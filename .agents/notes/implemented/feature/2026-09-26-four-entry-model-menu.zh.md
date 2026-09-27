# Agent Note：四个模型菜单入口

状态：已实现

[English](2026-09-26-four-entry-model-menu.md) | 中文

## 问题

Desktop 模型菜单约有 37 行：三个 DeepSeek 模型、每个物理算子一行，以及每个已刷新的 Codex（20 个）和 Claude Code（11 个）目录中的每个原生模型一行。所有者实际只用其中四个入口驱动工作。其余模型应在编排时按成本、质量、推理强度和任务特征逐个任务选择，而不是手动挑选。原生菜单行只存在内存里，重启后要显式刷新才会重新出现。协作面板的基础页还提供五种路由偏好和主模型自有的原生配置；分配器也因为 GPT-6-Astra 的名字不匹配任何档位规则，把 Codex 的前沿模型评为中档。

## 决策

Solar 产品提供四个入口：DeepSeek-V4-Pro、Codex 最新的两款原生模型和 ChatGPT Web。

`tool-physical-operator` 新增可选的 `Config` 字段，不设置时菜单保持原样。
- `entryOperatorIds` 列出作为独立入口的算子。
- `latestModelEntries` 让一个算子只通过其最新的原生模型提供入口。跳过指向其他提供方的转接 id（`openrouter/…`）。其余按 id 解析出的代数从新到旧排序，同一代内保持目录自身顺序；最新一代不足时由上一代补齐。第一个选中的模型显示在算子本身的入口上，选择该入口时固定使用这个模型，强度取菜单选择或目录默认值。其余的是 `operator:model` 入口。
- `stateRoot` 把刷新得到的目录保存在 `native-catalogs.json`。刷新时某个目录不可用，会保留该算子上一次成功的模型。

Desktop 与 Product Server 都会加载的 resident-operators bundle 设置 `entryOperatorIds: [chatgpt-web]`、Codex 的 `count: 2`，以及 `stateRoot: $DSH_HOME/physical-operator`。它还把 `llm-deepseek.models` 收窄为 V4-Pro，并设置新增的 `discoverModels: false`，因此刷新既不调用 `GET /models`，也不添加端点 id。产品默认模型仍是 `codex` 本身的入口，它现在运行最新的旗舰模型。

协作面板的基础页提供智能协作和仅主模型。Codex、Claude Code 和 ChatGPT Web 偏好移到高级调度页，作为「固定协作者」，与固定的原生模型和强度放在一起。Codex 主模型的模型和强度来自其菜单入口，因此没有主模型自有的配置。分配器的档位规则加入 `astra`，并把目录描述含 "frontier" 的模型视为高档、含 "fast" 或 "affordable" 的视为低档。

## 备选方案

**把两个 Codex 模型 id 写死。** 每次 Codex 发布新模型都要改产品。按实时目录排序后，刷新即可移动入口。

**使用 `codex:@latest-2` 这样的稳定槽位 id。** 刷新时，所有使用第二个入口的会话都会悄悄换模型。使用显式的 `codex:<model>` id，会话保留自己选的模型；只有算子本身的旗舰入口跟随最新模型，这与 Codex 默认模型原有的行为一致。

**保留 DeepSeek 的端点发现。** 刷新会把 `/models` 返回的每个 id 重新加入菜单，单一 DeepSeek 入口就失效了。

**只在客户端隐藏原生模型。** Host 目录仍会公布这些模型，其他读取目录的消费方会与菜单不一致。

## 后果

- 已在使用不再提供的模型的会话仍路由到该模型，菜单对它们显示 `Select model`；使用 `codex` 本身入口的会话现在运行旗舰模型，而不是已保存的 Codex 配置。
- Claude Code 和非入口的 Codex 模型仍然注册，委派和 TaskGraph 分配照常使用它们。
- 新安装在第一次刷新记录目录之前，列出的是 `Codex` 本身的入口。

## 延后事项

[智能协作分配](2026-09-26-smart-collaboration-allocation.md)现在负责为被委派的请求选择协作者和模型。任务特征匹配、推理强度选择，以及 DeepSeek 按轮次选强度，仍是同一设计中的提案。
