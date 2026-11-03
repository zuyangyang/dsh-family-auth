/**
 * The service other plugins consume: `ctx.familyAuth`.
 *
 * Business plugins never learn how identity is established. They declare a
 * module, then ask three questions: may I write (who am I stamping?), may I
 * touch this specific row, and which owners may my list query see.
 *
 * Every guard fails closed. A missing session, an unbound conversation or a
 * retired member produces an {@link AuthorizationError} rather than a default.
 * @module dsh-family-auth/auth
 */

import { DEFAULT_OWNER } from './config.js'
import { can, allowedOwnerIds } from './policy.js'
import { nowIso } from './util.js'

/** Stable error codes; tool wrappers render one receipt per code. */
export const AUTH_ERROR = {
  NEED_IDENTITY: 'NEED_IDENTITY',
  DENIED: 'DENIED',
  NO_SESSION: 'NO_SESSION',
  UNKNOWN_MODULE: 'UNKNOWN_MODULE',
}

/**
 * Raised by a guard. Carries a machine-readable `code` plus whatever extra
 * context the caller needs to build a helpful message.
 */
export class AuthorizationError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'AuthorizationError'
    this.code = code
    Object.assign(this, details)
  }
}

/**
 * Pull the session id out of a tool execution without trusting anything else.
 * @param {object} exec - DSH tool execution.
 * @returns {string} session id, or an empty string when absent.
 */
export function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' ? id : ''
}

/**
 * Build the authorization service.
 * @param {object} input - service inputs.
 * @param {object} input.repo - repository.
 * @param {object} input.config - normalized config.
 * @returns {object} the `familyAuth` service.
 */
export function createAuthService({ repo, config }) {
  /** Module declarations, for `family_whoami` and documentation. */
  const modules = new Map()

  const service = {
    /**
     * Declare a module so the authorization layer can describe it. Idempotent:
     * re-declaring the same name replaces the metadata.
     * @param {object} definition - module metadata.
     * @param {string} definition.name - module name, e.g. `ledger`.
     * @param {string[]} [definition.permissions] - supported actions.
     * @param {boolean} [definition.ownable] - whether rows carry `ownerId`.
     * @param {string[]} [definition.adminOnly] - actions reserved to the owner.
     * @returns {object} the stored definition.
     */
    defineModule(definition = {}) {
      const name = typeof definition.name === 'string' ? definition.name.trim() : ''
      if (name.length === 0) {
        throw new AuthorizationError(AUTH_ERROR.UNKNOWN_MODULE, 'module name is required')
      }
      const stored = {
        name,
        permissions: Array.isArray(definition.permissions) && definition.permissions.length > 0
          ? [...definition.permissions]
          : ['read', 'write'],
        ownable: definition.ownable !== false,
        adminOnly: Array.isArray(definition.adminOnly) ? [...definition.adminOnly] : [],
      }
      modules.set(name, stored)
      return stored
    },

    /** @returns {object[]} declared modules in declaration order. */
    listModules() {
      return [...modules.values()]
    },

    /**
     * Resolve the member this execution belongs to.
     * @param {object} exec - DSH tool execution.
     * @returns {object|null} member, or null when the conversation is unbound.
     */
    actorOf(exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId.length === 0) return null
      return repo.actorForSession(sessionId)
    },

    /** @returns {string} the session id for this execution, possibly empty. */
    sessionIdOf,

    /**
     * Resolve an actor or refuse. Never returns null.
     * @param {object} exec - DSH tool execution.
     * @returns {object} member.
     * @throws {AuthorizationError} `NO_SESSION` or `NEED_IDENTITY`.
     */
    requireActor(exec) {
      const sessionId = sessionIdOf(exec)
      if (sessionId.length === 0) {
        throw new AuthorizationError(
          AUTH_ERROR.NO_SESSION,
          'this execution has no session, so no member can be resolved',
        )
      }
      const actor = repo.actorForSession(sessionId)
      if (!actor) {
        throw new AuthorizationError(
          AUTH_ERROR.NEED_IDENTITY,
          'this conversation is not bound to a member yet',
          { members: repo.users().filter((u) => u.status === 'active').map((u) => u.name) },
        )
      }
      return actor
    },

    /**
     * Guard a write and return the owner id to stamp on the new row.
     *
     * Creating a row always targets yourself, so this is an identity check with
     * an audit trail rather than a grant check.
     * @param {object} exec - DSH tool execution.
     * @param {string} module - module name.
     * @returns {{ownerId: string, actor: object}} stamp for the new record.
     * @throws {AuthorizationError} when the actor cannot be resolved.
     */
    mustWrite(exec, module) {
      const actor = service.actorOf(exec)
      if (!actor) {
        const fallback = config.fallbackOwner
        if (fallback) {
          service.record(exec, module, 'write', { allow: true, reason: 'anonymous-fallback' })
          return { ownerId: fallback, actor: null, anonymous: true }
        }
        service.requireActor(exec)
      }
      service.record(exec, module, 'write', { allow: true, reason: 'self' })
      return { ownerId: actor.id, actor, anonymous: false }
    },

    /**
     * Guard access to one existing row.
     * @param {object} exec - DSH tool execution.
     * @param {string} module - module name.
     * @param {string} action - `read`, `write` or `manage`.
     * @param {object} resource - `{ ownerId, id }` of the row.
     * @returns {{actor: object, reason: string}} the actor and why it passed.
     * @throws {AuthorizationError} when the actor is unknown or lacks rights.
     */
    mustAccess(exec, module, action, resource = {}) {
      const actor = service.requireActor(exec)
      const decision = can({
        actor,
        action,
        module,
        resourceOwnerId: resource.ownerId,
        resourceId: resource.id,
        grants: repo.liveGrants(),
      })
      service.record(exec, module, action, decision, resource)
      if (!decision.allow) {
        throw new AuthorizationError(
          AUTH_ERROR.DENIED,
          'member ' + actor.name + ' may not ' + action + ' this ' + module + ' record',
          { reason: decision.reason },
        )
      }
      return { actor, reason: decision.reason }
    },

    /**
     * The owner whitelist a list query must apply.
     *
     * `null` means unrestricted. A set means "only these owners"; an empty set
     * means nothing is visible. Applying the returned value is mandatory — an
     * aggregate query cannot be protected any other way.
     * @param {object} exec - DSH tool execution.
     * @param {string} module - module name.
     * @returns {Set<string>|null} visible owner ids.
     * @throws {AuthorizationError} when binding is required but absent.
     */
    readScope(exec, module) {
      const actor = service.actorOf(exec)
      if (!actor) {
        // An unbound conversation can only see the shared bucket: enough to use
        // the assistant, never enough to read someone's personal records.
        if (config.fallbackOwner) {
          service.record(exec, module, 'read-scope', { allow: true, reason: 'fallback-only' })
          return new Set([config.fallbackOwner])
        }
        if (!config.requireBinding) return null
        service.requireActor(exec)
      }
      const scope = allowedOwnerIds({ actor, module, grants: repo.liveGrants() })
      service.record(exec, module, 'read-scope', {
        allow: scope === null || scope.size > 0,
        reason: scope === null ? 'all' : 'owned',
      })
      if (scope === null) return null
      // The shared bucket belongs to the whole household, so every member sees
      // it alongside their own rows.
      if (config.fallbackOwner && !scope.has(config.fallbackOwner)) scope.add(config.fallbackOwner)
      return scope
    },

    /**
     * Human label for an owner id, for receipts.
     * @param {string|null} ownerId - record owner.
     * @returns {string} member name, or a generic label for the shared bucket.
     */
    ownerLabel(ownerId) {
      if (!ownerId || ownerId === config.fallbackOwner) return '未识别'
      const user = repo.findUserById(ownerId)
      return user ? user.name : ownerId
    },

    /**
     * Look up an active member by name, for plugins that accept a person's name
     * from the user and need the stable id behind it.
     * @param {string} name - display name.
     * @returns {{id: string, name: string, role: string}|null} member, or null.
     */
    findMember(name) {
      const user = repo.findUserByName(name)
      if (!user || user.status !== 'active') return null
      return { id: user.id, name: user.name, role: user.role }
    },

    /** @returns {string} the owner id unbound writes should land under. */
    get fallbackOwner() {
      return config.fallbackOwner
    },

    /**
     * Everything this member may read, unioned across declared modules.
     *
     * Used for "what can I see?" reporting rather than enforcement; it does not
     * write audit rows, because asking is not reading.
     * @param {object} exec - DSH tool execution.
     * @returns {Set<string>|null} visible owner ids, null when unrestricted.
     */
    visibleOwners(exec) {
      const actor = service.actorOf(exec)
      if (!actor) return new Set()
      if (actor.role === 'owner') return null
      const declared = service.listModules()
      if (declared.length === 0) return new Set([actor.id])
      const grants = repo.liveGrants()
      const visible = new Set([actor.id])
      if (config.fallbackOwner) visible.add(config.fallbackOwner)
      for (const module of declared) {
        const scope = allowedOwnerIds({ actor, module: module.name, grants })
        if (scope === null) return null
        for (const id of scope) visible.add(id)
      }
      return visible
    },

    /**
     * Append an authorization decision to the audit table when enabled.
     * @param {object} exec - DSH tool execution.
     * @param {string} module - module name.
     * @param {string} action - attempted action.
     * @param {object} decision - `{ allow, reason }`.
     * @param {object} [resource] - involved row, when any.
     * @returns {object|null} the stored entry, or null when auditing is off.
     */
    record(exec, module, action, decision, resource) {
      if (!config.audit) return null
      return repo.auditDecision({
        sessionId: sessionIdOf(exec),
        module,
        action,
        allow: Boolean(decision?.allow),
        reason: decision?.reason || '',
        ownerId: resource?.ownerId || null,
        recordId: resource?.id || null,
        at: nowIso(),
      })
    },
  }

  return service
}
