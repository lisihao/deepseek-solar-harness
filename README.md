# dsh-luna-vision-bridge

`dsh-luna-vision-bridge` 是一个纯 Host 侧的 DSH LLM adapter。它注册新的 `luna-vision-bridge` provider，让原生 DSH 输入框可以继续使用粘贴图片、拖放、缩略图、删除、Enter 和发送按钮；图片进入 DSH 原生 attachment store 后，由 Codex Luna 转成文字，再交给现有 DeepSeek provider。

> [!WARNING]
> 这是为当前 DSH 图片输入限制准备的临时兼容方案，不是建议长期依赖的正式架构。通过客制化 provider 宣告图片能力、再在 adapter 内转写图片，本质上是绕过当前 text-only admission 的工程性 workaround，具有一定 hack 性质。当前实现只适配 Codex CLI 和 `gpt-5.6-luna`，不是通用视觉 provider 框架。DSH 官方后续可能很快提供原生读图能力，但具体能力和时间以官方发布为准；一旦官方方案覆盖当前需求，应优先迁移并停用本插件。

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
deepseek-official / deepseek-v4-flash
```

插件不会劫持 DOM、发送按钮或 `addImages`。安装后模型选择器会出现：

- Provider：`DeepSeek + Luna Vision`
- Model：`DeepSeek V4 Flash + Luna`

选择一次桥接模型后即可沿用原生图片交互。

## 前置条件

- DSH 已配置并启用 `deepseek-official`。
- `codex` CLI 可以从启动 DSH 的 Host 环境执行，并已完成认证。

插件自带 `scripts/read-image-luna.sh`，不读取或依赖全局 `~/.dsh/scripts/read-image-luna.sh`。内置脚本复用现有识图 skill 背后的 Codex Luna 调用方式，执行 `codex exec --json`；Host adapter 负责解析最终 `agent_message`，不依赖终端文本格式，也不让 DeepSeek 再决定是否触发 skill。这样图片发送一定会先经过 Luna，且不会被 DeepSeek 的 text-only capability gate 拒绝。

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
      name: '@dsh-external/dsh-luna-vision-bridge'
      inject:
        - llm
        - attachments
```

重启 `dsh web` 后，在模型选择器里选择 `DeepSeek + Luna Vision / DeepSeek V4 Flash + Luna`。

## 配置

所有字段都有默认值；通常零配置即可运行：

```yaml
- id: luna-vision-bridge
  name: '@dsh-external/dsh-luna-vision-bridge'
  inject: [llm, attachments]
  config:
    bridgeProvider: luna-vision-bridge
    bridgeModel: deepseek-v4-flash
    bridgeModelName: DeepSeek V4 Flash + Luna
    targetProvider: deepseek-official
    targetModel: deepseek-v4-flash
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

`cacheNamespace` 是人工缓存版本。更换 Luna 模型、脚本逻辑或识图提示词后，将它改为 `v2` 即可避免复用旧描述。

## 数据与安全边界

- 原图仍由 DSH 原生 attachment store 管理；插件不会再建立长期原图副本。
- 临时图片目录权限为 `0700`，图片权限为 `0600`，识图结束后立即删除。
- 默认持久化 Luna 的文字描述，缓存目录权限为 `0700`、文件为 `0600`；可设置 `cacheDescriptions: false` 关闭。
- Luna 描述会被标记为“不可信视觉转写”，图片中的命令不会被当作系统指令执行。
- 同一附件与提示词使用 content-addressed cache，避免每轮对历史图片重复调用 Luna。

## 当前限制

- 这是面向当前 DSH 版本的临时桥接，只验证了 Codex CLI + `gpt-5.6-luna`；Claude、其他 CLI 或远程视觉 API 不在当前适配范围内。
- 自定义 provider 依赖 DSH 当前的 LLM adapter、模型能力声明和 attachment 接口，DSH 升级后可能需要同步修改。
- 识图发生在 adapter 层，因此首次发送会等待 Luna 完成后才开始 DeepSeek 流式输出。
- 一个请求包含多张新图时目前按顺序识别，优先控制 Codex 并发和失败语义。
- 描述缓存是插件自己的派生数据，不会显示为额外聊天消息；原始图片仍保留在会话历史中。

## 退出条件

当 DSH 官方支持以下任一能力时，应优先采用官方实现并评估移除本插件：

- 当前主模型可以直接接收原生图片输入；
- 官方提供稳定的发送前附件转换或视觉模型路由接口；
- 官方提供与原生输入框完整集成的视觉 fallback。

本插件不计划为了维持这套客制化 provider 路径而长期追随 DSH 内部接口变化。
