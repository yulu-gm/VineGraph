# Agent Terminal JSON Presentation Implementation Plan

> 当前状态：已实现并验收。本文档现在作为实现记录和回归验收基线使用，不再包含待执行的未完成 task。

## 目标

让 Codex / Claude backend 的 agent terminal 默认呈现接近 CLI 的 Clean 输出：

- 隐藏 session、reasoning、tool result body 和成功命令的完整 stdout。
- 保留 assistant 正文、tool/command 摘要、失败命令摘要、error 和 done 状态。
- 保留 raw JSONL transcript 供调试追溯，但不把 verbose 内容默认展示给用户。
- 在 Inspect 的节点输出里使用真实 xterm 渲染 terminal 输出，而不是用前端逐条模拟日志。
- terminal、节点、session 三者绑定，节点并行时输出不混流。

## 当前实现状态

- [x] 设计文档已创建：`30e140e docs: design agent terminal json presentation`
- [x] Clean CLI presenter fixture 已创建：`a685fd1 test: cover agent terminal clean cli presentation`
- [x] agent terminal presentation 模块已落地：`src/agent-terminal-presentation.ts`
- [x] Codex / Claude JSONL stream 已接入统一 formatter：`src/execute-runner.ts`
- [x] `RawExecutionResult` 已保留 visible transcript、raw transcript 和 agent event summary。
- [x] 独立 Terminal / Controller Decisions 页签已移除，terminal 平移到 Inspect 节点输出。
- [x] Inspect 节点输出使用真实 xterm，不再用前端模拟 terminal 行。
- [x] terminal session 已和 graph node 绑定，默认复用同一节点 session：`ddd35a7 feat: bind terminal sessions to inspect nodes`
- [x] `reuse_session` 已作为节点执行配置，默认开启；关闭时保持原始新 session 行为。
- [x] Clean CLI meta 行 ANSI 样式已恢复：`0100e8c fix: restore agent terminal ansi styling`

## 文件范围

- `src/agent-terminal-presentation.ts`
  统一定义 `AgentTerminalEvent`、Codex adapter、Claude adapter、Clean CLI presenter、ANSI meta line 样式、bounded transcript helper 和 streaming formatter。

- `src/execute-runner.ts`
  Claude / Codex JSONL stream 运行时接入 `createAgentTerminalStreamFormatter()`，只向 terminal 推送 visible chunk，同时保存 raw transcript 和 agent event summary。

- `src/types.ts`
  `RawExecutionResult` 包含 terminal transcript、raw agent transcript、agent events 和 terminal mode 等运行结果字段。

- `src/terminal-attach.ts`
  负责 terminal attach / session 数据聚合，支持同一节点多次进入时维持上下文。

- `src/scheduler.ts`
  生成稳定的 node terminal session id，并把 terminal session 和 activation / node runtime 状态关联。

- `src/server.ts`
  按 `terminalSessionId` 路由 terminal input、resize、interrupt 和 output snapshot，避免跨节点串流。

- `src/ui/app.js`
  Inspect 内挂载 xterm，按 session 分桶缓存输出；切换节点时只显示当前节点 terminal session 的流式输出。

- `examples/implementation-plan-task-loop.vg.yaml`
  graph 节点默认配置 `reuse_session: true`，需要禁用时显式设置为 false。

## 后续需求变更记录

原计划里的 “在 Inspector / Detail 中额外显示 Raw agent transcript” 已被后续 UI 需求取代：

- 不再保留独立 Terminal 页签。
- 不再保留 Controller Decisions 页签。
- Inspect 节点输出区域直接显示当前节点 terminal。
- 节点输出模块默认跟随底部。
- 用户滚轮上滑时取消跟随。
- 滚到最底部，或光标进入最后一行时重新开启跟随。
- 不额外显示左侧 stdout。
- terminal 必须是真实 terminal/xterm，不能退化成一条条模拟数据。

因此 raw transcript 现在主要作为运行结果数据保留，不作为 Inspect 默认主视觉输出。

## Clean CLI 展示规则

- `session`：不显示。
- `reasoning`：不显示。
- `tool_result`：不显示 body。
- `command_start`：显示简短 command 摘要。
- `command_end` 成功：只显示成功状态、exit code 和耗时，不显示 stdout。
- `command_end` 失败：显示失败状态、exit code、耗时和截断后的 stderr/stdout 摘要。
- `assistant_text`：显示正文，使用 terminal 默认前景色。
- `tool_start`：显示 tool 名称和输入摘要。
- `error`：显示短错误摘要。
- `final_result`：显示 done 摘要。
- `unknown`：仅当内容较短时显示。

## ANSI 样式规则

Clean CLI meta 行必须保留 ANSI 样式，由 xterm 原生渲染：

- command start：amber / bold。
- command ok：green / bold。
- command failed：red / bold。
- failed command detail：red。
- tool start：cyan / bold。
- error：red / bold。
- done：green / bold。
- assistant 正文：不强制染色，使用 terminal 默认前景色。

实现时要保证 ANSI 不切断可搜索文本。例如测试和复制中仍应能匹配 `Claude tool Read docs/plan.md`、`Codex command npm.cmd test` 这类连续文本。

## Inspect Terminal 验收规则

- Inspect 里显示真实 xterm DOM。
- 选中 terminal 节点时，节点输出区域显示该节点对应 session 的 terminal。
- 选中 controller / internal / 无 terminal session 节点时，不保留旧 terminal DOM。
- 并行节点输出按 `terminalSessionId` 分桶，不混到当前 Inspect terminal。
- 切走再切回同一节点时，已缓存输出会重放到同一个节点 terminal。
- `reuse_session: true` 时，同一节点再次进入复用 session 上下文。
- `reuse_session: false` 时，每次激活使用新的 session，行为接近改造前。
- terminal input、resize、interrupt 都按当前 Inspect 选中的 `terminalSessionId` 路由。
- xterm loader / mount 失败时允许 fallback，但 fallback 不能掩盖正常 xterm 空白问题。

## 最终验收命令

从 `C:\Users\yulu\Documents\VineGraph\VineGraph` 执行：

```powershell
npm.cmd run typecheck
npm.cmd test
```

当前已验证：

- `npm.cmd run typecheck` 通过。
- `npm.cmd test` 通过，9 pass。
- formatter probe 确认输出包含 ANSI escape，并且纯文本仍连续可匹配。
- Browser / CDP smoke 已验证 Inspect xterm 挂载、切换节点、离开期间输出缓存、回切重放和 fallback 隐藏。

## 回归检查清单

- [x] Codex / Claude visible transcript 使用 Clean CLI 规则。
- [x] `tool_result`、reasoning、session metadata 和成功命令 stdout 不出现在 live terminal。
- [x] failed command 和 agent error 仍可见。
- [x] `RawExecutionResult.stdout` 仍是下游节点使用的最终 agent result。
- [x] `RawExecutionResult.terminalTranscript` 保存 visible Clean CLI transcript。
- [x] `RawExecutionResult.agentRawTranscript` 保存 bounded raw JSONL transcript。
- [x] `RawExecutionResult.agentEvents` 保存结构化 agent event summary。
- [x] shell / git backend 行为不受 agent formatter 影响。
- [x] Inspect terminal 使用真实 xterm，而不是前端模拟日志。
- [x] terminal / node / session 绑定，节点并行时输出不混流。
- [x] terminal meta 行保留 ANSI 样式。
- [x] 普通 assistant 正文不被强制白色染色。

## 后续维护规则

如果后续再次调整 Claude / Codex 输出解析：

1. 先确认 raw JSONL fixture 或真实 terminal log。
2. 只在 `src/agent-terminal-presentation.ts` 内扩展 adapter / presenter 规则。
3. 不要把 provider-specific JSON 解析散落回 `execute-runner.ts`。
4. 不要在 UI 层理解 Claude / Codex event 类型；UI 只消费 terminal session 和 visible terminal chunk。
5. 修改样式时保留 ANSI 输出，让 xterm 负责渲染。
6. 验收必须同时覆盖：JSON 清洗、ANSI 样式、Inspect xterm、session 分桶和 reuse session。
