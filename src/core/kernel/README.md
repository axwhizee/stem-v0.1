# kernel —— 领域聚合 / 门面（实例 / 模板 / 空间 / 上下文持有）

> 模块自述：实现细节见本文件；族谱与权限物化的算法细节见 `lineage/README.md`。

## 职责

- 持有并暴露领域聚合：`TemplateRegistry`（类表）、`InstanceManager`（实例）、`SpaceManager`（空间）、`LineageTree`（族谱/能力）、`Repository`/`ContextManager`/`Courier`（邮局）、`RuntimePort`（执行器接口）、`ToolCapabilityRegistry`、`AccessAskBus`、`EventHub`、`Logger`。
- 定义运行期写通道：`updateAgent`（实例参数唯一写面，改后全树 replay）、`terminateAgent`、`interruptAgent`、`instantiateInSpace`、`registerAgentClass`/`updateAgentClass`。
- 提供端口适配器：`toolHost.ts`（`SystemToolHost`）、`runtimePort.ts`（接口声明）、`systemFacade.ts`（接口声明）。
- **不自接线**：工具记录 sink 与 internal 工具装配由组合根 `main/toolWiring.ts` 完成（Kernel 不认识 bash）；Kernel 只注入日志/访问端口（`setLogSink`/`setAccessSink`/`setAccessResolver`）。

## 文件

| 文件 | 内容 |
|---|---|
| `Kernel.ts` | 容器/装配（收 `RuntimePort` 工厂；不 import 具体执行器与 main） |
| `TemplateRegistry.ts` | 类注册表（name 即 id） |
| `InstanceManager.ts` | 实例生命周期（id = 出生路径） |
| `SpaceManager.ts` | 空间 |
| `store.ts` / `persisted.ts` | 持久化端口 + write-through 装饰器 |
| `types.ts` | `AgentClass`/`AgentInstance`/branded id/错误联合 |
| `builtin/agents.ts` | 内置类表（assistant 占位类 + user 根类构造） |
| `runtimePort.ts` | `RuntimePort` + `RuntimePortDeps`（D3 端口倒置） |
| `systemFacade.ts` | `SystemFacade`（pilot 消费面） |
| `toolHost.ts` | `createSystemToolHost`（internal 工具宿主适配器） |

## 实例管理

- 实例化必填 `className` + `userPrompt`（根可为空串）+ `parentId`（根 null）；父须已存在（根除外）。**id 无指定通道**（路径形全托管：根 `0`，子 `<父id>-<序号>`）。
- 可选 `name`（撞全局名 = 拒绝并明示，缺省派生 `类名-N`）。
- **运行期实例写面唯一化**：`update(agentId, patch: {name?, toolOverride?, model?})`（写穿装饰器落行——三字段随实例行 JSON 持久，零 schema 迁移，重启 replay 天然承接）；授权/校验/族谱重算/审计编排在 `kernel.updateAgent`。

## 持久化与恢复

- **端口**：`store.ts` `InstanceStore`（实例 upsert/delete/loadAll + 空间 upsertSpace/deleteSpace/loadSpaces）；接口与默认内存实现同文件。
- **装饰器**：`persisted.ts` `PersistedInstanceManager` / `PersistedSpaceManager`——委托内存实现 + 写穿。
- **恢复语义（Kernel 构造内，装配步骤 0）**：实例装载（**活跃状态归一化** thinking/holding → interrupted）→ 空间装载（spaceId 重启可解析）→ 上下文接线（`ContextRegistration.restore=true` 跳过仓库开辟；快递员 `initialSentIds` 预置 → **重启零重放**）→ 根幂等（`createPilot` 检测根已存在即跳过）。悬空挂起等待（内存 hold/timer）不恢复，交给组装期 **legalize** 兜底。
- **terminate = 个体消亡**：实例/空间行删除、**消息行归档**（archived 标记，进化语料保留，恢复不加载、id 计数器避开历史序号）。
- **已知边界**：轮账三件（`turnCount/totalCost/totalTokens`）统一走 `recordTurnEnd` 显式通道；未走到轮末的轮（中断/崩溃）不记账是**正确语义**。

## 权限/模型物化

- 实例注册（创建/恢复）时经 `lineage.attach`/`replay` 物化：收敛链 steps（类 → [策略 raise] → 实例）+ 出生表 caps 封顶；写入面（实例化/更新/根注册）走同一代数做拒绝式校验。
- 模型四级律：实例显式 > 类基因 > 出生快照 > 父继承 > 家学（`config.user.model`）；「改父不级联」由子女出生快照数据结构保证。

## 依赖

`context`、`lineage`、`tools`、`gateway`、`logging`、`events`；**不依赖 main**。
