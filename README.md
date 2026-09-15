# stem

> **S**elf-**T**raining **E**volutionary **M**atrix —— 自我训练·进化·矩阵。
> 如同原始干细胞，可分化出任意角色与能力。以**原子化 Agent 类 + Agent 实例**为核心，配合**族谱树**与上下文策略，构建用户主权、可自我进化的多智能体系统。

**状态**：架构定稿，v1.0 发布前逐模块收敛。进展以 git 提交历史为准。

---

## 这是什么

stem 是一个**用户主权的 Agent 系统**：没有固定角色，一切 agent 来自你定义的 **AgentClass（模板）**，可自由创建、修改、实例化；实例沿**族谱树**协作，权限与模型沿链收敛；每个 agent 可挂**上下文（记忆）策略**决定消息如何整理与外挂记忆。

- **简单对话** = 简单类 + 空上下文实例
- **复杂任务** = 调度类再创建子实例并传递上下文
- **自我进化**：元能力工具（`agent_class_create` 等）让 AI 自己管理类与实例
- **Core 完全解耦**：纯 TS、零平台依赖，平台能力全部经端口注入；已从 VSCode 剥离
- **单项目空间**：一进程一 project root（`.stem/` = 世界）

## 架构一图流

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Layer 3  shell/（交互层）—— cli · webui · dashboard · feishu           │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 2  core/（纯 TS，零平台依赖）                                    │
│   main 组合根 · kernel 聚合 · pilot 扮演 · lineage 族谱                │
│   context 邮局+策略 · tools 四态+工具 · events · logging · config      │
├───────────────────────────────────────────────────────────────────────┤
│ Layer 1  gateway/（模型网关：OpenAI 兼容 + FakeGateway）               │
└───────────────────────────────────────────────────────────────────────┘
  extension/{tools,agent,context}/   横切 logging/
```

依赖单向：`shell → core → gateway`。

## 核心特征（速览）

| 特征 | 说明 |
|---|---|
| **平等 agent 生态** | 含根在内同一套机制；唯一差异 = 出生路径 id + 族谱位置 |
| **族谱树** | 父 = `parentIdOf(id)` 纯推导；可见域 = 自身∨祖先 |
| **属性收敛** | 工具权限四态 + 模型继承链（显式>类基因>父继承），沿链只紧不松；出生落地 |
| **邮局模型** | 仓库 → 管理员 → 快递员；无总线；统一挂起 Waiter |
| **上下文策略** | classic / cortex / none；可自定义 `.stem/context/` |
| **user#0 扮演** | 根是面板，外部 shell 经 Pilot 以根身份行动 |
| **工具模型** | 注册即出生声明；键即白名单；ask = 消息审批 |
| **stem 空间** | `.stem/stem.jsonc` + 类/策略/工具目录即真相；SQLite 持久 |

机制细节（收敛代数、loop 时序、库表结构等）→ **`docs/architecture.md`**。

## AgentClass 参数速查

四个产生通道同形：`.stem/agent/*.md` / `config.user` / 策略 spec / `agent_class_create|update`。

| 参数 | 必填 | 语义 |
|---|---|---|
| `name` | ✓ | 类名即 id |
| `description` | ✓ | 用途一句话 |
| `systemPrompt` | ✓ | 人设正文 |
| `tools` | – | 四态 Record；未设=完整继承；`{}`=本地封闭 |
| `contextStrategy` | – | 策略名（缺省 classic；实例化固化） |
| `model` | – | 类基因（继承链第 2 层） |
| `sendCountdown` | – | 送信倒计时 ms |
| `temperature` | – | 采样温度 |
| `effort` | – | `none\|low\|medium\|high` |

实例运行期可写面（`agent_update`）：`name` / `model` / `temperature` / `effort`。

## 工具一览

- **系统工具**（internal，约 20 枚）：类/实例生命周期、邮件、上下文、telemetry、`access_reply`
- **对外操作面**：`bash`（宿主注入 ShellRunner；无 ask/黑名单，靠超时与截断限半径）
- **extension**：`read/write/edit/grep/glob` + web 两件（`config.extensions.tools` 点名）
- **custom**：`.stem/tools/` 点名装载

完整清单与根权限推荐实值 → `docs/architecture.md` + `src/core/tools/README.md`。

## 快速上手

```bash
npm install
npm run shell                      # CLI：cwd 即空间
npm run shell -- test/space-demo   # 演示空间
npm run web                        # WebUI 127.0.0.1:4321
npm run dashboard -- [path]        # 仪表盘 4421
npm test && npm run typecheck
```

真实网关：config `providers` 注册端点，密钥走 env（`key_env` 声明变量名）。

### Docker

```bash
docker build -t stem:1.0 .
docker run -d -p 4321:4321 -v stem-data:/data --name stem stem:1.0
```

`/data` 承载 `.stem/`。**容器即 bash 边界**。

shell 交互：直接输入对话；`/new` `/agents` `/templates` `/tools` `/stop` `/help` `/exit`。

## 文档指南

| 想了解 | 去哪 |
|---|---|
| 系统怎么想（概念与关键模型） | `docs/architecture.md` |
| 怎么开发（分层/命名/测试/提交） | `docs/contributor.md` |
| 某模块怎么实现 | 该模块 `README.md`（见 architecture 模块导航） |
| agent 实操命令与坑 | `AGENTS.md` |
| 接口全量清单 | `docs/api.md`（交付产物，tag 前统一重定稿） |

## 关键前提

1. **Node ≥ 23.4**（`node:sqlite` 免 flag）；运行依赖 tsx / jsonc-parser / yaml
2. **无平台绑定**：core 零平台依赖
3. **模型**：OpenAI 兼容端点一段 config 接入
4. **自研**：类 / 实例 / 族谱 / 权限 / 上下文策略
5. **发布**：Docker + `/data` volume + `/api/health`
