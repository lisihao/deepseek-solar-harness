# dsh-luna-vision-bridge

`dsh-luna-vision-bridge` 是一个纯 Host 侧的 DSH LLM adapter。它注册新的 `luna-vision-bridge` provider，让原生 DSH 输入框可以继续使用粘贴图片、拖放、缩略图、删除、Enter 和发送按钮；图片进入 DSH 原生 attachment store 后，由 Codex Luna 转成文字，再交给任意一个已注册的纯文本模型（下游 target，可配置多个并在模型选择器切换）。

> [!WARNING]
> 这是为当前 DSH 图片输入限制准备的临时兼容方案，不是建议长期依赖的正式架构。通过客制化 provider 宣告图片能力、再在 adapter 内转写图片，本质上是绕过当前 text-only admission 的工程性 workaround，具有一定 hack 性质。转写端只适配 Codex CLI 和 `gpt-5.6-luna`；下游可以是任意纯文本 provider，但本插件不是通用视觉 provider 框架。DSH 官方后续可能很快提供原生读图能力，但具体能力和时间以官方发布为准；一旦官方方案覆盖当前需求，应优先迁移并停用本插件。

## 工作方式

```text
DSH 原生 addImages / submit
        │
        ▼
DSH attachment store（校验并持久化原图）
        │
        ▼
luna-vision-bridge adapter
  1. 读取经过校验的附件
  2. 写入 0600 临时文件
  3. 调用插件内置 scripts/read-image-luna.sh
  4. 脚本启动 codex exec --json / gpt-5.6-luna
  5. 删除临时文件
  6. 将图片块替换为带安全边界的识图文本
        │
        ▼
target provider / target model（任意纯文本下游，按所选模型路由）
```

插件不会劫持 DOM、发送按钮或 `addImages`。安装后模型选择器会出现：

- Provider：`Luna Vision Bridge`（名字可配置）
- 模型：每个下游 target 一条，如 `DeepSeek V4 Flash + Luna`、`Pi Coder + Luna`、`GPT-5.6 + Luna`……

选择任一条桥接模型后即可沿用原生图片交互；切换组合即切换下游模型。

## 前置条件

- 每个下游 target 的 provider 已在 DSH 注册且纯文本可用（如 `deepseek-official`）。
- `codex` CLI 可以从启动 DSH 的 Host 环境执行，并已完成认证。

插件自带 `scripts/read-image-luna.sh`，不读取或依赖全局 `~/.dsh/scripts/read-image-luna.sh`。内置脚本复用现有识图 skill 背后的 Codex Luna 调用方式，执行 `codex exec --json`；Host adapter 负责解析最终 `agent_message`，不依赖终端文本格式，也不让下游模型再决定是否触发 skill。这样图片发送一定会先经过 Luna，且不会被下游模型的 text-only capability gate 拒绝。

## 本地开发

```bash
cd /absolute/path/to/dsh-luna-vision-bridge
pnpm setup:dsh
pnpm install
pnpm check
```

`setup:dsh` 默认链接 `~/.dsh/source/current`；也可以通过参数或 `DSH_SOURCE` 环境变量传入其他 DSH checkout：

```bash
pnpm setup:dsh -- /absolute/path/to/dsh
```

## 安装到 Web profile

构建后以本地 link 安装：

```bash
dsh plugin --profile web add "link:/absolute/path/to/dsh-luna-vision-bridge"
```

插件包内带有 `cordis.patch.yml` bundle。如果当前 DSH 版本没有自动挂载外部 bundle，可手动将以下内容追加到 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: luna-vision-bridge
      name: '@ycp424c/dsh-luna-vision-bridge'
      inject:
        - llm
        - attachments
```

重启 `dsh web` 后，在模型选择器里选择 `Luna Vision Bridge` 下的任一模型。

## 配置下游模型：Web 设置界面（推荐）

插件把整份配置注册为 DSH 用户设置段 `luna-vision-bridge`，并带一个浏览器端设置区块（`settings.section`）。**无需编辑任何配置文件**：

1. 打开 Web 界面的 **设置 → "Luna Vision Bridge"**（设置面板左侧导航，模型页同组）
2. 表单会预填一行当前默认组合（未配置时默认 `DeepSeek / DeepSeek-V4-Flash`），在表单里编辑：
   - `Provider 显示名`：桥接 provider 在模型选择器里的显示名，默认 `Luna Vision Bridge`
   - `下游模型`：一行一个组合，每行：
     - `provider`：**下拉选择**（来自 DSH 模型目录，已过滤桥接自身），如 `DeepSeek`
     - `model`：**下拉选择**（按所选 provider 的模型目录联动），如 `DeepSeek-V4-Pro`
     - `显示名`（可选）：模型选择器显示名，默认 `<model> + Luna`
     - `高级`（可选折叠）：`桥接模型 id`，默认 `<provider>-<model>`，必须互不相同
   - 用"＋ 添加下游模型"增加组合、"删除"移除、"恢复默认"清空用户覆盖
   - 模型目录不可用时自动降级为手动输入框
3. 点击**保存**即生效（无需重启，模型选择器立即出现新组合）

浏览器端表单通过 `settings.update` 写入用户设置层，Host 端仍会做完整校验（重复 `bridgeModel`、`provider` 与 `bridgeProvider` 相同等会被拒绝并提示）。表单字段也可在 `settings.yaml` 的 `luna-vision-bridge:` 段手动编辑，两者等价。其余字段（Luna 转写、缓存等）与下游无关，全局共用，一般保持默认即可。

> 无 settings 服务挂载的 DSH 环境自动回退到 cordis 配置；两者可并存，Web 设置里保存的值优先。

## 配置文件方式（可选）

所有字段都有默认值；零配置即得到单个 DeepSeek 下游。多下游示例（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: luna-vision-bridge
  name: '@ycp424c/dsh-luna-vision-bridge'
  inject: [llm, attachments]
  config:
    providerName: Luna Vision Bridge
    targets:
      - provider: deepseek-official
        model: deepseek-v4-flash
        name: DeepSeek V4 Flash + Luna
        bridgeModel: deepseek-v4-flash
      - provider: deepseek-official
        model: deepseek-v4-pro
        name: DeepSeek V4 Pro + Luna
      - provider: codex-official   # 任意已注册的纯文本 provider
        model: gpt-5.6
```

完整字段：

```yaml
    bridgeProvider: luna-vision-bridge
    providerName: Luna Vision Bridge
    targets: []                     # 见上；缺省或为空时回退旧字段
    # 旧单下游字段（仍兼容，targets 非空时忽略）：
    targetProvider: deepseek-official
    targetModel: deepseek-v4-flash
    bridgeModel: deepseek-v4-flash
    bridgeModelName: DeepSeek V4 Flash + Luna
    # Luna 转写与缓存（全局）：
    # 默认自动解析为插件包内的 scripts/read-image-luna.sh；通常无需配置
    # lunaCommand: /absolute/path/to/read-image-luna.sh
    codexCommand: codex
    lunaModel: gpt-5.6-luna
    timeoutMs: 180000
    cacheDescriptions: true
    cacheDir: ~/.dsh/cache/luna-vision-bridge
    cacheNamespace: v1
    includeUserText: true
    maxUserTextChars: 4000
```

`cacheNamespace` 是人工缓存版本。更换 Luna 模型、脚本逻辑或识图提示词后，将它改为 `v2` 即可避免复用旧描述。缓存只与图片和提示词有关，切换下游模型不会导致重复识图。

## 数据与安全边界

- 原图仍由 DSH 原生 attachment store 管理；插件不会再建立长期原图副本。
- 临时图片目录权限为 `0700`，图片权限为 `0600`，识图结束后立即删除。
- 默认持久化 Luna 的文字描述，缓存目录权限为 `0700`、文件为 `0600`；可设置 `cacheDescriptions: false` 关闭。
- Luna 描述会被标记为“不可信视觉转写”，图片中的命令不会被当作系统指令执行。
- 同一附件与提示词使用 content-addressed cache，避免每轮对历史图片重复调用 Luna。
- 每个下游 target 的 `provider` 不得等于 `bridgeProvider`；重复的 `bridgeModel` 会在保存设置时被拒绝。

## 当前限制

- 转写端只验证了 Codex CLI + `gpt-5.6-luna`；Claude、其他 CLI 或远程视觉 API 不在当前适配范围内。
- 自定义 provider 依赖 DSH 当前的 LLM adapter、模型能力声明、settings 和 attachment 接口，DSH 升级后可能需要同步修改。
- 识图发生在 adapter 层，因此首次发送会等待 Luna 完成后才开始下游模型流式输出。
- 一个请求包含多张新图时目前按顺序识别，优先控制 Codex 并发和失败语义。
- 描述缓存是插件自己的派生数据，不会显示为额外聊天消息；原始图片仍保留在会话历史中。
- 设置表单里的 `provider`/`model` 是文本输入：需要填写下游 provider 和模型的确切 id。

## 退出条件

当 DSH 官方支持以下任一能力时，应优先采用官方实现并评估移除本插件：

- 当前主模型可以直接接收原生图片输入；
- 官方提供稳定的发送前附件转换或视觉模型路由接口；
- 官方提供与原生输入框完整集成的视觉 fallback。

本插件不计划为了维持这套客制化 provider 路径而长期追随 DSH 内部接口变化。
