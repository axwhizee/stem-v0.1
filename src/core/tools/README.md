# tools —— 工具框架（注册 / 访问代数 / 生命周期 / 统一输出）

> 模块自述：实现细节以本文件为准；架构定位与跨模块关系见 `docs/architecture.md`。
> 工具是模型唯一的行动面；一切「能力」都必须先成为工具。

## 1. 职责与依赖

- **对模型**：把注册的工具物化为 LLM tool schema（`materialize`），执行调用并统一成形结果。
- **对系统**：提供注册即出生声明（birth）、权限四态代数、收敛链折叠、ask 审批消息化。
- **依赖**：`gateway`（ToolDefinition schema）、`logging`（日志事件）；**自持端口** `internal/ports.ts`（消费方拥有，kernel 适配器实现，组合根注入）。**本模块不 import kernel**。

```
tools/
├── index.ts                 唯一出口（只 re-export）
├── types.ts                 领域类型（ToolCapability/ToolAccess/ToolContext/…）
├── access.ts                四态代数：restrictAccess / accessRank / 收敛链折叠
├── accessRequest.ts         ask 消息化（DefaultAccessAskBus / formatAccessRequest）
├── validate.ts              JSON Schema 子集参数校验
├── output.ts                ★ 统一输出成形（成功/失败同入口 + 窗口限制）
├── ToolCapabilityRegistry.ts 注册表（注册/物化/执行/生命周期钩子）
└── internal/                ★ 一切 kind=internal 工具的唯一定义域
    ├── index.ts             createInternalTools(host, bash?) —— internal 唯一出入口
    ├── ports.ts             SystemToolHost + 按域窄端口（Agent/Context/Telemetry/Access）
    ├── systemTools.ts       20 枚系统工具（agent_* / mail_* / context_* / telemetry_* / access_reply）
    └── bash.ts              bash 工具 + ShellRunner 端口（宿主注入）
```

## 2. 权限四态与收敛链

`ToolAccess = allow | ask | deny | ignore`，严格度总序 **`deny ≺ ask ≺ allow ≺ ignore`**（按监督度：ignore = 看不见的执行最宽）。一切权限书写面同一把尺，**只许顺链收紧**，藏匿（allow→ignore）判扩张被拒。

- **键即白名单**：类/实例的 `tools` Record 键为工具访问键；未列 = 本地 deny；**未设（undefined）= 完整继承父生效档案**；`{}` = 本地封闭。
- **出生声明（birth）**：每个工具注册时必带，是收敛链的全局封顶。internal 在 core 注册点写死（`access_reply: allow`、`bash: allow`，其余通例 `ignore`）；extension/custom 由 `config.extensions.tools {名: 权限词}` 点名时注入（装载与出生一句话）。
- **收敛链**：根清单 → 类清单 → [策略 raise 清单] → 实例清单，逐步折叠、不预合并，逐键被父面显式判定 ∧ 出生值封顶。物化面静默钳制（重启幂等），写入面拒绝式校验（扩张即拒、带层归因）。
- **模型可见 = allow ∪ ask**；deny 出局；ignore 背景在场（不暴露给模型但可被显式调用路径使用）。
- **ask 是消息交换**：`access_request` 投递到申请者族谱根信箱 → 根经 `access_reply` 回复 once/always/reject（always 记 per-(agent,key) 豁免备忘，只免询问不破 deny/ignore）。

## 3. 生命周期四段（规范）

| 段 | 时机 | 落点 |
|---|---|---|
| **初始化** | 系统装配时一次 | `register`（出生声明）+ `init(ctx)` / `registry.initAll`（fs/projectRoot/log 注入） |
| **激活** | 每 agent 生效时 | `materialize`（可见 = allow ∪ ask）+ `access.assert`（执行前门禁） |
| **工作** | 模型发起调用 | `execute` + `onBeforeExecute/onAfterExecute/onError` |
| **输出结果** | 结果落上下文前 | `output.ts` 统一成形（成功与错误同一入口） |

**唯一出入口**：`createInternalTools(ports)`（定义）+ `ToolCapabilityRegistry.execute`（执行）+ `output.ts`（成形）。

## 4. internal 工具宿主端口（DIP）

`internal/ports.ts` 由**消费方（tools）拥有**，按域拆窄端口 + 中性 DTO，避免 tools→kernel 源码依赖：

| 端口 | 覆盖 |
|---|---|
| `AgentPort` | 族谱/实例/类/寻址/通信（agent_*、mail_*） |
| `ContextPort` | 上下文本体操作（context_*、agent_pause） |
| `TelemetryPort` | 日志读取（telemetry_query） |
| `AccessPort` | ask 审批回复（access_reply） |

`SystemToolHost = { agents, context, telemetry, access }`；kernel 经 `kernel/toolHost.ts` 把自身域操作适配为中性 DTO，组合根注入。**其他模块不得 import 本端口类型。**

`createInternalTools({ host, bash? })` 是 internal 工具唯一定义入口；bash 端口存在时才装配。

## 5. 统一输出 + 窗口限制

`formatToolOutput(result | error, { outputLimit })` 是结果落上下文前的唯一成形点，同时服务于 runtime 会话回填与工具记录 sink，消除两处重复的错误渲染。

- `config.tools.outputLimit`（字符口径）；**0/未设 = 不启用**（默认零行为变更）。
- 超限：头部截断 + 省略说明。错误渲染 `[ToolError <kind>] <细节>`，细节退化链 message → feedback → accessKey → tool。
- 历史顶层 `tools` 数组形态 = 可行动迁移错误（清单请用 `user.tools` / `extensions.tools`）。

## 6. 加工具 / 加矩阵资源

- **internal 工具**：在 `internal/systemTools.ts`（或策略自带工具）定义 `ToolCapability`（id/description/parameters/**birth**/execute），经 `createInternalTools` 或策略 `registerTool`（出生恒 ignore）进入注册表。
- **extension 工具**：`extension/tools/<名>/<名>.ts` 默认导出 `ToolCapability` 或工厂 `(projectRoot) => ToolCapability`；在 `config.extensions.tools` 点名 `{名: 权限词}`。
- **custom 工具**：`.stem/tools/<名>.ts` 或 `<名>/<名>.ts`，同样必须点名——未点名 = 不存在于世界。
- 装载管线：`main/loader.ts`（internal → extension → custom，后层同名覆盖；类/策略目录即真相）。
