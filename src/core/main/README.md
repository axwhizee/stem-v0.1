# main —— 组合根 + 进程生命周期 + 装载管线 + agent 执行器

> 模块自述：实现细节见本文件；架构定位见 `docs/architecture.md`。
> **core 中唯一 import 一切的模块**；没有任何模块依赖 `main`。

## 职责

- **组合根**：`createStemSystem(deps)` 装配配置/工具注册表/Kernel/工具记录 sink/internal 工具/装载管线/Pilot。
- **工具装配**：`registerInternalTools`（internal 唯一出入口 `createInternalTools`：系统工具 + 可选 bash）+ `attachToolRecordSink`（工具三相位 → 事件流 + 仓库记录/历史行）——`internal 装配 + sink 接线`从 Kernel 构造器上移，Kernel 不再认识 bash。
- **装载管线**：`runInit(deps)` 三维资源矩阵（internal → extension → custom，后层同名覆盖）。
- **agent 执行器**：`DefaultRuntime`（原 `kernel/Runtime.ts`）——送信驱动轮循环，Kernel 经 `RuntimePort` 接口消费。
- **端口适配**：`createSystemToolHost(kernel)`（tools 的 internal 宿主）、`createSystemFacade(kernel)`（pilot 的系统门面）。

## 文件

| 文件 | 内容 |
|---|---|
| `index.ts` | 唯一出口 |
| `system.ts` | `createStemSystem` 组合根 + `StemSystem` + `dispose` |
| `loader.ts` | `runInit` 装载管线（原 `init/init.ts`） |
| `runtime.ts` | `DefaultRuntime` / `createRuntime`（原 `kernel/Runtime.ts`） |
| `types.ts` | `InitDeps`/`InitFs`/`InitToolLoader`/`ClassFs`/`InitReport`/`InitIssue`… |
| `systemFacade.ts` | `SystemFacade` 适配器（pilot 扮演面） |
| `toolWiring.ts` | `registerInternalTools` + `attachToolRecordSink`（internal 装配 + 工具记录 sink） |
| `toolHost.ts`（在 kernel） | `SystemToolHost` 适配器（见 kernel/README） |

## 装配顺序（固定）

1. 读唯一配置（`.stem/stem.jsonc`）；家学硬校验 `user.model` 必填；
2. 工具注册表 + Kernel（注入 `runtime` 工厂、user 类、classStore、stateStore）；
3. 工具记录 sink + internal 工具（`registerInternalTools`：系统工具 + `shellRunner` 注入才装配的 bash）；
4. `runInit` 矩阵装载；策略 `init`（可注册自带工具）；恢复箱 `realignRestoredInstances`；
5. Pilot（根实例化，经 `SystemFacade`）；boot 校验律（根 `access_reply` 必须 allow）；
6. 工具 `initAll`（fs/projectRoot/log 注入）；用户钩子。

## 依赖方向

`main → 全部 core 模块`（单向）；Kernel/Pilot 只认各自端口（`RuntimePort`/`SystemFacade`/`SystemToolHost`），实现由本模块注入。
