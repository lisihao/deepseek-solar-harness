# @deepseek-ai/dsh-resident-operator-local

[English](README.md) | 中文

`ctx.residentOperators` 的本地 Service Provider 与独立 daemon。DSH 插件只是可释放的 Unix socket 客户端；`dsh-resident-operatord` 是唯一 SQLite 写者，并跨 DSH/HMR 释放继续存在。它负责 command receipt、单 Session lease、state revision、有界结构化事件及大结果的内容寻址 Artifact。

Claude Code 使用官方 Agent SDK 持久化与恢复 Session；Codex 通过固定版本 app-server daemon 的本机属主 Unix WebSocket 控制 socket 使用非临时 thread；CLI `proxy` 只是 WebSocket 原始字节桥，不是 NDJSON transport。两个 Driver 都会在本机 CLI 无法证明原生订阅登录时默认拒绝，且不支持 API-key fallback。

## 协议、存储与恢复

JSON-RPC 2.0 通过仅属主可访问的 Unix socket 以 NDJSON 传输。握手会拒绝 Resident 协议、state schema、daemon build、必需方法集、产品版本、产品协议 hash 或原生订阅资格不一致。daemon 在单写 WAL 数据库中保存 `resident_sessions`、`command_receipts`、`session_leases`、有界事件及 Artifact 索引。

Receipt 按 `accepted -> running -> settled` 推进；daemon 在无法证明结算前崩溃时，启动恢复会将其标为 `indeterminate`。相同 command 与 canonical hash 重放会返回同一 Receipt，内容变化则冲突。重试只能在显式处置后用新 command ID 准入，并唯一关联旧 Receipt。正常停止会排空已准入 turn；进程被强制终止时由启动恢复处理，绝不自动重放。

## 配置与安全

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `dshHome` | 解析后的 DSH home | `resident-operators/` 的父目录。 |
| `autoStart` | `true` | 无兼容 socket 时启动独立本地 daemon。 |
| `connectTimeoutMs` | `5000` | 有界连接与启动等待。 |
| `pollIntervalMs` | `250` | turn 结算轮询间隔。 |

根目录权限为 `0700`，socket、lock、pid、SQLite 文件与 Artifact 为 `0600`。系统不保存原始 prompt 或终端屏幕；Receipt 只保存 canonical hash，持久化错误会脱敏 prompt 与疑似凭据。产品子进程使用共享的凭据清理环境，产品原生权限和 approval 策略仍是权威，两个 Driver 都不会回退到 API key。

## Model Experience

Indirectly, through the dual-mode physical-operator provider and `physical_operator` tool. The daemon stores no raw prompt or terminal screen; a large final result becomes a SHA-256 artifact reference.

#### KV Cache effect

No direct invalidation; the model-visible physical-operator Consumer owns its schema.

## Known Limitations and Deferred Work

- 协议 v1 只支持本地 Unix socket，正式验收平台为 macOS；Windows named pipe 后置。
- 产品原生权限策略仍是权威；DSH 文件沙箱不会自动限制外部产品。
- 人工写接管、durable Jobs 投影、远程算子池、亲和调度与 transcript 持久化均不在首发范围。
