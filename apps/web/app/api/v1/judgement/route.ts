/**
 * `POST /api/v1/judgement` — edits to judgement records only (ADR-018).
 *
 * Gates, reserves and memos, plus the A9 surfaces: risk flags, per-company
 * thresholds, the fund alert policy and alert acknowledgements (ADR-032).
 * Financial rows are unreachable from here by construction, not by convention
 * -- see the note on `JudgementEdit`.
 *
 * HEALTH IS NOT HERE AND WILL NOT BE. Affinity is the system of record for the
 * risk grade behind it (ADR-009) and the sync is one-way; the VC team maintains
 * it there. The platform shows the rating, who set it and when, and offers no
 * way to overwrite it.
 *
 * Financial rows are edited through `/api/v1/financial` (A7, ADR-031), over a
 * versioned store with trigger-enforced history. The split between the two
 * endpoints is the ADR-018 fact/judgement boundary, which ADR-031 left intact:
 * what changed is the interface offered over facts, not which rows are facts.
 */
import { applyJudgementEdit, db, type JudgementEdit } from '@portfolio-command/api';

import { withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

class ValidationError extends Error {
  override name = 'ValidationError';
}

/**
 * Narrows the parsed body to a `JudgementEdit`.
 *
 * Hand-written rather than schema-generated: three shapes do not justify a
 * validation dependency, and the failure messages are better for being written
 * for the person reading them.
 */
function parseEdit(body: unknown): JudgementEdit {
  if (typeof body !== 'object' || body === null) throw new ValidationError('Body must be an object.');
  const b = body as Record<string, unknown>;
  const str = (k: string): string => {
    const v = b[k];
    if (typeof v !== 'string' || v === '') throw new ValidationError(`"${k}" must be a non-empty string.`);
    return v;
  };

  switch (b['kind']) {
    case 'deal-gate':
      return { kind: 'deal-gate', dealId: str('dealId'), gateName: str('gateName'), status: str('status') };
    case 'reserve-allocation': {
      const allocated = b['allocated'];
      if (typeof allocated !== 'number') throw new ValidationError('"allocated" must be a number ($M).');
      return { kind: 'reserve-allocation', companyId: str('companyId'), allocated };
    }
    case 'memo-section': {
      const bodyText = b['body'];
      if (typeof bodyText !== 'string') throw new ValidationError('"body" must be a string.');
      return { kind: 'memo-section', subjectId: str('subjectId'), sectionKey: str('sectionKey'), body: bodyText };
    }
    /* ---------------------------- A9 ---------------------------- */

    case 'risk-flag-raise': {
      const severity = b['severity'];
      if (severity !== undefined && severity !== null && severity !== 'red' && severity !== 'yellow') {
        throw new ValidationError('"severity" must be "red", "yellow", or null to inherit the company health colour.');
      }
      const note = b['note'];
      if (note !== undefined && note !== null && typeof note !== 'string') {
        throw new ValidationError('"note" must be a string or null.');
      }
      return {
        kind: 'risk-flag-raise',
        companyId: str('companyId'),
        category: str('category'),
        note: (note as string | null | undefined) ?? null,
        severity: (severity as 'red' | 'yellow' | null | undefined) ?? null,
      };
    }
    case 'risk-flag-clear': {
      const flagId = b['flagId'];
      if (typeof flagId !== 'number' || !Number.isInteger(flagId)) {
        throw new ValidationError('"flagId" must be an integer.');
      }
      return { kind: 'risk-flag-clear', flagId, reason: str('reason') };
    }
    case 'company-threshold': {
      const t = b['thresholds'];
      if (typeof t !== 'object' || t === null) throw new ValidationError('"thresholds" must be an object.');
      const inner = parseThresholds(t as Record<string, unknown>);
      return { kind: 'company-threshold', companyId: str('companyId'), thresholds: inner };
    }
    case 'alert-policy': {
      const t = parseThresholds(b);
      const note = b['note'];
      if (note !== undefined && note !== null && typeof note !== 'string') {
        throw new ValidationError('"note" must be a string or null.');
      }
      // Every field is stated on a policy write. A partial policy would leave
      // the unstated metrics reading whatever the superseded row said, which
      // is not what "this is our policy" means on the screen that sends it.
      return {
        kind: 'alert-policy',
        minRunwayMo: t.minRunwayMo ?? null,
        maxBurnMult: t.maxBurnMult ?? null,
        minCashBalance: t.minCashBalance ?? null,
        maxRevenueDeclinePct: t.maxRevenueDeclinePct ?? null,
        minNrrPct: t.minNrrPct ?? null,
        note: (note as string | null | undefined) ?? null,
      };
    }
    case 'alert-acknowledge': {
      const value = b['value'];
      if (value !== undefined && value !== null && typeof value !== 'number') {
        throw new ValidationError('"value" must be a number or null.');
      }
      return {
        kind: 'alert-acknowledge',
        companyId: str('companyId'),
        alertKey: str('alertKey'),
        reason: str('reason'),
        untilDate: str('untilDate'),
        value: (value as number | null | undefined) ?? null,
      };
    }
    case 'alert-revoke':
      return { kind: 'alert-revoke', companyId: str('companyId'), alertKey: str('alertKey') };

    default:
      throw new ValidationError(
        '"kind" must be one of: deal-gate, reserve-allocation, memo-section, risk-flag-raise, ' +
          'risk-flag-clear, company-threshold, alert-policy, alert-acknowledge, alert-revoke. ' +
          'Financial records are edited through /api/v1/financial (ADR-031), and company health is ' +
          'maintained in Affinity (ADR-009).',
      );
  }
}

/**
 * The five threshold fields, shared by the per-company and fund-level shapes.
 *
 * THE THREE STATES SURVIVE PARSING, because the write path depends on telling
 * them apart: absent leaves the stored value alone, `null` clears it so the
 * fund policy is inherited, and `0` disables the alert outright. A parser that
 * folded `null` into `undefined` would make it impossible to hand a company
 * back to the policy once it had a number of its own.
 */
function parseThresholds(b: Record<string, unknown>) {
  const num = (k: string): number | null | undefined => {
    const v = b[k];
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new ValidationError(`"${k}" must be a non-negative number, or null to inherit the fund policy.`);
    }
    return v;
  };
  return {
    minRunwayMo: num('minRunwayMo'),
    maxBurnMult: num('maxBurnMult'),
    minCashBalance: num('minCashBalance'),
    maxRevenueDeclinePct: num('maxRevenueDeclinePct'),
    minNrrPct: num('minNrrPct'),
  };
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const edit = parseEdit(await request.json().catch(() => null));
    // The role check lives in applyJudgementEdit so it cannot be forgotten by a
    // second caller that does not go through this route.
    await applyJudgementEdit(db(), principal, edit);
    return { ok: true };
  });
}
