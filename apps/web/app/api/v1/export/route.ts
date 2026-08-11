/**
 * `GET /api/v1/export` — the ADR-001 contract.
 *
 * The frozen shape, field for field, and the only endpoint the frontend needs
 * to render all eight tabs. It is also what Daniel's export/edit/re-import loop
 * consumes, which is why the response is the whole document rather than a
 * paginated slice: the contract is a document, and half of one is not it.
 *
 * `asOf` is derived from the data (the latest final valuation mark), not read
 * from the clock, so two calls a minute apart return the same numbers and the
 * date on a board report is the date its marks are as at (ADR-007, ADR-021).
 */
import { buildExport, CAN_READ, db, requireRole, resolveAsOf } from '@portfolio-command/api';

import { withPrincipal } from '../../_lib/handler';

// The portfolio changes when someone writes to it, not on a timer, and a cached
// board number is worse than a slow one.
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    requireRole(principal, CAN_READ);
    const asOf = await resolveAsOf(db());
    return buildExport(db(), { asOf });
  });
}
