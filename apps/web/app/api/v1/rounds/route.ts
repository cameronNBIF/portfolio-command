/**
 * `/api/v1/rounds` — the ADR-012 deal-close capture (A8).
 *
 * `GET` serves the rounds table the Deal Close tab renders, and
 * `?completeness=true` serves the mandate coverage the dashboard tile reads.
 * `POST` applies one capture.
 *
 * SEPARATE FROM `/api/v1/financial` DESPITE TWO SHARED TABLES, because the two
 * have different authors. That endpoint is Finance's and writes our own cheque;
 * this one is the deal lead's and writes the shape of the round around it
 * (ADR-012, `CAN_CAPTURE_ROUND`). One endpoint over both would mean one role
 * gate over both, and the wider of the two would win.
 *
 * AMOUNTS ARE DOLLARS ON THIS ENDPOINT, as text, not the contract's `$M` — the
 * same divergence and the same reasoning as the financial endpoint. See the
 * units note in `packages/api/src/write/session.ts`.
 */
import {
  applyRoundMutation,
  db,
  readMandateCompleteness,
  readReferenceData,
  readRounds,
  ValidationError,
  type RoundMutation,
} from '@portfolio-command/api';

import { withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

const OPS = ['create', 'update', 'delete', 'restore'];

/**
 * Narrows the body to a `RoundMutation`.
 *
 * Shallow on purpose, matching the financial route: this checks the envelope
 * and leaves every field rule to `applyRoundMutation`, which owns them and
 * raises the same error type. Two validators over the same fields is how the two
 * drift apart.
 */
function parseMutation(body: unknown): RoundMutation {
  if (typeof body !== 'object' || body === null) throw new ValidationError('Body must be an object.');
  const b = body as Record<string, unknown>;

  const op = b['op'];
  if (typeof op !== 'string' || !OPS.includes(op)) {
    throw new ValidationError(`"op" must be one of: ${OPS.join(', ')}.`);
  }
  const reason = typeof b['reason'] === 'string' ? b['reason'] : null;

  if (op === 'delete' || op === 'restore') {
    const id = b['id'];
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new ValidationError('"id" is required and must be a round id.');
    }
    return { op, id, reason } as RoundMutation;
  }

  const values = b['values'];
  if (typeof values !== 'object' || values === null) {
    throw new ValidationError('"values" must be an object holding the complete round.');
  }
  // Defaulted rather than demanded: a round genuinely can have no co-investors,
  // and a form that omits the key entirely should mean the same thing as one
  // that sends an empty list.
  const v = values as Record<string, unknown>;
  if (v['coinvestors'] === undefined) v['coinvestors'] = [];
  if (!Array.isArray(v['coinvestors'])) {
    throw new ValidationError('"values.coinvestors" must be a list, holding the complete set for this round.');
  }

  if (op === 'update') {
    const id = b['id'];
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new ValidationError('"id" is required on an update and must be a round id.');
    }
    return { op, id, values, reason } as RoundMutation;
  }
  return { op, values, reason } as RoundMutation;
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const mutation = parseMutation(await request.json().catch(() => null));
    // The role check lives in applyRoundMutation so a second caller that does
    // not come through this route cannot skip it.
    const result = await applyRoundMutation(db(), principal, mutation);
    return { ok: true, ...result };
  });
}

export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const q = new URL(request.url).searchParams;

    // The dashboard's mandate tile. No role narrowing: coverage is a board
    // figure's qualifier and leadership reads both (ADR-005).
    if (q.get('completeness') === 'true') {
      return readMandateCompleteness(db());
    }

    // The form's dropdowns. Closes the A7 item that left the transaction form
    // with no investment-vehicle picker (ADR-030).
    if (q.get('reference') === 'true') {
      return readReferenceData(db(), principal);
    }

    return readRounds(db(), principal, {
      companyId: q.get('companyId'),
      from: q.get('from'),
      to: q.get('to'),
      incompleteOnly: q.get('incompleteOnly') === 'true',
      includeDeleted: q.get('includeDeleted') === 'true',
      limit: q.has('limit') ? Number(q.get('limit')) : undefined,
      offset: q.has('offset') ? Number(q.get('offset')) : undefined,
    });
  });
}
