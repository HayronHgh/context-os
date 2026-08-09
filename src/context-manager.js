import { estimateTokens, truncateMiddle } from "./utils.js";

export class ContextManager {
  constructor(config) {
    this.contextWindow = config.contextWindow;
    this.reservedOutputTokens = config.reservedOutputTokens;
    this.thresholds = config.thresholds;
    this.maxToolOutputChars = config.maxToolOutputChars;
  }

  estimate(messages) {
    return messages.reduce((total, message) => total + estimateTokens(message) + 8, 0);
  }

  ratio(messages) {
    const usable = Math.max(1, this.contextWindow - this.reservedOutputTokens);
    return this.estimate(messages) / usable;
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

  chooseCut(messages, force) {
    const userIndexes = [];
    for (let index = 1; index < messages.length; index += 1) {
      if (messages[index].role === "user") userIndexes.push(index);
    }
    if (userIndexes.length < 2) return -1;
    if (force) return userIndexes.at(-1);
    const target = Math.max(2, messages.length - 12);
    const candidates = userIndexes.filter((index) => index <= target);
    return candidates.length ? candidates.at(-1) : userIndexes[Math.max(1, userIndexes.length - 2)];
  }

  async prepare(inputMessages, compact, { force = false } = {}) {
    let messages = inputMessages.map((message) => structuredClone(message));
    const initialTokens = this.estimate(messages);
    const initialRatio = this.ratio(messages);
    const actions = [];

    if (force || initialRatio >= this.thresholds.garbageCollect) {
      messages = this.pruneStaleToolOutputs(messages);
      actions.push("tool-output-gc");
    }

    const afterGcRatio = this.ratio(messages);
    if (force || afterGcRatio >= this.thresholds.prune) {
      messages = this.pruneStaleToolOutputs(messages);
      actions.push("conversation-prune");
    }

    let stateTransfer = null;
    const afterPruneRatio = this.ratio(messages);
    if (force || afterPruneRatio >= this.thresholds.semanticCompact) {
      const cut = this.chooseCut(messages, force);
      if (cut > 1) {
        const older = messages.slice(1, cut);
        stateTransfer = await compact(older);
        messages = [
          messages[0],
          {
            role: "system",
            content: `CODING STATE TRANSFER (authoritative continuation state)\n${stateTransfer}`
          },
          ...messages.slice(cut)
        ];
        actions.push(afterPruneRatio >= this.thresholds.hardTransfer ? "hard-state-transfer" : "semantic-compaction");
      }
    }

    const finalTokens = this.estimate(messages);
    const finalRatio = this.ratio(messages);
    return {
      messages,
      stateTransfer,
      report: {
        initialTokens,
        finalTokens,
        initialRatio,
        finalRatio,
        actions,
        failure: finalRatio >= this.thresholds.failure
      }
    };
  }
}
