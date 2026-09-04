# v1.0 发布前实测计划（落盘 2026-09-04）

> **性质**：plan 卷——执行依据不回改；完成后删除随功能批提交（contributor §7）。
> **一句话**：我以 user0 第一视角组织真模型（`opencode-go/qwen3.8-flash`）跑 scenarios.md 场景 1-5 全链路，产出证据归档与阻塞清单，然后打 v1.0 tag。

## 0. 环境事实（每条命令都要）

- PATH：`export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`（每条 bash 自带）。
- 密钥：`OPENCODE_API_KEY`——`timeout 15 powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('OPENCODE_API_KEY','User')" | tr -d '\r\n'` 注入子进程 env（零打印零落盘）。
- 基线（S10 headers 修完后）：typecheck 0 + **347/347** + 离线双档 29/9。
- opencode 头适配已就位（shell/cli/gateway.ts `providerFetch`：UA + x-opencode-session 每进程 uuid）——**在线测试本身就是它的实战验证**；若网关 4xx 报头相关，先查这里。
- 提交纪律：任何提交前先征求用户同意；message 精炼；plan 卷随实现退役。

## 1. 准备件

- **验收空间 `test/space-v11/`**（新建，不污染 v10 现场）：
  - `stem.jsonc`：providers 含 opencode-go（key_env=OPENCODE_API_KEY）；`user.model = "opencode-go/qwen3.8-flash"`；`user.displayName = "船长"`（场景 1 顺带验证 S9 新链）；`context.window` 按 qwen3.8-flash 真实窗填（查 provider 文档定，默认 1M 档 → cortex dreamAt 另定）；`autoApprove: false`（ask 门必须走真答复流——由我经 pilot.replyAccess 扮演答复）。
  - `.stem/agent/` 类文件：`tester.md`（场景 2：读写+跑测，bash allow，max_steps 不设=无限）、`organizer.md`（场景 3：编排者，agent_instantiate+bus allow）、`worker.md`（场景 3 工人）、`cortex-pet.md`（场景 5：`context_strategy: cortex` + `cortex.dreamAt: ~15000` 压小让梦真实触发）、`evolver.md`（场景 4 起点基因）。
  - `bug/` 目录：含一个坏函数的小项目（tester 修）。
  - `.gitignore` 语境：`.artifacts/` 已豁免入库规则处理（v10 先例：space-v10/.artifacts 忽略——同样给 v11 加一行或证据直接入 DB）。
- **编排脚本 `test/feasibility/v10-live.mts`**：仿 update2/tree3 模式（createStemSystem 真网关 + pilot 流 + deliveries + replyAccess 审批 + 断言）；分场景可单跑（`--scenario=N`）；证据写 `test/space-v11/.artifacts/s<N>-*.json`（每场景：关键 telemetry 切片 + context_export + 断言结果表）。
- scenarios.md 场景 5 段**过时修正**（cortex 已实施、brain-plan/schedule 卷已退役）——本批顺手改实况。

## 2. 场景剧本（每轮 = 真模型对话，断言 = 结构化事实非文本相等）

| 场景 | 轮次设计 | 通过判据（证据） |
|---|---|---|
| 1 常驻助理 | 双轮对话（埋事实 A：喜欢某饮料+项目名）→ **重启进程** → 问「我喜欢什么」→ telemetry_query 回放 | 语境复现（文本含事实 A）；letter/status 事件流完整；displayName=船长 出现于 webui/CLI 侧栏与 letter |
| 2 专职工人 | user0 实例化 tester（`agent_instantiate`）指 bug/；tester bash 跑测→红→改文件（**ask 弹→我 replyAccess once**）→跑→绿→回信 | ask 申请在场（access.asked 事件）；测试文件真变绿（磁盘断言）；父信箱收到总结 |
| 3 族谱协作 | user0→organizer→两 worker（deptA/deptB 用 **wait:true** 收卷）互发 bus 信 | 收卷结果两行都在 organizer 上下文（tool 行配对）；部门墙：在 organizer 上 telemetry_query 看不到兄弟细节（可见域断言）；树形 agent_descendants 正确 |
| 4 进化半环 | user0 经 agent_class_create（ask→批）建 `evolver-v2.md`（systemPrompt 注入新风格）→ 重启 → 实例化 v2 → 输出携带新基因 | 类文件落盘；重启装载（kernel.class.registered）；新实例行为符合新 systemPrompt；现役 v1 实例不变（只影响后续实例） |
| 5 cortex 主场 | cortex-pet 长任务 30-40 轮（跨 **≥2 次梦**）：埋早期 needle 事实 → 灌工作轮 → 观察 `context.dreamed` 事件/记忆组轮替 → **梦后问 needle** → `.memory.json` 与 ltm 行一致性 → 穿插 agent_pause（挂起时发消息→醒后答出）与手动 `context_apply dream` | **核心断言：梦后上下文无实时轮仍答对 needle**；水位线梦后回落（estimatedTokens 观测量级）；镜像一致；invalid 轮替链可查（dashboard/直查 DB）；pause 醒后答出新信；半途/重触发若出现记 log 不判失败 |
| 6 幸存者 | **不跑**（明示非承诺，gap①②未设计） | — |

**成本闸**：qwen3.8-flash 单价低，预估全程 < ¥10；每场景证据文件含 usage 累计（`gateway.apiRequest` cost），超 3× 预估即中断报告。

## 3. 阻塞与修复约定

- 任一场景红 → 停在该场景，修复（修复=独立功能批，先报告再提交）→ 重跑该场景 → 继续。
- 修复引入的行为变化照惯例：log.md 追加 + 实况卷对拍。
- 已知候选雷（预判决策树）：① wait 收卷时序（真网络延迟比 FakeGateway 大——waitTimeoutMs 未配时超时值 = compact.replyTimeoutMs 60s，dream worker 也同闸）；② cortex dreamAt=15000 下 needle 轮次估算（每轮 ~500 tok → ~30 轮一梦，30-40 轮跨 2 梦可行——若模型回复超长/短需现场调参，调整只动类文件不改代码）；③ qwen3.8-flash 对工具 schema 的服从度（validate 错误文本回环首次实战，出现死循环重试即记观察项）；④ 9/06 前 opencode 头已修，若仍被拒→ 报告用户决策。
- 全绿后收尾批：**删除本卷** + v1.0 tag（tag 时机用户明示）+ log.md 追加验收记录。

## 4. 执行顺序

1. 准备件（space-v11 + v10-live.mts 骨架 + scenarios.md 场景 5 修正）→ 报告征求**提交一**（S10 headers 修复批：gateway.ts/test/architecture 记录，已过 347 绿）。
2. 跑场景 1-2 → 报告 → 跑 3-4 → 报告 → 跑 5（最重）→ 全程证据归档。
3. 汇总验收报告（红绿表 + 修复清单）→ 征求**提交二+**（各修复批 + 本卷删除）→（用户令）tag v1.0。

## 5. 压缩续做锚（若上下文被压缩，从本节回轨）

- 当前进度：S10 opencode 头适配**已完成未提交**（shell/cli/gateway.ts + gateway.test.ts 2 新例 + architecture L241 记录；347/347 typecheck 0）；待办 = 报告征求提交一 → 写 space-v11 与 v10-live.mts。
- 本轮（S10 前）已入库：`2ecf980` 挂起面+类形态、`7c5001e` S9 卷+README 参数表（**s9-plan/cortex-plan 卷已随 2ecf980 删除**）；`3957672` CLI 空间参数修复。
- user0 操作面：pilot（sendMessage/replyAccess/instantiate/setModel）；在线编排参照 `test/feasibility/update2.mts/tree3.mts`（其 require webui 守卫版可借结构，但 v10-live 走 **createStemSystem 直连**不依赖 webui）。
- 模型事实：qwen3.8-flash 长上下文档——config.context.window 先填保守值 256k（cortex dreamAt 独立于 window，clamp≤0.9×window=230k，15000 远低于线不触 clamp）。
- 新规则（contributor §7）：提交前征求同意；message 精炼；plan 卷随实现删除。
