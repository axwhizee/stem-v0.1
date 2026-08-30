# stem 实际架构

> 本文档记录**实际开发过程中明确的系统架构**与各模块内部的实现逻辑（`docs/architecture.md` 是最初的目标规划；本文档是落地后的真实形态，若与规划冲突以此为准，并会同步修订）。

**日期**：2026-08-22

---

## 一、总览

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 3  shell/（交互层，最外）—— 平台适配 + UI                          │
│   cli/   参考 shell：platform(bootStem 共享装配) + gateway + fs 工具集   │
│   webui/ WebUIShell：HTTP + SSE（agent 侧栏 / timeline / composer）     │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2  core/（纯 TS，零平台依赖，自治最小系统）                       │
│   init/     createStemSystem（组合根）· runInit 扫描管线                 │
│   kernel/   Kernel · TemplateRegistry · InstanceManager · SpaceManager │
│             Runtime（被动驱动）· userClass（内置 user 类）               │
│   pilot/    Pilot（user0 扮演接口）· events/（PilotEvent + EventHub）    │
│   lineage/  LineageTree（族谱纯关系视图）· context/（重建邮局 + legalize）│
│   tools/    ToolCapabilityRegistry（init 生命周期）· access · accessRequest│
│             · SkillRegistry · skill 工具                                │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 1  Model Gateway (core/gateway/)  ← 纯 TS（opencode 隔离）       │
│   ModelGateway · providers/(opencodeLlm / fetch) · FakeGateway         │
└──────────────────────────────────────────────────────────────────────┘
   extension/tools/  可选功能扩展（预留：扩展工具集 seam，如 VSCode 工具集）
   横切  Logging (core/logging/) —— 各模块 LogEvent 经注入 LogSink 直达记录器（无总线）
```

依赖方向（单向）：`shell → core(kernel/pilot/context/tools) → gateway`。core 目录零平台依赖（禁止 `import 'vscode'` 与平台全局）；平台能力（fs/网络/动态 import）全部以接口注入。

## 二、核心概念模型

### 2.1 全体 agent 绝对平等，user0 是 `user` 类实例

**一句话**：所有 agent（含 user0）是同一套机制的实例；user0 的特殊之处仅在于 `parentId = null`（根）与采用内置 `user` 类。

- **user0 = `user` 类的普通实例**：内置根模板 `core/kernel/userClass.ts`（`systemPrompt=''`、`sendCountdown=0`、`tools` = config 的 `permission`）。在 **pilot 初始化流程内**实例化（`createPilot → kernel.registerRootAgent`），与其它 agent 走完全相同的 `instantiate` 路径，无任何权限/流程特判。
- **AgentClass（模板）**：`name（即 id）/ description / systemPrompt / tools（Record<访问键, ask|deny|allow|ignore>，键即白名单）/ contextStrategy / model / sendCountdown`。
- **AgentInstance**：`id / classRef / parentId / displayName / spaceId / status / turnCount / totalCost / userPrompt / toolOverride`；`parentId` 即族谱父（= 创建者，user0 为 null 即根），创建时确定、不可变（`creatorId` 已合并）。
- **LineageTree**（`core/lineage/`，**无状态关系查询视图**，零 tools 依赖）：`getParent / getChildren / getAncestors / getDescendants / getRoot / isAncestorOf`，全部基于 InstanceManager 实时推导（parentId 单一事实源）。
- **销毁权（fail-closed）**：仅目标 agent 的**祖先**可销毁（`isAncestorOf`；根 `parentId=null` 无祖先 → 天然不可销毁）；有活跃子默认拒，`recursive: true` 级联整棵子树。
- **父子 = 所有权/责任关系，能力无关**：消息互通无方向限制、各自独立上下文与类。

### 2.2 工具访问（ToolAccess）：四态 + 族谱收敛 + ask 消息化

**一句话**：工具访问状态是 agent 类工具清单中的属性值，四态 `allow / ask / deny / ignore`；生效权限沿族谱单调收敛；ask 审批是**消息交换**。

- **四态**（`core/tools/types.ts`）：

| 状态 | 暴露给 LLM | 执行时 |
|---|---|---|
| `allow` | ✅ | ✅ 直接执行 |
| `ask` | ✅ | ⏸ 挂起（投递申请到根信箱，等根回复） |
| `deny` | ❌ | ❌ `access_denied` |
| `ignore` | ❌ 默认隐藏 | ✅ 等同 allow（显式 allow 后暴露） |

- **`ignore`（internal 系统工具默认隐藏）**：`kind=internal` 的 core 系统工具与 skill 默认 `ignore`，除非类清单显式声明；隐藏是可见性控制，越权由 `deny` 负责。
- **评估**（`core/tools/access.ts` 纯函数）：`evaluateAccess(key, layers, defaultAccess)` 层间取最严格（单调收缩，`deny ≺ ask ≺ {allow, ignore}`）；层顺序 = `[祖先链(含 config.permission=user 类 tools), agent 类, session 批准(仅当前实例)]`；`collectAncestorAccessLayers` 收集祖先层；`deny` 不可被后序撤销。
- **ask 消息化（扁平化）**：命中 ask 时 `core/tools/accessRequest.ts`（`AccessAskBus`）自动把申请投递到**申请者的族谱根信箱**（`<access_request>` 消息，机制同向模型发消息）并挂起；根 agent 经 `access_reply` 工具回复（once/always/reject，可带 feedback）。**无任何 agent 特判**——user0 的 ask 发给自己，由扮演它的 shell 经 pilot 确认。

### 2.3 Pilot：user0 扮演接口（驾驶舱）

- `core/pilot/Pilot.ts`：`identity`（恒 user0，未来 `as(agentId)` 可扮演任意 agent）+ `subscribe(PilotEvent)` + 命令（sendMessage / instantiate / terminate / interrupt / replyAccess / contextOverview / exportContext / listAgents / inspect / activeAgents）。
- **扮演 = user0 的 action**：`sendMessage` 记录人类输出为 user0 的 assistant 消息（user0 完整 transcript），同一文本作为 user 消息投递给目标。
- `createPilot({ kernel })`：pilot 初始化流程内实例化 user0（若未注册）。
- **不做抽象层**：外部（shell/webui）与 core 的一切交互经模块接口直连（日志导出、上下文数据库导出等不在 Pilot 内）。

### 2.4 事件流：PilotEvent + EventHub（多订阅者）

- `PilotEvent` 判别联合：`stream`（LLM 流式 text/reasoning/tool/usage/finish）/ `letter`（信箱来信，含 `<access_request>` 消息化申请）/ `status` / `notice`（扩展位）。
- `EventHub`：多订阅者 Set，`subscribe` 返回退订；新订阅者拿不到历史事件（初始视图靠直接查询模块）。
- kernel 的 `KernelOptions.onEvent` 收敛为单一 `(event: PilotEvent) => void`；Runtime 流式/状态经 kernel 转发到 hub。

### 2.5 中断与错误处理

- **中断入口**：`kernel.interruptAgent(agentId, { by })`（销毁权复用：仅祖先）；`kernel.abortAllAgents()`（进程优雅收尾）。
- **三种场景**：用户主动中断（shell `/stop` / webui 中断）→ `interruptAgent` → Runtime.abort → `halt` 消息闭合 → `interrupted`；网络/网关中断（`GatewayError`）→ 主循环 catch → `halt`（部分文本原样入库）→ `interrupted`；进程中断（SIGINT/SIGTERM）→ `abortAllAgents` → 各 agent 消息闭合后退出。
- **消息完整性**：中断时已产出的部分 assistant 补 `<interrupted>` 标记入库（消息闭合），仓库完整保留，下一次送信自动恢复。

### 2.6 消息库：tag + 双索引 + legalize

- **tag**（`StoredMessage.tag?: string`）：可选，标记合成消息（summary/impression/meta）；**strategy 是上下文属性**（实例化时确定），组装器按 agent 策略解释 tag。
- **双索引**：`turn`（轮序号，user 消息开启新轮，system 为第 0 轮）+ `indexInTurn`（轮内 0-based 顺序）；Repository 自动维护。
- **legalize**（`core/context/legalize.ts` 纯函数）：组装 delivery 时统一过——悬空 tool_calls 裁剪 / 孤儿 tool 剔除 / tool→user 相邻插边界。保证删除/修改（`context_remove`/`context_edit` = markInvalid/updateMessage）后的上下文仍可经 gateway 发送。
- **导出/概览**（context 模块，纯数据转换，无权限概念）：`exportJsonl` / `overview`；Kernel 做权限编排，系统工具 `context_export`/`context_overview`（agent 只能看自己的或祖先的）。

## 三、通信模型：仓库 · 管理员 · 快递员（重建邮局）

**一句话**：无集中式总线。上下文按"仓库（存储）→ 管理员（处理）→ 快递员（发送）"三模块协作；agent 通信直接投递到上下文管理员；log 走注入接口。

### 关键概念

- **仓库（Repository）**：上下文本体的唯一存储（`message / agentId / at / tokens / valid / from / tag? / turn / indexInTurn`）；任何消息先入库，触发 onChange。
- **管理员（ContextManager）**：打发送者戳（user 消息用 from 生成 `<sender id>`）、context_wait 判定（命中挂起 → 作为 tool 结果填充）、组装（`ContextAssembler` 可注入）+ **legalize**；可选 `skills` 依赖注入 `<available_skills>` 清单。
- **快递员（Courier）**：按 agentId 维护发送倒计时（初始 0 立即送；发送后开始；来信重置），发送时按 valid 顺序取有效消息。
- **消息 ≠ 上下文**：通信消息直接投递；上下文由管理员按模式组装。

### 唤醒语义（重要）

- **只有外部来信唤醒快递员**：`deposit`（外部消息投递）才触发 `courier.notifyReady`；agent 自身的 `appendHistory`（assistant/tool 入库）**不**触发重投递——否则 agent 自回复会无限循环。
- **context_wait 填充**：等待目标的回复命中挂起 → 作为 tool 结果填充到等待者 + 唤醒等待者。

### 送信倒计时（快递员维护的局部量）

- 倒计时**初始为 0**：首信到达立即组装送信。
- **仅发送完一次上下文后**才进入倒计时（= 合并下一批来信的滑动窗口），倒计时期间新来信**重置**倒计时。
- **送信条件**：上下文就绪**且**倒计时就绪；否则保持 holding。默认 `sendCountdownMs = 1000ms`（模板可配；user 类为 0）。

## 四、模块职责与内部实现

### 4.1 上下文三模块（`core/context/`）

- **仓库（Repository.ts）**：`register` 时把 systemPrompt（含 `<available_skills>` 清单）作为首条 system message；`append` 触发 `onChange(agentId)`。
- **管理员（ContextManager.ts）**：打戳 / context_wait 判定 / 组装（组装结果过 `legalize`）；`deposit` 显式唤醒快递员（见唤醒语义）；`appendHistory` 不唤醒。
- **快递员（Courier.ts）**：agent 收 `AgentDelivery`（含 `messageIds`）；`assemble:false` 的注册（user0 曾用）只汇总 user 信件（`UserDelivery`）——user0 全平等化后仍保留该通用选项作为信件通道。

### 4.2 Runtime（`core/kernel/Runtime.ts`，被动驱动）

- 不是同步 run：由快递员送信回调驱动（`processDelivery`）。
- 状态机：`idle →(送信)→ thinking →(LLM 返回)→ holding`；`interrupted`（可恢复）。
- 收完整上下文（`AgentDelivery`）→ 发 LLM → 工具轮（并行执行，结果按 index 回填）→ 每轮 assistant 消息自动复制到仓库 → 最终纯文本回复投递给**创建者**（= 族谱父）；发送者戳由管理员统一生成。
- 中断控制器 + 三层 try/catch + halt 消息闭合（见 2.5）；各 agent 独立 AsyncGenerator 天然并发。

### 4.3 InstanceManager（`core/kernel/InstanceManager.ts`）

- 实例化必填：`className` + `userPrompt`（字符串，根可为空串）+ `parentId`（根为 null）；父必须已存在（根除外）；`agentId` 可选（默认随机 4 位，冲突报错）。
- `parentId` 即创建者；根（parentId=null）无祖先 → 天然不可销毁。

### 4.4 LineageTree（`core/lineage/`，族谱纯关系视图）

- 事实源（manager 持有 parentId）+ 查询视图（实时推导）；`getInstance`/`getAllInstances` 由组合根注入。
- 销毁权判定 `isAncestorOf`；权限继承在 `tools/access.ts`（`collectAncestorAccessLayers`），本模块不依赖 tools。

### 4.5 ToolCapabilityRegistry（`core/tools/`）

- 注册/查询/materialize（按访问层过滤可见性）/execute（统一访问确认 + 参数校验 + ToolHooks）。
- 工具来源三分类（`ToolKind`）：`internal`（core 系统工具，默认 ignore）/ `shell`（宿主内置）/ `user`（用户 `.stem/tool/`）。
- **`initAll(ctx)` 生命周期**：`ToolCapability.init?(ctx: ToolInitContext)`（fs/skills/skillDir/log 注入），装配后调用一次、幂等、工具间禁跨依赖（skill 工具借此扫描 `.stem/skills/`）。

### 4.6 系统工具（`core/kernel/systemTools.ts`，kind=internal）

| 工具 | 作用 |
|---|---|
| `agent_class_create` / `agent_class_list` | 创建/列出 agent 类（name 即 id + tools 清单） |
| `agent_instantiate` / `agent_list` / `agent_inspect` | 创建实例（父=调用者）/ 列出 / 详情 |
| `agent_ancestry` / `agent_descendants` / `agent_terminate` | 祖先链 / 后代 / 终止（销毁权 + recursive） |
| `bus_send` / `bus_participants` | 发消息 / 参与者列表 |
| `context_wait` | 等待指定 agent 回复（其回复作为 tool 结果填充） |
| `context_export` / `context_overview` / `context_remove` / `context_edit` | 导出 jsonl / 概览 / 删除过时消息（markInvalid）/ 重写消息（system 除外） |
| `access_reply` | 批准/拒绝访问申请（once/always/reject；授权权=申请者的族谱根） |

> 系统工具 `kind=internal` → 默认 `ignore`，示例模板在 `tools` 显式 `allow`。

### 4.7 host 内置工具（`shell/cli/tools/`，kind=shell）

| 工具 | 作用 |
|---|---|
| `read` | 读取文本文件（offset/limit 分页）+ 目录列出；二进制检测 |
| `write` | 全量写入（父目录自动创建） |
| `edit` | oldString/newString 精确替换（0/多次匹配校验） |
| `grep` | 正则递归搜索（排除 .git/node_modules） |
| `glob` | glob 模式匹配文件 |

### 4.8 Gateway（`core/gateway/`）

- `ModelGateway` 接口、`providers/opencodeLlm`（单点，解析 reasoning_content → reasoning-delta）、`fetch`、`FakeGateway`。
- 并行工具调用：协议层 `tool_calls` 数组原生支持；工具轮并行执行，结果按 index 回填。

### 4.9 工具访问确认（`core/tools/accessRequest.ts`，取代 AccessManager/PanelBus）

- 分层评估（`access.ts`）+ `AccessAskBus`：`assert`（allow/ignore 通过 / deny 抛错 / ask 投递申请到根信箱并挂起）+ `reply(input, by)`（根授权校验 once/always/reject）。
- **无元 agent 短路**：user0 也是普通 agent，其 ask 发给自己，由扮演它的 shell 经 pilot 确认（`replyAccess`）。
- `autoApprove`（config）时 ask 直接放行（deny 仍拒绝）。

### 4.10 事件流（`core/events/`，取代 PanelBus）

- `PilotEvent` + `EventHub`（多订阅者）；`letter` 承载一切信箱来信（含 `<access_request>` 消息化申请）；shell/webui 统一订阅，不再有面板消息类型。

### 4.11 Logging 横切（`core/logging/`）

- 各模块经注入 `LogSink` 发日志 → 组合根接到 `Logger`（无总线）。
- `LogEvent`：`tool.invoked` / `gateway.apiRequest` / `context.assembled` / `mailbox.countdown|delivered` / `access.asked|replied` / `kernel.*`（class.registered / instance.created / status.changed / instance.terminated / instance.interrupted / message.sent）。
- `InMemoryLogger`：留档 + `query({agentId, type})` 过滤。

### 4.12 全局配置 + 初始化（`core/config/` + `core/init/`）

**唯一配置文件**：`<projectRoot>/.stem/stem.jsonc`（或 `.stem/stem.json`）。

- 配置项：`model`（`提供商/模型`）、`autoApprove`、`permission`（**= user 模板的工具权限**，内置根类 tools，族谱首层收敛起点）、`sendCountdown`、`tools`/`agents`（同步注册表，init 自动维护）。
- **系统装配**（`core/init/system.ts`，`createStemSystem(deps)` 组合根）：
  0. （可选 `stateStore` 注入）Kernel 构造内：内存核建好后先从 store 恢复（实例/消息/空间 + 状态归一化 + id 计数器续接），再套 write-through 装饰器，恢复出的实例在构造末尾统一接线上下文——装配顺序不变，恢复收敛在 Kernel 内；
  1. 读取配置 → 工具注册表 + Kernel（user 类 tools = config.permission，`skills` 注入）；
  2. 系统工具（agent_*/bus_*/context_* + access_reply）→ 宿主工具 → skill 工具；
  3. `runInit` 管线：扫描 `.stem/tool/*.ts`（默认导出 ToolCapability）+ `.stem/agent/*.md`（YAML 头 + 正文）→ 同步注册表（jsonc-parser 定点写回）→ 注册进 registry；
  4. `createPilot`（pilot 初始化内实例化 user0）→ 订阅事件流；
  5. `tools.initAll`（skill 扫描 `.stem/skills/*.md`）→ 用户注入钩子（`userHooks`，init 末尾，深度扩展）。
- 返回 `StemSystem { kernel, pilot, tools, config, init, dispose }`；任何 shell 注入平台能力即可装配出完整最小系统。

### 4.13 shell 层（`shell/cli/` + `shell/webui/`）

- **cli**（参考 shell）：`platform.ts`（`bootStem`：config + 网关 + createStemSystem + fs 工具集 + 示例模板钩子，供任何 shell 复用）+ `gateway.ts`（真实 go/zen / mock SSE）+ `storage/`（`createSqliteStateStore`：node:sqlite 实现两端口，默认 `.stem/stem.db`）+ CLI 命令（直接对话 /new /use /agents /templates /tools /stop）。
- **webui**（WebUIShell）：`node:http` + SSE，复用 cli 的 platform；REST（send/instantiate/terminate/interrupt/access）+ 观察（agents/templates/context）+ 单页 UI（agent 侧栏 / timeline / composer / 权限弹窗 = 渲染 `<access_request>` 消息 + `access_reply`）。

### 4.14 extension（`extension/tools/`，预留）

- 可选功能扩展 seam：`registerExtensionTools(registry)` 约定签名（未实现迁移）；fs 工具集未来迁此，可被 VSCode 工具集替换。
- skill / MCP 属 core 生态（上下文组装 + 配置目录解析），不在 extension。

### 4.15 持久化（个体层 SQLite，write-through）

**分层边界**：类层持久 = 文件（`.stem/agent/*.md` 镜像注册表，用户主权可审）；**个体层持久 = SQLite**（实例/消息/空间）。核心思想：**内存为准 + write-through（DB 为影）**——同步读接口（list/listValid/getState）零破坏，写操作内存生效后同步落行（单进程 + DatabaseSync，崩溃窗口为零）。

- **端口（core，零平台依赖）**：`context/store.ts` `MessageStore`（upsert/archiveAgent/loadBoxes/maxMessageSeq）；`kernel/store.ts` `InstanceStore`（实例 upsert/delete/loadAll + 空间 upsertSpace/deleteSpace/loadSpaces）。接口与默认内存实现同文件（`MemoryMessageStore`/`MemoryInstanceStore`，测试即用它观测持久化）。
- **装饰器（core）**：`context/persisted.ts` `PersistedRepository`；`kernel/persisted.ts` `PersistedInstanceManager` / `PersistedSpaceManager`——全部委托内层内存实现 + 写穿。**terminate = 个体消亡**：实例/空间行删除，**消息行归档**（archived 标记，进化语料保留，恢复不加载、id 计数器避开历史序号）。
- **恢复语义（Kernel 构造内，装配步骤 0）**：实例装载（**活跃状态归一化** thinking/holding → interrupted，halt 语义下消息闭合可恢复）→ 消息箱重放（反演 push 状态机还原 turn/indexInTurn 计数器 + `setCounterFloor` 防撞）→ 空间装载（spaceId 重启可解析）→ 上下文接线（`ContextRegistration.restore=true` 跳过仓库开辟；快递员 `initialSentIds` 预置 → **重启零重放**）→ user0 幂等（`createPilot` 检测根已存在即跳过）。悬空 context_wait 等待不恢复，交给组装期 **legalize** 自然兜底。
- **SQLite 适配（shell/cli/storage/）**：`node:sqlite`（`DatabaseSync`）；行 = 记录全量 JSON + `agent_id/seq` 冗余列；`PRAGMA user_version` 迁移守卫；rollback journal（9P/WAL-shm 安全）；默认 `<projectRoot>/.stem/stem.db`（`STEM_DB_PATH` 覆盖，`bootStem` 注入，缺省即持久，`stateStore:false` 显式纯内存）。
- **已知边界**：`turnCount/totalCost` 经引用直改不经装饰器，最后一次状态变更时全字段快照收敛——最多丢"进行中的一轮"记账零头（消息本体不受影响）；单进程假设；webui/cli 重启后 user0 出现在 agent 列表（平等化后属正常视图，UI 未过滤）。

## 五、messages 经典模式的定制化

1. **自动返回**：任何 agent 最终纯文本回复自动寄信给创建者（= 族谱父）。
2. **发送者戳**：`<sender id="xxx">内容</sender>`（管理员打戳生成）。
3. **user_prompt 组装**：信件在送信时合并为 user_prompt 进入上下文。

## 六、端到端时序（验收任务）

```
1. pilot（user0 扮演）─sendMessage─▶ 管理员 deposit(from=user0) → 仓库 append → onChange
2. 管理员 handleChange: 打戳 → 组装 + legalize → 快递员 notifyReady（deposit 唤醒）
3. 快递员: 取 valid 消息 → 发送 AgentDelivery → processDelivery
4. agent: thinking → tool_call(agent_instantiate) → 创建子 agent（parentId=调用者）
5. 子 agent: 首信投递 → 快递员发送 → thinking → tool_call(oc_get_time) → 工具结果入仓库
6. 子 agent: 最终回复投递给创建者（context_wait 命中 → 作为 tool 结果填充）
7. 创建者: 续轮 → 回复用户 → 投递给 user0 → letter 事件 → shell/webui 展示
```

## 七、技术选型

- TypeScript + tsx（运行/测试）+ node:test；运行时依赖 jsonc-parser / yaml；**node >= 23.4**（`node:sqlite` 免 flag）。
- 个体层存储：SQLite（`node:sqlite` DatabaseSync）write-through，经 core 端口注入（4.15）；缺省纯内存（测试 harness 不受影响）。
- 族谱存储：无独立存储（parentId 挂在实例上，LineageTree 实时推导；实例行本身持久化即族谱持久）。
- LLM 端点：真实 go/zen（`https://opencode.ai/zen/go/v1/chat/completions`）或 mock SSE 兜底。
