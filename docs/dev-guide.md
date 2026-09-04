# stem 开发者手册（dev-guide）

> 与 `api.md`（接口参考书）配套：本卷讲"**在哪扩、怎么扩**"，api.md 查"有什么"。
> 版本基线 v1.0（2026-09-02 冻结）。所有示例可直接在 test/space-demo 演示空间跑。
> 阅读路线：§2 扩展面全景（地图）→ §3 矩阵与食谱（动手）→ 其余分册速查。

## 0. 三十秒世界观

stem = **原子化 AgentClass（模板）+ Agent 实例**的自主系统：全体 agent 平等（user0 只是 `user` 类的根实例），权限与模型都是**族谱位置的函数**，外部世界经"消息交换"而非系统耦合通道抵达。代码分层：

```text
shell/（交互层：cli / webui / dashboard——平台适配 + UI）
  ↓ 注入平台端口
src/core/（纯 TS 领域逻辑，零平台依赖硬规则）
  ↓ 声明契约
extension/（矩阵 extension 层资源：tools / agent / context 目录形态）
```

一切扩展都收敛在 §2 的清单里——**系统不为任何具体功能开特例通道**，新能力 = 在某个既有扩展点上挂东西。

## 1. core 零平台依赖（最高优先级硬规则）

`src/core/` 内禁止 `import 'vscode'`、禁止平台全局（`window`/`process`/`Deno`）。平台能力一律以接口暴露、宿主注入（清单见 §2-I）。写 core 代码时想拿平台能力 = 在 `StemSystemDeps` 上加一个**可选端口**，别引依赖。跨层引用只能 import 模块 `index.ts`（内部文件禁止直引；shell 工具层如 dashboard 按平台代码豁免）。

## 2. 扩展面全景总清单

> 列义：**点位** = 名称；**契约/位置** = 找它；**时机** = 何时被调；**边界** = 语义约束与禁忌。

### A. 装配层注入点（组合根 `StemSystemDeps`，`src/core/init/system.ts`）

| 点位 | 类型/端口 | 时机 | 语义与边界 |
|---|---|---|---|
| `config` | `{ store: ConfigStore, paths: ConfigPaths }` | 全程 | 唯一配置文件抽象；paths 给 projectRoot/configDir/toolDir/agentDir/strategyDir |
| `gateway` | `ModelGateway` | 每次 LLM 轮 | 一切模型调用出口；宿主侧 `buildGateway(config, env)` 按 providers 路由（R1 两段式） |
| `fs` / `tools` | `InitFs` / `InitToolLoader` | runInit | 目录扫描 + 动态 import（矩阵装载与标本同源） |
| `extensionRoots` | `{tools?, agent?, context?}` | runInit | extension 层三根（宿主给仓库 `extension/` 路径）；缺省 = 无该层 |
| `shellRunner` | `ShellRunner` | bash execute | 提供才装配 bash 工具（core 可运行性的无平台证明） |
| `classFs` | `ClassFs` | 类书写时 | 提供才建 ClassStore（`agent_class_create/update` 落盘 `.stem/agent/`） |
| `stateStore` | `{ messages, instances }` | Kernel 构造 | 注入即 write-through + 启动恢复；`false/缺省` = 纯内存（标本模式） |
| `logger` / `timer` / `maxSteps` / `estimateCost` | LogSink / TimerFactory / number / `(usage)=>number` | 横切 | 日志出口、可测时钟、循环上限、成本定价策略（缺省 0 = 只计量不计费） |
| `hostTools` | `ToolCapability[]` | 装配步 3 | **显式代码注入工具**通道（测试/深度定制）；常规工具走矩阵不走了 |
| `userHooks` | `UserInitHook[]` | init 末尾 | `(system: StemSystem) => void`——装配后深度扩展的最后自由位 |
| `onEvent` | `(PilotEvent) => void` | 全程 | 事件流单点回调（内部经 EventHub 多订阅） |

### B. 资源注册点（registry 三面 + 矩阵目录）

| 点位 | 契约/位置 | 时机 | 语义与边界 |
|---|---|---|---|
| `ToolCapabilityRegistry.register(tool, {replace?})` | `src/core/tools` | 任意时刻 | 缺省同名抛错（代码防呆）；`replace` 仅矩阵装载律使用 |
| `TemplateRegistry.register(cls, {replace?})` / `update(name, patch)` | `src/core/kernel` | 任意时刻 | update 走收敛检查（模型书写面）；register+replace 是装载行为**不查收敛** |
| `StrategyRegistry.register(module)` | `src/core/context/strategies` | init/任意 | 同名直接覆盖内置 = 用户主权 |
| custom 目录 | `.stem/{tools,agent,context}/` | runInit 扫描 | **目录即真相**：放入即注册，config 零登记 |
| extension 点名 | `extension/<种类>/<名>/<名>.<ext>` + `config.extensions.<种类>` | runInit | 缺省表 `DEFAULT_EXTENSION_TOOLS` = fs 五件套 |
| internal 源 | 代码注册（`registerSystemTools`/`BUILTIN_TEMPLATES`/classic+none） | 装配固定序 | 恒在层；矩阵装载序 internal → extension → custom 后层覆盖 |
| `registry.initAll` 后新注册 | `tools.register(...)` | userHooks 内 | 新工具**不会自动 init**——需自管或再调 initAll（幂等约定） |

### C. 生命周期 hook 点

| 点位 | 契约/位置 | 时机 | 语义与边界 |
|---|---|---|---|
| `ToolCapability.init?(ctx: ToolInitContext)` | `src/core/tools/types.ts` | 装配完成后一次 | ctx = `{fs?, projectRoot?, log?}`；幂等由工具自证；**工具间禁跨依赖** |
| `UserInitHook(system)` | `src/core/init/system.ts` | createStemSystem 末尾 | 拿全量 StemSystem；注册钩子内即时生效（类/工具皆可补登） |
| `ToolHooks{onBeforeExecute/onAfterExecute/onError}` | `src/core/tools` | 每次工具执行 | registry 级横切（审计/限流/telemetry 挂载位）；经 `ToolRegistryOptions.hooks` 构造注入 |
| `Repository.onChange(agentId)` | `src/core/context` | 每条消息落库 | 新消息通知口（管理员 handleChange 即经它接线）；自定义观察者可用于自动巡检 |
| 管理员 wake 链 | `ContextManager` | user_prompt 信件抵达 | 策略 `process` 的触发点——compact 等重活必须自带重入 guard + 失败兜底，**绝不抛出到送信链路** |
| `setRecordSink/setLogSink/setAccessSink/setAccessResolver` | registry setter 面 | 装配接线 | kernel 组装四路接线（工具记录→邮局 / 日志 / ask 弹窗总线 / 权限台账）；shell 经内核装配后一般不再动 |
| `dispose()` | StemSystem | 进程收尾 | abortAllAgents + 存储 close |

### D. 权限与访问控制接入点

| 点位 | 契约/位置 | 语义与边界 |
|---|---|---|
| 类 `tools` Record（键即白名单） | `AgentClass.tools: Record<key, allow\|ask\|deny\|ignore>` | 未列 = 本地 deny（自我限定）；四态含 ignore=不暴露但等同 allow（internal 缺省） |
| `InstantiateOptions.tools` 补充 | `src/core/kernel` | 出生时对模板表的**收敛**（只收紧不放宽） |
| `InstantiateOptions.accessMode: 'grant'` | 同上 | 加法整表替换 = **系统特权通道**（策略 spawn/pilot 专用；`agent_instantiate` 工具参数永远不可达） |
| `AccessResolver` 端口 | `src/core/tools` ← `lineage/AccessLedger` | tools 侧唯一查询口；`ToolContext` 无权限层（判定不落默认：internal→ignore 其余→ask） |
| ask 消息化 `AccessAskBus` | `src/core/tools/accessRequest.ts` | `<access_request>` → 申请者族谱根信箱 → `access_reply`(once/always/reject+反馈)；`config.autoApprove` = 旁路（调试） |
| always 豁免备忘 | AccessAskBus per-agent | 只免询问，**不破 deny/ignore**（非权限层） |
| `restrictAccess` 四态纯代数 | `src/core/tools/access.ts` | 层间合成的唯一算法（lineage 只共享此纯函数，tools 绝不 import lineage） |
| `canReach(agentId)` 可见域 | `src/core/lineage` | 跨 agent 操作统一谓词（销毁/中断/telemetry/agent_update 全走它；自身∨祖先代查） |
| `DEFAULT_USER_TOOLS` | `src/core/kernel/builtin/agents.ts` | 根类缺省清单（内置类唯一定义域：USER_DEFAULT/ASSISTANT/buildUserClass）；`config.user.tools` 给出即**整表替换**（误删 `access_reply` = ask 死锁） |
| 祖先锁定律 | AccessLedger 语义矩阵 | 总序 `deny≺ask≺allow≺ignore` 顺链只许收缩；祖先匿名封闭不下传、显式判定才下传（藏匿/放宽皆扩张被拒） |

### E. 模型解析接入点（四级律的单点化）

| 点位 | 契约/位置 | 语义与边界 |
|---|---|---|
| 解析链本体 | `LineageTree.modelOf / nodeConfigOf` | 显式（实例行）> 类基因 > 父继承 > 家学（`config.user.model` 必填锚点，boot 硬校验）；attach 同批物化 `ModelBinding{ref,origin}` |
| 出生显式 | `InstantiateOptions.model` / `pilot.instantiate({model})` | 落实例行 = 持久载体（随行 JSON，含 `modelSnapshot` 出生快照跨重启） |
| 运行时热切 | `agent_update` 工具（canReach；model 半程）/ `pilot.setModel`（宿主薄壳同入口） | **不级联子女**（出生快照保护，replay 重解析天然）；下轮送信生效；审计 `kernel.model.set` + `kernel.instance.updated` |
| 摘要 worker 基因位 | `config.context.compact.summarizeModel` | 缺省 = 继承宿主档案 |
| 消费单点 | `RuntimeDeps.resolveModel` 端口 → lineage | **禁止**再拼 `template.model ?? 默认` 单层链（defaultModel/FALLBACK 已整体拆除） |
| 候选面 | `providers` 注册表 + `models` 白名单 + webui `/api/models` | 全严格式 `提供商/模型`，裸名不受理 |

### F. 上下文策略扩展面

| 点位 | 契约/位置 | 时机 | 语义与边界 |
|---|---|---|---|
| `ContextStrategyModule` 六面 | `src/core/context/strategies/types.ts` | — | `name`（注册键）/ `note`（追加宿主 systemPrompt，模型知晓自身记忆机制）/ `role`（AgentClass——S9 类形态统一，策略 spec 与用户类同形状）/ `assemble`（**纯函数**）/ `process`（异步许可）/ `actions`（Record<名,(api,args)=>string>） |
| `StrategyApi` 能力包 | 管理员构造注入 | process/actions 内 | list/listValid/append(tag)/markInvalid/updateMessage/estimatedTokens/settings/custom（宿主类基因槽）/spawn（role+worker 正规往返含回收）/lastWorkerId·roleAgentId（身份通道）/log——策略**不直连 kernel**；fs 与工具注册走 `init(ctx)`（`StrategyInitContext = {projectRoot,fs,settings,log,registerTool}`，cortex 为参考样板） |
| 触发/终点 | 管理员 wake 链 | user_prompt 抵达 → 唤醒快递员 | 重入合并、失败兜底不卡死（契约义务） |
| `tag` 词表 | 策略自定；**现状六元收口**（''/summary/cortex/ltm/note/stm） | append 合成消息时 | 组装器按该 agent 策略解释 tag；**strategy 不入库为 tag 的一部分**（上下文属性）；新策略要新 tag 先议后扩 |
| 面板态 | `AgentClass.panel=true` → 恒绑 none 策略 | — | 不组装不跑 LLM（user0/role 承载）；`contextStrategy` 字段对其无意义 |
| 落位 | `.stem/context/<名>.ts` / `extension/context/` | runInit | 同名覆盖内置 = 用户主权（classic 全量直出+compact 为参照实现） |

### G. 网关与 provider 扩展点

| 点位 | 契约/位置 | 语义与边界 |
|---|---|---|
| `ModelGateway.chat(req, {signal})` | `src/core/gateway` | 唯一 LLM 出口；`AsyncIterable<LLMEvent>`（text-delta/reasoning-delta/tool-call/**usage**/finish） |
| **零代码接入** | `config.providers` | OpenAI 兼容端点 = 一段 config；`openaiCompatible` 零端点常量/零 env 读取（baseUrl+apiKey+models 白名单全参数化） |
| 非兼容协议 | 新增 `providers/<名>.ts` + `buildGateway` 路由 | 宿主侧装配（core 只认契约）；usage 事件必须发（真实计量源头，`include_usage` 语义） |
| 测试面 | `FakeGateway(handler)` / `shell/cli/mockSse` | usage 可注入（token 归位测试）；mockSse = 纯测试/冒烟支撑，产品无回落 |
| 旋钮 | `requestTimeoutMs` / `fetch?`（openaiCompatible 配置面） | fetch 注入 = 传输层测试口 |

### H. 事件流与观测接入点

| 点位 | 契约/位置 | 时机 | 语义 |
|---|---|---|---|
| `pilot.subscribe(listener)` | `Pilot` → `EventHub` | 全程 | 多订阅者（SSE/巡检/仪表盘各挂各的）；返回退订函数 |
| `PilotEvent` 四型 | `src/core/events` | — | `stream`（LLM 流式）/ `letter`（信箱来信含 access_request）/ `status`（状态机迁移）/ `notice`（系统公告） |
| `Logger`/`LogSink` + `LogEvent` 判别联合 | `src/core/logging` | 全程 | 无总线日志：注入出口即可落盘/落控制台；关键 kind：`kernel.instance.interrupted`、`kernel.class.registered/updated`、`kernel.model.set`、`gateway.apiRequest`（真实 usage/cost）、`tool.call`、`init.tool/agent.registered` |
| `setRecordSink` 工具记录 | registry → 邮局 | 每次工具调用 | `ToolRecord{invocation,status,result|error}`——tool 消息入库的正规通道 |
| `telemetry_query` 工具 | 模型面 | — | 运行日志查询（internal 缺省 ignore、user0 allow；可见域 = 自身+后代） |
| dashboard | `shell/dashboard` | 离线/旁路 | DB 直读 + 标本装配（观测不侵入运行进程） |

### I. 平台端口清单（全部可换实现 = 宿主自由度）

| 端口 | 默认实现 | 换它的理由示例 |
|---|---|---|
| `MessageStore` / `InstanceStore` | `shell/cli/storage`（node:sqlite，v2） | 换 Postgres/文件；**契约是同步接口**（对齐 DatabaseSync 与内存读） |
| `ConfigStore` | `createNodeConfigStore`（JSONC） | 配置中心/加密存储 |
| `InitFs` / `InitToolLoader` | `createNodeInitFs` / tsx import | 只读空间、远程装载 |
| `ClassFs` | `createNodeClassFs` | 类库走 git/API |
| `ShellRunner` | `createNodeShellRunner` | 沙箱执行器、远端 shell |
| `TimerFactory` | 内置 | **测试手动计时器**（kernelHarness） |
| `LogSink` | 宿主 console/文件 | 结构化采集 |
| `ModelGateway` | providers 路由门面 | 任意协议 |
| `estimateCost` | 缺省 0 | 定价/预算策略 |

### J. shell 与交互扩展点

| 点位 | 位置 | 语义与边界 |
|---|---|---|
| **新 shell = 三件事** | 参考 cli/webui/dashboard | `bootStem()` 装配 + pilot 驱动 + `dispose()` 收尾；平台端口缺省全给好 |
| `Pilot` 全接口 | `src/core/pilot` | subscribe/sendMessage/instantiate(model 可选)/setModel/terminate/interrupt/replyAccess/runContextAction/listAgents/inspect/activeAgents/contextOverview/exportContext；`identity` 现为 user0（未来 `as(agentId)` 扮演任意 agent 的空位） |
| `runContextAction(agentId, action, args)` | Pilot → 策略 `actions` | 策略动作的 UI 透传口（compact 等；actions 面即功能面） |
| `view.js` 纯函数核心 | `shell/webui/view.js` | 汉字三态字形/routeLetters/computeTreeRows/deriveActions——**零 DOM 双端共用**（webui+dashboard+node 直测），前端语义扩展落这里 |
| HTTP/SSE API 面 | api.md §5 | webui=交互面（4321），dashboard=法医面（4421），并列零耦合 |
| 审批 UI | letter 事件（access_request）+ replyAccess | 渲染 `<access_request>` 消息本体，**不是弹窗通道**（消息即机制） |

### K. 配置扩展位（自由层的合法出口）

| 点位 | 语义 |
|---|---|
| `config.custom` | 顶层唯一自由块（R12：其余未知键 fail-fast）；工具/策略可读（经 `config` 引用） |
| `AgentClass.custom` | 类文件未知 frontmatter 键全量透传（自由式元数据；序列化回写保真） |
| 目录即真相 | 类/工具/策略的"启用清单"**不是**配置项——放文件即生效，config 永不回写（首启模板除外） |

## 3. 矩阵与食谱

三类资源 × 三层来源的装载律：**internal → extension → custom，后层同名覆盖前层**。extension 与 custom 的差别只有启用方式（点名 vs 目录即真相）与归属（仓库发布物 vs 用户空间）；装载管线同构（`runInit`）。目录形态约定：一资源一目录、**入口与目录同名**；附属脚本自由放置；`_` 前缀目录 = 共享辅助不入库。

### 3.1 custom 工具

`.stem/tools/greet/greet.ts`——

```ts
export default {
  id: 'greet',                                    // 权限键缺省 = id
  description: '向某人问好。',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  execute: async (input: { name: string }) => ({ text: `你好，${input.name}！` }),
}
```

要点：kind 由管线强制 `custom`；类清单显式列键（如 `config.user.tools` 加 `"greet": "allow"`）才对 user0 可见；需要空间根/参与初始化 → `init(ctx)`（§2-C）。平铺单文件 `.stem/tools/greet.ts` 兼容，同名时目录优先。

### 3.2 extension 工具（发布物形态）

`extension/tools/mytool/mytool.ts`——

```ts
import type { ToolCapability } from '../../../src/core/tools'
// 工厂形态：loader 注入 projectRoot（空间感知的路径沙箱等）
export default function createMyTool(projectRoot: string): ToolCapability {
  return {
    id: 'mytool', kind: 'extension',
    description: '…', parameters: { type: 'object', properties: {} },
    execute: async () => ({ text: `空间：${projectRoot}` }),
  }
}
```

config 点名 `"extensions": { "tools": ["mytool"] }`；点名缺失 = `extension_entry_missing` issue（fail-soft 不炸启动，dashboard 资源页可见）。缺省表 = fs 五件套；`[]` = 纯 bash 最小系统。参照实战：`extension/tools/websearch/`（入口 + 专用脚本同目录 + 密钥走 env）。

### 3.3 agent 类文件

`.stem/agent/reviewer.md`（extension 层同构 `extension/agent/creator/creator.md`）——

```markdown
---
description: 代码审查员
tools:                       # 键即白名单，值四态
  read: allow
  grep: allow
  bash: deny                 # 显式 deny 锁子孙
model: alibaba/qwen3.8-flash # 类基因（可选）
anything_else: 自由键        # 未知键透传 AgentClass.custom
---
正文 = systemPrompt。
```

文件名即类 id。模型侧书写 = `agent_class_create/update`（ask 审批、只许收敛、panel/user 根类保护、**只影响后续实例**）。

### 3.4 skill（SKILL.md 生态，零系统机制）

```text
.stem/tools/skill/
├── skill.ts            # custom 装载器：skill() 列清单 / skill({name}) 载正文
└── my-guide/SKILL.md   # YAML name/description + 正文（opencode/claude 兼容）
```

高频技能推荐升级：让 LLM 把 SKILL.md 转化为真工具（§3.1）或折叠进类 systemPrompt——纯书写面，无机制。

### 3.5 context 策略

`.stem/context/windowed.ts` 默认导出 `ContextStrategyModule`（五面契约见 §2-F）；同名覆盖内置。策略要造 agent 只用 `StrategyApi.spawnRole/spawnWorker`（模块扮演形态），worker 用完 terminate 归档。

## 4. 配置速查（唯一文件 `.stem/stem.jsonc`）

R12 全量有效：**未知顶层键 fail-fast**，`custom` 唯一自由位（§2-K）。

| 键 | 语义 |
|---|---|
| `providers.<名>` | `{ base_url 必填 http(s), key_env? 环境变量名, models? 白名单 }`；模型引用一律 `提供商/模型` 全严格式 |
| `user` | user0 内嵌类全对象；**`user.model` 必填 = 家学锚点**；`tools` 给出即整表替换 DEFAULT_USER_TOOLS（误删 `access_reply` = ask 死锁；误删 `agent_update` = 实例参数面锁死，ask 档） |
| `extensions` | `{ tools?, agent?, context? }` 分键点名（§2-B） |
| `context` | `{ window, compact: {enabled/threshold/keepRecentTurns/summarizeModel/instruction/replyTimeoutMs} }` |
| `bash` | `{ path?, defaultTimeoutMs?, maxOutputChars?, cwd? }` |
| `maxSteps` / `sendCountdown` / `autoApprove` | 循环上限 / 送信倒计时缺省 / ask 自动放行（调试） |

首启自动落 `DEFAULT_CONFIG_TEXT` 模板；密钥只走 env（`key_env` 存变量名）。

## 5. 权限与模型（族谱两道相，一个门面）

唯一门面 `LineageTree`；生效权限/模型 = 族谱位置的函数，注册期物化（attach/replay；内部 = AccessLedger 算法，标准形 {explicit, fallback}）。要点看 §2-D/§2-E 清单表；心法三条：**机制大于判断**（能靠白名单/族谱表达的不新增组件）、**键即白名单 = 自我限定**、**审批是消息不是通道**。

## 6. token 计量口径

两标记分工：**`tag` = 是什么**（strategy 写合成消息）；**`tokens` = 多大**（计量）。真实化三级：assistant 行直记网关 `usage.output`；tool/user 行 = 相邻请求 `input` 差分按估算占比归位（`attributeUsage`，负差回落）；未进网关的行保持 `chars/4` 估算。来源不设第三标记；compact 阈值与 totalCost 同口径；DB 行 JSON 整体序列化——加字段零迁移。

## 7. 宿主 shell 编写指南

见 §2-J 清单 + 三参考实：`shell/cli`（最小）、`shell/webui`（交互全量）、`shell/dashboard`（只读观测+标本）。共同骨架：`bootStem()` → pilot 驱动 → `dispose()`。空间定位约定统一 `位置参数 > STEM_PROJECT_ROOT > cwd`；端口环境变量各开一个。

## 8. 安全治理

- 密钥：值只走 env（config 的 `key_env` 存**变量名**；源码/日志/命令行零承载）。
- bash/web 工具 = 对外操作面：**无 ask、无黑名单**，事故半径靠超时/截断/默认 cwd 机制；规范靠提示词与专职工具分担。
- **容器即边界**：挂载 volume = 爆炸半径；webui/dashboard 默认绑 127.0.0.1，容器才 `STEM_HOST=0.0.0.0`；裸机不建议对外暴露。
- dashboard 清理是空间唯一"手改 DB"通道（`--allow-write` + 双确认）；同空间运行实例的写穿会覆盖删除——先停实例（一进程=一空间是约定，无锁）。

## 9. 测试规范与常见陷阱

- 单测与源码同目录（`node:test` + `assert/strict`）；**不 mock 全局**：注入 fake（FakeGateway 注 usage、内存 registry、mkdtemp 真 fs、kernelHarness 手动计时器、gateway `fetch?` 传输口）。
- 分模块跑 `npm run test:module -- "<glob>"`；提交前 typecheck 0 + 全量绿；`reference/` 噪音忽略。
- 陷阱：`verbatimModuleSyntax` 必须 `import type`；`noUncheckedIndexedAccess` 取值判空；core 错误是判别联合对象（`{kind}`）非 Error（`assert.throws` 用谓词）；持久化端口是**同步**接口（node:sqlite 对齐）；`turnCount/totalCost` 引用直改不经装饰器（随状态快照收敛，可接受边界）；改 `ToolKind`/工具 shape/`AgentClass.tools` 时同步检查 `extension/tools/` 与 `src/core/tools/`；SQLite 保留字（`AS all` 直接语法错）；nvm PATH 不跨 shell 会话。

## 10. 运行入口

```bash
npm run shell                # CLI（cwd 即空间；`-- <path>` 定位）
npm run web                  # WebUIShell :4321
npm run dashboard -- [path]  # 仪表盘 :4421（--allow-write 解锁清理）
npm run test / typecheck     # 300 用例 / tsc --noEmit
docker build -t stem:1.0 .   # 发布形态；python3 run-docker.py 一键（Windows/WSL 双端）
```
