# Agent Note: Desktop 底部产品标记

Status: implemented

[English](2026-08-19-desktop-bottom-product-marker.md) | 中文

## Problem

DSH 的持久产品身份与运行版本占用了一个 sidebar additive action。展开的左边栏会为静态文字消耗两行空间，收起后的窄栏又只能显示版本片段。产品身份必须持续可见，同时不能占用导航空间，也不能在呈现代码中复制打包版本。

## Decision

Desktop Client 会在兼容模式和高级模式下直接在 `document.body` 下挂载一个不可交互的标记。该标记用一行呈现 `solarBrandLabel(productVersion)`；其中 `productVersion` 来自 Electron 所有并经过校验的页面 marker。sidebar slot 不再承载产品品牌。

该标记拥有窗口底部 24 像素的区域。body data attribute 会保留这部分空间，使 fixed 标记不覆盖应用 root；窄窗口中的溢出内容会显示为省略号。Client generation dispose 时，Cordis effect 会同时移除元素与空间保留 attribute。

## Verification

Client 测试会校验完整的带版本标签、body 层挂载、不再注册品牌 slot，以及 effect dispose。样式测试会校验 body 保留空间、底部 fixed 定位、单行溢出行为和既有主题底色。Desktop package 检查与已安装应用验收会共同验证打包版本和实际渲染标记。

## Alternatives considered

**继续使用 `sidebar.footer.action`。** 这仍会占用导航空间，并且收起窄栏后依然无法显示大部分产品身份。

**不保留空间，直接覆盖标记。** 这会遮挡应用最底部的控件，并让第三方底部对齐 UI 变得不可靠。

**把完整文字放入原生标题栏。** 兼容窗口与高级窗口使用不同的原生 chrome，macOS hidden-inset 呈现也不提供稳定的全宽标题区域。

## Consequences

左边栏只保留可操作的 Desktop 条目，而产品身份与实际运行包版本会在各种呈现模式下持续可见。每个窗口会为标记让出 24 像素垂直空间；窄窗口可能显示省略号，但完整的无障碍标签和 tooltip 仍会保留。
