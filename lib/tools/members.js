/**
 * `family_member_list` and `family_member_add`.
 *
 * Adding a member is the owner's job: an unknown name cannot self-register,
 * which is what keeps a stranger in the group chat from becoming "family".
 * @module dsh-family-auth/tools/members
 */

import { denyText, guarded } from './shared.js'

const identityDefineTool = (definition) => definition

/**
 * @param {object} runtime - `{ repo, config, auth }`.
 * @param {Function} [defineTool] - injected for tests.
 * @returns {object} the `family_member_list` tool definition.
 */
export function createMemberListTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'family_member_list',
    description: 'List the household members and their roles. Use it before granting access, '
      + 'or when the user asks who is in the family.',
    parameters: {
      include_disabled: { type: 'boolean', description: '连已停用的成员一起列出。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: guarded(async (args, exec) => {
      runtime.auth.requireActor(exec)
      const all = runtime.repo.users()
      const shown = args.include_disabled ? all : all.filter((user) => user.status === 'active')

      if (shown.length === 0) {
        return { ok: true, members: [], text: '家里还没有成员记录。' }
      }

      const lines = ['家里的成员：']
      for (const user of shown) {
        const role = user.role === 'owner' ? '户主' : user.role === 'guest' ? '访客' : '成员'
        const state = user.status === 'active' ? '' : '（已停用）'
        lines.push('  · ' + user.name + ' — ' + role + state)
      }
      return {
        ok: true,
        members: shown.map((user) => ({ id: user.id, name: user.name, role: user.role, status: user.status })),
        text: lines.join('\n'),
      }
    }),
  })
}

/**
 * @param {object} runtime - `{ repo, config, auth }`.
 * @param {Function} [defineTool] - injected for tests.
 * @returns {object} the `family_member_add` tool definition.
 */
export function createMemberAddTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'family_member_add',
    description: 'Create a household member. Owner only. After this the person can say their name in '
      + 'their own conversation and family_bind will attach them.',
    parameters: {
      name: { type: 'string', required: true, description: '成员名字，之后他用这个名字认领自己。' },
      role: { type: 'string', description: 'member（默认）、guest 或 owner。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: guarded(async (args, exec) => {
      const actor = runtime.auth.requireActor(exec)
      if (actor.role !== 'owner') {
        runtime.auth.record(exec, 'auth', 'member-add', { allow: false, reason: 'not-owner' })
        return denyText('只有户主能添加成员。让家里的户主来做这一步。')
      }
      const user = runtime.repo.addUser({
        name: args.name,
        role: args.role || 'member',
        source: 'added-by:' + actor.name,
      })
      runtime.auth.record(exec, 'auth', 'member-add', { allow: true, reason: 'owner' })

      return {
        ok: true,
        member: { id: user.id, name: user.name, role: user.role },
        text: '已经加上「' + user.name + '」（' + (user.role === 'owner' ? '户主' : user.role === 'guest' ? '访客' : '成员') + '）。\n'
          + '让他在自己的对话里说一句"我是' + user.name + '"，就能对上号了。',
      }
    }),
  })
}
