# stem 实际架构

> 本文档记录**当前系统架构**（落地后的真实形态；与规划冲突时以本文档与代码为准）。模块实现细节住各模块 README（见「三、模块导航」）；本卷只承载**总览概念、跨模块关键模型与导航**。

---

## 一、核心概念

| 概念 | 一句话 |
|---|---|
| **分层模块化** | `shell → core(main/kernel/pilot/context/tools/…) → gateway` 单向依赖；core 零平台依赖，能力全经接口注入 |
| **平等 agent 生态** | 全体 agent（含根）同一套机制；唯一差异 = 出生路径 id + 族谱位置 |
| **族谱树** | 实例树：父 = `parentIdOf(id)` 纯推导；属性节点沿链继承/收敛；可见域 = 自身∨祖先 |
| **属性表继承-收敛** | 多数属性沿族谱链：继承父表 → 类基因 → 实例化入参 → 节点表；只紧不松 |
| **工具权限四态** | allow/ask/deny/ignore 专章；键即白名单 + 收敛链（见 2.3） |
| **邮局模型** | 无总线：仓库（存储）→ 管理员（处理/组装）→ 快递员（倒计时送信） |
| **上下文（记忆）策略** | 每 agent 可挂策略模块（classic/cortex/none…）：决定消息如何整理、压缩、外挂记忆与组装 |
| **自定义内容** | agent 类、工具、上下文策略、shell 均可扩展；config 点名 / 目录即真相 |
| **user#0 扮演** | 根是面板（`assemble:false`），外部 shell 经 Pilot 以根身份行动 |
| **stem 空间 + 配置** | 一进程一 project root；`.stem/` 目录即真相；`stem.jsonc` 唯一配置 |
| **SQLite 个体层** | 消息/实例 write-through；schema v4 零兼容；墓碑与归档可审计 |

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 3  shell/（交互层）—— 平台适配 + UI                              │
│   cli/（bootStem + SQLite + bash runner + 终端面板）                   │
│   webui/（HTTP + SSE 单页） · dashboard/（只读法医） · feishu/（长连接）│
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2  core/（纯 TS，零平台依赖，自治最小系统）                       │
│   main/ 组合根 + 装载管线 + Runtime                                   │
│   kernel/ Kernel · TemplateRegistry · InstanceManager · registerBox  │
│   pilot/ 根扮演接口 · events/ PilotEvent + EventHub                   │
│   lineage/ LineageTree（拓扑+能力+canReach）                          │
│   context/ 邮局（仓库/管理员/快递员）+ Waiter + 策略                   │
│   tools/ 注册表 + 四态代数 + accessRequest + output + internal/       │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 1  gateway/（模型网关契约 + OpenAI 兼容 provider + FakeGateway） │
└──────────────────────────────────────────────────────────────────────┘
  extension/{tools,agent,context}/  矩阵 extension 层（config 点名启用）
  横切  logging/ —— LogEvent 经注入 LogSink 直达记录器（无总线）
```

**依赖方向**：`shell → core → gateway`；组合根 `main` 依赖一切，**没有任何模块依赖 `main`**。平台能力（fs/网络/动态 import/child_process）全部以端口注入。

---

## 二、关键模型

### 2.1 agent 组成（三核心）

一个活着的 agent = **Runtime 循环 + 属性清单 + 记忆策略**。

#### （1）Runtime 循环

被动驱动（`DefaultRuntime`，住 `core/main/runtime.ts`）：不是同步 run loop，而是邮局送信回调驱动。

```
送信 AgentDelivery → thinking → LLM → 工具轮（并行）
  → assistant 入库 → 最终文本 deposit 给族谱父 → holding 等下一封信
```

- `contextWait` / 步数上限可收束本轮；中断 → `halt` 消息闭合 → `interrupted` 可恢复
- 典型端到端时序见「2.7 典型 loop」

#### （2）属性清单

实例行上的全部可判定/可继承字段（出生即定 + 运行期可写面）：

| 类别 | 字段 |
|---|---|
| **出生即定** | `id`（路径 `x.x`）、`classRef`、父（=`parentIdOf`）、`assemble`、`toolOverride` |
| **运行期可写**（`kernel.updateAgent`） | `name` / `model` / `temperature` / `effort` |
| **派生/账目** | `status` / `turnCount` / `totalCost` / `totalTokens` / `ctxTokens` / `modelBinding` |

**AgentClass（模板基因）**：`name / description / systemPrompt / tools / contextStrategy / model / sendCountdown / temperature / effort`。类文件住 `.stem/agent/<name>.md`。

**父与 userPrompt 不落库**——父纯推导，userPrompt 只走首信。属性如何沿族谱继承/收敛 → 见 2.2。

#### （3）记忆策略（上下文策略）

`contextStrategy` 挂在类基因上，实例化时确定；实现 = 独立模块（`core/context/strategies/`）。

| 策略 | 行为 |
|---|---|
| `classic` | 全量直出 + 阈值 compact（摘要 worker，旧段 markInvalid 可逆） |
| `cortex` | 三层外挂记忆（LTM / 笔记 / STM）+ 阈值做梦二段事务 |
| `none` | 面板态（不组装、不跑 LLM） |

契约两段式：`process`（异步许可，user_prompt 抵达触发）与 `assemble`（纯函数快照，快递员只发不组装）分离；可导出专有动作（compact/dream）与 raise 声明清单。详见 `src/core/context/README.md`。

### 2.2 族谱树（实例树）——继承 / 收敛 / id 索引

族谱树不描述「agent 内部怎么跑」，只描述**实例之间的属性关系与寻址**。

#### 基于 id 的族谱索引

- **id = 出生路径**：根 `0`；root 第 N 子 = `N`；子 = `<父id>.<出生序号>`（`1.3.2`）。序号永不回收（terminate 留墓碑）
- **父纯推导**：`parentIdOf`（`1.3`→`1`，`3`→`0`，`0`→null）；祖先链 = 字符串前缀；**父不落库**
- **呈现**：统一 `name#id`；写面解析 name 优先 → `name#id` → 唯一 id 前缀
- **可见域**：`canReach(viewer, target)` ⟺ 自身 ∨ 祖先——销毁/中断/上下文/telemetry/审批统一走它

#### 属性表的继承与收敛（多数属性）

实例在族谱上是**属性节点**。**继承-收敛链针对整张属性表**，不是只对 tools：

```
父属性表（继承）
    → 基类属性（收敛①：本类基因套在父生效值上）
    → 实例化入参（收敛②：显式参数覆盖/收紧）
    → agent 节点属性表（出生落地，随实例行持久）
```

| 步 | 含义 | 模型 `model` | 温度/思考强度 | 工具清单 `tools` |
|---|---|---|---|---|
| **继承** | 从父节点生效值出发 | 父 `modelBinding` | 父 `temperature`/`effort` | 父 `{explicit, fallback}` |
| **收敛① 基类** | 本类基因优先则覆盖 | 类 `model` | 类 `temperature`/`effort` | 类 `tools` 白名单套上 |
| **收敛② 实例化** | 实例化入参再收一层 | 显式 `model` | 显式 temperature/effort | `toolOverride` |
| **节点属性表** | 出生解析落地 | `modelBinding` 随行 | 写回实例行 | 物化生效档案 |

字段级通用规则：

- **解析序**：实例显式 > 类基因 > 父继承（严格父子相对，无跨代直达）
- **出生落地**：`modelBinding` / `temperature` / `effort` 随实例行持久；改父不级联子女
- **策略 raise**（当前实现，仅 tools）：插在类与实例之间，只抬不封；策略层近期可能整体重构

**tools 字段**除上述表级继承外，还有更细的**四态权限代数**（白名单、只紧不松、ask 审批）→ 专节 **2.3**。

**物化门面 `LineageTree`**（`core/lineage/`）：拓扑（纯推导）+ 能力（`attach`/`replay`，可启动重建、纯派生不入库）+ 可见域。权限算法住 `AccessLedger`，对外只经门面。

**根 `user#0`**：`user` 类普通实例，pilot 初始化内同一 `instantiate` 路径出生；唯一特殊性 = 面板性（`assemble:false`）。`config.user` = user 类完整基因（model/tools/systemPrompt/temperature/effort…），与其它类同一套继承-收敛机制。

实现细节：`src/core/lineage/README.md`、`src/core/kernel/README.md`。

### 2.3 工具权限控制（四态收敛）

**一句话**：权限只有两个来源——**注册即出生声明**（有什么、出身多宽）与**收敛清单**（沿族谱链谁能用到哪级）；ask 审批是**消息交换**。

| 状态 | 暴露给 LLM | 执行时 |
|---|---|---|
| `allow` | ✅ | ✅ 直接执行 |
| `ask` | ✅ | ⏸ 挂起（申请投族谱根信箱，等根 `access_reply`） |
| `deny` | ❌ | ❌ `access_denied` |
| `ignore` | ❌（背景在场） | ✅ 可执行（不设防） |

- **收敛链**与 2.2 的 tools 列同一把尺
- **键即白名单**：写了 = 未列出局；**整表缺席 = 完整继承**；空表 = 全关
- **只紧不松**：严格度总序 `deny ≺ ask ≺ allow ≺ ignore`；扩张即拒（写入面）或静默钳制（物化面）
- **两步独立归因**：类收敛 ≠ 实例收敛，不预合并
- **模型可见 = allow ∪ ask**；`kind` 三分类纯 provenance，不参与权限推断
- **boot 校验律**：根 `access_reply ≠ allow` 拒启（ask 消息化死锁审判）

细节：`src/core/tools/README.md`、`src/core/lineage/README.md`。

### 2.4 邮局模型（context）

一切消息进**仓库**，由**管理员**处理/组装，**快递员**倒计时投递。

| 角色 | 职责 |
|---|---|
| **Repository** | 上下文本体唯一存储；`markInvalid`/`updateMessage` 可逆改写 |
| **ContextManager** | 打戳（`<sender id="name#id" at="…">`）· Waiter 统一挂起 · 策略 process · 组装 + legalize |
| **Courier** | 倒计时送信（初始 0 立即送；发送后进入合并窗口；来信重置） |

**唤醒语义**：只有外部 `deposit` 触发快递员；agent 自身 `appendHistory` 不重投递。统一挂起 `Waiter`：`ask` / `instantiate.wait` / `agent_pause` 同一原语（`wait/emit/cancelOwner`）。

**上下文策略**：`classic`（直出 + compact）/ `cortex`（三层记忆 + 做梦）/ `none`（面板）；契约 `process`（异步许可）与 `assemble`（纯函数快照）分离。详见 `src/core/context/README.md`。

**消息库**：`tag`（合成消息出处）+ `turn`/`indexInTurn` 双索引；`legalize` 保证改后仍可经 gateway 发送。

### 2.5 stem 空间与配置文件

**一进程一空间**：project root 定位 = 位置参数 > `STEM_PROJECT_ROOT` > cwd（`shell/cli/platform.resolveProjectRoot`）。空间根下的 `.stem/` = 世界。

```
<projectRoot>/
└── .stem/
    ├── stem.jsonc        唯一配置文件（JSONC，可注释/尾逗号）
    ├── agent/<名>.md     AgentClass 目录即真相（frontmatter + systemPrompt 正文）
    ├── context/<名>.ts   用户上下文策略（目录即真相）
    ├── tools/<名>.ts     自定义工具（须 config.extensions.tools 点名才进世界）
    ├── mem/<agentId>/    策略派生文件（如 cortex 笔记；不进 DB）
    └── stem.db           个体层 SQLite（见 2.5）
```

**配置文件 `stem.jsonc`**（顶层键全表；未知键 boot fail-fast）：

| 键 | 作用 |
|---|---|
| `providers` | 模型端点注册表：`base_url` / `key_env`（密钥只走 env 名）/ `models` 白名单 |
| `user` | 根的完整类对象（人格/tools/contextStrategy/**model**/name…= user 类基因） |
| `autoApprove` / `sendCountdown` | 运行策略参数 |
| `context` | 窗口与 compact 参数 |
| `bash` | shell 工具路径/超时/截断/cwd |
| `tools` | `outputLimit` 等输出窗口 |
| `extensions` | `{tools?, agent?, context?}` 点名启用 extension 条目 |
| `custom` | 唯一合法扩展位 |

**两条真相律**：

- **config 即全部配置**——首启模板住 `config/defaults.ts`（文件缺失时内存等效）。
- **目录即真相**（类/策略层）——`.stem/agent/`、`.stem/context/` 自动装载，进化书写面；工具仍须点名。

`.stem/agent` 契约：文件名即类名；YAML frontmatter（未知字段拒收）+ 正文 = systemPrompt；往返律 `parse(serialize(cls)) ≡ normalize(cls)`。详见 `src/core/config/README.md`。

### 2.6 SQLite 数据结构

个体层（消息/实例）落 `.stem/stem.db`（`shell/cli/storage/sqliteStore.ts`，schema **v4**，零历史兼容——版本不符拒载，无迁移脚本）。

```sql
-- 上下文语料（唯一消息真相）
messages (
  id       TEXT PRIMARY KEY,     -- 消息 id（含序号信息，供 seq 推导）
  agent_id TEXT NOT NULL,        -- 所属 agent
  seq      INTEGER NOT NULL,     -- 入库序号（查询排序）
  message  TEXT NOT NULL,        -- StoredMessage 全量 JSON
  archived INTEGER DEFAULT 0     -- markInvalid / terminate 软删（可逆审计）
);
CREATE INDEX idx_messages_agent ON messages (agent_id, seq);

-- 实例行（含墓碑：terminate 不删，保 id/name 占用）
instances (
  id       TEXT PRIMARY KEY,     -- 出生路径 id
  instance TEXT NOT NULL         -- AgentInstance 全量 JSON
);
```

| 约定 | 说明 |
|---|---|
| **行 = 全量 JSON** | 冗余列仅供查询；语义转换只在 core 侧 |
| **write-through** | 内存核先生效，装饰器同步落行；驱动 `node:sqlite` DatabaseSync |
| **journal** | 默认 rollback（不启 WAL——WSL `/mnt/c` 9P 下 WAL-shm 有风险） |
| **恢复** | `loadBoxes`（archived=0）+ 实例 restore；`wireRestoredContexts` 在 runInit 载齐类/策略后一次完成 |
| **归档** | destroy/markInvalid 置 `archived=1`，语料保留、恢复不加载 |
| **派生文件不进 DB** | 记忆真相在仓库行；`.stem/mem/` 磁盘镜像单向永不回灌 |

### 2.7 典型 loop（从首个 userPrompt）

```
1. pilot.sendMessage(to, text)
   → 根 assistant transcript 入库
   → deposit(from=根) → 仓库 append → 打戳 → onChange

2. 管理员 wake
   → 策略 process（user_prompt 触发；compact/dream 在此）
   → 就绪 → 快递员 notifyReady（倒计时合并窗口）

3. 快递员
   → 委托管理员组装（策略 assemble + legalize）
   → 发送 AgentDelivery → kernel.processDelivery

4. Runtime
   → status=thinking → LLM → 工具轮（并行）
   → contextWait 收束 / 步数上限收束
   → assistant 行入库 → 最终文本 deposit 给族谱父

5. 若父在 instantiate.wait / waitForReply 挂起
   → 回信作为 tool 结果填充 → 唤醒父续轮

6. 根收 letter 事件 → shell/webui 展示
```

中断：`interruptAgent`（自身或祖先）→ Runtime.abort → `halt` 消息闭合（部分文本 + `<interrupted>`）→ `interrupted` 可恢复。进程收尾：`system.dispose()` → `drainForShutdown`。

---

## 三、模块导航

| 层 | 模块 | 职责 | README |
|---|---|---|---|
| core | main | 组合根 + 装载管线 + Runtime + 工具接线 | `src/core/main/README.md` |
| core | kernel | 领域聚合 + 运行期写通道 + 端口适配器 | `src/core/kernel/README.md` |
| core | lineage | 族谱树：拓扑 + 能力物化 + canReach | `src/core/lineage/README.md` |
| core | context | 邮局 + Waiter + 策略 | `src/core/context/README.md` |
| core | tools | 工具框架 + 四态代数 + internal 工具 | `src/core/tools/README.md` |
| core | gateway | 模型网关契约 + provider | `src/core/gateway/README.md` |
| core | config | StemConfig + `.stem/agent` 契约 | `src/core/config/README.md` |
| core | pilot | 根扮演接口 | `src/core/pilot/README.md` |
| core | events | PilotEvent + EventHub | `src/core/events/README.md` |
| core | logging | LogEvent + Logger | `src/core/logging/README.md` |
| shell | cli | 参考 shell + bootStem + SQLite | `shell/cli/README.md` |
| shell | webui | HTTP + SSE 单页 | `shell/webui/README.md` |
| shell | dashboard | 空间仪表盘（只读） | `shell/dashboard/README.md` |
| shell | feishu | 飞书长连接远程 shell | `shell/feishu/README.md` |
| ext | extension | 矩阵 extension 层 | `extension/README.md` |

**事件流**（跨 shell 观察面）：`PilotEvent` 四元——`stream`（LLM 流式）/ `letter`（信箱来信，含 access_request）/ `status` / `tool`（相位 called|success|error）。多订阅者 EventHub；新订阅者拿不到历史（初始视图靠直接查询模块）。

---

## 四、技术选型

- TypeScript + tsx（dependencies）+ node:test；运行时依赖 jsonc-parser / yaml；**node ≥ 23.4**（`node:sqlite` 免 flag）
- 发布：Docker（`node:24-slim` + 非 root + `/data` volume + HEALTHCHECK）——**容器即 bash 安全边界**
- LLM：OpenAI 兼容端点（config.providers 路由；密钥只走 env `key_env`）；测试 FakeGateway / mock SSE
