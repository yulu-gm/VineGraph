# VineGraph 产品需求文档（PRD）

日期：2026-05-17
状态：正式基线
范围：完整本地产品，按 M1 到 M4 分阶段交付

## 1. 产品定义

VineGraph 是一个本地桌面工作台，用于在真实本地项目目录中开发、运行、观察、调试和迭代 agent graph。

它面向希望 agent 工作流可见、可复现、文件化、可审计的开发者。产品体验必须扎根于正常本地开发工具：仓库、graph asset、终端、diff、运行历史和项目配置。

VineGraph 不是云执行平台、远程 runner 服务、多人协作产品，也不是在线 workflow marketplace。产品边界是单机本地开发者工具。

## 2. 产品目标

1. 让开发者可以打开任意本地项目目录，并直接基于真实文件操作。
2. 将 agent 工作流沉淀为项目内可持久化的 graph asset。
3. 通过终端输出、时间线事件、controller 决策、prompt 和 diff，让 graph 运行过程可观察。
4. 提供足够的 graph authoring 能力，让用户可以演进工作流，而不是每次都手写 YAML。
5. 提供 debugger 能力，支持节点级 rerun、prompt 检查、controller replay 和 run comparison。
6. 提供本地交付辅助能力，包括 patch、history 和可选 git workflow helper。
7. 除非后续产品方向明确改版，否则所有执行、密钥和产物都保持本地化。

## 3. 主要用户

### 本地开发者

在现有 repo 中运行 agent graph，观察执行过程，检查 diff，并用正常本地开发流程决定如何继续。

### Graph 作者

创建和编辑 `.vg.yaml` graph asset，配置 execute/controller 节点，并演进可复用的实现、评审、验证和调试循环。

### 工作流调试者

调查 graph 为什么做出某个路由决策、节点为什么失败、prompt 是否获得了正确上下文，以及不同 rerun 之间有什么差异。

## 4. 核心用户闭环

完整产品需要支持以下闭环：

1. 打开或创建本地项目。
2. 发现、创建或导入 VineGraph graph asset。
3. 在由真实 graph 定义生成的 canvas 上检查 graph。
4. 编辑节点、边、prompt、执行设置和校验规则。
5. 选择明确的 workspace target。
6. 运行 graph。
7. 观察终端输出、时间线、controller 决策、prompt 和 diff。
8. 从节点、prompt、controller 和文件变更层面调试失败或异常运行。
9. rerun 单个节点、从某个节点继续 rerun，或修改 graph 后重新运行。
10. 导出、保留、比较，或可选地提交本次运行结果。

## 5. 产品边界

### 范围内

- 本地项目目录管理。
- Git 与非 git 项目支持。
- 使用 `.vg.yaml` 和 `.vg.yml` 的 VineGraph graph asset。
- YAML graph 持久化和校验。
- 可视化 graph 检查和 authoring。
- Execute 和 controller 节点配置。
- 本地 app 设置，包括 agent CLI 路径、模型、reasoning effort、主题和 probe。
- 显式 workspace target 选择。
- 本地 run 编排。
- Terminal、timeline、prompt、controller decision、diff 和 changed files 可观察性。
- Run history 和本地产物管理。
- 本地 debugger 工作流。
- 可选 git workflow helper。
- 基于本地 server 和 Tauri shell 的桌面交付。

### 产品范围外

- 云端执行。
- 远程 runner。
- 多人协作。
- 团队权限。
- 托管 workflow marketplace。
- 纯浏览器 SaaS 部署。
- 服务端账号系统。
- 通过在线 registry 分享 graph。

## 6. 里程碑

### M1：小闭环工作台

M1 证明 VineGraph 可以在没有完整可视化 graph editor 的情况下，用于真实本地 agent graph 开发。

M1 必须支持：

- 打开本地 git 和非 git 项目。
- 创建并打开 `.vg.yaml` / `.vg.yml` graph asset。
- 从真实 nodes 和 edges 渲染 graph canvas。
- 在 inspector 中编辑关键节点配置。
- 保存经过校验的 graph asset。
- 保存本地 app 配置。
- 从 UI 运行项目 doctor/probe 检查。
- 每次运行前选择明确的 workspace target。
- 在选中的 workspace 中运行 graph。
- 通过 terminal、timeline、controller decisions 和 diff 观察运行。
- Git 项目显示 branch、dirty state 和 changed files。
- 非 git 项目保持可用，并清楚显示能力限制。
- 支持 system、dark 和 light 主题。

M1 不要求：

- 手动编辑 graph layout。
- 在 canvas 上创建节点或边。
- 完整 debugger 工作流。
- Run comparison。
- 通用项目 shell。
- Commit、push 或 pull request helper。
- 云端或协作功能。

### M2：Graph Authoring

M2 将 canvas 从检查界面升级为真正的 authoring 界面。

M2 必须支持：

- 从 UI 添加 execute 和 controller 节点。
- 安全删除节点。
- 创建、编辑和删除边。
- 编辑 port 和 route 语义。
- 拖拽节点。
- 保存 layout metadata。
- 管理 graph template。
- 显示 graph validation panel。
- 编辑过程中保持 graph 有效性。
- 继续以 YAML graph asset 作为事实来源。

### M3：Debugger

M3 将 VineGraph 升级为 graph 调试环境。

M3 必须支持：

- 运行单个节点。
- 从选定节点继续 rerun。
- 捕获并检查节点输入和输出。
- Replay controller decision。
- 对比不同 run 或 graph revision 的 prompt。
- 对比 run timeline、decision、output 和 diff。
- 搜索历史日志和 terminal transcript。
- 解释 readiness 和 routing 行为。
- 让 failed、skipped、cancelled 和 guarded path 可理解。

### M4：Local Delivery

M4 让 VineGraph 在成功或部分成功运行之后，也能帮助用户完成本地交付。

M4 必须支持：

- Run history 管理。
- 标记有用的 run。
- 改进 patch export。
- 清理本地产物。
- 可选 branch 和 commit helper。
- 在本地 git remote 支持时，可选生成 pull request 准备信息。
- 通用本地项目 shell。
- Config backup 和 migration。
- 将密钥从本地 app config 迁移到系统 keychain。
- 桌面打包加固。

## 7. 信息架构

Workbench 使用以下结构：

- 顶部工具栏：产品标识、当前项目、当前 graph asset、保存/dirty 状态、run、stop、doctor、patch/export、settings。
- 左侧 rail：graph flow、run、history、variables/config、settings。
- 左侧面板：repository explorer、graph assets、doctor 状态、workspace targets/worktrees、节点快捷入口。
- 中央区域：由当前 graph asset 生成的 graph canvas。
- 右侧面板：可编辑 inspector，用于 graph、node、ports、route guards、prompts、execution settings 和 run context。
- 底部 runtime dock：timeline、terminal、controller decisions、diff/changed files。
- 底部 workspace bar：当前 workspace target、branch 或非 git 状态、dirty state、run state。
- Settings dialog/drawer：app 级本地配置和 probe 操作。

Graph 切换通过 repo explorer 和 graph asset list 完成，不通过顶部工具栏 dropdown。

## 8. 领域模型

### Project

Project 是任意本地目录。它可以是 git repo，但 git 是能力，不是准入条件。

Project 字段：

- `id`
- `name`
- `rootPath`
- `kind`: `git` 或 `directory`
- `createdAt`
- `lastOpenedAt`
- `graphAssetGlobs`
- `defaultVerificationCommand`
- project-level config overrides

Git project 启用 branch 显示、dirty state、changed files、diff 和 worktree targets。

普通 directory project 启用 graph asset 扫描、graph asset 管理，以及直接针对该目录运行。它不启用 git worktrees、branch state、git diff 或 git changed-file status。

### Graph Asset

Graph asset 是带 VineGraph 专用扩展名的 YAML graph 文件：

- `.vg.yaml`
- `.vg.yml`

专用扩展名是资产边界，用于避免将普通 YAML 文件误识别为可执行 graph asset。旧版 `.yaml` graph 文件可以保持 CLI 兼容，也可以导入为 `.vg.yaml` 或 `.vg.yml`。

Graph asset 操作：

- Scan。
- Search/filter。
- Open。
- Create from template。
- Copy。
- Rename。
- Delete with confirmation。
- Import legacy YAML。
- Validate。
- Save。

### App Configuration

App-level configuration 保存在本机。

必须支持的配置字段：

- Controller API key。
- Codex CLI path。
- Claude CLI path。
- Default Codex model。
- Default Claude model，适用时。
- Default controller model。
- Default reasoning effort。
- Theme mode: `system`, `dark`, `light`。
- Default graph asset scan globs。
- Recent projects。

M1 可以将 secrets 存在本地 app config 中，但 UI 必须清楚说明。后续里程碑必须将 secrets 迁移到系统 keychain。

### Workspace Target

每次运行都必须使用明确的 workspace target。

Git project targets：

- Main working tree。
- Existing worktree。
- New worktree，运行前创建。

Non-git project targets：

- Project directory。

选中的 workspace target 必须在运行前和运行中始终可见。

### Run Record

Run record 捕获：

- Run id。
- Project id 和 root。
- Graph id 和 graph path。
- Workspace path 和 mode。
- Status。
- Start 和 finish time。
- Node activations。
- Terminal transcript 或 stream data。
- Controller decisions。
- Prompt assembly，存在时。
- Diff 和 changed files，存在时。
- Patch path，导出时。
- Errors、cancellation 和 timeout state。

产品工作流运行时，run history 必须保存在选中 project root 下。

## 9. 功能需求

### Project And Workspace

REQ-PROJ-001：用户可以将任意已有本地目录打开为 project。

REQ-PROJ-002：用户可以从 UI 创建新的本地 directory project。

REQ-PROJ-003：VineGraph 检测 git 能力，但不因目录不是 git repo 而拒绝项目。

REQ-PROJ-004：Git project 显示 branch 和 dirty state。

REQ-PROJ-005：Non-git project 显示清晰的 limited-capability state。

REQ-WORK-001：每次运行都必须有明确的 workspace target。

REQ-WORK-002：Git project 可以针对 main working tree 运行。

REQ-WORK-003：Git project 可以针对 existing worktree 运行。

REQ-WORK-004：Git project 可以创建新的 worktree target。

REQ-WORK-005：Non-git project 针对 project directory 运行。

REQ-WORK-006：Run API 必须以选中的 workspace path 作为 `cwd` 执行。

### Graph Assets

REQ-GRAPH-001：Repo explorer 默认扫描 `.vg.yaml` 和 `.vg.yml` graph asset。

REQ-GRAPH-002：普通 `.yaml` 和 `.yml` 文件默认不被当作 graph asset。

REQ-GRAPH-003：用户可以从 template 创建 graph asset。

REQ-GRAPH-004：用户可以从 repo explorer 打开 graph asset。

REQ-GRAPH-005：用户可以安全地 copy、rename 和 delete graph asset。

REQ-GRAPH-006：用户可以将 legacy YAML graph file 导入为 VineGraph graph asset。

REQ-GRAPH-007：Graph asset path 必须位于 project root 内，包含 symlink 场景。

REQ-GRAPH-008：保存 graph asset 前必须校验 graph。

REQ-GRAPH-009：如果保存失败，UI 中未保存的编辑必须保留。

### Canvas And Authoring

REQ-CANVAS-001：Canvas 从真实 graph nodes 和 edges 渲染。

REQ-CANVAS-002：Automatic layout 对 cyclic graph 必须稳定、可读且可终止。

REQ-CANVAS-003：Node 显示 type、backend/model badge、selected state 和 runtime status。

REQ-CANVAS-004：Edge 在 graph 数据允许时显示方向和 route 语义。

REQ-CANVAS-005：执行期间高亮 active/running node。

REQ-AUTHOR-001：Inspector 可以编辑 execute node 的 backend、prompt、command、model、reasoning effort、workspace access 和 timeout。

REQ-AUTHOR-002：Inspector 可以编辑 controller 的 model、prompt、readiness、outputs、output guards 和 limits。

REQ-AUTHOR-003：M2 增加基于 canvas 的节点和边创建能力。

REQ-AUTHOR-004：M2 保存 manual layout metadata。

REQ-AUTHOR-005：M2 提供 graph validation panel。

### Runtime And Observability

REQ-RUN-001：用户可以基于当前 graph asset 和选中的 workspace target 启动 run。

REQ-RUN-002：用户可以停止正在运行的 graph。

REQ-RUN-003：Run events 增量流式推送到 UI。

REQ-RUN-004：Terminal output 支持 ANSI 渲染和 active run terminal 行为。

REQ-RUN-005：Terminal 支持 copy、search、clear view、resize 和 bounded scrollback。

REQ-RUN-006：Timeline 显示 node lifecycle 和 status。

REQ-RUN-007：Controller decisions 显示 selected output、reason、confidence 和 payload。

REQ-RUN-008：Git project 显示选中 workspace 的 diff 和 changed files。

REQ-RUN-009：Non-git project 解释 git diff 不可用的原因。

REQ-RUN-010：Run records 本地持久化。

### Debugger

REQ-DBG-001：用户可以运行单个 node。

REQ-DBG-002：用户可以从选中的 node 继续 rerun。

REQ-DBG-003：用户可以检查捕获到的 node inputs 和 outputs。

REQ-DBG-004：用户可以检查和对比 prompt assembly。

REQ-DBG-005：用户可以 replay controller decisions。

REQ-DBG-006：用户可以 compare runs。

REQ-DBG-007：用户可以搜索历史 logs 和 terminal transcripts。

### Delivery

REQ-DELIV-001：用户可以为 git-backed runs 导出 patches。

REQ-DELIV-002：用户可以浏览和管理 run history。

REQ-DELIV-003：用户可以标记 successful 或 useful runs。

REQ-DELIV-004：用户可以可选地基于选中 run output 创建 branch 和 commit。

REQ-DELIV-005：当本地 git remote 支持时，用户可以可选地准备 pull request 信息。

REQ-DELIV-006：用户可以打开一个和 active graph-node terminal 分离的通用 project shell。

REQ-DELIV-007：用户可以 backup 和 migrate local configuration。

REQ-DELIV-008：Secrets 迁移到系统 keychain 存储。

## 10. 非功能需求

- Local-first：项目文件、graph assets、run records 和 settings 都保留在本地。
- Path safety：API route 不能读写 opened project root 之外的路径。
- Observability：run 不能是黑盒。
- Determinism：graph loading、validation 和 routing 应该能从文件化资产复现。
- Performance：长 terminal output 不能每个 chunk 都触发全量 UI rerender。
- Cross-platform：macOS 和 Windows 的本地开发工作流都必须继续支持。
- Accessibility：主要 panel、dialog、tabs 和 terminal controls 需要键盘与 ARIA 支持。
- Visual consistency：后续 UI 改动必须遵守 `docs/ui-reference.md` 和对应参考截图。

## 11. 按里程碑验收

### M1 验收

- 可以打开 git 和 non-git project。
- 可以扫描、创建、打开、编辑、保存和校验 graph assets。
- 可以渲染真实 graph nodes 和 edges。
- 可以选择明确的 workspace target。
- 可以在选中的 workspace 中运行 graph。
- 可以在可用时观察 terminal、timeline、controller decisions 和 diff。
- 可以保存 app config 和 theme。
- 可以运行 doctor/probe checks。
- Non-git project 保持可用。
- 通过自动化测试，并至少完成一张 dark UI 截图和一张 light UI 截图验证。

### M2 验收

- 可以从 UI 创建、删除、连接和配置 graph nodes。
- 可以编辑 route ports 和 edge semantics。
- 可以拖拽节点并保存 layout metadata。
- 可以使用 graph templates。
- 运行前可以看到 validation errors。

### M3 验收

- 可以运行和 rerun 选中的 graph 片段。
- 可以检查捕获到的 inputs、outputs、prompts 和 decisions。
- 可以 replay 或 compare controller behavior。
- 可以 compare runs 并搜索 history。

### M4 验收

- 可以管理历史 runs 和本地产物。
- 可以导出和准备交付产物。
- 可以安全使用可选 git helpers。
- 可以使用通用 project shell。
- 可以 backup 和 migrate config。
- Secrets 存储在系统 keychain 中。

## 12. 风险与约束

YAML 保存风险：保存 graph asset 可能破坏格式或注释。必须写前校验，保存失败时保留未保存 UI 编辑，后续可考虑 comment-preserving YAML 工具。

Workspace 混淆风险：agent 写入可能落到错误目录。必须持续显示 workspace target，并要求 run request 带有选中 workspace 字段。

Terminal 性能风险：长日志可能压垮 UI。必须使用 xterm 或 chunked append 路径、bounded scrollback 和 scheduled rendering。

Graph authoring 风险：无效可视化编辑可能生成无法运行的 graph。M2 必须在运行前显示 validation。

Debugger 复杂度风险：replay 和 rerun 语义可能偏离真实执行。M3 必须基于持久化 run records 和 graph definitions 实现 debugger 功能。

Secret storage 风险：本地 config 存储 secrets 只适用于早期里程碑。M4 必须将 secrets 迁移到系统 keychain。

Scope drift 风险：cloud、remote execution、collaboration 和 marketplace 保持在产品范围外，除非本 PRD 被明确修订。
