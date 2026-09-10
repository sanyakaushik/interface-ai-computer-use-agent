// In-memory "core" for the mock back-office console. Intentionally simple: this stands in for a
// legacy banking core, not a real one. No real PII: all member records are synthetic.

export interface SubAccount {
  id: string;
  type: string;
  balanceCents: number;
  purpose: string;
}

export interface Member {
  id: string;
  name: string;
  status: "active" | "locked";
  savingsBalanceCents: number;
  checkingBalanceCents: number;
  subAccounts: SubAccount[];
  notes: string[];
}

export const members = new Map<string, Member>([
  [
    "12345",
    {
      id: "12345",
      name: "Jordan Alvarez",
      status: "active",
      savingsBalanceCents: 482113,
      checkingBalanceCents: 91240,
      subAccounts: [],
      notes: [],
    },
  ],
  [
    "99999",
    {
      id: "99999",
      name: "Riley Chen",
      status: "locked",
      savingsBalanceCents: 0,
      checkingBalanceCents: 0,
      subAccounts: [],
      notes: [],
    },
  ],
  [
    "40000",
    {
      id: "40000",
      name: "Sam Okafor",
      status: "active",
      savingsBalanceCents: 15020,
      checkingBalanceCents: 3399,
      subAccounts: [],
      notes: [],
    },
  ],
]);

let subAccountSeq = 1000;
export function nextSubAccountId(): string {
  subAccountSeq += 1;
  return `SA-${subAccountSeq}`;
}

// Simulates a session that has expired after a configurable number of requests, so replay/
// discovery can exercise a recoverable "please log in again" interstitial. Reset per-process.
let requestsSinceLogin = 0;
export const SESSION_EXPIRY_THRESHOLD = 1_000_000; // effectively disabled unless forced via header
export function bumpRequestCounter(forceExpire: boolean): boolean {
  requestsSinceLogin += 1;
  if (forceExpire) return true;
  return requestsSinceLogin >= SESSION_EXPIRY_THRESHOLD;
}
export function resetSession(): void {
  requestsSinceLogin = 0;
}
