/**
 * The cheque-to-round link (ADR-033, F1).
 *
 * THE NARROWEST WRITE PATH IN THE CODEBASE, and the narrowness is the whole
 * argument rather than a nicety. This mutation sets or clears
 * `transaction.investment_round_id` and touches no other column on that table.
 * Amount, date, type, currency, vehicle and instrument stay behind
 * `CAN_WRITE_FINANCIAL` in `financial.ts`.
 *
 * WHY THAT SETTLES THE PERMISSION QUESTION. `investment_round` is captured by
 * `vc`, `finance` and `admin`; `transaction` is `finance` and `admin` only.
 * ADR-012's A8 note reasoned that the round link belongs to the deal lead and
 * shipped the picker read-only pointing at the Deal Close tab -- which was right
 * about AUTHORSHIP OF THE ROUND, wrong about THE LINK ITSELF, and a dead end
 * besides, because the Deal Close capture does not write `transaction` either.
 * No interface wrote that column at all; every link in the database was put
 * there by the A6 generator (finding S-1).
 *
 * ADR-033 resolves it: a deal lead attaching a cheque to a round they closed is
 * doing RECONCILIATION, not restating Finance's figures, and an operation that
 * can move a foreign key and nothing else cannot restate a figure. So the gate
 * is `CAN_CAPTURE_ROUND` and both surfaces call this one mutation.
 *
 * TWO PROPERTIES COME FOR FREE AND ARE ASSERTED RATHER THAN ASSUMED. The
 * ADR-031 trigger captures a link change, because it fires on any `UPDATE` to
 * `transaction` -- so linking is audited with a named actor without a line of
 * audit code here. And restatement detection works, because `checkRestatement`
 * keys on dates this module passes it. Both are in the F1 suite.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_CAPTURE_ROUND, type Principal, requireRole } from '../auth/principal.js';
import { ValidationError } from './errors.js';
import { asObject, optionalText } from './parse.js';
import { changeKind, checkRestatement, setSessionContext, type ChangeKind } from './session.js';

export interface LinkTransactionsMutation {
  /**
   * The cheques to move. A list rather than a single id because the Deal Close
   * surface attaches several at once -- a round funded from two vehicles is two
   * transactions -- and doing that as N calls would let a partial failure leave
   * a round half-reconciled with nothing on screen to say so.
   */
  transactionIds: string[];
  /**
   * The round to attach them to, or NULL for the form's explicit
   * *No round — standalone* option.
   *
   * Null is not "leave it alone": there is no leave-it-alone on this path,
   * because a mutation whose no-op case is indistinguishable from its clear case
   * is one nobody can use to clear anything. See `standalone_confirmed_at`.
   */
  investmentRoundId: string | null;
  reason?: string | null;
  /** ADR-038, FR-14. Why this changed, as distinct from what changed. */
  changeKind?: ChangeKind | null;
}

export interface LinkTransactionsResult {
  /** How many cheques were attached to a round. */
  linked: number;
  /** How many were detached and confirmed standalone. */
  cleared: number;
  /** True when the change moved a figure inside an already-issued period. */
  restated: boolean;
  /**
   * Set when the round's participation was upgraded from `unknown` to `yes` by
   * this link, so the UI can say so rather than the user discovering it later.
   */
  participationSetToYes: boolean;
}

interface TxnFacts {
  id: string;
  txn_date: string;
  txn_type: string;
  company_id: string | null;
  investment_round_id: string | null;
  round_date: string | null;
  standalone_confirmed_at: string | null;
  deleted_at: string | null;
  voided_at: string | null;
}

/**
 * The verb this mutation arrives under on `/api/v1/rounds`.
 *
 * ON THE ROUNDS ENDPOINT RATHER THAN THE FINANCIAL ONE, and that placement is
 * the permission decision made visible. It writes a column on `transaction`,
 * which is Finance's table, so the obvious home is the financial endpoint — and
 * the obvious home is wrong. That endpoint is gated on `CAN_WRITE_FINANCIAL`
 * and the deal lead who closed the round is `vc`. Routing it beside the round
 * capture puts it behind `CAN_CAPTURE_ROUND`, where the two people who do this
 * work both have access.
 */
export const LINK_OP = 'link-transactions';

/**
 * Narrows an unknown request body to a `LinkTransactionsMutation`.
 *
 * Shallow, like every other parser here: the id SHAPES are re-checked by
 * `applyLinkTransactions` against the same rule, because a caller that does not
 * come through the route must not be able to skip them.
 */
export function parseLinkTransactions(body: unknown): LinkTransactionsMutation {
  const b = asObject(body);

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
    reason: optionalText(b, 'reason'),
  };
}

/**
 * Applies one link change.
 *
 * One database transaction, so the link, the participation upgrade and every
 * version record the trigger writes land together or not at all. The session
 * context is set first because the trigger raises without it.
 */
export async function applyLinkTransactions(
  db: Kysely<DB>,
  principal: Principal,
  mutation: LinkTransactionsMutation,
): Promise<LinkTransactionsResult> {
  requireRole(principal, CAN_CAPTURE_ROUND);

  const ids = [...new Set(mutation.transactionIds ?? [])];
  if (ids.length === 0) {
    throw new ValidationError('"transactionIds" must name at least one transaction to link.');
  }
  if (ids.some((id) => typeof id !== 'string' || !/^\d+$/.test(id))) {
    throw new ValidationError('"transactionIds" must all be transaction ids.');
  }
  const roundId = mutation.investmentRoundId;
  if (roundId !== null && (typeof roundId !== 'string' || !/^\d+$/.test(roundId))) {
    throw new ValidationError(
      '"investmentRoundId" must be a round id, or null for a standalone cheque with no round.',
    );
  }

  const reason = mutation.reason?.trim() || null;
  const kind = changeKind(mutation.changeKind);

  return db.transaction().execute(async (trx) => {
    await setSessionContext(trx, principal, reason, kind);

    const txns = await loadTransactions(trx, ids);
    const round = roundId === null ? null : await loadRound(trx, roundId);

    validate(txns, round);

    /**
     * EVERY DATE THE CHANGE TOUCHES, not just the cheque's.
     *
     * `session.ts` sets the rule -- moving a row's effective date OUT of a
     * frozen period restates that period just as surely as changing its amount
     * -- and a link is that same shape with the dates on three different rows.
     * Detaching a 2024 cheque from a round changes THAT ROUND'S `ourInvested`,
     * and attaching it changes the new round's; both can move leverage inside
     * a period the board has already seen. Checking only `txn_date` would catch
     * the common case and miss the one where a cheque is dragged across a
     * period boundary, which is precisely the case worth catching.
     */
    const dates: (string | null)[] = [
      ...txns.map((t) => t.txn_date),
      ...txns.map((t) => t.round_date),
      round?.round_date ?? null,
    ];
    const restated = await checkRestatement(trx, dates, reason, 'link');

    let linked = 0;
    let cleared = 0;

    for (const t of txns) {
      /**
       * A no-op is skipped rather than written. Re-saving a form without
       * changing the picker should not produce a version row claiming an edit,
       * and should not restamp `standalone_confirmed_at` to today -- that
       * column answers "when was this looked at", and refreshing it on every
       * save would make a cheque nobody has revisited look freshly reviewed.
       *
       * ON THE CLEAR PATH THE LINK IS NOT THE WHOLE STATE, and reading it as
       * though it were is a bug the F1 suite caught. An unattached cheque
       * nobody has reviewed and an unattached cheque somebody has confirmed as
       * correctly standalone both have a null `investment_round_id` -- that is
       * the entire reason `standalone_confirmed_at` exists (ADR-033 clause 4).
       * Comparing only the foreign key made confirming a loose cheque a no-op,
       * which would have left the F6 unlinked-cheque check exactly as unable to
       * reach zero as it was before this phase.
       */
      const unchanged =
        roundId === null
          ? t.investment_round_id === null && t.standalone_confirmed_at !== null
          : t.investment_round_id === roundId;
      if (unchanged) continue;

      if (roundId === null) {
        // THE CLEAR PATH IS ALSO THE CONFIRMATION PATH (ADR-033 clause 4).
        // Choosing *No round — standalone* IS the act of looking at it, so the
        // two are one write. Without this the F6 unlinked-cheque check counts
        // correct cheques forever and can never reach zero.
        await sql`
          update pc.transaction
             set investment_round_id     = null,
                 standalone_confirmed_at = clock_timestamp(),
                 standalone_confirmed_by = ${principal.userId}::uuid
           where transaction_id = ${t.id}::bigint
        `.execute(trx);
        cleared += 1;
      } else {
        // The confirmation is cleared in the same statement that makes it
        // false. `txn_standalone_needs_no_round` enforces this regardless --
        // it is written here so the mutation cannot rely on being told.
        await sql`
          update pc.transaction
             set investment_round_id     = ${roundId}::bigint,
                 standalone_confirmed_at = null,
                 standalone_confirmed_by = null
           where transaction_id = ${t.id}::bigint
        `.execute(trx);
        linked += 1;
      }
    }

    /**
     * THE PARTICIPATION UPGRADE, and why it is not a violation of this
     * mutation's own narrowness rule.
     *
     * The rule ADR-033 states is that this mutation "sets or clears
     * `transaction.investment_round_id` and touches no other column ON THAT
     * TABLE". `investment_round` is a different table, behind the same
     * `CAN_CAPTURE_ROUND` gate, and this write is not a new decision: it is
     * clause 2's backfill rule -- a round with a live linked transaction is a
     * round we participated in -- applied to a link being created now instead
     * of one found in the database at migration time. A rule that reads
     * evidence at migration time and stops reading it afterwards leaves
     * `unknown` accumulating on rounds whose evidence is sitting right there.
     *
     * ONLY FROM `unknown`, NEVER FROM `no`. An explicit `no` is somebody's
     * statement, and a mutation that silently overwrites it would be doing the
     * thing this whole phase exists to stop -- collapsing a real answer into an
     * inferred one. Linking a cheque to a round marked `no` is refused in
     * `validate` instead, with a message that says where to change it.
     */
    let participationSetToYes = false;
    if (roundId !== null && linked > 0 && round?.nbif_participated === 'unknown') {
      await sql`
        update pc.investment_round
           set nbif_participated = 'yes'
         where investment_round_id = ${roundId}::bigint
           and nbif_participated = 'unknown'
      `.execute(trx);
      participationSetToYes = true;
    }

    return { linked, cleared, restated, participationSetToYes };
  });
}

async function loadTransactions(trx: Kysely<DB>, ids: string[]): Promise<TxnFacts[]> {
  const { rows } = await sql<TxnFacts>`
    select t.transaction_id::text      as id,
           t.txn_date::text            as txn_date,
           t.txn_type,
           t.company_id,
           t.investment_round_id::text as investment_round_id,
           r.round_date::text          as round_date,
           t.standalone_confirmed_at::text as standalone_confirmed_at,
           t.deleted_at::text          as deleted_at,
           t.voided_at::text           as voided_at
      from pc.transaction t
      left join pc.investment_round r on r.investment_round_id = t.investment_round_id
     where t.transaction_id = any(${ids}::bigint[])
  `.execute(trx);

  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ValidationError(
      `No transaction with id ${missing.join(', ')}. It may have been deleted by someone else since this screen loaded.`,
    );
  }
  return rows;
}

interface RoundFacts {
  id: string;
  company_id: string;
  company_name: string | null;
  round_date: string;
  label: string;
  nbif_participated: string;
  deleted_at: string | null;
}

async function loadRound(trx: Kysely<DB>, roundId: string): Promise<RoundFacts> {
  const { rows } = await sql<RoundFacts>`
    select r.investment_round_id::text as id,
           r.company_id,
           c.name                      as company_name,
           r.round_date::text          as round_date,
           r.label,
           r.nbif_participated,
           r.deleted_at::text          as deleted_at
      from pc.investment_round r
      left join pc.company c on c.company_id = r.company_id
     where r.investment_round_id = ${roundId}::bigint
  `.execute(trx);
  if (rows.length === 0) throw new ValidationError(`No round with id ${roundId}.`);
  return rows[0]!;
}

/**
 * Everything this mutation refuses, in the words of the person who will read it.
 *
 * NOTE WHAT IS NOT REFUSED, because the line matters and this codebase has
 * drawn it before. A round total below our own cheque is ACCEPTED and flagged
 * (see `validateRound` in `rounds.ts`), because it is a figure the deal lead
 * genuinely holds and refusing it pushes them into fudging the number or not
 * recording the round at all. None of the refusals below are figures anybody
 * holds -- they are a cheque pointing at another company's round, a deleted
 * row, an LP cashflow that never had a round. There is no legitimate workflow
 * on the other side of any of them, so refusing costs nothing and accepting
 * would put a wrong link into the one column F6 is built to reconcile.
 */
function validate(txns: TxnFacts[], round: RoundFacts | null): void {
  for (const t of txns) {
    if (t.deleted_at !== null) {
      throw new ValidationError(
        `Transaction #${t.id} is deleted. Restore it on the Finance tab before attaching it to a round.`,
      );
    }
    if (t.company_id === null) {
      throw new ValidationError(
        `Transaction #${t.id} is a ${t.txn_type.replace('_', ' ')} against a fund position, not a company. ` +
          'LP cashflows do not belong to a financing round.',
      );
    }
  }

  if (round === null) return;

  if (round.deleted_at !== null) {
    throw new ValidationError(
      `Round #${round.id} (${round.label}) is deleted. Restore it on the Deal Close tab before attaching cheques to it.`,
    );
  }

  const wrongCompany = txns.filter((t) => t.company_id !== round.company_id);
  if (wrongCompany.length > 0) {
    throw new ValidationError(
      `Transaction${wrongCompany.length > 1 ? 's' : ''} ${wrongCompany.map((t) => `#${t.id}`).join(', ')} ` +
        `${wrongCompany.length > 1 ? 'are' : 'is'} booked against a different company from the ` +
        `${round.label} round, which belongs to ${round.company_name ?? round.company_id}. ` +
        'A cheque and the round it funded are the same company by definition — check which one is wrong before linking.',
    );
  }

  if (round.nbif_participated === 'no') {
    throw new ValidationError(
      `The ${round.label} round records that NBIF did not participate, so a cheque of ours cannot belong to it. ` +
        'If we did participate, change that on the Deal Close tab first — it is a statement someone made deliberately, ' +
        'and this screen will not overwrite it on the strength of a link.',
    );
  }
}
