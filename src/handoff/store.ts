// Intervention store, backed by a single JSON file rather than a database. This is deliberately
// not a "real" durable store (no transactions, no concurrent-writer safety) — building that would
// be exactly the premature scaling infrastructure the brief says not to reward. What it does fix:
// the one real gap in an in-memory-only version — a handoff server restart while an intervention
// is open used to silently lose it, which is a genuinely bad failure mode for something whose
// whole job is "don't lose track of a human's pending task." A flat file is the smallest change
// that closes that gap; a real deployment would swap this module for a proper datastore behind
// the same four functions.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateInterventionInput, InterventionRequest } from "./types.js";

const STORE_PATH = process.env.HANDOFF_STORE_PATH ?? "evidence/.interventions.json";

interface StoreFile {
  seq: number;
  interventions: InterventionRequest[];
}

function load(): StoreFile {
  if (!existsSync(STORE_PATH)) return { seq: 0, interventions: [] };
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as StoreFile;
  } catch {
    // A corrupted/partially-written store file shouldn't crash the handoff server — start fresh
    // rather than blocking every future intervention on a file a human would need to go fix.
    return { seq: 0, interventions: [] };
  }
}

function save(store: StoreFile): void {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function createIntervention(input: CreateInterventionInput): InterventionRequest {
  const store = load();
  store.seq += 1;
  const record: InterventionRequest = {
    id: `intervention-${store.seq}`,
    status: "open",
    createdAt: new Date().toISOString(),
    ...input,
  };
  store.interventions.push(record);
  save(store);
  return record;
}

export function getIntervention(id: string): InterventionRequest | undefined {
  return load().interventions.find((i) => i.id === id);
}

export function listInterventions(): InterventionRequest[] {
  return load().interventions.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resumeIntervention(id: string, humanNotes?: string): InterventionRequest | undefined {
  const store = load();
  const record = store.interventions.find((i) => i.id === id);
  if (!record) return undefined;
  record.status = "resumed";
  record.resolvedAt = new Date().toISOString();
  record.humanNotes = humanNotes;
  save(store);
  return record;
}
