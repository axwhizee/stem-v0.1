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
