# Computer-Use Automation System

A small, real, end-to-end implementation of interface.ai's take-home brief: an LLM-driven
discovery agent that learns to complete a goal against a live back-office UI, records what it
learned as a typed, versioned, agent-invocable **capability artifact**, and a **deterministic
replay engine** that re-runs that capability in production without the LLM in the loop —
including runtime error/business-outcome handling, safety guardrails, and a human escalation
path that takes over the live session.

See [`REPORT.md`](./REPORT.md) for the design write-up (architecture, schema, determinism/error
handling, heterogeneity & multi-tenant story, escalation & handoff, safety, and cuts).

## Stack

TypeScript + Node.js, Playwright (Chromium, headed), Anthropic Claude (tool use + vision) for
discovery, Express (mock target app + handoff control server + capability API), Zod (artifact
schema + runtime validation), Vitest (unit tests).

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then fill in ANTHROPIC_API_KEY (only needed for `discover`)
```

`ANTHROPIC_API_KEY` is only required for `npm run discover` (the LLM-driven discovery loop).
`npm run replay`, `npm run mock-app`, `npm run serve`, `npm run handoff`, and `npm test` all run
with no external services or keys — everything runs against the local mock app.

## The target application

`/mock-app` is a small, deliberately "legacy" server-rendered back-office console ("Riverside
Credit Union — Servicing Console"): table-based layout, no client-side JS, no `id`/`data-testid`
attributes on interactive elements — every control is still identifiable by native role +
accessible name (a `<label>`, a `<button>` with text), which is the point: this is the seam the
whole system is built around (see `REPORT.md` #1/#4). Flows: search a member by ID → view
balances → open a new sub-account (multi-field form → confirmation → creation) → add an account
note in an embedded `<iframe>` panel (a separate document, standing in for a legacy
sub-app-bolted-onto-a-frame pattern — see `REPORT.md` #4). Seeded data: member `12345` (active),
`99999` (locked → access denied), `77777` (always "session expired", for exercising the
recoverable/hard-failure path), any other ID → not found.

## Demo path

Everything below runs from the repo root. Use a few terminals (or run the long-lived servers with
`&`/`run_in_background`): the mock app, the handoff control server, optionally a second mock-app
instance for the cross-tenant demo (step 9), and then discovery/replay.

**1. Start the target app:**
```bash
npm run mock-app
```

**2. Start the handoff control server** (needed if a run escalates; safe to leave running):
```bash
npm run handoff
```

**3. Run the agent on a goal** (requires `ANTHROPIC_API_KEY`) — this is the real, LLM-driven
discovery run; it opens a visible Chromium window, drives it, and on success saves a capability
artifact plus full evidence:
```bash
npm run discover -- \
  --id lookup_member_balance \
  --goal "Look up member 12345 and read their current savings balance." \
  --params memberId=12345 \
  --target http://localhost:4000
```
This writes `artifacts/lookup_member_balance.json` and `evidence/<runId>/` (structured log +
screenshots).

**4. Replay the saved artifact deterministically** (no LLM, no API key) — reproduces the same
result from the recorded capability:
```bash
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=12345
```

**5. Replay against inputs that hit a business outcome / runtime error**, to see the error
taxonomy in action:
```bash
# "no such member" — a legitimate business outcome, not a crash
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=00000

# locked account — another business outcome
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=99999

# always-expired session — recoverable retry, then a reported hard failure with evidence
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=77777
```

**6. (Optional) Record and replay the riskier `open_subaccount` capability**, to exercise the
irreversible-step risk classification and approval gate:
```bash
npm run discover -- \
  --id open_subaccount \
  --goal "Open a new savings sub-account for member 12345 with an initial deposit of 500 and purpose 'vacation savings', confirming the action to complete it, and report the new sub-account ID." \
  --params memberId=12345,depositAmount=500,purpose="vacation savings" \
  --target http://localhost:4000

# Blocked: artifact is freshly recorded as status:"draft" and the recorder flagged the
# confirmation step as irreversible.
npm run replay -- --artifact artifacts/open_subaccount.json --params memberId=12345,depositAmount=500,purpose="anniversary gift"

# Set "status": "approved" in artifacts/open_subaccount.json (simulating a human review), then:
npm run replay -- --artifact artifacts/open_subaccount.json --params memberId=12345,depositAmount=500,purpose="anniversary gift" --confirm-irreversible true
```

**7. (Optional) Record and replay `add_account_note`**, to exercise the iframe/legacy-frame path
(the "Account Notes" panel on the member detail page is a separately-served document embedded via
`<iframe>`):
```bash
npm run discover -- \
  --id add_account_note \
  --goal "For member 12345, add an account note in the Account Notes panel reading 'Verified phone number on file.' and then report how many total notes are now on the account." \
  --params memberId=12345,noteText="Verified phone number on file." \
  --target http://localhost:4000

# Replay against a different member than discovery ever saw — the recorded target.frame pattern
# ("/members/[^/]+/notes") generalizes exactly like a main-document checkpoint would.
npm run replay -- --artifact artifacts/add_account_note.json --params memberId=40000,noteText="Requested paper statements."
```

**8. (Stretch) Serve saved artifacts as agent-invocable capabilities:**
```bash
npm run serve
curl http://localhost:4200/capabilities
curl -X POST http://localhost:4200/capabilities/lookup_member_balance/invoke \
  -H "Content-Type: application/json" \
  -d '{"params": {"memberId": "12345"}}'
```

**9. (Stretch) Cross-tenant reuse** — replay the *same, unmodified* `lookup_member_balance`
artifact against a second mock-app instance standing in for a different tenant running the same
vendor product with different branding/labels:
```bash
# in another terminal, alongside the riverside instance from step 1
npm run mock-app:lakeside   # a second tenant, port 4001, same app, "Search" is labelled "Find Member"

# fails: the artifact only has an origin override for "lakeside" so far, no label override —
# this is the artifact correctly detecting a real tenant-branding difference, not a bug
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=12345 --tenant lakeside

# add a stepOverrides entry for the renamed button to the artifact's "overrides" array (a small,
# reviewed JSON diff — see artifacts/lookup_member_balance.json), then the same command succeeds:
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=12345 --tenant lakeside

# riverside, no --tenant flag: unaffected by the lakeside override
npm run replay -- --artifact artifacts/lookup_member_balance.json --params memberId=12345
```
See `REPORT.md` #4 and `evidence/README.md` ("cross-tenant reuse") for the full walkthrough — the
override is already committed in `artifacts/lookup_member_balance.json`, so the second command
above will actually succeed as-is; remove its `stepOverrides` to reproduce the failure first.

**10. Escalation demo** — with the handoff server running, replay with `--escalate-on-failure
true --headed true` against a failing input (e.g. `memberId=77777`); the run pauses and prints an
operator-console URL (`http://localhost:4100/operator`). Open it, review the context/screenshot,
optionally interact with the still-open, real Chromium window yourself, then click **Resume**
(with a note) — the run continues from there. See `REPORT.md` #5 for the design.

## Capability artifacts

Saved under `/artifacts/*.json`, validated against the Zod schema in
`src/artifact/schema.ts`. See `REPORT.md` #2 for the schema's fields and rationale.

## Configuration

- `allowlist.config.json` — allowed origins, allowed action types, and name patterns that mark a
  step irreversible (spec 3.4).
- `outcome-rules.<appId>.json` — per-target-app rules mapping page text to business
  outcome/recoverable codes (spec 3.3).
- `.env` — `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (default `claude-sonnet-5`), and port overrides.

## Tests

```bash
npm test        # vitest: schema validation, allowlist/risk/redaction, outcome classification,
                # locator fallback, durable handoff store, API retry/backoff, iframe perception +
                # frame-aware replay, and a full discovery-loop integration test (scripted LLM
                # client, real browser, real mock app — no API key needed)
npm run typecheck
```

## What's mocked / cut, and why

See `REPORT.md` #7 ("Cuts"). Short version: the target app is a purpose-built mock (not a real
bank system, per the brief); the "operator console" is a bare status/resume page, not a real
co-browsing UI (the actual live-session control is the real, headed browser window); desktop
surface support is design-only (multi-tenant reuse *and* the iframe/legacy-frame pattern *are*
implemented — see steps 7 and 9 above and `REPORT.md` #4 — but the operational tooling around
multi-tenant reuse, like automatic drift detection, is not); parameterization is deterministic
value-matching, not LLM-based generalization; extraction only understands "Label/Value" table
rows, not arbitrary prose; business-outcome/checkpoint classification only reads the main
document, not matched iframes (see `REPORT.md` #7).
