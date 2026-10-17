# Agent Note：共享 RLM 执行核心搬迁之前，先钉住容量、身份和用量三个接缝的测试

状态：已实现

[English](2026-10-17-shared-rlm-execution-test-slice-a.md) | 中文

## 问题

RLM 执行核心位于 `OrchestrationDaemon` 的私有方法中。把它抽出来，或在它旁边增加第二个消费者（例如独立的 RLM PhysicalOperator），会移动三处决定行为的代码：PhysicalOperator 的容量何时释放、`end` 何时发布；每个 Resident root、child 和消息 continuation 的请求带什么 operator、model 和 effort；每条 `rlm.usage` 事件指向哪个 command。对现有测试的静态阅读发现，每项性质都只有一条比该性质更弱的断言：

- `service.spec.ts` 只在结果已结算之后才调用 `dispose`，并且在启动失败用例之后才挂 `end` 监听器，所以过早释放槽位的 `dispose`、或在启动失败时发布事件的实现都能通过。
- daemon 层测试只比较事件里的 `operatorId`、`model`、`modelOrigin`，从不比较 Resident provider 收到的请求中的 `profile.model` 和 `profile.effort`，所以丢失或被替换的 effort 能通过。
- 用量测试数五条 `rlm.usage` 事件并比较它们的 `source` 多重集，所以一个 child 被记两次、另一个完全没记也能通过。

## 决定

只加测试。生产语义、抽取、新 operator 和网页流程都不在范围内。

1. **容量生命周期**（`packages/physical-operator/physical-operator/tests/service.spec.ts`，容量 1 的 stub）。结果仍 pending 时，`dispose` 不释放槽位，第二次 `start` 得到 `OPERATOR_BUSY`，也不发布 `end`；结果结算时才释放槽位并恰好发布一次 `end`。provider 在返回 run 之前失败，不发布 `start` 也不发布 `end`，两个监听器都先挂好。该用例覆盖 `dispose`；调用者的 `signal` 中止是另一条路径，这里没有对应用例。
2. **身份**（`packages/orchestration/orchestration-local/tests/prime-rlm-e2e.spec.ts`）。Resident fake 收到 daemon 构造的请求。每个请求的 operator、model 和 effort 与一个没有被任何请求碰过的来源比较：root 用封存的执行计划（本次运行的 artifact），每个 child 和 root 会话用运行时的状态文件。继承的 child 等于封存的 root 并记录 `parent-inherited`；显式的 child 等于它被要求的值并记录 `explicit`；消息 continuation 等于 root 会话记录的 model。effort 被断言为已定义，所以两个 undefined 不会相等。使用 Resident fake 是因为它携带 profile；在评测 scope 下 API 路径给每个请求固定同一个 model 和 effort，会掩盖错误的 profile。
3. **逐 command 用量**（`packages/orchestration/orchestration-local/tests/daemon.spec.ts`）。实际运行的 command 取自 worker 收到的请求，以及 child 和 goal continuation 的派发事件。`rlm.usage` 事件的 `sourceCommandId` 多重集与该集合相等，每个 command 一次，并带着它自己的 `source`、`operatorId` 和 `model`。只断言用量完整的 command；scope 内不完整用量的证据不变，不用零补齐，scope 之外可选 cache 字段的默认值不动。

## 考虑过的替代方案

**为这三个接缝建一个通用的 characterization 或 diff 框架**，而不是逐条写针对性断言。放弃：每个接缝的缺口是一条具体缺失的比较（一个任何请求都没碰过的来源、一个多重集而不是逐 command 的对应），不是缺一套框架；框架会比它准备迎接的抽取活得更久。

**用评测 scope 的 API 路径来断言身份**，而不是对着 Resident fake。放弃：该 scope 给每个请求固定同一个 model 和 effort，某个请求上丢失或被替换的 profile 仍会匹配，用例会因错误的理由而通过。

**把调用者的 `signal` 中止并进 `dispose` 这同一个容量用例。** 放弃：它们是进入同一释放逻辑的两条不同调用路径，一个声称同时覆盖两者的用例不能说明未来的回归到底打中了哪一条。

**一个用量用例同时断言完整和不完整的 command 集合。** 放弃：没有任何东西要求它们共用一个夹具，拆开后每个用例的失败只指向一个性质。

## 后果

这三个接缝现在各有一条断言，失败时指向被认定为测得不够的那条具体性质，而不只是更粗的症状；每条也都有一个已验证的负对照证明这一点：`dispose` 释放槽位、`dispose` 发布 `end`、启动失败时多发一个 `start`、profile 丢掉 effort、child 用 root 的分配启动、continuation 或 root 没带 profile 启动，以及 `rlm.usage` 事件重复一个 child 并漏掉另一个、使用节点执行 id、或使用别的 id，都会让对应用例变红。第二个 `end` 和启动失败后的 `end` 会先被包自己的 start/end 不变量拒绝，新的“恰好一次”断言来不及运行，所以这条断言本身没有被单独证明会失败；该不变量本身已经挡住了同一类回归，所以实际保障仍然成立，但这两个负对照记录了一个缺口：它们原本要单独证明的东西，和实际先变红的东西不是同一条。代价是范围变窄：没有通用的 characterization 框架，没有为 API 路径增加 `end` 事件，没有前后对比（那属于抽取本身），没有 root 与 child 共用一个容量 1 的 Resident operator 的容量测试，也没有改动恢复。这些等到有变更触及它们时再做。

## 验证

每个用例的负对照都修改真实的负责代码（`PhysicalOperatorRuntime.start` 里的容量和生命周期代码，或 `daemon.ts` 里的请求和用量代码），运行目标测试，再还原字节，并核对还原后文件的哈希与原始哈希一致。
