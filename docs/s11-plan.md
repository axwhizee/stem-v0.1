# S11 终案（残工卷）：法则收敛——cortex 适配 + feishu 会话

> **性质**：plan 卷——执行依据，落地即随批退役（contributor §1.1）。
> **已完成并落地**：工具模型批（出生声明+单操作收敛链+boot 律，`5fc155d`）与身份代数批（路径 id + 全局 name + 带时戳信件 + 存储 v3，见 log2 记账）。实现事实以代码 + `docs/architecture.md` + `docs/log2.md` 为准，本卷不再回述。
> **本卷只承载**：尚未开工的 c（cortex）/ d（feishu）两批的终案设计、其依赖的已落地接口事实、对拍尾账。
> **实况锚**：architecture.md §2.2b（cortex）与 §五（feishu）节仍是"卷在码前"（落地后删窗口声明）。冲突裁决链：本卷 → 裁决记录 → 对拍回写卷并 log2 记账。

## 0. 残工元律（本轮减法方法论）

- 三判据：**等价清单**（§5，被杀机制逐条指名新家，列不出 = 不能杀）、**定律可审判**（§4 审计测试进 CI）、**不对称账**（删错比加错贵；没有测试的行为 ≠ 不存在的机制）。
- **零历史兼容**（v1.x 开发期特权）：schema/配置形制不对 = 拒载硬错，重建即正义。
- 终局判据：源码不存在不属于任何定律的分支。

**裁决记录（c/d 相关摘录，防翻案）**：
1. 策略注册工具出生恒 `ignore`；抬上台面走**策略声明清单**；"策略与类配置矛盾 = 实例化拒绝"（复用收敛检查，零专门判断）；
2. 不防 ignore 幻觉盲调（法则自洽优先于臆测防御）；
3. bash 可直改 `.stem/mem/` 笔记文件（文件层 = 人机共读），记忆组 ltm/stm 有 DB 墙；`.memory.json` 是单向镜像（文档写明勿手改投影）；
4. 读 aloud 保留发件人戳（信件忠于原文；出口美化留给未来的多用户决策）；
5. dream worker 更名 **dreamer**（术语全链：文档/事件文案/日志/类名 `cortex-dream→cortex-dreamer`）；
6. 机制实例同规（dreamer 等不造第二等公民：普通 spawn、普通 name、普通权限收敛）。

## 1. S11-c：cortex 适配——策略 = 纯既有接口组合的完成时

1. **`cortex_set_ltm/set_stm` 与全局梦 token 暂存/分流机制整体退役**（等价清单 §5）；
2. **dreamer**（原 dream worker/cortex-dream）：spawn 走标准通道（contextRefs 全景重放、清单收敛到无工具或最小），它的正职是**说**——输出 = **回信**（通信 = 消息交换的第一性回归）；策略侧 parse + schema 校验：不合 → `sendMessage` 回信指出错处令其再改（worker 生命周期内循环）；双份齐 → 策略 runDream 收口段执行轮替（旧组 markInvalid / 新组 append / 镜像 / `context.dreamed` 事件——原子性本就住在这里，载体换回信）；
3. **笔记工具**（add/del_note）：出生移策略注册面（ignore），启用 cortex 的类经**策略声明清单**抬 allow——"全树白拿"退役；非 cortex 类不再持有；
4. 类文件（cortex-pet 等）手写的策略配套 tools 面随声明清单自动化而精简；水位线/阈值点火/教学样板组装/镜像四机制不动；
5. 契约增量总计：**一个字段**（`ContextStrategyModule.tools?: Record<string, ToolAccess>`）。

**c 批审计测试**（定律的 CI 形态）：
- 假策略（纯接口实现，非 cortex）走通"注册 ignore 出生 → 声明清单抬 allow → 被祖先锁拒造"全链；
- dreamer 回信循环：坏 schema 回信 → 策略错误回信 → 修正回信 → 轮替落定；半途夭折 = 水位不动下拍重触发（旧断言迁移）。

**c 批门槛**：typecheck 0 + `npm test` 全绿 + 离线双档 + **cortex 在线复跑**（v10-live 场景 5，space-v12 重建后 phase=warm|probe|dream|pause）。

## 2. S11-d：feishu shell——CLI 式显式会话 + 上下线 + 补偿

1. 秘书中转降级为可选项，会话模型改显式：`/new <class> [任务]`（实例化并设为当前目标）、`/use <name|id>`（切换；直接吃 B3 三形态解析）、`/exit`（解绑）、`/agents`（选人面板）；每会话当前目标持久化进 `feishu.jsonc`；
2. **上下线主动提示**：连接就绪时通知 owner"上线"、SIGTERM 优雅发"离线"；
3. **断线消息补偿**（与 2 配套成必需品）：重连后 `im.v1.message.list` 按 chat 增量拉取 + message_id 去重（router 现有 LRU 复用）；
4. 审批卡/命令面适配新寻址（呈现 `name#id` 已就位；按钮 value 仍存精确 id）。

**d 批门槛**：router 单测覆盖命令面/解析/补偿去重 + 真机冒烟。

## 3. 接口事实账（a/b 已落地——c/d 照此对拍）

- **收敛链**：`tools/access.ts: foldConvergenceSteps(parentExplicit, caps, steps)` 单一代数（steps=`[层名, 清单][]`，封顶 = min(父面显式, 出生值)；物化端静默钳制、写入端拒绝带层归因）。`Kernel.labeledSteps(steps, firstLabel)` **三步形 `[类, 策略, 实例]` 槽位已就位**——c 批传入 `strategy.tools` 即接通；`accessStepsOf` 现仅两步（类, 实例 override），c 在策略在场时插中间位，attach/replay/拒绝三面同步。
- **策略注册窄口**：`registerTool` 出生恒 ignore（cortex 笔记工具出生迁移即改注册点 birth 字段）。
- **spawn 通道**：`spawnRoleAgent/spawnStrategyWorker` 走标准 `instantiateInSpace`（grant 模式 + name 缺省派生）——dreamer 无特判可用现口；worker 回收 `terminateWorker`（自动落墓碑，地址不复用）。
- **寻址/呈现**：`kernel.resolveAgent(ref)` 三形态（`name#id`→精确 id→唯一前缀→name；歧义抛 `agent_ref_ambiguous` 带候选）、`kernel.displayOf(id)` 全名、`ROOT_ID='0'`/`ROOT_NAME='user'`、`formatFull(name,id)`；错误 `agent_name_conflict` 三级执法（出生/改名/装载）。
- **信件戳**：`context/stamp.ts`（`stampSender/formatStampAt/hasSenderStamp`）；打戳唯一在 ContextManager.applyStamps（`identityOf` 注入端口）——策略/工具侧禁手写伪 sender 行，dreamer 回信走普通 `sendMessage`。
- **持久**：`InstanceStore.delete` = 宿主法医专属（terminate 自动 `upsert(status:'terminated')` 墓碑）；schema v3 拒载硬错（cortex 无迁移负担，但 c 批若动 `.stem/mem/` 镜像形制需同步拒载意识）；`AgentStatus` 含 `'terminated'`，活体面（list/get/族谱）永不可见。
- **config**：`extensions.tools = {名:权限词}` 点名制；`user.name` 出生称呼（缺省 'user'）；推荐实值住 defaults.ts 模板；工具工厂入口形态保留。
- **boot 律执行位**：system.ts createStemSystem（家学 model → access_reply 审判 → tool_unresolvable）。

## 4. 尾账（随批执行的文档/清扫义务）

- **c 批随行**：architecture §2.2b cortex 节对拍回写 + 窗口声明**终删**（§2.1/2.2b/三/4.6/4.12/4.15/五 中 c 所及者）；dev-guide 策略契约表（`tools` 字段）与 cortex 食谱；api.md（ContextStrategyModule 行 + 注销 cortex_set_*）；README/AGENTS cortex 行与进化闭环行；space-v12 cortex-pet.md 类文件精简；`cortex-dream→cortex-dreamer` 与 "dream worker"→dreamer 全链改名（含事件文案）；log2 记账。
- **d 批随行**：architecture §五 + shell/feishu/README §2.1（显式会话模型）；feishu.jsonc 形制扩展的 defaults 与 parse；log2 记账。
- **死代码巡检站（非阻塞穿插）**：context / extension / shell 三站（kernel/lineage/tools 已毕）。
- **验收**：v10-live 全场景复跑留档 space-v12；场景 4 自进化按前裁决不追新。
