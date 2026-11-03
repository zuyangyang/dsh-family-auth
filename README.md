# dsh-family-auth

家庭成员的身份与数据授权层，用于 DeepSeek Harness（DSH）。

**解决的问题**：家里多个人共用一个 AI 助手时，各人的账本、日记、健康档案默认只能自己看；
需要时可以授权给别人只读。插件不做渠道适配、不读任何第三方插件的文件。

## 状态

Phase 1 开发中。

## 设计

完整设计见 [DESIGN.md](DESIGN.md)。

## 安装

```bash
dsh plugin --profile <name> add dsh-family-auth
```

## 许可

MIT
