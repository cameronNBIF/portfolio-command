-- =====================================================================
-- 0010 · F3 — Ownership maintenance, and the significant-influence policy
--
-- Closes FR-36 and the storage half of FR-21. Lands ADR-035. Four
-- changes, and the first two are one idea:
--
--   1. company_ownership gains `change_reason` and an optional link to
--      the round that caused it. Ownership stops being a by-product of
--      capturing a round and becomes a fact somebody can maintain.
--   2. That link is backfilled FROM EVIDENCE ONLY -- a live round of the
--      same company on the same date -- and from nothing else.
--   3. fund_accounting_policy, effective-dated on the fund_alert_policy
--      pattern, holding the significant-influence threshold.
--   4. significant_influence_asof(), which returns NULL -- never false --
--      when there is no ownership figure or no policy in force.
--
-- THESE ARE ONE MIGRATION BECAUSE THE SECOND IS WORTHLESS WITHOUT THE
-- FIRST. A significant-influence flag derived from a stale ownership
-- percentage is worse than no flag, because it looks authoritative.
-- Q-15 settled how ownership stays current: Finance enters adjustments
-- ad hoc, as word of the event reaches them, with no cadence -- and
-- until this migration there was no way to record one that was not
-- attached to a round we captured.
--
-- NO NUMBER MOVES. Every ownership_pct is untouched, the two columns
-- added are additive and nullable, and the policy table is created
-- EMPTY (section 3).
-- =====================================================================

set search_path = pc, public;

-- ---------------------------------------------------------------------
-- 1. AN OWNERSHIP ROW SAYS WHAT CAUSED IT (ADR-035 clause 1)
--
-- `company_ownership` has been dated, structured and correct in shape
-- since 0001, and written by exactly one thing: the Deal Close capture
-- form, as part of capturing a round. The events Q-15 names -- an option
-- pool expansion, a round we did not participate in, a secondary -- move
-- the cap table with no round of ours to hang them on, and the table had
-- nowhere to put the answer to "why did this change".
--
-- That answer is not decoration. This table feeds MOIC, the waterfall,
-- and from section 4 the accounting treatment of the company. A figure
-- that cannot say where it came from is one nobody can defend six months
-- later, in front of the person who signs the statements.
--
-- TWO COLUMNS RATHER THAN ONE, because the two paths know different
-- things. A standalone adjustment knows the reason and not the round; a
-- deal-close capture knows the round, AND THERE THE ROUND IS THE REASON.
-- Requiring prose from the second would get "Series B" typed into a box
-- beside the Series B it is already pointing at.
-- ---------------------------------------------------------------------

alter table pc.company_ownership
  -- Required by the STANDALONE write path, not by the database. See the
  -- note below on why there is no CHECK.
  add column change_reason text,
  add column investment_round_id bigint references pc.investment_round;

comment on column pc.company_ownership.change_reason is
  'FR-36, ADR-035 clause 1. What moved the cap table: an option pool expansion, a round we sat out, a secondary. REQUIRED by the standalone entry path and left null by the deal-close path, where investment_round_id carries the same information and the round IS the reason.';
comment on column pc.company_ownership.investment_round_id is
  'ADR-035 clause 1. The round that caused this position, where one did. Null on an ad-hoc adjustment between rounds -- the case FR-36 exists to make possible -- and on a legacy row whose causing round cannot be identified from evidence.';

-- WHY THERE IS NO `check (change_reason is not null or
-- investment_round_id is not null)`, which is the constraint this
-- section obviously wants.
--
-- 179 rows predate the requirement and 2 of them satisfy neither
-- predicate after the backfill below: their causing rounds were captured
-- through the A8 form and have since been soft-deleted. A validated
-- CHECK would refuse the migration. A `not valid` one would let those
-- rows sit and then fail the next UPDATE against either of them --
-- INCLUDING A SOFT DELETE, which is how a row in that state gets tidied
-- away. The operator would meet a constraint error on the one action
-- that resolves what the constraint is complaining about.
--
-- So the rule lives in the write path, where it can say a sentence, and
-- the F3 report makes a row with neither VISIBLE rather than legal.

create index on pc.company_ownership (investment_round_id);

-- ---------------------------------------------------------------------
-- 2. THE BACKFILL, FROM EVIDENCE AND NOTHING ELSE
--
-- The rule migration 0008 applied to round participation, for the same
-- reason: a link inferred from a coincidence is worse than a null,
-- because a null says "we do not know" and a wrong link says something
-- false with the same confidence as a right one.
--
-- The evidence here is exact: an ownership row whose date is the date of
-- EXACTLY ONE live round of the same company. The deal-close form writes
-- the pair in one transaction at one date, so that pattern is not a
-- coincidence -- it is the form's signature. Where two rounds share a
-- date, or where no live round does, the column stays null.
--
-- MEASURED BEFORE WRITTEN: 177 of 179 rows have exactly one, none is
-- ambiguous, and 2 have none. Those two are real -- not synthetic --
-- rows entered through the A8 form on 18 August 2026 whose rounds were
-- soft-deleted afterwards. They are the finding rather than a gap in it:
-- an ownership figure standing on a round that no longer exists is
-- exactly what the F3 report is for.
--
-- THE VERSION TRIGGER IS SCOPED OFF FOR THE STATEMENT, on the reading
-- F0, F1 and F2 all recorded: this initialises a column added in the
-- same migration, by a rule stated in the same migration, from rows the
-- ownership row already implies. The ADR-031 guarantee is untouched and
-- no financial fact changes. Left on, it would write 177 version rows
-- and set `row_updated_at`, and every one of those positions would claim
-- on screen to have been edited by somebody.
-- ---------------------------------------------------------------------

alter table pc.company_ownership disable trigger zz_version_company_ownership;

update pc.company_ownership co
   set investment_round_id = r.investment_round_id
  from pc.investment_round r
 where r.company_id = co.company_id
   and r.round_date = co.as_of_date
   and r.deleted_at is null
   and co.investment_round_id is null
   and (select count(*) from pc.investment_round r2
         where r2.company_id = co.company_id
           and r2.round_date = co.as_of_date
           and r2.deleted_at is null) = 1;

alter table pc.company_ownership enable trigger zz_version_company_ownership;

-- ---------------------------------------------------------------------
-- 3. THE ACCOUNTING POLICY (ADR-035 clause 2, FR-21)
--
-- Pat asked for a configurable significant-influence threshold with
-- automatic flagging and a report. 10% is the standard rule.
--
-- EFFECTIVE-DATED, ON THE fund_alert_policy PATTERN AND FOR THE SAME
-- ARGUMENT. This drives financial-statement treatment. A prior period's
-- classification has to stay reproducible, and a policy that silently
-- rewrote itself would reclassify a company inside a board pack issued
-- before the change. Setting a threshold SUPERSEDES the current row --
-- closes it and opens a new one -- rather than updating it; the write
-- path is what enforces that.
--
-- EVERY COLUMN IS NULLABLE AND NULL MEANS "NO POLICY FOR THIS", never a
-- default. Same rule as fund_alert_policy, and section 4 is where it
-- earns its keep: no threshold means the flag reads NULL, not false.
--
-- THERE IS NO fund_id, AND THAT IS THE ONE PLACE THIS TABLE DEPARTS FROM
-- THE PATTERN IT COPIES. `fund_alert_policy` is per fund because a
-- watchlist is a fund's watchlist. Significant influence is not: it is a
-- property of NBIF's holding in an investee, `company_ownership` carries
-- no fund dimension at all, and `significant_influence_asof` takes a
-- company and a date. A fund_id here would have to be resolved from a
-- company that has no fund, and that resolution would be an assumption
-- written in SQL -- invisible until the day a second fund exists. The
-- table keeps the name ADR-035 gave it; what it holds is the accounting
-- policy of the reporting entity.
--
-- THE MIGRATION INSERTS NO ROW (ADR-035 clause 3). The behaviour change
-- lands when someone sets the threshold on the Policies screen,
-- deliberately, and not as a side effect of running a migration.
-- Migration 0005 followed the same rule for the alert policy, and for
-- the same reason: until a row exists, "nobody has set a policy" and
-- "the policy is 10%" must not look alike.
-- ---------------------------------------------------------------------

create table fund_accounting_policy (
  fund_accounting_policy_id bigint primary key generated always as identity,
  effective_from            date not null default current_date,
  effective_to              date,

  -- Percent as a plain number: 10.000 means 10%, matching the ADR-001
  -- convention and `company_ownership.ownership_pct`, which is what it
  -- gets compared against.
  significant_influence_pct numeric(6,3)
                              check (significant_influence_pct is null
                                     or (significant_influence_pct >= 0
                                         and significant_influence_pct <= 100)),

  set_by                    uuid not null references pc.app_user,
  set_at                    timestamptz not null default now(),
  note                      text,

  constraint fund_accounting_policy_period
    check (effective_to is null or effective_to >= effective_from)
);

-- One open row at a time. Indexed on a constant rather than on a fund
-- key, because the table has no fund dimension -- see the note above.
create unique index fund_accounting_policy_current_uq
  on fund_accounting_policy ((true)) where effective_to is null;
create index on fund_accounting_policy (effective_from);

comment on table fund_accounting_policy is
  'F3, ADR-035 clause 2, FR-21. The accounting policies that drive financial-statement treatment -- today the significant-influence threshold, later whatever follows it. Effective-dated so a classification printed in an issued board pack reproduces against the policy in force when it was issued, not the one in force today. Superseded, never updated.';
comment on column fund_accounting_policy.significant_influence_pct is
  'The ownership percentage at or above which we hold significant influence. 10.000 = 10%, the standard rule Pat named. NULL means no threshold is set, which makes the derived flag NULL rather than false (see significant_influence_asof).';

create view v_fund_accounting_policy_current as
  select p.*, u.display_name as set_by_name
    from fund_accounting_policy p
    join app_user u on u.user_id = p.set_by
   where p.effective_to is null;

comment on view v_fund_accounting_policy_current is
  'F3. The accounting policy in force now. A reader reconstructing a past classification must query fund_accounting_policy with a date, not this view -- exactly as v_fund_alert_policy_current says of itself.';

-- ---------------------------------------------------------------------
-- 4. THE DERIVED FLAG (ADR-035 clause 4)
--
-- Three-valued, and the third value is the whole point.
--
--   true   -- ownership at or above the threshold in force on that date
--   false  -- ownership recorded, and below it
--   NULL   -- we hold no ownership figure, or no policy is in force
--
-- "WE HOLD NO OWNERSHIP FIGURE FOR THIS COMPANY" AND "THIS COMPANY IS
-- BELOW THE THRESHOLD" ARE DIFFERENT STATEMENTS, and reporting the
-- second when the first is true is how a company quietly drops off a
-- schedule an auditor expects to find it on. This is D-5's rule --
-- non-reporters are excluded, never counted as zeros -- applied where
-- the stakes are highest.
--
-- AT OR ABOVE, INCLUSIVELY. A company at exactly 10.0% is flagged. That
-- is the reading of "10% is the standard rule" this code asserts and the
-- report states on screen, so Pat confirms it rather than the code
-- assuming it silently.
--
-- DERIVED, NEVER STORED (ADR-002). It is a function of an ownership row
-- and a policy row, both already facts. A column would be a third copy
-- that goes stale the moment either moves -- and the whole reason FR-21
-- depends on FR-36 is that a stale flag looks authoritative.
--
-- BOTH INPUTS ARE READ AS AT THE DATE, not as at today: the ownership
-- row is the latest live one on or before it, and the policy is the one
-- whose period covers it. Passing last March's date reproduces last
-- March's classification, which is what effective-dating the policy was
-- for.
-- ---------------------------------------------------------------------

create function significant_influence_asof(p_company_id text, p_as_of date)
returns boolean language sql stable as $$
  select case
           when own.ownership_pct is null then null
           when pol.significant_influence_pct is null then null
           else own.ownership_pct >= pol.significant_influence_pct
         end
    from (select 1) one
    left join lateral (
      select co.ownership_pct
        from pc.company_ownership co
       where co.company_id = p_company_id
         and co.as_of_date <= p_as_of
         and co.deleted_at is null
       order by co.as_of_date desc, co.company_ownership_id desc
       limit 1) own on true
    left join lateral (
      select p.significant_influence_pct
        from pc.fund_accounting_policy p
       where p.effective_from <= p_as_of
         and (p.effective_to is null or p.effective_to > p_as_of)
       order by p.effective_from desc, p.fund_accounting_policy_id desc
       limit 1) pol on true
$$;

comment on function significant_influence_asof(text, date) is
  'ADR-035 clause 4. Whether we hold significant influence in this company as at this date: true, false, or NULL when ownership is unrecorded or no policy is in force. NEVER false in those cases -- "no figure" and "below the threshold" are different statements, and reporting the second when the first is true is how a company drops off a schedule an auditor expects to find it on. Inclusive at the threshold.';
