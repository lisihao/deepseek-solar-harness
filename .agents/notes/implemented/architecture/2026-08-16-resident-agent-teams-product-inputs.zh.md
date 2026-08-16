# Agent Note：Resident 与 Anchored AgentTeams 产品输入

状态：已实现

[English](2026-08-16-resident-agent-teams-product-inputs.md) | 中文

## 问题

Resident Physical Operators 位于尚未发布的 DSH 特性分支，而 AgentTeams persona 修复与 Anchored Standard delegated-agent gate 又分别位于另外两棵源码树。仅从已发布 DSH `0.1.0-rc.6` family 构建的 Desktop 包因此会缺少 Resident 执行能力，也可能让 team worker 从 promoted 工具目录开始，而不是遵循所选 preset 的受控首轮。

## 决策

Desktop 携带一组范围受限、内容寻址的预构建产品输入。七个 Resident/physical-operator tarball 来自一个已记录的 DSH commit，一个 AgentTeams tarball 来自其已记录 commit，修复后的 Anchored Standard 目录则从源树逐字节复制。`vendor/manifest.json` 持有 SHA-256 清单，`verify-vendored-inputs.mjs` 会拒绝缺失、新增或发生变化的输入。

Launcher 把 Resident 与 AgentTeams 作为产品 overlay 组合，不会把它们持久化进用户选择的 profile。Profile 已有的 bundle 不会重复加载。Resident 必须显式启用，physical-operator 默认仍为 ephemeral。在 macOS 上，仅 owner 可访问的私有 wrapper 会把用户原生 Claude Code 与 Codex 命令暴露给打包 daemon；不会转发 API credential，也不存在 API fallback。Electron 的 `ELECTRON_RUN_AS_NODE` marker 只用于 daemon bootstrap，并会在两个产品 driver 启动子进程前移除。

打包内的 Anchored Standard root 会以 system trust 排在已发布 preset root 之前。两个 promotion gate 均使用 `includeSubagents: true`，所以没有 durable event 的 delegated worker 仍是 unpromoted，首个请求只得到 `bash` 与 `str_replace_editor`。AgentTeams 最终固定为 `memberPersonaPlacement: prompt`，从而保留所选 preset persona，并把 member protocol 放入首条 user message。

## 验证

完整 workspace check 会构建全部 face、执行 typecheck 与 Desktop 测试、验证 sealed vendor 清单并证明 runtime closure。打包检查要求 `app.asar.unpacked` 中存在 Resident、AgentTeams、native-product runtime 与 Anchored Standard 文件。打包组合 smoke 会加载真实 Electron 产物，并证明只有一个 Resident row、一个 dual-mode router、一个使用 prompt placement 的 AgentTeams row，以及一个仍为 unpromoted 的 delegated Anchored Standard 首轮。

打包 Resident smoke 会通过应用 executable 启动 daemon，验证真实进程链，并把 Claude Code 与 Codex 审查为 `native-subscription`。两个 Provider 的显式无工具 turn 都会返回唯一 nonce 与原生 session ID。这些 smoke 使用隔离且路径较短的 DSH home，不转发 API key，结束后关闭 daemon 并删除临时状态。

## 结果

Desktop 可以在相关 package 尚未进入 DSH 公共发行版之前交付该特性，但每次 sealed input 变化都必须显式更新 manifest 与 lockfile。产品层会 shadow 同 id 的过期用户 Anchored Standard 副本，但不会删除用户数据。本里程碑的 Resident 发布验收仅覆盖 macOS；不受支持或发生协议变化的原生产品会 fail loud，普通 ephemeral 执行仍可用。Mac mini 部署不属于本变更，后续必须通过远程方式拉取 GitHub 正式发行版。
