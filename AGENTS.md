# AGENTS.md

## 项目概览

**stem**（Self-Training Evolutionary Matrix）—— 独立原型验证项目：以**原子化 AgentClass（模板）+ Agent 实例**为核心的 Agent 系统。核心目标是从 VSCode 剥离、宿主无关（core 零平台依赖）。

- 定位：不是"把 opencode 塞进 VSCode"，也不是单 Agent 会话容器；是**用户主权的 Agent 系统**（类可自由创建/实例化，MessageBus 支撑多 agent 协作/自我进化）。
- 参考源码在 `reference/`（opencode v1.18.15、VSCode 1.132.0），**仅作参考，非本项目产物**，其类型/编译错误可忽略。

## 快速命令

```bash
npm install                 # 安装依赖（node >= 20）
npm run typecheck           # tsc --noEmit 类型检查（唯一 lint/typecheck）
npm test                    # 全量单测：tsx --test src/**/*.test.ts shell/**/*.test.ts
npx tsx --test <file>       # 跑单个测试文件
npm run test:module -- "src/core/kernel/*.test.ts"   # 按模块跑（node:test 并发）
npm run shell               # 交互式调试 shell（mock 网关）
OPENCODE_API_KEY=<key> npm run shell   # 真实网关（opencode-go）
npm run smoke               # prototype 冒烟（原型遗留，可能过时）
npm run build               # 与 typecheck 相同（tsc --noEmit）
```

## 项目结构

```text
src/core/                  # 纯 TS 领域逻辑，零平台依赖（D11 硬规则）
  ├── bus/                 # MessageBus：agent 间通信（log/权限回复路由）
  ├── config/              # 全局配置：StemConfig 类型 + JSONC 解析（唯一配置文件 .stem/stem.jsonc）
  ├── context/             # ContextManager + Mailbox：邮局模式、倒计时送信
  ├── gateway/             # ModelGateway 接口 + providers/（opencodeLlm）
  ├── init/                # 初始化管线：扫描 .stem/tool + .stem/agent → 同步注册表 → 注册进 core
  ├── kernel/              # AgentKernel 组合根 + 模板/实例/运行时
  ├── logging/             # LogEvent 判别联合 + Logger（经总线路由）
  ├── panel/               # PanelBus：面板消息统一通道（letter/权限请求）
  ├── permission/          # 原子化 per-tool 权限（allow/deny/ask）+ 评估
  ├── tools/               # ToolCapabilityRegistry：工具注册/执行/权限确认
  └── types.ts
shell/                     # 宿主层（node/CLI），实现 core 注入的接口
  ├── main.ts              # 调试 shell 入口（组合根）：跑 init + 注册工具/模板
  ├── config/              # node fs 版 ConfigStore / InitFs / 动态 import 用户工具
  ├── tools/               # host 内置工具（kind=shell）：read/write/edit/grep/glob
  └── ui/                  # 弹窗模块（权限确认队列）
templates/                 # 内置 AgentClass 模板（JSON）
test-support/              # 测试支撑：mockSse.ts（SSE mock 服务器）、kernelHarness.ts
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

### 工具体系

- `ToolKind` 三分类：`internal`（core 系统工具）/ `shell`（宿主内置）/ `user`（用户 `.stem/tool/` 提供）。
- 工具声明 `permission`（权限名，缺省=工具 id）+ `parameters`（object schema）。
- 统一权限确认在 registry 层：`allow` 执行 / `deny` 抛错 / `ask` 挂起 → PanelBus 弹窗 → `once`/`always`/`reject`。

### 权限模型

- 评估规则集（**最后命中优先**）：`[全局配置 permission（最弱）, agent 类 rules, session 批准（最强）]`，未列出默认 `ask`。
- `autoApprove: true` 时 ask 直接放行（`PermissionManager` 选项）。

### 全局配置与初始化（唯一配置文件）

- 配置文件：`<projectRoot>/.stem/stem.jsonc`（或 `stem.json`），是**最终配置载体**，本阶段无多级合并。
- 配置项：`model`（`提供商/模型` 格式）、`autoApprove`、`permission`、`sendCountdown`、`tools`/`agents`（**纯镜像注册表**，init 自动维护）。
- `core/init` 管线（`runInit(deps)`）：扫描 `.stem/tool/*.ts`（默认导出 `ToolCapability`）+ `.stem/agent/*.md`（YAML 头 + 正文）→ 同步注册表（jsonc-parser 定点写回，保留注释）→ 注册进 `ToolCapabilityRegistry` + `AgentTemplateRegistry`。
- **用户 agent 文件**：文件名即类 id/name（不要求 YAML id/name）；`permission` 的键即工具白名单（融合设计）；`metadata` 等附加字段忽略。

### 测试规范

- 单测与源码同目录（`*.test.ts`），用 `node:test` + `node:assert/strict`。
- **不 mock 全局**；注入 fake（`FakeGateway`、内存 registry、临时目录）。
- 真实 fs 集成测试用 `mkdtemp` 临时目录（见 `shell/config/nodeConfig.test.ts`）。
- 纯逻辑抽纯函数（工具访问评估、JSONC 解析、agent frontmatter 解析）。
- **分模块测试**（改哪测哪）：`npm run test:module -- "src/core/kernel/*.test.ts"`。各模块已隔离（mock 端口 `listen(0)` 自动分配、fs 用独立 `mkdtemp`、无共享全局态），模块间无顺序依赖，可并发独立跑。

## 提交规范

- 提交前必须通过：`npm run typecheck`（0 错误，忽略 `reference/` 下错误）+ `npm test`（全绿）。
- `reference/` 目录下的 LSP/编译错误是参考代码噪音，**不要修改**，typecheck 结果以 `grep -v reference/opencode` 为准。
- 提交身份：`git -c user.name="OwlCat" -c user.email="owlcat@local" commit`（沿用仓库习惯）。
- `TODO.md` 是需求记录，**不纳入提交**。
- 新增核心模块需同步更新 `architecture.md`（root）与 `log.md`。

## 常见陷阱

- `verbatimModuleSyntax: true`：类型导入必须 `import type`。
- `noUncheckedIndexedAccess: true`：数组索引访问可能为 `undefined`，需判空。
- core 错误用判别联合对象（`{ kind: ... }`），不是 Error 实例；`assert.throws` 用谓词而非正则。
- `jsonc-parser` / `yaml` 是运行时依赖（`dependencies`），tsx/node 运行时直接使用。
- 改动 `ToolKind` / 工具 shape 时，同时检查 `shell/tools/` 与 `src/core/tools/`。
