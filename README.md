# stem

> **S**elf-**T**raining **E**volutionary **M**atrix —— 自我训练·进化·矩阵。
> 干细胞之意：如同原始 Agent 类，可分化出任意角色与能力。
> 抛弃会话概念：以**原子化 Agent 类 + Agent 实例**为核心，配合**族谱树**与模块化 harness 系统，构建可自我进化的多智能体集群。

**状态**：架构定稿，实现阶段（核心骨架 + 个体层持久化 + 上下文策略框架 + 族谱权限台账 + user0 配置对象化落地，193 单测全绿）。
**日期**：2026-08

---

## 项目定位

- **用户主权的 Agent 系统**：
  - 一切 Agent 来自 **AgentClass（模板）**，用户自由创建/修改/删除/实例化，**绝不固定任何角色**。
  - 简单对话 = 简单类 + 空上下文实例；复杂任务 = 调度器类再创建子实例并传递上下文。
  - **族谱树**：所有 agent 一律平等（同地位独立个体），唯一区别是 `parentId`——user0（`user` 类实例）是原点、根（`parentId=null`）；父可销毁/中断子（`agent_terminate`/`agent_interrupt` + 祖先校验）。
  - **工具访问四态**：权限融合进工具清单（allow/ask/deny/ignore），层间**单调收缩**（子 ≤ 父，deny 不可被撤销）；系统级工具默认 `ignore`（隐藏，显式 `allow` 才暴露）。
  - **元能力工具**（`agent_class_create` / `agent_inspect` / `agent_ancestry` / `agent_descendants` …）让 AI 自己管理 Agent 信息，实现自我进化（特修斯之船）。
  - **消息库 tag + 双索引**：为上下文管理策略（压缩/印象/记忆）提供定位，引导从经典组装走向自聚焦/记忆分层。
  - **Logging** 贯穿全系统，记录工具调用/API 请求/上下文组装，驱动评估与进化闭环。
- **Core 完全解耦**：core 层为纯 TS 领域逻辑，零 VSCode 依赖，所有平台能力经接口由宿主注入——为目标是从 VSCode 剥离的独立项目。
- **AgentSpace**：按项目/工作区划分 agent 列表，UI 复用 session 模式但一条目 = 一个 Agent 实例，用户可实时观察与接管任何 Agent。

## 架构一图流

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Layer 3  shell/（交互层，最外）—— 平台适配 + UI                          │
│   cli/（参考 shell：bootStem + fs 工具集 + CLI）· webui/（HTTP+SSE）     │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 2  core/（纯 TS，零平台依赖，自治最小系统）                       │
│   init/（createStemSystem 组合根）· kernel/（Kernel/Runtime/userClass） │
│   pilot/（user0 扮演接口）· events/（PilotEvent + EventHub）            │
│   lineage/（族谱纯关系视图）· context/（重建邮局 + legalize + 持久化端口）│
│   tools/（注册表 + access + accessRequest + SkillRegistry + skill）     │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 1  Model Gateway (core/gateway/)   ← 纯 TS（opencode 隔离）     │
│   ModelGateway · providers/(opencodeLlm / fetch) · FakeGateway         │
└───────────────────────────────────────────────────────────────────────┘
   extension/tools/  可选功能扩展（预留：扩展工具集 seam，如 VSCode 工具集）
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

## 本地参考资料

- `reference/deepseek-harness/` —— DeepSeek harness（事件源会话日志、capability seam、单调 guard 参考）
- `reference/pi/` —— 极简 agent harness（核心极简、快照/进度分离参考）
- `reference/le-opencode/` —— opencode 源码（provider/LLM 复用依据）
- `reference/vscode-1.132.0/` —— VSCode 源码（API 铁律核对依据）

## 快速上手

```bash
npm install                 # 安装依赖（node >= 23.4）
npm run typecheck           # tsc --noEmit 类型检查（唯一 lint/typecheck）
npm test                    # 全量单测（193）
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑
npm run shell               # CLI 交互 shell（参考 shell，mock 网关）
OPENCODE_API_KEY=<key> npm run shell   # 真实网关（opencode-go）
npm run web                 # WebUIShell（浏览器打开 http://localhost:4321）
```

shell 内可交互：直接输入对话；`/new` 创建实例、`/agents` 查看族谱、`/templates` 查看模板、`/tools` 查看工具、`/config` 看配置、`/compact` 手动压缩上下文、`/stop` 中断当前 agent、`/help` 帮助、`/exit` 退出。web 端为浏览器交互（agent 侧栏 / timeline / composer / 权限弹窗）。

## 关键前提

1. **VSCode**：1.132.0（本地源码核对基准），Proposed API 需 **Insiders** + `--enable-proposed-api=stem`。
2. **Proposals**：`["chatSessionsProvider", "chatParticipantAdditions"]`。
3. **opencode**：仅复用 Provider/LLM 能力（vendored `@opencode-ai/llm` + `@opencode-ai/schema`，或阶段 1 裸 fetch），不引入其 Session/Agent 引擎。
4. **effect**：引入 vendored llm 后锁定 `effect@4.0.0-beta`，且只存在于 gateway 层内部。
5. **Agent 系统自研**：AgentClass/实例/族谱/工具访问全部自研（VSCode 无原生 agent 工具）。
