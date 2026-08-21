/**
 * The deal-close capture write path (ADR-012, A8).
 *
 * ADR-012 specifies "a single deal-close form ... writing to `investment_round`,
 * `round_coinvestor` and `company_ownership`". THIS MODULE IS THAT SENTENCE MADE
 * LITERAL: one mutation, one database transaction, three tables. It is not three
 * endpoints the form calls in sequence, and the difference matters -- a round
 * total that lands without its co-investors, because the second call failed,
 * moves the leverage KPI while leaving the NB co-investment KPI behind, and
 * nothing on any screen would say so.
 *
 * VERSION CAPTURE IS NOT HERE. It is the trigger from migrations 0002 and 0003,
 * so a round total corrected by an UPDATE typed into psql at 9pm is recorded
 * identically to one corrected through this file. What lives here is what a
 * trigger cannot do: naming the actor, deciding whether a change restates a
 * published figure, and rejecting input before it reaches a constraint.
 *
 * WHO WRITES THIS IS NOT WHO WRITES `financial.ts`. See `CAN_CAPTURE_ROUND`.
 */
import { type Kysely, sql } from 'kysely';

import type { DB } from '@portfolio-command/db/generated';
import { CAN_CAPTURE_ROUND, type Principal, requireRole } from '../auth/principal.js';
import { DuplicateRoundError, ValidationError } from './errors.js';
import { asObject, oneOf, optionalText, requiredObject, rowId } from './parse.js';
import {
  changeKind,
  checkRestatement,
  date,
  optional,
  optionalMoney,
  setSessionContext,
  text,
  type ChangeKind,
} from './session.js';

/**
 * One co-investor in a round.
 *
 * `amount` IS OPTIONAL AND THAT IS THE POINT. ADR-015 is explicit that early
 * rounds carry co-investor names without amounts and that no process can now
 * recover them. Refusing a name without a figure would mean the platform holds
 * neither, which is strictly less than the deal lead knows.
 */
export interface CoinvestorInput {
  /** Present for a row already stored; absent means a new one. */
  id?: string | null;
  investorName: string;
  /** Set when this co-investor is one of our own LP positions (ADR-026 exact match). */
  fundInvestmentId?: string | null;
  isNbBased: boolean;
  /** DOLLARS, as typed. Null means the name is known and the figure is not. */
  amount?: string | null;
}

/**
 * The dated cap-table position after this round.
 *
 * Optional as a whole: a round can be captured before the cap table has been
 * restated, and the alternative -- demanding a number the deal lead does not yet
 * have -- gets a guess typed into a mandate field.
 */
export interface OwnershipInput {
  asOfDate: string;
  /** Percent as a plain number, matching the contract convention. "11.2" is 11.2%. */
  ownershipPct: string;
  proRataRights: boolean;
  fullyDiluted?: boolean;
  sourceDocument?: string | null;
}

export interface RoundCaptureInput {
  companyId: string;
  roundDate: string;
  /** Seed, Series A, and so on. Free text: the round is called what it is called. */
  label: string;
  instrumentId: number;
  /** ADR-030. Which vehicle our participation came from. Null = unrecorded, never a default. */
  investmentVehicleId?: number | null;

  /**
   * ADR-033. Did we put money into this round: `yes`, `no` or `unknown`.
   *
   * DEFAULTS TO `unknown` WHEN ABSENT, never to either answer -- which is why
   * this is optional on the input rather than required. A round captured from a
   * 2011 closing file by someone who does not know is a legitimate state, and
   * demanding an answer would get a guess typed into the column whose whole
   * purpose is to hold the difference between a guess and a fact.
   *
   * `no` is what makes a round with no cheque legitimate rather than a data
   * error, and it is what takes the round out of leverage. It cannot be set on a
   * round that has our cheque booked against it -- see `validateParticipation`.
   */
  nbifParticipated?: 'yes' | 'no' | 'unknown' | null;

  /** DOLLARS. The full round including every investor. DRIVES THE LEVERAGE KPI. */
  roundTotal?: string | null;
  /** DOLLARS. Capital from OTHER New Brunswick investors, excluding ours. DRIVES THE NB KPI. */
  nbOther?: string | null;
  /** DOLLARS. Null on a convertible, and legitimately so. */
  postMoney?: string | null;
  /** Percent as a plain number. */
  ownershipAfterPct?: string | null;
  leadInvestor?: string | null;
  note?: string | null;
  /** The SharePoint link to the closing documents (ADR-012 keeps them the source). */
  sourceDocument?: string | null;

  /** The COMPLETE set. See `writeCoinvestors` for what absence from it means. */
  coinvestors: CoinvestorInput[];
  ownership?: OwnershipInput | null;
}

export type RoundMutation = {
  reason?: string | null;
  /** ADR-038, FR-14. Why this changed, as distinct from what changed. */
  changeKind?: ChangeKind | null;
  /**
   * FR-08, ADR-038 clause 4. Acknowledges that this round shares a company and
   * a normalised label with one already recorded, and is a real second row
   * anyway — a second tranche, an extension, a bridge.
   *
   * REQUIRED ONLY WHEN THE WARNING FIRES, and refusing the plain save is the
   * whole mechanism: a check that can be ignored without noticing is not a
   * check. Never a hard block, on the codebase's own precedent — a round total
   * below our own cheque is accepted and flagged, because pushing somebody into
   * fudging a figure to get past a form is worse than the figure being wrong
   * and visible.
   */
  duplicateAckReason?: string | null;
} & (
  | { op: 'create'; values: RoundCaptureInput }
  | { op: 'update'; id: string; values: RoundCaptureInput }
  | { op: 'delete'; id: string }
  | { op: 'restore'; id: string }
);

export interface RoundWriteResult {
  id: string;
  /** True when the change moved a figure inside an already-issued period. */
  restated: boolean;
  /**
   * ADR-033. What the round now says about our participation, echoed back so
   * the form can report the default rather than leaving the user to discover
   * that leaving the field alone meant `unknown`.
   */
  nbifParticipated: 'yes' | 'no' | 'unknown';
  /** How the co-investor set was reconciled, so the UI can say what it did. */
  coinvestors: { created: number; updated: number; removed: number };
  ownershipWritten: boolean;
}

// --- validation -------------------------------------------------------------
// Written for the deal lead filling in a closing form, not for a developer
// reading a stack trace. The database enforces all of this regardless; what is
// bought here is a sentence that names the field and says what to do.

/** Percent as a plain number, 0 to 100. The contract convention (ADR-001). */
function percent(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,16})?$/.test(value)) {
    throw new ValidationError(
      `"${field}" must be a percentage as a plain number — 11.2 means 11.2%, not 0.112. Got ${JSON.stringify(value)}.`,
    );
  }
  if (Number(value) > 100) {
    throw new ValidationError(`"${field}" is ${value}%, which is more than the whole company.`);
  }
  return value;
}

const optionalPercent = (v: unknown, field: string): string | null =>
  v === null || v === undefined || v === '' ? null : percent(v, field);

const PARTICIPATION = ['yes', 'no', 'unknown'] as const;
type Participation = (typeof PARTICIPATION)[number];

/**
 * ADR-033 clause 1. Absent means `unknown`, and `unknown` is a real answer.
 *
 * The blank-to-null conversion the money and percent helpers do would be wrong
 * here: `null` is not a value this column can hold, and mapping an untouched
 * form field to the schema default is exactly what "defaults to unknown, not to
 * either answer" means in practice.
 */
function participation(value: unknown): Participation {
  if (value === null || value === undefined || value === '') return 'unknown';
  if (typeof value !== 'string' || !(PARTICIPATION as readonly string[]).includes(value)) {
    throw new ValidationError(
      `"nbifParticipated" must be one of ${PARTICIPATION.join(', ')} — leave it blank for unknown. Got ${JSON.stringify(value)}.`,
    );
  }
  return value as Participation;
}

/**
 * The other half of ADR-033's state table, enforced.
 *
 * The ADR names one illegal state -- a round we participated in with no
 * transaction -- and that one is a REPORTING gap rather than a constraint,
 * because the cheque legitimately arrives days later on Finance's clock and
 * blocking the deal lead until it does is the failure ADR-031 was written to
 * prevent. This is its mirror image, and it is not the same shape at all:
 * "we did not participate" said over a cheque that is already booked against
 * the round is not two records arriving out of order, it is two records
 * contradicting each other. One of them is wrong and the person on this form
 * is the one who can say which.
 *
 * Refused rather than flagged for the reason set out in `link-transactions.ts`:
 * this is not a figure anybody holds, so refusing costs nobody a fact.
 */
async function validateParticipation(
  trx: Kysely<DB>,
  roundId: string,
  value: Participation,
): Promise<void> {
  if (value !== 'no') return;

  const { rows } = await sql<{ n: string; total: string }>`
    select count(*)::text                        as n,
           coalesce(sum(t.amount_cad), 0)::text  as total
      from pc.v_transaction_live t
     where t.investment_round_id = ${roundId}::bigint
       and t.txn_type in ('investment','follow_on')
  `.execute(trx);

  const n = Number(rows[0]?.n ?? '0');
  if (n > 0) {
    throw new ValidationError(
      `This round has ${n} cheque${n > 1 ? 's' : ''} of ours booked against it, totalling ` +
        `$${Number(rows[0]!.total).toLocaleString('en-CA')}, so it cannot record that we did not participate. ` +
        'Either we did participate, or those cheques belong to a different round — ' +
        'move them on the Finance tab first, then set this.',
    );
  }
}

/**
 * The two `investment_round` check constraints, restated in the deal lead's
 * terms, plus the one cross-field rule that has no constraint behind it.
 *
 * WHAT IS DELIBERATELY NOT REJECTED: a round total below our own cheque. It is
 * arithmetically impossible and it is also a real state of the data -- the A6
 * dataset seeds one on Smart Skin Technologies precisely because ADR-012's rule
 * is that such a round is EXCLUDED from leverage, never imputed and never
 * refused. Rejecting it here would push the deal lead into either not recording
 * the round at all or adjusting a figure to get past the form, and both are
 * worse than a captured round the metric declines to use. The read path flags
 * it instead.
 */
function validateRound(v: RoundCaptureInput): void {
  const roundTotal = v.roundTotal ? Number(v.roundTotal) : null;
  const nbOther = v.nbOther ? Number(v.nbOther) : null;

  if (nbOther !== null && roundTotal !== null && nbOther > roundTotal) {
    throw new ValidationError(
      `NB co-investment of ${v.nbOther} is more than the whole round of ${v.roundTotal}. ` +
        'This field is capital from OTHER New Brunswick investors in the round, excluding our own cheque.',
    );
  }

  const names = v.coinvestors.map((c) => c.investorName.trim().toLowerCase()).filter(Boolean);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) {
    throw new ValidationError(
      `"${duplicate}" is listed twice as a co-investor in this round. ` +
        'Combine them into one line with the total amount, so capital-to-direct is not double-counted.',
    );
  }
}

// --- the request envelope ---------------------------------------------------

const OPS = ['create', 'update', 'delete', 'restore'] as const;

/**
 * Narrows an unknown request body to a `RoundMutation`.
 *
 * Shallow on purpose, matching the financial parser: this checks the envelope
 * and leaves every field rule to `applyRoundMutation`, which owns them and
 * raises the same error type. Two validators over the same fields is how the two
 * drift apart.
 *
 * THE LINK MUTATION IS NOT PARSED HERE, though it arrives on the same endpoint.
 * See `parseLinkTransactions` in `link-transactions.ts`: it carries a different
 * payload entirely — no `values`, no round fields — and folding it in would mean
 * one function with two bodies and a set of fields required in one shape and
 * forbidden in the other. The route branches on `op` before calling either.
 */
export function parseRoundMutation(body: unknown): RoundMutation {
  const b = asObject(body);

  /* The hint names the fifth verb this endpoint accepts. It is deliberately a
     sentence rather than a fifth entry in the list: `link-transactions` takes a
     different payload and sits behind a different gate, and listing it beside
     the four capture ops — as the route handler used to — invited a caller to
     send it with `values`. */
  const op = oneOf(b['op'], OPS, 'op', 'Attaching cheques to a round is "link-transactions".');
  const reason = optionalText(b, 'reason');
  // F6, FR-08 and FR-14. Both are envelope fields like `reason`: the shape is
  // checked here, the rules are `applyRoundMutation`'s.
  const envelope = {
    reason,
    changeKind: optionalText(b, 'changeKind'),
    duplicateAckReason: optionalText(b, 'duplicateAckReason'),
  };

  if (op === 'delete' || op === 'restore') {
    return { op, id: rowId(b['id'], 'round'), ...envelope } as RoundMutation;
  }

  const captured = requiredObject(b, 'values', 'the complete round');
  // Defaulted rather than demanded: a round genuinely can have no co-investors,
  // and a form that omits the key entirely should mean the same thing as one
  // that sends an empty list.
  if (captured['coinvestors'] === undefined) captured['coinvestors'] = [];
  if (!Array.isArray(captured['coinvestors'])) {
    throw new ValidationError('"values.coinvestors" must be a list, holding the complete set for this round.');
  }
  /* Widened deliberately: the envelope has confirmed an object with a list
     where the list goes, and every field rule below is `writeRound`'s. Naming
     `RoundCaptureInput` here would be this layer claiming a check it has not
     made. */
  const values: unknown = captured;

  if (op === 'update') {
    return { op, id: rowId(b['id'], 'round', true), values, ...envelope } as RoundMutation;
  }
  return { op, values, ...envelope } as RoundMutation;
}

// --- the entry point --------------------------------------------------------

/**
 * Applies one deal-close capture.
 *
 * Everything is one transaction so the round, its co-investors, the ownership
 * row and every version record the trigger writes land together or not at all.
 * The session context is set first because the trigger reads it.
 */
export async function applyRoundMutation(
  db: Kysely<DB>,
  principal: Principal,
  mutation: RoundMutation,
): Promise<RoundWriteResult> {
  requireRole(principal, CAN_CAPTURE_ROUND);

  const reason = mutation.reason?.trim() || null;
  const kind = changeKind(mutation.changeKind);

  return db.transaction().execute(async (trx) => {
    await setSessionContext(trx, principal, reason, kind);

    if (mutation.op === 'delete' || mutation.op === 'restore') {
      return softDelete(trx, principal, mutation.id, mutation.op, reason);
    }
    return writeRound(trx, principal, mutation, reason);
  });
}

/** The stored round date, and proof the round exists. */
async function existingRoundDate(trx: Kysely<DB>, id: string): Promise<string> {
  const { rows } = await sql<{ d: string }>`
    select round_date::text as d from pc.investment_round where investment_round_id = ${id}::bigint
  `.execute(trx);
  if (rows.length === 0) throw new ValidationError(`No round with id ${id}.`);
  return rows[0]!.d;
}

/**
 * Soft delete and its inverse (ADR-031 clause 6).
 *
 * The co-investor rows are deliberately left alone. `v_lp_capital_to_direct`
 * and `v_round_leverage` both join through the round and both now require it to
 * be live, so a deleted round's co-investors are already out of every total --
 * and leaving them attached means restoring the round restores what was in it,
 * rather than restoring an empty shell someone then has to retype.
 */
async function softDelete(
  trx: Kysely<DB>,
  principal: Principal,
  id: string,
  op: 'delete' | 'restore',
  reason: string | null,
): Promise<RoundWriteResult> {
  if (op === 'delete' && !reason) {
    throw new ValidationError('Deleting a round requires a reason.');
  }

  const when = await existingRoundDate(trx, id);
  const restated = await checkRestatement(trx, [when], reason, 'round');

  // A round still carrying transactions is a live position, not a mistyped row.
  // Checked before the write rather than after: the surrounding transaction
  // would roll back either way, but a reader should not have to know that to
  // see that the guard holds.
  if (op === 'delete') {
    const { rows: attached } = await sql<{ n: string }>`
      select count(*)::text as n from pc.v_transaction_live where investment_round_id = ${id}::bigint
    `.execute(trx);
    if (Number(attached[0]?.n ?? '0') > 0) {
      throw new ValidationError(
        `That round still has ${attached[0]!.n} transaction(s) booked against it. ` +
          'Deleting it would leave our own cheque pointing at nothing. ' +
          'Move or delete the transactions first, on the Finance tab.',
      );
    }
  }

  const { rows } = await sql<{ id: string }>`
    update pc.investment_round
       set deleted_at     = ${op === 'delete' ? sql`clock_timestamp()` : sql`null`},
           deleted_by     = ${op === 'delete' ? sql`${principal.userId}::uuid` : sql`null`},
           deleted_reason = ${op === 'delete' ? reason : null}
     where investment_round_id = ${id}::bigint
       and deleted_at is ${op === 'delete' ? sql`null` : sql`not null`}
    returning investment_round_id::text as id
  `.execute(trx);

  if (rows.length === 0) {
    throw new ValidationError(
      op === 'delete'
        ? 'That round is already deleted.'
        : 'That round is not deleted, so there is nothing to restore.',
    );
  }

  // The participation state is read back rather than assumed: a delete does
  // not change it, and echoing a guess would make the one field the caller did
  // not touch the one field it cannot trust.
  const { rows: p } = await sql<{ v: string }>`
    select nbif_participated as v from pc.investment_round where investment_round_id = ${id}::bigint
  `.execute(trx);

  return {
    id,
    restated,
    nbifParticipated: (p[0]?.v ?? 'unknown') as 'yes' | 'no' | 'unknown',
    coinvestors: { created: 0, updated: 0, removed: 0 },
    ownershipWritten: false,
  };
}

/**
 * FR-08. The round this one collides with, or null.
 *
 * NORMALISED LABEL ALONE, NO DATE WINDOW, and F6 measured before choosing.
 * 32 same-company same-label pairs existed in the demo data with the closest
 * two 256 days apart, which looked like an argument for a window -- until 29 of
 * the 32 turned out to be the A6 generator emitting a BRIDGE round under its
 * parent's label. Funke's description of the real thing is the fix: bridged
 * funding "shows up as a qualifier, like an adjective", so real data reads
 * "Series A bridge" and never collides. The generator was corrected and the
 * pairs went to zero.
 *
 * A window would have been a number nobody chose, compensating for a defect in
 * the demo data, and it would have quietly stopped catching the case FR-08
 * actually names: two "Series A" rows entered a year apart because somebody
 * forgot the first one.
 *
 * `pc.normalise_round_label` rather than a copy of it here, so the index, the
 * reconciliation view and this query cannot disagree about what "the same
 * label" means. Q-9 tightens all three at once by changing that function.
 */
async function findDuplicate(
  trx: Kysely<DB>,
  companyId: string,
  label: string,
  excludeId: string | null,
): Promise<{ id: string; label: string; round_date: string; company_name: string } | null> {
  const { rows } = await sql<{ id: string; label: string; round_date: string; company_name: string }>`
    select r.investment_round_id::text as id, r.label, r.round_date::text as round_date,
           c.name as company_name
      from pc.investment_round r
      join pc.company c on c.company_id = r.company_id
     where r.company_id = ${companyId}
       and r.deleted_at is null
       and pc.normalise_round_label(r.label) = pc.normalise_round_label(${label})
       and (${excludeId}::bigint is null or r.investment_round_id <> ${excludeId}::bigint)
     order by r.round_date, r.investment_round_id
     limit 1
  `.execute(trx);
  return rows[0] ?? null;
}

async function writeRound(
  trx: Kysely<DB>,
  principal: Principal,
  m: Extract<RoundMutation, { op: 'create' | 'update' }>,
  reason: string | null,
): Promise<RoundWriteResult> {
  const v = m.values;
  validateRound(v);

  const companyId = text(v.companyId, 'companyId');
  const roundDate = date(v.roundDate, 'roundDate');
  const label = text(v.label, 'label');
  if (!Number.isInteger(v.instrumentId)) {
    throw new ValidationError('"instrumentId" is required — every round has an instrument.');
  }

  const dates: (string | null)[] = [roundDate];
  if (m.op === 'update') dates.push(await existingRoundDate(trx, m.id));
  const restated = await checkRestatement(trx, dates, reason, 'round');

  const nbifParticipated = participation(v.nbifParticipated);

  /* FR-08, ADR-038 clause 4. Warn, do not block.
     Run before the write so the refusal names the round it collided with,
     rather than reporting a constraint the user has to work backwards from --
     and after `checkRestatement`, so a save that is going to be refused for a
     missing restatement reason says that first. */
  const duplicateOf = await findDuplicate(trx, companyId, label, m.op === 'update' ? m.id : null);
  const ackReason = m.duplicateAckReason?.trim() || null;
  if (duplicateOf && !ackReason) {
    throw new DuplicateRoundError(
      `${duplicateOf.company_name} already has a round called "${duplicateOf.label}" dated ` +
        `${duplicateOf.round_date}. That is often correct — a second tranche, an extension, a ` +
        'bridge under the same round — so this is a warning rather than a refusal. Say which it ' +
        'is and the save goes through.',
      { investmentRoundId: duplicateOf.id, label: duplicateOf.label, roundDate: duplicateOf.round_date },
    );
  }

  const cols = {
    company_id: companyId,
    round_date: roundDate,
    label,
    instrument_id: v.instrumentId,
    investment_vehicle_id: optional(v.investmentVehicleId),
    nbif_participated: nbifParticipated,
    round_total: optionalMoney(v.roundTotal, 'roundTotal'),
    nb_other: optionalMoney(v.nbOther, 'nbOther'),
    post_money: optionalMoney(v.postMoney, 'postMoney'),
    ownership_after_pct: optionalPercent(v.ownershipAfterPct, 'ownershipAfterPct'),
    lead_investor: optional(v.leadInvestor),
    note: optional(v.note),
    source_document: optional(v.sourceDocument),
    /* Stored on the row, per ADR-038 clause 4, so the acknowledgement outlives
       the session that gave it. Cleared when the collision goes away -- an
       acknowledgement of a duplicate that no longer exists is a claim about
       nothing, and it would keep the round looking deliberate after somebody
       deleted the row it was deliberate about. */
    duplicate_ack_at: duplicateOf && ackReason ? sql`clock_timestamp()` : null,
    duplicate_ack_by: duplicateOf && ackReason ? principal.userId : null,
    duplicate_ack_reason: duplicateOf && ackReason ? ackReason : null,
  };

  let roundId: string;
  if (m.op === 'create') {
    const row = await trx
      .insertInto('investment_round')
      // `captured_by` / `captured_at` record the ADR-012 capture event: a deal
      // lead went through this form for this round. See the update branch for
      // why they are not rewritten afterwards.
      .values({ ...cols, captured_by: principal.userId, captured_at: sql`clock_timestamp()` } as never)
      .returning('investment_round_id')
      .executeTakeFirstOrThrow();
    roundId = String(row.investment_round_id);
  } else {
    // Before the write, not after. A round that does not exist yet cannot have
    // cheques booked against it, so this check only ever has anything to say on
    // an update -- and saying it before anything is written means the error
    // names the contradiction rather than a constraint the user has to work
    // backwards from.
    await validateParticipation(trx, m.id, nbifParticipated);

    const row = await trx
      .updateTable('investment_round')
      .set(cols as never)
      .where('investment_round_id', '=', BigInt(m.id) as never)
      .returning('investment_round_id')
      .executeTakeFirst();
    if (!row) throw new ValidationError(`No round with id ${m.id}.`);
    roundId = String(row.investment_round_id);

    // Set only if it was never set. `captured_at` answers "has a deal lead been
    // through the capture form for this round", which is what
    // v_mandate_completeness counts and what a chasing list is built on. It is
    // NOT "when was this row last touched" -- the version log answers that, for
    // every edit, with the actor attached. Refreshing it here would make a
    // Finance typo correction indistinguishable from an original capture and
    // quietly destroy the only record of when the mandate data was first filed.
    await sql`
      update pc.investment_round
         set captured_by = ${principal.userId}::uuid, captured_at = clock_timestamp()
       where investment_round_id = ${roundId}::bigint and captured_at is null
    `.execute(trx);
  }

  const coinvestors = await writeCoinvestors(trx, roundId, v.coinvestors, m.op === 'create');
  const ownershipWritten = await writeOwnership(trx, principal, companyId, roundId, v.ownership);

  return { id: roundId, restated, nbifParticipated, coinvestors, ownershipWritten };
}

/**
 * Reconciles the round's co-investor set against what was submitted.
 *
 * THE SUBMITTED ARRAY IS THE COMPLETE SET, not a patch. The form draws every
 * co-investor and lets the user add and remove lines, so "absent" is a
 * deliberate removal rather than an omission -- the same reasoning that makes
 * `financial.ts` take a whole row on update rather than a patch.
 *
 * REMOVAL IS A SOFT DELETE, NEVER A `DELETE`. A hard delete would take the row
 * out of `round_coinvestor_asof()` reconstruction as cleanly as it takes it out
 * of the total, and an NB co-investment figure on an already-issued board pack
 * would stop reproducing. That is precisely the guarantee migration 0003 exists
 * to give this table.
 *
 * A previously removed co-investor re-appearing under the same name is
 * restored rather than duplicated, so a removal and an undo leave one row with
 * a legible history instead of two rows and a puzzle.
 */
async function writeCoinvestors(
  trx: Kysely<DB>,
  roundId: string,
  submitted: CoinvestorInput[],
  isNewRound: boolean,
): Promise<{ created: number; updated: number; removed: number }> {
  const existing = isNewRound
    ? []
    : (
        await sql<{ id: string; investor_name: string; deleted_at: string | null }>`
          select round_coinvestor_id::text as id, investor_name, deleted_at::text as deleted_at
            from pc.round_coinvestor where investment_round_id = ${roundId}::bigint
        `.execute(trx)
      ).rows;

  const byId = new Map(existing.map((r) => [r.id, r]));
  const byName = new Map(existing.map((r) => [r.investor_name.trim().toLowerCase(), r]));

  const keptIds = new Set<string>();
  let created = 0;
  let updated = 0;

  for (const c of submitted) {
    const investorName = text(c.investorName, 'investorName');
    const cols = {
      investor_name: investorName,
      // ADR-026: set only where the name matched an LP position exactly. The
      // resolution is the caller's, and a wrong link overstates a mandate KPI,
      // so nothing is inferred here.
      fund_investment_id: optional(c.fundInvestmentId),
      is_nb_based: c.isNbBased === true,
      amount: optionalMoney(c.amount, `amount for ${investorName}`),
    };

    const match = (c.id && byId.get(c.id)) || byName.get(investorName.trim().toLowerCase());

    if (match) {
      keptIds.add(match.id);
      await sql`
        update pc.round_coinvestor
           set investor_name      = ${cols.investor_name},
               fund_investment_id = ${cols.fund_investment_id},
               is_nb_based        = ${cols.is_nb_based},
               amount             = ${cols.amount},
               deleted_at         = null,
               deleted_by         = null,
               deleted_reason     = null
         where round_coinvestor_id = ${match.id}::bigint
      `.execute(trx);
      updated += 1;
    } else {
      await sql`
        insert into pc.round_coinvestor
          (investment_round_id, investor_name, fund_investment_id, is_nb_based, amount)
        values (${roundId}::bigint, ${cols.investor_name}, ${cols.fund_investment_id},
                ${cols.is_nb_based}, ${cols.amount})
      `.execute(trx);
      created += 1;
    }
  }

  let removed = 0;
  for (const row of existing) {
    if (keptIds.has(row.id) || row.deleted_at !== null) continue;
    await sql`
      update pc.round_coinvestor
         set deleted_at = clock_timestamp(),
             deleted_reason = 'Removed from the round on the deal-close form'
       where round_coinvestor_id = ${row.id}::bigint
    `.execute(trx);
    removed += 1;
  }

  return { created, updated, removed };
}

/**
 * The dated cap-table position, if one was supplied.
 *
 * Upserted on (company_id, as_of_date), which the schema makes unique. Two
 * captures at the same date are one restated fact, not two positions, and the
 * unique index would otherwise turn a corrected figure into a constraint error
 * the deal lead cannot act on.
 *
 * `deleted_at` IS EXPLICITLY CLEARED on the conflict path. The unique index
 * does not exclude soft-deleted rows, so without this a re-capture at a date
 * whose row had been deleted would silently write its values into a row that
 * stays invisible to every read.
 *
 * F3, ADR-035 clause 1: THE ROUND IS RECORDED AND THE REASON IS NOT. A position
 * captured here was caused by the round being captured with it, and
 * `investment_round_id` says so precisely; `change_reason` stays null because
 * prose beside the link would be a second, weaker copy of the same fact. The
 * standalone path in `ownership.ts` is the mirror image -- reason required,
 * round usually absent -- and between them every row can say what moved it.
 */
async function writeOwnership(
  trx: Kysely<DB>,
  principal: Principal,
  companyId: string,
  roundId: string,
  ownership: OwnershipInput | null | undefined,
): Promise<boolean> {
  if (!ownership) return false;

  const asOfDate = date(ownership.asOfDate, 'ownership.asOfDate');
  const ownershipPct = percent(ownership.ownershipPct, 'ownership.ownershipPct');

  await sql`
    insert into pc.company_ownership
      (company_id, as_of_date, ownership_pct, pro_rata_rights, fully_diluted,
       source_document, entered_by, investment_round_id)
    values (${companyId}, ${asOfDate}::date, ${ownershipPct}::numeric,
            ${ownership.proRataRights === true}, ${ownership.fullyDiluted !== false},
            ${optional(ownership.sourceDocument)}, ${principal.userId}::uuid,
            ${roundId}::bigint)
    on conflict (company_id, as_of_date) do update
       set ownership_pct       = excluded.ownership_pct,
           pro_rata_rights     = excluded.pro_rata_rights,
           fully_diluted       = excluded.fully_diluted,
           source_document     = excluded.source_document,
           investment_round_id = excluded.investment_round_id,
           deleted_at          = null,
           deleted_by          = null,
           deleted_reason      = null
  `.execute(trx);

  return true;
}
