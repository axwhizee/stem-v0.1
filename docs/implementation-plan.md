# 实现计划（stem · 场景驱动 · 模板化 · 自我进化）

> 阶段化推进，每阶段以 [`scenarios.md`](scenarios.md) 的对应场景为验收目标。
> 遵循 decisions / architecture / ui-design / code-style。

---

## 阶段 0：环境与骨架

| # | 任务 | 验收 |
|---|---|---|
| 0.1 | 安装 VSCode **Insiders**，确认 `--enable-proposed-api=stem`（或 argv.json） | 扩展能激活 |
| 0.2 | `@vscode/dts` 拉取 d.ts 到 `typings/`：`vscode.d.ts` + `chatSessionsProvider` + `chatParticipantAdditions`，tsconfig include | 类型可用 |
| 0.3 | 脚手架：`package.json`（decisions 铁律 3，扩展 ID `stem`）+ `tsconfig.json` + `esbuild.js` + `src/core/` + `src/adapters/` + `templates/` 骨架 | `npm run build` 通过 |
| 0.4 | 确认 go/zen 可达（`OPENCODE_API_KEY` 或 device-flow 完成） | 能拿到 token |
| 0.5 | **Telemetry 最小骨架**（core）：`events.ts` + `EventBus.ts` + `Recorder.ts`（存储接口）+ `Evaluator.ts`（占位） | 各层可 emit，能持久化 |

---

## 阶段 1：Spike 1 —— 类-实例最小闭环（S1/S2）

> 目标：VSCode 适配壳 + AgentClass 模板 + 单实例循环 + TSX + 真实 go/zen + 工具。
> **不引入多 Agent 与 MessageBus**，但 Kernel 各子系统接口先立。Core 全程零 vscode 依赖。

### Task 1.1：Adapter Shell（`src/adapters/vscode/shell/`）
- `SessionController`：`createChatSessionItemController('stem', refreshHandler)`（第二参函数）+ `newChatSessionItemHandler` + 欢迎会话。
- `SessionProvider`：`provideChatSessionContent(resource, token, { inputState })` → `{ history, requestHandler }`。
- `ToolBridge`：`ChatToolInvocationPart` / `ChatSubagentToolInvocationData` 封装。
- 验收（S1/U1）：Chat 面板看到 agent，能发消息，Dummy 回复。

### Task 1.2：Kernel 骨架（`src/core/kernel/`）
- `AgentTemplateRegistry`：register/get/list/validate + 内置示例模板（`SimpleChat` / `Coder`，从 `templates/*.json` 加载）。
- `AgentInstanceManager`：instantiate / terminate / get / list / updateStatus。
- `AgentSpaceManager`（最小）：按 project 分空间，list agents。
- `AgentRuntime`：单实例 while 循环（组装 ContextProfile → ModelGateway.chat → 工具 → 累加器）。
- `Scheduler`（最小）：`getOrCreateAgent('SimpleChat', spaceId)` 直通，无路由逻辑。
- 验收：`requestHandler → kernel.scheduler → agent.run` 通路打通。

### Task 1.3：ContextProfile + 渲染（`src/core/context/` + adapters）
- core：`ContextProfile` 抽象 + `PromptRenderer` 接口。
- adapters：prompt-tsx 实现（`<SystemMessage>` + `<UserMessage>`，历史用自建 `<HistoryMessages flex>`）。
- 调 `renderPrompt(ContextProfile, props, { modelMaxPromptTokens }, tokenizer)`（**tokenizer 必填**）。
- 无 UI 冒烟脚本：`npm test` 直接 renderPrompt + FakeGateway。
- 验收：messages 结构正确（system+user），tokenCount 合理。

### Task 1.4：ModelGateway + go/zen（`src/core/gateway/`）
- `ModelGateway.ts` 接口 + `Tokenizer.ts`（最小 `ITokenizer`）。
- `providers/fetchOpenAICompat.ts`：裸 fetch 打 `api.opencode.ai/zen/v1/chat/completions`，流式解析 → `LLMEvent`。
- 验收（S2 一部分）：多轮流式对话成功，System Prompt 生效，`ApiRequestRecorded` 落库。

### Task 1.5：工具闭环 + 权限分级雏形
- core：`ToolCapabilityRegistry`（registerTool + 权限校验 normal）。
- adapters：`oc_read_file` / `oc_list_dir`（`vscode.workspace.fs`）/ `oc_run_command` 实现注入。
- `ContextAssetPool`（最小）：`references` 存大输出引用 + `query/write` 接口立好。
- AgentRuntime 工具轮：`stream.push(ChatToolInvocationPart)` + 重推 `enablePartialUpdate`。
- 验收（S2/U5）：UI 出现工具卡片 Pending→Completed，最终输出文本。

**Spike 1 完成标志**：`AdapterShell + AgentClass模板 + 单实例循环 + TSX + go/zen + 工具 + Telemetry` 全链路打通，且 core 目录零 vscode import（lint 通过）。

---

## 阶段 2：多 Agent 集群（S3–S6）

### Task 2.1：AgentSpace 完整化（D12/UI）
- `AgentSpaceManager`：按 project 建空间、`listBySpace` / `getSpace`。
- **UI 对接**（`ui-design.md`）：Controller refreshHandler 按当前 workspace 过滤 → `items.replace(空间 agents)`；切换工作区 → 刷新列表。
- 分组展示：createdBy 分组（我的 / 子 Agent）+ badge + 状态徽标。
- 验收（U1/U2）：切换项目 A/B，列表跟随切换。

### Task 2.2：ContextAssetPool 完整化
- `memories(tag)` 多标签查询 / `write` / `pinnedFacts` / `taskCards` / `references`。
- 存储后端可插拔：`storage/` KV + 文件引用。
- 验收：`query(['#auth-fix','#completed'])` 返回相关记忆。

### Task 2.3：Scheduler 路由升级
- 规则路由（多类：Coder / Reviewer / Tester）。
- **LLM Router 评估**（可选）：一次小模型调用返回 agent 类名（Telemetry 记录路由决策）。
- 系统工具：`agent_instantiate` / `agent_terminate` / `agent_send_message`（advanced 权限）。
- 验收（S3 前提）：`route('写个测试') → Tester`，能创建子实例。

### Task 2.4：MessageBus（Agent IPC）
- `MessageBus`：send / subscribe / readMailbox；消息类型 `agent_message / task_delegation / handoff_request / result / broadcast`。
- 系统工具 `agent_send_message`（normal 权限）。
- `HandoffManager`：构造 ContextPayload、更新标签、UI 呈现移交。
- 子 Agent 执行器：复用 `AgentRuntime` + 独立实例 + 权限继承（深度限制、denies）。
- **用户接管**：`AgentInstanceManager.takeover(agentId, patch)` + UI 命令 `stem.agent.takeover`（`ui-design.md` §四）。
- 验收（S3/S5/S6/U4/U6）：A 完成 → B 接手（UI 子 Agent 卡片 + 列表可见）；结对对话（agent_message 双向）；用户接管生效。

### Task 2.5：无损压缩（Agent 级）
- `Compressor`：`renderPrompt` 后 `countTokens` 复核，超预算 → 旧历史 Summary + Reference ID → 重建 ContextProfile。
- 验收：压缩后上下文利用率上升，`ContextCompressed` 事件记录前后 token 数。

---

## 阶段 3：高级协作（S7–S9）

### Task 3.1：System Tools（元能力完整化）
- `agent_class_create/update/list/remove`（admin）——运行时创建 Agent 类。
- `context_query/write/create_index/summarize`（normal）——上下文资产工具化。
- `telemetry_read` / `module_evaluate` / `module_patch`（admin）——进化工具。
- 验收（S7/S10 前提）：admin Agent 能创建新类、读日志。

### Task 3.2：RAG 后端（S9）
- `ContextAssetPool.createIndex` + 向量索引后端（可插拔，`storage/VectorIndex`）。
- 验收：`context_create_index` 建库后，`context_query({ text })` 语义检索可用。

### Task 3.3：持久化与恢复
- Agent 类 / 实例 / AgentSpace / ContextAssetPool 持久化（KV / 文件 / 可选 DB，经 storage 接口）。
- 任务流恢复：重启后按 resource 恢复 AgentSpace 与实例。
- 验收（S8 前提）：重启后模拟公司架构可继续。

---

## 阶段 4：自我进化（S10/S11）

### Task 4.1：Evaluator（自我进化闭环）
- `Evaluator`：路由准确率 / 上下文利用率 / 压缩有效性 / 工具成功率 / 成本。
- 策略反馈：调整 contextBudget、路由规则、压缩阈值（纯函数 + 配置化）。
- 验收：运行若干任务后输出建议，手动/自动采纳。

### Task 4.2：Evolver Agent（特修斯之船）
- 模板 `Evolver`（admin）：telemetry_read → module_evaluate → 决策（agent_class_create / module_patch）。
- 验收（S10）：Evolver 识别薄弱模块，创建新 Agent 类或调整参数，改善被 Telemetry 验证。

### Task 4.3：用户市场（S11）
- 模板导出/导入（JSON / 文件）、模板派生（复制修改）。
- 验收：用户创建/共享 Agent 类，他人实例化使用。

---

## 阶段 5：体验与发布

| # | 任务 |
|---|---|
| 5.1 | Agent 状态指示（idle/running/waiting 对齐 UI） |
| 5.2 | Diff 预览 / 文件变更 review（`vscode.diff`） |
| 5.3 | 错误处理与重试（对齐 `provider-error` 分类） |
| 5.4 | esbuild 打包优化（tree-shaking effect）、VSIX 打包 |
| 5.5 | 评估 Marketplace 发布的 proposed API 限制与替代 |
| 5.6 | **Core 剥离验证**（D11）：core 作为独立包可被非 VSCode 宿主（CLI 冒烟）加载 |

---

## 依赖关系

```text
0.x
 ├──> 1.1 ─> 1.2 ─> 1.3 ─> 1.4 ─> 1.5    (Spike 1 串行；Kernel 骨架先行)
 └──> 0.5 (Telemetry) 并行支撑 1.x–5.x
2.1(AgentSpace/UI) ─> 2.2 ─> 2.3 ─> 2.4 ─> 2.5   (多 Agent；MessageBus 核心)
3.1 ─> 3.2 / 3.3（并行）                  (元能力 / RAG / 持久化)
4.1 ─> 4.2 ─> 4.3                          (自我进化 / 市场)
5.x 收尾（含 Core 剥离验证 5.6）
```

---

## 风险与预案

| 风险 | 预案 |
|---|---|
| Proposed API 在 Insiders 迭代变动 | 锁 1.132.0 行为；`typings/` 固定版本；升级前 diff d.ts |
| prompt-tsx alpha | 核心原语稳定；隔离在 `core/context`（PromptRenderer 接口），便于替换 |
| effect 体积 / 版本耦合 | 仅 gateway 内部；esbuild 严格 tree-shaking；升级成本高则保留旧版 + 适配层 |
| go/zen 端点服务端控制 | 配置驱动，不硬编码 URL |
| 多 Agent 并行受单会话限制 | 集群并行 = 多 ChatSessionItem（AgentSpace 内多条）；单任务流内串行 Agent |
| 上下文泄漏 / 记忆膨胀 | ContextAssetPool 标签作用域 + Compressor + Evaluator 监控 |
| **Agent 类权限越权** | 权限分级（normal/advanced/admin）+ 实例化用户确认 + 运行时降级不可越权 |
| **MessageBus 消息风暴 / 死循环** | 每消息深度限制 + 消息配额 + Telemetry 监控 + 手动终止入口 |
| **Evolver 改坏模块** | `module_patch` 走配置化注入 + 快照回滚 + Evaluator 回归验证 |
| **core 误依赖 vscode** | lint `no-restricted-imports`（core 范围）+ 5.6 剥离验证 |
| **AgentSpace 列表膨胀** | 项目级隔离 + 按 workspace 过滤 + 可选折叠/归档 |

> 原则：**场景驱动，数据说话**。每个阶段结束都运行 Telemetry 评估——"这个场景真的让任务变好了吗？"没有数据支撑的复杂度一律砍掉。
