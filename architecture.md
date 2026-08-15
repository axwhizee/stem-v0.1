# stem 实际架构

> 本文档记录**实际开发过程中明确的系统架构**与各模块内部的实现逻辑（`docs/architecture.md` 是最初的目标规划；本文档是落地后的真实形态，若与规划冲突以此为准，并会同步修订）。

**日期**：2026-08-14

---

## 一、总览

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 4  Host / 面板 (shell/ 当前为 CLI，未来 VSCode)                  │
│   面板 = user0：元 agent（族谱树根），注册上下文（assemble=false）      │
│   发消息 / 收汇总展示 / 工具访问确认弹窗                                │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 3  Kernel (core/kernel/)  ← 纯 TS，零平台依赖                    │
│   Kernel（组合根）· TemplateRegistry · InstanceManager · SpaceManager  │
│   Runtime（被动驱动状态机）· LineageTree（族谱，无状态视图）            │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2  Core Infra (core/context/, core/tools/, core/panel/)         │
│   仓库 Repository（存储）· 管理员 ContextManager（处理）· 快递员 Courier│
│   ToolCapabilityRegistry（工具引擎，统一访问确认）· AccessManager      │
│   access.ts（四态评估：allow/ask/deny/ignore）· PanelBus               │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 1  Model Gateway (core/gateway/)  ← 纯 TS（opencode 隔离）       │
│   ModelGateway · providers/(opencodeLlm / fetch) · FakeGateway         │
└──────────────────────────────────────────────────────────────────────┘
  横切  Logging (core/logging/) —— 各模块 LogEvent 经注入 LogSink 直达记录器（无总线）
```

依赖方向（单向）：`shell → kernel → context/tools → gateway`。core 目录零平台依赖（禁止 `import 'vscode'` 与平台全局）。

## 二、核心概念模型

### 2.1 族谱树：所有 agent 一律平等，user0 是原点

**一句话**：agent 之间的唯一区别是 `parentId`（族谱关系）；user0 的特殊之处仅在于 `parentId = null`——它是原点、元 agent。

- **AgentClass（模板）** 承载设定参数：`id / name / description / system_prompt / model / toolAccess / tools / memoryScope / send_countdown`。
- **AgentInstance** 承载：`id / classRef / creatorId / parentId / displayName / spaceId / status / turnCount / totalCost / userPrompt`。
  - `parentId`：族谱父（user0 为 null 即根）；**创建时确定、不可变**。
  - `creatorId`：发起者（与 parentId 分离；默认 = parentId）。
- **LineageTree**（`core/kernel/LineageTree.ts`，**无状态关系查询视图**）：不存任何关系数据，所有查询基于 InstanceManager 实时推导。
  - `getParent` / `getChildren` / `getAncestors`（[父 → … → user0]）/ `getDescendants`（BFS 子树）/ `isAncestorOf`。
  - **单一事实源**：parentId 挂在 AgentInstance 上，LineageTree 只是视图——无独立存储、无需同步、增删实例后自动正确。
- **销毁权（fail-closed）**：仅目标 agent 的**祖先**（含 user0 根）可销毁；默认禁止销毁有活跃子的父，`recursive: true` 级联整棵子树；元 agent（user0）不可销毁。
- **父子 = 所有权/责任关系，能力无关**：消息互通无方向限制、各自独立上下文与类（"同地位独立个体"）。

### 2.2 工具访问（ToolAccess）：权限融合进 tools

**一句话**：废弃独立的 permission 模块，工具访问状态是 agent 工具字典清单中的属性值，四态 `allow / ask / deny / ignore`。

- **四态**（`core/tools/types.ts`）：
  | 状态 | 暴露给 LLM（materialize） | 执行时（execute） |
  |---|---|---|
  | `allow` | ✅ | ✅ 直接执行 |
  | `ask` | ✅ | ⏸ 挂起弹窗（autoApprove 时放行） |
  | `deny` | ❌ | ❌ `access_denied` |
  | `ignore` | ❌ 默认隐藏 | ✅ 等同 allow（显式声明 allow 后暴露） |
- **`ignore`（系统级工具默认隐藏）**：`kind=internal` 的 core 系统工具默认 `ignore`——不在工具清单出现，除非在 `toolAccess` 显式声明 `allow`。隐藏是**可见性控制**而非授权边界；越权由 `deny` 负责。
- **评估**（`core/tools/access.ts`，纯函数）：
  - `evaluateAccess(key, layers, defaultAccess)`：**分层评估，层间取最严格**（单调收缩）；默认值仅兜底（不参与 restrict）。
  - 偏序 `deny ≺ ask ≺ {allow, ignore}`（allow≈ignore 同级）。
  - **层顺序**（kernel 合成）：`[全局(最弱), 祖先链(父→子), agent 类, session 批准(仅当前实例)]`。
  - **单向收缩**：任何一层 deny → 全局 deny；deny 不可被后序规则撤销（对齐 dsh 单调 guard 理念）。
  - **用户批准（session always/once）是链外人类授权**：只作用于被批准的当前实例，不传播给后代。
- **AccessManager**（`core/tools/AccessManager.ts`）：`assert`（评估 + allow/ignore 通过 / deny 抛错 / ask 挂起）+ `reply`（once/always/reject）+ 元 agent（user0）短路 `allow`。

### 2.3 用户面板（user0）= 元 agent

- `registerUser()` 将 user0 **实例化**为元 agent：`{ id: 'user0', classRef: '__meta__', parentId: null }`，进入实例体系（而非仅上下文注册）。
- **元权限**：AccessManager 对 `user0` 一律 `allow` 短路。作为偏序最大值，对后代**零污染**。
- 面板操作统一走 kernel 方法（`sendMessage` / `terminateAgent` / `interruptAgent` / `inspectAgent`…），系统工具只是薄适配（`ctx.agentId` 注入 by）。

### 2.4 中断与错误处理

- **中断入口**：`kernel.interruptAgent(agentId, { by })`（销毁权复用：仅祖先或 user0）；`kernel.abortAllAgents()`（进程优雅收尾）。
- **三种场景**：
  - **用户主动中断**（shell `/stop`）→ `interruptAgent` → Runtime.abort → `halt` 消息闭合 → `interrupted`。
  - **网络/网关中断**（`GatewayError` request_failed 等）→ 主循环 catch → `halt`（部分文本原样入库）→ `interrupted`。
  - **进程中断**（shell SIGINT/SIGTERM）→ `abortAllAgents` → 各 agent 消息闭合后退出。
- **消息完整性**：无论哪种中断，已产出的部分 assistant 补 `<interrupted>` 标记入库（消息闭合），仓库完整保留，下一次送信自动恢复。

## 三、通信模型：仓库 · 管理员 · 快递员（重建邮局）

**一句话**：无集中式总线。上下文按"仓库（存储）→ 管理员（处理）→ 快递员（发送）"三模块协作；agent 通信直接投递到上下文管理员；log / access_reply 走注入接口。

### 关键概念

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

## 四、模块职责与内部实现

### 4.1 上下文三模块（`core/context/`：仓库 / 管理员 / 快递员）

**无集中式总线**（已废弃 MessageBus）——agent 通信经 kernel `sendMessage(from, to, payload)` 直接投递到上下文管理员；log / access_reply 走注入接口。

- **仓库（Repository.ts）**：上下文本体的唯一存储，每条消息记录 `message / agentId / at / tokens（字符/4 估算） / valid / from`；`register` 时把 systemPrompt 作为首条 system message；任何消息先入库（`append`）并触发 `onChange(agentId)`（管理员处理入口）。
- **管理员（ContextManager.ts）**：收到待处理事件 → 打发送者戳（user 消息用 from 生成 `<sender id="from">`）、context_wait 判定（from 命中挂起 → 作为 tool 结果填充）、组装（`ContextAssembler` 可注入，classic/coding-hybrid）→ 通知快递员。
- **快递员（Courier.ts）**：按 agentId 维护发送倒计时，发送时从仓库按 valid 顺序取有效消息（agent 收 `AgentDelivery`（含 `messageIds`）；user0 收 `UserDelivery` 信件汇总）。

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

- 用户（`user0`）注册 `assemble:false`：不组装，只把信件汇总交给 Courier 直通发送（diff 上次发送的消息 id 集）。

### 4.2 Runtime（`core/kernel/Runtime.ts`，被动驱动）

- **不是同步 run**：向 kernel 注册后，由快递员送信回调驱动（`processDelivery`）。
- 状态机：`idle →(快递员送信)→ thinking(请求已发) →(LLM 返回)→ holding(等待下一次送信)`；`interrupted`（当前轮被中断，消息闭合、实例存活、可恢复）。
- 收到完整上下文（`AgentDelivery`）→ 发 LLM → **kernel 检查 assistant 中 tool_call 并调用工具**（工具结果经 `appendHistory` 入仓库）→ 每轮 assistant 消息自动复制到仓库 → 最终纯文本回复：
  - **不再拼发送者戳**（发送者戳由管理员打标签时统一生成）；
  - 最终回复直接投递给**创建者**（creatorId）上下文。

#### 错误处理与中断（Runtime 三层防护）

- **中断控制器**：每轮 `processDelivery` 注册一个 `AbortController`（`controllers` Map），`Runtime.abort(agentId)` / `abortAll()` 供 kernel/宿主中断（用户 `/stop`、进程 SIGINT/SIGTERM）。
- **三层 try/catch**：主循环内 `gateway.chat(request, { signal })` 抛错时统一走 `halt()` 收尾，不再冒泡导致状态卡死。
- **消息闭合（完整性保证）**：中断时已产出的部分 assistant 文本补 `\n<interrupted>` 标记入库（`appendHistory`），避免下一轮组装出现"assistant 后直接接 user"的非法消息序列；网络/工具错误则原样保留部分文本（不伪造完成标记）。
- **`interrupted` 语义**：仅暂停（不销毁、不清空仓库），下一次送信自动恢复（状态回 thinking）。与 `terminateAgent`（销毁）严格区分。
- **并发能力**：`gateway.chat` 是 AsyncGenerator，各 agent 独立调用天然并发（provider 层 unbounded，对齐 opencode）；中断一个 agent 不影响其他。

### 4.3 InstanceManager（`core/kernel/InstanceManager.ts`，实例存储本体）

- 实例化必填：`classId` + **`userPrompt`** + **`creatorId`**（用户默认 `user0`；agent 创建时可指定 id，默认随机 4 位 hash，**冲突报错**）。
- `parentId` 缺省 = creatorId（user0 创建时为根）；父不存在报错；元 agent（user0）不可销毁。
- 实例化流程自动执行：注册上下文（仓库/管理员/快递员，systemPrompt + sendCountdown + deliveryHandler）→ userPrompt 作为第一封信投递（from=creatorId）。
- 系统工具 `agent_instantiate` 因此**不 hold 等待**：创建即投递，由快递员驱动子 agent。

### 4.4 LineageTree（`core/kernel/LineageTree.ts`，族谱无状态视图）

- 与 InstanceManager 的关系：**事实源（manager 持有 parentId）+ 查询视图（lineage 实时推导）**。
- `getInstance` / `getAllInstances` / `accessLayerOf` 由组合根注入（同步路径解析访问层）。
- 销毁权判定 `isAncestorOf`；权限继承 `resolveAccessLayers`（祖先链逐层收集 ToolAccessRules）。

### 4.5 ToolCapabilityRegistry（`core/tools/`）

- 注册/查询/materialize（按工具访问层过滤可见性）/execute（**统一访问确认** + 参数校验 + ToolHooks）。
- 工具来源三分类（`ToolKind`）：`internal`（core 系统工具，默认 ignore）/ `shell`（宿主内置）/ `user`（用户 `.stem/tool/`）。
- **`onRecord` 回调**（kernel 装配时注入）：工具被触发/成功/失败时自动产生 `ToolRecord`（审计），工具结果消息经 `appendHistory` 进入仓库 —— 不依赖 runtime 手动发送。

### 4.6 系统工具（`core/kernel/systemTools.ts`，Kernel 注册，kind=internal）

| 工具 | 访问键 | 作用 |
|---|---|---|
| `agent_class_create` | agent_class_create | 创建新 agent 类（类属性 + `toolAccess` 列表，**不含实例数据**） |
| `agent_class_list` | agent_class_list | 列出 agent 类 |
| `agent_instantiate` | agent_instantiate | 创建 agent（必填 classId + userPrompt，**creatorId 可显式指定**，注册上下文，投递首信，**返回 agent id**） |
| `agent_list` | agent_list | 列出实例（含 parent 列） |
| `agent_inspect` | agent_inspect | 查看单个实例详情：父/子/祖先链、状态、轮次、成本 |
| `agent_ancestry` | agent_ancestry | 查询祖先链（[父 → … → user0]） |
| `agent_descendants` | agent_descendants | 查询全部后代（BFS 子树） |
| `agent_terminate` | agent_terminate | 终止实例（**销毁权校验**：祖先或 user0；`recursive` 级联） |
| `context_wait` | context_wait | 等待指定 agent 回复：其回复作为本工具 tool 结果填充（无常规 tool 结果） |
| `bus_send` | bus_send | 发送消息（单目标；并行调用实现一对多，经 kernel.sendMessage） |
| `bus_participants` | bus_participants | 查询参与者 id 列表（instances + user0） |

> 系统工具 `kind=internal` → 默认 `ignore`（隐藏），示例模板（creator 等）在 `toolAccess` 显式 `allow` 所需内部工具，避免弹窗打扰。

### 4.7 host 内置工具（`shell/tools/`，kind=shell）

| 工具 | 访问键 | 作用 |
|---|---|---|
| `read` | read | 读取文本文件（offset/limit 分页，1-based）+ 目录列出；二进制检测 |
| `write` | edit | 全量写入（父目录自动创建，不支持 append） |
| `edit` | edit | oldString/newString 精确替换（0/多次匹配校验） |
| `grep` | grep | 正则递归搜索（排除 .git/node_modules），file:line:text |
| `glob` | glob | glob 模式匹配文件（**/*/?/{a,b}） |

- shell 装配时 `createHostTools(<projectRoot>)` 注册（kind=shell）；`coder` 模板已启用这些工具。

### 4.8 Gateway（`core/gateway/`）

- 保持既有：`ModelGateway` 接口、`providers/opencodeLlm`（单点）、`FakeGateway`。
- 并行工具调用：协议层 `tool_calls` 数组原生支持；工具轮并行执行，结果按 index 回填。

### 4.9 工具访问确认（`core/tools/AccessManager.ts`，替代原 PermissionManager）

- 分层评估（`access.ts`）：**`[全局(最弱), 祖先链(父→子), agent 类, session 批准(最强)]`，层间取最严格（单向收缩）**。
- execute：registry 层统一 `assert` → allow/ignore 通过 / deny 抛 `access_denied` / **ask 挂起** → PanelBus 弹窗 → 用户回复 `once`（通过本次）/ `always`（通过+写 session approved，**仅当前实例**）/ `reject`（拒绝，可带反馈）。
- 元 agent（user0）短路 `allow`（用户是最终主权）。
- `autoApprove`（`stem.jsonc`）时 ask 直接放行，不弹窗（deny 仍拒绝）——只改 ask 的处置，不改评估结果。

### 4.10 PanelBus（`core/panel/`，面板消息统一通道）

- 所有通向面板的消息统一汇总为 `PanelMessage`：`letter`（回信）/ `permission_request`（工具访问确认弹窗，含 `accessKey`）/ `notice`（未来通知）。
- 面板端（shell/GUI）只需实现一个 consumer 消费统一消息流，内部再分发到展示层 / 弹窗模块；**core 与面板解耦，GUI 完全复用**。
- 弹窗模块（shell/ui/dialog.ts）：队列结构，`{title, body, options, multiple?}`；CLI 数字编号选择，多选逗号分隔。

### 4.11 Logging 横切（`core/logging/`）

- **各模块经注入的 `LogSink` 发日志** → 组合根接到 `Logger`（无总线中转）。
- `LogEvent` 判别联合：
  - `tool.invoked`：工具调用（called/success/error + durationMs）——ToolCapabilityRegistry 记录。
  - `gateway.apiRequest`：模型调用（model/provider/tokens/latencyMs/cost）——Runtime 每轮记录。
  - `context.assembled`：上下文构成 + **成分就绪时间** + **完整上下文留档**——ContextManager 记录。
  - `mailbox.countdown` / `mailbox.delivered`：倒计时触发/重置/发送状态——Courier 记录。
  - `access.asked` / `access.replied`：工具访问评估 + 用户回复——AccessManager 记录。
  - `kernel.*`：class.registered / instance.created / status.changed / instance.terminated / instance.interrupted / message.sent——Kernel 记录。
- `InMemoryLogger`：留档 + `query({agentId, type})` 过滤（后续持久化 + `telemetry_read` 工具）。

### 4.12 全局配置（`core/config/`）+ 初始化管线（`core/init/`）

**唯一配置文件**（本阶段不引入 `~/.config/stem/` 多级合并）：项目空间根目录下 `.stem/stem.jsonc`（或 `.stem/stem.json`）是最终配置载体。

- `core/config/`（纯 TS）：`StemConfig` 类型 + JSONC 解析/校验（`parseConfigText`）+ model 格式解析（`parseModelRef`，`提供商/模型`）；文件读写经 `ConfigStore` 接口注入（宿主实现：`shell/config/nodeConfig.ts`）。
- 配置项：
  - `model`：当前模型（如 `opencode-go/deepseek-v4-flash`）。
  - `permission`：全局工具访问（最弱，见 4.9；允许 allow/ask/deny/ignore）。
  - `autoApprove`：访问自动批准开关。
  - `sendCountdown`：全局默认送信倒计时。
  - `tools` / `agents`：**同步注册表（纯镜像）**，由 init 自动维护——发现 `.stem/tool/`、`.stem/agent/` 文件就登记，缺实现文件就移除。

**初始化管线 `core/init/`**（`runInit(deps)`，fs/动态 import 注入）：

1. 读取唯一配置（`ConfigStore.load`）。
2. 扫描 `tool/`（`.ts`，默认导出 `ToolCapability`）、`agent/`（`.md`，YAML 头 + 正文 systemPrompt）目录。
3. 同步注册表到 stem.jsonc（jsonc-parser 定点修改，保留注释）；已注册但无实现文件 → `orphan_registration` issue 并移除。
4. 注册到 core：用户工具 → `ToolCapabilityRegistry`（kind 强制 `user`）；用户 agent → `TemplateRegistry`。

**用户 agent 文件**（`.stem/agent/*.md`，对齐 opencode agent 惯例）：

```markdown
---
description: 代码审查员
permission:              # 融合的工具列表 + 访问（工具 = permission 的键；允许 allow/ask/deny/ignore）
  read: allow
  edit: deny
send_countdown: 800      # 可选
---
<system_prompt 正文>
```

- **文件名即 agent 类 id 与 name**（不要求 frontmatter 写 id/name，实例化时才命名）。
- **工具与访问融合**：`permission` 的键即工具白名单（`AgentClass.tools` 由键生成），动作即 `AgentClass.toolAccess`——避免"有权限无工具 / 有工具无权限"的尴尬；与全局配置 `permission` 形态一致（全局低于 agent）。
- 映射：description → `description`；send_countdown → `sendCountdown`；`metadata` 等附加字段忽略。
- shell 启动即跑 `runInit`（`tmp/` 为测试项目空间），`/config` 命令展示配置与注册表。

## 五、messages 经典模式的定制化（第一步）

1. **自动返回**：任何 agent 最终纯文本回复自动寄信给创建者。
2. **发送者戳**：`<sender id="xxx">内容</sender>`（管理员打戳生成，未来可加时间戳）。
3. **user_prompt 组装**：信件在送信时合并为 user_prompt 进入上下文。

## 六、端到端时序（验收任务）

```
1. 用户(user0) ──sendMessage──▶ 管理员 deposit(from=user0) → 仓库 append（system 已在首位）→ onChange
2. 管理员 handleChange: 打戳 → 组装 → 快递员 notifyReady（首信倒计时 0 立即发送）
3. 快递员: 从仓库取 valid 消息 → 发送 AgentDelivery → 创造者 processDelivery
4. 创造者: thinking → tool_call(agent_instantiate) → kernel 调工具 → 创建子agent(id+creatorId+parentId)
5. 子agent: 注册上下文 → 首信投递 → 快递员发送 → thinking → tool_call(oc_get_time) → 工具结果入仓库
6. 子agent: 最终回复投递给创造者（管理员打戳）→ context_wait 命中 → 作为 tool 结果填充创造者
7. 创造者: 继续轮 → 回复用户时间 → 投递给 user0 → 管理员打戳 → 快递员发信件 → 面板显示
```

## 七、技术选型

- TypeScript + tsx（运行/测试）+ node:test；运行时依赖 jsonc-parser / yaml（工具 schema 校验自研子集）。
- 仓库存储：本阶段**内存 JSON 消息列表**；后续换 SQLite（`Repository` 存储接口已隔离）。
- 族谱存储：**无独立存储**（parentId 挂在实例上，LineageTree 实时推导）。
- 倒计时：全局 `setTimeout`（core 内标准 API，非平台依赖）。
- LLM 端点：真实 go/zen（`https://opencode.ai/zen/go/v1/chat/completions`）或 mock SSE 兜底。

## 八、与最初规划（docs/architecture.md）的差异

| 项 | 规划 | 实际 |
|---|---|---|
| 通信 | MessageBus 保存消息、半双工 | **无总线**：仓库→管理员→快递员三模块；agent 通信经 kernel.sendMessage 直接投递；log/access_reply 走注入接口 |
| context 结构 | ContextManager 一体化邮局 | **重建邮局**：Repository（存储本体+valid/tokens/from 元数据）→ ContextManager（处理/打戳/组装）→ Courier（倒计时+发送）；ContextAssembler 为可注入组装策略 |
| 发送者戳 | runtime 生成 `<sender id>` | **管理员统一打戳**（用 from 元数据），runtime 只发原始文本 |
| 运行时 | 同步 while 循环 | 被动驱动：快递员送信触发，状态机 thinking/holding/interrupted；kernel 检查 tool_call 并调工具 |
| Agent 状态 | `idle/running/waiting` | `idle/thinking/holding/interrupted` |
| 错误处理 | 无 | 三层 try/catch + halt 消息闭合 + interrupted（仅暂停可恢复）+ 中断入口（/stop、SIGINT） |
| 实例化 | 无 userPrompt/creatorId | 必填 userPrompt；creatorId 可显式指定；**parentId 族谱关系** |
| 系统工具 | 阶段 3.1 | 提前：agent_class_*/agent_inspect/ancestry/descendants 已实现 |
| 权限模型 | `PermissionLevel`（normal/advanced/admin 角色等级） | **统一工具访问四态 ToolAccess**（allow/ask/deny/ignore），融合进 `core/tools/`（access.ts + AccessManager）；层间单调收缩（单向），deny 不可被撤销 |
| 权限继承 | 无 | **族谱树继承**：祖先链逐层收集访问层，层间取最严格（子 ≤ 父）；session 批准仅当前实例 |
| ignore | 无 | **系统级工具默认隐藏**：kind=internal 默认 ignore，显式 allow 才暴露 |
| user0 | 仅上下文注册 | **元 agent 实例化**：classRef=__meta__、parentId=null（族谱树根）、元权限短路 allow |
| 族谱树 | 无 | **LineageTree**（kernel 内无状态视图）：parentId 单一事实源 + 销毁权判定 + 权限继承 |
| 模块命名 | AgentKernel/AgentInstanceManager/… | **去 Agent 前缀**：Kernel/InstanceManager/TemplateRegistry/SpaceManager/Runtime |
| MessageBus | 只转发 agent 消息 | **废弃**：sender戳入管理员，log 入 Logger，access_reply 直连访问管理器 |
| 参与者 | bus 注册表 | 复用 instances + user0（无独立注册表） |
| 日志 | 规划 Telemetry（未实现） | core/logging/ 落地：各模块 LogEvent 经注入 LogSink 直达 InMemoryLogger |
| 面板通信 | user0 邮局收信 | **PanelBus 统一通道**：回信/访问确认/通知 → 面板弹窗模块（shell/ui/dialog） |
