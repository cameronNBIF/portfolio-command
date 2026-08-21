/**
 * `/api/v1/exits` — the exit event, and the view built on it (F4, ADR-036).
 *
 * `GET ?asOf=YYYY-MM-DD` serves the Exited view: the companies the roster says
 * have left, and — separately — the ones Finance has recorded an exit for while
 * Affinity still calls them portfolio companies. `POST` records or removes one
 * exit event.
 *
 * THE ENDPOINT WRITES AN EVENT AND NOT A MEMBERSHIP. There is no way to mark a
 * company exited from here, by construction rather than by omission: membership
 * is Affinity's, the sync is one-way inbound (ADR-009), and an exited flag
 * maintained in two places would have the nightly sync silently winning the
 * argument. That is the failure the health-rating workflow was cancelled to
 * avoid (ADR-032) and this endpoint does not reintroduce it.
 *
 * `POST` is gated on `CAN_WRITE_FINANCIAL` inside `applyExitMutation`; `GET` is
 * readable by all four roles, because who left the portfolio and when is a
 * board figure rather than privileged information.
 */
import {
  applyExitMutation,
  db,
  isIsoDate,
  parseExitMutation,
  readExitedView,
  ValidationError,
} from '@portfolio-command/api';

import { jsonBody, withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const asOf = new URL(request.url).searchParams.get('asOf');
    if (!isIsoDate(asOf)) {
      throw new ValidationError('Give "asOf" as YYYY-MM-DD — the date the view is drawn at.');
    }
    return readExitedView(db(), principal, asOf);
  });
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const mutation = parseExitMutation(await jsonBody(request));
    const result = await applyExitMutation(db(), principal, mutation);
    return { ok: true, ...result };
  });
}
