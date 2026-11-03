/**
 * The behavioural contract handed to the model.
 *
 * The guards are silent: they filter data before the model sees it, so the
 * model's job is not to enforce anything, it is to avoid *undoing* the guard by
 * talking around it. That is what this skill teaches.
 * @module dsh-family-auth/skill
 */

/** Skill name, referenced by `source` in the registry. */
export const SKILL_NAME = 'family-auth'

/** One-line description shown in the skill list. */
export const SKILL_DESCRIPTION = 'Household identity and sharing rules: who is speaking, '
  + 'whose records are visible, and how to refuse a request without leaking that data exists.'

const SKILL_WHEN_TO_USE = '当对话涉及家里任何成员的个人数据（账目、日记、健康档案），'
  + '或用户说"我是XX"、"给我老婆看"、"谁看过我的账"时。'

const CONTENT = `家里的数据按"谁记的就归谁"来管。权限不是你判断的——工具会判断，并且在数据到你手上之前就已经过滤掉了。你的任务是别用话把过滤推翻。

## 认人
- 用户明确说"我是XX""叫我XX"时，调用 family_bind，名字照他说的原样传。
- 工具返回 NEED_IDENTITY 回执时：把回执里的成员名单如实念给他，问他叫什么。不要猜，更不要把上一位说话的人当成这一位。
- 一个微信号可能先后给好几个人用，会话里还绑着上一位。对方说的名字和当前身份不一致时，直接 family_bind 成他说的名字。
- 永远不要替用户认领身份，也不要说"根据系统记录你是XX"。身份只有用户自己说了才算。

## 看数据
- 能看到的只有"你自己的 + 别人明确授权给你的"。没授权的记录，不要说内容，也不要说"有几条""大概多少"——存在本身就是信息。
- 工具说没权限，就如实说没权限。不要换成"我查不到""系统里没有"这类说法，那是撒谎。正确说法：这条是别人的记录，需要他授权给你。
- 汇总类问题（"这个月全家花了多少"）同样按权限算。工具返回的数字已经过滤过，直接用它，不要自己再补算。

## 授权
- 只有户主能 family_member_add 和 family_grant。
- 有人让你"帮我开个权限"时，别答应，告诉他去找户主。
- 用户说"给我老婆看"这类话，先问清是谁（名字），再 grant。

## 说话方式
- 不要解释内部机制，"我做了一次权限校验"这种话不必说。
- 拒绝时给出下一步：他怎么做才能看到。
- 回执里的成员名单、授权编号可以直接用；内部 id 除非用户要，否则别报。`

/**
 * Register the skill, if skills are enabled.
 * @param {object} ctx - Cordis context with the `skills` service.
 * @param {object} options - `{ config }`.
 * @returns {object|null} registration handle, or null when disabled.
 */
export function registerSkill(ctx, { config } = {}) {
  if (!config?.skill) return null
  return ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    content: CONTENT,
    source: 'dsh-family-auth',
  })
}

/**
 * Short standing reminder injected into every system prompt.
 *
 * Cheaper than the full skill: one paragraph the model cannot miss, stating the
 * two rules that matter most.
 * @returns {string} prompt fragment.
 */
export function buildBrief() {
  return [
    '[家庭权限] 这个对话的身份和数据范围由 dsh-family-auth 管理，工具返回的数据已经按权限过滤。',
    '用户说自己是谁时才 family_bind；工具返回 NEED_IDENTITY 就原样转达成员名单并问名字。',
    '没有授权的内容，连"存在几条"也不要说；如实说需要授权，不要用"查不到"掩盖。',
  ].join(String.fromCharCode(10))
}
