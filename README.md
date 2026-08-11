# stem

> **S**elf-**T**raining **E**volutionary **M**atrix —— 自我训练·进化·矩阵。
> 干细胞之意：如同原始 Agent 类，可分化出任意角色与能力。
> 抛弃会话概念：以**原子化 Agent 类 + Agent 实例**为核心，配合模块化 harness 系统，构建可自我进化的多智能体集群。

**状态**：架构定稿，进入实现阶段（Spike 1 起点）。
**日期**：2026-08

---

## 项目定位

- **不是**"把 opencode 塞进 VSCode"，也**不是**"单 Agent 会话容器"。
- 是**用户主权的 Agent 系统**：
  - 一切 Agent 来自 **AgentClass（模板）**，用户自由创建/修改/删除/实例化，**绝不固定任何角色**。
  - 简单对话 = 简单类 + 空上下文实例；复杂任务 = 调度器类（advanced 权限）再创建子实例并传递上下文。
  - **MessageBus** 让 Agent 之间能相互对话/委托/handoff（GAN 对抗、结对、公司模拟的基础）。
  - **上下文管理对外暴露为工具**（ContextAssetPool → `context_*` 工具），RAG 等可作为存储后端接入。
  - **元能力工具**（`agent_class_create` / `telemetry_read` / `module_patch`）让 AI 自己管理 Agent 信息，实现自我进化（特修斯之船）。
  - **Telemetry** 贯穿全系统，记录 Agent 状态/API 请求/完整上下文，驱动评估与进化闭环。
- **Core 完全解耦**：core 层为纯 TS 领域逻辑，零 VSCode 依赖，所有平台能力经接口由 `adapters/` 注入——为从 VSCode 剥离独立项目做准备。
- **AgentSpace**：按项目/工作区划分 agent 列表，UI 复用 session 模式但一条目 = 一个 Agent 实例，用户可实时观察与接管任何 Agent。
- 每个模块相互解耦、可独立升级——opencode Provider 层隔离在 `gateway/providers/`。

## 架构一图流

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Layer 4  Host Adapters (adapters/vscode/)   ← 唯一接触平台 API        │
│   shell: SessionController · SessionProvider · ToolBridge             │
│   tools: oc_* (vscode 实现) · context: prompt-tsx/存储                │
│   gateway: providers 装配                                             │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 3  Agent Kernel (core/kernel/)   ← 纯 TS，零平台依赖            │
│   AgentTemplateRegistry · AgentInstanceManager · AgentSpaceManager    │
│   Scheduler · MessageBus · ContextAssetPool · ToolCapabilityRegistry  │
│   AgentRuntime                                                         │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 2  Core Infra (core/context/, core/tools/)   ← 纯 TS            │
│   ContextProfile 抽象 · Compressor · 存储接口 · 工具引擎               │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 1  Model Gateway (core/gateway/)   ← 纯 TS（opencode 隔离）     │
│   ModelGateway · Tokenizer · providers/(fetch / opencodeLlm)          │
└───────────────────────────────────────────────────────────────────────┘
  横切  Telemetry (core/telemetry/) —— 全量日志 → 评估 → 策略反馈 → 自我进化
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/decisions.md`](docs/decisions.md) | 战略决策（D1–D12）、API 铁律、opencode 复用、勘误 |
| [`docs/architecture.md`](docs/architecture.md) | Agent Kernel 四层架构、Core 解耦、权限分级、数据流、自我进化 |
| [`docs/ui-design.md`](docs/ui-design.md) | **UI 设计**：AgentSpace 列表、session 复用、创建者区分、用户接管 |
| [`docs/scenarios.md`](docs/scenarios.md) | 应用场景路线图（S1–S11）：简单对话 → 公司模拟 → GAN → 自我进化 |
| [`docs/code-style.md`](docs/code-style.md) | 模块化代码风格、接口约定、依赖注入、事件驱动、自检清单 |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | 场景驱动的实现阶段与任务清单 |

## 本地参考资料

- `reference/opencode-dev/` —— opencode v1.18.15 源码（provider 复用依据）
- `reference/vscode-1.132.0/` —— VSCode 源码（API 铁律核对依据）

## 关键前提

1. **VSCode**：1.132.0（本地源码核对基准），Proposed API 需 **Insiders** + `--enable-proposed-api=stem`。
2. **Proposals**：`["chatSessionsProvider", "chatParticipantAdditions"]`。
3. **opencode**：仅复用 Provider/LLM 能力（vendoring `@opencode-ai/llm` + `@opencode-ai/schema`，或阶段 1 裸 fetch），不引入其 Session/Agent 引擎。
4. **effect**：引入 vendored llm 后锁定 `effect@4.0.0-beta`，且只存在于 gateway 层内部。
5. **Agent 系统自研**：AgentClass/实例/MessageBus/元能力全部自研（VSCode 无原生 agent 工具）。
