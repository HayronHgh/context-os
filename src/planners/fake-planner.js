import { ContextPlanner } from "./planner.js";

export class FakePlanner extends ContextPlanner {
  constructor({ plan } = {}) {
    super();
    if (plan === undefined) throw new Error("FakePlanner requires a plan or plan provider");
    this.configuredPlan = plan;
    this.calls = [];
  }

  async plan(input) {
    const captured = structuredClone(input);
    this.calls.push(captured);
    const output = typeof this.configuredPlan === "function"
      ? await this.configuredPlan(captured)
      : this.configuredPlan;
    return structuredClone(output);
  }
}
