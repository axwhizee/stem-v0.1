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
