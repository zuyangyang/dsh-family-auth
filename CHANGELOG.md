# Changelog

## 1.0.1

- 默认数据目录改成 <DSH_HOME> 下（原来写死绝对路径）。不同 profile（不同 DSH_HOME）默认各存各的；desktop 的 DSH_HOME 就是 ~/.dsh，行为不变。

## 1.0.0

- 家庭成员与授权（grant）的唯一来源：谁在说话、能看谁的、能改谁的。
- 模块注册表：业务插件用 `defineModule` 声明自己，权限按 模块 × 成员 × 权限等级 判定。
- 三个问题三个方法：`actorOf`（谁）、`readScope`（能看谁）、`mustWrite` / `mustAccess`（能不能动）。
- 认不出说话人时写入统一的 `default` 桶，只有户主能看到和认领。
- 审计：每次授权判定都可以落一行，谁在什么时候看了谁的什么。

