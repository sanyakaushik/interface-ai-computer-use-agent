// Client used by the discovery loop and the replay engine to raise an intervention and then
// block until a human resumes it. Talking over HTTP (rather than an in-process call) mirrors a
// real deployment where the automation engine and the operator-facing control plane are separate
// processes/services.
import type { CreateInterventionInput, InterventionRequest } from "./types.js";

const HANDOFF_URL = `http://localhost:${process.env.HANDOFF_PORT ?? 4100}`;

export async function raiseIntervention(input: CreateInterventionInput): Promise<InterventionRequest> {
  const res = await fetch(`${HANDOFF_URL}/interventions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to raise intervention: ${res.status} ${await res.text()}`);
  return (await res.json()) as InterventionRequest;
}

export async function waitForResume(id: string, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<InterventionRequest> {
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${HANDOFF_URL}/interventions/${id}`);
    if (res.ok) {
      const record = (await res.json()) as InterventionRequest;
      if (record.status === "resumed") return record;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for human to resume intervention ${id}`);
}

export function operatorUrl(): string {
  return `${HANDOFF_URL}/operator`;
}
