# M1 完整 Terminal 方案与待办

日期：2026-05-17
范围：M1 小闭环工作台中的完整 Terminal 能力
状态：部分落地，完整 Tauri/portable-pty session manager 待实施

当前落地状态：

- 已实现：节点 activation 与 terminal event 携带 `terminalSessionId`。
- 已实现：UI terminal action 会携带当前 `sessionId`，server 可按 session 精确路由 write、resize、interrupt。
- 已修复：Codex terminal-mode 不再把大 prompt 当作 PTY 键盘输入写入，避免 PTY canonical buffer 溢出导致卡住。
- 待实施：Tauri Rust `PtySessionManager`、`portable-pty`、显式 `attach(sessionId)`、reattach snapshot、transcript 持久化、session 清理策略。

## 1. 目标

M1 的完整 Terminal 不只是把 stdout/stderr 渲染成日志，而是让每个运行中的 agent 或 shell 节点拥有真实 PTY 语义，并让 UI Terminal 通过 `sessionId` 附加到对应 session。

目标体验：

1. 节点启动时创建或复用一个 PTY session。
2. Terminal UI 绑定到一个明确的 `sessionId`。
3. UI 通过 `attach(sessionId)` 订阅该 session 的输出，并将输入、resize、interrupt 发回同一 session。
4. session 生命周期、node activation、run record 三者可追踪。
5. UI 重载、切换 tab、切换选中节点时，可以重新 attach 到仍然存在的 session。
6. terminal transcript 被持久化到 run record，供后续调试和历史查看使用。

## 2. 推荐方案

可以考虑采用：

- Tauri 作为桌面端 native runtime。
- Rust `portable-pty` 管理 PTY。
- 前端使用 `xterm.js` 渲染 terminal。
- Tauri state 保存 `PtySessionManager`。
- UI 通过 Tauri command/event 或轻量本地 IPC 完成 `attach(sessionId)`。

推荐口径：

```text
Terminal 绑定 session。
Node activation 绑定 session。
UI 只 attach session，不直接 attach node。
Node 与 terminal 的关系通过 sessionId 连接。
```

也就是说，`attach(sessionId)` 是 VineGraph 自己的产品协议，不建议直接等同于 xterm.js 的 websocket attach addon。

## 3. 为什么这个方案适合完整 Terminal

优势：

- `portable-pty` 在 Rust 侧提供跨平台 PTY 抽象，和 Tauri 桌面壳天然匹配。
- 避免 Node `node-pty` 在桌面打包时的 native module 构建和分发风险。
- session registry 可以让 terminal 从“当前输出面板”升级为“可恢复、可切换、可审计的会话”。
- UI remount、dock collapse、tab 切换不会丢失 terminal 连接。
- 后续 M3 debugger 和 M4 project shell 可以复用同一个 session 模型。

需要注意：

- 当前项目已有 Node server + scheduler + xterm/node-pty 路径；如果 M1 改成 Tauri/portable-pty，需要设计 Node runtime 与 Tauri Rust PTY manager 的边界。
- 如果仍然要求浏览器访问 `http://localhost:3456` 也具备完整 terminal，则需要保留 Node PTY fallback 或提供本地 IPC/HTTP bridge。
- 多个写节点不能随意共享同一个 interactive session，否则输出和输入会交错；M1 默认应保持一个 activation 一个 session，除非 graph 明确声明复用。

## 4. Session 模型

### PtySession

建议字段：

- `sessionId`
- `projectId`
- `runId`
- `activationId`
- `nodeId`
- `workspacePath`
- `command`
- `args`
- `env`
- `cols`
- `rows`
- `status`: `starting`、`running`、`exited`、`killed`、`failed`
- `createdAt`
- `updatedAt`
- `exitCode`
- `transcriptPath` 或 bounded transcript buffer

### 绑定关系

```text
Run
  -> Activation
    -> TerminalSession(sessionId)
      -> xterm.js Terminal view attach(sessionId)
```

一个 UI terminal view 同一时间只绑定一个 session。  
一个 session 可以被 UI 多次 attach/detach。  
一个 activation 在 M1 默认最多绑定一个 session。

## 5. API / Command 草案

Tauri commands：

- `terminal_create_session(request) -> { sessionId }`
- `terminal_attach_session(sessionId) -> { snapshot, status }`
- `terminal_write(sessionId, data)`
- `terminal_resize(sessionId, cols, rows)`
- `terminal_interrupt(sessionId)`
- `terminal_detach(sessionId, viewId)`
- `terminal_close(sessionId)`
- `terminal_list(runId?) -> SessionSummary[]`

Tauri events：

- `terminal://session-started`
- `terminal://output`
- `terminal://resized`
- `terminal://status`
- `terminal://ended`

Node/run events 中也要携带：

- `sessionId`
- `activationId`
- `nodeId`
- `runId`

## 6. M1 必须完成的 Terminal 待办

| ID | 优先级 | 任务 | 验收标准 |
| --- | --- | --- | --- |
| VG-M1-TERM-001 | P0 | 定义 terminal session 数据模型 | `sessionId`、run、activation、node、workspace、status、size、transcript 字段明确，并写入类型定义。 |
| VG-M1-TERM-002 | P0 | 实现 Tauri `PtySessionManager` | Rust state 中可创建、保存、查询、关闭 session。 |
| VG-M1-TERM-003 | P0 | 接入 `portable-pty` | 能在 macOS/Windows 创建 PTY、启动命令、读取输出、写入输入、resize 和 kill。 |
| VG-M1-TERM-004 | P0 | 实现 `attach(sessionId)` | UI attach 后能收到历史 snapshot 和后续增量输出。 |
| VG-M1-TERM-005 | P0 | xterm.js 绑定 session | Terminal view 的输入、resize、interrupt 都发到当前绑定 session。 |
| VG-M1-TERM-006 | P0 | 节点 activation 绑定 session | 每个需要 terminal 的 execute node 启动时生成并记录 `terminalSessionId`。 |
| VG-M1-TERM-007 | P0 | Run event 携带 session 信息 | `terminal:started/output/ended` 或等价事件包含 `sessionId`，UI 不再猜测 active session。 |
| VG-M1-TERM-008 | P0 | Transcript 持久化 | Run record 能追踪 session transcript，并支持后续查看。 |
| VG-M1-TERM-009 | P0 | Stop/interrupt 语义统一 | 停止 run 时能 interrupt/kill active session，并最终写入 cancelled/failed 状态。 |
| VG-M1-TERM-010 | P1 | UI session 切换 | 用户选择节点或 terminal session 时，UI detach 当前 session 并 attach 新 session。 |
| VG-M1-TERM-011 | P1 | Reattach 恢复 | UI reload 或 dock remount 后，可以 attach 到仍在运行的 session。 |
| VG-M1-TERM-012 | P1 | Doctor 检查 terminal capability | Doctor 显示 Tauri portable-pty 是否可用；不可用时说明 fallback。 |
| VG-M1-TERM-013 | P1 | Browser/dev fallback | 非 Tauri 环境下保留现有 Node PTY 或 stream fallback。 |
| VG-M1-TERM-014 | P1 | 并发保护 | 防止多个 write activation 误共享同一 session；并发 read-only session 可区分显示。 |
| VG-M1-TERM-015 | P2 | Session 清理策略 | 运行结束、窗口关闭、app 退出时清理 PTY，避免孤儿进程。 |

## 7. M1 验收标准

完整 Terminal 在 M1 验收时必须满足：

- 一个运行中的 terminal view 明确绑定到一个 `sessionId`。
- 节点启动时能创建或绑定 PTY session。
- xterm.js 显示真实 PTY 输出，包括 ANSI、动态刷新和交互式输入。
- 输入、resize、Ctrl+C/interrupt 都作用于当前绑定 session。
- UI 切换节点或重载后可以重新 attach session。
- Run record 能关联 node activation 与 terminal session。
- 运行停止后 session 被正确结束或标记。
- `npm test`、`npm run typecheck` 通过。
- 至少完成一次真实桌面端 Terminal 手动验收。

## 8. 建议实施顺序

1. 先补 session 数据模型和事件协议。
2. 再实现 Tauri/Rust `PtySessionManager` 最小闭环：create、output、write、resize、kill。
3. 前端 xterm.js 改成 session-bound view。
4. Scheduler / execute runner 写入 `terminalSessionId`。
5. 做 reattach、transcript、cleanup。
6. 最后保留或整理 Node/browser fallback。

## 9. 决策点

需要在实施前确认：

1. M1 是否要求完整 terminal 只支持 Tauri 桌面端，还是也要求浏览器 UI 支持。
2. Node scheduler 是否继续作为执行主控，还是逐步把 terminal execution 下沉给 Tauri Rust。
3. Graph 节点是否允许显式声明复用某个 session，还是 M1 固定一个 activation 一个 session。
4. 历史 run 是否只保存 transcript，还是也要支持完整 interactive replay。

建议 M1 决策：

- 桌面端采用 Tauri + xterm.js + portable-pty。
- 浏览器 UI 保留现有 Node PTY/stream fallback。
- M1 默认一个 activation 一个 session。
- 历史 run 保存 transcript，不做完整 interactive replay。
