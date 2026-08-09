export class ContextPlanner {
  async plan(_input) {
    throw new Error("ContextPlanner.plan(input) must be implemented");
  }
}

export function assertContextPlanner(planner) {
  if (!planner || typeof planner.plan !== "function") {
    throw new Error("Context Planner must provide an async plan(input) function");
  }
  return planner;
}
