// A deliberately "legacy" server-rendered back-office console: table-based layout, no
// id/data-testid attributes, no client-side JS. Stands in for the bank core banking / servicing
// screens described in the assignment brief. Every interactive element still has a proper
// semantic role + accessible name (native <label>/<button>/<table>) — that's the point: legacy
// markup with no test hooks is still perceivable and actionable via accessibility semantics,
// which is exactly the seam the automation system is built around.
import "dotenv/config";
import express from "express";
import { members, nextSubAccountId, type Member } from "./data.js";

const PORT = Number(process.env.MOCK_APP_PORT ?? 4000);
const app = express();
app.use(express.urlencoded({ extended: true }));

const SESSION_EXPIRED_MEMBER_ID = "77777"; // deterministic, always-expired demo id

// Cross-tenant reuse demo (REPORT.md #4): the same underlying vendor product ("AcmeCore
// Servicing UI"), configured/branded differently per tenant. MOCK_APP_TENANT switches which
// tenant's instance this process serves — real differences a tenant's config might introduce
// (here: the header branding and the search control's label), everything else (routes, business
// logic, table layout) stays identical, which is exactly the case a shared artifact + per-tenant
// override should cover without re-recording.
const TENANTS = {
  riverside: { brand: "Riverside Credit Union — Servicing Console", searchButtonLabel: "Search" },
  lakeside: { brand: "Lakeside Community Bank — Member Services", searchButtonLabel: "Find Member" },
} as const;
type TenantId = keyof typeof TENANTS;
const TENANT_ID = (process.env.MOCK_APP_TENANT ?? "riverside") as TenantId;
const TENANT = TENANTS[TENANT_ID] ?? TENANTS.riverside;

// A visual reskin only, via one wrapping <div> plus plain-tag CSS selectors (table/th/td/form/
// label/input/button/a) — never a new class, id, or data-testid on any interactive element. A
// <div> isn't in perception.ts's element query (a[href], button, input, textarea, select), so
// wrapping the page in one doesn't change any role/name computation, any table's row/cell count
// (extraction depends on exact Field/Value pairs), or any button/link text (recorded artifacts
// already match on that). The point of this mock app — no test hooks, legacy table-based markup —
// is untouched; it just no longer looks abandoned.
const BASE_STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    background: #eef1f5;
    color: #1f2430;
    margin: 0;
    padding: 2rem 1rem 4rem;
  }
  .page { max-width: 720px; margin: 0 auto; }
  .page > table[role="presentation"] {
    background: #1f3a5f;
    border-radius: 10px 10px 0 0;
    width: 100%;
  }
  .page > table[role="presentation"] h1 {
    color: #ffffff;
    font-size: 1.15rem;
    font-weight: 600;
    margin: 0;
    padding: 1.1rem 1.5rem;
  }
  .page > hr { display: none; }
  .page > h2:first-of-type {
    background: #ffffff;
    border-radius: 0 0 10px 10px;
    margin: 0 0 1.5rem;
    padding: 1.25rem 1.5rem 1.25rem;
  }
  h2, h3 {
    color: #1f2430;
    font-weight: 600;
  }
  h3 { margin-top: 1.75rem; }
  table:not([role="presentation"]) {
    width: 100%;
    border-collapse: collapse;
    background: #ffffff;
    border: 1px solid #dde2ea;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  }
  th, td {
    text-align: left;
    padding: 0.65rem 0.9rem;
    border-bottom: 1px solid #eef1f5;
    font-size: 0.92rem;
  }
  th {
    background: #f5f7fa;
    color: #4b5468;
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  tr:last-child td { border-bottom: none; }
  form { background: #ffffff; border: 1px solid #dde2ea; border-radius: 8px; padding: 1.25rem 1.5rem; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04); }
  form table { border: none; box-shadow: none; margin-bottom: 1rem; }
  form table td { border: none; padding: 0.5rem 0.9rem 0.5rem 0; }
  label { font-size: 0.85rem; color: #4b5468; font-weight: 600; }
  input[type="text"], select {
    font: inherit;
    font-size: 0.92rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid #d3d9e2;
    border-radius: 6px;
    background: #fbfcfd;
    min-width: 220px;
  }
  input[type="text"]:focus, select:focus {
    outline: none;
    border-color: #3660a5;
    box-shadow: 0 0 0 3px rgba(54, 96, 165, 0.15);
  }
  button {
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    padding: 0.55rem 1.1rem;
    border: none;
    border-radius: 6px;
    background: #2f5aa8;
    color: #ffffff;
    cursor: pointer;
  }
  button:hover { background: #274a8c; }
  a { color: #2f5aa8; text-decoration: none; font-size: 0.92rem; }
  a:hover { text-decoration: underline; }
  p { font-size: 0.92rem; line-height: 1.5; }
  p[role="alert"] {
    background: #fdf2f2;
    border: 1px solid #f3c2c2;
    color: #9a2f2f;
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }
  iframe { border-radius: 8px; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title><style>${BASE_STYLES}</style></head>
<body>
<div class="page">
<table role="presentation" width="100%">
  <tr><td><h1>${TENANT.brand}</h1></td></tr>
</table>
<hr>
${body}
</div>
</body>
</html>`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

app.get("/", (_req, res) => {
  res.send(
    layout(
      "Member Search",
      `
    <h2>Member Search</h2>
    <form method="GET" action="/members/lookup">
      <table>
        <tr>
          <td><label for="memberId">Member ID</label></td>
          <td><input type="text" name="memberId" id="memberId"></td>
        </tr>
      </table>
      <button type="submit">${TENANT.searchButtonLabel}</button>
    </form>
  `
    )
  );
});

app.get("/members/lookup", (req, res) => {
  const memberId = String(req.query["memberId"] ?? "").trim();
  if (!memberId) {
    res.status(400).send(layout("Search Error", `<p>Please enter a member ID.</p><p><a href="/">Back</a></p>`));
    return;
  }
  res.redirect(`/members/${encodeURIComponent(memberId)}`);
});

app.get("/members/:id", (req, res) => {
  const id = req.params.id;

  if (id === SESSION_EXPIRED_MEMBER_ID) {
    res
      .status(440)
      .send(
        layout(
          "Session Expired",
          `<h2>Session Expired</h2><p>Your session has expired. Please log in again to continue.</p><p><a href="/">Return to login</a></p>`
        )
      );
    return;
  }

  const member = members.get(id);
  if (!member) {
    res
      .status(404)
      .send(
        layout(
          "Member Not Found",
          `<h2>Member Search</h2><p>No member found with ID "${escapeHtml(id)}".</p><p><a href="/">Back to search</a></p>`
        )
      );
    return;
  }

  if (member.status === "locked") {
    res
      .status(403)
      .send(
        layout(
          "Access Denied",
          `<h2>Access Denied</h2><p>This member's account is locked. You do not have permission to view this record.</p><p><a href="/">Back to search</a></p>`
        )
      );
    return;
  }

  res.send(layout(`Member ${member.id}`, renderMemberDetail(member)));
});

function renderMemberDetail(member: Member): string {
  const subRows = member.subAccounts
    .map(
      (s) =>
        `<tr><td>${s.id}</td><td>${escapeHtml(s.type)}</td><td>${money(s.balanceCents)}</td><td>${escapeHtml(
          s.purpose
        )}</td></tr>`
    )
    .join("");
  return `
    <h2>Member Detail</h2>
    <table border="1" cellpadding="4">
      <tr><th>Field</th><th>Value</th></tr>
      <tr><td>Member ID</td><td>${member.id}</td></tr>
      <tr><td>Name</td><td>${escapeHtml(member.name)}</td></tr>
      <tr><td>Status</td><td>${member.status}</td></tr>
      <tr><td>Savings Balance</td><td>${money(member.savingsBalanceCents)}</td></tr>
      <tr><td>Checking Balance</td><td>${money(member.checkingBalanceCents)}</td></tr>
    </table>

    <h3>Sub-Accounts</h3>
    <table border="1" cellpadding="4">
      <tr><th>ID</th><th>Type</th><th>Balance</th><th>Purpose</th></tr>
      ${subRows || `<tr><td colspan="4">None</td></tr>`}
    </table>

    <p><a href="/members/${member.id}/subaccount/new">Open Sub-Account</a></p>
    <p><a href="/">Back to search</a></p>

    <h3>Account Notes</h3>
    <iframe src="/members/${member.id}/notes" title="Account Notes" style="width:100%;height:240px;border:1px solid #999;"></iframe>
  `;
}

// This panel is deliberately served as its own document and embedded via <iframe> — a common
// legacy pattern (a servicing console built by bolting a separately-maintained sub-app onto a
// page via a frame) that this project's perception/replay layers previously assumed away.
// Interacting with it requires acting *inside* a child frame, not the main document — the seam
// this exercises is documented in REPORT.md #4.
function renderNotesPanel(member: Member): string {
  const noteRows = member.notes.map((n) => `<tr><td>${escapeHtml(n)}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Account Notes</title><style>${BASE_STYLES}
  body { padding: 0.9rem; background: #ffffff; }
  table { margin-bottom: 0.9rem; }
</style></head>
<body>
  <table border="1" cellpadding="4" width="100%">
    <tr><td>Total Notes</td><td>${member.notes.length}</td></tr>
  </table>
  <table border="1" cellpadding="4" width="100%">
    <tr><th>Note</th></tr>
    ${noteRows || `<tr><td>No notes yet.</td></tr>`}
  </table>
  <form method="POST" action="/members/${member.id}/notes">
    <label for="note">Note</label>
    <input type="text" name="note" id="note">
    <button type="submit">Add Note</button>
  </form>
</body>
</html>`;
}

app.get("/members/:id/notes", (req, res) => {
  const member = members.get(req.params.id);
  if (!member) {
    res.status(404).send(`<p>No member found with ID "${escapeHtml(req.params.id)}".</p>`);
    return;
  }
  res.send(renderNotesPanel(member));
});

app.post("/members/:id/notes", (req, res) => {
  const member = members.get(req.params.id);
  if (!member) {
    res.status(404).send(`<p>No member found with ID "${escapeHtml(req.params.id)}".</p>`);
    return;
  }
  const note = String(req.body.note ?? "").trim();
  if (note) member.notes.push(note);
  res.redirect(`/members/${member.id}/notes`);
});

app.get("/members/:id/subaccount/new", (req, res) => {
  const member = members.get(req.params.id);
  if (!member) {
    res.status(404).send(layout("Member Not Found", `<p>No member found with ID "${escapeHtml(req.params.id)}".</p>`));
    return;
  }
  res.send(layout(`Open Sub-Account for ${member.id}`, renderSubAccountForm(member, null)));
});

function renderSubAccountForm(
  member: Member,
  error: string | null,
  values?: { accountType: string; depositAmount: string; purpose: string }
): string {
  const v = values ?? { accountType: "savings", depositAmount: "", purpose: "" };
  return `
    <h2>Open New Sub-Account &mdash; Member ${member.id} (${escapeHtml(member.name)})</h2>
    ${error ? `<p role="alert"><strong>Validation error:</strong> ${escapeHtml(error)}</p>` : ""}
    <form method="POST" action="/members/${member.id}/subaccount/new">
      <table>
        <tr>
          <td><label for="accountType">Account Type</label></td>
          <td>
            <select name="accountType" id="accountType">
              <option value="savings" ${v.accountType === "savings" ? "selected" : ""}>Savings</option>
              <option value="money_market" ${v.accountType === "money_market" ? "selected" : ""}>Money Market</option>
            </select>
          </td>
        </tr>
        <tr>
          <td><label for="depositAmount">Initial Deposit (USD)</label></td>
          <td><input type="text" name="depositAmount" id="depositAmount" value="${escapeHtml(v.depositAmount)}"></td>
        </tr>
        <tr>
          <td><label for="purpose">Purpose</label></td>
          <td><input type="text" name="purpose" id="purpose" value="${escapeHtml(v.purpose)}"></td>
        </tr>
      </table>
      <button type="submit">Continue</button>
    </form>
    <p><a href="/members/${member.id}">Cancel</a></p>
  `;
}

app.post("/members/:id/subaccount/new", (req, res) => {
  const member = members.get(req.params.id);
  if (!member) {
    res.status(404).send(layout("Member Not Found", `<p>No member found with ID "${escapeHtml(req.params.id)}".</p>`));
    return;
  }
  const accountType = String(req.body.accountType ?? "savings");
  const purpose = String(req.body.purpose ?? "");
  const depositAmountRaw = String(req.body.depositAmount ?? "");
  const depositDollars = Number(depositAmountRaw);

  if (!depositAmountRaw || Number.isNaN(depositDollars) || depositDollars < 25) {
    res
      .status(422)
      .send(
        layout(
          "Validation Error",
          renderSubAccountForm(member, "Initial deposit must be at least $25.00.", {
            accountType,
            depositAmount: depositAmountRaw,
            purpose,
          })
        )
      );
    return;
  }

  const depositCents = Math.round(depositDollars * 100);
  res.send(
    layout(
      "Confirm Sub-Account",
      `
    <h2>Confirm New Sub-Account</h2>
    <p><strong>This action cannot be undone.</strong></p>
    <table border="1" cellpadding="4">
      <tr><th>Field</th><th>Value</th></tr>
      <tr><td>Member</td><td>${member.id} (${escapeHtml(member.name)})</td></tr>
      <tr><td>Account Type</td><td>${escapeHtml(accountType)}</td></tr>
      <tr><td>Initial Deposit</td><td>${money(depositCents)}</td></tr>
      <tr><td>Purpose</td><td>${escapeHtml(purpose)}</td></tr>
    </table>
    <form method="POST" action="/members/${member.id}/subaccount/confirm">
      <input type="hidden" name="accountType" value="${escapeHtml(accountType)}">
      <input type="hidden" name="depositAmount" value="${escapeHtml(depositAmountRaw)}">
      <input type="hidden" name="purpose" value="${escapeHtml(purpose)}">
      <button type="submit" name="intent" value="confirm">Confirm &mdash; Open Sub-Account</button>
    </form>
    <p><a href="/members/${member.id}">Cancel</a></p>
  `
    )
  );
});

app.post("/members/:id/subaccount/confirm", (req, res) => {
  const member = members.get(req.params.id);
  if (!member) {
    res.status(404).send(layout("Member Not Found", `<p>No member found with ID "${escapeHtml(req.params.id)}".</p>`));
    return;
  }
  const accountType = String(req.body.accountType ?? "savings");
  const purpose = String(req.body.purpose ?? "");
  const depositCents = Math.round(Number(req.body.depositAmount ?? "0") * 100);

  const subAccount = { id: nextSubAccountId(), type: accountType, balanceCents: depositCents, purpose };
  member.subAccounts.push(subAccount);

  res.send(
    layout(
      "Sub-Account Created",
      `
    <h2>Sub-Account Created</h2>
    <table border="1" cellpadding="4">
      <tr><th>Field</th><th>Value</th></tr>
      <tr><td>New Sub-Account ID</td><td>${subAccount.id}</td></tr>
      <tr><td>Account Type</td><td>${escapeHtml(subAccount.type)}</td></tr>
      <tr><td>Balance</td><td>${money(subAccount.balanceCents)}</td></tr>
      <tr><td>Member</td><td>${member.id} (${escapeHtml(member.name)})</td></tr>
    </table>
    <p><a href="/members/${member.id}">Back to member</a></p>
  `
    )
  );
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const server = app.listen(PORT, () => {
  console.log(`[mock-app] Riverside Credit Union servicing console listening on http://localhost:${PORT}`);
});
