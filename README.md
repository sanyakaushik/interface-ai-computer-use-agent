# Computer-Use Automation System

This is my submission for interface.ai's take-home. It's a system that:

1. Uses an LLM to figure out how to do something on a web app it's never seen before (a "discovery" run)
2. Saves what it learned as a reusable, typed **capability artifact**
3. Replays that artifact later with **no LLM involved at all** — deterministic, fast, cheap
4. Handles the errors you'd actually hit in production (member not found, validation errors, session timeouts) instead of just crashing
5. Knows when to stop and ask a human for help, and lets that human take over the same live browser session

The full design writeup is in [`REPORT.md`](./REPORT.md) — architecture, the artifact schema, how replay stays deterministic, safety, and what I cut.

## Stack

- TypeScript / Node.js
- Playwright (Chromium, run headed so a human can grab the browser if needed)
- Claude (Anthropic API) for the discovery agent — tool use + vision
- Express for the mock target app, the human-handoff server, and a small capability API
- Zod for the artifact schema
- Vitest for tests

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Then put your Anthropic key in `.env`. You only need it for `npm run discover` — everything else (replay, tests, the mock app) runs fully offline against the local app.

## What's the target app?

I built a small mock "core banking" console (`/mock-app`) instead of using a real site, since the assignment says not to hit real bank systems and this way I control every edge case. It's deliberately old-school: plain server-rendered HTML, table-based layout, no `id`/`data-testid` attributes anywhere. That's on purpose — the whole point of this project is handling apps that don't give you clean hooks to automate against, and a legacy internal banking tool is exactly that kind of app in real life.

You can: search a member by ID, view their balances, open a new sub-account (a multi-step form with a confirmation screen), and add an account note through a panel that's actually a separate page embedded in an `<iframe>` (again, a very real pattern in old enterprise software).

Test data that's already seeded:
- `12345` — normal active member
- `99999` — locked account (returns access denied)
- `77777` — always shows "session expired," used to test that path
- anything else — not found

## Running through the demo

Open a few terminals for this.

**1. Start the mock app**
```bash
npm run mock-app
```

**2. Start the handoff server** (only matters if a run gets stuck and escalates, but fine to leave running)
```bash
npm run handoff
```

**3. Run the agent on a real goal.** This needs your API key and actually opens a visible Chrome window and drives it:
```bash
npm run discover -- \
  --id lookup_member_balance \
  --goal "Look up member 12345 and read their current savings balance." \
  --params memberId=12345 \
  --target http://localhost:4000
```
If it works, you'll get `artifacts/lookup_member_balance.json` plus a log + screenshots under `evidence/<runId>/`.

**4. Replay it — no LLM this time**
```bash
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=12345
```

**5. Try it with inputs that don't just succeed**, to see how it handles real-world outcomes instead of only the happy path:
```bash
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=00000   # no such member
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=99999   # locked account
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=77777   # session expired, ends in a clear failure
```

**6. (Optional) Try the riskier capability** — opening a sub-account has a confirmation step, so the recorder marks it irreversible and replay won't run it unless you explicitly approve it:
```bash
npm run discover -- \
  --id open_subaccount \
  --goal "Open a new savings sub-account for member 12345 with an initial deposit of 500 and purpose 'vacation savings', confirming the action to complete it, and report the new sub-account ID." \
  --params memberId=12345,depositAmount=500,purpose="vacation savings" \
  --target http://localhost:4000

# this gets blocked, since the artifact is still "draft" and has an irreversible step
npm run replay -- --artifact artifacts/open_subaccount.json --params memberId=12345,depositAmount=500,purpose="anniversary gift"

# mark it "status": "approved" in the JSON file, then it works with explicit confirmation
npm run replay -- --artifact artifacts/open_subaccount.json --params memberId=12345,depositAmount=500,purpose="anniversary gift" --confirm-irreversible true
```

**7. (Optional) The iframe capability** — proves the same system works when the thing you're clicking is inside an embedded frame, not the main page:
```bash
npm run discover -- \
  --id add_account_note \
  --goal "For member 12345, add an account note in the Account Notes panel reading 'Verified phone number on file.' and then report how many total notes are now on the account." \
  --params memberId=12345,noteText="Verified phone number on file." \
  --target http://localhost:4000

npm run replay -- --artifact artifacts/add_account_note.json --params memberId=40000,noteText="Requested paper statements."
```

**8. (Stretch) Call a saved capability like an API:**
```bash
npm run serve
curl http://localhost:4200/capabilities
curl -X POST http://localhost:4200/capabilities/lookup_member_balance/invoke \
  -H "Content-Type: application/json" \
  -d '{"params": {"memberId": "12345"}}'
```

**9. (Stretch) Reuse the same artifact across a second "tenant"** — a second mock-app instance with different branding and a renamed button, standing in for two banks running the same vendor software:
```bash
npm run mock-app:lakeside   # port 4001, "Search" button is labelled "Find Member" here instead

npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=12345 --tenant lakeside
```
The artifact already has a small override in it for this tenant (see `artifacts/lookup_member_balance.json`'s `overrides` field) — remove it and re-run to see it fail first, which is the point: it proves the override actually matters instead of just being decoration. More detail on this in `REPORT.md` and `evidence/README.md`.

**10. Escalation demo** — run a replay with `--escalate-on-failure true --headed true` against something that fails (like `memberId=77777`). It'll pause and print a link to `http://localhost:4100/operator`. Open that, look at the screenshot and context, and click Resume (you can leave a note). The run picks back up from there. Design details in `REPORT.md`.

## Artifacts

Saved as JSON under `/artifacts`, validated against a Zod schema in `src/artifact/schema.ts`. `REPORT.md` covers why the schema looks the way it does.

## Config files

- `allowlist.config.json` — which origins and action types the agent is allowed to touch, plus name patterns that flag a step as irreversible
- `outcome-rules.<appId>.json` — maps page text to known outcomes (business errors vs. recoverable states)
- `.env` — API key, model name, ports

## Tests

```bash
npm test
npm run typecheck
```

52 tests covering the schema, the safety logic, outcome classification, locator fallback, the durable handoff store, API retry logic, the iframe/frame handling, and a full run of the discovery loop itself using a scripted fake LLM (so it doesn't need an API key to test).

## What I didn't build, and why

Full list is in `REPORT.md` under "Cuts," but the short version: the mock app is obviously not a real bank; the operator console is intentionally bare-bones (the real thing being handed off is the actual browser window, not the console); I did build both multi-tenant reuse and the iframe handling for real, but a proper desktop-app surface is still just a design sketch, not code; parameterization in artifacts is simple exact-value matching, not something LLM-driven; and extraction only understands plain label/value table rows, not free-form text.
