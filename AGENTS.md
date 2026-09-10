# AGENTS.md

> 本文件 = 每次会话必读的最小上下文：硬规则 + 命令 + 结构 + 概念速查。
> **机制细节一律看 `docs/architecture.md`（实况以此为准）；工程纪律动手前通读 `docs/contributor.md`。** 勿往本文缝细节。

## 项目

**stem**（Self-Training Evolutionary Matrix）= 以**原子化 AgentClass（模板）+ Agent 实例**为核心的自主多 agent 系统：类可自由创建/实例化，配**族谱树**与协作，让 AI 自己管理 agent 信息、自我进化。定位 = **用户主权的 Agent 系统**，宿主无关（core 零平台依赖，已从 VSCode 剥离）。

- `reference/` 是参考源码（deepseek-harness/pi/opencode/VSCode），**非本项目产物**，类型/编译错误可忽略。
- `docs/prompts.md` = 需求与优化台账（不提交）；`docs/log1.md` / `log2.md` = 历史卷（只追加）。

## 设计原则（硬规则）

1. **全体 agent 绝对平等**：根（全名 `user#0`，出生路径 id `0`，`parentId=null`）是内置 `user` 类的普通实例，无任何权限/身份特判。根唯一独有的是**面板性**（kernel 根接线 `assemble:false`：不组装、不跑 LLM 轮，由外部 shell 扮演）——扮演接口的身份，不是特权。差异只由类/实例配置与族谱收敛产生。
2. **机制大于判断**：能靠既有机制表达的需求不新增组件。ask 审批 = 消息交换（`access_request` → 根信箱 → `access_reply`）；上下文删除 = `markInvalid` + 组装 `legalize`。
3. **权限与模型 = 族谱位置的函数**：注册期 attach/replay 物化（内部 `AccessLedger`），tools 经 `AccessResolver` 端口查询，跨 agent 操作统一树谓词 `canReach`。**键即白名单**（未列 = 本地 deny；祖先显式判定锁子孙；严格度总序 `deny≺ask≺allow≺ignore` 只许顺链收缩；类 tools 未设 = 完整继承，`{}` = 本地封闭）；`grant` = 清单整表替换 + 逐键祖先封顶（spawn 受限 / `agent_update.grantTools`）。**模型四级律**：实例显式 > 类基因 > 出生快照 > 父继承 > 家学（`config.user.model` 必填锚点）；改父不级联子女。
4. **模块自治**：装配在 core（`createStemSystem` 组合根，平台能力接口注入）；shell 只做平台适配 + UI；外部交互经模块接口（pilot = 根扮演接口）。
5. **分层**：`shell`（最外）→ `core`（agents + 系统工具 + bash = 最小系统）→ `extension`（目录形态资源）；core 零平台依赖（禁平台全局）。**少即是多**：优先 `init` 生命周期扩展，不新建子系统。
6. **对外操作面 = bash 单点**：无 ask、无黑名单（对齐 pi），事故半径靠硬超时 / 输出截断 / 默认 cwd。**容器即边界**：挂载 volume 即爆炸半径，不建议裸机暴露 webui。

## 快速命令

```bash
npm install                 # 依赖（node >= 23.4，node:sqlite 免 flag）
npm run typecheck           # tsc --noEmit（唯一 lint/typecheck）
npm test                    # 全量单测（node:test）
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑
npm run test:feas           # 离线可行性冒烟（mockSse 零密钥；在线两档见 contributor §6.2）
npm run shell               # CLI：cwd 即空间（`-- <path>` 指定；key 走 env）
ALIBABA_API_KEY=<key> npm run shell   # 真实网关（密钥只走 env，config providers.<p>.key_env 声明变量名）
npm run web                 # WebUI http://localhost:4321（`-- <path>` / STEM_PROJECT_ROOT）
npm run dashboard -- [path] # 仪表盘 http://localhost:4421（DB 只读直查；--allow-write 解锁清理）
npm run feishu -- [path]    # 飞书长连接远程 shell（FEISHU_APP_ID/SECRET 走 env）
python3 run-docker.py       # 容器一键起（Windows/WSL 双端）
```

## 项目结构

```text
src/core/       纯 TS 零平台依赖（硬规则；全表见 contributor §2.1）
  config/       StemConfig + JSONC 解析 + defaults.ts（首启模板 = 唯一预设）+ agentFile.ts（.stem/agent 文件契约）
  context/      重建邮局：Repository/ContextManager/Courier + tag/双索引 + legalize + strategies/(classic/cortex/none)
  events/       PilotEvent(五元) + EventHub
  gateway/      ModelGateway + providers/openaiCompatible + FakeGateway
  main/         createStemSystem 组合根 + runInit 矩阵装载 + runtime 执行器 + 端口适配（唯一 import 一切）
  kernel/       Kernel/TemplateRegistry/InstanceManager/SpaceManager + builtin/agents + 持久化端口/装饰器 + RuntimePort/SystemFacade
  lineage/      LineageTree：拓扑 + 能力物化（权限/模型）+ canReach 唯一门面
  logging/      LogEvent + Logger（注入 LogSink，运行时内存）+ forget
  pilot/        根（user#0）扮演接口（依赖 SystemFacade 门面）
  tools/        ToolCapabilityRegistry + access 四态代数 + accessRequest + output（统一输出）+ internal/（系统工具 + bash）
shell/          宿主层：cli/（bootStem + SQLite + mockSse）/ webui/ / dashboard/ / feishu/
extension/      矩阵 extension 层：tools/（fs 五件套 + web 两件 + _lib）/ agent/（creator）/ context/
test/           support/ + feasibility/（四档冒烟）+ space-demo/ + space-v10/
docs/           实况卷 architecture.md（机制以此为准）/ contributor.md（工程纪律）/ scenarios.md
                api.md / dev-guide.md（交付产物，1.0 前可能滞后）
                log1.md / log2.md（历史卷，只追加）/ prompts.md（需求台账，不提交）
```

## 核心概念速查（详情 = architecture.md 对应节）

- **AgentClass**：name 即 id；`tools` 四态 Record（键即白名单；未设 = 继承，`{}` = 封闭）；contextStrategy 实例化时固化；panel = 模块扮演；custom 自由位。→ arch §2/4.6
- **AgentInstance**：id = 出生路径（根 `0`，子 `<父id>-<序号>`，序号永不回收，terminate 落墓碑）；name 全局唯一（缺省派生 `类名-N`）；parentId = 创建者 = 族谱父；model/modelSnapshot 随行持久；轮账 turnCount/totalCost/totalTokens（终身累计）走 recordTurnEnd；状态 idle→thinking→holding，interrupted 可恢复。呈现 `name#id`，写面三形态寻址。→ arch 2.1/4.3
- **族谱树**：实例层派生事实唯一面（拓扑实时推导 + 权限/模型注册期物化 + canReach）；纯派生不入库。→ arch 4.4
- **邮局**：仓库 → 管理员（打戳/策略 process/组装/legalize/waitForReply）→ 快递员（倒计时送信，只发不组装）；通信 = `kernel.sendMessage`，无总线。→ arch §3
- **上下文策略**：契约 note/role/tools/assemble/process/actions/init（tools = 收敛链 raise 声明清单）；触发 = user_prompt 抵达，终点 = 唤醒快递员；classic = 直出 + compact（markInvalid 可逆）；cortex = 三层记忆（LTM/笔记/STM）+ 阈值做梦二段事务（dreamer 回信交付）；`.stem/context/*.ts` 可覆盖。→ arch 2.2b
- **工具与访问**：注册即出生声明（internal 注册点写死：`access_reply`/`bash` allow，其余 ignore；extension/custom 经 `config.extensions.tools {名:权限词}` 点名，**未点名 = 不存在**）+ 收敛链（根→类→[策略]→实例逐级收紧）；模型可见 = allow ∪ ask；kind 纯 provenance。→ arch 2.2/4.5/4.9
- **消息库**：StoredMessage tag（六元词表）+ turn/indexInTurn 双索引；信件戳 `<sender id="name#id" at="yymmdd.hhmm">`；tokens = 网关真实值差分归位、chars/4 兜底。→ arch 2.6
- **持久化**：个体层 SQLite write-through（消息/实例/空间，schema v3——版本不符 = 拒载硬错）；类/策略/工具 = 文件真相；一空间一库一进程；重启 = 装载 + 归一化 + replay + 零重放。→ arch 4.15
- **配置**：`.stem/stem.jsonc` 唯一载体（`providers.key_env` 存变量名不存密钥；`user` = 根的完整类对象，`user.model` 必填家学锚点；R12 未知顶层键 fail-fast；类/策略目录即真相，config 永不回写）。→ arch 4.12
- **进化闭环（人启动）**：agent_class_create/update（同名覆盖、tools 只许收敛、落盘 `.stem/agent/`、只影响后续实例）+ telemetry_query（可见域日志）+ 重启新实例携带新基因。记忆生理层 = cortex。→ arch 4.6
- **实例参数唯一写面**：`agent_update`（缺省目标 = 自身，canReach）= model / name / tools 收敛 patch / grantTools 整表；写实例行 → 全树 replay。类/拓扑/策略/提示词永不入此通道。→ arch 2.2/4.3/4.4
- **事件流**：PilotEvent 五元（stream/letter/status/tool/notice）；tool 事件只带名字/相位不带参数，详情走 DB；EventHub 多订阅者。→ arch 2.4

## 门槛

`npm run typecheck` 0 错误 + `npm test` 全绿；改跨模块机制跑 `npm run test:feas` 离线档；改行为在 `docs/log2.md` 追加一条；commit message 只描述功能变化、禁进度代号，**提交前先征得用户同意**。全文见 `docs/contributor.md §6/§7`。

## 文档管理

docs下面的`logx.md`是所有迭代记录的日志，只做尾部追加（避免撑爆上下文）；交付产物不需要每次迭代都进行更新，只需要发布前更新就够了；临时信息（典型如步骤代号、日期等）不进持久化文档
