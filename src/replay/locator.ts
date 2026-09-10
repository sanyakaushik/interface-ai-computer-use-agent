// Resolves a step's ranked locator candidates against the live page (spec 3.3: "stable
// element/control targeting"). Tries strategies in the order the artifact stored them —
// role+name first (survives markup/attribute churn since it targets accessibility semantics),
// then visible text, then a structural CSS path as a last resort. Each attempt gets a short,
// independent timeout so one dead candidate doesn't stall the whole step past its budget.
//
// Operates against a `LocatorRoot` (a Page or a Frame — Playwright gives both the same
// getByRole/getByText/locator API), resolved by `resolveFrameRoot` in engine.ts before this
// function is called — this file doesn't know or care whether the target is on the main
// document or inside an embedded iframe.
import type { Locator, Page, Frame } from "playwright";
import { ROLE_MAP } from "../agent/actions.js";
import type { LocatorCandidate } from "../artifact/schema.js";

export type LocatorRoot = Page | Frame;

export interface LocatorAttempt {
  candidate: LocatorCandidate;
  ok: boolean;
  error?: string;
}

export interface LocatorResolution {
  locator: Locator;
  usedCandidate: LocatorCandidate;
  attempts: LocatorAttempt[];
}

export class LocatorResolutionError extends Error {
  constructor(
    public readonly attempts: LocatorAttempt[],
    message: string
  ) {
    super(message);
    this.name = "LocatorResolutionError";
  }
}

const CANDIDATE_TIMEOUT_MS = 2000;

export async function resolveLocator(root: LocatorRoot, candidates: LocatorCandidate[]): Promise<LocatorResolution> {
  const attempts: LocatorAttempt[] = [];
  for (const candidate of candidates) {
    try {
      const locator = buildLocator(root, candidate);
      await locator.waitFor({ state: "visible", timeout: CANDIDATE_TIMEOUT_MS });
      attempts.push({ candidate, ok: true });
      return { locator, usedCandidate: candidate, attempts };
    } catch (err) {
      attempts.push({ candidate, ok: false, error: (err as Error).message });
    }
  }
  throw new LocatorResolutionError(
    attempts,
    `No locator candidate resolved (tried ${candidates.map((c) => `${c.strategy}:"${c.value}"`).join(", ")}).`
  );
}

function buildLocator(root: LocatorRoot, candidate: LocatorCandidate): Locator {
  switch (candidate.strategy) {
    case "role+name": {
      const role = ROLE_MAP[candidate.role ?? ""];
      if (!role) throw new Error(`Unknown role "${candidate.role}" for role+name candidate.`);
      return root.getByRole(role, { name: candidate.value, exact: true });
    }
    case "text":
      return root.getByText(candidate.value, { exact: true });
    case "cssPath":
      return root.locator(candidate.value);
    case "labelledValue":
      throw new Error('"labelledValue" candidates are for extraction only; use resolveExtractedValue.');
  }
}
