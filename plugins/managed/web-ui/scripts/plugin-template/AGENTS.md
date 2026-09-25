# AGENTS.md — __NAME__

DSH web GUI plugin __NAME__. 包级规则：只写本包特有约定，不重复根 AGENTS.md 与
packages/AGENTS.md 的全局/包级规则。

## 本包要点

- <!-- 本包实现什么、挂载到哪些界面位置 -->
- <!-- 跨目录结构约定（src/host、src/client、src/core 分区） -->

## 提交前检查

```sh
pnpm --filter @linxin666/dsh-client-ui-__NAME__ typecheck
pnpm --filter @linxin666/dsh-client-ui-__NAME__ test
pnpm --filter @linxin666/dsh-client-ui-__NAME__ build
```
