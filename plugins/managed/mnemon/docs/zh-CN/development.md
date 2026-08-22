# 开发与验证

**简体中文** | [English](../en/development.md) | [文档中心](./README.md)

## 环境

发布的插件仍为较旧且兼容的 DSH Host 保留 Node.js 20 engine 下限。当前源码检出中的 DSH 0.1.1-rc.2 验证工具链需要 Node.js `^22.19.0 || >=24.0.0`：rc.2 会导入 Node Zstd API 并使用 `Promise.withResolvers`，因此 Node 20 无法加载完整 rc.2 profile。CI 在 Node.js 22.19 和 24 上运行完整 Linux 验证链，并在 Node.js 24 上运行 Windows 验证链，均使用 pnpm 10.13.1。升级依赖时，应通过完整验证链路确认 DSH 与 Mnemon 兼容性。

安装依赖：

```sh
pnpm install
```

## 标准命令

```sh
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest run
pnpm run build      # declarations + host/client bundles
pnpm run verify     # typecheck + tests + reproducible build + package validation
```

## 目录结构

```text
src/
+-- index.ts                  # Host composition root
+-- config.ts                 # settings schema
+-- process.ts / runner.ts    # local CLI execution
+-- service.ts                # durable-memory facade
+-- memory-bodies.ts          # Memory Space registry
+-- runtime-memory.ts         # hot-memory authority
+-- documents.ts              # managed Documents
+-- subagent.ts               # bounded workers
+-- lifecycle.ts              # root-Agent hooks
+-- review-activity.ts        # activity score
+-- tools.ts / commands.ts    # model and human interfaces
+-- rpc.ts / settings.ts      # Web bridges
+-- storage-scope.ts          # storage inventory
+-- shared/contracts.ts       # Host/Client wire contract 唯一事实源
+-- client/                   # React workspace and locales
tests/                        # Vitest suites
scripts/                      # 确定性构建与发布包检查
lib/                          # 生成且忽略的发布产物
docs/zh-CN/                   # Chinese documentation
docs/en/                      # English mirror
cordis.patch.yml              # DSH profile bundle patch
```

## 构建产物

```text
tsdown（直接读取 src/）
  -> lib/index.js             Node ES2024 ESM
  -> lib/client.js            DSH browser module wrapper

tsc -p tsconfig.types.json
  -> lib/types/**/*.d.ts      只生成声明

lightningcss plugin
  -> CSS Modules compiled and injected as scoped <style>
```

Host 将所有 package dependency 保持为 external。Client 将 React、ReactDOM、JSX runtime、Cordis 和 DSH UI primitives 保持为 external；来自 `node_modules` 的依赖只允许打入 `markdown-to-jsx`。

`lib/` 是发布输入，但已被 Git 忽略，禁止手工编辑。`pnpm run verify:build` 会连续构建两次并比较每个输出文件的 hash；CSS export 顺序或其他非确定性变化会直接失败。

`src/shared/contracts.ts` 是配置结构、RPC 通道、设置协议和 Client 可见 DTO 的唯一事实源。`src/client/` 下的文件只能通过该 contract 导入父级模块。Host 模块可以为兼容性 re-export shared 类型，但不应重新定义 wire DTO。

## 测试层次

现有 Vitest 套件覆盖：

- 配置解析、CLI 查找、进程串行；
- Memory Space 发现、激活、路由与合并；
- recall payload 兼容和图谱解析；
- Runtime JSON/Markdown 一致性、锁、容量、UTF-8 和 revision；
- Documents 路径、frontmatter、搜索、LRU、归档与冲突；
- worker 工具隔离、schema 子集、结构化回执；
- 生命周期 cue、评分、idle debounce、取消和水位保留；
- RPC authority、只读行为和设置 revision；
- Web 工作台、双语文案和关键交互；
- 不依赖 Web 专有服务的核心激活，以及 Headless 按 Agent cwd 路由；
- Client/Host 源码边界、确定性构建 hash、发布包内容、exports 和 TypeScript 解析。

这些主要是临时目录、fake runner 和 mock Host 集成测试。此外，`verify:headless` 会构建包、安装到隔离的真实 DSH Headless profile、启动本地模拟模型，并断言代表性 Mnemon 工具进入模型请求。真实 DSH + Mnemon WebUI 的自动化端到端测试仍是独立工作。

## 真实 WebUI 验证

发布前使用隔离环境，避免污染个人记忆：

```text
temporary DSH_HOME
temporary MNEMON_DATA_DIR or custom storageScope
temporary workspace
independent Web port
local link installation
```

建议场景：

1. 空根：UI 不报错，能够创建第一个 Memory Space。
2. 普通对话：只出现短 cue，不强制 recall 或写入。
3. 历史问题：Agent 自主 recall，并返回正确 space provenance。
4. 显式沉淀：worker 查重、选择范围并可被再次召回。
5. 多空间：读取只覆盖 active，写入 inactive 后自动激活。
6. Runtime：USER / MEMORY add、replace、remove 和投影一致。
7. Documents：创建、检索、更新、人工归档和原项目文件不变。
8. 评分审查：轻任务不触发；达标后等待 idle；新 turn 能取消并保留水位。
9. 只读：写工具、写命令和写 RPC 被拒绝，读取仍可用。
10. Sidebar：四个一级标签、记忆体四个二级标签、固定页头、筛选与加载更多均正常。
11. 对话内交互：本回合记忆只在已完成且有活动的回合出现；跳转目标正确；存入记忆取消不写入。
12. 设置：Sidebar / Buildin、存储范围与两个对话开关保存后实时生效，不需要刷新。
13. ZIP：导出后可预检，并能在隔离 custom 根完成合并恢复；损坏 checksum 必须拒绝。
14. 版本：检查不会安装；link / 手工来源不显示不安全更新；更新完成后自动重新检查状态。
15. 状态和浏览器控制台：无未处理错误或警告。

容量极限、CLI 超时、revision 冲突和 Host 重启应在专用故障注入环境验证。

## 维护文档视觉素材

公开 UI 截图统一位于 `docs/assets/screenshots/`，中英文文档复用同一组实机画面；语言相关架构图分别保存在 `docs/assets/diagrams/zh-CN/` 与 `docs/assets/diagrams/en/`。界面结构、主要文案或默认行为变化时：

1. 使用真实 DSH Web profile，但先检查画面中没有 token、凭据或不应公开的个人数据；
2. 主截图与视频以 1600×900 标准宽屏为基线，不再使用窄视口作为发布主素材；
3. 完整录制页面向下与向上滚动，并覆盖筛选、重复点击、切换、展开、弹窗和精确跳转等按钮状态；
4. 写入、更新组件和保存设置停在最终确认前；使用公开测试数据的只读 Agent 查询可以真实执行，并应录到等待和结果；
5. 覆盖同职责截图，避免按版本不断累积文件名；只有新增用户任务时才增加素材；
6. 同步 README 海报、GIF / MP4 演示和 `ui-guide.md`；
7. 检查 PNG / JPEG 扩展名与真实编码一致，并在原始分辨率下确认文字可读；
8. 删除已无引用、展示旧 Buildin 布局或术语过时的截图；
9. 运行链接与图片检查，再人工打开中英文 README 和 UI 指南。

README 演示资源位于 `docs/assets/media/dsh-mnemon-memory-system-demo.*`。演示顺序应覆盖状态、运行时、档案、记忆体、Provider 与弹窗交互；既要展示整体上下滑动，也要展示关键按钮的两种状态。自动化不得真正提交记忆、更新组件或保存设置，但可以执行安全的只读 Agent 查询。

## 修改 subagent schema

Mnemon 的一次性结果工具采用 DSH 工具参数支持的紧凑 JSON Schema 子集：

```text
type, oneOf, properties, required, additionalProperties,
items, enum, const, and annotation keywords
```

不要加入 `maxItems` 等不受支持关键字。`assertDshOutputSchema()` 会在注册结果工具前递归拒绝未知 schema 键；结果数量等限制由 persona 和 Host parser 双重实现。

## 修改存储格式

Runtime、Documents 和 Memory Space registry 都带版本字段或固定结构。修改时需要：

1. 明确旧格式解析策略；
2. 增加迁移或拒绝路径；
3. 保证临时文件与原子 rename；
4. 补充并发和损坏输入测试；
5. 更新中英文存储、运维和 Roadmap 文档；
6. 在复制的数据根上完成升级/回退验证。

当前没有正式 schema migration 框架，不应静默改变持久格式。

## 文档国际化维护

`docs/zh-CN` 与 `docs/en` 应保持同名文件和相同章节职责。修改默认值、流程或限制时：

- 同步两种语言；
- 保持命令、配置键、路径和代码符号完全一致；
- 使用相对路径互链对应语言页面；
- 架构总览优先使用可访问、无脚本和无外部资源的 SVG；目录树、命令、公式与短协议仍使用可复制的 `text` / ASCII；
- 根 README 只保留摘要，把细节放到单一权威 docs 页面；
- 所有用户可感知界面变化同步检查 `ui-guide.md`、`getting-started.md`、`configuration.md` 与 `operations.md`。

Web locale 变更时，中文键集合仍是类型事实源；英文词典必须满足 `Record<MnemonKey, string>`，并保持占位符一致。

## 发布检查

```text
[ ] pnpm run verify
[ ] 确认 worktree 中没有生成的 lib diff
[ ] 确认发布包只包含运行时、声明、根文档和 cordis.patch.yml
[ ] install the built/local bundle into an isolated Web profile
[ ] confirm `verify:headless` activates the built bundle in an isolated Headless profile
[ ] run real Mnemon CLI and WebUI smoke tests
[ ] verify Chinese and English workspaces
[ ] verify global/workspace/custom paths as applicable
[ ] record tested DSH and Mnemon versions
[ ] back up any data root used for upgrade testing
```

`package.json.files` 当前发布 `lib`、patch、两份根 README、`SECURITY.md` 和 License。文档站点与媒体继续保留在 GitHub，不进入 npm 包。

## 发布到 npm

发布后 `dsh plugin --profile web add dsh-mnemon` 即按 registry 名称解析（与 dsh-better-sidebar 同路径）。发布步骤：

```sh
pnpm run verify
npm pack --ignore-scripts
npm publish dsh-mnemon-<version>.tgz --access public --ignore-scripts
```

发布已经打好的 tarball，能确保 npm 收到的就是人工检查过的制品。GitHub release workflow 会在核对 tag 与 `package.json` 后执行同一流程。

凭据约定：NPM_TOKEN 只写入用户级 `~/.npmrc`（`npm config set "//registry.npmjs.org/:_authToken" "${NPM_TOKEN}" --userconfig ~/.npmrc`），发布后删除。**不要**把凭据行提交进仓库 `.npmrc`：pnpm 11 出于安全会忽略项目级 `.npmrc` 中未展开的环境变量凭据并告警，且该文件会随仓库传播。

2FA 注意：若 npm 账号开启发布级两步验证，交互发布直接执行 `pnpm publish --access public`，按提示输入 OTP；脚本/CI 发布需改用 Classic **Automation** 令牌或允许 bypass 2FA 的 Granular 令牌（`npm login` 生成的普通令牌无法发布，会报 403 Two-factor authentication required）。

发布前核对 `package.json` 的 `repository`/`homepage`/`bugs` 指向 `omdsh-dev/dsh-mnemon`（npm 页面与 GitHub 保持一致），并确认版本号已递增。
