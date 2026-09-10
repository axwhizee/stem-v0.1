# main —— 组合根 + 进程生命周期 + 装载管线 + agent 执行器

> 模块自述：实现细节见本文件；架构定位见 `docs/architecture.md`。
> **core 中唯一 import 一切的模块**；没有任何模块依赖 `main`。

## 职责

- **组合根**：`createStemSystem(deps)` 装配配置/工具注册表/Kernel/工具记录 sink/internal 工具/装载管线/Pilot。
- **工具装配**：`registerInternalTools`（internal 唯一出入口 `createInternalTools`：系统工具 + 注入 `shellRunner` 才装配的 bash）+ `attachToolRecordSink`（工具三相位 → 事件流 `tool` 变体 + 仓库记录/历史行）——`internal 装配 + sink 接线`从 Kernel 构造器上移，Kernel 不再认识 bash。
- **装载管线**：`runInit(deps)` 三维资源矩阵（internal → extension → custom，后层同名覆盖）。
- **agent 执行器**：`DefaultRuntime`（原 `kernel/Runtime.ts`）——送信驱动轮循环，Kernel 经 `RuntimePort` 接口消费。
- **端口适配**：`createSystemToolHost(kernel)`（tools 的 internal 宿主，实住 `kernel/toolHost.ts`）、`createSystemFacade(kernel)`（pilot 的系统门面）。

## 文件

| 文件 | 内容 |
|---|---|
| `index.ts` | 唯一出口 |
| `system.ts` | `createStemSystem` 组合根 + `StemSystem` + `dispose` |
| `loader.ts` | `runInit` 装载管线 |
| `runtime.ts` | `DefaultRuntime` / `createRuntime`（被动驱动轮循环） |
| `toolWiring.ts` | `registerInternalTools` + `attachToolRecordSink` |
| `types.ts` | `InitDeps`/`InitFs`/`InitToolLoader`/`ClassFs`/`InitReport`/`InitIssue`… |
| `systemFacade.ts` | `SystemFacade` 适配器（pilot 扮演面） |
| （`toolHost.ts` 在 kernel） | `SystemToolHost` 适配器 |

## Runtime（`runtime.ts`，被动驱动）

- 不是同步 run：由快递员送信回调驱动（`processDelivery`）。
- 状态机：`idle →(送信)→ thinking →(LLM 返回)→ holding`；`interrupted`（可恢复）。
- 收完整上下文（`AgentDelivery`）→ 发 LLM → 工具轮（并行执行，结果按 index 回填；`contextWait` 命中则收束轮循环不空转）→ 每轮 assistant 消息复制入仓库 → 最终纯文本回复投递**创建者**（= 族谱父；发送者戳由管理员生成）。
- 中断控制器 + 多层 try/catch + `halt` 消息闭合（见 architecture 2.5）；各 agent 独立 AsyncGenerator 天然并发。

## 装配顺序（`createStemSystem`，固定）

0. （可选 `stateStore` 注入）Kernel 构造内：内存核建好 → 从 store 恢复（实例/消息/空间 + 状态归一化 + id 计数器续接 + 族谱树能力相 replay）→ 套 write-through 装饰器 → 构造末尾接线恢复箱上下文（顺序不变，恢复收敛在 Kernel 内）。
1. 读配置（不存在 = `defaultStemConfig` 内存等效；**家学硬校验 `config.user.model`**）→ 工具注册表 + Kernel（user 类 = config.user 对象；注入 `contextSettings`/`maxSteps`/`project`/`toolOutputLimit`/`stateStore`/`classStore`）。
2. 工具记录 sink（`attachToolRecordSink`）→ internal 工具（`registerInternalTools`：系统工具 + 注入 `shellRunner` 才装配的 bash）→ 宿主显式 `hostTools`。
3. `runInit` 矩阵装载（tools / agent 类 / context 策略 × extension 点名 + custom 扫描；后层同名覆盖；目录即真相，永不回写）。
4. 策略 `init`（可注册自带工具）→ 恢复箱 `realignRestoredInstances`（类/策略载齐后补对齐）。
5. `createPilot`（pilot 初始化内实例化根，挂真实项目空间）→ 订阅事件流；boot 校验律（根 `access_reply` 必 allow）。
6. `tools.initAll`（fs/projectRoot/log 注入）→ 用户注入钩子（`userHooks`）。

- 返回 `StemSystem { kernel, pilot, tools, config, init, dispose }`；任何 shell 注入平台能力即可装配出完整最小系统。

## 依赖方向

`main → 全部 core 模块`（单向）；Kernel/Pilot 只认各自端口（`RuntimePort`/`SystemFacade`/`SystemToolHost`），实现由本模块注入。
