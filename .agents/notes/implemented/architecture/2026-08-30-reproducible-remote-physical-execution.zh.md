# Agent Note: 可复现的远程物理执行

Status: implemented

[English](2026-08-30-reproducible-remote-physical-execution.md) | 中文

## Problem

远程 Physical Operator 最初会转发调度机器的绝对工作区路径，并且对超大结果只保留远端 Resident Artifact 引用。绝对路径在另一台 Server 上没有稳定含义；只有远端引用也会使调度权威无法独立保留和验证结果。远程容量还独立存放在 `remote-operators.json`，与 `cluster.json` 分离，因此成员表与可调度容量可能漂移。

## Decision

Remote Sync 传输版本化工作区身份，包括不含凭据的规范仓库身份、精确干净 Git commit 和可选仓库相对子目录。`@deepseek-ai/dsh-client-connection` 持有该线路约定和 `ctx.remoteOperatorHost` Service Definition；`@deepseek-ai/dsh-orchestration-local` 提供 Server 本地 Git 与 Resident 产物实现。接收 Server 只解析其本地允许列表中的仓库，在所有者私有缓存中保留不可变 Git 对象，并为每条 command 建立带租约的独立可写 checkout。发送端绝对路径与 Git 凭据都不会进入线路。只有资格审查证明本地集群成员启用了远程执行且至少一个配置仓库可物化时，Server 才声明 execute。

Remote Sync 会在有界读取 deadline 内为超大 Resident 结果引用暴露最多 8 MiB 的精确不可变 JSON 字节。调用方针对这些字节验证所声明的 SHA-256，校验完整的提供方无关结果，并在向 Scheduler 返回结算结果前把带来源的封装写入本地 Orchestration CAS。已接受命令身份、轮询亲和性、indeterminate 处理和 generation fencing 均不改变。协议 1.3 仍与 1.4 Server 的投影读取兼容，但不会准入旧 execute 形态。

`cluster.json` 同时持有选举成员表与远程执行容量。每个成员都可以声明 `remoteExecution`，其中包含启用状态、轮询间隔与仓库允许列表。旧 `remote-operators.json` 只在没有集群成员声明远程执行时作为迁移输入；同时使用两种来源会报错。

## Verification

聚焦 composition 测试会从真实临时 Git 仓库派生身份，在 Server 侧物化其精确 detached commit 与子目录，证明并行 execution 不会共享 tracked 或 untracked 修改，拒绝脏工作区或未知仓库，对精确 Resident 产物字节执行损坏／大小／取消检查，把完整结果持久化到本地 CAS，并验证线路请求不含绝对工作区。选举测试会暂停 vote 与 heartbeat，证明新 term 能栅栏迟到完成；daemon 测试证明 close 会等待 tick 静止并持久化脱离调用方的 tick 失败诊断。

## Alternatives considered

**转发或改写绝对路径。** 拒绝，因为相同路径文本既不能标识相同内容，也不能证明两台机器共享文件系统。可配置前缀映射只会复制这种歧义，而不是定义输入。

**允许每台远程 Server clone 调用方提供的任意 URL。** 拒绝，因为仓库可用性与凭据属于部署关注点。线路只标识内容；Server 本地 Provider 持有如何获得允许仓库的决定。

**只在执行 Server 上保留超大结果。** 拒绝，因为调度权威无法证明或保留已结算 Attempt 背后的结果。复制精确字节并写入调用方 CAS 会同时保留远端与本地内容身份。

**让成员目录与容量目录保持独立。** 拒绝，因为陈旧的第二目录可能把工作调度到当前权威拓扑之外的节点，或遗漏有效成员。

## Consequences

- 远程工作只接受带 origin 与 Server 本地允许列表条目的干净已提交 Git 输入；未提交修改必须先形成 commit 才能派发。
- 每台执行 Server 自行决定 source 路径或不含凭据的 URL，因此仓库凭据留在 Remote Sync 之外。
- 精确 Git 对象会被缓存，而每次 execution 都得到独立可写 checkout；观察会续租，只有已证明 settled 后才释放。
- 大型远程结果会在 Scheduler 观察到终态输出前增加一次有界产物传输和一次本地 CAS 写入。
- 容量发现与 Leader 选举共用一份成员表；成员变更仍要求显式的固定集群配置。
