import { CompactionPlanError, validatePlanBinding } from "./compaction-plan.js";
import { validateCompactionAuthorization } from "./compaction-validator.js";
import { plannerMetrics } from "./planner-observability.js";
import { assertContextPlanner } from "./planners/planner.js";
import { buildPlannerInput } from "./planners/planner-input.js";
import { SemanticPlannerError } from "./planners/qwen-planner.js";

async function emit(audit, event) {
  if (typeof audit === "function") await audit(structuredClone(event));
}

function failure(status, error, input) {
  return {
    status,
    fallbackRequired: true,
    error: {
      code: error.code ?? "PLANNER_FAILED",
      causeCode: error.causeCode ?? null,
      message: error.message
    },
    visibleUnitIds: input?.visibleUnitIds ?? [],
    hiddenUnitIds: input?.hiddenUnitIds ?? [],
    plan: null,
    validatedPlan: null,
    metrics: null
  };
}

export async function generateSemanticProposal({
  planner,
  inventory,
  pressure,
  task = null,
  config = {},
  requestedPlanId = null,
  audit = () => {},
  currentInventory = null
} = {}) {
  const selectedPlanner = assertContextPlanner(planner);
  const input = buildPlannerInput(inventory, { pressure, task, config, requestedPlanId });
  let plan;
  try {
    plan = await selectedPlanner.plan(input);
  } catch (error) {
    const plannerError = error instanceof SemanticPlannerError
      ? error
      : new SemanticPlannerError("PLANNER_FAILED", error?.message ?? String(error));
    const status = plannerError.code === "STALE_INVENTORY" ? "STALE_INVENTORY" : "PLANNER_FAILED";
    const result = failure(status, plannerError, input);
    await emit(audit, {
      type: "semantic_planner_result",
      plannerVersion: input.payload.plannerPromptVersion,
      inventoryId: input.payload.inventory.id,
      status,
      fallbackRequired: true,
      errorCode: result.error.code,
      causeCode: result.error.causeCode
    });
    return result;
  }

  const latestInventory = typeof currentInventory === "function"
    ? await currentInventory()
    : inventory;
  try {
    validatePlanBinding(plan, latestInventory);
  } catch (error) {
    if (error instanceof CompactionPlanError && error.code === "STALE_INVENTORY") {
      const result = failure("STALE_INVENTORY", error, input);
      await emit(audit, {
        type: "semantic_planner_result",
        plannerVersion: input.payload.plannerPromptVersion,
        inventoryId: input.payload.inventory.id,
        status: "STALE_INVENTORY",
        fallbackRequired: true,
        errorCode: "STALE_INVENTORY"
      });
      return result;
    }
    const result = failure("PLANNER_FAILED", error, input);
    await emit(audit, {
      type: "semantic_planner_result",
      plannerVersion: input.payload.plannerPromptVersion,
      inventoryId: input.payload.inventory.id,
      status: "PLANNER_FAILED",
      fallbackRequired: true,
      errorCode: error.code ?? "PLANNER_FAILED"
    });
    return result;
  }

  const validatedPlan = validateCompactionAuthorization({
    plan,
    inventory: latestInventory,
    pressure
  });
  const metrics = plannerMetrics({
    input,
    plan,
    validatedPlan,
    plannerRun: selectedPlanner.lastRun ?? null
  });
  const result = {
    status: "VALIDATED",
    fallbackRequired: validatedPlan.runtime.fallbackRequired,
    error: null,
    visibleUnitIds: [...input.visibleUnitIds],
    hiddenUnitIds: [...input.hiddenUnitIds],
    plan,
    validatedPlan,
    metrics
  };
  await emit(audit, {
    type: "semantic_planner_result",
    plannerVersion: input.payload.plannerPromptVersion,
    inventoryId: input.payload.inventory.id,
    inventoryFingerprint: input.payload.inventory.fingerprint,
    planId: plan.planId,
    status: result.status,
    fallbackRequired: result.fallbackRequired,
    validatorStatus: validatedPlan.status,
    ...metrics
  });
  return result;
}
