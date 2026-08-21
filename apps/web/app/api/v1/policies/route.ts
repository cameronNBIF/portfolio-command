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
  parseFinancePolicyEdit,
  readFinancePolicies,
} from '@portfolio-command/api';

import { jsonBody, withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => readFinancePolicies(db(), principal));
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const edit = parseFinancePolicyEdit(await jsonBody(request));
    const result = await applyFinancePolicyEdit(db(), principal, edit);
    return { ok: true, ...result };
  });
}
