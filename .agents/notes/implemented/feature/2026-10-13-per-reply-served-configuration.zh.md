# Agent Note: 每条回复所用的配置

Status: implemented

[English](2026-10-13-per-reply-served-configuration.md) | 中文

## Problem

用户可以在两个 step 之间更换模型或推理强度，原生 operator 路由还可能运行用户没有指定的模型（Smart Auto）。对话里没有每条回复所用配置的记录：API 回复记录了提供方和模型，没有强度；原生回复只记录了 operator 名。

## Decision

Agent loop 把构建请求时所用的推理强度，以可选字段 `reasoningEffort` 记在 `assistant/message` 的 source 上，与 `provider`、`model` 并列。原生回复在存储中的 source 不变（提供方 `dsh-physical-operator`，模型为 operator id）。Host 只改写这条回复的对外视图（`session.history` 页和实时流）：改为 `<operator>:<原生模型>` 加 `reasoningEffort`，取自同一 turn 和 step 的 dispatch：优先用 daemon 为该命令解析出的配置（`turn.accepted` 进度），否则用 dispatch 自带的 `residentProfile`。没有记录配置的回复仍显示 operator 名。

对话节点把收尾回复的 source 作为 `provenance` 携带，`ui-conversation` 以 `served` 属性交给 `conversation.chat.assistant-actions` 的条目，自己不命名任何模型。`ui-model-selection` 注册说明条目：用模型目录的显示名命名模型和强度，原生回复显示为 `operator · 原生模型`，无法命名模型时什么也不显示。说明只出现在一轮的收尾回复上，中间的工具步骤没有。

## Alternatives considered

**把原生模型写进已存储的回复。** 这会改动 lane 和交接逻辑据以匹配的持久记录（`source.model === operatorId`），旧日志还需要迁移。改写对外视图不动日志，没有配置时退回 operator 名。

**在 `ui-conversation` 里解析名称。** 它不依赖 `ui-model-selection`，反方向的依赖已经存在。通过槽位属性传递，让显示名留在拥有目录的包里。

**每个 step 都显示说明。** 工具步骤会重复收尾回复的配置并让操作栏拥挤；中途的更换可以在模型菜单的"当前生效"提示里看到。

## Consequences

`reasoningEffort` 可选且只增不改：旧日志和旧客户端读取没有它的回复不受影响，回滚只会失去说明。headless 和 ACP 快照日志在请求带强度的位置多出该字段。Web aria 基线多出说明行。

窄屏下说明与复制、分支和时钟共用一行，会被截断，完整文字在悬停提示里。本次改动之前记录的回复显示不带强度的说明。完整快照覆盖 API 路径；原生的 `operator · 模型` 说明由单元测试和 Host 历史测试覆盖，没有完整快照。
