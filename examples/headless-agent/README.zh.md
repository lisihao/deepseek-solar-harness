# headless-agent

[English](README.md) | 中文

本目录负责 headless coding agent（智能体）的回放和真实模型测试组装：DeepSeek V4 + 本地 bash 与文件系统工具 + subagent 委托 + 工作流与全新 agent Ralph 迭代 + `todo_write` + JSONL 持久化。本目录显式挂载共享 agent 主干、一个根 agent、持久化和检查点策略；它不是第二个产品入口。

## 运行

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm dsh --profile headless "fix the failing test in this workspace"
```

产品命令是 [`dsh --profile headless`](../../apps/cli/README.md)：它接受一项非空任务，创建并持久化新会话，打印最终 assistant 文本，然后退出。

快照套件通过 [`tests/fixtures/headless-driver.ts`](tests/fixtures/headless-driver.ts) 运行本目录的配置。这个未导出且仅供测试使用的进程会在结果记录之前，以 JSONL 发出规范会话事件。该事件流属于测试基础设施，不是受支持的 CLI（命令行界面）输出格式。子会话只通过父会话的工具事件和结果对外显示。

## E2B POC overlay

[`e2b.cordis.yml`](e2b.cordis.yml) 使用一个共享 E2B 沙箱替换本地文件系统与子进程提供方，同时保留 `dsh-bash-local` 和相同的面向模型工具。请在 git 忽略的根目录 `.env` 中，将 `E2B_API_KEY` 与 `DEEPSEEK_API_KEY` 放在一起，然后运行凭据门控的实机组合测试；它在同一个沙箱中驱动 FS、Bash、PTY 和 LSP，并证明沙箱最终被删除：

```sh
pnpm exec vitest run --config vitest.e2e.config.ts packages/e2b/e2b/tests/composition.e2e.ts
```

该 overlay 会在沙箱中创建相同的绝对 cwd，但不会上传或挂载宿主工作区。文件与 Bash 变更只存在于 E2B；Cordis、模型调用、agent／会话状态、会话日志、skill（技能）和 SDK 缓冲仍在宿主上。该组合会在超时和资源释放时终止其沙箱。它是提供方组合 POC，而不是完整 harness 迁移或工作区同步功能。

## 高级配置

[`advanced.cordis.yml`](advanced.cordis.yml) 在测试组装中添加 Code Mode 和 Cordis 工具。

## Keyless 独立 RLM

[`standalone-rlm.cordis.yml`](standalone-rlm.cordis.yml) 将明确拥有的 root、独立 RLM Provider 与既有执行所有者组装在一起。API 和 Codex 快照场景只替换外部传输；不使用凭据，经过真实 Loader、工具、daemon 和 RLM 核心。运行 `pnpm run test:snapshot -- examples/headless-agent/tests/standalone-rlm.snapshot.ts`；完成 host 构建后，设置 `DSH_EXAMPLE_MODE=lib`，以 plain Node 检查构建包的 exports。此夹具不构成通用 CLI 或 Desktop Host 集成。

## 本地 HTTP 准入

[`http-admission.cordis.yml`](http-admission.cordis.yml) 将真实 Loader、Worker、Runtime、DeepSeek 适配器和共享评估账本连接到回环 HTTP 服务；认证和响应均为合成数据。运行 `pnpm run test:snapshot -- examples/headless-agent/tests/http-admission.snapshot.ts`；完成 host 构建后，设置 `DSH_EXAMPLE_MODE=lib`，以 plain Node 检查构建包的 exports。服务端独立记录每次请求到达，夹具逐项核对 root、child 和工具轮中的请求体哈希、观察事件与账本尝试。父流程读取完整子结果后才发出下一次请求，并发上限保持为 1。

输入上界未获证明时，准入在任何 HTTP 请求到达前拒绝。请求到达后断连会持久保留 unknown，不发生隐藏重试，并继续占用并发上限为 1 的槽位；另一项并发上限为 2 的独立诊断证明，后续独立请求成功不会抹去该 unknown。篡改请求体关联、保留未分类的到达记录或删除 unknown 事件，都必须使验证失败。按字节计量的合成作用域不证明真实 Provider token 上界、操作系统隔离或付费运行就绪；该组装不发出外部模型请求。
