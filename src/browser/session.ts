// Owns the one live Playwright session used across discovery, replay, and human handoff. Runs
// headed (not headless) on purpose: the human-escalation path (spec 3.6) needs a real OS-level
// window a person can literally take the mouse/keyboard on, not just an API. Keeping this in one
// module means discovery, replay, and handoff never each maintain their own copy of "what a
// live surface is."
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface AutomationSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export async function launchSession(opts: { headless?: boolean } = {}): Promise<AutomationSession> {
  const browser = await chromium.launch({ headless: opts.headless ?? false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    close: async () => {
      await browser.close();
    },
  };
}
