# UI 设计（VSCode 端 · AgentSpace 与 Session 复用）

> 核心：**复用 VSCode session 模式的展示形态，但语义彻底改为 Agent 实例**。
> 用户创建与 Agent 调度创建的 Agent 本质相同、并列展示、实时可观察、用户可接管。

---

## 一、设计原则

1. **一个对话条目 = 一个 Agent 实例**（不是"一段会话历史"）。
2. **用户创建 vs 调度创建的 Agent 是平等的**——只是 `createdBy` 标识不同，展示上微区分，不降级。
3. **按项目切换 Agent 空间（AgentSpace）**：避免单个列表过大，切换项目 = 切换到该项目的 agent 列表。
4. **一切 Agent 可被用户实时观察与接管**。

---

## 二、概念映射：session 模式 → Agent 语义

| VSCode session 概念 | stem 语义 |
|---|---|
| ChatSessionItem（左侧列表一条） | 一个 **AgentInstance**（面向用户） |
| ChatSessionItem 列表 | 当前项目（AgentSpace）的 agent 实例列表 |
| 切换工作区/项目 | 切换 AgentSpace（刷新 agent 列表） |
| 打开一个 item → 对话 | 与对应 Agent 实例直接对话 |
| requestHandler | 路由到该 Agent 实例的 `agent.run()` |
| 新建会话按钮 | 新建 Agent 实例（用户实例化某个 AgentClass） |
| 会话标题 | Agent 的 displayName（类名 + 用户命名） |
| `ChatSubagentToolInvocationData` | 调度创建的子 Agent（呈现为"工具卡片"，但在列表中也可见） |

---

## 三、AgentSpace 与列表

### 3.1 AgentSpace 组织

```
项目 A（AgentSpace-A）
├── 用户创建的 Agent
│   ├── [agent] Coder-1        (class: Coder,   由用户创建)
│   └── [agent] MyHelper       (class: SimpleChat, 由用户创建)
├── 调度创建的 Agent
│   └── [agent] Coder-1/sub-reviewer (class: Reviewer, 由 Coder-1 创建)
└── 共享上下文资产（pinnedFacts / memories / references）

项目 B（AgentSpace-B）  ← 切换项目时列表切换到这里
└── ...
```

### 3.2 列表分组与标识

- **分组**：按 `createdBy` 分组展示（"我的 Agent" / "子 Agent"），但**可折叠，不隐藏**。
- **标识**：item `badge` 显示创建来源；调度创建的附父 Agent 名（`by Coder-1`）。
- **状态徽标**：`idle` / `running` / `waiting`（复用 `ChatSessionItem.status` 的视觉）。

### 3.3 项目切换（关键：避免列表过大）

- 用一个 `ChatSessionItemController` 管理**全部项目**的 item；`refreshHandler` 按**当前激活 workspace** 过滤出该 AgentSpace 的 agents。
- 切换项目 → `onDidChangeActiveWorkspace` → `refreshHandler` 重新加载 → `items.replace(当前空间 agents)`。
- 可选：列表顶部显示当前 AgentSpace 名（项目路径）。
- **归属**：每个 item 的 `resource` 用 `agent-space://<project>/<agentId>`，保证跨项目不冲突。

---

## 四、用户接管与微调

### 4.1 接管入口
- 任意 Agent item（含调度创建的）都可被用户打开对话。
- 右键/菜单提供 **"接管 (Takeover)"**：
  - 调整该实例的 `systemPrompt` / `tools` / `memoryScope` / `contextBudget`。
  - 挂起调度器对它的控制，改为用户直接驱动。
  - 释放后恢复调度。

### 4.2 实现
```typescript
// core: AgentInstanceManager.takeover(agentId, patch)
// UI: 命令 stem.agent.takeover → 打开该实例的属性编辑（QuickPick / 面板）
// 状态：agent.takeoverBy = 'user' | undefined（Telemetry: AgentTakeover）
```

---

## 五、Shell 层职责（adapters/vscode/shell/）

### 5.1 SessionController
- `createChatSessionItemController('stem', refreshHandler)`（第二参函数）。
- `newChatSessionItemHandler`：用户新建 Agent → `instantiate(classId, {spaceId})` → `items.add(item)`。
- `refreshHandler`：按当前 workspace → `AgentSpaceManager.list(project)` → `items.replace(items)`。

### 5.2 SessionProvider
- `provideChatSessionContent(resource, token, { inputState })`：
  - 解析 `resource` → `(project, agentId)` → 返回该 Agent 的 `ChatSession { history, requestHandler }`。
- `requestHandler`：路由到 `kernel.agents.get(agentId).run(request)`。

### 5.3 ToolBridge
- `stream.push(new ChatToolInvocationPart(...))` + `ChatSubagentToolInvocationData` 呈现子 Agent。
- 工具状态流转（Pending → Running → Completed / Failed）。

---

## 六、运行中的实时观察

- 选中任意 running 状态的 Agent item → 其 `activeResponseCallback` 流式推送输出。
- 调度创建的 Agent 在运行时以"工具卡片"出现在父 Agent 的流中，**同时**在列表中可见（双向可见）。
- 停止：用户可中断任意 Agent（`cancel`）。

---

## 七、验收标准（UI 相关）

| # | 验收 |
|---|---|
| U1 | 打开项目 A：列表显示该项目"我的 Agent"与"子 Agent"分组 |
| U2 | 切换项目 B：列表切换为项目 B 的 Agent 空间 |
| U3 | 新建 Agent（用户创建）后立即出现在列表 |
| U4 | Scheduler 创建子 Agent 后：父流出现工具卡片 + 列表出现子 Agent 条目（badge 显示 by 父） |
| U5 | 用户打开任意 Agent（含调度创建的）可对话 |
| U6 | Takeover 后修改 systemPrompt 生效，Telemetry 记录 AgentTakeover |
