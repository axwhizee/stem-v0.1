# stem

> **S**elf-**T**raining **E**volutionary **M**atrix —— 自我训练·进化·矩阵。
> 干细胞之意：如同原始 Agent 类，可分化出任意角色与能力。
> 抛弃会话概念：以**原子化 Agent 类 + Agent 实例**为核心，配合**族谱树**与模块化 harness 系统，构建可自我进化的多智能体集群。

**状态**：架构定稿，v1.0 发布前逐模块收敛（核心骨架 + 个体层持久化（schema v3）+ 上下文策略框架 classic/cortex + 族谱权限台账与出生声明 + 根配置对象化 + 身份代数（路径 id + 全局 name + 带时戳信件）+ bash 最小操作面 + extensions 点名装载）。发布进展与验证证据以 **git 提交历史** 为准（本文不再承载用例数/日期等易漂移数字）。

---

## 项目定位

- **用户主权的 Agent 系统**：
  - 一切 Agent 来自 **AgentClass（模板）**，用户自由创建/修改/删除/实例化，**绝不固定任何角色**。
  - 简单对话 = 简单类 + 空上下文实例；复杂任务 = 调度器类再创建子实例并传递上下文。
  - **族谱树**：所有 agent 一律平等（同地位独立个体），唯一区别是 `parentId`——根（`user` 类实例，全名 `user#0`，出生路径 id `0`）是原点（`parentId=null`）；父可销毁/中断子（`agent_terminate` 等 + 祖先校验）。
  - **工具访问四态**：allow/ask/deny/ignore；生效权限 = 族谱位置的函数（`AccessLedger` 注册期物化）——**键即白名单**（未列 = 本地 deny），祖先显式 deny/ask 锁子孙（不可撤销），session 批准仅为 ask 免询问备忘。
  - **元能力工具**（`agent_class_create` / `agent_inspect` / `agent_ancestry` / `agent_descendants` …）让 AI 自己管理 Agent 信息，实现自我进化（特修斯之船）。
  - **消息库 tag + 双索引**：为上下文管理策略（压缩/印象/记忆）提供定位，引导从经典组装走向自聚焦/记忆分层。
  - **Logging** 贯穿全系统，记录工具调用/API 请求/上下文组装，驱动评估与进化闭环。
- **Core 完全解耦**：core 层为纯 TS 领域逻辑，零平台依赖，所有平台能力经接口由宿主注入——已从 VSCode 剥离的独立项目。
- **AgentSpace**：按项目/工作区划分 agent 列表，UI 复用 session 模式但一条目 = 一个 Agent 实例，用户可实时观察与接管任何 Agent。

## 架构一图流

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Layer 3  shell/（交互层，最外）—— 平台适配 + UI                       │
│   cli/（bootStem + extensionRoots + bash runner + storage + CLI）     │
│   webui/（HTTP + SSE；三件套分文件；流式思维链/监督抽屉/占用条；/api/health） │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 2  core/（纯 TS，零平台依赖，自治最小系统）                     │
│   main/（createStemSystem 组合根 + runInit 装载）· kernel/（Kernel/实例/空间 │
│   pilot/（根 user#0 扮演接口）· events/（PilotEvent + EventHub）      │
│   lineage/（族谱纯关系视图）· context/（邮局 + legalize + 持久化端口）│
│   tools/（注册表 + access 四态 + accessRequest + bash 端口）          │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 1  Model Gateway (core/gateway/)   ← 纯 TS（opencode 隔离）    │
│   ModelGateway · providers/(openaiCompatible) · FakeGateway           │
└───────────────────────────────────────────────────────────────────────┘
   extension/{tools,agent,context}/  矩阵扩展层：目录形态资源（config.extensions 分键点名）
   横切  Logging (core/logging/) —— LogEvent 经注入 LogSink 直达记录器（无总线）
```

依赖方向（单向）：`shell → core(kernel/pilot/context/tools) → gateway`。core 目录零平台依赖（禁止 `import 'vscode'` 与平台全局）；平台能力（fs/网络/动态 import）全部以接口注入。

## 核心概念

| 概念 | 说明 |
|---|---|
| **AgentClass（模板）** | 角色设定：name（即 id）/ description / systemPrompt / **tools**（四态 Record，键即白名单）/ contextStrategy / model / sendCountdown / panel / custom——全量参数速查见下表。用户主权载体。 |
| **AgentInstance** | 运行时原子单位：**id**（出生路径，系统全托管：根 `0`，子 `<父id>-<序号>`，永不复用）/ classRef / **parentId**（=创建者，族谱）/ **name**（全局唯一称呼，呈现 `name#id`）/ status / turnCount / totalCost / totalTokens（终身累计，不受 compact 影响）。 |
| **族谱树 LineageTree** | 无状态关系视图：parentId 挂实例上，实时推导 children/ancestors/descendants；销毁权判定。 |
| **根（user#0）** | `user` 类普通实例（`parentId=null` 即根，无任何特判）；`config.user` = 其类配置完整对象（人格/权限/模型声明式可配 + `name` 出生称呼，缺省 'user'）。 |
| **工具访问 ToolAccess** | 四态 allow/ask/deny/ignore；生效权限 = 族谱位置的函数（`lineage/AccessLedger` 注册期物化：继承→收敛，键即白名单；grant 双门面：spawn 受限 / `agent_update.grantTools`），tools 经 `AccessResolver` 端口查询。 |
| **邮局** | 无集中式总线：仓库（存储）→ 管理员（打戳/策略处理/组装 + legalize）→ 快递员（倒计时+发送，只发不组装）。个体层经 MessageStore/InstanceStore 端口 write-through 落 SQLite（宿主注入），缺省纯内存。 |
| **上下文策略** | `context/strategies/` 独立子模块（契约：note/role/tools/assemble/process/actions/init；tools = 收敛链 raise 声明清单；process 触发=user_prompt 抵达、终点=就绪唤醒快递员）。classic = 全量直出 + compact（markInvalid 归档可逆）；cortex = 三层外挂记忆（LTM/笔记/STM）+ 阈值做梦二段事务（dreamer 回信交付、记忆组轮替、`.stem/mem/` 单向镜像）；`.stem/context/*.ts` 可加载用户策略（自我进化承载之一）。 |
| **ask 消息化** | ask 审批 = 消息交换：`access_request` 投递根信箱 → 根经 `access_reply` 回复（once/always/reject；always = per-agent 免询问备忘）。 |
| **PilotEvent** | 统一事件流（stream/letter/status/tool/notice）+ EventHub 多订阅者；外部（shell/webui）订阅。 |
| **tag + 双索引** | StoredMessage 带 tag（非原生合成消息）+ turn/indexInTurn（双索引），为上下文策略提供精确定位。 |

## AgentClass 参数速查

**类参数**（AgentClass 全字段——四个产生通道同形：`.stem/agent/*.md` / `config.user` / 策略 spec / `agent_class_create/update`；S9 起类定义统一为唯一形状，加字段全通道自动生效）：

| 参数 | 必填 | 语义 | 生效点 |
|---|---|---|---|
| `name` | ✓ | 类名即 id（`makeAgentClassID`，注册查重；`.stem/agent/<名>.md` 文件名即 id） | 模板键 / 实例 classRef |
| `description` | ✓ | 类用途一句话 | agent_list/inspect、进化素材 |
| `systemPrompt` | ✓ | 人设正文 | 实例化注册进仓库 system 行（策略 note 追加其后） |
| `tools` | – | 四态 Record<键, deny/ask/allow/ignore>；**未设 = 完整继承父档案；空表 = 本地封闭并显式锁子孙**；键即白名单 | 族谱台账注册期物化 |
| `contextStrategy` | – | 策略名（缺省 classic；未知类注册期 fail-fast；实例化固化为上下文属性） | ContextManager 注册 |
| `model` | – | 类基因（四级律第 2 层：显式实例行 > **类基因** > 父继承 > 家学锚点） | lineage ModelBinding |
| `sendCountdown` | – | 送信倒计时 ms（缺省 = 全局 config.sendCountdown） | 快递员 |
| `panel` | – | true = 模块扮演面板（不组装、不跑 LLM 轮；策略 role 承载）。根的面板性不经此字段（kernel 根接线的结构性事实） | 注册接线 |
| `custom` | – | 自由槽（`.stem/agent` 未知字段全透传于此；策略基因如 `custom.cortex={dreamAt?,consolidateModel?}` 住这里） | 策略经 `StrategyApi.custom` 消费 |
| `maxSteps` | – | 单轮工具步数上限；**≤0/未设 = 无限制**（长程工作默认放开）；解析 = 类基因 > 全局 config.maxSteps > 无限。资源上限而非权限，不进族谱律不继承不封顶 | Runtime 轮循环 |

**实例侧参数**（不在类上；运行期唯一写面 `agent_update`，缺省目标=自身，canReach）：`name`（全局唯一称呼，撞名拒；根的出生名 = `config.user.name`）/ `model` 显式行（四级律顶层）/ `tools` 收敛 patch / `grantTools` 清单整表（逐键祖先封顶）。

**根的全部特殊性**（皆为接线/结构事实非类特权）：`parentId=null`、出生路径 id 恒 `0`、`assemble:false`（面板性=pilot 扮演）、家学锚点（`config.user.model` 必填）；类本体 = 内置类表普通条目（`kernel/builtin/agents.ts` 统一形态）。

## 工具清单

工具按来源分三类（`ToolKind = internal | extension | custom`，kind 是纯 provenance 不参与权限）。权限只有两个来源：**注册表出生声明**（每个工具注册点写死 birth——`access_reply`/`bash` 出生 allow，其余 internal 通例 ignore 背景在场；extension/custom 由 `config.extensions.tools` 点名时给定权限词）与**收敛清单链**（根→类→[策略]→实例逐级收紧）。**模型可见 = allow ∪ ask**。

### ① core 系统工具（`kind=internal`，20 个，`src/core/tools/internal/systemTools.ts`）

系统自我管理与邮局机制的模型侧能力面；"根清单（模板实值）"列 = 首启模板的 `user.tools` 推荐实值（config 是唯一清单源，代码零缺省表；boot 校验律审判 access_reply=allow 缺位拒启）。

| 分组 | 工具 | 说明 | 根清单（模板实值） |
|---|---|---|---|
| agents 生态 | `agent_class_create` | 创建 agent 类并**落盘 `.stem/agent/`**（新名 = 变体并存可 A/B；tools 键即白名单）——自我进化书写面 | `ask` |
| | `agent_class_update` | 同名覆盖更新 + 落盘（tools 增量 patch、逐键**只许收敛**；panel/user 根类拒绝；**只影响后续实例**） | `ask` |
| | `agent_class_list` | 列出全部类与关键属性 | allow |
| | `agent_instantiate` | 实例化类（parentId=调用者；可继承父上下文；模型路径只能收敛；**wait=true 创建并等待回信**——配对原子完成竞态绝迹，可配 waitTimeoutMs） | allow |
| | `agent_list` | 列出空间内实例 | allow |
| | `agent_inspect` | 实例详情：族谱链/状态/轮次/成本/**生效权限表** | allow |
| | `agent_update` | 实例参数统一写面（缺省目标=自身，canReach）：model / name / tools 收敛 patch / grantTools 清单整表 | `ask` |
| | `agent_ancestry` | 祖先链 `[父 → … → 根]` | allow |
| | `agent_descendants` | 后代子树（BFS） | allow |
| | `agent_terminate` | 销毁实例（自身或祖先；recursive 级联子树） | `ask` |
| 多 agent 协作 | `mail_send` | 向指定参与者送信（自动 from 戳） | allow |
| | `mail_participants` | 邮局在册参与者清单 | allow |
| 观测 | `telemetry_query` | 运行日志查询（工具/模型/信箱/权限/上下文/类书写审计；可见域 = **自身 + 族谱后代**，行式压缩）——进化闭环观测面 | allow |
| 上下文管理 | `context_overview` | 上下文概览（role/turn/tag/token 占比）——自省 | allow |
| | `context_export` | 导出完整上下文为 jsonl（只读） | allow |
| | `context_remove` | `markInvalid` 删消息/整轮（归档可逆；仅自身或祖先） | allow |
| | `context_edit` | 重写指定消息内容（system 不可改） | allow |
| | `context_apply` | 执行策略专有动作（如 classic 手动 `compact`） | allow |
| | `agent_pause` | 自主挂起攒信：ms 到点唤醒，期间来信自然堆积 | 未列=隐藏 |
| 系统义务 | `access_reply` | 答复 `access_request`（once/always/reject；仅族谱根可答）——**根义务，删则 ask 死锁** | allow |

### ② core 外部操作面（`kind=internal`）

| 工具 | 位置 | 说明 | 根清单（模板实值） |
|---|---|---|---|
| `bash` | `src/core/tools/internal/bash.ts` | **最小系统唯一对外操作面**（外部文件/系统）：执行 shell 命令返回 stdout/stderr/exit code。core 只定义工具与 `ShellRunner` 端口，执行由宿主注入（node child_process）。治理对齐 pi：**不走 ask、无黑名单**——靠超时/截断/默认 cwd 限事故半径 + 提示词分担；`config.bash` 配参（`path/defaultTimeoutMs/maxOutputChars/cwd`）。 | `allow` |
> 不配 shell 的 agent：模板 `tools` 白名单**不列 `bash` 键**即可（键即自我限定，代码里永不写危险命令黑名单）。

### ③ extension 工具（`kind=extension`，fs 五件套 + web 两件，`extension/tools/`）

由 **`config.extensions.tools: {名: 权限词}`** 点名装载（装载与出生一句话说完；键在 extension/tools/ 与 .stem/tools/ 双源解析不到 = 拒启）。未点名 = 不存在于世界（目录扫描制已废止）。

| 工具 | 说明 |
|---|---|
| `read` | 读文件（分页）/ 列目录 |
| `write` | 写文件 |
| `edit` | 精确字符串替换编辑 |
| `grep` | 正则递归搜内容 |
| `glob` | glob 模式匹配路径 |

> 定位：可选能力包，非最小系统必需（缺省点名 = fs 五件套 allow）。空间自有代码落 `.stem/tools/`，同样必须点名进世界——用户空间放文件不再自动生效（代码注入面闭合）。

### ④ custom 工具（`kind=custom`，`.stem/tools/` 点名装载）

平铺 `<名>.ts` 或目录 `<名>/<名>.ts` 形态默认导出 `ToolCapability`（示例：`test/space-demo/.stem/tools/user_hello.ts`），在 `config.extensions.tools` 点名才进世界（权限词即出生）。**agent 类/上下文策略仍是目录即真相**（`.stem/agent/`、`.stem/context/` 自动装载，用户主权书写面不受影响）。

### ⑤ extension 层（`extension/`，三类资源目录形态）

仓库级可选扩展的家：`extension/tools/<名>/<名>.ts`、`extension/agent/<名>/<名>.md`、`extension/context/<名>/<名>.ts`，由 `config.extensions.{tools,agent,context}` 分键点名启用（装载与覆盖律见 `extension/README.md`）。与 custom 层同构，差别只在启用方式（点名 vs 目录即真相）与归属（仓库发布物 vs 用户空间）。当前住户：fs 五件套 + web 两件（tools）、`creator` 调度者示例（agent）。

## 本地参考资料

- `reference/deepseek-harness-dsh-v0.1.2-rc.1/` —— DeepSeek harness（事件源会话日志、capability seam、单调 guard 参考）
- `reference/pi-0.84.4/` —— 极简 agent harness（核心极简、快照/进度分离参考）
- `reference/opencode-1.18.27/` —— opencode 源码（provider/LLM 复用依据）
- `reference/vscode-1.132.0/`、`reference/vscode-1.136.1/` —— VSCode 源码（历史核对基准，本项目已剥离）

## 快速上手

```bash
npm install                 # 安装依赖（node >= 23.4）
npm run typecheck           # tsc --noEmit 类型检查（唯一 lint/typecheck）
npm test                    # 全量单测
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑
npm run shell               # CLI shell：**cwd 即空间**（opencode-style；无 key 也可起，用到才硬错）
npm run shell -- test/space-demo   # 指定目录（仓库演示空间）
ALIBABA_API_KEY=<key> npm run shell   # 真实网关（密钥只走 env：config providers.<p>.key_env 声明变量名）
npm run web                 # WebUIShell（OLED 无边框主题：流式思维链/工具监督抽屉/占用条；127.0.0.1:4321；`npm run web -- <目录>`）
npm run feishu -- [目录]     # 飞书 shell：长连接远程助理（免公网；显式会话 /new /use +
                            #   上下线通知与断线补偿；配置样例见 shell/feishu/feishu.example.jsonc）
npm run build               # 与 typecheck 相同（tsc --noEmit）
```

### Docker（1.0 发布形态）

```bash
docker build -t stem:1.0 .
docker run -d -p 4321:4321 -v stem-data:/data --name stem stem:1.0
# 真实网关：-e <providers 声明的 key_env 名>=<key>（模板默认 OPENCODE_API_KEY）；国内构建可加 --registry-mirror 或改 lock 源
```

镜像 = `node:24-slim` + 非 root + HEALTHCHECK（`/api/health`）。**`/data` volume 承载
`.stem/`（配置自举 + SQLite 个体层持久）——容器即 bash 的安全边界，挂载目录就是爆炸半径**。

shell 内可交互：直接输入对话；`/new` 创建实例、`/agents` 查看族谱、`/templates` 查看模板、`/tools` 查看工具、`/config` 看配置、`/compact` 手动压缩上下文、`/stop` 中断当前 agent、`/help` 帮助、`/exit` 退出。web 端为第一视角浏览器交互（SVG 泳道族谱侧栏 / 信箱按 sender 归位时间线 / 模型行 origin 徽标即切 / 「审」权限面板；视图逻辑住 `view.js` 纯函数、node 直测）。

## 关键前提

1. **Node**：`>= 23.4`（`node:sqlite` 免 flag）；运行依赖 `tsx` / `jsonc-parser` / `yaml`（飞书 shell 另用官方 SDK）。
2. **无平台绑定**：已从 VSCode 剥离——无 VSCode/Proposed API 依赖，core 零平台依赖，一切平台能力经端口由宿主注入。
3. **模型接入**：OpenAI 兼容端点一段 config 即接入（`config.providers`）；provider 路由在 shell 门面，密钥只走 env。
4. **Agent 系统自研**：AgentClass / 实例 / 族谱 / 工具访问 / 上下文策略全部自研。
5. **发布形态**：Docker（`node:24-bookworm-slim` + 非 root + `/data` volume + `/api/health` HEALTHCHECK）。
