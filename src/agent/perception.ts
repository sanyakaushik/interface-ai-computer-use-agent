// The DOM-independence seam (see REPORT.md #4). Perception never hands the LLM a raw CSS
// selector or DOM path — only a flat list of (role, accessible name, current value) triples, each
// tagged with a self-describing `ref` the agent echoes back to act. This is deliberately the same
// shape an accessibility-tree walk over a desktop app would produce, so the agent loop, the tool
// contract, and the artifact schema's `role+name` locator strategy all carry over unchanged if the
// surface adapter underneath is swapped for a legacy-web or desktop backend — only this file and
// `actions.ts` would need a new implementation.
//
// Perception also walks every frame on the page, not just the main document (`page.frames()`
// includes the main frame at index 0, plus any <iframe> children) — a deliberate legacy-surface
// case: the mock app's "Account Notes" panel is a separately-served document embedded via
// <iframe>, standing in for the "servicing console with a bolted-on sub-app" pattern real legacy
// back-office UIs use. A ref's frame index is part of its self-description (`frameIdx::role::
// name::nth`) so `actions.ts` can act inside the correct frame without any extra session state.
import type { Frame, Page } from "playwright";

export interface PerceivedElement {
  ref: string; // self-describing: "<frameIdx>::<role>::<accessible name>::<nth>"
  frameIdx: number;
  role: string;
  name: string;
  value?: string;
}

export interface Perception {
  url: string;
  title: string;
  elements: PerceivedElement[];
  visibleText: string; // trimmed innerText of the main document, for reading balances/messages/errors
}

// Runs entirely inside a frame's own JS context — no Node-side DOM access, so this works
// identically against any Chromium-rendered surface regardless of markup quality (table layouts,
// no test IDs, etc.), and identically whether that frame is the top-level document or an iframe.
const COLLECT_ELEMENTS_SCRIPT = `
(() => {
  function computeRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return null;
  }

  function computeName(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && label.textContent) return label.textContent.trim();
    }
    const closestLabel = el.closest('label');
    if (closestLabel && closestLabel.textContent) return closestLabel.textContent.trim();
    if (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea') {
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();
    }
    if (el.textContent) return el.textContent.trim().slice(0, 120);
    return '';
  }

  function computeValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return el.value ?? '';
    if (tag === 'select') return el.value ?? '';
    return undefined;
  }

  const candidates = Array.from(document.querySelectorAll('a[href], button, input, textarea, select'));
  const seenRoleName = new Map();
  const out = [];
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue; // hidden
    const role = computeRole(el);
    if (!role) continue;
    const name = computeName(el);
    const key = role + '::' + name;
    const nth = seenRoleName.get(key) ?? 0;
    seenRoleName.set(key, nth + 1);
    out.push({ role, name, nth, value: computeValue(el) });
  }
  return out;
})()
`;

// page.frames()[0] is always the main frame; child frames follow in the order Playwright
// discovered them. That ordering is stable within one synchronous perceive-then-act turn (the
// only guarantee actions.ts relies on), even though it isn't guaranteed stable across a
// navigation that adds/removes frames.
export async function perceive(page: Page): Promise<Perception> {
  const frames = page.frames();
  const elements: PerceivedElement[] = [];
  for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    const frame = frames[frameIdx]!;
    let raw: { role: string; name: string; nth: number; value?: string }[];
    try {
      raw = await frame.evaluate(COLLECT_ELEMENTS_SCRIPT);
    } catch {
      continue; // a detached/cross-origin/not-yet-loaded frame — skip it for this turn
    }
    for (const el of raw) {
      elements.push({ ref: `${frameIdx}::${el.role}::${el.name}::${el.nth}`, frameIdx, role: el.role, name: el.name, value: el.value });
    }
  }
  const visibleText = await page.evaluate(() => document.body?.innerText ?? "");
  return {
    url: page.url(),
    title: await page.title(),
    elements,
    visibleText: visibleText.trim().slice(0, 4000),
  };
}

// At discovery time, when the agent extracts a value, we need to know *how* to find that same
// fact deterministically on replay (with different input params, so the value itself will
// differ). Our target app's convention — and the one this system currently understands — is a
// "Label" / "Value" table row; this looks up the label for a given observed value so the
// recorder can store it as a `labelledValue` locator candidate. Searches every frame, since a
// labelled value might live inside an embedded panel.
export async function findLabelForValue(page: Page, value: string): Promise<{ label: string; frameIdx: number } | undefined> {
  const frames = page.frames();
  for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    const label = await frames[frameIdx]!
      .evaluate((val: string) => {
        const rows = Array.from(document.querySelectorAll("tr"));
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll("td, th"));
          if (cells.length >= 2 && cells[1]?.textContent?.trim() === val) {
            return cells[0]?.textContent?.trim() ?? undefined;
          }
        }
        return undefined;
      }, value)
      .catch(() => undefined);
    if (label) return { label, frameIdx };
  }
  return undefined;
}

// Which frame (by index into page.frames()) a ref's element was found in, and that frame's live
// URL — used by the recorder to store a parameterized `frame` pattern on the artifact step, and
// by actions.ts to resolve the ref against the right frame.
export async function frameUrlForIndex(page: Page, frameIdx: number): Promise<string | undefined> {
  return page.frames()[frameIdx]?.url();
}

export function frameByIndex(page: Page, frameIdx: number): Page | Frame {
  if (frameIdx === 0) return page;
  const frame = page.frames()[frameIdx];
  if (!frame) throw new Error(`No frame at index ${frameIdx} (page currently has ${page.frames().length} frame(s)).`);
  return frame;
}

export function parseRef(ref: string): { frameIdx: number; role: string; name: string; nth: number } {
  // Format: "<frameIdx>::<role>::<accessible name>::<nth>" — frameIdx and role come off the
  // front, nth off the back, so whatever's left in the middle (even if a name legitimately
  // contained "::") is the name.
  const parts = ref.split("::");
  const frameIdx = Number(parts.shift());
  const role = parts.shift() ?? "";
  const nth = Number(parts.pop());
  const name = parts.join("::");
  if (!role || Number.isNaN(nth) || Number.isNaN(frameIdx)) {
    throw new Error(`Malformed element ref: "${ref}"`);
  }
  return { frameIdx, role, name, nth };
}

export function formatPerceptionForModel(p: Perception): string {
  const lines = p.elements.map(
    (e) => `${e.ref} | role=${e.role} | name="${e.name}"${e.value ? ` | value="${e.value}"` : ""}${e.frameIdx > 0 ? ` | inFrame` : ""}`
  );
  return [`URL: ${p.url}`, `TITLE: ${p.title}`, ``, `INTERACTIVE ELEMENTS:`, ...lines, ``, `PAGE TEXT:`, p.visibleText].join(
    "\n"
  );
}
