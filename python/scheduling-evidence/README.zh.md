# DSH 调度证据采集器

[English](README.md) | 中文

DSH 调度读取的公开模型证据的 Python 采集器：`codex_radar_provider`（Codex Radar）和 `ai_frontier_provider`（AI Frontier）。它们原样复制自 Codex Workbench，各自保留 SQLite 版本存储，所以抓取失败或载荷非法都不会替换最后一次有效数据。本目录不发布，也不通过 pip 安装。

## 要求

Python 3.11 或更新版本，只使用标准库。把 `src` 放进 `PYTHONPATH`，不需要其他配置。

## 命令行

每个采集器都是一个带 JSON 命令行的模块。所有命令都接受 `--state-root`，输出一行 JSON，结果不是 `ok` 时以非零状态退出。

```sh
export PYTHONPATH=python/scheduling-evidence/src
python3.12 -m codex_radar_provider.cli --state-root "$DSH_HOME/scheduling/radar" status
python3.12 -m ai_frontier_provider.cli --state-root "$DSH_HOME/scheduling/ai-frontier" status
```

`status` 与 `show` 读取已存储的版本。`consent`、`refresh`、`import` 会写入，其中 `refresh` 与 `import` 需要所有者提供的授权文件。只有 `refresh` 会访问网络，并且每个采集器各自强制最小刷新间隔。本目录里没有任何东西会按计划启动采集器；这由后面的调度 Consumer 负责。

## 来源

源码来自 Codex Workbench 主源码 `b358d53978ebc90c53e842c1626011cf40e73b6a`。[来源清单](../../distribution/workbench-scheduling-sources.json)记录了每个文件的 sha256，`tests/test_source_manifest.py` 在复制的文件与清单不一致时失败。Radar 采集器派生自 `wineandchord/codex-radar`，其 MIT 许可声明在 `LICENSE-WineChord-Codex-Radar`。

## 测试

```sh
cd python/scheduling-evidence
PYTHONPATH=src python3.12 -m unittest discover -s tests
```

27 个采集器测试使用本地 fixture，不需要网络。CI 在 Python 3.12 下运行它们。

## 已知限制与延后事项

- 采集器只从它们源码里记录的公开 Codex Radar 与 AI Frontier 端点抓取，复制期间没有联系过这些端点；上游 schema 变化会使导入失败，但不会替换已存储的数据。
- 这里不做分类、排序或选模型。分配器通过后续的 TypeScript 包读取已存储的版本。
