# @deepseek-ai/dsh-model-allocation

[English](README.md) | 中文

面向 TaskGraph 的配额感知模型分配 Service Definition。它只拥有不可变 Offer 与分配计划，不读取产品私有协议、不执行节点，也不修改 Scheduler 状态。Provider 可以综合原生订阅、独立配额池、计费 API 兜底、质量等级与并发容量。

本包没有模型可见面；编排 Consumer 会把选定计划保存为已封存执行工件和有界事件。
