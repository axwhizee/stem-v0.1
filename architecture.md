# stem 实际架构

> 本文档记录**实际开发过程中明确的系统架构**与各模块内部的实现逻辑（`docs/architecture.md` 是最初的目标规划；本文档是落地后的真实形态，若与规划冲突以此为准，并会同步修订）。

**日期**：2026-08-11

---

## 一、总览

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 4  Host / 面板 (shell/ 当前为 CLI，未来 VSCode)                  │
│   面板 = user0：注册上下文（assemble=false），发消息 / 收汇总展示       │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 3  Agent Kernel (core/kernel/)  ← 纯 TS，零平台依赖             │
│   AgentTemplateRegistry · AgentInstanceManager · AgentSpaceManager     │
│   AgentRuntime（被动驱动状态机）· AgentKernel（组合根+系统工具）        │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2  Core Infra (core/context/, core/tools/, core/permission/, core/panel/) │
│   仓库 Repository（存储）· 管理员 ContextManager（处理）· 快递员 Courier（发送）│
│   ToolCapabilityRegistry（工具引擎，统一权限确认）· PermissionManager · PanelBus │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 1  Model Gateway (core/gateway/)  ← 纯 TS（opencode 隔离）       │
│   ModelGateway · providers/(opencodeLlm / fetch) · FakeGateway         │
└──────────────────────────────────────────────────────────────────────┘
  横切  Logging (core/logging/) —— 各模块 LogEvent 经注入 LogSink 直达记录器（无总线）
```

依赖方向（单向）：`shell → kernel → context/tools → gateway`。core 目录零平台依赖（禁止 `import 'vscode'` 与平台全局）。

## 二、通信模型：仓库 · 管理员 · 快递员（重建邮局）

**一句话**：无集中式总线。上下文按"仓库（存储）→ 管理员（处理）→ 快递员（发送）"三模块协作；agent 通信直接投递到上下文管理员；log / permission_reply 走注入接口。

### 关键概念

- **AgentClass（模板）** 承载设定参数：`id / name / description / system_prompt / model / permission / tools / memoryScope / send_countdown`。
- **AgentInstance** 承载：`id / classRef / creatorId / displayName / spaceId / status / history`。
- **用户面板**：与 agent 一视同仁，id 固定 `user0`；注册进上下文（assemble=false 不组装，只汇总信件）。
- **仓库（Repository）**：上下文本体的唯一存储，每条消息记录 `message / agentId / at / tokens（估算） / valid / from`；任何消息先入库，触发 onChange（管理员处理入口）。
- **管理员（ContextManager）**：收到「上下文待处理事件」→ 打发送者戳（user 消息用 from 元数据生成 `<sender id>`）、context_wait 判定（命中挂起 → 作为 tool 结果填充）、组装（classic/coding-hybrid 模式）→ 通知快递员「上下文待发送事件」。
- **快递员（Courier）**：按 agentId 维护发送倒计时（初始 0 立即送；发送后开始；来信重置），发送时从仓库按 valid 顺序取有效消息。
- **消息 ≠ 上下文**：通信消息直接投递；上下文由管理员按模式组装。

### 送信倒计时（快递员维护的局部量）

- 倒计时**初始为 0**：首信到达立即组装送信（无需等待）。
- **仅发送完一次上下文后**才进入倒计时（= 合并下一批来信的滑动窗口），倒计时期间新来信**重置**倒计时。
- **送信条件**：上下文就绪（管理员已处理/组装）**且**倒计时就绪；否则保持 holding。
- 默认 `sendCountdownMs = 1000ms`（模板可配）。

### 消息流

```
发送方 ──投递──▶ 管理员 deposit（from 元数据）→ 仓库 append（入库 + 触发 onChange）
                                                      │
                         管理员 handleChange：打戳 / context_wait 判定 / 组装
                                                      │
                                 ──上下文待发送事件──▶ 快递员 notifyReady
                                                      │
                              倒计时就绪 → 从仓库取 valid 消息 → 发送
                                                      │
                      完整上下文 → LLM → thinking → 工具轮 → 最终 assistant
                                                      │
                     runtime: 复制 assistant→仓库；最终回复投递给创建者
```

## 三、模块职责与内部实现

### 3.1 上下文三模块（`core/context/`：仓库 / 管理员 / 快递员）

**无集中式总线**（已废弃 MessageBus）——agent 通信经 kernel `sendMessage(from, to, payload)` 直接投递到上下文管理员；log / permission_reply 走注入接口。

- **仓库（Repository.ts）**：上下文本体的唯一存储，每条消息记录 `message / agentId / at / tokens（字符/4 估算） / valid / from`；`register` 时把 systemPrompt 作为首条 system message；任何消息先入库（`append`）并触发 `onChange(agentId)`（管理员处理入口）。
- **管理员（ContextManager.ts）**：收到待处理事件 → 打发送者戳（user 消息用 from 生成 `<sender id="from">`，替代原 runtime 拼戳）、context_wait 判定（from 命中挂起 → 作为 tool 结果填充）、组装（`ContextAssembler` 可注入，classic/coding-hybrid）→ 通知快递员。
- **快递员（Courier.ts）**：按 agentId 维护发送倒计时（初始 0 立即送；发送后开始；来信重置 = 合并窗口），发送时从仓库按 valid 顺序取有效消息（agent 收 `AgentDelivery`（含 `messageIds`）；user0 收 `UserDelivery` 信件汇总）。

### 3.2 仓库·管理员·快递员 协作（`core/context/` 内部）

按 `agentId` 分箱，仓库（存储）/ 管理员（处理）/ 快递员（发送）职责分离：

```typescript
// 管理员 —— 处理入口 + 对外单一上下文接口
interface ContextManager {
  register(reg: { agentId; systemPrompt?; assemble?; onDelivery; onHold? })
  deposit(agentId, letter, from?)   // 投信；from 命中 context_wait 挂起 → 作为 tool 结果填充
  appendHistory(agentId, message)   // 历史（assistant/tool 按来源追加）
  appendToolRecord(agentId, record) // 工具审计（仅日志占位，不干扰仓库）
  registerHold(waitFor, { ownerId, toolCallId })
  getState(agentId)
  handleChange(agentId)             // 仓库 onChange 入口
}
```

- **仓库（Repository）**：统一消息记录 `[system, user, assistant, tool, ...]`，每条带 `at / tokens / valid / from`；systemPrompt 在 register 时作为首条 system message 入库（不在单独字段）。
- **管理员（ContextManager）**：收到 `onChange` → 打发送者戳（user 消息补 `<sender id="from">`）、context_wait 判定（from 命中挂起 → 该回复作为 tool 结果填充到 owner，而非信件）、组装（`ContextAssembler` 可注入，缺省 `classicAssemble`）→ `courier.notifyReady`。
- **快递员（Courier）**：**不参与处理**，只等待「上下文就绪信号（管理员已处理）+ 倒计时就绪」→ 发送时从仓库按 valid 顺序取有效消息（agent 收 `AgentDelivery`（含 `messageIds`）；user 收 `UserDelivery` 信件汇总）。
- 送信倒计时（Courier 维护）：初始 0（首信立即送信）；发送后开始倒计时，倒计时中新内容就绪**重置**倒计时（合并滑动窗口）；结束仍就绪则发送，否则 `onHold` → holding。
- 用户（`user0`）注册 `assemble:false`：不组装，只把信件汇总交给 Courier 直通发送（diff 上次发送的消息 id 集）。

### 3.4 AgentRuntime（`core/kernel/AgentRuntime.ts`，被动驱动）

- **不是同步 run**：向 kernel 注册后，由快递员送信回调驱动（`processDelivery`）。
- 状态机：`idle →(快递员送信)→ thinking(请求已发) →(LLM 返回，assistant 或 tool_call)→ holding(等待下一次送信) →…`。
- 收到完整上下文（`AgentDelivery`）→ 发 LLM → **kernel 检查 assistant 中 tool_call 并调用工具**（工具结果经 `appendHistory` 入仓库）→ 每轮 assistant 消息自动复制到仓库 → 最终纯文本回复：
  - **不再拼发送者戳**（发送者戳由管理员打标签时统一生成）；
  - 最终回复直接投递给**创建者**（creatorId）上下文。

### 3.5 AgentInstanceManager（`core/kernel/AgentInstanceManager.ts`）

- 实例化必填：`classId` + **`userPrompt`** + **`creatorId`**（用户默认 `user0`；agent 创建时可指定 id，默认随机 4 位 hash，**冲突报错**）。
- 实例化流程自动执行：注册上下文（仓库/管理员/快递员，systemPrompt + sendCountdown + deliveryHandler）→ userPrompt 作为第一封信投递（from=creatorId）。
- 系统工具 `agent_instantiate` 因此**不 hold 等待**：创建即投递，由快递员驱动子 agent。

### 3.6 ToolCapabilityRegistry（`core/tools/`）

- 注册/查询/materialize（按权限规则过滤工具可见性）/execute（**统一权限确认** + 参数校验 + ToolHooks）。
- 内部工具（kind=internal，systemTools 注册）与外部工具（kind=external，宿主/未来 MCP 经注册接口接入）统一注册，工具来源为固有属性。
- **`onRecord` 回调**（kernel 装配时注入）：工具被触发/成功/失败时自动产生 `ToolRecord`（审计），工具结果消息经 `appendHistory` 进入仓库 —— 不依赖 runtime 手动发送。
- 工具结果消息由工具模块自动追加到仓库（经典组装的一部分）。

### 3.7 系统工具（`core/kernel/systemTools.ts`，Kernel 注册，kind=internal）

| 工具 | 权限名 | 作用 |
|---|---|---|
| `agent_class_create` | agent_class_create | 创建新 agent 类（类属性 + `permissions` 权限列表，**不含实例数据**） |
| `agent_class_list` | agent_class_list | 列出 agent 类 |
| `agent_instantiate` | agent_instantiate | 创建 agent（必填 classId + userPrompt，**creatorId 可显式指定**，注册上下文，投递首信，**返回 agent id**） |
| `agent_list` | agent_list | 列出实例 |
| `agent_terminate` | agent_terminate | 终止实例（注销上下文） |
| `context_wait` | context_wait | 等待指定 agent 回复：其回复作为本工具 tool 结果填充（无常规 tool 结果） |
| `bus_send` | bus_send | 发送消息（单目标；并行调用实现一对多，经 kernel.sendMessage） |
| `bus_participants` | bus_participants | 查询参与者 id 列表（instances + user0） |

> 系统工具默认权限名 = 工具 id；示例模板（creator 等）在 `permissions` 中显式 `allow` 所需内部工具，避免弹窗打扰。

### 3.8 host 内置工具（`shell/tools/`，kind=shell）

- 与 core 解耦的真实文件系统工具，经 registry 注册接口接入（未来 MCP / VSCode 工具同样经该接口）。
- 工具来源三分类（`ToolKind`）：`internal`（core 系统工具）/ `shell`（宿主内置工具）/ `user`（用户 `.stem/tool/` 提供的工具）。
- 参考 opencode 实现：

| 工具 | 权限名 | 作用 |
|---|---|---|
| `read` | read | 读取文本文件（offset/limit 分页，1-based）+ 目录列出；二进制检测 |
| `write` | edit | 全量写入（父目录自动创建，不支持 append） |
| `edit` | edit | oldString/newString 精确替换（0/多次匹配校验） |
| `grep` | grep | 正则递归搜索（排除 .git/node_modules），file:line:text |
| `glob` | glob | glob 模式匹配文件（**/*/?/{a,b}） |

- shell 装配时 `createHostTools(<projectRoot>)` 注册（kind=shell）；`coder` 模板已启用这些工具。

### 3.9 Gateway（`core/gateway/`）

- 保持既有：`ModelGateway` 接口、`providers/opencodeLlm`（单点）、`FakeGateway`。
- 并行工具调用：协议层 `tool_calls` 数组原生支持；工具轮并行执行，结果按 index 回填。

### 3.10 统一权限模型（`core/permission/`，原子化 per-tool）

**废弃模糊的角色等级（normal/advanced/admin）**，改为**每个工具原子化的 allow/deny/ask**，由 **agent 类权限列表**决定：

- **工具**：声明 `permission`（权限名，string；缺省=工具 id；可多工具共享，如 edit/write → `'edit'`）+ `kind: 'internal' | 'shell' | 'user'`（固有属性：内部=core 系统工具，shell=宿主内置，user=用户 `.stem/tool/` 提供）。
- **Agent 类**：`permissions: Record<权限名, allow|deny|ask>`；**未列出的工具默认 ask**（弹窗交用户确认）。
- **全局配置权限（最弱）**：`stem.jsonc` 的 `permission` 作为全局默认，评估规则集 = **[全局默认, agent 类规则, session 用户批准]**，最后命中优先——agent 类可覆盖全局、用户批准可覆盖 agent 类。
- **autoApprove**：`stem.jsonc` 的 `autoApprove=true` 时 ask 直接放行，不弹窗（deny 仍拒绝）。
- **评估** `evaluate(permission, rules)`：最后命中优先，缺省 ask。
- **materialize**：deny 的工具不暴露给模型；allow/ask 暴露（执行时才确认）。
- **execute**：registry 层统一 `assert` → allow 执行 / deny 抛 `permission_denied` / **ask 挂起** → PanelBus 弹窗 → 用户回复 `once`（通过本次）/ `always`（通过+写 session approved，**用户批准优先于 agent 规则**）/ `reject`（拒绝，可带反馈）。
- 用户确认完全**面向面板**：ask 请求经 PanelBus 发到面板，CLI 用弹窗模块选择。

### 3.11 PanelBus（`core/panel/`，面板消息统一通道）

- 所有通向面板的消息统一汇总为 `PanelMessage`：`letter`（回信）/ `permission_request`（权限弹窗）/ `notice`（未来通知）。
- 面板端（shell/GUI）只需实现一个 consumer 消费统一消息流，内部再分发到展示层 / 弹窗模块；**core 与面板解耦，GUI 完全复用**。
- 弹窗模块（shell/ui/dialog.ts）：队列结构，`{title, body, options, multiple?}`；CLI 数字编号选择，多选逗号分隔。

### 3.12 Logging 横切（`core/logging/`）

- **各模块经注入的 `LogSink` 发日志** → 组合根接到 `Logger`（无总线中转）。
- `LogEvent` 判别联合（对齐 docs §4.1 + 补充点）：
  - `tool.invoked`：工具调用（called/success/error + durationMs + 结果/错误）——ToolCapabilityRegistry 记录。
  - `gateway.apiRequest`：模型调用（model/provider/tokens/latencyMs/cost）——AgentRuntime 每轮记录。
  - `context.assembled`：上下文构成 + **成分就绪时间**（letters/history/tools 时间戳）+ **完整上下文留档**——ContextManager 记录。
  - `mailbox.countdown` / `mailbox.delivered`：倒计时触发/重置/发送状态——Courier 记录。
  - `kernel.*`：class.registered / instance.created / status.changed / instance.terminated / message.sent——Kernel 记录。
- `InMemoryLogger`：留档 + `query({agentId, type})` 过滤（后续持久化 + `telemetry_read` 工具）。
- 低层模块（context/tools/runtime）**不依赖 bus**：通过注入的 `LogSink` 发日志，组合根装配。

### 3.13 全局配置（`core/config/`）+ 初始化管线（`core/init/`）

**唯一配置文件**（本阶段不引入 `~/.config/stem/` 多级合并）：项目空间根目录下 `.stem/stem.jsonc`（或 `.stem/stem.json`）是最终配置载体。

- `core/config/`（纯 TS）：`StemConfig` 类型 + JSONC 解析/校验（`parseConfigText`）+ model 格式解析（`parseModelRef`，`提供商/模型`）；文件读写经 `ConfigStore` 接口注入（宿主实现：`shell/config/nodeConfig.ts`）。
- 配置项：
  - `model`：当前模型（如 `opencode-go/deepseek-v4-flash`）。
  - `permission`：全局工具权限（最弱，见 3.10）。
  - `autoApprove`：权限自动批准开关。
  - `sendCountdown`：全局默认送信倒计时。
  - `tools` / `agents`：**同步注册表（纯镜像）**，由 init 自动维护——发现 `.stem/tool/`、`.stem/agent/` 文件就登记，缺实现文件就移除。

**初始化管线 `core/init/`**（`runInit(deps)`，fs/动态 import 注入）：

1. 读取唯一配置（`ConfigStore.load`）。
2. 扫描 `tool/`（`.ts`，默认导出 `ToolCapability`）、`agent/`（`.md`，YAML 头 + 正文 systemPrompt）目录。
3. 同步注册表到 stem.jsonc（jsonc-parser 定点修改，保留注释）；已注册但无实现文件 → `orphan_registration` issue 并移除。
4. 注册到 core：用户工具 → `ToolCapabilityRegistry`（kind 强制 `user`）；用户 agent → `AgentTemplateRegistry`。

**用户 agent 文件**（`.stem/agent/*.md`，对齐 opencode agent 惯例）：

```markdown
---
description: 代码审查员
permission:              # 融合的工具列表 + 权限（工具 = permission 的键）
  read: allow
  edit: deny
send_countdown: 800      # 可选
---
<system_prompt 正文>
```

- **文件名即 agent 类 id 与 name**（不要求 frontmatter 写 id/name，实例化时才命名）。
- **工具与权限融合**：`permission` 的键即工具白名单（`AgentClass.tools` 由键生成），动作即 `AgentClass.permissions`——避免"有权限无工具 / 有工具无权限"的尴尬；与全局配置 `permission` 形态一致（全局低于 agent）。
- 映射：description → `description`；send_countdown → `sendCountdown`；`metadata` 等附加字段忽略。
- shell 启动即跑 `runInit`（`tmp/` 为测试项目空间），`/config` 命令展示配置与注册表。

## 四、messages 经典模式的定制化（第一步）

1. **自动返回**：任何 agent 最终纯文本回复自动寄信给创建者。
2. **发送者戳**：`<sender id="xxx">内容</sender>`（runtime 生成，未来可加时间戳）。
3. **user_prompt 组装**：信件在送信时合并为 user_prompt 进入上下文。

## 五、端到端时序（验收任务）

```
1. 用户(user0) ──sendMessage──▶ 管理员 deposit(from=user0) → 仓库 append（system 已在首位）→ onChange
2. 管理员 handleChange: 打戳 → 组装 → 快递员 notifyReady（首信倒计时 0 立即发送）
3. 快递员: 从仓库取 valid 消息 → 发送 AgentDelivery → 创造者 processDelivery
4. 创造者: thinking → tool_call(agent_instantiate) → kernel 调工具 → 创建子agent(id+creatorId)
5. 子agent: 注册上下文 → 首信投递 → 快递员发送 → thinking → tool_call(oc_get_time) → 工具结果入仓库
6. 子agent: 最终回复投递给创造者（管理员打戳）→ context_wait 命中 → 作为 tool 结果填充创造者
7. 创造者: 继续轮 → 回复用户时间 → 投递给 user0 → 管理员打戳 → 快递员发信件 → 面板显示
```

## 六、技术选型

- TypeScript + tsx（运行/测试）+ node:test；运行时依赖 jsonc-parser / yaml（工具 schema 校验自研子集）。
- 仓库存储：本阶段**内存 JSON 消息列表**；后续换 SQLite（`Repository` 存储接口已隔离）。
- 倒计时：全局 `setTimeout`（core 内标准 API，非平台依赖）。
- LLM 端点：真实 go/zen（`https://opencode.ai/zen/go/v1/chat/completions`）或 mock SSE 兜底。

## 七、与最初规划（docs/architecture.md）的差异

| 项 | 规划 | 实际 |
|---|---|---|
| 通信 | MessageBus 保存消息、半双工 | **无总线**：仓库→管理员→快递员三模块；agent 通信经 kernel.sendMessage 直接投递；log/permission_reply 走注入接口 |
| context 结构 | ContextManager 一体化邮局 | **重建邮局**：Repository（存储本体+valid/tokens/from 元数据）→ ContextManager（处理/打戳/组装）→ Courier（倒计时+发送）；ContextAssembler 为可注入组装策略 |
| 发送者戳 | runtime 生成 `<sender id>` | **管理员统一打戳**（用 from 元数据），runtime 只发原始文本 |
| AgentRuntime | 同步 while 循环 | 被动驱动：快递员送信触发，状态机 thinking/cooldown/hold；kernel 检查 tool_call 并调工具 |
| Agent 状态 | `idle/running/waiting` | `idle/thinking/holding` |
| 实例化 | 无 userPrompt/creatorId | 必填 userPrompt；creatorId 可显式指定，注册上下文，system 入库 |
| 系统工具 | 阶段 3.1 | 提前：agent_class_create/list 已实现（权限名=工具 id） |
| 上下文 | ContextProfile + 渲染器 | 仓库有效消息 + 组装策略经典组装 |
| 工具记录 | 无 | onRecord 自动审计 + tool 结果入仓库 |
| MessageBus | 只转发 agent 消息 | **废弃**：sender戳入管理员，log 入 Logger，permission_reply 直连权限管理器 |
| 参与者 | bus 注册表 | 复用 instances + user0（无独立注册表） |
| 日志 | 规划 Telemetry（未实现） | core/logging/ 落地：各模块 LogEvent 经注入 LogSink 直达 InMemoryLogger |
| 权限 | `PermissionLevel`（normal/advanced/admin 角色等级） | **统一原子化 per-tool**：工具 permission 名 + agent 类 permissions 列表（allow/deny/ask），缺省 ask 交用户确认；core/permission/ |
| 面板通信 | user0 邮局收信 | **PanelBus 统一通道**：回信/权限请求/通知 → 面板弹窗模块（shell/ui/dialog） |
