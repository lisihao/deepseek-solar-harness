# Changelog

## 0.1.15 — 视觉全面优化（主题更新）

### 新增
- 配置项：`dsh.miku.title`（标题栏文字）、`dsh.miku.cells`（状态栏文字）
- Safari 适配：支持 `prefers-reduced-transparency`（系统开启"降低透明度"时自动去掉毛玻璃，省 GPU 开销）

### 优化
- 背景图保持内置原版纯原创电子偶像氛围图（1920x1080，WebP 内嵌，无静态资源）
- 透明化：左侧导航栏、文件树 / 预览面板、对话区、输入框全部改为毛玻璃（半透明 + blur），背景图透出
- 文字配色：浅色主题正文恢复深墨色文字（WCAG AA 对比度），Miku 蓝保留为强调色；输入框文字深墨色
- 输入框：高不透明度浅色毛玻璃底（`rgba(250,253,255,0.92)` + blur），深墨文字在背景图任意区域都可读
- 按钮：主操作按钮改为实心 Miku 蓝渐变 + 白字，次要按钮为浅蓝底 + 深蓝字 + 细边框
- 拖拽分隔条：去掉白色边框与白条，命中区透明，仅保留 Miku 蓝分割线
- 状态栏：背景改为与标题栏一致的蓝紫洋红渐变，文字白色
- 设置界面：亮 / 暗主题统一为深蓝毛玻璃
- Safari 适配：`prefers-reduced-transparency` 下除移除毛玻璃外，为关键表面补近不透明实底

### 修复
- 修复全局 `* { border-radius: 6px }` 覆盖标题栏按钮 / 状态栏单元格精确圆角的问题
- 修复 CSS 中重复的 scrollBody 规则（合并去重）

### 维护者调整（合入前）
- 移除初音光标与第三方背景图：光标素材与同人背景仅获"本 UI 使用"授权，不满足随包开源许可的再分发要求；背景图恢复为原版纯原创电子偶像氛围图。若后续提供覆盖公开分发与下游商用的书面授权，可另开 PR 恢复光标。
- 浅色主题对比度微调：label-tertiary 调深、主按钮蓝调深至 WCAG AA。
- LICENSE（BSD-3-Clause）与 package.json license 字段统一。

---

# Changelog (English)

## 0.1.15 — Visual overhaul (theme update)

### Added
- Config keys: `dsh.miku.title` (title text), `dsh.miku.cells` (status text)
- Safari support: `prefers-reduced-transparency` (frosted glass degrades to plain fills when the system reduces transparency)

### Improved
- Backdrop stays the original pure-original electronic-idol ambience art (1920x1080, WebP inlined; no static assets)
- Transparency: sidebar, explorer/preview panes, conversation and inputs are now frosted glass (translucent + blur); the art glows through
- Text colors: light-theme body text restored to deep ink (WCAG AA contrast); Miku blue stays an accent; input text is deep ink
- Inputs: high-opacity pale frosted fill (`rgba(250,253,255,0.92)` + blur) so deep-ink text stays readable over any backdrop area
- Buttons: primary actions use a solid Miku-blue gradient with white text; secondary buttons are pale blue fill with deep-blue ink and a hairline border
- Drag handles: white borders/bands removed; transparent hit zone with a Miku-blue divider line
- Status bar: background now matches the title bar's blue-violet-magenta gradient with white text
- Settings: both themes share the same deep-blue frosted glass
- Safari: `prefers-reduced-transparency` also raises the key surfaces to near-opaque fills, not just dropping the blur

### Fixed
- Global `* { border-radius: 6px }` no longer overrides the precise corner radii of title-bar buttons / status cells
- Duplicate scrollBody rules merged

### Maintainer adjustments (before merge)
- Removed the Miku cursor and the third-party backdrop: both were only authorized "for use in this UI", which does not cover redistribution under the package's open-source license; the backdrop was restored to the original pure-original art. The cursor can return in a follow-up PR with written authorization covering public distribution and downstream commercial use.
- Light-theme contrast polish: darker tertiary label and darker primary-button blues (WCAG AA).
- LICENSE (BSD-3-Clause) now matches the package.json license field.
