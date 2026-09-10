// Structured evidence logger (spec 3.5): one JSONL log per run under /evidence/<runId>/, plus
// screenshot/snapshot capture on failure or business outcome. Used by both the discovery loop
// and the replay engine so both produce the same shape of evidence.
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../safety/redaction.js";

export interface LogEntry {
  ts: string;
  runId: string;
  kind: "discovery" | "replay";
  step: number | string;
  event: string; // e.g. "observe", "decide", "act", "outcome", "error", "escalate"
  detail: Record<string, unknown>;
}

export class EvidenceLogger {
  readonly runDir: string;
  private readonly logPath: string;

  constructor(
    public readonly runId: string,
    public readonly kind: "discovery" | "replay",
    evidenceRoot = "evidence"
  ) {
    this.runDir = join(evidenceRoot, runId);
    if (!existsSync(this.runDir)) mkdirSync(this.runDir, { recursive: true });
    this.logPath = join(this.runDir, "log.jsonl");
  }

  log(step: number | string, event: string, detail: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      runId: this.runId,
      kind: this.kind,
      step,
      event,
      detail: redactDetail(detail),
    };
    appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  saveScreenshot(name: string, pngBuffer: Buffer): string {
    const path = join(this.runDir, `${name}.png`);
    writeFileSync(path, pngBuffer);
    return path;
  }

  saveSnapshot(name: string, snapshotText: string): string {
    const path = join(this.runDir, `${name}.snapshot.txt`);
    writeFileSync(path, redactText(snapshotText), "utf-8");
    return path;
  }

  saveJson(name: string, data: unknown): string {
    const path = join(this.runDir, `${name}.json`);
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
    return path;
  }
}

function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    out[k] = typeof v === "string" ? redactText(v) : v;
  }
  return out;
}

export function newRunId(prefix: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}
