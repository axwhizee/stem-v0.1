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
   由族谱树能力面注册期物化（attach/replay，内部 = AccessLedger 算法，S5.1 门面合一；
   继承→收敛两步，标准形 {explicit, fallback}）；跨 agent 操作统一走树谓词 canReach（自身∨祖先代查）；
   tools 经 `AccessResolver` 端口查询（不随身传层、kernel 无编排）。**键即白名单=自我限定**
   （未列=本地 deny，祖先匿名封闭不下传；祖先**显式** deny/ask 锁子孙，`deny≺ask≺allow/ignore`
   不可撤销）；`grant` 加法 = 系统机制特权（整表替换+未列一律 deny+显式 deny 铁律鉴权，
   模型工具路径不可达）；session always = **ask 免询问备忘**（非权限层）。config.user.tools
   = user0 根类清单（缺省 DEFAULT_USER_TOOLS 含 access_reply 根义务 + bash 对外操作面 +
   telemetry_query 观测 allow + agent_class_create/update 书写 ask）。
4. **模块自治**：初始化/装配在 core（平台能力经接口注入，core 零平台依赖、可独立运行）；
   shell 只做平台适配 + UI；外部与 core 的一切交互经模块接口（pilot 为 user0 扮演接口）。
5. **少即是多**：工具生命周期（`init`）扩展优先于新建子系统；internal 工具列表不固化、随开发增长。
6. **架构分层**：`shell`（交互层，最外）→ `core`（agents 生态 + skill + 系统工具 + bash，
   即最小系统）→ `extension`（可选功能扩展，典型：扩展工具集）。
7. **对外操作面 = bash 单点**：无扩展时，除系统工具外模型触达外部文件/系统的唯一入口是
   core 的 bash 工具（执行经 `ShellRunner` 端口由宿主注入，core 零平台依赖）。**无 ask、
   无黑名单**（对齐 pi：高频工具询问打断循环得不偿失）——事故半径靠超时/输出截断/默认 cwd
   三机制，行为规范靠提示词与专职工具分担，不给 shell 靠白名单不列键。**容器即边界**：
   发布形态下挂载 volume 就是爆炸半径，不建议裸机对外暴露 webui。

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
docker build -t stem:1.0 . && docker run -d -p 4321:4321 -v stem-data:/data stem:1.0   # 发布形态
docker run -d -p 4321:4321 -v stem-data:/data -e OPENCODE_API_KEY=<key> stem:1.0   # 真实网关
```

## 项目结构

```text
src/core/                  # 纯 TS 领域逻辑，零平台依赖（D11 硬规则）
  ├── config/              # 全局配置：StemConfig 类型 + JSONC 解析（唯一配置文件 .stem/stem.jsonc；
  │                        #   user 对象（tools 键）/ maxSteps / context 块 / bash 块 / extensions 数组；
  │                        #   S4.2 起无 tools/agents/strategies 镜像——目录即真相）
  ├── context/             # 重建邮局：仓库 Repository + 管理员 ContextManager + 快递员 Courier
  │                        #   + tag/双索引 + exportJsonl/overview + legalize（组装合法化）
  │                        #   + store.ts（MessageStore 端口）+ persisted.ts（write-through 装饰器）
  │                        #   + strategies/（上下文策略子模块：契约+注册表+classic/none；
  │                        #     process/assemble 两段式、compact、模块扮演 agent、.stem/context 加载）
  ├── events/              # PilotEvent 判别联合 + EventHub（多订阅者事件中心）
  ├── gateway/             # ModelGateway 接口 + providers/(opencodeLlm / fetch) + FakeGateway
  ├── init/                # 系统初始化与装配：createStemSystem（组合根）+ runInit 扫描管线
  │                        #   （.stem/tools + .stem/agent + .stem/context → 注册进 core；
  │                        #     目录即真相，config 只在首次自举默认模板、永不回写）
  │                        #   + agentParse/agentSerialize（类文件双向：解析 + S5.2 落盘序列化）
  ├── kernel/              # Kernel + TemplateRegistry/InstanceManager/SpaceManager/
  │                        #   Runtime + userClass（内置 user 类 + DEFAULT_USER_TOOLS，user0 采用）
  │                        #   + store.ts（InstanceStore 端口）+ persisted.ts（实例/空间写穿装饰器）
  ├── lineage/             # 族谱树门面 LineageTree（S5.1 三相合一：拓扑实时推导 + 能力物化
  │                        #   attach/detach/replay + effectiveAccess/profileOf + 可见域 canReach）；
  │                        #   AccessLedger 降为内部实现（算法/语义矩阵不变，不入库纯派生）
  ├── logging/             # LogEvent 判别联合 + Logger（经注入 LogSink，无总线）
  ├── pilot/               # Pilot：user0 扮演接口（驾驶舱；sendMessage/instantiate/
  │                        #   replyAccess/runContextAction/订阅事件流）
  ├── tools/               # ToolCapabilityRegistry（含 init 生命周期；materialize/execute 经
  │                        #   AccessResolver 端口查询族谱树）+ access.ts（四态纯代数 restrict）
  │                        #   + accessRequest.ts（ask 消息化：投递根信箱 + access_reply +
  │                        #     per-agent ask 豁免备忘）+ bash.ts（bash 工具 + ShellRunner 端口：
  │                        #     最小系统唯一对外操作面，无 ask 无黑名单，超时/截断限事故半径）
  │                        #   + SkillRegistry + skill 工具
  └── types.ts
shell/                     # 宿主层（node/CLI + Web），实现 core 注入的接口
  ├── cli/                 # 参考 shell：platform.ts（bootStem 共享装配 + TOOL_SETS 解析 + bash
  │                        #   runner）+ gateway + fs 工具集（read/write/edit/grep/glob，tool_set）+
  │                        #   storage/（SQLite 端口实现）+ CLI 命令
  └── webui/               # WebUIShell：HTTP + SSE 浏览器交互层（OLED 主题；agent 侧栏/timeline/
                           #   composer/ask 弹窗/compact/销毁；/api/health）
extension/                 # 可选功能扩展（tool_set 包落位；config.extensions 选择、宿主解析注入）
templates/                 # 内置 AgentClass 模板（JSON，name 即 id，tools 为 Record）
test-support/              # 测试支撑：kernelHarness.ts（内存 + FakeGateway + 手动计时器）+
                           #   mockSse 兼容再导出（正身 shell/cli/mockSse.ts = 无 key 产品回落，
                           #   Docker 实跑后归位——镜像只 COPY src/shell/extension/templates）
tmp/                       # 测试项目空间（.stem/ 配置 + 用户 tools/agent 示例）
docs/                      # 设计文档：architecture.md（实际架构，以此为准）/ log.md（开发日志）/
                           #   evolution-plan.md（S5 方案冻结；S5.1 族谱树/S5.2 观测书写已落地，
                           #   S5.3 调度与 S5.4 dreaming 待实施；进度以 log.md 为准）/
                           #   s6-plan.md（S6 定稿：零兜底网关/模型族谱/space 分级持久化/
                           #   第一视角 WebUI；R1-R14 裁决记录——实施批 1~2 按此执行）/
                           #   code-style.md / scenarios.md（目标场景清单，6 条+自检）/
                           #   prompts.md（需求记录，不纳入提交）
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
- **族谱树（LineageTree，S5.1 门面）**：实例层派生事实唯一面——拓扑（parentId 挂实例实时推导）+ 能力（台账物化，见原则 3）+ 可见域 `canReach`（销毁/中断/上下文/telemetry 统一谓词；有活跃子默认拒销毁，recursive 级联）；红线：纯派生不入库、零运行时状态、零类层依赖。
- **重建邮局（无总线）**：仓库（存储）→ 管理员（打戳/策略 process/组装/context_wait 填充/信箱配对）→ 快递员（倒计时送信，**只发不组装**——送信快照经管理员按策略委托构造）；agent 通信经 `kernel.sendMessage` 直接投递；log/access_reply 走注入接口。
- **上下文策略（context/strategies/）**：每种策略 = 独立子模块（契约 `ContextStrategyModule`：note/role/assemble/process/actions）；触发点 = user_prompt 信件抵达，终点 = 就绪后唤醒快递员（process 异步许可、assemble 纯函数，重入合并、失败兜底不卡死）；classic = 全量直出 + opencode 式 compact（轮边界、摘要 worker 邮局正规往返、markInvalid 归档可逆）；策略需要造 agent 时用**模块扮演 agent**（role 挂宿主下、panel 态、worker 用完 terminate 归档，回信经 waitForReply 配对）；用户策略 `.stem/context/*.ts` 可覆盖内置。
- **个体层持久化（SQLite write-through）**：core 端口 `MessageStore`/`InstanceStore`（+内存默认实现）+ 装饰器（PersistedRepository/InstanceManager/SpaceManager，内存为准同步落行）；宿主注入 node:sqlite 实现（`shell/cli/storage/`，默认 `.stem/stem.db`）。**terminate 归档消息保留语料**；重启恢复 = 装载 + 状态归一化（thinking/holding→interrupted）+ 计数器续接 + 族谱树能力相 replay 重放 + 快递员 lastSentIds 预置（零重放）；类层持久仍走文件，不进 DB。
- **进化书写与观测（S5.2，1.0 人启动闭环）**：`agent_class_create`（新名 = 变体并存）/ `agent_class_update`（同名覆盖；tools 增量 patch、逐键只许收敛 `checkToolsConvergence`；panel/user 根类拒绝；**只影响后续实例**——已物化档案不追改）经 `ClassStore` 端口落盘 `.stem/agent/`（core `agentSerialize` 往返律 + 宿主 `ClassFs` IO，panel 永不回写红线）——目录即真相，进化跨重启生效；`telemetry_query`（internal 缺省 ignore、user0 默认 allow）按树可见域（自身 + 后代）查全部运行日志，行式压缩；审计事件 `kernel.class.registered/updated`（persisted + 发起者归属）。
- **事件流（PilotEvent）**：`stream`（LLM 流式）/ `letter`（信箱来信，含 access_request）/ `status` / `notice`，经 EventHub 多订阅者发布，外部（shell/webui）统一订阅。

### 工具体系与访问

- `ToolKind` 三分类：`internal`（core 系统工具 + bash + skill，默认 `ignore` 隐藏）/ `shell`（宿主注入，典型 = config.extensions 选装的 tool_set）/ `user`（用户 `.stem/tools/` 提供）。
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
- 配置项：`model`（`提供商/模型` 格式）、`autoApprove`、**`user`（user0 内嵌 agent 类完整对象：description/systemPrompt/tools/contextStrategy/model/sendCountdown；tools 给出整表替换 DEFAULT_USER_TOOLS）**、`maxSteps`、**`context`（window + compact{enabled/threshold/keepRecentTurns/summarizeModel/instruction/replyTimeoutMs}）**、**`bash`（path/defaultTimeoutMs/maxOutputChars/cwd）**、`extensions`（宿主 tool_set 包 id 数组，缺省 `["fs"]`、`[]`=纯 bash）、`sendCountdown`。**S4.2 起无 `tools`/`agents`/`strategies` 镜像字段——目录即真相**（旧键出现被解析丢弃）。
- **系统装配**（`createStemSystem(deps)`，core 组合根）：config → 工具注册表 + Kernel（user 类 = config.user 对象，contextSettings/maxSteps 注入；注入 `stateStore` 时 Kernel 内恢复+套写穿装饰器+台账拓扑重放）→ 系统工具 → bash 工具（注入 `shellRunner` 端口才装配）→ 宿主工具（bootStem 按 config.extensions 解析 tool_set）→ skill 工具 → `runInit` 扫描管线 → Pilot 初始化（实例化 user0；已恢复则幂等跳过）→ `initAll`（skill 发现）→ 用户注入钩子。
- `runInit` 管线：扫描 `.stem/tools/*.ts`（默认导出 `ToolCapability`）+ `.stem/agent/*.md`（YAML 头 + 正文）+ `.stem/context/*.ts`（默认导出 `ContextStrategyModule`，同名覆盖内置）→ 注册进 `ToolCapabilityRegistry` + `TemplateRegistry` + 策略注册表。**目录即真相：config 只在文件不存在时写默认模板，管线此后纯只读、永不回写**。
- **用户 agent 文件**：文件名即类 id/name（不要求 YAML id/name）；`tools` 的键即工具清单（融合设计，工具=键、动作=值；S4.2 起键名与 AgentClass.tools 齐平）；已知可选键 `context_strategy`/`model`；**其余未知字段透传 `AgentClass.custom`**（自由式 frontmatter）。
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
- **权限一律走族谱树门面**：`lineage/LineageTree` 是唯一权限变更/查询面（attach/detach/replay + effectiveAccess/profileOf；AccessLedger 是其内部实现，禁止 kernel 再直连台账）；跨 agent 操作一律 `canReach`；tools/inspect 只经 `AccessResolver` 查询——**禁止**再拼 accessLayers（`ToolContext` 已无该字段）。类书写（agent_class_create/update）与观测（telemetry_query）也同一等公民：ask 门 + 树可见域，无特权通道。
- **grant 是系统特权通道**（策略 spawn / pilot 初始化；`InstantiateOptions.accessMode` 不得出现在 `agent_instantiate` 工具参数里——模型永远只能收敛）。
- `config.user.tools` 给出 = **整表替换**默认表：误删 `access_reply` 会锁死 ask 消息化（根答复义务）。
- bash 无 ask 无黑名单：治理 = 超时/截断/默认 cwd 机制 + 提示词 + 白名单不列键；容器发布形态下**挂载 volume = 爆炸半径**，不建议裸机对外暴露 webui。
- 面板注册（`assemble:false`，含 user0 / 策略 role）恒绑 none 策略：不触发 process、不注入策略 note；`contextStrategy` 字段仅对真跑 LLM 轮的 agent 有意义。
- compact 触发点在管理员 wake 链内（user_prompt 抵达 → process → 就绪才 notifyReady）：策略实现必须自带重入 guard 与失败兜底，**绝不抛出到送信链路**。
- 持久化端口是**同步**接口（对齐 `node:sqlite` DatabaseSync 与仓库同步读）：写穿在内存生效后落行，`turnCount/totalCost` 引用直改不经装饰器，随下次状态快照收敛（可接受边界）。
- 运行依赖 tsx（无扩展名相对导入 + `.stem/tools/*.ts` 动态 import）：已列入 dependencies（S4.4，镜像 `npm ci --omit=dev` 不剔除）；node >= 23.4（node:sqlite）。
- webui 绑定：裸机缺省 127.0.0.1，容器设 `STEM_HOST=0.0.0.0`；扩展/镜像注册表已删除，新增工具能力按 tool_set 落 `TOOL_SETS` 清单或 `.stem/tools/`。
