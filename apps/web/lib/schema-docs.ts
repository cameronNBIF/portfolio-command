/**
 * The Data tab's reference documentation, extracted VERBATIM from the
 * prototype (docs/reference/vc-toolkit.html) rather than transcribed, so it
 * cannot drift by typo.
 *
 * The annotated JSON schema below is the ADR-001 contract as Daniel documents
 * it. It is what his import/export workflow is written against, and
 * packages/contract is the same shape expressed in TypeScript -- neither may
 * move without the other.
 */

/** CSV column specs, one per entity. Header order is part of the contract. */
export const CSV_SPECS: Record<string, string> = {
  companies: "id,name,sector,stage,vintage,instrument,health,ownership_pct,invested_m,fmv_m,realized_m,pro_rata,reserves_allocated_m,reserves_deployed_m,board_seat,board_holder,next_meeting,exited,source,fte,fte_nb,fte_at_entry,women_csuite,csuite_size",
  rounds: "company_id,date,label,instrument,invested_m,round_total_m,nb_other_m,post_money_m,ownership_after_pct,lead,note",
  marks: "company_id,date,fmv_m,method,marked_by,rationale",
  kpis: "company_id,period,revenue_m,monthly_burn_m,cash_m,runway_months",
  fund_investments: "id,name,manager,strategy,vintage,committed_m,called_m,distributions_m,nav_m,co_invest_rights,capital_to_direct_m,women_senior_gp,next_call_date,agm_date,rationale",
  fund_cashflows: "fund_id,date,amount_m"
};

/** The annotated JSON schema rendered in the Data tab. */
export const JSON_SCHEMA_EXAMPLE = `{
  "fund": {
    "name": "Ridgeline Direct Investments",
    "currency": "USD", "vintage": 2019,        // vintage = inception year
    "style": "evergreen",                      // "evergreen" | "closed-end" - switches labels and metrics
    "capitalBase": 400,                        // $M permanent capital (evergreen)
    "committed": 400, "called": 310,           // $M (closed-end only)
    "distributionPolicy": "Realized proceeds recycle ...",
    "feeDragPct": 2.3,                         // used for net IRR estimate
    "navHistory": [{ "q": "2026-Q1", "nav": 498.5, "cost": 269.0 }],   // quarterly - drives FMV growth KPIs
    "annualPlatformTarget": 5, "ytdPlatformsClosed": 2,
    "distributions": [{ "date": "2024-10-15", "amount": 27.5, "company": "Solvine", "note": "..." }]
  },
  "companies": [{
    "id": "C001", "name": "...", "sector": "...", "stage": "Series B", "vintage": 2021,
    "health": "green|yellow|red", "riskFlags": ["..."],
    "instrument": "SAFE|Convertible Note|Debt-to-Note|Preferred Equity|Common Equity",
    "ownershipPct": 11.2, "invested": 8.5, "fmv": 24.7, "realized": 0,   // all $M
    "exited": false, "proRata": true,
    "reservesAllocated": 4.0, "reservesDeployed": 1.5,
    "board": { "seat": "Director|Observer|None", "holder": "...", "nextMeeting": "2026-08-12" },
    "kpis": [{ "period": "2026-Q1", "revenue": 14.2, "burn": 0.9, "cash": 22.4, "runwayMo": 25 }],
    "thresholds": { "minRunwayMo": 12 },       // drives dashboard alerts
    "source": "University spinout",            // sourcing channel - drives the sourcing chart
    "fte": 145, "fteNB": 98, "fteAtEntry": 38, // jobs KPI: total / in-NB / at entry
    "womenCSuite": 2, "cSuiteSize": 5,         // diversity KPI
    "rounds": [{ "date": "2021-03-15", "label": "Series A", "instrument": "...",
                 "invested": 5.0, "roundTotal": 12,          // roundTotal drives the leverage KPI
                 "nbOther": 1.5,                             // $M from other NB investors (excl. us) - NB co-investment KPI
                 "postMoney": 42, "ownershipAfter": 11.9, "lead": "Us", "note": "..." }],
    "milestones": [{ "title": "...", "due": "2026-12-31", "status": "on-track|at-risk|pending" }],
    "covenants": [{ "text": "...", "status": "compliant|watch|breached" }],
    "govFunding": { "program": "...", "amount": 45, "conditions": "...", "status": "active|conditions pending" },
    "marks": [{ "date": "2026-03-31", "fmv": 24.7, "method": "...", "by": "...", "rationale": "..." }],
    "tasks": [{ "title": "...", "due": "2026-08-05", "done": false }]
  }],
  "pipeline": [{
    "id": "P001", "name": "...", "sector": "...", "funnel": "Sourced|Screening|Diligence|IC Review|Term Sheet|Closed|Passed",
    "source": "...", "checkSize": 7.0, "valuation": 52, "owner": "...", "nextStep": "...", "added": "2026-04-02",
    "gates": [{ "name": "Initial screen", "status": "pending|in-progress|passed|failed" }],
    "termSheet": { "security": "...", "preMoney": 45, "postMoney": 52, "investment": 7.0, "ownership": 13.5,
                   "liquidation": "...", "antiDilution": "...", "board": "...", "proRata": "...",
                   "dividends": "...", "optionPool": "...", "founderVesting": "..." }
  }],
  "fundInvestments": [{                       // strategic LP positions - separate from direct portfolio
    "id": "F001", "name": "Meridian Growth Fund III", "manager": "...", "strategy": "Growth equity",
    "vintage": 2021, "committed": 15, "called": 11.0, "distributions": 1.5, "nav": 13.8,   // all $M
    "coInvestRights": true, "coInvestsDone": 2, "referrals": 3,
    "capitalToDirect": 6.5,                    // $M this fund (and its network) deployed into our direct portfolio
    "womenSeniorGP": true,                     // women in the manager's senior leadership
    "nextCallEst": "2026-09-30", "agm": "2026-10-15", "contact": "...", "rationale": "...",
    "cashflows": [{ "date": "2021-06-30", "amount": -3.0 }]   // negative = call, positive = distribution
  }],
  "memos": {}   // keyed by company/deal id; section text
}`;

/** The metric-conventions note printed beneath the schema. */
export const METRIC_CONVENTIONS =
  `MOIC = (FMV + realized) / invested. TVPI = (NAV + realized proceeds) / invested cost; DPI = realized proceeds / cost; RVPI = NAV / cost - reported in both modes. Gross IRR = since-inception XIRR of round outflows, realizations, and current NAV. Net IRR = gross minus feeDragPct. Evergreen mode adds context rather than removing metrics: proceeds recycle into the capital base (dry powder = capitalBase - invested + realizations), DPI is flagged as recycling-based rather than shareholder distributions, and committed/called framing is replaced by capital base / net deployed. Set fund.style to "closed-end" for a distributing-vehicle presentation.`;
