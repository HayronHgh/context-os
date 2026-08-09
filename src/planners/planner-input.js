import { PLANNER_PROMPT_VERSION, PLANNER_SYSTEM_PROMPT } from "./planner-prompt.js";
import { estimateTokens, truncateMiddle } from "../utils.js";

export const PLANNER_INPUT_SCHEMA_VERSION = 1;

export const PLANNER_DEFAULTS = Object.freeze({
  maxInputTokens: 12000,
  maxOutputTokens: 2048,
  maxVisibleUnits: 64,
  fullUnitChars: 600,
  maxUnitChars: 1000,
  maxTaskChars: 1000,
  temperature: 0.1,
  maxAttempts: 2
});

const RETRY_RESERVE_TOKENS = 160;
const MIN_INPUT_TOKENS = 1024;
const MIN_OUTPUT_TOKENS = 128;

function requireInteger(config, field, minimum) {
  const value = config[field];
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Invalid planner config: ${field} must be an integer >= ${minimum}`);
  }
}

export function normalizePlannerConfig(config = {}) {
  const normalized = { ...PLANNER_DEFAULTS, ...(config ?? {}) };
  requireInteger(normalized, "maxInputTokens", MIN_INPUT_TOKENS);
  requireInteger(normalized, "maxOutputTokens", MIN_OUTPUT_TOKENS);
  requireInteger(normalized, "maxVisibleUnits", 1);
  requireInteger(normalized, "fullUnitChars", 1);
  requireInteger(normalized, "maxUnitChars", 1);
  requireInteger(normalized, "maxTaskChars", 1);
  requireInteger(normalized, "maxAttempts", 1);
  if (normalized.maxAttempts > 2) throw new Error("Invalid planner config: maxAttempts must be <= 2");
  if (normalized.fullUnitChars > normalized.maxUnitChars) {
    throw new Error("Invalid planner config: fullUnitChars must be <= maxUnitChars");
  }
  if (typeof normalized.temperature !== "number"
    || !Number.isFinite(normalized.temperature)
    || normalized.temperature < 0
    || normalized.temperature > 2) {
    throw new Error("Invalid planner config: temperature must be between 0 and 2");
  }
  return Object.freeze(normalized);
}

function pressureView(pressure) {
  const ratio = pressure?.ratio;
  const requiredReductionTokens = pressure?.requiredReductionTokens;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) {
    throw new Error("Planner pressure.ratio must be a non-negative finite number");
  }
  if (!Number.isSafeInteger(requiredReductionTokens) || requiredReductionTokens < 0) {
    throw new Error("Planner pressure.requiredReductionTokens must be a non-negative safe integer");
  }
  return { ratio, requiredReductionTokens };
}

function taskView(task, maximum) {
  const objective = truncateMiddle(String(task?.objective ?? ""), maximum);
  const phase = truncateMiddle(String(task?.phase ?? "unknown"), Math.min(maximum, 160));
  return { objective, phase };
}

function statsView(snapshot) {
  const stats = snapshot?.stats ?? {};
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    totalUnits: integer(stats.totalUnits),
    totalTokens: integer(stats.totalTokens),
    protectedUnits: integer(stats.protectedUnits),
    recoverableUnits: integer(stats.recoverableUnits)
  };
}

function representation(unit, config) {
  const text = typeof unit.content === "string" ? unit.content : String(unit.summary ?? "");
  const full = text.length <= config.fullUnitChars;
  const visible = full ? text : truncateMiddle(text, config.maxUnitChars);
  return {
    mode: full ? "full" : "summary",
    text: visible,
    sourceTokens: unit.tokens,
    visibleChars: visible.length
  };
}

function validateUnit(unit) {
  return unit
    && typeof unit === "object"
    && typeof unit.id === "string"
    && typeof unit.kind === "string"
    && typeof unit.authority === "string"
    && typeof unit.recoverability === "string"
    && typeof unit.lifecycle === "string"
    && typeof unit.protected === "boolean"
    && Array.isArray(unit.protectedReasons)
    && Array.isArray(unit.dependencies)
    && Number.isSafeInteger(unit.tokens)
    && unit.tokens >= 0;
}

function entryFor(unit, config) {
  return {
    id: unit.id,
    position: unit.position,
    kind: unit.kind,
    authority: unit.authority,
    tokens: unit.tokens,
    recoverability: unit.recoverability,
    protected: unit.protected,
    protectedReasons: [...unit.protectedReasons],
    dependencies: unit.dependencies.map(({ unitId, relation }) => ({ unitId, relation })),
    lifecycle: unit.lifecycle,
    representation: representation(unit, config)
  };
}

function ranking(units) {
  const dependencyTargets = new Set();
  for (const unit of units) {
    for (const dependency of unit.dependencies) {
      if (dependency.relation === "depends_on") dependencyTargets.add(dependency.unitId);
    }
  }
  const unresolved = (unit) => unit.kind === "ERROR"
    || unit.kind === "HYPOTHESIS"
    || unit.protectedReasons.includes("UNRESOLVED_ERROR")
    || unit.protectedReasons.includes("UNRESOLVED_HYPOTHESIS");
  return [...units].sort((left, right) => {
    const leftRank = [
      left.protected ? 0 : 1,
      left.authority === "USER" ? 0 : 1,
      left.lifecycle === "ACTIVE" ? 0 : 1,
      dependencyTargets.has(left.id) || left.protectedReasons.includes("DEPENDENCY_ROOT") ? 0 : 1,
      unresolved(left) ? 0 : 1,
      left.position
    ];
    const rightRank = [
      right.protected ? 0 : 1,
      right.authority === "USER" ? 0 : 1,
      right.lifecycle === "ACTIVE" ? 0 : 1,
      dependencyTargets.has(right.id) || right.protectedReasons.includes("DEPENDENCY_ROOT") ? 0 : 1,
      unresolved(right) ? 0 : 1,
      right.position
    ];
    for (let index = 0; index < leftRank.length; index += 1) {
      if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
    }
    return left.id.localeCompare(right.id);
  });
}

function requestTokens(payload, retry = true) {
  const messages = [
    { role: "system", content: PLANNER_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) }
  ];
  return estimateTokens(messages) + (retry ? RETRY_RESERVE_TOKENS : 0);
}

function planChallenge(identity) {
  const fingerprint = String(identity?.fingerprint ?? "").replace(/^sha256:/, "");
  return `plan_${fingerprint.slice(0, 24) || "inventory"}`;
}

function basePayload(snapshot, pressure, task, requestedPlanId, config) {
  const identity = snapshot?.inventory;
  if (!identity || typeof identity.id !== "string" || typeof identity.fingerprint !== "string") {
    throw new Error("Planner inventory snapshot requires an id and fingerprint");
  }
  return {
    schemaVersion: PLANNER_INPUT_SCHEMA_VERSION,
    plannerPromptVersion: PLANNER_PROMPT_VERSION,
    requestedPlanId: requestedPlanId ?? planChallenge(identity),
    inventory: { id: identity.id, fingerprint: identity.fingerprint },
    pressure: pressureView(pressure ?? snapshot.pressure),
    task: taskView(task ?? snapshot.task, config.maxTaskChars),
    stats: statsView(snapshot),
    visibleUnitIds: [],
    units: []
  };
}

export function buildPlannerInput(snapshot, {
  pressure = null,
  task = null,
  requestedPlanId = null,
  config = {}
} = {}) {
  const normalized = normalizePlannerConfig(config);
  if (!Array.isArray(snapshot?.units) || snapshot.units.some((unit) => !validateUnit(unit))) {
    throw new Error("Planner inventory snapshot contains invalid units");
  }
  const ids = snapshot.units.map((unit) => unit.id);
  if (new Set(ids).size !== ids.length) throw new Error("Planner inventory unit IDs must be unique");

  const payload = basePayload(snapshot, pressure, task, requestedPlanId, normalized);
  if (requestTokens(payload) > normalized.maxInputTokens) {
    throw new Error("Planner input metadata exceeds maxInputTokens before units are added");
  }

  const visible = [];
  const ranked = ranking(snapshot.units);
  for (const unit of ranked) {
    if (visible.length >= normalized.maxVisibleUnits) break;
    const candidate = entryFor(unit, normalized);
    const proposed = [...visible, candidate].sort((left, right) => left.position - right.position);
    const proposedPayload = {
      ...payload,
      visibleUnitIds: proposed.map((entry) => entry.id),
      units: proposed
    };
    if (requestTokens(proposedPayload) <= normalized.maxInputTokens) visible.push(candidate);
  }

  visible.sort((left, right) => left.position - right.position);
  payload.visibleUnitIds = visible.map((entry) => entry.id);
  payload.units = visible;
  const visibleSet = new Set(payload.visibleUnitIds);
  const hiddenUnitIds = snapshot.units.filter((unit) => !visibleSet.has(unit.id)).map((unit) => unit.id);
  const estimatedInputTokens = requestTokens(payload);
  if (estimatedInputTokens > normalized.maxInputTokens) {
    throw new Error("Planner input exceeds maxInputTokens");
  }

  return {
    payload,
    visibleUnitIds: [...payload.visibleUnitIds],
    hiddenUnitIds,
    estimatedInputTokens,
    config: normalized
  };
}

export function estimatePlannerRequestTokens(input, { retry = false } = {}) {
  return requestTokens(input?.payload, retry);
}
