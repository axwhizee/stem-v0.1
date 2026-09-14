# stem 实际架构

> 本文档记录**当前系统架构**（落地后的真实形态；与规划冲突时以本文档与代码为准）。**模块内部实现住各模块 README**（见下「模块自述导航」）；本卷只承载总览、跨模块机制与导航。

> **模块自述导航**：
> - **core**：`src/core/{main,kernel,lineage,context,tools,gateway,config,pilot,events,logging}/README.md`
> - **shell**：`shell/{cli,webui,dashboard,feishu}/README.md` · **extension**：`extension/README.md`
> 承载各模块实现细节；本卷只承载**总览 + 跨模块机制 + 导航**。`api.md` 为交付产物（发布前可能滞后）。

---

## 一、总览

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 3 shell/（交互层，最外）—— 平台适配 + UI │
│ cli/ 参考 shell：platform(bootStem + extension 根注入 + bash │
│ runner) + gateway + storage(SQLite) │
│ webui/ WebUIShell：HTTP + SSE（OLED 主题；/api/health） │
│ feishu/ 飞书长连接 shell（免公网远程宿主；router 纯逻辑+SDK 适配） │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2 core/（纯 TS，零平台依赖，自治最小系统） │
│ main/ createStemSystem（组合根）· runInit 装载管线 · runtime 执行器 │
│ kernel/ Kernel · TemplateRegistry · InstanceManager │
│  · RuntimePort/SystemFacade 端口 · builtin/agents（内置类表） │
│ pilot/ Pilot（根扮演接口，依赖 SystemFacade）· events/（PilotEvent + EventHub） │
│ lineage/ LineageTree（族谱树：拓扑+能力+可见域）· context/（重建邮局 + wait）│
│ tools/ ToolCapabilityRegistry（出生声明+init）· access · accessRequest│
│  · output（统一输出）· internal/（系统工具 + bash / ShellRunner 端口） │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 1 Model Gateway (core/gateway/) ← 纯 TS（OpenAI 兼容泛化） │
│ ModelGateway · providers/(openaiCompatible) · FakeGateway │
└──────────────────────────────────────────────────────────────────────┘
 extension/{tools,agent,context}/ 矩阵 extension 层：目录形态资源（agent/context 分键点名；tools 点名即出生声明：{"名": 权限}）
 横切 Logging (core/logging/) —— 各模块 LogEvent 经注入 LogSink 直达记录器（无总线）
```

依赖方向（单向）：`shell → core(main/kernel/pilot/context/tools) → gateway`。core 目录零平台依赖（禁止 `import 'vscode'` 与平台全局）；平台能力（fs/网络/动态 import）全部以接口注入。组合根 `main` 依赖一切，**没有任何模块依赖 `main`**。

## 二、核心概念模型

### 2.1 全体 agent 绝对平等：路径 id + 全局 name

**一句话**：所有 agent（含根）是同一套机制的实例；**id = 出生路径（系统全托管），name = 可变称呼（全局唯一）**——根没有任何字段级特殊性，它只是族谱链上唯一没有"接收父表"的那次收敛。

- **id（路径形 `x.x`）**：根 = `0`；root 第 N 子 = `N`；子 = `<父id>.<出生序号>`（`1.3.2`）。序号 1 起、**永不回收**（terminate 留空洞；出生计数含归档墓碑——地址复用 = 历史信件指错实体，绝对禁止；重启扫描全库立计数器地板）。纯推导零查询：代际 = 段数、父 = `parentIdOf`（`1.3`→`1`；`3`→`0`；`0`→null）、祖先链 = 前缀。分隔符 `.`。`前缀 ⇔ isAncestorOf` 是审计断言（Ledger 与字符串互验），**权限裁决权威仍是物化，编码不是旁路**。`instantiate` 显式指定 id 的通道不存在（出生即路径）。
- **name（全局唯一，可变）**：出生 = 显式指定（**撞全局名 = 拒绝并明示**，绝不自动加后缀）或缺省确定性推导 `类名-下一号`（扫描含墓碑，可复现无随机）。根 name 缺省 `"user"` → **全名 `user#0`**（验收空间配置 `name: "船长"` 则全名 `船长#0`——名字是 config 实值不是系统定义）。可变面 `agent_update.name`（撞名拒）；DB 装载期唯一性校验（手改撞名 = boot 硬错）。role/worker 等机制实例同规——不造第二等公民。
- **呈现与解析**：一切对人/对模型的呈现（信件戳/agent_list/审批卡/错误 message）统一 **`name#id`**；写面解析三形态：**name 优先**（全局唯一无歧义，模型的认知舒适区），`name#id` 精确制导，裸 id 兼容（精确 → 唯一前缀 → name 反查）。
- **根实例（全名 `user#0`）= `user` 类的普通实例**：内置根模板在 `core/kernel/builtin/agents.ts` 统一类表，类配置 = **`config.user` 完整对象**（name/systemPrompt/tools/contextStrategy/model/sendCountdown/temperature/effort 全可配——元 agent 人格进配置文件；**tools = 纯收敛清单**（A2 链的第一环，值集见 defaults.ts 首启模板实值——模板是写好的 config 不是兜底机制）；`access_reply` 生效 allow 由 **boot 校验律**保证，缺位拒启）。在 **pilot 初始化流程内**实例化（`createPilot → SystemFacade.registerRootAgent`），与其它 agent 走完全相同的 `instantiate` 路径，无任何权限/流程特判；挂**真实项目空间**。
- **AgentClass（模板）**：`name（类名即标识）/ description / systemPrompt / tools（收敛清单：键即白名单 + 逐键只紧不松，见 2.2）/ contextStrategy / model / sendCountdown / temperature / effort`。面板性 = 实例 `assemble:false`；策略参数住策略模块公式。
- **AgentInstance**：`id（路径 `x.x`）/ name / classRef / assemble?（false=被外部扮演）/ status / turnCount / totalCost / totalTokens（终身累计）/ ctxTokens?（最近 prompt_tokens 反馈）/ toolOverride / model（显式层）/ modelBinding（出生落地）/ temperature / effort`。**父 = `parentIdOf(id)` 纯推导，不落库**；**userPrompt 不落实例**（只走 `InstantiateOptions.userPrompt` 首信投递）。拓扑永不入任何写通道（无 reparent 则地址永不腐化；**法与编码互保**）。
- **LineageTree 族谱树门面**（`core/lineage/`，实例层派生事实唯一面）：三相——**拓扑**（getParent/getChildren/getAncestors/getDescendants/getRoot/isAncestorOf，父 = `parentIdOf(id)` 纯推导）、**能力**（attach/detach/replay + effectiveAccess/profileOf + 模型相 modelOf/nodeConfigOf，出生落地无运行期全树 replay）、**可见域**（canReach = 自身∨祖先）。红线：权限/模型档案可启动重放重建；**节点全属性与运行时在实例行**；零类层依赖。
- **销毁权（fail-closed）**：仅目标的**祖先**可销毁（根天然不可销毁）；有活跃子默认拒，`recursive: true` 级联。
- **父子 = 所有权/责任关系，能力无关**：消息互通无方向限制、各自独立上下文与类。

### 2.2 工具权限：注册表 + 单操作收敛链

**一句话**：权限只有两个来源——**注册即出生声明**（有什么、出身如何）与**收敛清单**（谁能用到哪级）；后者对全链所有层级（根/类/策略/实例）是**同一个操作**：输入一张表 + 一份清单 → 输出一张更紧的表。ask 审批仍是**消息交换**。

- **四态**（`core/tools/types.ts`）：

| 状态 | 暴露给 LLM | 执行时 |
|---|---|---|
| `allow` | ✅ | ✅ 直接执行 |
| `ask` | ✅ | ⏸ 挂起（申请投申请者族谱根信箱，等根回复） |
| `deny` | ❌ | ❌ `access_denied` |
| `ignore` | ❌（背景在场） | ✅ 可执行（不设防：系统严守族谱即无幻觉盲调之虞） |

- **显式化收敛链**：`ignore→allow→ask→deny` 为唯一合法方向（每步 = 把工具往上显式化/加监督）。**一切 agent 一律平等**：
 - **注册表**（注册面生成总工具表）：internal 在 core 注册点硬编码出生权限（`access_reply: allow`、`bash: allow`，其余通例 `ignore`——上台面由清单显式化；**缺声明的工具 = 盘点补齐，无兜底**）；extension/custom 必须 `config.extensions.tools: {"名": "权限词"}` 点名（装载与出生一句话；**目录扫描废止**——未点名 = 不存在于世界，模型可写 `.stem/agent/` 但永不获得代码入口）；策略 `registerTool` 注册的工具出生恒 `ignore`；
 - **收敛链**：`注册表 ─根清单─▶ 根生效表 ─交付─▶ 类清单 ─▶ 策略声明清单* ─▶ 实例化清单 ─▶ 生效表`。清单语义同一把尺：写了 = 键即白名单（未列出局）+ 逐键沿链只紧不松（扩张即拒，错误带归因）；**整表缺席 = 完整继承接收表**（"缺席≠否决"）；空表 = 表态全关；
 - **两步独立**：类收敛与实例收敛分步套用（不预合并）——零合并逻辑，免费失败归因（"类收敛被拒"≠"实例收敛被锁"）；
 - **策略声明清单 = raise 步**（契约字段 `ContextStrategyModule.tools?`）：插在类清单后、实例清单前执行——**只抬不封**（逐键提升表内键，表外键与本地封闭面不动，纯 raise 链继承父封闭形）；封顶公式与白名单步同一把尺（出生 ∧ 链上显式），声明宽即违例 → 写入面**实例化拒绝**、物化面静默钳制——复用收敛检查，"策略与类配置矛盾"由法则自然宣判，零特判；
 - **grant**（仅策略 spawn 通道 `InstantiateOptions.accessMode`）：清单形整表替换 + 逐键父面封顶取严——本质是"白名单自限 + 收紧"的组合便利形，语义不变；
- **模型可见清单 = allow ∪ ask**（Runtime 组装工具定义时过滤）；`kind` 三分类**降为纯 provenance 元数据**（装载源/信级/审计展示），不参与任何权限推断——审计测试表驱动断言之。
- **能力物化（算法 = `lineage/AccessLedger.ts`）**：生效权限 = 族谱位置的函数，注册期两步物化 `{explicit, fallback}`（replay 按拓扑序重放，纯派生不入库）；查询 `effectiveAccess(agentId, key)`；`tools` 侧只认注入端口 `AccessResolver`（`ToolContext = {agentId, spaceId, signal?, callId?, parent?}`）。
- **boot 校验律（替代一切代码兜底）**：① 根生效表 `access_reply ≠ allow` → 拒启（明示 ask 消息化死锁理由——主权归 config，法只做审判）；② config.extensions.tools 键在装载源解析不到 → 拒启（未知键 fail-fast 同律）；③ 未知 config 顶层键照旧拒启。
- **ask 消息化**：命中 ask 时 `AccessAskBus` 把申请投递到**申请者族谱根信箱**（`<access_request>` 消息）并挂起；根经 `access_reply` 回复（once/always/reject+feedback）。**无 agent 特判**——根的 ask 发给自己，由扮演它的 shell 确认。
- **session 豁免备忘**：`always` = 该 `(agentId, accessKey)` 后续 ask 免询问（仅当前实例、不传播）；ask 环节备忘，**非权限层**（不参与收敛单调，绝不豁免 deny/ignore）。
- **全参数统一解析律（/ 保留）**：模型与权限同门面——生效模型 = 显式（实例行）> 类基因 > 父继承 > 家学（`config.user.model` 全链锚点）；**出生解析落地**（`modelBinding` 随行持久，改父不级联子女）；运行期可写面 = `name`/`model`/`temperature`/`effort`（`kernel.updateAgent` → `updateNode` 语义，无全树 replay）。

### 2.2b 上下文管理策略（`core/context/strategies/`）

**一句话**：每种策略 = 独立子模块，实现统一契约 `ContextStrategyModule`；触发点 = user_prompt 信件抵达、终点 = 完整上下文就绪后唤醒快递员；策略可导出专有动作（compact/dream）经 pilot / `context_apply` / CLI 调用；可自带工具与数据目录（装载期 `init`）。**契约面、classic/cortex 实现、参数与模块扮演 agent（role）细节 → `src/core/context/README.md`。**

### 2.3 Pilot：根（user#0）扮演接口（驾驶舱）

- `core/pilot/Pilot.ts`：`identity`（恒根，未来 `as(agentId)` 可扮演任意 agent）+ `subscribe(PilotEvent)` + 命令（sendMessage / instantiate（可带 name 显式出生名、model 显式出生；**id 恒系统按路径生成，无指定通道**）/ **setModel**（扮演通道）/ terminate / interrupt / replyAccess / contextOverview / exportContext / **runContextAction**（策略动作，如 compact）/ listAgents / inspect / activeAgents）。
- **扮演 = 根的 action**：`sendMessage` 记录人类输出为根的 assistant 消息（根完整 transcript），同一文本作为 user 消息投递给目标。
- `createPilot({ facade })`：pilot 初始化流程内实例化根（若未注册）。
- **不做抽象层**：外部（shell/webui）与 core 的一切交互经模块接口直连（日志导出、上下文数据库导出等不在 Pilot 内）。

### 2.4 事件流：PilotEvent + EventHub（多订阅者）

- `PilotEvent` 判别联合**五元**：`stream`（LLM 流式 text/reasoning/tool/usage/finish）/ `letter`（信箱来信，含 `<access_request>` 消息化申请）/ `status` / `tool`（工具执行相位 called/success/error，= ToolRecord.status 直转，main `attachToolRecordSink` 单点双写）/ `notice`（扩展位）。**tool 事件刻意无 args/result**（裁决：参数摘要不上广播——耗时客户端 called→success 相减，详情走 DB 面 telemetry/logger.query 按需查）；delta 类事件 live-only 定性（快照收口 = 轮末信件与仓库行，断线不补 delta 间隙）。
- `EventHub`：多订阅者 Set，`subscribe` 返回退订；新订阅者拿不到历史事件（初始视图靠直接查询模块）。
- kernel 的 `KernelOptions.onEvent` 收敛为单一 `(event: PilotEvent) => void`；Runtime 流式/状态经 kernel 转发到 hub。

### 2.5 中断与错误处理

- **中断入口**：`kernel.interruptAgent(agentId, { by })`（中断权与销毁权同源：**自身或祖先**，无根特判）；`kernel.abortAllAgents`（进程优雅收尾）。
- **三种场景**：用户主动中断（shell `/stop` / webui 中断）→ `interruptAgent` → Runtime.abort → `halt` 消息闭合 → `interrupted`；网络/网关中断（`GatewayError`）→ 主循环 catch → `halt`（部分文本原样入库）→ `interrupted`；进程中断（SIGINT/SIGTERM）→ `abortAllAgents` → 各 agent 消息闭合后退出。
- **消息完整性**：中断时已产出的部分 assistant 补 `<interrupted>` 标记入库（消息闭合），仓库完整保留，下一次送信自动恢复。

### 2.6 消息库：tag + 双索引 + legalize

- **tag**（`StoredMessage.tag?: string`）：可选，标记合成消息。**词表六元**（不再扩）：`''`（原生行）/ `summary`（classic 压缩）/ `cortex`（cortex 锚点与载体行）/ `ltm` / `note` / `stm`（三层记忆行）；**strategy 是上下文属性**（实例化时确定），组装器按 agent 策略解释 tag。记忆族 tag（cortex/ltm/note/stm）在卸载/清理选择集中恒被排除（dream 造的空间不被其它机制误伤）。
- **双索引**：`turn`（轮序号，user 消息开启新轮，system 为第 0 轮）+ `indexInTurn`（轮内 0-based 顺序）；Repository 自动维护。
- **legalize**（`core/context/legalize.ts` 纯函数）：组装 delivery 时统一过——悬空 tool_calls 裁剪 / 孤儿 tool 剔除 / tool→user 相邻插边界。保证删除/修改（`context_remove`/`context_edit` = markInvalid/updateMessage）后的上下文仍可经 gateway 发送。
- **导出/概览**（context 模块，纯数据转换，无权限概念）：`exportJsonl` / `overview`；Kernel 做权限编排，系统工具 `context_export`/`context_overview`（可见域 = canReach：自身或后代，祖先可代查）。

## 三、通信模型：仓库 · 管理员 · 快递员（重建邮局）

**一句话**：无集中式总线。上下文按"仓库（存储）→ 管理员（处理）→ 快递员（发送）"三模块协作；agent 通信直接投递到上下文管理员；log 走注入接口。

### 关键概念

- **仓库（Repository）**：上下文本体的唯一存储（`message / agentId / at / tokens / valid / from / tag? / turn / indexInTurn`）；任何消息先入库，触发 onChange。两标记分工：**tag = 是什么**（合成消息出处，strategy 写），**tokens = 多大**（计量：网关真实值优先、估算兜底，来源不设第二标记）。
- **token 真实计量（累积差分归位）**：gateway `usage` 事件（openaiCompatible 流式 `include_usage`）→ Runtime 双通道——① assistant 行 append 时**直记** `outputTokens`；② `contextManager.attributeUsage` 把**相邻请求 inputTokens 差分**（扣除上轮 output）按估算占比归位到两轮之间新入库的 tool/user 行（`Repository.setTokens` 静默修订不触发 onChange，persisted 写穿零 schema 迁移）。护栏：首轮只记基线（整段 prompt 含 schemas 无行级可分性）、差分非负（compact 跳变回落估算）、基线纯内存（重启/compact 自愈）。compact 阈值与 totalCost 随真实口径自动升级。
- **管理员（ContextManager）**：打发送者戳（user 消息用 from 生成 `<sender id="name#id" at="yymmdd.hhmm">`——时间+身份一枚戳，分钟精度，打戳器一处收口）、统一挂起（`Waiter`：instantiate.wait / waitForReply / agent_pause）、**策略 process（异步，user_prompt 抵达触发）→ 就绪后唤醒快递员**、组装（按 agent 策略分发 + **legalize**；组装权归管理员——快递员只发不组装）。
- **快递员（Courier）**：按 agentId 维护发送倒计时（初始 0 立即送；发送后开始；来信重置）；agent 送信快照经管理员委托（`buildAgentDelivery`）构造，面板（`assemble:false`）信件 diff 自持。
- **消息 ≠ 上下文**：通信消息直接投递；上下文由管理员按模式组装。

### 唤醒语义（重要）

- **只有外部来信唤醒快递员**：`deposit`（外部消息投递）才触发 `courier.notifyReady`；agent 自身的 `appendHistory`（assistant/tool 入库）**不**触发重投递——否则 agent 自回复会无限循环。
- **统一挂起（`context/wait.ts` Waiter）**：`wait({key, owner, timeoutMs?, signal?}) → event|timeout|aborted`；`emit(key,payload)`；`cancelOwner(owner)` 挂 unregister/terminate。映射：`ask` = `ask:<requestId>`；`instantiate.wait` / `waitForReply` = hold 表 + `reply:<from>`；`agent_pause` = `timer:<toolCallId>` 纯倒计时。hold 随实例化**先于首信注册**（竞态从时序上根除）；hold 可配 timeoutMs 超时自回填；runtime 见 `contextWait` 标记**收束轮循环**（不空转）。默认计时器单点 `defaultTimer`。

### 送信倒计时（快递员维护的局部量）

- 倒计时**初始为 0**：首信到达立即组装送信。
- **仅发送完一次上下文后**才进入倒计时（= 合并下一批来信的滑动窗口），倒计时期间新来信**重置**倒计时。
- **送信条件**：上下文就绪**且**倒计时就绪；否则保持 holding。默认 `sendCountdownMs = 1000ms`（模板可配；user 类为 0）。

## 四、模块导航

各模块实现细节住各自 README；本卷不复述。跨模块机制见第二、三节。

| 层 | 模块 | 职责 | README |
|---|---|---|---|
| core | main | 组合根（`createStemSystem`）+ 装载管线（`runInit`）+ Runtime + internal 工具/记录 sink 接线 | `src/core/main/README.md` |
| core | kernel | 领域聚合（实例/模板/空间）+ 持有邮局 + 运行期写通道 | `src/core/kernel/README.md` |
| core | lineage | 族谱树：拓扑 + 能力物化（权限/模型）+ `canReach` | `src/core/lineage/README.md` |
| core | context | 重建邮局（仓库/管理员/快递员）+ 策略 + 持久化端口 | `src/core/context/README.md` |
| core | tools | 工具框架 + 访问四态代数 + internal 工具（系统/bash） | `src/core/tools/README.md` |
| core | gateway | 模型网关契约 + OpenAI 兼容 provider | `src/core/gateway/README.md` |
| core | config | `StemConfig` + `.stem/agent` 文件契约 | `src/core/config/README.md` |
| core | pilot | 根（user#0）扮演接口（经 SystemFacade） | `src/core/pilot/README.md` |
| core | events | `PilotEvent` + EventHub | `src/core/events/README.md` |
| core | logging | `LogEvent` + Logger + forget | `src/core/logging/README.md` |
| shell | cli | 参考 shell：`bootStem` + 网关路由 + SQLite + CLI | `shell/cli/README.md` |
| shell | webui | HTTP + SSE + 单页 UI | `shell/webui/README.md` |
| shell | dashboard | 空间仪表盘（法医/管理员） | `shell/dashboard/README.md` |
| shell | feishu | 飞书长连接远程 shell | `shell/feishu/README.md` |
| ext | extension | 矩阵 extension 层（tools/agent/context 目录形态） | `extension/README.md` |

## 五、messages 经典模式的定制化

1. **自动返回**：任何 agent 最终纯文本回复自动寄信给创建者（= 族谱父）。
2. **发送者戳**：`<sender id="name#id" at="260907.0039">内容</sender>`（管理员打戳生成；带分钟时间戳——agent 判断事件远近的免费时序面）。
3. **user_prompt 组装**：信件在送信时合并为 user_prompt 进入上下文。

## 六、端到端时序（验收任务）

```
1. pilot（根 user#0 扮演）─sendMessage─▶ 管理员 deposit(from=根) → 仓库 append → onChange（打戳）
2. 管理员 wake：策略 process（user_prompt 触发点；如 classic 超阈值 compact——
 spawn 摘要 worker → 回信配对 → 摘要入库/旧段失效）→ 返回 = 完整上下文就绪
 → 快递员 notifyReady（倒计时合并窗口）
3. 快递员: 经管理员委托取送信快照（策略 assemble + legalize）→ 发送 AgentDelivery → processDelivery
4. agent: thinking → tool_call(agent_instantiate) → 创建子 agent（parentId=调用者，台账继承+收敛绑定）
5. 子 agent: 首信投递 → 快递员发送 → thinking → tool_call(oc_get_time) → 工具结果入仓库
6. 子 agent: 最终回复投递给创建者（instantiate.wait 命中挂起 → 作为 tool 结果填充）
7. 创建者: 续轮 → 回复用户 → 投递给根 → letter 事件 → shell/webui 展示
```

## 七、技术选型

- TypeScript + tsx（运行/测试，**dependencies**——镜像 `--omit=dev` 不剔除）+ node:test；运行时依赖 jsonc-parser / yaml；**node >= 23.4**（`node:sqlite` 免 flag）。
- 发布形态：Docker（`node:24-slim` + 非 root + `/data` volume + HEALTHCHECK `/api/health`）——**容器即 bash 的安全边界**，挂载 volume = 爆炸半径。
- 个体层存储：SQLite（`node:sqlite` DatabaseSync）write-through，经 core 端口注入（见 `src/core/context/README.md`、`src/core/kernel/README.md`）；缺省纯内存（测试 harness 不受影响）。
- 运行时数据文件：`.stem/mem/<agentId>/`（cortex 笔记正文 + `.memory.json` 镜像）——**派生/外挂文件不进 DB**（记忆真相在仓库行，镜像单向永不回灌；笔记文件由策略 fs 口读写，磁盘 = 正文真相）。
- 族谱存储：无独立存储（父 = `parentIdOf(id)` 纯推导；实例行本身持久化即族谱持久）。
- LLM 端点：真实 go/zen（`https://opencode.ai/zen/go/v1/chat/completions`）或 mock SSE 兜底。
