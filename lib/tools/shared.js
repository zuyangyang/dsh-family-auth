/**
 * Shapes shared by every tool: how a refusal is worded, how the roster reads.
 *
 * Refusals are receipts, not stack traces. The model relays this text verbatim,
 * so it must be something a family member can act on.
 * @module dsh-family-auth/tools/shared
 */

import { AUTH_ERROR } from '../auth.js'
import { IDENTITY_ERROR } from '../identity.js'

/**
 * Render the roster as one line of quoted names.
 * @param {string[]} names - member names.
 * @returns {string} human-readable list.
 */
export function rosterLine(names) {
  if (!Array.isArray(names) || names.length === 0) return '（还没有成员）'
  return names.map((name) => '「' + name + '」').join('、')
}

/**
 * Turn an authorization or identity error into the text shown to the user.
 * @param {Error} error - thrown error.
 * @returns {{ok: false, code: string, text: string, members?: string[]}} receipt.
 */
export function refusal(error) {
  const code = error?.code || 'ERROR'
  const members = Array.isArray(error?.members) ? error.members : undefined

  switch (code) {
    case AUTH_ERROR.NEED_IDENTITY:
    case IDENTITY_ERROR.NO_SESSION:
      return {
        ok: false,
        code: AUTH_ERROR.NEED_IDENTITY,
        text: '我还不知道你是哪位，所以没法动家里的记录。\n'
          + '已在册的成员：' + rosterLine(members) + '\n'
          + '告诉我你的名字，我用 family_bind 记下来就好了。',
        ...(members ? { members } : {}),
      }
    case IDENTITY_ERROR.UNKNOWN_MEMBER:
      return {
        ok: false,
        code: IDENTITY_ERROR.UNKNOWN_MEMBER,
        text: '「' + String(error.message || '').replace('unknown member: ', '') + '」不在成员表里。\n'
          + '已在册的成员：' + rosterLine(members) + '\n'
          + '要让家里人把你加上，得由管理员执行 family_member_add。',
        ...(members ? { members } : {}),
      }
    case IDENTITY_ERROR.DISABLED_MEMBER:
      return {
        ok: false,
        code,
        text: '这个成员已被停用，暂时不能操作。请联系家里的管理员。',
      }
    case IDENTITY_ERROR.EMPTY_NAME:
      return { ok: false, code, text: '你还没说名字。告诉我你叫什么，我记一下。' }
    case AUTH_ERROR.DENIED:
      return {
        ok: false,
        code,
        text: '你没有看这条记录的权限。\n'
          + '我这边拿到的数据里本来就没有它，所以也给不出内容。\n'
          + '需要的话，让记录的所有人给你授权。',
      }
    default:
      return { ok: false, code, text: '操作没能完成：' + (error?.message || String(error)) }
  }
}

/**
 * Wrap a tool body so any guard failure becomes a receipt instead of a throw.
 * @param {Function} body - async function returning the success payload.
 * @returns {Function} guarded tool body.
 */
export function guarded(body) {
  return async (args, exec) => {
    try {
      return await body(args, exec)
    } catch (error) {
      return refusal(error)
    }
  }
}

/**
 * A refusal the tool decided itself, so it can be audited before returning.
 * @param {string} text - what to tell the user.
 * @returns {{ok: false, code: 'DENIED', text: string}} receipt.
 */
export function denyText(text) {
  return { ok: false, code: AUTH_ERROR.DENIED, text }
}

/**
 * Assert the actor is the household owner, for administrative tools.
 * @param {object} actor - resolved member.
 * @returns {object} the actor.
 * @throws {Error} with `code === 'DENIED'`.
 */
export function requireOwner(actor) {
  if (!actor || actor.role !== 'owner') {
    const error = new Error('only the household owner may do this')
    error.code = AUTH_ERROR.DENIED
    throw error
  }
  return actor
}
