-- =====================================================================
-- 0004 · An index on transaction.investment_round_id
--
-- One index, and it is here rather than folded into 0003 because it is a
-- performance fix with a measurement behind it rather than part of the
-- A8 feature.
--
-- WHAT NEEDS IT. Two hot queries join transactions to their round through
-- a lateral, once per round:
--
--   * the ADR-001 export adapter's round query (packages/api/src/read/
--     export.ts), which runs on EVERY page render because page.tsx is
--     force-dynamic and board numbers are never served from a cache;
--   * readRounds (packages/api/src/read/rounds.ts), behind the Deal Close
--     tab.
--
-- `transaction` carried three indexes -- (company_id, txn_date),
-- (fund_investment_id, txn_date) and (txn_type, txn_date) -- and none on
-- investment_round_id, so both laterals fell back to a sequential scan of
-- the whole transaction table once per round.
--
-- MEASURED, NOT ASSUMED, and the honest number is small. On the A6
-- dataset (177 rounds, 282 transactions), `explain (analyze, buffers)`
-- over the export adapter's round query:
--
--   without the index   Seq Scan on transaction, loops=177,  889 buffers
--   with the index      Index Scan,              loops=177,  360 buffers
--
-- Both complete in under a millisecond. On the smaller reference fixture
-- the planner correctly ignores the index altogether and seq-scans three
-- pages, which is the right choice at that size. So this buys nothing
-- today and would be a poor reason to add an index on its own.
--
-- It goes in now for the SHAPE rather than the number. The work is
-- O(rounds x transactions) and only the constant is small: A13 loads
-- Finance's full history since inception (ADR-015), fifteen years or more
-- for some companies. At a few thousand transactions across several
-- hundred rounds the un-indexed plan visits millions of rows to render
-- one dashboard, on the page that is force-dynamic precisely because
-- board numbers must never come from a cache. An index added before the
-- data arrives costs nothing; the same index added after arrives as an
-- incident on a screen that used to be fast.
--
-- Plain btree on the single column, matching the convention of the three
-- already there. Not partial on `investment_round_id is not null` despite
-- most LP transactions carrying a null: the nulls are a minority of the
-- table, the saving is trivial at this size, and a partial index is one
-- more thing whose predicate has to be kept in step with the queries.
-- =====================================================================

set search_path = pc, public;

create index on pc.transaction (investment_round_id);

comment on index pc.transaction_investment_round_id_idx is
  'Serves the per-round lateral in the ADR-001 export adapter and in readRounds. Both run once per round and were sequential-scanning the whole table before it. Added at A8 for the A13 row counts, not for the current ones (see migration 0004).';
