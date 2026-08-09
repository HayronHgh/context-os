import { SEMANTIC_PRESERVATION_REASON_CODES } from "./validated-transformation.js";
import { estimateTokens } from "./utils.js";

export const TRANSFORM_VALIDATOR_PROMPT_VERSION = "transform-validator-v1";

export const TRANSFORM_VALIDATOR_SYSTEM_PROMPT = `You assess whether compressed ContextOS candidate content preserves the meaning of one original unit.
You do not edit or rewrite content. Return strict JSON with exactly two keys: verdict and reasonCodes.
verdict must be ACCEPT or REJECT. ACCEPT requires an empty reasonCodes array. REJECT requires one or more allowed codes.
Allowed codes: CONSTRAINT_LOST, FACT_LOST, DECISION_LOST, IDENTIFIER_LOST, ERROR_STATE_LOST, UNRESOLVED_STATE_LOST, FABRICATION_ADDED, MEANING_CHANGED.
Check concrete constraints, facts, decisions, identifiers, paths, commands, errors, unresolved state, fabrication, and meaning.
You have no tools and no authority to approve mechanical failures, modify candidates, or mutate context.`;

const DEFAULT_CONFIG = Object.freeze({
  maxInputTokens: 24000,
  maxOutputTokens: 512,
  temperature: 0,
  maxAttempts: 2
});

const RETRYABLE_CODES = new Set([
  "MALFORMED_JSON",
  "SCHEMA_VIOLATION",
  "EMPTY_OUTPUT"
]);
const REASON_CODES = new Set(SEMANTIC_PRESERVATION_REASON_CODES);

export class TransformValidationError extends Error {
  constructor(code, message, { causeCode = null, attempts = 0 } = {}) {
    super(message);
    this.name = "TransformValidationError";
    this.code = code;
    this.causeCode = causeCode;
    this.attempts = attempts;
  }
}

function requireInteger(config, field, minimum) {
  if (!Number.isSafeInteger(config[field]) || config[field] < minimum) {
    throw new Error(`Invalid transform validator config: ${field} must be an integer >= ${minimum}`);
  }
}

export function normalizeTransformValidatorConfig(config = {}) {
  const normalized = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  requireInteger(normalized, "maxInputTokens", 256);
  requireInteger(normalized, "maxOutputTokens", 1);
  requireInteger(normalized, "maxAttempts", 1);
  if (normalized.maxAttempts > 2) {
    throw new Error("Invalid transform validator config: maxAttempts must be <= 2");
  }
  if (typeof normalized.temperature !== "number"
    || !Number.isFinite(normalized.temperature)
    || normalized.temperature < 0
    || normalized.temperature > 2) {
    throw new Error("Invalid transform validator config: temperature must be between 0 and 2");
  }
  return Object.freeze(normalized);
}

function stripOptionalCodeFence(text) {
  const value = String(text ?? "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match ? match[1].trim() : value;
}

function validAssessment(value) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, "verdict")
    || !Object.hasOwn(value, "reasonCodes")
    || !["ACCEPT", "REJECT"].includes(value.verdict)
    || !Array.isArray(value.reasonCodes)
    || value.reasonCodes.some((code) => !REASON_CODES.has(code))
    || new Set(value.reasonCodes).size !== value.reasonCodes.length) return false;
  return value.verdict === "ACCEPT"
    ? value.reasonCodes.length === 0
    : value.reasonCodes.length > 0;
}

function parseAssessment(raw) {
  const text = stripOptionalCodeFence(raw);
  if (!text) throw new TransformValidationError("EMPTY_OUTPUT", "Semantic validator returned no JSON");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TransformValidationError("MALFORMED_JSON", "Semantic validator output is not valid JSON");
  }
  if (!validAssessment(parsed)) {
    throw new TransformValidationError(
      "SCHEMA_VIOLATION",
      "Semantic validator output does not match the strict verdict schema"
    );
  }
  return Object.freeze({ verdict: parsed.verdict, reasonCodes: Object.freeze([...parsed.reasonCodes]) });
}

function correction(error) {
  return `Previous output failed ${error.code}. Return strict JSON only: {"verdict":"ACCEPT|REJECT","reasonCodes":[]}.`;
}

export class QwenTransformValidator {
  constructor({ client, config = {} } = {}) {
    if (!client || typeof client.chat !== "function") {
      throw new Error("QwenTransformValidator requires a client with chat(messages, options)");
    }
    this.client = client;
    this.config = normalizeTransformValidatorConfig(config);
  }

  async assess(input) {
    if (!input
      || input.schemaVersion !== 1
      || typeof input.originalContent !== "string"
      || typeof input.candidateContent !== "string"
      || typeof input.kind !== "string"
      || typeof input.authority !== "string"
      || !Array.isArray(input.protectedReasons)
      || input.protectedReasons.some((reason) => typeof reason !== "string")) {
      throw new TransformValidationError(
        "SEMANTIC_VALIDATOR_INPUT_INVALID",
        "Semantic validator requires original/candidate content and Runtime facts"
      );
    }
    const baseMessages = [
      { role: "system", content: TRANSFORM_VALIDATOR_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(structuredClone(input)) }
    ];
    const retryMessages = [...baseMessages, { role: "user", content: correction({ code: "SCHEMA_VIOLATION" }) }];
    if (estimateTokens(retryMessages) > this.config.maxInputTokens) {
      throw new TransformValidationError(
        "SEMANTIC_VALIDATOR_INPUT_BUDGET_EXCEEDED",
        "Semantic validation request exceeds maxInputTokens"
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
        return parseAssessment(raw);
      } catch (error) {
        const current = error instanceof TransformValidationError
          ? error
          : new TransformValidationError("SEMANTIC_VALIDATOR_CLIENT_ERROR", error?.message ?? String(error));
        if (!RETRYABLE_CODES.has(current.code) || attempt >= this.config.maxAttempts) {
          throw new TransformValidationError(
            "SEMANTIC_VALIDATION_FAILED",
            `Semantic validation failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${current.message}`,
            { causeCode: current.code, attempts: attempt }
          );
        }
        previousError = current;
      }
    }
    throw new TransformValidationError("SEMANTIC_VALIDATION_FAILED", "Semantic validator exhausted its attempts");
  }
}
