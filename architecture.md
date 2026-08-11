# stem 实际架构

> 本文档记录**实际开发过程中明确的系统架构**与各模块内部的实现逻辑（`docs/architecture.md` 是最初的目标规划；本文档是落地后的真实形态，若与规划冲突以此为准，并会同步修订）。

**日期**：2026-08-11

---

## 一、总览

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 4  Host / 面板 (shell/ 当前为 CLI，未来 VSCode)                  │
│   面板 = user0：接入总线与邮局，发送消息 / 接收汇总展示                 │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 3  Agent Kernel (core/kernel/)  ← 纯 TS，零平台依赖             │
│   AgentTemplateRegistry · AgentInstanceManager · AgentSpaceManager     │
│   AgentRuntime（被动驱动状态机）· AgentKernel（组合根+系统工具）        │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2  Core Infra (core/context/, core/tools/, core/bus/)           │
│   ContextManager（邮局）· ContextAssembler（经典组装）· MessageBus      │
│   ToolCapabilityRegistry（工具引擎，ToolHooks/onRecord）               │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 1  Model Gateway (core/gateway/)  ← 纯 TS（opencode 隔离）       │
│   ModelGateway · providers/(opencodeLlm / fetch) · FakeGateway         │
└──────────────────────────────────────────────────────────────────────┘
  横切  Telemetry（规划中，未实现）
```

依赖方向（单向）：`shell → kernel → context/tools/bus → gateway`。core 目录零平台依赖（禁止 `import 'vscode'` 与平台全局）。

## 二、通信模型：单工邮局模式（核心架构）

**一句话**：MessageBus 只是"送信员"，真正的信箱是上下文管理器（邮局）；所有上下文成分**异步就绪**投递到邮局，邮局在**送信倒计时**结束后把组装好的**完整上下文**主动"送信"给 agent；agent 全程**被动**。

### 关键概念

- **AgentClass（模板）** 承载设定参数：`id / name / description / system_prompt / model / permission / tools / memoryScope / send_countdown`。
- **AgentInstance** 承载：`id / classRef / creatorId / displayName / spaceId / status / history`。
- **用户面板**：在总线与邮局中与 agent **一视同仁**，id 固定 `user0`；有送信倒计时但**不做上下文组装**，只做 user_prompt 汇总展示。
- **消息 ≠ 上下文**：总线承载通信消息；上下文由邮局按 agent id 组装（本阶段经典组装模式）。

### 上下文成分与就绪来源（全部异步）

| 成分 | 就绪时机 | 来源 |
|---|---|---|
| `system_prompt` | 实例化注册到邮局时 | AgentInstanceManager |
| `user_prompt`（信件） | 用户/agent 投信，倒计时结束时累积完成 | 用户面板 / bus_send / 自动寄信 |
| `assistant_message`（历史） | agent 每轮模型返回后，runtime 自动复制到邮局 | AgentRuntime |
| `tool_call` 记录（历史） | 工具被触发 / 得到反馈时自动记录 | ToolCapabilityRegistry（onRecord） |

### 送信倒计时（邮局维护的局部量）

- 倒计时**初始为 0**：首次来信立即组装送信（无需等待）。
- **仅发送完一次上下文后**才进入倒计时（= 合并下一批来信的滑动窗口），cooldown 期间新来信**重置**倒计时。
- 倒计时结束：上下文可完整组装（有 user_prompt）→ 组装送信；不完整 → **hold** 直到完整。
- 默认 `send_countdown = 1000ms`（模板可配）。

### 单工消息流

```
发送方 ──信件──▶ MessageBus ──▶ 邮局(deposit: 按id累积 + 重置倒计时)
                                      │
                      倒计时结束(或首信) → ContextAssembler 组装完整上下文
                                      │
                  ──bus 送信──▶ 收件方（agent 由 kernel 处理；user 由面板处理）
                                        │
                     完整上下文 → LLM → thinking → 工具轮 → 最终assistant
                                        │
                     runtime: 自动复制assistant→邮局; 最终回复加发送者戳→寄信给创建者
```

## 三、模块职责与内部实现

### 3.1 MessageBus（`core/bus/MessageBus.ts`）

- 参与者注册/注销/查询（`user0` + 所有 agent，实例化时自动注册）。
- `send(msg)`：只负责**转发**到邮局，不保存消息。
- 保留理由：未来可能承载广播/审计等；当前为薄层。

### 3.2 ContextManager 邮局（`core/context/ContextManager.ts`）

按 `agentId` 分箱维护：

```typescript
interface Mailbox {
  readonly systemPrompt?: string       // 实例化时注册
  readonly context: ChatMessage[]      // 历史（assistant 轮 + tool 结果，按来源追加）
  readonly pendingLetters: ChatMessage[]  // user_prompt 信件（送信后清空）
  readonly toolRecords: ToolRecord[]   // 工具调用审计（未来定制组装用）
  readonly sendCountdownMs: number     // 送信倒计时（模板传入）
}
```

行为：

- `register(agentId, { systemPrompt, sendCountdownMs, deliveryHandler })` —— 实例化时注册。
- `deposit(agentId, letter)` —— 投信：追加 pendingLetters；idle/hold 且无计时器 → 立即组装送信；cooldown 中 → 重置倒计时。
- `appendHistory(agentId, message)` —— runtime/工具模块追加历史消息。
- `appendToolRecord(agentId, record)` —— 工具模块自动记录。
- 倒计时结束 → 可组装（pending 非空）→ `assemble` → 清空信件 → 送信 → 重新倒计时；不可组装 → 通知 kernel 进入 hold。
- 用户（`user0`）注册时 `assemble: false`：不做组装，直接把信件汇总为一条消息送信给面板。

### 3.3 ContextAssembler（`core/context/ContextAssembler.ts`）

- 接口 `assemble(input) → { system, messages, tools }`。
- **经典组装模式**（默认实现）：`system = systemPrompt`，`messages = [...context, ...pendingLetters]`，`tools = 按权限物化`。
- 组装器可替换（为未来深度定制上下文预留扩展位）。

### 3.4 AgentRuntime（`core/kernel/AgentRuntime.ts`，被动驱动）

- **不是同步 run**：向 kernel 注册后，由邮局送信回调驱动。
- 收到组装好的上下文 → `status=thinking` → 发 LLM → 工具轮（并行执行）→ 每轮 assistant 消息自动复制到邮局历史 → 最终纯文本回复：
  - 自动加**发送者戳** `<sender id="<agentId>">内容</sender>`；
  - 自动寄信给**创建者**（creatorId）→ 状态 `cooldown`。
- 状态机：`idle →(送信)→ thinking →(最终回复寄出)→ cooldown →(倒计时结束·有信)→ thinking →(无信)→ hold`。
- 状态反映在实例的 `status` 属性（kernel 维护）。

### 3.5 AgentInstanceManager（`core/kernel/AgentInstanceManager.ts`）

- 实例化必填：`classId` + **`userPrompt`** + **`creatorId`**（用户默认 `user0`；agent 创建时可指定 id，默认随机 4 位 hash，**冲突报错**）。
- 实例化流程自动执行：注册总线参与者 → 注册邮局（systemPrompt + sendCountdown + deliveryHandler）→ userPrompt 作为第一封信投递。
- 系统工具 `agent_instantiate` 因此**不 hold 等待**：创建即投递，由邮局驱动子 agent。

### 3.6 ToolCapabilityRegistry（`core/tools/`）

- 注册/查询/materialize（权限物化）/execute（权限+参数校验+ToolHooks）。
- **新增 `onRecord` 回调**（kernel 装配时注入）：工具被触发（onBefore）、成功（onAfter）、失败（onError）时**自动**产生 `ToolRecord`（含调用、参数、结果/错误、agentId、时间）发送给邮局 —— 不依赖 runtime 手动发送，确保可靠。
- 工具结果消息由工具模块自动追加到邮局历史（经典组装的一部分）。

### 3.7 系统工具（`core/kernel/systemTools.ts`，Kernel 注册）

| 工具 | 权限 | 作用 |
|---|---|---|
| `agent_instantiate` | advanced | 创建 agent（必填 userPrompt + creatorId，注册总线+邮局，投递首信） |
| `agent_list` | advanced | 列出实例 |
| `agent_terminate` | advanced | 终止实例（注销总线+邮局） |
| `bus_send` | normal | 经总线发消息（单目标；并行调用实现一对多） |
| `bus_participants` | normal | 查询总线注册 id 列表 |

### 3.8 Gateway（`core/gateway/`）

- 保持既有：`ModelGateway` 接口、`providers/opencodeLlm`（单点）、`FakeGateway`。
- 并行工具调用：协议层 `tool_calls` 数组原生支持；工具轮并行执行，结果按 index 回填。

## 四、messages 经典模式的定制化（第一步）

1. **自动返回**：任何 agent 最终纯文本回复自动寄信给创建者。
2. **发送者戳**：`<sender id="xxx">内容</sender>`（runtime 生成，未来可加时间戳）。
3. **user_prompt 组装**：信件在送信时合并为 user_prompt 进入上下文。

## 五、端到端时序（验收任务）

```
1. 用户(user0) ──msg──▶ bus ──▶ 邮局[创造者]（首信，立即送信）
2. 创造者: thinking → tool_call(agent_instantiate, userPrompt="读取当前时间并告知")
3. 工具: 创建子agent(id+creatorId) → 注册总线/邮局(systemPrompt+倒计时) → 投递userPrompt首信
4. 子agent: 邮局送信 → thinking → tool_call(oc_get_time) → 工具自动记录 → 最终回复时间
5. 子agent: 加戳寄信给创造者 → cooldown → hold
6. 创造者: 收到信件 → 组装 → thinking → 回复用户时间 → 加戳寄信给 user0
7. 用户面板: user0 信箱收信汇总 → 显示
```

## 六、技术选型

- TypeScript + tsx（运行/测试）+ node:test；零运行时依赖（工具 schema 校验自研子集）。
- 邮局存储：本阶段**内存 JSON 消息列表**；后续换 SQLite（`ContextManager` 存储接口已隔离）。
- 倒计时：全局 `setTimeout`（core 内标准 API，非平台依赖）。
- LLM 端点：真实 go/zen（`https://opencode.ai/zen/go/v1/chat/completions`）或 mock SSE 兜底。

## 七、与最初规划（docs/architecture.md）的差异

| 项 | 规划 | 实际 |
|---|---|---|
| 通信 | MessageBus 保存消息、半双工 | 单工邮局模式：bus 只转发，ContextManager 持信箱与组装 |
| AgentRuntime | 同步 while 循环 | 被动驱动：邮局送信触发，状态机 thinking/cooldown/hold |
| Agent 状态 | `idle/running/waiting` | `idle/thinking/cooldown/hold` |
| 实例化 | 无 userPrompt/creatorId | 必填 userPrompt + creatorId，注册总线+邮局 |
| 上下文 | ContextProfile + 渲染器 | 邮局累积成分 + ContextAssembler 经典组装 |
| 工具记录 | 无 | onRecord 自动记录 tool_call 到邮局 |
