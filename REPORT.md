# Design Report — Computer-Use Automation System

## 1. Architecture

The system has four pieces that share two contracts (an artifact schema and an allowlist/outcome
config) but otherwise don't know about each other's internals:

- **Discovery loop** (`src/agent`): an LLM-driven observe → decide → act loop against a live
  Playwright session. Perception (`perception.ts`) never exposes the DOM to the model — each turn
  it walks the live page and returns a flat list of `(role, accessible name, value)` triples, each
  tagged with a self-describing `ref`. The LLM (Claude, via tool use) only ever sees that list plus
  a screenshot, and acts through eight literal tools (click/type/selectOption/navigate/waitFor/
  extract/finish_success/report_stuck) — never arbitrary code. This is the load-bearing design
  choice: it means the agent works identically on a table-based, no-test-ID legacy page as it would
  on a modern one, and it gives the allowlist something concrete to gate (a fixed action-type
  vocabulary, not "run this JS").
- **Recorder** (`src/artifact/recorder.ts`): translates a successful discovery transcript into a
  versioned `CapabilityArtifact`. This is a pure, deterministic transform — no LLM involved — and
  is the only place a transcript becomes a capability.
- **Replay engine** (`src/replay`): loads an artifact + params and executes it with zero model
  calls, using a ranked locator fallback chain and a configured outcome taxonomy (business
  outcome / recoverable / hard failure) to decide what to do at each step.
- **Handoff** (`src/handoff`): a small Express control server (separate process) that records
  intervention requests and resume signals; it never touches the browser itself.

**Key trade-offs:**
- *Single Node process per run, no queue/service mesh.* The brief explicitly discourages building
  scaling infrastructure prematurely. Discovery, replay, and the capability API are separate
  entry points, but nothing here assumes more than one instance; a real deployment would put a
  queue in front of replay invocations, not reachitecture the artifact/engine boundary.
- *Headed (not headless) Chromium by default.* Costs a little speed, but it is what makes the
  human-escalation story real (§5) rather than aspirational — the same OS-level window is what a
  human takes over.
- *Perception via a hand-rolled accessibility walk, not Playwright's own ARIA snapshot helper.*
  Gives full control over the `ref` format the LLM sees and keeps a single code path that both the
  discovery loop and, conceptually, a future desktop backend could implement (§4).
- *TypeScript + Zod end-to-end* so the artifact contract — the focal point of the assignment — is
  both a compile-time type and a runtime-validated boundary (untrusted JSON in, typed object out).

## 2. Artifact schema

`src/artifact/schema.ts`. An artifact is not a step recording — it is a capability contract, so it
carries, beyond the ordered `steps[]`:

- **`target`**: `{ appId, vendorProduct, vendorVersion, baseUrlPattern }`. Deliberately *not* a
  literal tenant URL — this is the multi-tenant seam (§4): an artifact is scoped to a vendor
  product/version, and a tenant's concrete base URL is supplied at replay time.
- **`inputParams[]` / `outputs[]`**: typed, named, described — the calling contract an AI agent
  (or a human reviewer) needs without reading the steps. `inputParams` also carries `sensitive`,
  enforced by the redaction layer (§6).
- **`steps[].target.candidates[]`**: a *ranked* list of locator strategies
  (`role+name` → `text` → `cssPath`), each with a confidence score, rather than one selector.
  This is the single most important schema decision: it encodes *how sure we are* about each way
  of finding a control, and lets replay degrade gracefully instead of being all-or-nothing on one
  brittle selector.
- **`steps[].checkpoint`** and a top-level **`successCheckpoint`**: every state-changing step (and
  the run overall) asserts what "worked" looks like, rather than assuming the last action
  succeeded — directly the glossary's "checkpoint" concept.
- **`steps[].target.riskLevel`** (`safe`/`irreversible`) and top-level **`status`**
  (`draft`/`approved`): risk lives on the artifact, not bolted onto the caller, so it travels with
  the capability wherever it's invoked from.
- **`provenance.discoveryRunId`**: links to `/evidence`, but the raw transcript is never embedded
  — the artifact is meant to be read and diffed by a human reviewer without wading through a
  chat log.

**Parameterization** is deliberately simple and explainable rather than ML-driven: discovery is
invoked with named param values (e.g. `memberId=12345`); any `type`/`selectOption` action whose
literal text exactly matches a supplied value is recorded as `inputBinding: {kind:"param", ...}`
instead of a literal. This is a documented cut (§7) — it can't infer a parameter the operator
didn't tell it about — but it's fully auditable in the saved JSON, which matters more for a
reviewed, regulated-environment artifact than cleverness would.

## 3. Determinism & error handling

Replay (`src/replay/engine.ts`) never calls an LLM. Each step:

1. **Resolves its target** via `locator.ts`'s fallback chain — `role+name` first (survives markup
   rewrites since it targets accessibility semantics, not implementation detail), then `text`,
   then a recorded structural `cssPath` as a last resort. Each candidate gets a short, independent
   timeout, so one dead candidate doesn't consume the whole step's budget. Failure to resolve *any*
   candidate is reported as a hard failure carrying every attempted candidate and its error — not
   a bare "element not found."
2. **Acts**, then **classifies the resulting page** against `outcome-rules.<appId>.json`
   (`src/replay/outcomes.ts`) *before* trusting the step's own checkpoint. This ordering is
   deliberate: a validation error or "member not found" page will not satisfy the next
   checkpoint, but that's not a locator/timing bug — it's the taxonomy's job to recognize it
   first and short-circuit with a **business outcome** (`{status:"business_outcome", code,
   message}`), distinct from a **hard failure**. Getting this distinction backwards (treating
   "no such member" as a crash) is the mistake the assignment explicitly calls out, and it's why
   outcome classification runs ahead of checkpoint verification, not after.
3. **Recoverable conditions** (currently: a known session-expired interstitial) get exactly one
   inline retry (re-navigate) before being escalated to a hard failure — bounded, not an infinite
   loop, and the distinction between "recovered" and "still broken after retrying" is itself
   logged.
4. **Hard failures** (locator exhausted, checkpoint unmet after a real action, disallowed
   origin/action) return `{status:"failure", stepId, expected, observed, evidencePath}` with a
   screenshot saved to `/evidence` — enough to debug without re-running.
5. **Extraction** (`src/replay/extraction.ts`) resolves output values the same deterministic way:
   via a recorded "Label" for a table row, re-read from the *current* page rather than replayed
   from the recording (so a different member ID legitimately returns a different balance).

Config-driven outcome rules (rather than hardcoded logic) mean adding a new business-outcome or
recoverable pattern for a new screen is a JSON edit, not a code change — this is also the seam
that would carry drift *detection*: a step that starts throwing `LOCATOR_NOT_FOUND` in production
across many runs is a drift signal an operator would triage by updating `outcome-rules`/candidate
lists, not by re-recording from scratch.

## 4. Heterogeneity & multi-tenant

**Surface abstraction — including a legacy pattern that's implemented, not just described.**
The agent loop, the tool contract, and the artifact's `role+name` locator strategy are all
expressed in terms of (role, accessible name, value) — never raw markup. That's exactly the
shape an OS accessibility-tree walk over a desktop app produces. But "no clean DOM" isn't only a
markup-quality problem — legacy servicing consoles are often literally assembled from separately
maintained sub-apps bolted together via `<iframe>` (a frameset-descended pattern real back-office
software still uses). Rather than assume that away, the mock app's "Account Notes" panel is a
genuinely separate document embedded via iframe, and perception (`src/agent/perception.ts`) walks
every frame on the page (`page.frames()`), not just the main document — each element's `ref` is
self-describing down to which frame it's in (`frameIdx::role::name::nth`). The artifact schema
carries this through: a step's `target.frame` is a parameterized URL pattern (recorded and
generalized exactly like a checkpoint — see §3) that tells replay which frame to search before
resolving locator candidates (`resolveFrameRoot` in `src/replay/engine.ts`). A real,
LLM-discovered capability (`artifacts/add_account_note.json`, `evidence/README.md`) types into
and clicks controls inside the iframe and extracts a labelled fact from within it, and replays
deterministically against a member never seen during discovery. Porting to a legacy web app needed
no change beyond this (frames are still a web-DOM concept); porting to *desktop* is the piece that
remains design-only: writing a new `perception.ts`/`actions.ts` pair against an OS accessibility
API (UI Automation/AXUIElement) behind the same interface, and adding a `cssPath`-equivalent
last-resort strategy for that platform to the schema's `LocatorStrategy` enum. The agent loop,
recorder, and replay engine would not change either way — that's the seam holding.

**Multi-tenant reuse — implemented as a stretch goal, not just designed.** An artifact's `target`
names a *vendor product + version*, not a tenant. `CapabilityArtifact.overrides[]`
(`src/artifact/schema.ts`) is a small array of `{tenantId, baseUrlPattern?, stepOverrides}`
records: `baseUrlPattern` lets a tenant's actual instance live at a different origin than the one
discovery was recorded against, and `stepOverrides[stepId].candidates` contribute tenant-specific
locator candidates that the replay engine tries *first*, ahead of the base artifact's own
candidates, for that step only (`executeStep`'s `candidatesFor()` in `src/replay/engine.ts`). A
reviewer adds one of these when they notice a tenant's instance differs — a small, auditable JSON
diff, not a re-recording, and not silently generated by anything.

Demoed end to end (`evidence/README.md`, "cross-tenant reuse"): the real, LLM-discovered
`lookup_member_balance` artifact was recorded once against "Riverside" (the mock app on :4000,
search control labelled "Search"). A second tenant instance, "Lakeside" (:4001, same vendor
product, same routes and business logic, but branded differently and with that control labelled
"Find Member" — a realistic per-tenant config difference), was stood up without touching the
artifact. Replaying the unmodified artifact with `--tenant lakeside` and only a `baseUrlPattern`
override correctly **fails** at the renamed control (proving the override is load-bearing, not
decorative); adding one `stepOverrides` entry for that step makes the same artifact **succeed**
against Lakeside; replaying against Riverside again with no `--tenant` flag confirms the base
tenant is provably unaffected by the addition. One artifact, one small reviewed diff, two tenants,
zero re-recording.

**Drift detection**, per this design, is inferred from replay outcomes rather than needing a
separate crawler: a `LOCATOR_NOT_FOUND` hard failure whose lowest-confidence (`cssPath`)
candidate is what last worked, or a rising failure rate on one step across tenants running the
same `vendorProduct`/`vendorVersion`, is the signal an artifact needs a reviewed update (in the
common case, exactly the kind of one-step override just demonstrated) — the `draft`/`approved`
status field is exactly the gate that would sit in front of promoting an edited artifact back
into unattended use. **Not implemented**: any automatic tooling to *detect* that drift and propose
the override — today a human notices the failure (as in the demo) and edits the JSON by hand. A
tenant registry mapping `(appId, tenantId) → baseUrl` operationally (rather than one override
entry per artifact) and per-tenant allowlist scoping (today's `allowlist.config.json` lists every
known tenant origin in one flat file — fine for two tenants, not for hundreds) are the two things
I'd build next to take this from "the mechanism works" to "this is how hundreds of tenants would
actually be configured."

## 5. Escalation & handoff

**Detecting "stuck."** Two paths: (a) the discovery agent proactively calls `report_stuck` when
it can't recognize the page state, has tried and failed a couple of times, or is facing a
step it judges irreversible and unclear — the system prompt explicitly tells it that asking for
help is the correct behavior, not a wrong guess; (b) replay treats certain hard failures (when
invoked with `--escalate-on-failure`) as escalable rather than terminal.

**Raising the request.** Both paths call the same `raiseIntervention` (`src/handoff/client.ts`),
carrying the goal/capability id, the current step, the reason, and a screenshot + perception
snapshot — everything §3.6 asks for a human to act on.

**Taking control of the live session — the real part.** The browser runs headed for exactly this
reason: when the loop raises an intervention it stops issuing Playwright commands and blocks on
`waitForResume`, but it does not close or replace the session. The window a person sees and can
click into *is* the automation's live session, not a fresh one — there is no proxying or
co-browsing layer in between, which is also why there's nothing to get out of sync. "Who is in
control" is exactly the automation's call-stack position: paused-and-polling vs.
actively-issuing-commands; a `resumed`-status intervention is the only way out of the poll.

**What's mocked, explicitly.** The "operator console" (`src/handoff/operator.html`) is a bare
polling page showing context + a Resume button with a notes field — not a real co-browsing UI,
per the assignment's own scope note. What's real is the control-transfer mechanism: pause,
expose the literal live window, a recorded resume signal, and the human's notes captured as
evidence (`humanNotes` on the `InterventionRequest`, logged to `/evidence`).

**Limits.** The intervention store is a single JSON file (`src/handoff/store.ts`), not a real
database — no transactions, no concurrent-writer safety — but it does survive a handoff-server
restart without losing an open intervention, which an in-memory version cannot (tested in
`tests/handoff-store.test.ts`, including recovery from a corrupted file). What's still missing:
no notification mechanism (an operator must be watching the console); and only one human at a
time can plausibly act on a given session, which the model doesn't yet enforce beyond "there's
one browser window."

## 6. Safety

- **Allowlist** (`allowlist.config.json`, `src/safety/allowlist.ts`): an explicit origin list and
  action-type list, checked identically by discovery (before every navigate/tool execution) and
  replay (before every step). An attempted out-of-allowlist navigation is a hard stop, not a
  warning.
- **Risk classification** (`src/safety/risk.ts`): two independent, conservative signals feed
  this, and either alone is enough to tag a step `irreversible` at record time — (1)
  `classifyRisk`: the target's accessible name matches a configured pattern (`confirm`, `submit`,
  `create`, `delete`, …); (2) `pageTextSignalsIrreversibility`: the page itself said something
  like "this action cannot be undone" immediately before the click, regardless of what the control
  is named. (2) exists specifically because (1) alone is trivially wrong for a blandly-named
  control ("OK", "Continue") sitting next to an explicit warning — both signals are exercised in
  `tests/safety.test.ts`. Replay's approval gate (`checkApprovalGate`) then requires *both* the
  artifact to be `status:"approved"` *and* an explicit per-invocation
  `--confirm-irreversible`/`confirmIrreversible` flag before executing any such step — an artifact
  can't silently graduate from reviewed-draft to unattended-irreversible-execution. I chose
  block-until-explicit-confirmation over "just flag it" because the brief frames this as regulated
  financial data and irreversible operations (opening an account) — the cost of a false block (an
  operator re-running with the flag) is much lower than the cost of an unattended irreversible
  action.
- **Redaction** (`src/safety/redaction.ts`): input params the schema marks `sensitive` are masked
  wherever they're logged, plus a heuristic backstop (SSN-shaped and long-digit-run values) that
  catches an operator forgetting to flag a field. Applied uniformly by the evidence logger, so
  discovery transcripts and replay logs get the same treatment.
- **Limits.** The allowlist is origin/action-type only — it doesn't understand *data* scope (e.g.
  "may read member 12345 but not 99999"); redaction is pattern-based, not a full PII classifier,
  so an unusually-shaped secret could slip through; and risk classification, even with two
  signals, is still not exhaustive — a control that's both blandly named *and* on a page with no
  explicit warning text would still be missed (though a rename between recording and replay would
  also fail locator resolution first in most cases, since `role+name` is the primary candidate,
  surfacing as a hard failure rather than a silent risk miss).

## 7. Cuts

Deliberately left minimal or undone, with what I'd build next:

- **Desktop surface support is design-only** (§4), per the brief's explicit scope — this is the
  one surface-heterogeneity claim still unproven by code. Multi-tenant reuse and the iframe/legacy
  frame pattern, by contrast, *are* implemented (§4) — but multi-tenant only has the
  candidate-override mechanism, not the operational tooling around it (a real tenant registry,
  drift *detection*, per-tenant allowlist scoping — see §4's "not implemented" note). Next:
  implement a second `perception.ts`/`actions.ts` pair against an OS accessibility API to prove
  the last remaining surface seam holds too.
- **No LLM-based parameter generalization** — deterministic exact-value matching only. Next: a
  bounded, reviewed step where a human confirms which typed values should have been parameters,
  rather than trusting an LLM's guess unattended.
- **Two stretch goals** (the agent-facing capability API, `src/capabilities/api.ts`, and
  cross-tenant reuse, `overrides[]` + `src/replay/engine.ts`), at the top of the brief's "at most
  one or two." Confidence/approval scoring and multi-run stability checks were the next candidates
  I'd reach for with more time.
- **No notification channel** for the handoff server (§5) — an operator must be watching the
  console; the intervention store itself is file-backed and survives a restart (§5).
- **Extraction only understands "Label/Value" table rows** (`src/replay/extraction.ts`), not
  arbitrary prose. Every fact this system currently reads back is presented that way in the mock
  app; a real target with prose-embedded facts would need a more general (and still
  LLM-free-at-replay-time) extraction strategy — likely anchored text-proximity rather than exact
  table structure.
- **Business-outcome/checkpoint classification only reads the main document**
  (`classifyPageText`/`verifyCheckpoint` in `src/replay/engine.ts`), even though target
  resolution now understands frames. A validation error or "not found" state rendered *inside* an
  iframe (rather than the main page, as in this project's mock app) wouldn't be caught by the
  outcome taxonomy today — extending those two functions to also scan matched frames is
  straightforward given the frame-resolution plumbing already exists, just not done.
- **No multi-run stability/flakiness signal** — each replay is judged independently; running N
  times and reporting a pass rate per artifact was the most valuable stretch goal I didn't have
  time for.
