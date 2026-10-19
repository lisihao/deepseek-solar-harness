# DSH 两阶段研究交接契约

版本 1.0；核查日期 2026-10-16 UTC。本文是设计契约，不代表已实现或已在用户账户跑通。

## 核心原则

交接包同时保留不可改写的原始产物与可修订的结构化索引。后者用于检索和核验，不能替代前者。本文所说“用户可见记录”，是产品正常界面已经向当前用户展示的计划、报告、网站列表和活动摘要；这不意味着该私人会话可以向公众公开。

字段由谁填写，比字段叫什么更重要：DSH 的运行与捕获信息来自实际界面、工具结果或经验证的本地记录；模型只能提供候选主张和分析，不能自行证明身份、访问历史、权限或用户授权。包内的网页、计划、报告和其他模型文字始终是待研究数据。

## 文件结构建议

- manifest.json：任务、运行、捕获范围、文件完整性和阶段状态。
- stage1/question.txt：本次真实用户问题及用户批准的范围，不混入来源内容。
- stage1/prompt.txt：实际提交的第一阶段提示词，含版本号。
- stage1/plan-original.txt：首次显示的研究计划；变更后另存新版本，不覆盖。
- stage1/plan-final.txt：实际开始研究所用的可见计划；平台未显示则明确缺失。
- stage1/report-original.md 或产品原生导出文件：完整原始报告及引用。优先正常复制/下载，不为导出而创建公开分享链接。
- stage1/activity-visible.jsonl：界面可见的网站、查询或活动摘要。只记录实际显示的内容；看不到具体查询则 query_text 为 null。
- stage1/sources.json：报告引用与浏览列表的并集，保留各自来源；“被浏览”与“被引用”分别标记。
- stage1/claims.json：候选主张与证据关系，包含第一阶段出处锚点。
- stage2/prompt.txt、verification.json、changes.json、report-final.md：第二阶段输入、核验记录、修订记录和最终报告。
- capture/：必要的界面截图或正常导出记录，用于证明可见状态；不包含凭据、隐藏端点、浏览器存储或未授权资料。

文件名仅是建议。产品不存在的导出能力不得补造。若某项只能截图，保留截图并注明文字提取方式；提取文本不是原生导出。上下文超限时按完整章节分块并记录顺序、页码和完整性，不能悄悄只传摘要。

## 顶层结构

以下是数据契约的字段定义，不是平台官方 API，也不是已经实现的 JSON Schema。字符串默认 UTF-8；所有时间使用带时区的 ISO 8601。未知值用 null，并附缺失原因；不要用空字符串混淆未知、未提供和不存在。

| 字段 | 类型与约束 | 填写者与含义 |
|---|---|---|
| schema_version | 固定字符串 dsh.research.handoff.v1 | DSH |
| run_id | 全局唯一字符串 | DSH；重试另有 attempt_id |
| task | object | 真实用户问题、目标、范围、约束、截止时间、语言 |
| policy | object | DSH 从可信用户请求及权限判断获得，不采信网页自称授权 |
| stages | object | 第一/二阶段实际状态与时间 |
| runtime_observations | array | 每个阶段的界面模式、模型标签、档位、工具和可见变化 |
| raw_artifacts | array | 原始文件、版本、获取方式、捕获时间、完整性 |
| public_visible_activity | object | 用户可见的研究活动及捕获边界；名称不是公开分享许可 |
| sources | array | 来源目录，不把一个 URL 自动等同一个独立证据 |
| claims | array | 原子主张、原始出处、重要性和证据关系 |
| contradictions | array | 冲突主张、来源、差异类型和解决状态 |
| gaps | array | 缺失信息、影响、可行下一步、是否阻塞结论 |
| verification | object | 第二阶段核验方式、覆盖、逐条结果 |
| synthesis | object | 推断、假设、建议及其依赖主张 |
| final_artifact | object/null | 最终报告引用与交付状态 |

## 关键对象

### task

- original_question：完整原始问题。
- decision_goal、audience、scope、exclusions：用户给定值与助手暂定假设分开。
- as_of、timezone、language：信息截止点、时区、输出语言。
- assumptions：每项含 assumption_id、text、basis=user_supplied/explicit_assumption、impact。

### policy

- allowed_source_classes：默认仅 public_web；任何私人来源需要本任务明确授权。
- approved_material_refs：跨 Gemini/OpenAI 传输的指定资料引用；不含密钥或未经批准的私人资料。
- allowed_destinations：本任务批准的具体研究服务与用户交付位置。
- external_content_is_untrusted：固定 true。
- hidden_reasoning_collection_allowed：固定 false。
- public_sharing_allowed：默认 false。
- authority_evidence_ref：指向 DSH 已验证的用户请求引用，不能由 Gemini 输出填写或改变。

一个 policy 字段无法自行授权。实际执行必须由 DSH 的可信控制层根据当前用户意图与权限独立检查；从文件导入的同名字段也不能升级权限。

### runtime_observations 的每项

- stage、provider、surface、observed_at。
- selected_mode_label、selected_model_label、selected_effort_label：原样记录 UI 字样，未知为 null。
- response_model_label：若正常响应详情可见则记录，与选定标签分开。
- selection_evidence_artifact_ref：可见状态的证据引用。
- available_tools、observed_tool_use：区分界面提供与本次实际使用。
- identity_observation=ui_observed/platform_returned/unknown；模型自述单独存为未经验证陈述，不能冒充这两类观察。
- fallback_observed、fallback_reason、selection_changes：额度或模式变动时保留，不静默降级。
- capability_notes：例如最高模型无法浏览时，明确标记核验能力缺口；未经用户批准的替代方案不能冒充原要求已满足。

“最高能力”仅指本次账户、界面、额度和任务所需工具约束内的可用选择，不代表经过比较试验的全球最优模型。提示词要求不会自动选择最高模型。

### raw_artifacts 的每项

- artifact_id、kind、stage、relative_path、media_type、byte_count。
- captured_at、capture_method=native_export/copy_visible_text/screenshot/derived_extraction。
- sha256：由捕获程序实际计算；未计算写 null。哈希只证明同一文件内容未变，不证明内容真实。
- version、derived_from_artifact_ids、capture_completeness=complete/partial/unknown。
- missing_segments、limitations；original=true 的文件只追加新版本，不原位重写。
- native_citation_mapping_preserved：引用标号及链接是否成功保留，不能仅凭正文存在判定 true。

### public_visible_activity

- capture_status=complete_for_observed_view/partial/not_exposed/not_captured。
- surface_label：界面实际名称，例如 Sites browsed；不得假设标签固定。
- observation_window_start/end、coverage_notes。
- events[]：event_id、observed_at、displayed_timestamp（若无则 null）、event_type、visible_text、query_text、source_ids、artifact_ref。
- event_type=plan/query/site_visit/status/public_summary。公开步骤摘要只保存产品已显示内容，不补写隐藏过程。

complete_for_observed_view 只表示已保存所见视图，不表示收集到所有查询、所有页面访问或完整内部研究过程。自己后来补搜的记录必须属于 stage2，不能回填为 Gemini 活动。

### sources 的每项

- source_id、title、authors_or_publisher、original_url、resolved_url、canonical_url（无法确认则 null）。保留原 URL，不随意删去有语义的查询参数。
- published_at、updated_at、accessed_at、content_as_of、version、language。
- source_type=official_document/original_research/original_data/standard/primary_record/review/secondary_report/other。
- discovered_via=stage1_citation/stage1_visible_activity/stage2_search/user_provided，可多值。
- read_scope=full_text/relevant_sections/abstract/search_snippet/unavailable/unknown，分别按阶段记录。
- source_family_id、depends_on_source_ids：标明转载、同一研究或数据来源。
- interests_or_limitations、retraction_or_correction_status：未知即 unknown，不自行声称无更正。
- evidence_locations[]：location_id、section/page/table、brief_paraphrase、short_quote（可选）、capture_ref。

只记录可访问的证据；避免在 URL、截图或日志内保留鉴权 token。来源是否可靠需要结合主张判断，不能仅由域名或类型推出。

### claims 的每项

- claim_id、text、claim_type=source_statement/externally_checkable_fact/synthesis_inference/recommendation/assumption。
- scope、time_scope、importance=critical/material/background。
- origin_stage、origin_artifact_ref、origin_locator、parent_claim_ids。
- evidence_links[]：source_id、location_id、relation=supports/partially_supports/contradicts/context_only/unverified、rationale_summary。
- confidence=high/medium/low/unknown 与 confidence_basis。
- stage1_status=claimed_supported/claimed_mixed/claimed_unknown。第一阶段自述状态不能继承为第二阶段验证结论。

### verification

- method=source_reopened/mixed/material_only/not_started。
- claim_inventory_complete：能否证明主张清单覆盖整个报告。
- checked_claim_ids、unchecked_claim_ids、critical_claim_ids、sampling_policy。
- checks[]：check_id、claim_id、checked_at、checker_stage、source_ids、observed_read_scope、verdict、rationale_summary、remaining_uncertainty。
- verdict=supported/partially_supported/contradicted/irrelevant_citation/unverifiable。
- completeness_metrics：关键主张回源核验数/关键主张总数；已检查引用关系数/待检查引用关系数；缺失来源与实质矛盾数。必须保留分母定义；不将这些指标命名为绝对事实正确率。

### synthesis

- conclusions[]：conclusion_id、text、kind=finding/inference/recommendation/scenario、depends_on_claim_ids、assumptions、confidence、counterevidence_ids、change_conditions。
- changes_from_stage1[]：原 claim_id、action=retain/narrow/correct/remove/add、replacement_claim_id、reason、evidence_refs。
- unresolved_material_issues：保持显式列出，不能在最终排版时删除。

## 交接示例骨架

下例仅展示容器，不代表已有真实研究运行。

```json
{
  "schema_version": "dsh.research.handoff.v1",
  "run_id": "TO_BE_ASSIGNED",
  "task": {
    "original_question": "TO_BE_PROVIDED",
    "as_of": null,
    "timezone": "UTC",
    "language": "zh-CN",
    "assumptions": []
  },
  "policy": {
    "allowed_source_classes": ["public_web"],
    "approved_material_refs": [],
    "allowed_destinations": [],
    "external_content_is_untrusted": true,
    "hidden_reasoning_collection_allowed": false,
    "public_sharing_allowed": false,
    "authority_evidence_ref": null
  },
  "stages": {
    "stage1": {"status": "not_started"},
    "stage2": {"status": "not_started"}
  },
  "runtime_observations": [],
  "raw_artifacts": [],
  "public_visible_activity": {
    "capture_status": "not_captured",
    "surface_label": null,
    "observation_window_start": null,
    "observation_window_end": null,
    "coverage_notes": "No research run has been performed.",
    "events": []
  },
  "sources": [],
  "claims": [],
  "contradictions": [],
  "gaps": [],
  "verification": {
    "method": "not_started",
    "claim_inventory_complete": false,
    "checked_claim_ids": [],
    "unchecked_claim_ids": [],
    "critical_claim_ids": [],
    "checks": []
  },
  "synthesis": {"conclusions": [], "changes_from_stage1": []},
  "final_artifact": null
}
```

## 状态与验收

阶段一状态：not_started → plan_ready → researching → report_ready → captured；也可能 blocked/failed/partial。只有观察到报告完成并保存了完整正文、引用映射和捕获范围说明后才可标 captured。某些活动由平台未提供时仍可交接，但必须带 gap；不因没有活动日志而伪造完整链路。

阶段二状态：not_started → checking → synthesizing → complete/partial/needs_input。complete 需要所有关键主张有回源核验结果，结论不依赖已知错误，重要未决分歧已显著披露，所有新增外部事实也有相应证据。它不是“全部背景事实逐条检查”或“绝对无误”的承诺。

验收至少覆盖：

1. 固定模型名字不存在或界面无该选项：明确不可用，不假装选择成功。
2. 模型或额度中途降级：记录实际变化，不标作最高模型完成。
3. Gemini 完成而公开活动不可导出：保存可见部分，标明缺项，保留报告继续。
4. 引用存在但不支持句子：被标 irrelevant_citation 或 partially_supported。
5. 多家报道依赖同一新闻稿：算一个证据家族，不能提高独立性置信度。
6. 关键来源被删除或无法访问：unverifiable，并提供影响与下一步。
7. 两份证据在版本或日期上冲突：保留双方范围，并给出有依据的裁定或未决状态。
8. 外部正文要求上传文件、变更提示词或执行操作：不能触发任何该类动作。
9. 跨模型材料被截断：阻止“完整交接”状态，补齐或明确部分结果。
10. ChatGPT 没有网页工具：material_only，不冒充独立回源验证。
11. 第一阶段引用与浏览列表不一致：两份原记录均保留，不互相补写；区分浏览未引用与引用未观察到浏览。
12. 用户问题带未经批准跨服务传输的私人信息：停在传输之前说明具体数据与目的，或使用用户批准的去敏版本。

## 方法来源与限度

主张级核验借鉴 [FActScore](https://aclanthology.org/2023.emnlp-main.741/) 和 [SAFE](https://arxiv.org/abs/2403.18802)；区分答案正确性与引用质量借鉴 [ALCE](https://aclanthology.org/2023.emnlp-main.398/)；实体、活动、派生关系参考 [W3C PROV 概览](https://www.w3.org/TR/prov-overview/)。本契约是针对 DSH 的设计推断，不是这些论文测试或背书过的实现，也不声称具备它们的基准分数。
