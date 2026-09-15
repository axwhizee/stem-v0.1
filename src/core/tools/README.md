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
├── ToolCapabilityRegistry.ts 注册表（注册/物化/执行/记录 sink）
└── internal/                ★ 一切 kind=internal 工具的唯一定义域
    ├── index.ts             createInternalTools(host, bash?) —— internal 唯一出入口
    ├── ports.ts             SystemToolHost + 按域窄端口（Agent/Context/Telemetry/Access）
    ├── shared.ts            resolveOr / resolveReachable / MODEL_* 呈现基元（模型解析走 gateway.parseModelRef）
    ├── systemTools.ts       createSystemTools 聚合（20 枚工具清单）
    ├── agentClassTools.ts   agent_class_*
    ├── agentInstanceTools.ts agent_instantiate/update/list/inspect/ancestry/descendants/terminate
    ├── mailTools.ts         mail_*
    ├── contextTools.ts      agent_pause + context_*
    ├── telemetryTools.ts    telemetry_query + 行渲染
    ├── accessTools.ts       access_reply
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

`SystemToolHost = { agents, context, telemetry, access }`；kernel 经 `kernel/toolHost.ts` 把自身域操作适配为中性 DTO，组合根注入。**其他模块不得 import 本端口类型**：类型只住 `internal/ports.ts`，不随 `tools/index.ts` 公开导出；kernel 适配器为具名例外，直取 `../tools/internal/ports`。

中性 DTO 与 kernel 基因同集：`AgentClassGenesView`（tools/contextStrategy/model/sendCountdown/temperature/effort）组合出 View/Input/Patch；`AgentConfigView.model` 直接用 gateway `ModelBinding`（toolHost 零拷贝）。

`createInternalTools({ host, bash? })` 是 internal 工具唯一定义入口；bash 端口存在时才装配。

## 5. 系统工具（`internal/` 分域文件，20 枚）

系统自我管理与邮局机制的模型侧能力面；定义按域拆分（`agentClassTools` / `agentInstanceTools` / `mailTools` / `contextTools` / `telemetryTools` / `accessTools`），`systemTools.ts` 只做 `createSystemTools` 聚合。**出生权限逐把声明，通例 `ignore`**——上台面由各级收敛清单显式化（根清单实值 = `config/defaults.ts` 首启模板，非系统兜底）。

| 工具 | 作用 |
|---|---|
| `agent_class_create` / `agent_class_update` / `agent_class_list` | 创建（新名 = 变体并存）/ 更新（同名覆盖；tools 增量、只许收敛——**硬门禁在 `kernel.updateAgentClass`**，工具层同尺预检换 agent 文案；系统机制类·user 根类拒绝；**只影响后续实例**）/ 列出——均回写 `.stem/agent/`（ClassStore 注入时） |
| `telemetry_query` | 运行日志观测（进化闭环"观测"翼）：可见域 = 自身 + 族谱后代（canReach）；行式压缩 + 类型前缀通配 + 时间窗 + limit 截尾 |
| `agent_instantiate` / `agent_list` / `agent_inspect` | 创建实例（父=调用者；可继承父上下文；模型路径只能收敛；**wait=true 创建并等待回信**——配对原子完成竞态绝迹，可配 waitTimeoutMs）/ 列出 / 详情（族谱链/状态/轮次/成本/生效权限表） |
| `agent_ancestry` / `agent_descendants` / `agent_terminate` | 祖先链 / 后代子树（BFS）/ 终止（销毁权 + recursive） |
| `agent_update` | 实例参数统一写面（缺省目标=自身，canReach）：name / model / temperature / effort；审计双事件 |
| `mail_send` / `mail_participants` | 发消息（自动 from 戳）/ 参与者清单 |
| `agent_pause` | 自主挂起攒信（ms 到点唤醒；期间信件自然堆积。等特定子回信走 `agent_instantiate` 的 wait） |
| `context_export` / `context_overview` / `context_remove` / `context_edit` | 导出 jsonl (只读) / 概览（role/turn/tag/token 占比）/ 删除过时消息（markInvalid）/ 重写消息（system 不可改） |
| `context_apply` | 执行上下文策略专有动作（如 classic compact；仅自身或祖先） |
| `access_reply` | 答复访问申请（once/always/reject；授权权 = 申请者的族谱根）——**根义务，删则 ask 死锁** |

> internal 出生实值（盘点定形）：`access_reply: allow` + `bash: allow`，其余通例 `ignore`。策略工具（cortex 笔记两键 `cortex_add_note`/`cortex_del_note`）住策略注册点，出生 `ignore`、经 `strategy.tools` raise 声明清单抬升；`cortex_load_*` 是组装轮里的虚拟名不注册（幻觉点名 = unknown 无害）。

## 6. bash 工具（`internal/bash.ts`，kind=internal）

- **最小系统唯一对外操作面**：不采用扩展时，除系统工具外模型触达外部文件/系统的入口只有 bash。core 只定义工具形状与 `ShellRunner` 端口（`run({command,cwd,timeoutMs,shell}) → {stdout,stderr,exitCode,timedOut}`），执行由宿主注入（node `child_process` 实现 = `shell/cli/bash.ts`）——core 零平台依赖不破。
- **治理 = 机制 + 分担，非询问**（对齐 pi）：**无 ask、无黑名单**（高频工具询问打断模型循环得不偿失）；事故半径三机制（硬超时缺省 120s / stdout·stderr 各 50k 截断 / cwd 缺省项目根，`config.bash` 可配 `path/defaultTimeoutMs/maxOutputChars/cwd`）；行为规范靠工具描述提示词（非交互式、有专职工具优先）；不想给某 agent shell → 模板白名单不列 `bash` 键（键即自我限定）。非零退出码不是工具失败（输出 + exit code 照常返回，模型自判）。
- 出生权限 `allow`；宿主未注入 `shellRunner` 则不装配（`bootStem` 缺省注入，`shellRunner:false` 可关）。

## 7. 访问确认（`accessRequest.ts`，取代 AccessManager）

- 生效访问经注入 `AccessResolver` 向族谱台账查询（无判定 → 出生值）；`assert`（allow/ignore 通过 / deny 抛错 / ask 投递申请到根信箱并挂起）+ `reply(input, by)`（根授权校验 once/always/reject）。
- **在途复核（总序防御）**：reply once/always 落地前重查该键现生效值——挂起期间被 `agent_update` 收敛为 deny 的，迟到的批准被铁律压死（reject 回文本带因，不写 always 备忘；复用 resolvePort，零新依赖）。
- **无元 agent 短路**：根也是普通 agent，其 ask 发给自己，由扮演它的 shell 经 pilot `replyAccess` 确认。
- **session 豁免备忘**：`always` = 该 `(agent, accessKey)` 免询问放行（仅本实例，非权限层，不破 deny/ignore）。
- `autoApprove`（config）时 ask 直接放行（deny 仍拒绝）。

## 8. 统一输出 + 窗口限制

`formatToolOutput(result | error, { outputLimit })` 是结果落上下文前的唯一成形点，同时服务于 runtime 会话回填与工具记录 sink（`main/toolWiring.attachToolRecordSink`），消除两处重复的错误渲染。

- `config.tools.outputLimit`（字符口径）；**0/未设 = 不启用**（默认零行为变更）。
- 超限：头部截断 + 省略说明。错误渲染 `[ToolError <kind>] <细节>`，细节退化链 message → feedback → accessKey → tool。
- **错误守卫**：`isToolError`（kind ∈ `TOOL_ERROR_KINDS`）替代任意带 kind 对象的鸭子判定；`formatToolOutput` 只认真 ToolError。执行通道对领域错误（KernelError 等）仍原样透传（工具是通道不是转换器）。
- **`errorBrief(cause)`**：任意异常 → `{kind?, message}` 投影（runtime halt 等），杜绝裸对象 `String()` 成 `[object Object]`。
- **`ToolPhase = called|success|error`**：ToolRecord / LogEvent / PilotEvent.tool 共用单源。
- 历史顶层 `tools` 数组形态 = 可行动迁移错误（清单请用 `user.tools` / `extensions.tools`）。

## 9. 加工具 / 加矩阵资源

- **internal 工具**：在 `internal/` 对应分域文件定义 `ToolCapability`（id/description/parameters/**birth**/execute），经 `createInternalTools` 或策略 `registerTool`（出生恒 ignore）进入注册表。
- **extension 工具**：`extension/tools/<名>/<名>.ts` 默认导出 `ToolCapability` 或工厂 `(projectRoot) => ToolCapability`；在 `config.extensions.tools` 点名 `{名: 权限词}`。
- **custom 工具**：`.stem/tools/<名>.ts` 或 `<名>/<名>.ts`，同样必须点名——未点名 = 不存在于世界。
- 装载管线：`main/loader.ts`（internal → extension → custom，后层同名覆盖；类/策略目录即真相）。
