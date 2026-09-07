import { createAppError } from '@/middleware/errorHandler';

/**
 * Catalogue scoping.
 *
 * A car type or wash type is either shared across the org (branch_id IS NULL)
 * or private to one branch (branch_id = that branch). Every read has to see
 * both; every write has to land in the right one. Both rules live here so
 * they read the same way in each route rather than being retyped — and
 * miscopied — per query.
 */

export type CatalogueActor = {
  role?: string;
  branch_id?: string;
  org_id?: string;
};

/**
 * SQL fragment + params for "the catalogue this caller should see".
 *
 * `nextParam` is the next free positional placeholder number, since these
 * queries already bind org_id (and sometimes more) ahead of the scope clause.
 *
 *   orgadmin, no branch filter -> everything in the org
 *   orgadmin, ?branch_id=X     -> shared + X's own
 *   manager / worker           -> shared + their own branch's, always
 *
 * A manager is never allowed to widen this by passing someone else's
 * branch_id: their token's branch is used regardless of the query string.
 */
export function catalogueScope(
  actor: CatalogueActor,
  requestedBranchId: string | undefined,
  alias: string,
  nextParam: number
): { sql: string; params: any[] } {
  const isBranchBound = actor.role === 'manager' || actor.role === 'worker';
  const branchId = isBranchBound ? actor.branch_id : requestedBranchId;

  // An org admin who asked for no particular branch sees the whole org,
  // including every branch's private types — that is the oversight view.
  if (!branchId) return { sql: '', params: [] };

  return {
    sql: ` AND (${alias}.branch_id IS NULL OR ${alias}.branch_id = $${nextParam})`,
    params: [branchId],
  };
}

/**
 * Which branch_id a new catalogue row should be stamped with.
 *
 * A manager can only ever create for their own branch. An org admin creates
 * org-wide by default, or for a specific branch if they explicitly name one.
 */
export function catalogueWriteBranch(
  actor: CatalogueActor,
  requestedBranchId: string | null | undefined
): string | null {
  if (actor.role === 'manager') {
    if (!actor.branch_id) {
      throw createAppError(400, 'NO_BRANCH', 'Your account is not attached to a branch');
    }
    // Explicitly rejected rather than silently redirected: a manager sending
    // another branch's id is either a bug or an attempt, and quietly writing
    // it to their own branch would hide both.
    if (requestedBranchId && requestedBranchId !== actor.branch_id) {
      throw createAppError(403, 'FORBIDDEN', 'Managers can only manage their own branch');
    }
    return actor.branch_id;
  }
  return requestedBranchId ?? null;
}

/**
 * Guard for editing/deleting an existing row.
 *
 * A manager may only touch rows belonging to their own branch — never a
 * shared org-wide row, which every other branch also depends on.
 */
export function assertCanEditCatalogueRow(
  actor: CatalogueActor,
  row: { branch_id: string | null }
): void {
  if (actor.role !== 'manager') return;

  if (row.branch_id === null) {
    throw createAppError(
      403,
      'SHARED_CATALOGUE_ITEM',
      'This is shared across all branches — only an org admin can change it'
    );
  }
  if (row.branch_id !== actor.branch_id) {
    throw createAppError(403, 'FORBIDDEN', 'This belongs to another branch');
  }
}
