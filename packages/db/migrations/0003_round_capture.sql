-- =====================================================================
-- 0003 · A8 — Deal-close capture, and the soft delete that 0002 left half
--        wired
--
-- ADR-012 puts round total, co-investors with an NB flag and amounts,
-- ownership after the round, pro-rata rights and post-money in a single
-- form filled by the deal lead at close, writing to three tables:
-- investment_round, round_coinvestor and company_ownership. Two of those
-- three were brought under ADR-031 versioning by migration 0002. The
-- third was not, and it is the one carrying the NB co-investment and
-- capital-to-direct figures.
--
-- THIS MIGRATION IS MOSTLY ABOUT ONE THING: giving a table an edit button
-- and a reproducibility guarantee in the same change, rather than the
-- button first. Everything else here is the consequence of that, plus
-- four reads that gained a `deleted_at` column in 0002 and never learned
-- to honour it.
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. round_coinvestor JOINS THE VERSIONED SET
--
-- It qualifies on 0002's own test — "tables holding facts that feed a
-- board number". `nb_other` on the round drives the NB co-investment
-- tile, and these rows drive v_lp_capital_to_direct on the Funds tab.
-- 0002 did not include it because nothing could write to it: the A6
-- generator populated it and no interface touched it. A8 is the change
-- that makes it editable, so this is the migration in which it has to
-- become reconstructable.
--
-- IT ALSO GAINS `is_synthetic`, WHICH IS AN ADR-020 GAP RATHER THAN A
-- CONSEQUENCE OF VERSIONING. ADR-020 says every generated financial row
-- carries the flag; the A6 generator writes hundreds of these rows and
-- none of them declared itself. Backfilled from the parent round, which
-- is where the truth already was.
-- ---------------------------------------------------------------------

alter table pc.round_coinvestor
  add column is_synthetic   boolean not null default false,
  add column row_created_at timestamptz not null default clock_timestamp(),
  add column row_updated_at timestamptz not null default clock_timestamp(),
  add column deleted_at     timestamptz,
  add column deleted_by     uuid references pc.app_user,
  add column deleted_reason text;

update pc.round_coinvestor rc
   set is_synthetic = r.is_synthetic
  from pc.investment_round r
 where r.investment_round_id = rc.investment_round_id;

-- The same flattening 0002 had to do, and for the same reason:
-- clock_timestamp() is volatile and evaluated per column, so the two
-- defaults land microseconds apart and the UI's "edited" pill — which
-- keys on row_updated_at > row_created_at — would claim every existing
-- row had been changed by someone.
update pc.round_coinvestor set row_updated_at = row_created_at;

create index on pc.round_coinvestor (investment_round_id);

comment on column pc.round_coinvestor.is_synthetic is
  'ADR-020. Added at A8; the A6 generator had been writing these rows without it, so a co-investor was the one generated financial row that could not be identified as generated. Backfilled from the parent round.';
comment on column pc.round_coinvestor.deleted_at is
  'ADR-031 soft delete. A co-investor removed from a round leaves v_lp_capital_to_direct and the NB co-investment aggregate, and stays restorable.';

-- ---------------------------------------------------------------------
-- 2. TWO AMENDMENTS TO THE CAPTURE TRIGGER
--
-- 0002 said attaching the trigger to a seventh table would be "one
-- CREATE TRIGGER and no new code". That was very nearly true. Two
-- clauses inside the function assume something round_coinvestor breaks,
-- and both are restated below with the reasoning, because a trigger that
-- silently does the wrong thing on one of seven tables is worse than one
-- that was never attached.
--
-- (a) THE EFFECTIVE DATE. The restatement test coalesces over the five
--     date columns the six tables use. round_coinvestor has none: a
--     co-investor is dated by the round it was in. Without this, editing
--     a co-investor's amount inside a period already issued to the board
--     would record is_restatement = false and stay out of
--     v_restatement_log — silently, on a mandate figure.
--
--     Resolved as a FALLBACK rather than a branch: the lookup runs only
--     when the coalesce found nothing, so `transaction` (which carries
--     both a txn_date and an investment_round_id) is untouched and reads
--     its own date as before. The rule is "a row with no date of its own
--     inherits its round's", which is a property of the data, not a
--     special case for one table.
--
-- (b) THE GENERATOR EXEMPTION NOW COVERS UPDATE. 0002 deliberately left
--     UPDATE outside the exemption and gave its reason: "the generator
--     never issues one — so exempting updates would buy nothing and
--     leave a hole a future reader has to reason about." The premise has
--     since stopped being true. `packages/db/src/generate/run.ts` links
--     co-investors to LP positions in a second pass, after
--     fund_investment exists, with a bulk UPDATE over round_coinvestor
--     — so every regeneration would now write a version row per linked
--     co-investor describing a demo rebuild nobody will ever ask about.
--
--     The three conditions are unchanged and still all required:
--     synthetic row, system principal, and now any of the three verbs.
--     The property 0002 was protecting survives intact — a human editing
--     a synthetic row during a demo carries their own actor id, so their
--     edit is versioned like any other. What is exempted is the
--     generator rewriting its own output, which is the only thing it was
--     ever about.
--
-- (c) THE EXEMPT PATH NOW FLATTENS row_created_at / row_updated_at, and
--     this is a live defect carried from 0002 rather than anything to do
--     with A8. Column defaults are applied BEFORE a BEFORE trigger runs,
--     so both timestamps are already populated — by two separate
--     evaluations of the volatile clock_timestamp() — by the time the
--     exemption returns early and skips the assignment that would
--     normally equalise them. 0002 flattened the pair for rows that
--     existed when it ran, which is why this has not been seen: it
--     surfaces on the next `npm run db:generate`, where every freshly
--     generated row would carry row_updated_at a few microseconds past
--     row_created_at and the UI's "edited" pill — which keys on exactly
--     that comparison — would mark the entire synthetic dataset as
--     having been changed by someone.
-- ---------------------------------------------------------------------

create or replace function pc.capture_financial_version() returns trigger
language plpgsql as $$
declare
  actor      uuid := pc.current_actor_id();
  key_col    text := tg_argv[0];
  img        jsonb := case when tg_op = 'INSERT' then to_jsonb(new) else to_jsonb(old) end;
  now_ts     timestamptz := clock_timestamp();
  verb       text;
  restated   boolean;
  eff_date   date;
begin
  -- The generator's bulk rewrite, and nothing else. See (b) above.
  if coalesce((img ->> 'is_synthetic')::boolean, false)
     and actor = '00000000-0000-0000-0000-000000000001'::uuid then
    if tg_op = 'DELETE' then
      return old;
    end if;
    -- See (c) above. The exempt path still has to flatten the pair,
    -- because it skips the assignment below that normally does it.
    if tg_op = 'INSERT' then
      new.row_updated_at := new.row_created_at;
    end if;
    return new;
  end if;

  verb := case
    when tg_op = 'INSERT'                                       then 'create'
    when tg_op = 'DELETE'                                       then 'delete'
    when old.deleted_at is not null and new.deleted_at is null  then 'restore'
    when old.deleted_at is null and new.deleted_at is not null  then 'delete'
    else 'update'
  end;

  -- Does this row sit inside a period the board has already been shown?
  eff_date := coalesce(
    img ->> 'txn_date', img ->> 'effective_date', img ->> 'round_date',
    img ->> 'as_of_date', img ->> 'distribution_date'
  )::date;

  -- See (a) above. Only reached by a row that carries no date of its own.
  if eff_date is null and jsonb_exists(img, 'investment_round_id') then
    select r.round_date into eff_date
      from pc.investment_round r
     where r.investment_round_id = (img ->> 'investment_round_id')::bigint;
  end if;

  restated := eff_date is not null and exists (
    select 1 from pc.fund_nav_snapshot s
     where s.frozen_at is not null and s.period_end >= eff_date);

  insert into pc.financial_row_version
    (table_name, record_id, row_image, valid_from, valid_to, action,
     changed_by, change_reason, is_restatement, is_synthetic)
  values (
    tg_table_name, img ->> key_col, img,
    case when tg_op = 'INSERT' then now_ts else (img ->> 'row_updated_at')::timestamptz end,
    now_ts,
    verb, actor, pc.current_change_reason(), restated,
    coalesce((img ->> 'is_synthetic')::boolean, false));

  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_op = 'INSERT' then
    new.row_created_at := now_ts;
  end if;
  new.row_updated_at := now_ts;
  return new;
end $$;

create trigger zz_version_round_coinvestor
  before insert or update or delete on pc.round_coinvestor
  for each row execute function pc.capture_financial_version('round_coinvestor_id');

-- The seventh reconstruction function, from the same template 0002 used.
create or replace function pc.round_coinvestor_asof(p_at timestamptz)
returns setof pc.round_coinvestor
language sql stable as $$
  select c.*
    from pc.round_coinvestor c
   where c.row_created_at <= p_at
     and c.row_updated_at <= p_at
     and c.deleted_at is null
  union all
  select (jsonb_populate_record(null::pc.round_coinvestor, v.row_image)).*
    from (
      select distinct on (record_id) record_id, row_image
        from pc.financial_row_version
       where table_name = 'round_coinvestor'
         and valid_from <= p_at
         and valid_to   >  p_at
       order by record_id, valid_to
    ) v
   where (v.row_image ->> 'deleted_at') is null
$$;

comment on function pc.round_coinvestor_asof(timestamptz) is
  'ADR-031. The co-investor set as it stood at an instant. This is what makes an NB co-investment figure on an issued board pack reproducible after a deal lead corrects a co-investor amount.';

-- ---------------------------------------------------------------------
-- 3. SOFT DELETE REACHES THE ROUND READS
--
-- 0002 section 6 wired deleted_at into v_transaction_live and
-- company_fmv_asof, which covered every read of the two tables it could
-- delete rows from at the time. investment_round and company_ownership
-- got the column and no reader — harmless while no write path could set
-- it, and a live defect the moment A8 ships the form that can.
--
-- Four reads, restated in full because Postgres cannot amend one
-- predicate of an existing view or function. Nothing else in any of them
-- changes, and with nothing deleted no number moves.
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
  and r.round_total is not null
  and r.round_total >= ours.our_invested;

create or replace view pc.v_lp_capital_to_direct as
select rc.fund_investment_id,
       sum(rc.amount) as capital_to_direct,
       count(distinct r.company_id) as companies_touched
from pc.round_coinvestor rc
join pc.investment_round r on r.investment_round_id = rc.investment_round_id
where rc.fund_investment_id is not null
  and rc.deleted_at is null
  and r.deleted_at is null
group by rc.fund_investment_id;

-- Body unchanged from 0001 but for `co.deleted_at is null` on the
-- ownership lateral. Without it, deleting a mis-keyed ownership row would
-- leave it as the company's current ownership and pro-rata position on
-- every screen, because the lateral takes the latest by date and asks
-- nothing else.
create or replace function pc.company_current_asof(p_as_of date)
returns table (
  company_id text, name text, sector text, sector_label text, stage text,
  health text, hq_city text, hq_region text, is_nb_based boolean,
  source_channel text, source_label text, invested numeric,
  first_investment_date date, vintage_year int, fmv numeric, realized numeric,
  exited boolean, exit_date date, exit_type text,
  ownership_pct numeric, pro_rata_rights boolean
) language sql stable as $$
select c.company_id,
       c.name,
       s.name                                    as sector,
       c.sector_label,
       cs.stage,
       cs.health,
       c.hq_city, c.hq_region, c.is_nb_based,
       sc.name                                   as source_channel,
       c.source_label,
       inv.invested,
       inv.first_investment_date,
       extract(year from inv.first_investment_date)::int as vintage_year,
       pc.company_fmv_asof(c.company_id, p_as_of)        as fmv,
       rz.realized,
       (ce.company_id is not null)               as exited,
       ce.exit_date, ce.exit_type,
       own.ownership_pct, own.pro_rata_rights
from pc.company c
left join pc.v_company_invested inv on inv.company_id = c.company_id
left join pc.v_company_realized rz  on rz.company_id  = c.company_id
left join pc.company_exit ce        on ce.company_id  = c.company_id
left join pc.ref_sector s           on s.sector_id    = c.sector_id
left join pc.ref_source_channel sc  on sc.source_channel_id = c.source_channel_id
left join lateral (
    select cst.health, rs.name as stage
      from pc.company_state cst
      left join pc.ref_stage rs on rs.stage_id = cst.stage_id
     where cst.company_id = c.company_id and cst.effective_to is null
     limit 1) cs on true
left join lateral (
    select co.ownership_pct, co.pro_rata_rights
      from pc.company_ownership co
     where co.company_id = c.company_id
       and co.deleted_at is null
     order by co.as_of_date desc limit 1) own on true;
$$;

-- ---------------------------------------------------------------------
-- 4. MANDATE COMPLETENESS, CORRECTED AND EXTENDED
--
-- ADR-012's monitoring half. The view existed since 0001 and has never
-- been read by anything; A8 puts it on the dashboard, which is the point
-- at which its arithmetic starts to matter.
--
-- THREE CHANGES.
--
-- (a) It counted soft-deleted rounds. Same class of defect as section 3
--     and found the same way.
--
-- (b) It gains `rounds_captured` — rounds whose `captured_at` is set,
--     meaning a deal lead has actually been through the form. This is a
--     different question from "is round_total filled in" and the
--     difference is the whole D-5 discipline applied to mandate data: a
--     round nobody has opened and a round someone opened and left a
--     field blank on look identical field-by-field, and only one of them
--     is a chasing target.
--
-- (c) POST-MONEY IS DELIBERATELY NOT A COMPLETENESS FIELD, though the
--     ADR-012 form captures it. A null post_money is legitimately "not
--     applicable" on a convertible note and "not known" on an equity
--     round, and the platform cannot tell those apart. Counting it would
--     report a portfolio of notes as permanently incomplete, which is
--     the D-5 error in the other direction — asserting a gap where there
--     is none. The same argument does not apply to round_total, nb_other
--     or ownership_after_pct: all three are facts every round has,
--     whether or not anyone wrote them down.
--
-- Columns are APPENDED, never reordered: `create or replace view` cannot
-- change an existing column list, and the four original columns are what
-- any ad-hoc query already written against this view expects.
-- ---------------------------------------------------------------------

create or replace view pc.v_mandate_completeness as
select count(*)                                                as rounds_total,
       count(*) filter (where round_total is null)             as missing_round_total,
       count(*) filter (where nb_other is null)                as missing_nb_other,
       count(*) filter (where ownership_after_pct is null)     as missing_ownership,
       round(100.0 * count(*) filter (where round_total is not null)
             / nullif(count(*),0), 1)                          as pct_leverage_coverage,
       count(*) filter (where captured_at is not null)         as rounds_captured,
       count(*) filter (where is_synthetic)                    as rounds_synthetic
from pc.investment_round
where deleted_at is null;

comment on view pc.v_mandate_completeness is
  'ADR-012. The decay monitor for the two mandate KPIs that depend on deal-lead discipline at a single moment. pct_leverage_coverage is the headline the ADR names: the share of rounds carrying a round total, which is the share of the portfolio the leverage figure can see at all. Read alongside the ADR-001 export, never inside it - this is a statement ABOUT the data (the A5 v_kpi_coverage precedent).';

-- The taper, which ADR-015 requires be reported rather than smoothed:
-- "coverage will be lower for older vintages and must be reported
-- honestly rather than imputed", and O-6's note that some histories run
-- fifteen years or more against a prototype seeded with a 2019 inception.
--
-- Per YEAR rather than per era, because era boundaries would be a
-- judgement encoded in SQL where a reader cannot see it. Bucketing for
-- display is the UI's business; this view states the fact.
create or replace view pc.v_mandate_completeness_by_year as
select extract(year from round_date)::int                      as round_year,
       count(*)                                                as rounds_total,
       count(*) filter (where round_total is not null)         as with_round_total,
       count(*) filter (where nb_other is not null)            as with_nb_other,
       count(*) filter (where ownership_after_pct is not null) as with_ownership,
       count(*) filter (where captured_at is not null)         as captured,
       round(100.0 * count(*) filter (where round_total is not null)
             / nullif(count(*),0), 1)                          as pct_leverage_coverage
from pc.investment_round
where deleted_at is null
group by 1
order by 1;

comment on view pc.v_mandate_completeness_by_year is
  'ADR-015. Mandate capture coverage by round year. The taper toward older vintages is the expected shape, not a defect: round totals and co-investor detail for early rounds are unrecoverable by any process. Reported so a leverage figure can be read against how much of the portfolio it can see.';
