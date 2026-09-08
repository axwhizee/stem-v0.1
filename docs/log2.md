# 开发日志 · 卷二（2026-09-07 起）

> 历史卷（只追加不回改）。卷一 = `docs/log1.md`（2026-09-07 封卷，此前全部沿革见彼卷）。
> 切分原因：卷一逾 100KB，整卷读取会撑爆 LLM 协作者的上下文预算——日志的读者
> 从"人"变成了"人 + 每轮装配的 agent"，体积纪律与代码同等重要。
> 滚动规则：本卷到达 ~100KB 量级时同样切卷（log3.md 起，指针链在旧卷头）。

### 日志卷滚动切分（log.md → log1.md + log2.md）

沿革卷按"读者上下文预算"切分：卷一冻结封存（内容零改动，仅更名），本卷续账；全部实况卷/纪律卷引用改指（历史沿革指向 → log1；"追加本批记账"规则指向 → log2）。commit 提交纪律不变：改行为 → 本卷追加一条。

### S11-a 工具模型落地（出生声明 + 单操作收敛链 + boot 律）与 kernel 死代码清扫

权限模型换代：`ToolCapability.birth` 必填（注册即出生声明，全仓 30+ 注册点编译期盘点补齐；access_reply/bash 出生 allow，其余 internal 通例 ignore），注册表 `birthTable()/birthOf()` 成为收敛链全局封顶；族谱无判定不再落 kind 推导（**kind 降纯 provenance**），模型可见清单 = allow∪ask。收敛链改为 steps 逐步折叠（`foldConvergenceSteps` 单一代数：物化端静默钳制 / 写入端拒绝式带层归因——类收敛/实例收敛分立），类清单与实例清单**两步独立不预合并**；根缺省清单 DEFAULT_USER_TOOLS 退役（推荐实值迁 defaults.ts 首启模板，harness 缺省跟随），boot 三律上线（根 access_reply ≠ allow 拒启 / config.extensions.tools 点名不可解析拒启 / 家学 model 照旧）。extensions.tools 数组形→{名:权限词}（装载与出生一句话），**custom 目录扫描废止**（未点名=不存在于世界；agent 类/策略目录即真相不变）；bus_send/bus_participants 更名 mail_*。行为翻转：类清单藏匿父面 allow（→ignore）现在**实例化即拒**（旧=物化压回），modelTools/agentUpdate 测试按新律改写。附带 kernel 模块死代码清扫（listAgentsBySpace/finishReason/counter/fold 死参数/双校验助手合并/导出面收窄/MemoryInstanceStore 迁 test/support）。门槛：typecheck 0 + 367/367 + 离线双档 29/9。实况卷对拍零偏差（arch §2.2 窗口声明收窄至身份节待 b）；实施事实与 b/c 交接见 s11-plan §K。

### S11-b 身份代数落地（路径 id + 全局 name + 带时戳信件 + 存储 v3，零兼容）

id = 出生路径全托管：根 `0`、子 `<父id>-<序号>`（纯推导：代际=段数、父=去尾段、祖先=前缀）；序号永不回收——terminate 语义从"物理删行"翻为**落归档墓碑**（status='terminated'，活体面不可见、restore 扫描立计数器地板与名字占用）。name = 全局唯一可变称呼：出生显式（撞名拒、绝不自动后缀）或缺省派生 `类名-N`（含墓碑扫描可复现），运行期 `agent_update.name`（撞名拒），装载期 DB 撞名 = boot 硬错；`displayName` 字段全链改名 `name`，config.user.name 唯一真源（缺省 'user' → 全名 `user#0`，验收空间「船长」回归为实值）。呈现面统一 `name#id`（信件戳/列表/审批卡 `<access_request agent="…">`/参与者/错误文案）；写面三形态解析 `kernel.resolveAgent`（name#id 精确→精确 id→唯一前缀→name，歧义抛候选）；`agent_instantiate` 的 agentId 显式参退役（出生命名改走 name）。信件戳升级 `<sender id="name#id" at="yymmdd.hhmm">`（stamp.ts 纯函数单点收口，ContextManager 打戳经注入 identityOf 端口）。存储 `PRAGMA user_version=3`：任何非零不符版本 = 拒载硬错（v1→v2 迁移段与 project 参数整块删除；明示"删 .stem/stem.db 重建"）；`InstanceStore.delete` 口保留但 terminate 不再走它（宿主法医专属）。审计测试进 CI：B1 前缀⇔isAncestorOf 随机对拍（含空洞）、name 三级撞名拒、寻址往返/歧义、戳格式一处收口、v3 拒载三案。开发空间 demo/v10/v11 重建（旧库删除、v11 称呼回归 name），在线验收现场迁 space-v12（v11 留档）；v10-live 场景 1/3 真网关复跑全过。门槛：typecheck 0 + 386/386 + 离线双档 29/9 + 在线抽查 4+3。api.md 全表重对拍（+16/-5 符号）；architecture 修复卷内两处实现漏网。

