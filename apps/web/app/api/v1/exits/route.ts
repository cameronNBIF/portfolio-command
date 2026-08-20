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
  readExitedView,
  ValidationError,
  type ExitEventInput,
  type ExitMutation,
} from '@portfolio-command/api';

import { withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

const OPS = ['record', 'remove'];

/**
 * Narrows the body to an `ExitMutation`.
 *
 * Shallow, as on every other v1 endpoint: the envelope here, every field rule
 * in `write/exits.ts` — including the exit-type vocabulary, which is read from
 * the database constraint rather than restated in TypeScript.
 */
function parseMutation(body: unknown): ExitMutation {
  if (typeof body !== 'object' || body === null) throw new ValidationError('Body must be an object.');
  const b = body as Record<string, unknown>;

  const op = b['op'];
  if (typeof op !== 'string' || !OPS.includes(op)) {
    throw new ValidationError(`"op" must be one of: ${OPS.join(', ')}.`);
  }

  if (op === 'remove') {
    const companyId = b['companyId'];
    const reason = b['reason'];
    if (typeof companyId !== 'string' || companyId === '') {
      throw new ValidationError('"companyId" is required to remove an exit event.');
    }
    if (typeof reason !== 'string') {
      throw new ValidationError('"reason" is required: an exit that disappears unexplained is one nobody can account for.');
    }
    return { op: 'remove', companyId, reason };
  }

  const values = b['values'];
  if (typeof values !== 'object' || values === null) {
    throw new ValidationError('"values" must be an object holding the exit event.');
  }
  return { op: 'record', values: values as ExitEventInput };
}

export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const asOf = new URL(request.url).searchParams.get('asOf');
    if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      throw new ValidationError('Give "asOf" as YYYY-MM-DD — the date the view is drawn at.');
    }
    return readExitedView(db(), principal, asOf);
  });
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const mutation = parseMutation(await request.json());
    const result = await applyExitMutation(db(), principal, mutation);
    return { ok: true, ...result };
  });
}
