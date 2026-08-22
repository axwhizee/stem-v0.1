# AGENTS.md

## 项目概览

**stem**（Self-Training Evolutionary Matrix）—— 独立原型验证项目：以**原子化 AgentClass（模板）+ Agent 实例**为核心的 Agent 系统。核心目标是从 VSCode 剥离、宿主无关（core 零平台依赖）。

- 定位：不是"把 opencode 塞进 VSCode"，也不是单 Agent 会话容器；是**用户主权的 Agent 系统**——类可自由创建/实例化，配**族谱树**与多 agent 协作，让 AI 自己管理 Agent 信息实现自我进化。
- 参考源码在 `reference/`（deepseek-harness、pi、opencode、VSCode），**仅作参考，非本项目产物**，其类型/编译错误可忽略。

## 设计原则（硬规则）

1. **全体 agent 绝对平等**：user0 是内置 `user` 类的普通实例（`parentId=null` 即根），
   无任何权限/流程特判；一切差异仅由类/实例配置与族谱收敛产生。
2. **机制大于判断**：能靠既有机制表达的需求不新增组件（user0 平等化后 PanelBus /
   AccessManager / META 特判即自然消失）。ask 审批是**消息交换**（`access_request` →
   根信箱 → `access_reply`），不是系统耦合通道；上下文删除 = `markInvalid` + 组装时 `legalize`。
3. **权限收敛走族谱**：config 中工具权限设置 = **user 模板的 tools 清单**（内置根模板）；
   生效权限 = 祖先链（含 user0 根）→ 类清单 → session 批准，层间单调收缩
   （`deny ≺ ask ≺ allow/ignore`）；internal 默认 `ignore` 仅兜底，显式权限一律由模板声明。
4. **模块自治**：初始化/装配在 core（平台能力经接口注入，core 零平台依赖、可独立运行）；
   shell 只做平台适配 + UI；外部与 core 的一切交互经模块接口（pilot 为 user0 扮演接口）。
5. **少即是多**：工具生命周期（`init`）扩展优先于新建子系统；internal 工具列表不固化、随开发增长。
6. **架构分层**：`shell`（交互层，最外）→ `core`（agents 生态 + skill + 系统工具 + bash，
   即最小系统）→ `extension`（可选功能扩展，典型：扩展工具集）。

## 快速命令

```bash
npm install                 # 安装依赖（node >= 20）
npm run typecheck           # tsc --noEmit 类型检查（唯一 lint/typecheck）
npm test                    # 全量单测：tsx --test src/**/*.test.ts shell/**/*.test.ts
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑（node:test 并发）
npm run shell               # 交互式调试 shell（mock 网关）
OPENCODE_API_KEY=<key> npm run shell   # 真实网关（opencode-go）
npm run build               # 与 typecheck 相同（tsc --noEmit）
```

## 项目结构

```text
src/core/                  # 纯 TS 领域逻辑，零平台依赖（D11 硬规则）
  ├── config/              # 全局配置：StemConfig 类型 + JSONC 解析（唯一配置文件 .stem/stem.jsonc）
  ├── context/             # 重建邮局：仓库 Repository + 管理员 ContextManager + 快递员 Courier
  │                        #   + tag/双索引 + exportJsonl/overview
  ├── gateway/             # ModelGateway 接口 + providers/(opencodeLlm / fetch) + FakeGateway
  ├── init/                # 初始化管线：扫描 .stem/tool + .stem/agent → 同步注册表 → 注册进 core
  ├── kernel/              # Kernel 组合根 + TemplateRegistry/InstanceManager/SpaceManager/
  │                        #   Runtime/LineageTree（族谱）
  ├── logging/             # LogEvent 判别联合 + Logger（经注入 LogSink，无总线）
  ├── panel/               # PanelBus：面板消息统一通道（letter/访问确认/通知）
  ├── tools/               # ToolCapabilityRegistry + access.ts（四态评估）+ AccessManager
  └── types.ts
shell/                     # 宿主层（node/CLI），实现 core 注入的接口
  ├── main.ts              # 调试 shell 入口（组合根）：跑 init + 注册工具/模板
  ├── config/              # node fs 版 ConfigStore / InitFs / 动态 import 用户工具
  ├── tools/               # host 内置工具（kind=shell）：read/write/edit/grep/glob
  └── ui/                  # 弹窗模块（访问确认队列）
templates/                 # 内置 AgentClass 模板（JSON，name 即 id，tools 为 Record）
test-support/              # 测试支撑：kernelHarness.ts（内存 + FakeGateway + 手动计时器）
tmp/                       # 测试项目空间（.stem/ 配置 + 用户 tool/agent 示例）
docs/                      # 设计文档（architecture/decisions/code-style/…）
architecture.md            # 当前实现架构（root）
log.md                     # 开发日志（root）
```

## 核心架构要点

### Core 零平台依赖（最高优先级硬规则）

- `src/core/` 内**禁止** `import 'vscode'`、禁止平台全局（`window`/`process`/`Deno`）。
- 平台能力（fs、动态 import、网络）全部**以接口暴露、由宿主注入**：如 `ConfigStore`、`InitFs`、`InitToolLoader`、`ModelGateway`、`LogSink`、`PanelConsumer`。
- 跨层引用**只能 import `index.ts`**（禁止 import 内部文件）。
- 接口 + 实现同文件（`interface X` + `DefaultX`），模块目录含 `index.ts` 唯一出口。

### 核心模型

- **AgentClass（模板）**：`name` 即 id（注册查重）；`description`；`systemPrompt`；`tools`（`Record<访问键, ask|deny|allow|ignore>`，**键即白名单**，空 Record=无工具、undefined=全部）；`contextStrategy`（默认 classic）；`model`；`sendCountdown`。
- **AgentInstance**：`id` / `classRef`（模板名）/ `parentId`（= 创建者，user0 为 null 即根）/ `displayName` / `spaceId` / `status` / `turnCount` / `totalCost` / `userPrompt` / `toolOverride`。**creatorId 已合并进 parentId**（谁创建谁就是父），运行时属性多于工具调用参数。
- **状态机**：`idle → thinking → holding`；`interrupted`（当前轮被中断，仅暂停、消息闭合、可恢复）。
- **族谱树（LineageTree）**：无状态关系查询视图——parentId 挂实例上，实时推导 parent/children/ancestors/descendants；销毁权（祖先或 user0 可销毁；有活跃子默认拒，recursive 级联）。
- **重建邮局（无总线）**：仓库（存储）→ 管理员（打戳/组装/context_wait 填充）→ 快递员（倒计时送信）；agent 通信经 `kernel.sendMessage` 直接投递；log/access_reply 走注入接口。

### 工具体系与访问

- `ToolKind` 三分类：`internal`（core 系统工具，默认 `ignore` 隐藏）/ `shell`（宿主内置）/ `user`（用户 `.stem/tool/` 提供）。
- `ToolAccess` 四态：`allow`（暴露+执行）/ `ask`（暴露+执行弹窗）/ `deny`（不暴露+拒绝）/ `ignore`（不暴露+等同 allow）。
- **分层评估（单调收缩）**：`[全局 → 祖先链 → agent 类(tools) → session 批准]`，层间取最严格；`deny` 不可被后序规则撤销；session 批准仅当前实例，不传播后代。默认 ask（internal 默认 ignore）。
- 统一访问确认在 registry 层（AccessManager）：allow/ignore 执行 / deny 抛错 / ask 挂起 → PanelBus 弹窗 → user0 回复（once/always/reject）。

### 消息库：tag + 双索引

- `StoredMessage`：`id / agentId / message / at / tokens / valid / from? / tag? / turn / indexInTurn`。
- **tag**（可选）：标记非原生合成消息（如 summary/impression/meta）；**strategy 是上下文属性**（实例化时确定），组装器按 agent 的策略解释 tag。
- **双索引**：`turn` = 轮序号（复用 turnCount 语义：user 消息开启新轮）、`indexInTurn` = 轮内序号；Repository 自动维护。

### 全局配置与初始化（唯一配置文件）

- 配置文件：`<projectRoot>/.stem/stem.jsonc`（或 `stem.json`），是**最终配置载体**，本阶段无多级合并。
- 配置项：`model`（`提供商/模型` 格式）、`autoApprove`、`permission`（全局工具访问最弱层）、`sendCountdown`、`tools`/`agents`（**纯镜像注册表**，init 自动维护）。
- `core/init` 管线（`runInit(deps)`）：扫描 `.stem/tool/*.ts`（默认导出 `ToolCapability`）+ `.stem/agent/*.md`（YAML 头 + 正文）→ 同步注册表（jsonc-parser 定点写回，保留注释）→ 注册进 `ToolCapabilityRegistry` + `TemplateRegistry`。
- **用户 agent 文件**：文件名即类 id/name（不要求 YAML id/name）；`permission` 的键即工具清单（融合设计，工具=键、动作=值）；`metadata` 等附加字段忽略。

### 测试规范

- 单测与源码同目录（`*.test.ts`），用 `node:test` + `node:assert/strict`。
- **不 mock 全局**；注入 fake（`FakeGateway`、内存 registry、临时目录）。
- 真实 fs 集成测试用 `mkdtemp` 临时目录（见 `shell/config/nodeConfig.test.ts`）。
- 纯逻辑抽纯函数（工具访问评估 access.ts、JSONC 解析、agent frontmatter 解析）。
- **分模块测试**（改哪测哪）：`npm run test:module -- "src/core/kernel/*.test.ts"`。各模块已隔离（无共享全局态、fs 用独立 mkdtemp），模块间无顺序依赖，可并发独立跑。

## 提交规范

- 提交前必须通过：`npm run typecheck`（0 错误，忽略 `reference/` 下错误）+ `npm test`（全绿）。
- `reference/` 目录下的 LSP/编译错误是参考代码噪音，**不要修改**，typecheck 结果以 `grep -v reference/` 为准。
- 提交身份：`git -c user.name="OwlCat" -c user.email="owlcat@local" commit`（沿用仓库习惯）。
- `TODO.md`、`prompts.md` 是需求记录，**不纳入提交**。
- 新增核心模块需同步更新 `architecture.md`（root）与 `log.md`。

## 常见陷阱

- `verbatimModuleSyntax: true`：类型导入必须 `import type`。
- `noUncheckedIndexedAccess: true`：数组索引访问可能为 `undefined`，需判空。
- core 错误用判别联合对象（`{ kind: ... }`），不是 Error 实例；`assert.throws` 用谓词而非正则。
- `jsonc-parser` / `yaml` 是运行时依赖（`dependencies`），tsx/node 运行时直接使用。
- 改动 `ToolKind` / 工具 shape / `AgentClass.tools` 时，同时检查 `shell/tools/` 与 `src/core/tools/`。
- `AgentClass`：name 即模板键；`tools` 为 `Record`（键即白名单），不再是数组 + 独立 toolAccess。
- `AgentInstance`：无 creatorId；族谱关系用 parentId。
