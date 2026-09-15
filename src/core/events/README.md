# events —— 统一事件流（PilotEvent + EventHub）

> 模块自述：实现细节见本文件。

## 职责

- `PilotEvent` 四元：`stream`（LLM 流式事件）/`letter`（来信）/`status`（状态变化）/`tool`（工具触发，只带名字/相位，详情走 DB）。
- `DefaultEventHub`：多订阅者发布/订阅（外部 shell/GUI 订阅面）。

## 文件

| 文件 | 内容 |
|---|---|
| `types.ts` | `PilotEvent` 判别联合 |
| `EventHub.ts` | `EventHub` 接口 + `DefaultEventHub` |

## 纪律

- 事件是**观察面**，不承载控制流；tool 事件刻意不带 args/result（避免泄漏与膨胀）。
- 订阅返回 unsubscribe。

## 依赖

叶子。
