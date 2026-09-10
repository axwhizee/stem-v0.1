# logging —— 结构化日志（LogEvent / Logger / LogSink）

> 模块自述：实现细节见本文件。

## 职责

- `LogEvent`：判别联合的结构化事件（tool.invoked / gateway.apiRequest / kernel.* / context.* / mailbox.* / access.* / init.* …）。
- `Logger`：注入式日志出口；`InMemoryLogger` 运行时内存实现（`all()` 供 telemetry_query）。
- `LogSink`：`{ log(event) }` 最小端口，组合根注入。
- `forget`：吞异常留痕辅助（fire-and-forget 的安全包装），避免孤儿 promise 击落进程。
- **运行时边界（现状）**：唯一实现即内存留档——日志不落 DB、不跨重启，`telemetry_query` 观测域 = 当前进程生命周期；跨重启长程观测若需要则走后续 `LogStore` 端口，1.0 前保持运行时形态。

## 文件

| 文件 | 内容 |
|---|---|
| `events.ts` | `LogEvent` 联合 |
| `Logger.ts` | `Logger`/`LogSink` + `InMemoryLogger` |
| `forget.ts` | `forget(promise, site, onLog)` |

## 依赖

叶子（`ToolAccess` 等不涉及；纯日志）。
