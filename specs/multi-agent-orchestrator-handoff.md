# Multi-Agent Orchestration Control Plane — Architecture & Implementation Handoff

## 1. 背景与当前基线（CodexRemote 现状）

本仓库 `CodexRemote` 已完成 **Phase 1 + Phase 2 + AGY 运行中排队续发**（均在当前 working tree 中，已通过 `npm run build`、52/52 `npm run test:ui`、`tests/android_package.py` 与 APK 签名验证）：

- **前端聚合工作台**（`apps/workbench/src/chat.ts`、`apps/workbench/public/index.html`、`apps/workbench/public/chat.css`）：
  - 单一 Workspace 混排 Codex 与 Antigravity 会话（紧凑 `Codex` / `AGY` 徽标 + 纯视图筛选器）。
  - 左上角显示远程主机名，输入框模型选择器左侧内联 `#agent-picker`（未发送草稿可无损切换，发送首轮后锁定）。
  - 右侧 `#workbench` 支持 `type: 'workspaceSession'` 标签页，可与主聊天同屏并行展示/操作同项目的任意 Codex 或 Antigravity 会话（双向实时流式、独立模型/权限、就地审批）。
  - 移动端顶部 `#workspace-switcher` 活跃任务快捷切换条，以及合并 Codex + Antigravity 运行/审批状态的「活动」视图。
  - Antigravity 运行中支持前后端双持有的排队续发队列（`c.agyQueue` + `antigravity.mts` 的 `queue` / `cancel-queued` / `interrupt-next`）。
- **接收端服务**（`apps/receiver/src/server.mts`、`apps/receiver/src/transport.mts`、`apps/receiver/src/antigravity.mts`）：
  - 单主机连接 `openRemote()` 同时持有 Codex（`nativeStream` / `nativeCall` / daemon fallback）与 Antigravity（`AgentAcpClient`）。
  - Codex 路由：`/api/turn`、`/api/threads`、`/api/active-threads`、`/api/answer/:id`、`/api/interrupt/:id`、`/api/thread-steer/:id` 等。
  - Antigravity 路由：`/api/antigravity/{submit,status,active,availability,workspaces,workspace,session,sessions,history,options,answer,stop,cancel-queued,interrupt-next}`。
- **既有保护约束（严禁破坏）**：
  - 保留 `android/` 下载进度回调（`window.receiverDownloadChanged`）、`tests/desktop-baseline.test.ts`（不改 `reviewedVersion`）、Chromium 83 WebView 语法兼容，以及现有 Codex 侧边分支聊天（`sideChat`）全部行为。

---

## 2. 本阶段目标：真正的「聚合层多 Agent 调度控制面」

不要做成简单的“人工复制/转发按钮（UI Handoff）”，而是建设**位于聚合层（Receiver Control Plane）的真正调度总线**，解决目前「A Agent 通过 Shell 冷启一次性 B Agent CLI 慢、黑盒、无热上下文」的痛点：

### 核心理念
1. **常驻热会话复用（Warm Session Pool）**：所有被调度的任务直接路由到主机上**已有的常驻 Codex Thread / Antigravity Session**（或在同 Workspace 下创建并持久化为一个可复用的常驻 Session），避免冷启动与重复全仓扫描。
2. **聚合层统一调度总线（Orchestrator Control Plane）**：任何 Agent（AGY → Codex、Codex → AGY、未来 Claude Code / OpenCode）都通过统一调度原语互发任务、观察进度、取回结构化结果，并支持多轮往返协作。
3. **全程可视化 + 人在环内接管**：调度发起后，发起方聊天流出现实时「委派状态卡（Dispatch Card）」，点击即可在右侧 `#workbench` 直接打开并旁观目标常驻 Session 的实时流式输出、就地审批、随时插话接管或中止整条调度链。
4. **后台持续推进**：调度状态机运行在 Receiver（Node 服务，Android 端随前台服务常驻）中，即使平板锁屏或切换页面，目标 Agent 完成本轮后聚合层依然能自动回收结果并推进下一跳回传。

---

## 3. 目标架构与模块划分

### 3.1 共享协议类型：`packages/protocol/orchestration.ts`（新增）
定义跨 Receiver 与 Workbench 的强类型结构与校验：
- `AgentKind = 'codex' | 'antigravity'`
- `SessionRef = { agent: AgentKind; sessionId: string; cwd: string; projectId?: string | null; title?: string }`
- `DispatchStatus = 'awaiting_confirm' | 'queued' | 'running' | 'waiting_approval' | 'returning' | 'done' | 'stopped' | 'failed' | 'rejected'`
- `DispatchPolicy = { mode: 'auto' | 'confirm'; maxHops: number; singleWriterLock: boolean }`
- `DispatchRecord`:
  - `id: string`（UUID）
  - `chainId: string`（整条多跳协作链 ID）
  - `parentDispatchId?: string | null`
  - `hop: number`（从 1 开始，严格 `<= maxHops`）
  - `from: SessionRef`
  - `to: SessionRef`（支持调用前省略 `sessionId`，由聚合层按 `cwd + agent` 自动复用或新建常驻 Worker Session）
  - `objective: string`（精炼目标）
  - `prompt: string`（发给目标 Session 的结构化提示词，上限 16 KB）
  - `autoReturn: boolean`（目标完成后是否自动将结构化回执发回 `from` 会话）
  - `targetJobId?: string | null`（目标 Agent 的真实 turn/job ID）
  - `returnJobId?: string | null`（回传给发起方的真实 turn/job ID）
  - `status: DispatchStatus`
  - `summary?: string`（目标完成后的精炼回执：结论、改动文件、退出码/错误）
  - `approval?: { token: string; title: string; detail: string; agent: AgentKind; jobId: string } | null`
  - `createdAt`, `updatedAt`, `completedAt`

### 3.2 统一运行时适配层 + 调度控制面：`apps/receiver/src/orchestrator.mts`（新增）
在 `apps/receiver/src/server.mts` 中实例化 `createOrchestrator({ codexBridge, antigravity, stateDir, onEvent })`：

1. **统一 `AgentRuntimeAdapter` 抽象**（封装 Codex 与 Antigravity 差异）：
   - `AntigravityAdapter`：直接复用 `createAntigravity(...)` 的 `submit`（支持 `queue: true`）、`status`、`stop`、`answer`、`sessions`、`history`。
   - `CodexAdapter`：复用 `server.mts` 现有的 Codex 提交/状态订阅/中断/审批机制（支持 native App Server 与 daemon 两条链路，抽干净内部提交函数，不走 HTTP 自回环）。
   - 统一能力接口：`startTurn({ cwd, projectId, sessionId, prompt, model, effort, serviceTier, sandbox, approvalPolicy, queue })`、`getTurnStatus(jobId)`、`cancelTurn(jobId)`、`answerApproval(jobId, token, decision)`。
2. **常驻热 Session 绑定（Workspace Worker Binding）**：
   - 持久化 `<stateDir>/orchestrator/state.json`（原子写 `tmp + rename`）。
   - 记录每个 `(normalizedCwd, agent)` 默认绑定的常驻 Worker Session（若该会话已被删除/归档则自动新建），并允许调用方显式指定已有 `target.sessionId`。
3. **同仓写锁（Single-Writer Guard）**：
   - 同一 `normalizedCwd` 下如果已有写调度任务在跑，新调度自动排队进入 `queued`（并在前一个完成后自动触发），避免两个 Agent 并发改同一仓库文件互相踩踏（预留未来 `worktreePath` 字段）。
4. **调度生命周期与自动回传（Return Loop）**：
   - `dispatch` 创建 `DispatchRecord`：
     - 校验 `hop <= policy.maxHops`（超限返回 `409`，严防无限互踢烧额度）。
     - 若 `policy.mode === 'confirm'`（人工确认模式），停在 `awaiting_confirm`，推送 SSE 通知前端；用户点「批准执行」后才下发。
     - 若 `policy.mode === 'auto'`，立即下发给目标常驻 Session（若目标 Session 正忙，自动以排队/续发方式挂入）。
   - 后台监听器持续跟踪 `targetJobId`：
     - 目标触发审批 → 调度状态同步为 `waiting_approval`，并将审批元数据透传给前端（用户在右侧面板或调度卡上可直接点批准/拒绝）。
     - 目标完成（`done`）→ 提取结构化回执（最终回复摘录 + 关键工具/文件变更摘要 + 状态，控制长度在安全阈值内）：
       - 若 `autoReturn === true` 且未超 `maxHops`，**自动将回执投递回 `from` 常驻 Session**（如果 `from` 正在忙则排队），状态进入 `returning` → 回传启动后标记本跳 `done`。
       - 若目标失败或被用户手动中止（`stopped` / `failed`），**绝不静默继续下一跳**，明确停止并通知用户。
   - 重启恢复：Receiver 重启后加载未终结的 `DispatchRecord`，重新挂接在途 `targetJobId` 状态，不丢记录。

### 3.3 面向 Agent 的本地调度触发机制（双通道）
让真正运行中的 Agent 能主动触发聚合层调度，而不是只能由人点按钮：

- **通道 A：Receiver HTTP + SSE 控制面 API**（挂载在 `apps/receiver/src/server.mts` 的 `/api/orchestrator/*`）：
  - `GET /api/orchestrator/events`（SSE：实时推送 `dispatch.updated`、`policy.updated`）
  - `POST /api/orchestrator/list`（返回当前主机的调度列表、绑定关系与策略）
  - `POST /api/orchestrator/dispatch`（发起一次跨 Agent 调度）
  - `POST /api/orchestrator/approve`（批准/拒绝 `awaiting_confirm` 的调度）
  - `POST /api/orchestrator/cancel`（中止调度及目标在途轮次）
  - `POST /api/orchestrator/policy`（读写 `{ mode: 'auto' | 'confirm', maxHops }`）
- **通道 B：Agent 主动调用聚合层（零黑盒协议）**：
  - **方案 1（优先实现，对 Codex & AGY 零额外插件依赖，开箱即用）**：**聚合层结构化指令拦截 + 自动路由**。
    - 约定极简机器可读指令块（例如模型输出末尾的 ` ```orchestrator-dispatch ` JSON 块，含 `{ toAgent, toSessionId?, objective, prompt, autoReturn? }`）。
    - 当任意一个由 Receiver 监控的会话完成本轮并包含合法的 `orchestrator-dispatch` 块时，Orchestrator 自动解析并触发 `dispatch`（受 `policy.mode`、`maxHops`、单写锁保护）！
    - 好处：无需改动 Antigravity 或 Codex 的私有二进制，**同时对 Codex 和 Antigravity 立即生效**，且可在工作台提供一键开关开启/注入系统协作提示。
  - **方案 2（同步预留标准接口）**：提供独立极轻 CLI / stdio-MCP 适配入口（如 `apps/receiver/src/orchestrator-cli.mts`），通过 loopback token 调用 `/api/orchestrator/*`，后续可直接注册为 Codex/AGY 的 MCP tool，实现「轮次中途同步调用另一个常驻热 Session 并取回结果」。

### 3.4 工作台 UI 集成（`apps/workbench/src/chat.ts`、`chat.css`、`index.html`）
保持极度克制、与现有 Phase 1/2 视觉完全统一：
1. **聊天流内「委派状态卡（Dispatch Card）」**：
   - 在发起方会话中显示该会话发出的调度卡片：目标 Agent 徽标（`Codex` / `AGY`）、任务目标、当前状态（`待确认` / `排队中` / `执行中` / `等待审批` / `已回传` / `已完成`）、耗时。
   - 卡片操作按钮：
     - `awaiting_confirm` 时：**「批准执行」/「拒绝」**；
     - 运行中 / 完成后：**「在右侧查看」**（一键在 `#workbench` 打开对应的目标常驻 Session，实时看流式回复和审批！）；
     - 运行中：**「停止」**。
2. **侧栏 / 顶部状态打通**：
   - 存在 `awaiting_confirm` 或 `waiting_approval` 的调度时，在 `#workspace-switcher` 和「活动」视图中置顶高亮提示，点击直达对应会话/分屏。
3. **简洁的调度策略设置 & 快捷发起入口**：
   - 在「设置」里增加「多 Agent 调度」小节：切换 `每跳需我确认`（默认推荐）/ `自动流转`，以及最大自动跳数（默认 `3`）。
   - 在消息操作栏与右侧分屏头保留快捷入口「派给另一助手（复用常驻会话）」，走同一套 `/api/orchestrator/dispatch` API，方便随时手动触发或测试。

---

## 4. 建议的分步实施顺序（供 Codex Session 按阶段推进）

1. **Step 1 — 协议与 Orchestrator 核心引擎 + 单元测试**
   - 新增 `packages/protocol/orchestration.ts` 与 `apps/receiver/src/orchestrator.mts`。
   - 从 `apps/receiver/src/server.mts` 抽离 Codex 内部 turn 启动/订阅/中断/审批桥接，接入 `CodexAdapter` + `AntigravityAdapter`。
   - 实现 `dispatch`、`approve`、`cancel`、`policy`、`list`、`events`（SSE）、`maxHops` 护栏、同仓写锁、`autoReturn` 回传、以及 `orchestrator-dispatch` 结构化块自动触发。
   - 新增 `tests/orchestrator.test.mjs`，完整覆盖：AGY→Codex 调度并自动回传、热 Session 复用、confirm 模式拦截与放行、maxHops 防死循环、单写锁排队、审批透传、中止不继续下一跳、重启恢复。
2. **Step 2 — 工作台 UI 与实时联动 + Playwright 测试**
   - 接入 `/api/orchestrator/events` SSE 与 `/api/orchestrator/*` API。
   - 渲染会话内委派卡片（支持一键在 `#workbench` 右侧打开目标常驻 Session、就地批准/停止）、打通 `#workspace-switcher` 与「活动」视图、在设置页增加调度策略开关、在消息操作栏提供快捷委派入口。
   - 在 `tests/workbench.test.ts` 新增桌面宽屏与手机窄屏的端到端调度交互测试。
3. **Step 3 — 面向 Agent 的本地桥接 CLI/MCP（可选增强，确认 Step 1+2 稳定后立刻做）**
   - 新增 `apps/receiver/src/orchestrator-cli.mts`（或 MCP server），允许运行中的 Agent 主动查询同 Workspace 常驻 Session 并发起同步/异步调度。
4. **Step 4 — 全量验证与 Alpha 签名 APK 打包**
   - 必须通过：`npm run build`、`node --test tests/orchestrator.test.mjs`、`npm run test:ui`、`npm run package:web`。
   - 打包 APK 时沿用 alpha 签名密钥（`CODEX_REMOTE_TEST_KEYSTORE=C:\Users\Chend\Documents\Codex\2026-11-25\new-chat-2\work\android-client\build\local-test.jks`），并运行 `tests/android_package.py` 与 `apksigner verify`。

---

## 5. 关键文件路径速查
- 接收端入口：`apps/receiver/src/server.mts`
- Antigravity 适配：`apps/receiver/src/antigravity.mts`
- Remote 传输：`apps/receiver/src/transport.mts`
- 工作台主逻辑：`apps/workbench/src/chat.ts`
- 工作台模板与样式：`apps/workbench/public/index.html`、`apps/workbench/public/chat.css`
- 共享协议目录：`packages/protocol/`
- 打包清单（新增 receiver 文件必须同步登记！）：`scripts/web-files.json`、`scripts/build.ts`、`apps/receiver/src/server.mts`（`receiverHash` 文件列表）
- Alpha 签名密钥：`C:\Users\Chend\Documents\Codex\2026-11-25\new-chat-2\work\android-client\build\local-test.jks`
- Android 工具链根目录：`C:\Users\Chend\Documents\Codex\2026-11-25\new-chat-2\work\android-runtime-check`
