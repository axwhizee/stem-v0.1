# shell/feishu —— 飞书长连接远程 shell

> 一句话：**把飞书变成 stem 的移动宿主**——手机上一条消息，你主机上的 agent 生态就开始干活；agent 要越权时，裁决卡弹在你聊天窗口里。
>
> 免公网 IP、免域名、免内网穿透：只要你的主机**能出网**，飞书就能驱动它。

```
你（飞书客户端）
   │ 发消息 / 点卡片按钮
   ▼
飞书开放平台（云）
   │ ① 事件推送：走「长连接」——你的进程拨出的那条 WebSocket
   ▼                        ② 你的 shell 调 REST API 回复/发卡（普通 HTTPS 出网）
shell/feishu（你的主机，本目录）
   │ pilot.sendMessage / replyAccess      ▲ PilotEvent 订阅（letter/status/tool）
   ▼                                      │
stem core（根 user#0 生态：接待员、organizer、cortex-pet……全部照族谱树运行）
```

---

## 一、飞书开放平台：你需要知道的功能面

这个 shell 建立在飞书开放平台四个机制上。先讲平台，再讲我们用了什么。

### 1.1 应用与机器人（身份层）

- **企业自建应用**：在 [open.feishu.cn/app](https://open.feishu.cn/app) 创建，个人免费租户即可。每个应用有 `App ID`（`cli_` 开头）与 `App Secret`——本 shell 只从**环境变量**读这两个值（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`），配置文件永不承载明文密钥（与 stem `providers.key_env` 同律）。
- **机器人能力**：应用详情 →「添加应用能力」→ 机器人。开启后应用才有一个可对话的 bot 身份，用户搜应用名即可私聊。
- **发布版本**：**所有权限/事件/能力改动都要「版本管理与发布」重新发布才生效**（个人租户秒过）。"配了没反应"九成是忘了发布。

### 1.2 事件订阅与长连接（入站通道）

飞书把你和 bot 的对话作为**事件**推给你的后端，两种订阅方式：

| | 长连接（本 shell 采用） | 回调 Webhook |
|---|---|---|
| 原理 | 你的进程**拨出** WebSocket，事件沿这条连接进来 | 飞书 POST 到你的公网 HTTPS 地址 |
| 前置 | 仅需出网 | 公网 IP/域名 + 验签 + 解密 |
| SDK | `@larksuiteoapi/node-sdk` 的 `WSClient`（自动重连） | 自建 HTTP 服务 |

关键事件就两个，都要在「事件与回调」页添加：

- **`im.message.receive_v1`（接收消息）**：单聊消息恒推；群消息默认**只推 @机器人 的**（要收全部群消息是"敏感权限"，自建应用设"仅企业内可用"可免审核开通）。
- **`card.action.trigger`（卡片回调）**：用户点击交互卡片按钮/提交表单时触发，**回调方式同样选长连接**（否则审批按钮点了没反应）。

两个已实测的载荷坑（官方 SDK 类型与实际推送不一致）：消息类型字段线上真实为 `msg_type` 而类型声明是 `message_type`（本 shell 双形兼容读取）；文本消息的 `content` 是 JSON 字符串 `'{"text":"…"}'` 需 parse。

### 1.3 消息与卡片（出站表达力）

出站走 REST（`tenant_access_token` 由 SDK 自动管理），形态从弱到强：

1. **纯文本**（`msg_type: text`）——日常回复。
2. **富文本 post / 图片 / 文件**——收图收文件要先经 `im.v1.message.resources` 下载 `file_key`；**音频消息可收但飞书不提供转写**（要 ASR 自备）。
3. **交互卡片 interactive**（`schema: 2.0` JSON）——标题头带色（green/red/orange…）、markdown 块、按钮/下拉/表单，按钮 `value` 携带任意业务负载并**经 `card.action.trigger` 回调进你的长连接**。这就是"审批卡"的原理：一张卡片 = 一次远程裁决界面。
4. **卡片更新**：发出后 **14 天内可全量/局部/流式更新**（同一张卡持续刷新状态而不刷屏；流式文本打字机效果走 cardkit 组件级 API，10 次/秒上限）。本 shell v1 只用了一次"裁决后原地更新留档"，打字机卡片是预留项。
5. **仅特定人可见卡片**：群里发只给某成员看/可交互的卡（多人群里做私密切审批卡的预留素材）。

**频控红线**（设计任何推送前记牢）：向**同一用户**发消息 5 QPS、向**同一群**机器人共享 5 QPS——所以本 shell 的 watch 事件流做了节流聚合（窗内多条并一条），长文本做了分箱。

### 1.4 更远的能力（本 shell 未接，平台已开）

飞书背后是 2500+ API 的办公套件：云文档读写、多维表格、日历、审批流……同一 `tenant_access_token` 都能调——"聊天 shell"只是最小切片，远期 agent 直接写你文档/建日程时，扩展的是 stem 侧工具，不是这个 shell 的骨架。

---

## 二、本 shell 的功能

### 2.1 扮演模型（最重要的一节）

stem 的第一性事实：**根（user#0）是面板**——它不组装、不跑 LLM 轮（AGENTS.md 设计原则 1）。所以"在飞书跟船长说话"的真实机制是：

```
你的消息 ──pilot（以根身份）──▶ 本会话当前目标 agent（/new /use 选定；秘书/绑定表兜底）
                                        │ 真 LLM 轮 + 工具（bash/读写/…按族谱权限）
              目标的回信落进根信箱 ◀──┘
你的聊天窗口 ◀──读 aloud：root letter 事件反查 StoredMessage.from 后转发──
```

- **显式会话（CLI 式，本 shell 的缺省模型）**：每个 chat 有"当前目标"，`/new <类> [任务]` 创建并绑定、`/use <name|id>` 切换（吃三形态寻址）、`/exit` 解绑、`/agents` 看选人面板。目标表**回写 `.stem/feishu.jsonc`**（`sessions` 键，jsonc 定点编辑保你的注释）——重启后每个会话继续对着原 agent 说话，记忆连续。
- **接待员（secretary）降级为可选项**：`secretaryClass` 配了才有兜底（找 `classRef == secretaryClass` 且父为根的活跃实例，没有就创建）；置 `""` = 关闭秘书中转，未绑定会话只收到指令指引——"跟谁说话"永远是显式的。
- **读 aloud 忠于信件原文**：回信带 `<sender id="…">` 发件人戳（邮局打戳是信件真相的一部分，仓库/审计面与出口同源）。单主人自用场景这是特性不是噪音；若将来 shell 面向多用户产品化，出口美化（剥戳/换名片格式）归表现层决策，勿动审计链。
- **权限的本体在族谱树，不在聊天渠道**：open_id 白名单只是**渠道闸门**（谁能跟这个 shell 说话）；说的每句话能触发什么工具，永远由 agent 在族谱中的位置 + 类/实例配置收敛出的生效权限决定（AGENTS.md 原则 3）。白名单外的人：零服务、零泄漏。

### 2.2 功能清单

| 你做什么 | shell 做什么 | 走哪条链路 |
|---|---|---|
| 单聊发普通消息 | 以根身份投给**本会话当前目标**，回信读 aloud | `pilot.sendMessage` → 回信 letter |
| 发 `/new <类> [任务]` | 创建实例并设为本会话目标（回写配置） | `pilot.instantiate` |
| 发 `/use <name\|id>` | 切换本会话目标（name / name#id / 唯一前缀 / 精确 id 都认；歧义回候选） | `kernel.resolveAgent` |
| 发 `/agents` / `/exit` | 选人面板 / 解绑本会话目标 | `pilot.listAgents` / 会话表 |
| shell 重启 / 断线重连 | 向主人会话发"上线"；按 `lastSeenAt` 增量拉取各会话历史**补偿重放**（真人∧白名单∧未见，时间升序） | `im.v1.message.list` → `planReplay` |
| shell 收到 SIGTERM/SIGINT | 优雅发"离线"再退场 | — |
| 发 `/tree` | 族谱树卡（缩进 + 状态徽标 🟢idle 🔵thinking 🟡holding ⚪interrupted） | `pilot.listAgents` |
| 发 `/status [agent]` | 实例详情 + **生效接线反射**（策略/组装/custom/倒计时，`boxFacts`） | `pilot.inspect` + `contextManager.boxFacts` |
| 发 `/logs [agent] [n]` | 该 agent 最近 n 条运行账（状态/审批/工具/做梦…） | `kernel.logger.query` |
| 发 `/watch <agent\|all>` / `/unwatch` | 订阅该 agent 的 letter/status/notice 实时推送（节流聚合） | `pilot.subscribe` + 路由表 |
| 发 `/stop <agent>` | 中断在途轮 | `pilot.interrupt` |
| agent 触发 `ask` 权限 | **审批卡**（申请详情 + 允许一次/本会话总是/拒绝）；裁决后卡片原地更新留档 | 根信箱 `<access_request>` → `pilot.replyAccess` |
| 群聊 @bot | 按 `chatBindings` 把该群绑成**某个子 agent 的移动窗口**（如项目群直连 tester） | 同单聊，目标换绑 |
| 群/单聊 @ 消息 | `@_user_1` 占位自动剔除后再投递 | router `stripMentions` |

### 2.3 首次上手（认领流程）

1. 配置见 §三；起服：
   ```bash
   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx \
   OPENCODE_API_KEY=xxx npm run feishu -- <空间路径>     # 缺省 cwd
   ```
2. **飞书给 bot 发任意消息** → 白名单为空时它会回你 `open_id`（认领指引）。
3. 把 `open_id` 填进 `.stem/feishu.jsonc` 的 `ownerOpenIds`，重启 → 正式开通。
4. 冒烟三连：`/new assistant 你是试飞员`（现场建目标并绑定）→ `/tree`（族谱卡）→ 让它"把一句话写进 notes.txt"（`write` 是 ask 门，弹审批卡，三键各试一次）。重启 shell 再看：上线通知 + 会话目标还在（`sessions` 回写生效）。

### 2.4 配置参考（`.stem/feishu.jsonc`）

shell 层自治理文件（**不进 core StemConfig**——平台配置不入 core 铁律；样例见 `feishu.example.jsonc`）：

| 键 | 缺省 | 含义 |
|---|---|---|
| `ownerOpenIds` | `[]` | 主人白名单；空 = 回认领指引不服务 |
| `secretaryClass` | `""` | 秘书兜底（**可选项**）：单聊未绑定会话的接待员类；`""` = 关闭中转，一切对话须显式 `/new` `/use` |
| `chatBindings` | `{}` | `chat_id → agent 实例 id` 静态绑定（群 = 该 agent 窗口）；优先级低于 `/use` 显式会话 |
| `sessions` | `{}` | **shell 自管**：chat_id → 当前目标（/new /use /exit 回写，jsonc 定点编辑保注释） |
| `ownerChatId` | `""` | **shell 自管**：主人单聊最近值（上线/离线通知与补偿投递面） |
| `lastSeenAt` | `{}` | **shell 自管**：各会话最近处理时刻（断线补偿增量起点） |
| `approvalChatIds` | `[]` | 审批卡额外投递的群（管理群收卡、单聊裁决） |
| `watchThrottleMs` | `2000` | watch 推送节流窗（并条防撞 5 QPS） |

### 2.5 部署与运维

```bash
# 开发态后台
setsid nohup npx tsx shell/feishu/main.ts <空间> > /tmp/feishu-shell.log 2>&1 &

# 生产：systemd（密钥走 EnvironmentFile，chmod 600）
[Service]
EnvironmentFile=/home/<user>/stem/.env
ExecStart=/usr/bin/node --import tsx shell/feishu/main.ts /home/<user>/myspace
Restart=always
```

WSClient 内置断线重连，systemd 兜进程级自愈。**一空间一进程**：feishu shell 与 webui/cli 不可同时开同一空间（SQLite 单写者约定）。

排障速查：收不到消息 → 发布版本了吗 → 长连接订阅方式选了吗 → `im.message.receive_v1` 加了吗 → 日志里 `ws client ready` 有吗 → 账号在应用可用范围内吗。**审批卡按钮无反应 → 「卡片回调」事件没加或没选长连接方式。**

---

## 三、实现原理（三文件分工与不变量）

```
router.ts   纯逻辑决策面（零 SDK、零 IO，全单测）
            入站 InboundMsg → OutAction[]（deliver/reply/approvalCard/command）
            内含：白名单闸门 / 认领指引 / 会话目标优先级（显式>绑定>秘书）/ 命令解析 /
                  会话表与 setSessionTarget（钩子回写）/ planReplay 补偿重放计划 /
                  <access_request> XML 解析 / 卡片 value 判别 /
                  message_id LRU 去重（平台事件有重试，必须幂等）/
                  watch 订阅集 / 长文分箱 / formatTree 渲染
feishu.ts   SDK 协议翻译（@larksuiteoapi 具名导入；msg_type 双形兼容；
            REST sendText/sendCard/updateCard + listMessages 增量拉取）——
            全仓库唯一认识飞书 SDK 的文件
main.ts     接线：env 校验 → bootStem（复用 cli 的 platform，含网关/SQLite/bash 注入）
            → 秘书（可选）/会话表装载 → onMessage→router→execute；pilot.subscribe→读 aloud/watch；
            卡片回调 → pilot.replyAccess → 卡留档；start 后上线通知+compensate；SIGTERM 优雅离线
config.ts   .stem/feishu.jsonc 装载 + **定点回写**（裸 JSONC 白名单 fail-fast；
            jsonc-parser modify/applyEdits 只动目标键保用户注释——edits 必须整批应用）
cards.ts    卡片 JSON 构造（审批卡三键 / 裁决留档态 / 信息卡）
```

对 core 的态度：**零改动、零特权**。本 shell 用到的全部是 pilot/kernel 既有门面（`sendMessage/instantiate/inspect/listAgents/replyAccess/interrupt/subscribe` + `boxFacts` + `logger.query`），与 CLI/WebUI 完全同权——它只是第四个"扮演根的外部大脑接口"（AGENTS.md 原则 4：shell 只做平台适配 + UI）。

**已知边界与预留**（都有明确的平台机制支撑，未做纯属范围裁剪）：流式打字机回复（cardkit streaming，10/s 下节流即可）；图片入站 → 多模态；语音入站 → 自备 ASR；免 @ 群环境感知（敏感权限，可开）；单聊自定义菜单按钮（`application:bot.menu:write`）；多用户化（出口美化、每用户会话隔离——当前架构默认单主人）。断线消息补偿已落地（启动拉取重放；补偿窗口受平台历史可查范围约束）。
