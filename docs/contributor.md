# stem 开发手册

> 面向开发者的唯一纪律落点：工作流、分层契约、命名与类型、错误模型、测试、提交。

## 读什么

| 你要做的事 | 先读 |
|---|---|
| 改 core / 加能力 | 本卷 §2–§5 + 相关模块 README + `architecture.md` 对应模型节 |
| 写/改文档 | 本卷 §1 + 提交前对拍表 |
| 跑测试 / 排查假绿 | 本卷 §6 |
| 提交 | 本卷 §7 + 自检清单 |
| 了解系统 | `README.md` → `docs/architecture.md` |

## 1. 开发工作流

1. **改前**：读相关模块 README 与 `architecture.md` 对应节；跨模块先看模块导航表。
2. **实现**：
   - **加法**（新能力）做完整，不留半成品；
   - **减法**（重构/审查）用通用机制替换补丁，删特判、去重复、灭死代码；
   - 新需求先问「既有机制能否自然表达」——能则强化、复用现有机制，不能才加新组件。
3. **验证**：`npm run typecheck` + `npm test`；跨模块改跑 `npm run test:feas` 离线档。
4. **文档**：按 §2 对拍表整节重写受影响实况卷，禁止补丁式缝一句。
5. **提交**：先向用户报告增量，同意后再 commit（见 §7）。

---

## 2. 文档纪律

### 2.1 分工

| 卷 | 职责 | 更新时机 |
|---|---|---|
| `README.md` | 用户面：定位、特征、架构概览、上手、文档指南 | 特征/上手变化 |
| `docs/architecture.md` | 概念提纲 + 关键模型 + 模块导航 | 跨模块机制变化 |
| `AGENTS.md` | agent 实操：命令、结构、工作流、环境坑 | 实操面变化 |
| 本卷 | 开发者纪律 | 纪律/流程变化 |
| 各模块 `README.md` | 该模块**当前**实现逻辑 | 模块行为变化 |
| `docs/api.md` | 接口清单（交付产物） | **仅正式 tag 发布前统一重定稿** |

- **实况卷只写「现在是什么」**；过时 = bug，**整节系统性重写**，禁止局部打补丁。
- **沿革由 git 提交历史承载**（行为变化写进 commit message）；不设日志卷。
- **plan 卷** = 仓库根 `plan.md`（gitignore，不入 `docs/`）；实现完成即删除。只写「将要做什么 + 为什么」，不写实况。
- **事实优先**：文档与代码冲突时，代码是真相，改文档。拿不准就读码或跑标本，禁止凭旧文档记忆推断。
- **死文字零容忍**：描述已不存在机制的段落，删掉或重写成活事实，二者必居其一。禁止把沿革写进实况（「X 已删除 / 曾经是 Y」）。

### 2.2 改动后对拍（提交前）

| 改了什么 | 必须审视（整节，不是那一句） |
|---|---|
| core 公开接口/端口 | 模块 README + architecture 模块导航；api.md 标「tag 前重定稿」即可 |
| 配置结构 | `defaults.ts` 首启模板 + `config/README` + `README.md` 参数速查 |
| 工具 kind/shape/权限语义 | architecture 收敛模型 + `tools/README` + `README.md` 工具一览 |
| 新增/退役模块或目录 | `AGENTS.md` 结构树 + architecture 结构图 + 本卷命名表 |
| 任何行为变化 | commit message 说清行为；上表相关卷整节重写 |

---

## 3. 分层与契约

### 3.1 core 零平台依赖（最高优先级硬规则）

- `src/core/` 禁止平台依赖与平台全局（`window` / `process` / `Deno`）。平台能力一律**接口暴露、宿主注入**（MessageStore / InstanceStore / ConfigStore / InitFs / InitToolLoader / ClassFs / ShellRunner / TimerFactory / LogSink / ModelGateway 等，全表见各模块 README）。
- 依赖单向：`shell → core`，`extension → core`；core 不认识住户。禁止反向。
- 每个模块一个 `index.ts` 唯一出口（只 re-export）；跨层**只 import index**，禁止直引内部文件。
- 禁止全局单例持跨层状态。装配只发生在组合根 `createStemSystem`（core）与 `bootStem`（宿主）。
- `shell/`、`extension/` 是平台代码，豁免平台全局禁令；`extension/tools/*` 入口仍经工厂接 projectRoot，不读 `process.cwd`。

### 3.2 接口即契约

- 层间交互必须有显式 interface；**接口与默认实现同文件**（`interface X` + `class DefaultX`）。
- 消费方只依赖 interface；构造器/`options` 注入，不 import 具体实现。
- 接口方法用 `readonly` 属性形式声明（可解构、可转发）。

### 3.3 运行期写面（敏感）

- 实例参数唯一写通道 = `kernel.updateAgent`（`name` / `model` / `temperature` / `effort`）。禁止新增散点 setter。
- 类 tools 收敛硬门禁在 `kernel.updateAgentClass` 写入面；工具层只做 agent 友好预检。
- 权限与模型一律走 `LineageTree` 门面；`AccessLedger` 是内部实现，禁止直连。

---

## 4. 命名与类型

| 场景 | 规则 | 示例 |
|---|---|---|
| 文件 | 类 PascalCase；功能 camelCase | `LineageTree.ts`、`agentFile.ts` |
| 接口 | 名词，无 `I` 前缀 | `ModelGateway`、`ContextStrategyModule` |
| 实现类 | `Default` 前缀或语义名 | `DefaultRepository`、`AccessLedger` |
| 判别联合 | `type` / `kind` 域 | `PilotEvent`、`KernelError` |
| ID | branded string + 构造函数 | `AgentID`、`AgentClassID`、`makeAgentID` |
| 工具 id | 语义 snake/kebab | `agent_class_create`、`read` |
| 常量 | UPPER_SNAKE | `BASH_DEFAULTS` |

类型纪律：

- 多用 `readonly` / `interface` / `type`；**禁止 `any`**（未知用 `unknown` + 守卫）。
- `import type` 写类型导入；`noUncheckedIndexedAccess` 下索引取值必须判空。
- core 错误 = **判别联合对象**（`{ kind: ... }`），不是 Error 实例。测试用谓词断言，宿主 shell 可用 Error。

---

## 5. 错误与异步

- **高频通道 fail-soft**：extension 工具缺依赖回可行动文本给模型，不抛栈炸轮；装载期问题进 `init.issues`（不炸启动）。
- **流式**一律 `AsyncIterable`，消费方 `for await` + AbortSignal。
- **Runtime 主循环**必须有显式退出条件（无 tool_call / finish）。
- **策略 `process`** = 重入 guard + 失败兜底，**绝不抛出到送信链路**。
- **持久化端口同步**（对齐 node:sqlite）；写穿在内存生效后落行。
- 工具执行通道对带 `kind` 的领域错误**原样透传**（工具是通道不是转换器）；非结构化异常用 `errorBrief` / `execution_failed` 收口。

---

## 6. 工具与权限（改动敏感区）

- `ToolAccess = allow | ask | deny | ignore`；严格度总序 **`deny ≺ ask ≺ allow ≺ ignore`**，一切书写面只许顺链收缩。
- 类 `tools`：**键即白名单**；`{}` = 本地封闭；**未设 = 完整继承父生效档案**。
- 改工具 shape（含 `registerAccess`）/ `AgentClass.tools` / `ToolContext` 时全量对拍：tools 模块、extension 工具、注册表出生面、系统工具 schema、族谱台账、config 模板、webui/dashboard。
- `grant` = 整表替换 + 逐键祖先封顶，仅策略 spawn 通道使用。
- ask 是消息交换：改审批 = 改 `<access_request>` 消息形状，考虑根信箱可读性。

---

## 7. 测试

### 7.1 单测

- 与源码同目录（`*.test.ts`），`node:test` + `node:assert/strict`。
- **不 mock 全局**——注入 fake：FakeGateway、内存 registry、mkdtemp 真 fs、kernelHarness 手动计时器、gateway `fetch?`。
- 纯逻辑抽纯函数单独测（access 代数 / JSONC / frontmatter / legalize 等）。
- 分模块：`npm run test:module -- "<glob>"`。

### 7.2 可行性冒烟

`npm run test:feas`（`test/feasibility/`）：offline1 装配/端到端/审批/书写/模型/重启；offline2 compact；online 真网关（需密钥）。

- 改 core 装配 / 族谱 / 网关 → **必须**跑离线两档。
- 发版前补跑在线档。

### 7.3 真端点教训（高价值）

1. **自造 mock 会精确隐藏它没见过的形状**——真端点冒烟不可省；抓真 SSE 原文写回归是标准流程。
2. **假阳性断言**：marker 别写进 prompt；断言指到 `role:"tool"` 行级证据。
3. **时序**：等 LLM 轮先等进 `thinking` 再等离开；compact 探针要第三轮；`prompt_tokens` 用阶梯递增，固定值会撞负差回落护栏。
4. **手动计时器**：`flushAll` 全量触发会同时炸掉长超时与 0ms 倒计时——含 `waitForReply` 的链先 pump，久无进展再 flush；配对通道守「先登记等待者、后投递触发信」。

---

## 8. 提交

- **门槛**：`npm run typecheck` 0（忽略 `reference/` 噪音）+ `npm test` 相对基线不新增失败。
- **身份**：`git -c user.name="OwlCat" -c user.email="owlcat@local" commit`。
- **提交前一律先让用户审查**。
- **message**：conventional commit；标题一句话说清功能变化；正文只列关键点。**严禁进度代号**（S7/T1/R6 之类）——历史要读出「系统多了什么能力」。
- 每功能批一次 commit；scope 用能力域（feat(kernel) / refactor(tools) / docs / test…）。
- `docs/prompts.md` 不提交。

---

## 9. 环境陷阱（开发机实录）

- nvm PATH **不跨 shell 会话**：每条命令自带 `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`。
- 密钥只走 env：Windows 用户变量经 `powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('<NAME>','User')"` 读，只进子进程，零打印零落盘。
- 常驻服务必须 `setsid` 脱组；`pkill -f` 用 `[r]` 拆分防自噬。
- `/mnt/c` drvfs 偶发 NotFound——重试即恢复。
- loopback HTTP 测试清 `*_PROXY`；webui SSE = `/api/events`。
- SQLite：`all` 是保留字；node ≥ 23.4。
- 运行依赖 `tsx`；`jsonc-parser` / `yaml` 是 runtime dependencies。
- webui/dashboard：裸机 127.0.0.1；容器 `STEM_HOST=0.0.0.0`。

---

## 10. 提交前自检

- [ ] 层间只 import `index.ts`？core 零平台依赖？
- [ ] 依赖单向？无全局单例？
- [ ] 判别联合、无 `any`、`import type`？
- [ ] 新逻辑有同目录单测？fake 注入而非 mock 全局？
- [ ] 动了接口/配置/工具 shape → §2.2 对拍表走完（整节重写）？
- [ ] 行为变化写进 commit message？无进度代号？
- [ ] typecheck + 全量测试绿？
- [ ] 跨模块 → offline feas 跑过？发版批补在线档？
