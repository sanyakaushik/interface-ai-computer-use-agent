// Resolves an `extract` step's output value deterministically at replay time — no LLM involved.
// Handles the one UI pattern our target app (and, by design, most back-office summary/detail
// screens) uses to present a fact: a "Label" / "Value" table row. Documented as a deliberate cut
// in REPORT.md: this does not attempt to extract values from arbitrary prose.
import type { LocatorCandidate } from "../artifact/schema.js";
import type { LocatorRoot } from "./locator.js";

export async function resolveExtractedValue(root: LocatorRoot, candidates: LocatorCandidate[]): Promise<string> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    if (candidate.strategy !== "labelledValue") continue;
    try {
      const rowLocator = root.locator("tr", { hasText: candidate.value });
      if ((await rowLocator.count()) > 0) {
        const cells = rowLocator.first().locator("td");
        if ((await cells.count()) >= 2) {
          const text = (await cells.nth(1).innerText()).trim();
          if (text) return text;
        }
      }
    } catch (err) {
      errors.push(`${candidate.value}: ${(err as Error).message}`);
    }
  }
  throw new Error(`Could not resolve extracted value (label candidates: ${candidates.map((c) => c.value).join(", ")}). ${errors.join("; ")}`);
}
