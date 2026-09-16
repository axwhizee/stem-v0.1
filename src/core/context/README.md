# context —— 重建邮局（仓库 / 管理员 / 快递员 / 策略 / 记忆）

> 模块自述：实现细节见本文件；架构定位见 `docs/architecture.md`。

## 职责

一切消息进入仓库，由管理员处理/组装，快递员定时投递。

- **Repository**：上下文本体唯一存储（内存 + write-through 装饰器）；`markInvalid`/`updateMessage` 支持可逆删除与改写。
- **ContextManager**：处理（打戳/策略 process/组装 legalize）+ 生命周期 `register`/`unregister`；策略动作 `runStrategyAction`；统一挂起经 `Waiter`。
- **Courier**：倒计时送信，只发不组装。
- **Waiter**（`wait.ts`）：统一挂起原语（event/timeout/aborted + cancelOwner）；`defaultTimer`/`DEFAULT_SEND_COUNTDOWN_MS` 单点。
- **策略**：`classic`（直出 + compact，markInvalid 可逆）/ `cortex`（三层记忆 LTM/笔记/STM + 阈值做梦二段事务）/ `none`（面板态）。契约 `note/role/tools/assemble/process/actions/init`。

## 文件

| 文件 | 内容 |
|---|---|
| `Repository.ts` / `persisted.ts` / `store.ts` | 仓库 + 持久化装饰器/端口 |
| `ContextManager.ts` | 管理员 |
| `Courier.ts` | 快递员 |
| `wait.ts` | 统一挂起原语（ask/hold/reply/pause 共用） |
| `stamp.ts` | 信件戳写读单源：`stampSender` / `parseStamp` / `stripSenderStamp` / `hasSenderStamp` |
| `legalize.ts` | 消息序列合法化（网关发送前必经） |
| `strategies/` | `classic` / `cortex/` / `none` + registry |

## 策略契约（`ContextStrategyModule`）

- **两段式生命周期**：`process`（异步许可：可摘要/整理、经系统通道造 agent，返回 = 就绪）与 `assemble`（纯函数同步：送信快照）分离——快递员永不异步、只发不组装。`ContextRegistration.contextStrategy` 开辟时确定，未知策略注册期 fail-fast。
- **契约面**：`note`（systemPrompt 追加）/`role`/`tools`（**收敛链 raise 声明清单，只抬不封**，见 architecture 2.2）/`assemble`/`process`/`actions`/`init`。
- `init?(ctx)`：装载期钩子（组合根在工具 `initAll` 之前执行）；`StrategyInitContext = {projectRoot, fs, settings, log, registerTool}`——策略自带工具经窄口注册，**出生恒 ignore**；`.stem/context/` 用户策略 provenance = custom 形。
- `StrategyApi`：`lastWorkerId`/`roleAgentId`/`updateMessage`/`ctxTokens?`（反馈水位）；`spawn(task, spec, opts?)` 回信纠错循环（`opts.validate(reply)` 不合 → role 名义发纠错信再等，缺省 ≤2 轮；**先登记等待者后发信**免竞态，轮尽原样返回末件）。
- **模块扮演 agent（role）**：创建方传 `assemble:false`（不组装/不跑 LLM/收信由策略消费）的懒生成代理，父 = **宿主 agent**（terminate 级联回收）；worker（`summarizer`/`cortex-dreamer`）是**正常组装 agent**（跑 LLM），经邮局正规往返 + `waitForReply` 配对，用完即 terminate。role 面板 / worker `none` 策略 → 天然断套娃；策略失败 catch + 降级照常唤醒。
- **用户策略（`.stem/context/*.ts`）**：init 管线扫描默认导出的 `ContextStrategyModule` 注册进注册表（同名覆盖内置 = 用户主权）。

### classic（急救室，对齐 opencode compact）

完整历史直出 + 逼近窗口阈值时把轮边界之前的旧段交摘要 worker 精炼为一条 `<context_summary>`（tag=`summary`）、旧消息 `markInvalid`（**仓库/DB 语料保留，压缩可逆可审计**）。轮边界压缩 + append-only → 前缀缓存稳定。触发 = user_prompt 抵达（`process`，await 压缩完成再就绪），另导出 `actions.compact`。参数 `config.context.{window,compact}`；compact 是 classic **私有动作**。

### cortex（睡眠生理，纯既有接口组合）

"上下文 = 专注度资源"。三层外挂记忆：**LTM**（JSON，仓库 tool 行 tag=`ltm` + `.stem/mem/<id>/.memory.json` 单向镜像永不回灌）/ **笔记层**（`.stem/mem/<id>/<主题>.md`，agent 与 dreamer 双可写，目录行 tag=`note` 磁盘巡检 in-place 再生）/ **STM**（tag=`stm` 行，无文件）。组装样板：记忆组 = 仓库真实行（锚点 `cortex` + 载体 assistant 虚拟点名 `cortex_load_*` 三枚，不注册）。触发 = `ctxTokens ≥ dreamAt`（反馈账；模块公式 `resolveDreamAt(min(DEFAULT, window×0.003))`）→ 异步点火不等收口。**dreamer（`cortex-dreamer`）** 回信即交付物（`<cortex_dream><ltm>JSON</ltm><stm>markdown</stm></cortex_dream>` 双段报告，schema 校验住 spawn validate）；双份齐 → **runDream 收口段**执行轮替（旧组+快照实时行 markInvalid、新组 append、镜像、`context.dreamed` 事件）——二段事务原子性住这里；半途/轮尽 = 不轮替、水位不动重触发。笔记不经回信：dreamer 调 add/del_note 当场以 host 名义落盘；dreamer 模型走出生链（无 consolidateModel）。`actions.dream` 手动提前做梦。

## 关键语义

- **tag 六元词表**（`''`/`summary`/`cortex`/`ltm`/`note`/`stm`）+ `turn/indexInTurn` 双索引；tokens = 网关真实值差分归位、chars/4 兜底；记忆族 tag 在卸载/清理选择集中恒被排除。
- **触发 = user_prompt 抵达；终点 = 唤醒快递员**；`deposit` 才唤醒、`appendHistory` 不唤醒（防自回复死循环）。
- **挂起等待填充**：`agent_instantiate{wait}` 的**独占消费**住 `ContextManager.holds`（`from` 命中 → tool 结果填充并删除；hold 先于首信注册 = 竞态根除）；**超时自回填**经 `Waiter` 的 `hold:` 键。`waitForReply` = `reply:<from>` 事件；`agent_pause` = 纯倒计时；`cancelOwner` 挂 unregister/terminate。竞态契约见 `hold.test.ts`。
- 一空间一库一进程；重启 = 装载 + 归一化 + replay + 零重放。
- `.stem/context/*.ts` 可覆盖内置策略（用户主权）。

## 持久化

- **端口**：`store.ts` `MessageStore`（upsert/archiveAgent/loadBoxes/maxMessageSeq）；接口与默认内存实现同文件。
- **装饰器**：`persisted.ts` `PersistedRepository`——委托内存实现 + 写穿；`setTokens` 静默修订不触发 onChange。
- **恢复**：消息箱重放反演 push 状态机还原 turn/indexInTurn 计数器 + `setCounterFloor` 防撞。

## 依赖

`gateway`、`logging`、`tools`（access 代数）。
