# brain_enhanced 上下文记忆策略 · 方案冻结（brain-plan）

> **性质**：plan 卷——实施期执行依据，不回改；落地即随下一功能批退役（contributor §1.1）。
> **前身**：原 evolution-plan.md §5 dreaming/ltm-stm-mix 案（该卷 S5/S6 内容全部落地后随批退役，历史见 git 史与 docs/log.md；基因层进化"目标-达成度 exemplar 方案"存档同在该卷 §9，实施时另开 plan 卷）。
> **来源**：用户 2026-09-02 构思（brain-simu 三层记忆 + 上下文层模型主权）× v1.0 验收约 60 真实模型轮实测校准（证据 = docs/log.md 2026-09-02 阶段记录；原 llm-playbook 卷已退役，行为观察要点已并入本卷风险表与 AGENTS 速查）。
> **一句话**：classic 是急救室（超阈值压一次），brain 是生理——**主动整理（模型主权）+ 被动卸载（策略保底）+ 睡眠归纳（离线固化）** 三通道，精准上下文与记忆上下文的权衡做成可进化的基因旋钮。

## 0. 理论地基（用户四点 → 工程映射）

| 论点 | 工程落点 |
|---|---|
| 智力够，缺"记忆生理" | 三层：上下文层（工作记忆，模型自由修改）/ 笔记层（海马体，文件）/ 记忆层（皮层，单文件） |
| 高频闭环 > 开环一次性 | stem 已有节律器官（快递员/倒计时/信箱）；brain 把"感知"从塞满上下文换成**实时总结 + 文档化外挂 + 工具读环境**——本方案主线即这两者的权衡 |
| 有损压缩 + 睡眠归纳 | 压缩必损 → 毒性靠 provenance + 每拍全量重写 + 过时声明对冲（§5） |
| 自进化不人工调参 | **权衡即基因**：精准↔印象谱 = `custom.mem` 数值位；策略代码本身 = 系统信任级不动（原 D7 延续） |

## 1. 三层生理形状（上下文层 = 模型可自由修改的活页）

```
L0 上下文层（每拍 assemble 现拼，全派生；模型经既有工具可自由修改）
   = <memory>    LTM 文件头注入（按预算截断，恒附过时声明句）
   + <notes>     笔记层目录条（每篇一行"主题 —— 首句摘要"）
   + <watermark> 水位条（仅高水位出现：已用 X/Y tokens、笔记 N 篇，可整理）
   + 精准区       最近 recentFloor 轮原文（valid 消息，天然滚动）
   + 本轮信件     （永远在场）
L1 笔记层 = .stem/mem/<agentId>/notes/<主题>.md   —— 短期记忆/操作文档
   写入方：① 模型主动（主通道）——既有 fs/write 工具写笔记，再
     context_remove 被整理的原消息；两枚都是现役工具，零新增件
     （memory_note 专用工具不做——机制大于判断）
   ② compact 卸载（策略保底）——摘要 worker 输出从"一条 summary 消息"
     变为"按主题分篇落文件 + 上下文内一行指针"，原消息 markInvalid 照旧
   ③ 睡眠拍副产品（整理时发现值得成篇的细节）
   读取方：模型按注入目录条按图索骥——有 fs 工具的类直接 read（路径权限
   天然）；无 fs 的类由策略在追问时代读打包（v2 候补）
L2 记忆层 = .stem/mem/<agentId>/MEMORY.md          —— 长期单一记忆文件
   唯一写入者 = 睡眠拍（全量重写，覆写即纠错）；人可手改（文件即真相）；
   每次睡眠留 DB 一行 tag='memory' 审计消息（不承载注入）
```

**误删兜底论证（"敢把上下文层交给模型"的支点）**：`context_remove` = markInvalid——语料归档永不删、策略 `list()` 全含、**睡眠输入恒含被剔除消息**。模型的主动行为只裁 L0，L1/L2 一字不丢；误删的代价是"重读一次语料/笔记"的痛感，不是永久失忆。裁决权与无损性分离：**哪些细节用完了 = 模型的实时判断（它最清楚）；信息永不再丢 = 机制的结构性保证**。权衡因此不需要模型赌对——赌错可恢复，赌对省 token。

**存储裁决**：记忆住文件不住消息带（推翻 ltm-stm-mix 的 tag 带案）——人可审、git 化即记忆史、覆写即纠错、与语料归档解耦；实测背书：模型对"文件=真相"母语级适应（skill/回读/跨重启一次上手），对静默注入的 note 不调起（playbook §2.1）。目录名 `mem` 不用 `tmp`（tmp=可弃，记忆=资产）。

## 2. 三通道分工（classic 全保留为保底）

| 通道 | 主体 | 触发 | 定位 |
|---|---|---|---|
| **主动整理** | 模型（write 笔记 + context_remove 原件的组合） | `<watermark>` 水位条（仅高水位注入）+ 宿主类 systemPrompt 第二环句："水位提示出现时，把不再高频的细节写成主题笔记，再剔除原件" | 主通道：低频、高判断质量 |
| **被动卸载** | 策略 compact（分篇笔记+指针） | threshold（与 classic 同源参数） | 保底：模型懒惰照样转；退路 = classic 现状行为 |
| **睡眠归纳** | memorist 子实例（§3） | everyMs ∧ 轮闭合 ∧ 饥饿 | 离线：L2 唯一写入者，兼 L0 误删的回收站 |

水位条是给模型的**触发条件**而非能力清单（playbook 实测：模型不调起描述性 note，"计数+条件"式约束全中）；低水位零输出不扰民。

## 3. 睡眠规格（一拍一次生死）

```
前置  ：StrategyApi 扩 schedule(name, fn, everyMs)——同名幂等/异常吞并落
        log/宿主 detach·terminate 联动取消/不入库重启自排（TimerFactory 已在
        ContextManager 手中，零新端口；此薄件 = 原 S5.3 设计，实施编 S7.1）
触发  ：timer 到点 ∧ 轮闭合（Runtime activeTurns 无本 agent 在途——P6 产物）
        ∧ 饥饿达标（水位线后新内容 ≥ hunger tokens）
水位线：MEMORY.md 头注 <!-- slept@<at> --> 即状态，零新存储
打包  ：策略读 [MEMORY.md 现文 + 新/变笔记篇目 + 水位线后 episode 片段
        (截断，含 invalid——模型主动剔除的原件也是记忆原料)] 一份纯文本 userPrompt
工人  ：role memorist-<agentId> 子实例——父=宿主（族谱诚实）；tools 字面 {}
        零工具（输入输出纯文本契约，同 summarize worker 先例；fs/bash 一律
        不给——无人值守写盘通道 = 红线）；model = custom.mem.consolidateModel
        基因位（缺省 inherit，起步配小模型）
产出  ：新 MEMORY.md 全文 → 策略写盘 → 工人 terminate 归档（不留常驻睡眠工）
留痕  ：DB append tag='memory' 一行 + 审计事件 context.memorized{agentId,
        inTokens, outTokens, bytes}（token 账目走既有差分归位，睡眠成本可观测）
```

MEMORY.md 格式规范（毒性对策内嵌）：分区 =「身份与任务 / 进行中的承诺 / 事实与环境 / 教训」；每条带 `←t<turn>` provenance；头部恒附"以下可能过时，关键决策回语料/文件核实"。

## 4. 权衡旋钮（brain-simu ↔ 全保留 = 同一基因面的滑位）

```
custom.mem = { ltmShare: 0.10, notesShare: 0.05, watermark: 0.60,
               recentFloor: 6, hunger: 2000, everyMs: 600000,
               sleepCap: 48, consolidateModel? }
```

比例 × window 预算分配（LTM 超份额截断、目录条恒一行/篇）；`recentFloor→∞ 且 ltmShare→0` 退化为 classic，`recentFloor→0` 即**纯 brain-simu**（极端印象化，全靠指针+工具）——用户方案的两个变体是同一策略上的谱，不做两个策略。`watermark` = 主动整理通道的开关位；`sleepCap` = 每日睡眠硬顶（原"进化熔断"开放点在此落位）。基因经 StrategyApi 读宿主类 custom（归属类配置，D11 不变）。

## 5. 风险与治理（括号内为实测证据）

| 风险 | 对策（全部在机制内） |
|---|---|
| 有损压缩毒性：错误固化进 LTM 反复注入（P5：模型把一次工具失败当永久事实写进总结链式误判） | provenance `←t<turn>` 可回查；睡眠**全量重写**（旧错被下拍稀释不追加）；注入头恒附过时声明句 |
| 注入物不被调起（实测：note 零反应 vs 点名格式全中） | `<memory>/<notes>/<watermark>` 显式块+条件句；宿主类 systemPrompt 配第二环句（playbook §2.1 现成文案） |
| 模型滥删、把有用细节裁掉（判断权下放固有代价） | 误删兜底论证（§1）使代价=痛感非失忆；水位条仅高水位出现（平时无滥删机会）；context_export 全量语料可回溯 |
| 睡眠与在途轮竞态 | 触发恒在轮闭合后（activeTurns）；水位线幂等；睡眠期新消息进 L1 等下拍 |
| 成本失控 | 饥饿才睡 + consolidateModel 小模型位 + sleepCap 硬顶；worker 账目差分归位已可观测 |
| "读笔记"挤占步数预算（乱走吃光 maxSteps 实证） | 目录条给"何时读"条件不给能力清单；**前置依赖：playbook §3 步数预算告知改进** |
| 无人值守写盘面 | 睡眠工零工具；只写 `.stem/mem/`；策略文件/类文件与睡眠绝缘（**记忆≠基因，两层不交叉**）；`.stem/mem/` 建议入 git = 记忆史可审可回滚 |

## 6. 批次与验收

| 批 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| S7.1 | `schedule` 薄调度（含 detach 取消/异常兜底/重启自排） | — | timer 无泄漏/异常不逃逸/重启重排 单测 |
| S7.2 | `.stem/mem/` 文件协议 + compact 升级（分篇+指针）+ L0 组装（memory/notes/watermark 注入） | 可与 S7.1 并行 | 离线双档改造：高水位触发水位条→模拟模型 write+context_remove 落篇/置 invalid→睡眠打包含 invalid 验证→重启后目录条复现；classic 用户零影响（策略按类注册隔离） |
| S7.3 | memorist 睡眠拍 + 审计事件 + `custom.mem` 全基因位 | S7.1+S7.2 | 离线：mock 输出→MEMORY.md 重写→下拍注入可见；在线：第 30 轮仍答对第 3 轮事实（记忆保持 needle 文件化变体），对照 classic 同任务成本/质量 |

**明确不做**：memory_note 专用工具（主动整理 = write+context_remove 组合承载）；策略代码自进化（系统信任级，D7）；常驻睡眠工；`.stem/tmp` 命名；唤醒全量 LLM 心跳轮（原开放点 #2 裁决不变：先只做 worker 级整理）。

## 7. 否决记录（防翻案，含前案）

①删 courier 改 kernel 收发缓冲 / ②注 `<tick/>` 信 + process 契约分支 / ③kernel tick 开关——三案皆"kernel 长业务"（铁律：调度权归策略，策略醒来直接操作记忆，不经信件链路、不经 kernel 编排）。④LTM 住消息带（ltm-stm-mix 原案）——被文件化案取代（§1 存储裁决）。⑤睡眠工给 fs 工具（读笔记自取）——输入由策略打包，零工具纯契约（§3 红线）。⑥每次睡眠写心跳行——纯 IO 噪声，只落"确实改了记忆"的 context.memorized。
