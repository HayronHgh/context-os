import { serializeMessageForModel } from "./context-messages.js";
import { ContextManager } from "./context-manager.js";
import { isContextUnitId } from "./context-unit.js";
import { EXECUTABLE_PLAN_SCHEMA_VERSION } from "./execution-preflight.js";
import { RecoveryVerifier } from "./recovery-verifier.js";
import {
  ACTION_OPERATION,
  TRANSFORMATION_CANDIDATE_SCHEMA_VERSION,
  TRANSFORMATION_OPERATIONS,
  contentDigest
} from "./transformation-candidate.js";
import { VALIDATED_TRANSFORMATION_SCHEMA_VERSION } from "./validated-transformation.js";
import {
  accountingToolsDigest,
  createExecutionAbort,
  createExecutionResult,
  validTokenBreakdown
} from "./execution-result.js";

const VALIDATION_FIELDS = [
  "schemaVersion",
  "validationId",
  "sourceCandidateId",
  "inventory",
  "status",
  "decisions",
  "runtime"
];
const VALIDATION_DECISION_FIELDS = [
  "unitId",
  "action",
  "operation",
  "permission",
  "sourceContentDigest",
  "candidateContentDigest",
  "validatedCandidateTokens"
];
const VALIDATION_RUNTIME_FIELDS = ["validatedAt", "zeroMutation", "actualReductionTokens"];
const CANDIDATE_FIELDS = [
  "schemaVersion",
  "candidateId",
  "sourceExecutablePlanId",
  "inventory",
  "status",
  "decisions",
  "runtime"
];
const CANDIDATE_DECISION_FIELDS = [
  "unitId",
  "action",
  "operation",
  "sourceContentDigest",
  "candidateContent",
  "candidateContentDigest",
  "requestedTargetTokens",
  "candidateEstimatedTokens"
];
const CANDIDATE_RUNTIME_FIELDS = ["generatedAt", "zeroMutation", "actualReductionTokens"];
const PLAN_FIELDS = [
  "schemaVersion",
  "executablePlanId",
  "sourceValidatedPlanId",
  "inventory",
  "status",
  "decisions",
  "runtime"
];
const PLAN_DECISION_FIELDS = [
  "unitId",
  "action",
  "executionDisposition",
  "importance",
  "requestedTargetTokens",
  "potentialReductionUpperBound",
  "recoveryProof"
];
const PLAN_RUNTIME_FIELDS = [
  "checkedAt",
  "requiredReductionTokens",
  "potentialReductionUpperBound",
  "actualReductionTokens",
  "zeroMutation"
];
const IDENTITY_FIELDS = ["id", "fingerprint"];
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DESTRUCTIVE_ACTIONS = new Set(["EVICT", "EXTERNALIZE", "COMPRESS"]);

function exactFields(value, fields) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && fields.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => fields.includes(field));
}

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function validIdentity(value) {
  return exactFields(value, IDENTITY_FIELDS)
    && typeof value.id === "string"
    && FINGERPRINT_PATTERN.test(String(value.fingerprint ?? ""));
}

function validDigest(value) {
  return value === null || DIGEST_PATTERN.test(String(value ?? ""));
}

function validValidatedTransformation(value) {
  return exactFields(value, VALIDATION_FIELDS)
    && value.schemaVersion === VALIDATED_TRANSFORMATION_SCHEMA_VERSION
    && /^validation_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(String(value.validationId ?? ""))
    && /^candidate_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(String(value.sourceCandidateId ?? ""))
    && validIdentity(value.inventory)
    && value.status === "VALIDATED"
    && Array.isArray(value.decisions)
    && value.decisions.every((decision) => (
      exactFields(decision, VALIDATION_DECISION_FIELDS)
      && isContextUnitId(decision.unitId)
      && Object.hasOwn(ACTION_OPERATION, decision.action)
      && TRANSFORMATION_OPERATIONS.includes(decision.operation)
      && decision.permission === "APPROVED"
      && DIGEST_PATTERN.test(String(decision.sourceContentDigest ?? ""))
      && validDigest(decision.candidateContentDigest)
      && (decision.validatedCandidateTokens === null
        || (Number.isSafeInteger(decision.validatedCandidateTokens)
          && decision.validatedCandidateTokens >= 0))
    ))
    && new Set(value.decisions.map((decision) => decision.unitId)).size === value.decisions.length
    && exactFields(value.runtime, VALIDATION_RUNTIME_FIELDS)
    && validTimestamp(value.runtime.validatedAt)
    && value.runtime.zeroMutation === true
    && value.runtime.actualReductionTokens === null;
}

function validCandidate(value) {
  return exactFields(value, CANDIDATE_FIELDS)
    && value.schemaVersion === TRANSFORMATION_CANDIDATE_SCHEMA_VERSION
    && /^candidate_[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(String(value.candidateId ?? ""))
    && typeof value.sourceExecutablePlanId === "string"
    && validIdentity(value.inventory)
    && value.status === "PREPARED"
    && Array.isArray(value.decisions)
    && value.decisions.every((decision) => (
      exactFields(decision, CANDIDATE_DECISION_FIELDS)
      && isContextUnitId(decision.unitId)
      && Object.hasOwn(ACTION_OPERATION, decision.action)
      && TRANSFORMATION_OPERATIONS.includes(decision.operation)
      && DIGEST_PATTERN.test(String(decision.sourceContentDigest ?? ""))
      && (decision.candidateContent === null || typeof decision.candidateContent === "string")
      && validDigest(decision.candidateContentDigest)
      && (decision.requestedTargetTokens === null
        || (Number.isSafeInteger(decision.requestedTargetTokens) && decision.requestedTargetTokens > 0))
      && (decision.candidateEstimatedTokens === null
        || (Number.isSafeInteger(decision.candidateEstimatedTokens)
          && decision.candidateEstimatedTokens >= 0))
    ))
    && new Set(value.decisions.map((decision) => decision.unitId)).size === value.decisions.length
    && exactFields(value.runtime, CANDIDATE_RUNTIME_FIELDS)
    && validTimestamp(value.runtime.generatedAt)
    && value.runtime.zeroMutation === true
    && value.runtime.actualReductionTokens === null;
}

function validExecutablePlan(value) {
  return exactFields(value, PLAN_FIELDS)
    && value.schemaVersion === EXECUTABLE_PLAN_SCHEMA_VERSION
    && typeof value.executablePlanId === "string"
    && validIdentity(value.inventory)
    && value.status === "EXECUTABLE"
    && Array.isArray(value.decisions)
    && value.decisions.every((decision) => (
      exactFields(decision, PLAN_DECISION_FIELDS)
      && isContextUnitId(decision.unitId)
      && Object.hasOwn(ACTION_OPERATION, decision.action)
      && decision.recoveryProof
      && ["VERIFIED", "NOT_REQUIRED"].includes(decision.recoveryProof.status)
    ))
    && new Set(value.decisions.map((decision) => decision.unitId)).size === value.decisions.length
    && exactFields(value.runtime, PLAN_RUNTIME_FIELDS)
    && value.runtime.zeroMutation === true
    && value.runtime.actualReductionTokens === null;
}

function sameIdentity(...values) {
  return values.every((value) => value?.id === values[0]?.id
    && value?.fingerprint === values[0]?.fingerprint);
}

function messageContent(message) {
  const wire = serializeMessageForModel(message);
  return Object.keys(wire).length === 2 && typeof wire.content === "string"
    ? wire.content
    : JSON.stringify(wire);
}

function contextUnitId(message) {
  return message?.context_os?.contextUnitId;
}

function validContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return false;
  if (!Array.isArray(context.messages)
    || !Number.isSafeInteger(context.contextGeneration)
    || context.contextGeneration < 0) return false;
  const messagesDescriptor = Object.getOwnPropertyDescriptor(context, "messages");
  const generationDescriptor = Object.getOwnPropertyDescriptor(context, "contextGeneration");
  return messagesDescriptor?.writable === true && generationDescriptor?.writable === true;
}

function validCurrentInventory(inventory) {
  return inventory
    && typeof inventory === "object"
    && validIdentity(inventory.inventory)
    && Array.isArray(inventory.units)
    && inventory.units.every((unit) => (
      unit
      && typeof unit === "object"
      && isContextUnitId(unit.id)
      && typeof unit.content === "string"
      && typeof unit.recoverability === "string"
      && (unit.recoveryRef === null
        || (typeof unit.recoveryRef === "object" && !Array.isArray(unit.recoveryRef)))
    ))
    && new Set(inventory.units.map((unit) => unit.id)).size === inventory.units.length;
}

function chainIsExact({ validatedTransformation, candidate, executablePlan, inventory, messages }) {
  if (!validCandidate(candidate) || !validExecutablePlan(executablePlan) || !validCurrentInventory(inventory)) {
    return false;
  }
  if (validatedTransformation.sourceCandidateId !== candidate.candidateId
    || candidate.sourceExecutablePlanId !== executablePlan.executablePlanId
    || !sameIdentity(
      validatedTransformation.inventory,
      candidate.inventory,
      executablePlan.inventory,
      inventory.inventory
    )) return false;

  const ids = inventory.units.map((unit) => unit.id);
  const messageIds = messages.map(contextUnitId).filter((id) => id !== undefined && id !== null);
  if (new Set(messageIds).size !== messageIds.length
    || messageIds.length !== ids.length
    || messageIds.some((id, index) => id !== ids[index])) return false;

  const validationById = new Map(validatedTransformation.decisions.map((decision) => [decision.unitId, decision]));
  const candidateById = new Map(candidate.decisions.map((decision) => [decision.unitId, decision]));
  const planById = new Map(executablePlan.decisions.map((decision) => [decision.unitId, decision]));
  if ([validationById, candidateById, planById].some((map) => map.size !== ids.length)) return false;
  return ids.every((unitId) => {
    const validation = validationById.get(unitId);
    const prepared = candidateById.get(unitId);
    const executable = planById.get(unitId);
    return validation
      && prepared
      && executable
      && validation.action === prepared.action
      && prepared.action === executable.action
      && validation.operation === prepared.operation
      && prepared.operation === ACTION_OPERATION[executable.action]
      && validation.validatedCandidateTokens === prepared.candidateEstimatedTokens
      && prepared.requestedTargetTokens === executable.requestedTargetTokens;
  });
}

function contentBindings({ validatedTransformation, candidate, inventory, messages }) {
  const validationById = new Map(validatedTransformation.decisions.map((decision) => [decision.unitId, decision]));
  const candidateById = new Map(candidate.decisions.map((decision) => [decision.unitId, decision]));
  const inventoryById = new Map(inventory.units.map((unit) => [unit.id, unit]));
  const reasons = [];
  const checks = [];
  for (const message of messages) {
    const unitId = contextUnitId(message);
    if (unitId === undefined || unitId === null) continue;
    const validation = validationById.get(unitId);
    const prepared = candidateById.get(unitId);
    const unit = inventoryById.get(unitId);
    const currentDigest = contentDigest(messageContent(message));
    const sourceMatches = currentDigest === validation.sourceContentDigest
      && currentDigest === prepared.sourceContentDigest
      && currentDigest === contentDigest(unit.content);
    if (!sourceMatches && !reasons.includes("SOURCE_CONTENT_CHANGED")) {
      reasons.push("SOURCE_CONTENT_CHANGED");
    }
    let candidateMatches = true;
    if (prepared.operation === "REPLACE") {
      candidateMatches = typeof prepared.candidateContent === "string"
        && contentDigest(prepared.candidateContent) === validation.candidateContentDigest
        && contentDigest(prepared.candidateContent) === prepared.candidateContentDigest;
      if (!candidateMatches && !reasons.includes("CANDIDATE_CONTENT_CHANGED")) {
        reasons.push("CANDIDATE_CONTENT_CHANGED");
      }
    }
    checks.push({ unitId, sourceMatches, candidateMatches });
  }
  return { valid: reasons.length === 0, reasons, checks };
}

function validateToolProtocol(messages) {
  let pending = null;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.role !== "string") {
      return false;
    }
    if (message.role === "tool") {
      if (!pending || typeof message.tool_call_id !== "string" || !pending.delete(message.tool_call_id)) {
        return false;
      }
      if (pending.size === 0) pending = null;
      continue;
    }
    if (pending) return false;
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const ids = message.tool_calls.map((call) => call?.id);
      if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) return false;
      pending = new Set(ids);
    }
  }
  return pending === null;
}

function buildNextContext({ messages, candidate }) {
  const candidateById = new Map(candidate.decisions.map((decision) => [decision.unitId, decision]));
  const nextMessages = [];
  for (const source of messages) {
    const decision = candidateById.get(contextUnitId(source));
    if (!decision) {
      nextMessages.push(structuredClone(source));
      continue;
    }
    if (decision.operation === "REMOVE") continue;
    const next = structuredClone(source);
    if (decision.operation === "REPLACE") next.content = decision.candidateContent;
    nextMessages.push(next);
  }
  if (!validateToolProtocol(nextMessages)) throw new Error("Transformed messages violate tool-call structure");
  return nextMessages;
}

function commitContext(context, nextMessages, expectedGeneration) {
  const previousMessages = context.messages;
  const previousGeneration = context.contextGeneration;
  try {
    context.messages = nextMessages;
    context.contextGeneration = expectedGeneration + 1;
  } catch (error) {
    try {
      context.messages = previousMessages;
      context.contextGeneration = previousGeneration;
    } catch {
      // The target was prevalidated as writable; this is only a best-effort rollback for exotic proxies.
    }
    throw error;
  }
}

export class AtomicExecutor {
  constructor({ now = () => new Date() } = {}) {
    if (typeof now !== "function") throw new Error("AtomicExecutor now must be a function");
    this.now = now;
    this.consumedValidationIds = new Set();
    this.inFlightValidationIds = new Set();
    this.activeContexts = new WeakSet();
  }

  async execute({
    validatedTransformation,
    candidate,
    executablePlan,
    inventory,
    context,
    recoveryVerifier,
    contextManager,
    tools = []
  } = {}) {
    const abortedAt = this.now().toISOString();
    const abort = (reasonCodes, checks = []) => createExecutionAbort({
      validatedTransformation,
      inventory,
      reasonCodes,
      checks,
      abortedAt
    });
    if (!validValidatedTransformation(validatedTransformation)) {
      return abort(["INVALID_VALIDATED_TRANSFORMATION"]);
    }
    if (this.consumedValidationIds.has(validatedTransformation.validationId)
      || this.inFlightValidationIds.has(validatedTransformation.validationId)) {
      return abort(["EXECUTION_ALREADY_CONSUMED"]);
    }
    if (!validContext(context)
      || !(recoveryVerifier instanceof RecoveryVerifier)
      || !(contextManager instanceof ContextManager)
      || !Array.isArray(tools)) {
      return abort(["EXECUTION_CHAIN_MISMATCH"]);
    }
    if (this.activeContexts.has(context)) return abort(["EXECUTION_STALE_CONTEXT"]);

    if (!validCandidate(candidate) || !validExecutablePlan(executablePlan) || !validCurrentInventory(inventory)) {
      return abort(["EXECUTION_CHAIN_MISMATCH"]);
    }
    if (validatedTransformation.sourceCandidateId !== candidate.candidateId
      || candidate.sourceExecutablePlanId !== executablePlan.executablePlanId) {
      return abort(["EXECUTION_CHAIN_MISMATCH"]);
    }
    if (!sameIdentity(
      validatedTransformation.inventory,
      candidate.inventory,
      executablePlan.inventory,
      inventory.inventory
    )) return abort(["EXECUTION_STALE_CONTEXT"]);

    const generationBefore = context.contextGeneration;
    const messagesBefore = context.messages;
    if (!chainIsExact({
      validatedTransformation,
      candidate,
      executablePlan,
      inventory,
      messages: messagesBefore
    })) return abort(["EXECUTION_CHAIN_MISMATCH"]);
    let initialBindings;
    try {
      initialBindings = contentBindings({
        validatedTransformation,
        candidate,
        inventory,
        messages: messagesBefore
      });
    } catch {
      return abort(["SOURCE_CONTENT_CHANGED"]);
    }
    if (!initialBindings.valid) return abort(initialBindings.reasons, initialBindings.checks);

    let tokenAccountingBefore;
    let toolsDigest;
    try {
      tokenAccountingBefore = contextManager.estimateComponents(messagesBefore, tools);
      toolsDigest = accountingToolsDigest(tools);
      if (!validTokenBreakdown(tokenAccountingBefore)) throw new Error("Invalid token accounting breakdown");
    } catch {
      return abort(["EXECUTION_BUILD_FAILED"]);
    }

    let nextMessages;
    try {
      nextMessages = buildNextContext({ messages: messagesBefore, candidate });
    } catch {
      return abort(["EXECUTION_BUILD_FAILED"]);
    }

    this.inFlightValidationIds.add(validatedTransformation.validationId);
    this.activeContexts.add(context);
    try {
      const unitById = new Map(inventory.units.map((unit) => [unit.id, unit]));
      const recoveryChecks = [];
      for (const decision of executablePlan.decisions.filter((entry) => DESTRUCTIVE_ACTIONS.has(entry.action))) {
        let proof;
        try {
          proof = await recoveryVerifier.verify({ unit: unitById.get(decision.unitId), action: decision.action });
        } catch (error) {
          recoveryChecks.push({
            unitId: decision.unitId,
            action: decision.action,
            recoveryProof: null,
            detail: String(error?.message ?? error).slice(0, 500)
          });
          return abort(["RECOVERY_REVALIDATION_FAILED"], recoveryChecks);
        }
        recoveryChecks.push({ unitId: decision.unitId, action: decision.action, recoveryProof: proof });
        if (decision.recoveryProof.status === "VERIFIED" && proof.status !== "VERIFIED") {
          return abort(["RECOVERY_REVALIDATION_FAILED"], recoveryChecks);
        }
        if (decision.recoveryProof.status === "NOT_REQUIRED" && proof.status !== "NOT_REQUIRED") {
          return abort(["RECOVERY_REVALIDATION_FAILED"], recoveryChecks);
        }
      }

      if (context.contextGeneration !== generationBefore || context.messages !== messagesBefore) {
        return abort(["EXECUTION_STALE_CONTEXT"], recoveryChecks);
      }
      if (!chainIsExact({
        validatedTransformation,
        candidate,
        executablePlan,
        inventory,
        messages: context.messages
      })) return abort(["EXECUTION_STALE_CONTEXT"], recoveryChecks);
      let finalBindings;
      try {
        finalBindings = contentBindings({
          validatedTransformation,
          candidate,
          inventory,
          messages: context.messages
        });
      } catch {
        return abort(["SOURCE_CONTENT_CHANGED"], recoveryChecks);
      }
      if (!finalBindings.valid) return abort(finalBindings.reasons, [...recoveryChecks, ...finalBindings.checks]);

      try {
        commitContext(context, nextMessages, generationBefore);
        this.consumedValidationIds.add(validatedTransformation.validationId);
      } catch {
        return abort(["EXECUTION_COMMIT_FAILED"], recoveryChecks);
      }
      return createExecutionResult({
        validatedTransformation,
        inventoryBefore: inventory.inventory,
        operations: candidate.decisions.map(({ unitId, operation }) => ({ unitId, operation })),
        potentialReductionUpperBound: executablePlan.runtime.potentialReductionUpperBound,
        tokenAccountingBefore,
        toolsDigest,
        committedAt: this.now().toISOString(),
        generationBefore,
        generationAfter: context.contextGeneration
      });
    } finally {
      this.inFlightValidationIds.delete(validatedTransformation.validationId);
      this.activeContexts.delete(context);
    }
  }
}

const defaultExecutor = new AtomicExecutor();

export async function executeTransformation(input) {
  return defaultExecutor.execute(input);
}
