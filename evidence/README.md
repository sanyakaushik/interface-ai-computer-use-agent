# Evidence index

All runs below are real: three genuine LLM-driven discovery runs (Claude driving a live, visible
Chromium window against the mock app) and a set of deterministic replay runs against the
artifacts those discoveries produced, with no LLM involved in the replays. Each directory is
`evidence/<runId>/log.jsonl` (a structured, timestamped log of what happened and why) plus a
screenshot for any run that failed or was escalated.

## Discovery runs (LLM-driven, produced the saved artifacts under `/artifacts`)

- **`discovery-2026-09-09T23-23-30-505Z-ebpo67`** — goal: "Look up member 12345 and read their
  current savings balance." → produced [`artifacts/lookup_member_balance.json`](../artifacts/lookup_member_balance.json).
  Outputs: `savingsBalance: "$4821.13"`.
- **`discovery-2026-09-09T23-26-18-453Z-b6lteh`** — goal: "Open a new savings sub-account for
  member 12345 with an initial deposit of 500 and purpose 'vacation savings', confirming the
  action to complete it, and report the new sub-account ID." → produced
  [`artifacts/open_subaccount.json`](../artifacts/open_subaccount.json). Outputs:
  `newSubAccountId: "SA-1001"`. Note: the recorder classified both the "Open Sub-Account" link
  and the final "Confirm — Open Sub-Account" button as `riskLevel: "irreversible"` (conservative
  name-pattern match — see `REPORT.md` #6), which is why replaying this capability requires the
  approval-gate demo below.
- **`discovery-2026-09-10T00-29-10-209Z-fap3oo`** — goal: "For member 12345, add an account note
  in the Account Notes panel reading 'Verified phone number on file.' and then report how many
  total notes are now on the account." → produced
  [`artifacts/add_account_note.json`](../artifacts/add_account_note.json). Outputs:
  `totalNotes: "1"`. This is the legacy-frame demo: the "Account Notes" panel on the member detail
  page is a genuinely separate document embedded via `<iframe>` (see `REPORT.md` #4) — the agent
  typed into and clicked controls *inside that frame*, and the recorder correctly stored
  `target.frame: "/members/[^/]+/notes"` (parameterized, not hardcoded to member 12345) on the
  three steps that acted inside it.

## Deterministic replay — `lookup_member_balance` (no LLM involved)

- **`replay-...-dd5y6w`** — `memberId=40000` (a member never seen during discovery) →
  `status: success`, `savingsBalance: "$150.20"`. Demonstrates the artifact generalizing across
  input values — the checkpoint recorded during discovery (`/members/12345`) is stored
  parameterized as `/members/[^/]+`, not hardcoded to the discovery run's literal ID.
- **`replay-...-wbjyhk`** — `memberId=00000` → `status: business_outcome`, code
  `MEMBER_NOT_FOUND`. A legitimate answer, not a crash.
- **`replay-...-65icnk`** — `memberId=99999` (seeded as locked) → `status: business_outcome`,
  code `ACCESS_DENIED`.
- **`replay-...-87trgr`** — `memberId=77777` (seeded as permanently session-expired) →
  `status: failure` at `step-3`, after one automatic recoverable-retry attempt failed to clear
  the condition. Includes `failure-step-3.png` screenshot evidence. This is the "replay that hits
  an injected/simulated failure" the brief asks for.

## Deterministic replay — `open_subaccount` (no LLM involved; exercises the risk/approval gate)

- **`replay-...-zdnkdd`** — artifact still `status:"draft"` → `status: awaiting_approval`
  (irreversible step present, artifact not yet approved).
- **`replay-...-gikn0t`** — artifact promoted to `status:"approved"` but invoked without
  `--confirm-irreversible` → still `status: awaiting_approval` (approval alone isn't enough; the
  caller must also explicitly confirm per invocation).
- **`replay-...-19x19y`** — approved + `--confirm-irreversible true` → `status: success`,
  `newSubAccountId: "SA-1002"`.
- **`replay-...-kor2zz`** — same capability, `depositAmount=5` (below the $25 minimum) →
  `status: business_outcome`, code `VALIDATION_ERROR`.

## Deterministic replay — `add_account_note` (no LLM involved; exercises the iframe/legacy-frame path)

- **`replay-2026-09-10T00-29-49-178Z-eu50am`** — `memberId=12345` (same member as discovery) →
  `status: success`, `totalNotes: "2"` (the note discovery itself added is still there, plus this
  one). Proves the real, LLM-recorded `target.frame` pattern resolves correctly on replay
  (`resolveFrameRoot` in `src/replay/engine.ts`).
- **`replay-2026-09-10T00-29-51-717Z-kk7tz2`** — `memberId=40000` (a member never seen during
  discovery, and never had a note added before) → `status: success`, `totalNotes: "1"`. Proves
  the frame-targeted steps generalize across input params exactly like main-document steps do —
  the `frame` pattern was stored parameterized, not as a literal `/members/12345/notes`.

## Escalation & handoff demo (spec 3.6)

Two full pause → human-notes → resume cycles against `lookup_member_balance` /
`memberId=77777`, run with `--escalate-on-failure --headed` and the handoff server
(`npm run handoff`) up:

- **`replay-...-8oud47`** — step-3's recoverable-retry failure raised `intervention-3`
  (`http://localhost:4100/operator`), captured with a screenshot and perception snapshot; resumed
  with human notes recorded on the intervention record. The run then reached step-4's extraction,
  which also failed against this deliberately-unrecoverable seed member, raising
  `intervention-4` (again with a screenshot); resumed again. Because the human's notes describe
  actions that (in this seeded demo) don't actually change the mock app's server-side state, the
  extraction still never produced a value — and the engine correctly reports
  `status: failure, stepId: "outputs", observed: "missing: savingsBalance"` rather than a false
  success, instead of assuming reaching the end of the step list means the goal was met. See
  `REPORT.md` #5 for the control-transfer design and what's mocked (a bare status/resume page)
  vs. real (the pause/resume mechanism and the fact that the live session being handed off is the
  same headed browser window, not a fresh one).

## Stretch goal — cross-tenant reuse

Second stretch goal: the same `lookup_member_balance` artifact, unmodified in its core steps,
reused across two separate mock-app instances standing in for two tenants running the same
vendor product (`AcmeCore Servicing UI`) with different branding/labels — see `REPORT.md` #4 and
the `overrides[]` field on the artifact schema (`src/artifact/schema.ts`). "Riverside" (port 4000,
button labelled "Search") is the tenant discovery was recorded against; "Lakeside" (port 4001,
button labelled "Find Member") is a second tenant instance the artifact was never recorded on.

- **`replay-...-2c6yjk`** — riverside, no `--tenant` flag → `status: success` (baseline,
  confirms the artifact still behaves exactly as before this feature was added).
- **`replay-...-4phprv`** — lakeside, with only a `baseUrlPattern` override registered (no
  step-level override yet) → `status: failure` at `step-3`, `"No locator candidate resolved
  (tried role+name:\"Search\", text:\"Search\")"`, with a screenshot. This is the artifact
  correctly failing on a real, would-happen tenant-branding difference — not a bug — and is the
  proof the override is actually needed, not decorative.
- **`replay-...-7i6tcr`** — lakeside, after adding one `stepOverrides["step-3"]` candidate
  (`role+name: button "Find Member"`) to the artifact's `overrides[]` array — a small, reviewable
  JSON diff, not a re-recording — → `status: success`, same `savingsBalance` output contract.
- **`replay-...-di9qji`** — riverside again, same artifact file (now carrying the lakeside
  override) and no `--tenant` flag → still `status: success`, unaffected — the override only
  applies when its `tenantId` is explicitly selected.

Reproduce: `npm run mock-app` (riverside, :4000) and `npm run mock-app:lakeside` (:4001) in two
terminals, then `npm run replay -- --artifact artifacts/lookup_member_balance.json --params
memberId=12345 --tenant lakeside`.

## Stretch goal — agent-facing capability API

- **`replay-2026-09-09T23-30-51-072Z-yzg0cz`** — `GET /capabilities` listed both saved artifacts
  with their typed input/output schema; `POST /capabilities/lookup_member_balance/invoke` with
  `{"params": {"memberId": "12345"}}` ran the same replay engine used by the CLI and returned
  `{"status": "success", "outputs": {"savingsBalance": "$4821.13"}}` — an AI agent invoking a
  saved capability by name with typed args, per `src/capabilities/api.ts`.
