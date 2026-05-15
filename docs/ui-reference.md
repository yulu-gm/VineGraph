# UI 参考图与约束

后续所有 VineGraph / AgentGraph 前端 UI 调整，都必须优先参考本目录下的三张参考图：

- `docs/ui-reference/reference-ui-1.png`
- `docs/ui-reference/reference-ui-2.png`
- `docs/ui-reference/reference-ui-3.png`

这些图片是当前 Graph Harness UI 的视觉与布局基准。新增页面、重构布局、调整节点样式、改 inspector、改运行日志面板时，都要先打开这些参考图对照，不允许脱离参考图另起一套视觉方向。

## 必须保留的设计方向

1. 整体是深色桌面工具界面，不做营销页、不做浅色卡片式后台。
2. 主画布必须是带网格的 Graph Canvas，节点和连线是第一视觉中心。
3. 顶部保留项目 / graph 选择、运行、停止、验证、设置等工具栏语义。
4. 左侧保留导航和项目 / graph / 节点入口，适合长期操作和扫描。
5. 右侧保留 Inspector，用于展示 Graph details、Node details、Node types、输出路由和守卫。
6. 节点样式按类型区分：Start/End、Agent/Execute、Command、Controller/Branch、Human Gate、Internal。
7. 连线必须有清晰方向和语义颜色：正常流转、成功、失败、回环、人工介入要容易区分。
8. 运行状态、日志、diff、controller decision 必须可见，不能隐藏成只有命令行才能看。
9. 圆角、边框、阴影、发光效果都要克制，服务于节点层级和状态识别。
10. 后续 UI 验收必须包含真实浏览器截图，并和参考图进行视觉对照。

## 当前三张图的侧重点

- `reference-ui-1.png`：完整工作台布局，包含左侧导航、节点面板、中央 canvas、右侧属性检查器、底部运行时间线 / diff。
- `reference-ui-2.png`：纯 canvas 展示，重点是节点类型、连线颜色、网格背景、缩放控制和 flow 布局。
- `reference-ui-3.png`：产品化桌面壳布局，重点是顶栏、左侧 workspace、右侧 inspector、状态栏和 graph canvas 的整体密度。

## UI 改动验收清单

- [ ] 本次改动没有削弱 Graph Canvas 的第一视觉中心地位。
- [ ] 顶部工具栏、左侧导航、右侧 Inspector 的信息层级仍然清晰。
- [ ] 节点、连线、状态、日志、diff 至少有一处真实运行数据可见。
- [ ] 字体大小、按钮尺寸、输入框和面板在桌面宽屏下不拥挤、不溢出。
- [ ] 颜色不是单一蓝紫主题；至少有蓝、青绿、紫、橙、红等语义色参与状态表达。
- [ ] 浏览器截图与三张参考图的布局方向一致。
