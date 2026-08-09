import { estimateTokens } from "./utils.js";

export const TRANSFORMER_PROMPT_VERSION = "transformer-v1";

export const TRANSFORMER_SYSTEM_PROMPT = `You prepare compressed candidate content for exactly one ContextOS unit.
Return strict JSON with exactly one key: {"content":"compressed candidate"}.
Preserve concrete facts, constraints, decisions, identifiers, paths, commands, errors, and unresolved state that remain useful.
Do not return unitId, action, authority, recoverability, targetTokens, hashes, explanations, Markdown fences, or execution instructions.
The output is only a candidate. You have no tools and no authority to mutate context.`;

const DEFAULT_CONFIG = Object.freeze({
  maxInputTokens: 12000,
  maxOutputTokens: 2048,
  temperature: 0.1,
  maxAttempts: 2
});

const RETRYABLE_CODES = new Set([
  "MALFORMED_JSON",
  "SCHEMA_VIOLATION",
  "EMPTY_OUTPUT"
]);

export class TransformationError extends Error {
  constructor(code, message, { causeCode = null, attempts = 0 } = {}) {
    super(message);
    this.name = "TransformationError";
    this.code = code;
    this.causeCode = causeCode;
    this.attempts = attempts;
  }
}

function requireInteger(config, field, minimum) {
  if (!Number.isSafeInteger(config[field]) || config[field] < minimum) {
    throw new Error(`Invalid transformer config: ${field} must be an integer >= ${minimum}`);
  }
}

export function normalizeTransformerConfig(config = {}) {
  const normalized = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  requireInteger(normalized, "maxInputTokens", 256);
  requireInteger(normalized, "maxOutputTokens", 1);
  requireInteger(normalized, "maxAttempts", 1);
  if (normalized.maxAttempts > 2) {
    throw new Error("Invalid transformer config: maxAttempts must be <= 2");
  }
  if (typeof normalized.temperature !== "number"
    || !Number.isFinite(normalized.temperature)
    || normalized.temperature < 0
    || normalized.temperature > 2) {
    throw new Error("Invalid transformer config: temperature must be between 0 and 2");
  }
  return Object.freeze(normalized);
}

function stripOptionalCodeFence(text) {
  const value = String(text ?? "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match ? match[1].trim() : value;
}

function parseCandidate(raw) {
  const text = stripOptionalCodeFence(raw);
  if (!text) throw new TransformationError("EMPTY_OUTPUT", "Transformer returned no candidate JSON");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TransformationError("MALFORMED_JSON", "Transformer output is not valid JSON");
  }
  if (!parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1
    || !Object.hasOwn(parsed, "content")
    || typeof parsed.content !== "string"
    || !parsed.content.trim()) {
    throw new TransformationError(
      "SCHEMA_VIOLATION",
      "Transformer output must be exactly one non-empty string field named content"
    );
  }
  return parsed.content;
}

function correction(error) {
  return `Previous output failed ${error.code}. Return strict JSON only with exactly one non-empty string field: {"content":"..."}.`;
}

export class QwenTransformer {
  constructor({ client, config = {} } = {}) {
    if (!client || typeof client.chat !== "function") {
      throw new Error("QwenTransformer requires a client with chat(messages, options)");
    }
    this.client = client;
    this.config = normalizeTransformerConfig(config);
  }

  async compress(input) {
    if (!input
      || input.schemaVersion !== 1
      || typeof input.unitId !== "string"
      || typeof input.kind !== "string"
      || typeof input.authority !== "string"
      || !Number.isSafeInteger(input.targetTokens)
      || input.targetTokens <= 0
      || typeof input.content !== "string") {
      throw new TransformationError("TRANSFORMER_INPUT_INVALID", "Transformer requires one valid compression unit");
    }
    const payload = structuredClone(input);
    const baseMessages = [
      { role: "system", content: TRANSFORMER_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) }
    ];
    const retryMessages = [...baseMessages, { role: "user", content: correction({ code: "SCHEMA_VIOLATION" }) }];
    if (estimateTokens(retryMessages) > this.config.maxInputTokens) {
      throw new TransformationError(
        "TRANSFORMER_INPUT_BUDGET_EXCEEDED",
        "Transformer request exceeds maxInputTokens"
      );
    }

    let previousError = null;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      const messages = previousError
        ? [...baseMessages, { role: "user", content: correction(previousError) }]
        : baseMessages;
      let response;
      let raw = "";
      try {
        response = await this.client.chat(messages, {
          tools: [],
          temperature: this.config.temperature,
          maxTokens: this.config.maxOutputTokens,
          responseFormat: { type: "json_object" },
          chatTemplateKwargs: { enable_thinking: false }
        });
        raw = typeof response?.message?.content === "string" ? response.message.content : "";
        const content = parseCandidate(raw);
        return content;
      } catch (error) {
        const current = error instanceof TransformationError
          ? error
          : new TransformationError("TRANSFORMER_CLIENT_ERROR", error?.message ?? String(error));
        if (!RETRYABLE_CODES.has(current.code) || attempt >= this.config.maxAttempts) {
          throw new TransformationError(
            "TRANSFORMER_FAILED",
            `Transformer failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${current.message}`,
            { causeCode: current.code, attempts: attempt }
          );
        }
        previousError = current;
      }
    }
    throw new TransformationError("TRANSFORMER_FAILED", "Transformer exhausted its bounded attempts");
  }
}
