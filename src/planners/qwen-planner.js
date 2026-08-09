import { CompactionPlanError, parseCompactionPlan } from "../compaction-plan.js";
import { estimateTokens } from "../utils.js";
import { ContextPlanner } from "./planner.js";
import { estimatePlannerRequestTokens, normalizePlannerConfig } from "./planner-input.js";
import { PLANNER_PROMPT_VERSION, PLANNER_SYSTEM_PROMPT } from "./planner-prompt.js";

const RETRYABLE_CODES = new Set([
  "MALFORMED_JSON",
  "SCHEMA_VIOLATION",
  "DUPLICATE_DECISION",
  "PLAN_ID_MISMATCH",
  "PLAN_UNIT_NOT_VISIBLE",
  "PLANNER_EMPTY_OUTPUT",
  "PLANNER_CLIENT_ERROR"
]);

const PARSE_FAILURE_CODES = new Set([
  "MALFORMED_JSON",
  "SCHEMA_VIOLATION",
  "DUPLICATE_DECISION"
]);

const FAILURE_CATEGORIES = Object.freeze({
  MALFORMED_JSON: "protocol",
  SCHEMA_VIOLATION: "protocol",
  DUPLICATE_DECISION: "protocol",
  PLANNER_EMPTY_OUTPUT: "protocol",
  PLAN_ID_MISMATCH: "binding",
  PLAN_UNIT_NOT_VISIBLE: "visibility",
  PLANNER_CLIENT_ERROR: "client",
  STALE_INVENTORY: "stale"
});

export class SemanticPlannerError extends Error {
  constructor(code, message, { causeCode = null, path = null, attempts = 0 } = {}) {
    super(message);
    this.name = "SemanticPlannerError";
    this.code = code;
    this.causeCode = causeCode;
    this.path = path;
    this.attempts = attempts;
  }
}

function stripOptionalCodeFence(text) {
  const value = String(text ?? "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  return match ? match[1].trim() : value;
}

function attemptError(error) {
  if (error instanceof SemanticPlannerError || error instanceof CompactionPlanError) return error;
  return new SemanticPlannerError("PLANNER_CLIENT_ERROR", error?.message ?? String(error));
}

function validateCandidate(plan, input) {
  if (plan.planId !== input.payload.requestedPlanId) {
    throw new SemanticPlannerError(
      "PLAN_ID_MISMATCH",
      "Planner must return requestedPlanId exactly as planId",
      { path: "planId" }
    );
  }
  if (plan.inventory.id !== input.payload.inventory.id
    || plan.inventory.fingerprint !== input.payload.inventory.fingerprint) {
    throw new SemanticPlannerError(
      "STALE_INVENTORY",
      "Planner returned an inventory identity that does not match its bounded input",
      { path: "inventory" }
    );
  }
  const visible = new Set(input.visibleUnitIds);
  const unseen = plan.decisions.filter((decision) => !visible.has(decision.unitId));
  if (unseen.length) {
    throw new SemanticPlannerError(
      "PLAN_UNIT_NOT_VISIBLE",
      `Planner referenced units outside visibleUnitIds: ${unseen.map((decision) => decision.unitId).join(", ")}`,
      { path: "decisions" }
    );
  }
  return plan;
}

function failureInstruction(error) {
  const location = error.path ? ` at ${error.path}` : "";
  return `Previous proposal was rejected: ${error.code}${location}. Return corrected JSON only. The exact top-level keys are schemaVersion, planId, inventory, decisions. inventory must be the nested object {"id": inventory.id, "fingerprint": inventory.fingerprint}; never emit inventoryId or inventoryFingerprint. Reuse requestedPlanId and the exact inventory identity.`;
}

function recordFailure(run, code) {
  run.failedAttempts += 1;
  if (PARSE_FAILURE_CODES.has(code)) run.parseFailures += 1;
  const category = FAILURE_CATEGORIES[code];
  if (category) run.failures[category] += 1;
}

function parseResultFor(code) {
  if (code === "PLANNER_CLIENT_ERROR") return "not_attempted";
  if (["PLAN_ID_MISMATCH", "PLAN_UNIT_NOT_VISIBLE", "STALE_INVENTORY"].includes(code)) return "ok";
  return "error";
}

function freezeRun(run) {
  return Object.freeze({
    ...run,
    failures: Object.freeze({ ...run.failures })
  });
}

export class QwenPlanner extends ContextPlanner {
  constructor({ client, config = {}, audit = () => {}, now = () => Date.now() } = {}) {
    super();
    if (!client || typeof client.chat !== "function") {
      throw new Error("QwenPlanner requires a client with chat(messages, options)");
    }
    if (typeof audit !== "function") throw new Error("QwenPlanner audit must be a function");
    this.client = client;
    this.config = normalizePlannerConfig(config);
    this.audit = audit;
    this.now = now;
    this.lastRun = null;
  }

  async plan(input) {
    if (!input?.payload || !Array.isArray(input.visibleUnitIds) || !Array.isArray(input.hiddenUnitIds)) {
      throw new SemanticPlannerError("PLANNER_INPUT_INVALID", "QwenPlanner requires a bounded Planner input");
    }
    if (estimatePlannerRequestTokens(input, { retry: true }) > this.config.maxInputTokens) {
      throw new SemanticPlannerError("PLANNER_INPUT_BUDGET_EXCEEDED", "Planner request exceeds maxInputTokens");
    }

    const baseMessages = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input.payload) }
    ];
    let previousError = null;
    const run = {
      plannerVersion: PLANNER_PROMPT_VERSION,
      attempts: 0,
      failedAttempts: 0,
      parseFailures: 0,
      failures: {
        protocol: 0,
        binding: 0,
        visibility: 0,
        client: 0,
        stale: 0
      },
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      visibleUnits: input.visibleUnitIds.length,
      hiddenUnits: input.hiddenUnitIds.length
    };

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      const messages = previousError
        ? [...baseMessages, { role: "user", content: failureInstruction(previousError) }]
        : baseMessages;
      const requestTokens = estimateTokens(messages);
      if (requestTokens > this.config.maxInputTokens) {
        throw new SemanticPlannerError("PLANNER_INPUT_BUDGET_EXCEEDED", "Planner retry exceeds maxInputTokens", { attempts: attempt - 1 });
      }

      const startedAt = this.now();
      let response;
      let rawOutput = "";
      let currentError = null;
      try {
        response = await this.client.chat(messages, {
          tools: [],
          temperature: this.config.temperature,
          maxTokens: this.config.maxOutputTokens,
          responseFormat: { type: "json_object" },
          chatTemplateKwargs: { enable_thinking: false }
        });
        rawOutput = typeof response?.message?.content === "string"
          ? response.message.content
          : "";
        if (!rawOutput.trim()) {
          throw new SemanticPlannerError("PLANNER_EMPTY_OUTPUT", "Planner returned no JSON content");
        }
        const parsed = parseCompactionPlan(stripOptionalCodeFence(rawOutput));
        const plan = validateCandidate(parsed, input);
        const latencyMs = Math.max(0, this.now() - startedAt);
        const observedInputTokens = response?.usage?.prompt_tokens ?? requestTokens;
        const outputTokens = response?.usage?.completion_tokens ?? estimateTokens(rawOutput);
        run.attempts = attempt;
        run.inputTokens += observedInputTokens;
        run.outputTokens += outputTokens;
        run.latencyMs += latencyMs;
        await this.audit({
          type: "semantic_planner_attempt",
          plannerVersion: PLANNER_PROMPT_VERSION,
          inventoryId: input.payload.inventory.id,
          inventoryFingerprint: input.payload.inventory.fingerprint,
          inputTokens: observedInputTokens,
          visibleUnits: input.visibleUnitIds.length,
          hiddenUnits: input.hiddenUnitIds.length,
          attempt,
          outputTokens,
          parseResult: "ok",
          latencyMs,
          rawOutput
        });
        this.lastRun = freezeRun(run);
        return plan;
      } catch (error) {
        currentError = attemptError(error);
        const latencyMs = Math.max(0, this.now() - startedAt);
        const observedInputTokens = response?.usage?.prompt_tokens ?? requestTokens;
        const outputTokens = response?.usage?.completion_tokens
          ?? (rawOutput ? estimateTokens(rawOutput) : 0);
        run.attempts = attempt;
        recordFailure(run, currentError.code);
        run.inputTokens += observedInputTokens;
        run.outputTokens += outputTokens;
        run.latencyMs += latencyMs;
        await this.audit({
          type: "semantic_planner_attempt",
          plannerVersion: PLANNER_PROMPT_VERSION,
          inventoryId: input.payload.inventory.id,
          inventoryFingerprint: input.payload.inventory.fingerprint,
          inputTokens: observedInputTokens,
          visibleUnits: input.visibleUnitIds.length,
          hiddenUnits: input.hiddenUnitIds.length,
          attempt,
          outputTokens,
          parseResult: parseResultFor(currentError.code),
          errorCode: currentError.code,
          failureCategory: FAILURE_CATEGORIES[currentError.code] ?? "unknown",
          errorPath: currentError.path ?? null,
          latencyMs,
          rawOutput
        });
      }

      if (currentError.code === "STALE_INVENTORY") {
        this.lastRun = freezeRun(run);
        throw new SemanticPlannerError("STALE_INVENTORY", currentError.message, {
          causeCode: currentError.code,
          path: currentError.path,
          attempts: attempt
        });
      }
      if (!RETRYABLE_CODES.has(currentError.code) || attempt >= this.config.maxAttempts) {
        this.lastRun = freezeRun(run);
        throw new SemanticPlannerError(
          "PLANNER_FAILED",
          `Semantic Planner failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${currentError.message}`,
          { causeCode: currentError.code, path: currentError.path, attempts: attempt }
        );
      }
      previousError = currentError;
    }
    throw new SemanticPlannerError("PLANNER_FAILED", "Semantic Planner exhausted its bounded attempts");
  }
}
