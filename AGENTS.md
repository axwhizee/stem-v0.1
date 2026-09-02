# AGENTS.md

## 项目概览

**stem**（Self-Training Evolutionary Matrix）—— 独立原型验证项目：以**原子化 AgentClass（模板）+ Agent 实例**为核心的 Agent 系统。核心目标是从 VSCode 剥离、宿主无关（core 零平台依赖）。

- 定位：不是"把 opencode 塞进 VSCode"，也不是单 Agent 会话容器；是**用户主权的 Agent 系统**——类可自由创建/实例化，配**族谱树**与多 agent 协作，让 AI 自己管理 Agent 信息实现自我进化。
- 参考源码在 `reference/`（deepseek-harness、pi、opencode、VSCode），**仅作参考，非本项目产物**，其类型/编译错误可忽略。
- 工程纪律（分层契约/命名/错误/测试/提交/环境陷阱全表）在 **`docs/contributor.md`——动手前通读**；文档维护本身也受其 §1 纪律约束（实况卷禁补丁式更新，过时即整节重写）。

## 设计原则（硬规则）

1. **全体 agent 绝对平等**：user0 是内置 `user` 类的普通实例（`parentId=null` 即根），
   无任何权限/身份特判（根的可见性 = 树结构天然全视、审批权 = 类表 `access_reply` 答复义务，
   皆结构性事实非特权）；根唯一独有的是**面板性**——`parentId=null` 经 kernel 根接线
   `assemble:false`（不组装不跑 LLM 轮，信件由扮演它的外部 shell 消费），是"扮演接口"的
   身份而非特权；一切差异仅由类/实例配置与族谱收敛产生。
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
   = user0 根类清单（缺省 DEFAULT_USER_TOOLS 整表：管理/上下文/总线/观测面 allow、类书写与
   terminate 高危 ask、bash/websearch/webfetch 对外操作面 allow——以 `userClass.ts` 表为准）。
   **S6/R6 全参数统一解析律**：生效模型 = 显式（实例行）> 类基因 > 父继承 > 家学（user.model 必填
   锚点；attach 同批物化、Runtime 经 resolveModel 单点取快照、setModel 不级联子女——族规=出生快照，
   快照随实例行持久跨重启）——模型与权限同门面，无第二套通道。
4. **模块自治**：初始化/装配在 core（平台能力经接口注入，core 零平台依赖、可独立运行）；
   shell 只做平台适配 + UI；外部与 core 的一切交互经模块接口（pilot 为 user0 扮演接口）。
5. **少即是多**：工具生命周期（`init`）扩展优先于新建子系统；internal 工具列表不固化、随开发增长。
6. **架构分层**：`shell`（交互层，最外）→ `core`（agents 生态 + 系统工具 + bash，
   即最小系统）→ `extension`（可选功能扩展 = 矩阵 extension 层：tools/agent/context 目录形态资源）。
7. **对外操作面 = bash 单点**：无扩展时，除系统工具外模型触达外部文件/系统的唯一入口是
   core 的 bash 工具（执行经 `ShellRunner` 端口由宿主注入，core 零平台依赖）。**无 ask、
   无黑名单**（对齐 pi：高频工具询问打断循环得不偿失）——事故半径靠超时/输出截断/默认 cwd
   三机制，行为规范靠提示词与专职工具分担，不给 shell 靠白名单不列键。**容器即边界**：
   发布形态下挂载 volume 就是爆炸半径，不建议裸机对外暴露 webui。

## 快速命令

```bash
npm install                 # 安装依赖（node >= 23.4，node:sqlite 免 flag）
npm run typecheck           # tsc --noEmit 类型检查（唯一 lint/typecheck；reference/ 噪音 grep -v 掉）
npm test                    # 全量单测：tsx --test src/shell/extension 三层 *.test.ts
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑（node:test 并发）
npm run test:feas           # 可行性冒烟离线档（test/feasibility，mockSse 零密钥）；
                            #   在线两档需 ALIBABA_API_KEY=<key>（真网关/双服务，见 contributor §6.2）
npm run shell               # CLI shell：cwd 即空间（opencode-style；`-- <path>` 指定目录）
ALIBABA_API_KEY=<key> npm run shell   # 真实网关（密钥只走 env：config providers.<p>.key_env 声明变量名）
npm run web                 # WebUIShell（http://localhost:4321；空间定位同上，`-- <path>`/STEM_PROJECT_ROOT）
npm run dashboard -- [path] # 空间仪表盘（http://localhost:4421；法医/管理员 shell：DB 只读直查 +
                            #   标本装配资源清单 + 清理；--allow-write 才解锁写操作，可与 webui 并开）
npm run build               # 与 typecheck 相同（tsc --noEmit）
python3 run-docker.py       # 容器一键起（Windows/WSL 双端：读用户 env 密钥 + 卷管理 + 配置安检）
docker build -t stem:1.0 . && docker run -d -p 4321:4321 -v stem-data:/data stem:1.0   # 发布形态
docker run -d -p 4321:4321 -v stem-data:/data -e <providers 声明的 key_env 名>=<key> stem:1.0   # 真实网关
```

## 项目结构

```text
src/core/                  # 纯 TS 领域逻辑，零平台依赖（D11 硬规则）
  ├── config/              # 全局配置：StemConfig 类型 + JSONC 解析 + defaults.ts（首启模板 = 唯一预设的
  │                        #   数据形态）（唯一配置文件 .stem/stem.jsonc；providers 注册表（base_url/
  │                        #   key_env/models）/ user 对象（含 model 家学锚点，必填）/ maxSteps / context
  │                        #   块 / bash 块 / extensions 分键对象（tools/agent/context 点名清单）；无镜像键——目录即真相；
  │                        #   R12 全量有效：未知顶层键 fail-fast，custom 唯一扩展位）
  ├── context/             # 重建邮局：仓库 Repository + 管理员 ContextManager + 快递员 Courier
  │                        #   + tag/双索引 + exportJsonl/overview + legalize（组装合法化）
  │                        #   + store.ts（MessageStore 端口）+ persisted.ts（write-through 装饰器）
  │                        #   + strategies/（上下文策略子模块：契约+注册表+classic/none；
  │                        #     process/assemble 两段式、compact、模块扮演 agent、.stem/context 加载）
  ├── events/              # PilotEvent 判别联合 + EventHub（多订阅者事件中心）
  ├── gateway/             # ModelGateway 接口 + providers/(openaiCompatible：零端点常量/零 env 读取，
  │                        #   baseUrl + 可选 apiKey + models 白名单) + FakeGateway；路由门面在宿主 buildGateway(config,env)
  ├── init/                # 系统初始化与装配：createStemSystem（组合根）+ runInit 矩阵装载
  │                        #   （tools/agent/context 三类 × extension 点名 + custom 扫描 → 注册 core；
  │                        #     目录即真相，config 只在首次自举默认模板、永不回写）
  │                        #   + agentParse/agentSerialize（类文件双向：解析 + 落盘序列化）
  ├── kernel/              # Kernel + builtin/（内置占位类 JSON = internal 类层：Assistant 无 tools 键
  │                        #   = 完整继承父档案）+ TemplateRegistry/InstanceManager/SpaceManager/
  │                        #   Runtime + userClass（内置 user 类 + DEFAULT_USER_TOOLS，user0 采用）
  │                        #   + store.ts（InstanceStore 端口）+ persisted.ts（实例/空间写穿装饰器）
  ├── lineage/             # 族谱树门面 LineageTree（三相合一：拓扑实时推导 +
  │                        #   能力物化 attach/detach/replay + effectiveAccess/profileOf +
  │                        #   modelOf/setModel/nodeConfigOf（四级律出生物化+快照） + 可见域 canReach）；
  │                        #   AccessLedger 降为内部实现（算法/语义矩阵不变，不入库纯派生）
  ├── logging/             # LogEvent 判别联合 + Logger（经注入 LogSink，无总线）
  ├── pilot/               # Pilot：user0 扮演接口（驾驶舱；sendMessage/instantiate(可带 model)/
  │                        #   setModel/replyAccess/runContextAction/订阅事件流）
  ├── tools/               # ToolCapabilityRegistry（含 init 生命周期；materialize/execute 经
  │                        #   AccessResolver 端口查询族谱树）+ access.ts（四态纯代数 restrict）
  │                        #   + accessRequest.ts（ask 消息化：投递根信箱 + access_reply +
  │                        #     per-agent ask 豁免备忘）+ bash.ts（bash 工具 + ShellRunner 端口：
  │                        #     最小系统唯一对外操作面，无 ask 无黑名单，超时/截断限事故半径）
  └── types.ts
shell/                     # 宿主层（node/CLI + Web），实现 core 注入的接口
  ├── cli/                 # 参考 shell：platform.ts（bootStem 共享装配 + extension 资源根注入 +
  │                        #   bash runner）+ gateway.ts（providers 路由两段式）+ storage/（SQLite
  │                        #   端口实现，v2 根伪空间归并）+ CLI 命令（stem [path] 空间定位）
  │                        #   + mockSse.ts（OpenAI 兼容 SSE mock 服务器：纯测试/冒烟支撑）
  ├── dashboard/           # 空间仪表盘 shell（与 webui 并列零耦合）：db.ts 只读直查（族谱/token 账目/
  │                        #   语料/原表——write-through 行即运行态镜像）+ inventory.ts 标本装配
  │                        #   （bootStem stateStore:false 纯内存，三态清单+策略面=矩阵真实结果）+
  │                        #   cleanup.ts 清理（孤儿 GC/terminated GC/定点 purge/VACUUM，
  │                        #   --allow-write 只读门禁 + confirm 双确认）+ public/ 前端（复用 view.js）
  └── webui/               # WebUIShell：HTTP + SSE 浏览器交互层（OLED 主题，第一视角：
                           #   view.js 纯函数核心[汉字三态字形/routeLetters 信箱归位/computeTreeRows
                           #   git 风族谱行序/deriveActions 能力事实驱动，双端共用可 node 直测] +
                           #   SVG 泳道族谱侧栏（行=id·最近任务·状态字，点行直达）+ header 模型行
                           #   （origin 徽标 + /api/models 候选即切）+ 审面板 + 空桌引导；/api/health）
extension/                 # 矩阵 extension 层：tools/agent/context 目录形态资源（<名>/<名>.<ext> 入口
                           #   （可工厂形），附属脚本自由放置；config.extensions 分键点名启用；
                           #   住户：tools fs 五件套 + websearch/webfetch + _lib/ 共享辅助；agent creator）
test/                      # 跨模块可行性冒烟（非 node:test；npm run test:feas，见 contributor §6.2）
test/                      # 测试工作区：support/（kernelHarness 内存+FakeGateway+手动计时器）+
                           #   mockSse 兼容再导出（产品无 mock 回落——离线冒烟 = mockSse 作匿名
                           #   provider 入测试 config）
                           #   演示空间 test/space-demo/（.stem/ 配置 + custom 工具示例）；
                           #   验收现场 test/space-v10/（opencode 网关执行场）
docs/                      # 设计文档（实况卷/历史卷二分见 contributor §1）：
                           #   实况卷 architecture.md（实际架构，以此为准）/ api.md（接口清单，对拍冻结）/
                           #   dev-guide.md（扩展点全景+食谱）/ contributor.md（工程纪律）/ llm-playbook.md（LLM 实测反馈+提示词指南）/
                           #   历史卷 log.md（开发日志）/ evolution-plan.md（§5 brain_enhanced 记忆策略方案 S7 候选，§9 目标-达成度存档）/
                           #   阶段 plan 卷（实施期的执行依据，不回改；落地即随下一功能提交删除）/
                           #   scenarios.md（目标场景清单，6 条+自检）/ prompts.md（需求记录，不纳入提交）
```

## 核心架构要点

### Core 零平台依赖（最高优先级硬规则）

- `src/core/` 内**禁止** `import 'vscode'`、禁止平台全局（`window`/`process`/`Deno`）。
- 平台能力（fs、动态 import、网络）全部**以接口暴露、由宿主注入**：如 `ConfigStore`、`InitFs`、`InitToolLoader`、`ModelGateway`、`LogSink`、`TimerFactory`、工具 `init` 的 `ToolInitFs`。
- 跨层引用**只能 import `index.ts`**（禁止 import 内部文件）。
- 接口 + 实现同文件（`interface X` + `DefaultX`），模块目录含 `index.ts` 唯一出口。

### 核心模型

- **AgentClass（模板）**：`name` 即 id（注册查重）；`description`；`systemPrompt`；`tools`（`Record<访问键, ask|deny|allow|ignore>`，**键即白名单=自我限定**，空 Record=本地封闭、**未设（undefined）=完整继承父生效档案**——internal 占位类 assistant 即此形）；`contextStrategy`（默认 classic，开辟上下文空间时确定）；`model`；`sendCountdown`；`panel`（true = 模块扮演面板：不组装不跑 LLM，策略 role 携带；user0 的面板性走根接线，见原则 1）；`custom`（自由扩展位）。
- **AgentInstance**：`id` / `classRef`（模板名）/ `parentId`（= 创建者，user0 为 null 即根）/ `displayName` / `spaceId` / `status` / `turnCount` / `totalCost` / `userPrompt` / `toolOverride` / `model`（模型显式层）/ `modelSnapshot`（出生快照，族规跨重启）——后两者随实例行 JSON 持久（零 schema 迁移）。**creatorId 已合并进 parentId**（谁创建谁就是父），运行时属性多于工具调用参数。
- **状态机**：`idle → thinking → holding`；`interrupted`（当前轮被中断，仅暂停、消息闭合、可恢复）。
- **族谱树（LineageTree，S5.1 门面 + S6 配置相）**：实例层派生事实唯一面——拓扑（parentId 挂实例实时推导）+ 能力（权限台账物化 + **模型配置相**：显式>类基因>出生快照>父继承>家学 四级律 attach 物化 ModelBinding{ref,origin}，modelOf/setModel（不级联）/nodeConfigOf，见原则 3）+ 可见域 `canReach`（销毁/中断/上下文/telemetry/set_model 统一谓词；有活跃子默认拒销毁，recursive 级联）；红线：纯派生不入库（显式/快照的持久载体在实例行，kernel 装载传入）、零运行时状态、零类层依赖（原始层输入由 kernel 算好传入）。
- **重建邮局（无总线）**：仓库（存储）→ 管理员（打戳/策略 process/组装/context_wait 填充/信箱配对）→ 快递员（倒计时送信，**只发不组装**——送信快照经管理员按策略委托构造）；agent 通信经 `kernel.sendMessage` 直接投递；log/access_reply 走注入接口。
- **上下文策略（context/strategies/）**：每种策略 = 独立子模块（契约 `ContextStrategyModule`：note/role/assemble/process/actions）；触发点 = user_prompt 信件抵达，终点 = 就绪后唤醒快递员（process 异步许可、assemble 纯函数，重入合并、失败兜底不卡死）；classic = 全量直出 + opencode 式 compact（轮边界、摘要 worker 邮局正规往返、markInvalid 归档可逆）；策略需要造 agent 时用**模块扮演 agent**（role 挂宿主下、panel 态、worker 用完 terminate 归档，回信经 waitForReply 配对）；用户策略 `.stem/context/*.ts` 可覆盖内置。
- **个体层持久化（SQLite write-through）**：core 端口 `MessageStore`/`InstanceStore`（+内存默认实现）+ 装饰器（PersistedRepository/InstanceManager/SpaceManager，内存为准同步落行）；宿主注入 node:sqlite 实现（`shell/cli/storage/`，默认 `.stem/stem.db`，`createSqliteStateStore(file, project)`，user_version **v2**：根伪空间归并迁移）。**空间语义（S6/R3/R11）**：`.stem` = 世界——一进程一空间一库；opencode-style 定位 `stem [path]` > env > cwd；单实例 = 约定非机制（无锁）。**terminate 归档消息保留语料**；重启恢复 = 装载 + 状态归一化（thinking/holding→interrupted）+ 计数器续接 + 族谱树能力相 replay 重放 + 快递员 lastSentIds 预置（零重放）；类层持久仍走文件，不进 DB。
- **进化书写与观测（S5.2，1.0 人启动闭环）**：`agent_class_create`（新名 = 变体并存）/ `agent_class_update`（同名覆盖；tools 增量 patch、逐键只许收敛 `checkToolsConvergence`——类层为继承形（undefined）时无类层基线，扩张由台账物化兜底；panel/user 根类拒绝；**只影响后续实例**——已物化档案不追改）经 `ClassStore` 端口落盘 `.stem/agent/`（core `agentSerialize` 往返律 + 宿主 `ClassFs` IO，panel 永不回写红线）——目录即真相，进化跨重启生效；`telemetry_query`（internal 缺省 ignore、user0 默认 allow）按树可见域（自身 + 后代）查全部运行日志，行式压缩；审计事件 `kernel.class.registered/updated`（persisted + 发起者归属）。
- **模型自由三环（S6）**：实例化 `model` 参（出生显式）/ 类基因 `AgentClass.model` / 运行时 `agent_set_model`（internal 缺省 ignore、canReach、审计 `kernel.model.set`）+ `pilot.setModel`（宿主通道）；`agent_inspect` 出示 NodeConfig 整像（origin 四态谱系：实例显式/类基因/父继承/家学；家学下传保持 origin=home 的 blame 语义）；改模型 = 下轮送信生效、不级联子女；`context.compact.summarizeModel` 为摘要 worker 类基因位（缺省继承宿主档案）。
- **事件流（PilotEvent）**：`stream`（LLM 流式）/ `letter`（信箱来信，含 access_request）/ `status`（from→to 迁移）/ `notice`，经 EventHub 多订阅者发布，外部（shell/webui）统一订阅。

### 工具体系与访问

- `ToolKind` 三分类（矩阵）：`internal`（core 系统工具 + bash，默认 `ignore` 隐藏）/ `extension`（`extension/tools/` 目录形态，`config.extensions.tools` 点名启用）/ `custom`（用户 `.stem/tools/` 自动扫描；平铺 + 目录双形态）。**系统级 skill 子系统已废除**：SKILL.md 兼容 = custom 工具约定（`.stem/tools/skill/`）。
- `ToolAccess` 四态：`allow`（暴露+执行）/ `ask`（暴露+执行弹窗）/ `deny`（不暴露+拒绝）/ `ignore`（不暴露+等同 allow）。
- **权限查询（台账物化）**：生效权限注册期由 `AccessLedger` 物化（converge 减法默认 / grant 加法系统特权，见原则 3）；tools 侧 `materialize(agentId)`/`assert` 经 `AccessResolver` 端口查询，无判定落默认（internal ignore / 其余 ask）；**ToolContext 不含权限层**。
- **ask 消息化（扁平化）**：命中 ask 时 `accessRequest` 自动投递 `<access_request>` 消息到**申请者的族谱根信箱**（机制同向模型发消息）并挂起；根 agent 经 `access_reply` 工具回复（once/always/reject）。无 agent 特判（user0 的 ask 发给自己，由扮演它的 shell 经 pilot 确认）。always = **per-agent ask 豁免备忘**（只免询问，非权限层）。
- **工具生命周期**：`ToolCapability.init?(ctx)` 参与系统初始化（ctx = `{fs?, projectRoot?, log?}`，空间感知/资产预热类需求）；`registry.initAll(ctx)` 装配后调用一次、幂等、工具间禁跨依赖。

### 消息库：tag + 双索引

- `StoredMessage`：`id / agentId / message / at / tokens / valid / from? / tag? / turn / indexInTurn`。
- **token 计量双标记**：tag=是什么（strategy 写合成消息），tokens=多大（网关真实值优先——assistant 行直记 usage.output、tool/user 行按相邻请求 input 差分归位（Runtime→contextManager.attributeUsage，负差护栏回落估算、基线内存自愈）；估算 chars/4 兜底）。`Repository.setTokens` 静默修订（不触发 onChange）。
- **tag**（可选）：标记非原生合成消息（如 summary/impression/meta）；**strategy 是上下文属性**（实例化时确定），组装器按 agent 的策略解释 tag。
- **双索引**：`turn` = 轮序号（复用 turnCount 语义：user 消息开启新轮）、`indexInTurn` = 轮内序号；Repository 自动维护。

### 全局配置与初始化（唯一配置文件）

- 配置文件：`<projectRoot>/.stem/stem.jsonc`（或 `stem.json`），是**最终配置载体**，本阶段无多级合并。
- 配置项（**R12 全量有效原则：未知顶层键 boot fail-fast**，历史 model/tools/agents/strategies 键报错并指路；`custom` 唯一扩展位）：**`providers`（模型提供商注册表：`base_url` 必填 http(s) / `key_env` 密钥环境变量名（配置文件永不承载明文密钥；缺省=匿名端点）/ `models` 启用白名单——一切模型引用的 provider 必须在此注册）**、`autoApprove`、**`user`（user0 内嵌 agent 类完整对象：description/systemPrompt/tools/contextStrategy/**model=家学锚点（必填，boot 硬校验）**/sendCountdown；tools 给出整表替换 DEFAULT_USER_TOOLS）**、`maxSteps`、**`context`（window + compact{enabled/threshold/keepRecentTurns/summarizeModel/instruction/replyTimeoutMs}）**、**`bash`（path/defaultTimeoutMs/maxOutputChars/cwd）**、`extensions`（分键对象 `{tools?,agent?,context?}`=extension 目录点名清单；tools 缺省=fs 五件套、显式 `[]`=纯 bash；旧数组形态 fail-fast 指路）、`sendCountdown`。**目录即真相** + **config 即全部配置**（R12）；无顶层 `model`（链拆除），首启缺文件 = `defaultStemConfig()` 内存等效 + `DEFAULT_CONFIG_TEXT` 落盘（唯一预设 opencode-go 是模板数据非代码常量）。
- **系统装配**（`createStemSystem(deps)`，core 组合根）：config（缺失=defaultStemConfig；**家学硬校验 config.user.model**）→ 工具注册表 + Kernel（user 类 = config.user 对象，contextSettings/maxSteps/**project（空间身份，根挂真实空间）**注入；注入 `stateStore` 时 Kernel 内恢复+套写穿装饰器+台账&模型相拓扑重放）→ 系统工具 → bash 工具（注入 `shellRunner` 端口才装配）→ `runInit` 矩阵装载（extension 点名 + custom 扫描，后层同名覆盖前层；extension 根由宿主注入）→ Pilot 初始化（实例化 user0；已恢复则幂等跳过）→ `initAll`（fs/projectRoot/log 注入）→ 用户注入钩子。**网关在宿主侧装配**：bootStem 按 config.providers 建 `buildGateway(config, env)` 路由门面（R1 两段式：key_env 未命中启动 warn 点名 + 用到才硬错）。
- `runInit` 矩阵管线：三类资源 × 两来源层统一装载——extension 层按 `config.extensions.<种类>` 从宿主注入的 `extensionRoots` 装载目录形态条目（工具入口 default 可为 `ToolCapability` 或工厂 `(projectRoot) => ToolCapability`）；custom 层扫描 `.stem/{tools,agent,context}/`（平铺兼容 + `<名>/<名>.<ext>` 目录优先）。装载序 internal → extension → custom，**后层同名 replace 覆盖**；注册进 `ToolCapabilityRegistry` + `TemplateRegistry` + 策略注册表。**目录即真相：config 只在文件不存在时写默认模板，管线此后纯只读、永不回写**。
- **用户 agent 文件**：文件名即类 id/name（不要求 YAML id/name）；`tools` 的键即工具清单（融合设计，工具=键、动作=值；缺 tools 键 = 继承形）；已知可选键 `context_strategy`/`model`；**其余未知字段透传 `AgentClass.custom`**（自由式 frontmatter）。
- **user0**：`user` 类的普通实例（内置根模板，`parentId=null`），人格与权限面全部经 `config.user` 声明式可配；在 pilot 初始化流程内实例化；**面板态不跑 LLM 轮**（与子实例的一切对话经 pilot 扮演收发的信箱信件）；系统 ready 后由用户经 pilot 手动实例化后续 agent。

### 测试与提交（纪律全文见 docs/contributor.md）

- 单测同目录 `*.test.ts`（node:test，不 mock 全局、注入 fake、真 fs 用 mkdtemp）；跨模块机制动过跑 `npm run test:feas`。
- 提交门槛 typecheck 0 + 测试全绿；commit message **只描述功能变化、禁进度代号**；实况卷按 contributor §1.3 对拍表整节审视。
