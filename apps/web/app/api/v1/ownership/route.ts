/**
 * `/api/v1/ownership` — the cap table between rounds (F3, FR-36, ADR-035).
 *
 * `GET ?asOf=YYYY-MM-DD` serves the significant-influence schedule, and
 * `GET ?companyId=…` one company's ownership history. `POST` records or
 * corrects one dated position.
 *
 * ITS OWN ENDPOINT RATHER THAN A VERB ON `/api/v1/rounds`, though both are
 * gated on `CAN_CAPTURE_ROUND` and both write `company_ownership`. That
 * endpoint captures a ROUND — one mutation over three tables, where the
 * ownership row is one consequence of the event being recorded. This one exists
 * because Q-15 established that the cap table moves when no round of ours does:
 * an option pool expansion, a round we sat out, a secondary. Folding it into the
 * deal-close capture would mean inventing a round to hang it on, which is the
 * exact fiction FR-36 exists to stop.
 *
 * PERCENTAGES ARE PLAIN NUMBERS AS TEXT — "11.2" is 11.2%, not 0.112 — matching
 * the ADR-001 contract convention and the rounds endpoint beside it.
 */
import {
  applyOwnershipMutation,
  db,
  isIsoDate,
  parseOwnershipMutation,
  readOwnershipHistory,
  readSignificantInfluence,
  ValidationError,
} from '@portfolio-command/api';

import { jsonBody, withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const q = new URL(request.url).searchParams;

    const companyId = q.get('companyId');
    if (companyId) {
      const rows = await readOwnershipHistory(db(), principal, companyId);
      return { rows };
    }

    const asOf = q.get('asOf');
    if (!isIsoDate(asOf)) {
      /* No default to today, and the message says why rather than silently
         picking one: the schedule reproduces a classification that may already
         have been reported, so the date is the caller's to state (ADR-021). */
      throw new ValidationError(
        'Give "asOf" as YYYY-MM-DD — the date the schedule is drawn at — or "companyId" for one ' +
          "company's ownership history.",
      );
    }
    return readSignificantInfluence(db(), principal, asOf);
  });
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const mutation = parseOwnershipMutation(await jsonBody(request));
    const result = await applyOwnershipMutation(db(), principal, mutation);
    return { ok: true, ...result };
  });
}
