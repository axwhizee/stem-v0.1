# S9 方案 · 挂起面重构 + 类形态统一（定稿 2026-09-04）

> **性质**：plan 卷——实施期执行依据，不回改；落地即随下一功能批退役（contributor §1.1）。
> **沿革**：cortex（S8）落地后的优化轮——用户五提案收敛 + 三悬点终裁。评估记录（含现状取证）在对话与 log。
> **已定裁决**：① maxSteps 默认关（0=无限制新语义）+ 类基因位；② 类形态全统一（`userClass.ts` 整体删除，root 接线归 init/pilot 流程）；③ internal 类汇总 `kernel/builtin/agents.ts`（**不入 lineage、不用 jsonc**——TS loader 只认 .json，lineage 是派生事实域）；④ `context_wait` 工具**整体退役**，等回复融合进 `agent_instantiate`（wait 参数）；⑤ 自主挂起独立成工具（命名 **`agent_pause`**——`hang` 易与 cortex 的"梦/睡眠"混语义，pause 中立且贴"暂停攒信"）。

## 1. S9.1 挂起面（等信与攒信两个正交入口）

**缺陷动机（现状取证）**：`context_wait` 先注册 hold 后才有配对——若子的回信先于父调 wait 到达，它已作为普通信件入库，hold 永无回填，那轮悬空 toolCall 被 legalize 裁掉，父"等了个寂寞"（语义静默丢失）。竞态从时序上根除的唯一办法 = **注册发生在子存在之前**。

- **`agent_instantiate` + `wait?: boolean` + `waitTimeoutMs?: number`**：wait 时 execute 内**先 `registerHold(newId, {ownerId, toolCallId=本次调用})` 再 instantiate**（同一次 execute 内定序，竞态绝迹）；本工具轮以既有 `contextWait` 标记通道不记账（kernel L271 通道保留——两新入口共用），子的回信经 deposit 命中正规回填 tool 行 + notifyReady；`waitTimeoutMs` 超时回填"等待超时（Nms 未收到回复）"文本行并清 hold（不无限悬空）。缺省（不传 wait）行为不变：创建即返回 id，异步协作照旧。
- **新工具 `agent_pause`**（kind=internal，**进 DEFAULT 工具表？否——用户裁决：不列根表，走 internal 缺省 ignore**：对模型隐藏，类清单显式点名才见；user0 面板不跑轮无需求）：参数 `{ms, reason?}`——**无上限 clamp**（用户裁决：数小时挂起合法，实测出问题再说；防孤儿靠 unregister/interrupted 清理兜底）；语义 = 挂到点醒：到点回填"暂停 N ms 结束，期间新信 X 封（见最新组装）"一行 + notifyReady——**期间信件无需新机制**（照常 deposit 进仓库行，醒后一次组装全见=天然累积）。timer 走现有 `TimerFactory` 端口（manualTimers 可测）；box unregister 清挂起 + cancel timer。
- **退役清单**：`context_wait` 工具删除（systemTools 注册表 + 描述面）；根表本来未列它（近死面，零兼容负担）；docs 三卷删行；feas 场景若有用例改走 instantiate.wait；参数校验/竞态回归测试新增（子先回信场景必测）。
- **`context_apply` 描述顺手补 dream 例**（"如 classic 的 compact / cortex 的 dream 手动触发"）。
- **Dream 复用说明（用户问，零实施）**：agent 自行做梦**已接通**——`context_apply({action:"dream"})` 模型侧可达（S8 deliverable），同步跑完整梦（全局梦 token 串行：自动梦在途时返回"已有梦在途"文本），回报串即 tool 结果，下轮组装即新记忆组；cortex note/锚点文本已明示该权利。本卷不动它。

## 2. S9.2 类形态统一（一个形状、一张内置表、一条注册根）

- **`kernel/builtin/agents.ts`**：`export const BUILTIN_AGENT_CLASSES: readonly AgentClass[]` = **user 类默认档**（现 userClass.ts 的 DEFAULT_USER_TOOLS 表 + createUserClass 默认值域整体迁入，注释保真）+ **assistant**（现 `Assistant.json` 退役删除——import json 通道关闭）。**策略自带类不并入**（决策 C：CLASSIC_ROLE/SUMMARIZER/CORTEX_ROLE/DREAM_WORKER 随策略模块住，形状统一后自动够着新字段）。
- **`userClass.ts` 整体删除**（用户终案）：`USER_CLASS_ID` → `kernel/types.ts`（id 之家）；`UserClassConfig` 删除——**config.StemUserClass 直连**（model 已是 ModelRef，类型纯冗余）；`createUserClass` 合并逻辑挪进 **pilot 初始化流程**：`createPilot` 读 `kernel.userClassConfig`（构造透传 config.user + displayName）→ 与内置 user 档 merge → `templates.register` → `registerRootAgent(displayName ?? 'User')`。**config.user 补 `displayName?`** = user0 出生显示名（运行期改名走 agent_update 现成）；类名 'user' 不可配改（族谱/DB/进化禁面身份锚）。
- **`StrategyAgentSpec` 并入 `AgentClass`**：契约里 spec 类型改为 `AgentClass`（`className`≡`name`），`ensureSystemTemplate` 的手写映射函数删除（漂移源根除——"加配置项对所有 agent 生效不需专门添加"的正解）；四枚策略 spec 与调用点形状连动（`spec.name`）。
- **maxSteps 落地**：`AgentClass.maxSteps?` + `Runtime` 解析（轮起点读 template.maxSteps ?? config.maxSteps ?? 0=无限；`steps < max` 仅在 max>0 时判）+ 撞限 notice 行动化（"步数已尽，若需继续请再发一信"入 notice/日志）+ 文档面（README 表已就位）。
- **agentPause 进工具注册表**（systemTools 计数 19→20，README 工具清单同步；agent_instantiate 参数面同步）。

## 3. 批次与验收

| 批 | 内容 | 验收锚 |
|---|---|---|
| S9.1 | wait 融合 + agent_pause + context_wait 退役 + apply 描述补例 | 竞态回归测试（子先回信场景配对成功）；pause 定时器可测（manualTimers）；`agent_update`/树测试零破坏；全量 + 离线双档 |
| S9.2 | agents.ts + userClass.ts 删除 + Spec 并入 + config.user.displayName + maxSteps | 全通道形状统一测试（builtin 表逐条过模板校验）；user0 出生名可配测试；maxSteps=0 无限/类级限/撞限 notice 三例；338 基线连动零破坏 + typecheck 0 |
| 明确不做 | hang 上限 clamp；context_wait 保留兼容；类名 config 可改；策略类并入 builtin 表；maxSteps 进族谱律/agent_update；`lineage/` 放类文件；jsonc 装载 | |

## 4. 否决记录

① context_wait 保留双入口（用户裁：两个作用相近功能不留，wait-only）；② 纯 sleep 定时收集独立于 instantiate 之外"等任意人"（并入 pause 语义——到点醒+攒信）；③ maxSteps 走四级族谱律（它是资源上限非权限，单类基因位+全局兜底即可）；④ 类名可配（id 锚定族谱/DB，改名走 displayName）；⑤ 策略类数据并入 builtin 表（生命周期随策略模块）；⑥ jsonc/lineage 落点（loader 限制/域错位）；⑦ agent_pause 进根表 allow（用户裁：internal 缺省 ignore，点名才见）；⑧ pause 时长 clamp（用户裁：不设限，实测再说）。
