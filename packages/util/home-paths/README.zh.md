# dsh-home-paths

[English](README.md) | 中文

DeepSeek Harness 用户数据的共享文件系统路径辅助工具。

## DSH 主目录

`resolveDshHome()` 解析 DeepSeek Harness 的单根主目录。优先级从高到低为：显式配置的路径、`$DSH_HOME`、`~/.dsh`。harness 将所有用户数据保存在同一根目录下。

`dshHomePath(...segments)` 使用 Node 的平台路径规则，将子路径段拼接到解析后的主目录下。不传入任何路径段时，返回主目录本身。

`dshHomeDisplay()` 以符号方式表示当前根目录，用于面向用户的路径：默认主目录表示为 `~/.dsh`，任何已配置的主目录表示为 `$DSH_HOME`。它绝不会泄露机器的绝对路径。

`DSH_HOME_DIR_NAME` 定义默认用户数据目录名：`.dsh`。

`defaultDshHome()` 使用 Node 的平台路径规则，将操作系统主目录与 `.dsh` 拼接，并返回默认 DeepSeek Harness 主目录。

`expandHomePath()` 使用操作系统主目录展开 `~`、`~/...` 和 Windows 风格的 `~\...` 前缀。它会保留非波浪号路径和 `~user/...` 原样不变。

## 监听路径

`canonicalizeWatchPath()` 为原生文件系统 watcher 提供一种稳定的目标路径表示。它通过 `fs.realpath()` 解析层级最深的现有祖先路径，再拼回缺失的后缀，因此即使文件或目录尚未创建也仍可监听。尤其是，Windows 8.3 别名不能与原生 watcher 后端发出的长路径混用。

## 本地 IPC

`localIpcAddress(root, channel)` 为本机 daemon 提供跨平台端点身份。POSIX 在路径符合 macOS Unix socket 限制时使用 `root` 内的 socket；较长路径会确定性地映射到操作系统临时根目录下的当前用户专用目录，而当临时根目录自身过长时使用有界的 `/tmp` 后备路径。Windows 保持确定性的 `\\.\pipe\...` 命名管道地址。`localIpcUsesFilesystem()` 告诉生命周期代码是否需要清理陈旧路径和设置文件权限；Windows 命名管道绝不会被当成文件处理。

该辅助函数只派生端点。POSIX daemon 收到临时端点后，必须以 `0700` 模式创建父目录、以 `0600` 模式创建 socket，并在启动和停止期间清理它自己的陈旧 socket；持久化数据库和产物仍保留在 `root` 下。

该包刻意保持规模小且不依赖 harness，以便产品包共享用户数据路径约定，而不必彼此依赖。

## 已知限制与暂缓事项

- **展开范围刻意保持狭窄**：只有单独的 `~`、`~/...` 和 `~\...` 使用当前操作系统主目录；`~alice/...` 等指定用户的形式、环境变量和 shell 表达式保持不变。
- **规范化会读取，但绝不修改**：`canonicalizeWatchPath()` 会执行 `realpath` 探测，并传播除路径不存在以外的错误；调用方仍负责目录创建、权限，以及对结果路径应用信任策略。
- **IPC 仅限本机**：辅助函数不会打开监听、认证对端或暴露 TCP；准入和生命周期仍由对应 daemon 负责。
