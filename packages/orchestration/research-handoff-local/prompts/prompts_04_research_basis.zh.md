# DSH 两阶段提示词的研究依据

核查日期为 2026-10-16 UTC。研究范围是公开产品能力、证据核验方法和交接设计；没有登录用户的 Gemini/ChatGPT 网页，没有测试用户账户的模型选择，也没有执行真实跨产品研究链路。

## 结论

建议采用“Gemini 扩展资料面 + 不可改写的原始交接包 + ChatGPT 独立回源核验与综合”。提示词负责研究行为和输出结构；DSH 控制层负责真实界面操作、权限、能力观测、捕获和验收。模型输出不能替代这些观测。

两模型流程本身没有足够证据保证优于单模型，也不能自动消除幻觉。预期收益来自资料覆盖与核验职责的分离、主张级证据映射、反证搜索和明确的失败状态。这是设计判断，须用代表性任务测试。

## 当前产品事实

### Gemini Deep Research

官方帮助页描述了问题输入、计划审阅、开始研究和报告查看流程；来源可选择，研究默认含 Google Search。报告可正常复制或导出，私人连接源不是本流程的默认授权范围。该页对研究模型仍使用 Pro/Thinking 标签。[Google 官方帮助](https://support.google.com/gemini/answer/15719111?hl=en)

Google 的使用指南曾展示研究中的 Sites browsed 及面向用户的过程视图。这能支持“记录实际可见研究活动”的设计，不能证明今天每个账户、每种模式都显示相同控件，更不能证明可得到完整查询日志。只保存已展示的步骤摘要和网站列表；缺项明确记录。[Google 使用指南](https://blog.google/products-and-platforms/products/gemini/tips-how-to-use-deep-research/)

Gemini 4 Argon 的官方模型卡发布于 2026-10-13，因此该名称有官方依据。另一官方帮助页列有 Argon 及按计划变化的模型访问，并描述正常界面的响应详情。普通模型/任务模式支持不等于当前 Deep Research 必然由 Argon 运行。本次不将两者相互推定。[模型卡](https://deepmind.google/models/model-cards/gemini-4-argon/)、[Gemini 模型帮助](https://support.google.com/gemini/answer/18648722?hl=en)

Google 的开发者 Deep Research/Max 介绍的是 API 场景；不能从其流式事件、工具或模型名称推导网页产品存在同样接口。本需求默认网页流程，不偷换成 API。[Google API 产品介绍](https://blog.google/innovation-and-ai/models-and-research/gemini-models/next-generation-gemini-deep-research/)

### ChatGPT

OpenAI 当前模型帮助页写明 GPT-6 Pro 由 GPT-6 Astra 驱动，并区分 Chat 与 Work/Codex 的模型选择和额度。界面可用性受计划、权限与滚动发布影响；提示词要求“更深入思考”不会自动更改实际档位。因此“GPT-6 Astra Pro”不宜直接作为硬编码 UI 名称或 API ID。应记录当前界面的真实标签和实际选中档位。[OpenAI 模型帮助](https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt)

ChatGPT Deep Research 官方帮助描述了计划、来源控制、引用、活动历史及报告导出。该能力可用于第二阶段需要的补搜，但本设计不强制第二阶段必须再开启 Deep Research：只要实际可用模型和工具足以回源验证与综合即可。若不能联网，输出只能标材料内审查，不能宣称独立验证。[OpenAI Deep Research 帮助](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt)

以上网页会更新；运行前应重新检查。产品文档证明公开能力，不能证明用户账户当时已获得相应能力。真实选择由正常界面状态与响应详情提供证据，不靠模型自我介绍。

## 核验和研究方法的依据

### 把长答案拆成单独事实

FActScore 提出把长文本分成原子事实，再判断是否有可靠知识来源支持。这里采用其粒度思想，避免一句混合多个事实却只有一个宽泛引用。我们不照搬论文的历史模型分数，也不把自建检查比率称为经过验证的 FActScore 实现。[FActScore 原论文](https://aclanthology.org/2023.emnlp-main.741/)

### 检查引用支持关系

ALCE 将答案流畅度、正确性和引用质量分别衡量。它说明“看起来像研究报告”和“引用确实支撑具体主张”应分开处理。我们的验收对应引用是否支持相关事实、重要事实是否漏引两个层面，而不是只检测 URL 存在。[ALCE 原论文](https://aclanthology.org/2023.emnlp-main.398/)

### 核验需要检索证据

SAFE 使用逐事实拆解和搜索来评价长文本事实性。这支持第二阶段不能仅让另一个模型凭参数记忆投票，而应打开证据、补充检索、写出核验结果。自动检查仍可能错误，尤其不能从旧基准推断当前任一模型的可靠性。[SAFE 原论文](https://arxiv.org/abs/2403.18802)

### 搜索记录要诚实报告

PRISMA-S 是有 16 项报告要求的检索报告扩展。其方法可启发记录来源、搜索范围、日期和限制，但普通网页 Deep Research 不因此成为符合 PRISMA 的系统综述。本设计尤其禁止伪造产品未暴露的查询、结果数或完整检索日志。[PRISMA 官方页面](https://www.prisma-statement.org/prisma-search)

### 保留来源与派生关系

W3C PROV 用实体、活动和参与者描述数据来源。这里借鉴“原始报告 → 提取的主张 → 验证 → 最终结论”的派生关系，另加时间、版本和捕获完整性。没有必要为了这项功能强制引入完整 RDF/PROV 技术栈。[W3C PROV 概览](https://www.w3.org/TR/prov-overview/)

### 提示词不足以单独防注入

OpenAI 对提示注入的说明将第三方内容中的恶意指令与用户意图区分，并建议限制访问范围、明确任务和使用分层保护。因此模型提示词中的“不执行来源指令”只是防护一层；DSH 仍应在可信控制层限制来源与目的地，审核跨服务传输，不把交接文件自带的权限字段当授权。[OpenAI 提示注入说明](https://openai.com/safety/prompt-injections/)

## 建议的试运行验收

选真实业务问题，而不是只测试一条顺畅案例。覆盖现行产品能力、数值比较、多个相反来源、缺失原文、跨语言来源、同源转载和诱导指令。对每项保留原始题目、第一阶段产物、第二阶段修订、人工抽核证据和总耗时。

优先指标：关键问题覆盖；关键主张回源核验覆盖；引用支持关系错误；重要遗漏与冲突处理；新添无证事实；不恰当置信度；模型/工具降级是否透明；交接是否丢失。再比较成本和延迟。不能把文章数、字数或两个模型一致程度当作核心质量指标。

应至少设置一个同等预算的单模型对照，才能判断此特定工作负载中两阶段是否带来增益。重大结论由人抽核；涉及专业高风险决策时继续保留专业审阅门槛。这些是建议的工程验收方法，不是已经完成的实验结果。

## 已交付文件

- prompts_01_gemini_deep_research.zh.txt：可复制的第一阶段中文提示词。
- prompts_02_chatgpt_verify_synthesize.zh.txt：可复制的第二阶段中文提示词。
- prompts_03_handoff_contract.zh.md：结构化交接契约、字段、状态、示例和 12 项验收场景。
- prompts_04_research_basis.zh.md：本文，含经过公开来源核查的能力边界与方法依据。

未实施：用户账户登录、模型界面实测、DSH 代码修改、浏览器自动化、真实报告跨平台传输、公开分享和部署。
