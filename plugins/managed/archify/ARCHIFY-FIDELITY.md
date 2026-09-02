# Archify v2.16.0 → DSH 适配保真矩阵

## 来源锁定

本适配使用 `https://github.com/tt-a1i/archify` 的 `v2.16.0`，提交为 `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de`。用户提供的 `citrolabs/archify` 地址当前不是可用的 GitHub 来源；没有把它臆造为来源。精确上游目录位于 `vendor/archify/`，文件数 190，树摘要和许可见 [SOURCE-LOCK.json](SOURCE-LOCK.json)。

## 逐项矩阵

| 上游能力/契约 | 上游证据（v2.16.0） | DSH 实现 | 状态 |
| --- | --- | --- | --- |
| 五种图类型 | `schemas/`、`renderers/`、`examples/`：architecture/workflow/sequence/dataflow/lifecycle | `types.ts` 只复制枚举；运行时调用 exact vendored CLI | faithful |
| Typed JSON IR 与严格校验 | 五类 schema、`schemas/common.schema.json`、生成 validator；`additionalProperties: false` | `input` 作为 JSON 透传到临时文件；schema 仍由上游 validator 权威 | faithful |
| Architecture renderer | `renderers/architecture/render-architecture.mjs` | `render architecture`；artifact hash 返回 | faithful |
| Workflow renderer | `renderers/workflow/render-workflow.mjs` | `render workflow`；artifact hash 返回 | faithful |
| Sequence renderer | `renderers/sequence/render-sequence.mjs` | `render sequence`；artifact hash 返回 | faithful |
| Dataflow renderer | `renderers/dataflow/render-dataflow.mjs` | `render dataflow`；artifact hash 返回 | faithful |
| Lifecycle renderer | `renderers/lifecycle/render-lifecycle.mjs` | `render lifecycle`；artifact hash 返回 | faithful |
| `validate` | CLI `validate`：schema、renderer、artifact/composition checks、`--json`、`--layout-json` | `validate` 传递 type/quality/repoRoot 并返回 bounded response/diagnostics | faithful |
| `deliver` | CLI `deliver`：冻结 spec、原子 HTML commit、artifact checks、upstream receipt | 临时目标由 adapter 管理；成功 HTML 写入 DSH CAS，并额外发布 workspace delivery projection | compatible adapter |
| `compare` | `delta/architecture-delta.mjs`，只支持 architecture，HTML + sidecar receipt | 两个 IR 写临时文件，调用 exact `compare --json`，HTML 与上游 receipt 保留为 CAS | faithful |
| Workflow v1→v2 migration | CLI `migrate workflow ... --to-schema 2 --json` | `migrate` action，迁移 JSON 作为 CAS `json` artifact | faithful |
| `inspect` | CLI architecture `--layout-json` | `inspect` action | faithful |
| `guide` | CLI scenario guide，`--json`、`--lang` | `guide` action | faithful |
| `doctor` | CLI runtime completeness check | `doctor` action | faithful |
| `visual-check` | CLI visual checker；依赖已有 HTML | `htmlPath` 只允许 artifact root 内文件 | compatible adapter |
| `brands` / explicit capture | CLI catalog and `brands capture <url>` | `query` 查询；`captureUrl` 仅显式传入时执行 | compatible adapter |
| `preview` / `--open` | 上游交互式 preview/open | 未暴露为模型工具；DSH 模型工具返回 refs，UI/CLI 可单独调用 vendored runtime | deliberate omission |
| `check` | 上游最终 artifact checker | `render`/`deliver` 使用上游命令路径；用户可用 `visual-check` 做进一步检查 | compatible adapter |
| Source-evidence | architecture `--repo-root` 与 commit-pinned evidence | 仅显式传递 `repoRoot`；不自动推断仓库事实 | faithful boundary |
| Receipts | upstream deliver/compare receipts | adapter 再写 content-addressed receipt，记录输入 hash、命令状态、artifact ref 和 bounded diagnostics | compatible extension |
| Process boundary | 上游 CLI 需要 Node 进程；命令不要求 shell 语义 | 通过注入的 `ctx.subprocess` 以显式 argv 启动，传播取消/超时并收集受限输出 | compatible adapter |
| Runtime dependencies | 上游 manifest 的 `ajv`、`parse5`、`saxes`、`simple-icons` | plugin `dependencies` 明确声明，独立 tarball 不依赖宿主 hoist | faithful packaging |
| Skill authoring policy | exact source `vendor/archify/SKILL.md` | root `SKILL.md` 是 DSH-facing adapter，明确 validate→deliver 和 refs；exact source remains vendored | compatible adapter |
| License/third-party notices | upstream `LICENSE` and `skill-release.json`; pinned brand notices | plugin root includes MIT license/notice and exact upstream license | faithful |

## DSH 边界

| 约束 | 验证方式 |
| --- | --- |
| 不耦合 TaskGraph/Scheduler/Core | adapter 只依赖 Cordis、`dsh-tools`、`dsh-session`、`systemPrompt` 和 `ctx.subprocess`；`src` 没有 orchestration/TaskGraph import |
| 不复制上游渲染/校验实现 | `runner.ts` 只启动 `vendor/archify/bin/archify.mjs`；五种图由上游运行时执行 |
| 大结果不进入模型响应 | 返回 bounded summary、CAS `artifactRef`、`receiptRef`，不内联 HTML |
| 不持久化原始 prompt/秘密 | receipt 只记录 canonical input hash 和 bounded process output；输入临时目录在 finally 清理 |
| 路径写入受控 | deliver 的 `outputName` 是单段安全文件名；visual-check 的 `htmlPath` 必须位于 artifact root |
| 取消可传播 | 注入的 `ctx.subprocess` 接收 `ToolRunContext.signal`，进程树由 DSH 终止；没有自动重试或静默降级 |

## 结论

对 Archify v2.16.0 的 CLI/runtime/schema 五图核心能力，本插件是 **faithful vendored runtime + compatible DSH adapter**。`preview/--open` 不属于模型工具的首发范围，这是明确的产品边界，不冒充“全部接口已接入”。
