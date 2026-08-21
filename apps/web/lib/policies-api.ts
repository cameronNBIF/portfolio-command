'use client';

/**
 * The client's side of the Policies surface (F3, FR-21, FR-36, ADR-035).
 *
 * TWO ENDPOINTS BEHIND ONE SCREEN, and the split is not an implementation
 * detail — it is the permission boundary the tab is built around.
 * `/api/v1/policies` is gated on `CAN_SET_FINANCE_POLICY` and decides how every
 * position is classified; `/api/v1/ownership` is gated on `CAN_CAPTURE_ROUND`
 * and records what we own. The alert-policy card on the same screen posts to a
 * third, `/api/v1/judgement`, through `alerts-api.ts`, because it belongs to
 * the investment team. One client covering all three would hide that.
 *
 * Thin, for the reason `finance-api.ts` is thin: every rule about what a valid
 * threshold, factor or ownership figure is lives in `packages/api/src/write`,
 * and a second copy here would be a second thing to keep in step.
 *
 * PERCENTAGES ARE PLAIN NUMBERS — "11.2" is 11.2%, not 0.112 — and ownership
 * travels as a STRING, unparsed, so what was typed is what reaches `numeric`.
 */
import type {
  FinancePolicies,
  OwnershipRow,
  SignificantInfluenceReport,
} from '@portfolio-command/api';

import { call } from './http';

export const fetchFinancePolicies = (): Promise<FinancePolicies> => call('/api/v1/policies');

/**
 * `null` is a value here and must survive the journey.
 *
 * It means "no threshold in force", which makes the derived flag NULL for every
 * company — a different statement from a threshold of 0, which would flag every
 * company we hold a figure for. A `?? 0` anywhere on this path would collapse
 * the two on the one screen where the difference is the requirement.
 */
export const setSignificantInfluenceThreshold = (
  significantInfluencePct: number | null,
  note?: string | null,
): Promise<{ applied: string }> =>
  call('/api/v1/policies', {
    method: 'POST',
    body: JSON.stringify({ kind: 'accounting-policy', significantInfluencePct, note: note ?? null }),
  });

export const addRetentionOption = (
  factor: string,
  label: string,
): Promise<{ applied: string }> =>
  call('/api/v1/policies', {
    method: 'POST',
    body: JSON.stringify({ kind: 'retention-option-add', factor, label }),
  });

/** Retired, never deleted: a used factor is referenced by marks that must still reconstruct. */
export const setRetentionOptionActive = (
  factor: string,
  isActive: boolean,
): Promise<{ applied: string }> =>
  call('/api/v1/policies', {
    method: 'POST',
    body: JSON.stringify({ kind: 'retention-option-active', factor, isActive }),
  });

export const fetchSignificantInfluence = (asOf: string): Promise<SignificantInfluenceReport> =>
  call(`/api/v1/ownership?${new URLSearchParams({ asOf })}`);

export const fetchOwnershipHistory = (companyId: string): Promise<{ rows: OwnershipRow[] }> =>
  call(`/api/v1/ownership?${new URLSearchParams({ companyId })}`);

export interface OwnershipResult {
  ok: true;
  id: string;
  restated: boolean;
  replacedExisting: boolean;
}

export const recordOwnership = (values: {
  companyId: string;
  asOfDate: string;
  ownershipPct: string;
  proRataRights: boolean;
  fullyDiluted?: boolean;
  sourceDocument?: string | null;
  changeReason: string;
  investmentRoundId?: string | null;
}, reason?: string | null): Promise<OwnershipResult> =>
  call('/api/v1/ownership', {
    method: 'POST',
    body: JSON.stringify({ op: 'set', values, reason: reason ?? null }),
  });

export const deleteOwnership = (id: string, reason: string): Promise<OwnershipResult> =>
  call('/api/v1/ownership', {
    method: 'POST',
    body: JSON.stringify({ op: 'delete', id, reason }),
  });

/**
 * Percent for display, from the value as stored.
 *
 * Two decimals because `ownership_pct` is `numeric(19,16)` to satisfy the
 * ADR-001 round trip, and rendering sixteen of them would suggest a cap-table
 * precision nobody has. The same rule and the same reasoning as `pct()` in
 * `rounds-api.ts`.
 */
export function pct(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `${n.toFixed(2).replace(/\.00$/, '')}%`;
}

/**
 * Today, for the schedule's date picker.
 *
 * A DEFAULT FOR THE PICKER, NOT A SUBSTITUTE FOR ONE — the same distinction
 * `currentValuationCycle()` makes and for the same reason. The API requires
 * `asOf` and refuses to assume, because a classification reproduced without a
 * stated date is one nobody can check. What this does is spare the reader from
 * typing the date they almost always want.
 *
 * TODAY RATHER THAN THE DOCUMENT'S `asOf`, which is derived from the latest
 * valuation mark. Significant influence has nothing to do with when a position
 * was last valued: it is ownership against a policy, both of which move on
 * their own timelines. Defaulting to a mark date would show a threshold set
 * this morning as not yet in force, which is true and useless.
 */
export const todayISO = (): string => new Date().toISOString().slice(0, 10);

/**
 * How old an ownership figure is, in words.
 *
 * A FACT, NOT A JUDGEMENT. FR-21 depends on FR-36 because a flag derived from a
 * stale cap table looks exactly as authoritative as one derived from a current
 * one — so the age is shown on every row and no threshold is invented above
 * which the platform calls a figure "stale". Nobody has set one.
 */
export function ageInMonths(asOfDate: string | null, at: string): number | null {
  if (!asOfDate) return null;
  const from = new Date(`${asOfDate}T00:00:00Z`);
  const to = new Date(`${at}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth())
  );
}
