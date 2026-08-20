-- =====================================================================
-- 0011 · F4 — Roster status, and what "exited" means
--
-- Closes S-4 in part and lands ADR-036, amending ADR-009. Four changes:
--
--   1. company_state.roster_status — is this a portfolio company or an
--      exited one, dated, synced from Affinity.
--   2. affinity_status_map gains is_portfolio_member and is_exited, so
--      BOTH membership questions are answered by a table rather than by
--      a literal in TypeScript.
--   3. roster_status backfilled from evidence already in the database.
--   4. company_current_asof derives `exited` from the roster, falling
--      back to the exit event where the roster does not speak.
--
-- A NUMBER MOVES, AND THAT IS THE POINT OF THE PHASE. Today's dashboard
-- reads 7 exited companies. Every one of them is a company whose
-- Affinity LIFECYCLE status is "Winding Down" -- a different field
-- entirely -- and under ADR-036 all seven are still portfolio companies.
-- The correct figure is 2: Potential Motors and Alongside, the two
-- entries whose Affinity STATUS is `Exited`, confirmed by the F4 probe
-- against the live API before this migration was written.
--
-- The control totals do NOT move. Both companies have been on the roster
-- since A4, because the sync has counted `Exited` as membership from the
-- start; 82 companies, invested $47,216,678.00, FMV $42,030,272.00,
-- equal to the frozen F0 baseline to the cent. That is what the probe
-- was for, and it is why this migration exists at all rather than a
-- decision memo.
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. ROSTER STATUS, ON THE DATED TABLE (ADR-036 clause 3)
--
-- "When did this company leave the portfolio" is a question the board
-- asks, and it deserves an answer with a date on it. `company_state`
-- already carries health, risk grade and lifecycle status that way, and
-- already appends a row only on genuine change -- so a status transition
-- produces exactly one new row, on the night it happens.
--
-- VERBATIM, AND NULLABLE. Verbatim because it is Affinity's string and
-- Affinity is the system of record (ADR-026, the same reason
-- `sector_label` sits beside `sector_id`): a renamed or retired option
-- degrades to text that still says what was seen, rather than to a
-- foreign key that fails. Nullable because the ADR-001 fixture path has
-- no Affinity roster status at all, and section 4 depends on being able
-- to tell "Affinity has not spoken" from "Affinity says Portfolio".
--
-- NO CHECK CONSTRAINT, deliberately. The vocabulary lives in Affinity
-- and changes without a deploy; a CHECK here would turn a new option
-- into a failed sync at 2am. What routes each value is section 2.
-- ---------------------------------------------------------------------

alter table pc.company_state
  add column roster_status text;

comment on column pc.company_state.roster_status is
  'ADR-036 clause 3. Affinity''s Status for this company, verbatim -- `Portfolio`, `Exited`, `Closed`. Dated, because when a company left the portfolio is a question the board asks. NULL means Affinity has not spoken for this company (the fixture path), which is a different state from any value and is what the `exited` fallback keys on. Not constrained: the vocabulary is Affinity''s and changes without a deploy.';

create index on pc.company_state (roster_status) where effective_to is null;

-- ---------------------------------------------------------------------
-- 2. THE MAP ANSWERS BOTH MEMBERSHIP QUESTIONS (ADR-009, extended)
--
-- `affinity_status_map` exists because ADR-009 requires the
-- status-to-stage resolution to be a table rather than code, so that a
-- renamed or newly added status is a row edit rather than a deploy. The
-- sync's own comment says it: *"Resolved through affinity_status_map,
-- never by matching text."*
--
-- MEMBERSHIP DID NOT FOLLOW THAT RULE. It was a hardcoded Set in
-- `map.ts` -- `PORTFOLIO_STATUSES = {Portfolio, Exited, Closed}` -- and
-- F4 is the phase that adds a SECOND question of exactly the same kind
-- ("which status means exited"). Answering the new one in a table while
-- the old one stays in a literal would leave the two rules a file apart,
-- and the day they disagree is the day a company is on the roster and
-- not in either view.
--
-- So both live here. A status nobody has classified is a member of
-- nothing and exits nothing, which is the safe default for an option
-- added in Affinity on a Tuesday: it changes no view until someone says
-- what it means.
-- ---------------------------------------------------------------------

alter table pc.affinity_status_map
  add column is_portfolio_member boolean not null default false,
  add column is_exited           boolean not null default false;

comment on column pc.affinity_status_map.is_portfolio_member is
  'ADR-009, ADR-036. Whether an entry with this Status is a portfolio company at all. Was a hardcoded Set in the sync until F4. A status nobody has classified is not a member -- the safe default for an option added in Affinity without a deploy.';
comment on column pc.affinity_status_map.is_exited is
  'ADR-036 clause 1. Whether this Status means the company has LEFT the portfolio. Exactly one status carries it today. Separate from is_portfolio_member because an exited company is still on the roster -- it appears in the Exited view rather than vanishing.';

-- The rule as it stands, stated once. `Closed` is here because the sync
-- has always counted it: NBIF's deals move from Approved straight to
-- Portfolio, so no live entry carries it, and it is kept for the case
-- where one does rather than dropped for being unobserved.
update pc.affinity_status_map
   set is_portfolio_member = true
 where affinity_status in ('Portfolio', 'Exited', 'Closed');

update pc.affinity_status_map
   set is_exited = true
 where affinity_status = 'Exited';

-- ---------------------------------------------------------------------
-- 3. BACKFILL, FROM EVIDENCE ALREADY IN THE DATABASE
--
-- The sync writes `roster_status` from tonight on, but every company
-- sitting here now would read NULL until it runs -- and NULL means "the
-- roster has not spoken", which section 4 answers by falling back to the
-- exit event. That is precisely the artefact this phase is correcting,
-- so the migration would leave the wrong number on the dashboard until a
-- sync happened to run.
--
-- The evidence is already here and is exact: `pipeline_deal.funnel_label`
-- is the VERBATIM Affinity Status (the sync writes it that way for this
-- reason), and `converted_company_id` is the company that entry became.
-- One row per company, no inference. The same rule migrations 0008 and
-- 0010 used: read what is recorded, write nothing that is not.
--
-- UPDATED IN PLACE ON THE CURRENT STATE ROW, not appended as a new dated
-- row. A new row would assert that something CHANGED tonight, and
-- nothing did: this is a column added in the same migration being
-- initialised from a fact the database already held. `company_state`
-- carries no version trigger (migration 0002 lists the seven financial
-- tables and this is not one), so there is nothing to scope off.
-- ---------------------------------------------------------------------

update pc.company_state cs
   set roster_status = d.funnel_label
  from pc.pipeline_deal d
 where d.converted_company_id = cs.company_id
   and cs.effective_to is null
   and d.funnel_label is not null;

-- ---------------------------------------------------------------------
-- 4. WHAT `exited` MEANS (ADR-036 clause 4)
--
--   exited = (the roster says exited)
--         or (the roster has not spoken, and Finance recorded an exit)
--
-- THE FALLBACK IS NOT A HEDGE. `exited` is in the frozen ADR-001
-- contract and the golden masters assert against a fixture with no
-- Affinity roster status anywhere in it. The fallback keeps that path
-- and every golden master untouched while making Affinity authoritative
-- wherever it actually speaks. Two sources with different coverage,
-- expressed honestly.
--
-- RESOLVED THROUGH THE MAP, NEVER AGAINST THE LITERAL 'Exited'. Section
-- 2 exists for this line. An unmapped status falls back to the exit
-- event rather than asserting false, because "we do not know what this
-- status means" is not evidence that a company is still in the
-- portfolio.
--
-- EXIT DATE AND EXIT TYPE STILL COME FROM `company_exit`, and that
-- asymmetry is ADR-036's whole point: membership is the VC team's fact
-- in Affinity, the exit EVENT is Finance's fact in the platform, and
-- they are allowed to disagree for a while. A company the roster calls
-- exited with no exit event recorded shows exactly that -- exited, with
-- no date -- which is a line for the F6 reconciliation surface rather
-- than a contradiction to hide.
--
-- Restated in full because Postgres cannot amend one expression of an
-- existing function. Everything else is byte-identical to the 0003
-- version, INCLUDING the `cst.effective_to is null` lateral: it reads
-- the CURRENT state row rather than the one in force at p_as_of, which
-- is pre-existing behaviour for health and stage. Changing it here would
-- move health, and health drives alerts and the golden masters. It is
-- noted rather than fixed in passing.
-- ---------------------------------------------------------------------

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
       -- ADR-036 clause 4.
       case
         when cs.roster_status is not null and m.affinity_status is not null
           then m.is_exited
         else (ce.company_id is not null)
       end                                       as exited,
       ce.exit_date, ce.exit_type,
       own.ownership_pct, own.pro_rata_rights
from pc.company c
left join pc.v_company_invested inv on inv.company_id = c.company_id
left join pc.v_company_realized rz  on rz.company_id  = c.company_id
left join pc.company_exit ce        on ce.company_id  = c.company_id
left join pc.ref_sector s           on s.sector_id    = c.sector_id
left join pc.ref_source_channel sc  on sc.source_channel_id = c.source_channel_id
left join lateral (
    select cst.health, rs.name as stage, cst.roster_status
      from pc.company_state cst
      left join pc.ref_stage rs on rs.stage_id = cst.stage_id
     where cst.company_id = c.company_id and cst.effective_to is null
     limit 1) cs on true
left join pc.affinity_status_map m on m.affinity_status = cs.roster_status
left join lateral (
    select co.ownership_pct, co.pro_rata_rights
      from pc.company_ownership co
     where co.company_id = c.company_id
       and co.deleted_at is null
     order by co.as_of_date desc limit 1) own on true;
$$;

comment on function pc.company_current_asof(date) is
  'ADR-036. The company as it stands, with `exited` derived from the Affinity roster status where there is one and from a recorded exit event where there is not. Membership is the VC team''s fact in Affinity; the exit event is Finance''s fact in the platform, and the two are allowed to disagree for a period -- a company the roster calls exited with no exit event recorded reads exited with no date, which is a reconciliation line rather than a contradiction.';
