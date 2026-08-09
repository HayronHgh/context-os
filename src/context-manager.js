import { estimateTokens, truncateMiddle } from "./utils.js";

export class ContextManager {
  constructor(config) {
    this.contextWindow = config.contextWindow;
    this.reservedOutputTokens = config.reservedOutputTokens;
    this.thresholds = config.thresholds;
    this.maxToolOutputChars = config.maxToolOutputChars;
    this.fixedPromptOverheadTokens = config.fixedPromptOverheadTokens ?? 512;
  }

  estimateComponents(messages, tools = []) {
    const messageTokens = messages.reduce((total, message) => total + estimateTokens(message) + 8, 0);
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

  pruneStaleToolOutputs(messages) {
    const staleBoundary = Math.max(1, messages.length - 14);
    return messages.map((message, index) => {
      if (index >= staleBoundary || message.role !== "tool" || String(message.content ?? "").length <= 800) return message;
      return {
        ...message,
        content: truncateMiddle(message.content, 500, "\n...[stale tool output pruned; artifact remains on disk]...\n")
      };
    });
  }

  pruneStaleToolTurns(messages) {
    const staleBoundary = Math.max(1, messages.length - 12);
    const pruned = [];
    for (let index = 0; index < messages.length;) {
      const message = messages[index];
      const calls = message.role === "assistant" && Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (index < staleBoundary && calls.length) {
        const expectedIds = new Set(calls.map((call) => call.id));
        let end = index + 1;
        const resultIds = new Set();
        while (end < messages.length && messages[end].role === "tool") {
          resultIds.add(messages[end].tool_call_id);
          end += 1;
        }
        const isComplete = expectedIds.size === resultIds.size && [...expectedIds].every((id) => resultIds.has(id));
        if (isComplete && end <= staleBoundary) {
          const visible = String(message.content ?? "").trim();
          pruned.push({
            role: "assistant",
            content: visible
              ? truncateMiddle(visible, 300, "\n...[older tool exchange omitted]...\n")
              : "[older tool exchange pruned; durable artifacts and task state remain available]"
          });
          index = end;
          continue;
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

  async prepare(inputMessages, compact, { force = false, tools = [] } = {}) {
    let messages = inputMessages.map((message) => structuredClone(message));
    const initialBreakdown = this.estimateComponents(messages, tools);
    const initialTokens = initialBreakdown.totalTokens;
    const initialRatio = this.ratio(messages, tools);
    const actions = [];

    if (force || initialRatio >= this.thresholds.garbageCollect) {
      messages = this.pruneStaleToolOutputs(messages);
      actions.push("tool-output-gc");
    }

    const afterGcRatio = this.ratio(messages, tools);
    if (force || afterGcRatio >= this.thresholds.prune) {
      messages = this.pruneStaleToolTurns(messages);
      actions.push("conversation-prune");
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
        failure: finalRatio >= this.thresholds.failure
      }
    };
  }
}
