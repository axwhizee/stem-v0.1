# 整体设计架构（stem · Agent Kernel · 用户主权 · Core 解耦 · 自我进化）

> stem = **S**elf-Training **E**volutionary **M**atrix。干细胞之意——如同原始 Agent 类，可分化出任意角色。
> 目标形态：**抛弃会话概念**。以"原子化 Agent 类 + Agent 实例"为唯一核心，配合模块化 harness 系统。
> 用户拥有 Agent 类与实例的**全部创建/管理权限**；系统向 Agent 暴露管理工具；所有日志引出给 AI，实现自我进化。
> 场景目标见 [`scenarios.md`](scenarios.md)。UI 设计见 [`ui-design.md`](ui-design.md)。

---

## 〇、第一原则：Core 完全解耦

> **core（Layer 1–3）零 VSCode 依赖**。所有 VSCode API 调用只存在于 `adapters/vscode/`。

- core 是**纯 TypeScript 领域逻辑**，只依赖自身与通用库（prompt-tsx 属通用渲染，经接口隔离）。
- 所有平台能力（文件系统、终端、存储、UI）以 **接口** 暴露，由 `adapters/` 注入实现。
- 这为**从 VSCode 剥离出独立项目**做准备：将来换一个宿主（CLI / Web / 其他编辑器），只换 `adapters/`，core 原样带走。

### 解耦边界

| 能力 | 接口（core 定义） | VSCode 实现（adapters 注入） |
|---|---|---|
| LLM 访问 | `ModelGateway` | `providers/fetchOpenAICompat.ts`、`opencodeLlm.ts` |
| 文件系统工具 | `ToolCapability`（声明） | `oc_read_file`（用 `vscode.workspace.fs`） |
| 终端工具 | `ToolCapability` | `oc_run_command`（child_process） |
| 存储 | `KVStore` / `VectorIndex` | VSCode workspaceState / 文件 |
| 提示渲染 | `PromptRenderer` | prompt-tsx 实现（ContextProfile） |
| UI 壳 | `ShellPort`（事件路由） | `SessionController/SessionProvider/ToolBridge` |

---

## 一、核心概念模型

```
AgentClass      —— 模板（可复用的"类"：prompt / contextProfile / tools / 权限 / memoryScope）
AgentInstance   —— 由用户或 Agent 从 AgentClass 实例化（运行时原子单位，独立状态）
AgentSpace      —— 按项目/工作区划分的 agent 列表 + 共享上下文（对应 UI 的一个 agent 列表）
AgentKernel     —— 系统核心（模板注册表 / 实例管理 / 调度 / IPC / 上下文资产 / 工具注册）
MessageBus      —— Agent 间通信总线（对话 / 委托 / handoff / 广播）
ContextAssetPool —— 上下文资产池（记忆 / 引用 / 知识库），对外暴露为工具
ToolCapabilityRegistry —— 统一工具注册（业务工具 + 系统管理工具）
Telemetry       —— 横切日志 / 评估（自我进化数据源）
```

### 1.1 AgentClass（模板，用户主权的载体）

```typescript
interface AgentClass {
  readonly id: string
  readonly name: string                    // "Coder" / "Reviewer" / "Scheduler"
  readonly description: string             // 用户可读
  readonly systemPrompt: string            // 该类的专属提示词
  readonly contextProfile: ContextProfile  // 上下文组装策略（可继承/定制）
  readonly tools: ToolRef[]                // 该类实例可用的工具
  readonly permission: PermissionLevel     // 'normal' | 'advanced' | 'admin'
  readonly memoryScope: Tag[]              // 可访问的上下文资产标签
  readonly model?: ModelRef                // 可选模型偏好
  readonly custom?: Record<string, unknown> // 用户自定义元数据
}

type PermissionLevel =
  | 'normal'   // 仅业务工具 + 对话工具
  | 'advanced' // + 实例创建 / 上下文分配 / handoff（调度器）
  | 'admin'    // + 类创建 / 模块改造 / 全量日志（进化者）
```

- **用户主权**：用户自由 `create_agent_class` / `update` / `delete` / `instantiate`。系统**绝不内置固定角色**，只提供示例模板（SimpleChat / Coder / Reviewer / Scheduler / Evolver）。
- **Agent 也能创建类**：admin 权限 Agent 可经 `agent_class_create` 运行时造新类。

### 1.2 AgentInstance（运行时原子单位）

```typescript
interface AgentInstance {
  readonly id: string
  readonly classRef: AgentClassID
  readonly displayName: string            // 用户可命名
  readonly createdBy: 'user' | AgentID    // 区分用户创建 vs 调度创建
  readonly context: ContextHandle         // 该实例的私有上下文区
  readonly mailbox: Mailbox               // MessageBus 消息队列
  readonly spaceId: AgentSpaceID          // 所属 Agent 空间
  status: 'idle' | 'running' | 'waiting'
  turnCount: number
  totalCost: number
}
```

- **用户创建与调度创建的 Agent 本质相同**，都是 `AgentInstance`；`createdBy` 仅作展示区分。
- **用户可接管**任何实例（包括调度创建的）：改 prompt / 工具 / 状态，直接对话微调。

### 1.3 AgentSpace（项目级 agent 空间）

```typescript
interface AgentSpace {
  readonly id: AgentSpaceID
  readonly project: WorkspaceRef          // 关联的项目/工作区
  readonly agents: AgentInstance[]        // 该空间内的 agent 实例列表
  readonly sharedAssets: ContextAssetPool // 空间级共享上下文
}
```

- **一个项目/工作区 = 一个 AgentSpace**。切换项目 → 切换到对应空间的 agent 列表（避免列表过大）。
- AgentSpace 是 UI"一个 agent（session）列表"的载体（见 `ui-design.md`）。

### 1.4 为什么"抛弃会话"

- 旧心智：会话 = 一串对话历史。
- 新心智：**AgentInstance = 一个能对话、能干活、能被其他 Agent 对话的实体**。
- UI 的"一个对话条目" = 面向用户的**一个 Agent 实例**（复用 session 模式做展示，但语义是 Agent）。

---

## 二、四层架构 + 适配层

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 4  Host Adapters    (adapters/)   ← 唯一接触平台 API 的地方      │
│   vscode/: shell(SessionController/SessionProvider/ToolBridge)          │
│            tools(oc_* 用 vscode API) · context(prompt-tsx/存储)          │
│            gateway(providers 实现)                                       │
│   (未来) cli/ web/ other-editor/                                        │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 3  Agent Kernel     (core/kernel/)  ← 纯 TS，零平台依赖           │
│   AgentTemplateRegistry · AgentInstanceManager · Scheduler · MessageBus │
│   ContextAssetPool · ToolCapabilityRegistry · AgentRuntime              │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 2  Core Infra       (core/context/, core/tools/)  ← 纯 TS         │
│   ContextProfile 抽象 · Compressor · 存储接口(KV/Vector/File) · 工具引擎 │
├────────────────────────────────────────────────────────────────────────┤
│ Layer 1  Model Gateway    (core/gateway/)  ← 纯 TS（opencode 隔离）     │
│   ModelGateway 接口 · Tokenizer · providers/*（fetch / opencodeLlm）    │
└────────────────────────────────────────────────────────────────────────┘

  横切层  Telemetry / EventBus  (core/telemetry/)  ← 纯 TS
```

### 依赖方向（单向，禁止反向）

```
adapters → core(kernel → core-infra → gateway)
  └──────────────── telemetry（横切，各层只 emit）
```

**重构原则**：
- 系统管理工具操作 Kernel 状态 → 由 **Kernel** 提供。
- 业务工具（`oc_*`）声明在 core，**实现注入**自 adapters（VSCode 提供文件系统/终端实现）。
- `ToolCapabilityRegistry` 在 Kernel 统一注册两者（依赖注入，不反向 import）。
- `ContextProfile` 抽象在 core；prompt-tsx 具体实现由 adapters 提供（core 定义 `PromptRenderer` 接口）。

---

## 三、Agent Kernel 各子系统

### 3.1 AgentTemplateRegistry

```typescript
interface AgentTemplateRegistry {
  register(cls: AgentClass): Promise<void>
  update(id: AgentClassID, patch: Partial<AgentClass>): Promise<void>
  remove(id: AgentClassID): Promise<void>
  get(id: AgentClassID): Promise<AgentClass>
  list(filter?: { spaceId? }): Promise<AgentClass[]>
  validate(cls: AgentClass): Promise<void>
}
```

### 3.2 AgentInstanceManager

```typescript
interface AgentInstanceManager {
  instantiate(classId: AgentClassID, opts: { spaceId, displayName?, createdBy?, contextInit? }): Promise<AgentInstance>
  terminate(agentId: AgentID): Promise<void>
  get(agentId: AgentID): Promise<AgentInstance>
  listBySpace(spaceId: AgentSpaceID): Promise<AgentInstance[]>
  updateStatus(agentId: AgentID, status: AgentStatus): Promise<void>
  takeover(agentId: AgentID, patch: Partial<AgentInstancePatch>): Promise<void>  // 用户接管/微调
}
```

### 3.3 Scheduler / Orchestrator

```typescript
interface Scheduler {
  route(input: string, spaceId: AgentSpaceID): Promise<AgentID>
  delegate(task: TaskSpec, to: AgentID): Promise<void>
  handoff(from: AgentID, to: AgentID, payload: ContextPayload): Promise<void>
  summarize(agentId: AgentID): Promise<void>
}
```

### 3.4 MessageBus（Agent IPC）

```typescript
type AgentMessage =
  | { kind: 'user_prompt';     to: AgentID; payload: string }
  | { kind: 'agent_message';   from: AgentID; to: AgentID; payload: MessageContent }  // Agent 间对话
  | { kind: 'task_delegation'; from: AgentID; to: AgentID; task: TaskSpec }
  | { kind: 'handoff_request'; from: AgentID; to: AgentID; payload: ContextPayload }
  | { kind: 'result';          from: AgentID; to: AgentID; result: ResultPayload }
  | { kind: 'broadcast';       from: AgentID; to: AgentID[]; payload: MessageContent }

interface MessageBus {
  send(msg: AgentMessage): Promise<void>
  subscribe(agentId: AgentID, handler: (msg: AgentMessage) => void): Disposable
  readMailbox(agentId: AgentID): Promise<AgentMessage[]>
}
```

### 3.5 ContextAssetPool

```typescript
interface ContextAssetPool {
  query(tags: Tag[], opts?: { text?: string; limit?: number }): Promise<ContextAsset[]>
  write(asset: ContextAsset): Promise<AssetID>
  createIndex(cfg: IndexConfig): Promise<void>
  summarize(agentId: AgentID, refId?: AssetID): Promise<SummaryRef>
}
```

工具化暴露：`context_query` / `context_write` / `context_create_index` / `context_summarize`。

### 3.6 ToolCapabilityRegistry

```typescript
interface ToolCapabilityRegistry {
  registerTool(tool: ToolCapability): Promise<void>           // 声明（core）
  registerSystemTool(tool: SystemCapability): Promise<void>   // Kernel 提供
  materialize(permissions: PermissionLevel, scope: AgentContext): ToolRef[]
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>
}
```

**业务工具（声明在 core，实现注入）**：`oc_read_file` / `oc_list_dir` / `oc_run_command` / `oc_edit` / `oc_write` / `oc_search`。

**系统管理工具（Kernel 提供，按权限分级）**：

| 工具 | 权限 | 作用 |
|---|---|---|
| `agent_class_create / update / list / remove` | admin | 运行时创建/修改 Agent 类 |
| `agent_instantiate / terminate / list / takeover` | advanced | 实例管理（调度器/用户接管） |
| `agent_send_message` | normal | Agent 间对话 |
| `context_query / write / create_index / summarize` | normal | 上下文资产工具化 |
| `telemetry_read` | admin | 读取全量日志 |
| `module_evaluate` | admin | 评估模块有效性 |
| `module_patch` | admin | 调整模块参数/行为 |

---

## 四、横切层：Telemetry（自我进化数据源）

### 4.1 事件类型（core 定义，纯数据）

```typescript
type TelemetryEvent =
  | AgentClassRegistered   { classId, by: 'user' | AgentID, at }
  | AgentInstanceCreated   { agentId, classId, spaceId, by }
  | AgentStatusChanged     { agentId, from, to, at }
  | AgentRouteDecided      { input, routedTo, rationale }
  | AgentMessageSent       { kind, from, to, payloadSize }
  | AgentTakeover          { agentId, by, patch }
  | ApiRequestRecorded     { agentId, model, provider, promptTokens, completionTokens, latencyMs, cost, cacheHit }
  | ContextAssembled       { agentId, messages, tokenBudget, usedTokens, truncated }
  | ContextCompressed      { agentId, oldTokens, newTokens, summaryRef }
  | ToolInvoked            { agentId, tool, args, resultRef, durationMs, success }
  | HandoffPerformed       { from, to, payloadSize }
  | ModulePatched          { module, patch, by, rationale }
```

### 4.2 自我进化闭环

```
事件流 → 持久化（KV / 文件 / 可选 DB）
      → Evaluator（路由准确率 / 上下文利用率 / 压缩有效性 / 工具成功率 / 成本）
      → 策略反馈（调整 contextBudget / 路由规则 / 压缩阈值 / 记忆保留）
      → 高级：Evolver Agent（admin）telemetry_read → module_evaluate → module_patch / agent_class_create
```

---

## 五、数据流

### 5.1 用户直接对话（S1）

```text
Chat UI(某 agent item) → SessionProvider.requestHandler
  → kernel.agents.get(agentId) → agent.run(request)
      ├─ allocateContext：ContextAssetPool.query(agent.memoryScope)
      ├─ renderPrompt(ContextProfile) → ModelGateway.chat
      └─ 纯文本 → stream.markdown
```

### 5.2 复杂任务（S3 / S8，Agent 间协作）

```text
用户 → Scheduler 实例（advanced）
Scheduler.route(input) 拆解
  → agent_instantiate('Coder', {spaceId}) → MessageBus.task_delegation
  → Coder 执行（检索 #spec → 工具 → 写 #result）
  → result → Scheduler.handoff('Reviewer')
  → Reviewer 审查 → Scheduler.summarize → 用户
用户可在列表中实时看到每个 agent 的状态与输出，并可接管任意一个
```

### 5.3 GAN 对抗（S7）

```text
用户 → Judge（admin）
Judge → agent_instantiate('Explorer-A/B/C') → 各发探索任务
Explorer 各写 #explore-<viewpoint>
Judge context_query(['#explore-*']) → 综合判断 → 决策/融合（可迭代对抗收敛）
```

---

## 六、模块解耦与独立升级原则

1. **接口即契约**：层间只依赖 interface。
2. **依赖注入**：组合根 `extension.ts`（VSCode 宿主）装配 core + adapters；core 无全局单例。
3. **单向依赖**：adapters → core；telemetry 只收事件。
4. **Core 零平台依赖**：core 目录内禁止 `import 'vscode'`（用 lint 规则强制）。
5. **opencode 隔离**：`gateway/providers/opencodeLlm.ts` 单点。
6. **effect 隔离**：只在 gateway 内部，对外纯 TS。
7. **用户主权**：所有 Agent 类/实例创建权限归用户；系统只给示例模板与工具能力。
8. **可独立发布**：core 可作为独立 npm 包（`@stem/core`），供任意宿主复用。

---

## 七、与 opencode 的边界

| 能力 | 归属 |
|---|---|
| Agent 类/实例 / Scheduler / MessageBus / 上下文资产 / 工具注册 / 进化 | **stem core 自研** |
| Provider 认证（go/zen device-flow + OPENCODE_API_KEY） | core/gateway/providers（opencode） |
| LLM 协议 / SSE / 重试 / prompt cache | vendored `@opencode-ai/llm`（opencode） |
| 系统提示模板 | 参考 opencode（不硬编码） |
| Token 估算 / 溢出分类 | 参考 opencode `util/token` / `provider-error` |
| MCP | VSCode 原生 MCP（adapter 层） |
| ACP | 对照基准（未来 sidecar 通道） |
| 文件系统 / 终端 / UI | VSCode API（adapter 层） |

---

## 八、目录结构（目标）

```text
stem/
├── package.json / tsconfig.json / esbuild.js
├── typings/                        # @vscode/dts 拉取的 proposed d.ts
├── templates/                      # 示例 Agent 类（JSON，用户可复制/编辑）
│   ├── simple-chat.json · coder.json · reviewer.json · scheduler.json · evolver.json
├── src/
│   ├── extension.ts                # 组合根（VSCode 宿主）：装配 core + adapters
│   ├── core/                       # 纯 TS 领域逻辑（零 vscode 依赖）
│   │   ├── kernel/
│   │   │   ├── AgentTemplateRegistry.ts
│   │   │   ├── AgentInstanceManager.ts
│   │   │   ├── AgentSpaceManager.ts
│   │   │   ├── Scheduler.ts
│   │   │   ├── MessageBus.ts
│   │   │   ├── ContextAssetPool.ts
│   │   │   ├── ToolCapabilityRegistry.ts
│   │   │   ├── system-tools/       # agent_* / context_* / telemetry_* / module_*
│   │   │   └── AgentRuntime.ts
│   │   ├── context/
│   │   │   ├── ContextProfile.ts    # 抽象（PromptRenderer 接口）
│   │   │   ├── Compressor.ts
│   │   │   └── storage/             # KVStore / VectorIndex / FileRef 接口
│   │   ├── gateway/
│   │   │   ├── ModelGateway.ts
│   │   │   ├── Tokenizer.ts
│   │   │   └── providers/           # fetchOpenAICompat / opencodeLlm
│   │   └── telemetry/
│   │       ├── EventBus.ts · events.ts · Recorder.ts · Evaluator.ts
│   ├── adapters/                   # 平台适配（VSCode，未来可加 cli/web）
│   │   ├── vscode/
│   │   │   ├── shell/              # SessionController · SessionProvider · ToolBridge
│   │   │   ├── tools/              # oc_read_file · oc_list_dir · oc_run_command ...（vscode 实现）
│   │   │   ├── context/            # prompt-tsx ContextProfile 实现 · 存储实现
│   │   │   └── gateway/            # providers 装配
│   └── util/
├── vendor/                         # (后续) @opencode-ai/llm + @opencode-ai/schema
└── docs/
```
