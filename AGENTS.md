# AGENTS.md

> 本文件 = 面向 agent 的**实操手册**：硬规则 + 命令 + 环境坑 + 纪律。
> 项目本身（定位/架构/概念/参数/工具清单/上手）看 `README.md`；机制细节看 `docs/architecture.md`（实况以此为准）；完整工程纪律看 `docs/contributor.md`。**两份文档不重复叙述：项目描述归 README，坑与纪律留本文件。**

## 项目速记（描述看 README）

**stem**（Self-Training Evolutionary Matrix）= 以**原子化 AgentClass（模板）+ Agent 实例**为核心的自主多 agent 系统：类可自由创建/实例化，配**族谱树**与协作，让 AI 自己管理 agent 信息、自我进化。定位 = **用户主权的 Agent 系统**，宿主无关（core 零平台依赖，已从 VSCode 剥离）。完整描述见 `README.md`。

agent 须知：
- `reference/` 是外部参考源码（deepseek-harness/pi/opencode/VSCode），**非本项目产物**——其类型/编译错误一律忽略。
- `docs/prompts.md` = 需求与优化台账（不提交）；沿革由 git 提交历史承载（改行为 → commit message 说清）。

## 设计原则（硬规则）

1. **全体 agent 绝对平等**：根（全名 `user#0`，出生路径 id `0`，`parentId=null`）是内置 `user` 类的普通实例，无任何权限/身份特判。根唯一独有的是**面板性**（kernel 根接线 `assemble:false`：不组装、不跑 LLM 轮，由外部 shell 扮演）——扮演接口的身份，不是特权。差异只由类/实例配置与族谱收敛产生。
2. **权限与模型 = 族谱位置的函数**：注册期 attach/replay 物化（内部 `AccessLedger`），tools 经 `AccessResolver` 端口查询，跨 agent 操作统一树谓词 `canReach`。**键即白名单**（未列 = 本地 deny；祖先显式判定锁子孙；严格度总序 `deny≺ask≺allow≺ignore` 只许顺链收缩；类 tools 未设 = 完整继承，`{}` = 本地封闭）；`grant` = 清单整表替换 + 逐键祖先封顶（spawn 受限 / `agent_update.grantTools`）。**模型四级律**：实例显式 > 类基因 > 出生快照 > 父继承 > 家学（`config.user.model` 必填锚点）；改父不级联子女。
3. **模块自治**：装配在 core（`createStemSystem` 组合根，平台能力接口注入）；shell 只做平台适配 + UI；外部交互经模块接口（pilot = 根扮演接口）。
4. **分层**：`shell`（最外）→ `core`（agents + 系统工具 + bash = 最小系统）→ `extension`（目录形态资源）；core 零平台依赖（禁平台全局）。**少即是多**：优先 `init` 生命周期扩展，不新建子系统。
5. **对外操作面 = bash 单点**：无 ask、无黑名单（对齐 pi），事故半径靠硬超时 / 输出截断 / 默认 cwd。**容器即边界**：挂载 volume 即爆炸半径，不建议裸机暴露 webui。
6. **对过时文件/死代码零容忍**，文档忠于现状、不写临时行为。

## 工作方法：加减法

- **加法**：满足需求、增加功能时放手做加法——把能力完整做进去，不为省事留半成品。
- **减法**：代码审阅/优化时做减法——**用通用、清晰的机制替代冗杂的打补丁**，删特判、去重复、灭死代码（硬规则 6）。
- 落点：新需求先问「既有机制能否自然表达」——能则复用收敛、不新增组件，不能才加法；批末回看这段逻辑能否用更少、更通用的原语重写。

## 快速命令

```bash
npm install                 # 依赖（node >= 23.4，node:sqlite 免 flag）
npm run typecheck           # tsc --noEmit（唯一 lint/typecheck）
npm test                    # 全量单测（node:test）
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑
npm run test:feas           # 可行性冒烟（离线档零密钥；在线档需真网关，见 contributor §6.2）
npm run shell               # CLI：cwd 即空间（`-- <path>` 指定；key 走 env）
ALIBABA_API_KEY=<key> npm run shell   # 真实网关（密钥只走 env，config providers.<p>.key_env 声明变量名）
npm run web                 # WebUI http://localhost:4321（`-- <path>` / STEM_PROJECT_ROOT）
npm run dashboard -- [path] # 仪表盘 http://localhost:4421（DB 只读直查；--allow-write 解锁清理）
npm run feishu -- [path]    # 飞书长连接远程 shell（FEISHU_APP_ID/SECRET 走 env）
python3 run-docker.py       # 容器一键起（Windows/WSL 双端）
```

## 环境与踩坑（WSL 开发机实录）

- **node PATH 不跨 shell 会话**：每条命令自带 `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`。
- 密钥只走 env：读 Windows 用户变量经 `powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('<NAME>','User')"`，只进子进程环境，零打印零落盘。
- 常驻服务必须 `setsid` 脱组（工具会话超时 SIGKILL 连坐进程组）；`pkill -f` 模式串用 `[r]` 拆分写法（防自噬当前命令行）。
- `/mnt/c` drvfs 偶发 `FileSystem.access` NotFound——重试即恢复，非产品问题。
- loopback HTTP 测试脚本内防御性清 `*_PROXY` env；webui SSE 端点 = `/api/events`。
- SQLite：`all` 是保留字（`AS all` 语法错，`AS at` 可用）；node >= 23.4（node:sqlite 免 flag）。
- 运行依赖 `tsx`（无扩展名相对导入 + `.stem/tools/*.ts` 动态 import）；`jsonc-parser`/`yaml` 是运行时 dependencies。
- 完整清单与「真端点教训」见 `docs/contributor.md §6/§8`。

## 项目结构

```text
src/core/       纯 TS 零平台依赖（硬规则；全表见 contributor §2.1）
  config/       StemConfig + JSONC 解析 + defaults.ts（首启模板 = 唯一预设）+ agentFile.ts（.stem/agent 文件契约）
  context/      重建邮局：Repository/ContextManager/Courier + tag/双索引 + legalize + strategies/(classic/cortex/none)
  events/       PilotEvent(五元) + EventHub
  gateway/      ModelGateway + providers/openaiCompatible + FakeGateway
  main/         createStemSystem 组合根（含 internal 工具 + 记录 sink 接线/toolWiring）+ runInit 矩阵装载 + runtime 执行器 + 端口适配（唯一 import 一切）
  kernel/       Kernel/TemplateRegistry/InstanceManager/SpaceManager + builtin/agents + 持久化端口/装饰器 + RuntimePort/SystemFacade
  lineage/      LineageTree：拓扑 + 能力物化（权限/模型）+ canReach 唯一门面
  logging/      LogEvent + Logger（注入 LogSink，运行时内存）+ forget
  pilot/        根（user#0）扮演接口（依赖 SystemFacade 门面）
  tools/        ToolCapabilityRegistry + access 四态代数 + accessRequest + output（统一输出）+ internal/（系统工具 + bash）
shell/          宿主层：cli/（bootStem + SQLite + mockSse）/ webui/ / dashboard/ / feishu/
extension/      矩阵 extension 层：tools/（fs 五件套 + web 两件 + _lib）/ agent/（creator）/ context/
test/           support/ + feasibility/（可行性冒烟）+ space-demo/（演示空间）
docs/           实况卷 architecture.md（机制以此为准）/ contributor.md（工程纪律）/ scenarios.md
                api.md（交付产物，1.0 前可能滞后）/ prompts.md（需求台账，不提交）
```

> 概念/参数/工具清单/上手 → `README.md`；机制细节 → `docs/architecture.md` 对应节。本文件不复述。

## 门槛与提交纪律

`npm run typecheck` 0 错误 + `npm test` 全绿；改跨模块机制跑 `npm run test:feas` 离线档。改行为的说明写进 commit message（git 历史即沿革），只描述功能变化、**禁进度代号**，**提交前先征得用户同意**。全文见 `docs/contributor.md §6/§7`。

## 文档管理

- 实况文档（AGENTS / architecture / contributor / 各模块 README）承载"当前系统是什么"；**沿革由 git 提交历史承载**（改行为 → commit message 说清），不设日志卷。
- **AGENTS vs README 分工**：AGENTS = agent 实操（硬规则/命令/环境坑/纪律）；README = 项目描述（定位/架构/概念/参数/工具清单/上手）。**勿在本文件复述项目描述**。
- 交付产物（`api.md`）不需要每次迭代更新，发布前统一重定稿即可。
- 文档正文**整段单行**书写，不要手动折行；临时信息（典型如步骤代号、日期等）不进持久化文档。
