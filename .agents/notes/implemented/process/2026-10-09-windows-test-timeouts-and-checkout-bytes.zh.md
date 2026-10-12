# Agent Note：Windows 原生测试超时与检出字节

Status: implemented

[English](2026-10-09-windows-test-timeouts-and-checkout-bytes.md) | 中文

## 问题

独立的[原生 Windows 任务](2026-08-08-native-windows-pull-request-ci.md)在 2026-10-03 到 2026-10-09 之间结束的 50 次 pull request 运行里失败了 22 次（另有 9 次被取消），其中包括没有改动它所测内容的运行。每次失败的测试都不一样，看起来像噪声。

## 证据

按失败类型对失败运行的日志做了分类（51 个失败的测试实例）：

- **27 次是 Vitest 默认 5 秒超时**，另有 3 次是显式的 15 秒或 30 秒上限，分布在大约二十个文件里：Git、SQLite、文件系统和子进程夹具。覆盖率这一步在失败和通过的运行里用时相同（中位数约 790 秒），所以失败时机器并没有更慢，是个别测试越过了这条线。
- **10 次换行断言**，提交里是 `\n`，读到的是 `'exact commit fixture\r\n'`。其中一次早于此前的 snapshot 导入修复，另外三次就是下面这个情况。
- **约 10 次临时目录竞争**（`ENOTEMPTY`、`EBUSY`、`ENOENT`），发生在测试删除一个刚被进程关闭文件的目录时，另有一次临时 socket 上的 `listen EACCES`。

## 决策

**检出字节是产品修复。** `materializeWorkspace` 用 `git clone --shared --no-checkout` 和 `git checkout --detach` 创建远程执行检出，继承了宿主的 Git 配置。Windows 宿主通常有 `core.autocrlf=true`，所以成员收到的是 CRLF 文件，而不是提交里的字节。snapshot 导入路径已经固定了 `core.autocrlf=false`；现在两条克隆路径都在检出前固定它。事后设置它并执行 `git reset --hard` 的测试辅助函数已删除：当文件大小和时间与索引一致时 `reset --hard` 不会动它，所以它只在 Git 的 racy 时间戳窗口内才修复检出，这就是失败时有时无的原因。回归测试把 `GIT_CONFIG_GLOBAL` 指向 `core.autocrlf=true`，在任何平台都能复现。

**Windows 使用更长的默认超时，而不是逐个测试打补丁。** `vitest.config.ts` 里 Windows 默认测试 20 秒、钩子 30 秒；Linux 和 macOS 保持 5 秒和 10 秒，测试里显式设置的超时始终优先。运行结果显示是一批测试都靠近这条线，而不是某一个夹具特别慢，再加一个单测的覆盖只是重复同样的补丁。

**临时目录清理重试**（`fs.rm` 的 `maxRetries`、`retryDelay`），用于以这种方式失败的两个 spec。

## 考虑过的替代方案

**保持 5 秒，逐个修测试。** 之前每次修复只去掉一个失败的测试，失败率仍然接近一半。

**所有平台都调高超时。** 这会为了 Windows 的问题，在必需的 Linux 任务上掩盖变慢的回归。

**让原生任务对失败的测试重试。** 重试会隐藏不稳定的测试，而这个任务的价值恰恰是它不被掩盖的结果。

## 后果

Windows 上的卡死会在 20 秒而不是 5 秒后被报告，在 Windows 上变慢的测试不再在 5 秒处失败。新的默认值并不证明这个任务已经稳定：改动前测得的失败率是要对比的基线，因其他原因失败的测试（`listen EACCES` 的 socket、一处 Cordis catalog 比较、一处受管文件工具匹配）留给各自单独调查。
