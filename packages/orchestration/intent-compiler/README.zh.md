# Intent Compiler

[English](README.md) | 中文

`ctx.intentCompiler` 把不可变请求转换为版本化的 `IntentIRV1`。它记录 Compiler 溯源和确定性输入／输出 hash；不能创建 Run 或派发工作。

## Model Experience

无。此抽象 Service Definition 不增加模型可见上下文。

#### KV Cache effect

无。消费方决定 Intent 产物是否进入后续模型请求。

## Known Limitations and Deferred Work

- 随附的本地提供方只做确定性直通编译；语义分类和澄清对话需要另一个提供方。
