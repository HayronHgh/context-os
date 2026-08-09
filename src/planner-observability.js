export function createPlannerSessionAudit(memory) {
  if (!memory || typeof memory.appendSession !== "function") {
    throw new Error("Planner session audit requires appendSession(event)");
  }
  return async (event) => {
    memory.appendSession(structuredClone(event));
  };
}
function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function reasonDistribution(decisions) {
  const counts = {};
  for (const decision of decisions) {
    for (const code of decision.reasonCodes) counts[code] = (counts[code] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function plannerMetrics({ input, plan, validatedPlan, plannerRun = null }) {
  const explicitIds = new Set(plan.decisions.map((decision) => decision.unitId));
  const explicit = validatedPlan.decisions.filter((decision) => explicitIds.has(decision.unitId));
  const authorized = explicit.filter((decision) => decision.permission === "AUTHORIZED").length;
  const rejected = explicit.filter((decision) => decision.permission === "REJECTED").length;
  const auditOnly = explicit.filter((decision) => decision.permission === "AUDIT_ONLY").length;
  const nonAudit = explicit.length - auditOnly;
  const reasons = reasonDistribution(explicit);
  return {
    plannerInputTokens: plannerRun?.inputTokens ?? input.estimatedInputTokens,
    plannerOutputTokens: plannerRun?.outputTokens ?? null,
    plannerLatencyMs: plannerRun?.latencyMs ?? null,
    visibleUnits: input.visibleUnitIds.length,
    hiddenUnits: input.hiddenUnitIds.length,
    explicitDecisions: explicit.length,
    implicitKeeps: validatedPlan.decisions.length - explicit.length,
    parseAttempts: plannerRun?.attempts ?? null,
    parseFailures: plannerRun?.parseFailures ?? null,
    authorizedDecisions: authorized,
    rejectedDecisions: rejected,
    auditOnlyDecisions: auditOnly,
    rejectionReasonDistribution: reasons,
    protectedProposalViolationRate: ratio(reasons.PROTECTED_UNIT ?? 0, nonAudit),
    recoverabilityViolationRate: ratio(reasons.NON_RECOVERABLE ?? 0, nonAudit),
    dependencyViolationRate: ratio(reasons.ACTIVE_DEPENDENCY ?? 0, nonAudit),
    proposalAuthorizationRate: ratio(authorized, nonAudit),
    illegalProposalRate: ratio(rejected, nonAudit),
    potentialReductionUpperBound: validatedPlan.runtime.potentialReductionUpperBound,
    requiredReductionTokens: validatedPlan.runtime.requiredReductionTokens
  };
}
