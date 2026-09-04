# cortex 记忆策略 · 最终方案（R2 定稿 2026-09-03）

> **性质**：plan 卷——实施期执行依据，实施开始后不回改；落地即随下一功能批退役（contributor §1.1）。
> **沿革**：R0 brain-plan（文件三层+timer 睡眠）→ R1 cortex-plan（阈值激活+去 MEMORY.md）→ **R2 本版**（用户终裁：三层记忆=LTM/笔记/STM 重划分；记忆组=锚点+三对工具调用；dream 事务二段式；agent 获得笔记工具但无尺寸义务；无硬性预算——提示词指导）。理论校准证据 = v1.0 验收约 60 真实模型轮（docs/log.md 2026-09-02 阶段）。
> **一句话**：classic 是急救室，cortex 是睡眠生理——上下文是**专注度资源**（1M 窗模型自愿只用 256k），醒着看三件套+新信，做梦看全景。

## 1. 记忆架构

| 层 | 形式 | 载体（唯一真相） | 写者 | 内容 |
|---|---|---|---|---|
| **LTM 长期记忆** | JSON | 仓库 tool 行（tag='ltm'）+ `.stem/mem/<agentId>/.memory.json` **单向镜像**（及时更新，永不回灌——灾难恢复时人工回灌通道） | dream 经 cortex_set_ltm（策略落盘+轮替） | 身份/环境事实/教训/进行承诺（跨任务固化） |
| **笔记层** | Markdown | 文件 `.stem/mem/<agentId>/<主题>.md`（文件名即主题） | **agent 与 dream 均可**（cortex_add_note/del_note，agent 也可裸 write）；目录代理 = 仓库 tool 行（tag='note'，策略从磁盘巡检重建） | 领域特化知识、值得脱离上下文的内容 |
| **STM 短期记忆** | Markdown | 仓库 tool 行（tag='stm'），无文件（任务态随梦全替，无外部读者） | dream 经 cortex_set_stm | 当前工作状态：进展/未兑现承诺/眼前事实（"醒着的我刚才在干嘛"） |

**误删兜底不变**：一切"删除"= markInvalid（归档永不删、dream 打包恒含 invalid、context_export 可回溯）——裁错了是痛感不是失忆。

## 2. 组装格式（记忆组 = 教学样板）

```
system（类 systemPrompt）
user  tag='cortex'  【锚点】策略自写的常驻介绍（组创建时一次写，不轮替）：
      介绍 cortex 三层记忆与操作面——"以下三组工具结果是你的记忆；
      你可以 cortex_add_note 记笔记、context_remove 裁用完的对话轮、
      context_apply dream 提前做梦；上下文尺寸由 dream 负责，不必自己盯。"
      ★假想调用即为 agent 打样：读有 load 族、写有 add/del 族、裁有 context 族
assistant tool_calls=[cortex_load_ltm{}, cortex_load_notes{}, cortex_load_stm{}]
                    content=一句承接（"正在载入你的记忆…"——更像真实工作流）
tool    tag='ltm'   <LTM JSON>
tool    tag='note'  <目录：每篇一行 主题——首句摘要>
tool    tag='stm'   <STM markdown>
（随后 = 醒来后的新信件，正常轮序；首次做梦前 = userPrompt 首信 + 实时轮，无记忆组）
```

- `cortex_load_*` 是**合成消息里的虚拟函数名**（gateway 不校验注册，materialize 清单不含——agent 幻觉点名 = unknown 无害）；真实注册工具只有 set/add/del 四枚（§4）。
- 记忆组轮替 = 每梦一组四行（assistant+tool×3）append + 旧组 markInvalid（锚点不轮替）；**invalid 轮替链 = 记忆演变史**（dashboard 直查）。
- 轮替是事务：仅当 LTM 与 STM 双更落定才执行（半途而废 = 不轮替、水位线不动、下拍重触发）。
- legalize 兼容：assistant/tool 成对相邻 ✓；卸载选集恒排除 tag∈{cortex,ltm,note,stm}（dream 造的空间不被其他清理误伤）。

## 3. dream（工作子实例，"做梦"）

```
触发  ：process（user_prompt 信抵达）首行判定 estimatedTokens ≥ dreamAt ∧ 不在途
        ——异步唤醒器：spawn 后立即返回就绪，本轮送信照常，新组下拍生效。
        梦成即 markInvalid 全部实时轮 → estimatedTokens 瞬降回三件套水位——
        dreamAt 天然兼作重启线与频控（无 minDelta/无 ceiling/无 timer：一个数字三职责）。
打包  ：[现行 LTM+STM+目录 + 水位线后全部轮（含 invalid 与模型自裁的）
        + 有变化的笔记正文全文] → 首信（无硬性预算截断——1M 窗模型；
        大致预算以提示词文本指导：LTM 精简到核心、STM 保进度、每笔记 ≤ 摘要级引用）
二段式（顺序即依赖）：
        ① 对话+笔记+旧 LTM → cortex_set_ltm(JSON)
        ② 对话+旧 STM      → cortex_set_stm(markdown)
        期间可 cortex_add_note/cortex_del_note（把该出上下文的东西做成外挂笔记）
出生  ：role 类名 'dream'（父=宿主；contextStrategy 'none' 断递归；
        model = custom.cortex.consolidateModel 缺省 inherit）
        grant 表 {cortex_set_ltm, cortex_set_stm, cortex_add_note, cortex_del_note}
        全 allow，其余一律 deny（受限 grant：逐键封顶现成；根表不列这些键
        → 对全世界天然 deny，白拿隔离）
事务  ：双 set 落定 = 策略执行轮替（§2）+ .memory.json 镜像及时更新 + 水位线推进
生命  ：一拍一生死——完成后策略 terminate 归档；失败 = 下拍重触发（在途保护防叠波）
手动  ：actions.dream（context_apply 模型侧 / pilot.runContextAction 与 CLI /dream
        用户侧——按钮通道现成，提前做梦应急/收尾固化）
```

## 4. 面向主 agent 的记忆操作面（主权常开，义务没有）

- **cortex_add_note / cortex_del_note 进 DEFAULT_USER_TOOLS = allow**（继承形 agent 白拿；非 cortex 类 agent 也可用——目录按 caller agentId 就地建，值在 cortex 类才兑现）。
- context 操作工具维持根表 allow（remove/edit/export/overview 现状即然）——锚点文本明示主权："随时可整理自己的上下文"；尺寸义务归 dream。
- agent 裸 `write` 到 `.stem/mem/<id>/` 的笔记文件同样有效：process 巡检 diff 磁盘，**目录真变化才轮转目录对**（防语料 churn）。
- LTM/STM 的 set 工具不给 agent（记忆固化 = dream 专属事务，防半途态）。

## 5. 契约改动（全部新增件，零改他人）

1. `ContextStrategyModule.init?(ctx)`——装载期先于工具 initAll；ctx = `{fs, projectRoot, log, registerTool(窄口)}`；cortex 的 init：建 `.stem/mem/` + 注册 4 工具（kind=custom，同策略信任级）+ 校验 `dreamAt ≤ window×0.9`（不满足 warn+clamp）。
2. `AssembleInput.estimatedTokens: number`（一行字段，触发判断/水位感知原料）。
3. 事件 `context.dreamed{agentId, at, notesTouched, invalidRows}` + Logger/遥测 case 各一行。
4. compact 边界三条纪律（R1 已裁，继续有效）：compact 是 classic 私有 action；两策略共用 summarize worker 基础设施但组合私有；参数分家（`config.context.compact`=classic，`custom.cortex`=cortex）。

## 6. 基因配置（无硬预算版）

```
custom.cortex = {
  dreamAt: 262_144,        // 专注度线（绝对估算 tokens；256k/320k 两档自愿收紧；
                           //   config.context.window 填模型真实窗，线留余量）
  consolidateModel?        // dream 模型基因位（缺省 inherit；建议同档大窗或次档）
}
```
仅此两件。总结预算 = dream 提示词模板内文本指导（随实测调，不做假配置项）；STM/LTM 无截断手术刀——养肥自然触线再梦，线兼作最后防线。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 有损毒性（错误进 LTM 反复注入——P5 误读链实证） | LTM schema 每条带 `←t<轮>` provenance；每梦全量重写不追加（旧错稀释）；锚点与注入文首恒附"记忆可能过时，关键决策回语料/笔记核实" |
| 注入物不被调起（note 实测零反应 vs 点名格式全中） | 教学样板设计（§2：锚点+拟真调用=用模型母语展示机制）；操作指引全走条件句 |
| 双 set 半程态（只更新了 LTM 没更新 STM） | 事务判据 = 双更齐才轮替；半途 = 水位线不动下拍重来 |
| 目录 churn / 文件与目录漂移 | 巡检 diff 仅变化才轮转；文件=正文真相，目录=可再生代理（有行无文件→跳过并失效） |
| 首次做梦前的大上下文 | userPrompt 首信+实时轮直送（classic 式但窗充裕：1M 模型 256k 线，天然不险） |
| 虚拟工具名被 agent 幻觉调用 | 未注册 = unknown tool 报错，软文本回模型，无害 |
| dream 成本 | 每梦 = 1 次 worker 轮（全量打包）；频率上限 = 每积累 dreamAt tokens 一次；context.dreamed 账目可观测（usage 差分归位现成） |

## 8. 批次与验收

| 批 | 内容 | 验收锚 |
|---|---|---|
| S8.1 | 契约三件（init+registerTool / estimatedTokens / context.dreamed）+ 4 工具注册与 deny 隔离面（根表不列=全树不可执行、grant 表放行、非 cortex agent 用 add_note 建目录） | 契约单测 + 权限矩阵 |
| S8.2 | 组装器（锚点/三对轮次/虚拟名）+ 巡检（diff 轮转目录对）+ process 唤醒 + actions.dream + CLI `/dream` 一行 | 离线双档改造：FakeGateway 全流程（组注入→轮替→重启复现→legalize 合法→classic 零影响） |
| S8.3 | dream 事务（双 set→轮替→镜像→水位线）+ 打包 + 在途保护 + 失败重触发 | 离线：半途而废不轮替锚；在线（真网关，space-v10 类挂 cortex）：长任务 40+ 轮跨两次梦——**梦后上下文无实时轮仍答对早期事实**（needle 变体），对照 classic 成本/质量；`.memory.json` 镜像一致性 |
| 明确不做 | 硬性总结预算、空闲 timer 睡眠、记忆回灌、STM 文件化、agent 侧 set 工具、多 agent 共享记忆（族谱隔离：各管各的 `.stem/mem/<id>/`） | |

## 9. 否决记录（累积防翻案）

①删 courier/tick 信/kernel 开关（历史三连）；②MEMORY.md 独立文件层（R1：仓库即真相；本版兑现为镜像单向）；③整理者零工具纯文本契约（R1：schema 合同取代）；④工具缺省 ignore（=隐藏可执行，误用；根表不列天然 deny）；⑤timer 睡眠节律（R1：阈值激活）；⑥同步等待整理（R1：异步不拦信）；⑦userPrompt 首信充当锚点（R2 用户裁：首信无代表性——策略自写介绍行）；⑧note 作为独立仓库行（R1）→ 目录对代理化（R2：正文在文件、目录在记忆组）；⑨recentFloor 保留实时轮（R2：梦后零保留——STM 取代实时区，这才是 brain-simu 的兑现）；⑩minDelta/ceiling/watermark 多闸（R2：轮替自带瞬降，一个 dreamAt 三职责）；⑪硬性记忆预算截断（R2：提示词指导，假配置项不做）。

## 10. 续做锚（上下文压缩后的开工须知——本节与 §1-§9 同为准绳）

**已入代码的裁决 = 不可再议的地板**：权限总序、受限 grant（逐键封顶）、`agent_update` 唯一实例写面、ask 在途 deny 复核、`test:feas` 守卫（rc>1=skip）——落码于 `2a060ef`/`c5de891`，四卷文档已对拍一致。dream 的一切权限形态建立在它们之上。

**开工时的一处事实修正**：§5.2（AssembleInput + estimatedTokens）**取消**——StoredMessage 行自带 `tokens` 字段（真实值差分归位/估算兜底同源），策略 assemble 内 sum valid 行即得水位，无需契约新字段。§5 契约新增件实为两件：策略 `init?` + `context.dreamed` 事件。

**S8.1 起步精确指路（均已核实）**：
- 契约与注册：`src/core/context/strategies/types.ts`（+`init?(ctx)`）；registry 注册口 = `ToolCapabilityRegistry.register(tool, opts?)`（异步）；`DEFAULT_USER_TOOLS` 在 `src/core/kernel/userClass.ts`（+两键 allow）。
- init 调用位：组合根 `src/core/init/system.ts`——**L176 附近 `tools.initAll` 之前**逐策略执行 init（ctx 携带 fs/projectRoot/log/registerTool 窄口闭包）。
- 事件线三处同 `context.compacted` 形状：`logging/events.ts`（interface+union）、`logging/Logger.ts`（格式化 case + eventInvolvesAgent 归组）、`kernel/systemTools.ts`（telemetryBrief case）。
- 四工具落 `strategies/cortex/` 新目录（入口仿 classic.ts + index 出口）；per-agent 运行态 = 策略模块内 Map（dream 双 set 暂存、在途位、水位线、目录缓存）；add_note 的 name 校验 `^[a-z0-9][a-z0-9-]{0,40}$` 且保留字 `memory`（撞 `.memory.json`）。
- 测试参照系：`strategies/classic.test.ts`（策略测试形状）、`test/support/kernelHarness`（fake 注入）。

**操作纪律（本会话血泪，全生效）**：
- 每条 bash 前置 `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`（忘带 = Windows npx GBK 乱码）；起服务 `timeout 60 bash test/feasibility/tools/up.sh [webui|dashboard]`（幂等）。
- **写文件一律用 Write/Edit 工具——不用 `&&` 长链夹 heredoc**（cdb9290 事故：git rm 因 staged 拒绝、链上半段静默未执行、commit 照跑留下空壳卷；修复靠跟进笔）。git rm 前先 `git status` 查 staged。
- 基线 = typecheck 0 + `npm test` **323/323** + 离线双档 29/9；每批过线才 commit（`git -c user.name="OwlCat" -c user.email="owlcat@local"`，message 无进度代号）。
- drvfs 偶发 NotFound = 重试；在线验收需密钥（注入法 contributor §8，opencode 网关走 OPENCODE_API_KEY，space-v10 有 provider 配置）。

**悬点（开工时问用户或顺路核，勿擅动）**：
- `.gitignore` 有用户手改 +2 行未提交——S8.2 笔记文件持久化语义定稿时一并问明（若为 `.stem/mem` 豁免规则则对齐采纳）。
- 旧 playbook 卷（已退役，`git show d274f3b:docs/llm-playbook.md` 可取回）的"错误文本行动化/步数告知"等改进未排——是否混入 S8 批次听用户。
- docker 验收（15/16 的唯一开放项）与本事无关，仍等点头。

**提交节奏**：S8.1 → S8.2 → S8.3 各一批 conventional commit；每批按 contributor §1.3 对拍（AGENTS 策略速查行、architecture 2.2b/2.6 tag 词表、api.md 契约面、dev-guide 策略食谱）+ log.md 追加。全部落地即本卷退役（plan 卷纪律）。
