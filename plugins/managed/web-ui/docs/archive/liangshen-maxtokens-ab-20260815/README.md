# 梁神模式 bootstrapMaxTokens A/B 实验归档（2026-08-15）

一次性实验快照，不进入长期文档。内容为 dsh-liangshen 新增
`bootstrapMaxTokens`（phase 1 首轮 maxTokens 封顶 1024 + 晋升剥离）的实测数据。

## 背景

社区实验（xiaobright/dsh-anchored-standard issue #6）显示首轮
`max_tokens=1024` 时 "We need" 轨迹命中率 81%，256000（DSH 默认）时 0/5。
本实验在用户本机复测该效应，并验证优化实现无副作用。

## 测试环境

- profile：`liangshen-headless`（`~/.dsh/profiles/liangshen-headless`，dsh-base +
  dsh-headless + 自定义 runner 挂载梁神 preset）
- 模型：DeepSeek V4 Pro + reasoningEffort=max（settings 独立文件，不碰全局）
- 对照组 preset：`liangshen-baseline`（复制 liangshen 删去 bootstrapMaxTokens 行）
- 任务（固定英文）：`Inspect the repository /Users/zcl/code/dsh-web-ui: list the
  top-level package directories under packages/ and report how many there are.`
- 指标：首个 assistant reasoning 块词法分类（\bwe\b / \blet me\b，minimal-like =
  we>0 且 letMe==0）

## 结果

### opencode-go 中转（`ls-ab`，每组 6 个新会话）

| 组 | maxTokens | minimal-like | standard-like | ambiguous |
|---|---|---|---|---|
| baseline | 384000 | 6/6 (100%) | 0 | 0 |
| cap | 1024 | 6/6 (100%) | 0 | 0 |

### 官方 API（api.deepseek.com，`ls-ab2`）

| 组 | maxTokens | minimal-like | standard-like | ambiguous |
|---|---|---|---|---|
| baseline | 384000 | 5/6 (83%) | 1（we+let me 混合） | 0 |
| cap | 1024 | 5/5 (100%) | 0 | 0 |

## 结论

1. 本机两个端点均未复现社区 "256k→0/5"（干净环境 + 当前服务端行为下 384k 也有
   83-100% we）；max_tokens 效应是环境相关的边际稳定器，非普适开关
2. 1024 封顶无副作用：任务完成质量正常，晋升后 wire 正确剥离回 384000
3. 本机当前梁神配置（双工具 phase 1 + 注入剥离 + 极简面）首块 we 概率基线
   83-100%，历史全量基线 40% 的低值来自旧 wire（bash+read 6.8%）、中文/子代理
   任务与 web 环境干扰

## 文件

- `sessions/*.jsonl.zstd`：35 个实验/验证会话原始记录（含 reasoning，不公开转发）
- `outputs/*.out`：headless 运行输出（两组各 6/5 次 + 验证）
- `scripts/`：批量运行与分析脚本（run-ab.sh、final*.py）
- `liangshen-facts.md`：调研事实链（截图结论 / modeltest / issue #6 交叉对照）
