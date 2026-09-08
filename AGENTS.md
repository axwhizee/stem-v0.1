# AGENTS.md

## 项目概览

**stem**（Self-Training Evolutionary Matrix）—— 以**原子化 AgentClass（模板）+ Agent 实例**为核心的 Agent 系统：类可自由创建/实例化，配**族谱树**与多 agent 协作，让 AI 自己管理 Agent 信息实现自我进化。定位是**用户主权的 Agent 系统**，宿主无关（core 零平台依赖，已从 VSCode 剥离）。

- `reference/` 为参考源码（deepseek-harness/pi/opencode/VSCode），**非本项目产物**，其类型/编译错误可忽略。
- 工程纪律（分层契约/命名/错误/测试/提交/环境陷阱/文档维护）全在 **`docs/contributor.md`——动手前通读**。
- 本文只承载"每条会话都必须知道的硬规则 + 操作命令 + 概念速查"；**机制细节一律在 `docs/architecture.md`（实况以此为准）**，勿往本文缝细节。

## 设计原则（硬规则）

1. **全体 agent 绝对平等**：根（全名 `user#0`）是内置 `user` 类的普通实例（`parentId=null`，出生路径 id `0`），无任何权限/身份特判（根可见性 = 树结构天然全视，审批权 = `access_reply` 答复义务，皆结构性事实）。根唯一独有的是**面板性**：经 kernel 根接线 `assemble:false`（不组装不跑 LLM 轮，信件由扮演它的外部 shell 消费）——"扮演接口"的身份而非特权。一切差异仅由类/实例配置与族谱收敛产生。
2. **机制大于判断**：能靠既有机制表达的需求不新增组件。ask 审批是**消息交换**（`access_request` → 根信箱 → `access_reply`），不是系统耦合通道；上下文删除 = `markInvalid` + 组装时 `legalize`。
3. **权限与模型收敛走族谱树**：生效权限 = **族谱位置的函数**（注册期 attach/replay 物化，内部 AccessLedger；跨 agent 操作统一树谓词 `canReach`；tools 经 `AccessResolver` 端口查询，kernel 无编排）。**键即白名单=自我限定**（未列=本地 deny；祖先**显式**判定锁子孙，严格度**总序** `deny≺ask≺allow≺ignore` 只许顺链收缩——藏匿/放宽皆扩张被拒；类 tools 未设 = 完整继承父档案，空表 = 本地封闭）；`grant` = 清单形整表替换（给定即全部能力、未列一律 deny、逐键经祖先显式**封顶**——无扩张面，模型侧经 agent_update.grantTools 可达，系统侧 spawn/宿主专用）；session always = ask 免询问备忘（非权限层，deny 在途复核压死）。**模型同门面，四级律**：显式（实例行）> 类基因 > 出生快照 > 父继承 > 家学（config.user.model 必填锚点；setModel 不级联子女，快照随实例行跨重启）。
4. **模块自治**：初始化/装配在 core（`createStemSystem` 组合根，平台能力经接口注入）；shell 只做平台适配 + UI；外部与 core 的一切交互经模块接口（pilot = 根扮演接口）。
5. **少即是多**：工具生命周期（`init`）扩展优先于新建子系统；internal 工具列表不固化、随开发增长。
6. **架构分层**：`shell`（交互层，最外）→ `core`（agents 生态 + 系统工具 + bash = 最小系统）→ `extension`（矩阵扩展层：tools/agent/context 目录形态资源）。
7. **对外操作面 = bash 单点**：除系统工具外模型触达外部文件/系统的唯一入口是 core bash 工具（执行经 `ShellRunner` 端口宿主注入）。**无 ask、无黑名单**（对齐 pi）——事故半径靠超时/输出截断/默认 cwd 三机制。**容器即边界**：发布形态挂载 volume 即爆炸半径，不建议裸机对外暴露 webui。

## 快速命令

```bash
npm install                 # 安装依赖（node >= 23.4，node:sqlite 免 flag）
npm run typecheck           # tsc --noEmit 类型检查（唯一 lint/typecheck；reference/ 噪音 grep -v 掉）
npm test                    # 全量单测：tsx --test src/shell/extension 三层 *.test.ts
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑（node:test 并发）
npm run test:feas           # 可行性冒烟离线档（test/feasibility，mockSse 零密钥）；
                            #   在线两档需 ALIBABA_API_KEY=<key>（真网关/双服务，见 contributor §6.2）
npm run shell               # CLI shell：cwd 即空间（opencode-style；`-- <path>` 指定目录）
ALIBABA_API_KEY=<key> npm run shell   # 真实网关（密钥只走 env：config providers.<p>.key_env 声明变量名）
npm run web                 # WebUIShell（http://localhost:4321；空间定位同上，`-- <path>`/STEM_PROJECT_ROOT）
npm run feishu -- [path]    # 飞书 shell（长连接远程宿主，免公网；FEISHU_APP_ID/SECRET 走 env，
                            #   .stem/feishu.jsonc 自治理配置；显式会话 /new /use /exit +
                            #   上下线通知与断线补偿 + 审批卡远程裁决）
npm run dashboard -- [path] # 空间仪表盘（http://localhost:4421；法医/管理员 shell：DB 只读直查 +
                            #   标本装配资源清单 + 清理；--allow-write 才解锁写操作，可与 webui 并开）
npm run build               # 与 typecheck 相同（tsc --noEmit）
python3 run-docker.py       # 容器一键起（Windows/WSL 双端：读用户 env 密钥 + 卷管理 + 配置安检）
docker build -t stem:1.0 . && docker run -d -p 4321:4321 -v stem-data:/data stem:1.0   # 发布形态
docker run -d -p 4321:4321 -v stem-data:/data -e <providers 声明的 key_env 名>=<key> stem:1.0   # 真实网关
```

## 项目结构

```text
src/core/                  # 纯 TS 领域逻辑，零平台依赖（硬规则，全表见 contributor §2.1）
  ├── config/              # StemConfig + JSONC 解析 + defaults.ts（首启模板 = 唯一预设）
  ├── context/             # 重建邮局：Repository + ContextManager + Courier + tag/双索引
  │                        #   + legalize + strategies/（策略子模块：契约+注册表+classic/none）
  ├── events/              # PilotEvent + EventHub
  ├── gateway/             # ModelGateway + providers/openaiCompatible + FakeGateway
  ├── init/                # createStemSystem 组合根 + runInit 矩阵装载 + agentParse/agentSerialize
  ├── kernel/              # Kernel + builtin/（Assistant 占位类）+ TemplateRegistry/
  │                        #   InstanceManager/SpaceManager/Runtime + builtin/agents 类表 + 持久化端口/装饰器
  ├── lineage/             # LineageTree：拓扑 + 能力物化（权限/模型）+ 可见域 canReach 唯一门面
  ├── logging/             # LogEvent + Logger（注入 LogSink）+ forget（孤儿 promise 安全阀）
  ├── pilot/               # Pilot：根（user#0）扮演接口（sendMessage/instantiate/setModel/replyAccess）
  ├── tools/               # ToolCapabilityRegistry + access 四态代数 + accessRequest（ask 消息化）+ bash
  └── types.ts
shell/                     # 宿主层：cli/（bootStem 装配 + SQLite storage + mockSse）+ webui/ + dashboard/
                           #   + feishu/（飞书长连接远程 shell：router 纯逻辑 + SDK 适配 + 审批卡）
extension/                 # 矩阵 extension 层：tools/（fs 五件套 + web 两件 + _lib）+ agent/（creator）
test/                      # 测试工作区：support/（kernelHarness/mockSse 兼容层）+ feasibility/
                           #   （四档冒烟 + ask3/update2/tree3 编排 + tools/ 起服脚本）
                           #   + space-demo/（演示空间）+ space-v10/（验收现场）
docs/                      # 实况卷 architecture.md（机制详情以此为准）/ api.md（接口清单）/
                           #   dev-guide.md（扩展食谱）/ contributor.md（工程纪律）/
                           #   scenarios.md（目标场景）
                           #   历史卷 log1.md/log2.md（日志滚动卷，卷一 2026-09-07 封存）/ prompts.md（需求，不提交）；plan 卷落地即退役
```

## 核心概念速查（详情 = architecture.md 对应节）

- **AgentClass**：name 即 id；tools 四态 Record（键即白名单，未设=继承/{}=封闭）；contextStrategy 实例化时固化；panel=模块扮演（不组装不跑轮）；custom 自由位。→ arch §2/4.6
- **AgentInstance**：id = 出生路径（根 `0`，子 `<父id>-<序号>`，序号永不回收，terminate 落墓碑）；name 全局唯一称呼（缺省派生 `类名-N`，agent_update.name 可改）；parentId = 创建者 = 族谱父；model/modelSnapshot 随实例行持久；状态机 idle→thinking→holding，interrupted 可恢复。呈现面统一 `name#id`，写面三形态寻址（name / name#id / 唯一 id 前缀）。→ arch 2.1/4.3
- **族谱树**：实例层派生事实唯一面（拓扑实时推导 + 权限/模型注册期物化 + canReach 可见域）；纯派生不入库。→ arch 4.4
- **邮局**：仓库→管理员（打戳/策略 process/组装/legalize/waitForReply 配对）→快递员（倒计时送信**只发不组装**）；通信 = kernel.sendMessage，无总线。→ arch §3
- **上下文策略**：契约 `ContextStrategyModule`（note/role/tools/assemble/process/actions/init；tools = 收敛链 raise 声明清单），触发 = user_prompt 信抵达、终点 = 唤醒快递员；classic = 直出 + compact（markInvalid 归档可逆）；cortex = 三层外挂记忆（LTM/笔记/STM，仓库记忆组 + `.stem/mem/` 单向镜像）+ 阈值做梦二段事务（dreamer 回信交付 `<cortex_dream>` 报告、schema 校验纠错循环住 spawn，轮替即归档）；`.stem/context/*.ts` 用户可覆盖。→ arch 2.2b
- **工具与访问**：注册表出生声明（internal 注册点写死 birth：access_reply/bash allow 其余通例 ignore；extension/custom 经 `config.extensions.tools {名:权限词}` 点名=装载+出生一句话，**目录扫描废止**）+ 单操作收敛链（根→类→[策略]→实例逐步收紧，出生值全局封顶；模型可见 = allow∪ask）+ boot 律（根 access_reply 非 allow 拒启/点名不可解析拒启）；kind 纯 provenance。ask 命中投 `<access_request>` 到申请者族谱根信箱，根经 access_reply 裁决。→ arch 2.2/4.5/4.9
- **消息库**：StoredMessage tag（合成标记）+ turn/indexInTurn 双索引；信件戳 `<sender id="name#id" at="yymmdd.hhmm">`（打戳器唯一在管理员）；tokens = 网关真实值差分归位、chars/4 兜底；remove/edit = markInvalid/update + legalize 保组装合法。→ arch 2.6
- **持久化**：个体层 SQLite write-through（消息/实例/空间，schema v3——版本不符 = 拒载硬错零兼容）；类/策略/工具 = 文件真相不进 DB；一空间一库一进程，`stem [path]`>env>cwd 定位；重启 = 装载+归一化+replay+零重放。→ arch 4.15
- **配置**：`.stem/stem.jsonc` 唯一载体（providers.key_env 永不承载明文密钥；user = 根的完整类对象含家学 model 锚点与 name 出生称呼（缺省 'user'→全名 user#0）与根收敛清单 tools（推荐实值住模板）；R12 未知顶层键 fail-fast；agent 类/策略目录即真相、config 永不回写）。→ arch 4.12
- **进化闭环（人启动）**：agent_class_create/update（同名覆盖、tools 只许收敛、落盘 `.stem/agent/`、只影响后续实例、panel/user 类拒绝）+ telemetry_query（可见域日志）+ 重启新实例携带新基因。→ arch 4.6；记忆生理层 = cortex（已实施）
- **实例参数唯一写面**：`agent_update`（缺省目标=自身，canReach）= model / name（全局唯一，撞名拒）/ tools 收敛 patch / grantTools 清单整表（两形式互斥）；写实例行 → 族谱全树 replay（收缩沿链下传、改父不动子靠快照）。类定义/拓扑/策略/提示词永不入此通道。→ arch 2.2/4.3/4.4
- **事件流**：PilotEvent（stream/letter/status/notice）经 EventHub 多订阅者，shell/webui 统一订阅。→ arch 2.4

## 测试与提交（全文 = contributor §6/§7）

门槛 typecheck 0 + `npm test` 全绿；跨模块机制动过跑 `npm run test:feas` 离线档；commit message 只描述功能变化、禁进度代号；改行为 log2.md 追加一条。
