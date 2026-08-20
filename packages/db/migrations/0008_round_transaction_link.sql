-- =====================================================================
-- 0008 · F1 — The round/transaction link, and explicit participation
--
-- Closes findings S-1 and S-2 in docs/finance-current-state.md and lands
-- ADR-033. Three changes to the schema and one to a view:
--
--   1. investment_round.nbif_participated — three-state, defaulting to
--      unknown, backfilled to yes FROM EVIDENCE ONLY.
--   2. transaction.standalone_confirmed_at / _by — the other half of the
--      same idea: a null round link somebody has actually looked at.
--   3. v_round_leverage excludes rounds we sat out.
--
-- S-2 IS THE FINDING THIS MIGRATION EXISTS FOR. A round with nothing
-- pointing at it is four states collapsed into one -- we did not
-- participate, the cheque is not booked yet, the cheque is booked and
-- nobody linked it, or somebody mistyped -- and `ourInvested` reads $0
-- for all four. The first is legal and the last is an error, and the
-- database cannot currently tell them apart. Everything below is about
-- making those four states four.
--
-- NO NUMBER MOVES TODAY. Every round in the database carries a cheque
-- and backfills to `yes`, so the leverage predicate added at the bottom
-- excludes nothing. THAT IS WHY IT GOES IN NOW: the guard is installed
-- before the data that would trip it exists, which is the only moment
-- installing it is free. See ADR-033 clause 3, and the F1 tests, which
-- assert the exclusion against a round constructed for the purpose
-- rather than trusting a predicate nothing exercises.
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. DID WE PARTICIPATE IN THIS ROUND (ADR-033 clauses 1 and 2)
--
-- The finance requirements meeting reached two conclusions that cannot
-- both hold: a round cannot exist without one of our transactions, AND
-- rounds we did not participate in still have to be recorded because
-- they move ownership and FMV. A round we did not participate in IS a
-- round with no transaction.
--
-- ADR-033 resolves it with a definition rather than an arbitration: THE
-- ROUND IS AN EVENT IN THE COMPANY'S LIFE, NOT IN OURS. A Series B
-- happens whether or not we write a cheque. Once that is the definition,
-- a round with no transaction is legitimate when we sat it out and an
-- error when we did not -- and this column is what carries the
-- difference.
--
-- THREE STATES, NOT A BOOLEAN, and the default is neither answer. A
-- round backfilled from a 2011 closing file genuinely may not know, and
-- `unknown` is not a synonym for `no`. This is the convention the
-- codebase has already reached twice: a null round_total means "not
-- captured" and is EXCLUDED from leverage rather than imputed (ADR-012),
-- and a null co-investor amount means "the name is known and the figure
-- is not" (ADR-015). Absence must be distinguishable from a real value,
-- never conflated with one.
--
-- A CHECK CONSTRAINT RATHER THAN A ref_ TABLE, per the 0001 schema rule:
-- extensible lists live in tables so a new sector does not need a
-- migration, and small fixed sets use CHECK. This set is closed by
-- definition -- there is no fourth answer to "did we put money in" -- so
-- a reference table would offer an extension point that must never be
-- used. Contrast ref_fmv_retention_option, which F2 adds as a table
-- precisely because Finance is meant to be able to change that list.
--
-- ADDED WITH A CONSTANT DEFAULT, which Postgres records in the catalogue
-- without rewriting the table and without firing a row trigger. Only the
-- evidence backfill below touches rows.
-- ---------------------------------------------------------------------

alter table pc.investment_round
  add column nbif_participated text not null default 'unknown',
  add constraint round_participation_known check (
    nbif_participated in ('yes', 'no', 'unknown'));

comment on column pc.investment_round.nbif_participated is
  'ADR-033. Did NBIF put money into this round: yes / no / unknown, defaulting to unknown because a backfilled round genuinely may not know and unknown is not a synonym for no. `no` is EXCLUDED from v_round_leverage and from the ADR-001 export''s rounds array -- a round we sat out contributes a round total with no matching cost and would inflate the ratio. `unknown` is included, on the same reasoning that a null round total is excluded rather than imputed: the two absences are different and neither is guessed at.';

-- THE BACKFILL, AND THE ONLY THING IT IS ALLOWED TO READ.
--
-- A live linked transaction, and nothing else. Not "the round has a
-- round_total", not "the company has invested capital", not "it looks
-- like the sort of round we would have joined". ADR-033 clause 2 is one
-- sentence -- the backfill reads evidence, never an assumption -- and
-- the reason it is one sentence is that every softer rule writes a
-- confident `yes` over a round nobody has checked, which is exactly the
-- collapse S-2 describes, re-created in a column added to fix it.
--
-- Everything without that evidence stays `unknown`. On the A6 dataset
-- that is nearly nothing, because the generator gives every round a
-- cheque. On A13's fifteen years of history it will not be, and
-- `unknown` becoming a visible, countable completeness gap is the point
-- rather than a defect -- the same way mandate coverage already is.
--
-- v_transaction_live, NOT pc.transaction: a voided cheque, a reversing
-- row or a soft-deleted one is not evidence that we participated. It is
-- the same predicate v_round_leverage and the export adapter use for
-- `ourInvested`, which is what keeps "this round says we participated"
-- and "this round shows a cheque" from disagreeing on day one.
--
-- WHY THE VERSION TRIGGER IS OFF FOR THIS STATEMENT. Exactly the F0
-- precedent (migration 0006 section 2), for exactly the F0 reason, and
-- it is worth restating rather than cross-referencing because it is the
-- only judgement call here.
--
-- `zz_version_investment_round` fires on every UPDATE and sets
-- `new.row_updated_at := now_ts` unconditionally. The Deal Close screen
-- reads `row_updated_at > row_created_at` as "this round has been edited
-- since it was captured" and draws a pill. Left on, this statement would
-- make every round in the database claim, permanently and on screen, to
-- have been edited by someone. Nobody edited them.
--
-- THE ADR-031 GUARANTEE IS NOT WEAKENED. That guarantee is that no
-- financial fact changes without an attributed, reconstructable version
-- record. This statement changes no fact: it initialises a column added
-- in the same migration, by a rule stated in the same migration, from
-- rows the round already points at. A reader with the schema and no
-- version log can reproduce every value it writes. Nothing here is
-- recoverable only from history, because nothing here was ever anything
-- else.
--
-- The trigger is re-enabled below, inside this migration's own
-- transaction, so a failure anywhere leaves it on.

alter table pc.investment_round disable trigger zz_version_investment_round;

update pc.investment_round r
   set nbif_participated = 'yes'
 where r.nbif_participated = 'unknown'
   and exists (select 1
                 from pc.v_transaction_live t
                where t.investment_round_id = r.investment_round_id
                  and t.txn_type in ('investment', 'follow_on'));

alter table pc.investment_round enable trigger zz_version_investment_round;

-- The reportable completeness gap, named so a screen can count it
-- without restating the predicate. Rounds, not percentages: the
-- denominator is a judgement (see v_kpi_coverage's comment for the same
-- reasoning) and F6 is the phase that decides what to divide by.
create index on pc.investment_round (nbif_participated);

-- ---------------------------------------------------------------------
-- 2. A NULL ROUND LINK SOMEBODY HAS LOOKED AT (ADR-033 clause 4)
--
-- The mirror of section 1, on the other table. `investment_round_id is
-- null` is also two states wearing one face: a bridge note or a
-- secondary purchase that correctly has no round, and a cheque nobody
-- has got to yet.
--
-- WITHOUT THIS COLUMN THE F6 UNLINKED-CHEQUE CHECK CAN NEVER REACH ZERO.
-- That is the whole argument. A reconciliation surface that reports "31
-- unlinked cheques" forever, because 31 of them are correct, is a
-- surface people stop reading -- and the ones that stop being read are
-- the ones that were built to be read every month.
--
-- NOT A BOOLEAN, for the reason every other confirmation in this schema
-- is not one: `captured_at` / `captured_by` on the round, `prepared_by`
-- on the mark, `deleted_at` / `deleted_by` everywhere. A confirmation
-- with no name and no clock against it cannot be chased, cannot be
-- audited, and cannot be told from a default.
--
-- THREE CONSTRAINTS, ALL OF THEM ABOUT KEEPING THE STATEMENT TRUE:
--
--   * Both columns or neither. A timestamp with nobody behind it is the
--     thing this column was added to stop being possible.
--   * Only when there is no round link. The sentence is "this cheque
--     correctly has no round". A row asserting that while pointing at
--     one is not a judgement call anyone should get to make -- and the
--     link mutation therefore CLEARS the confirmation when it attaches a
--     round, which is enforced here rather than remembered there.
--   * Only on a direct cheque. An LP capital call, distribution or fee
--     never had a round to be standalone from. Written against
--     `company_id` rather than against the four direct txn_types,
--     matching how `txn_instrument_direct_only` was written at F0:
--     `txn_direct_types` already ties those two together and a second
--     copy of the type list is a second thing to keep in step.
-- ---------------------------------------------------------------------

alter table pc.transaction
  add column standalone_confirmed_at timestamptz,
  add column standalone_confirmed_by uuid references pc.app_user,
  add constraint txn_standalone_both_or_neither check (
    (standalone_confirmed_at is null) = (standalone_confirmed_by is null)),
  add constraint txn_standalone_needs_no_round check (
    standalone_confirmed_at is null or investment_round_id is null),
  add constraint txn_standalone_direct_only check (
    standalone_confirmed_at is null or company_id is not null);

comment on column pc.transaction.standalone_confirmed_at is
  'ADR-033. Set when someone has confirmed that this cheque correctly belongs to no round -- a bridge note, a standalone convertible, a secondary purchase. Distinguishes that from a cheque nobody has reviewed, which is the distinction the F6 unlinked-cheque check needs in order to ever reach zero. Cleared automatically when a round is attached: the two statements cannot both be true.';

-- `v_transaction_live` IS DELIBERATELY NOT WIDENED, on the standing rule
-- 0002 set when it rewrote that view with an explicit column list: a
-- later migration adding a column must not silently widen a view the
-- ADR-001 export reads from. Nothing aggregates on either column; the
-- Finance read path and the link mutation both select from
-- `pc.transaction` directly.

-- ---------------------------------------------------------------------
-- 3. LEVERAGE BELIEVES THE ROUND (ADR-033 clause 3)
--
-- Leverage measures capital attracted ALONGSIDE OUR OWN MONEY. A round
-- we sat out contributes its whole total to the numerator with nothing
-- in the denominator to match it, and the ratio goes up because we did
-- less. That is not a rounding concern; it is the metric reporting the
-- opposite of what happened.
--
-- ADR-012's existing rule is extended rather than altered. That rule is
-- that a round with a missing or invalid total is EXCLUDED, NEVER
-- IMPUTED -- the exclusion below is the same rule reaching a round whose
-- cost side is absent for a different reason.
--
-- `<> 'no'` AND NOT `= 'yes'`, which is the whole reason the column has
-- three states. `unknown` stays IN the ratio. Dropping it would mean a
-- historical round nobody has classified silently leaves the leverage
-- figure, and coverage would improve every time someone failed to
-- answer a question. Only an explicit statement that we sat this one out
-- takes a round out of the metric.
--
-- Restated in full because Postgres cannot amend one predicate of an
-- existing view. Nothing else changes; the column list is identical to
-- 0003's.
-- ---------------------------------------------------------------------

create or replace view pc.v_round_leverage as
select r.investment_round_id,
       r.company_id,
       r.round_date,
       ours.our_invested,
       r.round_total,
       r.nb_other,
       (r.round_total - ours.our_invested)                              as capital_attracted,
       least(coalesce(r.nb_other,0), r.round_total - ours.our_invested)  as nb_capital,
       greatest(r.round_total - ours.our_invested
                - least(coalesce(r.nb_other,0), r.round_total - ours.our_invested), 0)
                                                                        as outside_capital
from pc.investment_round r
join lateral (
    select coalesce(sum(t.amount_cad),0) as our_invested
      from pc.v_transaction_live t
     where t.investment_round_id = r.investment_round_id
       and t.txn_type in ('investment','follow_on')) ours on true
where r.deleted_at is null
  and r.nbif_participated <> 'no'
  and r.round_total is not null
  and r.round_total >= ours.our_invested;

comment on view pc.v_round_leverage is
  'ADR-012 and ADR-033. Rounds the leverage figure can see: live, participated in or unclassified, with a captured total that is at least our own cheque. CONVENIENCE ONLY (ADR-021) -- the published leverage KPI is computed in packages/metrics from the ADR-001 export, and the export applies the participation predicate itself in read/export.ts. Both are asserted in the F1 suite; a change to one without the other is the failure that suite exists to catch.';
