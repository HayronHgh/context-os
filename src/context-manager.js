import { estimateTokens, truncateMiddle } from "./utils.js";
import { normalizeAgentConfig } from "./config.js";
import { serializeMessageForModel } from "./context-messages.js";
import { isDurableToolMessage, recoveryReference } from "./tool-evidence.js";

export class ContextManager {
  constructor(config) {
    const normalized = normalizeAgentConfig(config);
    this.contextWindow = normalized.contextWindow;
    this.reservedOutputTokens = normalized.reservedOutputTokens;
    this.thresholds = normalized.thresholds;
    this.maxToolOutputChars = normalized.maxToolOutputChars;
    this.fixedPromptOverheadTokens = normalized.fixedPromptOverheadTokens ?? 512;
    this.staleToolCompressionChars = normalized.staleToolCompressionChars;
    this.staleToolPreviewChars = normalized.staleToolPreviewChars;
  }

  estimateComponents(messages, tools = []) {
    const messageTokens = messages.reduce(
      (total, message) => total + estimateTokens(serializeMessageForModel(message)) + 8,
      0
    );
    const toolTokens = tools.length ? estimateTokens({ tools, tool_choice: "auto" }) : 0;
    return {
      messageTokens,
      toolTokens,
      fixedPromptOverheadTokens: this.fixedPromptOverheadTokens,
      totalTokens: messageTokens + toolTokens + this.fixedPromptOverheadTokens
    };
  }

  estimate(messages, tools = []) {
    return this.estimateComponents(messages, tools).totalTokens;
  }

  ratio(messages, tools = []) {
    const usable = Math.max(1, this.contextWindow - this.reservedOutputTokens);
    return this.estimate(messages, tools) / usable;
  }

  pruneStaleToolOutputs(messages, metrics = {}) {
    const staleBoundary = Math.max(1, messages.length - 14);
    return messages.map((message, index) => {
      if (index >= staleBoundary || message.role !== "tool" || String(message.content ?? "").length <= this.staleToolCompressionChars) {
        return message;
      }
      if (!isDurableToolMessage(message)) {
        metrics.nonDurableEvictionsBlocked = (metrics.nonDurableEvictionsBlocked ?? 0) + 1;
        return message;
      }
      metrics.toolOutputsCompressed = (metrics.toolOutputsCompressed ?? 0) + 1;
      const reference = recoveryReference(message);
      return {
        ...message,
        content: [
          "[stale tool result externalized]",
          `${reference.tool} -> artifact: ${reference.artifactId}`,
          `originalChars: ${reference.originalChars}`,
          "preview:",
          truncateMiddle(message.content, this.staleToolPreviewChars)
        ].join("\n"),
        context_os: { ...message.context_os, representation: "compressed" }
      };
    });
  }

  pruneStaleToolTurns(messages, metrics = {}) {
    const staleBoundary = Math.max(1, messages.length - 12);
    const pruned = [];
    for (let index = 0; index < messages.length;) {
      const message = messages[index];
      const calls = message.role === "assistant" && Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (index < staleBoundary && calls.length) {
        const expectedIds = new Set(calls.map((call) => call.id));
        let end = index + 1;
        const results = [];
        const resultIds = new Set();
        while (end < messages.length && messages[end].role === "tool") {
          results.push(messages[end]);
          resultIds.add(messages[end].tool_call_id);
          end += 1;
        }
        const isComplete = results.length === calls.length
          && expectedIds.size === resultIds.size
          && [...expectedIds].every((id) => resultIds.has(id));
        if (isComplete && end <= staleBoundary) {
          if (results.every(isDurableToolMessage)) {
            const visible = String(message.content ?? "").trim();
            const references = results.map(recoveryReference);
            pruned.push({
              role: "assistant",
              content: [
                "[older tool exchange externalized]",
                ...references.map((reference) => `${reference.tool} -> artifact: ${reference.artifactId}`),
                ...(visible ? ["assistant note:", truncateMiddle(visible, 300)] : [])
              ].join("\n"),
              context_os: { kind: "externalized-tool-exchange", recoveryReferences: references }
            });
            metrics.toolExchangesEvicted = (metrics.toolExchangesEvicted ?? 0) + 1;
            index = end;
            continue;
          }
          metrics.nonDurableEvictionsBlocked = (metrics.nonDurableEvictionsBlocked ?? 0) + 1;
        }
      }
      pruned.push(message);
      index += 1;
    }
    return pruned;
  }

  chooseCut(messages, hardTransfer) {
    const userIndexes = [];
    for (let index = 1; index < messages.length; index += 1) {
      if (messages[index].role === "user") userIndexes.push(index);
    }
    if (userIndexes.length < 2) return -1;
    if (hardTransfer) return userIndexes.at(-1);
    const target = Math.max(2, messages.length - 12);
    const candidates = userIndexes.filter((index) => index > 1 && index <= target);
    return candidates.length ? candidates.at(-1) : userIndexes[Math.max(1, userIndexes.length - 2)];
  }

  async prepare(inputMessages, compact, { force = false, tools = [], durabilityMetrics = {} } = {}) {
    let messages = inputMessages.map((message) => structuredClone(message));
    const initialBreakdown = this.estimateComponents(messages, tools);
    const initialTokens = initialBreakdown.totalTokens;
    const initialRatio = this.ratio(messages, tools);
    const actions = [];
    const metrics = {
      artifactsCreated: durabilityMetrics.artifactsCreated ?? 0,
      artifactCharsPersisted: durabilityMetrics.artifactCharsPersisted ?? 0,
      toolOutputsCompressed: 0,
      toolExchangesEvicted: 0,
      nonDurableEvictionsBlocked: 0
    };

    if (force || initialRatio >= this.thresholds.garbageCollect) {
      const compressedBefore = metrics.toolOutputsCompressed;
      const blockedBefore = metrics.nonDurableEvictionsBlocked;
      messages = this.pruneStaleToolOutputs(messages, metrics);
      if (metrics.toolOutputsCompressed > compressedBefore) actions.push("tool-output-gc");
      else if (metrics.nonDurableEvictionsBlocked > blockedBefore) actions.push("tool-output-gc-blocked");
    }

    const afterGcRatio = this.ratio(messages, tools);
    if (force || afterGcRatio >= this.thresholds.prune) {
      const evictedBefore = metrics.toolExchangesEvicted;
      const blockedBefore = metrics.nonDurableEvictionsBlocked;
      messages = this.pruneStaleToolTurns(messages, metrics);
      if (metrics.toolExchangesEvicted > evictedBefore) actions.push("conversation-prune");
      else if (metrics.nonDurableEvictionsBlocked > blockedBefore) actions.push("conversation-prune-blocked");
    }

    let stateTransfer = null;
    const afterPruneRatio = this.ratio(messages, tools);
    if (force || afterPruneRatio >= this.thresholds.semanticCompact) {
      const hardTransfer = force || afterPruneRatio >= this.thresholds.hardTransfer;
      const cut = this.chooseCut(messages, hardTransfer);
      if (cut > 1) {
        const older = messages.slice(1, cut);
        stateTransfer = await compact(older);
        messages = [
          messages[0],
          {
            role: "system",
            content: `CODING STATE TRANSFER\nDerived continuation state. Verify mutable facts against repository/tool evidence.\n${stateTransfer}`
          },
          ...messages.slice(cut)
        ];
        actions.push(hardTransfer ? "hard-state-transfer" : "semantic-compaction");
      }
    }

    const finalBreakdown = this.estimateComponents(messages, tools);
    const finalTokens = finalBreakdown.totalTokens;
    const finalRatio = this.ratio(messages, tools);
    return {
      messages,
      stateTransfer,
      report: {
        initialTokens,
        finalTokens,
        initialRatio,
        finalRatio,
        initialBreakdown,
        finalBreakdown,
        actions,
        ...metrics,
        failure: finalRatio >= this.thresholds.failure
      }
    };
  }
}
