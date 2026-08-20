/**
 * `/api/v1/policies` — the finance policies (F3, FR-21, ADR-035 clause 5).
 *
 * `GET` serves the accounting policy with its history and the FMV retention
 * options; `POST` sets a threshold or edits the option list.
 *
 * SEPARATE FROM `/api/v1/judgement`, WHICH ALREADY CARRIES THE ALERT POLICY,
 * AND THAT SPLIT IS THE WHOLE POINT OF THE TAB THESE TWO SHARE. The judgement
 * endpoint is gated on `CAN_EDIT_JUDGEMENT` — the investment team, who own the
 * watchlist. What is set here decides financial-statement treatment, so it is
 * gated on `CAN_SET_FINANCE_POLICY`. One endpoint over both would mean one gate
 * over both, and the wider of the two would win — the same argument that keeps
 * Finance and Deal Close apart.
 *
 * THE ALERT POLICY IS DELIBERATELY NOT SERVED HERE even though its card sits on
 * the same screen. It reaches the browser through the ADR-001 export as
 * `alertPolicy` and always has; moving the card between tabs is not a reason to
 * introduce a second read of the same row.
 *
 * `GET` is readable by all four roles. What our significant-influence threshold
 * is is not privileged information inside a nine-person team, and a leadership
 * reader who cannot see the threshold cannot make sense of the schedule that
 * applies it.
 */
import {
  applyFinancePolicyEdit,
  db,
  readFinancePolicies,
  ValidationError,
  type FinancePolicyEdit,
} from '@portfolio-command/api';

import { withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

const KINDS = ['accounting-policy', 'retention-option-add', 'retention-option-active'];

/**
 * Narrows the body to a `FinancePolicyEdit`.
 *
 * Shallow, as everywhere else on v1: the envelope here, the field rules in
 * `write/finance-policy.ts`.
 *
 * ONE THING THIS MUST NOT DO IS COALESCE A NULL. `significantInfluencePct: null`
 * is "no threshold in force", which makes the derived flag NULL for every
 * company; `0` would flag every company we hold a figure for. A `?? 0` here
 * would turn the first into the second, silently, on the one screen where the
 * difference is the requirement.
 */
function parseEdit(body: unknown): FinancePolicyEdit {
  if (typeof body !== 'object' || body === null) throw new ValidationError('Body must be an object.');
  const b = body as Record<string, unknown>;

  const kind = b['kind'];
  if (typeof kind !== 'string' || !KINDS.includes(kind)) {
    throw new ValidationError(`"kind" must be one of: ${KINDS.join(', ')}.`);
  }

  if (kind === 'accounting-policy') {
    const pct = b['significantInfluencePct'];
    if (pct !== null && typeof pct !== 'number') {
      throw new ValidationError(
        '"significantInfluencePct" must be a number — 10 means 10% — or null for no threshold in force.',
      );
    }
    return {
      kind,
      significantInfluencePct: pct,
      note: typeof b['note'] === 'string' ? b['note'] : null,
    };
  }

  const factor = b['factor'];
  if (typeof factor !== 'string' || factor === '') {
    throw new ValidationError('"factor" is required — the retained share as a decimal, such as "0.60".');
  }

  if (kind === 'retention-option-add') {
    const label = b['label'];
    if (typeof label !== 'string') throw new ValidationError('"label" is required.');
    const sortOrder = b['sortOrder'];
    return {
      kind,
      factor,
      label,
      sortOrder: typeof sortOrder === 'number' ? sortOrder : null,
    };
  }

  const isActive = b['isActive'];
  if (typeof isActive !== 'boolean') {
    throw new ValidationError('"isActive" must be true to offer this option or false to retire it.');
  }
  return { kind: 'retention-option-active', factor, isActive };
}

export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => readFinancePolicies(db(), principal));
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const edit = parseEdit(await request.json());
    const result = await applyFinancePolicyEdit(db(), principal, edit);
    return { ok: true, ...result };
  });
}
