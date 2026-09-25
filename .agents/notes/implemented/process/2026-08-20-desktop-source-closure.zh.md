# Agent Note: Desktop 打包源码闭包

Status: implemented

[English](2026-08-20-desktop-source-closure.md) | 中文

## Problem

[Solar monorepo](2026-08-17-solar-monorepo-p0-p2.md) 已将核心、Desktop 与受管插件源码共置，但 Desktop 在独立 Yarn 构建中仍会安装 sealed package 归档。归档摘要能够证明输入稳定，却不能证明公开 clone 含有应用内每个 package 的可编辑源码。用户自行安装的 profile 插件与私人 Remote Module 目标也需要明确边界，避免为了声明源码完整而把个人运行态复制进 Git。

## Decision

`products/desktop/dsh-plugin-desktop/vendor/manifest.json` 通过 `sourcePackages` map 覆盖全部 `dsh-packages/*.tgz` 归档。每个值都是仓库内相对路径，指向核心 workspace 或 `plugins/managed` 中已被 Git 跟踪的 `package.json`。Desktop vendor 校验器要求归档集合与源码 map key 完全相同，拒绝逃逸仓库或未进入 Git index 的路径，提取每个归档 manifest，并要求 package 名称与版本和对应源码 manifest 一致。它还会把归档内每个非生成文件与对应的已跟踪源码逐字节比较；只有包管理器自动注入的 `LICENSE` 可以对应仓库根许可证。

Remote Modules 归档由通用的已跟踪 package 重新构建，使已接受产品输入不再包含部署专用的历史示例。内容变化会同时更新不可变摘要 manifest 与 Desktop lockfile locator。

共享 client bundle 构建使用仓库相对路径标识 CSS Modules。虚拟模块 ID 与 Lightning CSS 文件名不再包含物理 worktree 根路径，因此从不同 `/Users/.../Projects` worktree 构建同一提交时，class hash 与生成 bundle 注释保持稳定。

默认 Desktop 产品包含每个 sealed 应用 package 的源码，并在构建前验证映射。Sealed 归档继续作为不可变构建输入，使独立 Yarn 产品依赖图不会静默切换解析模式。摘要保护已接受字节，Desktop 校验器则为说明、配置、脚本和其他非生成包内容证明精确的已跟踪来源。根工作区构建完成后，根产物门禁会把每个 sealed 核心归档中的每个生成态 `lib/` 成员与其映射 package 的构建结果进行比较。Desktop 校验器另行把已安装 package 的每个成员与归档成员逐字节比较，因此更新 tarball 却未更新 Yarn file locator 和已安装依赖时，也会在打包前失败。

安装在 `~/.dsh` 的可选插件继续属于用户 profile 扩展，除非 Solar 修改或打包它们。修改或打包的插件必须先携带导入来源与原生检查进入 `plugins/managed`，才能成为产品输入。公开 Remote Modules 行以空 `instances` 数组启用；私人名称、URL 与中继端口只保存在本机 profile 设置中。

## Verification

`yarn verify:vendor` 校验完整 vendor 文件集、不可变摘要、全部已跟踪源码映射、非生成归档内容精确一致、归档与已安装 package 内容精确一致，以及 Anchored Standard delegated-worker 门禁。`pnpm verify-desktop-vendor-build` 在根产物聚合中的 `pnpm build` 之后运行，并拒绝根工作区 tarball 中缺失或陈旧的归档生成文件。Client CSS 测试会从两个物理根路径编译同一 stylesheet，并要求虚拟 ID 与输出完全一致。受管插件归档继续由其组件原生构建与来源检查负责，不归根 pnpm 构建所有。随后 `yarn check` 构建并类型检查 Desktop，运行聚焦与 package 套件，并校验 runtime closure、CLI、loader 和 profile boot。

## Alternatives considered

**移除全部 sealed 归档，让 Desktop 直接解析根 workspace。** 本阶段否决，因为产品有意保留独立 Yarn 依赖图，而根使用 pnpm。改变 package 解析并证明可安装 runtime 等价属于独立兼容性变更，不是让源码可评审、可修改的必要条件。

**只用文档记录源码位置，不提供可执行 map。** 否决，因为新增、删除或独立升级归档后，说明文字可能变得陈旧。

**只在每个归档旁记录源码树摘要。** 否决，因为只更新记录的摘要就能让元数据看似最新，却不能证明生成归档字节来自当前构建。

**导入某位用户 `~/.dsh` profile 中发现的全部插件。** 否决，因为未修改的可选插件不是默认应用构建输入，复制运行 profile 还会把私人配置与生成状态混入产品源码。

## Consequences

公开 clone 可以检查并修改默认 DSH Desktop 应用内每个 sealed package 的源码，再按仓库声明的包管理边界构建已接受的 macOS 产品。新增或替换 Desktop 归档时，必须在同一改动中加入已跟踪源码映射；修改根 package 后，也不能在 sealed 生成代码仍然陈旧时通过产物通道。受管插件的生成字节仍由各自的原生组件资格检查负责。个人插件选择与 Remote Module 目标继续作为可迁移的本地配置，而不是公开产品默认值。
