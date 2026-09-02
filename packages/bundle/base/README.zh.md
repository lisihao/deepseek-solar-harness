# `@deepseek-ai/dsh-base`

[English](README.md) | 中文

以 profile 组合包形式交付的共享 dsh 核心：[`cordis.patch.yml`](cordis.patch.yml) 在空的 profile 根之上插入全部基础插件行——模型适配器、共享的 [`agent-default-model`](../../core/agent-default-model/README.md) 选择、工具、持久化、策略、settings／credentials、遥测与宿主级 subagent provider——作为每个 profile 的 `dsh.profile.bundles` 列表中的第一层。Codex 与 Claude Code provider 以休眠状态加载；Agent Preset 分别决定自己的 agent 是否贡献任一面向模型的委派工具。后续的组合包层（例如 [`dsh-web-app`](../web-app/README.md)）和用户 profile 的 `cordis.patch.yml` 按 id 覆盖这些行；patch 会替换目标行的整个 `config`，因此模式专属的值放在各模式组合包中，而不是这里。该包没有运行时 API；profile 组合器通过 manifest（元数据清单）的 `dsh.bundle.patch` 字段解析 patch，绝不通过代码。

patch 携带受支持的 POSIX shell 栈：`bash-sandbox` 与 `tool-bash` 是默认的执行器和工具行，`sandbox` 与 `sandbox-policy` 为 Linux／macOS 提供沙盒策略。权限切换器与 approval 服务保持不变，`fs-sandbox` 继续围栏 `ctx.fs` 写入——在其旁再挂载 `dsh-fs-local` 会重复注册 `ctx.fs` 并在加载时失败。平台专属的兼容包仅保留为源码，不会插入默认 profile。

行集合及其设计依据以行内注释写在 patch 文件里；[生成的组合图](../../../apps/cli/composition.md)负责渲染它。

## 模型体验

通过插入的行间接产生影响：该组合包选定了随发行版交付的无 persona 提示词基座、工具集合与 DeepSeek 适配器，供各模式组合包进一步特化；它自身不贡献任何模型可见文本。

#### KV Cache 影响

无直接影响；每条插入行的影响由其所属的包负责。

## 已知限制与暂缓事项

- **patch 会替换整行 `config`**：profile 覆盖必须重述该行需要保留的每个字段；不存在深度合并层。
- **Claude SDK 的平台 CLI（命令行界面）仍在 Profile 安装闭包中**：base 组合包依赖 Claude 提供方，其生产路径解析宿主提供的 `claude`；移除 SDK 中未使用的可选载荷，推迟到产品安装闭包后续项处理。
