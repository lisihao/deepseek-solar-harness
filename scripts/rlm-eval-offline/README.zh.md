# RLM 离线准备

[English](README.md) | 中文

本目录准备本地数据、固定的 OOLONG 官方 synth 评分器、候选对照臂和预算算法，不包含付费启动器。代码循环只接受脚本式 fake Provider；测试通过不证明实际 DSH 传输已集成、忠实复现论文或 RLM 有收益。

## 本地使用

使用现有含 pyarrow 和 python-dateutil 的 Python 环境，运行 `python3 scripts/rlm-eval-offline/test_offline.py`。该合成验收套件创建临时合成 Parquet，不是真实 OOLONG 题目。代码单元计时在主线程使用 POSIX 信号，仅限制可信夹具，不提供针对恶意代码的隔离。

`prepare_data.py --manifest <local-input.json> --out <new-directory>` 只读取明确指定的本地 Parquet。原始数据模式要求固定数据集 revision 和独立冻结的上游文件校验和；合成模式会在输出中明确标记。输入清单还须提供确切题 ID 和元数据、开发／留出划分、经审查的数据许可依据、经审查的记录提取器指纹，以及含哈希的完整有序 UTF-8 字节区间。缺依据、漏尾部、元数据冲突或跨分区记录重叠都会在发布冻结产物前失败。代码的 MIT 许可不能证明数据集许可。 Parquet 解析直接使用已校验摘要的内存字节；校验后即使原路径被替换，也不能改变导出的记录。

导出把 runner 字段白名单与控制端原始答案字符串分开，带标签上下文不进入 runner JSONL。输出哈希绑定两份文件及原始来源元数据。仅分文件不能证明文件系统或网络隔离；真实试验前必须阻止实际 runner 读取答案。

`official_scorer.py --input <controller-input.json> --out <new-result.json>` 先核对保留的完整上游字节、Git blob 和两个函数 AST，再只执行原始 synth 抽取与评分函数，保留首个 gold、整数数值、比较、DATE 和大小写敏感行为。官方内容分与完成感知分分别保存；未完整结束的 trial 保留官方分，但完成感知分为零。[上游源码](https://api.github.com/repos/abertsch72/oolong/git/blobs/5c8113ee360957cff010d27310e844630216b21d)身份记录在源码中，保留的 base64 字节可解码成完整原文件。OOLONG-Pairs 的独立官方材料冻结前不受支持。

## 对照与预算准备

无密钥 `pilot-receipts.snapshot.ts` 示例通过现有 Loader 装配运行实际 Worker／Runtime，并使用进程内脚本适配器。四个策略分别保留全文 BM25、完整固定分块 map/reduce、外置上下文无子调用和外置上下文递归执行。map 输出经所属 Runtime 完整读取，进入根 Worker 的实际后续请求。外置上下文单元明确请求初始 64 字节片段，完整原文仍在文件中；这不证明全文已读或访问隔离。运行要求现有 Python 3 具备 SQLite FTS5；`DSH_OFFLINE_PYTHON` 选择已有解释器。source 与 plain Node built 模式分别保留回执。

`pilot_receipts.py --bundle <retained-pilot-directory> --out <new-report.json>` 核对实际请求字节、准入尝试、发送、Worker 命令、Runtime 单元结果、子调用归属、完整 map 输入／输出及未变上限，并按最终 Worker 文本块顺序派生完整原始输出。未知生命周期和缺失回执继续留在清单中，记录排除原因；未知用量保留预算预留。可选的 `--source <source-controller> --freeze <frozen-development>` 只把派生的终态输出交给已接受的控制端评分器，报告只能留在控制端。哈希及同进程观察不是独立签名；脚本式发送和用量不是 HTTP 请求、真实 token、费用或实测收益。报告始终保留两个启动／就绪标志为 false。[决策说明](../../.agents/notes/implemented/testing/2026-10-18-native-pilot-receipts.md)列出证据限制。

`controller_scorer.py --source <source-controller> --freeze <frozen-development> --schedule <schedule.json> --results <raw-results.jsonl> --out <new-report.json>` 将经审查的本地来源包与排程中的 synth 输出连接。来源目录包含 `metadata-reviewed.json` 及其固定的五个文件：`rows.jsonl`、`selection.json`、`source-manifest.json`、`record-map.json` 和 `extractor.py`。冻结目录包含 `freeze.json`、runner 的 `cases.json` 和控制端的 `oracles.json`。这是固定本地导出格式，与 `prepare_data.py` 的输入清单格式不同。每项结果提供排程中的 `trial_id`、`case_id`、`input_sha256`、已记录的 `model`、终态 `status` 和完整原始 `output`。适配器核对文件指纹及原始输入身份，再以原始答案字符串调用固定官方函数。重复、未排程、身份不符和未知状态的结果在写入前拒绝；缺失试次保持缺失，不计算用量。报告包含完整输出和 gold，只能保留在控制端。[决策说明](../../.agents/notes/implemented/testing/2026-10-18-scheduled-official-synth-scoring.md)解释了通用已抽取答案分为何单独保留。

`arm_adapter.py` 定义 direct、CodeAct/BM25、CodeAct/subcalls、summary、固定分块 map/reduce、RLM/no-subcalls、flat RLM 和 recursive RLM。CodeAct 与 RLM 使用同一持久 fake 代码／文件循环；Host 持有的 none/root-only/recursive 子调用策略独立于上下文放置。RLM 初始 fake 请求只含上下文句柄和字节数，完整原文保留在持久内核中可读。每次 fake 请求和代码结果均保留。root-only 禁止孙层；recursive 限制深度和累计子调用，不强迫分工。

`preprocessing.py` 使用本地 [SQLite FTS5 BM25](https://www.sqlite.org/fts5.html#the_bm25_function)，记录 SQLite source ID、unicode61、k1=1.2、b=0.75、top-k 和查询；分数相同时按原始记录索引排序。固定记录分块器要求明确的版本化 token 计数器，超长记录整体保留，原始字节不丢失。摘要和固定 map/reduce 按顺序处理全部分块，记录完整 fake 输入并共用整树预算；缺段或未完成分块不能产出成功。合成字节计数不是生产模型 token 上限证明。

`budget.py` 持有候选上限：整树输入 200000、含 reasoning 的输出 16000、物理尝试 24、在途 1、max_tokens 4096、1200 秒新准入窗口、代码单元 64、每单元 10 秒、单次材料读取 8192 字节、深度 2、累计子调用 8。fake 尝试前先预留；未知用量保留预留，已知超预留用量全额记账并停止后续准入。缺输入、reasoning、传输／WP1、模型依据或价格未知时拒绝报价。条件算术不授予启动权限。

## 就绪范围

`preflight.py --inputs <preparation-input.json> --out <new-report.json>` 新建报告，列出官方源码验证、本地依赖版本、候选上限和准确的剩余阻碍。示例输入有意不填真实数据或价格。该离线原型的报告始终保留 `paidLaunchAllowed: false` 和 `experimentReady: false`。

真实原始 Parquet、数据许可依据、经审查的记录提取及真实开发／留出题冻结仍依赖外部输入。实际 DSH Worker 的共同非 RLM 工具循环、提供方／模板输入上限、含 reasoning 的输出上限、完整物理传输／WP1 绑定、答案隔离及模型／价格依据仍须集成。这些脚本不把既有请求字节审计变成发送前 token 上限证明，也不改变任何原 run、历史评分或已安装 Desktop。
