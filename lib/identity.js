/**
 * Turning "I am X" into an actor.
 *
 * The conversation supplies a session id; the user supplies a name. This module
 * validates that name against the member table and, when it checks out, binds
 * that conversation to that member so later turns need no declaration at all.
 *
 * It deliberately does not consult any channel plugin: the only identifiers are
 * the DSH session id and the name the user typed.
 * @module dsh-family-auth/identity
 */

import { nameKey } from './repo.js'
import { normalizeName } from './util.js'

/** Stable error codes so tool wrappers can render a specific receipt. */
export const IDENTITY_ERROR = {
  EMPTY_NAME: 'EMPTY_NAME',
  UNKNOWN_MEMBER: 'UNKNOWN_MEMBER',
  DISABLED_MEMBER: 'DISABLED_MEMBER',
  NO_SESSION: 'NO_SESSION',
}

function fail(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, extra)
  return error
}

/**
 * Resolve the actor for a conversation without any user input.
 * @param {object} repo - repository.
 * @param {string} sessionId - DSH session id.
 * @returns {object|null} member, or null when unbound.
 */
export function actorForSession(repo, sessionId) {
  return repo.actorForSession(sessionId)
}

/**
 * Handle a user's identity claim.
 *
 * Resolution order:
 * 1. The name matches an existing active member -> bind and return it.
 * 2. The name matches a disabled member -> refuse.
 * 3. There are no members yet -> the claim creates the household owner (either
 *    the configured `bootstrap.ownerName` or, when unset, the first claimant).
 * 4. Members exist but the name is unknown -> refuse and list the known names,
 *    so the assistant can ask the owner to add this person.
 *
 * @param {object} input - claim inputs.
 * @param {object} input.repo - repository.
 * @param {string} input.sessionId - DSH session id.
 * @param {string} input.name - name the user typed.
 * @param {object} input.config - normalized config.
 * @returns {{actor: object, created: boolean, rebound: boolean}} outcome.
 * @throws {Error} carrying an {@link IDENTITY_ERROR} code.
 */
export function claimIdentity({ repo, sessionId, name, config }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw fail(IDENTITY_ERROR.NO_SESSION, 'cannot bind identity without a session')
  }
  const cleaned = normalizeName(name)
  if (cleaned.length === 0) {
    throw fail(IDENTITY_ERROR.EMPTY_NAME, 'member name is required')
  }

  const existing = repo.findUserByName(cleaned)
  const members = repo.users()

  if (existing) {
    if (existing.status !== 'active') {
      throw fail(IDENTITY_ERROR.DISABLED_MEMBER, 'member is disabled: ' + existing.name)
    }
    const previous = repo.bindingMap().get(sessionId)
    repo.bind(sessionId, existing.id, { source: 'user-declared', note: 'claim: ' + cleaned })
    return {
      actor: existing,
      created: false,
      rebound: Boolean(previous) && previous.userId !== existing.id,
    }
  }

  const bootstrapName = config?.bootstrapOwnerName || ''
  const canBootstrap = members.length === 0
    && (bootstrapName.length === 0 || nameKey(bootstrapName) === nameKey(cleaned))

  if (canBootstrap) {
    const created = repo.addUser({
      name: cleaned,
      role: 'owner',
      source: bootstrapName.length === 0 ? 'first-claim' : 'bootstrap-owner',
    })
    repo.bind(sessionId, created.id, { source: 'user-declared', note: 'bootstrap' })
    return { actor: created, created: true, rebound: false }
  }

  throw fail(
    IDENTITY_ERROR.UNKNOWN_MEMBER,
    'unknown member: ' + cleaned,
    { members: members.map((user) => user.name) },
  )
}
