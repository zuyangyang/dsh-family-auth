/**
 * `family_whoami` and `family_bind`: the whole onboarding surface.
 *
 * Binding is the only way a conversation acquires a member, so this tool is
 * deliberately forgiving about phrasing and strict about the outcome.
 * @module dsh-family-auth/tools/identity
 */

import { claimIdentity } from '../identity.js'
import { guarded, rosterLine } from './shared.js'

const identityDefineTool = (definition) => definition

/**
 * @param {object} runtime - `{ repo, config, auth }`.
 * @param {Function} [defineTool] - injected for tests.
 * @returns {object} the `family_whoami` tool definition.
 */
export function createWhoamiTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'family_whoami',
    description: 'Report who this conversation is currently speaking as, and what that person may read. '
      + 'Use it when someone asks "你知道我是谁吗", or before explaining why a record is not visible.',
    parameters: {},
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: guarded(async (_args, exec) => {
      const actor = runtime.auth.actorOf(exec)
      const members = runtime.repo.users().filter((user) => user.status === 'active')

      if (!actor) {
        return {
          ok: false,
          code: 'NEED_IDENTITY',
          text: '这个对话还没绑定到任何成员。\n'
            + '已在册的成员：' + rosterLine(members.map((user) => user.name)) + '\n'
            + '告诉我你的名字，我记下来之后就能对上你的记录。',
          members: members.map((user) => user.name),
        }
      }

      const grants = runtime.repo.grantsFor(actor.id)
      const scope = runtime.auth.readScope(exec, 'ledger')
      const scopeText = scope === null
        ? '全部成员的数据'
        : scope.size === 1
          ? '只有你自己的'
          : '你自己的，加上 ' + (scope.size - 1) + ' 位授权给你的人'

      const lines = [
        '你是「' + actor.name + '」，角色：' + roleLabel(actor.role) + '。',
        '当前能看到的：' + scopeText + '。',
      ]
      if (grants.length > 0) {
        lines.push('拿到的授权：')
        for (const grant of grants) lines.push('  · ' + describeGrant(grant))
      } else if (actor.role !== 'owner') {
        lines.push('还没有人给你授权，所以只能看到自己的记录。')
      }
      lines.push('家里人：' + rosterLine(members.map((user) => user.name)))

      return {
        ok: true,
        member: { id: actor.id, name: actor.name, role: actor.role },
        visible: scope === null ? 'all' : [...scope],
        grants: grants.map((grant) => ({ id: grant.id, module: grant.module, permission: grant.permission })),
        text: lines.join('\n'),
      }
    }),
  })
}

/**
 * @param {object} runtime - `{ repo, config, auth }`.
 * @param {Function} [defineTool] - injected for tests.
 * @returns {object} the `family_bind` tool definition.
 */
export function createBindTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'family_bind',
    description: 'Record who is speaking in this conversation. Call it as soon as the user says their name '
      + '(for example "我是杨"). Only members already created by the owner can bind; an unknown name is '
      + 'refused together with the current roster, so the assistant can ask the owner to add the person.',
    parameters: {
      name: { type: 'string', required: true, description: '名字，照用户说的原样传。' },
      note: { type: 'string', description: '可选备注，比如"换了个微信号"。' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: guarded(async (args, exec) => {
      const sessionId = runtime.auth.sessionIdOf(exec)
      const result = claimIdentity({
        repo: runtime.repo,
        sessionId,
        name: args.name,
        config: runtime.config,
      })
      runtime.auth.record(exec, 'auth', 'bind', { allow: true, reason: 'user-declared' })

      const lines = ['记下了，你是「' + result.actor.name + '」。']
      if (result.created) {
        lines.push(result.actor.role === 'owner'
          ? '这是家里的第一个成员，所以把你设为户主：你可以给别人授权。'
          : '已经为你建好档案。')
      }
      if (result.rebound) lines.push('（这个对话之前绑的是别人，现在改成你了。）')
      if (result.actor.role !== 'owner') {
        lines.push('默认你只能看自己的记录。要看别人的，得他们授权给你。')
      }

      return {
        ok: true,
        member: { id: result.actor.id, name: result.actor.name, role: result.actor.role },
        created: result.created,
        rebound: result.rebound,
        text: lines.join('\n'),
      }
    }),
  })
}

/** Human label for a role. */
function roleLabel(role) {
  if (role === 'owner') return '户主'
  if (role === 'guest') return '访客'
  return '成员'
}

/**
 * One readable line for a grant.
 * @param {object} grant - grant record.
 * @returns {string} description.
 */
export function describeGrant(grant) {
  const what = grant.module === '*' ? '所有模块' : grant.module
  const how = grant.permission === 'manage' ? '管理' : grant.permission === 'write' ? '读写' : '查看'
  let whom = '全部记录'
  if (grant.scope?.kind === 'owner') whom = (grant.scope.ownerIds || []).length + ' 位成员的记录'
  if (grant.scope?.kind === 'records') whom = (grant.scope.recordIds || []).length + ' 条指定记录'
  const expiry = grant.expiresAt ? '，到 ' + grant.expiresAt.slice(0, 10) + ' 为止' : ''
  return what + ' · ' + how + ' · ' + whom + expiry
}
