# pilot —— 根（user#0）扮演接口（出口）

> 模块自述：实现细节见本文件；根接线见 `docs/architecture.md`。

## 职责

- 外部（shell/webui）与自治系统交互的**唯一出口**：扮演根（user 类普通实例，id `0`）。
- 扮演层：发消息/实例化/终止/中断/回复访问申请/上下文动作。
- 观察层：列表/详情/活跃/上下文概览/导出。
- 事件订阅：`subscribe(PilotEvent)`。

## 门面化（D4）

`Pilot` **只依赖 `SystemFacade` 接口**（kernel 声明），不依赖具体 `Kernel`；实现由组合根 `main/systemFacade.ts` 注入。`createPilot` 负责根幂等（首启注册 / 重启对齐称呼）。

## 文件

| 文件 | 内容 |
|---|---|
| `Pilot.ts` | `Pilot` 接口 + `DefaultPilot` + `PilotOptions { facade, identity? }` + `createPilot` |
| `index.ts` | 唯一出口 |

## 依赖

`SystemFacade`（kernel 类型）、`tools`（ToolAccess/AccessReplyInput）、`gateway`（ModelRef）、`events`（PilotEvent）。**不依赖 main / 具体 Kernel**。
