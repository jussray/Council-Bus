// Production entrypoint: one Worker handles HTTP, Queue, Cron and Workflow steps.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { createCouncilApplication, runCouncilWorkflow } from "./durable-core.js";

export class CouncilApprovalWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runCouncilWorkflow(event, step, this.env);
  }
}

export default createCouncilApplication();
