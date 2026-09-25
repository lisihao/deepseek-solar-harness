# Module Inventory - Part 3 (dsh-pet / dsh-live-stats / dsh-liangshen / dsh-tool-describe-image)

仓库 worktree: /Users/zcl/code/dsh-web-ui-perf（分支 perf/webui-plugin-suite）。只读分析。证据格式 文件路径:行号，相对 packages/。复杂度在包内横向比较。全文无 emoji。

## 总表

| 包 | 职责 | 文件数 | 行数(src+tests) | 复杂度 | S.U.P.E.R |
| --- | --- | --- | --- | --- | --- |
| dsh-pet | 鲸鱼娘宠物：会话活动->动画状态机 + 好感/投喂经济 + 持久化 | 25 | 4802 | High | S:pass U:pass P:pass E:pass R:partial |
| dsh-live-stats | 直播 token 估算与吞吐投影（replayable projection） | 18 | 2857 | Medium | S:pass U:pass P:pass E:partial R:pass |
| dsh-liangshen | 梁神锚定 agent preset 的宿主同步 + system-prompt 宣告 | 8 | 979 | Low | S:pass U:pass P:fail E:pass R:pass |
| dsh-tool-describe-image | 模型侧 describe_image 工具：调 vision 端点返回文本 | 20 | 4206 | High | S:partial U:pass P:pass E:partial R:partial |

---

### dsh-pet

职责一句话：把官方 DSH session 事件投影成宠物动画状态机，维护好感度/投喂经济并持久化，向浏览器半区暴露 RPC + 媒体路由。

- host 半区：src/index.ts(148)、src/service.ts(554)、src/routes.ts(171)、src/invariant.ts(40)
- core 半区（纯逻辑）：src/state.ts(160)、src/persist.ts(128)、src/affinity.ts(144)、src/treats.ts(113)；测试 src/*.test.ts(407)、tests/service-enabled.spec.ts(461)
- client 半区：src/client/index.ts(277)、PetDockEntry.tsx(102)、PetSettingsCard.tsx(186)、PluginSettingsCard.tsx(261)、WhalePet.tsx(376)、pet-store.ts(80)、spritesheet.ts(138)、settings-form.ts(303)、locales.ts(139)、pet.module.css(208)、settings-card.module.css(298)
- 公开 API：exports .(host) + ./client + ./invariant + ./src/*（package.json:1-25）；service 方法 state/interact/setVisible/setConfig/setName 映射到 /api/pet/*（service.ts:288-438, routes.ts:116-168）；cordis.patch.yml mount 行 id=pet
- 内部依赖：@deepseek-ai/dsh-session(service.ts:11)、dsh-host-webserver(index.ts:12)、dsh-settings(index.ts:11)；外部依赖 schemastery+clsx，peer react/react-dom（package.json:63-68）
- 复杂度 High：单一 service 同时承载事件投影、好感经济、持久化 flush、RPC 与 settings 双写回环（service.ts:250, 446-469, 547-553），职责交错
- 性能与流畅度：
  - 事件订阅无节流：session/event 每个 chunk 都走 projectOfficialEvent->applyActivity->machine.render（service.ts:316-345）；assistant/chunk 高频（thinking/review 翻转）会被当作活动变更
  - view() 每个读请求都 settleTreats(Date.now()) 并可能触发磁盘 flush（service.ts:513-516, 547-553）；浏览器若轮询 pet.state 会在无休止时写 pet.json
  - affinityView 每次读都按墙钟算 cooldown（service.ts:532-545）；rankOf 线性扫 4 档（affinity.ts:79-85），量级可忽略
  - 浏览器动画循环在 client/WhalePet.tsx(376) 与 spritesheet.ts(138)（重构时核对 rAF/interval 清理）
- S.U.P.E.R：
  - S pass：state/persist/affinity/treats 各单一职责
  - U pass：事件->状态机->视图单向，依赖内聚（state.ts:99-160 无外部引用）
  - P pass：RPC 视图 JSON 可序列化，schema 用 schemastery 定义（index.ts:86-93）
  - E pass：DSH_HOME/持久化目录可注入（persist.ts:64-66, service.ts:55）
  - R partial：settings 写回回环 syncSettingsFromPet(service.ts:457-469) 与 applySettingsSection(446-454) 互为镜像，换 settings 层需两处同步
- 转换注意事项：拆 service 为 event-projection(纯) + ledger + persistence 三件；view() 中结算经济属副作用，移到显式 RPC/定时器；PET_SETTINGS_NAMESPACE=pet 在 host/service.ts:81 与 client 重复拼写，建议共享 core 常量

---

### dsh-live-stats

职责一句话：把会话 token/吞吐投影成可重放的 liveTokenUsage，浏览器半区渲染 TPS 行。

- host 半区：src/index.ts(76)、src/invariant.ts(35)
- core 半区：src/estimator.ts(147)、src/projection.ts(391)；测试 tests/estimator.spec.ts(80)、tests/projection.spec.ts(648)、tests/client-apply.spec.tsx(40)
- client 半区：src/client/index.ts(94)、TpsLine.tsx(51)、LiveStatsSettingsCard.tsx(153)、PluginSettingsCard.tsx(264)、settings-form.ts(322)、locales.ts(65)、settings-card.module.css(298)
- 公开 API：exports .+./client+./invariant+./src/*（package.json:9-23）；host 导出 createLiveTokenUsageProjectionDefinition+resolveEstimatorConfig（index.ts:74-76），无 RPC 路由，纯 projection
- 内部依赖：provider 无关，仅 dsh-session-projection(index.ts:4)、dsh-session/dsh-llm type-only（estimator.ts:1-2）；外部 schemastery+zod（package.json:60-61）
- 复杂度 Medium：projection 折叠逻辑精细但模块内聚，估算深度封顶防栈溢出（estimator.ts:83-99）
- 性能与流畅度：
  - token 事件高频更新经 projection 增量折叠：每次 chunk 重建 active step 对象并复制 buckets（projection.ts:315-339），无节流/批处理，流式输出时每 chunk 一次重建——考虑 coalesce 到 rAF
  - estimator 对 tool-result 递归定价，default 分支 JSON.stringify 整个 block（estimator.ts:110-118），超大 block 每 chunk 全量序列化
  - view() 每次读都重算 rate（projection.ts:238-263）；TPS 行渲染在 client/TpsLine.tsx(51)
- S.U.P.E.R：
  - S pass：estimator(纯定价) 与 projection(折叠) 清晰分离
  - U pass：事件单向 fold 进 state，view 纯派生（projection.ts:284-389）
  - P pass：LiveTokenUsageProjection 视图 JSON 纯序列化，schema 定义于 projectionSchema（projection.ts:274）
  - E partial：投影 spec 冻结在闭包，settings 变更靠 re-register 重放（index.ts:52-64）——统计口径非可移植契约，replay 依赖宿主事件日志
  - R pass：projection 定义经 sessionProjections.register 注入，可替换无需动 client
- 转换注意事项：把 state active/step 拷贝式重建（projection.ts:320-335）改为增量可复用对象减少 GC；estimateContentTokens 的 JSON.stringify 加长度上界缓存；settings namespace live-stats（index.ts:17）与 client 拼写重复，抽共享 core 常量

---

### dsh-liangshen

职责一句话：宿主启动时把捆绑预设同步进 ~/.dsh/.agent-presets 并宣告 system-prompt 段（纯 host，无 client）。

- host 半区：src/index.ts(122)、src/sync.ts(146)；测试 src/index.test.ts(61)、src/sync.test.ts(138)、tests/tool-bootstrap.test.ts(417)、tests/analyze-session.test.ts(95)
- core/client：无（无浏览器半区；presets/ 为数据资产）
- 公开 API：exports .+./presets/*（package.json:15-19）；name=liangshen、inject=[systemPrompt]（index.ts:27-30）、system-prompt section name plugin:dsh-liangshen(index.ts:113)
- 内部依赖：dsh-system-prompt（index.ts:22）；外部 schemastery（package.json:52）
- 复杂度 Low：起止逻辑线性（sync -> announce），无运行时热状态
- 性能与流畅度：
  - 无 rAF/interval；仅启动时同步写盘 1 次，幂等跳过字节一致树（sync.ts:86-109）
  - syncOnePreset 全树读文件比对（sync.ts:87-101），预设文件小可接受；重构时对超大树可加 mtime 短路
- S.U.P.E.R：
  - S pass：index(装配) 与 sync(文件同步) 单一职责，index.ts:80-122 只做编排
  - U pass：调用方向单向（sync -> agent-presets 根），无反向依赖
  - P fail：预设同步契约是目录形态约定而非 schema——agent.cordis.yml 隐式约（sync.ts:5-7），无 JSON Schema/校验；失败仅进 logger.warn（index.ts:91-93）
  - E pass：DSH_HOME 可覆盖，homedir 兜底（index.ts:62-67, 87）；预设目录走 import.meta.url 所在包路径（index.ts:70-72）
  - R pass：预设同步与宣告均经 cordis effect 挂/拆（index.ts:105-121），换宣告渠道零波及 sync
- 转换注意事项：为 agent.cordis.yml 定义 schema 并校验后视作成功，把 warn-only 失败升级为可测结果；dshHome()(index.ts:62-67) 与 dsh-pet 的 petHomeDir()(persist.ts:64-66) 重复实现同一 DSH_HOME 解析

---

### dsh-tool-describe-image

职责一句话：给文本模型一个 describe_image 工具，把本地/URL/attachment 图像交给 OpenAI 兼容 vision 端点，仅把文本答案送回会话。

- host 半区：src/index.ts(560)、src/attach-routes.ts(266)、src/media.ts(52)、src/invariant.ts(4)
- client 半区：src/client/index.ts(102)、attach.ts(120)、send-hook.ts(88)、DescribeImageSettingsCard.tsx(216)、PluginSettingsCard.tsx(308)、settings-form.ts(315)、locales.ts(124)、settings-card.module.css(292)
- 测试：tests/*(1753，含 tool/attach/send-hook/loader-composition/mock-server)
- 公开 API：exports 全五段（package.json:12-26）；name=describe-image、inject=[tools,webServer](index.ts:30-31)；注册工具 describe_image(index.ts:516-559) 与 /describe-image prefix 路由(attach-routes.ts:234-265)
- 内部依赖：dsh-tools、dsh-settings、dsh-credentials、dsh-launch-environment、dsh-attachment(index.ts:20-26, attach-routes.ts:18-22)；外部 schemastery+peer react（package.json:57-59）
- 复杂度 High：index.ts(560) 单文件承载 resolveConfig + apiKey 解析 + loadImage 分支 + 双协议 response 解析 + 工具注册与 settings 双写回环，职责过载
- 性能与流畅度：
  - 每次调用重新 fetch + 全量 base64 入 data URL（index.ts:393-425），无缓存/复用；attachment 读取走 store 校验（index.ts:297-341）
  - 请求 redirect:error + AbortSignal.any 60s 超时（index.ts:430-436），防泄漏与挂起
  - attach 路由保留 128 条注册表 FIFO（attach-routes.ts:57-71）；serveRawImage 每次从 store 读全量字节、cache-control private max-age=3600（attach-routes.ts:197-225）
  - describeImageCallView 纯读卡（index.ts:472-480），无轮询
- S.U.P.E.R：
  - S partial：index.ts 同时做配置解析、凭据解析、协议封送、工具注册（index.ts:120-559），违反 Single Purpose
  - U pass：settings -> spec -> 工具执行单向；attach 路由经 store 校验后回写（attach-routes.ts:144-162）
  - P pass：输出 JSON Schema 严格声明（index.ts:537-548）；ResolvedConfig 明确契约（index.ts:94-104）
  - E partial：API key 走 env/credential seam（index.ts:163-179）合规，但 baseURL/model 依赖外部端点与版本（responses vs chat-completions 双协议 394-424），跨环境需端点就绪
  - R partial：换 vision 端点仅动 callVision/buildVisionRequest（index.ts:393-449），但工具描述 DESCRIPTION_HEAD 与注册主体耦合（index.ts:451-525）
- 转换注意事项：拆 config-resolve/vision-client/tool-register；vision 调用加响应语义缓存（同 image+prompt 短 TTL）；client send-hook(88) 与 attach.ts(120) 是双写路径，抽共享上传/反馈契约

---

## 跨包重复与不一致

- DSH_HOME 解析重复：dsh-pet/persist.ts:64-66 petHomeDir() 与 dsh-liangshen/index.ts:62-67 dshHome() 各自实现同一定义（env DSH_HOME 到 ~/.dsh，含 ~ 展开），应抽共享 core
- settings 卡片样板重复：三包均自带 PluginSettingsCard.tsx（dsh-pet 261 / dsh-live-stats 264 / dsh-tool-describe-image 308 行）、settings-card.module.css(298/298/292)、settings-form.ts(303/322/315)，为同型表单外壳与样式；应以共享设置卡抽取
- settings namespace 双端拼写：dsh-live-stats/index.ts:17、dsh-pet/service.ts:81 在 host 显式拼写并与 client 镜像，字符串未共享 core，改 key 需双端同步
- i18n 注册样板：各包 src/client/locales.ts（dsh-pet 139 / dsh-live-stats 65 / dsh-tool-describe-image 124）各自 ctx.locale.register 注册 zh/en 字典——四包三套重复样板
- host JSON 路由包装：dsh-pet/routes.ts:49-113 的 readJsonBody/getRoute/postRoute 与 dsh-tool-describe-image/attach-routes.ts:164-187 的 readJsonBody/json 信封高度雷同（body 上限截断 + JSON 信封），可并入共享 host 路由 helper
- invariant 文件各包独有：四包均有 src/invariant.ts（dsh-live-stats 35 / dsh-pet 40 / dsh-tool-describe-image 4），遵循仓库 ./invariant 约定而内容独立——重构时统一规范

---

## 给重构任务的 TOP 建议清单

- dsh-pet：(1) 按 事件投影 / 好感经济 / 持久化 三件拆分 service.ts；(2) view() 移出副作用 settleTreats，改显式 RPC 或节流定时结算；(3) 抽共享 PET_SETTINGS_NAMESPACE core 常量；(4) 核对 client/WhalePet 的 rAF/interval 在卸载与 disable 时清理
- dsh-live-stats：(1) 修 projection.ts:320-335 的逐 chunk 对象重建，引入 rAF coalesce 或可复用 buffer；(2) estimateContentTokens 的 JSON.stringify(block) 加长度上界；(3) 共享 live-stats namespace 常量与 estimator spec 契约到 core；(4) 验证 settings re-register 重放对高频事件不丢帧
- dsh-liangshen：(1) 为 agent.cordis.yml 定义 JSON Schema 并在同步后校验，fail 升级为可测；(2) 与 dsh-pet 合并 DSH_HOME 解析到 shared；(3) 同步加 mtime/快速路径避免大树全量字节比对；(4) 移交 sync/announce 的 effect 生命周期到测试门禁
- dsh-tool-describe-image：(1) 拆分 index.ts:495-560，分离 config-resolve / vision-client / tool-register；(2) vision 调用加短 TTL 语义缓存并保持 redirect:error；(3) 抽共享上传/反馈契约供 attach.ts 与 send-hook.ts 复用；(4) 迁移 /describe-image 的 readJsonBody/json 信封到共享 host helper
