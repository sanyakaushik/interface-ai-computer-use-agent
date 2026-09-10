// The legacy-surface case: the mock app's "Account Notes" panel is served as its own document
// and embedded via <iframe>, standing in for a servicing console built by bolting a
// separately-maintained sub-app onto a page via a frame. These tests prove perception can see
// into that frame, discovery-time actions can act inside it, and the replay engine can find the
// right frame from a recorded pattern and fail cleanly when it can't.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { perceive, findLabelForValue, frameByIndex } from "../src/agent/perception.js";
import { doClick, doType, resolveRef } from "../src/agent/actions.js";
import { resolveFrameRoot } from "../src/replay/engine.js";
import { resolveLocator } from "../src/replay/locator.js";
import { resolveExtractedValue } from "../src/replay/extraction.js";

const TEST_PORT = 4098;
const TEST_URL = `http://localhost:${TEST_PORT}`;

let mockAppServer: import("node:http").Server;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  process.env.MOCK_APP_PORT = String(TEST_PORT);
  const mod = await import(/* @vite-ignore */ `../mock-app/server.js?t=${Date.now()}`);
  mockAppServer = mod.server;
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => mockAppServer.close(() => resolve()));
});

describe("iframe-embedded panel: perception and discovery-time actions", () => {
  it("perceives elements inside the embedded notes iframe, tagged with a non-zero frame index", async () => {
    await page.goto(`${TEST_URL}/members/12345`, { waitUntil: "domcontentloaded" });
    // Give the iframe a moment to attach and load.
    await page.waitForSelector("iframe");

    const perception = await perceive(page);
    const noteField = perception.elements.find((e) => e.role === "textbox" && e.name === "Note");
    const addNoteButton = perception.elements.find((e) => e.role === "button" && e.name === "Add Note");
    const searchButton = perception.elements.find((e) => e.role === "button" && e.name === "Search");

    expect(noteField).toBeDefined();
    expect(addNoteButton).toBeDefined();
    expect(noteField!.frameIdx).toBeGreaterThan(0);
    expect(addNoteButton!.frameIdx).toBe(noteField!.frameIdx);
    // The main-document Search button (from a different page, but same-shaped assertion) stays
    // at frame 0 — sanity-checking that we're not tagging everything as "in a frame."
    if (searchButton) expect(searchButton.frameIdx).toBe(0);
  });

  it("can type into and click a control inside the iframe via a ref, and the change is visible on reload", async () => {
    await page.goto(`${TEST_URL}/members/12345`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("iframe");
    const perception = await perceive(page);
    const noteField = perception.elements.find((e) => e.role === "textbox" && e.name === "Note")!;
    const addNoteButton = perception.elements.find((e) => e.role === "button" && e.name === "Add Note")!;

    await doType(page, noteField.ref, "Verified ID over the phone.", 5000);
    await doClick(page, addNoteButton.ref, 5000);

    // The panel's own form POSTs and redirects within the iframe; give it a beat, then check the
    // note landed by reading the iframe frame's content directly.
    await page.waitForTimeout(300);
    const label = await findLabelForValue(page, "Verified ID over the phone.");
    expect(label).toBeUndefined(); // it's a single-column notes table, not a label/value row — just confirm no crash

    const iframeFrame = frameByIndex(page, noteField.frameIdx);
    const text = await (iframeFrame as import("playwright").Frame).evaluate(() => document.body.innerText);
    expect(text).toContain("Verified ID over the phone.");
  });

  it("resolveRef throws a clear error for a malformed (pre-frame-support) ref format", () => {
    expect(() => resolveRef(page, "textbox::Member ID::0")).toThrow(/Malformed element ref/);
  });
});

describe("iframe-embedded panel: replay-side frame resolution", () => {
  it("resolveFrameRoot finds the iframe by its parameterized URL pattern and resolves a locator inside it", async () => {
    await page.goto(`${TEST_URL}/members/12345`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("iframe");

    // Mirrors what the recorder would store: the notes panel's path with the member id
    // generalized to a wildcard, exactly like a checkpoint pattern.
    const framePattern = "/members/[^/]+/notes";
    const root = await resolveFrameRoot(page, framePattern);
    expect(root).not.toBe(page); // it's the Frame, not the top-level Page

    const resolution = await resolveLocator(root, [{ strategy: "role+name", role: "button", value: "Add Note", confidence: 0.9 }]);
    expect(resolution.usedCandidate.strategy).toBe("role+name");
  });

  it("resolveFrameRoot returns the page itself when no frame pattern is given", async () => {
    const root = await resolveFrameRoot(page, undefined);
    expect(root).toBe(page);
  });

  it("resolveFrameRoot throws a clear, debuggable error when no frame matches", async () => {
    await expect(resolveFrameRoot(page, "/no/such/frame/path", 500)).rejects.toThrow(/No frame found matching/);
  });

  it("resolveExtractedValue reads a labelled fact from inside the iframe, not just the main document", async () => {
    // The notes panel's "Total Notes" summary is a genuine Label/Value row living inside the
    // embedded frame — this proves extraction works there, not just on the main page.
    await page.goto(`${TEST_URL}/members/12345`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("iframe");
    const root = await resolveFrameRoot(page, "/members/[^/]+/notes");
    expect(root).not.toBe(page);
    const value = await resolveExtractedValue(root, [{ strategy: "labelledValue", value: "Total Notes", confidence: 0.8 }]);
    expect(value).toMatch(/^\d+$/);
  });
});
