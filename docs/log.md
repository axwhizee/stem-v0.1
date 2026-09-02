# 开发日志

> 记录当前开发阶段的实际进展与关键发现。README 与 docs 描述的是目标设计，本文件记录的是已完成与已验证的部分。

## 阶段：独立原型验证 —— opencode provider 模块剥离 + 小型 chat 模块

**日期**：2026-08-11

### 目标

在正式实施 Spike 1 之前，先做一次**独立的原型验证**：

1. 把 opencode 的 Provider/LLM 能力从宿主中剥离为独立模块（`core/gateway/`）；
2. 在其上编写一个小型 chat 模块，做初步对话验证；
3. 确认功能完全正常后，再进入 VSCode 接入。

### 完成内容

#### 1. 项目脚手架

- `package.json` / `tsconfig.json` / `.gitignore`（TypeScript + tsx + node:test，无额外运行时依赖，未引入 VSCode）。
- 依赖：`typescript` / `tsx` / `@types/node`（devDependencies）。

#### 2. 独立模块 `src/core/gateway/`（纯 TS，零平台依赖）

| 文件 | 内容 |
|---|---|
| `types.ts` | 领域类型：`ModelRef` / `ChatMessage` / `LLMRequest` / `LLMEvent`（判别联合）/ `ToolDefinition` / `GatewayError`（统一错误分类） |
| `ModelGateway.ts` | **网关接口契约**：`chat(request) → AsyncIterable<LLMEvent>`（消费方只依赖此接口） |
| `providers/opencodeLlm.ts` | **opencode 单点实现**：认证 + 裸 fetch + SSE 解析 + 错误分类（context_overflow / api_error / auth_missing） |
| `FakeGateway.ts` | 测试替身（无网络） |
| `index.ts` | 唯一出口（只 re-export） |

实现要点（对齐 docs 决策）：

- **opencode 隔离**：opencode 相关代码只存在于 `providers/opencodeLlm.ts`，对外只暴露 `ModelGateway` 接口。
- **端点配置驱动、不硬编码**：`server` + `path` 可配置，`fetch` 可注入（离线测试用）。
- **流式**：`stream_options.include_usage` 显式请求 usage；解析 `content` / `reasoning_content` / `tool_calls`（增量聚合）/ `usage` / `finish_reason`。
- **错误分类**：参考 opencode `llm/provider-error.ts` 的 context-overflow 模式集合 + HTTP 状态可重试判定。
- **不做客户端 token 估算**（本次讨论结论）：真实 token 消耗由服务端 `usage` 返回，tokenizer 延后到 renderPrompt 阶段。

#### 3. 小型 chat 模块 `prototype/chat.ts`

- `ChatSession`：维护多轮 history，`ask(input)` 流式消费 `gateway.chat()` 并汇总 `text / reasoning / toolCalls / usage / finishReason`。
- **后续已删除**：验证完成后由 core/kernel 的 AgentRuntime 取代（见第二阶段）。

#### 4. 验证设施

- `prototype/mockSse.ts`：OpenAI 兼容 SSE mock 服务器（认证校验 / 文本流 / reasoning / 工具调用 / 错误响应可控），供测试与冒烟共用。
- `prototype/smoke.ts`：冒烟脚本（有 `OPENCODE_API_KEY` 走真实端点，否则自动切 mock）。**后续已删除**：冒烟职责由临时 shell 层取代。

#### 5. 测试（13/13 通过，`npm test`）

- provider：文本流式 / 请求体形状（system 首位 + include_usage）/ 401 认证失败 / context_overflow 分类 / reasoning 事件 / 工具调用增量聚合 / 消息序列化（tool_calls 与 tool 结果回传）/ 流内错误 / 注入式 fetch 离线路径。
- chat：多轮历史递增 / 工具调用回写 / 事件回调（该文件随 chat 模块一并删除）。

### 关键发现（重要）

1. **go/zen 真实端点已与 docs 记录不一致**。
   - docs（decisions）记录：`api.opencode.ai/zen/v1/chat/completions` —— 已失效（返回 `Not Found`）。
   - **实测有效端点**：`https://opencode.ai/zen/go/v1/chat/completions`（OpenCode Go / opencode-go 订阅）。
   - 模型目录：`https://opencode.ai/zen/go/v1/models`（GET + Bearer）。
   - 印证了「端点配置驱动、不硬编码」的必要性；默认值已更新为实测值。

2. **真实链路验证通过**（本机 opencode-go API key + `deepseek-v4-flash`）：
   - 流式文本正常；`reasoning_content` 正常捕获；`usage`（input/output tokens）正常返回；
   - **多轮对话正常**：第二轮正确引用第一轮上下文。

3. **SSE 流式返回一个额外尾事件**：`data: {"choices":[],"cost":"0"}`（在 `[DONE]` 之后），解析器对其无副作用。

### 运行方式

```bash
npm run typecheck   # 类型检查
npm test            # 单元测试（25 项）
npm run shell       # 临时 shell：无 OPENCODE_API_KEY 时自动用本地 mock SSE
OPENCODE_API_KEY=<key> OPENCODE_MODEL=<model> npm run shell   # 真实 go/zen
```

### 后续（未执行）

- 接入 VSCode：Adapter Shell（SessionController/SessionProvider/ToolBridge）+ 组合根装配（实现计划 Task 1.1）。
- tokenizer / renderPrompt 延后引入（接入 renderPrompt 时必填，`chars/4` 估算即可）。

---

## 阶段：agent 核心模板（Kernel）+ 临时 shell 调试层

**日期**：2026-08-11

### 目标

跳过 VSCode 接入，先实现 **core 层完整内容**，并以**临时 shell 层**对 core 调试检验：

1. 实现规划中的 agent 核心模板（Kernel：模板注册表 / 实例管理 / 空间 / 运行时）；
2. shell 层调用 agent 模板模块 + ModelGateway（llm 接口）模块，完成简单 agent 实例的创建与简单对话；
3. 删除第一阶段临时搭建的 chat 模块。

### 完成内容

#### 1. `src/core/kernel/`（Agent Kernel 骨架，纯 TS，零平台依赖）

| 模块 | 内容 |
|---|---|
| `types.ts` | branded id（`AgentClassID`/`AgentID`/`AgentSpaceID`）+ `AgentClass`（模板）/ `AgentInstance` / `AgentSpace` / `PermissionLevel` / `ContextProfile`（最小占位）/ `KernelError`（判别联合） |
| `AgentTemplateRegistry.ts` | 接口 `register/update/remove/get/list/validate` + 默认实现（内存 Map）+ 校验规则（D7：一切 Agent 来自模板） |
| `AgentInstanceManager.ts` | 接口 `instantiate/terminate/get/listBySpace/updateStatus/takeover` + 默认实现（创建前校验 classRef） |
| `AgentSpaceManager.ts` | 最小版：project → space 映射（D12） |
| `AgentRuntime.ts` | **单实例 while 循环**：instance → template → 组装 ContextProfile/历史 → `ModelGateway.chat` 流式 → 累加器 → 回写历史/计数；显式退出条件（maxSteps / 无 tool_call）；状态 running→idle |
| `AgentKernel.ts` | core 内部组合容器：装配以上子系统 + `getOrCreateAgent`（Scheduler 最小直通）+ `run` |
| `index.ts` | barrel 出口 |

- **内置模板** `templates/SimpleChat.json` / `templates/Coder.json`（非硬编码角色，code-style §3.2）。
- 成本估算 `estimateCost` 可注入（默认不估算，定价后续接入）。
- `ContextProfile` 最小支持：systemPrompt 覆盖 / includeHistory 开关；renderPrompt + tokenizer 预算留待 Task 1.3。

#### 2. 临时 shell 层 `shell/main.ts`

- CLI 交互调试：创建 agent 实例、切换实例、直接对话（流式输出 reasoning / text / usage / finish）。
- 命令：`/new <classId>` `/use <agentId>` `/agents` `/templates` `/source` `/help` `/exit`。
- gateway：`OPENCODE_API_KEY` 存在走**真实 go/zen**，否则自动切本地 mock SSE。

#### 3. 清理

- 删除旧 chat 模块：`prototype/chat.ts`、`prototype/chat.test.ts`、`prototype/smoke.ts`（被 kernel + shell 取代）。
- `prototype/mockSse.ts` 移至 `test-support/mockSse.ts`（测试与 shell 共用）。

#### 4. 测试（25/25 通过，`npm test`）

- registry：register/get/list/update/remove、重复注册、校验、permission 过滤。
- instance：instantiate/get/listBySpace/terminate、无效 classRef、updateStatus/takeover。
- runtime：文本对话（system 生效、历史累积、usage、状态复位）、成本估算注入、onEvent 透传、工具调用记录。
- kernel：getOrCreateAgent 复用/新建、run 通路、内置模板装配。

### 验证结果（真实 go/zen）

- **简单对话正常**：多轮对话、第二轮回溯第一轮上下文；
- **shell 交互正常**：创建 SimpleChat 实例 → 对话 → 创建 Coder 实例 → 切换 → 列表查看；
- 无 key 时 mock SSE 兜底，全链路（shell → kernel → runtime → gateway）工作正常。

### 运行方式

```bash
npm run typecheck   # 类型检查
npm test            # 单元测试（44 项）
npm run shell       # 临时 shell（mock 兜底）
OPENCODE_API_KEY=<key> OPENCODE_MODEL=<model> npm run shell   # 真实 go/zen
```

### 后续（未执行）

- ContextProfile 完整化 + renderPrompt + tokenizer（Task 1.3）。
- VSCode Adapter Shell 接入（Task 1.1）。
- MessageBus / 多 Agent / ContextAssetPool（阶段 2）。

---

## 阶段：工具调用与注册（ToolCapabilityRegistry + 工具轮）

**日期**：2026-08-11

### 目标

补齐工具调用与注册功能 —— agent 能力的根基。该系统同时是上下文管理、日志读取、MCP/skill 支持、日志输出等模块的统一接入接口，**设计上以可扩展为第一优先**。

### 完成内容

#### 1. 公共权限 `src/core/types.ts`

- `PermissionLevel`（normal / advanced / admin）+ `hasPermission` 比较（铁律 8 分级）。

#### 2. `src/core/tools/`（工具引擎，纯 TS，零平台依赖）

| 文件 | 内容 |
|---|---|
| `types.ts` | `ToolCapability` / `ToolInvocation` / `ToolContext` / `ToolResult`（含 references 大输出引用）/ `ToolError`（判别联合）/ `ToolParametersSchema` / `PermissionResolver` / `ToolHooks` / `ToolCategory` |
| `validate.ts` | JSON Schema 子集参数校验（纯函数：required / 类型 / 枚举 / 数组 items） |
| `ToolCapabilityRegistry.ts` | 接口 `register/unregister/get/list/materialize/execute` + 默认实现 |

**可扩展性设计（面向权限管理、MCP、skill、telemetry 等未来接入）**：

1. **`ToolContext` 是开放接口**：core 只定义最小字段（agentId/spaceId/agentPermission/signal）；权限管理、MCP 通道、日志器等宿主能力以「组合扩展」注入，不修改 core。
2. **权限校验可插拔（`PermissionResolver`）**：默认 `LevelPermissionResolver`（工具 permission ≤ agent 权限）；未来可换 deny 名单、人工确认、子 agent 权限继承策略。
3. **执行生命周期钩子（`ToolHooks`）**：`onBeforeExecute` / `onAfterExecute` / `onError`，供 telemetry、审计、限流、MCP 网关挂载。
4. **`ToolCategory` 分类**：`business / system / context / telemetry / module` + 任意扩展（未来 mcp/skill 自然并入），支持按类目过滤与物化。
5. **统一注册入口**：业务工具（oc_*）、系统管理工具（agent_*）、上下文工具（context_*）、日志工具（telemetry_*）走同一 `register`。
6. **双层校验**：自定义 `tool.validate` 优先，再走 schema 校验；均失败抛 `invalid_arguments`。
7. **错误归一化**：`tool_not_found / tool_already_registered / permission_denied / invalid_arguments / execution_failed`。

#### 3. AgentRuntime 工具轮（铁律 6）

- `while` 循环：LLM 返回 `tool_calls` → `ToolCapabilityRegistry.execute` 逐个执行 → tool 结果入上下文 → 续轮，直到纯文本或 `maxSteps`（默认 5）。
- 工具执行失败 → 错误文本（`[ToolError kind] message`）入上下文，模型可自纠续轮。
- usage 跨轮累加；模板 `tools` 白名单 ∩ 权限物化结果 → 本轮 LLM 工具集。
- `AgentKernel` 注入 `tools` 注册表。

#### 4. shell 演示

- 注册示例业务工具 `oc_echo` / `oc_get_time` + 模板 `tool-assistant`（工具白名单）。
- 新增 `/tools` 命令；mock 模式支持工具调用演示（识别 echo 请求 → tool_call → 工具执行 → 文本续轮）。

### 测试（44/44 通过）

- validate：required / 类型 / 枚举 / 数组 items / 非对象。
- registry：注册/查询/列表/重复冲突/形状校验、materialize 权限过滤、execute 成功、permission_denied（admin 工具被 normal 调）、invalid_arguments、tool_not_found、钩子顺序（before→execute→after / 错误→onError）、可插拔权限策略（deny 名单）、自定义 validate。
- runtime 工具轮：tool_call → 执行 → 结果入上下文 → 模型续轮；工具失败错误入上下文可自纠；maxSteps 限制防死循环。

### 验证结果

- **mock 模式工具轮**：`echo hello` → 模型 tool_call(oc_echo) → 执行 → 续轮输出 `Echo: echo hello`，turns=2，usage 跨轮累加。
- **真实 go/zen 工具轮**：问「现在几点」→ 模型调用 `oc_get_time` → 执行 → 输出正确 UTC 时间，turns=2（usage 943+148 tok）。

### 运行方式

```bash
npm run shell       # 然后 /new tool-assistant → 输入 “echo hello”
```

### 后续（未执行）

- 系统管理工具实现（`agent_*` / `context_*` / `telemetry_*`，按权限分级注册为 ToolCapability）。
- MCP / skill 工具适配器（复用 ToolCapability + hooks 挂载）。
- ToolContext 扩展：权限策略细化（deny/人工确认/子 agent 权限继承）。
- Telemetry `ToolInvoked` 事件（经 ToolHooks 挂载）。

---

## 阶段：单工邮局模式（agent 通信总线）+ 系统工具 + context_wait

**日期**：2026-08-11

### 目标

打通 agent-user 融合通信：总线退化为"送信员"，上下文管理器成为"邮局 + 数据库"（按 agent id 分箱，所有上下文成分异步就绪）；agent 全程被动，由邮局送信驱动；新增系统工具（agent_*/bus_*/context_wait）。

### 完成内容

#### 1. 通信模型重构（单工邮局模式）

- **MessageBus**（`core/bus/`）：参与者注册/查询 + 消息转发（携带 from）。不存消息。
- **ContextManager（邮局）**（`core/context/`）：按 agentId 分箱持有 `systemPrompt / context历史 / pendingLetters / toolRecords`；**送信倒计时**（初始 0，送信后开始，来信重置）；**送信条件 = 上下文就绪 & 倒计时就绪**。
- **ContextAssembler**：经典组装模式（system + 历史 + 信件 → messages），可替换。
- **AgentRuntime**：被动驱动 `processDelivery`；状态机 `idle / thinking / holding`；最终回复自动加 `<sender id>` 戳寄信给创建者；每轮 assistant 自动复制到邮局历史。
- 用户面板（user0）与 agent 一视同仁注册邮局（不组装，只汇总信件）。

#### 2. 系统工具（`core/kernel/systemTools.ts`）

| 工具 | 权限 | 作用 |
|---|---|---|
| `agent_instantiate` | advanced | 创建 agent（必填 userPrompt + creatorId，可指定 agentId，返回新建 id） |
| `agent_list` / `agent_terminate` | advanced | 实例管理 |
| `context_wait` | normal | 等待指定 agent 回复：其 assistant_message 作为**本工具的 tool 结果**填充（无常规结果） |
| `bus_send` | normal | 经总线发消息（单目标，并行实现一对多） |
| `bus_participants` | normal | 查询总线注册参与者 |

- 工具调用自动记录（ToolRecord / onRecord → 邮局），不依赖 runtime 手动发送。
- `ToolContext` 增加 `callId`（供 context_wait 绑定自身 tool_call）。

#### 3. context_wait 机制

- `context_wait(agentId)` 注册挂起等待（邮局 `registerHold`）。
- 总线 forward 携带 from；邮局 deposit 时若 from 命中挂起等待 → 该 assistant_message 作为 **tool 结果**（`role:'tool'`，toolCallId 匹配）填充到等待者上下文，而非信件。
- 送信条件纳入"待填充结果"。

#### 4. 测试（48/48 通过）

- 状态机 holding、邮局信件累积、简单对话闭环、发送者戳、工具轮（onRecord 自动记录）、并行工具调用、白名单隔离、**agent 链端到端**（用户→创造者→agent_instantiate→context_wait→子agent读时间→回传→用户）。

### 验证结果

- **mock 模式**：creator 链完整（创建→context_wait→子agent读时间→回传→汇报）。
- **真实 go/zen**：创造者成功创建子 agent（creatorId 正确、返回 id）；模型行为不可控（模板选择、context_wait 调用依赖模型遵循提示词）。

### 关键修复（调试中发现）

- `Promise.race` 中超时的 next() 产生"僵尸 waiter" → 队列支持超时自移除并 resolve(null)。
- shell `onEvent` 闭包引用旧 `currentAgentId` + `streamedAny` 跨会话污染 → 改为引用动态 state + 会话前重置。

### 后续（未执行）

- sub_agent 清理（手动 `agent_terminate` / kernel 接口）。
- 等待超时机制（context_wait 无超时，需手动清理）。
- Telemetry / MCP / skill 工具适配。

---

## 阶段：类-实例分离 + context 模块子模块化（Mailbox 拆出）

**日期**：2026-08-12

### 目标

- 提前落地阶段 3.1 的类管理工具：`agent_class_create/list`（admin），类属性与实例数据彻底分离。
- context 模块子模块化：ContextManager（成分管理 + 拼装 + 就绪信号）与 Mailbox（等待 + 倒计时 + 发送）职责分离；ContextAssembler 合并入 ContextManager 为可注入组装策略。

### 完成内容

1. **系统工具**（admin 权限）：`agent_class_create`（只承载 `id/name/description/systemPrompt/permission/tools/model/sendCountdown`，**不含 userPrompt 等实例数据**，走 `AgentTemplateRegistry.register` + validate）、`agent_class_list`。
2. **context 重构**：
   - `Mailbox.ts` 子模块：只负责等待「上下文就绪信号 + 倒计时就绪」→ 向指定 id 发送；不参与拼装。
   - `ContextManager.ts`：单一上下文接口（deposit/appendHistory/appendToolRecord/registerHold），内容就绪时**只读拼装**快照 → 交给 Mailbox；Mailbox 发送前 `beforeSend` → 信件并入历史清空。
   - `ContextAssembler.ts` **删除**：合并为 `ContextManager` 内的可注入组装策略（`ContextAssembler` 函数类型 + `classicAssemble` 默认实现），未来 renderPrompt/Compressor 作为策略注入。
   - `getState` 改为异步（组合成分状态 + Mailbox 状态 `coolingDown`）。

### 验证

- 49/49 测试通过（新增：agent_class_create/list 创建类、类不含实例数据、新类可实例化、normal 权限被拒）。
- mock 模式 creator 链 / tool-assistant 工具轮均正常。

### 后续（未执行）

- logging 模块（提交 2）：各模块日志经 MessageBus 路由到日志订阅者。
- `agent_class_update/remove`、模板持久化。

---

## 阶段：Logging 横切模块（core/logging/，消息总线作为通信接口抽象）

**日期**：2026-08-12

### 目标

为所有模块添加日志接口，经消息总线发送到专门的日志模块——MessageBus 从"送信员"升级为**通信接口抽象**（agent 消息 → 邮局；log → 日志记录器）。

### 完成内容

1. **core/logging/**：`events.ts`（LogEvent 判别联合）、`Logger.ts`（InMemoryLogger：留档 + query 过滤 + clear）。
2. **MessageBus**：`BusMessage` 判别联合（AgentBusMessage / LogBusMessage），按 kind 路由；`onLog` 订阅者。
3. **各模块接入**（低层模块经注入 `LogSink`，组合根装配到 bus）：
   - **tools**：`tool.invoked`（called/success/error + durationMs + 结果/错误）。
   - **context/Mailbox**：`mailbox.countdown`（start/reset/fire/hold）+ `mailbox.delivered`（发送状态）。
   - **context/ContextManager**：`context.assembled`（上下文构成 + 成分就绪时间戳 + 完整上下文留档）。
   - **runtime**：`gateway.apiRequest`（model/provider/tokens/latency/cost）+ `kernel.status.changed`。
   - **kernel**：`kernel.instance.created/terminated`、`kernel.class.registered`（经 `registerAgentClass`）、`kernel.message.sent`（bus forward 时）。
4. 测试 50/50（新增 logging 全链路集成测试：路由 + 各事件 + query 过滤 + 上下文留档 + 工具日志）。

### 设计要点

- 依赖方向：低层模块（context/tools/runtime）**不依赖 bus**，只依赖 `LogSink` 接口；组合根（AgentKernel）装配到 bus log 路由 → logger。
- `getState` 之前的 `coolingDown` 状态与日志联动。

### 后续（未执行）

- 持久化（SQLite/文件）+ `telemetry_read` 系统工具。
- `agent_class_update/remove`、模板持久化。

---

## 阶段：统一权限模型 + PanelBus 面板通道 + 弹窗模块

**日期**：2026-08-12

### 目标

工具分为内部/外部两类（固有属性）；废弃模糊的 PermissionLevel 角色等级，改为**统一原子化 per-tool 权限**（allow/deny/ask），由 agent 类权限列表决定，ask 完全面向用户（面板）确认；统一 PanelBus 汇总所有面板消息。

### 完成内容

1. **统一权限模型（core/permission/）**：
   - 工具声明 `permission`（权限名，缺省=工具 id；edit/write 可共享 'edit'）+ `kind: 'internal'|'external'`（固有属性）。
   - Agent 类 `permissions: Record<权限名, allow|deny|ask>`；未列出的默认 ask。
   - `evaluate`：规则集=[agent 类, ...session 批准]，最后命中优先，缺省 ask。
   - `PermissionManager`：ask 挂起 → 面板确认；once/always/reject；always 写 approved（用户批准优先于 agent 规则）。
   - **废弃 PermissionLevel**（core/types / kernel / tools / systemTools / 模板 / 测试全量迁移）。

2. **registry 统一权限确认**：`materialize(rules)` 过滤 deny；`execute` 内统一 assert（allow 执行 / deny 拒绝 / ask 挂起），工具无需内部调权限接口（external_directory 简化掉）。

3. **PanelBus（core/panel/）**：统一面板消息流（letter 回信 / permission_request 权限弹窗 / notice 通知），面板端只需实现一个 consumer；bus 新增 `permission_reply` kind 路由到权限管理器。

4. **弹窗模块（shell/ui/dialog.ts）**：可复用队列弹窗（主题/正文/编号选项，支持多选）；权限确认弹窗 = 主题"权限确认"、正文"agent xx 正在申请 xx 工具权限"、选项 1.单次批准 2.始终批准 3.拒绝。

5. **shell 事件循环重构**：回信经 PanelBus 异步展示（不再阻塞等待）；弹窗优先处理（用户输入行优先解析为弹窗选择）。

### 验证

- 62/62 测试通过（新增 permission 评估/管理器单测：ask 挂起 once/always/reject、always 免询问、用户批准优先）。
- mock 模式：内部工具（allow）不弹窗，creator 链正常；外部工具（ask）触发权限弹窗 → 输入 1 单次批准 → 工具执行 → 结果展示。

### 后续（未执行）

- host 工具（read/write/edit/grep/glob，shell/tools/，提交 2）。
- 权限规则持久化（per-project）+ `telemetry_read`。

---

## 阶段：host 外部工具（read/write/edit/grep/glob，kind=external）

**日期**：2026-08-12

### 目标

实现第一批外部注册工具（相较 core 的外部模块 `shell/tools/`），参考 opencode 实现；工具为固有属性 kind=external，经 registry 注册接口接入，权限名 read/edit/edit/grep/glob。

### 完成内容

- `shell/tools/fs-util.ts`：路径解析（相对工作区）、二进制检测（NUL）、递归遍历（排除 .git/node_modules）、glob→正则。
- `read`（权限 read）：文本读取 + offset/limit 分页（1-based）+ 目录列出 + 二进制拒绝 + 50KB 截断。
- `write`（权限 edit）：全量写入，父目录自动创建，不支持 append。
- `edit`（权限 edit）：oldString/newString 精确替换（非 diff），0 次/多次（需 replaceAll）校验。
- `grep`（权限 grep）：正则递归搜索，include glob 过滤，file:line:text。
- `glob`（权限 glob）：glob 模式匹配（**/*/?/{a,b}）。
- shell 装配 `createHostTools(process.cwd())` 注册；`coder` 模板启用这些工具。
- `package.json` test 脚本扩展覆盖 `shell/**/*.test.ts`。

### 验证

- 69/69 测试通过（新增 host 工具单测：read 分页/目录、write 自动建目录、edit 精确替换与校验、grep 递归、glob 匹配）。
- mock 模式 `/tools` 列出 5 个 external 工具及权限名。

### 后续（未执行）

- MCP 工具适配器（复用 ToolCapability 注册接口 + 统一权限确认）。
- external_directory 资源级审批（当前简化掉，所有路径统一走工具权限确认）。

---

## 阶段：全局配置（core/config）+ 初始化管线（core/init）+ 用户 tool/agent

**日期**：2026-08-12

### 目标

建立**唯一配置文件** `.stem/stem.jsonc`（本阶段不引入 `~/.config/stem/` 多级合并），自动发现并注册用户工具/agent：`core/config` 处理配置读写解析，`core/init` 作为初始化管线（扫描 → 同步注册表 → 注册进 core）。

### 完成内容

1. **core/config/**（纯 TS，fs 经接口注入）：
   - `types.ts`：`StemConfig`（model/autoApprove/permission/sendCountdown + tools/agents 镜像注册表）、`RegisteredTool`/`RegisteredAgent`、`ConfigLoadResult`、`ConfigError`。
   - `parse.ts`：`parseConfigText`（jsonc-parser 解析 JSONC，校验字段类型与 model `提供商/模型` 格式）、`normalizeConfig`、`parseModelRef`。
   - `store.ts`：`ConfigStore` / `ConfigPaths` 接口（读 + 写 raw text，宿主注入实现）。

2. **core/init/**（初始化管线 `runInit(deps)`，fs/动态 import 注入）：
   - 扫描 `.stem/tool/*.ts`（默认导出 `ToolCapability`）+ `.stem/agent/*.md`（YAML 头 + 正文）。
   - **同步注册表（纯镜像）**：新文件 → 登记；已注册但无实现文件 → `orphan_registration` issue 并移除；jsonc-parser `modify` 定点写回，**保留注释**。
   - 注册进 core：工具 → `ToolCapabilityRegistry`（kind 强制 `user`）；agent → `AgentTemplateRegistry`。
   - 用户 agent 文件解析（`agentParse.ts`）：**文件名即 agent 类 id/name**（不要求 frontmatter 写 id/name，实例化时才命名）；**工具与权限融合**——`permission: { read: allow, edit: deny }` 的键即工具白名单、动作即权限，避免"有权限无工具 / 有工具无权限"；description / send_countdown 映射，metadata 等附加字段忽略。

3. **ToolKind 三分类**：`'internal' | 'external'` → `'internal' | 'shell' | 'user'`；`shell/tools/` 5 个工具改 `kind: 'shell'`。

4. **权限配置接入**：`PermissionManager` 新增 `globalDefaults`（全局权限，最弱优先级）+ `autoApprove`（ask 直接放行）；`AgentKernelOptions` 透传 `globalPermissionDefaults` / `autoApprove`，规则集 = [全局默认, agent 类规则, session 批准]。

5. **shell/config/**（node fs 宿主实现）：`resolveConfigPaths` / `createNodeConfigStore`（stem.jsonc 优先，其次 stem.json）/ `createNodeInitFs` / `nodeToolLoader`（动态 import 用户工具）/ `FALLBACK_MODEL`。

6. **tmp/ 测试项目空间**：`tmp/.stem/stem.jsonc` + `tool/user_hello.ts`（示例用户工具）+ `agent/user-reviewer.md`（示例用户 agent，YAML 头 + 审查员提示词）。

7. **shell/main.ts 接入**：启动时 `runInit`（模型/权限/autoApprove/倒计时从配置读取）；`/config` 命令展示配置与注册表；host 工具 root 改为项目空间 `tmp/`。

### 验证

- 101/101 测试通过（新增：config 解析 12 项、agent 解析 10 项、init 管线 8 项、权限 globalDefaults/autoApprove 2 项、nodeConfig 真实 fs 集成 3 项）。
- mock 模式验证：`/config` 显示 model=`opencode-go/deepseek-v4-flash`、全局权限 `{read: allow}`、注册 `user_hello` + `user-reviewer`；`/templates` 列出用户 agent `user-reviewer`；stem.jsonc 自动写入 tools/agents 镜像且注释保留。
- typecheck 0 错误。

### 后续（未执行）

- `~/.config/stem/` 全局配置 + 多级合并（`[项目 .stem, 全局]` 优先级）。
- 运行时热更新 / watch `.stem/` 目录。
- user 工具权限与 enabled 的用户覆盖（当前镜像只读）。

---

## 阶段：上下文模块重构（重建邮局：仓库 / 管理员 / 快递员）+ 废弃总线

**日期**：2026-08-12

### 目标

按「重建邮局」方案重构 context 模块为三模块：**仓库**（上下文本体存储）/ **管理员**（处理/打戳/组装）/ **快递员**（倒计时+发送）；**废弃集中式 MessageBus**，agent 通信直接投递、log/permission_reply 走注入接口。

### 完成内容

1. **core/context/ 三模块**：
   - `Repository.ts`（仓库）：唯一存储，每条消息记录 `message / agentId / at / tokens（字符/4 估算） / valid / from`；`register` 时 systemPrompt 作为首条 system message 入库；任何消息 `append` 后触发 `onChange`。
   - `ContextManager.ts`（管理员）：收到待处理事件 → **打发送者戳**（user 消息用 from 元数据生成 `<sender id="from">`，替代原 runtime 拼戳）、context_wait 判定（from 命中挂起 → 回复作为 tool 结果填充 owner）、组装（ContextAssembler 可注入，classic/coding-hybrid）→ `courier.notifyReady`。
   - `Courier.ts`（快递员，原 Mailbox 改造）：倒计时逻辑保留（初始 0 立即送；发送后开始；来信重置），**发送时从仓库按 valid 顺序取有效消息**；agent 收 `AgentDelivery`（新增 `messageIds`）、user0 收 `UserDelivery`（diff 上次发送消息 id 集）。
   - 删除旧 `Mailbox.ts`。

2. **废弃 core/bus/（MessageBus）**：
   - agent 通信 → kernel `sendMessage(from, to, payload)` 直接投递到管理员；
   - log → 各模块 LogSink 组合根直达 Logger（无总线中转）；
   - permission_reply → 面板直接调 `kernel.permissions.reply(input)`（shell/main.ts 已改）；
   - 参与者查询 → 复用 instances + user0（`kernel.listParticipants()`），`bus_participants` 工具改查该接口。

3. **AgentRuntime**：移除 bus；最终回复**不再拼发送者戳**，直接投递给创建者；每轮 assistant 复制到仓库（`appendHistory`）；工具结果经 `appendHistory` 入仓库（`appendToolRecord` 仅审计，不写仓库）。

4. **AgentKernel**：装配仓库/管理员/快递员；`sendMessage` 替代 bus.send；实例化/注册/终止流程更新。

### 验证

- 101/101 测试通过（更新 runtime/kernel/agentChain 测试到新架构；新增仓库/快递员路径）。
- mock 模式验证：简单对话（`<sender id="user0">` 戳正确）、echo 工具轮、creator 链（agent_instantiate + context_wait + 子 agent 读时间 → 回传）均正常。

### 后续（未执行）

- 仓库真实 token 记账（基于 gateway usage 差值校正；当前 tokens 为字符/4 估算占位）。
- coding-hybrid 模式（五段排布：原则信息/对话脉络/精炼历史/元代码空间/实时 toolcall 结果）。
- 仓库持久化（SQLite/文件）。

---

## 阶段：工具访问四态融合 + 族谱树 + user0 元化 + 命名简化

**日期**：2026-08-14

### 目标

1. **权限模块融合进 tools**：废弃 `core/permission/`，工具访问状态成为 agent 工具字典的属性值（四态 `allow/ask/deny/ignore`）。
2. **族谱树**：agent 明确父子关系（同地位独立个体），父可销毁子；user0 是原点/元 agent。
3. **系统级工具默认隐藏**：`kind=internal` 默认 `ignore`，显式 `allow` 才暴露。
4. **命名简化**：kernel 子模块去 Agent 前缀。

### 完成内容

1. **`core/tools/` 工具访问四态**：
   - `access.ts`：`evaluateAccess`（分层评估，层间取最严格 = 单向收缩）+ `restrictAccess`（偏序 `deny ≺ ask ≺ {allow, ignore}`）+ `toolAccessToRules`。
   - `AccessManager.ts`（替代 PermissionManager）：`assert`（allow/ignore 通过 / deny 抛 `access_denied` / ask 挂起弹窗）+ `reply`（once/always/reject）+ **元 agent（user0）短路 allow**。
   - `types.ts`：`ToolAccess` / `ToolAccessRule` / `ToolAccessRules` / `AccessRequest` / `AccessReply` / `AccessAssertInput` / `AccessError`；`ToolCapability.permission` → `accessKey`；`ToolContext.rules` → `accessLayers`。
   - `ToolCapabilityRegistry`：materialize 过滤 deny/ignore（internal 默认 ignore）；execute 走 AccessManager。
   - **删除 `core/permission/`**（types/evaluate/PermissionManager/index）。

2. **族谱树 `core/kernel/LineageTree.ts`**（无状态关系查询视图）：
   - `AgentInstance.parentId`（创建时确定、不可变；user0 为 null 即根）。
   - 单一事实源：parentId 挂实例上，LineageTree 实时推导，无独立存储/无需同步。
   - `getParent / getChildren / getAncestors / getDescendants / isAncestorOf / resolveAccessLayers`（权限继承）。
   - 销毁权（fail-closed）：仅祖先（含 user0）可销毁；有活跃子默认拒绝，`recursive` 级联；元 agent 不可销毁。

3. **user0 元化**：
   - `registerUser()` 实例化 user0 为元 agent（`classRef='__meta__'`、`parentId=null`），进入实例体系。
   - 元权限：AccessManager 对 user0 短路 allow（作为偏序最大值对后代零污染）。

4. **权限继承（单向收缩）**：
   - kernel 合成完整访问层 `[全局(最弱), 祖先链(父→子), agent 类]`，AccessManager 追加 session 批准。
   - 子 ≤ 父：任何一层 deny → 全局 deny，deny 不可被后序规则撤销。
   - session 批准（always/once）仅当前实例，不传播后代。

5. **系统工具新增/增强**：
   - 新增 `agent_inspect` / `agent_ancestry` / `agent_descendants`。
   - `agent_terminate` 增参 `recursive` + 销毁权校验（by=ctx.agentId）。

6. **命名简化**（kernel 子模块去 Agent 前缀，领域类型 `AgentClass/AgentInstance/AgentID` 保留）：
   - `AgentKernel` → `Kernel`、`AgentInstanceManager` → `InstanceManager`、`AgentTemplateRegistry` → `TemplateRegistry`、`AgentSpaceManager` → `SpaceManager`、`AgentRuntime` → `Runtime`（含同名文件 git mv）。

7. **同步**：shell/main.ts（access.reply、globalToolAccessDefaults）、shell/tools/*（accessKey）、config/parse（四态校验）、init/agentParse（toolAccess）、panel/types（accessKey）、logging（access.asked/replied）、templates/*.json（toolAccess）。

### 验证

- 106/106 测试通过（新增 access.test 9 项 + LineageTree.test 7 项；更新 tools/kernel/init/shell 测试）。
- typecheck 0 错误（忽略 reference/）。

### 后续（未执行）

- `agent_class_update` 接入：类 toolAccess 运行时变更经动态传导自动收紧全部实例。
- 仓库真实 token 记账（基于 gateway usage 差值校正）。
- coding-hybrid 模式（五段排布）。
- 仓库/族谱持久化（SQLite/文件）。

---

## 阶段：错误处理强化（interrupted 状态 + 消息闭合 + 中断入口 + gateway 并发保障）

**日期**：2026-08-15

### 目标

处理网络中断（gateway 问题）、进程中断、用户主动中断；细化状态分类（thinking/holding/interrupted）；确保中断时 messages 完整性（避免无法创建完整上下文列表导致 agent 失效）；确认 agent 间 gateway 并发调用能力。

### 完成内容

1. **`AgentStatus` 增加 `interrupted`**（kernel/types.ts）：当前轮被中断（用户/进程/网络/工具错误），实例仍存活、消息完整，下一次送信自动恢复（回 thinking）。与 `terminateAgent`（销毁）严格区分。

2. **Runtime 错误处理（三层防护）**（kernel/Runtime.ts）：
   - 每轮 `processDelivery` 注册 `AbortController`（`controllers` Map）；`Runtime.abort(agentId)` / `abortAll()` / `activeAgents()` 供 kernel/宿主中断。
   - 主循环 `gateway.chat(request, { signal })` 抛错时统一走 `halt()` 收尾（不再冒泡卡死状态）。
   - **消息闭合**：中断时已产出的部分 assistant 文本补 `\n<interrupted>` 标记入库（`appendHistory`），避免"assistant 后直接接 user"非法消息序列；网络/工具错误原样保留部分文本（不伪造完成标记）。
   - 日志新增 `kernel.instance.interrupted`（aborted/errorKind/message）。

3. **Kernel 中断入口**（kernel/Kernel.ts）：`interruptAgent(agentId, { by })`（销毁权复用：仅祖先或 user0）+ `abortAllAgents()` + `activeAgents()`。

4. **shell 中断能力**（shell/main.ts）：`/stop` 命令（中断当前活跃 agent）；SIGINT/SIGTERM 优雅收尾（中断所有活跃 agent，消息闭合后退出）。

5. **gateway 并发保障**：
   - 确认 `ModelGateway.chat`（AsyncGenerator）各 agent 独立调用天然并发（对齐 opencode provider 层 unbounded 并发）。
   - `FakeGateway` 支持 `ChatOptions.signal` 中断模拟（含 `abortError()` 导出），并透传 signal 给 handler。
   - `gateway/types.ts` 新增 `isAbortError` 判定（区分主动中断与网络错误）。

### 验证

- 111/111 测试通过。新增 Runtime 4 项（用户中断闭合+恢复 / 网络错误原样保留 / 中断后消息闭合 / 多 agent 并发）+ Kernel 1 项（中断+权限+恢复）。
- typecheck 0 错误。
- shell 冒烟：`/stop` 正常中断 thinking 中的 agent；`/help` 含新命令。

### 后续（未执行）

- 工具轮并发上限（mapLimit）——用户决策暂不设置，保持 Promise.all 无上限。
- 进程中断时若 halt 收尾超时的兜底（当前 300ms 等待）。

---

## 阶段：消息库 tag + 双索引 + 参数精简（AgentClass/Instance）+ creatorId 合并 + 导出/概览

**日期**：2026-08-16

### 目标

为上下文管理策略（self-focus / ltm-stm-mix / coding-hybrid 等）做模块准备：消息库 tag + 双索引、参数精简、creatorId 合并、上下文导出/概览工具。

### 完成内容

1. **消息库 tag + 双索引**（core/context/）：
   - `StoredMessage` 增加 `tag?`（描述性标签，标记非原生合成消息，如 summary/impression）+ `turn`（轮序号，复用 turnCount 语义）+ `indexInTurn`（轮内序号）。
   - Repository 自动维护：user 消息开启新轮（turn 递增、轮内序号归 0），其余轮内递增；system 为第 0 轮。
   - **strategy 不作为 tag 的一部分**：每个 agent 的上下文策略在开辟上下文空间时确定（上下文属性），组装器按 agent 策略解释 tag。

2. **AgentClass 精简**（name 即 id）：
   - 移除 `id`（name 即模板键，注册查重）；移除 `memoryScope`（占位未用）。
   - `tools` 融合白名单与访问：`Record<访问键, ask|deny|allow|ignore>`，**键即白名单**（空 Record=无工具，undefined=全部），替代原 `tools` 数组 + `toolAccess` 双轨。
   - 新增 `contextStrategy`（默认 classic，实例化时写入上下文属性）。

3. **AgentInstance 精简 + creatorId 合并**：
   - 移除 `creatorId`（**合并进 parentId**：谁创建谁就是父）；移除 `createdBy`。
   - `InstantiateOptions`：`className` + `parentId`（必填）+ `userPrompt`（必填）+ `agentId?` + `tools?`（临时收敛）+ `contextRefs?`（父仓库消息索引，深拷贝导入）。
   - 全量替换 creatorId → parentId（Kernel/Runtime/systemTools/shell/测试，约 12 文件）。

4. **上下文导出/概览**：
   - context 模块（纯格式化，无权限）：`exportJsonl(agentId)`（jsonl 逐行）+ `overview(agentId)`（只读反射 role/turn/tag/token 占比）。
   - Kernel 薄转发（`exportContext`/`contextOverview`）+ 系统工具 `context_export`/`context_overview`（agent 只能看自己的或祖先的）。

5. **系统工具参数精简**：`agent_class_create`（name/tools/contextStrategy）、`agent_instantiate`（className/userPrompt/agentId/contextRefs/tools，父自动=调用者）。

### 验证

- 115/115 测试通过（新增 context 4 项：tag+双索引、导出、概览；更新 kernel/init/shell 测试）。
- typecheck 0 错误。
- shell 冒烟：context_export/context_overview 工具注册、模板 tools 显示为 Record、/agents 显示 parent。

### 后续（未执行）

- 上下文管理策略实现（coding-hybrid 渐进版 / ltm-stm-mix / self-focus 裁剪开关）。
- contextRefs 支持"轮索引 or 轮+序号"定位语法（当前仅消息 id 或轮索引）。
- 后台总结工具（每轮每消息短摘要）——用户暂缓。

## 阶段：user0 平等化 + ask 消息化 + 自治系统装配 + shell 分层

**日期**：2026-08-22

### 目标

按「全体 agent 绝对平等」原则做系统性重构：user0 落回 `user` 类普通实例、ask 审批消息化、core 自治装配（createStemSystem）、外部交互统一为 Pilot 扮演 + PilotEvent 事件流、shell 分层（cli 参考 shell + webui）。

### 完成内容

1. **设计理念固化**（AGENTS.md 新增六条硬规则）：全体平等 / 机制大于判断 / 权限收敛走族谱 / 模块自治 / 少即是多 / 架构分层。

2. **工具生命周期 + skill 生态**（core/tools/）：
   - `ToolCapability.init?(ctx: ToolInitContext)` + `registry.initAll(ctx)`（fs/skills/skillDir/log 注入，装配后调用一次、幂等）；
   - `SkillRegistry`（register/get/list/manifest `<available_skills>`）+ `skill` 工具（internal，类配置显式 allow；init 扫描 `.stem/skills/*.md`，execute 懒加载正文）——渐进式披露，避免工具上下文膨胀。

3. **legalize（上下文合法化）**（core/context/legalize.ts，纯函数）：组装 delivery 统一过——悬空 tool_calls 裁剪 / 孤儿 tool 剔除 / tool→user 相邻插边界。保证删除/修改后的上下文仍可经 gateway 发送。

4. **族谱树独立模块化**（core/lineage/）：纯关系视图（parent/children/ancestors/descendants/getRoot/isAncestorOf），零 tools 依赖；权限继承收敛至 `tools/access.ts`（`collectAncestorAccessLayers`）。

5. **ask 权限消息化**（core/tools/accessRequest.ts，取代 AccessManager/PanelBus）：
   - 命中 ask → `AccessAskBus` 自动投递 `<access_request>` 到**申请者的族谱根信箱**（机制同向模型发消息）并挂起；
   - 根 agent 经 `access_reply` 工具回复（once/always/reject，可带 feedback，`reply(input, by)` 校验调用者是根）；
   - **删除 `core/panel/`（PanelBus）与 `core/tools/AccessManager.ts`**；kernel 事件流收敛为 `PilotEvent`（stream/letter/status/notice）+ `EventHub`（多订阅者）。

6. **user0 平等化**（core/kernel/）：
   - 内置 `user` 类（`userClass.ts`：systemPrompt=''、sendCountdown=0、**tools = config.permission**）；user0 = user 类普通实例（parentId=null 即根）；
   - 移除 `META_CLASS_ID` / `registerMetaAgent` / `registerUser`，根经 `registerRootAgent` 走正常 `instantiate` 路径；终止权泛化为 `isAncestorOf`（根无祖先 → 天然不可销毁）；
   - config.permission 语义重定义 = user 模板 tools（不再独立全局最弱层，由祖先链首层承接）。

7. **Pilot + 系统装配**（core/pilot/ + core/init/）：
   - `Pilot`：user0 扮演接口（sendMessage/instantiate/terminate/interrupt/replyAccess/context 管理 + subscribe(PilotEvent)）；`createPilot` 内实例化 user0；
   - `createStemSystem(deps)`：config → 工具注册表 + Kernel（user 类 tools=config.permission + skills 注入）→ 系统/宿主/skill 工具 → runInit 管线 → pilot(user0) → initAll(skill 发现) → 用户注入钩子（userHooks）；shell 只注入平台能力。

8. **上下文删除/修改工具**：`context_remove`（markInvalid，system 除外，可整轮删）+ `context_edit`（updateMessage，system 除外）；user0 亦适用（无特判）。

9. **修复潜在无限循环**：只有外部来信（`deposit`）才唤醒快递员，agent 自身 `appendHistory` 不触发重投递（否则 agent 自回复会无限循环——原设计在真实计时器下暴露）。

10. **shell 分层**：`shell/cli/`（参考 shell：platform.bootStem 共享装配 + gateway + fs 工具集 + CLI）+ `shell/webui/`（HTTP + SSE 浏览器交互层：agent 侧栏/timeline/composer/权限弹窗）+ `extension/tools/`（预留扩展工具集 seam）。

### 验证

- 139/139 测试通过（新增：lineage 迁移 + getRoot、legalize、skill/init 生命周期、accessRequest 总线、createStemSystem 装配、pilot 扮演）。
- typecheck 0 错误。
- `npm run shell`（CLI）与 `npm run web`（http://localhost:4321）冒烟正常：agents/templates/context API、发送消息、SSE、权限弹窗流程。

### 后续（未执行）

- `context_validate` 预览工具（首期只做 remove+edit）。
- 上下文管理策略实现（coding-hybrid / ltm-stm-mix / self-focus）。
- extension 工具集迁移（fs 工具 → extension/tools，可替换为 VSCode 工具集）。
- user0 transcript 完整化（assemble=true 全转录 + skills 清单注入已就绪，webui 渲染细化）。

## 阶段：个体层持久化（SQLite write-through）——M1~M4

**日期**：2026-08-29

### 目标

四大特色中"上下文可扩展管理"与"自我进化"都需要**跨进程存活的个体记忆**：实例族谱、上下文消息、空间落盘（Docker 部署的前置——此前会话历史纯内存，重启即失）。分层边界：类层持久 = 文件（`.stem/agent/*.md`），个体层持久 = SQLite。

### 完成内容

1. **持久化端口（core，零平台依赖）**：
   - `context/store.ts`：`MessageStore`（upsert/archiveAgent/loadBoxes/maxMessageSeq）+ `MemoryMessageStore` 参考实现；
   - `kernel/store.ts`：`InstanceStore`（实例 + 空间两表）+ `MemoryInstanceStore`；
   - 同步接口（对齐 `node:sqlite` DatabaseSync 与仓库同步读——读接口零破坏）。
2. **write-through 装饰器（core）**：`PersistedRepository` / `PersistedInstanceManager` / `PersistedSpaceManager`——内存为准、写操作同步落行；`Repository.restore/setCounterFloor`、`InstanceManager.restore`（活跃状态归一化 thinking/holding→interrupted）为恢复专用方法。
3. **Kernel/装配接线**：`KernelOptions.stateStore`（可选注入，缺省纯内存）→ 内存核恢复 → 套装饰器 → 构造末尾 `wireRestoredInstances`（`ContextRegistration.restore=true` 跳过仓库开辟，快递员 `initialSentIds` 预置 = **重启零重放**）；`createStemSystem` deps 透传 + dispose 关句柄。
4. **terminate 语义改造**：实例/空间行删除，**消息行归档**（archived 标记保留进化语料；恢复不加载，id 计数器经 `maxMessageSeq` 避开历史序号）。顺带修复两问题：`terminateAgent` 校验先于副作用（原实现先注销上下文再抛销毁权错误）+ recursive 级联的子体上下文原本泄漏（现按族谱子树逐个注销）。
5. **SQLite 适配（shell/cli/storage/）**：node:sqlite（行 = 记录全量 JSON + agent_id/seq 冗余列；`PRAGMA user_version` 迁移守卫；rollback journal 避开 9P/WAL-shm 风险）；`bootStem` 默认注入（`<projectRoot>/.stem/stem.db`，`STEM_DB_PATH` 覆盖，`stateStore:false` 显式纯内存）；.gitignore 排除 `*.db*`。
6. **user0 空间常规化**：`registerRootAgent` 改走 `spaces.getOrCreate`（清 `__meta__` 遗留特判，平等原则）；空间随实例持久化（spaceId 重启可解析，listAgents 恢复可见）；webui 首启判空条件相应修正（现为"除 user0 外无 agent"）。

### 验证

- 156/156 测试（新增 17：装饰器/端口 13 + SQLite 真库 round-trip 3 + 重启 e2e 1）；typecheck 0 错误。
- e2e（`init/restart.test.ts`）：A 对话 → B 重启（族谱/上下文/计数器续接/零重放/续聊送达）→ terminate 归档 → C 归档不加载 + id 防撞。
- 冒烟：bootStem 双生命周期 + webui HTTP 双生命周期（真库落 `.stem/stem.db`，同 id 恢复、holding→interrupted 归一、SIGTERM 优雅退出）。

### 已知边界

- `turnCount/totalCost` 引用直改不经装饰器，随下次状态快照收敛（丢进行中的一轮记账零头，消息本体不受影响）。
- 单进程假设；`node:sqlite` 标记 experimental（只用 prepare/run/all，API 极稳）；engines 升 `>=23.4`（免 flag），Docker 基像计划相应改 node:24-slim。
- 重启后 user0 出现在 agent 列表（平等化后的正常视图，webui UI 未过滤）。

### 后续

- 上下文管理策略（summary/impression 等 tag 合成消息随 write-through 天然持久）。
- `agent_class_create` 类落盘回写 `.stem/agent/*.md`（自我进化闭环，类层文件哲学）。
- Docker 部署方案按定稿执行（此轮持久化落地后"会话内存态"限制已消除）。

## 阶段：权限台账 + 上下文策略框架 + user0 配置对象化

**日期**：2026-08-31

### 目标

三目标收敛为一次架构闭环：①实现 classic 上下文管理方案（对齐 opencode compact）；②明确族谱树与 tools 的权限系统划分（生效权限 = 族谱位置的函数，统一收敛接口）；③配置模块完善（user0 内嵌 agent 类全对象可配）。全部经四方讨论冻结方案后按 S2′→S1′→S3′ 实施（权限是语义地基，策略消费权限语义，配置收口参数面）。

### 完成内容

1. **S2′ 族谱权限台账（8498714）**：
   - 新增 `lineage/AccessLedger`：注册两步曲（继承 inherit → 收敛 converge）物化标准形 `{explicit, fallback}`；语义四则——键即白名单（本地封闭）、祖先只供**显式**判定（匿名封闭不下传；显式 deny/ask 锁子孙）、不设限 = 完整继承父档案（子面不宽于父）、**grant 加法** = 系统特权整表替换（免除逐个填 deny；未列一律 deny；祖先显式 deny 铁律不可豁免）；重启拓扑 rebind（纯派生态不入库）。
   - tools 查询反转：`AccessResolver` 端口注入（registry/ask 总线向台账查询，`ToolContext` 删 accessLayers，Runtime 删层传递与空表特判）；kernel 编排三件套（resolveAccessLayers/rulesOf/resolveClassLayer）删除，只剩 provider 接线；`LineageTree` 保纯关系视图，台账并列于 lineage 目录。
   - 修复三个存量语义 bug：**B1** 白名单未强制（未列键落到默认照常暴露）、**B2** always 批准跨 agent 泄漏、**B5** always 参与分层取严永远压不住 ask——session 批准重定义为 **per-agent ask 豁免备忘**（非权限层）。interrupt 去 user0 特判（自身或祖先）；agent_inspect 出示生效权限表（物化红利）。
2. **S1′ 上下文策略框架（368ad99）**：
   - **组装权收归管理员**（结构性缺口修复：旧 `contextAssembler` 注入不影响真实送信——快递员硬组装；现快递员只发不组装，送信快照 = 管理员按 agent 策略分发 + legalize）。
   - `context/strategies/` 独立子模块：契约 `ContextStrategyModule`（note/role/assemble/process/actions）+ 注册表；两段式生命周期（触发 = user_prompt 信件抵达，终点 = process 返回"完整上下文就绪"再唤醒快递员；process 异步许可 / assemble 纯函数；重入合并 guard；失败兜底绝不卡死送信）；未知策略注册期 fail-fast、恢复接线兜底默认；**面板（assemble:false，user0 与策略 role）恒绑 none**（note 不污染人格）。
   - **classic = opencode 式 compact**：估算 token 逼近 window×threshold 时按轮边界把旧段交摘要 worker，摘要经 `append(tag='summary')` 正规入库 + 旧段 `markInvalid`——**语料归档可逆可审计**（opencode 无此优势）、轮边界 + append-only 前缀缓存稳定；参数全走 `config.context`。
   - **模块扮演 agent（role）**：策略懒生成扮演 agent（父 = **宿主**→级联回收、creator=parent 规则零例外——pilot 扮演 user0 的同构推广）；worker（summarizer 规格硬编码于策略模块，决策 C）经邮局正规往返 + 回信配对 `waitForReply`（信箱兑现原语），用完 terminate 归档；递归终止双保险（worker/role = none/panel）。
   - 策略专有动作通道：`pilot.runContextAction` / internal 工具 `context_apply`（仅自身或祖先）/ CLI `/compact` / webui `/api/context_action`。
   - **`.stem/context/*.ts` 用户策略加载**（init 管线，与 `.stem/tool/` 同构、同名覆盖内置）——"让 agent 自己写上下文策略"的通路。删 ContextProfile 死代码。
3. **S3′ 配置对象化（43ea41b）**：顶层 `permission` 迁移为 **`user` 完整 agent 类对象**（description/systemPrompt/permission/contextStrategy/model/sendCountdown——元 agent 人格进配置文件；permission 整表替换内置 **DEFAULT_USER_TOOLS**，含 access_reply 根义务——修复 user0 零工具死锁 B3）；新增 `maxSteps` + `context` 块（window/compact 全参数 → ContextSettings 逐项兜底映射）；agentParse **自由式 frontmatter**（context_strategy/model 已知键 + 未知键透传 custom）；ConfigPaths.strategyDir、strategies 镜像、CLI /config 更新。

### 验证

- 193/193 测试（本轮 +37：台账语义矩阵 11 / ask 总线重写 10 / classic compact 单测 6 / 策略框架集成 5 / user 类 3 / 配置解析重写 +4 / init 策略加载 4 / system user 装配 1 / 手动动作 1 等）；typecheck 0 错误；存量 156 测试语义迁移后全绿（行为兼容硬验收）。
- webui 双生命周期冒烟（真实 `.stem` 模板配置含 user/context 块）：首启自动 simple-chat + 手动实例对话落库 → 重启同 id 恢复、holding→interrupted 归一 ✔。

### 已知边界

- grant 不入库（纯派生）：重启后策略 role/worker 重新懒生成并复绑；`always` 豁免不跨进程。
- compact 的 role agent 会作为"活跃子"参与销毁权判定：terminate 宿主须 `recursive`（子树级联含 role——设计内行为，UI 折叠显示可后补）。
- worker 回信走正规投递会进 role 信箱（审计留痕），重启后 role 按 classRef 找回复用（幂等）。
- 权限语义整体收紧（B1 落地）：模板未声明的工具现在真不可见——示例配置已随之扩写（tmp/.stem user.permission）。
- 策略模块跑在系统信任级（`.stem/context/` 与 `.stem/tool/` 同前提：用户主权模型，非沙箱）。

### 后续

- self_focus / ltm-stm-mix / coding-hybrid 策略（契约与插槽就绪，逐策略独立模块交付）。
- `agent_class_create` 落盘回写 `.stem/agent/*.md`（自我进化闭环）；benchmark 模块（评估→进化回路）。
- Docker 打包（node:24-slim 基像、tsx 移入 dependencies、/api/health）——按定稿在 v1.0 前执行。

## 阶段：bash 最小操作面 + extensions tool_set + 目录即真相 + OLED webui + Docker（S4，1.0 前置）

**日期**：2026-09-01

### 目标

用户规划：不采用扩展时，除系统工具外**只应有 bash** 供模型操作外部文件/系统。四方讨论冻结四决策：fs 五件套 = extension tool_set（config.extensions 选择、缺省 ["fs"] 保默认体验）；config 三镜像全删（目录即真相）；层级取**最小变体**（不动目录，extension 定义为 tool_set 包）；webui 采用 **OLED 友好主题**（纯黑 + 青绿运行色 + 品红介入色）。

### 完成内容

1. **S4.1 bash（9373dbc）**：`core/tools/bash.ts` = internal 工具 + `ShellRunner` 端口（core 零平台依赖，node child_process 实现驻 `shell/cli/bash.ts` 经 bootStem 注入，`shellRunner:false` 可关）。治理对齐 pi：**无 ask 无黑名单**——事故半径三机制（硬超时缺省 120s / stdout·stderr 各 50k 截断 / cwd 缺省项目根）+ 描述提示词分担（非交互式、专职工具优先、退出码非零非失败）；不给 shell = 白名单不列键。`config.bash{path,defaultTimeoutMs,maxOutputChars,cwd}`；DEFAULT_USER_TOOLS 内置 `bash:'allow'`。
2. **S4.2 目录即真相 + tool_set（4b44db6）**：三镜像（tools/agents/strategies）从 config 类型/解析/init 写回整体移除（已核实 agent_class_create 本就不落盘 → 镜像零信息量）；runInit 只在配置文件不存在时写默认模板、**此后纯只读永不回写**；orphan 检测随之消失。`config.extensions: string[]`（core 透传无感知；bootStem `TOOL_SETS` 清单解析，缺省 `["fs"]`、`[]` = 纯 bash、未知 id 告警跳过）；`user.permission`→`user.tools`、`.md` frontmatter `permission`→`tools`（与 AgentClass.tools 齐平，不留兼容读）；`.stem/tool/`→`.stem/tools/`。
3. **S4.3 webui（a23c8ac）**：OLED 主题（纯黑 #000、边框+留白分层禁灰底卡片、青绿=运行/主操作 + 品红=ask/interrupted/销毁、状态"字形+色+文字"三重编码）；header 动作补 compact/销毁（confirm+recursive，明示语料保留）；summary 归档渲染为分隔条、无效消息不显示但仓库保留；`/api/health`；绑定：裸机 127.0.0.1、容器 STEM_HOST=0.0.0.0。
4. **S4.4 Docker（25e987f）**：node:24-slim + 非 root + `/data` volume（配置自举 + SQLite）+ HEALTHCHECK（node 内置 fetch，slim 无 curl）；**tsx 移入 dependencies**（兑现"镜像勿按 devDependency 剔除"）；无 key 回落 mock 开箱可跑。

### 架构立场（本轮定形）

- **对外操作面 = bash 单点**；**容器即边界**（挂载 volume = 爆炸半径，不建议裸机暴露 webui）——bash 无 ask 与 Docker 发布同批落地、互为前提。
- **目录即真相**：`.stem/{tools,agent,context}/` 是唯一注册面，config 纯声明、init 纯只读（除首次自举）。
- extension 语义收敛为 tool_set 包；shell 保持"官方宿主 + 参考 UI"（最小变体，host/apps 重组推迟到真实需要时）。

### 验证

- 202/202 测试 + typecheck 0；真实 spawn 冒烟（超时强杀/截断路径/缺省 cwd）；extensions 三态冒烟（默认 fs / [] 纯 bash / 未知 id 容错）；webui 冒烟（health / send→mock 回复→context 落库往返 / OLED 令牌渲染 / 持久恢复 interrupted）。
- 镜像语义迁移踩点：`tools.get()` 未命中抛错而非返回 undefined（materialize 返回 ToolDefinition 用 `name` 字段——冒烟脚本首查 bash 误报即此因）。

### 遗留

- `agent_class_create` 类落盘回写 `.stem/agent/*.md`（镜像删除后此闭环更显紧迫）；`templates/` 下拉暂含 user 类实例化（平等化设计内，UI 折叠留后）。
- Docker 构建需 Windows 侧执行（本 WSL 未开 integration）；国内网络或需 registry mirror。

## 阶段：S5.1 族谱树重构 + S5.2 进化观测与书写（S5 前两批落地）

**日期**：2026-09-01 · 依据：`docs/evolution-plan.md` §3/§4（方案冻结件）

### 目标

用户裁决：dreaming/策略自调度延后，先实施**族谱树重构**（实例层派生事实门面合一）与**进化观测与书写**（1.0 人启动闭环的两翼——看得到日志、写得了基因）。

### 完成内容

1. **S5.1 族谱树门面（46bb227）**：`LineageTree` 从"纯关系视图"升级为三相合一——拓扑（原有，parentId 挂实例实时推导）+ **能力**（`attach/detach/replay + effectiveAccess/profileOf`；`AccessLedger` 降为树内部实现，算法与 11 例语义矩阵测试**原样随迁零改动**）+ **可见域**（新树谓词 `canReach` = 自身∨祖先代查）。kernel 四点（instantiate/registerRoot/restore/terminate）台账编排下沉为 attach/detach/replay，删除 `accessLedger` 公开字段；`context_*` 五工具 + `interruptAgent` 的"isAncestorOf+手动自身比较"散点全部收敛 canReach。红线守住：纯派生不入库、零运行时状态、零类层依赖。**行为兼容验收达成**：门面直测 +6，其余 202 例零修改全绿。
2. **S5.2 书写翼（efcd499）**：`init/agentSerialize.ts`（agentParse 逆函数）——往返律 `parse∘serialize ≡ id` 三例直测（全字段/最简类/文本级幂等），红线 = panel 类永不回写 + custom 已知键冲突拒绝 + 类名路径注入守卫（模型可控输入参与文件路径必须收紧）。`ClassStore` 端口（core 序列化、宿主 `ClassFs` IO，`bootStem` 经 nodeConfig bundle 注入，零平台依赖不破）：`agent_class_create` 改造为注册+落盘（新名 = 变体并存供 A/B 与回滚，同名撞 `template_exists`），新增 `agent_class_update`（同名覆盖；**tools patch 增量合并**——整表替换会静默丢键，restart e2e 当场暴露此陷阱后定案；逐键 `checkToolsConvergence` 序不升：deny 不可撤销、ask 不得移除人审闸、allow↔ignore 同级可见性自决、新键放行由台账兜底；panel/user 根类拒绝；**只影响后续实例**——已绑定档案物化于树不追改，防"改类即远程改现役"）。
3. **S5.2 观测翼（同批）**：`telemetry_query`（kind=internal、category=telemetry——ToolCategory 的 telemetry 位就此兑现）：可见域 = canReach（自身+后代、兄弟不可见、根天然全视，与 context_* 同一谓词零特权通道）；行式压缩（`时刻 | 类型 | 摘要`，摘要按类型取关键字段不 dump 大负载）+ 类型前缀通配 + 时间窗 + limit 截尾报总匹配。审计事件 `kernel.class.registered/updated`（persisted + agentId 发起者归属）；`eventInvolvesAgent` 导出为 agent 归属判定唯一实现（补 context.compacted 与 class 事件映射——查询与观测共用一份映射防口径漂移）。`DEFAULT_USER_TOOLS` + `telemetry_query:'allow'` + `agent_class_update:'ask'`，tmp 演示配置镜像。
4. **重启进化 e2e（classRestart.test）**：ask 挂起 → 根经 `access_reply` 答复（always 的 **per-(agent,key) 备忘**语义顺带实弹：create 的豁免不覆盖 update 键）→ 兑现落盘 → dispose → 全新 `createStemSystem` 从同一文件表 runInit 装载 → 进化类携带新基因出生 + 实例化即生效。目录即真相（S4.2）至此完成"写侧闭环"。

### 架构立场（本轮定形）

- **族谱树 = 实例层派生事实唯一门面**："agent 实例树"仅是概念别名（用户裁决保留族谱命名）；一切"谁够得着谁/谁有什么能力"的问题都问树，kernel 回归接线+生命周期。
- **类文件是基因唯一持久载体**：进化 = 写文件（模型经 ask 门授权书写）+ 重启装载 + 新实例出生；个体一生不换心脏（策略/权限物化不可追改）。
- **观测与书写同权治理**：telemetry 走树可见域、类书写走 ask+收敛校验——无评估特权通道，"看"和"改"都是族谱位置的函数。

### 验证

237/237 测试（+29：序列化 7/书写面 15/观测 6/重启 e2e 1）+ typecheck 0 + webui 冒烟（health/持久恢复）。收敛校验与"扩张整单拒绝（零注册表变更零落盘）"矩阵全绿；e2e 曾暴露 update 全表替换丢键陷阱 → 改增量合并（设计修正记录进方案勘误节）。

### 遗留

- S5.3（策略自调度薄层）/ S5.4（ltm-stm-mix dreaming）按方案延后；benchmark/fitness 后置。
- 待拍板三点（睡眠留痕/心跳 LLM 轮/进化熔断）+ #4 已裁决（见方案 §8 实施记录）。
- `agent_class_update` 对 custom 键的 patch 语义未开放（文件级 custom 由用户直写）；类删除（remove）刻意不给模型——退场权归用户。

### 追记：Docker Desktop 实跑部署（S5 同日）——三处真实缺陷暴露即修

首次真正跑通镜像构建与运行（此前 S4.4 只静态审查未实跑，WSL 集成当时未开）。**流程**：Docker Desktop 开启本发行版 WSL 集成 → docker.io 直连失败（国内网络）→ `docker.m.daocloud.io` pull 成功 → `docker tag` 回原名（不改 Dockerfile）→ build/run/冒烟。

1. **Dockerfile 权限 bug**：`USER node` 后 `mkdir /data` 必失败（根目录普通用户无写权）——改为 root 先建 + `chown node:node` 再切用户；volume 首启属主随之正确。
2. **mockSse 错位**：无 key 回落 mock 是发布形态的**产品能力**，文件却住 `test-support/`（镜像不 COPY）→ 容器起不来（ERR_MODULE_NOT_FOUND）。正身迁 `shell/cli/mockSse.ts`（node:http 宿主层归属），`test-support/mockSse.ts` 留兼容再导出（core 单测引用面不动）。
3. **webui 错误序列化**：core 判别联合对象经 `String(e)` 变 `[object Object]`（部署排障被误导）→ `JSON.stringify` 保真。
4. 冒烟环境噪音一枚（非产品 bug）：早前 smoke 用子 shell 起 webui、`kill` 只杀了包装进程，两个僵尸占 4321 劫持 curl——**webui smoke 脚本教训：拿 `$!` 要 kill 孙进程或改 `exec`/进程组**。

**验收**：`-p 4321:4321 -v stem-data:/data` 起容器 → HEALTHCHECK green / send→mock 回复双轮 / `/data/.stem/` 自举 config+stem.db（messages 7 行）/ **docker restart 后 agents+消息全恢复**（pblj→interrupted 归一化 ✓）/ 日志零 error。237 测试 + typecheck 0 回归不破。

---

## 阶段：S6 批 1 —— 零兜底网关、config 全量有效、模型入族谱、空间归位（2026-09-01）

**执行依据**：`docs/s6-plan.md`（R1-R14 定稿）。一个功能 commit 覆盖 1a（网关/配置）+ 1b（模型配置相）+ 1c（空间归位）。

### 完成内容

1. **网关泛化（1a）**：`git mv opencodeLlm.ts → openaiCompatible.ts`——一切 OpenAI 兼容端点（opencode zen / dashscope compatible-mode / deepseek / 本地 mock）共用一个实现。**代码零端点常量、零 process.env 读取**（core 红线种子 #8 清零）：`{ baseUrl(必填), apiKey?, models?, requestTimeoutMs?, fetch? }` 全由宿主传入，POST `{base_url}/chat/completions`、请求恒发裸模型 id（provider 是路由概念不入协议体）；apiKey 缺省 = 匿名端点不发 Authorization（R13 本地/测试端点自洽）；models 白名单在请求前硬拦（`model_not_allowed`，不触网）。错误 union 新增 `provider_unwired` / `model_not_allowed`。
2. **config 全量有效原则（R12，1a）**：顶层 `model`、`FALLBACK_MODEL`、`Kernel/Runtime.defaultModel` 三层兜底整体拆除（含 Runtime 的 `templates` 依赖——它只为查 model 而存在，随单层链殉葬）。`providers` 注册表入型（块内 snake_case：`base_url` 必填 http(s) / `key_env` 变量名 / `models` 白名单），config 内模型引用（user.model / summarizeModel）与注册表交叉对拍（provider 必注册、白名单必命中）。**未知顶层键 boot fail-fast**（废除 S4.2 静默丢弃兼容；`model/tools/agents/strategies` 历史键给专门迁移指路文案），`custom` 成唯一扩展位。**首启模板迁 `config/defaults.ts`**（R2"唯一预设 opencode-go"降格为模板数据 + `defaultStemConfig()` 兼作文件缺失时的内存等效，杜绝"无配置装配无锚系统"）。
3. **家学硬校验（R12）**：`config.user.model` = 全体解析链链尾锚点，`createStemSystem` 缺失即抛（可行动文案直指 stem.jsonc）。
4. **模型入族谱（R6/R7/R14，1b）**：LineageTree 能力相新增**模型配置相**——`attach` 携带 kernel 算好的原始层 `{instanceModel, classModel, snapshot}`（树零类层红线不破），按**显式 > 类基因 > 出生快照 > 父继承 > 家学**物化 `ModelBinding{ref, origin}`（home 值随链下传不改标 = git-blame 语义）；`modelOf/setModel(不级联)/nodeConfigOf` 门面化，replay 与台账同拓拓扑序。Runtime 经 `resolveModel` 端口取本轮快照（setModel 下轮送信自然生效；无锚防御 = interrupted + `model_unresolved` 日志点名）。`AgentInstance.model`（显式层）随实例行 JSON 持久（零 schema 迁移）；新工具 **`agent_set_model`**（internal 缺省 ignore、canReach 可见域、`kernel.model.set` 审计事件 + telemetry 行式）+ `agent_instantiate.model` 参 + `pilot.setModel` + `/api/set_model`；`agent_inspect` 出示整份 NodeConfig（origin 四态中文谱系）。`summarizeModel` 死键接线（审计发现只解析不消费——升为摘要 worker 类的类基因位，缺省走出生链继承宿主）。
5. **宿主路由（R1，1a）**：`buildGateway(config, env)` 逐 provider 装配 + `req.model.provider` 路由门面，两段式 = key_env 未命中启动 warn 点名（不印值）+ 用到才硬错（文案指到 config 行/env 名）。**产品路径 mock 回落删除**（种子 #2 兑现：creator/tool 剧情脚本随之下线，离线冒烟用 mockSse-as-匿名-provider 通道——gateway.test 即示范）。
6. **空间归位（R3/R11/R5，1c）**：**根伪空间 bug 修**——`registerRootAgent` 改挂真实项目 space（`KernelOptions.project` 自 `paths.projectRoot` 下传；spaces 表新卷只有一行）；老卷 **sqlite v1→v2 归并迁移**（`createSqliteStateStore(file, project)`：伪行+真空间并存 → 实例并真空间删伪行；只有伪行 → 直接转正；JSON1 就地改写，幂等）。CLI **`stem [path]`** 位置参数（> `STEM_PROJECT_ROOT` > cwd，opencode-style）、webui 默认 cwd（原 `cwd/tmp` 判死，`npm run shell -- tmp` 跑演示空间）；`.gitignore` 加 `/.stem/`。单实例 = 约定非机制（无锁，R5 裁决）。

### 实施偏差（不回改方案，此案在册）

- **新增 `modelSnapshot` 持久层**（计划未明写的语义洞，restart e2e 当场暴露）："改父不动子（族规=出生快照）"在纯再解析的 replay 下会跨重启失效（父亲行改后，无显式子女重启即被"追改"）→ attach 落在 inherited/home 层时 kernel 把出生解析写进行 JSON（根 home 层不写——家学 = config 本体，编辑重启应在根生效；此边界与 S5.2"改类只影响后续实例"同构）。origin 谱系自此跨重启保真。
- `AgentInstancePatch` 未扩 model（takeover 保持 displayName 专职；改模型走显式 `setModel` 端口，语义分界干净）。

### 验证

- **264/264 测试**（+25：providers 校验矩阵×10、路由两段式×4、快照层×2、模型工具面×5、sqlite v2×2、首启模板×2）+ typecheck 0。
- **端到端冒烟（mockSse 匿名 provider，真 HTTP+SSE+sqlite）**：首启接通 → 双轮送达 → **spaces 表单行断言**（伪空间回归）→ 快照随行持久 → 重启族谱/档案/续谈全量恢复 → setModel 落盘 → **无 key 两段式**（boot warn 点名 + 首封信 interrupted+provider_unwired 入账，系统照常启动）。
- **webui 端点冒烟**：health `providers: mock` / instantiate / set_model（origin=explicit）/ 非法模型串 400 文案。
- **ALIBABA 实弹**：轮 1 真对话（qwen3.8-flash，tok 142/52，reasoning 正常）；会话中 setModel→`qwen3.7-plus`/`qwen3.8-max` 均撞 dashscope `AllocationQuota.FreeTierOnly`（免费额度耗尽，非代码问题）——**切换生效由错误本身证明**（quota 报错按模型返回），错误被分类捕获走 halt→interrupted、消息闭合，零兜底错误路径实战合规；`模型显式出生 + setModel 后双轮成功续谈`（flash→flash）全链路无中断。max/plus 恢复付费或换 key 后可复跑 A/B。

### 架构立场（本批定形）

- **模型与权限同门面**：R6"全参数统一解析律"落地——tools（收敛格代数）与 model（取先链）都是族谱位置的函数，树物化、kernel 算输入、工具走 canReach，无第二套通道。
- **config = 真相的完整兑现**：无兜底常量、无静默丢弃、无死键（summarizeModel 补全消费位）；首启模板是数据不是代码。
- **空间语义终极化**：`.stem` = 世界（一进程一空间一库）；opencode-style `stem [path]`；单实例靠约定。

---

## 阶段：S6 批 2 —— 第一视角 git 风 WebUI（2026-09-02）

**执行依据**：`docs/s6-plan.md` §2；批 1（a237a50）的 /api/set_model、model+origin 数据面在此消费。

### 完成内容

1. **view.js 视图纯函数核心（新文件，零 DOM 双端共用）**：浏览器 `<script type="module">` import + server `/view.js` 静态路由（text/javascript）+ node:test 直测（view.d.ts 供 TS 严格面）。四组纯函数——
   - **字形表（R8）**：状态 静/思/持/断 + 动作 停/缩/毁/生/送/审/工/摘/我/模，验收矩阵含"全部单汉字"实现级断言；三态视觉 token `.ico[data-state]`：off=斜纹遮罩 / ready=白边框 / active=荧光（accent 光晕），旧几何字符 ⏸✕○◐▲▍⚙⊂⚠ 全清零，流式光标改 border-right 动画；
   - **routeLetters（R9 第一视角）**：信箱按 `<sender>` 反查归位——常规窗"我（根来信）右侧/兄弟来信左侧/assistant 它自己"；根窗反相（assistant=人类经 pilot 的发言右侧、user=后代回信左侧）；access_request 不占正文流（归「审」面板）；summary 出「摘」中缝、tool 出「工」行、invalid（compact 归档）跳过——"user0 退出会话流"由数据归位实现，无 agent 特判；
   - **computeTreeRows（git 风侧栏）**：DFS 先序行序 + 泳道列（lane=深度）+ 背景竖线 passThrough（**"兄续弟断"**：有下一兄弟的节点其泳道贯穿 (自身行, 兄弟行) 开区间——纯函数测试逮到初版两处语义 bug【竖线错漏延伸段/子行断点】后改为此算法）；溢出折叠：同父 >6 → 留 5 + 「…+n 兄弟（共 m 实例）」、深 >4 → 「…+n 后代」；顶层支系双色轮替、根行「我」灰显空心点；SVG 每行一段（lines + path join + circle）；
   - **deriveActions（seed #5 消判）**：按钮三态全部由族谱事实驱动——根（parentId=null）毁/停/缩/送遮罩（无祖先可销毁/面板无 LLM 轮/非对话窗口），普通后代送=荧光；UI 里**不再出现任何 user0 字符串判断**。
2. **server.ts**：删首启自动 simple-chat 的 demo bootstrap（**seed #1 清**，空桌引导接管）；`/api/agents` 增 `lastPrompt`（剥 `<sender>` 的最近 user 信，UI truncate 30）；新 `/api/models`（providers 白名单展开候选，models 空 → openEnded）；`/view.js` 静态路由（sendHtml 泛化 sendStatic）。
3. **index.html 重写**：侧栏=树（行=id · 最近任务 · 状态字，点行直达"树即列表"）；header 模型行（值下拉即切 `/api/set_model` + origin 徽标 显式/类基因/父继承/家学）；composer 空桌引导 + 选中才荧光"送"；ask=「审」面板；创建盒「生」。

### 验证

- **278/278 测试**（+14：view.js 纯函数矩阵——字形/剥壳截断/routeLetters 三态归位/树行序·穿越线·双折叠·多根防御/动作三态）+ typecheck 0。
- **webui 端点冒烟（mockSse 匿名 provider 真起服务）**：`/view.js` 200 text/javascript；index 零几何字形残留（正则断言）；**空桌**（首启仅 user0，不再自动造对话对象）；`/api/models` 候选展开；instantiate 双后代 → lastPrompt/model+home 徽标 → setModel=explicit → 换模续谈送达。
- 视觉级（泳道绘制观感/三态对比度）属浏览器人工验收项，纯函数层已把可测语义全部锁死。

### 追记：S6 批 1+2 合体的 Docker 老卷实跑（2026-09-02）

新镜像直接对 **S5 时代旧卷 `stem-data`** 开火（v1 库 + 含顶层 `model` 的旧 config——正是升级验收场景）：

1. **R12 实弹**：旧 config 起容即拒（`未知配置键 "model"：顶层 model 已拆除…家学锚点 = user.model`，退出干净无栈噪）；按文案迁移（providers.alibaba=dashscope compatible-mode + key_env + 白名单 / user.model 家学）后正常启动。
2. **v2 归并迁移（真卷）**：`user_version 1→2`，spaces 双行（伪 `user0` + 真 `/data`）归并为单行 space-2(/data)，user0/i8di 实例行 spaceId 收敛，10 条历史语料保留。
3. **两段式反证**：`gateway: providers: alibaba`（key 命中零告警；密钥仅 `-e ALIBABA_API_KEY` 透传 env 名，命令行/文件零明文）。
4. **老 agent 复活续谈**：i8di（S5 era demo，重启恢复 interrupted→持话）真网关回"好你"——正确倒读一周前语境，语料连续性实证。
5. **模型三环**：新后代家学出生(home) → set_model → 徽标 explicit → **docker restart 后 explicit 仍随实例行存活**（s6-plan 批 2 验收项"setModel 值重建后存活"）+ turns 计数器续接 + 零重放 + 重启后续答"一"。

容器现行（http://localhost:4321）：新 WebUI（族谱侧栏/第一视角/模型行）直接可浏览。踩坑一枚（非产品）：冒烟脚本按不存在的 `m.at` 字段判新回复致假阴性——webui context 端点无 at 字段，判"新回复"应以消息数增长为准。

## 阶段：S7 批 1 —— 三维资源矩阵（tools/agent/context × internal/extension/custom）+ skill 机制废除（2026-09-02）

**方案**：`s7-plan.md`（D1-D9 裁决，本轮不含 S5.3 调度/dreaming）。本批 = T1（矩阵落地 + skill 泛化 + 清理）。

### 完成内容

- **装载律统一**：`runInit` 从"三目录平铺扫描"泛化为**三类资源 × 两来源层矩阵**——extension 层按 `config.extensions.{tools,agent,context}` 分键点名从宿主注入的 `extensionRoots` 装载（目录形态唯一 `<名>/<名>.<ext>`）；custom 层扫 `.stem/`（平铺兼容 + 目录形态优先）。装载序 internal → extension → custom，**后层同名 replace 覆盖**（`ToolCapabilityRegistry.register`/`TemplateRegistry.register` 新增 `{replace}` 选项，代码注册路径缺省仍查重防呆）。extension 点名缺失 = `extension_entry_missing` issue（fail-soft）。
- **工具三分类更名**：`ToolKind = internal | shell | user` → `internal | extension | custom`（registry 默认权限判定只依赖 internal，其余照常落 ask，无逻辑变动）。
- **fs 五件套迁居**：`shell/cli/tools/` → `extension/tools/{read,write,edit,grep,glob}/<同名>.ts` + `_lib/`（共享 fs-util + 集成测试 `tools.test.ts` 随行）。**实施中暴露的真实缺口**：extension 工具需空间根做路径沙箱而装载时 core 才有 projectRoot——收敛为"**入口 default 允许工厂形态** `(projectRoot) => ToolCapability`"，loader 注入（读工厂签名零特判，custom 层维持纯对象约定）。
- **skill 机制整体拆除（D1 最彻底案：系统零 skill 概念）**：删 `SkillRegistry.ts` + `skill.ts` + ContextManager `<available_skills>` manifest 注入链 + `skillDirOf` 装配（净减 ~150 行 + 一条 system 组装通路）；`ToolInitContext` 去 skill 专用形 → 通用 `{fs, projectRoot, log}`。兼容双路：① `.stem/tools/skill/skill.ts` custom 装载器（目录形态约定首个实战：入口 + `<技能名>/SKILL.md` 资产同目录自由放置；空参列清单/传名载正文——渐进披露后移一轮，用户裁决"值得"）+ tmp 空间装样例技能一枚；② LLM 手动转化（SKILL.md → 真工具/类人格，文档使用模式零机制）。`DEFAULT_USER_TOOLS` 加 `skill: 'allow'`（约定 id，未安装 = 键空转）。
- **agent 类三分层归位**：内置示例类 `templates/{SimpleChat,Coder}.json` 从 Kernel 静态 import 迁 `src/core/kernel/builtin/`（internal 层=core 自带；根目录 templates/ 与 tsconfig include、Dockerfile COPY 同步撤）；**`demoTemplatesHook` 整体删除**（tool-assistant 引用的 oc_*/bus_* 混合死配置，S5 拆迁遗留；CLI 内联 oc_* 三演示工具同删），creator 调度者示例改写活工具清单后落 `extension/agent/creator/creator.md` = extension 类层首住户（T4 用例 5 载体）。
- **config**：`extensions` 从字符串数组 → 分键对象（validateExtensions 重写：键名枚举 + 元素校验 + 旧数组形态 fail-fast 指路迁移文案）；`DEFAULT_CONFIG_TEXT` 模板 extensions 转为注释示例（缺省行为 core 兜底，模板更简）。缺省表 `DEFAULT_EXTENSION_TOOLS` = fs 五件套（D9）。
- **周边治理**：`tmp/.stem` 配置迁移新形态（+creator 点名 +skill 键）；opencode 参考工具（含明文 dashscope key 的 websearch/deepsearch）挪出扫描目录 `tmp/ref-tools/` + .gitignore 锚定（**该 key 随旧提交已入 git 历史——控制台轮换为硬性事项**，本轮实测确认）；`user_hello.ts` 注释同步。

### 验证

- `typecheck` 0；`npm test` **277/277**（净增 13 用例：extension 点名装载/缺失 issue/agent·context 类目录点名/宿主无根零 issue/平铺+目录双形态与优先序/replace 覆盖律/工厂入口注入/分键 config 校验 + 旧数组拒启/D9 缺省表锚点）。
- 真装配冒烟（bootStem tmp 纯内存）：三源工具面 21 internal + **5 extension**（工厂收根 + 沙箱行为正确反证）+ 2 custom；`skill()` 清单/`skill({name})` 正文实开；模板五连 = user + simple-chat/coder(internal) + creator(extension 点名) + user-reviewer(custom) 三层齐。
- 踩坑两枚：① pkill -f 自噬（模式串在当前命令行内，连坐自家 shell）——改用 `[r]` 正则拆分或精确 pid；② fake 目录发现函数返回全路径后又拼一次前缀（双重拼接致 packed 探测全灭），REPL 隔离复现 30 秒定位——**测试 fake 与宿主实现必须同语义**的又一次实证。


## 阶段：websearch/webfetch extension 工具（对外信息面开闸，2026-09-02）

矩阵落地后的首批第三方资源，dogfood `extension/tools/<名>/<名>.ts` 目录形态与工厂入口约定。

- **websearch**（`dashscopeMcp.ts` 专用脚本 + 入口）：百炼 WebSearch MCP（JSON-RPC：initialize 进程内幂等握手 → `tools/call bailian_web_search`），结果格式化编号列表（标题/URL/来源/摘要，snippet 500 字符收敛）。**密钥治理**：`ALIBABA_API_KEY` env 晚绑定读取（与 providers.alibaba 同账号同变量），未配置 = 可行动错误文本回模型（fail-soft 不抛栈）；count 夹取 [1,20]、30s 超时。
- **webfetch**（`htmlExtract.ts` 纯函数 + 入口）：零依赖 HTML→text/markdown 抽取（噪声块剥离/块级换行/实体解码/markdown 近似转换），三格式参数 + Accept 协商（markdown 请求优先原生直出）、手动重定向限 5 跳、4MB 拉取上限 + maxChars 截断（默认 20k 上限 100k）、非文本 content-type 拒回、伪协议 url 校验。
- **权限与启用**：与 bash 同"对外操作面"权级（无 ask 无黑名单，超时/截断限事故半径）——`DEFAULT_USER_TOOLS` 加 `websearch/webfetch` allow（未安装 = 键空转）；tmp 空间 `extensions.tools` 点名 + user0 整表同步。
- **可测性设计**：transport 层 fetch 作构造 deps 注入（假帧夹具测 MCP 握手序/错误分层/参数夹取），零全局 mock——extension 工具遵守与 core 相同的"纯逻辑抽纯函数"纪律。
- **验证**：typecheck 0 + 293/293（新 16 用例）+ **真端点实测**：百炼 MCP 出带来源编号结果、example.com markdown 转换干净（key 经 powershell 读 Windows 用户 env，只进子进程，零打印零落盘）。


## 阶段：行级 token 真实计量（累积差分归位，2026-09-02）

估算口径（chars/4）全面升级为网关实测口径；**两标记分工定稿：tag=是什么（strategy 语义标签）、tokens=多大（计量，真实优先估算兜底，来源不设第三标记）**。

- **通道**：gateway usage 事件本已存在（openaiCompatible `include_usage`、FakeGateway 可注入），缺口 = Runtime 只把 usage 折进 totalCost 未落行。补三处：① `Repository.setTokens(agentId, id, tokens)` 静默修订口（不触发 onChange——token 不改上下文形状；PersistedRepository 写穿，DB 行 JSON 整体序列化零 schema 迁移）；② `ContextManager.attributeUsage(agentId, usage)` **累积差分归位**：Δ = input(n) − input(n−1) − output(n−1) = 两轮之间新行（tool/user）的真实增量，按估算占比分摊、末行吸收凑整；assistant 行在 append 时**直记** output（`appendHistory` opts 化 `{tag?, tokens?}`，7 调用点兼容）；③ Runtime 每 step usage 抵达后接线。
- **护栏三件套**：首轮只记基线（整段 prompt 含 schemas/system 无行级可分性，估算保留）；差分非正（compact 重组跳变）该批回落估算；基线纯内存 Map——重启/compact 后首轮重记自愈，零持久化负担。
- **红利自动生效**：compact threshold（estimatedTokens 求和读行 tokens）与 `context_overview`/webui `/context`（条目新增 tokens 字段）随真实口径升级；totalCost 通道不变（既有 estimateCost(usage) 语义即真实）。
- **验证**：297/297（新 4 用例：output 直记/差分归位/多行占比分摊+和守恒/负差护栏；persisted setTokens 写穿+恢复往返）；**真网关实弹**（dashscope qwen3.8-flash 双轮）：usage [142/27, 174/15] → assistant 行 27·15 直记、第二轮 user 行差分落 5（估算口径 12，真实口径各归其位），system 首轮基线保持 52≈54 估算不动。
- 踩坑记：首轮冒烟"差分未归位"实为**验证脚本竞态**（发消息后 status 仍处上轮 holding 即退出轮询），产品行为正确——脚本先等进 thinking 再等出 thinking 复测即中。


## 阶段：空间仪表盘 shell（法医/管理员视图，v1.0 前可观测性补齐，2026-09-02）

- **定位裁决**（与 WebUI"并列但不冲突"的解法）：不侵入运行进程、不造第二套清册——个体层同步 write-through 使 **DB 行即运行态实时镜像**（只读直查得族谱/token/语料近实时全量）；资源清单 = `bootStem({stateStore:false})` **纯内存标本装配**的真实结果（矩阵三态 + materialize(user0) 生效可见集 + 家学/providers 密钥状态 + init issues），零 DB 触碰零 LLM 成本。
- **数据层**（db.ts）：summary 四卡（语料/token 双口径/实例状态/DB 与 schema）+ dashAgents（窗口函数取最新 user 信剥 sender 戳，行序数据喂 view.js computeTreeRows）+ tokenStats（byAgent 角色堆叠/tag 分项/byDay 桶）+ 语料分页 + 原表 JSON pretty。清理（cleanup.ts）：孤儿箱 GC / terminated 语料 GC（墓碑保留）/ 定点 purge（非 terminated 默认拒绝、force 自担）/ VACUUM（freelist×page_size 估计）——唯一写通道：`--allow-write` 进程姿态 + confirm 双确认，**不假装检测并发实例**（无锁是既定约定，知情权交操作者）。
- **前端**：OLED 同设计语言六页签（族谱缩进树/token 账目/资源清单/语料/原表/清理），复用 view.js 纯函数核心（ES module 双端共用兑现设计初衷），手写 SVG 账目条形（依赖政策本轮放开，工程选择仍自包含：无构建链 + 无 CDN 网络风险）。
- **验证**：300/300（dashboard 3 用例：真 SQLite 全查询面/清理三门禁/真标本三态装配）+ **双服务并开实跑**（4321+4421 同 tmp 空间互不干扰）：账目精确（1sif system 行 52 = T3 直记真实值）、extension 7 件（五件套+web 两件）全列、类五枚分层无误（creator=extension、user-reviewer=custom）、只读门禁 403 实弹、user0 无 system 行正确（空人格不落行）。
- 踩坑三枚：`AS all` SQLite 保留字（syntax error near "all"）；窗口 rn=1 是尾行非"尾 user 行"（role 过滤须进分区前）；工具会话 SIGKILL 连坐进程组——冒烟常驻服务需 setsid 脱组。


## 阶段：v1.0 初步测试——机制可行性三档五脚本（2026-09-02）

用户裁决把全量验收先降维为**机制可行性**（验证各模块机制都能正常工作，不追指标）。测试脚本固化于 `test/feasibility/`（`npm run test:feas` 跑离线三档，在线两档需 `ALIBABA_API_KEY`）。

- **档位与结果**：offline1（mockSse 匿名 provider 真宿主装配，29✔）= 装配全链/端到端回信归位/status 事件/token usage 直记/ask 消息化→根答复→类落盘/bash allow 执行/模型四级+blame 语义/home 下传保持/setModel 不级联/重启恢复七面；offline2（compact 9✔）= 摘要 worker 正规往返/归档可逆/turnCount 续接/手动动作面/面板零请求；online（真网关 11✔）= 模型自发 tool_call→bash→回注闭合/websearch+webfetch 实弹/真 LLM 触发 ask→审批→落盘/telemetry 观测/真实 compact；http（双服务 10✔）= SSE/真轮 HTTP 面/跨进程 DB 镜像/门禁 403/terminate 收敛。
- **P0 bug（真网关挖出，单测从未见过）**：dashscope qwen3.8-flash 流式 tool_calls **尾分片携带 `id:""`**，openaiCompatible 解析器 `typeof tc.id==='string'` 无条件覆盖 → 首片真 id 被抹 → flush 期 `!call.id` 全跳 → **工具链整体静默失效**（finish reason 正常、假绿极隐蔽：assistant 空 content + 正常闭合）。单测 mock 尾片无 id 键恰漏此形状。修复 = 空串不覆盖 + dashscope 实测形状回归用例（reasoning_content 混片一并锁定）。**教训：可行性测试必须真端点——自造 mock 会精确隐藏它没见过的形状**。
- **设计事实核定（修测试预期）**：user0 根 = `assemble:false` 面板接线（kernel 级，与类 panel 字段并行的根特判），**永不跑 LLM 轮**——一切模型轮可行性验证的正确目标是子实例；「给 user0 自发消息跑轮」的用例设计是错的（test-plan 用例表按此校准）。
- **仪表盘策略维度补全**：inventory 标本此前根本没采策略面（"Strategy 列表为空"实为观测面缺维，非注册丢失）——补 `strategies` 字段（注册表实况 + process/actions 能力面 + 层判定：内置集从 createBuiltinStrategyRegistry 派生不硬编码）+ 前端清单表；测试断言 classic/none 在列。
- **待裁决的设计精髓问题**（记录不擅动）：① `builtin/Coder.json`/`SimpleChat.json` 系 S2 demo 遗留赖在 internal 层（违反"internal=最小系统"），tmp `user-reviewer.md` 同类；② access_request 消息 metadata 仅 `{tool:id}` **不带申请实参**——根审批"盲批"（风险恰在参数里：bash 命令行/类内容）；③ `shell/cli/main.ts` 头注释旧叙事（"临时面板/bus.send 自动寄信"）+ 绕 pilot 直连 kernel 面（`access.reply`/`instantiateAgent`），属叙述债与原则 4 小偏离。

## 阶段：internal 类层净化 + 文档纪律重构（contributor.md 归口）

- **internal 类层清账**：退役 S2 时代 demo 遗留（`builtin/SimpleChat.json`/`Coder.json` 与 tmp 空间 `user-reviewer.md`），立 **`Assistant.json` 占位类**——不写 tools 键（undefined = 完整继承父生效档案）、不设 model（落四级解析链）、systemPrompt `You are a helpful assistant.`：internal 只保底一张白纸，示例性角色归 extension/custom 层。连带：`AgentClass.tools` 类型可选化（`checkToolsConvergence` 对继承形无类层基线放行——扩张真实兜底在台账物化；类清单展示区分 `inherit` 与封闭 `-`）、CLI 默认对话目标与 harness 默认类、封闭语义测试位（tools={} 三处）改局部自定义 closed 类、tokenUsage 的 coder 本为局部 register 免疫。typecheck 0 + 301/301 + 可行性离线双档 29+9 绿。
- 离线档 2 本轮暴露两枚测试数据脆弱点（修正入档 contributor §6.3）：compact 检查点在"下一封 user 信抵达"，两轮消息无触发时机——测试需第三轮探针；mock 固定 `prompt_tokens` 令差分恒负命中回落护栏，通过与否系于估算基线（类 systemPrompt 一变即漂）——改阶梯递增走真实归位通道。
- **文档纪律重构（用户裁决：实况卷禁补丁式更新）**：新建 `docs/contributor.md` 归口工程纪律——§1 文档维护纪律（实况卷/历史卷二分、补丁式更新三禁 + 反例实录、改动→对拍表、事实优先）、§2-§5 分层/命名/错误/权限纪律（code-style 有效面按当前实况系统重写）、§6-§9 测试/提交/环境陷阱/自检清单。`docs/code-style.md` **退役删除**（VSCode 时代愿景卷：ContextAssetPool/MessageBus/adapters 组合根/oc_* 前缀/三态权限全废，补丁不可救）；AGENTS.md 整卷审视重写——修 panel 叙事（user0 面板性 = 根接线 `assemble:false`，`panel` 字段属策略 role，双入径写清；`Kernel/types.ts` 源码注释同步）、原则 1"无特判"精化为"无权限/身份特判（面板性系结构性身份）"、DEFAULT_USER_TOOLS 描述以表为准、extension 住户/结构树/快速命令（test:feas/run-docker）同步、三纪律段迁出留指针。`shell/cli/main.ts` 头注释旧叙事（bus.send/临时面板）改写为 pilot 扮演实况。

## 阶段：v1.0 全量验收（opencode 网关，2026-09-02）

15/16 用例过（16 docker 待点头），scenarios 场景 1-4 自检全落地。执行场 `test/space-v10/`（tmp 用户资产零触碰），操作件 `test/feasibility/tools/`（幂等 up.sh：双 fork 脱组 + 探活 + SSE 记录器自续），编排脚本 ask3/update2/tree3 归档 `test/feasibility/`。全程判据/证据/人工盯守记录见 docs/test-plan.md §6.2-6.3。

- **验收战果 = 五个实况 bug**（初步档 mock 与单测各自掩盖的面，全部真端网/真进程挖出）：dispose 与进行轮的退出竞态 + 12 处裸 void 孤儿 promise（P6，两度击落 webui）；轮账目引用直改不落库致重启清零（P9）；grep/bash 相对路径基准漂移（P5）；webui context 丢工具轨迹（P3）；实例化面板漏 birth 模型通道（P10）。逐一修复带回归锚，基线 310 单测 + 离线双档 + ask3/update2/tree3 全绿。
- **行为面收获**：tester 场景闭环教科书级（并行跑测定位→最小修复→复跑→诚实汇报，外部复核）；assistant 占位类乱走暴露"根表无 fs 键"设计事实（root 最小权限面——用例主体必须是专职工人，systemPrompt 纪律决定模型稳定性）；家学模型自然断流恰证中断自愈路径。
- 踩坑追加：`setsid` 内 npx 无 PATH（用绝对 node --import tsx）；up.sh 式脚本化起服务（操作命令与常驻彻底分离，混链必挂）；Windows npx 兜底乱码报错 = WSL PATH 未带；drvfs 偶发 NotFound 重试即复；dashboard messages 参数是 `archived=1`；terminate 竞态族（not_found/terminated）静默语义进 forget 白名单。
