# AGENTS.md

## 项目概览

**stem**（Self-Training Evolutionary Matrix）—— 独立原型验证项目：以**原子化 AgentClass（模板）+ Agent 实例**为核心的 Agent 系统。核心目标是从 VSCode 剥离、宿主无关（core 零平台依赖）。

- 定位：不是"把 opencode 塞进 VSCode"，也不是单 Agent 会话容器；是**用户主权的 Agent 系统**——类可自由创建/实例化，配**族谱树**与多 agent 协作，让 AI 自己管理 Agent 信息实现自我进化。
- 参考源码在 `reference/`（deepseek-harness、pi、opencode、VSCode），**仅作参考，非本项目产物**，其类型/编译错误可忽略。

## 设计原则（硬规则）

1. **全体 agent 绝对平等**：user0 是内置 `user` 类的普通实例（`parentId=null` 即根），
   无任何权限/流程特判；一切差异仅由类/实例配置与族谱收敛产生。
2. **机制大于判断**：能靠既有机制表达的需求不新增组件（user0 平等化后 PanelBus /
   AccessManager / META 特判即自然消失）。ask 审批是**消息交换**（`access_request` →
   根信箱 → `access_reply`），不是系统耦合通道；上下文删除 = `markInvalid` + 组装时 `legalize`。
3. **权限收敛走族谱**：族谱树兼顾权限清单——生效权限 = **族谱位置的函数**，
   由 `lineage/AccessLedger` 注册期物化（继承→收敛两步，标准形 {explicit, fallback}）；
   tools 经 `AccessResolver` 端口查询（不随身传层、kernel 无编排）。**键即白名单=自我限定**
   （未列=本地 deny，祖先匿名封闭不下传；祖先**显式** deny/ask 锁子孙，`deny≺ask≺allow/ignore`
   不可撤销）；`grant` 加法 = 系统机制特权（整表替换+未列一律 deny+显式 deny 铁律鉴权，
   模型工具路径不可达）；session always = **ask 免询问备忘**（非权限层）。config.user.permission
   = user0 根类清单（缺省 DEFAULT_USER_TOOLS 含 access_reply 根义务）。
4. **模块自治**：初始化/装配在 core（平台能力经接口注入，core 零平台依赖、可独立运行）；
   shell 只做平台适配 + UI；外部与 core 的一切交互经模块接口（pilot 为 user0 扮演接口）。
5. **少即是多**：工具生命周期（`init`）扩展优先于新建子系统；internal 工具列表不固化、随开发增长。
6. **架构分层**：`shell`（交互层，最外）→ `core`（agents 生态 + skill + 系统工具 + bash，
   即最小系统）→ `extension`（可选功能扩展，典型：扩展工具集）。

## 快速命令

```bash
npm install                 # 安装依赖（node >= 23.4，node:sqlite 免 flag）
npm run typecheck           # tsc --noEmit 类型检查（唯一 lint/typecheck）
npm test                    # 全量单测：tsx --test src/**/*.test.ts shell/**/*.test.ts
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑（node:test 并发）
npm run shell               # CLI 交互 shell（参考 shell，mock 网关）
OPENCODE_API_KEY=<key> npm run shell   # 真实网关（opencode-go）
npm run web                 # WebUIShell（浏览器打开 http://localhost:4321）
npm run build               # 与 typecheck 相同（tsc --noEmit）
```

## 项目结构

```text
src/core/                  # 纯 TS 领域逻辑，零平台依赖（D11 硬规则）
  ├── config/              # 全局配置：StemConfig 类型 + JSONC 解析（唯一配置文件 .stem/stem.jsonc；
  │                        #   user 对象 / maxSteps / context 块 / tools|agents|strategies 镜像）
  ├── context/             # 重建邮局：仓库 Repository + 管理员 ContextManager + 快递员 Courier
  │                        #   + tag/双索引 + exportJsonl/overview + legalize（组装合法化）
  │                        #   + store.ts（MessageStore 端口）+ persisted.ts（write-through 装饰器）
  │                        #   + strategies/（上下文策略子模块：契约+注册表+classic/none；
  │                        #     process/assemble 两段式、compact、模块扮演 agent、.stem/context 加载）
  ├── events/              # PilotEvent 判别联合 + EventHub（多订阅者事件中心）
  ├── gateway/             # ModelGateway 接口 + providers/(opencodeLlm / fetch) + FakeGateway
  ├── init/                # 系统初始化与装配：createStemSystem（组合根）+ runInit 扫描管线
  │                        #   （.stem/tool + .stem/agent + .stem/context → 同步注册表 → 注册进 core）
  ├── kernel/              # Kernel + TemplateRegistry/InstanceManager/SpaceManager/
  │                        #   Runtime + userClass（内置 user 类 + DEFAULT_USER_TOOLS，user0 采用）
  │                        #   + store.ts（InstanceStore 端口）+ persisted.ts（实例/空间写穿装饰器）
  ├── lineage/             # 族谱树（纯关系视图：parent/children/ancestors/descendants/getRoot/
  │                        #   isAncestorOf）+ AccessLedger（权限台账：converge/grant 物化，
  │                        #   生效权限=族谱位置的函数；重启拓扑重放）
  ├── logging/             # LogEvent 判别联合 + Logger（经注入 LogSink，无总线）
  ├── pilot/               # Pilot：user0 扮演接口（驾驶舱；sendMessage/instantiate/
  │                        #   replyAccess/runContextAction/订阅事件流）
  ├── tools/               # ToolCapabilityRegistry（含 init 生命周期；materialize/execute 经
  │                        #   AccessResolver 端口查询台账）+ access.ts（四态纯代数 restrict）
  │                        #   + accessRequest.ts（ask 消息化：投递根信箱 + access_reply +
  │                        #     per-agent ask 豁免备忘）
  │                        #   + SkillRegistry + skill 工具
  └── types.ts
shell/                     # 宿主层（node/CLI + Web），实现 core 注入的接口
  ├── cli/                 # 参考 shell：platform.ts（bootStem 共享装配）+ gateway +
  │                        #   fs 工具集（read/write/edit/grep/glob）+ storage/（SQLite 端口实现）+ CLI 命令
  └── webui/               # WebUIShell：HTTP + SSE 浏览器交互层（agent 侧栏/timeline/composer）
extension/                 # 可选功能扩展（预留：扩展工具集 seam，如 VSCode 工具集）
templates/                 # 内置 AgentClass 模板（JSON，name 即 id，tools 为 Record）
test-support/              # 测试支撑：kernelHarness.ts（内存 + FakeGateway + 手动计时器）
tmp/                       # 测试项目空间（.stem/ 配置 + 用户 tool/agent 示例）
docs/                      # 设计文档：architecture.md（实际架构，以此为准）/ log.md（开发日志）/
                           #   code-style.md / scenarios.md / prompts.md（需求记录，不纳入提交）
```

## 核心架构要点

### Core 零平台依赖（最高优先级硬规则）

- `src/core/` 内**禁止** `import 'vscode'`、禁止平台全局（`window`/`process`/`Deno`）。
- 平台能力（fs、动态 import、网络）全部**以接口暴露、由宿主注入**：如 `ConfigStore`、`InitFs`、`InitToolLoader`、`ModelGateway`、`LogSink`、`TimerFactory`、工具 `init` 的 `ToolInitFs`。
- 跨层引用**只能 import `index.ts`**（禁止 import 内部文件）。
- 接口 + 实现同文件（`interface X` + `DefaultX`），模块目录含 `index.ts` 唯一出口。

### 核心模型

- **AgentClass（模板）**：`name` 即 id（注册查重）；`description`；`systemPrompt`；`tools`（`Record<访问键, ask|deny|allow|ignore>`，**键即白名单=自我限定**，空 Record=无工具、undefined=完整继承父档案）；`contextStrategy`（默认 classic，开辟上下文空间时确定）；`model`；`sendCountdown`；`panel`（模块扮演面板：不组装不跑 LLM，如 user0/策略 role）；`custom`（自由扩展位）。
- **AgentInstance**：`id` / `classRef`（模板名）/ `parentId`（= 创建者，user0 为 null 即根）/ `displayName` / `spaceId` / `status` / `turnCount` / `totalCost` / `userPrompt` / `toolOverride`。**creatorId 已合并进 parentId**（谁创建谁就是父），运行时属性多于工具调用参数。
- **状态机**：`idle → thinking → holding`；`interrupted`（当前轮被中断，仅暂停、消息闭合、可恢复）。
- **族谱树（LineageTree）**：无状态关系查询视图——parentId 挂实例上，实时推导 parent/children/ancestors/descendants/getRoot；销毁/中断权（**自身或祖先**；有活跃子默认拒，recursive 级联）；同目录 **AccessLedger 权限台账**承载族谱权限收敛（见原则 3）。
- **重建邮局（无总线）**：仓库（存储）→ 管理员（打戳/策略 process/组装/context_wait 填充/信箱配对）→ 快递员（倒计时送信，**只发不组装**——送信快照经管理员按策略委托构造）；agent 通信经 `kernel.sendMessage` 直接投递；log/access_reply 走注入接口。
- **上下文策略（context/strategies/）**：每种策略 = 独立子模块（契约 `ContextStrategyModule`：note/role/assemble/process/actions）；触发点 = user_prompt 信件抵达，终点 = 就绪后唤醒快递员（process 异步许可、assemble 纯函数，重入合并、失败兜底不卡死）；classic = 全量直出 + opencode 式 compact（轮边界、摘要 worker 邮局正规往返、markInvalid 归档可逆）；策略需要造 agent 时用**模块扮演 agent**（role 挂宿主下、panel 态、worker 用完 terminate 归档，回信经 waitForReply 配对）；用户策略 `.stem/context/*.ts` 可覆盖内置。
- **个体层持久化（SQLite write-through）**：core 端口 `MessageStore`/`InstanceStore`（+内存默认实现）+ 装饰器（PersistedRepository/InstanceManager/SpaceManager，内存为准同步落行）；宿主注入 node:sqlite 实现（`shell/cli/storage/`，默认 `.stem/stem.db`）。**terminate 归档消息保留语料**；重启恢复 = 装载 + 状态归一化（thinking/holding→interrupted）+ 计数器续接 + 权限台账拓扑重放 + 快递员 lastSentIds 预置（零重放）；类层持久仍走文件，不进 DB。
- **事件流（PilotEvent）**：`stream`（LLM 流式）/ `letter`（信箱来信，含 access_request）/ `status` / `notice`，经 EventHub 多订阅者发布，外部（shell/webui）统一订阅。

### 工具体系与访问

- `ToolKind` 三分类：`internal`（core 系统工具，默认 `ignore` 隐藏）/ `shell`（宿主内置）/ `user`（用户 `.stem/tool/` 提供）。
- `ToolAccess` 四态：`allow`（暴露+执行）/ `ask`（暴露+执行弹窗）/ `deny`（不暴露+拒绝）/ `ignore`（不暴露+等同 allow）。
- **权限查询（台账物化）**：生效权限注册期由 `AccessLedger` 物化（converge 减法默认 / grant 加法系统特权，见原则 3）；tools 侧 `materialize(agentId)`/`assert` 经 `AccessResolver` 端口查询，无判定落默认（internal ignore / 其余 ask）；**ToolContext 不含权限层**。
- **ask 消息化（扁平化）**：命中 ask 时 `accessRequest` 自动投递 `<access_request>` 消息到**申请者的族谱根信箱**（机制同向模型发消息）并挂起；根 agent 经 `access_reply` 工具回复（once/always/reject）。无 agent 特判（user0 的 ask 发给自己，由扮演它的 shell 经 pilot 确认）。always = **per-agent ask 豁免备忘**（只免询问，非权限层）。
- **工具生命周期**：`ToolCapability.init?(ctx)` 参与系统初始化（skill 扫描等）；`registry.initAll(ctx)` 装配后调用一次、幂等、工具间禁跨依赖。

### 消息库：tag + 双索引

- `StoredMessage`：`id / agentId / message / at / tokens / valid / from? / tag? / turn / indexInTurn`。
- **tag**（可选）：标记非原生合成消息（如 summary/impression/meta）；**strategy 是上下文属性**（实例化时确定），组装器按 agent 的策略解释 tag。
- **双索引**：`turn` = 轮序号（复用 turnCount 语义：user 消息开启新轮）、`indexInTurn` = 轮内序号；Repository 自动维护。

### 全局配置与初始化（唯一配置文件）

- 配置文件：`<projectRoot>/.stem/stem.jsonc`（或 `stem.json`），是**最终配置载体**，本阶段无多级合并。
- 配置项：`model`（`提供商/模型` 格式）、`autoApprove`、**`user`（user0 内嵌 agent 类完整对象：description/systemPrompt/permission/contextStrategy/model/sendCountdown；permission 给出整表替换 DEFAULT_USER_TOOLS）**、`maxSteps`、**`context`（window + compact{enabled/threshold/keepRecentTurns/summarizeModel/instruction/replyTimeoutMs}）**、`sendCountdown`、`tools`/`agents`/`strategies`（**纯镜像注册表**，init 自动维护）。
- **系统装配**（`createStemSystem(deps)`，core 组合根）：config → 工具注册表 + Kernel（user 类 = config.user 对象，contextSettings/maxSteps 注入；注入 `stateStore` 时 Kernel 内恢复+套写穿装饰器+台账拓扑重放）→ 系统工具/宿主工具 → skill 工具 → `runInit` 扫描管线 → Pilot 初始化（实例化 user0；已恢复则幂等跳过）→ `initAll`（skill 发现）→ 用户注入钩子。
- `runInit` 管线：扫描 `.stem/tool/*.ts`（默认导出 `ToolCapability`）+ `.stem/agent/*.md`（YAML 头 + 正文）+ `.stem/context/*.ts`（默认导出 `ContextStrategyModule`，同名覆盖内置）→ 同步注册表（jsonc-parser 定点写回，保留注释）→ 注册进 `ToolCapabilityRegistry` + `TemplateRegistry` + 策略注册表。
- **用户 agent 文件**：文件名即类 id/name（不要求 YAML id/name）；`permission` 的键即工具清单（融合设计，工具=键、动作=值）；已知可选键 `context_strategy`/`model`；**其余未知字段透传 `AgentClass.custom`**（自由式 frontmatter）。
- **user0**：`user` 类的普通实例（内置根模板，`parentId=null`），人格与权限面全部经 `config.user` 声明式可配；在 pilot 初始化流程内实例化；系统 ready 后由用户经 pilot 手动实例化后续 agent。

### 测试规范

- 单测与源码同目录（`*.test.ts`），用 `node:test` + `node:assert/strict`。
- **不 mock 全局**；注入 fake（`FakeGateway`、内存 registry、临时目录）。
- 真实 fs 集成测试用 `mkdtemp` 临时目录（见 `shell/cli/config/nodeConfig.test.ts`）。
- 纯逻辑抽纯函数（工具访问评估 access.ts、JSONC 解析、agent frontmatter 解析、legalize）。
- **分模块测试**（改哪测哪）：`npm run test:module -- "src/core/kernel/*.test.ts"`。各模块已隔离（无共享全局态、fs 用独立 mkdtemp），模块间无顺序依赖，可并发独立跑。

## 提交规范

- 提交前必须通过：`npm run typecheck`（0 错误，忽略 `reference/` 下错误）+ `npm test`（全绿）。
- `reference/` 目录下的 LSP/编译错误是参考代码噪音，**不要修改**，typecheck 结果以 `grep -v reference/` 为准。
- 提交身份：`git -c user.name="OwlCat" -c user.email="owlcat@local" commit`（沿用仓库习惯）。
- `TODO.md`、`prompts.md` 是需求记录，**不纳入提交**。
- 新增核心模块需同步更新 `docs/architecture.md` 与 `docs/log.md`。

## 常见陷阱

- `verbatimModuleSyntax: true`：类型导入必须 `import type`。
- `noUncheckedIndexedAccess: true`：数组索引访问可能为 `undefined`，需判空。
- core 错误用判别联合对象（`{ kind: ... }`），不是 Error 实例；`assert.throws` 用谓词而非正则。
- `jsonc-parser` / `yaml` 是运行时依赖（`dependencies`），tsx/node 运行时直接使用。
- 改动 `ToolKind` / 工具 shape / `AgentClass.tools` 时，同时检查 `shell/cli/tools/` 与 `src/core/tools/`。
- `AgentClass`：name 即模板键；`tools` 为 `Record`（键即白名单=自我限定，空 Record=全部本地 deny、undefined=完整继承父档案），不再是数组 + 独立 toolAccess。
- `AgentInstance`：无 creatorId；族谱关系用 parentId。
- **权限一律走台账**：`lineage/AccessLedger` 是唯一权限变更/查询面（bind/rebind/unbind + effectiveAccess/profileOf）；tools/inspect 只经 `AccessResolver` 查询——**禁止**再拼 accessLayers（`ToolContext` 已无该字段，旧"分层取严"代码是回归源头）。
- **grant 是系统特权通道**（策略 spawn / pilot 初始化；`InstantiateOptions.accessMode` 不得出现在 `agent_instantiate` 工具参数里——模型永远只能收敛）。
- `config.user.permission` 给出 = **整表替换**默认表：误删 `access_reply` 会锁死 ask 消息化（根答复义务）。
- 面板注册（`assemble:false`，含 user0 / 策略 role）恒绑 none 策略：不触发 process、不注入策略 note；`contextStrategy` 字段仅对真跑 LLM 轮的 agent 有意义。
- compact 触发点在管理员 wake 链内（user_prompt 抵达 → process → 就绪才 notifyReady）：策略实现必须自带重入 guard 与失败兜底，**绝不抛出到送信链路**。
- 持久化端口是**同步**接口（对齐 `node:sqlite` DatabaseSync 与仓库同步读）：写穿在内存生效后落行，`turnCount/totalCost` 引用直改不经装饰器，随下次状态快照收敛（可接受边界）。
- 运行依赖 tsx（无扩展名相对导入 + `.stem/tool/*.ts` 动态 import）：tsx 属运行期必需（打包/镜像勿按 devDependency 剔除）；node >= 23.4（node:sqlite）。
