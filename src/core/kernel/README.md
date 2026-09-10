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

## 权限/模型物化

- 实例注册（创建/恢复）时经 `lineage.attach`/`replay` 物化：收敛链 steps（类 → [策略 raise] → 实例）+ 出生表 caps 封顶；写入面（实例化/更新/根注册）走同一代数做拒绝式校验。
- 模型四级律：实例显式 > 类基因 > 出生快照 > 父继承 > 家学（`config.user.model`）；「改父不级联」由子女出生快照数据结构保证。

## 依赖

`context`、`lineage`、`tools`、`gateway`、`logging`、`events`；**不依赖 main**。
