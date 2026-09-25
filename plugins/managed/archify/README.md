# DSH Archify 插件

[English](README.en.md)

这是一个隔离的 DSH managed plugin，把 [Archify v2.16.0](https://github.com/tt-a1i/archify/tree/v2.16.0) 作为模型可调用的 `archify` 工具接入。上游仓库的五种 typed JSON IR、渲染器、严格校验器、几何诊断、Architecture Delta、迁移器、指南、示例和测试原样 vendored；DSH 只增加适配层，不把 Archify 业务代码放进 Core、TaskGraph 或 Scheduler。

上游来源已经锁定为：

```text
仓库   https://github.com/tt-a1i/archify
标签   v2.16.0
提交   c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de
许可   MIT
```

## 提供什么

插件注册一个模型工具：

| action | 作用 |
| --- | --- |
| `render` | 从一个 typed JSON IR 渲染 HTML；支持 architecture/workflow/sequence/dataflow/lifecycle |
| `validate` | 运行上游 schema、渲染、artifact 和 composition 校验，返回结构化诊断 |
| `deliver` | 原子生成最终 HTML，并写入内容寻址 artifact、命名 delivery 和 receipt |
| `compare` | 对两个 architecture IR 做 Architecture Delta，生成 HTML 与上游 receipt |
| `inspect` | 查看 architecture layout JSON |
| `migrate` | 按上游规则把 workflow schema v1 迁移到 v2 |
| `guide` / `doctor` | 返回上游 authoring 指南或检查 vendored runtime |
| `visual-check` | 对 artifact root 内已有 HTML 运行上游视觉检查 |
| `examples` / `brands` | 查询上游示例或品牌目录；`brands capture` 只在用户明确给 URL 时执行 |

输入使用 `input`、`baseInput`、`headInput` 直接传 JSON IR，不要求模型自己拼接临时文件。工具自动在临时目录写入输入，然后调用精确的 `vendor/archify/bin/archify.mjs`；这不会改变 IR 的语义。

## 执行边界

适配器通过 DSH 的 `ctx.subprocess` 接缝注入并启动 Node 子进程，使用显式 argv、`stdin: ignore` 和受限 stdout/stderr 收集，不经过 shell，也不直接导入宿主 `child_process`。工具取消会终止受 DSH 管理的进程树，超时和非零退出会返回失败结果；插件必须由 profile 提供 `@deepseek-ai/dsh-subprocess`，不能依赖宿主偶然 hoist。Archify 的 `ajv`、`parse5`、`saxes` 和 `simple-icons` 运行时依赖已随插件 manifest 声明。

## 产物和 receipt

每个工作区的默认根目录为 `.dsh-archify/`，也可以通过插件配置 `artifactRoot` 指定。目录权限为 `0700`，文件权限为 `0600`，结构如下：

```text
.dsh-archify/
├── artifacts/sha256/<digest>   # HTML、迁移 JSON 或 adapter receipt
└── deliveries/<name>.html      # deliver 的命名投影
```

返回值只包含摘要、有限诊断、`artifactRef`、`deliveryPath`、compare 的 `upstreamReceiptRef` 和 `receiptRef`。receipt 记录 action/type、上游提交、输入 hash、命令退出状态、有限 stdout/stderr、产物 hash 和诊断；不保存原始 prompt、完整 HTML 到会话事件，也不复制 DSH 编排状态。

## 安装

在构建好的 DSH profile 中安装预构建 tarball：

```sh
npm pack
dsh plugin --profile <profile> add ./deepseek-ai-dsh-archify-2.16.0-dsh.1.tgz
dsh --profile <profile> --dump-config | grep archify
```

`cordis.patch.yml` 会把 row `archify` 加入 profile。开发时也可以把本目录作为本地插件挂载；正式分发应使用固定版本 tarball。完整来源锁定和文件树摘要见 [SOURCE-LOCK.json](SOURCE-LOCK.json)，保真逐项核对见 [ARCHIFY-FIDELITY.md](ARCHIFY-FIDELITY.md)。

## 模型使用规则

插件通过 `systemPrompt` 提示架构、设计、需求、审核等 agent：有实际图示价值时先生成 typed IR、先 validate、最后 deliver。它不会强迫普通问答生成图，也不会把“调用过工具”当成交付成功；必须检查 `ok`、诊断和 receipt。

## 验证

```sh
npm run typecheck
npm test
npm run build
node vendor/archify/bin/archify.mjs doctor
```

仓库中的 [ARCHIFY-FIDELITY.md](ARCHIFY-FIDELITY.md) 还要求对五种示例分别执行真实 `validate --json`，并区分“精确 vendored runtime”与“DSH 适配行为”。

## 许可

插件适配层与上游 Archify 均为 MIT；上游通知和品牌图标说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
