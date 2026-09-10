import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";

// The store reads its path from HANDOFF_STORE_PATH at import time, so it must be set before the
// dynamic import below — this also lets each test run against an isolated file.
const TEST_STORE_PATH = "evidence/.test-interventions.json";

describe("durable intervention store", () => {
  beforeEach(() => {
    if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH);
    process.env.HANDOFF_STORE_PATH = TEST_STORE_PATH;
  });

  afterEach(() => {
    if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH);
    delete process.env.HANDOFF_STORE_PATH;
  });

  it("creates and retrieves an intervention, persisted across separate calls", async () => {
    const { createIntervention, getIntervention } = await import(/* @vite-ignore */ `../src/handoff/store.js?t=${Date.now()}`);
    const created = createIntervention({
      runId: "run-1",
      kind: "discovery",
      capabilityOrGoal: "test goal",
      currentStep: "step-1",
      reason: "test reason",
    });
    expect(created.id).toBe("intervention-1");
    expect(created.status).toBe("open");
    expect(existsSync(TEST_STORE_PATH)).toBe(true);

    const fetched = getIntervention(created.id);
    expect(fetched?.reason).toBe("test reason");
  });

  it("survives a fresh module load reading the same file (simulating a process restart)", async () => {
    const store1 = await import(/* @vite-ignore */ `../src/handoff/store.js?t=${Date.now()}-a`);
    store1.createIntervention({ runId: "run-1", kind: "replay", capabilityOrGoal: "cap", currentStep: "s1", reason: "r1" });

    // A distinct module instance (different query string busts the ESM cache) reading the same
    // file stands in for "the process restarted" — the record must still be there.
    const store2 = await import(/* @vite-ignore */ `../src/handoff/store.js?t=${Date.now()}-b`);
    const listed = store2.listInterventions();
    expect(listed).toHaveLength(1);
    expect(listed[0].reason).toBe("r1");
  });

  it("resumeIntervention persists status and notes, and returns undefined for an unknown id", async () => {
    const { createIntervention, resumeIntervention, getIntervention } = await import(/* @vite-ignore */ `../src/handoff/store.js?t=${Date.now()}`);
    const created = createIntervention({ runId: "run-2", kind: "discovery", capabilityOrGoal: "g", currentStep: "s", reason: "r" });

    expect(resumeIntervention("does-not-exist")).toBeUndefined();

    const resumed = resumeIntervention(created.id, "fixed it manually");
    expect(resumed?.status).toBe("resumed");
    expect(resumed?.humanNotes).toBe("fixed it manually");
    expect(getIntervention(created.id)?.status).toBe("resumed");
  });

  it("recovers gracefully from a corrupted store file instead of throwing", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync("evidence", { recursive: true });
    writeFileSync(TEST_STORE_PATH, "{not valid json", "utf-8");

    const { listInterventions } = await import(/* @vite-ignore */ `../src/handoff/store.js?t=${Date.now()}`);
    expect(listInterventions()).toEqual([]);
  });
});
