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
  applyLinkTransactions,
  applyRoundMutation,
  db,
  readCompanyCheques,
  readMandateCompleteness,
  readReferenceData,
  readRounds,
  ValidationError,
  type LinkTransactionsMutation,
  type RoundMutation,
} from '@portfolio-command/api';

import { withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

const OPS = ['create', 'update', 'delete', 'restore'];

/**
 * ADR-033. The link lives on THIS endpoint rather than on `/api/v1/financial`,
 * and that placement is the permission decision made visible.
 *
 * It writes a column on `transaction`, which is Finance's table -- so the
 * obvious home is the financial endpoint. The obvious home is wrong. That
 * endpoint is gated on `CAN_WRITE_FINANCIAL` (`finance`, `admin`) and the deal
 * lead who closed the round is `vc`, and the whole point of ADR-033 clause 6 is
 * that attaching a cheque to a round is reconciliation rather than restatement.
 * Routing it here puts it behind `CAN_CAPTURE_ROUND`, beside the round capture
 * it reconciles against, where the two people who do this work both have access.
 */
const LINK_OP = 'link-transactions';

function parseLink(b: Record<string, unknown>): LinkTransactionsMutation {
  const ids = b['transactionIds'];
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError('"transactionIds" must be a non-empty list of transaction ids.');
  }
  const roundId = b['investmentRoundId'];
  // `undefined` is rejected and `null` is accepted, deliberately: null is the
  // form's explicit "No round -- standalone" choice and has to be expressible,
  // while a body that simply omits the key is a caller who has not decided, and
  // guessing which they meant is how a cheque gets silently detached.
  if (roundId === undefined) {
    throw new ValidationError(
      '"investmentRoundId" is required — a round id, or null for a standalone cheque with no round.',
    );
  }
  return {
    transactionIds: ids.map(String),
    investmentRoundId: roundId === null ? null : String(roundId),
    reason: typeof b['reason'] === 'string' ? b['reason'] : null,
  };
}

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
    throw new ValidationError(`"op" must be one of: ${[...OPS, LINK_OP].join(', ')}.`);
  }
  const reason = typeof b['reason'] === 'string' ? b['reason'] : null;
  // F6, FR-08 and FR-14. Both are envelope fields like `reason`: the shape is
  // checked here, the rules are `applyRoundMutation`'s. Two validators over one
  // field is how the two drift apart.
  const changeKind = typeof b['changeKind'] === 'string' ? b['changeKind'] : null;
  const duplicateAckReason =
    typeof b['duplicateAckReason'] === 'string' ? b['duplicateAckReason'] : null;
  const envelope = { reason, changeKind, duplicateAckReason };

  if (op === 'delete' || op === 'restore') {
    const id = b['id'];
    if (typeof id !== 'string' || !/^\d+$/.test(id)) {
      throw new ValidationError('"id" is required and must be a round id.');
    }
    return { op, id, ...envelope } as RoundMutation;
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
    return { op, id, values, ...envelope } as RoundMutation;
  }
  return { op, values, ...envelope } as RoundMutation;
}

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null) {
      throw new ValidationError('Body must be an object.');
    }
    const b = body as Record<string, unknown>;

    // Branched before `parseMutation` rather than inside it: the link carries a
    // different payload entirely -- no `values`, no round fields -- and folding
    // it into the capture parser would mean one function with two bodies and a
    // set of fields that are required in one shape and forbidden in the other.
    if (b['op'] === LINK_OP) {
      // The role check lives in applyLinkTransactions so a second caller that
      // does not come through this route cannot skip it.
      const result = await applyLinkTransactions(db(), principal, parseLink(b));
      return { ok: true, ...result };
    }

    const result = await applyRoundMutation(db(), principal, parseMutation(body));
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

    // F1. Every direct cheque a company has, with the round each is currently
    // attached to. Behind `?cheques=` on this endpoint rather than on the
    // financial one for the same reason the link mutation is: it is the read
    // that surface needs in order to reconcile, and the deal lead has to be
    // able to make it.
    const chequesFor = q.get('cheques');
    if (chequesFor) {
      return { rows: await readCompanyCheques(db(), principal, chequesFor) };
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
