/**
 * The authorization decision, as a pure function.
 *
 * Nothing here touches the filesystem or a Cordis context, so every rule can be
 * exercised by `node --test` without booting a harness. Callers supply the
 * actor resolved from the conversation and the grants folded from storage.
 *
 * Order of precedence is deliberate: ownership is checked before grants, so
 * "my data is mine" never depends on a grant row existing.
 * @module dsh-family-auth/policy
 */

/** Permissions from weakest to strongest; a stronger grant implies the weaker ones. */
export const PERMISSION_RANK = { read: 1, write: 2, manage: 3 }

/** Wildcard module name. */
export const ANY_MODULE = '*'

/** Reasons a decision can carry; stable strings so callers and tests can assert. */
export const REASON = {
  NO_ACTOR: 'no-actor',
  INACTIVE: 'inactive',
  OWNER: 'owner',
  SELF: 'self',
  GRANT: 'grant',
  NO_GRANT: 'no-grant',
}

function rank(permission) {
  return PERMISSION_RANK[permission] ?? 0
}

function isLive(grant, nowMs) {
  if (!grant || typeof grant !== 'object') return false
  if (grant.revokedAt) return false
  if (grant.expiresAt) {
    const expires = Date.parse(grant.expiresAt)
    if (Number.isFinite(expires) && expires <= nowMs) return false
  }
  return true
}

function coversModule(grant, module) {
  return grant.module === ANY_MODULE || grant.module === module
}

function coversResource(grant, module, resourceOwnerId, resourceId) {
  const scope = grant.scope
  if (!scope || typeof scope !== 'object') return false
  switch (scope.kind) {
    case 'all':
      return true
    case 'owner':
      return typeof resourceOwnerId === 'string'
        && Array.isArray(scope.ownerIds)
        && scope.ownerIds.includes(resourceOwnerId)
    case 'records':
      return typeof resourceId === 'string'
        && Array.isArray(scope.recordIds)
        && scope.recordIds.includes(resourceId)
    default:
      return false
  }
}

/**
 * Decide whether `actor` may perform `action` on a resource.
 *
 * @param {object} input - decision inputs.
 * @param {object|null} input.actor - resolved member, or null when unknown.
 * @param {string} input.action - one of `read`, `write`, `manage`.
 * @param {string} input.module - module name, e.g. `ledger`.
 * @param {string} [input.resourceOwnerId] - owner of the record in question.
 * @param {string} [input.resourceId] - record id, needed for `records` scopes.
 * @param {object[]} [input.grants] - live-or-not grant records; filtering is ours.
 * @param {Date} [input.now] - clock injection for expiry tests.
 * @returns {{allow: boolean, reason: string, grantId?: string}} decision.
 */
export function can({ actor, action, module, resourceOwnerId, resourceId, grants = [], now = new Date() }) {
  if (!actor || typeof actor.id !== 'string') return { allow: false, reason: REASON.NO_ACTOR }
  if (actor.status && actor.status !== 'active') return { allow: false, reason: REASON.INACTIVE }
  if (actor.role === 'owner') return { allow: true, reason: REASON.OWNER }
  if (typeof resourceOwnerId === 'string' && resourceOwnerId === actor.id) {
    return { allow: true, reason: REASON.SELF }
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now))
  const needed = rank(action)
  if (needed === 0) return { allow: false, reason: REASON.NO_GRANT }

  for (const grant of grants) {
    if (!isLive(grant, nowMs)) continue
    if (grant.granteeId !== actor.id) continue
    if (!coversModule(grant, module)) continue
    if (rank(grant.permission) < needed) continue
    if (!coversResource(grant, module, resourceOwnerId, resourceId)) continue
    return { allow: true, reason: REASON.GRANT, grantId: grant.id }
  }

  return { allow: false, reason: REASON.NO_GRANT }
}

/**
 * The owner-id whitelist a list query must apply.
 *
 * Returns `null` when the actor may read everything (unrestricted), otherwise
 * the exact set of owner ids whose rows are visible. Callers must treat `null`
 * as "no filter" and a set as "WHERE owner IN (...)" — an empty set means none.
 *
 * A `records` scope is intentionally not folded in here: it cannot be expressed
 * as an owner whitelist, so it is enforced per-record by `can()` instead.
 *
 * @param {object} input - scope inputs.
 * @param {object|null} input.actor - resolved member.
 * @param {string} input.module - module name.
 * @param {object[]} [input.grants] - grant records.
 * @param {Date} [input.now] - clock injection.
 * @returns {Set<string>|null} visible owner ids, or null for unrestricted.
 */
export function allowedOwnerIds({ actor, module, grants = [], now = new Date() }) {
  if (!actor || typeof actor.id !== 'string') return new Set()
  if (actor.status && actor.status !== 'active') return new Set()
  if (actor.role === 'owner') return null

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now))
  const visible = new Set([actor.id])

  for (const grant of grants) {
    if (!isLive(grant, nowMs)) continue
    if (grant.granteeId !== actor.id) continue
    if (!coversModule(grant, module)) continue
    if (rank(grant.permission) < PERMISSION_RANK.read) continue
    const scope = grant.scope
    if (!scope || typeof scope !== 'object') continue
    if (scope.kind === 'all') return null
    if (scope.kind === 'owner' && Array.isArray(scope.ownerIds)) {
      for (const id of scope.ownerIds) {
        if (typeof id === 'string') visible.add(id)
      }
    }
  }

  return visible
}

/**
 * Fold an append-only grant log into current grant state.
 *
 * A `revoke` entry marks the referenced grant revoked without deleting it, so
 * the audit trail keeps both the grant and the withdrawal.
 * @param {object[]} entries - raw grant/revoke records in file order.
 * @returns {object[]} grants with `revokedAt` set where withdrawn.
 */
export function foldGrants(entries) {
  const byId = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'grant' && typeof entry.id === 'string') {
      byId.set(entry.id, { ...entry, revokedAt: entry.revokedAt ?? null })
    } else if (entry.type === 'revoke' && typeof entry.grantId === 'string') {
      const existing = byId.get(entry.grantId)
      if (existing) existing.revokedAt = entry.at || existing.revokedAt || 'revoked'
    }
  }
  return [...byId.values()]
}
