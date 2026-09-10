export type InterventionStatus = "open" | "resumed" | "abandoned";

export interface InterventionRequest {
  id: string;
  runId: string;
  kind: "discovery" | "replay";
  capabilityOrGoal: string; // capability id (replay) or the natural-language goal (discovery)
  currentStep: string; // step id or a short description of where execution was
  reason: string; // why the system stopped
  screenshotPath?: string; // relative path under /evidence
  snapshotText?: string; // perception/DOM snapshot text, truncated
  status: InterventionStatus;
  createdAt: string;
  resolvedAt?: string;
  humanNotes?: string;
}

export interface CreateInterventionInput {
  runId: string;
  kind: "discovery" | "replay";
  capabilityOrGoal: string;
  currentStep: string;
  reason: string;
  screenshotPath?: string;
  snapshotText?: string;
}
