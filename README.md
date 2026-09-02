# stem

> **S**elf-**T**raining **E**volutionary **M**atrix —— 自我训练·进化·矩阵。
> 干细胞之意：如同原始 Agent 类，可分化出任意角色与能力。
> 抛弃会话概念：以**原子化 Agent 类 + Agent 实例**为核心，配合**族谱树**与模块化 harness 系统，构建可自我进化的多智能体集群。

**状态**：架构定稿，实现阶段（核心骨架 + 个体层持久化 + 上下文策略框架 + 族谱权限台账 + user0 配置对象化 + bash 最小操作面 + extensions tool_set，202 单测全绿）。
**日期**：2026-08

---

## 项目定位

- **用户主权的 Agent 系统**：
  - 一切 Agent 来自 **AgentClass（模板）**，用户自由创建/修改/删除/实例化，**绝不固定任何角色**。
  - 简单对话 = 简单类 + 空上下文实例；复杂任务 = 调度器类再创建子实例并传递上下文。
  - **族谱树**：所有 agent 一律平等（同地位独立个体），唯一区别是 `parentId`——user0（`user` 类实例）是原点、根（`parentId=null`）；父可销毁/中断子（`agent_terminate`/`agent_interrupt` + 祖先校验）。
  - **工具访问四态**：allow/ask/deny/ignore；生效权限 = 族谱位置的函数（`AccessLedger` 注册期物化）——**键即白名单**（未列 = 本地 deny），祖先显式 deny/ask 锁子孙（不可撤销），session 批准仅为 ask 免询问备忘。
  - **元能力工具**（`agent_class_create` / `agent_inspect` / `agent_ancestry` / `agent_descendants` …）让 AI 自己管理 Agent 信息，实现自我进化（特修斯之船）。
  - **消息库 tag + 双索引**：为上下文管理策略（压缩/印象/记忆）提供定位，引导从经典组装走向自聚焦/记忆分层。
  - **Logging** 贯穿全系统，记录工具调用/API 请求/上下文组装，驱动评估与进化闭环。
- **Core 完全解耦**：core 层为纯 TS 领域逻辑，零 VSCode 依赖，所有平台能力经接口由宿主注入——为目标是从 VSCode 剥离的独立项目。
- **AgentSpace**：按项目/工作区划分 agent 列表，UI 复用 session 模式但一条目 = 一个 Agent 实例，用户可实时观察与接管任何 Agent。

## 架构一图流

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Layer 3  shell/（交互层，最外）—— 平台适配 + UI                       │
│   cli/（bootStem + TOOL_SETS + bash runner + storage + CLI）          │
│   webui/（HTTP + SSE，OLED 主题，/api/health）                        │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 2  core/（纯 TS，零平台依赖，自治最小系统）                     │
│   init/（createStemSystem 组合根）· kernel/（Kernel/Runtime/userClass │
│   pilot/（user0 扮演接口）· events/（PilotEvent + EventHub）          │
│   lineage/（族谱纯关系视图）· context/（邮局 + legalize + 持久化端口）│
│   tools/（注册表 + access + accessRequest + bash + SkillRegistry）    │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 1  Model Gateway (core/gateway/)   ← 纯 TS（opencode 隔离）    │
│   ModelGateway · providers/(openaiCompatible) · FakeGateway           │
└───────────────────────────────────────────────────────────────────────┘
   extension/tools/  可选 tool_set 包（config.extensions 选择，宿主解析注入）
   横切  Logging (core/logging/) —— LogEvent 经注入 LogSink 直达记录器（无总线）
```

依赖方向（单向）：`shell → core(kernel/pilot/context/tools) → gateway`。core 目录零平台依赖（禁止 `import 'vscode'` 与平台全局）；平台能力（fs/网络/动态 import）全部以接口注入。

## 核心概念

| 概念 | 说明 |
|---|---|
| **AgentClass（模板）** | 角色设定：name（即 id）/ description / systemPrompt / **tools**（Record，键即白名单）/ contextStrategy / model / sendCountdown。用户主权载体。 |
| **AgentInstance** | 运行时原子单位：classRef / **parentId**（=创建者，族谱）/ displayName / status / turnCount / totalCost。 |
| **族谱树 LineageTree** | 无状态关系视图：parentId 挂实例上，实时推导 children/ancestors/descendants；销毁权判定。 |
| **user0** | `user` 类普通实例（`parentId=null` 即根，无任何特判）；`config.user` = 其内嵌 agent 类完整对象（人格/权限/模型声明式可配）。 |
| **工具访问 ToolAccess** | 四态 allow/ask/deny/ignore；生效权限 = 族谱位置的函数（`lineage/AccessLedger` 注册期物化：继承→收敛，键即白名单；grant 加法为系统特权），tools 经 `AccessResolver` 端口查询。 |
| **重建邮局** | 无集中式总线：仓库（存储）→ 管理员（打戳/策略处理/组装 + legalize）→ 快递员（倒计时+发送，只发不组装）。个体层经 MessageStore/InstanceStore 端口 write-through 落 SQLite（宿主注入），缺省纯内存。 |
| **上下文策略** | `context/strategies/` 独立子模块（契约：process 触发=user_prompt 抵达、终点=就绪唤醒快递员；assemble 纯函数）。classic = 全量直出 + opencode 式 compact（摘要 worker 邮局正规往返、markInvalid 归档可逆）；`.stem/context/*.ts` 可加载用户策略（自我进化承载之一）。 |
| **ask 消息化** | ask 审批 = 消息交换：`access_request` 投递根信箱 → 根经 `access_reply` 回复（once/always/reject；always = per-agent 免询问备忘）。 |
| **PilotEvent** | 统一事件流（stream/letter/status/notice）+ EventHub 多订阅者；外部（shell/webui）订阅。 |
| **tag + 双索引** | StoredMessage 带 tag（非原生合成消息）+ turn/indexInTurn（双索引），为上下文策略提供精确定位。 |

## 工具清单

工具按来源分三类（`ToolKind = internal | shell | user`），全生态现状如下。**内部工具默认 `ignore`（对模型隐藏），类清单显式声明才暴露**。

### ① core 系统工具（`kind=internal`，19 个，`src/core/kernel/systemTools.ts`）

系统自我管理与邮局机制的模型侧能力面；"user0 默认"列 = `DEFAULT_USER_TOOLS`（`config.user.tools` 给出则整表替换）。

| 分组 | 工具 | 说明 | user0 默认 |
|---|---|---|---|
| agents 生态 | `agent_class_create` | 创建 agent 类并**落盘 `.stem/agent/`**（新名 = 变体并存可 A/B；tools 键即白名单）——自我进化书写面 | `ask` |
| | `agent_class_update` | 同名覆盖更新 + 落盘（tools 增量 patch、逐键**只许收敛**；panel/user 根类拒绝；**只影响后续实例**） | `ask` |
| | `agent_class_list` | 列出全部类与关键属性 | allow |
| | `agent_instantiate` | 实例化类（parentId=调用者；可继承父上下文；模型路径只能收敛） | allow |
| | `agent_list` | 列出空间内实例 | allow |
| | `agent_inspect` | 实例详情：族谱链/状态/轮次/成本/**生效权限表** | allow |
| | `agent_ancestry` | 祖先链 `[父 → … → 根]` | allow |
| | `agent_descendants` | 后代子树（BFS） | allow |
| | `agent_terminate` | 销毁实例（自身或祖先；recursive 级联子树） | `ask` |
| 多 agent 协作 | `bus_send` | 向指定参与者送信（自动 from 戳） | allow |
| | `bus_participants` | 总线参与者清单 | allow |
| 观测 | `telemetry_query` | 运行日志查询（工具/模型/信箱/权限/上下文/类书写审计；可见域 = **自身 + 族谱后代**，行式压缩）——进化闭环观测面 | allow |
| 上下文管理 | `context_overview` | 上下文概览（role/turn/tag/token 占比）——自省 | allow |
| | `context_export` | 导出完整上下文为 jsonl（只读） | allow |
| | `context_remove` | `markInvalid` 删消息/整轮（归档可逆；仅自身或祖先） | allow |
| | `context_edit` | 重写指定消息内容（system 不可改） | allow |
| | `context_apply` | 执行策略专有动作（如 classic 手动 `compact`） | allow |
| | `context_wait` | 等子 agent 回信入 tool 结果（配合 instantiate） | 未列=隐藏 |
| 系统义务 | `access_reply` | 答复 `access_request`（once/always/reject；仅族谱根可答）——**根义务，删则 ask 死锁** | allow |

### ② core 外部操作面 + skill（`kind=internal`，2 个）

| 工具 | 位置 | 说明 | user0 默认 |
|---|---|---|---|
| `bash` | `src/core/tools/bash.ts` | **最小系统唯一对外操作面**（外部文件/系统）：执行 shell 命令返回 stdout/stderr/exit code。core 只定义工具与 `ShellRunner` 端口，执行由宿主注入（node child_process）。治理对齐 pi：**不走 ask、无黑名单**——靠超时/截断/默认 cwd 限事故半径 + 提示词分担；`config.bash` 配参（`path/defaultTimeoutMs/maxOutputChars/cwd`）。 | `allow` |
| `skill` | `src/core/tools/skill.ts` | 懒加载 skill 正文进上下文（清单见 system 提示 `<available_skills>`；init 扫描 SKILL.md 注册） | 未列=隐藏 |

> 不配 shell 的 agent：模板 `tools` 白名单**不列 `bash` 键**即可（键即自我限定，代码里永不写危险命令黑名单）。

### ③ extension tool_set：shell fs 工具（`kind=shell`，5 个，`shell/cli/tools/`）

由 **`config.extensions: string[]`** 选择加载（宿主 bootStem 解析；缺省 `["fs"]`，显式 `[]` = 纯 bash 最小系统）。core 对 tool_set id 无感知，只透传字符串数组。

| 工具 | 说明 |
|---|---|
| `read` | 读文件（分页）/ 列目录 |
| `write` | 写文件 |
| `edit` | 精确字符串替换编辑 |
| `grep` | 正则递归搜内容 |
| `glob` | glob 模式匹配路径 |

> 定位：这是可选能力包（`fs` tool_set），非最小系统必需。第三方/宿主专属工具包（如 VSCode 工具集）落 `extension/tools/`，落位后并入 bootStem 的 `TOOL_SETS` 清单即可被 `config.extensions` 选择。未知 id 告警跳过、不炸启动。

### ④ user 工具（`kind=user`，`.stem/tools/*.ts`）

用户默认导出 `ToolCapability` 即注册（示例：`test/space-demo/.stem/tools/user_hello.ts`）；**目录即真相**——放进 `.stem/tools/` 自动加载，config 无镜像字段（S4.2 起 tools/agents/strategies 三镜像注册表已删除）。

### ⑤ extension（tool_set 包挂载点，`extension/tools/`）

可选功能扩展以 **tool_set 包**形式落此（一组 `ToolCapability`），经 `config.extensions` 选择、宿主装配层解析注入（见 ③）。当前 fs 参考实现暂驻 `shell/cli/tools/`（其本身体依赖 node 平台能力），本目录承接第三方/宿主专属包。

## 本地参考资料

- `reference/deepseek-harness/` —— DeepSeek harness（事件源会话日志、capability seam、单调 guard 参考）
- `reference/pi/` —— 极简 agent harness（核心极简、快照/进度分离参考）
- `reference/le-opencode/` —— opencode 源码（provider/LLM 复用依据）
- `reference/vscode-1.132.0/` —— VSCode 源码（API 铁律核对依据）

## 快速上手

```bash
npm install                 # 安装依赖（node >= 23.4）
npm run typecheck           # tsc --noEmit 类型检查（唯一 lint/typecheck）
npm test                    # 全量单测（264）
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑
npm run shell               # CLI shell：**cwd 即空间**（opencode-style；无 key 也可起，用到才硬错）
npm run shell -- test/space-demo   # 指定目录（仓库演示空间）
ALIBABA_API_KEY=<key> npm run shell   # 真实网关（密钥只走 env：config providers.<p>.key_env 声明变量名）
npm run web                 # WebUIShell（OLED 主题，127.0.0.1:4321；同样支持 `npm run web -- <目录>`）
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

1. **VSCode**：1.132.0（本地源码核对基准），Proposed API 需 **Insiders** + `--enable-proposed-api=stem`。
2. **Proposals**：`["chatSessionsProvider", "chatParticipantAdditions"]`。
3. **opencode**：仅复用 Provider/LLM 能力（vendored `@opencode-ai/llm` + `@opencode-ai/schema`，或阶段 1 裸 fetch），不引入其 Session/Agent 引擎。
4. **effect**：引入 vendored llm 后锁定 `effect@4.0.0-beta`，且只存在于 gateway 层内部。
5. **Agent 系统自研**：AgentClass/实例/族谱/工具访问全部自研（VSCode 无原生 agent 工具）。
