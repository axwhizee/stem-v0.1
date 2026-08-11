# 决策与 API 铁律（已确认）

> 所有结论经 **VSCode 1.132.0 本地源码** 与 **opencode v1.18.15 源码** 核实。
> 核实基准：
> - VSCode：`Coding/Web/Projects/stem/reference/vscode-1.132.0`
> - opencode：`Coding/Web/Projects/stem/reference/le-opencode`（v1.18.15）
> - prompt-tsx：`microsoft/vscode-prompt-tsx` main（0.4.0-alpha.9）

---

## 一、战略决策

| # | 决策 | 内容 |
|---|---|---|
| D1 | 会话接管 | 走 **Path B**（`chatSessionsProvider` 原生接管）。`requestHandler` 拥有消息组装绝对控制权，VSCode 不对自有会话做有损压缩。 |
| D2 | 工具自研 | 放弃 `copilot_*` 黑盒，自研核心工具（`oc_read_file` / `oc_list_dir` / `oc_run_command`），经 `ToolCapabilityRegistry` 注册，完全掌控工具输出结构。 |
| D3 | 模型双轨 | **Spike 1 纯 BYOK 直连**（绕过 `request.model`，直接 fetch / vendored `@opencode-ai/llm`）；`registerLanguageModelChatProvider` 为后期增强。 |
| D4 | **Agent-Centric 架构** | 核心原子是 **AgentInstance**。一个 **Scheduler** 统一管理 Agent 创建、分工、上下文分配与 handoff。VSCode 的 ChatSession 降级为 UI 壳（任务流呈现）。 |
| D5 | **模块化 + 独立升级** | 层间只经接口通信。opencode Provider 层完全隔离在 `gateway/providers/`，接口固定，实现可随 opencode 变化独立替换。 |
| D6 | **自我进化（Telemetry）** | 独立日志模块贯穿全系统：记录 Agent 状态变化、API 请求记录、完整上下文 → 评估有效性 → 反馈调整策略。 |
| D7 | **Agent 模板化 + 用户主权** | 一切 Agent 都来自 **AgentClass（模板）**，用户自由创建/修改/删除 Agent 类并实例化。系统**绝不固定任何角色**，只提供示例模板（SimpleChat/Coder/Reviewer/Scheduler/Evolver）。简单对话 = 简单类 + 空上下文实例。 |
| D8 | **MessageBus（Agent IPC）** | Agent 间可相互对话/委托/handoff/广播（`agent_message` 等）。是 GAN 对抗、结对、公司模拟等场景的基础。暴露为工具 `agent_send_message`。 |
| D9 | **上下文管理工具化** | ContextAssetPool 对外暴露为工具（`context_query/write/create_index/summarize`），可被 Agent 调用。RAG/知识库等新技术作为可插拔存储后端接入。 |
| D10 | **元能力（系统管理工具）** | 按权限分级提供系统工具：normal=对话/上下文，advanced=实例创建/分配，admin=Agent 类创建/模块改造/全量日志。admin Agent（Evolver）可读日志→评估→创建新类/改模块，实现特修斯之船。 |
| D11 | **Core 完全解耦** | core（Layer 1–3）为**纯 TS 领域逻辑，零 VSCode 依赖**。所有平台能力（文件/终端/存储/UI/渲染）以接口暴露，由 `adapters/` 注入实现。为**从 VSCode 剥离独立项目**做准备——将来换宿主（CLI/Web/编辑器）只换 `adapters/`，core 原样带走。 |
| D12 | **AgentSpace（项目级 Agent 空间）** | 每个项目/工作区一个 AgentSpace（agent 列表 + 共享上下文）。切换项目 = 切换 AgentSpace，避免列表过大。UI 复用 session 模式但**一条目 = 一个 Agent 实例**；用户创建与调度创建的 Agent 本质相同、并列展示、可实时观察、可接管微调。 |

---

## 二、API 铁律（以 1.132.0 为准）

### 铁律 1：Session / 任务流标识
- 稳定版 `ChatRequest` **没有 `sessionId`**（字段：`prompt/command/references/toolReferences/toolInvocationToken/model`）。
- `chatSessionResource` 是 proposed `chatParticipantAdditions.d.ts:1074` 的 `LanguageModelToolInvocationStreamOptions` 字段，**不是** ChatRequest 字段。
- **正确取法**：`provideChatSessionContent(resource, ...)` 的 `resource` 闭包即任务流 URI。可选 fallback：`context.chatSessionContext?.chatSessionItem?.resource`。

### 铁律 2：Proposals
- 需要：`["chatSessionsProvider", "chatParticipantAdditions"]`。
- `chatSessionsProvider` → 会话壳（Controller / ContentProvider）。
- `chatParticipantAdditions` → `ChatResponseStream` 扩展（`push` / `beginToolInvocation` / `usage`）与 `ChatToolInvocationPart` / `ChatSubagentToolInvocationData`。
- `chatParticipantPrivate` 不需要。

### 铁律 3：Contributes（`contributes.chatSessions`）
1.132.0 schema 合法字段：`type / name / displayName / description / when / icon / order / alternativeIds / welcomeTitle / welcomeMessage / inputPlaceholder / capabilities.supportsFileAttachments / customAgentTarget`
- 必填：`type`、`name`、`displayName`、`description`（`chatSessions.contribution.ts:249`）。
- `name` 正则 `^[\w-]+$`（同文件 :79）。
- `customAgentTarget` 在 1.132.0 合法（:219-220，filtered mode picker），保留。
- 建议补：`welcomeTitle` / `welcomeMessage` / `inputPlaceholder` / `capabilities.supportsFileAttachments`。

### 铁律 4：注册顺序
1. `vscode.chat.createChatParticipant('opencode', handler)` → participant。
2. `vscode.chat.createChatSessionItemController('opencode', refreshHandler)`：
   - **第二参是函数** `(token: CancellationToken) => Thenable<void>`（**不是** provider 对象）。
   - `newChatSessionItemHandler = (context: { request: { prompt, command? }, inputState }, token) => Thenable<ChatSessionItem>`。
   - 会话列表经 `controller.items.add/replace/delete/get` 管理。
3. `vscode.chat.registerChatSessionContentProvider('opencode', provider, participant)`。

### 铁律 5：prompt-tsx 预算（BYOK 关键）
- 真实签名：`renderPrompt(ctor, props, endpoint: { modelMaxPromptTokens }, tokenizerMetadata: ITokenizer | LanguageModelChat, progress?, token?, mode?)`。
- **第三、四参必填，不存在默认 tokenizer**。BYOK 必须提供自有 `ITokenizer`。
- 选项名是 `modelMaxPromptTokens`（endpoint 内），没有 `maxPromptTokenCount`。
- 先 `renderPrompt` 第一道裁剪，再 `countTokens` 第二道防线（无损压缩触发点）。
- prompt-tsx `0.4.0-alpha.9`，核心导出在 **`@vscode/prompt-tsx/base`**。

### 铁律 6：Agent Loop 形态
- `requestHandler` 内 **while 循环**：LLM 返回 tool_call → 执行工具 → 结果入 Context → 下一轮，直到纯文本。
- 工具调用 UI：`stream.push(new ChatToolInvocationPart(toolName, toolCallId, errorMessage?))` + 重推 `enablePartialUpdate: true` 更新状态。流式版 `beginToolInvocation` / `updateToolInvocation`。
- 工具执行：`vscode.lm.invokeTool(name, { parameters, toolInvocationToken })`。
- **子 Agent 呈现**：`stream.push(new ChatToolInvocationPart('agent', callId, ...))` 且 `toolSpecificData = new ChatSubagentToolInvocationData(description, agentName, prompt, result)` —— **子 Agent 以"工具卡片"呈现**。
- 最终轮才 `stream.markdown(text)`；返回 `ChatResult`（usage/cost）。
- 维护 `LanguageModelChatMessage[]` 累加器：每轮追加 `assistant(toolCall)` + `user(toolResult)`。

### 铁律 7：Agent 系统自研（VSCode 无原生 agent 工具）
- 1.132.0 中**不存在 `runSubagent` 等原生 agent 工具**（已 grep）。
- Agent 系统（AgentClass / 实例 / MetaTools / dialogue）**全部自研**，位于 core/kernel 层。
- 子 Agent 执行 = 复用 `AgentRuntime` + 独立实例（不是新进程）。
- UI 呈现统一走 `ChatSubagentToolInvocationData`（挂载于 `ChatToolInvocationPart.toolSpecificData`）。
- 语义蓝本：opencode `task` 工具（深度限制、权限继承 denies、前台/后台执行）。

### 铁律 8：Agent 类权限分级（D7/D10）
- `normal`：业务工具 + `agent_send_message` + 上下文资产工具（对话/读资产）。
- `advanced`：+ `agent_instantiate` / `agent_terminate` / `handoff`（调度器）。
- `admin`：+ `agent_class_create` / `telemetry_read` / `module_evaluate` / `module_patch`（进化者）。
- 权限在 AgentClass 声明，实例化时用户确认，运行时可降级不可越权。

---

## 三、部署与环境
- **Insiders**（proposed API 仅存在于 Insiders）。
- 扩展 ID：`stem`。启动：`code-insiders . --enable-proposed-api=stem`，或 `argv.json` 配置。
- **激活事件**：`chatSessions` contribution 自动生成 `onChatSession:<type>`（`chatSessions.contribution.ts:252-256`），**`"activationEvents": []` 不是 bug**。`onStartupFinished` 为可选增强。
- `@types/vscode` 不含 proposed 类型：`@vscode/dts` 拉取 d.ts → `typings/` → tsconfig include。

---

## 四、opencode 侧复用清单

| 模块 | 用途 | 方式 |
|---|---|---|
| `@opencode-ai/llm` | 统一 LLM 客户端（协议/认证/SSE/重试/缓存） | vendoring（+ `@opencode-ai/schema`），依赖极轻、无 Bun 耦合 |
| `core/src/plugin/provider/opencode.ts` | go/zen 接入（device-flow OAuth + `/api/config`） | 重写 ~150 行（不搬 plugin 框架） |
| `opencode/src/auth/index.ts` | auth.json 读写 | 直接搬（几十行） |
| `core/src/util/token` | token 估算（tokenizer 参考） | 参考/复制 |
| `llm/src/schema/events.ts` | `LLMEvent` 状态机（loop 事件骨架） | 参考 |
| `llm/src/cache-policy.ts` | prompt cache 策略 | 参考 |
| `session/prompt/*.txt` + `agent.ts` | 系统提示模板 | 参考（不硬编码） |
| `core/src/system-context/` | ContextProfile 的代数设计参考 | 参考 |
| `packages/opencode/src/acp/` | ACP Agent 端——标准 Agent 行为基准 / 未来 sidecar | 对照基准 |

### opencode 同步策略（对应 D5）
- `@opencode-ai/llm` / `@opencode-ai/schema` 未发布 npm（private），vendoring + 定期同步。
- **隔离原则**：opencode 相关代码只存在于 `src/core/gateway/providers/opencodeLlm.ts` 一个模块；对外只暴露 `ModelGateway` 接口。opencode 升级 → 只改该模块 + 接口适配。
- 同步频率：跟随 release tag（v1.18.x），协议层 churn 低。
- 风险：`effect@4.0.0-beta` 版本耦合，跨大版本升级痛。预案：若升级成本过高，保留旧版 vendored + 适配层（anti-corruption layer）。

### go/zen 接入要点
- 认证：`OPENCODE_API_KEY` 或 device-flow OAuth（`console.opencode.ai`：`/auth/device/code` → 轮询 `/auth/device/token`）。
- 配置：`GET {server}/api/config` 下发 provider（含 go/zen 的 npm + api URL）。
- 端点：`api.opencode.ai/zen/v1/chat/completions`、`/zen/v1/messages`、`/zen/go/v1/...`。
- V2 走 `OpenAICompatibleChat.route` + `Auth.bearer(key)`。

---

## 五、历史勘误记录

| 版本 | 曾被误判 | 修正 |
|---|---|---|
| 评审 2 | "`request.sessionId` 不存在" | ✅ 确认（稳定版确实无此字段） |
| 评审 3 | "`customAgentTarget` 不在 schema" | ❌ main 分支误判；**1.132.0 存在**，保留 |
| 评审 4 | "`activationEvents: []` 是 bug" | ❌ 1.132.0 自动生成 `onChatSession:<type>` |
| 评审 4 | "`renderPrompt` 可省略 tokenizer" | ❌ 第三、四参必填，BYOK 必须自备 `ITokenizer` |
| 评审 4 | "`ChatSessionItem.timing` 必填" | ❌ `timing?:` 可选 |
| 评审 4 | "`stream.toolInvocation()` 存在" | ❌ 应为 `stream.push(new ChatToolInvocationPart(...))` / `beginToolInvocation` |
| 架构评审 | "`invokeTool('runSubagent')` 可用" | ❌ **VSCode 无 `runSubagent` 工具**，子代理自研（铁律 7） |
| 架构评审 2 | "只有 Agent 实例，无类概念" | ✅ 升级为 **AgentClass 类-实例体系（D7）** + MessageBus（D8）+ ContextAssetPool 工具化（D9）+ 元能力（D10） |
| 定名评审 | "项目名 less-code" | ✅ 更名 **stem**（Self-Training Evolutionary Matrix），定位"可分化一切的干细胞" |
