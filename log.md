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
npm test            # 单元测试（25 项）
npm run shell       # 临时 shell（mock 兜底）
OPENCODE_API_KEY=<key> OPENCODE_MODEL=<model> npm run shell   # 真实 go/zen
```

### 后续（未执行）

- 工具闭环（ToolCapabilityRegistry + AgentRuntime 工具轮，Task 1.5）。
- ContextProfile 完整化 + renderPrompt + tokenizer（Task 1.3）。
- VSCode Adapter Shell 接入（Task 1.1）。
- MessageBus / 多 Agent / ContextAssetPool（阶段 2）。
