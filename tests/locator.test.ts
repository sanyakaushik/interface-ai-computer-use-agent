import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolveLocator, LocatorResolutionError } from "../src/replay/locator.js";
import type { LocatorCandidate } from "../src/artifact/schema.js";

let browser: Browser;
let page: Page;

const HTML = `
<!doctype html>
<html><body>
  <table>
    <tr><td>Savings Balance</td><td>$4821.13</td></tr>
  </table>
  <button>Open Sub-Account</button>
</body></html>
`;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(HTML);
});

afterAll(async () => {
  await browser.close();
});

describe("replay locator fallback chain", () => {
  it("resolves via the first matching candidate (role+name)", async () => {
    const candidates: LocatorCandidate[] = [
      { strategy: "role+name", role: "button", value: "Open Sub-Account", confidence: 0.9 },
      { strategy: "text", value: "Open Sub-Account", confidence: 0.5 },
    ];
    const resolution = await resolveLocator(page, candidates);
    expect(resolution.usedCandidate.strategy).toBe("role+name");
    expect(resolution.attempts).toHaveLength(1);
  });

  it("falls back to the text candidate when role+name no longer matches", async () => {
    const candidates: LocatorCandidate[] = [
      { strategy: "role+name", role: "button", value: "Renamed Button That Does Not Exist", confidence: 0.9 },
      { strategy: "text", value: "Open Sub-Account", confidence: 0.5 },
    ];
    const resolution = await resolveLocator(page, candidates);
    expect(resolution.usedCandidate.strategy).toBe("text");
    expect(resolution.attempts).toHaveLength(2);
    expect(resolution.attempts[0]!.ok).toBe(false);
    expect(resolution.attempts[1]!.ok).toBe(true);
  });

  it(
    "throws a LocatorResolutionError carrying every attempt when nothing matches",
    async () => {
      const candidates: LocatorCandidate[] = [
        { strategy: "role+name", role: "button", value: "Nope", confidence: 0.9 },
        { strategy: "text", value: "Also Nope", confidence: 0.5 },
      ];
      try {
        await resolveLocator(page, candidates);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(LocatorResolutionError);
        expect((err as LocatorResolutionError).attempts).toHaveLength(2);
      }
    },
    15000
  );
});
