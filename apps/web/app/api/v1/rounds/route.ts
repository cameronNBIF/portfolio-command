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
  LINK_OP,
  parseLinkTransactions,
  parseRoundMutation,
  readCompanyCheques,
  readMandateCompleteness,
  readReferenceData,
  readRounds,
} from '@portfolio-command/api';

import { jsonBody, withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const body = await jsonBody(request);

    /* Branched before the parsers rather than inside one of them: the link
       carries a different payload entirely -- no `values`, no round fields --
       and folding it into the capture parser would mean one function with two
       bodies and a set of fields that are required in one shape and forbidden
       in the other. The reading is deliberately loose, because a body that is
       not an object has no `op` to read and both parsers reject it identically.

       ADR-033 puts the link on THIS endpoint rather than on the financial one,
       and that placement is the permission decision made visible -- see the note
       on `LINK_OP`. */
    if (typeof body === 'object' && body !== null && (body as { op?: unknown }).op === LINK_OP) {
      // The role check lives in applyLinkTransactions so a second caller that
      // does not come through this route cannot skip it.
      const result = await applyLinkTransactions(db(), principal, parseLinkTransactions(body));
      return { ok: true, ...result };
    }

    const result = await applyRoundMutation(db(), principal, parseRoundMutation(body));
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
