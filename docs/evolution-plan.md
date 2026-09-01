# stem 自进化与自主节律 · S5 方案冻结

> **性质**：方案设计冻结文档。经三轮讨论收敛，作为 S5 各批实施的唯一依据；与口头讨论冲突时以本文为准。
> **状态**（2026-09-01）：**S5.1 族谱树重构 ✅（46bb227）· S5.2 进化观测与书写 ✅（efcd499）**——实施偏差与裁决记录见 §8；S5.3 调度 / S5.4 dreaming 延后实施（用户指令）。**§9 = 目标-达成度进化方案存档**（用户改道裁决，取代原"benchmark 后置"行；未排实施）。
> **日期**：2026-09-01 · 前置：S4 已全部落地（bash 单点 / extensions tool_set / 目录即真相 / OLED webui / Docker）。
> **范围**：①族谱树重构 ②进化观测与书写 ③dreaming 上下文策略方案。**不含**实现代码；benchmark/fitness 模块明确后置。

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

## 2. 现状基线（已核实）

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

## 5. S5.3/5.4 · 策略自调度 + dreaming 仿生策略（方案）

> 定位：**方案冻结，不排入 1.0 实施承诺**。dreaming 是"进化闭环跑通后第一个被进化的对象"——先用本文机制把它设计成可生长的形状。

### 5.1 机制：调度权归策略（v3 冻结形态）

**唯一薄件**：`StrategyApi` 扩一个调度面 + 自触发约定——

```ts
// StrategyApi 追加（TimerFactory 已在 ContextManager 手中，经工厂透传）：
readonly schedule: (name: string, fn: () => Promise<void>, everyMs: number) => void
//  ① 同名幂等覆盖；② fn 抛错 = catch + log，绝不逃逸；③ 宿主 agent detach /
//  terminate → 该 agent 全部 timer 取消（树 detach 联动，防泄漏）；
//  ④ 不入库：重启后由策略注册期自行重排（节律是类的基因位，从配置重建）。
readonly wakeHint?: （后置可选）策略请求"提前醒一次"，v2 再谈。
```

**自触发语义**：策略在模块装载/首绑定时把自己某个 action（如 `consolidate`）`schedule` 上——醒来时**直接经 append/markInvalid/spawn 操作自己的记忆**，全程 kernel 不参与、不经信件、不经快递员。

**双时钟并行定案**（承 D8/D9/D10）：

| | sendCountdown | 策略自调度 |
|---|---|---|
| 驱动 | 事件（来信） | 时钟 |
| 作用 | 合并突发信，攒一次 LLM 调用（省） | 无刺激时的生理窗（整理/进化评估） |
| 归属 | courier（保留） | 策略（经 TimerFactory 端口） |
| 关系 | **正交**：整理不动送信状态机；送信不看定时器 | |

**否决记录（防翻案）**：①删 courier 改 kernel 收发缓冲（= 在 kernel 里重写 courier 且丢合并窗/并发隔离/唤醒语义）；②kernel 定时注 `<tick/>` 信 + `process` 返回 `deliver|suppress`（= 多造一条信类型 + 契约分支，而策略本就可直接动记忆——间接且更重）；③kernel "tick 开关调用其他接口"的处理器注册（= kernel 长业务，违背薄协调者）。

**开放点 #1（睡眠拍留痕）**：自调度整理天然留痕（append 的 impression + markInvalid 位图 + 新事件 `context.consolidated`）——倾向**落审计事件**；"每次醒来即写一条心跳行"倾向**不做**（纯 token/IO 噪声）。

### 5.2 dreaming 策略记忆分层（生理模型）

```
┌ LTM（新皮层）:  tag ∈ {impression, lesson} 的合成记忆带 —— 小而全，恒在
├ STM（海马体）:  最近 N 轮原文 —— 精准，滚动过期
└ 当前拍:        本轮信件 —— 永远在场
```

组装 = 预算分配拼接（`window × 比例`，LTM 超预算则再归纳一层）；写入 = 睡眠期跨轮归纳。

**与 classic 的关系**：不冲突、分层复用——classic 是**被动急救**（超阈值压 turn→summary，轮内），dreaming（拟名 `ltm-stm-mix`）是**主动生理**（周期跨轮归纳 episodes→语义记忆）。实现上 ltm-stm-mix **组合复用** classic 的 assemble 与 compact 实现，只加自调度归纳例程，不复制压缩逻辑。

### 5.3 睡眠期动作规格（v1 只做两件事）

| action | 内容 | 成本 |
|---|---|---|
| `consolidate` | 自上次水位线以来（水位线 = 私有 tag 消息记 `at`）的 episodes 交 **spawn worker（小模型，复用 `summarizeModel` 先例）** 归纳 → `append(tag:'impression'/'lesson')`；原文不失效（等 classic compact 收口，防双重失效竞态） | 零主模型；小模型 |
| `prune` | 低价值寒暄轮 markInvalid（保留判断走规则/worker） | 零 LLM（可选） |

**节奏 = 可进化基因位**：`everyMs` 起步保守（如 idle-only + 低频）；节律参数归属类配置（`custom.dream.*` 透传位——策略经 `StrategyApi` 读宿主类的 custom 即可拿基因），进化回路可自调。

### 5.4 治理红线（无人值守自改进 = 最锋利处）

- 策略文件 = 代码、系统信任级：改它的手段是既有 bash/edit（用户主权），生效重启——**不给模型任何新的写策略通道**（D7）；
- tick + bash 无 ask + 类可写 → 三防护：类显式配置才有心跳（opt-in）、telemetry/授权可见域走树位置函数（§3.4）、`.stem/` git 化 = 进化史即版本史；
- **开放点 #3（熔断，倾向做）**：每日/每周期 `log.class.*` 书写次数上限（如 10），超限策略自抑制 + `notice` 事件提示人工介入——防无 fitness 梯度下朝"省 token"方向漂；
- 全量 LLM"心跳对话轮"**不进 v1**（开放点 #2）：先只做 worker 级整理。

### 5.5 评估面（benchmark 占位）

语料基础已在（归档不删 + 双索引 + tag）。benchmark 模块 = 回放任务集 → 同任务在两代类/策略下跑出 telemetry 对照（成功率/成本/中断率/ask 通过率）→ 供评估者消费。**S5.2 观测面跑起来之前不动工**。

---

## 6. 批次、依赖与验收总表

| 批 | 内容 | 依赖 | 验收 | 节奏 |
|---|---|---|---|---|
| **S5.1** | 树合并 + attach 下沉 + canReach | — | ✅ 达成（46bb227）：+6 门面直测、余 202 零修改全绿、typecheck 0 | — |
| **S5.2** | 序列化器 + create/update 落盘 + telemetry_query + 类审计事件 | S5.1（canReach） | ✅ 达成（efcd499）：237 全绿（+29，含重启进化 e2e） | — |
| **S5.3** | `StrategyApi.schedule` 薄调度（含 detach 取消/失败兜底/重排） | S5.1（生命周期钩子点） | timer 无泄漏测试、异常不逃逸测试 | 小批 |
| **S5.4** | `ltm-stm-mix`（consolidate 起步）+ 模板文档 | S5.2+S5.3 | 语料对照人工评审（impression 质量） | **实验性，1.0 后** |
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

*本文档由三轮设计讨论收敛生成；§9 为 S6 批 3 方案存档（用户 2026-09-01 改道裁决）。实施时各批独立提交并同步 architecture.md/log.md。*
