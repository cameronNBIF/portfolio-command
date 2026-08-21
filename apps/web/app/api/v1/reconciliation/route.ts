/**
 * `GET /api/v1/reconciliation` — the eight data-integrity checks (F6, FR-09).
 *
 * Read-only, and it has no POST on purpose. Nothing is fixed *here*: every row
 * names the screen that fixes it and the fix happens there, through the write
 * path that already owns that table. A resolve-from-the-list endpoint would be
 * a second way to change a financial row, bypassing the form that knows the
 * rules — and "mark as resolved" without changing the underlying fact is how a
 * reconciliation list starts lying.
 */
import { db, readReconciliation } from '@portfolio-command/api';

import { withPrincipal } from '../../_lib/handler';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return withPrincipal(request, async (principal) => {
    const q = new URL(request.url).searchParams;
    return readReconciliation(db(), principal, {
      check: q.get('check'),
      limit: q.has('limit') ? Number(q.get('limit')) : undefined,
    });
  });
}
