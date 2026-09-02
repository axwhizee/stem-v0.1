# v1.0 验收测试方案（test-plan）

> **状态**：方案待用户定稿 → 正式执行 → 全绿后打 `v1.0` tag。
> 本文件是执行现场的唯一真相源（含环境、钥匙获取法、用例步骤、历史踩坑），
> 任何会话压缩后凭本文件可无损续做。执行中在 §6 打勾记结果。

## 0. 前置与现状

- 提交链（HEAD 起）：`92f03e1` docs(dashboard) → `b478efc` feat(dashboard) → `7b9b248` feat(context) token 真实计量 → `e49e84c` feat(tools) web 两件 → `8f7ab4e` feat 三维矩阵 → S6 批 1/2 → S5。
- 基线：**typecheck 0；npm test 300/300**。执行期间任何改动必须保持两者全绿才可记"通过"。
- 本轮**不做**：S5.3 调度 / S5.4 dreaming（`evolution-plan.md`）——v1.0 后才议。
- 方案沿革：矩阵/两标记/web 后端/测试网关诸裁决的当时记录见 `docs/log.md`（plan 卷已按纪律落地删除）。

## 1. 环境与资源

- **形态**：本机非 docker（docker 为 §2 可选第 16 项）。常驻服务用 **setsid 脱组**起（工具会话超时 SIGKILL 会连坐进程组，nohup 挡不住）：
  ```bash
  NODE="$HOME/.nvm/versions/node/v24.16.0/bin/node"   # 每命令须带 PATH（nvm 不跨调用）
  setsid "$NODE" --import tsx shell/webui/server.ts tmp     > /tmp/webui.log 2>&1 < /dev/null &
  setsid "$NODE" --import tsx shell/dashboard/server.ts tmp > /tmp/dash.log  2>&1 < /dev/null &
  ```
  webui = http://localhost:4321（用户操作面：/api/send|instantiate|interrupt|access|set_model|terminate|events(SSE)|agents|templates|context|models）；dashboard = 4421（观测旁路，全程开着当证人）。
- **密钥**（值零打印零落盘，只进子进程 env；WSL 看不到 Windows 用户变量，经 powershell 读）：
  ```bash
  export OPENCODE_API_KEY="$(timeout 15 powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('OPENCODE_API_KEY','User')" | tr -d '\r\n')"
  export ALIBABA_API_KEY="$(timeout 15 powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('ALIBABA_API_KEY','User')" | tr -d '\r\n')"   # websearch 后端必需
  ```
- **网关定稿**（用户裁决）：`opencode-go / qwen3.8-flash`（非免费但小额；执行前 `curl -s https://opencode.ai/zen/go/v1/models -H "Authorization: Bearer $OPENCODE_API_KEY"` 探 **`(free)` 后缀变体**，命中即改用之）。
- **测试前置改动**（开跑第一步）：`tmp/.stem/stem.jsonc` ① providers 增 `"opencode-go": { "base_url": "https://opencode.ai/zen/go/v1", "key_env": "OPENCODE_API_KEY" }`；② `user.model` 从 alibaba/qwen3.8-flash 切到 **opencode-go 选定模型**；ALIBABA provider 保留（websearch 用）。extensions 已点名五件套+web 两件+creator；user0 整表含 skill/web 两键。
- **纪律**：用例限量、单轮短回复为主、绝不让 agent 挂机；测试产生的实验 agent/类文件在报告后询问用户是否清理（tmp DB 是用户资产，默认不清）。

## 2. 用例矩阵（P0 = v1.0 门槛，P1 = 应过）

扮演方式：我以 curl 打 webui API = 用户浏览器操作面；文件面动作 = 用户编辑 `.stem/`。dashboard 与 SSE 日志作证据。

| # | P | 用例 | 步骤梗概 | 通过判据 |
|---|---|------|---------|---------|
| 1 | P0 | custom 类装载与对话 | 写 `tmp/.stem/agent/haiku.md`（description+tools:{}+正文；基因 model 不设）→ instantiate → send | 家学 origin=home；回复符合人格 |
| 2 | P0 | 工具面建类（进化书写 + ask-once） | send user0「创建类…」（agent_class_create=ask）→ /api/events 见 access_request → /api/access once → 类文件落盘 `.stem/agent/` → instantiate 新类 | 审批闭环；重启后类仍在（文件真相） |
| 3 | P0 | 类更新收敛检查 | agent_class_update 给新类**加**工具键 → 期望被拒（逐键只许收敛）；改 systemPrompt → ask 后生效 | 拒加键的报错文案可行动 |
| 4 | P0 | fs 五件套任务 | write（ask 审批）落文件 → read 回读 → edit 改一处 → grep/glob 命中 | 内容逐字正确；tool 行入箱 |
| 5 | P0 | bash 任务 | 子 agent `echo` + `ls` 输出汇总 | 无 ask 直接执行；输出截断护栏在位 |
| 6 | P0 | ask 三分支 | 一次会话连发三次需 ask 工具：once→再触发仍问；always→免问（豁免备忘）；reject→反馈文本进模型上下文 | 三态行为与 accessRequest 语义一致 |
| 7 | P0 | creator 调度链（extension 类） | instantiate creator → 「查一下 X 时间/生成一句诗交给子 agent」→ 观察 agent_instantiate+context_wait 填充回信 | 父子挂树；回信以 tool 结果非信件；dashboard 树出现孙辈 |
| 8 | P0 | interrupt 生命周期 | 让模型写 500 字长文，流式中途 /api/interrupt → 状态 interrupted、部分文本闭合 → send 续谈可恢复 | 消息闭合无悬空 tool_calls（legalize 生效）|
| 9 | P0 | 模型四环 | instantiate 带 model 参（explicit 出生）；agent_set_model 改自己；agent_inspect 看 origin 四态；验证不级联子女 | NodeConfig 输出与族谱四级律一致 |
| 10 | P0 | skill 兼容实测 | send「用 skill() 看看有什么技能」→ 清单 → 加载 hello-guide → 复述要点编号 | 目录形态 custom 装载器 + SKILL.md 双形态 |
| 11 | P0 | web 工具实调 | 「搜 X 并总结」「抓某 URL」→ 模型自主 websearch/webfetch | 结果含真实链接；无 ask（操作面权级）|
| 12 | P0 | token 账目核对 | 全部跑完：dashboard /api/tokens 按 agent/角色核——assistant 行=非 chars/4 整除的真实值；跨轮 tool/user 行=差分归位；total 与多轮和一致；user0 panel 行保持估算 | 账目自洽、与真实网关口径一致（非估算特征）|
| 13 | P1 | 状态机 SSE 全程记录 | 后台 `curl -N /api/events > log`，全程 idle→thinking→holding→(interrupted) 轨迹 | 无非法迁移、无卡死态 |
| 14 | P0 | 重启恢复 | kill webui → 原命令重启 → agents/status/model(explicit)/turnCount 续接；对被中断 agent 续谈；`haiku.md` 类文件仍在 | interrupted 归一、零重放、文件+DB 双真相 |
| 15 | P1 | dashboard dogfood | 用例期间 4421 全程观察：树实时长新节点、账目增长、清理页只读姿态 | 与 webui 并开零互扰（已初步验证，回归即可）|
| 16 | P1 | docker 形态（可选，用户点头才做） | `python3 run-docker.py --build` → 卷内旧 alibaba config 按 R12 指路迁移或直接 --reset-config → 容器内一轮 websearch+对话 | 发布形态同行为 |

## 3. Bug 处置纪律

发现即修：修复合入**它所属主题的最早批次提交口径**（测试轮不产生功能 commit——测试报告独立；fix 随下一批 docs/代码提交或独立 `fix:` commit，禁提任务代号）。修复后该用例从步骤重跑。

## 4. 历史踩坑清单（防重蹈，全部来自实测）

- `pkill -f <模式>` 模式串若出现在当前命令行会**自噬 shell**（用 `[r]` 拆字符或精确 pid）；杀 setsid 进程要 `pgrep -f` 找 pid 直杀。
- webui/dashboard 空间定位是**裸位置参数**（`server.ts tmp`），无 `--` 前缀（曾生成 `--/` 垃圾目录）。
- `/api/agents/:id/context` 条目**无 `at` 字段**；判"新回复"以消息行数增长为准。
- 轮询等待：先等**进入** thinking 再等**离开**（否则上轮 holding 瞬间即退，竞态假阴性——T3 冒烟实锤）。
- SQLite 保留字：`AS all` 语法错；`AS at` 可用。窗口函数 rn=1 = 尾行，非"尾 user 行"。
- nvm PATH 不跨工具调用，每条命令自带 export。
- `config.user.tools` 整表替换：新工具键要手动补进 tmp 表（已含 web 两件 + skill）。
- 提交身份 `git -c user.name="OwlCat" -c user.email="owlcat@local"`；`TODO.md/prompts.md` 不入库；reference/ 噪音忽略。

## 5. 报告与出口

- 报告格式：本表 16 项逐项 `✔/✖/⚠(附注)` + 关键证据摘录 + bug 清单与修复 commit → **直接对话输出**（不落文档，用户裁决）。
- v1.0 出口条件：P0 全 ✔（P1 允许带已知限制放行）+ 回归 typecheck/300+ 全绿 + 用户确认 → `git tag -a v1.0 -m "..."`（用户下令才打）。

## 6. 执行记录

### 6.1 初步测试（2026-09-02，机制可行性档——已完成）

用户裁决：全量验收前先做**功能可行性**（模块机制能跑通即达标）。产物 = `test/feasibility/` 四脚本（offline1 29✔ / offline2 9✔ / online 11✔ / http 10✔ = 59 断言全绿；`npm run test:feas` 离线可重复，在线两档需 ALIBABA key）。重大产出：**挖出并修复网关 P0**（dashscope tool_calls 空 id 尾片覆盖 → 真网关工具链静默失效，详见 docs/log.md 对应阶段）；核定 user0 面板事实——**本表用例 4/5/7 的目标须改为子实例跑轮**（user0 不跑 LLM 轮是设计事实）。

### 6.2 全量验收（进行中，2026-09-02：网关 opencode/qwen3.8-flash，空间 `test/space-v10/`，操作件 `test/feasibility/tools/`）

**执行期判据校准（开跑即立，覆盖用例表原文的口径错误）**：
- 轮终态 = **holding**（非 idle——thinking→holding 是设计稳态，unit 有锚；idle 仅初始）；waitidle.sh 已按此修。
- user0 面板 turnCount 恒 0 为正确语义（不跑轮）。
- webui `/api/instantiate` 不受理 agentId 参数（id 自动短码生成）——用例以返回的 id 为准。
- 运行中新增 `.stem/agent/*.md` **需重启装载**（目录即真相=启动期扫描，无 watcher——此即用例 #1 语义之一）。

| # | 结果 | 证据/备注 |
|---|------|-----------|
| 1 | ✔ 通过 | haiku.md 热重启装载→instantiate(jn2c)→真模型三行俳句逐字吻合人格（tools={} 零调用）、assistant 行 tokens=117 真实值、回信以 `<sender id="jn2c">` 落 user0 信箱 |
| 9(1/2环) | ✔ 通过 | birth model=max → origin=explicit 落行跨重启；/api/set_model 热切 flash。**发现并修复**：webui /api/instantiate 不透传 model（三环·环一用户面不可达）→ feat(webui) 补齐（API+侧栏下拉） |
| 4 | ✔ 通过（换主体后） | worker 类（fs5+bash 显式 allow）五步作业全中：write/read/grep/glob/bash + **并行三工具轮**。**发现并修复两处**：(a) P5 工具相对路径基准不统一——grep/glob 的 include/pattern 对绝对路径做锚定 test 恒不中、bash cwd="." 随宿主进程漂（= 首测 assistant 乱走真因之一：占位类继承根表**无 fs 键**，属设计事实非 bug，用例主体改 worker）；(b) webui contextOf 手抄字段丢 toolCalls 工具轨迹（审计面缺）→ 透传修复。三处回归锚（tools.test include/glob、bash.test 相对与缺省 cwd、305/305）|
| 5 | ✔ 通过 | wc -c 输出回库、默认 cwd=空间根（pwd 实证）；14 项非零退出码 = 正常结果语义单测锚 |

| # | 结果 | 证据/备注 |
|---|------|-----------|
| 1-16 | — | 待执行（用例 4/5/7 预期需按 6.1 校准） |
