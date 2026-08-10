import { COMPACTION_SYSTEM_PROMPT } from "./prompts.js";
import { formatStateTransfer, parseStateTransfer } from "./state-transfer.js";
import { serializeContext } from "./context-messages.js";
import { isDurableToolMessage, recoveryReference } from "./tool-evidence.js";
import { estimateTokens, truncateMiddle } from "./utils.js";

function assistantContent(message) {
  if (typeof message?.content === "string" && message.content.trim()) return message.content;
  if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim()) return message.reasoning_content;
  return "";
}

function stripCodeFence(text) {
  return String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function transferContent(content) {
  if (typeof content === "string") return truncateMiddle(content, 14000);
  if (!Array.isArray(content)) return truncateMiddle(JSON.stringify(content ?? ""), 14000);
  const safeParts = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    if (part.type === "image_url") return { type: "image_url", image_url: "[older image omitted during state transfer]" };
    if (part.type === "input_audio") return { type: "input_audio", input_audio: "[older audio omitted during state transfer]" };
    return part;
  });
  return truncateMiddle(JSON.stringify(safeParts), 14000);
}

export class StateTransferCompactor {
  constructor({ client, maxInputMessageChars = 14000, maxInputTokens = 32000, maxOutputTokens = 2400, maxAttempts = 2 } = {}) {
    if (!client?.chat) throw new Error("StateTransferCompactor requires a chat client");
    this.client = client;
    this.maxInputMessageChars = maxInputMessageChars;
    this.maxInputTokens = maxInputTokens;
    this.maxOutputTokens = maxOutputTokens;
    this.maxAttempts = maxAttempts;
  }

  transcript(messages) {
    return messages.map((internalMessage) => {
      const message = serializeContext([internalMessage])[0];
      return {
        role: message.role,
        name: message.name,
        content: truncateMiddle(transferContent(message.content), this.maxInputMessageChars),
        tool_calls: message.tool_calls,
        recovery: isDurableToolMessage(internalMessage) ? recoveryReference(internalMessage) : undefined
      };
    });
  }

  partition(transcript) {
    const chunks = [];
    let current = [];
    for (const item of transcript) {
      const candidate = [...current, item];
      if (current.length && estimateTokens(JSON.stringify(candidate)) > this.maxInputTokens) {
        chunks.push(current);
        current = [item];
      } else {
        current = candidate;
      }
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  async compactOnce(transcript) {
    const request = [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(transcript) }
    ];
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const retryInstruction = attempt === 1 ? [] : [{
        role: "user",
        content: `Your previous state transfer was invalid: ${lastError.message}\nReturn a corrected JSON object matching every required field and no additional fields.`
      }];
      const { message } = await this.client.chat([...request, ...retryInstruction], {
        maxTokens: this.maxOutputTokens,
        temperature: 0.1,
        responseFormat: { type: "json_object" },
        chatTemplateKwargs: { enable_thinking: false }
      });
      const text = stripCodeFence(assistantContent(message));
      try {
        return formatStateTransfer(parseStateTransfer(text));
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`State transfer validation failed after ${this.maxAttempts} attempts: ${lastError.message}`);
  }

  async compact(messages) {
    const transcript = this.transcript(messages);
    let chunks = this.partition(transcript);
    if (chunks.some((chunk) => estimateTokens(JSON.stringify(chunk)) > this.maxInputTokens)) {
      throw new Error("One state-transfer input item exceeds the bounded compaction budget");
    }
    let transfers = [];
    for (const chunk of chunks) transfers.push(await this.compactOnce(chunk));
    while (transfers.length > 1) {
      const mergeTranscript = transfers.map((content, index) => ({
        role: "system",
        name: `contextos_state_transfer_chunk_${index + 1}`,
        content
      }));
      chunks = this.partition(mergeTranscript);
      const merged = [];
      for (const chunk of chunks) merged.push(await this.compactOnce(chunk));
      if (merged.length >= transfers.length) {
        throw new Error("State-transfer merge could not reduce the bounded chunk count");
      }
      transfers = merged;
    }
    return transfers[0];
  }
}
