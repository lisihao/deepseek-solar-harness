# @deepseek-ai/dsh-scheduling-evidence-rpc

[English](README.md) | 中文

`ctx.schedulingEvidence` 的已认证 Host RPC 只读 Consumer。`/scheduling-evidence` 通道只有一个端点 `overview`，不接收负载，也不修改任何东西。它返回调度证据设置区所需的页面数据：所有者的 Radar 开关、最近一次周期、已存储版本及其表行数、每一行已存储的模型数据，以及当前生效的 `model-allocation.publicEvidence` 和 `model-allocation.costAware` 模式。

该通道以 `trusted-host` 权限注册。网关通过运行采集器的 `status` 和 `show` 命令读取存储，所以页面显示的是磁盘上的内容，而不只是分配器在内存里持有的部分。

## 模型体验

无。负载只发给设置页，不会进入任何模型请求。

#### KV 缓存影响

无；该通道不会向请求前缀添加任何内容。

## 已知限制与后续工作

- 页面数据包含每一行已存储的模型数据（第一次采集为 89 行），不分页。
- 每次 `overview` 调用会启动两个短暂的采集器进程；页面每次访问请求一次，而不是订阅。
