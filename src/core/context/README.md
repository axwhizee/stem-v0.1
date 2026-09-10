# context —— 重建邮局（仓库 / 管理员 / 快递员 / 策略 / 记忆）

> 模块自述：实现细节见本文件；架构定位见 `docs/architecture.md`。

## 职责

「无总线」通信模型：一切消息进入仓库，由管理员处理/组装，快递员定时投递。

- **Repository**：上下文本体唯一存储（内存 + write-through 装饰器）；`markInvalid`/`updateMessage` 支持可逆删除与改写。
- **ContextManager**：处理（打戳/策略 process/组装 legalize/waitForReply）+ 生命周期 `register`/`realign`/`unregister`；策略动作 `runStrategyAction`。
- **Courier**：倒计时送信，只发不组装。
- **策略**：`classic`（直出 + compact，markInvalid 可逆）/ `cortex`（三层记忆 LTM/笔记/STM + 阈值做梦二段事务）/ `none`（面板态）。契约 `note/role/tools/assemble/process/actions/init`。

## 文件

| 文件 | 内容 |
|---|---|
| `Repository.ts` / `persisted.ts` / `store.ts` | 仓库 + 持久化装饰器/端口 |
| `ContextManager.ts` | 管理员 |
| `Courier.ts` | 快递员 |
| `stamp.ts` | 信件戳 `<sender id="name#id" at="yymmdd.hhmm">` |
| `legalize.ts` | 消息序列合法化（网关发送前必经） |
| `strategies/` | `classic` / `cortex/` / `none` + registry |

## 关键语义

- **tag 六元词表 + turn/indexInTurn 双索引**；tokens = 网关真实值差分归位、chars/4 兜底。
- 触发 = user_prompt 抵达；终点 = 唤醒快递员。
- 一空间一库一进程；重启 = 装载 + 归一化 + replay + 零重放。
- `.stem/context/*.ts` 可覆盖内置策略（用户主权）。

## 依赖

`gateway`、`logging`、`tools`（access 代数）。
