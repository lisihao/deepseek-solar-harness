# 模块清单 part2 — dsh-aionui-panel / dsh-remote-web-ui / dsh-web-ui-settings / dsh-skins / dsh-web-ui-all

> 本文是 spec-driven 重构的模块分析后半（part1 见同目录 sibling）。数据源 worktree
> /Users/zcl/code/dsh-web-ui-perf @ perf/webui-plugin-suite（base main@a7a38401）。
> 全部为只读分析；行数为 git ls-files 源码（剔除 lib/ 构建产物与 node_modules）。
> S.U.P.E.R 判定按 super-philosophy.md 的 10 项检查清单打分，兼容性另注。

## 总表

| 包 | 职责 | 文件数 | 行数(源码) | 复杂度 | S.U.P.E.R |
| --- | --- | --- | --- | --- | --- |
| dsh-aionui-panel | 右侧 Explorer/预览/SCM 面板 | 63 | 11612（含 lib） | 高 | partial |
| dsh-remote-web-ui | 移动端远程控制+配对+自更新 | 76 | 14939（含 lib） | 高 | partial |
| dsh-web-ui-settings | Web UI 设置组+社区插件索引 | 28 | 2141 | 低-中 | pass |
| dsh-skins | 皮肤聚合载具（skins/* 内置资产） | 59 | 3505（含 lib） | 中 | partial |
| dsh-web-ui-all | 全家桶聚合载具+compat shim | 14 | 425 | 低 | pass |

> 注：aionui-panel 源码 src/ 合计约 2948 行（host ~1492、client ~1396、core 160）。
> remote-web-ui 源码 src/ 约 10217 行（mobile 页面占 ~5000），host 半区约 2900 行。
> dsh-skins 载具源码 968 行不含内置 skins/* 资产；含 lib 产物时行数被编译物放大。

---

## dsh-aionui-panel

### 模块条目
- 职责：工作区门控的文件系统+git 服务与 /aionui-panel/* HTTP 路由（含 SSE 变更流），浏览器半区挂载右侧 Explorer/预览/SCM 面板（packages/dsh-aionui-panel/src/index.ts:6-19）。
- 文件清单/半区：host = src/host/{fs-service,git-service,routes,gate}.ts（共 1442 行）、client = src/client/** 含 store.ts(1122) 与 preview/mount/drag/layout（约 1400 行）、core = src/core/types.ts(160)。
- 公开 API：exports 提供 host 半区与 browser 半区（package.json:26-35）；inject 依赖 webServer/subprocess/workspaceRegistry/systemPrompt（src/index.ts:26-27）；RPC 路由 /aionui-panel/list|read|write|search|delete|git-status|git-diff|git-stage|git-unstage|git-discard|raw + 精确路由 /aionui-panel/events SSE（src/host/routes.ts:254-345,430-432）；另注册系统提示段 plugin:aionui-panel（src/index.ts:42-47）。
- 内部/外部依赖：peer react；dev @deepseek-ai/cordis + dsh-host-webserver/subprocess/workspace/system-prompt + client-locale/client-runtime/client-ui-conversation（package.json）。
- 复杂度评级：高。最大文件 src/client/store.ts(1122 行) 同时承载 explorer/scm/preview 三个 store 远端语义；重复模式见文末跨包清单。

### 性能与流畅度观察
- git 轮询：SSE 连接期间 setInterval(pollGit,30s)（routes.ts:52,398），对每个订阅者跑 git.statusCanonical + rev-parse（routes.ts:105-118）；anti-overlap 用 polling 布尔闸，git status 有 15s 超时守卫（routes.ts:94,123,62-66）。
- SCM 刷新以 fs watch + focus 事件驱动为主，轮询只补外部 .git 写入（routes.ts:35-40）。
- 客户端每个 store 各持 150ms debounce persist + searchTimer（store.ts:247-264,505-524,741-762）；pagehide/visibilitychange 时 flushNow（client/index.ts:147-159）。
- 预览打开动画用 setTimeout 300ms 移除 class（client/index.ts:128-131）；raw 图片路由 cache-control:no-cache 每次全量读文件、大图无流式（routes.ts:214-222）。
- 潜在热点：fs.search 全量遍历文件名、无索引；每个 SSE fs 事件触发 explorer+preview 两个 store 的 handleFsChange 重取（client/index.ts:95-98）。

### S.U.P.E.R 逐条
1. 单职责（文件级）partial：routes.ts(444) 同时承载 JSON 信封、SSE 订阅簿、loopback 栅栏、git 轮询调度四个概念（src/host/routes.ts:6-429）。
2. 函数单概念 pass：apply/gate/各 handler 职责单一。
3. 数据单向流 pass：host 服务 -> 路由 -> SSE -> store，无反向依赖。
4. 无循环 import pass。
5. 跨模块接口 schema 定义 fail/partial：core/types.ts(160) 只有 PanelEnvelope/PanelError 类型，各 RPC payload 靠 routes 内手写 strField 解析（routes.ts:93-166），无 JSON Schema。
6. I/O 可序列化 pass：全部走 JSON 信封。
7. 无硬编码路径/URL partial：路由前缀 /aionui-panel 在 host 与 client 两处手写字符串，无单一权威常量。
8. 依赖显式声明 pass。
9. 可替换性 partial：FsService/GitService 走构造注入（src/index.ts:33-35）好拆，但浏览器 api.ts 把主机协议耦合进每个 store，换主机会波及 store。
10. 测试全过 pass（tests/ 15 个 spec）。

---

## dsh-remote-web-ui

### 模块条目
- 职责：移动端远程控制 host 半区（配对/令牌/设备会话/revoke + /api/pair 路由族 + api/gate LAN 栅栏 + presence 清扫 + 自动隧道 + 自更新）；client 渲染侧栏配对面板；mobile 独立页面 bundle（packages/dsh-remote-web-ui/src/index.ts:6-9）。
- 文件清单/半区：host = src/{index,routes,pairing,gate,lan,tunnel,update,update-routes,mobile-routes,mobile-api}.ts（约 2900 行）；client = src/client/*（约 1900 行）；mobile = src/mobile/** 含 mobile-styles(856)、views/ChatView.tsx(758)、messages.ts(555)，独立 bundle 经 src/mobile/index.tsx 构建为 lib/mobile.js（mobile-routes.ts:4-11）。
- 公开 API：exports host / ./invariant / ./client（package.json:18-29）；RPC 路由 /api/pair/{issue,accept,stop,heartbeat,status,events}（routes.ts:40-58,322-345）；/m 页面 + /m/api/* 代理 + /m/api/events.mux SSE（mobile-routes.ts、mobile-api.ts:87-201）；api/gate 事件栅栏（src/index.ts:266-268）。
- 内部/外部依赖：dependencies 含 cloudflared/clsx/qrcode.react/zod；@deepseek-ai/dsh-host-webserver/apiproxy/settings/subprocess + client-runtime/connection/ui-settings/ui-sidebar。
- 复杂度评级：高。最大文件 mobile-styles.ts(856)、ChatView.tsx(758)、messages.ts(555)；移动端与 host/desktop 双套面。

### 性能与流畅度观察
- SSE 双通道：desktop /api/pair/events（routes.ts:186-238）+ mobile /m/api/events.mux（mobile-api.ts:162-201，15s heartbeat）。隧道可能不透明转发 SSE，MuxClient 用 12s 静默阈值 + 3s 轮询回退（mux.ts:33-43,60-62）。
- ChatView 尾部缓冲：初始历史页在途时事件进 liveBufferRef，达 MAX_TAIL_BUFFER_EVENTS 上限丢最旧并重拉（ChatView.tsx:33-39,119-122,232-244）；stuck 历史有 setTimeout 超时（ChatView.tsx:153-159）。
- session.list 在 host 侧分页（SESSION_PAGE_SIZE=20 + cursor，mobile-api.ts:37-49,190-241），避免手机整表传输。
- 移动 bundle 完全自包含（mobileBundle 预设 external:[] 全部内联，shared/tsdown.client.ts），首载体积大但无二次依赖。

### S.U.P.E.R 逐条
1. 单职责（文件级）partial：index.ts(362) 同时编排配对服务、隧道、自更新、settings section、gate、路由生命周期六件事（index.ts:142-335）。
2. 函数单概念 partial：apply() 内嵌 enabled 开关的状态机分支（disposeRoutes/disposeSweep 手动生命周期，index.ts:288-328），是单个大调度器。
3. 数据单向流 pass：service -> routes -> SSE/mux -> client。
4. 无循环 import pass。
5. 跨模块接口 schema 定义 partial：Config 有 schemastery schema（index.ts:66-83），mobile mux 帧用 schema 校验（mux.ts:8-9）；但 /api/pair 各端点 payload 仍手写 parse（routes.ts:96-118），无独立 schema。
6. I/O 可序列化 pass。
7. 无硬编码路径/URL partial：/m/mobile.js 硬编码于 mobile-routes.ts:30；PAIR_PATHS 常量集中（routes.ts:40-52）好。
8. 依赖显式声明 pass：cloudflared 等全在 package.json dependencies。
9. 可替换性 partial：gate/routes/service 走注入可换，但 mobile-api 按方法名白名单与注入边界耦合（mobile-api.ts:27-34），换 host 传输层要同步改。
10. 测试全过 pass（tests/ 12 个 spec + mobile 单测）。

---

## dsh-web-ui-settings

### 模块条目
- 职责：设置界面注册 Web UI 插件组卡片（WebUIPluginsCard + CommunityPluginsCard）与 settings 兼容作用域 shim；host 侧 allowlist + bridge 提供社区插件跳转/校验（src/index.ts）。
- 文件清单/半区：host = src/{index,allowlist,bridge,protocol}.ts（469 行）；client = src/client/* 含 index.ts(86)、compat-settings-scope.ts(312)、两张 Card（83+73）、locales(56)；generated/community.ts(35) 为构建生成。
- 公开 API：host 注入 dsh-settings 注册设置 section；client 经 slot 注入设置组卡片、声明 web-ui.plugin.item 子槽位（src/index.ts、client/index.ts:22-85）。
- 内部/外部依赖：schemastery + @deepseek-ai/dsh-settings + client-runtime/locale/ui-settings。
- 复杂度评级：低-中。最大文件 compat-settings-scope.ts(312，作用域适配），逻辑平。

### 性能与流畅度观察
- 社区索引非运行时扫描：community.json(39 行) 构建期生成进 generated/community.ts，CommunityPluginsCard 直接 import 渲染（CommunityPluginsCard.tsx:10,17），无启动 fetch 热点。
- allowlist/bridge 为 host 纯逻辑（无轮询）；compat-settings-scope 一次性适配、无定时器。
- client 面仅静态渲染卡，无渲染热点。

### S.U.P.E.R 逐条
1-4. 单职责 / 函数单概念 / 数据单向流 / 无循环 import 均 pass。
5. 跨模块接口 schema 定义 partial：bridge/protocol.ts(73) 有 RPC envelope，但 CommunityPluginEntry 类型从 generated 导出、无手写 schema（generated/community.ts:1-35）。
6. I/O 可序列化 pass。
7. 无硬编码路径/URL pass：社区列表来自 community.json 源，allowlist 为常量表。
8. 依赖显式声明 pass。
9. 可替换性 pass：Card 组件 props 注入 entry（CommunityPluginsCard.tsx:17），可换数据源。
10. 测试全过 pass（tests/ 4 个 spec）。

---

## dsh-skins（含 skins/* 10 个皮肤）

### 模块条目
- 职责：皮肤聚合载具，build.mjs 把 packages/skins/<id> 的 skin.json + lib/client.js + 空 host 入口同步进本包 skins/<id>/，npm 只付一个包名（packages/dsh-skins/aggregate.yml:1-9）。
- 文件清单/半区：载具源码 = build.mjs + aggregate.yml + package.json（968 行不含资产）；10 个源皮肤 = packages/skins/{blue-fantasy,dragon-heir,miku,minecraft,qq2006,qq98,ths,trading,whale-song,xp}，各含 src/client/{index.ts,art.ts,<id>.module.css} + src/index.ts（空 host）+ skin.json，每皮肤实际文本源码 77-403 行（dragon-heir 另带约 7.2MB PNG 资产）。skin-center 是独立插件（patch 行 ui-skin-center 宿主），不在 10 皮肤之列。半区：每皮肤 client = src/client/**、host = src/index.ts（stub）。
- 公开 API：皮肤互斥由 dsh-skin use 管理，皮肤只进 skins/ 资产不进 patchFrom（aggregate.yml:23）；bundle 走共享 clientBundle 预设；carrier 包带 dsh.bundle patch 供 dsh plugin add（build.mjs:62-98）。
- 内部/外部依赖：仅 dev @deepseek-ai/cordis / lightningcss / vitest / jsdom；皮肤本身零运行时依赖。
- 复杂度评级：中。build.mjs（约 180 行）实现 5 文件同步 + staging 原子交换；皮肤间差异大（minecraft 399 行像素全景 vs qq2006 75 行纯 CSS），但结构高度同构。

### 性能与流畅度观察
- apply/dispose 模式一致：每皮肤 export apply(ctx) 写 bodyAttr/注入 DOM，ctx.effect 注册 dispose 回滚（minecraft index.ts:362-397、qq2006:24-72、whale-song:65-98）。CSS 经 bundle CSS-modules auto-inject，dispose 由 loader 移除 style 标签（shared/tsdown.client.ts 注释）。
- minecraft 在 apply 时同步渲染 6 个 640x640 SVG 全景并 encodeURIComponent 成 data-URI（index.ts:275-291,380-390），单次切换可能卡主线程；SCENES 为模块级常量（index.ts:198-259）但每次 apply 重渲染、无缓存。
- dragon-heir 加载 3 个共约 7.2MB PNG 背景（assets/*.png），首次 try-on/应用下载与解码开销大。
- 各皮肤自绘 art.ts（minecraft block 系统、trading quotes/quotes.ts 505 行）彼此独立，无共享 scene-art 抽象。

### S.U.P.E.R 逐条
1. 单职责：载具 pass、皮肤 client pass（每皮肤只做应用/回收一个外观）。
2. 函数单概念 partial：各皮肤 index.ts 的 apply 同时处理 bodyAttr+DOM 注入+标题+effect（minecraft:362-397），是皮肤契约固定的多件事形态。
3. 数据单向流 pass：skin.json 描述 -> client.apply 渲染。
4. 无循环 import pass。
5. 跨模块接口 schema 定义 fail：skin.json（如 minecraft/skin.json）无统一 schema；apply/dispose 契约与 bundle 形态只见于 AGENTS.md 文本，未机器校验。
6. I/O 可序列化 partial：skin.json 可序列化，但 client.js 是闭包工厂非纯数据，无法被校验器覆盖。
7. 无硬编码路径/URL partial：minecraft data-URI 为代码内生成可接受；build.mjs 硬编码 source/out 相对路径（build.mjs:19-22）固定在这套仓库布局。
8. 依赖显式声明 pass。
9. 可替换性 partial：皮肤互相独立可换，但应用机制三处以上重复（每皮肤各写 bodyAttr 常量 + effect dispose 样板），抽公共基座可消除。
10. 测试全过 pass（每皮肤有 tests/apply.spec.ts）。

---

## dsh-web-ui-all（聚合载具）

### 模块条目
- 职责：全家桶聚合载具：aggregate.yml 汇总全部功能插件 + 内置 compat shim（self: ui-web-ui-compat，aggregate.yml:17）+ 先声明 ui-web-ui-settings 子槽位（aggregate.yml:12-16）。
- 文件清单/半区：src/client/index.ts + src/index.ts（425 行，全包 4 个源码文件）。
- 公开 API：exports host / ./client（package.json）；dependencies 全部 workspace:* 依赖 11 个插件 + dsh-skins（aggregate.yml deps）。
- 内部/外部依赖：全部为子插件 workspace:*；无自有运行时逻辑。
- 复杂度评级：低；主要复杂度在 aggregate.mjs 生成一致性门禁而非本包代码。

### 性能与流畅度观察
- 无自有轮询/渲染热点；compat shim 为一次性挂载。性能取决于子插件，本包只决定加载顺序与 patch 展开。

### S.U.P.E.R 逐条
1-4. 单职责 / 函数单概念 / 数据单向流 / 无循环 import 均 pass。
5. 跨模块接口 schema 定义 partial：aggregate.yml 带注释契约（aggregate.yml:1-9）但无机器 schema，靠 aggregate.mjs --check 一致性门禁（packages/AGENTS.md 测试纪律）。
6. I/O 可序列化 pass（aggregate.yml 为序列化清单）。
7. 无硬编码路径/URL partial：patchFrom/deps 用相对路径（aggregate.yml），依赖仓库内布局。
8. 依赖显式声明 pass。
9. 可替换性 pass：增删插件只改 aggregate.yml。
10. 测试全过 pass（聚合用 --check 门禁代替单测，packages/AGENTS.md）。

---

## 跨包重复与不一致（与 part1 互补）

1. 皮肤 apply/dispose 样板在 10 个皮肤间重复：每包手写 bodyAttr 常量 + document write + ctx.effect 回滚 + 标题保存（minecraft index.ts:362-397、qq2006:24-72、whale-song:65-98），CSS 注入同源于共享 tsdown.client.ts。可抽单一 ThemePresenter 基座，皮肤只声明注入物清单。
2. aionui-panel 与 remote-web-ui 各实现一套 SSE 长连接 + heartbeat + 订阅簿：aionui /aionui-panel/events（routes.ts:250-430，heartbeat 15s）与 remote /api/pair/events 和 /m/api/events.mux（routes.ts:186-238、mobile-api.ts:162-201）模式几乎一致（Set 订阅、res.write push、15s ping），是跨包重复的推送抽象。
3. loopback/信任栅栏重复：aionui-panel isLoopbackRequest（routes.ts:76-93）与 remote-web-ui isTrustedApiRequest/isLoopbackClient（routes.ts:37-60、gate.ts）语义一致（loopback socket + Host 校验 + sec-fetch-site + Origin），两处各写一份。
4. 定时轮询/清扫语义分散：aionui-panel pollGit（routes.ts:94-123，30s、anti-overlap 闸、15s 超时）与 remote presence sweep（index.ts:288-328）以及 part1 中 git-graph 的 status poll 为同类 setInterval 模式，无共享轮询护栏工具。
5. 皮肤 bundle 与普通插件 client bundle 同走共享 clientBundle 预设，skin 的 dsh.client 声明 inject 为空但 skin-center 复用同一运行时；皮肤中心 try-on「执行真实 client.js」与浏览器半区加载机制存在两种 bundle 加载路径（dsh-skins aggregate.yml 注释）。
6. 设置卡壳重复：settings 的 CommunityPluginsCard/WebUIPluginsCard 与 remote-web-ui 的 PluginSettingsCard 等均经 ui-web-ui-settings 子槽位注入，卡片壳（映射/链接/图标/样式 module.css）在各包内复制，无共享设置卡基座。
7. i18n 双轨：remote-web-ui 的 client 用 locales.ts 字典 217 行，而移动端页面用硬编码中文文案（mobile/views/App.tsx 等），同一语言事实两套来源。

---

## 给重构任务的 TOP 建议清单

- dsh-aionui-panel：1) 把路由前缀与 RPC payload 字段抽成单一 constants/schema 模块（host+client 共享 core），消除 strField 手写解析与两处 URL 字符串；2) fs search 加索引/去抖，并合并 SSE fs 事件为一批再刷 explorer+preview；3) 将 loopback 栅栏 + SSE 订阅簿抽象为共享 host 工具（与 remote-web-ui 并档），消除第三份复制；4) 用 schemastery/zod 给每个 RPC envelope 建 JSON Schema，替代仅类型无运行时的 core/types.ts。
- dsh-remote-web-ui：1) 把 apply() 的 enabled 状态机（disposeRoutes/disposeSweep 手动生命周期）抽成可组合的 enable/disable 编排；2) 为 /api/pair 各端点与 mobile 请求建统一 schema 校验层；3) 复用 aionui-panel 的 SSE 订阅簿/心跳基座，消除第三份 SSE push 重复；4) mobile 打包把纯逻辑（messages/mux）与 React views 懒分块，降低全内联首包体积。
- dsh-web-ui-settings：1) 抽出可复用「设置卡基座」slot 组件供本包两张卡与 remote-web-ui 等插件的 PluginSettingsCard 共用；2) 把 CommunityPluginEntry 数据结构写成显式 schema，让 community.json 经 schema 校验生成，替代仅有导出的类型。
- dsh-skins / skins：1) 引入统一 skin.json 校验器 + ThemePresenter 基座，把 10 个皮肤共同的 bodyAttr + apply/dispose + 标题样板收敛为声明式注入清单；2) 对 art.ts 全量场景渲染做 module 级缓存（minecraft SCENES 每次 apply 重排 6 SVG 应 lazy 一次）；3) dragon-heir 的 7.2MB PNG 压缩/降采样或改渐进加载；4) 保留 build.mjs 的 staging 原子交换不变量并补 --check。
- dsh-web-ui-all：1) 保持纯组装形态，把 aggregate.yml 的 patchFrom/deps/self 契约升级为可机检 schema（供 aggregate.mjs --check）；2) 统一 compat shim 单一来源，消除内嵌与独立两路歧义。
