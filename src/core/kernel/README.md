# kernel —— 领域聚合 / 门面（实例 / 模板 / 上下文持有）

> 模块自述：实现细节见本文件；族谱与权限物化的算法细节见 `lineage/README.md`。

## 职责

- 持有并暴露领域聚合：`TemplateRegistry`（类表）、`InstanceManager`（实例）、`LineageTree`（族谱/能力）、`Repository`/`ContextManager`/`Courier`（邮局）、`Waiter`（统一挂起）、`RuntimePort`（执行器接口）、`ToolCapabilityRegistry`、`AccessAskBus`、`EventHub`、`Logger`。
- 定义运行期写通道：`updateAgent`（name/model/temperature/effort 唯一写面，无全树 replay）、`terminateAgent`（含 `waiter.cancelOwner`）、`interruptAgent`、`instantiateInSpace`、`registerAgentClass`/`updateAgentClass`（**tools 收敛硬门禁在写入面本层**——webui/组合根直调不可绕过）。
- 提供端口适配器：`toolHost.ts`（`SystemToolHost`）、`runtimePort.ts`（接口声明）、`systemFacade.ts`（接口声明）。
- **不自接线**：工具记录 sink 与 internal 工具装配由组合根 `main/toolWiring.ts` 完成（Kernel 不认识 bash）；Kernel 只注入日志/访问端口（`setLogSink`/`setAccessSink`/`setAccessResolver`）。
- **上下文箱注册**：`registerBox` 单点（根出生 / 恢复接线 / 实例化三路共用）——组装开关、策略、信件回调、hold；恢复路径 forget 不挡启动，出生路径 fail-fast。

## 文件

| 文件 | 内容 |
|---|---|
| `Kernel.ts` | 容器/装配门面（收 `RuntimePort` 工厂；不 import 具体执行器与 main） |
| `convergenceSteps.ts` | 收敛链步原料 + 写入面校验（listStep/strategyStep/validate/labeled） |
| `classWrite.ts` | 类书写面（register/update/persist；tools 收敛硬门禁） |
| `TemplateRegistry.ts` | 类注册表（name 即 id） |
| `InstanceManager.ts` | 实例生命周期（id = 出生路径 `x.x`） |
| `attributes.ts` | 类字段单一真相（校验/frontmatter 映射/normalize） |
| `store.ts` / `persisted.ts` | 持久化端口 + write-through 装饰器 |
| `types.ts` | `AgentClass`/`AgentInstance`/branded id/`parentIdOf`/错误联合 |
| `builtin/agents.ts` | 内置类表（assistant + user 根类构造） |
| `runtimePort.ts` | `RuntimePort` + `RuntimePortDeps`（D3 端口倒置） |
| `systemFacade.ts` | `SystemFacade`（pilot 消费面） |
| `toolHost.ts` | `createSystemToolHost`（internal 工具宿主适配器） |

## 实例管理

- 实例化必填 `className` + `userPrompt`（根可为空串）+ `parentId`（根 null）；父须已存在（根除外）。**id 无指定通道**（路径形全托管：根 `0`，root 子 `N`，子 `<父id>.<序号>`）。
- **不落库**：`parentId`（=`parentIdOf(id)`）、`userPrompt`（只走 InstantiateOptions 首信）。
- 可选 `name`（撞全局名 = 拒绝并明示，缺省派生 `类名-N`）；`assemble:false` = 面板（创建方指定）。
- **运行期实例写面**：`update(agentId, patch: {name?, toolOverride?, model?, temperature?, effort?})`；授权/校验/审计编排在 `kernel.updateAgent`。

## 持久化与恢复

- **端口**：`store.ts` `InstanceStore`；装饰器 `persisted.ts` `PersistedInstanceManager` 写穿。
- **恢复语义**：`wireRestoredContexts`（runInit 载齐类/策略后一次完成）：实例装载（活跃状态归一化 thinking/holding → interrupted）→ lineage 启动 replay → 上下文接线（`restore=true` 跳过仓库开辟；快递员 `initialSentIds` 预置 → **重启零重放**）。悬空挂起不恢复，交 legalize 兜底。
- **terminate = 个体消亡**：活体面移除、**id/name 占用保留（墓碑）**、消息行归档；`waiter.cancelOwner` 清理 ask/hold/pause。
- **已知边界**：轮账三件统一走 `recordTurnEnd`；未走到轮末的轮不记账是正确语义。

## 权限/模型物化

- 实例注册时经 `lineage.attach`/`replay` 物化；写入面走同一代数做拒绝式校验。
- 模型继承链：实例显式 > 类基因 > 父继承（严格父子相对）；**出生落地 `modelBinding`**，改父不级联。形状（`ModelOrigin`/`ModelBinding`/`EffortLevel`）住 `gateway`，kernel re-export。
- 类字段单一真相见 `attributes.ts`（校验/frontmatter 映射/`pickAgentClassGenes`）。

## 依赖

`context`、`lineage`、`tools`、`gateway`、`logging`、`events`；**不依赖 main**。
