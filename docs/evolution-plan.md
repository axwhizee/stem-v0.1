# stem 自进化与自主节律 · S5 方案冻结

> **性质**：方案设计冻结文档。经三轮讨论收敛，作为 S5 各批实施的唯一依据；与口头讨论冲突时以本文为准。
> **状态**（2026-09-02 刷新）：**S5.1 ✅（46bb227）· S5.2 ✅（efcd499）· S6 全批 ✅**（模型自由三环/配置收敛/仪表盘，v1.0 全量验收 15/16 通过，记录见 docs/log.md）。S5.3 薄调度与 S5.4 dreaming 均已改道：**§5 整卷重写为 brain_enhanced 三层记忆策略方案**（用户 2026-09-02 构思 + LLM 实测反馈校准，取代原案——原案 LTM 住消息带，新案 LTM/笔记住文件）。**§9 = 目标-达成度进化方案存档**（未排实施，与 §5 正交）。
> **日期**：2026-09-01 · 前置：S4 已全部落地（bash 单点 / extensions tool_set / 目录即真相 / OLED webui / Docker）。
> **范围**：①族谱树重构 ②进化观测与书写 ③brain_enhanced 记忆策略方案。**不含**实现代码；benchmark 已被 §9 取代。

---

## 0. 背景：统一模型

把系统视作一个可自我迭代的生命体，四个正交支柱：

| 支柱 | 承载模块 | 管什么 |
|---|---|---|
| **社会结构** | 族谱树（LineageTree，概念别名"实例树"） | 谁是谁：拓扑、继承、生效能力、**可见域** |
| **基因组** | AgentClass（`.stem/agent/*.md`） | 我是谁：systemPrompt / tools / 节律参数 / model |
| **生理** | 上下文策略（`.stem/context/*.ts`） | 怎么记：组装、压缩、归纳、**自持节律** |
| **时间** | 双时钟并行 | sendCountdown（事件合并窗）∥ 策略自调度（时钟节律） |

**进化闭环**（1.0 口径 = 人启动）：评估者读日志与语料 → 产出诊断与变体 → **写类文件 / 写策略文件**（目录即真相）→ 重启装载 → **新实例携带新基因出生** → 活体语料回流评估。

**两条铁律**（讨论定案，全部设计以此为准）：

1. **进化发生在类层/文件层，不发生在个体一生内**——`contextStrategy` 与拓扑绑定是实例化时固化的上下文属性；个体不能中途换策略/换权限基因。"自我迭代" = 旧个体生产新基因，新个体携带新基因出生。
2. **调度权归策略，不归 kernel**——策略本就是独立模块、已握有 `StrategyApi`（直接操作记忆）。周期性整理 = 策略自调度 + 直接操作记忆，**不是** kernel 定时回调策略。（否决记录见 §5.4）

---

## 1. 决策冻结清单

| # | 决策 | 状态 |
|---|---|---|
| D1 | 族谱树**保留现名** LineageTree/"族谱树"（"agent 实例树"仅为概念别名，不入命名） | ✅ |
| D2 | 树 = 拓扑 + 能力物化（AccessLedger 并入）+ 编排下沉 + **可见域端口**；**仍是纯派生相**（rebind 可重建、不入库） | ✅ |
| D3 | 树**禁止**吸纳运行时状态（status/turnCount）与 context 注册接线——静态能力拓扑归树，时间轴执行归 Runtime/kernel | ✅ |
| D4 | kernel 瘦身：`instantiate` 的"能力解析"半段（bind/继承/收敛/grant 编排）下沉树；kernel 留生命周期 + 接线 + LLM 循环 | ✅ |
| D5 | 进化三缺口逐一补：类落盘 / 日志可见面 / fitness（**1.0 只做前两个 + 人启动进化**，自动优化等 benchmark） | ✅ |
| D6 | 类书写面 = create（新名落盘，变体并存可 A/B）+ update（同名覆盖落盘）；均 ask 门控、审计落 `log.class.*`；模型侧 update 只能收敛工具面 | ✅ |
| D7 | 策略文件修改 = 走既有 bash/edit（系统信任级、用户主权、容器边界兜底），**不新建模型侧写策略通道**；生效 = 重启装载（热重载推迟） | ✅ |
| D8 | **不删 courier**：合并窗口=成本、每实例独立倒计时=并发、"仅外部来信唤醒"=防自回复循环；"kernel 收发缓冲"方案撤销 | ✅（撤销旧案） |
| D9 | **不做 kernel 双模式**（同步/异步）；tick 不是内核模式开关 | ✅（撤销旧案） |
| D10 | **不注入 tick 合成信、不引入 process `deliver\|suppress` 契约**——v3 策略自调度直接操作记忆，不走送信链路（比 tick 信方案更小更本质） | ✅（取代 v1/v2） |
| D11 | dreaming 类仿生策略 = **方案阶段**（本文 §5），实施排在薄调度（S5.3）之后，1.0 不承诺 | ✅ |
| D12 | `telemetry_query` 可见域 = **自身 + 后代**（祖先可代查、根天然全视）；与 `context_remove` 族谱权限语义同构。明确**不做**全谱可见（击穿树位置收敛语义） | ✅（倾向，待确认 #3） |

**待拍板**（§6 汇总）：睡眠拍审计留痕粒度、1.0 心跳是否允许全量 LLM 轮、进化熔断参数。

---

## 2. 现状基线（S5 冻结时点核实，保留为历史快照；至 2026-09-02 本表多数行已落地或被超越——agentSerialize / telemetry_query / 树 attach / 类落盘均已存在，实况以 docs/architecture.md 为准）

| 事实 | 出处 |
|---|---|
| 族谱纯关系视图（无状态、provider 注入、零 tools 依赖） | `src/core/lineage/LineageTree.ts` |
| 权限台账与树**并列**于 lineage 目录：`bind/unbind/rebind/has/effectiveAccess/profileOf`，物化标准形 `{explicit, fallback}`，不入库、重启拓扑重放 | `src/core/lineage/AccessLedger.ts` |
| kernel 编排残留：`instantiateInSpace` 内联台账绑定（`ownAccessOf` + `ledger.bind` + grant 模式判断）与 contextManager.register 接线 | `src/core/kernel/Kernel.ts`（≈L378-415） |
| 状态机四态 `idle/thinking/holding/interrupted`，无 sleep | `src/core/kernel/types.ts` |
| LogEvents 16 型（tool.invoked / gateway.apiRequest / context.assembled / context.compacted / mailbox.* / kernel.* / access.* / init.*），`InMemoryLogger` 有 `query()` 但**模型侧无任何日志工具** | `src/core/logging/events.ts` |
| `TemplateRegistry` **已有 `update/remove` API**，但无工具面、无落盘 | `src/core/kernel/TemplateRegistry.ts` |
| `agent_class_create` 工具仅内存注册；**类不落盘，重启即蒸发**（进化闭环最硬缺口） | `src/core/kernel/systemTools.ts` |
| 策略契约：`ContextStrategyModule {name, note, role, assemble, process?, actions?}`；`StrategyApi {agentId, settings, estimatedTokens, list, listValid, append, markInvalid, spawn, log}`；process 触发点 = user_prompt 信件抵达 | `src/core/context/strategies/types.ts` |
| **TimerFactory 端口已在 `ContextManager` 手中**（`timer?: TimerFactory`，Courier 同款）——策略自调度只需把它接进 StrategyApi，零新端口 | `src/core/context/ContextManager.ts` L36/L146 |
| `.stem/agent/*.md` = 类持久唯一面（agentParse：文件名即 id，frontmatter `tools/context_strategy/model` + 未知键透传 custom，正文 = systemPrompt）；**无逆函数（序列化器）** | `src/core/init/agentParse.ts` |
| `agentParse.normalizePermissions` 支持四态 allow/ask/deny/ignore | 同上 |
| 目录即真相已立（S4.2）：init 纯只读、无镜像；`.stem/tools/` 复数 | `src/core/init/init.ts` |
| 语料基础已在：terminate 归档保留全部消息 + 双索引 + tag 位（impression/lesson 等） | `src/core/context/persisted.ts`、AGENTS 持久化节 |

---

## 3. S5.1 · 族谱树重构（实例树合并）

### 3.1 目标

把"关系相"（LineageTree）与"能力相"（AccessLedger）合并为**单一门面**，并下沉 kernel 的能力解析编排，使树成为实例层一切派生事实的唯一查询面。**行为零变化是硬验收**（纯重构）。

### 3.2 目标形状

```
core/lineage/
  LineageTree.ts        # 门面（保留现名）。对外聚合三类查询：
    ├─ 拓扑    getParent/getChildren/getAncestors/getDescendants/getRoot/isAncestorOf（不变）
    ├─ 能力    effectiveAccess(agentId,key)/profileOf(agentId)/has(agentId)
    └─ 可见域  canReach(viewerId, targetId)      ← 新增（自身∨祖先可代查；见 3.4）
  AccessLedger.ts       # 保留为树的内部实现文件（物化两步曲/rebind 逻辑原样迁移，不重写）
```

**新增生命周期编排（下沉自 kernel）**：

```ts
/** attach：实例注册的"能力解析"半段——继承→收敛 / grant 整表，一步完成。
 *  kernel 传入自身清单（类 tools ∪ toolOverride 已由 kernel 合并好）与模式；
 *  树内部完成 parent profile 解析、restrictAccess 取严、fallback 封闭物化。 */
attach(entry: { agentId; parentId; own?; mode?: 'inherit' | 'grant' }): void
detach(agentId): void
replay(entries: readonly AttachEntry[]): void   // 重启拓扑序重放（原 rebind 语义）
```

**依赖方向（不破）**：树需读"父档案/自身清单"，但自身清单由调用方（kernel）算好传入——树**不 import kernel/TemplateRegistry**（维持零类层依赖）；`lineage→tools` 仍只共享 `restrictAccess` 纯代数。若后续要"树直读类档案"，用注入 provider 端口，当前不做。

### 3.3 kernel 瘦身

`instantiateInSpace` 中删除台账绑定段（`ownAccessOf` + `ledger.bind` + grant 判断改为一行 `tree.attach(...)`）；`restore` 路径的台账重放改 `tree.replay(...)`；`terminate` 路径改 `tree.detach(...)`。AccessResolver 端口由树供实现（`tools` 侧零改动）。

### 3.4 可见域（为 S5.2 预铺）

`canReach(viewer, target) = viewer === target || isAncestorOf(viewer, target)`（自身，或祖先代查）。消费方：
- S5.2 `telemetry_query`（查**自身 + 后代** = ∀t. canReach(t, viewer) 的镜像：目标属于 viewer 子树或 viewer 自身）；
- 与既有 `context_remove/edit/export/apply` 的"仅自身或祖先"同构——**统一收敛到这一个树谓词**，消除各系统工具内重复的族谱判定散点。

### 3.5 迁移步骤与验收

1. AccessLedger 实现并入 LineageTree（内部组合，两文件保留；语义矩阵测试随迁不删改）；
2. 树加 attach/detach/replay/canReach；
3. kernel 三处调用点切换（instantiate / restore / terminate）；
4. 系统工具的族谱判定切换 canReach（行为等价）；
5. **验收**：202 测试全绿零语义改动（台账矩阵 11 例逐条对拍）；typecheck 0；webui 冒烟（权限面/ask 弹窗无变化）。

### 3.6 风险与红线

- **红线**：树节点不得持有任何运行时/时间轴状态；不得持久化（派生态 = 可重建，这是不入库的全部理由）。
- 风险：门面膨胀 → 规则 = 树只回答"位置/能力/可见域"三类问题，其余一律拒绝入树（例：agent 忙闲 = Runtime；上下文内容 = 仓库）。

---

## 4. S5.2 · 进化观测与书写

### 4.1 观测：`telemetry_query`（internal，缺省 ignore）

```
参数: { agentId?, types?: string[], since?: number, limit? = 50 }
语义: 无 agentId → 查调用者自身;有 → 需 caller.canReach(target)（自身+后代）
返回: 行式压缩（"at | type | 关键字段…"，控制 token 面）；空结果返回显式 '(no events)'
权限: 纯查询无副作用 → user0 默认表可 allow（评估者 role 亦经 grant 面给）
```

实现要点：`createStemSystem` 已持 `Logger`（InMemoryLogger.query 现成）；工具工厂注入 `logQuery` 端口 + 树 `canReach`（经 kernel 闭包，工具不 import lineage）。日志事件新增两型配合书写面：`kernel.class.updated`（patch 摘要）与后续 §5 的整理事件。

### 4.2 书写：类落盘（本轮最硬补环）

**先决件：序列化器**（agentParse 的逆函数，`core/init/agentSerialize.ts`）：

```
AgentClass → .stem/agent/<name>.md
  frontmatter: description / tools(四态 Record 原样) / context_strategy? /
               model?(ModelRef → "provider/id" 回写) / send_countdown? /
               custom(原键值透传，round-trip 无损)     // 正文 = systemPrompt
  往返律: parse(serialize(cls)) ≡ cls（name 恒取文件名；panel 等内部键不落盘，见红线）
```

红线：`panel:true` 的策略 role / 内置类 **永不回写**（系统机制类与用户基因分界，`.stem/agent/` 只装用户主权基因）。

**工具面**（两枚，默认表外——user0 想用需在 `config.user.tools` 声明，或维持 create 的 ask 现状）：

| 工具 | 语义 | 门控 |
|---|---|---|
| `agent_class_create`（改造） | 注册 **+ 落盘**。新名 = 变体并存（gen-2/gen-3 谱系，供 A/B 与回滚） | 现状 ask 保留；**授权即落盘**（拒绝则纯内存试验田可选，见开放点 #4） |
| `agent_class_update`（新增） | 同名覆盖 + 落盘。参数 = `Partial<AgentClass>` patch | ask 门控；**工具路径只允许收敛**：patch.tools 逐键与现档案取严（deny≺ask≺allow 不可逆扩张——`TemplateRegistry.update` 现成但零校验，需在工具层补），model/systemPrompt 可改 |

**边界记录（设计内）**：
- update 只影响**后续实例**——已绑定实例的能力快照已物化于树（不追改，防"改类即改现役 agent"的远程失控）；
- remove 暂不暴露（类退场 = 用户删文件——目录即真相的删除权归用户）；
- 重启后 = `.stem/agent/` 装载（现状管线零改动，落盘即进化持久——S4.2 红利兑现）。

### 4.3 人启动的进化回路（1.0 口径）

流程：用户让 user0 实例化/唤起一个**评估者**（可用 `.stem/agent/evaluator.md`：telemetry_query + context_export + 读库语料）→ 产出诊断与变体（新类 create / 现役 update / 策略文件改写提案文本）→ **ask 门落盘类，策略文件由人/模型经 edit 落实** → 重启装载 → 新实例出生验证 → 语料对比。
明确不做：自动批量试错、自动改策略、目标函数自评（全部等 benchmark）。

### 4.4 验收

序列化器 round-trip 单测（含 custom 自由键 / 四态 / 缺省键省略）；update 收敛校验矩阵（扩张 ask→allow 被拒 / 合法收敛通过）；telemetry 可见域矩阵（兄弟不可见、后代可见、根全视）；重启进化持久 e2e（create → dispose → 重建系统 → 类仍在）；全量 202 + typecheck。

---

## 5. S7 候选 · brain_enhanced 三层记忆策略（重写于 2026-09-02）

> 定位：**方案冻结**（用户构思 brain-simu/增强版 + v1.0 验收约 60 个真实模型轮反馈校准，证据见 docs/llm-playbook.md）。进化对象 = 生理层（策略），与 §9（基因层进化）正交。经典问题：classic 是急救室（超阈值压一次），brain 是生理（持续印象化 + 短期笔记 + 睡眠固化）。

### 5.0 理论地基（用户四点 → 工程映射）

| 论点 | 工程落点 |
|---|---|
| 智力够，缺"记忆生理" | 三层：上下文层（工作记忆）/ 笔记层（海马体，文件）/ 记忆层（皮层，单文件） |
| 高频闭环 > 开环一次性 | stem 已有节律器官（快递员/倒计时/信箱）；brain 把"感知"从塞满上下文换成**指针化记忆 + 工具实时读环境** |
| 有损压缩 + 睡眠归纳 | 压缩必损 → 毒性靠 provenance + 每拍全量重写 + 过时声明对冲（§5.5 风险表） |
| 自进化不人工调参 | **权衡即基因**：精准↔印象谱 = `custom.mem` 数值位，进化回路（§9 评估者）可调；策略代码本身 = 系统信任级不动（D7 延续） |

### 5.1 前置薄件：策略自调度（原 S5.3 设计存活，重编号 S7.1）

`StrategyApi` 追加 `schedule(name, fn, everyMs)`（同名幂等覆盖 / fn 异常吞并落 log / 宿主 detach·terminate 联动取消 / 不入库重启由策略注册期自排——TimerFactory 已在 ContextManager 手中，零新端口）。睡眠拍触发 = **timer 到点（给出"最早可睡"）∧ 轮闭合（Runtime activeTurns 无本 agent 在途——P6 产物直接复用）**。双时钟正交、对删 courier / 注 tick 信 / kernel 开关三案的否决记录不变（git 史可溯，铁律 D10 不破：策略醒来直接操作记忆，不经 kernel 编排、不经信件链路）。

### 5.2 三层生理形状

```
L0 上下文层（每拍 assemble 现拼，全派生，不落任何新存储）
   = <memory>  LTM 文件头注入（按预算截断）
   + <notes>   笔记层目录条（每篇一行"主题 —— 首句摘要"）
   + 精准区     最近 recentFloor 轮原文（valid 消息，天然滚动）
   + 本轮信件   （永远在场）
L1 笔记层 = .stem/mem/<agentId>/notes/<主题>.md   —— 短期记忆/操作文档
   写入方：① compact 升级——摘要 worker 输出从"一条 summary 消息"变为
   "按主题分篇落文件 + 上下文内一行指针"（原消息 markInvalid 归档照旧）
   ② 睡眠拍副产品（整理时发现值得成篇的细节）
   读取方：模型按注入目录条按图索骥——有 fs 工具的类直接 read（路径权限
   天然，v1 不设专用工具）；无 fs 的类由策略在追问时代读打包（v2 候补）
L2 记忆层 = .stem/mem/<agentId>/MEMORY.md          —— 长期单一记忆文件
   唯一写入者 = 睡眠拍（全量重写，覆写即纠错）；人可手改（文件即真相）；
   每次睡眠留 DB 一行 tag='memory' 审计消息（不承载注入）
```

**存储裁决：记忆住文件，不住消息带**（推翻原 §5.2 ltm-stm-mix 的 tag 带案）——人可审、git 化即记忆史、覆写即纠错、与语料归档解耦；实测背书：模型对"文件=真相"母语级适应（skill/回读/跨重启全一次上手），对静默注入的 note 不调起（llm-playbook §2.1）。目录名定 `mem` 不用 `tmp`（tmp=可弃，记忆=资产；根级 tmp/ 已退役避免混淆）。

### 5.3 睡眠规格（一拍一次生死）

```
水位线：上次睡眠 at（MEMORY.md 头注 <!-- slept@<at> --> 即状态，零新存储）
触发  ：timer 到点 ∧ 轮闭合 ∧ 饥饿达标（水位线后新内容 ≥ hunger tokens）
打包  ：策略读 [MEMORY.md 现文 + 新/变笔记篇目 + 水位线后 episode 片段(截断)]
        → 一份纯文本 userPrompt（记忆工作不需要环境操作）
工人  ：role memorist-<agentId> 子实例——父=宿主（族谱诚实）；tools 字面 {}
        零工具（输入输出纯文本契约，同 summarize worker；fs/bash 一律不给，
        无人值守写盘通道 = §5.5 红线）；model = custom.mem.consolidateModel
        基因位（缺省 inherit，起步配小模型）
产出  ：新 MEMORY.md 全文（规范见 §5.5 毒性对策行）→ 策略写盘 → 工人
        terminate 归档（不留常驻睡眠工，防族谱/dashboard 僵尸节点）
留痕  ：DB append tag='memory' 一行（输入摘要+条数）+ 审计事件
        context.memorized{agentId, inTokens, outTokens, bytes}（token 账目
        走既有差分归位，睡眠成本可观测）
```

### 5.4 权衡旋钮（brain-simu ↔ 全保留 = 同一基因面的滑位）

```
custom.mem = { ltmShare: 0.10, notesShare: 0.05, recentFloor: 6,
               hunger: 2000, everyMs: 600000, sleepCap: 48, consolidateModel? }
```

比例 × window 预算分配（LTM 超份额截断、目录条恒一行/篇）；`recentFloor→∞ 且 ltmShare→0` 退化为 classic，`recentFloor→0` 即**纯 brain-simu**（极端印象化，全靠指针+工具）——用户方案的两个变体是同一策略上的谱，不做两个策略。`sleepCap` = 每日睡眠硬顶（原开放点"进化熔断"在此落位）。基因经 StrategyApi 读宿主类 custom 获得（D11 归属不变）。

### 5.5 风险与治理（括号内为实测证据）

| 风险 | 对策（全部在机制内） |
|---|---|
| **有损压缩毒性**：错误固化进 LTM 反复注入（验收 P5：模型把一次工具失败当永久事实写进总结并链式误判） | MEMORY.md 规范：每条印象带 `←t<turn>` provenance 可回查；睡眠**全量重写**（旧错被下拍稀释）；注入头恒附一句"记忆可能过时，关键决策回语料/文件核实" |
| 注入物不被调起（实测：note 零反应 vs 点名格式全中） | `<memory>/<notes>` 显式块格式；宿主类 systemPrompt 配第二环句："笔记目录=你的记忆索引，追问细节前先读对应篇目"（playbook §2.1 现成文案） |
| 睡眠与在途轮竞态 | 触发恒在轮闭合后（activeTurns）；水位线幂等；睡眠期间新消息进 L1 等下拍 |
| 成本失控 | 饥饿才睡 + consolidateModel 小模型位 + sleepCap 硬顶；worker 账目归位已可观测 |
| "读笔记"挤占步数预算（乱走吃光 maxSteps 实证） | 目录条给"何时读"条件不给能力清单；**前置依赖：playbook §3 步数预算告知改进** |
| 无人值守写盘面 | 睡眠工零工具（§5.3）；只写 `.stem/mem/`；策略文件/类文件与睡眠绝缘（**记忆≠基因，两层不交叉**）；`.stem/mem/` 建议入 git = 记忆史可审可回滚 |

### 5.6 批次与验收

| 批 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| S7.1 | `schedule` 薄调度（含 detach 取消/异常兜底/重启自排） | — | timer 无泄漏/异常不逃逸/重启重排 单测 |
| S7.2 | `.stem/mem/` 文件协议 + compact 升级（分篇笔记+指针）+ L0 组装注入 | 可与 S7.1 并行 | 离线双档改造：FakeGateway 下笔记分篇落盘、重启后目录条复现；classic 用户零影响（策略按类注册隔离） |
| S7.3 | memorist 睡眠拍 + 审计事件 + `custom.mem` 全基因位接通 | S7.1+S7.2 | 离线：mock 输出→MEMORY.md 重写→下拍注入可见；在线：第 30 轮仍能答对第 3 轮事实（记忆保持 needle 文件化变体），对照 classic 同任务成本/质量 |
| 明确不做 | memory_note 主动工具（等实测暴露需求再议）、策略代码自进化、常驻睡眠工、`.stem/tmp` 命名、唤醒全量 LLM 心跳轮（原开放点 #2 裁决不变） | | |

## 6. 批次、依赖与验收总表

| 批 | 内容 | 依赖 | 验收 | 节奏 |
|---|---|---|---|---|
| **S5.1** | 树合并 + attach 下沉 + canReach | — | ✅ 达成（46bb227）：+6 门面直测、余 202 零修改全绿、typecheck 0 | — |
| **S5.2** | 序列化器 + create/update 落盘 + telemetry_query + 类审计事件 | S5.1（canReach） | ✅ 达成（efcd499）：237 全绿（+29，含重启进化 e2e） | — |
| ~~S5.3~~ | 薄调度设计存活，**编号并入 S7.1**（§5.1，2026-09-02 重编） | | | |
| ~~S5.4~~ | dreaming/ltm-stm-mix **已被 §5 brain_enhanced 重写取代**（记忆住文件非消息带） | | | |
| 后置 | ~~benchmark/fitness~~ → **已被 §9 目标-达成度方案取代**（用户裁决，benchmark 基建不建） | — | — | — |

## 7. 待拍板（S5.3/S5.4 实施前处理）

1. **睡眠拍留痕**：整理审计事件粒度（仅落"确实改了记忆"→ 推荐；每次醒来必落 → 不推荐）；
2. **心跳 LLM 轮**：1.0 只 worker 级整理（推荐）vs 允许全量对话轮；
3. **进化熔断**：是否采纳"周期书写次数上限"（推荐做，一行配置）；
4. **ask 拒绝时的落盘语义**：✅ 已由机制裁决（S5.2 实施）——ask 门在 execute 之前，拒绝 = 工具根本不执行（既不注册也不落盘）；"纯内存试验田"场景 = 宿主未注入 `classFs` 时（create/update 文案显式区分"已落盘 / 仅内存注册"）。

## 8. S5.1/S5.2 实施记录（与本文原稿的偏差 = 以代码为准的勘误）

1. **审计事件命名**：`kernel.class.registered/updated`（对齐既有 kernel.instance.* 家族），非原稿泛称 `log.class.*`；均带 `persisted` 与发起者 `agentId`（归属映射 `eventInvolvesAgent` 导出为唯一实现，顺带补齐 context.compacted 事件映射）。
2. **update 的 tools patch = 增量合并**（原稿"逐键 patch 取严"未指明表语义）：整表替换会在只改一键时静默丢其余键——restart e2e 当场暴露此陷阱后定案 `{ ...current, ...patch }` 合并、仅对提及键做收敛校验。
3. **收敛判定 = rank 不升矩阵**（deny ≺ ask ≺ allow/ignore）：ask→allow/ignore 拒（不可移除人审闸）、deny 任何变更拒、allow↔ignore 同级互转放行（可见性自决，与台账"同级取自身值"同构）、**新键放行**（键即白名单 = 自我限定，实际能力仍由族谱台账收敛兜底，扩张不可达）。
4. **update 目标治理**：缺省 = 调用者所属类（自我进化主路径）；显式 name 可指向任意类，防护 = ask 门 + 白名单 + panel/user 根类拒绝 + "只影响后续实例"，未加谱系位置校验（机制大于判断：越权书写由根授权收敛）。
5. **telemetry**：缺省查询 = 仅自身、后代需显式 agentId（与本文一致）；实施增强 = types 支持 `gateway.*` 前缀通配、limit 截尾并报告总匹配数、行摘要按类型取关键字段不 dump 大负载。
6. **panel/user 红线双保险**：工具层文案拒绝 + `serializeAgentClass` 抛错（红线不依赖单层防守）。

## 9. 目标-达成度进化（exemplar 拟合）· S6 批 3 方案存档

> **状态**：方案设计冻结，**未排实施**（用户 2026-09-01 裁决：S6 当下重心 = 网关/配置/族谱模型/WebUI 四模块）。
> **定位**：本方案**取代** §6 批次表中"benchmark/fitness → 自动化进化"后置行——用户裁决改道第一性方案：不做 benchmark 基建，目标 = 例文本体，达成度 = 拟合打分。

### 9.1 哲学：为什么例文比 benchmark 更第一性

- benchmark 回答"通用能力打几分"——间接度量、基建沉重（任务集/评分器/回放），且与"这个用户想要什么样的回复"隔着一层；
- **目标-达成度**：用户给几段例文（输入 → 他满意的回复）= 目标的全信息表达；评估 = 判定模型对照例文的拟合打分，回路里没有任何中间指标基建；
- 进化对象严格限定 = **Agent 类基因**（systemPrompt / model / sendCountdown / tools 收敛面）；**上下文策略不动**（classic 足够承载——用户裁决），本方案与 S5.3/S5.4 调度、dreaming 完全正交，互不阻塞。

### 9.2 承载件（三个，全部走既有"目录即真相"，零新增子系统）

1. **目标卡 `.stem/goal.md`**（自由文本，LLM 亲读，刻意不建 schema——校验例文格式 = 又造一套 benchmark）：

   ```markdown
   # 目标：<一句话，如"回复更像日常助理：口语、克制、先结论">
   ## Rubric（每例文按维打 0-10）
   - 风格贴合（对照例文的语气/结构/长度习惯）
   - 信息克制（不堆砌、不表演）
   - 任务达成（该做的事做了）
   ## 例文对
   ### case-1 <输入>… </输入> <理想回复>… </理想回复>
   ### case-2 …（建议 3-6 组；太少拟合噪声大，太多烧钱）
   ## 通过线
   - 均分 ≥ 8.5 或连续两代无提升即收敛
   - 熔断：代数 ≤ 4 / 单代 LLM 花费上限（自配 totalCost 观测判断）
   ```

2. **评估者类 `.stem/agent/evaluator.md`**（一个类文件 = 整套流程的实例化；作业协议直接写进 systemPrompt）：

   ```yaml
   ---
   description: 目标-达成度进化执行者：读 .stem/goal.md，迭代目标类变体直至拟合
   tools:
     agent_instantiate: allow    # 造被测实例（父=评估者，族谱诚实）
     agent_list: allow
     context_wait: allow         # 收被测回复
     context_export: allow       # 读完整 transcript 供打分
     telemetry_query: allow      # 回放自身辖区运行日志
     agent_class_create: ask     # ★ 写基因仍走根批准（人类锚点保留，不豁免）
     agent_class_update: ask
     bash: deny                  # 评估者不需要对外操作面（键即白名单的自我限定示范）
   ---
   <协议正文见 9.3>
   ```

3. **协议文档** = 本节（正式实施批若获通过，再同步进 docs 使用面）。

### 9.3 作业协议（评估者 systemPrompt 的正文骨架）

```
loop（gen = 当前代数，缺省冠军 = 目标类现名）：
 1 读 .stem/goal.md（例文 + rubric + 通过线 + 熔断参数）
 2 对每条例文：agent_instantiate <冠军类>（userPrompt = 例文输入）→ context_wait 收回复
   ——被测实例挂评估者名下 = 可见域天然覆盖，打分所需 transcript 合法可查
 3 自评打分：逐例文逐 rubric 维 0-10 + 一句诊断；均分 = 本代达成度
   （打分与生成同模型时注意自我偏好噪声——可选 agent_instantiate 换裁判类的变体玩法）
 4 通过线达成 / 熔断触发 → 终止：向根汇报（分数史 + 冠军类 + 每代 diff 摘要）
 5 否则诊断 → agent_class_create <目标类>-g<gen+1>（新名变体并存可 A/B）
   ——tools 只许收敛（S5.2 内建）、prompt 自由突变；ask 待根批准
 6 分数写进新类的 custom.eval = { gen, score, at }（类文件 = 合法持久载体，
   分数史随基因走、重启不丢、agent_class_list 一屏尽览——不建第三持久面）
 7 回 2（下一代以本代更优者为冠军）
```

### 9.4 与 S6 机制的咬合（本方案几乎全是复用）

| 依赖 | 提供方 |
|---|---|
| 书写面（create 变体/update 收敛 + ask 门 + 落盘重启生效） | S5.2 已落地 |
| 观测面（telemetry_query 树可见域） | S5.2 已落地 |
| **模型 = 进化基因位**（逐代 A/B 换模型拟合、setModel 随时切换） | **S6 批 1**（族谱模型配置相）——评分史住 custom 正是为多维基因留位 |
| 版本对照 = 变体并存 + git 审史 | S4.2/S5.2 既有 |

### 9.5 v1 执行形态与首战

- **人启动**（S5 冻结口径）：用户一句话发起（"按 goal.md 迭代 assistant 的日常助理风格"），评估者实例（或 pilot 背后的人/我）跑循环；自动心跳化 = 等 S5.3 调度薄层，属另一条演进线；
- 首战验收：真实网关（S6 批 1 后）下 gen1→gen2 一轮完整进化，分数史落类 custom，log.md 留档——进化闭环首个活体样本；
- 明确不做：打分服务、例文 schema 校验、自动无人值守、上下文策略进化。

### 9.6 已知风险（预案在机制内，不加新件）

- **同模型自评的偏好噪声** → 缓解 = 协议第 3 步的裁判类变体 + 例文对锚定（相对打分比绝对打分稳）；
- **prompt 过拟合例文**（背题不泛化）→ 缓解 = 例文建议 3-6 组异质输入 + 终局人工验收（ask 门天然是最终泛化测试位）；
- **烧钱失控** → 熔断三条件（代数/停滞/花费）写目标卡，评估者协议第 4 步硬查 `totalCost` 观测。

---

*本文档由三轮设计讨论收敛生成；§9 为 S6 批 3 方案存档（用户 2026-09-01 改道裁决）；§5 于 2026-09-02 按用户 brain 构思 + llm-playbook 实测整卷重写。实施时各批独立提交并同步 architecture.md/log.md。*
