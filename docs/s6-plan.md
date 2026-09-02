# stem S6 执行方案 · 定稿（第四轮收口）

> **性质**：四轮讨论 + 全部问题裁决后的**最终执行依据**；实施偏差记 log.md，不回改本文。
> **日期**：2026-09-01 · 前置：S5.1/S5.2（evolution-plan.md）落地、Docker 实跑通过、密钥治理 key_env 制。
> **实施状态（2026-09-02）**：批 1 ✅（a237a50）· 批 2 ✅（本批，实施细节与偏差见 log.md）——进度以 `docs/log.md` 为准，本文仅存裁决与方案。

## 0. 裁决记录（R1-R14，定案防复议）

| # | 裁决 |
|---|---|
| R1 | 网关**零兜底**：代码无预设表/回落；`key_env` 未命中 env = boot warn 点名（不印值）+ provider 不接通，模型**实际用到才硬错**（可行动文案指到 config 行/env 名） |
| R2 | **唯一预设 = opencode zen 免费清单**，且只以 `DEFAULT_CONFIG_TEXT` 模板数据存在（代码零 URL 常量）；alibaba/dashscope 为用户自定义示例 |
| R3 | **持久化单层：`.stem` = 世界**。一进程 = 一 space = 一 projectRoot = 一 `.stem` = 一 `stem.db`。类清单、config、tools/context、实例树（拓扑+身份+**配置相**）、上下文历史全部空间级。跨 space 共享类 = 复制目录（git 管理），**不建全局机制**（less is more） |
| R4 | user0 的**类** = config 硬编码（不落 `.stem/agent/`）；**实例**行与普通实例同律（空间级，root id 恒 `user0` 零迁移） |
| R5 | 单实例 = **约定非机制**：无抢占锁（opencode 逻辑，双开同目录行为未定义、不建议；boot 日志打印 db 路径作提示）。SpaceManager 多空间 API 与 spaces 表退化为单行工件 → 整理种子 #9 评估拆除 |
| R6 | 全参数统一解析律：**显式 > 类基因 > 父继承 > 家学**（链尾 = user0 的 `config.user.model`）；tools 同构（代数=收敛格），算法不动、次序归口一条律 |
| R7 | `agent_set_model` = internal、权限走缺省（ignore，白名单显式赋权）、可见域 canReach（自身∨后代） |
| R8 | 图标禁 emoji/几何字符 → 汉字单字；三态视觉：**不可用=遮罩 / 可用=白边框 / 激活=荧光** |
| R9 | 第一视角：user0 不作对话窗口；信箱按 `<sender>` 反查归位各 agent 窗 |
| R10 | 目标-达成度进化 = 方案存档不实施（evolution-plan.md §9）；本阶段重心 = 网关/配置/族谱/WebUI |
| R11 | **opencode-style 空间定位**：`stem` = cwd；`stem <path>` = 指定目录；webui 默认 cwd、`STEM_PROJECT_ROOT` 覆盖（**改掉现 `cwd/tmp` 默认**）。仓库演示空间 `tmp/` 改为显式指参；`.gitignore` 加 `.stem/`（`tmp/.stem` 跟踪例外）。**无切换器、无注册表** |
| R12 | **顶层 model 链整体拆除**：`StemConfig.model`、`FALLBACK_MODEL`、`Kernel/Runtime.defaultModel` 全删（~8 文件 12 处，测试 harness 随行）；`config.user.model` **必填**（boot 硬校验——config 即全部配置，它是全局缺省的本体）。**config 全量有效原则**：未知顶层键 = boot fail-fast（废除 S4.2"静默丢弃"兼容；`custom` 为唯一合法扩展位） |
| R13 | provider 条目 = `{ base_url, key_env?, models? }`（块内 snake_case）；`base_url` 必填（alibaba = 实测 `https://dashscope.aliyuncs.com/compatible-mode/v1`）、`key_env` 可缺省（匿名/本地端点，mockSse 测试路自洽）、`models` 空 = 全启用 |
| R14 | 树配置相**落盘**（修正 R3 早先"不持久"稿）：`AgentInstance.model?` 随显式实例化/setModel 写实例行（instances 表行 JSON 序列化，**零 schema 迁移**）；恢复 replay 时它是显式层——"回到空间 = 树+语料+配置全量续谈" |

## 1. 批 1 · 网关、配置、模型族谱、空间归位（一个功能 commit）

### 1a 网关与配置
- config：`providers` 类型+校验（R13；model 引用的 provider ∈ 注册表、id ∈ 非空白名单）；删 `config.model`/`FALLBACK_MODEL`；`user.model` 必填校验；**未知顶层键 fail-fast**（R12）。
- `git mv opencodeLlm.ts → openaiCompatible.ts`：`{ baseUrl, apiKey?, models?, requestTimeoutMs?, fetch? }`，固定 `baseUrl + '/chat/completions'`、`model` 恒发裸 id；**删 `process.env` 读取**（core 红线清零，种子 #8）；SSE/tool_calls/reasoning/overflow 表原样保留。
- 宿主 `buildGateway(config, env)`：逐 provider 建实例 + `req.model.provider` 路由门面（R1 两段式）；**产品路径无 mock**，测试/冒烟把 mockSse 作为普通 provider 写进测试 config。
- `DEFAULT_CONFIG_TEXT` 重写：`providers.opencode-go`（zen base_url + `key_env: OPENCODE_API_KEY`）+ `user.model: "opencode-go/…"` + 注释（"复制此块接任意 OpenAI 兼容端点"）。

### 1b 模型入族谱（配置相）
- 树门面：`attach(entry + model)` / `modelOf` / `setModel`（不级联、下轮生效、**写实例行**，R14）/ `nodeConfigOf` = `{ access, model:{ref, origin: explicit|class|inherited|home} }`。
- 出生链 R6；`Runtime` L92 → `modelOf(agentId)`；`agent_instantiate` 增 model 参；新工具 `agent_set_model`（R7）；`pilot.setModel`；`agent_inspect` 出示整份 NodeConfig（origin 谱系，git-blame 式）。
- 拆除 `defaultModel` 全链（Q4 批准）；harness/webui 构造面随行。

### 1c 空间归位（原批 2 幸存项并入）
- **根伪 space bug 修复**：`registerRootAgent` 挂真实项目 space（废 `getOrCreate('user0')` 伪空间行）；老卷启动期一次性归并迁移（~10 行，现 `/data` 卷直接升级）。
- CLI `stem [path]` 位置参数 + webui 默认 cwd（R11）；`.gitignore` 加 `.stem/`（`!tmp/.stem/` 例外）。
- **验收**：解析链四级对拍矩阵 / setModel 写行 + 重启延续 / 不级联 / origin 四态正确 / providers 校验矩阵（缺 base_url、未知键、白名单不命中、user.model 缺失各 fail-fast）/ 路由 warn+硬错两段式 / mockSse-as-provider 映射测试 / 伪 space 迁移 + 旧卷回归 / 实弹：`ALIBABA_API_KEY=…` 真双轮对话 + 会话中 `set_model` A/B 换模型续谈。

## 2. 批 2 · WebUI（一个 commit，方案已成熟）
- 三态视觉 token（R8）全局 `.ico[data-state]`：遮罩/白边框/荧光；汉字表：静/思/持/断、停/缩/毁/生/送、审、工、摘；清 `⏸✕○◐▲▍⚙⚠`（流式光标 = border-right CSS）。
- **git 风族谱树侧栏**：原点行「我」（本空间 root，灰显）；DFS 行序 + SVG 泳道分支线（家族着色）；**行 = id（等宽）· 最近 user_prompt（剥 `<sender>` 截断 ~30 字）** + 状态字；溢出折叠（深>4 或同父>6 →「…+n」）；点行直达（树即列表）；`/api/agents` 增 `lastPrompt`。
- **第一视角**（R9）：user0 退出会话流；`view.js` 纯函数 `routeLetters` 按 sender 归位；ask 弹窗=「审」面板；空桌引导（删 server demo bootstrap，种子 #1/#5）。
- header 模型行：值 + origin 徽标 + 下拉即切（`/api/set_model`，批 1 接口）。~~space 切换器~~（R11 判死）。
- 测试：view.js 纯函数矩阵（computeLanes/routeLetters/截断/glyph 表）+ 真实 key 浏览器冒烟。

## 3. 批 3 · 目标-达成度进化（零实现承诺）
方案存档 = **evolution-plan.md §9**（例文拟合、评估者类、熔断、分数住类 custom）。实施时自动吃到本方案红利：setModel = 模型基因位逐代 A/B。

## 4. 整理轮账本（S6.3，scenarios 重写已完成 ✅）
随批清除：#1/#5（demo bootstrap/视图特判，批 2）、#2（mock 剧情下沉，批 1 顺带）、#7（Runtime 单层解析，批 1）、#8（process.env，批 1）、#10 新（顶层 model 残骸，批 1 即 R12）。批后评估：**#3** 三类基因源并存（`BUILTIN_TEMPLATES` 拆除半径=测试 fixture 全迁）、**#6** pilot 双通道、**#9** SpaceManager/spaces 表单行工件拆除。

## 5. 已知边界（接受并声明）
- 双开同 `.stem` 无锁（约定单实例，冲突未定义，R5）；
- 一 space 一世：类/进化史随目录走，跨目录共享靠复制（R3）；
- 观测面会话性：in-memory 日志随进程生死（语料在 db/类 custom，永久）；
- setModel 不级联：改父不动子（族规=出生快照，R6/R14）；
- deepseek 块 `base_url` 未实测（填官方值，404 自改）。

## 6. 纪律（已内化）
每批一个功能 commit（conventional，feat(S6.x) 式）；文档修正随功能批；AGENTS/README 不留临时指针；实施完成时同步 architecture.md（分层/解析律/config 键面）与 log.md。
