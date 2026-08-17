# 已确认事实链（2026-08-15）

## A. 截图结论（用户/社区实验，chat/completions 直连）
- tools 不存在 / [] / tool_choice=none → we need
- tools>0 && tool_choice!=none(auto) → let me（"数量名称不影响"）
- 《某长prompt》可覆盖协议（语义路径）
- tool_choice 是 per-request 开关，无跨请求记忆
- 灰测/正式版 tool_choice 默认行为可能不同

## B. modeltest 实验文档（2026-08-14，探针固定 max_tokens=1024）
- Pro：首轮工具目录是轨迹变量（bash+read→we；bash+glob→let me；PTC run_code 单工具→let me；25 工具→let me）
- 影响来自"实际可调用的 schema surface"，不是文本提及
- 动态晋升（turn1 两工具→turn2 25 工具）后轨迹保持（Need... 无 let me）
- 决定性实验：锚定后恢复完整工具，风格保持（官方 API 环境）
- Flash 由 persona 主导；Pro 由工具面主导

## C. anchored-standard Issue #6（2026-08-15，官方端点）
- 首轮 max_tokens 是最强变量：1024→26/32(81%) we；256000→0/5 let me；非单调（4096 翻转、8192 未翻转）
- 两轮验证：首轮 1024 锚定后放开 256000，次轮仍保持（we=1, letMe=0）
- 技能目录注入（skill-catalog ~9KB user 消息）阻断：0/9 vs 81%
- DSH 身份头双头概率调制：双头 4/7 vs 无头 18/18 (p≈0.0016)
- 并发标题请求弱效应
- 中文题面一般不出 We need 指纹（有反例数据点）
- 服务端行为 8-14 vs 8-15 漂移（256k 下 8-14 minimal-like、8-15 0/5）
- 陷阱：requestProposal(persistedHeader) 会把上一份 header 的 maxTokens 带进下一请求，晋升后需显式剥离

## D. 梁神模式实现现状（~/.dsh/.agent-presets/liangshen）
- phase1：wire tools=[bash,str_replace_editor]；仅 persona section；无上下文；仅用户消息
- 已剥离：skill-catalog、agent-instructions（deferredSources）[OK] prepend:true [OK]
- 未控制：首轮 maxTokens（走适配器默认 ~256k/384k）[X]
- 晋升：anchorGate（首块 we 且无 let me / 4 步兜底 / turn-end 释放）；promoteAfterFirstResponse [OK]
- 晋升后：PTC run_code 单工具 + persona 追加 cwd + 延迟 1 步注入
- 校验：stringList 要求非空数组（空工具配置会被拒绝，需改校验）

## E. DSH rc.6 harness 事实
- 用户默认 provider=opencode-go（pi-ai openai-responses），reasoningEffort=max，模型 deepseek-v4-flash（本会话 PTC）
- pi-ai openai-responses：immediate.length>0 才发 tools 字段；toolChoice 透传但 DSH 不设置
- dsh-llm-pi-ai：options 不透传 toolChoice
- dsh-agent-loop：tools.length>0 才发；agent/request 瀑布可改 maxTokens；requestProposal 有 adapterDefaults.maxTokens=true 剥离机制；agent/pre-step 瀑布存在
- dsh-llm-deepseek（官方适配器）：发 x-deepseek-harness-user-id + session-id 双头

## F. 本地实测（macOS + opencode-go）
- 27376e37（liangshen）：首块 "We need review repo..."（we=1,letMe=0）[OK]；晋升后 #1 起立即 let me（I need... Let me...）
- 与 modeltest 官方 API 的"晋升后保持"相反 → 环境差异（opencode-go 中转）
- 全量基线（262 会话混合 preset）：minimal-like 仅 8.8%（但混杂 run_code/其他形态）

