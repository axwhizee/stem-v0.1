# AGENTS.md

> 本文件 = 面向 agent 的**实操手册**：命令、结构、工作流、环境坑、提交纪律、文档索引。
> 项目是什么 → `README.md`；机制与关键模型 → `docs/architecture.md`；开发纪律 → `docs/contributor.md`；模块实现 → 各模块 README。**勿在本文件复述项目描述与机制细节。**

## 文档系统

优先参考下面的文档获取项目的基本信息，其中可能存在与实际代码的延迟，建议以代码为准

| 文档 | 面向 | 职责 | 更新时机 |
|---|---|---|---|
| `README.md` | 新用户 | 定位、主要特征、架构概览、上手、文档指南 | 特征/上手变化时 |
| `docs/architecture.md` | 所有人 | 核心概念提纲 + 关键模型（agent 组成 / 族谱树 / 邮局 / 空间 / loop）+ 模块导航 | 跨模块机制变化时 |
| `AGENTS.md`（本文件） | agent | 命令、结构、工作流、环境坑、提交纪律 | 实操面变化时 |
| `docs/contributor.md` | 开发者 | 分层契约、命名、错误模型、测试、提交规范 | 纪律/流程变化时 |
| 各模块 `README.md` | 开发者 | 该模块**当前**实现逻辑（architecture 的延伸） | 模块行为变化时 |
| `docs/api.md` | 开发者 | 接口清单（交付产物） | **仅正式 tag 发布前统一重定稿** |
| `docs/prompts.md` | 本地 | 需求与优化台账（不提交） | 随时 |

**实况卷只写现在是什么**；沿革由 git 提交历史承载。plan 卷 = 根路径 `plan.md`（gitignore），实现完成即删。

## 快速命令

```bash
npm install                 # 依赖（node >= 23.4，node:sqlite 免 flag）
npm run typecheck           # tsc --noEmit（唯一 lint/typecheck）
npm test                    # 全量单测（node:test）
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑
npm run test:feas           # 可行性冒烟（离线档零密钥；在线档需真网关）
npm run shell               # CLI：cwd 即空间（`-- <path>` 指定；key 走 env）
ALIBABA_API_KEY=<key> npm run shell   # 真实网关（密钥只走 env）
npm run web                 # WebUI http://localhost:4321
npm run dashboard -- [path] # 仪表盘 http://localhost:4421（DB 只读；--allow-write 解锁清理）
npm run feishu -- [path]    # 飞书长连接远程 shell
python3 run-docker.py       # 容器一键起
```

部署：Docker 镜像 + `/data` volume（承载 `.stem/`）；`STEM_HOST=0.0.0.0` 放开容器绑定；HEALTHCHECK `/api/health`。**容器即 bash 边界**，挂载目录即爆炸半径。

## 项目结构

```text
src/core/       纯 TS 零平台依赖
  config/       StemConfig + JSONC + defaults（首启模板）+ agentFile（.stem/agent 契约）
  context/      邮局 + Waiter + strategies/(classic/cortex/none)
  events/       PilotEvent + EventHub
  gateway/      ModelGateway + openaiCompatible + FakeGateway
  main/         组合根 + runInit + runtime + toolWiring
  kernel/       Kernel / TemplateRegistry / InstanceManager + 端口
  lineage/      LineageTree（拓扑+能力+canReach）
  logging/      LogEvent + Logger + forget
  pilot/        根 user#0 扮演接口
  tools/        注册表 + 三态代数 + output + internal/
shell/          cli / webui / dashboard / feishu
extension/      tools / agent / context（config 点名）
test/           support / feasibility / space-demo
docs/           architecture / contributor / scenarios / api（交付）
```

> `reference/` = 外部参考源码，非本项目产物，其编译错误一律忽略。

## 工作流（agent 实操）

1. **改前**：读相关模块 README + `docs/architecture.md` 对应节；跨模块先看导航表。
2. **实现**：加法做完整；减法用通用机制替换补丁。core 零平台依赖；层间只 import `index.ts`。
3. **验证**：`npm run typecheck` + `npm test`；跨模块改跑 `npm run test:feas` 离线档。
4. **文档**：行为变则整节重写对拍卷（见 contributor §1.3），禁止补丁式缝一句。
5. **提交**：先汇报增量，用户同意后 `git -c user.name="OwlCat" -c user.email="owlcat@local" commit`；message 只写功能变化，**禁进度代号**。

## 门槛与硬规则（摘要）

- 全体 agent 绝对平等；权限/模型 = 族谱位置的函数；键即白名单只紧不松。
- 对外操作面 = bash 单点（静态三态权限，无进程内审批）；密钥只走 env。
- 对过时文件/死代码零容忍；文档忠于现状。
- 机制细节见 `docs/architecture.md` 与 `docs/contributor.md`，本文件不展开。

## 环境与踩坑（WSL 开发机实录）

- **node PATH 不跨 shell 会话**：每条命令自带 `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`。
- 密钥只走 env：Windows 用户变量经 `powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('<NAME>','User')"`，只进子进程，零打印零落盘。
- 常驻服务必须 `setsid` 脱组；`pkill -f` 模式串用 `[r]` 拆分（防自噬）。
- `/mnt/c` drvfs 偶发 `FileSystem.access` NotFound——重试即恢复。
- loopback HTTP 测试脚本内防御性清 `*_PROXY`；webui SSE = `/api/events`。
- SQLite：`all` 是保留字；node ≥ 23.4。
- 运行依赖 `tsx`；`jsonc-parser`/`yaml` 是运行时 dependencies。
- 完整清单见 `docs/contributor.md §6/§8`。
