# Agent Note：一次评测 scope 的请求账本

Status: implemented

[English](2026-10-15-evaluation-request-ledger.md) | 中文

## 问题

RLM 运行是一棵树：root、child、孙代、它们各自的 continuation，以及每个节点里的工具循环。每个模型轮次都是一次物理 HTTP 请求。此前没有任何东西在整棵树上计数这些请求。`maxDepth`、`maxChildren`、`maxTurns` 约束的是树的形状，不是请求；Goal 记账在事后记录 usage 且不含缓存读取；工具循环只合并 usage，下一轮之前从不检查；worker 无法设置 `max_tokens`，所以每个请求都带 adapter 默认的 256000；agent 级的重试策略（`maxRetries=2`）也不等于 worker 的请求。付费评测需要相反的东西：请求离开进程之前就检查并记录的限额，整棵树共用，并如实说明自己不知道什么。

## 决策

**home 就是 scope。** daemon 根目录里的 `evaluation-scope.json` 把该 home 封存给一次评测：scope id、唯一允许的模型、`inputBound` 模式、累计输入 token（含缓存读取）、累计计费输出 token、HTTP 尝试数、并发请求数、单个请求的 `max_tokens` 的限额，以及 `thinking: enabled` 和推理 effort。它在启动时严格校验（任何字段都没有默认值），并按哈希封存进账本。一个 home 就是一个 scope，所以该 daemon 的所有派发共用一份账本，重试不能换来新的预算。用户全局的 provider、模型和 effort 设置不受影响。

**准入在物理请求处。** `GenerateOptions.admission` 是一个闭包，DeepSeek adapter 在序列化请求体之后、`fetch` 之前，用线上请求的事实（请求体字节数和 sha256、模型、`max_tokens`、thinking、effort、是否含非文本内容）调用它。两边都必须显式选择：adapter 声明 `enforcesAdmission`，对不强制准入的 adapter 设置 admission 的调用会失败而不是不计量地运行。账本把线上的值与 scope 比对，不一致就拒绝，从不改写。检查、预留和持久写入（临时文件、fsync、rename、目录 fsync）是同一个同步步骤，所以并发请求不会同时拿到最后的余额，预留在请求发送之前就已在磁盘上。

**预留是什么。** 输入是请求体的字节数。输出是请求的 `max_tokens`。同时占用一个尝试名额和一个并发名额。`usage` chunk 到达时（`translate` 只在 `[DONE]` 时产生它）在它传出之前结算；输入是 `inputTokens + cacheReadTokens`，输出是 `outputTokens`（API 的 `completion_tokens` 已包含 reasoning，所以不再重复加）。其他一切都让预留保持 `unknown`：中止、空闲超时、任何类别的错误状态、`[DONE]` 之前断流、没有 usage 的 `[DONE]`、消费者停止读取、崩溃。unknown 的请求继续占用预留和并发名额，因为它可能仍在 provider 处运行；它绝不释放也不重新发送，只有已核对的回执才能结束它。重启时所有在途请求变为 unknown。结算幂等；冲突的第二次结算是完整性故障并停止准入。超出预留的 usage 按报告值计入，同样停止准入：界限或上限没有守住，账本如实说出，而不是截断数字。

**输入上界是被审计的，不是被证明的。** 只有分词器是字节级、且聊天模板增加的内容不超过 JSON 结构时，请求体字节数才是 token 数的上界。这两点对该 provider 都没有被证实，官方 API 参考也没有明说 `max_tokens` 包含 reasoning token。所以 scope 必须写明 `inputBound`。`request-bytes-audited` 是唯一会准入请求的模式，各处都把它描述为字节预留加事后审计。`proven-token-count` 要求发送前证明的上界，本构建给不出，所以它不准入任何请求。任何地方都不使用字符数除以四的估算。

**同一时间只有一个所有者，账本在被信任之前先校验。** 账本在读写任何内容之前先取得自己的所有者锁。锁文件通过一次硬链接完整发布，所以不存在锁文件已存在却没有所有者的时刻；已被持有或读不出的锁绝不接管，过期的锁在一个以同样方式发布的排他接管 guard 之下替换：接管者在 guard 之下重新读取该锁，只有它仍是读到的那把过期锁才删除，若有新的所有者抢到新锁，接管者就退出。不会对可能已被别的进程重新填充的路径做重命名。接管中途死掉的进程留下的 guard 会让之后的接管失败关闭，直到手工删除。`close()` 之后对象不再写入，所以旧的票据、admission 或回执不能覆盖新所有者持有的文件。daemon 在持有自己的锁之后才打开账本，因为 daemon 锁把没有 pid 文件的锁当作过期。持久化文件在任何恢复写入之前先校验（版本、键、状态、计数、跟随序号的唯一 id、与 usage 和预留一致的状态）；校验失败的账本逐字节原样保留且不发送任何请求，合计超过最大精确整数时，在任何在途请求被标为 unknown 之前就拒绝。

**失败即关闭。** 在 scope 之下只允许 DeepSeek API worker 运行，Resident 和远程算子的派发被拒绝，所以 API worker 的模型请求都不能绕过账本离开 daemon，加载进 daemon 的其他插件通过其上下文发起、且不带 admission 的模型调用会被 `llm/stream` 上的监听器拒绝。scope 的模型会发送到线上，不论分配选了什么；`model.allocated` 事件仍显示分配结果。三层分开计数：graph 尝试、工具轮次（每个请求的标签写明其命令和轮次）、已准入和被拒绝的 HTTP 尝试。

## 考虑过的替代方案

**只在 worker 里计数。** 否决：之后的重试或中间件可能再次调用 adapter，而且 worker 看不到序列化后的请求体。准入放在 fetch 处。

**用字符数除以四估算输入 token。** 否决：这不是上界，而不会被突破的上限必须来自上界。

**释放被放弃请求的名额。** 否决：该请求可能仍在运行并计费。代价是在 `concurrentRequests = 1` 的 scope 里，一个 unknown 请求可以一直占着唯一的名额，直到回执被核对。

**让评测 runner 用启动参数而不是文件启动 daemon。** 暂不采用：daemon 由客户端以固定参数启动，而隔离 home 里的文件由该 home 封存。

## 后果

字节预留没有被证明接近真实 token 数：它可能大得多，并持有到结算，所以并行的 child 可能被提前拒绝，每个 unknown 请求都持有其完整预留。保证恰好是这些：受计量的 API 路径上的请求，在离开之前被计数、预留并写盘，且使用 scope 指定的生成参数。它不是被证明的 token 上限，不是网络或凭据隔离（REPL 中的代码仍可自行访问网络），也不是墙钟限制。目前没有生产代码核对 unknown 请求。`model.allocated` 和 `rlm.usage` 事件仍显示分配所选的模型，所以成本必须从账本计算。

三个结论要分开。（1）生成参数逐个物理请求贯通：scope 的模型、`max_tokens`、effort 和 thinking 模式出现在每次普通调用和工具循环的每一轮的线上请求里，fake 端点收到的请求体可以印证。（2）准入可核验：收到的每个请求体都按 sha256 对应到唯一一个已准入的尝试，账本记录每个尝试预留了什么、用了什么。（3）针对真实 provider 的严格 token 总上限**没有**被证实。官方 Chat Completions 页面把 `max_tokens` 定义为可生成 token 的最大数，并把 `reasoning_tokens` 列在 completion 明细之内，这支持把 reasoning 看作 completion 的一部分，但没有说上限包含它（只有 Responses API 对 `max_output_tokens` 这样明说，而本代码不使用那个 endpoint）。token 用量页面提供文本的离线分词器，并说明不同模型分词不同、以 usage 为准；没有找到对完整 messages、工具 schema 与结果、聊天模板和服务端包装的发送前计数或上界。请求字节数、文本 token 数和上下文容量是不同的事实。所以 `request-bytes-audited` 是被审计的预留，而需要那份证明的 `proven-token-count` 会拒绝所有请求；这只验证安全拒绝，并不意味着可以运行正式评测。不切换 endpoint，不降低 reasoning，也不提高预算来绕过这一点。

## 测试

`evaluation-ledger.spec.ts` 覆盖 scope 文件、准入、每一种拒绝、结算、重启、unknown 请求、所有者锁，以及一张损坏账本文件的表。`admission.spec.ts` 用真实 adapter 对接回环服务器，检查给 admission 的事实、结算与 yield 的先后，以及每种必须保持预留的结束方式。`worker-evaluation.spec.ts` 检查每一轮的生成参数。`daemon.spec.ts` 用真实 daemon、worker 和 adapter 对接回环端点，跑 root、child、孙代和 continuation，把收到的每个请求体按 sha256 对应到唯一一个已准入的尝试，并覆盖耗尽、缓存读取、界限违反、带 unknown 请求的重启、同一根目录上的第二个 daemon 以及损坏的账本。无 key 的 `prime-rlm-evaluation` 快照通过生产 Loader 和 daemon 做同样的事，只替换 provider。适配器测试（`evaluation-adapter.spec.ts`）和 `daemon.spec.ts` 中的评测测试使用回环端点和假 key，并安装一个让任何其他主机的 `fetch` 抛错的 guard；`evaluation-ledger.spec.ts` 和 `worker-evaluation.spec.ts` 不发送任何请求，`admission.spec.ts` 使用回环服务器但没有这个 guard，生产 Loader 快照只给它启动的 daemon 配置回环端点和假 key，没有安装这样的 guard。携带 admission 的调用不跟随重定向（307 或 308 会在一次准入下再次发送 POST），两个回环端点证明第二个端点收不到它。Loader driver 保存被放弃的请求，清理期间拒绝新请求，并再次查找晚启动的 daemon，有对应的故障测试。这些都不能证明真实 provider 的 token 计数遵守字节预留。
