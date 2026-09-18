# main —— 组合根 + 进程生命周期 + 装载管线 + agent 执行器

> 模块自述：实现细节见本文件；架构定位见 `docs/architecture.md`。
> **core 中唯一 import 一切的模块**；没有任何模块依赖 `main`。

## 职责

- **组合根**：`createStemSystem(deps)` 按 stem 初始化 + 工具 drain 装配最小系统（architecture 2.8）。
- **工具装配**：发现段产出无序清单；drain = `register`+`init` 可追加、完成后冻结。`createInternalToolDefs` 产出 internal 定义，组合根与测试 harness **同一 drain 路径**。Kernel 不认识 bash。
- **发现管线**：`runInit` 装载类/策略/工具定义（config 点名 + `.stem/` 目录真相；工具清单无序）。**无策略 boot init、无 registerTool**。
- **agent 执行器**：`DefaultRuntime`——送信驱动轮循环，Kernel 经 `RuntimePort` 接口消费。
- **端口适配**：`createSystemToolHost(kernel)`（tools 的 internal 宿主，实住 `kernel/toolHost.ts`）、`createSystemFacade(kernel)`（pilot 的系统门面）。

## 文件

| 文件 | 内容 |
|---|---|
| `index.ts` | 唯一出口 |
| `system.ts` | `createStemSystem` 组合根 + `StemSystem` + `dispose` |
| `loader.ts` | `runInit` 装载管线 |
| `runtime.ts` | `DefaultRuntime` / `createRuntime`（被动驱动轮循环） |
| `runtimeHalt.ts` | 中断/错误收尾（消息闭合） |
| `runtimeToolRound.ts` | 工具轮并行执行 + contextWait 收束 |
| `toolWiring.ts` | `createInternalToolDefs` + `attachToolRecordSink` |
| `types.ts` | `InitDeps`/`InitFs`/`InitToolLoader`/`ClassFs`/`InitReport`/`InitIssue`… |
| `systemFacade.ts` | `SystemFacade` 适配器（pilot 扮演面） |
| （`toolHost.ts` 在 kernel） | `SystemToolHost` 适配器 |

## Runtime（`runtime.ts`，被动驱动）

- 不是同步 run：由快递员送信回调驱动（`processDelivery`）。
- 状态机：`idle →(送信)→ thinking →(LLM 返回)→ holding`；`interrupted`（可恢复）。
- 收完整上下文（`AgentDelivery`）→ 发 LLM → 工具轮（并行执行，结果按 index 回填；`contextWait` 命中则收束轮循环不空转）→ 每轮 assistant 消息复制入仓库 → 最终纯文本回复投递**创建者**（= 族谱父；发送者戳由管理员生成）。
- 中断控制器 + 多层 try/catch + `halt` 消息闭合（见 architecture 2.5）；错误日志走 `errorBrief` 投影（结构化 kind 保留，杜绝 `[object Object]`）；各 agent 独立 AsyncGenerator 天然并发。

## 装配顺序（architecture 2.8）

Ⅰ **stem 初始化**：空间定位 → config 解析（缺 = 首启模板内存等效；**user.model 必填**）→ 参数落位 → 资源发现（工具定义入**无序清单** `InitReport.toolInventory`；类/策略入注册表）。

Ⅱ **Kernel 构造**（工具表尚空；stateStore 注入时构造内恢复，上下文接线延后）。

Ⅲ **工具 drain**：seed = internal 定义 + hostTools + 发现清单 + 策略 `ownedTools`/`createOwnedTools`。`registry.drain`：`register` + `init`，init 可 `registerMore`；完成 → **冻结**。internal 经端口用到 Kernel，故 Kernel 先于 drain。

Ⅳ `wireRestoredContexts` → Ⅴ `createPilot`（user#0）→ Ⅵ boot 校验律（根 `access_reply` 必 allow）→ Ⅶ `userHooks`。

- 返回 `StemSystem { kernel, pilot, tools, config, init, dispose }`。
- **无策略 boot 相位、无 tools.initAll**：策略只被发现进注册表；工具就绪只有 drain 一条路。

## 依赖方向

`main → 全部 core 模块`（单向）；Kernel/Pilot 只认各自端口（`RuntimePort`/`SystemFacade`/`SystemToolHost`），实现由本模块注入。
