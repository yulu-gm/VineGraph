# 项目自迭代最小入口

`examples/project-task-loop.yaml` 是 VineGraph 当前用于项目自迭代的最小真实入口。它默认使用 git worktree 隔离改动，让实现节点写入文件，让两个 review 节点保持 Codex read-only 并行检查。

## 前置条件

- 当前目录是一个 git repo。
- 已执行 `npm.cmd install`。
- `codex.cmd --version` 可以正常输出版本。
- 已设置 `DEEPSEEK_API_KEY`，用于 controller 节点决策。

## 启动前预检

```powershell
npm.cmd start -- --doctor examples/project-task-loop.yaml
```

> 这个命令是目标预检入口，Task 8 会实现。

## 启动 UI

```powershell
npm.cmd start -- --serve --port 3456
```

打开 UI 后：

1. 选择 `project-task-loop.yaml`。
2. 填写任务范围 `task_scope`。
3. 填写验证命令 `verification_command`，例如 `npm.cmd test && npm.cmd run typecheck`。
4. 点击运行，观察 Terminal 输出和 Inspector 中的节点 prompt。

## 验收标准

- 运行时使用 worktree 路径承载本轮改动，而不是直接写主工作区。
- `review_code_quality` 和 `review_functionality` 在实现节点完成后并行运行。
- Terminal 能看到实现、review、controller、后续评估节点的输出。
- Inspector 能查看每个 Codex 节点实际发送的 prompt。
- 导出的 patch 包含新建文件。

## 当前边界

- 不并行运行多个 write agent；同一时间只有实现或修复节点写入 workspace。
- controller 节点需要有效的 `DEEPSEEK_API_KEY`。
- 当前 UI 是运行与检查界面，不是 Graph Editor。
