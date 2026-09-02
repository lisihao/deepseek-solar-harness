# DSH Desktop

[English](README.md) | 中文

`dsh-plugin-desktop` 在 Electron 中运行 DSH，同时仍然参与普通 Cordis 组合。安装后的应用名称为 **DSH Desktop**。该包提供 `dsh-plugin-desktop` 可执行命令和 `dsh-desktop` 别名；已注册的 npm 包名是可靠的 `npx` 入口。

## 架构

Electron 可执行文件只包含最小启动代码。它获取单实例锁、解析当前选中的 DSH profile、提供原生运行时能力，并在 Electron main 进程中启动 Host Cordis 根。`desktop-shell` Host 插件通过 Cordis effect 拥有 `BrowserWindow`、导航策略、settings namespace，以及关闭与退出生命周期。原生 runtime 拥有实体托盘；`desktop-shell`、`desktop-profiles`、`desktop-terminal` 与 `desktop-updates` 则通过有序 item registry 提供 effect-scoped 命令。

两种呈现模式都复用现有 loopback Web carrier。profile 挂载普通 `dsh-base` 与 `dsh-web-app` bundle；Host 把 HTTP 与 WebSocket surface 绑定到 `127.0.0.1` 的临时端口；Electron 在沙箱 renderer 中加载该同源页面。Electron 不维护自有插件 roster，不使用 preload bridge，renderer 也不会获得原始 Electron API。

同一 package 还提供 `dsh-product-server`，它是远程部署使用的纯 Node Host Adapter。Desktop 与 Product Server 都从唯一的封装产品组合生成，因此会加载相同的 Resident、Orchestration、AgentTeams、Billing、Remote Modules、RLM／Continuous Harness、模型分配、记忆、治理和产品 UI row。只有 Host Adapter row 不同：Desktop 拥有 Electron 窗口、托盘、终端、profile 与更新 effect；Product Server 拥有持久 Web endpoint，为远程客户端固定使用浏览器目录选择器，并始终保留 compatibility 浏览器布局，因为它不会加载 Electron 所有的 advanced layout provider。普通 `dsh server` 命令仍是兼容上游的裸 Server profile，不是 DSH Desktop 产品部署。

DSH Desktop 保存一个带名称的 Product Server 列表和一项当前 Server 选择，且这两项不依赖当前部署角色。原生 **Connect to Remote Server…** 窗口可新增、编辑、选择和删除条目；手工切换当前条目会让 Frontend 重启并连接对应 endpoint，而不会启动本机 Host。连接建立后，Desktop 自有 monitor 会持续资格检查整个目录；发现新的可调度 Leader 时，只重新挂载浏览器 generation，不重启应用。成功接管的备用项会成为持久化的当前 Server，并显示在原生窗口标题中。若全部条目均不可用，系统会保留完整目录并打开本地部署恢复界面，不会静默启动本机 Host。切回本机 Server 后，系统仍保留完整列表、最后选择和呈现模式，因此用户无需重新配置就能再次选择任一已保存 Server。已有的单 Server 部署状态会迁移为列表中的第一个条目。`http://127.0.0.1:13080` 这类 loopback endpoint 通常通过 owner 控制的 SSH 本地转发访问 Product Server，会直接使用已经认证的隧道，不再要求第二份配对码或 Keychain 凭据。手机／pocket 等直接访问远程 HTTPS 的客户端仍使用一次性配对挑战、加密持久设备凭据和短期访问 session。Frontend billing bridge 会读取每个已配置 Server 的账本，只加一次未启动的 MacBook 历史，并在费用面板保留各 Server 的 ready/unavailable 来源明细。

Electron 持有原生 **Deployment** 菜单，以及当前 Frontend Server 无法加载时显示的本地恢复页面。两处都提供不依赖远程 Client bundle 的 **Use Local Server** 与 **Connect to Remote Server…**。Desktop 页脚始终直接暴露 Server 配置；在 Frontend 角色下还会额外暴露 **Use Local Server**。

同一原生窗口还拥有可选的后台 Git commit 同步。每台设备分别配置本地仓库路径、作为权威的 GitHub remote、分支、同步方向、间隔，以及可选的 Tailscale／SSH 加速 remote。同步会拒绝脏工作树或错误分支，只对已提交 ref 执行 fast-forward 或 push；遇到分叉时报告冲突，不会自行 merge。加速 remote 只可预取 Git object；GitHub 始终是接受结果的权威，而且加速路径失败不会阻断权威路径。

该窗口还提供按 revision 去重的后台 Session 进展交接。Frontend 可以把当前 Product Server 上完整、事件边界闭合的 Session 副本拉取到受保护的暂存箱，切换到本机 Server 后再导入；正在运行的本机 Server 也可对同样的不可变日志前缀执行推送或拉取。控制器按 Server 记录 revision，未变化的日志不会重复传输。它不会复制 SQLite 或 WAL 文件，不复制未闭合的回合，也不会建立第二个活跃写者：存活任务继续由原 Server 持有，通过现有 snapshot/cursor 流实时观察。

desktop package 拥有普通 Host 与 Web Client 两个 face。它的 Client face 会校验 Host 提供的模式、平台与产品版本 marker。两种模式都会在窗口内容下方的保留区域挂载一条不可交互的单行产品标记，并继续把 Desktop 操作放在普通 additive slot 中；兼容模式随后停止，不提供 layout service 或 root 呈现，高级模式则安装下文所述的 desktop layout service 与 root 呈现。两种模式下，第三方 Web client 都继续使用普通 DSH 模块图。

托盘中的 profile 选择器会列出现有 profile，以及可延迟创建的 `desktop` 与 `web` 默认项。可选 profile 必须直接按顺序组合 `dsh-base` 与 `dsh-web-app`；headless、损坏或已经内嵌 desktop bundle 的 profile 仍会显示，但不可选择。只有 `desktop` 是 Launcher 管理的 profile：它会修复安装方拥有的前缀，同时保留第三方 bundle 的相对顺序。其他被选 profile 的 manifest、用户 patch 与依赖均保持不变。Launcher 只会为当前 generation 在 `dsh-web-app` 后插入自有 desktop layer，不会把该 layer 持久化到被选 bundle 列表。

Desktop 产品层还会提供 Resident Physical Operators 与 AgentTeams，但不会把任一 bundle 持久化到用户选择的 profile。普通聊天模型选择旁只显示一个“协作”控件，不再把算子、原生模型和强度呈现为三个同级选择器。每个未配置的 Session 使用“智能协作”：主模型负责对话，并在非简单任务中判断是否委派给 Codex 或 Claude Code。人工策略按 Session 记录，可关闭委派或让符合条件的任务优先使用某个产品；短问答仍留在主模型。产品专属的原生模型和推理/思考强度统一收进该控件的高级偏好，两者缺省都按任务推荐；首轮实际采用的组合会按“算子 + 规范化工作区”锁定到 Resident Session，只有 idle 且 revision 匹配的 reset 才能改变。每次打开控件都会立即刷新原生订阅模型目录，并在面板可见时缩短刷新周期，避免启动初期竞态让选项持续禁用一分钟。Desktop 会识别旧版未标记的策略事件，而新版策略与 profile 事件带有可忽略扩展标记，因此旧 reader 也能冷加载同一 Session，不会拒绝日志。底层 physical-operator 请求在调用方省略 `mode` 时仍缺省为 `ephemeral`，从而保持 Provider 兼容；智能协作会对仓库、多轮和需要跨重启连续的工作显式优先使用 `resident`。在 macOS 上，launcher 会把用户原生的 `claude` 与 `codex` 命令解析为仅 owner 可访问的私有 wrapper，Resident daemon 使用产品订阅登录态和原生 session 连续性，禁止 API key fallback。Daemon 独立于 Electron generation，因此应用重启只会断开客户端，不会删除 receipt、lease、artifact 或原生产品 session。

当前 Session header 会在两种呈现模式下增加一个纯新增的 **物理算子** action。它会打开同源、只读的状态面板，显示该 Session 的 Provider 资格、持久 Session、最新 Receipt 状态与有界进度事件。Host route 按需读取 `ctx.residentOperators`，不会创建 Desktop 自有的 Resident 状态库。面板还会说明智能协作与插件能力约定：模型工作使用 `physical_operator` 工具，Host 插件通过注入 `ctx.physicalOperators` 执行，可信管理/状态插件则可注入 `ctx.residentOperators` 检查状态。基于实时 descriptor、tag 与 execution mode 的指引会主动触发委派；策略可见且已记录，不会引入隐藏分类器或第二调度权威。Desktop 不会把该 action 放入 sidebar footer，因此运维检查不会占用会话导航空间。

“物理算子”action 会区分已安装 Resident 宿主与活动 worker，并显示每个 worker 的隔离 lane。Codex 与 Claude Code 各自最多接纳四个并发 lane；一个原生产品宿主因此可以执行多个独立 TaskGraph 节点，而不会把重复应用错误呈现为多个算子。

产品层还会把封装后的 `@deepseek-ai/dsh-orchestrations` Bundle 作为独立插件能力挂载。Service Definition 分别拥有 Intent、Context、Capsule、TaskGraph 和 Orchestration 约定；Local Provider 拥有持久 daemon、SQLite 状态、Artifact Store 与调度写入；Tool 和 Web UI 只消费 `ctx.orchestrations`。当前 Session header 中新增的 **编排** action 会打开工作台，通过同源投影展示 Run、DAG 依赖、Compiler/Capsule/Context 阶段、已封印 ExecutionPlan、算子选择、Attempt、Generation、Evidence、Blocker 与事件。暂停、恢复、取消、批准、拒绝和不确定执行处置都调用公共 Service seam，不直接修改 daemon 存储。移除该 Bundle 就会完整移除这组能力，不改变聊天、Workflow 或物理算子。

每个编排工作台 Run 顶部都有“协作 Trace”摘要。它会标出准入的“智能协作”“仅主模型”“优先 Codex”或“优先 Claude Code”策略、TaskGraph 路由、活动与最大 worker 数、可派发节点、clean-task Capsule 状态和 fresh-lane 隔离。事件时间线保留相同的准入信息、Capsule 解析、算子派发、lane 与调度等待原因，因此任务完成并重启后仍可解释。

Resident 派发还会将提供方无关的连接、推理／执行、工具活动和结果整理阶段投影到协作 Trace。终态事件会显示所选 Codex 或 Claude Code 算子、停止原因、有界的面向用户输出和不可变 Evidence 引用。私有推理文本、提示词、终端屏幕和产品本地 transcript 仍不进入该投影。

位于 `/tmp/dsh-orchestration-*` 或 `/private/tmp/dsh-orchestration-*` 下的本地验收 Run 仍持久化保留，并带有**验收**标签。工作台默认包含它们，同时提供仅影响展示的隐藏控制，并保持已存储数量可见。

Desktop 会把 Solar 受控的 Better Sidebar、GenUI、插件诊断、模型 fallback、代码图谱、Mnemon、Aegis skills 和有界工具作为产品输入封装。即使聚合 UI 包依赖旧版本，product-first 解析也会保持已接受 Better Sidebar 实现的权威性，而其挂载 guard 会阻止 sidebar 重复归属。Mnemon 是唯一产品记忆 bundle；陈旧的 Memory Evolve row 会被禁用，但不会删除用户数据。原生 DeepSeek provider 将 `deepseek-v4-flash-vision-exp` 声明为支持图像输入，因此 Desktop 不会加载 Luna Vision Bridge 或 Modlens。Aegis 只贡献 skills；Code-as-Harness 仍是唯一的完成与准入权威。

打包内的 `anchored-standard` preset 是 system-trust 产品输入，并排在同名上游 preset root 之前。它的首轮 gate 会覆盖 delegated agent，因此 AgentTeams worker 会与主 agent 一样从 `bash` 和 `str_replace_editor` 两个 bootstrap 工具开始，而不是被当作已经 promoted。AgentTeams 还会把 member protocol 放入首条 user prompt，不再替换所选 preset 的 persona。若用户 profile 已声明 AgentTeams，产品层不会重复加载；最终 patch 仍会强制这一 prompt placement。

Profile 选择保存在 Electron user data 下的 desktop 自有状态中，而不是被选 profile 内的另一个字段。切换会先记为 pending，再通过有序重启生效。只有 Cordis 树与原生窗口成功挂载后，新 profile 才会成为 last-known-good；托盘会在 Web surface 加载后才创建，而且该状态提交会在托盘命令能够运行前同步完成。Pending generation 启动失败时会回滚并自动重启一次。官方 profile 默认共用同一个 DSH home 中的 sessions、settings 与 storage，因此切换不会复制或迁移记录；自定义 profile patch 仍可主动重定向其中某个持久化根。

Launcher 会在 Loader entry 挂载前注册作用于当前 generation 的 `ctx.desktopProfiles` service。其不可变 `current` 值包含激活 profile 的 `name` 与绝对 `dir`；`list()` 只读执行发现，`select(name)` 会串行化“先持久化、再重启”的切换，而不会就地改变当前 generation。该 service 是 Desktop Host capability，不是 renderer bridge，也不是当前上游 DSH 已提供的 active-profile API。

Cordis 的裸插件导入从持久化 profile 解析。一个范围受限的 Node resolve hook 只处理由 `@deepseek-ai/cordis-plugin-loader` 发起的导入，因此即使打包后的 Electron 不暴露 Node 内部 ESM Loader，profile 本地第三方包与修复后的 launcher fallback 仍使用同一条解析路径。

在 profile 准备与 Cordis boot 之前，Launcher 会把只包含固定版本内置 `pnpm` 命令的私有命令目录前置到当前 Electron main 进程的 `PATH`。因此 Host 与第三方插件从启动开始即可发现该 package manager，也可以通过普通 DSH subprocess provider 使用它，而无需系统安装 Node.js。该 ambient path 是兼容 surface，不是正式的插件管理 contract。

`desktop-pnpm` Host row 会提供 `ctx.desktopPnpm`，用于针对不可变激活 profile 执行受管 package operation。`run(args, signal?)` 会在激活 profile 目录中直接执行内置 pnpm；它是低层 operation，不承诺 DSH profile 初始化、调用方相对 source 锚定或 bundle reconcile。`runPlugin(args, invokingDir, signal?)` 则会从调用方绝对目录启动内置的 `dsh plugin --profile <active>`。插件安装、卸载、更新与依赖修复必须使用 `runPlugin()`，使上游 CLI 继续拥有相对 `file:` 与 `link:` spec、pnpm profile working directory、首次初始化，以及成功后 `dsh.profile.bundles` reconcile 的权威语义。

两个方法都会返回实时 stdout 与 stderr stream、在完整 process tree 退出后才 settle 的 `done` promise，以及 `cancel()`。每个 generation 同时最多运行一个 operation。Service 使用普通 DSH subprocess provider、准确的已打包 JavaScript entry、无 shell argv，以及只属于 child 的 DSH home、Electron-backed Node、CI 与 native-module ABI 值。公开 runtime path 仍不会暴露 `node` 或 `dsh`；其中私有 helper、`ELECTRON_RUN_AS_NODE` 与 npm ABI 变量只存在于 package-manager subprocess tree 内。Launcher 不会修改系统 `PATH`、shell 启动文件、profile 配置或 `.env` 文档。

插件作者应遵循 [Desktop 插件 service 架构](docs/plugin-services.zh.md)中记录的受支持 contract import、生命周期规则与适配模式。

## 模式设置与重启边界

DSH home `settings.yaml` 文档中的 `dsh-desktop.mode` 字段是单一事实源：

```yaml
dsh-desktop:
  mode: compatibility # 或 advanced
```

Launcher 会在组合一个 generation 之前，读取当前 `@deepseek-ai/dsh-settings-file` row 解析到的同一份文件。Host 通过标准 settings service 注册 `dsh-desktop` namespace。profile manifest 中没有平行的模式值。

用户可以从托盘选择另一种模式，也可以手工编辑 DSH home 中的 `settings.yaml` 文档。托盘会更新已注册的 `dsh-desktop` settings namespace，手工编辑则修改 settings provider 观察的同一文件。修改提交后会请求一次有序重启：先 dispose 当前 Cordis 树，仅当零退出码的 shutdown 成功时才让 Electron relaunch。应用绝不会在存活的 renderer generation 中热切换 root slot、原生窗口材质或 Loader row。

Linux 只支持兼容模式。其托盘模式命令会被禁用，advanced 值会被拒绝，而不会静默降级。

## 兼容模式

`dsh-desktop.mode` 默认为 `compatibility`。该模式创建带有操作系统原生边框的普通窗口，并加载当前 DSH profile 中的官方 Web surface。macOS 会隐藏可见的页面标题。原生标题栏颜色与外观由操作系统拥有。

desktop Client module 会校验模式与平台 marker，随后在兼容模式下不产生任何 effect。它不提供或替换 `layout` service，不注册 `root` 或 `sidebar` occupant，不安装样式，也不改动 conversation surface。兼容模式会保留被选 profile 自身的 layout、sidebar 与 conversation 组合；普通 `desktop` 与 `web` profile 因而会原样保留官方 row。

Cordis row 会在 profile 激活期间登记原生窗口参数。Launcher 只在 `app-boot` 完成并审计整个 profile 后创建窗口，因此首个 renderer manifest 会包含所有已激活的官方、desktop 与第三方 client plugin，同时插件自身不会在 Loader entry 内等待整棵 Loader tree。

macOS 与 Linux 仍使用上游自适应目录 chooser。因此 workspace 选择会遵循受支持宿主 profile 选定的官方 Web surface 或 native chooser。

## 高级模式

高级模式是为 macOS 显式组合的 desktop 呈现。Launcher 会在读取全部用户 patch 后禁用官方 `ui-layout` Loader row，保持官方 `ui-sidebar` 与 `ui-conversation` row 启用，并把所选模式应用到 `desktop-shell`。

desktop Client 随后在自身 Cordis fiber 生命期内提供 `layout` service，并且只注册 `root` slot occupant。其 root 为不变的上游 sidebar、conversation、details 与 overlay contribution 声明 seat。官方 sidebar 继续作为 `sidebar` occupant，并继续声明 workspace browser、settings shell 与纯新增 footer action seat。这样会保留其组件行为、收起动画与第三方扩展点，而 desktop package 只拥有 frame 几何与原生材质。

高级 theme presenter 会把当前上游 theme snapshot 投影到 document，包括 color scheme、解析后的 token 值、深色模式 marker 与 theme-color metadata。它订阅普通 theme 变化，generation dispose 时只移除由自身投影的状态。

对于高级 generation，Electron adapter 还会在 Host boot 完成后读取已注册的 `ui-theme.preference`，并在创建窗口前把内置 `light`、`dark` 或 `system` 值同步到 Electron 原生外观。窗口存续期间提交的 preference 变化会更新原生材质，dispose 则恢复此前的 Electron 外观。仅存在于 Client 的第三方 theme id 不会改变该 Host preference。

desktop sidebar surface 会把上游 sidebar-fill token 局部设为透明，因此官方 sidebar 与 session 列表渐隐可以透出原生材质，而无需改变其组件样式。

在 macOS 上，高级窗口使用透明 hidden-inset 标题栏、定位后的红黄绿按钮与原生 `sidebar` vibrancy。其 90 CSS 像素收起列会把官方 56 像素 rail 居中放在 desktop 自有的红绿灯顶部 inset 下方。Sidebar surface 本身不可拖动；红绿灯右侧由 desktop 自有的透明 32 CSS 像素条提供窗口拖动目标。Conversation 与 details 完整 surface 上方的 caption row 会保留 20 CSS 像素视觉间距，同时提供另一块透明的 32 CSS 像素拖动命中区域。按钮、链接、输入框、对话框与显式声明 `app-region: no-drag` 的 contribution 仍可交互；放在顶部 32 像素内的自定义 pointer target 也必须声明同一排除规则。Linux 会拒绝高级模式，而不会静默降级到与持久化设置不同的呈现。

## 开发

该包由 `products/desktop/` 中的 Yarn workspace 管理。Solar Harness 源码位于该 workspace 向上两级的 monorepo 根目录，并保留独立的 pnpm 依赖图。请从 `products/desktop/` 安装并验证 DSH Desktop：

```sh
yarn install
yarn check
```

该检查会验证生产依赖图中的每个必需第一方 peer 都由 desktop deploy root 声明。Headless Loader smoke 会激活 launcher 拥有的 desktop row 与 profile 本地第三方 row，然后启动已发布 Web profile 并检查其 loopback 根页面与 client manifest。单元和类型测试覆盖两种 profile 组合、重启栅栏、client environment 校验、desktop layout 状态与各平台原生窗口选项。

有图形会话时，显式启动桌面应用：

```sh
yarn dev
```

`dev` 会在启动前自动构建，不需要另行手动构建。

以下 headless-safe 启动器入口不会导入或启动 Electron：

```sh
node lib/bin.js --help
node lib/bin.js --version
node lib/product-server-bin.js --host 127.0.0.1 --port 3080 --trusted-host mini.example:3080
```

Mac mini 必须从固定 GitHub Release 自行安装 Product Server，不复制 MacBook 产物。安装器会验证 tag 与 commit 的绑定，在 Mac mini 本机构建并执行 release-shaped Product Server 冒烟，原子切换 LaunchAgent，将上一份 release 保留为 `rollback`，随后验证 HTTP、Remote Sync 以及 `operator.read/execute/interrupt`：

```sh
node scripts/install-product-server.mjs \
  --ref DSH-desktop-v3.10.1 \
  --commit <正式发布的完整-40-位-commit>
```

默认安装会创建单成员集群，并允许从发布仓物化精确 commit。使用 `--execution-repo <git-url>` 可选择另一单一 Git 权威；使用 `--cluster-config <path>` 可安装完整的多 Server 成员与仓库准入目录。

## 插件工作流

使用普通 DSH 命令管理任意 profile：

```sh
dsh plugin --profile desktop add third-party-plugin
dsh plugin --profile desktop remove third-party-plugin
dsh plugin --profile desktop update
```

应用默认使用 `desktop`。可以在托盘的 **Profile** 子菜单中选择其他 Web-capable profile；切换时应用会重启。生成的 DSH 终端会让裸命令默认作用于当前激活 profile，因此以下短命令可以直接修改它：

```sh
dsh plugin add third-party-plugin
dsh plugin remove third-party-plugin
dsh plugin update
```

显式 `--profile <name>` 始终具有更高优先级，可用于在切换前准备其他 profile。

`dshmarket@1.2.3` 尚未预装，也不是 DSH Desktop 的 dependency。该版本仍从 config/argv 解析 profile，并通过私有 child-process 代码启动 `dsh plugin`；它既不读取 `desktopProfiles`，也不使用 `desktopPnpm`，package exports 也没有 runner injection seam。后续兼容版本必须动态探测 Desktop service，同时在普通 DSH 中保留现有 CLI fallback。此外，`1.2.3` 的源码仓库与 npm tarball 均未包含完整 MIT 许可文本或版权通知，因此该版本尚未通过内置再分发 gate。用户主动安装第三方 package 与 Desktop 将其嵌入 application archive 或 installer 是两个独立边界。

Required injection、可选 Desktop 适配、TypeScript 示例、cancellation 与 fallback 指南详见[面向插件作者的 service 文档](docs/plugin-services.zh.md)。

随后可以通过 npm 启动该包：

```sh
npx dsh-plugin-desktop
```

第三方 Host 插件只需提供普通 `dsh.bundle` patch。包含浏览器 UI 的插件还要发布普通 `dsh.client` 元数据，将 `platform` 设为 `"web"`，并导出 `./client` 产物。上游 Web 客户端模块图会在两种模式下发现它；Electron 不要求单独的客户端构建，也不引入 desktop 专用注册 API。高级模式 contribution 必须面向该显式组合中存在的 service 与 slot，不能假设官方 layout 或 sidebar occupant 拥有它们。

## 桌面操作

打包后的 macOS 应用会在启动 60 秒后查询 `https://www.dshdesktop.cn/api/desktop/version`，并在每次检查完成六小时后再次查询。每次 no-cache 请求的期限为 15 秒，并与托盘中的 **Check for Updates…** 命令共用一个 in-flight operation。响应只有在包含规范的 stable Semantic Versioning 时才会被接受。后台检查遇到网络、HTTP、超时、无效响应、相同版本或服务端旧版本时保持静默。手工检查一定会显示原生结果对话框：相同或旧版本会显示当前安装版本，失败会提示用户重试，严格更新的版本则显示 **Download** 或 **Later**。自动更新提示会按版本记录，用户仍可从托盘显式重试。开发运行、未打包启动与 Linux 不会下载安装包。

选择 **Download** 后，应用会先重新确认服务端版本没有变化，然后才首次请求 macOS 用于计数的固定下载入口。DSH Desktop 使用 Electron 网络跟随 service redirect，把不超过 1 GiB 的文件流式写入私有、按版本划分的 user-data 目录，并在交付前拒绝不完整的 DMG。应用会打开下载好的 DMG，并提示用户替换 `Applications` 中的应用后重新打开。下载、文件系统与安装器打开失败都会保持静默，同时保留托盘中的可重试版本操作。

Release operator 必须先发布 macOS 产物，再让版本可被发现。产物与 download redirect 准备完成后，在 Upstash Redis console 中把 `deepseek-harness-desktop:release:version` 设置为规范的 stable 版本，例如 `SET deepseek-harness-desktop:release:version 2.0.1`。版本 API 会立即生效；key 缺失、服务不可用或值无效时，Desktop 不会显示任何提示。

在 macOS 上，**Open DSH Terminal** 会打开以当前激活 profile 为工作目录的系统终端。欢迎信息会显示应用版本、当前 profile、profile 目录与 DSH home，并列出配置与插件管理命令。在该终端内，裸 `dsh`、`dsh --dump-config`，以及没有选择 profile 的 plugin 子命令都会默认使用当前激活 profile；显式 `--profile` 与上游 `web` alias 会保留原有含义。DSH Desktop 会在自身 user-data 目录下按 profile 生成私有 `dsh`、`pnpm` 与 `node` shim，设置 `DSH_HOME`，使用当前 profile 作为工作目录，并且只在该终端的 `PATH` 前置 shim 目录；之后切换 profile 不会改变已经打开的终端命令。它不会修改全局环境或 shell 启动文件。macOS launcher 会先保留用户的交互式 zsh 或 bash 设置，再恢复 desktop 自有变量。Linux 不组合该终端命令。

## 原生生命周期

关闭窗口会隐藏窗口，Host Cordis 树继续运行。托盘可以重新打开窗口、选择激活 profile、打开隔离的 DSH 终端、检查 stable release、通过标准 settings namespace 更改模式，或请求显式退出。Profile 与模式切换都会先 dispose 当前 Cordis 树，再让 Electron relaunch。原生退出、`SIGINT` 与 `SIGTERM` 也会在退出前请求 dispose；超过五秒或收到重复请求时会强制完成最终退出。导航与重定向被限制在确切的 loopback origin；外部 HTTP、HTTPS 与邮件链接由操作系统打开；renderer 启用 `contextIsolation` 与 Chromium sandbox，并关闭 Node integration。

## 打包

`yarn package:dir` 为当前宿主平台创建未封装目录。如果应用归档缺少 desktop 更新与终端模块、DSH CLI bootstrap、内置 pnpm 入口、Resident/AgentTeams runtime package、Code-as-Harness 治理、修复后的 Anchored Standard preset 或物理 deployment package，packaged-runtime gate 会拒绝该产物。Electron Builder 会把根 manifest、desktop runtime 与完整依赖树输出到 `app.asar.unpacked`；Host profile boot 与 CLI bootstrap 都会使用这棵物理树，因此 DSH profile fallback 的符号链接不会指向虚拟 ASAR 目录。`verify:vendor` 会在打包前拒绝过期的已安装 file dependency，`verify:composition-package` 会从打包后的 Electron 目录组合这些产品输入，`verify:resident-package` 会从打包 daemon 审查原生订阅 Provider，`verify:resident-execution` 则会显式执行无工具的真实产品 turn。`build/app-icon.png` 保持为未经修改的 iOS Default 源图，并继续作为 macOS 与 Linux 应用图标。构建过程会运行 `scripts/generate-mac-app-icon.mjs`，把该图缩放为 824 × 824 像素并居中放入透明的 1024 × 1024 画布；macOS 打包与运行中的 Dock 都使用生成的 `build/app-icon-mac.png`。`build/tray-icon.svg` 是品牌蓝托盘源文件：构建过程会派生由 macOS 系统自动着色的模板图，以及固定品牌蓝的 macOS 与 Linux 托盘图。

`yarn verify:orchestration-e2e` 是持久化编排的安装态产品验收。因为它会消耗通过资格审查的 Claude Code 与 Codex 原生订阅，若未用 `DSH_ALLOW_SUBSCRIPTION_E2E=1` 显式授权一次确实受影响的最终验收，它会在连接 Desktop 之前直接拒绝执行。默认最小矩阵会拒绝循环 Graph，证明高阶规划与验证包围两个并行低阶 DAG 叶节点，封存并执行启用的节点级 RLM 计划，回忆一条先前的 Continuous Harness outcome，查询运行中 Host 的投影，并通过 CDP 打开真实 Desktop 工作台。RLM 对比在高阶验证者结算前始终隐藏两个候选的方法身份，结算后再把冻结输出、揭盲映射、裁决、完整源码提交和产品版本记录为可复用的真实订阅质量证据。质量/综合/成本三个独立目标 turn 与 scope 冲突的两个独立 turn 会复用仍然有效的确定性证据或既有安装态证据；只有相关行为确实受影响时，才用 `DSH_SUBSCRIPTION_E2E_FULL_MATRIX=1` 单独授权这五次额外订阅调用。该命令会在 `dist/acceptance/` 下写入包含运行模式与复用范围的 JSON 证据 Artifact；模块 mock 不能替代其中的真实执行部分。

## 模型体验

产品层会增加 AgentTeams 与既有 physical-operator 工具面。每个 Session 的执行策略缺省为“智能协作”，并显示在聊天模型选择旁；也可以通过 `/operator` 命令或 Desktop 面板人工覆盖。Resident 执行只返回有界 continuity metadata，底层 run API 在省略 `mode` 时仍按 ephemeral 处理。动态 system-prompt 区段会在每个非简单任务开始时对照实时 descriptor、tag 和 mode 进行判断，而 Session-header 面板只向人投影状态。打包内的 Anchored Standard 会让主 agent 与 delegated agent 都使用双工具首轮 bootstrap。AgentTeams 会把协调协议放在 worker 的首条 user message 中，并保留 preset persona。

#### KV Cache 影响

Desktop 没有创建第二套模型请求管线。Anchored Standard 与 AgentTeams 仍作用于 DSH Host 组装的同一请求；切换 preset 对 cache identity 的影响与普通 DSH 一致。

## 已知限制与暂缓事项

- 添加或删除 profile bundle 后必须重启 DSH Desktop；Launcher 不监听 profile manifest。从托盘选择其他 profile 时会自动完成该重启。
- 切换 compatibility/advanced 模式按设计必然重启应用；存活的 generation 不会热切换 Loader row、slot 所有权或原生材质。
- Linux 不支持高级模式。Linux 继续使用兼容呈现。
- Resident 原生产品资格审查与发布验收目前仅覆盖 macOS。订阅登录缺失，或固定的 Claude/Codex 协议发生变化时会 fail loud，绝不会回退到 API key；普通 ephemeral 算子仍然可用。
- Desktop 会先解析用户目录中的 `~/.local/bin`、`~/.npm-global/bin`、`~/.bun/bin` 或 `~/.volta/bin` 产品安装，再考虑继承的系统 `PATH`。这样 Finder 与终端启动会使用同一份已通过资格审查的 Claude/Codex 版本，并避免旧的 root-owned Claude CLI 共享和轮换同一个 macOS Keychain 凭据。Claude Agent SDK 的目录发现与执行也固定使用这份已解析客户端，不能静默退回另一份在 token 刷新或 TLS 行为上不同的内置 CLI。
- macOS 托盘终端会提供私有 `dsh`、`pnpm` 与 `node` shim。除此之外，Host runtime 会在当前 Electron 进程的 `PATH` 中公开内置 `pnpm` 命令作为 ambient compatibility，并提供受管 `desktopPnpm` service；这些命令都不会加入系统 `PATH`，Linux 目前也没有 desktop 终端命令。
- `desktopPnpm.run()` 与 `runPlugin()` 会启动准确的已打包 entry，从而避免 manager process 的 shell lookup。第三方插件直接调用 Node `spawn('pnpm', { shell: false })` 仍属于不可移植行为，应改用受管 service 或 shell-aware 启动路径。
- `dshmarket@1.2.3` 仍是用户可选安装的第三方 package，而不是内置 marketplace。只有重新审计的版本同时消费可选 Desktop service、保留普通 DSH fallback，并包含再分发所需的完整 license notice 后，才会重新评估预装。
- 更新交接只验证下载容器，不验证 publisher 身份。macOS 仍要求用户从已打开的 DMG 替换应用。签名产物、publisher 校验与原生升级测试仍是发布 gate。
- 共享 carrier 使用 loopback HTTP 与 WebSocket，而不是 Electron IPC。替换它需要上游 DSH 提供 transport 扩展点，不属于该独立包的范围。
- P1-P2 迁移期间，本产品固定使用已发布的 DSH `0.1.0-rc.6` family，而已导入的 Solar 核心保留自己的源码版本和来源。测试继续验证已发布包接口，直到后续源码集成阶段完成资格审查并明确改变该依赖边界。
- `package:dir` 是用于 smoke 的未封装产物。安装与升级行为、原生通知与终端，以及每台目标机器上的原生材质外观仍属于目标平台验证边界。
