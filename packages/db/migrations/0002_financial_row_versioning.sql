-- =====================================================================
-- 0002 · ADR-031 — Financial rows become editable, over a versioned store
--
-- ADR-018 made transactions, marks and LP cashflows append-only so that a
-- previously issued board report stayed reproducible. ADR-031 keeps that
-- requirement and changes how it is met: the base tables now hold current
-- state and are edited in place, and every prior state is retained here.
--
-- THE ONE THING TO UNDERSTAND ABOUT THIS FILE: capture is by TRIGGER, not
-- by application code. An UPDATE typed into psql at 9pm is versioned
-- exactly like one issued through the API, and neither can run without
-- naming an actor. That is the property that made it safe to give Finance
-- an Edit button, and it is the reason none of this lives in TypeScript.
--
-- Nothing here changes a single stored value, so no view, metric or
-- golden master moves. Verified by the A7 suite.
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. THE VERSIONED TABLES
--
-- Six tables hold facts that feed a board number. Each gains the same
-- four-column lifecycle block, so the trigger below can be written once
-- and attached six times rather than specialised per table.
--
--   row_created_at  when the fact entered the platform
--   row_updated_at  when its current image became true. This is the
--                   `valid_from` of the NEXT version written, which is
--                   what lets the chain be reconstructed without storing
--                   redundant timestamps.
--   deleted_at      soft delete. Set means the row is gone from every
--                   view and every total, and is restorable.
--
-- `transaction` and `valuation_mark` already carry `booked_at`, which is
-- semantically the creation time. It is left alone and backfilled from
-- rather than reused: `booked_at` is a Finance-facing fact ("when did we
-- book this?") and `row_created_at` is a storage fact. Conflating them
-- would mean an edit to a booking date silently rewrote the version
-- chain's start.
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'transaction', 'valuation_mark', 'investment_round',
    'company_ownership', 'fund_distribution', 'fund_investment_nav'
  ] loop
    execute format($f$
      alter table pc.%I
        add column row_created_at timestamptz not null default clock_timestamp(),
        add column row_updated_at timestamptz not null default clock_timestamp(),
        add column deleted_at     timestamptz,
        add column deleted_by     uuid references pc.app_user,
        add column deleted_reason text
    $f$, t);
  end loop;
end $$;

-- No index on deleted_at. The obvious `(deleted_at) where deleted_at is null`
-- indexes a column that is null for every row it contains, and the largest of
-- these tables holds 1,015 rows. The existing indexes carry the reads.

-- Rows that predate this migration were created when they were booked, not
-- when the migration ran. Where the table knows, say so; where it does not,
-- the default stands and is honest about it.
update pc.transaction     set row_created_at = booked_at, row_updated_at = booked_at;
update pc.valuation_mark  set row_created_at = booked_at, row_updated_at = booked_at;

-- THEN FLATTEN THE PAIR ON EVERY TABLE, and this is not belt-and-braces.
-- `clock_timestamp()` is volatile and is evaluated separately for each column,
-- so the two defaults above land microseconds apart. The UI reads
-- `row_updated_at > row_created_at` as "this row has been edited since it was
-- entered" and draws a pill, which meant every pre-existing row in the four
-- tables without a booked_at claimed to have been edited by someone. Caught on
-- the LP NAV table the first time the Finance screen rendered.
do $$
declare t text;
begin
  foreach t in array array[
    'transaction', 'valuation_mark', 'investment_round',
    'company_ownership', 'fund_distribution', 'fund_investment_nav'
  ] loop
    execute format('update pc.%I set row_updated_at = row_created_at', t);
  end loop;
end $$;

comment on column pc.transaction.deleted_at is
  'ADR-031 soft delete. A row booked against the wrong company is deleted and re-entered rather than edited into an unrelated fact. Excluded from v_transaction_live and therefore from every aggregate.';

-- ---------------------------------------------------------------------
-- 2. WHO IS DOING THIS
--
-- The actor arrives as a session variable rather than a trigger argument
-- because triggers cannot see application state any other way. `set local
-- pc.actor_id = '<uuid>'` inside the transaction is the contract; the
-- write path in packages/api does it, and anyone connecting directly must
-- do it too.
--
-- The function RAISES rather than returning null. An anonymous edit to a
-- financial row is not a degraded audit entry, it is a defect, and it
-- should fail loudly at the point it is attempted rather than quietly
-- produce a version record naming nobody.
-- ---------------------------------------------------------------------

create or replace function pc.current_actor_id() returns uuid
language plpgsql stable as $$
declare v text;
begin
  v := nullif(current_setting('pc.actor_id', true), '');
  if v is null then
    raise exception
      'No pc.actor_id set for this session. Financial rows cannot be modified anonymously (ADR-031). Issue: set local pc.actor_id = ''<app_user uuid>'';'
      using errcode = 'insufficient_privilege';
  end if;
  return v::uuid;
end $$;

comment on function pc.current_actor_id is
  'ADR-031. Raises rather than defaulting: there is no such thing as an unattributed financial edit.';

-- Optional, and deliberately separate from the actor. A reason is required
-- only for restatements (clause 5); everywhere else it is welcome but not
-- demanded, and conflating the two would mean every routine typo fix
-- prompted for prose nobody reads.
create or replace function pc.current_change_reason() returns text
language sql stable as $$
  select nullif(current_setting('pc.change_reason', true), '');
$$;

-- ---------------------------------------------------------------------
-- 3. THE VERSION STORE
--
-- One table, not six, holding the full prior row as jsonb. The typed
-- alternative — transaction_version, valuation_mark_version, and so on —
-- buys column types nothing here needs, and costs six tables that must be
-- kept in step with six parents forever. `jsonb_populate_record` gives the
-- types back at read time, on the one path that wants them (section 5),
-- and does it against the live table definition, so a future column
-- addition cannot leave a version table stale.
-- ---------------------------------------------------------------------

create table pc.financial_row_version (
  financial_row_version_id bigint primary key generated always as identity,
  table_name    text        not null,
  record_id     text        not null,   -- text, because keys are bigint and company_ownership is composite in spirit
  row_image     jsonb       not null,   -- the COMPLETE row, every column
  valid_from    timestamptz not null,   -- when this image became true
  valid_to      timestamptz not null,   -- when it stopped being true
  action        text        not null check (action in ('create','update','delete','restore')),
  changed_by    uuid        not null references pc.app_user,
  change_reason text,

  -- Set when the edited row's effective date falls inside a frozen
  -- fund_nav_snapshot period: this change moved a number the board has
  -- already seen. ADR-031 clause 5 permits it and requires it be visible.
  is_restatement boolean not null default false,

  -- Carried from the row image so a demo edit is greppable without
  -- unpacking jsonb, and so the ADR-020 banner logic never has to.
  is_synthetic  boolean not null default false,

  constraint frv_interval check (valid_to >= valid_from)
);

create index on pc.financial_row_version (table_name, record_id, valid_to desc);
create index on pc.financial_row_version (changed_by, valid_to desc);
create index on pc.financial_row_version (valid_to desc) where is_restatement;

comment on table pc.financial_row_version is
  'ADR-031. The COMPLETE history of every financial row: its creation, every edit, its deletion and any restoration. Never pruned: at this platform''s transaction volume the table is immaterial for its lifetime, and that was considered rather than overlooked.';
comment on column pc.financial_row_version.row_image is
  'The whole row, not a diff. A diff is cheaper to store and useless to reconstruct from when a column is added later. For action=create this is the row as first entered; for every other action it is the row as it was BEFORE the change.';
comment on column pc.financial_row_version.valid_to is
  'For action=create this equals valid_from: a creation is an instant, not an interval. The reconstruction in section 5 uses a half-open predicate, so create rows are correctly invisible to it.';

-- ---------------------------------------------------------------------
-- 4. CAPTURE
--
-- BEFORE INSERT OR UPDATE OR DELETE, one function for all six tables. It
-- reads the table name from TG_TABLE_NAME and the key from TG_ARGV[0], so
-- attaching it to a seventh table is one CREATE TRIGGER and no new code.
--
-- WHY INSERTS ARE CAPTURED TOO, when the base row is right there. Because
-- the alternative is worse. Without it, "who entered this and when" is
-- answered by a different column on every table — `entered_by` on four of
-- them, `prepared_by` on valuation_mark — and the History panel in the
-- Finance UI would need a six-way union that grows a branch every time the
-- schema does. With it, `financial_row_version` is the single complete
-- answer to "what has ever happened to this row", and the panel is one
-- query. The cost is one extra row per financial row, on a table holding
-- low thousands.
--
-- THE SYNTHETIC EXEMPTION, and how narrow it deliberately is.
-- `npm run db:generate` clears and rewrites the whole synthetic dataset on
-- every run (packages/db/src/generate/run.ts), by DELETE followed by
-- INSERT. Versioning that would write thousands of rows describing a demo
-- regeneration nobody will ever ask about. So capture is skipped for
-- exactly that: an INSERT or DELETE, of a synthetic row, by the
-- generator's system user. All three conditions.
--
-- An UPDATE is NOT exempt even under those conditions, because the
-- generator never issues one — so exempting updates would buy nothing and
-- leave a hole a future reader has to reason about. A human editing a
-- synthetic row during a demo is versioned like any other edit. Nor is the
-- actor requirement waived: the generator sets pc.actor_id like everyone
-- else, so "no financial row is modified anonymously" holds without
-- exception. The exemption is about version-table volume, not identity.
-- ---------------------------------------------------------------------

create or replace function pc.capture_financial_version() returns trigger
language plpgsql as $$
declare
  actor      uuid := pc.current_actor_id();
  key_col    text := tg_argv[0];
  -- On INSERT the image IS the new row; on everything else it is the row as
  -- it stood before this statement touched it.
  img        jsonb := case when tg_op = 'INSERT' then to_jsonb(new) else to_jsonb(old) end;
  now_ts     timestamptz := clock_timestamp();
  verb       text;
  restated   boolean;
  eff_date   date;
begin
  -- The generator's bulk rewrite, and nothing else. See the note above.
  if tg_op in ('INSERT', 'DELETE')
     and coalesce((img ->> 'is_synthetic')::boolean, false)
     and actor = '00000000-0000-0000-0000-000000000001'::uuid then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  verb := case
    when tg_op = 'INSERT'                                       then 'create'
    when tg_op = 'DELETE'                                       then 'delete'
    when old.deleted_at is not null and new.deleted_at is null  then 'restore'
    when old.deleted_at is null and new.deleted_at is not null  then 'delete'
    else 'update'
  end;

  -- Does this row sit inside a period the board has already been shown?
  -- One coalesce over the five date columns these six tables use, rather
  -- than a per-table branch: adding a seventh table should not mean
  -- editing this function.
  eff_date := coalesce(
    img ->> 'txn_date', img ->> 'effective_date', img ->> 'round_date',
    img ->> 'as_of_date', img ->> 'distribution_date'
  )::date;
  restated := eff_date is not null and exists (
    select 1 from pc.fund_nav_snapshot s
     where s.frozen_at is not null and s.period_end >= eff_date);

  insert into pc.financial_row_version
    (table_name, record_id, row_image, valid_from, valid_to, action,
     changed_by, change_reason, is_restatement, is_synthetic)
  values (
    tg_table_name, img ->> key_col, img,
    -- A creation is an instant, not an interval, so from = to and the
    -- half-open reconstruction predicate never selects it.
    case when tg_op = 'INSERT' then now_ts else (img ->> 'row_updated_at')::timestamptz end,
    now_ts,
    verb, actor, pc.current_change_reason(), restated,
    coalesce((img ->> 'is_synthetic')::boolean, false));

  if tg_op = 'DELETE' then
    return old;
  end if;

  -- Stamped here rather than trusted from the caller: the next version's
  -- valid_from is this value, so a caller that forgot to set it would open
  -- a silent gap in the chain.
  if tg_op = 'INSERT' then
    new.row_created_at := now_ts;
  end if;
  new.row_updated_at := now_ts;
  return new;
end $$;

do $$
declare r record;
begin
  for r in
    select unnest(array[
             'transaction', 'valuation_mark', 'investment_round',
             'company_ownership', 'fund_distribution', 'fund_investment_nav'
           ]) as t,
           unnest(array[
             'transaction_id', 'valuation_mark_id', 'investment_round_id',
             'company_ownership_id', 'fund_distribution_id', 'fund_investment_nav_id'
           ]) as k
  loop
    execute format(
      'create trigger %I before insert or update or delete on pc.%I
         for each row execute function pc.capture_financial_version(%L)',
      'zz_version_' || r.t, r.t, r.k);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. RECONSTRUCTION
--
-- This is the clause that discharges ADR-018's requirement, so it is built
-- now rather than deferred: a reconstruction path that does not exist yet
-- is a reproducibility guarantee that does not exist yet.
--
-- `<table>_asof(t)` returns the table exactly as it stood at instant t.
-- Two sources, unioned:
--   - rows whose CURRENT image was already true at t, and which existed
--     and were not deleted then;
--   - rows whose image at t is held in the version store.
-- A row created after t appears in neither. A row deleted before t appears
-- in neither, because its live image is deleted and its version images all
-- expired earlier.
--
-- Generated from one template rather than written six times: the bodies
-- would be identical but for two identifiers, and six copies of a
-- correctness-critical query is six places for them to drift.
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'transaction', 'valuation_mark', 'investment_round',
    'company_ownership', 'fund_distribution', 'fund_investment_nav'
  ] loop
    execute format($f$
      create or replace function pc.%I(p_at timestamptz)
      returns setof pc.%I
      language sql stable as $body$
        select c.*
          from pc.%I c
         where c.row_created_at <= p_at
           and c.row_updated_at <= p_at
           and c.deleted_at is null
        union all
        select (jsonb_populate_record(null::pc.%I, v.row_image)).*
          from (
            select distinct on (record_id) record_id, row_image
              from pc.financial_row_version
             where table_name = %L
               and valid_from <= p_at
               and valid_to   >  p_at
             order by record_id, valid_to
          ) v
         where (v.row_image ->> 'deleted_at') is null
      $body$
    $f$, t || '_asof', t, t, t, t);
  end loop;
end $$;

comment on function pc.transaction_asof(timestamptz) is
  'ADR-031. The transaction table as it stood at an instant. Reproducing a superseded board pack is this function with a timestamp in it. The A7 suite asserts the round trip: mutate, reconstruct as of before, assert the original figures return.';

-- ---------------------------------------------------------------------
-- 6. SOFT DELETE REACHES THE READS
--
-- v_transaction_live already excluded voided and reversing rows; it now
-- also excludes deleted ones. Reversal is retained deliberately (ADR-031
-- clause 7) — a clawback is a real economic event and belongs in the
-- register as a second row. What was withdrawn is the obligation to use
-- that mechanism for typing errors.
--
-- Every aggregate in the schema reads through this view or through the
-- filters below, so this is the whole of the change to the read path.
-- With nothing deleted, no number moves; the golden masters assert it.
--
-- THE COLUMN LIST IS NOW EXPLICIT, where 0001 wrote `select *`. Not
-- cosmetic: `create or replace view` cannot change an existing view's
-- column list, and `select *` over a table that just gained five columns
-- tries to. Spelling the columns out also means the next migration to add
-- a column cannot silently widen a view the ADR-001 export reads from.
-- The list below is 0001's expansion of `*`, verbatim and in order.
-- ---------------------------------------------------------------------

create or replace view pc.v_transaction_live as
select transaction_id, txn_date, booked_at, txn_type, company_id,
       fund_investment_id, investment_round_id, investment_vehicle_id,
       amount, currency, fx_rate_to_cad, source_document, note, entered_by,
       batch_id, is_synthetic, voided_by_transaction_id, voided_at,
       voided_reason, reverses_transaction_id,
       amount * coalesce(fx_rate_to_cad, 1) as amount_cad
from pc.transaction
where voided_at is null and reverses_transaction_id is null and deleted_at is null;

-- FMV as at a date, with deleted marks excluded. Body is otherwise
-- unchanged from 0001; restated here in full because Postgres has no
-- way to amend one predicate of an existing function.
create or replace function pc.company_fmv_asof(p_company_id text, p_as_of date)
returns numeric language sql stable as $$
  select coalesce(
    (select vm.fmv
       from pc.valuation_mark vm
      where vm.company_id = p_company_id
        and vm.status = 'final'
        and vm.deleted_at is null
        and vm.effective_date <= p_as_of
      order by vm.effective_date desc, vm.booked_at desc
      limit 1),
    (select coalesce(sum(t.amount_cad), 0)
       from pc.v_transaction_live t
      where t.company_id = p_company_id
        and t.txn_type in ('investment','follow_on')
        and t.txn_date <= p_as_of)
  );
$$;

-- ---------------------------------------------------------------------
-- 7. WHAT FINANCE AND THE ADMIN READ
-- ---------------------------------------------------------------------

-- The verbose audit log, joined to a name. This is the view to query when
-- the question is "who changed this and what did it used to say".
create or replace view pc.v_financial_change_log as
select v.financial_row_version_id,
       v.table_name,
       v.record_id,
       v.valid_to as changed_at,
       v.action,
       u.display_name as changed_by_name,
       u.email        as changed_by_email,
       v.change_reason,
       v.is_restatement,
       v.is_synthetic,
       -- Named for what it is rather than for the common case: on a
       -- 'create' row this is the row as entered, and calling it
       -- "previous_values" there would be a lie a reader only catches once.
       v.row_image,
       v.valid_from as image_effective_from
  from pc.financial_row_version v
  join pc.app_user u on u.user_id = v.changed_by
 order by v.valid_to desc;

comment on view pc.v_financial_change_log is
  'ADR-031. Every creation, edit, deletion and restoration of a financial row, newest first, with the complete row image. Drives the History panel in the Finance UI and answers the admin''s ad-hoc question without a join to write.';

-- Restatements alone: the numbers that moved after the board saw them.
-- ADR-031 clause 5 permits restatement and requires it be visible; this
-- view is the "visible". Whether anyone is notified is an A9 question.
create or replace view pc.v_restatement_log as
select * from pc.v_financial_change_log where is_restatement;

-- The frozen boundary, as a scalar the write path can ask for cheaply.
-- Null when the board has been shown nothing yet, which is true today.
create or replace function pc.latest_frozen_period_end() returns date
language sql stable as $$
  select max(period_end) from pc.fund_nav_snapshot where frozen_at is not null;
$$;

-- ---------------------------------------------------------------------
-- 8. ADR-020 IS UNAFFECTED, AND SAYS SO
--
-- The banner keys on synthetic rows in the base tables. Deleted rows still
-- count: a synthetic row that has been soft-deleted has not left the
-- database, and a banner that switched off because someone deleted the
-- demo data would be exactly the wrong behaviour.
-- ---------------------------------------------------------------------

comment on view pc.v_synthetic_data_status is
  'ADR-020. Counts synthetic rows in the base tables, INCLUDING soft-deleted ones (ADR-031): a deleted synthetic row is still synthetic data present in the database, and the banner must not switch off because someone tidied the demo.';
