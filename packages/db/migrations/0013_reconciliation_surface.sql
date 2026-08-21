-- =====================================================================
-- 0013 · F6 — The reconciliation surface
--
-- Closes S-10, FR-08, FR-09 and FR-14. Lands ADR-038, amending ADR-031.
-- Three changes:
--
--   1. financial_row_version.change_kind — a correction and a late
--      arrival stop looking like the same event (FR-14).
--   2. investment_round duplicate acknowledgement, plus the normalised
--      label the check keys on (FR-08).
--   3. v_reconciliation — one view, eight checks (FR-09, S-10).
--
-- NOTHING HERE CHANGES A FIGURE. Every column is additive and nullable,
-- the view is read-only, and no existing view, function or metric is
-- redefined. The one thing that moves is what the demo data LOOKS like,
-- and that moved in the generator rather than here -- see the F6 entry
-- in BUILD-LOG.md for the before and after.
--
-- WHY THE CHECKS ARE A VIEW AND NOT EIGHT QUERIES IN TYPESCRIPT. F6's
-- own argument against itself is that a reconciliation list nobody can
-- act on becomes wallpaper. The second failure is subtler: eight checks
-- written in the read path are eight checks the database cannot be asked
-- about directly, so Finance's own ad-hoc query and the screen drift
-- apart and nobody notices which is right. One view, one definition.
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. A CORRECTION AND A LATE ARRIVAL ARE NOT THE SAME EVENT (FR-14,
--    ADR-038 clauses 1 to 3)
--
-- ADR-031 flags an edit inside a frozen period as a RESTATEMENT, which
-- is right for a corrected figure and wrong for a grant that becomes
-- known six months after the round. Pat's requirement is precisely that
-- the second should be recordable "without it being treated as a data
-- correction error". Under ADR-031 as built both look identical in the
-- change log, and one of them reads as an accusation.
--
-- THE ROW'S HISTORY WAS RIGHT; THE LABEL WAS WRONG.
--
-- NULLABLE, AND NULL MEANS UNCLASSIFIED. Every version row written
-- before this migration genuinely is unclassified — 49 of them in this
-- database — and backfilling a guess would be worse than the gap. It is
-- required on updates going FORWARD, by the API, which is where the
-- person who knows the answer is standing.
--
-- A CHECK RATHER THAN A REFERENCE TABLE, on the rule migration 0009 set
-- when it made the opposite choice for retention factors: each value
-- here names a distinct branch in application code, so the set is closed
-- by construction and an unlisted value would be one nothing can
-- produce. The retention list was a table because FINANCE changes it;
-- nobody changes this without a deploy.
-- ---------------------------------------------------------------------

alter table pc.financial_row_version
  add column change_kind text
    check (change_kind is null
           or change_kind in ('correction', 'new-information', 'initial-load'));

comment on column pc.financial_row_version.change_kind is
  'ADR-038, FR-14. Why this change happened, as distinct from what it changed. `correction` = the stored figure was wrong. `new-information` = the figure was right and something arrived late, a grant six months after the round being the case that prompted this. `initial-load` = a bulk historical import (A13). NULL means unclassified, which every row written before migration 0013 genuinely is; required on updates going forward by the API, not by this constraint.';

-- The reader, matching `current_change_reason()` exactly. Separate from
-- the reason for the same argument ADR-031 made about separating the
-- reason from the actor: they answer different questions, and a routine
-- typo fix should not have to pick a kind out of a list to say so.
create or replace function pc.current_change_kind() returns text
language sql stable as $$
  select nullif(current_setting('pc.change_kind', true), '');
$$;

comment on function pc.current_change_kind is
  'ADR-038. Reads the change kind the write path set for this transaction. Optional where the reason is optional; a NULL here is an unclassified change, not a defect.';

-- Restated in full, because Postgres cannot amend one clause of an
-- existing function body. THE ONLY CHANGE IS THE TWO TOKENS CARRYING
-- `change_kind` into the insert; the rest is migration 0003's body
-- character for character, and it was COPIED FROM 0003 RATHER THAN
-- RETYPED FROM ITS DESCRIPTION.
--
-- That distinction is not pedantry. The first draft of this migration
-- retyped the body from ADR-031's A8 amendment and dropped four lines:
-- the exempt path's `new.row_updated_at := new.row_created_at`. The
-- exempt path returns before the assignment at the bottom that normally
-- flattens the pair, so without it every synthetic row comes back from
-- `db:generate` with row_updated_at microseconds ahead of
-- row_created_at -- and the Finance screen reads that as "somebody
-- edited this" and draws a pill. 95 rows across three tables claimed to
-- have been edited by nobody before it was caught. It is the SAME defect
-- ADR-031's A8 amendment records being fixed, reintroduced by the act of
-- describing the fix instead of copying it.
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
     changed_by, change_reason, change_kind, is_restatement, is_synthetic)
  values (
    tg_table_name, img ->> key_col, img,
    case when tg_op = 'INSERT' then now_ts else (img ->> 'row_updated_at')::timestamptz end,
    now_ts,
    verb, actor, pc.current_change_reason(), pc.current_change_kind(),
    restated,
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

-- The change log carries it, or the column is written and never read.
-- Appended at the END of both views deliberately: `create or replace
-- view` can add a column there and nowhere else, and `v_restatement_log`
-- is `select *` over the first, so it has to be replaced in step or it
-- keeps the old, narrower column list.
--
-- `v_restatement_log` IS THE VIEW THIS MATTERS MOST ON. It exists to
-- answer "what moved after the board saw it", and FR-14's whole point is
-- that two different events land in it -- a figure that was wrong, and a
-- figure that was right and incomplete. Without this column that view
-- cannot tell them apart, which is the state Pat objected to.
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
       v.row_image,
       v.valid_from as image_effective_from,
       v.change_kind
  from pc.financial_row_version v
  join pc.app_user u on u.user_id = v.changed_by
 order by v.valid_to desc;

create or replace view pc.v_restatement_log as
select * from pc.v_financial_change_log where is_restatement;

comment on view pc.v_restatement_log is
  'ADR-031 clause 5 and ADR-038. The numbers that moved after the board saw them, and -- since F6 -- WHY each moved. A restatement of a wrong figure and a grant that arrived six months late are both here and are no longer the same row shape: `change_kind` separates them. NULL means the change predates migration 0013 and is genuinely unclassified.';

-- ---------------------------------------------------------------------
-- 2. THE DUPLICATE ROUND, AS A WARNING WITH A NAME ON IT (FR-08,
--    ADR-038 clause 4)
--
-- Funke raised the risk in as many words: "two 'Triple Hare Series A'
-- records being created". A HARD BLOCK WOULD BE WRONG, and the
-- codebase's own precedent says why -- a round total below our own
-- cheque is accepted and flagged, because pushing somebody into fudging
-- a figure to get past a form is worse than the figure being wrong and
-- visible.
--
-- So: detect, refuse the plain save, and require an acknowledgement that
-- is STORED ON THE ROW. Three columns rather than a boolean, for the
-- reason every other confirmation in this schema is three: an
-- acknowledgement with no name and no clock against it cannot be
-- chased, cannot be audited, and cannot be told from a default.
--
-- ON Q-9, WHICH IS STILL OPEN, AND WHAT THE MEASUREMENT SAID.
-- The question is what counts as "the same round". F6 measured it before
-- choosing: 32 same-company same-label pairs existed in the demo data
-- and the CLOSEST two were 256 days apart, so a label-only rule would
-- have fired 32 times on its first day and been wrong every time. That
-- looked like an argument for a date window.
--
-- It was not. 29 of the 32 were the A6 generator emitting a BRIDGE round
-- under its parent's label -- `plan.ts` has held the rung 25% of the
-- time since A6, with the comment "a bridge holds the rung", and then
-- written "Seed" three times for one company. Funke's own description of
-- the real thing is the fix: bridged funding "shows up as a qualifier,
-- like an adjective", so real Finance-entered data reads "Series A
-- bridge" and never collides. The generator was corrected and the pairs
-- went to zero.
--
-- THEREFORE THE RULE IS NORMALISED LABEL ALONE, exactly as ADR-038
-- clause 4 specifies, WITH NO DATE WINDOW. A window would have been a
-- number nobody chose, compensating for a defect in the demo data, and
-- it would have quietly stopped catching the very case FR-08 names --
-- two "Series A" rows entered a year apart because somebody forgot the
-- first one. Finance owns this entry path and is accountable for it; the
-- warning is there to catch the slip, not to police the team.
-- ---------------------------------------------------------------------

alter table pc.investment_round
  add column duplicate_ack_at     timestamptz,
  add column duplicate_ack_by     uuid references pc.app_user,
  add column duplicate_ack_reason text,
  add constraint round_duplicate_ack_whole check (
    (duplicate_ack_at is null) = (duplicate_ack_by is null)
    and (duplicate_ack_at is null) = (duplicate_ack_reason is null));

comment on column pc.investment_round.duplicate_ack_at is
  'FR-08, ADR-038 clause 4. Set when somebody was warned that this round shares a company and a normalised label with another and confirmed it anyway -- a second tranche, an extension, a bridge. Never a hard block: "Series A" and "Series A extension" and a second tranche of one raise are all real. The reason travels with it and is not the ADR-031 restatement reason, which explains a change to a published figure rather than the existence of this row.';

/**
 * The normalisation, as a function so the index and the check cannot
 * disagree.
 *
 * IMMUTABLE and deliberately dull: case-fold, drop everything that is
 * not a letter or a digit, collapse to nothing. "Series A", "series a"
 * and "Series-A" are one label; "Series A" and "Series A bridge" are
 * two, which is the whole point of section 2's argument.
 *
 * NO STEMMING, NO SYNONYMS, NO FUZZY DISTANCE. Q-9 may tighten this
 * later and this is the seam it tightens at -- one function, one index,
 * one query. A fuzzy rule chosen now, before Finance has said what it
 * considers the same round, is a rule that fires at a rate nobody
 * predicted on data nobody has seen.
 */
create or replace function pc.normalise_round_label(p_label text)
returns text language sql immutable strict as $$
  select lower(regexp_replace(p_label, '[^a-zA-Z0-9]+', '', 'g'));
$$;

comment on function pc.normalise_round_label(text) is
  'FR-08. The label a duplicate check compares. Case-folded, punctuation and whitespace removed, nothing else -- see migration 0013 section 2 on why the rule is deliberately not fuzzy while Q-9 is open.';

-- Not unique: a duplicate is legal once acknowledged, which is the whole
-- design. This serves the lookup the write path does on every save.
create index investment_round_normalised_label_idx
  on pc.investment_round (company_id, pc.normalise_round_label(label))
  where deleted_at is null;

-- ---------------------------------------------------------------------
-- 3. ONE VIEW, EIGHT CHECKS (FR-09, S-10)
--
-- FR-09 proposed seven and the roadmap settled seven; this is eight,
-- and the differences are worth stating rather than leaving to be
-- noticed.
--
--   * FR-09's "FMV below NBV" is NOT here. Net book value is the largest
--     item in the register and is blocked on Q-5 and Q-6 -- there is no
--     NBV in the schema to compare against, so the check cannot be
--     written, let alone got wrong.
--
--   * The roadmap replaced it with "exit-status mismatch", which F4
--     created the conditions for and which is check 7.
--
--   * "Round captured by VC, not confirmed by Finance" (check 3) IS
--     HERE BUT IS NOT WHAT IT SAYS. It assumed a handoff: the deal lead
--     captures, Finance confirms. Confirmed 21 August 2026 that FINANCE
--     ENTERS THESE ROUNDS, not the VC team -- so a `finance_confirmed_at`
--     column would have been Finance signing off its own typing, a
--     column that means nothing and fires on all 178 rounds until
--     somebody clicks 178 times.
--
--     What FR-09 actually calls it is "awaiting accounting
--     classification", and that IS real and is derivable today: a round
--     whose live cheques carry no instrument (F0 left 104 of 284 NULL,
--     honestly) or no vehicle (ADR-030). No new column, no invented
--     workflow, and true whoever typed the round in.
--
--   * Check 8, the overdrawn LP position, is F5's. ADR-037 clause 5 put
--     `overdrawn` on the view precisely so this surface could read a
--     column rather than re-derive a rule.
--
-- EVERY ROW NAMES TWO FIGURES WHERE THERE ARE TWO. That is FR-09's
-- actual requirement -- "flag discrepancies where VC and Finance have
-- entered conflicting information" -- and a row that says only "this is
-- wrong" sends the reader back to three screens to find out how wrong.
-- Where a check has no second figure (an unlinked cheque disagrees with
-- nothing) both are NULL and the detail sentence carries it.
--
-- SEVERITY IS NOT A COLUMN. Every row here is something a person has to
-- look at; ranking them would invent a priority nobody agreed, and the
-- screen groups by check instead.
-- ---------------------------------------------------------------------

create or replace view pc.v_reconciliation as

-- 1. A cheque nobody has linked and nobody has confirmed as standalone.
--    F1 built `standalone_confirmed_at` so this can reach zero; without
--    it the surface would report 31 forever because 31 are correct.
select 'unlinked-cheque'                                    as check_kind,
       'transaction'                                        as subject_table,
       t.transaction_id::text                               as subject_id,
       t.company_id                                         as company_id,
       c.name                                               as company_name,
       -- The RAW txn_type, not a label. `TXN_TYPE_LABELS` in the web layer
       -- is the one place those words live (FR-33 renamed the stored values
       -- at F5 precisely so it can be), and a SQL copy of that map would be
       -- a second thing to keep in step for no gain.
       t.txn_type                                           as subject_label,
       t.txn_date                                           as subject_date,
       t.amount                                             as figure_a,
       'Cheque'                                             as figure_a_label,
       null::numeric                                        as figure_b,
       null::text                                           as figure_b_label,
       'Booked against no round, and nobody has confirmed it belongs to none.'
                                                            as detail
  from pc.transaction t
  join pc.v_transaction_live v on v.transaction_id = t.transaction_id
  join pc.company c            on c.company_id     = t.company_id
 where t.company_id is not null
   and t.txn_type in ('investment', 'follow_on')
   and t.investment_round_id is null
   and t.standalone_confirmed_at is null

union all

-- 2. We say we were in the round and there is no cheque against it.
--    ADR-033 made participation explicit precisely so this state is
--    distinguishable from "we did not participate".
select 'participated-no-cheque',
       'investment_round',
       r.investment_round_id::text,
       r.company_id,
       c.name,
       r.label,
       r.round_date,
       r.round_total,
       'Round total',
       null::numeric,
       null::text,
       'Marked as participated, but no live investment or follow-on is linked to it.'
  from pc.investment_round r
  join pc.company c on c.company_id = r.company_id
 where r.deleted_at is null
   and r.nbif_participated = 'yes'
   and not exists (
     select 1 from pc.v_transaction_live t
      where t.investment_round_id = r.investment_round_id
        and t.txn_type in ('investment', 'follow_on'))

union all

-- 3. Awaiting accounting classification. See section 3's note: this is
--    FR-09's third check, built as what it means rather than as the
--    handoff it assumed.
select 'unclassified-round',
       'investment_round',
       r.investment_round_id::text,
       r.company_id,
       c.name,
       r.label,
       r.round_date,
       cheques.n::numeric,
       'Cheques',
       cheques.unclassified::numeric,
       'Unclassified',
       case
         when cheques.no_instrument > 0 and cheques.no_vehicle > 0
           then 'Cheques in this round carry no instrument and no vehicle.'
         when cheques.no_instrument > 0
           then 'Cheques in this round carry no instrument classification.'
         else 'Cheques in this round carry no investment vehicle (ADR-030).'
       end
  from pc.investment_round r
  join pc.company c on c.company_id = r.company_id
  join lateral (
    select count(*)                                                       as n,
           count(*) filter (where t.instrument_id is null)                as no_instrument,
           count(*) filter (where t.investment_vehicle_id is null)        as no_vehicle,
           count(*) filter (where t.instrument_id is null
                               or t.investment_vehicle_id is null)        as unclassified
      from pc.transaction t
      join pc.v_transaction_live v on v.transaction_id = t.transaction_id
     where t.investment_round_id = r.investment_round_id
       and t.txn_type in ('investment', 'follow_on')) cheques on true
 where r.deleted_at is null
   and cheques.n > 0
   and cheques.unclassified > 0

union all

-- 4. S-10, and the reason this whole surface exists. `nb_other` and the
--    NB co-investor amounts are two separate captures of one quantity;
--    the mandate KPI uses `nb_other` and nothing has ever shown the
--    disagreement outside the capture form.
select 'coinvestor-sum-mismatch',
       'investment_round',
       r.investment_round_id::text,
       r.company_id,
       c.name,
       r.label,
       r.round_date,
       r.nb_other,
       'NB other (KPI)',
       nb.total,
       'Σ NB co-investors',
       'The mandate KPI reads the first figure; the co-investor rows sum to the second.'
  from pc.investment_round r
  join pc.company c on c.company_id = r.company_id
  join lateral (
    select sum(rc.amount) as total
      from pc.round_coinvestor rc
     where rc.investment_round_id = r.investment_round_id
       and rc.is_nb_based
       and rc.deleted_at is null) nb on true
 where r.deleted_at is null
   and r.nb_other is not null
   and nb.total is not null
   and nb.total <> r.nb_other

union all

-- 5. A round smaller than our own cheque. Already accepted and flagged
--    at capture (ADR-012) and already excluded from leverage
--    (v_round_leverage's predicate); what it has never had is a place
--    that lists it after the form is closed.
select 'round-total-below-cheque',
       'investment_round',
       r.investment_round_id::text,
       r.company_id,
       c.name,
       r.label,
       r.round_date,
       r.round_total,
       'Round total',
       ours.invested,
       'Our cheque',
       'The round is smaller than our participation in it, so it is excluded from leverage.'
  from pc.investment_round r
  join pc.company c on c.company_id = r.company_id
  join lateral (
    select coalesce(sum(t.amount_cad), 0) as invested
      from pc.v_transaction_live t
     where t.investment_round_id = r.investment_round_id
       and t.txn_type in ('investment', 'follow_on')) ours on true
 where r.deleted_at is null
   and r.round_total is not null
   and r.round_total < ours.invested

union all

-- 6. D-3, and the reason F2 stored `basis_fmv` rather than looking it
--    up. A review is applied to a basis; if that basis mark is later
--    corrected, every mark derived from it was computed from a figure
--    that no longer exists. Storing the basis is what makes that
--    DETECTABLE instead of silent, and this is the detection.
select 'mark-basis-drift',
       'valuation_mark',
       m.valuation_mark_id::text,
       m.company_id,
       c.name,
       m.method_label,
       m.effective_date,
       m.basis_fmv,
       'Basis as applied',
       b.fmv,
       'Basis mark now',
       'This mark was computed from a basis that has since been corrected.'
  from pc.valuation_mark m
  join pc.valuation_mark b on b.valuation_mark_id = m.basis_mark_id
  join pc.company c        on c.company_id        = m.company_id
 where m.deleted_at is null
   and b.deleted_at is null
   and m.basis_fmv is distinct from b.fmv

union all

-- 7. ADR-036 clause 2, made visible. Membership is the VC team's fact in
--    Affinity and the exit event is Finance's fact here, and the two are
--    ALLOWED to disagree for a period. What they should not do is
--    disagree unnoticed.
select 'exit-status-mismatch',
       'company',
       c.company_id,
       c.company_id,
       c.name,
       coalesce(cs.roster_status, 'no roster status'),
       ce.exit_date,
       null::numeric,
       null::text,
       null::numeric,
       null::text,
       case
         when ce.company_id is null
           then 'Affinity''s roster says this company has exited; Finance has recorded no exit event.'
         else 'Finance has recorded an exit; Affinity''s roster still counts the company as ours.'
       end
  from pc.company c
  left join pc.company_exit ce on ce.company_id = c.company_id
  left join lateral (
    select cst.roster_status
      from pc.company_state cst
     where cst.company_id = c.company_id and cst.effective_to is null
     limit 1) cs on true
  left join pc.affinity_status_map m on m.affinity_status = cs.roster_status
 where m.affinity_status is not null
   and m.is_exited <> (ce.company_id is not null)

union all

-- 8. F5's, and the reason ADR-037 clause 5 put the flag on the view.
--    Accepted and flagged, never refused -- a recallable distribution
--    redrawn, a side letter nobody has keyed yet.
select 'lp-overdrawn',
       'fund_investment',
       lp.fund_investment_id,
       null::text,
       lp.name,
       'Committed Capital',
       null::date,
       lp.committed,
       'Committed',
       lp.called,
       'Drawn',
       'This position has been drawn beyond the commitment in force.'
  from pc.v_lp_position_current lp
 where lp.overdrawn;

comment on view pc.v_reconciliation is
  'FR-09, S-10, F6. Eight data-integrity checks in one place, each naming the subject, the company and the two figures that disagree. NOT a health or alert surface (that is A9): everything here is a disagreement between two captures of the same fact, or a fact nobody has finished recording. `severity` is deliberately absent -- every row is something a person has to look at, and ranking them would invent a priority nobody agreed.';

-- A count per check, for the screen's summary row and for anyone who
-- wants the trend without pulling 200 rows.
create or replace view pc.v_reconciliation_summary as
select check_kind, count(*) as open_items
  from pc.v_reconciliation
 group by check_kind;

comment on view pc.v_reconciliation_summary is
  'F6. One row per check with its open count. Zero-count checks are ABSENT rather than reported as zero -- the read path supplies the full list of eight and fills the gaps, because a view cannot name a check that has no rows without hardcoding the vocabulary in a second place.';
