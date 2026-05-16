# UI 参考图与约束

后续所有 VineGraph / AgentGraph 前端 UI 调整，都必须优先参考本目录下的三张参考图：

- `docs/ui-reference/reference-ui-1.png`
- `docs/ui-reference/reference-ui-2.png`
- `docs/ui-reference/reference-ui-3.png`

这些图片是当前 Graph Harness UI 的视觉与布局基准。新增页面、重构布局、调整节点样式、改 inspector、改运行日志面板时，都要先打开这些参考图对照，不允许脱离参考图另起一套视觉方向。

## M1 当前工作台

- 顶部工具栏显示当前项目、当前 graph asset、保存状态、运行状态，并提供运行、停止、Doctor、导出 Patch 和设置入口。
- 左侧 Repository explorer 用于打开项目目录；Graph Assets 区域只自动发现 `.vg.yaml` / `.vg.yml`，旧版 `.yaml` 示例通过 CLI 或导入为 graph asset 保留兼容。
- 左侧还包含 Doctor、Worktrees 和节点面板，服务于项目级运行前检查、workspace 管理和快速查看节点类型。
- 中央 Graph Canvas 从当前 graph asset 的 nodes / edges 自动布局，是工作台第一视觉中心。
- 右侧 Inspector 显示所选节点属性、输出路由、守卫和运行概览；节点配置中的 backend、model、reasoning、timeout、prompt template、command JSON 可以编辑并保存回 graph asset。
- 底部 Runtime Dock 提供日志、Terminal、Controller Decisions 和 Diff 标签页，支持调整高度、折叠、过滤 terminal、复制和清空视图。
- 底部 workspace bar 显示当前运行目标，用户从 workspace switcher 选择 workspace target，旁边显示分支 / detached 信息、路径和 dirty 状态。
- Settings 是本地配置 dialog，包含 controller API key、Codex / Claude CLI 路径、默认 Codex 模型、默认 reasoning effort，以及 `system` / `dark` / `light` 主题模式；主题选择支持跟随系统、深色和浅色。

## 必须保留的设计方向

1. 整体是桌面工具界面，不做营销页、不做卡片式后台；支持 dark、light、system 主题，但信息密度和工具感保持一致。
2. 主画布必须是带网格的 Graph Canvas，节点和连线是第一视觉中心。
3. 顶部保留项目、graph asset、运行、停止、Doctor、导出 Patch、设置等工具栏语义。
4. 左侧保留导航、Repository explorer、Graph Assets、Doctor、Worktrees 和节点入口，适合长期操作和扫描。
5. 右侧保留可编辑 Inspector，用于展示和保存节点配置、输出路由、守卫和运行概览。
6. 节点样式按类型区分：Start/End、Agent/Execute、Command、Controller/Branch、Human Gate、Internal。
7. 连线必须有清晰方向和语义颜色：正常流转、成功、失败、回环、人工介入要容易区分。
8. 运行状态、日志、Terminal、diff、controller decision 必须在 Runtime Dock 可见，不能隐藏成只有命令行才能看。
9. 圆角、边框、阴影、发光效果都要克制，服务于节点层级和状态识别。
10. 底部 workspace bar 必须明确展示当前运行目标，避免 graph asset 和 workspace target 混淆。
11. 后续 UI 验收必须包含真实浏览器截图，并和参考图进行视觉对照。

## 当前三张图的侧重点

- `reference-ui-1.png`：完整工作台布局，包含左侧导航、节点面板、中央 canvas、右侧属性检查器、底部运行时间线 / diff。
- `reference-ui-2.png`：纯 canvas 展示，重点是节点类型、连线颜色、网格背景、缩放控制和 flow 布局。
- `reference-ui-3.png`：产品化桌面壳布局，重点是顶栏、左侧 workspace、右侧 inspector、状态栏和 graph canvas 的整体密度。

## UI 改动验收清单

- [ ] 本次改动没有削弱 Graph Canvas 的第一视觉中心地位。
- [ ] 顶部工具栏、左侧导航、右侧 Inspector 的信息层级仍然清晰。
- [ ] Repository explorer 和 Graph Assets 明确表达 `.vg.yaml` / `.vg.yml` graph asset 工作流。
- [ ] Inspector 编辑后能保存回当前 graph asset，且运行路径不会和画布展示的 graph drift。
- [ ] Settings 中本地配置和 system / dark / light 主题模式可访问。
- [ ] Runtime Dock 的日志、Terminal、Controller Decisions、Diff 能承载运行检查。
- [ ] Workspace bar 展示并切换运行使用的 workspace target。
- [ ] 节点、连线、状态、日志、diff 至少有一处真实运行数据可见。
- [ ] 字体大小、按钮尺寸、输入框和面板在桌面宽屏下不拥挤、不溢出。
- [ ] 颜色不是单一蓝紫主题；至少有蓝、青绿、紫、橙、红等语义色参与状态表达。
- [ ] 浏览器截图与三张参考图的布局方向一致。
