/**
 * Typed views over the append-only tables.
 *
 * Each table is a log; these folds turn it into current state. Reads are cheap
 * because a household has tens of rows, not millions, and re-folding means the
 * process never holds stale shadow state that a crash could desynchronize.
 * @module dsh-family-auth/repo
 */

import { newId, normalizeName, nowIso } from './util.js'
import { foldGrants } from './policy.js'

/** Table names, so a typo is a missing-file error rather than silent data loss. */
export const TABLE = {
  USERS: 'users',
  BINDINGS: 'bindings',
  GRANTS: 'grants',
  AUDIT: 'audit',
}

/**
 * Fold user records: `add` creates, `update` patches role/status/name.
 * @param {object[]} entries - raw user log.
 * @returns {object[]} current users in creation order.
 */
export function foldUsers(entries) {
  const byId = new Map()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.type === 'add' && typeof entry.id === 'string') {
      byId.set(entry.id, { ...entry })
    } else if (entry.type === 'update' && typeof entry.id === 'string') {
      const current = byId.get(entry.id)
      if (current) Object.assign(current, entry.patch || {}, { updatedAt: entry.at })
    }
  }
  return [...byId.values()]
}

/**
 * Fold a name into its comparison key. Names are the human-facing identity, so
 * they compare case-insensitively and whitespace-insensitively.
 * @param {unknown} name - raw name.
 * @returns {string} comparison key.
 */
export function nameKey(name) {
  return normalizeName(name).toLowerCase()
}

/**
 * Create the repository over a store.
 * @param {ReturnType<import('./store.js').createStore>} store - storage handle.
 * @returns {object} repository.
 */
export function createRepo(store) {
  const repo = {
    store,

    // ---------------------------------------------------------------- users

    /** @returns {object[]} current members. */
    users() {
      return foldUsers(store.read(TABLE.USERS))
    },

    /**
     * Look a member up by exact (case/space-insensitive) name.
     * @param {string} name - claimed name.
     * @returns {object|undefined} matching member.
     */
    findUserByName(name) {
      const key = nameKey(name)
      if (key.length === 0) return undefined
      return repo.users().find((user) => nameKey(user.name) === key)
    },

    /**
     * Look a member up by id.
     * @param {string} id - member id.
     * @returns {object|undefined} matching member.
     */
    findUserById(id) {
      return repo.users().find((user) => user.id === id)
    },

    /**
     * Append a new member. Names are unique by comparison key.
     * @param {object} input - member fields.
     * @param {string} input.name - display name.
     * @param {string} [input.role] - `owner`, `member` or `guest`.
     * @param {string} [input.source] - why this member exists, for the audit trail.
     * @returns {object} created member.
     * @throws {Error} with `code === 'NAME_TAKEN'` when the name is in use.
     */
    addUser({ name, role = 'member', source = 'manual' }) {
      const cleaned = normalizeName(name)
      if (cleaned.length === 0) {
        const error = new Error('member name is required')
        error.code = 'EMPTY_NAME'
        throw error
      }
      if (repo.findUserByName(cleaned)) {
        const error = new Error('member name already exists: ' + cleaned)
        error.code = 'NAME_TAKEN'
        throw error
      }
      const user = {
        type: 'add',
        id: newId('u'),
        name: cleaned,
        role: role === 'owner' ? 'owner' : role === 'guest' ? 'guest' : 'member',
        status: 'active',
        source,
        createdAt: nowIso(),
      }
      store.append(TABLE.USERS, user)
      return user
    },

    /**
     * Patch a member. Only `role`, `status` and `name` are patchable.
     * @param {string} id - member id.
     * @param {object} patch - fields to change.
     * @returns {object} the patched member.
     */
    updateUser(id, patch) {
      const current = repo.findUserById(id)
      if (!current) {
        const error = new Error('no such member: ' + id)
        error.code = 'NO_SUCH_USER'
        throw error
      }
      const safe = {}
      for (const key of ['role', 'status', 'name']) {
        if (patch[key] !== undefined) safe[key] = patch[key]
      }
      store.append(TABLE.USERS, { type: 'update', id, patch: safe, at: nowIso() })
      return { ...current, ...safe }
    },

    // ------------------------------------------------------------- bindings

    /**
     * Current session-to-member map. A later `bind` for the same session wins.
     * @returns {Map<string, object>} bindings keyed by session id.
     */
    bindingMap() {
      const map = new Map()
      for (const entry of store.read(TABLE.BINDINGS)) {
        if (!entry || typeof entry !== 'object') continue
        if (entry.type === 'bind' && typeof entry.sessionId === 'string' && typeof entry.userId === 'string') {
          map.set(entry.sessionId, { ...entry })
        } else if (entry.type === 'unbind' && typeof entry.sessionId === 'string') {
          map.delete(entry.sessionId)
        }
      }
      return map
    },

    /**
     * Bind a conversation to a member. Rebinding is allowed and recorded.
     * @param {string} sessionId - DSH session id.
     * @param {string} userId - member id.
     * @param {object} [meta] - `source` and `note`.
     * @returns {object} binding record.
     */
    bind(sessionId, userId, meta = {}) {
      const record = {
        type: 'bind',
        sessionId,
        userId,
        source: meta.source || 'user-declared',
        note: meta.note || '',
        boundAt: nowIso(),
      }
      store.append(TABLE.BINDINGS, record)
      return record
    },

    /**
     * Forget a conversation's member.
     * @param {string} sessionId - DSH session id.
     * @returns {boolean} whether a binding existed.
     */
    unbind(sessionId) {
      const existed = repo.bindingMap().has(sessionId)
      store.append(TABLE.BINDINGS, { type: 'unbind', sessionId, at: nowIso() })
      return existed
    },

    /**
     * Resolve the member a conversation currently belongs to.
     * @param {string} sessionId - DSH session id.
     * @returns {object|null} member, or null when unbound or stale.
     */
    actorForSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      const binding = repo.bindingMap().get(sessionId)
      if (!binding) return null
      const user = repo.findUserById(binding.userId)
      if (!user || user.status !== 'active') return null
      return user
    },

    // --------------------------------------------------------------- grants

    /** @returns {object[]} current grants, revoked ones included with `revokedAt`. */
    grants() {
      return foldGrants(store.read(TABLE.GRANTS))
    },

    /** @returns {object[]} grants that are still live. */
    liveGrants() {
      return repo.grants().filter((grant) => !grant.revokedAt)
    },

    /**
     * @param {string} granteeId - member id.
     * @returns {object[]} live grants held by that member.
     */
    grantsFor(granteeId) {
      return repo.liveGrants().filter((grant) => grant.granteeId === granteeId)
    },

    /**
     * Record a grant.
     * @param {object} grant - `granteeId`, `module`, `permission`, `scope`.
     * @param {object} meta - `grantedBy`, optional `expiresAt`, `note`.
     * @returns {object} the stored grant.
     */
    addGrant(grant, meta) {
      const record = {
        type: 'grant',
        id: newId('g'),
        granteeId: grant.granteeId,
        module: grant.module || '*',
        permission: grant.permission || 'read',
        scope: grant.scope || { kind: 'all' },
        grantedBy: meta.grantedBy,
        grantedAt: nowIso(),
        expiresAt: meta.expiresAt || null,
        note: meta.note || '',
        revokedAt: null,
      }
      store.append(TABLE.GRANTS, record)
      return record
    },

    /**
     * Withdraw a grant without deleting its history.
     * @param {string} grantId - grant id.
     * @param {string} by - acting member id.
     * @returns {object} the revoke record.
     */
    revokeGrant(grantId, by) {
      const record = { type: 'revoke', grantId, by, at: nowIso() }
      store.append(TABLE.GRANTS, record)
      return record
    },

    // ---------------------------------------------------------------- audit

    /**
     * Append an authorization decision. Allows are recorded too: the audit log
     * is the only evidence that a read did not cross members.
     * @param {object} record - decision context.
     * @returns {object} the stored record.
     */
    auditDecision(record) {
      const entry = { type: 'audit', at: nowIso(), ...record }
      store.append(TABLE.AUDIT, entry)
      return entry
    },

    /**
     * @param {number} [limit] - most recent entries to return.
     * @returns {object[]} audit entries, newest last.
     */
    auditLog(limit = 50) {
      const all = store.read(TABLE.AUDIT)
      return limit > 0 ? all.slice(-limit) : all
    },
  }

  return repo
}
