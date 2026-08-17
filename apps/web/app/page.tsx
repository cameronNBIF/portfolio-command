/**
 * The application's entry point, and A3's exit criterion made concrete: the
 * portfolio now comes from Postgres rather than from `docs/reference/demo.json`.
 *
 * A server component, so the document is assembled through `packages/api` on
 * the server and the client receives the same ADR-001 shape it received from
 * the fixture at A2. Nothing in `PortfolioApp` or the eight tabs changed to
 * accommodate it, which is the property ADR-020 promised and the reason A2
 * could be built ahead of the backend at all.
 *
 * IT CALLS THE API LAYER DIRECTLY RATHER THAN FETCHING ITS OWN HTTP ENDPOINT.
 * `GET /api/v1/export` exists and serves the identical document via the
 * identical function -- it is the contract for Daniel's export/re-import loop
 * and for any external consumer. But a server component fetching its own origin
 * has to reconstruct a bearer token it already has the identity for, and adds a
 * network hop and a second failure mode to a call that is otherwise a function
 * invocation. Both paths run the same authorisation and the same adapter.
 */
import { headers } from 'next/headers';

import {
  buildExport,
  CAN_READ,
  db,
  readKpiCoverage,
  requireRole,
  resolveAsOf,
  resolvePrincipal,
} from '@portfolio-command/api';

import { PortfolioApp } from './PortfolioApp';

// Board numbers are never served from a cache. The portfolio changes when
// someone writes to it, and a stale figure is worse than a slow page.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const principal = await resolvePrincipal(db(), await headers());
  requireRole(principal, CAN_READ);

  // Derived from the latest final valuation mark, never from the clock, so the
  // page reproduces itself and its date is the date its marks are as at
  // (ADR-007, ADR-021).
  const asOf = await resolveAsOf(db());
  const doc = await buildExport(db(), { asOf });

  // Read alongside the document, not inside it. Coverage is a statement about
  // the data rather than part of it, and the ADR-001 shape is frozen (A5).
  const kpiCoverage = await readKpiCoverage(db());

  // The role decides whether the Finance tab is offered (A7). Passed as a
  // string rather than the whole principal: the client needs to know what this
  // user may do, not who they are, and the write path re-checks it server-side
  // on every mutation regardless.
  return <PortfolioApp db={doc} asOf={asOf} kpiCoverage={kpiCoverage} role={principal.role} />;
}
