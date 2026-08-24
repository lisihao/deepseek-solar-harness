# UI Physical Operator

[English](README.md) | 中文

这个双面插件在 `/api/resident-operators` 暴露 daemon 持有的 Resident 物理算子投影，并注册对应浏览器控件。Host face 接受 loopback 所有者请求和已配对远程设备 Bearer，只提供 GET，绝不写入 Resident 状态。Client face 为任意 DSH 浏览器壳增加 Resident 状态面板，以及会话级协作／模型／强度选择器。

## 权威边界

- `dsh-resident-operatord` 仍是 Session、Receipt、Lease 和 Event 的唯一写者。
- Host 路由只读取 `ctx.residentOperators`，不复制 prompt、原生 transcript 或持久状态。
- Client 依赖能力接缝和同源认证 HTTP，不依赖 Electron 或 DSH Desktop。
- 路由变更通过已记录的 Host 命令执行；浏览器面板不能直接调用 daemon 控制 socket。

## Model Experience

无。浏览器投影与执行策略控件不会注册模型可见上下文。

#### KV Cache effect

Dashboard 不产生 KV Cache 影响；所选执行策略只影响后续派发。

## 已知限制与后续工作

- 首发仅远程暴露只读 Resident 状态；中断与重置仍是受信任的本机管理操作。
