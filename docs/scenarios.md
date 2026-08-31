# 应用场景（发展路线图）

> 本文件是项目的**目标清单**：所有架构决策与实现步骤都围绕让这些场景可行。
> 场景按依赖复杂度排序——低编号场景（S1）先落地，高编号场景驱动后续模块能力。
> 每个场景标注：涉及 Agent 类、核心机制、依赖模块、落地阶段。

---

## 场景速览

| # | 场景 | 阶段 | 核心机制 |
|---|---|---|---|
| S1 | 简单对话 | 1 | 基础 Agent 类 + 空上下文实例 |
| S2 | 单 Agent 编码助手 | 1 | Agent 类 + 业务工具 |
| S3 | 复杂任务分解（调度器） | 2 | Scheduler + MessageBus + 上下文分配 |
| S4 | 多角度代码审查 | 2 | 多实例并行 + 聚合评估 |
| S5 | 测试流水线（生成→执行→修复） | 2 | handoff 链 + ContextAssetPool 标签 |
| S6 | 结对编程 | 2 | Agent 间实时对话（MessageBus） |
| S7 | GAN 对抗分析 | 3 | 生成者 vs 评估者，对抗迭代 |
| S8 | 模拟公司架构 | 3 | 角色化 Agent 类 + 上下文资产自治 |
| S9 | RAG 知识库 | 3 | ContextAssetPool 工具化 + 索引后端 |
| S10 | 自我进化（特修斯之船） | 4 | 元能力工具 + Telemetry + 模块改造 |
| S11 | 用户自有 Agent 市场 | 4 | TemplateRegistry 用户主权 + 模板分发 |

---

## S1：简单对话（阶段 1）

- **目标**：用户与一个轻量 Agent 实例直接对话，无复杂上下文。
- **Agent 类**：`SimpleChat`（无工具、空 memoryScope、默认 SystemPrompt）。
- **机制**：用户 `instantiate_agent(SimpleChat)` → 在 ChatSession 中对话，上下文只有当前轮。
- **依赖**：AgentTemplateRegistry（内置类）+ AgentInstanceManager + ModelGateway。
- **价值**：验证"Agent 类 → 实例"最小闭环，等价传统聊天。

## S2：单 Agent 编码助手（阶段 1）

- **目标**：单个编码 Agent 完成读写文件、跑命令、改代码。
- **Agent 类**：`Coder`（tools: oc_read_file / oc_list_dir / oc_run_command / oc_edit）。
- **机制**：AgentRuntime 单实例循环 + ContextProfile（PinnedFacts + HistoryMessages）+ Compressor。
- **依赖**：业务工具 + ContextAssetPool（references）+ Telemetry。
- **价值**：Spike 1 主目标，打通工具闭环。

## S3：复杂任务分解（阶段 2）

- **目标**：调度器 Agent 把大任务分解给多个专业 Agent，传递上下文。
- **Agent 类**：`Scheduler`（高级权限）+ `Coder` + `Reviewer` + `Tester`。
- **机制**：
  - Scheduler `route()` 拆解 → `create_agent_instance` → 委托子任务。
  - 每个子 Agent 从 ContextAssetPool 检索标签记忆（如 `#task-3-spec`）。
  - 子 Agent 完成后 `handoff` 结果回 Scheduler → 汇总给用户。
- **依赖**：MessageBus（task_delegation / handoff_request）+ Scheduler + ContextAssetPool。
- **价值**：验证"把合适的上下文交给合适的 Agent"。

## S4：多角度代码审查（阶段 2）

- **目标**：多个审查者 Agent 从不同角度审同一代码，评估者聚合。
- **Agent 类**：`SecurityReviewer` / `PerfReviewer` / `ReadabilityReviewer` / `Aggregator`。
- **机制**：Scheduler 并行实例化多个 Reviewer → 各自写 `#review-<aspect>` 标签 → Aggregator 读取汇总产出终审。
- **依赖**：多实例 + ContextAssetPool 标签隔离 + 聚合工具。
- **价值**：展示"同一上下文多角度探索"的雏形（GAN 前身）。

## S5：测试流水线（阶段 2）

- **目标**：生成测试 → 执行 → 修复失败 → 回归 的自动化闭环。
- **Agent 类**：`TestWriter` / `TestRunner`（含 oc_run_command）/ `Fixer`。
- **机制**：handoff 链：TestWriter 产出 → TestRunner 执行写入 `#test-results` → Fixer 读取失败项修复 → 回归。
- **依赖**：HandoffManager + ContextAssetPool 标签 + 工具。
- **价值**：验证 agent 间通过共享上下文资产的协作模式。

## S6：结对编程（阶段 2）

- **目标**：两个 Agent 实时对话协作（driver/navigator）。
- **Agent 类**：`Driver` / `Navigator`。
- **机制**：MessageBus 的 `agent_message` 双向实时投递；Navigator 的建议经 Driver 执行。
- **依赖**：MessageBus（点对点实时）+ 事件驱动。
- **价值**：验证 Agent IPC 的核心能力——**Agent 之间能互相"说话"**。

## S7：GAN 对抗分析（阶段 3）

- **目标**：多个"生成者" Agent 从不同角度探索同一上下文，一个"评估者" Agent 判断取舍。
- **Agent 类**：`Explorer-A/B/C`（各持不同 contextProfile 侧重）+ `Judge`。
- **机制**：
  - Explorer 各自探索 → 各写 `#explore-<viewpoint>`。
  - Judge 读取所有结果 → 判断哪个方案最优/如何融合 → 输出决策。
  - 可迭代：Judge 反馈 → Explorer 第二轮再探索（对抗式收敛）。
- **依赖**：多实例 + ContextAssetPool + Scheduler + Evaluator 辅助。
- **价值**：验证"针对同一上下文的多角度分析与评估"。

## S8：模拟公司架构（阶段 3）

- **目标**：用 Agent 实例模拟真实组织（CEO/PM/开发/测试/运维），长期维护复杂项目。
- **Agent 类**：`CEO` / `PM` / `Engineer` / `QA` / `Ops`（各配 memoryScope 与权限）。
- **机制**：
  - CEO 拆解战略 → PM 细化任务 → Engineer 实现 → QA 验证 → Ops 部署。
  - 每个角色**维护自己的上下文资产**（标签命名空间，如 `#eng/auth` / `#qa/regression`）。
  - 长期运行：跨会话持续，重启后恢复（阶段 3.3 持久化）。
- **依赖**：TemplateRegistry（角色类）+ InstanceManager + ContextAssetPool（资产自治）+ 持久化。
- **价值**：验证"Agent 各自维护上下文资产、有条不紊执行极复杂项目"。

## S9：RAG 知识库（阶段 3）

- **目标**：把 RAG 引入上下文管理，Agent 能建索引、检索知识。
- **机制**：ContextAssetPool 暴露上下文工具：`context_create_index({ source, name })` / `context_query({ tags, query })` → 底层接向量索引后端。
- **Agent 类**：`KnowledgeManager`（能建库）+ 任意 Agent（能检索）。
- **依赖**：ContextAssetPool 工具化 + 可插拔检索后端。
- **价值**：证明"上下文管理模块对外暴露接口、可被 Agent 视为工具"，RAG 只是第一个接入者。

## S10：自我进化（特修斯之船）（阶段 4）

- **目标**：一个"改造者" Agent 读取所有日志，评估薄弱模块，创建新 Agent 或改进模块，实现自我进化。
- **Agent 类**：`Evolver`（管理员权限：telemetry_read / module_evaluate / module_patch / agent_class_create）。
- **机制**：
  1. `telemetry_read` 获取全部状态变化、API 请求、上下文、工具记录。
  2. `module_evaluate` 定位薄弱点（如路由准确率低、压缩后任务失败率高）。
  3. 决策：创建新 Agent 类专攻该问题 / 调整模块参数 / 改造模块。
  4. 新 Agent 参与后续任务 → 评估改善 → 继续循环。
- **依赖**：Telemetry 全量日志 + 系统管理工具 + 模块可注入（配置驱动）。
- **价值**：验证"模块化的极致——系统能改造自己"。

## S11：用户自有 Agent 市场（阶段 4）

- **目标**：用户自由创建、定制、分发 Agent 类模板（共享、复用）。
- **机制**：TemplateRegistry 用户主权：创建 Agent 类（含 systemPrompt/contextProfile/tools/权限）+ 模板导出/导入（JSON / 文件）。
- **依赖**：TemplateRegistry + 模板序列化。
- **价值**：证明"绝不固定某个 Agent 的可能性"，生态化。
