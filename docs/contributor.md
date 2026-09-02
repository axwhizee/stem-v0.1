# stem 贡献者手册（contributor）

> 开发纪律与风格契约的唯一落点。与其余文档的分工见 §1。
> 本卷自身首先遵守 §1 纪律：所有内容以**当前代码实况**为准，禁止补丁式缝补。

## 0. 三十秒阅读路线

改代码前：§1（文档纪律）→ §2（分层与模块契约）→ §6（测试）。
写文档时：§1 + 提交前对拍表（§1.3）。
扩展系统能力时：`docs/dev-guide.md`（扩展点全景与食谱）。

## 1. 文档维护纪律（最高优先级）

### 1.1 两类文档，两种义务

| 类型 | 卷 | 义务 |
|---|---|---|
| **实况卷** | AGENTS.md · docs/architecture.md · docs/api.md · docs/dev-guide.md · docs/llm-playbook.md · 本卷 · README | 承载"当前系统是什么"。内容过时 = bug，**整节系统性重写**，禁止局部打补丁 |
| **历史卷** | docs/log.md · docs/evolution-plan.md · prompts.md（阶段 plan 卷如 test-plan 落地即随批退役） | 承载"当时发生了什么/定了什么"。**只追加不回改**（偏差记 log，plan 卷是执行依据非实况） |

**plan 卷生命周期**（用户裁决）：阶段计划卷（`*-plan.md`）是实施期的执行依据；
**实施完成即随下一个功能提交删除**——全部裁决与沿革已追加在 log.md，残留计划
只会长成过时指路牌。写 plan 时即按此契约：plan 卷只承载"将要做什么+为什么这么定"，
不承载实况描述（实况永远归 architecture/api/dev-guide）。

### 1.2 为什么（历史教训实录）

补丁式更新是本项目文档的头号病灶——只写增量、不清旧账，过时内容沉底不被审视：

- `docs/code-style.md`（已于本卷合并后退役删除）：正文停留在 VSCode 时代愿景——`ContextAssetPool/KVStore/MessageBus/adapters/extension.ts` 组合根、`oc_*` 工具前缀、`normal/advanced/admin` 权限三级、`'idle'|'running'|'waiting'` 状态机。这些概念**全部已被废除**，直到有人拿它当契约才会中毒。
- AGENTS.md 曾长期表述「panel……如 user0」——暗示 user0 的类携带 `panel: true` 字段；实况是 **user0 的面板性来自根接线**（`Kernel` 对 `parentId=null` 的 `assemble:false`），`panel` 字段是策略 role 的泛化形态。一字之差会让人去 userClass.ts 找不存在的字段。
- `shell/cli/main.ts` 头注释残留「bus.send → 邮局 → 自动寄信」旧叙事（bus 早已工具化为 `bus_*` 系统工具）。

**判定标准：一段文字如果描述的是已经不存在的机制，它就是死文字。死文字零容忍——删掉或重写成活的事实，二者必居其一。**

### 1.3 改动后的对拍流程（提交前自查）

改了 X → 必须审视卷 Y 的**整节**（不是那句被改的话）：

| 改动 | 对拍位置 |
|---|---|
| core 公开接口/端口 | api.md（跑 §6 对拍脚本）+ architecture 对应模块节 + dev-guide 清单表 |
| 配置结构 | defaults.ts（首启模板 = 唯一预设）+ architecture 配置节 + AGENTS 配置节 + dev-guide §4 |
| 工具 kind/shape/权限语义 | architecture 工具节 + dev-guide §2-D + AGENTS 设计原则 + `extension/tools/`、`src/core/tools/` 全部住户 |
| 新增/退役模块、目录形态 | AGENTS 结构树 + architecture 结构图 + 本卷 §3 命名表 |
| 任何行为变更 | docs/log.md **追加**一条（含验证证据）；被影响的实况卷按上表整节重写 |

### 1.4 事实优先

文档与代码冲突时，**代码是真相，改文档**——除非确认代码本身是 bug（走修复+log 记账，不得反向把 bug 写成文档）。拿不准实况时读码或跑标本（dashboard 资源页 = 矩阵真实装配结果），禁止凭旧文档记忆推断。

## 2. 分层与模块结构契约

### 2.1 core 零平台依赖（D11，最高优先级硬规则）

- `src/core/` 禁止平台依赖与平台全局（`window`/`process`/`Deno`）；平台能力一律**接口暴露、宿主注入**（MessageStore/InstanceStore/ConfigStore/InitFs/InitToolLoader/ClassFs/ShellRunner/TimerFactory/LogSink/ModelGateway——全表见 dev-guide §2-A/§2-I）。
- 依赖方向单向：`shell → core ← extension`（core 不认识任何住户）；**禁止反向**（gateway 调 shell 之类）。
- 每个模块目录一个 `index.ts` 唯一出口（只 re-export 不写逻辑）；跨层引用**只能 import index**，禁止直引内部文件。
- 禁止全局单例（`globalThis`/`static` 持跨层状态）；装配只发生在组合根 `createStemSystem`（core 侧）与 `bootStem`（宿主侧）。
- 例外口径：`shell/`、`extension/` 是平台代码，豁免平台全局禁令（但 `extension/tools/*` 入口仍经工厂接 projectRoot，不读 `process.cwd`）。

### 2.2 接口即契约

- 层间交互对象必须有显式 interface，**接口与默认实现同文件**（`interface X` + `class DefaultX`）；实现可整体替换（SQLite→别的存储、FakeGateway 测试）。
- 消费方只依赖 interface 类型；构造器/`options` 注入依赖，不 import 具体实现。
- 接口方法签名以 `readonly` 属性形式声明（可解构、可转发）。

## 3. 命名与类型

| 场景 | 规则 | 现行示例 |
|---|---|---|
| 文件 | PascalCase 类文件；camelCase 功能文件 | `LineageTree.ts`、`agentParse.ts` |
| 接口 | 名词无 `I` 前缀 | `ModelGateway`、`ContextStrategyModule` |
| 实现类 | `Default` 前缀或语义名 | `DefaultRepository`、`AccessLedger` |
| 判别联合成员 | `type`/`kind` 域判别 | `PilotEvent`、`LogEvent`、`{kind:'...'}` 错误 |
| ID | branded string | `AgentID`/`AgentClassID`/`AgentSpaceID`/`ProjectRef`（构造走 `makeAgentID` 等） |
| 工具 id | 语义 snake/kebab；三分类 kind 而非前缀分权 | `agent_class_create`、`read`、`websearch` |
| 类模板 | `kernel/builtin/<Name>.json`（internal）；目录形态（extension/custom） | `Assistant.json`（占位继承类） |
| 常量 | UPPER_SNAKE | `DEFAULT_USER_TOOLS` |

类型纪律：多用 `readonly`/`interface`/`type`；**禁止 `any`**（未定用 `unknown`+守卫）；`verbatimModuleSyntax` 强制类型导入写 `import type`；`noUncheckedIndexedAccess` 下索引取值必须判空。

## 4. 错误处理与异步

- **core 错误 = 判别联合对象（`{ kind: ... }`），不是 Error 实例**；测试断言用 `assert.throws(rejects)` 谓词而非正则。宿主层（shell）例外可 Error。
- 高频通道 fail-soft：extension 工具缺依赖（密钥未配）回**可行动文本**给模型，不抛栈炸轮（websearch 是范本）；装载期问题进 `init.issues`（fail-soft 不炸启动，dashboard 可见）。
- 流式一律 `AsyncIterable`（`ModelGateway.chat`），消费方 `for await` + AbortSignal。
- Runtime 主循环必须有显式退出条件（maxSteps **每轮**归零 / 无 tool_call / finish）；策略 `process` 契约 = 重入 guard + 失败兜底，**绝不抛出到送信链路**。
- 持久化端口是**同步**接口（对齐 node:sqlite DatabaseSync 与仓库同步读）；写穿在内存生效后落行。

## 5. 工具与权限纪律（改动敏感区）

- `ToolKind = internal | extension | custom`；`ToolAccess = allow | ask | deny | ignore`；类 `tools` Record **键即白名单=自我限定**，`{}` = 本地封闭，**未设（undefined）= 完整继承父生效档案**（internal `assistant` 占位类即此形）。
- 改 `ToolKind`/工具 shape/`AgentClass.tools`/`ToolContext` 时全量对拍：`src/core/tools/`、`extension/tools/`、`DEFAULT_USER_TOOLS`、系统工具 schema、族谱台账、webui/dashboard 展示面。
- 权限与模型**一律走族谱树门面**（attach/detach/replay + effectiveAccess/modelOf/canReach）；禁止 kernel/tools 再拼第二套判定链（AccessLedger 是内部实现，禁止直连）。
- `grant` 是系统特权通道：`InstantiateOptions.accessMode` 不得出现在任何模型工具参数里。
- ask 是消息交换不是系统通道：改审批流程 = 改 `<access_request>` 消息形状，考虑根信箱可读性（实参披露是待裁决项，见 log）。

## 6. 测试规范

### 6.1 单测纪律

- 单测与源码同目录（`*.test.ts`），`node:test` + `node:assert/strict`；**不 mock 全局**——注入 fake（FakeGateway 注 usage、内存 registry、mkdtemp 真 fs、kernelHarness 手动计时器、gateway `fetch?` 传输口）。
- 纯逻辑抽纯函数单独测（access 代数/JSONC/frontmatter 解析/legalize/htmlExtract/dashscope 客户端）。
- 分模块跑 `npm run test:module -- "<glob>"`；各模块隔离（无共享全局态），可并发独立跑。

### 6.2 可行性冒烟（test/feasibility/，`npm run test:feas`）

跨模块全链路脚本（非 node:test，独立退出码）：offline1 装配/端到端/审批/书写/模型/重启、offline2 compact 策略面、online 真网关、http 双服务。改动 core 装配/族谱/网关后**必须**跑离线两档；发版前全四档。

### 6.3 真端点教训（本项目最高价值测试经验）

1. **自造 mock 会精确隐藏它没见过的形状**——dashscope tool_calls 尾分片带 `id:""` 覆盖真 id → 真网关工具链整体静默失效，单测全绿掩盖至今（修复见 log）。真端点冒烟不可省；抓真 SSE 原文写回归用例是标准流程。
2. **假阳性断言自查**：marker 别出现在 prompt 里（否则 user 行命中）；断言要指到 `role:"tool"` 行级证据。
3. **时序与口径陷阱**：等 LLM 轮先等进 `thinking` 再等离开（固定 sleep 竞态）；compact 检查点在"下一封 user 信抵达"，测试需要第三轮做触发探针；mock `prompt_tokens` 给**固定值**会命中负差回落护栏（Δ≤0 回落估算）——用量阶梯递增让真实归位通道保持畅通。

## 7. 提交规范

- 门槛：`npm run typecheck` 0 错误（`reference/` 参考码噪音忽略，对拍 `grep -v reference/`）+ `npm test` 全绿。
- 身份：`git -c user.name="OwlCat" -c user.email="owlcat@local" commit`（沿用仓库习惯）。
- `TODO.md`、`prompts.md` 是需求记录，不纳入提交。
- **commit message 只描述功能变化本身，严禁出现阶段/进度代号**（S7、T1、R6 之类）——历史要可读出"系统多了什么能力"，不是"项目走到哪"。plan 卷与 log.md 才承载代号叙事。
- 每功能批一次 conventional commit；scope 用能力域（feat(gateway)/feat(dashboard)/test/docs…）。

## 8. 环境与运行陷阱（WSL 开发机实录）

- nvm PATH **不跨 shell 会话**：每条命令自带 `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`。
- 密钥只走 env：Windows 用户环境变量经 `powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('<NAME>','User')"` 读取，只进子进程环境，零打印零落盘。
- 常驻服务必须 `setsid` 脱组（工具会话超时 SIGKILL 连坐进程组，nohup 挡不住）；`pkill -f` 模式串会自噬当前命令行，用 `[r]` 拆分写法。
- `/mnt/c` drvfs 偶发 `FileSystem.access` NotFound——重试即恢复，非产品问题。
- loopback HTTP 测试：脚本内防御性清 `*_PROXY` env；webui SSE 端点是 `/api/events`。
- SQLite：`all` 是保留字（`AS all` 语法错，`AS at` 可用）；node >= 23.4（node:sqlite 免 flag）。
- 运行依赖 tsx（无扩展名相对导入 + `.stem/tools/*.ts` 动态 import）；`jsonc-parser`/`yaml` 是运行时 dependencies（镜像 `npm ci --omit=dev` 不剔除）。
- webui/dashboard 绑定：裸机缺省 127.0.0.1，容器设 `STEM_HOST=0.0.0.0`（见 §2.1 容器即边界）。

## 9. 提交前自检清单

- [ ] 层间只 import `index.ts`？core 零平台依赖守住？
- [ ] 依赖单向（无 shell→core 反向）？无全局单例？
- [ ] 判别联合类型、无 `any`、`import type` 齐？
- [ ] 新逻辑有同目录单测？纯函数抽了？fake 注入而非 mock 全局？
- [ ] 动了接口/配置/工具 shape → §1.3 对拍表逐行走完（实况卷**整节**重写，非补一句）？
- [ ] log.md 追加了本批记账（含验证证据）？
- [ ] commit message 无进度代号？typecheck + 全量测试绿？
- [ ] 跨模块机制动过 → `npm run test:feas` 离线档跑了吗？发版批跑全四档 + 真端点？
