-- =====================================================================
-- 0012 · F5 — The LP three-stage model, in NBIF's own words
--
-- Closes S-7 and FR-32, FR-33, FR-34. Lands ADR-037. Six changes:
--
--   1. The terminology rename, of the STORED VALUE and not just the
--      label: capital_call -> capital_drawdown, distribution ->
--      capital_distribution. Confirmed with Funke (Q-23).
--   2. fund_commitment — the commitment AS AT a date, an absolute
--      rather than a delta.
--   3. fund_committed_asof(), the reader.
--   4. Backfill: one row per position, reconciled to the workbook's
--      $8,725,000 control total inside this transaction, and only then
--      versioned like every other financial row.
--   5. v_lp_position_current derives `committed` and flags a position
--      drawn beyond the commitment in force.
--   6. fund_investment.committed is dropped.
--
-- NO NUMBER MOVES, and unlike F4 that is a claim this migration
-- enforces rather than asserts. Section 4 raises and aborts if the
-- backfilled commitments do not sum to the cent to what the column
-- held, and section 6 cannot be reached until they do. The ADR-001
-- contract is untouched: `FundInvestment.committed` is still a $M
-- scalar, the API derives it instead of reading a column, and
-- packages/metrics/lp.ts never learns the difference (ADR-037 clause 3).
--
-- WHY THE RENAME IS HERE AND NOT LATER. Funke's point stands on its
-- own: from the fund manager's side a capital call is a demand for
-- funds; from ours the same event is a drawdown against a prior
-- commitment. Renaming the stored value touches two CHECK constraints,
-- one view, 282 synthetic rows and the version store. Doing it after
-- A13 means doing it against fifteen years of real history instead.
-- The afternoon is now.
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. THE TERMINOLOGY (FR-33, ADR-037 clause 4, Q-23)
--
-- `capital_call`  -> `capital_drawdown`
-- `distribution`  -> `capital_distribution`
-- `fee`           unchanged. A management fee is a fee.
--
-- THE THIRD RENAME IS A BONUS RATHER THAN THE POINT, and it is worth
-- naming: finding S-6 records that `fund_distribution` -- the fund's
-- own realizations to its shareholder -- collides with LP
-- `distribution`, which is money coming back to us from a GP. They are
-- opposite directions of travel under one word. `capital_distribution`
-- separates them at the point where somebody reads a query.
--
-- BOTH VALUES ARE LP-ONLY, which is what makes this safe to do as a
-- blanket UPDATE. `txn_direct_types` confines a company's transaction
-- to investment / follow_on / realization / write_off, and
-- `txn_lp_types` confines a fund position's to these three. No direct
-- cheque has ever carried either string, so no company figure -- MOIC,
-- invested, realized, FMV, leverage -- can be reached from here.
--
-- WHY THE VERSION TRIGGER IS OFF FOR THE STATEMENT, which is the same
-- judgement 0006 and 0008 made and for the same second reason. The
-- trigger sets `new.row_updated_at := now_ts` unconditionally, and the
-- Finance screen reads `row_updated_at > row_created_at` as "somebody
-- edited this" and draws a pill. 282 LP cashflows would claim,
-- permanently and on screen, to have been edited. Nobody edited them.
--
-- AND THE ADR-031 GUARANTEE IS NOT WEAKENED. That guarantee is about
-- financial FACTS: no amount, date, subject or classification changes
-- without an attributed, reconstructable version record. This changes
-- none of those. The event is the same event, on the same date, for the
-- same dollars, against the same position, in the same direction. What
-- changes is how the platform spells it -- and section 1c is what makes
-- "the history still reconstructs" literally true rather than nearly.
-- ---------------------------------------------------------------------

alter table pc.transaction drop constraint transaction_txn_type_check;
alter table pc.transaction drop constraint txn_lp_types;

alter table pc.transaction disable trigger zz_version_transaction;

update pc.transaction
   set txn_type = case txn_type
                    when 'capital_call' then 'capital_drawdown'
                    when 'distribution' then 'capital_distribution'
                  end
 where txn_type in ('capital_call', 'distribution');

alter table pc.transaction enable trigger zz_version_transaction;

alter table pc.transaction
  add constraint transaction_txn_type_check check (txn_type in
    ('investment','follow_on','realization','write_off',
     'capital_drawdown','capital_distribution','fee'));

alter table pc.transaction
  add constraint txn_lp_types check (
    fund_investment_id is null or txn_type in
      ('capital_drawdown','capital_distribution','fee'));

comment on column pc.transaction.amount is
  'Always positive. Direction is implied by txn_type. Capital drawdowns are outflows, capital distributions are inflows.';
comment on column pc.transaction.txn_type is
  'FR-33, ADR-037 clause 4. LP activity is `capital_drawdown` / `capital_distribution` / `fee` -- NBIF''s words, confirmed with Funke at Q-23. From the GP''s side a drawdown is a capital call; from ours it is a draw against a commitment we already made, and the platform speaks from our side. Direct activity is investment / follow_on / realization / write_off and has never used either LP string.';

-- 1c. THE VERSION STORE IS REWRITTEN TOO, and this is not tidiness.
--
-- `transaction_asof(t)` reconstructs the table from `row_image` via
-- jsonb_populate_record. An image still spelling `capital_call` would
-- reconstruct a row whose type is no longer in the vocabulary, so a
-- reproduced board pack would silently drop every LP cashflow from any
-- query filtering on the new name. That is exactly the reproducibility
-- guarantee ADR-031 exists to provide, failing quietly.
--
-- The images are a machine-read reconstruction source, not a
-- transcript, so correcting the spelling in them corrects the
-- reconstruction rather than rewriting history. `audit_log` is left
-- alone for the opposite reason: it IS a transcript, read by people,
-- and it should keep saying what was actually submitted at the time.
--
-- Zero rows in this database today -- no LP cashflow has ever been
-- edited through the Finance screens. Written for the database that has
-- them, because after A13 one will.

update pc.financial_row_version
   set row_image = jsonb_set(row_image, '{txn_type}',
                     to_jsonb(case row_image ->> 'txn_type'
                                when 'capital_call' then 'capital_drawdown'
                                else 'capital_distribution'
                              end))
 where table_name = 'transaction'
   and row_image ->> 'txn_type' in ('capital_call', 'distribution');

-- ---------------------------------------------------------------------
-- 2. THE COMMITMENT BECOMES AN EVENT (S-7, FR-32, ADR-037 clause 1)
--
-- The word that settles the design is ADJUSTABLE. Q-16 confirmed the
-- three-stage model and confirmed that a commitment is not a number
-- fixed once at subscription -- it is a level that can be raised at a
-- second close, by a side letter, or by an amended LPA. A level that
-- changes over time, and that the board may be shown at a past date, is
-- not a column. S-7 is the finding that says so: no date, no document,
-- no way to record an increase as a fact.
--
-- AN ABSOLUTE AS AT A DATE, NOT A DELTA, and it is the same reasoning
-- F2 wrote down for the valuation ledger. An absolute is one indexed
-- lookup; a delta chain has to be replayed from the position's
-- inception on every read, and one corrected early row silently shifts
-- every figure after it. An increase from $500k to $750k is a new row
-- saying $750,000 -- not a row saying $250,000 that the reader has to
-- add up correctly.
--
-- NO `currency` COLUMN. The position already has one and a commitment
-- is denominated in the position's currency by definition. A second
-- copy is a second thing that can disagree.
-- ---------------------------------------------------------------------

create table pc.fund_commitment (
  fund_commitment_id bigint primary key generated always as identity,
  fund_investment_id text not null references pc.fund_investment on delete cascade,

  -- The date this commitment level took effect. NOT the date it was
  -- typed in: `row_created_at` is that, and conflating the two is how a
  -- side letter signed in March but keyed in June reports wrongly for a
  -- quarter.
  as_of_date         date not null,

  -- DOLLARS. Zero is legitimate and is not the same as no row: a
  -- commitment released to nil is a fact somebody decided, and the
  -- absence of a row is a fact nobody has recorded.
  committed          numeric(18,2) not null check (committed >= 0),

  -- ADR-035 clause 1, borrowed deliberately. `company_ownership` learned
  -- at F3 that an adjustment which cannot say what caused it is a number
  -- nobody can defend six months later, and a commitment increase is the
  -- same shape of fact. NULLABLE HERE and required by the API on the
  -- adjustment path -- section 4's backfill has no cause to name beyond
  -- the migration itself, and inventing one would be worse than the gap.
  change_reason      text,

  -- The LPA, the subscription agreement, the side letter. Free text, as
  -- everywhere else: the document store is not this platform's job.
  source_document    text,

  is_synthetic       boolean not null default false,   -- ADR-020
  entered_by         uuid not null references pc.app_user,

  -- ADR-031's lifecycle block, identical on all seven versioned tables.
  row_created_at timestamptz not null default clock_timestamp(),
  row_updated_at timestamptz not null default clock_timestamp(),
  deleted_at     timestamptz,
  deleted_by     uuid references pc.app_user,
  deleted_reason text
);

-- ONE COMMITMENT LEVEL PER POSITION PER DATE. Two rows at one date are
-- one restated fact, not two commitments, so the write path upserts on
-- this key exactly as the F3 ownership path does.
--
-- AND NO `where deleted_at is null` ON IT, which is the opposite of what
-- F2 did to the valuation index and is deliberate rather than
-- inconsistent. F2's problem was an index REFUSING a legal second row;
-- this one has no legal second row to refuse. What it must not do is let
-- a re-entry at a deleted row's date insert alongside it -- so the index
-- stays total and the upsert clears `deleted_at`, which is the pattern
-- `company_ownership` already proved.
create unique index on pc.fund_commitment (fund_investment_id, as_of_date);

-- The read in section 3 is (position, date desc). This serves it.
create index on pc.fund_commitment (fund_investment_id, as_of_date desc);

comment on table pc.fund_commitment is
  'ADR-037 clause 1, closing S-7. The commitment on an LP position AS AT a date -- an absolute, not a delta. A commitment is adjustable (Q-16), so it is an event rather than a column, and an increase is a new dated row rather than an arithmetic puzzle. `fund_investment.committed` was dropped by the same migration that created this table.';
comment on column pc.fund_commitment.as_of_date is
  'The date this commitment level took effect. Not the date it was entered -- that is row_created_at.';
comment on column pc.fund_commitment.committed is
  'DOLLARS (ADR-008), and the LEVEL in force from as_of_date, not the change. A raise from $500,000 to $750,000 is a row reading 750000.00.';
comment on column pc.fund_commitment.change_reason is
  'What caused this level: a second close, a side letter, an amended LPA. Required by the API on every path except migration 0012''s backfill, which has no cause to name.';

-- ---------------------------------------------------------------------
-- 3. THE READER (ADR-037 clause 1)
--
-- `company_fmv_asof`'s sibling, and shaped like it on purpose --
-- including the deterministic tiebreak F2 had to add to that one after
-- discovering that `booked_at` defaults to transaction start time and
-- two rows written together tie on it. The unique index above makes a
-- tie impossible here, and the tiebreak is written anyway: an ordering
-- that is only deterministic because of a constraint somewhere else is
-- one deploy away from not being.
--
-- RETURNS NULL, NOT ZERO, when nothing was committed on or before the
-- date. The two are different states -- "no commitment had been made
-- yet" against "the commitment was released to nil" -- and collapsing
-- them inside the function would put the decision in the wrong place.
-- The export coalesces at its own boundary, where the ADR-001 contract
-- requires a number and 0 is the right one.
-- ---------------------------------------------------------------------

create or replace function pc.fund_committed_asof(p_fund_investment_id text, p_as_of date)
returns numeric language sql stable as $$
  select fc.committed
    from pc.fund_commitment fc
   where fc.fund_investment_id = p_fund_investment_id
     and fc.deleted_at is null
     and fc.as_of_date <= p_as_of
   order by fc.as_of_date desc, fc.fund_commitment_id desc
   limit 1;
$$;

comment on function pc.fund_committed_asof(text, date) is
  'ADR-037 clause 1. The commitment in force on an LP position at a date: the latest undeleted row on or before it. NULL when none -- "nothing committed yet" is not "committed nil", and the caller decides which it needs. This replaces fund_investment.committed, which migration 0012 dropped.';

-- ---------------------------------------------------------------------
-- 4. THE BACKFILL, AND THE CONTROL TOTAL IT HAS TO CLEAR
--
-- One row per position, at the earliest date the commitment can be
-- PROVEN to have existed, which is the position's first drawdown. A
-- commitment logically precedes its first draw, but by how much is not
-- in this database: `fund_investment` has never carried an inception
-- date, a subscription date or a document date. Choosing the first
-- drawdown is choosing the earliest defensible date over an invented
-- one.
--
-- TWO POSITIONS HAVE NO DRAWDOWN AT ALL -- Island Capital Partners and
-- Nadarra Ventures, both 2025 vintage, both committed and not yet
-- drawn. They fall back to 1 January of the vintage year, which IS an
-- inference and says so in `change_reason`, so the two rows built on a
-- guess are greppable rather than indistinguishable from the fourteen
-- built on evidence.
--
-- A position with neither a drawdown nor a vintage year would produce a
-- NULL date and fail the NOT NULL above rather than silently vanish.
-- There is no such position today; if one ever exists, this migration
-- stops and somebody chooses a date deliberately.
--
-- WRITTEN BEFORE THE TRIGGER IS ATTACHED, which is section 4b and is
-- the same order 0002 used for its own backfills. `capture_financial_
-- version` raises unless the session names an actor, and a migration
-- has none to name: `pc.actor_id` is set by the API's write path, per
-- request, by the person doing the writing. Setting it here to the
-- system user would make the version store say a person entered
-- sixteen commitments tonight. Nobody did -- the figures have been in
-- the database since A6, in a column.
-- ---------------------------------------------------------------------

insert into pc.fund_commitment
  (fund_investment_id, as_of_date, committed, change_reason, source_document,
   is_synthetic, entered_by)
select fi.fund_investment_id,
       coalesce(first_draw.d, make_date(fi.vintage_year, 1, 1)),
       fi.committed,
       case when first_draw.d is not null
            then 'Migration 0012 (F5): commitment level carried from fund_investment.committed, '
                 || 'dated at the position''s first drawdown -- the earliest date it is evidenced.'
            else 'Migration 0012 (F5): commitment level carried from fund_investment.committed. '
                 || 'No drawdown exists, so the date is INFERRED as 1 January of the vintage year.'
       end,
       fi.source_document,
       -- ADR-020's flag is INHERITED here, not asserted, and the first draft of
       -- this migration got it wrong in a way worth recording: it set `false`
       -- on the reasoning that the commitment FIGURES are real, which they are
       -- -- they come from NBIF LP Funds.xlsx and are the control totals A6
       -- reconciles to. But the row is not the figure. On a generated database
       -- the column this backfill reads was itself written by `db:generate`,
       -- and a non-synthetic row there survives the generator's clear step and
       -- collides with the one it writes next. Regenerability has now broken
       -- between phases three times (F1, F4, and this), always the same way:
       -- something new does not say whether the generator owns it.
       --
       -- So the rule is one clause with three correct answers. The database
       -- says whether it holds generated data at all; the position says whether
       -- anything about ITS history is real. Generated database, no real LP
       -- row on this position -> synthetic, and `db:generate` clears it. Real
       -- A13 load -> `contains_synthetic` is false and so is this. Fixture
       -- database -> synthetic, and the purge takes it with the position.
       (select contains_synthetic from pc.v_synthetic_data_status)
         and not exists (
           select 1 from pc.transaction t
            where t.fund_investment_id = fi.fund_investment_id and not t.is_synthetic
           union all
           select 1 from pc.fund_investment_nav n
            where n.fund_investment_id = fi.fund_investment_id and not n.is_synthetic),
       fi.created_by
  from pc.fund_investment fi
  left join lateral (
    select min(t.txn_date) as d
      from pc.v_transaction_live t
     where t.fund_investment_id = fi.fund_investment_id
       and t.txn_type = 'capital_drawdown') first_draw on true;

-- `clock_timestamp()` is volatile and is evaluated once PER COLUMN, so
-- the two lifecycle defaults land microseconds apart and every row
-- claims to have been edited on the Finance screen. 0002 and 0003 both
-- hit this and both fixed it exactly here, before the trigger existed.
update pc.fund_commitment set row_updated_at = row_created_at;

do $$
declare
  v_positions   int;
  v_rows        int;
  v_column_sum  numeric(18,2);
  v_ledger_sum  numeric(18,2);
  v_workbook    constant numeric(18,2) := 8725000.00;
begin
  select count(*), sum(committed) into v_positions, v_column_sum from pc.fund_investment;
  select count(*), sum(committed) into v_rows, v_ledger_sum from pc.fund_commitment;

  if v_rows <> v_positions then
    raise exception
      'F5 backfill: % LP positions produced % commitment rows. One row per position, or the column is not safe to drop.',
      v_positions, v_rows;
  end if;

  if v_ledger_sum is distinct from v_column_sum then
    raise exception
      'F5 backfill: the commitment ledger sums to % and fund_investment.committed sums to %. They must agree to the cent before the column goes.',
      v_ledger_sum, v_column_sum;
  end if;

  -- The workbook total, checked separately from the column so that a
  -- database which has drifted from NBIF LP Funds.xlsx says so here
  -- rather than at A13. A WARNING and not an exception: a test database
  -- built from the ADR-001 fixture holds the prototype's LP positions,
  -- not NBIF's, and is entitled to a different total. The equality that
  -- MUST hold -- ledger against column -- is the one above.
  if v_ledger_sum <> v_workbook then
    raise warning
      'F5 backfill: commitments sum to % against the NBIF LP Funds.xlsx control total of %. Expected on a fixture database; investigate on a real one.',
      v_ledger_sum, v_workbook;
  else
    raise notice 'F5 backfill: % positions, commitments reconcile to % exactly.', v_rows, v_ledger_sum;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4b. AND NOW IT IS VERSIONED LIKE EVERY OTHER FINANCIAL ROW (ADR-031)
--
-- The trigger function reads its table and key from TG_TABLE_NAME and
-- TG_ARGV[0], which is why 0002 said attaching it to a seventh table
-- would be one CREATE TRIGGER and no new code. This is that seventh
-- table and that one statement.
--
-- `capture_financial_version` coalesces five effective-date columns to
-- decide whether a change is a restatement, and `as_of_date` is already
-- one of them -- fund_investment_nav uses it. Nothing to add there.
--
-- From here on, a commitment cannot be created, raised, deleted or
-- restored without an attributed version record, including from psql.
-- ---------------------------------------------------------------------

create trigger zz_version_fund_commitment
  before insert or update or delete on pc.fund_commitment
  for each row execute function pc.capture_financial_version('fund_commitment_id');

-- The reconstruction function, from 0002's template verbatim so the
-- seven bodies cannot drift.
create or replace function pc.fund_commitment_asof(p_at timestamptz)
returns setof pc.fund_commitment
language sql stable as $$
  select c.*
    from pc.fund_commitment c
   where c.row_created_at <= p_at
     and c.row_updated_at <= p_at
     and c.deleted_at is null
  union all
  select (jsonb_populate_record(null::pc.fund_commitment, v.row_image)).*
    from (
      select distinct on (record_id) record_id, row_image
        from pc.financial_row_version
       where table_name = 'fund_commitment'
         and valid_from <= p_at
         and valid_to   >  p_at
       order by record_id, valid_to
    ) v
   where (v.row_image ->> 'deleted_at') is null
$$;

comment on function pc.fund_commitment_asof(timestamptz) is
  'ADR-031. The commitment ledger as it stood at an instant. Note the two dates this composes with: fund_commitment_asof(t) is what the platform BELIEVED at instant t, and as_of_date is when a commitment level took effect. Reproducing a board pack issued before a commitment was corrected needs the first; reporting unfunded capital as at a past quarter needs the second.';

-- ---------------------------------------------------------------------
-- 5. THE VIEW DERIVES IT, AND FLAGS THE OVERDRAW (ADR-037 clause 5)
--
-- DROPPED AND RECREATED rather than replaced, because `overdrawn` is a
-- new column and `create or replace view` cannot add one anywhere but
-- the end. Nothing depends on this view: it is convenience-only, and
-- the note above it has said so since A1.
--
-- `current_date`, exactly as `v_company_current` does and with the same
-- caveat: the API never reads a commitment from here. It calls
-- `fund_committed_asof()` with the explicit as-at date it hands the
-- metrics package (ADR-021), so an export re-run reproduces itself.
--
-- A DRAWDOWN BEYOND THE COMMITMENT IS ACCEPTED AND FLAGGED, NEVER
-- REFUSED (ADR-037 clause 5). Same principle as a round total below our
-- own cheque, and the same reasoning: it is a real state of real data --
-- a recallable distribution redrawn, a late amendment, a GP notice keyed
-- before the side letter arrives -- and a platform that makes it
-- un-recordable gets a fudged figure instead of a visible one. The flag
-- lives here so F6's reconciliation surface reads a column rather than
-- re-deriving the rule.
-- ---------------------------------------------------------------------

drop view if exists pc.v_lp_position_current;

create view pc.v_lp_position_current as
select fi.fund_investment_id,
       fi.name, fi.manager_name, fi.strategy, fi.vintage_year,
       committed.amount                                as committed,
       coalesce(draws.drawn, 0)                        as called,
       coalesce(committed.amount, 0) - coalesce(draws.drawn, 0) as unfunded,
       coalesce(dists.distributions, 0)                as distributions,
       coalesce(nav.nav, 0)                            as nav,
       nav.as_of_date                                  as nav_as_of,
       -- ADR-037 clause 5. Drawn beyond the commitment in force. NULL
       -- when there is no commitment on record, because "we cannot tell"
       -- is not "no, this is fine" -- the same three-valued discipline
       -- ADR-035 clause 4 applied to significant influence.
       case when committed.amount is not null
            then coalesce(draws.drawn, 0) > committed.amount
       end                                             as overdrawn,
       case when coalesce(draws.drawn,0) > 0
            then (coalesce(nav.nav,0) + coalesce(dists.distributions,0)) / draws.drawn
       end                                             as tvpi,
       case when coalesce(draws.drawn,0) > 0
            then coalesce(dists.distributions,0) / draws.drawn
       end                                             as dpi
from pc.fund_investment fi
cross join lateral (
    select pc.fund_committed_asof(fi.fund_investment_id, current_date) as amount) committed
left join lateral (
    select sum(t.amount_cad) as drawn from pc.v_transaction_live t
     where t.fund_investment_id = fi.fund_investment_id
       and t.txn_type = 'capital_drawdown') draws on true
left join lateral (
    select sum(t.amount_cad) as distributions from pc.v_transaction_live t
     where t.fund_investment_id = fi.fund_investment_id
       and t.txn_type = 'capital_distribution') dists on true
left join lateral (
    select n.nav, n.as_of_date from pc.fund_investment_nav n
     where n.fund_investment_id = fi.fund_investment_id
       and n.deleted_at is null
     order by n.as_of_date desc limit 1) nav on true;

-- THE COLUMN IS STILL CALLED `called`, and that is on purpose. The
-- export adapter reads it by name and so does anything Finance has
-- pointed at this view; renaming a result column is a break with no
-- offsetting gain, and FR-33's requirement is about the WORDS PEOPLE
-- SEE. The vocabulary that had to change is `txn_type`, because that is
-- the one A13 would have made expensive.

comment on view pc.v_lp_position_current is
  'CONVENIENCE ONLY for `committed`, `unfunded`, `tvpi` and `dpi` (ADR-023, ADR-021). The API reads `called`, `distributions` and `nav` from here and computes the multiples in packages/metrics; it derives `committed` by calling fund_committed_asof() with an EXPLICIT as-at date, never from this view''s current_date. Anyone pointing Power BI at the ratio columns gets a figure the platform itself does not use.';
comment on column pc.v_lp_position_current.called is
  'Capital DRAWN to date, in NBIF''s terminology (FR-33). The column keeps its name because the export adapter and Finance''s own queries read it by that name; what had to be renamed is the stored txn_type.';
comment on column pc.v_lp_position_current.overdrawn is
  'ADR-037 clause 5. True when drawdowns to date exceed the commitment in force. Accepted and flagged, never refused: it is a real state of real data and the platform''s job is to surface it. NULL means no commitment is on record, which is not the same as "not overdrawn".';

-- The `deleted_at is null` on the NAV lateral is a repair carried in
-- passing, not a change of definition. The 0001 view predates ADR-031's
-- soft delete by a migration, so a NAV statement deleted through the
-- Finance screen, on purpose, would still be the one this view reported.
-- Every other read in the system already excludes them, including the
-- one the export actually uses; this view had been left behind. Zero
-- deleted NAV rows exist, so no figure moves.

-- ---------------------------------------------------------------------
-- 6. THE COLUMN GOES (ADR-037 clause 2)
--
-- This pays down one of ADR-002's oldest debts. The field inventory has
-- carried `called` and `distributions` as "should be derived, MVP stores
-- it separately" since A1, and `committed` sat beside them as a stored
-- scalar that a dated fact had outgrown. It is the first of them to
-- actually go.
--
-- Dropped now rather than deprecated, for the reason the roadmap gives
-- for doing Track F at all: forward-only becomes binding the moment
-- something reaches Azure, and nothing has. A column left behind
-- "temporarily" is a column two readers disagree over at A13.
-- ---------------------------------------------------------------------

alter table pc.fund_investment drop column committed;

-- ---------------------------------------------------------------------
-- 7. THE SYNTHETIC GUARD LEARNS THE SEVENTH TABLE (ADR-020)
--
-- Dropped and recreated so the new count sits with the others rather
-- than after the boolean they feed. Only `contains_synthetic` is read by
-- name anywhere in the codebase, and it keeps its name and its meaning.
--
-- `fund_commitment` joins the OR, which is a change with no effect today
-- and one worth having: a database holding generated commitments and
-- nothing else is still a database that must show the banner.
-- ---------------------------------------------------------------------

drop view if exists pc.v_synthetic_data_status;

create view pc.v_synthetic_data_status as
select
  (select count(*) from pc.transaction         where is_synthetic) as synthetic_transactions,
  (select count(*) from pc.valuation_mark      where is_synthetic) as synthetic_marks,
  (select count(*) from pc.investment_round    where is_synthetic) as synthetic_rounds,
  (select count(*) from pc.fund_investment_nav where is_synthetic) as synthetic_lp_navs,
  (select count(*) from pc.fund_commitment     where is_synthetic) as synthetic_lp_commitments,
  (select count(*) from pc.company_ownership   where is_synthetic) as synthetic_ownership,
  (select count(*) from pc.fund_distribution   where is_synthetic) as synthetic_fund_distributions,
  (select count(*) from pc.transaction          where is_synthetic) > 0
    or (select count(*) from pc.valuation_mark   where is_synthetic) > 0
    or (select count(*) from pc.fund_commitment  where is_synthetic) > 0
    or (select count(*) from pc.fund_distribution where is_synthetic) > 0
                                                              as contains_synthetic;

comment on view pc.v_synthetic_data_status is
  'Read at application start. If contains_synthetic is true the UI must display a persistent synthetic-data banner on every screen and stamp every PDF export (ADR-020). A production environment reading true is a deployment error, not a warning.';
