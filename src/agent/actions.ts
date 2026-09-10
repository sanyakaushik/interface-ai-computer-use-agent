// Executes a tool call against the live page during discovery, resolving a perception `ref` back
// to a Playwright locator. This is the only place discovery touches Playwright directly — the
// loop and the LLM never see selectors, only refs.
import type { Frame, Locator, Page } from "playwright";
import { frameByIndex, parseRef } from "./perception.js";

export const ROLE_MAP: Record<string, Parameters<Page["getByRole"]>[0]> = {
  link: "link",
  button: "button",
  textbox: "textbox",
  checkbox: "checkbox",
  radio: "radio",
  combobox: "combobox",
};

// A ref's frameIdx says which frame (main document or an embedded iframe) to act in; Page and
// Frame share the relevant locator API (getByRole/getByText/locator), so everything downstream
// of this function is written against that common shape and doesn't care which one it got.
export function resolveRef(page: Page, ref: string): Locator {
  const { frameIdx, role, name, nth } = parseRef(ref);
  const root: Page | Frame = frameByIndex(page, frameIdx);
  const playwrightRole = ROLE_MAP[role];
  if (!playwrightRole) throw new Error(`Unsupported role in ref "${ref}": ${role}`);
  return root.getByRole(playwrightRole, { name, exact: true }).nth(nth);
}

export async function doClick(page: Page, ref: string, timeoutMs: number): Promise<void> {
  await resolveRef(page, ref).click({ timeout: timeoutMs });
}

export async function doType(page: Page, ref: string, text: string, timeoutMs: number): Promise<void> {
  const locator = resolveRef(page, ref);
  await locator.fill(text, { timeout: timeoutMs });
}

export async function doSelectOption(page: Page, ref: string, value: string, timeoutMs: number): Promise<void> {
  await resolveRef(page, ref).selectOption(value, { timeout: timeoutMs });
}

export async function doNavigate(page: Page, url: string, timeoutMs: number): Promise<void> {
  await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
}

// Captures a last-resort structural locator (nth-child chain) for the element a ref currently
// resolves to. Recorded as the lowest-confidence fallback candidate in the artifact — used only
// if role+name and text matching both fail on replay (e.g. after a markup change altered
// accessible names, which the recorder cannot foresee).
export async function captureCssPath(page: Page, ref: string): Promise<string | undefined> {
  try {
    const locator = resolveRef(page, ref);
    return await locator.evaluate((el: Element) => {
      function pathOf(node: Element): string {
        if (node.tagName.toLowerCase() === "body") return "body";
        const parent = node.parentElement;
        if (!parent) return node.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        const index = siblings.indexOf(node) + 1;
        const selector = `${node.tagName.toLowerCase()}:nth-of-type(${index})`;
        return `${pathOf(parent)} > ${selector}`;
      }
      return pathOf(el);
    });
  } catch {
    return undefined;
  }
}
