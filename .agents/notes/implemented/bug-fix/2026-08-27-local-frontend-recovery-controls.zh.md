# Agent Note: 本地 Frontend 恢复控件

Status: implemented

[English](2026-08-27-local-frontend-recovery-controls.md) | 中文

## Problem

Frontend 部署从远程 Client bundle 加载角色控件。当选定 Server 或其隧道不可用时，用于离开 Frontend 模式的控件会与其需要恢复的内容一起消失。

## Decision

Electron 为每个 macOS 窗口 generation 持有原生 Deployment 菜单。Frontend generation 首次无法访问远程页面时，还会在继续原有重连循环的同时换入本地恢复文档。两种本地界面与托盘和远程 Desktop 页脚调用同一组 deployment adapter 操作。

本地恢复文档不包含 Server 数据、凭据、会话状态或通用浏览器桥。它的操作只导航到 Electron 主进程已经拦截的两个准确 deployment URL。

## Alternatives considered

**只保留远程页脚和托盘。** 否决，因为远程页脚与失效 Server 共享依赖，而仅存在于托盘的恢复路径不足以让主窗口用户发现。

**超时后自动启动本地 Host。** 否决，因为 Frontend 模式必须显式失败，不能在没有用户明确操作时创建第二个运行权威。

## Consequences

用户无需先恢复远程 Server，即可从应用菜单或可见恢复页面离开不可用的 Frontend 部署。Electron 除现有托盘控件外还持有一份小型静态恢复文档和 macOS 菜单模板。远程导航成功后会替换恢复文档；系统不会引入离线写队列或自动回退的本地 Host。
