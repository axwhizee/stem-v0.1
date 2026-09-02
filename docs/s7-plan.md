# S7 方案：三维资源矩阵、工具生态与自主运行前检查

> 状态：**方案冻结，暂不执行**（2026-09-02 定稿）。前置 = S6 批 1/2 已落地（见 `s6-plan.md`）。
> 定位：让系统进入"自主运行"实测前的功能补齐——扩展体系定型（矩阵/目录形态）、web 工具、
> 真实 token 记账、user0 视角端到端、开发者手册。
> **S5.3 调度与 S5.4 dreaming（`evolution-plan.md`）不在本轮**——流程实测通过后才议。
> 实施偏差记 `log.md`，不回改本文（沿 S6 先例）。

## 1 裁决记录

- **D1 skill 工具化泛化**：skill 本质 = "调用返回一段 prompt 文本的工具"，废除 SkillRegistry +
  单 `skill` 工具 + `<available_skills>` manifest 注入三件套；每个 skill 注册为一个合成的
  `ToolCapability`（description 进工具 schema，正文 execute 懒加载——渐进披露语义不变）。
  收益 = 权限粒度升为**逐技能键**（族谱白名单精确圈定，替代现 `skill` 一键全有或全无）、
  ContextManager 删一条注入通路、技能直接继承工具生态一切机制（init 生命周期/ask/遥测/未来 hook）。
  目录约定保留 `SKILL.md` 名（opencode 生态兼容），附属脚本同目录经返回值路径提示由 fs/bash 触达。
- **D2 extensions 按资源目录分键**：`config.extensions` 从字符串数组升级为对象，
  键 = extension 资源根目录名（`tools/agent/skills/context`），值 = 该目录下启用的条目名数组。
  跨种类不混命名空间（用户裁决：防后续新增资源种类致混乱）。旧数组形态 = R12 拒启 + 迁移指路。
- **D3 目录形态 = 资源打包约定**：extension 与 custom 下**一资源一目录、入口代码与目录同名**
  （`tools/websearch/websearch.ts`），附属脚本/资源同目录自由放置；`.stem/` 侧兼容既有平铺单文件
  （`tools/xxx.ts`、`agent/xxx.md`、`skills/xxx.md`），目录形态优先。
- **D4 内置示例类归位**：`templates/SimpleChat|Coder.json` 语义即 internal 层（恒在），从 Kernel
  静态 import 迁入统一装载器的 internal 注册源；`demoTemplatesHook`（引用 bus_send/oc_* 等已死
  工具，属 S5 拆迁遗留）**整体删除**；其中引用活工具的 `creator` 调度者示例改写迁入
  `extension/agent/creator/`，充当 extension 类层首住户 + T4 用例载体。
- **D5 tokens 不新增标记**：`StoredMessage` 保持 `tag` / `tokens` 两标记——**tag = 是什么**
  （合成消息出处，strategy 写）、**tokens = 多大**（网关实测优先、估算兜底，来源不区分标记）。
- **D6 websearch 后端 = Dashscope WebSearch MCP**（沿用用户 opencode 自定义工具的通路：
  JSON-RPC initialize → `tools/call bailian_web_search`），密钥 `ALIBABA_API_KEY` 走 env，
  **绝不进源码**；webfetch 自实现轻量 HTML 转换，不引入 turndown 依赖（原型够用，手册注明可替换）。
- **D7 T4 测试网关 = `opencode-go/qwen3.8-flash`**（免费模型 = `(free)` 后缀，测试前打
  `/v1/models` 探测，命中则改用）；测试用例限量，不挂机。
- **D8 开发者手册后置（T5）**：注入点清单必须描述 T1-T4 定稿后的实况，一次成型免返工。
- **D9 缺省表**：`extensions.tools` 缺省 = `["read","write","edit","grep","glob"]`（fs 拆目录后
  逐名列举，等价旧 `["fs"]` 行为）；`agent/skills/context` 缺省 = `[]`。不引入"组"概念（机制大于判断）。

## 2 三维资源矩阵（核心抽象）

三种资源 × 三层来源，统一装载纪律；**解析器按种类各自保留**（.ts 模块 / .md frontmatter /
.json 三类 shape 是本质差异，不强行统一文件格式——少即是多）。

| | internal（恒在，代码注册） | extension（`config.extensions.<种类>` 显式启用） | custom（`.stem/` 自动扫描） |
|---|---|---|---|
| **tools** | core 系统工具 + bash +（原 skill 工具废除后）无 | `extension/tools/<名>/<名>.ts` | `.stem/tools/<名>/<名>.ts`（兼容平铺） |
| **agent 类** | user 根类（config.user）+ SimpleChat/Coder | `extension/agent/<名>/<名>.md` | `.stem/agent/<名>/<名>.md`（兼容平铺） |
| **skills** | （无内置） | `extension/skills/<名>/SKILL.md` | `.stem/skills/<名>/SKILL.md`（兼容平铺） |
| **context 策略** | classic / none | `extension/context/<名>/<名>.ts`（管线支持，暂无住户） | `.stem/context/<名>.ts`（已有） |

**统一装载律**（runInit/init 泛化为一个约定）：

1. 注册顺序 internal → extension → custom，**后层同名覆盖前层**（custom 覆盖内置 = 用户主权，
   与现 context 策略覆盖语义齐平）。
2. extension 条目未在目录/命名空间命中 = warn 跳过不炸启动（现 resolveToolSets 语义）；
   目录内非法文件 = 装载报错点名（与 runInit 现纪律一致）。
3. 入口发现：目录含与目录同名入口文件（tools/context = `.ts`；agent = `.md`；skills = `SKILL.md`
   固定名）；`_` 前缀目录 = 共享辅助代码（`extension/tools/_lib/`），不参与扫描。
4. skill 合成条目：`id/description/正文` 取 frontmatter 与 body，`parameters = {}`（无参），
   execute 返回正文 + 附属文件根路径提示；kind 随来源层；权限键 = 技能名（缺省落通用默认）。

**config.extensions 形态**（D2）：

```jsonc
"extensions": {
  "tools":   ["read", "write", "edit", "grep", "glob"],   // 缺省即此五项（D9）
  "agent":   [],
  "skills":  [],
  "context": []
}
```

core 侧类型从 `readonly string[]` 改为分键对象（仍只透传，解析在宿主）；
`extensions` 给出数组 = 顶层键类型错，R12 fail-fast 文案指路新形态。

## 3 批 T1：矩阵落地 + skill 工具化 + 清理

**变更面**（预计一次 commit）：

1. `ToolKind = 'internal' | 'shell' | 'user'` → `'internal' | 'extension' | 'custom'`
   （types.ts + 所有 kind 标注 + materialize 默认表 + webui/遥测措辞 + AGENTS.md 工具体系节）。
2. `shell/cli/tools/`（fs 五件套 + fs-util）→ `extension/tools/{read,write,edit,grep,glob}/`
   各自目录 + 共享 `extension/tools/_lib/`（fs-util/路径沙箱）；`TOOL_SETS` 常量退役，
   extension 装载改"目录扫描 + 命名空间校验"（宿主侧统一 loader，与 agent/context 同构）。
3. `src/core/tools/{skill.ts,SkillRegistry.ts}` 删除；skill 装载并入统一 loader 的 skills 种类
   （合成 ToolCapability）；`ContextManager` 删 `skills.manifest` 注入链（装配 options + 210 行段）；
   `system.ts` 删 skillDirOf/skillTool 装配；DEFAULT_USER_TOOLS 的 `skill` 键处置（移除，
   注释说明逐技能键语义）。
4. agent 类装载三分层：Kernel 去 `templates/*.json` 静态 import，内置模板入装载器 internal 源；
   `.stem/agent/` 扫描兼容目录形态；`extension/agent/creator/` 落位（D4）+ `demoTemplatesHook`
   删除（main.ts / webui server.ts 引用点清）。
5. `config.extensions` 分键对象化（types.ts + parse.ts 校验 + defaults.ts 模板 + 旧形态迁移文案）。
6. `.gitignore` 追加 `tmp/.stem/tools/websearch.ts`、`tmp/.stem/tools/deepsearch.ts`
   （含明文密钥的参考文件，防误提交）。
7. Dockerfile COPY 范围核查（extension/ 进镜像）；容器实测重启一次。
8. tsconfig include 范围核查（extension/ 现为工程内目录，typecheck 覆盖）。

**验收**：typecheck 0 + 全量测试绿 + 新增单测（extensions 对象解析/旧数组拒启、目录形态
custom 工具装载、同名覆盖顺序、skill 合成条目注册与逐键权限、`_lib` 不入库）+ mockSse 冒烟回归。

## 4 批 T2：websearch + webfetch（目录形态首批 dogfood）

- `extension/tools/websearch/`：`websearch.ts`（入口，ToolCapability）+ `dashscopeMcp.ts`
  （JSON-RPC 通路：initialize 幂等 + `tools/call bailian_web_search {query, count}`）
  + `format.ts`（结果行式压缩：标题/链接/摘要，控 token）。参数：`query` 必填、`count` 可选（默认 5 上限 20）。
  密钥 = `ALIBABA_API_KEY` env（宿主注入路径对齐 bash 端点模式：值不进 config/源码/日志）。
  超时（默认 30s）/输出截断（bash 同款限半径）。
- `extension/tools/webfetch/`：`webfetch.ts` + `htmlToText.ts`（剥 script/style/标签→文本、
  实体解码、空白收敛）。参数：`url` 必填、`format`（text|markdown 近似|html）缺省 text、
  `timeout` 秒上限 120、输出截断。User-Agent 伪装 + 重数上限（防重定向环）。
- 权限：`DEFAULT_USER_TOOLS` 增 `websearch` / `webfetch` = allow（对外操作面单点治理口径与 bash 一致：
  无 ask，不列键即 deny 自我限定）；tmp 配置 `extensions.tools` 显式启用两件。
- 测试：单测 = 假 fetch 注入（MCP 帧/HTML 样本夹具）；真实端点冒烟一次（有网环境，结果核验含链接）。

**验收**：typecheck + 全量绿 + 真网关对话中模型实际调 websearch/webfetch 各一次（T2 内自验，
T4 再纳入完整矩阵）。

## 5 批 T3：tokens 真实计量（累积差分归位）

gateway 通道已备（openaiCompatible `stream_options.include_usage` → `usage` 事件，
FakeGateway 可注入），缺口 = Runtime 收 usage 只进 totalCost，行级 `tokens` 全估算。

**归位算法**（纯函数 `attributeUsage`，可测）：

1. 记每 agent 上次请求的 `input_tokens` 累计基线；本轮：
   - `output_tokens` → 本轮生成 assistant 行的 `tokens`（含 toolCall 部分）。
   - `input_tokens(n) - input_tokens(n-1)` → 两轮之间新增行（tool 回执 / user 来信）的真实增量，
     按各行估算占比分摊（和 = 真实增量，单行仍留估算做形状）。
   - 差分为负或基线缺失（compact 重组轮跳变 / 首轮 / 重启）→ 本批回落估算，下次累积自然纠偏。
2. `tokens` 字段唯一，真实值直接覆盖估算（D5，不记来源）；system 头行、panel 消息等
   从未进网关的行保持估算。
3. `instance.totalCost` 改逐轮真实 usage 累加（现 estimateCost 通道升级口径）。
4. 红利自动生效：classic compact threshold 判断（有效消息 token 合计）与 `agent_inspect`
   /telemetry 的体量展示转为真实口径。

**验收**：FakeGateway 注 usage 的差分断言（多轮工具环逐行核对）+ sqlite 重载往返 +
真网关单轮比对（值明显偏离 chars/4 估算）+ 负差分护栏用例。

## 6 批 T4：user0 视角端到端实跑（报告进对话，不落文档）

环境：本机 `npm run web`（非 docker）+ tmp 空间；家学 `opencode-go/qwen3.8-flash`
（先探 `(free)` 变体，D7）；密钥经 powershell 读 Windows 用户 env → 只进子进程环境不落盘。
我以用户操作面（webui HTTP API + 文件面）执行：

| # | 用例 | 观察点 |
|---|------|--------|
| 1 | `.stem/agent/*.md` 建类 → 实例化 → 对话 | custom 类层、家学/类基因/显式四级 |
| 2 | `agent_class_create` 工具面建类（ask 审批） | 进化书写 + access 消息化全链 |
| 3 | fs + bash 工具任务（写文件/读回/echo） | extension 五目录逐一口验、tool 消息回填 |
| 4 | 类 tools 配 ask 键 → access_request → once/always/reject 三分支 | 根信箱、豁免备忘 |
| 5 | `extension/agent/creator` 调度子 agent | 父子挂接、agent_instantiate/context_wait、canReach |
| 6 | 长回复中途 interrupt → 再 sendMessage | thinking→interrupted 闭合、恢复续谈 |
| 7 | set_model 热切换 + agent_inspect origin 四态 | 模型四环 |
| 8 | websearch/webfetch 实调（真网关模型自主选用） | T2 全链 + 对外操作面 |
| 9 | token 记账抽查：跑完核 DB 行 tokens/totalCost 量级 | T3 真实口径 |
| 10 | 杀进程重启 | interrupted 归一、零重放、计数器/快照续接 |

发现的 bug 即修，修复合入对应批次 commit。测试后清理运行产物（tmp 空间 DB 视情况重置）。

## 7 批 T5：开发者手册 `docs/dev-guide.md`

注入点全清单以代码为准（编写时逐一核对），大纲：

1. 架构分层与 core 零平台依赖红线（端口注入全景表：`createStemSystem(deps)` 各 deps 契约）。
2. 三维资源矩阵（§2 展开成食谱）：每个格子"放什么文件/入口约定/示例/常见坑"——
   custom 工具（目录形态带附属脚本）、extension tool_set 开发与发布、agent 类三源、
   skill 写法（含 hook 面：ToolCapability.init）、context 策略契约。
3. `config.extensions` / stem.jsonc 键位速查（R12 语义、迁移史）。
4. 权限与模型族谱速查（四态/白名单键语义、grant 系统特权、四级模型律）。
5. 宿主 shell 实现指南：MessageStore/InstanceStore/ShellRunner/ModelGateway 端口 + buildGateway。
6. 事件流订阅（PilotEvent/EventHub）与遥测。
7. token 计量口径（tag vs tokens 分工）。
8. 安全治理（密钥 env 纪律、bash 无黑名单三机制、容器 = 爆炸半径）。

## 8 安全与治理

- 参考文件中的明文 Dashscope key（`sk-fc9c…`，tmp/.stem/tools/websearch.ts）：**未进 git 历史**
  （已核实 untracked），T1 加 ignore；该 key 曾明文落盘，建议尽快在阿里云控制台**轮换**。
- 新代码密钥治理红线不变：值只走 env，config/源码/日志/命令行（ps）四面不承载。
- web 两工具与 bash 同属对外操作面：ask 不设卡，超时/截断/白名单不列键三机制兜底。

## 9 明确不做（本轮）

- S5.3 调度 / S5.4 dreaming（等 T4 全绿后另议）。
- extensions "组"概念（fs 一键套）、跨种类混命名空间（D2 裁决）。
- turndown/Readability 依赖引入（D6）；tokensReal 来源标记（D5）。
- skill 的运行时动态启停子命令（工具化后族谱键即权限面，无需第二套开关）。

## 10 提交节奏与纪律

T1、T2、T3、T5 各一 conventional commit（T4 不产 commit，修 bug 归批）；
AGENTS.md/`architecture.md` 措辞同步随 T1（结构变更）与 T3（口径变更）；
每批合入前：typecheck 0 + 全量测试绿；文档偏差记 `log.md`。
