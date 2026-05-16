# VineGraph / AgentGraph

VineGraph 当前实现名为 **AgentGraph**，是一个面向代码任务的单层 Agent Graph Runtime 原型。它用 YAML 描述执行图，把“真正做事”的 Execute 节点和“判断下一步”的 Controller 节点拆开，由 Runtime 负责调度、循环限制、运行记录、工作区隔离和 diff/patch 产物。

这个仓库目前不是完整的通用工作流平台，也不是可视化 Graph Editor。当前重点是先跑通一个可观察、可复现、可收敛的最小运行时。

## 当前能力

- 读取 `examples/*.yaml` 里的单层 graph 配置。
- 支持 `execute` 节点，backend 包括 `shell`、`git`、`internal`、`codex`、`claude`。
- 支持 `controller` 节点，通过 DeepSeek-compatible chat API 选择 output port。
- 支持 edge 调度、回边循环、`maxTotalSteps` 和 `maxFixAttempts` 限制。
- 支持 `local` / `worktree` 两种 workspace 模式。
- 每次运行会写入 `.agentgraph/runs/`，有 diff 时会导出 `.agentgraph/patches/*.patch`。
- 提供一个 Node HTTP server + 原生前端 UI，用于选择 graph、启动运行、查看 timeline、节点日志和 diff。
- 提供 Tauri 桌面壳，用来启动同一个本地服务和 UI。

## 技术栈

- TypeScript + Node.js ESM
- `tsx` 直接运行 TypeScript 入口
- `js-yaml` 解析 graph YAML
- `mustache` 渲染 prompt / command 模板
- Node HTTP server + 静态 HTML/CSS/JS UI
- Tauri 2 桌面壳

## 快速开始

macOS / Linux:

```bash
npm install
npm run example
```

Windows:

```powershell
npm.cmd install
npm.cmd run example
```

`npm.cmd run example` 会执行 `examples/simple-test.yaml`，跑一个最小 shell smoke test。成功后会在 `.agentgraph/runs/` 下生成本次运行记录。

## 常用命令

运行指定 graph：

```bash
npm start -- examples/simple-test.yaml
```

Windows:

```powershell
npm.cmd start -- examples/simple-test.yaml
```

启动 Web UI：

```bash
npm start -- --serve --port 3456
```

Windows:

```powershell
npm.cmd start -- --serve --port 3456
```

然后打开：

```text
http://localhost:3456
```

Windows 一键启动 Web UI：

```powershell
.\start.bat
```

启动 Tauri 桌面版：

macOS:

```bash
./start-tauri.sh
```

Windows:

```powershell
.\start-tauri.bat
```

`start-tauri.sh` / `start-tauri.bat` 会从项目根目录完成启动准备：检查 Node.js / npm / Rust / Cargo，安装依赖，构建 debug 版 Tauri 客户端，启动本地 server，再打开桌面版。Windows 版本还会检查 Microsoft C++ Build Tools，缺失时优先通过 `winget` 安装 Node.js LTS、Visual Studio Build Tools 和 Rustup。首次启动可能会花更久。

类型检查：

```bash
npm run typecheck
```

Windows:

```powershell
npm.cmd run typecheck
```

运行回归测试：

```bash
npm test
```

Windows:

```powershell
npm.cmd test
```

## Graph 配置概览

最小 graph 由 `id`、`version`、`runtime`、`nodes`、`edges` 组成：

```yaml
id: phase1_smoke_test
version: "0.1.0"

runtime:
  workspace:
    mode: local

nodes:
  - id: run_tests
    type: execute
    backend: shell
    command:
      program: node
      args:
        - "-e"
        - "console.log('Running tests...'); console.log('All tests passed!');"

  - id: end_success
    type: execute
    backend: internal
    command:
      program: internal
      args: ["finish_success"]

edges:
  - from: graph.start
    to: run_tests.inputs.trigger

  - from: run_tests.outputs.done
    to: end_success.inputs.trigger
```

Controller 节点只能选择自己声明过的 output。Runtime 会按选中的 output port 继续走对应 edge：

```yaml
- id: after_tests
  type: controller
  model: deepseek-chat
  readiness:
    mode: all_required
  inputs:
    test_result:
      required: true
  outputs:
    fix_from_test_logs:
      description: "Tests failed, route to fix node"
    end_success:
      description: "Tests passed, finish successfully"
  promptTemplate: |
    Choose one output and return JSON only.
```

需要真实调用 Controller 时，设置环境变量：

```powershell
$env:DEEPSEEK_API_KEY="your-api-key"
```

`codex` 和 `claude` backend 会优先读取：

```text
AGENTGRAPH_CODEX_PATH
AGENTGRAPH_CLAUDE_PATH
```

没有设置时，桌面/server 应用首次启动会探测本机 `codex` / `claude`（Windows 上为 `codex.cmd` / `claude.cmd`），跳过 `node_modules/.bin` 里的同名 shadow，并把解析到的真实可执行路径写入当前进程环境。具体调用方式和 macOS / Windows 路径示例见 `.env.example`。

macOS 真实调用链 smoke test：

```bash
npm start -- examples/mac-agent-backend-smoke.yaml
```

这个 graph 会真实调用 AgentGraph 的 `codex` backend、`claude` backend，以及 DeepSeek controller API。它只做只读连通性检查，不会修改文件。

## 目录结构

```text
src/
  index.ts              CLI / server 启动入口
  graph-loader.ts       YAML 解析与基础校验
  scheduler.ts          Graph 调度、循环和运行收尾
  execute-runner.ts     shell / git / internal / codex / claude 执行器
  controller-runner.ts  Controller 模型调用、JSON 决策解析与 guard 校验
  workspace-manager.ts  local / worktree 工作区、diff、patch、清理
  run-history.ts        运行记录持久化
  template.ts           Mustache 模板上下文和渲染
  ui/                   Web UI 静态资源

examples/               可运行 graph 示例
docs/design.md          当前设计案和阶段规划
src-tauri/              Tauri 2 桌面壳
```

## 当前边界

- 当前 UI 是固定流程面板，不是可拖拽编辑的 Graph Editor。
- `human` backend 还没有进入实际 TypeScript 类型和 runner。
- Controller 调用当前固定走 DeepSeek-compatible API 地址。
- 运行输出通过 SSE 推送到 UI；节点 stdout / stderr、完成状态和取消状态会实时进入运行面板。
- `worktree` 模式要求 graph 所在目录能作为 git repo root 使用；示例 graph 目前默认用 `local` 模式。

更完整的设计背景和后续阶段见 [docs/design.md](docs/design.md)。
