# 代码风格与模块化设计参考

> 项目整体模块化、层间解耦、可独立升级、可自我进化。本文件是**代码风格契约**，实现时必须遵守。

---

## 一、模块结构规范

### 1.1 每个模块的组成（接口 + 实现 + 出口）

```text
src/core/context/
├── ContextAssetPool.ts   # interface + 默认实现
├── ContextAssetPool.test.ts  # 单元测试（同目录）
├── types.ts              # 该模块专属类型（若跨模块再抽到公共 types）
└── index.ts              # 唯一出口：导出 interface 与默认实现（barrel）
```

```typescript
// ContextAssetPool.ts —— 接口与实现同文件，接口必须显式导出
export interface ContextAssetPool {
  readonly query: (tags: Tag[], opts?: { text?: string; limit?: number }) => Promise<ContextAsset[]>
  readonly write: (asset: ContextAsset) => Promise<AssetID>
  readonly createIndex: (cfg: IndexConfig) => Promise<void>
  readonly summarize: (agentId: AgentID, refId?: AssetID) => Promise<SummaryRef>
}

// 默认实现
export class DefaultContextAssetPool implements ContextAssetPool {
  constructor(private storage: KVStore) {}   // 依赖注入，不 new 全局单例
  // ...
}
```

### 1.2 入口约定

- 每个目录一个 `index.ts`，**只 re-export**，不写逻辑。
- 跨层引用**只能 import index**（禁止 `import { X } from "core/context/ContextAssetPool"` 内部文件——除非同层同目录）。
- 模块路径别名：`@/adapters/*`、`@/core/*`（kernel/context/gateway/telemetry）。

### 1.3 Core 零平台依赖（D11 硬规则）

- `src/core/` 目录内**禁止 `import 'vscode'`**、禁止任何平台全局（`window`/`process`/`Deno`）。
- core 内所有平台能力以接口暴露：`ModelGateway` / `KVStore` / `VectorIndex` / `FileRef` / `PromptRenderer` / `ToolCapability`（实现由 adapters 注入）。
- lint 规则强制：`no-restricted-imports` 拦截 `vscode`（core 范围）；`import/export` 单向校验。

---

## 二、解耦规范

### 2.1 接口即契约（D5）

- 层间交互对象**必须有显式 interface**（`Scheduler` / `ModelGateway` / `ContextAssetPool` / `ContextProfile` / `AgentTemplateRegistry`）。
- 实现类实现 interface，消费方**只依赖 interface 类型**。
- 接口方法签名稳定；实现可替换（如 provider 切换、宿主切换）。

### 2.2 依赖注入（组合根）

- 模块构造器接收依赖，**不 import 具体实现做单例**。
- 宿主入口（VSCode 的 `extension.ts`）是**组合根**，装配 core + adapters：

```typescript
// adapters/vscode/extension.ts（组合根，VSCode 宿主）
const telemetry = new TelemetryRecorder(kvStore)          // core
const gateway = new FetchOpenAICompatGateway(config)      // core/gateway
const registry = new AgentTemplateRegistry(store)         // core
const memory = new ContextAssetPool(kvStore)              // core
const bus = new MessageBus()
const kernel = new AgentKernel({ registry, memory, bus, gateway, telemetry })
// adapters 注入
const fileTools = createVscodeFileTools()                 // adapters/vscode/tools
const promptRenderer = new VscodePromptTsxRenderer()      // adapters/vscode/context
const shell = new VscodeShell(kernel, fileTools, promptRenderer)  // adapters/vscode/shell
shell.register(context)                                   // 注册 chatSessionsProvider
```

> 组合根是唯一允许同时接触 core 与 adapters 的地方；core 本身不依赖 adapters。

### 2.3 事件驱动（D6）

- 状态变化用 `telemetry.emit(event)`，**消费方不 import telemetry 内部实现**。
- 事件是判别联合（见 architecture §四），单向流：emit → EventBus → Recorder → Evaluator。

### 2.4 禁止项

- ❌ 层间反向依赖（gateway 调 shell）。
- ❌ **core 目录内 `import 'vscode'` 或任何平台全局**（D11，lint 强制）。
- ❌ 模块内 `import` effect（除 gateway 内部）。
- ❌ 全局单例 `globalThis` / `static` 持有跨层状态。
- ❌ 除宿主组合根（`adapters/*/extension.ts`）外的模块内做装配。

---

## 三、类型与命名

### 3.1 类型

- 事件 / DTO 用**判别联合**（`type X = A | B | C`，带 `type` 字段）。
- 多用 `readonly`、`interface`（对象形状）、`type`（联合/别名）。
- **禁止 `any`**；未定类型用 `unknown` + 类型守卫。
- ID 用 branded string（`AgentClassID`、`AgentID`、`WorkspaceID`、`AssetID`、`ToolCallID`）。

### 3.2 Agent 类 / 实例命名

- **AgentClass 模板**：`AgentClass` 类型定义；示例模板放 `templates/*.json`（SimpleChat / Coder / Reviewer / Scheduler / Evolver），**非硬编码**。
- **AgentInstance**：运行时对象，`classRef` 指向模板，`displayName` 用户可命名，`createdBy` 区分用户/调度创建。
- **系统管理工具**：`agent_*` / `context_*` / `module_*` / `telemetry_*` 前缀，与业务工具 `oc_*` 区分。
- 实例状态：`'idle' | 'running' | 'waiting'`（对齐 VSCode UI 展示）。

### 3.3 命名

| 场景 | 规则 | 示例 |
|---|---|---|
| 文件 | PascalCase 组件/类，camelCase 其他 | `AgentRuntime.ts`, `compress.ts` |
| 接口 | 名词，不加 `I` 前缀 | `ModelGateway`, `MessageBus` |
| 实现类 | `Default` 前缀 或 语义名 | `DefaultScheduler`, `FetchOpenAICompatGateway` |
| 事件 | `*Event` / 语义过去式 | `AgentRouteDecided`, `ApiRequestRecorded` |
| 工具 | `oc_` / `agent_` / `context_` / `module_` 前缀 + snake_case | `oc_read_file`, `agent_send_message` |
| 常量 | UPPER_SNAKE | `MAX_CONTEXT_BUDGET` |

---

## 四、控制流与错误处理

### 4.1 错误

- **不 throw 字符串**；定义判别联合错误：

```typescript
type AgentError =
  | { kind: "route_not_found"; input: string }
  | { kind: "model_not_available"; model: string }
  | { kind: "tool_denied"; tool: string }
  | { kind: "context_overflow"; agentId: string }
```

- 模块内捕获 → 归一化为 AgentError → 上层处理 → **同时 `telemetry.emit`**。

### 4.2 异步

- 流式用 `AsyncIterable`（ModelGateway.chat），调用方 `for await`。
- 避免回调地狱；组合用 async/await + 结构化并发（小规模 `Promise.all`）。
- 每个 request 响应 must return `ChatResult`（含 usage/cost）。

### 4.3 控制流

- 优先 early-return / 三元，避免深层嵌套。
- AgentRuntime 的 while 循环必须有**显式退出条件**（max steps / 无 tool_call / token 耗尽）。

---

## 五、可测试性

- 单元测试与源码同目录（`*.test.ts`）。
- **不 mock 全局**；注入 fake：`FakeGateway` / `InMemoryContextAssetPool` / `FakeKVStore`。
- 纯逻辑（路由规则、压缩决策、token 预算、**权限校验**）抽成**纯函数**便于测试。
- 冒烟测试（无 UI）：直接构造 Scheduler + FakeGateway，验证路由/循环/上下文组装/MessageBus 投递。

---

## 六、模块化自检清单（PR / 提交前）

- [ ] 层间只 import `index.ts`？
- [ ] 依赖方向是 adapters → core（kernel → infra → gateway）？
- [ ] 跨层类型走 interface，无具体实现 import？
- [ ] core 目录无 `vscode` / 平台全局 import（D11）？
- [ ] 无 `any`、无全局单例、无反向依赖？
- [ ] 状态变化 / API 请求 / 上下文 / 工具 / 路由 / Agent 消息 是否 emit 了 telemetry？
- [ ] 涉及 opencode 的改动是否只落在 `core/gateway/providers/`？
- [ ] 新增工具是否有权限分级（normal/advanced/admin）校验？
- [ ] Agent 类模板是否走 `AgentTemplateRegistry`，而非硬编码角色？
- [ ] Agent 列表 / AgentSpace 相关改动是否符合 `ui-design.md`？
- [ ] 测试是否存在（新逻辑）？
