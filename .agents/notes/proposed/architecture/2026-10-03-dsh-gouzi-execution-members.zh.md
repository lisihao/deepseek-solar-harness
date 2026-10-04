# Agent Note: 狗子：同一主实例下的长期执行成员

Status: proposed

[English](2026-10-03-dsh-gouzi-execution-members.md) | 中文

## Problem

现在的 DSH 要用户思考服务器：一个本地的、一个远程的，以及会话存在哪一个。用户真正关心的是：谁一直对一个目标负责，直到它被验收。产品方向是一个入口 DSH，加上一小组有名字的工作伙伴，称为**狗子**；它们在 Mac mini 这类宿主上持续执行被授权的任务，主实例负责规划、分派和验收成果。

平台已经具备大部分机制，所以风险在于再造一套：

- `RemotePhysicalOperator`（`packages/orchestration/orchestration-local/src/remote-physical-operator.ts`）通过 `operator.providers`、`operator.execute`、`operator.inspect`、`operator.events`、`operator.interrupt` 在另一台 DSH Server 上执行任务。它发送干净提交的工作区身份，并以执行 ID 作为命令 ID。命令离开进程后传输失败，结果记为 `COMMAND_INDETERMINATE`，从不重发。
- 服务端是 `packages/client/connection/src/index.ts` 与 `remote-sync-host.ts`。`operatorExecute` 先按身份物化工作区，再启动 Resident 轮次。已有连接范围 `pocket`，在这些路由上被拒绝。
- daemon 在 `refreshRemoteOperators`（`daemon.ts`）中，按 orchestration 根目录下的目录文件注册远端 Server，ID 形如 `remote.<serverId>.<operatorId>`。
- 只有配置了集群时，调度权才来自集群选举，`runTick` 受 `canSchedule` 约束。
- `startup.ts` 只接受部署角色 `web` 与 `server`，拒绝 `worker`。启动多台普通 Server 会让每台都有自己的调度器。

狗子不能是改了名的 Remote Frontend，不能是一个 agent 里的十个提示词角色，也不能是十台各自都能调度的普通 Server。

## Proposal

**一个权威，多个执行者。** 主实例保有唯一的全局 TaskGraph、Scheduler、权限策略和验收记录。狗子是独立进程，拥有自己的 home、状态根目录、Session、执行身份和工作树。它不挂载编排调度、集群选举和成员管理服务；这由组合决定，而不是靠提示词。

### 契约

记录定义在 `packages/orchestration/orchestration/src/gouzi.ts`，只有类型和成员上限。

- `GouziRecord` 含 `gouziId`、`ownerId`、`hostId`、`generation`、名字、头像、角色与策略版本、`membership`。
- 成员由三个相互独立的维度描述：`membership`（`provisioning | enabled | retiring | archived`）、`connection`（`online | unreachable`）、`activity`（`resting | queued | working | awaiting-approval | paused | faulted`）。界面显示一个主状态，详情保留三者。
- `GOUZI_MEMBER_LIMIT` 为 10。`countsTowardGouziLimit` 对除 `archived` 外的所有 membership 为真。停止运行或失联的成员仍占槽；只有凭证已撤销、在途工作已结算、进程树已停止或已可靠隔离的成员才变为 `archived`。授权过期不是这种证据。
- `GouziExecutionGrant` 封存一次尝试：run、node、attempt、执行 ID、成员、generation、`authorityEpoch`、计划哈希、读/写/effect 范围、凭证引用、截止时间和 `offlineUntil`。它不携带任何密钥。
- `GouziExecutionReceipt` 重复执行 ID 与请求哈希，并带序号、状态、成果引用和退出证据。相同 ID 与哈希返回已存回执；相同 ID、不同哈希为冲突。
- `GouziCapabilitySnapshot` 是带修订号与过期时间的观测状态。新任务要重新检查。
- `GouziHandoff` 与 `GouziExperienceProposal` 固定后续阶段所需的形状；两者都不增加权限、预算、归属或代码。

### 权威纪元

配对宿主时生成 `authorityEpoch`，宿主保存它接受的那一个。从旧快照恢复的主实例不得派单，必须重新配对，这会生成新纪元并撤销旧绑定。宿主绑定丢失同样需要重新配对；宿主从不接受见到的第一个连接。

### 复用

成员经由现有的远端执行路径到达。P1 增加受限的连接范围、`operatorExecute` 之前的执行授权检查、成员侧的持久幂等账本，以及包装 `RemotePhysicalOperator` 并附带授权的 `gouzi.<id>.<operatorId>` 算子。集群管理、副本和投票路由对成员凭证保持不可达。

### 源码基线

设计对照 `solar` 的 `24526765a4` 核对，这也是当前的头提交。上面每一条都读过该源码：`startup.ts` 的角色、`products/desktop/dsh-plugin-desktop/src/product-server.ts` 的启动器、`connection/src/index.ts` 的算子路由、`orchestration-local/src/store.ts` 的 schema 版本 4。这些都不表示某台宿主或已安装的应用被运行验证过。

### P1 构建的内容

| 范围 | 位置 |
|---|---|
| 受限设备范围 | `packages/host/remote-auth` 与 `packages/client/connection` 中的 `gouzi` 范围：只放行 `describe`、`gouzi.hello` 与 `operator.*`；`/api`、snapshot、replica、cluster、设备名册和事件 socket 都会拒绝它 |
| 成员闸门 | `packages/client/connection` 中的 `GouziMemberService`（Definition 与线上 Consumer）；Provider 为 `packages/host/gouzi-member`（存储的身份、授权准入、持久幂等账本） |
| 成员注册表 | `packages/orchestration/orchestration-local` 中基于 schema 5（`gouzi_hosts`、`gouzi_members`）的 `GouziRegistry`；十只上限是一个立即事务；以 `OrchestrationService.gouzi`（契约里的 `GouziControl`）和 daemon 协议 6 的 `gouzi.*` 方法暴露 |
| 算子 | `gouziOperatorServer` 与 `RemotePhysicalOperator` 里的授权钩子；daemon 在每次刷新时注册已启用的成员，并跟踪 `connection` 与 `activity` |
| 成员进程 | `products/desktop/dsh-plugin-desktop` 中的 `dsh-gouzi-worker`（`prepareGouziWorkerProfile`、`startGouziWorker`）与 `orchestration-local` 的 `./remote-host` 入口；`GouziSupervisor` 负责启动、接管和停止脱离终端的成员 |
| 入口 UI | `packages/orchestration/ui-gouzi`：`/api/gouzi`、`GouziHostService`（Desktop 插件里的 `gouzi-host` 提供它）、六个 SVG 头像、四步领养向导 |

实现中确定的决定：

- **`planHash` 封存实际发送的请求。** 它是不含 `commandId` 与授权的执行请求的 `gouziRequestHash`，所以成员按它收到的内容重新计算。封存的节点计划可以通过执行 ID 从 attempt 找到。
- **成员宿主对每个调用方都要求授权。** 挂载了成员闸门的宿主，对每一次 `operator.execute` 都要求授权，包括回环属主或 SSH 隧道端点（connection 把它们当作 `admin`）。否则 `gouzi` 范围会被绕过。
- **端点属于成员。** 同一宿主上的多个成员监听不同端口，所以端点放在成员记录上，每次启动时替换。
- **明确的拒绝不是传输失败。** 成员返回的 HTTP 400、403、404、409、422 是拒绝；命令发出后的其他失败仍为 `COMMAND_INDETERMINATE`。
- **Resident daemon 比成员活得久。** 停止 worker 会让它启动的脱离终端的 Resident daemon 继续运行，以便持久轮次在重启后仍在；退役会同时停止两者，并且只有没有任何进程残留时才归档。
- **成员不运行调度器。** worker 配置停用所有编排行，只挂载 remote-host 入口；它的 home 里不会产生编排状态。

### 通过 SSH 的远程宿主

成员可以住在另一台机器上，例如 Mac mini，由用户在领养向导里添加这台机器。

- **使用系统 OpenSSH，不新增依赖。** Desktop 的 `gouzi-host` Provider 运行系统自带的 `ssh`、`ssh-keygen` 和 `ssh-keyscan`。再引入一个库只会重复平台信任库、agent 和 `known_hosts` 已经提供的能力。
- **登录之前先由用户确认这台机器。** `host-inspect` 读取主机密钥并展示指纹。`host-add` 带着确认过的指纹，如果机器出示了别的密钥就拒绝。随后密钥被固定在每台宿主自己的 `known_hosts` 里，之后每次连接都用 `StrictHostKeyChecking=yes`。
- **密码只用一次。** `host-add` 通过临时的 `SSH_ASKPASS` 脚本（从子进程环境读取密码）登录，安装一把专用 ed25519 密钥，然后丢弃密码。密码不保存、不记日志、不返回。如果之后发现这台机器不可用，或者宿主被移除，机器能应答时会把这把密钥从远程 `authorized_keys` 里删掉。
- **不上传任何东西。** 远程机器通过 `ELECTRON_RUN_AS_NODE` 运行它自己已安装的 DSH Desktop。`dsh-gouzi-agent` 命令每次调用只做一个操作（`probe`、`resolve`、`browse`、`provision`、`start`、`stop`），并打印一行 `DSH-GOUZI-AGENT` 结果。添加宿主时会检查协议号和最低版本（3.36.0），所以应用较旧的机器会被拒绝，并提示先升级。
- **端点是本机的端口转发。** 成员在远程的回环地址上监听。主实例打开 `ssh -N -L` 指向它，把本地端口记录在宿主目录里，让保存的端点在重启后仍然有效；转发断开时用同一个端口重开，只有旧端口被别的进程占用时才换新端口。远程成员的每次调用仍然需要执行授权，转发不会给它额外权限。
- **不改 schema。** 编排存储保留宿主行（标签、授权纪元、凭据引用）。SSH 地址、用户、专用密钥和固定的主机密钥放在 Desktop 的目录 `gouzi/hosts` 里，所以 schema 仍是 5。

限制：任务的工作区身份取自主实例上一份干净的 Git 检出，因此只存在于远程机器上的仓库暂时还不能接收任务；这需要“远程常驻工作区身份”，是下一块要做的事。面向用户的“本地／远程 Server”选择入口会保留到远程成员覆盖这种情况为止，之后连同已保存 Server 条目的迁移一起退役。

### 阶段

P0 是本文与契约类型，不改变任何行为。P1 是一只成员的端到端：从入口 UI 创建，配对试点宿主，在隔离工作树里执行一个被授权的任务，持久化回执和成果，由主实例确认。P2 增加原子资源准入、进程树回收、有限离线执行，以及取消与重连处理。P3 增加角色、自动分工、受限消息和独立验证。P4 增加经验提案、带版本的发布与回滚，以及迁移。计算机操作（CUA）不在范围内。

## Alternatives considered

**给 Remote Frontend 改名。** 它是没有独立执行身份的展示角色，改名会声称存在一个并不存在的工作者。

**用 `server` 角色启动普通 Product Server。** 每一台都能运行调度器并参加集群选举，破坏唯一权威；成员数量也只能靠人工限制。

**一个 agent 里的十个提示词角色。** 它们共用一个 Session、一个进程和同一组权限，无法分别隔离、恢复和审计。

**让成员加入集群。** 休眠成员会占用法定人数，离线成员会拖住调度。

**宿主上的第二份任务数据库。** 两个存储可能对任务状态各执一词。主存储仍是唯一写入者；成员只保存自己的执行日志和未确认的回执。

## Acceptance criteria

- 契约导出可编译，上限与 membership 规则有测试，`doc-sync` 通过。
- 差异不改任何启动器、调度器、连接路由、UI 或默认值。
- P1 满足设计中对应的各项：创建并重启后身份不变（A01）、两次隔离执行（A02）、成员凭证在集群与成员管理路由上被拒（A03）、错误的 generation、owner 或计划哈希在任何副作用之前被拒（A04）、重复的执行 ID 返回已存回执且不同哈希冲突（A05）、关闭窗口不会停止任务（A08）、丢失响应后对账而不二次派发（A10），以及第十一只被拒。

## Risks

受限的连接范围会触碰认证，所以每一种拒绝都要有负例测试。Schema 5 是单向迁移，旧程序无法打开新库；备份与回滚边界必须在 P1 合并前写清楚。P1 的任务从干净提交开始，脏工作区需要在之后的阶段显式生成快照。成员与其他成员共用宿主用户，这里的隔离指状态与工作树分离，而不是租户之间的安全边界。
