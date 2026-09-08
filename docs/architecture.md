# stem 实际架构

> 本文档记录**实际开发过程中明确的系统架构**与各模块内部的实现逻辑（落地后的真实形态，与规划冲突时以本文档为准，并会同步修订）。
> **窗口期声明**：工具模型节（§2.2/4.5/4.12）与身份存储节（§2.1/三/4.3/4.4/4.15/信戳）已按 s11-plan 终案落地并对拍；§2.2b cortex 与 §五 feishu 会话模型仍先行于码（s11-c/d 落地后删除本声明）。冲突时以 s11-plan 裁决链 + §K 交接账为准。

**日期**：2026-08-22 · 最后同步 2026-09-08（身份代数落地：路径 id `0`/全局 name/信件戳 name#id+分钟时刻/存储 v3 拒载——本卷两处实现漏网已修：agentId 随机描述行、agent_update displayName 行）

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
│ init/ createStemSystem（组合根）· runInit（目录即真相，不回写） │
│ kernel/ Kernel · TemplateRegistry · InstanceManager · SpaceManager │
│ Runtime（被动驱动）· builtin/agents（内置类表） │
│ pilot/ Pilot（根扮演接口）· events/（PilotEvent + EventHub） │
│ lineage/ LineageTree（族谱树：拓扑+能力+可见域）· context/（重建邮局）│
│ tools/ ToolCapabilityRegistry（出生声明+init）· access · accessRequest│
│ · bash 工具（ShellRunner 端口） │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 1 Model Gateway (core/gateway/) ← 纯 TS（OpenAI 兼容泛化） │
│ ModelGateway · providers/(openaiCompatible) · FakeGateway │
└──────────────────────────────────────────────────────────────────────┘
 extension/{tools,agent,context}/ 矩阵 extension 层：目录形态资源（agent/context 分键点名；tools 点名即出生声明：{"名": 权限}）
 横切 Logging (core/logging/) —— 各模块 LogEvent 经注入 LogSink 直达记录器（无总线）
```

依赖方向（单向）：`shell → core(kernel/pilot/context/tools) → gateway`。core 目录零平台依赖（禁止 `import 'vscode'` 与平台全局）；平台能力（fs/网络/动态 import）全部以接口注入。

## 二、核心概念模型

### 2.1 全体 agent 绝对平等：路径 id + 全局 name

**一句话**：所有 agent（含根）是同一套机制的实例；**id = 出生路径（系统全托管），name = 可变称呼（全局唯一）**——根没有任何字段级特殊性，它只是族谱链上唯一没有"接收父表"的那次收敛。

- **id（路径形）**：根 = `0`；子 = `<父id>-<出生序号>`（`0-3-2-7`）。序号 1 起、**永不回收**（terminate 留空洞；出生计数含归档墓碑——地址复用 = 历史信件指错实体，绝对禁止；重启扫描全库立计数器地板）。纯推导零查询：代际 = 段数、父 = 去尾段、祖先链 = 前缀。分隔符 `-`（URL/文件名/shell 三安全；id 段只含数字，与含 `-` 的类名一眼可辨）。`前缀 ⇔ isAncestorOf` 是审计断言（Ledger 与字符串互验），**权限裁决权威仍是物化，编码不是旁路**。`instantiate` 显式指定 id 的通道不存在（出生即路径）。
- **name（全局唯一，可变）**：出生 = 显式指定（**撞全局名 = 拒绝并明示**，绝不自动加后缀）或缺省确定性推导 `类名-下一号`（扫描含墓碑，可复现无随机）。根 name 缺省 `"user"` → **全名 `user#0`**（验收空间配置 `name: "船长"` 则全名 `船长#0`——名字是 config 实值不是系统定义）。可变面 `agent_update.name`（撞名拒）；DB 装载期唯一性校验（手改撞名 = boot 硬错）。role/worker 等机制实例同规——不造第二等公民。
- **呈现与解析**：一切对人/对模型的呈现（信件戳/agent_list/审批卡/错误 message）统一 **`name#id`**；写面解析三形态：**name 优先**（全局唯一无歧义，模型的认知舒适区），`name#id` 精确制导，裸 id 兼容（精确 → 唯一前缀 → name 反查）。
- **根实例（全名 `user#0`）= `user` 类的普通实例**：内置根模板在 `core/kernel/builtin/agents.ts` 统一类表，类配置 = **`config.user` 完整对象**（name/systemPrompt/tools/contextStrategy/model/sendCountdown 全可配——元 agent 人格进配置文件；**tools = 纯收敛清单**（A2 链的第一环，值集见 defaults.ts 首启模板实值——模板是写好的 config 不是兜底机制）；`access_reply` 生效 allow 由 **boot 校验律**保证，缺位拒启）。在 **pilot 初始化流程内**实例化（`createPilot → kernel.registerRootAgent`），与其它 agent 走完全相同的 `instantiate` 路径，无任何权限/流程特判；挂**真实项目空间**。
- **AgentClass（模板）**：`name（类名即标识）/ description / systemPrompt / tools（收敛清单：键即白名单 + 逐键沿 ignore→allow→ask→deny 只紧不松，见 2.2）/ contextStrategy / model / sendCountdown / panel（模块扮演面板）/ custom（自由扩展位）`。
- **AgentInstance**：`id（路径）/ name / classRef / parentId / spaceId / status / turnCount / totalCost / userPrompt / toolOverride / model（显式层）/ modelSnapshot（出生快照）`；`parentId` 即族谱父（= 创建者，根为 null），创建时确定、不可变——**拓扑永不入任何写通道**（这条既有律恰是路径 id 成立的守护：无 reparent 则地址永不腐化；**法与编码互保**）。
- **LineageTree 族谱树门面**（`core/lineage/`，实例层派生事实唯一面）：三相——**拓扑**（getParent/getChildren/getAncestors/getDescendants/getRoot/isAncestorOf，parentId 单一事实源，实时推导）、**能力**（attach/detach/replay + effectiveAccess/profileOf + 模型相 modelOf/setModel/nodeConfigOf，全参数统一解析律见 2.2 末）、**可见域**（canReach = 自身∨祖先）。红线：纯派生不入库、零运行时状态、零类层依赖。
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
 - **策略声明清单**（契约字段 `ContextStrategyModule.tools?`）：宿主类实例化时插在类清单后执行（策略依赖键 ignore→allow 显式化）；祖先已 ask/deny 该键 → **实例化拒绝**——复用收敛检查，"策略与类配置矛盾"由法则自然宣判，零特判；
 - **grant 双门面**（spawn 受限 / `agent_update.grantTools`）：清单形整表替换 + 逐键父面封顶取严——本质是"白名单自限 + 收紧"的组合便利形，语义不变；
- **模型可见清单 = allow ∪ ask**（Runtime 组装工具定义时过滤）；`kind` 三分类**降为纯 provenance 元数据**（装载源/信级/审计展示），不参与任何权限推断——审计测试表驱动断言之。
- **能力物化（算法 = `lineage/AccessLedger.ts`）**：生效权限 = 族谱位置的函数，注册期两步物化 `{explicit, fallback}`（replay 按拓扑序重放，纯派生不入库）；查询 `effectiveAccess(agentId, key)`；`tools` 侧只认注入端口 `AccessResolver`（`ToolContext = {agentId, spaceId, signal?, callId?, parent?}`）。
- **boot 校验律（替代一切代码兜底）**：① 根生效表 `access_reply ≠ allow` → 拒启（明示 ask 消息化死锁理由——主权归 config，法只做审判）；② config.extensions.tools 键在装载源解析不到 → 拒启（未知键 fail-fast 同律）；③ 未知 config 顶层键照旧拒启。
- **ask 消息化**：命中 ask 时 `AccessAskBus` 把申请投递到**申请者族谱根信箱**（`<access_request>` 消息）并挂起；根经 `access_reply` 回复（once/always/reject+feedback）。**无 agent 特判**——根的 ask 发给自己，由扮演它的 shell 确认。
- **session 豁免备忘**：`always` = 该 `(agentId, accessKey)` 后续 ask 免询问（仅当前实例、不传播）；ask 环节备忘，**非权限层**（不参与收敛单调，绝不豁免 deny/ignore）。
- **全参数统一解析律（/ 保留）**：模型与权限同门面——生效模型 = 显式（实例行）> 类基因 > 父继承 > 家学（`config.user.model` 全链锚点）；改父不级联子女（`modelSnapshot` 出生快照）；运行期改写唯一通道 = `kernel.updateAgent`（写实例行 → 全树 replay）。

### 2.2b 上下文管理策略（`core/context/strategies/`）

**一句话**：每种策略 = 独立子模块，实现统一契约 `ContextStrategyModule`；触发点 = user_prompt 信件抵达、终点 = 完整上下文就绪后唤醒快递员；策略可导出专有动作（compact/dream）经 pilot / `context_apply` / CLI 调用；策略可自带工具与数据目录（装载期 `init`）。

- **两段式生命周期**：`process`（异步许可：可做摘要/整理、经系统通道造 agent，返回即"就绪"）与 `assemble`（纯函数同步：送信快照）分离——快递员永不异步、只发不组装（组装权归管理员）。`ContextRegistration.contextStrategy` 开辟时确定（上下文属性），未知策略注册期 fail-fast（恢复接线兜底默认，不炸启动）。
- **契约面（建、 定形）**：`init?(ctx)` 装载期钩子（组合根在工具 `initAll` 之前逐策略执行；`StrategyInitContext = {projectRoot, fs(读+可选写口), settings, log, registerTool}`——策略自带工具经窄口注册进总表，**出生恒 ignore**（A1）；策略 provenance 与自身分类对齐：core 策略 → internal 形、`.stem/context/` 策略 → custom 形）；**`tools?` 声明清单（契约新增的唯一字段）**：宿主类实例化时插在类清单后执行的收敛清单（策略依赖键抬 allow，祖先锁过即实例化拒绝——见 2.2）；`StrategyApi.custom`（宿主类 custom 自由槽 = 策略基因参数载体）+ `lastWorkerId/roleAgentId/updateMessage`；`ToolContext.parent`（调用者直接父 id）。
- **classic（急救室，对齐 opencode compact）**：完整历史直出 + 逼近窗口阈值时把轮边界之前的旧段交摘要 worker 精炼为一条 `<context_summary>`（tag='summary'）、旧消息 `markInvalid`（**仓库/DB 语料保留，压缩可逆可审计**，opencode 无此优势）。轮边界压缩 + append-only → 前缀缓存稳定。触发 = user_prompt 抵达（`process`，await 压缩完成再就绪），另导出 `actions.compact`。参数 `config.context.{window,compact}`。compact 是 classic **私有动作**——参数不与其它策略混用。
- **cortex（睡眠生理， 建 / 收敛为纯既有接口组合）**："上下文 = 专注度资源"。三层外挂记忆：**LTM**（JSON，仓库 tool 行 tag='ltm' + `.stem/mem/<id>/.memory.json` 单向镜像永不回灌）/ **笔记层**（`.stem/mem/<id>/<主题>.md`，agent 与 dreamer 双可写，目录行 tag='note' 磁盘巡检 in-place 再生；**文件层 = 人机共读地盘**——agent 经 bash 直改笔记文件合法，dreamer 下拍目录再生吸收人工编辑；`.memory.json` 是投影勿手改）/ **STM**（tag='stm' 行，无文件）。**教学样板组装**：记忆组 = 仓库真实行（锚点 user tag='cortex' 一次写不轮替 + 载体 assistant 虚拟调用 `cortex_load_ltm/notes/stm` 三枚——不注册，幻觉点名 = unknown 无害 + 三 tool 行配对），assemble 恒直出。触发 = `estimatedTokens ≥ custom.cortex.dreamAt`（阈值激活无 timer，轮替即瞬降水位）→ **异步点火不等收口**。**dreamer（原 dream worker 更名，cortex 对 core 的最后机制索取清零）**：spawn 走标准通道（contextRefs 全景重放、清单收敛至无工具），正职是**说**——输出 = **回信**；策略侧 parse + schema 校验，不合 → `sendMessage` 回信指出错处令其再改（生命周期内循环）；双份齐 → **runDream 收口段**执行轮替（旧组+快照实时行 markInvalid、新组 append、镜像、`context.dreamed` 事件——**二段事务的原子性本就住在这里**，`cortex_set_ltm/stm` 与全局梦 token 暂存分流整体退役），半途 = 不轮替水位不动下拍重触发。**agent 主权面**：`cortex_add_note/del_note` 出生策略注册面（ignore），启用 cortex 的类经策略声明清单抬 allow——**非 cortex 类不再白拿**；水位线无独立存储（现行记忆组最大 turn 行序推导）。`actions.dream` 手动提前做梦。参数仅两件：`custom.cortex = {dreamAt?, consolidateModel?}`。方案史见日志卷（brain-plan→cortex 三版收敛→纯接口化减法）。
- **模块扮演 agent（role）**：策略需造工具 agent 时，懒生成一个自己的扮演 agent（父 = **宿主 agent**，故 terminate 级联回收；`AgentClass.panel=true` 面板态：不组装、不跑 LLM、收信由策略模块消费）——是"pilot 扮演根"的同构推广，赋予代码模块族谱位/信箱/权限面。worker（`summarizer`/`cortex-dreamer` 规格，策略硬编码，父 = role，`contextStrategy:'none'`）经邮局正规往返 + 回信配对 `waitForReply` 兑现，用完即 terminate 归档。role 的 `tools` 语义要点：**不设 = 匿名不封顶**（cortex role 须如此，否则空表本地封闭会锁死 worker grant 键——`ensureSystemTemplate` 对 `spec.tools` undefined 原样透传）。
- **递归终止**：role/worker 均 `panel` 或 `none` 策略（无 process、不再 spawn），天然断套娃；策略失败绝不卡死送信（catch + 降级照常唤醒，双保险；cortex 自动链另走 fire-and-forget）。
- **用户策略加载（`.stem/context/*.ts`）**：init 管线扫描默认导出 `ContextStrategyModule` 注册进注册表（同名覆盖内置 = 用户主权），与 `.stem/tools/` 同构——"让 agent 自己写上下文策略"的加载通道；用户策略同样享有 `init` 装载期。

### 2.3 Pilot：根（user#0）扮演接口（驾驶舱）

- `core/pilot/Pilot.ts`：`identity`（恒根，未来 `as(agentId)` 可扮演任意 agent）+ `subscribe(PilotEvent)` + 命令（sendMessage / instantiate（可带 name 显式出生名、model 显式出生；**id 恒系统按路径生成，无指定通道**）/ **setModel**（扮演通道）/ terminate / interrupt / replyAccess / contextOverview / exportContext / **runContextAction**（策略动作，如 compact）/ listAgents / inspect / activeAgents）。
- **扮演 = 根的 action**：`sendMessage` 记录人类输出为根的 assistant 消息（根完整 transcript），同一文本作为 user 消息投递给目标。
- `createPilot({ kernel })`：pilot 初始化流程内实例化根（若未注册）。
- **不做抽象层**：外部（shell/webui）与 core 的一切交互经模块接口直连（日志导出、上下文数据库导出等不在 Pilot 内）。

### 2.4 事件流：PilotEvent + EventHub（多订阅者）

- `PilotEvent` 判别联合：`stream`（LLM 流式 text/reasoning/tool/usage/finish）/ `letter`（信箱来信，含 `<access_request>` 消息化申请）/ `status` / `notice`（扩展位）。
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
- **管理员（ContextManager）**：打发送者戳（user 消息用 from 生成 `<sender id="name#id" at="yymmdd.hhmm">`——时间+身份一枚戳，分钟精度，打戳器一处收口）、挂起等待判定（instantiate.wait 命中挂起 → 作为 tool 结果填充；可配超时自回填）、**策略 process（异步，user_prompt 抵达触发）→ 就绪后唤醒快递员**、组装（按 agent 策略分发 + **legalize**；组装权归管理员——快递员只发不组装）；信箱配对 `waitForReply`（模块扮演 agent 的程序化等待原语）。
- **快递员（Courier）**：按 agentId 维护发送倒计时（初始 0 立即送；发送后开始；来信重置）；agent 送信快照经管理员委托（`buildAgentDelivery`）构造，面板（`assemble:false`）信件 diff 自持。
- **消息 ≠ 上下文**：通信消息直接投递；上下文由管理员按模式组装。

### 唤醒语义（重要）

- **只有外部来信唤醒快递员**：`deposit`（外部消息投递）才触发 `courier.notifyReady`；agent 自身的 `appendHistory`（assistant/tool 入库）**不**触发重投递——否则 agent 自回复会无限循环。
- **挂起等待填充（挂起面）**：`agent_instantiate{wait}` 的回信命中挂起 → 作为 tool 结果填充到等待者 + 唤醒（hold 随实例化**先于首信注册** = 竞态从时序上根除；context_wait 工具已退役）；hold 可配 timeoutMs 超时自回填不永悬；`agent_pause` 到点自唤醒回填（期间来信照常进仓库堆积，醒后一次组装全见，无时长上限）；实例注销清全部挂起 timer 防孤儿。runtime 见 `contextWait` 标记**收束轮循环**（不空转）。

### 送信倒计时（快递员维护的局部量）

- 倒计时**初始为 0**：首信到达立即组装送信。
- **仅发送完一次上下文后**才进入倒计时（= 合并下一批来信的滑动窗口），倒计时期间新来信**重置**倒计时。
- **送信条件**：上下文就绪**且**倒计时就绪；否则保持 holding。默认 `sendCountdownMs = 1000ms`（模板可配；user 类为 0）。

## 四、模块职责与内部实现

### 4.1 上下文三模块（`core/context/`）

- **仓库（Repository.ts）**：`register` 时把 systemPrompt（= 人格 + 策略 note）作为首条 system message；`append` 触发 `onChange(agentId)`。
- **管理员（ContextManager.ts）**：打戳 / 挂起等待判定（hold/pause 双通道）/ 策略 process 链（触发点 user_prompt 抵达，返回=就绪）/ 组装 `buildAgentDelivery`（策略分发 + `legalize`）/ `waitForReply` 配对 / `runStrategyAction`；`deposit` 经 wake 链唤醒快递员（重入 guard：处理中来信合并补跑；策略失败兜底照常唤醒）；`appendHistory` 不唤醒。面板（`assemble:false`，含根与策略 role）恒绑 none 策略。
- **快递员（Courier.ts）**：agent 收 `AgentDelivery`（含 `messageIds`，快照来自管理员委托——**只发不组装**）；`assemble:false` 注册（根 / 模块扮演 role）只汇总 user 信件（`UserDelivery` diff）。

### 4.2 Runtime（`core/kernel/Runtime.ts`，被动驱动）

- 不是同步 run：由快递员送信回调驱动（`processDelivery`）。
- 状态机：`idle →(送信)→ thinking →(LLM 返回)→ holding`；`interrupted`（可恢复）。
- 收完整上下文（`AgentDelivery`）→ 发 LLM → 工具轮（并行执行，结果按 index 回填）→ 每轮 assistant 消息自动复制到仓库 → 最终纯文本回复投递给**创建者**（= 族谱父）；发送者戳由管理员统一生成。
- 中断控制器 + 三层 try/catch + halt 消息闭合（见 2.5）；各 agent 独立 AsyncGenerator 天然并发。

### 4.3 InstanceManager（`core/kernel/InstanceManager.ts`）

- 实例化必填：`className` + `userPrompt`（字符串，根可为空串）+ `parentId`（根为 null）；父必须已存在（根除外）。**id 无指定通道**（出生路径全托管：根 `0`，子 `<父id>-<序号>`，§4.3）；可选 `name`（撞全局名 = 拒绝并明示，缺省派生 `类名-N`）。
- `parentId` 即创建者；根（parentId=null）无祖先 → 天然不可销毁。
- **运行期实例写面唯一化**：`update(agentId, patch: AgentInstancePatch{name?, toolOverride?, model?})`（name 全局唯一，撞名拒） 取代原 takeover/setModel 散点（写穿装饰器落行——三个字段全随实例行 JSON 持久，零 schema 迁移，重启 replay 天然承接）；授权/校验/族谱重算/审计编排在 `kernel.updateAgent`。

### 4.4 LineageTree（`core/lineage/`，族谱树：拓扑 + 能力物化 + 可见域门面）

- 事实源（manager 持有 parentId）+ 查询视图（实时推导）；`getInstance`/`getAllInstances` 由组合根注入。
- **唯一权限变更/查询面**（.1 门面合一）：`attach/detach/replay + effectiveAccess/profileOf`（语义见 2.2，`AccessLedger.ts` 降为内部实现、算法与语义矩阵测试随迁零改动）；销毁/中断权与上下文/观测面操作权统一为 `canReach` 谓词；`lineage→tools` 仅共享 `restrictAccess` 纯代数。
- **模型配置相**（//）：attach 输入 = kernel 算好的原始层 `{instanceModel（实例行显式）, classModel（类基因）, snapshot（出生快照）}`，按**显式 > 类基因 > 出生快照 > 父继承 > 家学**物化 `ModelBinding{ref, origin}`（home 值随链下传不改标，git-blame 语义）；`modelOf/nodeConfigOf`（access+model 整像，agent_inspect 出示）——**模型与权限均无直改口**（重构裁决）：运行期变更 = kernel 写实例行后 `replayLineage` 全树重放（启动恢复与更新共用该单点；权限收缩沿链下传自动重算，"改父不动子"由快照层数据结构天然保证，replay 幂等）。持久边界：显式层随实例行 `model`、快照随行 `modelSnapshot`（行 JSON 零迁移）——族规"改父不动子"跨重启不失效。

### 4.5 ToolCapabilityRegistry（`core/tools/`）

- 注册/查询/materialize（`materialize(agentId)`：经 `AccessResolver` 查询生效访问；**模型可见清单 = allow ∪ ask**——过滤律）/execute（统一访问确认 + 参数校验 + ToolHooks）；不 import lineage/kernel（端口接线由组合根完成）。**注册即出生声明**：每个工具进总表必须携带出生权限（internal 代码写定、extension/custom config 点名给定、策略注册恒 ignore）——不存在无出生的工具。
- **工具来源三分类（`ToolKind`） 降级为纯 provenance 元数据**（装载源/信级/审计展示），**不参与任何权限推断**（审计测试表驱动断言）：`internal`（core 注册表）/ `extension`（`extension/tools/<名>/<名>.ts` 目录形态，`config.extensions.tools` 点名装载）/ `custom`（`.stem/tools/`，**同须 config 点名——目录扫描废止**：未点名 = 不存在于世界，模型可写该类目录但永不获得代码入口，注入面闭合）。
- **`initAll(ctx)` 生命周期**：`ToolCapability.init?(ctx: ToolInitContext)`（fs/projectRoot/log 注入），装配后调用一次、幂等、工具间禁跨依赖——工具参与系统初始化的唯一 hook。

### 4.5b bash 工具（`core/tools/bash.ts`，kind=internal）

- **最小系统唯一对外操作面**：不采用扩展时，除系统工具外模型触达外部文件/系统的入口只有 bash。core 只定义工具形状与 `ShellRunner` 端口（`run({command,cwd,timeoutMs,shell}) → {stdout,stderr,exitCode,timedOut}`），执行由宿主注入（node `child_process` 实现 = `shell/cli/bash.ts`）——core 零平台依赖不破。
- **治理 = 机制 + 分担，非询问**（对齐 pi）：**无 ask、无黑名单**（高频工具询问打断模型循环得不偿失）；事故半径三机制（硬超时缺省 120s / stdout·stderr 各 50k 截断 / cwd 缺省项目根，`config.bash` 可配 `path/defaultTimeoutMs/maxOutputChars/cwd`）；行为规范靠工具描述提示词（非交互式、有专职工具优先）；不想给某 agent shell → 模板白名单不列 `bash` 键（键即自我限定）。非零退出码不是工具失败（输出 + exit code 照常返回，模型自判）。
- 出生权限 `allow`（A1：对外操作面的自然出生，随注册点声明，`config.user.tools` 收敛可关）；宿主未注入 `shellRunner` 则不装配（`bootStem` 缺省注入，`shellRunner:false` 可关）。

### 4.6 系统工具（`core/kernel/systemTools.ts`，internal；**出生权限逐把声明，通例 ignore——上台面由各级清单显式化**）

| 工具 | 作用 |
|---|---|
| `agent_class_create` / `agent_class_update` / `agent_class_list` | 创建（新名 = 变体并存）/ 更新（同名覆盖；tools 增量、只许收敛；panel·user 根类拒绝；**只影响后续实例**）/ 列出——均回写 `.stem/agent/`（ClassStore 注入时） |
| `telemetry_query` | 运行日志观测（进化闭环"观测"翼）：可见域 = 自身 + 族谱后代（canReach）；行式压缩 + 类型前缀通配 + 时间窗 + limit 截尾 |
| `agent_instantiate` / `agent_list` / `agent_inspect` | 创建实例（父=调用者）/ 列出 / 详情 |
| `agent_ancestry` / `agent_descendants` / `agent_terminate` | 祖先链 / 后代 / 终止（销毁权 + recursive） |
| `agent_update` | 实例参数统一写面（缺省目标=自身，canReach）：model / name / tools 收敛 patch（总序拒扩张）/ grantTools 清单整表（逐键封顶）——吸收原 agent_set_model；审计双事件 |
| `mail_send` / `mail_participants` | 发消息 / 参与者列表（原 `bus_*` 更名——"bus 已死名不灭"清除，邮局叙事归位） |
| `agent_pause` | 自主挂起攒信（ms 到点唤醒；期间信件自然堆积。等特定子回信走 agent_instantiate 的 wait） |
| `context_export` / `context_overview` / `context_remove` / `context_edit` | 导出 jsonl / 概览 / 删除过时消息（markInvalid）/ 重写消息（system 除外） |
| `context_apply` | 执行上下文策略专有动作（如 classic compact；仅自身或祖先） |
| `access_reply` | 批准/拒绝访问申请（once/always/reject；授权权=申请者的族谱根） |

> internal 出生实值（盘点定形）：`access_reply: allow`（根答复义务的自然出生）+ `bash: allow`，其余通例 `ignore`——`telemetry_query`/`context_*`/`agent_*` 系/`mail_*` 系的管理面与高危面分级，是 **根收敛清单（defaults.ts 首启模板实值）** 的表态而非系统兜底（`DEFAULT_USER_TOOLS` 兜底退役，A4）。策略工具（cortex 笔记两键 + load 面等）住策略注册点（出生 ignore、`strategy.tools` 声明清单抬升、非 cortex 类不再白拿）；`cortex_set_ltm/set_stm` 整体退役（dreamer 回信，C2）。

### 4.7 extension 工具层：fs 五件套 + web 两件（`extension/tools/`，kind=extension）

**一工具一目录、入口与目录同名**（`tools/read/read.ts`；`_lib/` 下划线前缀 = 共享辅助不入库；附属脚本/资源同目录自由放置）。由 `config.extensions.tools` 点名加载（init 管线统一矩阵），缺省 = fs 五件套，显式 `[]` = **纯 bash 最小系统**；点名缺失 → `extension_entry_missing` issue 不炸启动（fail-soft）。入口默认导出允许两形态：`ToolCapability` 对象或**工厂** `(projectRoot) => ToolCapability`（工作区级工具需要空间根做路径沙箱，loader 注入）。fs 五件套（read/write/edit/grep/glob）以工厂形态实现（`createXTool(root)`），路径沙箱基于注入的空间根。

| 工具 | 作用 |
|---|---|
| `read` | 读取文本文件（offset/limit 分页）+ 目录列出；二进制检测 |
| `write` | 全量写入（父目录自动创建） |
| `edit` | oldString/newString 精确替换（0/多次匹配校验） |
| `grep` | 正则递归搜索（排除 .git/node_modules） |
| `glob` | glob 模式匹配文件 |

### 4.8 Gateway（`core/gateway/`）

- `ModelGateway` 接口、`providers/openaiCompatible`（泛化单点：`{baseUrl(必填), apiKey?(缺省=匿名不发 Authorization), models?(白名单请求前硬拦), fetch?}`，POST `{base_url}/chat/completions` 恒发裸模型 id，解析 reasoning_content → reasoning-delta；**代码零端点常量、零 process.env**——端点/密钥全由宿主从 config.providers 注入）、`fetch`、`FakeGateway`。错误分类补 `provider_unwired` / `model_not_allowed`。**路由在宿主门面**（`shell/cli/gateway.buildGateway(config, env)`）：逐 provider 装配 + 按 `req.model.provider` 分发；两段式 = key_env 未命中启动 warn 点名（不印值）+ 用到才硬错（零兜底；产品无 mock 回落）。
- 并行工具调用：协议层 `tool_calls` 数组原生支持；工具轮并行执行，结果按 index 回填。

### 4.9 工具访问确认（`core/tools/accessRequest.ts`，取代 AccessManager/PanelBus）

- 生效访问经注入 `AccessResolver` 向族谱台账查询（无判定 → defaultAccess：internal ignore / 其余 ask）；`assert`（allow/ignore 通过 / deny 抛错 / ask 投递申请到根信箱并挂起）+ `reply(input, by)`（根授权校验 once/always/reject）。
- **在途复核（总序防御）**：reply once/always 落地前重查该键现生效值——挂起期间被 `agent_update` 收敛为 deny 的，迟到的批准被铁律压死（reject 回文本带因，不写 always 备忘；复用 resolvePort，零新依赖）。
- **无元 agent 短路**：根也是普通 agent，其 ask 发给自己，由扮演它的 shell 经 pilot 确认（`replyAccess`）。
- **session 豁免备忘**：always = 该 `(agent,accessKey)` 免询问放行（仅本实例；非权限层，不破 deny/ignore）——见 2.2。
- `autoApprove`（config）时 ask 直接放行（deny 仍拒绝）。

### 4.10 事件流（`core/events/`，取代 PanelBus）

- `PilotEvent` + `EventHub`（多订阅者）；`letter` 承载一切信箱来信（含 `<access_request>` 消息化申请）；shell/webui 统一订阅，不再有面板消息类型。

### 4.11 Logging 横切（`core/logging/`）

- 各模块经注入 `LogSink` 发日志 → 组合根接到 `Logger`（无总线）。
- `LogEvent`：`tool.invoked` / `gateway.apiRequest` / `context.assembled` / `context.compacted`（compact 结果：compacted/skipped/failed） / `mailbox.countdown|delivered` / `access.asked|replied` / `kernel.*`（class.registered / instance.created / status.changed / instance.terminated / instance.interrupted / message.sent）。
- `InMemoryLogger`：留档 + `query({agentId, type})` 过滤。

### 4.12 全局配置 + 初始化（`core/config/` + `core/init/`）

**唯一配置文件**：`<projectRoot>/.stem/stem.jsonc`（或 `.stem/stem.json`）。

- 配置项（/ 全量有效原则：**未知顶层键 boot fail-fast**，`custom` 为唯一扩展位；历史键 model/tools/agents/strategies 出现即报错并给迁移指路——静默丢弃兼容已废除）：**`providers`（模型提供商注册表：`base_url` 必填 http(s) / `key_env` 密钥环境变量名（**配置文件永不承载明文密钥**；缺省 = 匿名端点）/ `models` 启用白名单；一切模型引用的 provider 必须在此注册）**、`autoApprove`、**`user`（根 agent 类完整对象：description/systemPrompt/tools（纯收敛清单，见 2.2）/contextStrategy/**model（家学锚点，boot 必填硬校验——全链缺省的本体）**/sendCountdown/**name（根出生名，缺省 `user`）**）、`maxSteps`、**`context`（window/compact：threshold/keepRecentTurns/summarizeModel（摘要 worker 类基因位，已接线）/instruction/replyTimeoutMs）**、**`bash`（path/defaultTimeoutMs/maxOutputChars/cwd）**、**`extensions`（分键对象：`{tools?, agent?, context?}` = `extension/<键>/` 下启用的目录形态条目名；tools 缺省 = fs 五件套，agent/context 缺省 = 不启用；旧数组形态 fail-fast 指路）**、`sendCountdown`。**目录即真相**（agent 类/策略层）+ **config 即全部配置**；首启模板 = `config/defaults.ts` 的 `DEFAULT_CONFIG_TEXT`（唯一预设 opencode-go 以模板数据存在；文件缺失时 `defaultStemConfig` 兼作内存等效——首启装配必有锚）。
- **系统装配**（`core/init/system.ts`，`createStemSystem(deps)` 组合根）：
 0. （可选 `stateStore` 注入）Kernel 构造内：内存核建好后先从 store 恢复（实例/消息/空间 + 状态归一化 + id 计数器续接 + 族谱树能力相 replay 重放），再套 write-through 装饰器，恢复出的实例在构造末尾统一接线上下文——装配顺序不变，恢复收敛在 Kernel 内；
 1. 读取配置（不存在 = `defaultStemConfig` 内存等效；**家学硬校验 config.user.model**）→ 工具注册表 + Kernel（user 类 = config.user 对象，`contextSettings`/`maxSteps`/**`project`（项目空间身份，根挂真实空间）**注入；策略注册表内置 classic/none）；
 2. 系统工具（agent_*/bus_*/context_* + telemetry_query + context_apply + access_reply）→ bash 工具（注入 `shellRunner` 才装配）→ 类回写通道（注入 `classFs` 才建 `ClassStore`：create/update 授权后 serialize → .stem/agent/<name>.md`）；
 3. `runInit` 管线（统一矩阵装载）：三类资源（tools / agent 类 / context 策略）× 两来源层——**extension 层**按 `config.extensions.<种类>` 点名从 `extensionRoots`（宿主注入仓库 `extension/` 根）装载目录形态资源（`<名>/<名>.<ext>`；工具入口可工厂形态收 projectRoot）；**custom 层**自动扫描 `.stem/` 各目录（平铺兼容 + 目录形态优先）。装载序 internal → extension → custom，**后层同名覆盖前层**（registry/template register replace）。**目录即真相：仅配置文件不存在时写默认模板，管线此后纯只读、永不回写**（镜像同步/orphan 检测已整体移除）。
 4. `createPilot`（pilot 初始化内实例化根，挂真实项目空间）→ 订阅事件流；
 5. `tools.initAll`（fs/projectRoot/log 注入）→ 用户注入钩子（`userHooks`，init 末尾，深度扩展）。
- 返回 `StemSystem { kernel, pilot, tools, config, init, dispose }`；任何 shell 注入平台能力即可装配出完整最小系统。

### 4.13 shell 层（`shell/cli/` + `shell/webui/` + `shell/dashboard/` + `shell/feishu/`）

- **cli**（参考 shell）：`platform.ts`（`bootStem`：config + 网关 + createStemSystem + extension 资源根注入（仓库 extension/ 三目录）+ bash `ShellRunner` 注入，供任何 shell 复用）+ `gateway.ts`（**providers 路由门面**：逐 provider 装配 + `req.model.provider` 分发，两段式 warn/硬错；产品无 mock，mockSse 降测试/冒烟支撑。**厂商适配收容所（v1.0）**：`providerFetch` 经 openaiCompatible 的 fetch 端口注入请求头——全体 provider 补 `User-Agent: stem/<version>`；baseUrl 命中 `*.opencode.ai` 再补 `x-opencode-session` = **每进程一个随机 uuid**（opencode 运营要求「每会话稳定 id」：进程/容器即会话，进程间随机、零持久化、不编码 agent/空间身份；刻意拒绝全局硬编码值——镜像分发会共享一个 session 被限流连坐）。**core 对一切厂商头零感知**，此类适配只准住本文件）+ `storage/`（`createSqliteStateStore`：node:sqlite 实现两端口，默认 `.stem/stem.db`）+ CLI 命令（直接对话 /new /use /agents /templates /tools /config /compact /stop）。
- **dashboard**（空间仪表盘，法医/管理员 shell）：独立进程独立端口 4421，与 webui 真并列零共享——数据源两路：SQLite 只读直查（个体层同步 write-through，行即运行态实时镜像：族谱/token 账目/语料/原表）+ **纯内存标本装配**（`bootStem({stateStore:false})` 的矩阵装载与 materialize(根) 生效可见集 = 资源清单单一真相）；清理为唯一写通道（`--allow-write` 进程姿态 + `confirm=yes` 双确认；孤儿箱 GC/terminated 语料 GC/定点 purge(active 需 force)/VACUUM，freelist 回收估计）。前端复用 webui view.js 纯函数核心（行序/字形），OLED 同语言。
- **webui**（WebUIShell）：`node:http` + SSE，复用 cli 的 platform；REST（send/instantiate/terminate/interrupt/access/context_action + **`/api/health`** = docker HEALTHCHECK 探针）+ 观察（agents/templates/context）+ 单页 UI（**OLED 友好主题**：纯黑底、边框分层无灰底卡片、青绿=运行/品红=介入双色语义、状态"字形+色+文字"三重编码；agent 侧栏 / timeline（summary 归档渲染为分隔条）/ composer / header 动作 compact·中断·销毁 / 权限弹窗 = 渲染 `<access_request>` 消息 + `access_reply`）。绑定地址：裸机缺省 `127.0.0.1`，容器 `STEM_HOST=0.0.0.0`。

- **feishu**（飞书 shell，v1.0+）：第三远程宿主——官方 SDK `@larksuiteoapi/node-sdk` **长连接模式**（程序拨出 WebSocket，免公网 IP/域名/回调服务，NAT 后主机仅需出网）。**扮演模型**：根面板不跑轮 → 单聊默认对象 = 船长名下自动解析/创建的**接待员实例**（`secretaryClass`，缺省内置 assistant）；飞书消息经 pilot 以根身份投递 = "船长的话"，接待员回船长的信从根信箱 letter 事件反查 `StoredMessage.from` 后**读 aloud** 给主人。三文件分工：`router.ts` 纯逻辑全决策面（owner 白名单闸门/chat_id→agent 路由表/`/help /tree /status /logs /watch /unwatch /stop` 命令/`<access_request>` XML 解析/`card.action.trigger` value 判别/message_id LRU 去重/长文分箱/formatTree——零 SDK 全单测）+ `feishu.ts` 协议翻译（SDK 具名导入、`msg_type/message_type` 双形兼容、REST 发送）+ `main.ts` 接线（凭证只 env、watch 节流聚合、审批三键卡 once/always/reject → pilot.replyAccess → 卡原地更新留档）。配置 `.stem/feishu.jsonc` = **shell 层自治理文件**（不进 core StemConfig——平台配置不入 core 铁律；ownerOpenIds 空时回打印来话 open_id 供认领）。群语义：绑定表把群变成子 agent 的移动窗口；审批可路由到管理群。**权限不由聊天渠道定义**——白名单外的飞书身份在 shell 收敛为零服务，agent 能干什么仍全是族谱树的函数。
### 4.14 extension/：矩阵 extension 层（三类资源目录形态）

- 仓库级可选扩展的家：`extension/tools/<名>/<名>.ts`、`extension/agent/<名>/<名>.md`、`extension/context/<名>/<名>.ts`——**一资源一目录、入口与目录同名**，附属脚本/资源同目录自由放置；由 `config.extensions.{tools,agent,context}` 分键点名启用（装载与覆盖律见 §4.12 init 管线；）。
- 首住户：fs 五件套（tools/read…glob）+ web 两件（tools/websearch：百炼 WebSearch MCP，密钥 `ALIBABA_API_KEY` 走 env；tools/webfetch：零依赖抓取转换，无密钥）+ `agent/creator/`（调度者示例类——父子调度 dogfood）；`_lib/` 前缀目录 = 共享辅助代码不参与扫描。
- 与 custom 层的差别只在**启用方式**（点名 vs 目录即真相）与**归属**（仓库发布物 vs 用户空间），装载管线同构（core/init 统一 loader）。
- ** 起无系统级 skill 子系统**：SKILL.md 生态兼容降为 custom 工具约定（`.stem/tools/skill/skill.ts` 装载器 + `<技能名>/SKILL.md` 资产，见 dev-guide 食谱）；MCP 类外部能力同样走工具三分类落位，不设第二通道。

### 4.15 持久化（个体层 SQLite，write-through）

**分层边界**：类层持久 = 文件（`.stem/agent/*.md`，目录即真相，用户主权可审；**兑现回写侧**：agent_class_create/update 经 `ClassStore` 端口落盘——core 序列化 `agentSerialize`（往返律，panel 机制类永不回写红线）+ 宿主 `ClassFs` IO，进化跨重启唯一通道）；**个体层持久 = SQLite**（实例/消息/空间）。核心思想：**内存为准 + write-through（DB 为影）**——同步读接口（list/listValid/getState）零破坏，写操作内存生效后同步落行（单进程 + DatabaseSync，崩溃窗口为零）。

- **端口（core，零平台依赖）**：`context/store.ts` `MessageStore`（upsert/archiveAgent/loadBoxes/maxMessageSeq）；`kernel/store.ts` `InstanceStore`（实例 upsert/delete/loadAll + 空间 upsertSpace/deleteSpace/loadSpaces）。接口与默认内存实现同文件（`MemoryMessageStore`/`MemoryInstanceStore`，测试即用它观测持久化）。
- **装饰器（core）**：`context/persisted.ts` `PersistedRepository`；`kernel/persisted.ts` `PersistedInstanceManager` / `PersistedSpaceManager`——全部委托内层内存实现 + 写穿。**terminate = 个体消亡**：实例/空间行删除，**消息行归档**（archived 标记，进化语料保留，恢复不加载、id 计数器避开历史序号）。
- **恢复语义（Kernel 构造内，装配步骤 0）**：实例装载（**活跃状态归一化** thinking/holding → interrupted，halt 语义下消息闭合可恢复）→ 消息箱重放（反演 push 状态机还原 turn/indexInTurn 计数器 + `setCounterFloor` 防撞）→ 空间装载（spaceId 重启可解析）→ 上下文接线（`ContextRegistration.restore=true` 跳过仓库开辟；快递员 `initialSentIds` 预置 → **重启零重放**）→ 根幂等（`createPilot` 检测根已存在即跳过）。悬空挂起等待（wait/pause 的内存 hold 与 timer）不恢复，交给组装期 **legalize** 自然兜底。
- **SQLite 适配（shell/cli/storage/）**：`node:sqlite`（`DatabaseSync`）；行 = 记录全量 JSON + `agent_id/seq` 冗余列；`PRAGMA user_version` 守卫（**当前 v3**：路径 id + name 唯一 + 戳升级原子形制；**版本不符 = boot 拒载硬错，零兼容零迁移脚本**——v1/v2 旧空间属前史，重建即正义）；rollback journal（9P/WAL-shm 安全）；默认 `<projectRoot>/.stem/stem.db`（`STEM_DB_PATH` 覆盖，`bootStem` 注入，缺省即持久，`stateStore:false` 显式纯内存）。**空间语义**：`.stem` = 世界——一进程 = 一空间 = 一 projectRoot = 一 `.stem` = 一 `stem.db`；定位 opencode-style（`stem [path]` > `STEM_PROJECT_ROOT` > cwd），无注册表无切换器，单实例 = 约定非机制（无锁）。
- **已知边界**：`turnCount/totalCost` 经引用直改不经装饰器，最后一次状态变更时全字段快照收敛——最多丢"进行中的一轮"记账零头（消息本体不受影响）；单进程假设；webui/cli 重启后根出现在 agent 列表（平等化后属正常视图，UI 未过滤）。

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
- 个体层存储：SQLite（`node:sqlite` DatabaseSync）write-through，经 core 端口注入（4.15）；缺省纯内存（测试 harness 不受影响）。
- 运行时数据文件：`.stem/mem/<agentId>/`（cortex 笔记正文 + `.memory.json` 镜像）——**派生/外挂文件不进 DB**（记忆真相在仓库行，镜像单向永不回灌；笔记文件由策略 fs 口读写，磁盘 = 正文真相）。
- 族谱存储：无独立存储（parentId 挂在实例上，LineageTree 实时推导；实例行本身持久化即族谱持久）。
- LLM 端点：真实 go/zen（`https://opencode.ai/zen/go/v1/chat/completions`）或 mock SSE 兜底。
