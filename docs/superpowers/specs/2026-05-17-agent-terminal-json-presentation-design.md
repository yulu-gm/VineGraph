# Agent Terminal JSON Presentation 设计

日期：2026-05-17

## 目标

重新设计 Codex / Claude backend 在 Terminal 中的 JSON stream 解析与展示方式，让默认 Terminal 接近 Claude CLI / Codex CLI 的日常阅读体验，而不是把内部 JSON event、tool result、reasoning、session metadata 和命令完整结果都直接刷出来。

默认策略采用 **Clean CLI**：

- Terminal 显示用户真正需要读的执行流。
- verbose 信息不直接显示。
- 原始事件和诊断信息不丢失，仍可进入 run record、Inspector 或后续调试视图。

本设计只覆盖 agent backend 的 JSON stream presentation，不改变 shell / git 的真实 PTY 输出语义，也不替代已有 Timeline、Inspector、Controller Decisions、Diff 面板。

## 当前问题

当前 `src/execute-runner.ts` 中 `formatCodexStreamEvent` 和 `formatClaudeStreamEvent` 直接把不同 JSON event 映射成 terminal 字符串。这个实现简单，但有几个问题：

1. 解析、展示策略和 terminal 输出拼装混在一起，后续适配 Codex / Claude 输出格式会继续变复杂。
2. session/init、reasoning、tool_result、成功命令 stdout 等 verbose 内容会进入 live terminal。
3. `tool result` 这类内容对调试有价值，但默认展示会淹没 assistant 正文和真正失败点。
4. 一旦选择隐藏 verbose 内容，如果没有 raw transcript 或 raw event 保存，就会出现“Terminal 干净了但调试证据丢了”的风险。

## 范围

包含：

- 为 Codex JSONL 和 Claude stream-json 增加统一的 agent event 归一层。
- 为归一后的事件增加 Clean CLI presenter。
- 默认隐藏 session、reasoning、tool result、成功命令 stdout 和空 lifecycle event。
- 保留 assistant 正文、命令摘要、失败摘要、错误、取消、超时和最终结果。
- 在 run record 中保留足够的原始 JSONL 或结构化 agent events，支持后续查看和问题追踪。
- 为解析和展示策略增加可运行的本地验证样例。

不包含：

- 新增完整折叠 UI。
- 改造 xterm.js 的渲染能力。
- 改 shell / git backend 的输出策略。
- 重新实现 Tauri portable-pty。
- 做多种用户可配置 verbosity 模式。后续可以在 Clean CLI 基础上扩展 Debug 模式。

## 方案取舍

### 方案 A：统一语义事件解析层

Codex / Claude 的原始 JSONL 先被 adapter 解析成统一的 `AgentTerminalEvent`，再交给 presenter 输出 terminal chunk。

优点：

- agent 输出格式适配和产品展示策略分离。
- 后续能安全支持 Debug Folded 或设置项。
- 可以明确区分“隐藏但保存”和“完全忽略”。

缺点：

- 比直接过滤多一层类型和测试。

### 方案 B：在现有 formatter 中直接过滤

继续使用现有 `formatCodexStreamEvent` / `formatClaudeStreamEvent`，把不想显示的类型返回空字符串。

优点：

- 改动最小。

缺点：

- 解析和展示继续耦合。
- 后续维护成本高。
- 很难保证隐藏内容仍被完整保存。

### 方案 C：前端折叠

后端仍推送所有信息，前端按事件类别折叠。

优点：

- 调试信息可见性强。

缺点：

- 和 Clean CLI 默认目标不一致。
- verbose 内容仍进入 live terminal 数据流，影响可读性和性能。

结论：采用方案 A。

## 架构

新增一个 agent terminal presentation 层，建议放在独立模块中，例如：

- `src/agent-terminal-events.ts`
- 或 `src/agent-terminal-presentation.ts`

该层包含三类职责：

1. Adapter：把 Codex / Claude 原始 JSON event 转成统一事件。
2. Presenter：把统一事件按 Clean CLI 策略转成可显示 chunk。
3. Recorder：把原始事件或归一事件以 bounded 方式保存到 run result。

`execute-runner.ts` 只负责：

- 从 CLI stdout 按 JSONL 切行。
- 调用对应 adapter。
- 调用 Clean CLI presenter。
- 把 presenter 产物发到 `terminal:onOutput`。
- 把 raw stdout / raw JSONL / final message 分别写入正确结果字段。

## 统一事件模型

建议的语义事件类型：

```ts
type AgentTerminalVisibility = "show" | "hide";

interface AgentTerminalEvent {
  backend: "codex" | "claude";
  kind:
    | "session"
    | "assistant_text"
    | "reasoning"
    | "command_start"
    | "command_end"
    | "tool_start"
    | "tool_result"
    | "final_result"
    | "error"
    | "lifecycle"
    | "unknown";
  text?: string;
  title?: string;
  command?: string;
  toolName?: string;
  exitCode?: number;
  durationMs?: number;
  failed?: boolean;
  raw: unknown;
}
```

这不是要求完全照抄的最终代码形状，但实现必须保留这个边界：先归一，再展示。

## Clean CLI 展示规则

默认显示：

- `assistant_text`：原样显示正文，保留必要换行。
- `command_start`：显示一行命令摘要，例如 `Codex command npm.cmd test`。
- `command_end`：显示一行结果摘要，例如 `Codex command ok exit 0 12s`。
- 失败的 `command_end`：显示结果摘要，并附带截断后的 stderr 摘要。
- `error`：显示错误摘要。
- `final_result`：如果不是 assistant 正文重复内容，显示短 done/result 摘要。

默认隐藏：

- `session`
- `reasoning`
- `tool_result`
- 成功命令的完整 stdout
- 空的 `lifecycle`
- 只有 token、id、model、usage、cost 的 metadata
- 无法识别且没有用户可读文本的 `unknown`

特殊规则：

- `tool_start` 默认可显示短摘要，例如 `Claude tool Bash npm.cmd test`；但不显示工具参数大对象。
- `tool_result` 默认隐藏，只保存。
- 如果 tool 或 command 失败，失败摘要必须显示。
- 单条 terminal chunk 必须有长度上限，避免一个 JSON event 把 xterm 刷爆。
- presenter 不应输出裸 JSON，除非事件无法解析且内容本身是用户可读文本。

## Codex Adapter

Codex 当前通过 `codex exec --json --color always` 输出 JSONL。

Adapter 应覆盖这些类别：

- session / started：归为 `session`，默认隐藏。
- reasoning：归为 `reasoning`，默认隐藏。
- assistant/message/agent_message：归为 `assistant_text`。
- exec command begin / command begin：归为 `command_start`。
- exec command end / command end：归为 `command_end`，提取 exit code、duration、stdout、stderr。
- tool / function_call：归为 `tool_start`。
- result / completed / end：归为 `final_result`。
- error / failed：归为 `error`。
- 其他有文本的事件：归为 `unknown`，默认只在文本短且明显可读时显示。

Codex 的最终 `stdout` 仍优先来自 `--output-last-message` 文件，其次来自 JSON event 中的 final assistant message。Terminal 不再把 raw JSON event 当成 stdout。

## Claude Adapter

Claude 当前通过 `claude -p --output-format stream-json --verbose --include-partial-messages` 输出 JSONL。

Adapter 应覆盖这些类别：

- `system` / `init`：归为 `session`，默认隐藏。
- `assistant` content text：归为 `assistant_text`。
- `assistant` content `tool_use`：归为 `tool_start`，只显示工具名和短参数摘要。
- `user` content `tool_result`：归为 `tool_result`，默认隐藏。
- `result`：归为 `final_result`，提取 duration、cost、result text；cost 默认不显示在 Terminal，可进入详情。
- error / failed subtype：归为 `error`。

Claude 的最终 `stdout` 优先来自 `result.result`。Terminal 不显示 tool result 原文。

## 数据保存

Terminal 的可见输出和调试数据必须分开。

建议在 `RawExecutionResult` 增加 bounded 字段：

- `terminalTranscript`：Clean CLI 可见 transcript，用于 Terminal attach snapshot。
- `agentRawTranscript`：原始 JSONL 或原始 stream 文本，截断保存。
- `agentEvents`：可选的归一事件摘要，保存时去掉巨大 payload 或只保留 metadata。

如果担心 run record 体积，至少保留 `agentRawTranscript`，并沿用 `MAX_TERMINAL_TRANSCRIPT_CHARS` 这类上限。不能只保存 Clean CLI transcript，否则隐藏内容将无法追溯。

## UI 行为

当前 live Terminal 继续消费 `terminal:output` chunk，不需要知道每个 JSON event 的内部结构。

Inspector / Detail 后续可以显示：

- visible terminal transcript。
- final stdout。
- stderr / diagnostics。
- raw agent transcript 或 agent events。

本次设计不要求马上新增 UI 折叠控件。Clean CLI 是默认 terminal 表现。

## 错误处理

- JSON parse 失败：如果该行像普通文本，按普通可见文本输出；如果像截断 JSON，进入 pending buffer 等下一行。
- 单行 JSON 太大：保存时截断；Terminal 只显示短摘要。
- Adapter 未识别事件：不输出裸 JSON；记录为 `unknown`。
- CLI stderr：仍作为 diagnostics 保存；只有 agent 失败、超时或 stderr 中存在明确错误时才在 Terminal 显示摘要。
- 超时 / cancelled：Terminal 必须显示短状态行，并保留已收到的 raw transcript。

## 验证策略

当前仓库没有 `tests/` 目录，因此实现时不能引用旧计划里的已删除测试文件作为事实。验证应从当前项目重新建立最小可运行样例。

建议增加轻量单元测试或可执行 probe：

1. Codex JSONL fixture：
   - session 和 reasoning 不显示。
   - assistant message 显示。
   - successful command 只显示摘要，不显示完整 stdout。
   - failed command 显示失败摘要和截断 stderr。
   - tool result 不显示但 raw transcript 保留。

2. Claude stream-json fixture：
   - system init 不显示。
   - assistant text 显示。
   - tool_use 显示短摘要。
   - user tool_result 不显示但 raw transcript 保留。
   - result.result 成为最终 stdout。

3. Execute runner 集成测试：
   - 给 parser 输入分片 JSONL，确认 pending buffer 正常处理。
   - `terminalTranscript` 是 Clean CLI transcript。
   - `agentRawTranscript` 包含原始 JSONL。

4. 手动验证：
   - 运行一个 Codex node。
   - 运行一个 Claude node。
   - Terminal 默认能读到正文、命令摘要和失败点。
   - Inspector 或 run record 中仍能找到 raw agent transcript。

基础命令：

```powershell
npm.cmd run typecheck
```

如果新增测试脚本，应同步更新 `package.json`，避免出现文档提到 `npm test` 但仓库没有 test script 的状态。

## 验收标准

- Codex / Claude Terminal 默认不再显示 session、reasoning、tool result 原文和成功命令完整 stdout。
- Terminal 能显示 assistant 正文、命令摘要、失败摘要、错误、取消和超时。
- 隐藏内容仍能在 run record 或 Inspector 可追溯。
- `stdout` 保持用于 graph 后续节点消费的最终 agent 结果，不再混入 terminal presentation 噪声。
- shell / git backend 的真实 terminal 输出不受影响。
- TypeScript typecheck 通过。
- 至少有一组 fixture 覆盖 Codex 和 Claude JSON stream 的 Clean CLI 规则。
