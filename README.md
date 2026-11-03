# dsh-family-auth

家庭多租户鉴权：**每个人默认只能看自己记的东西，可以把查看权限授权给别人。**

给一家人共用一个助手时用：微信、网页、桌面各有各的会话，但只要说一句"我是杨"，
之后的对话就都算在杨名下，账目、日记、体检记录各自归各的。

## 安装

```bash
npm install dsh-family-auth
```

在 profile 的 `cordis.patch.yml` 里加配置：

```yaml
- id: dsh-family-auth
  config:
    dataDir: ~/.dsh-family/data/auth
    bootstrap:
      ownerName: 杨
```

## 用法

第一次对话：

> 我：我是杨
> 助手：记下了，你是「杨」。这是家里的第一个成员，所以把你设为户主。

之后问"这个月花了多少"，只会算到杨自己的记录。想给太太看：

> 我：把账本给我太太看（她叫小红）
> 助手：已授权给「小红」：ledger · 查看 · 全部记录。

## 给插件作者

业务插件不需要懂身份是怎么建立的，只用三个守卫：

```js
export const inject = ['tools', 'familyAuth']

export function apply(ctx) {
  const auth = ctx.familyAuth
  auth.defineModule({ name: 'health' })

  const { ownerId } = auth.mustWrite(exec, 'health')                       // 写：记在谁名下
  auth.mustAccess(exec, 'health', 'read', { ownerId: r.ownerId })          // 单条：能碰吗
  const scope = auth.readScope(exec, 'health')                             // 列表：能看见谁
}
```

`readScope` 返回 `null`（不受限）或一个 owner id 的 `Set`，调用方必须自己套到查询上——
汇总类查询（"全家这个月花了多少"）只能靠它防住。

完整设计：**[DESIGN.md](./DESIGN.md)**。

## 状态

0.1.0，Phase 1：身份、授权、审计、工具面、行为契约 skill 已完成，69 个单元测试。
业务侧接入（`dsh-ledger` 等的读写守卫）在后续提交里做。

## 许可

MIT
