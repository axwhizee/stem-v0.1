# 开发日志 · 卷二（2026-09-07 起）

> 历史卷（只追加不回改）。卷一 = `docs/log1.md`（2026-09-07 封卷，此前全部沿革见彼卷）。
> 切分原因：卷一逾 100KB，整卷读取会撑爆 LLM 协作者的上下文预算——日志的读者
> 从"人"变成了"人 + 每轮装配的 agent"，体积纪律与代码同等重要。
> 滚动规则：本卷到达 ~100KB 量级时同样切卷（log3.md 起，指针链在旧卷头）。

### 日志卷滚动切分（log.md → log1.md + log2.md）

沿革卷按"读者上下文预算"切分：卷一冻结封存（内容零改动，仅更名），本卷续账；全部实况卷/纪律卷引用改指（历史沿革指向 → log1；"追加本批记账"规则指向 → log2）。commit 提交纪律不变：改行为 → 本卷追加一条。

### S11-a 工具模型落地（出生声明 + 单操作收敛链 + boot 律）与 kernel 死代码清扫

权限模型换代：`ToolCapability.birth` 必填（注册即出生声明，全仓 30+ 注册点编译期盘点补齐；access_reply/bash 出生 allow，其余 internal 通例 ignore），注册表 `birthTable()/birthOf()` 成为收敛链全局封顶；族谱无判定不再落 kind 推导（**kind 降纯 provenance**），模型可见清单 = allow∪ask。收敛链改为 steps 逐步折叠（`foldConvergenceSteps` 单一代数：物化端静默钳制 / 写入端拒绝式带层归因——类收敛/实例收敛分立），类清单与实例清单**两步独立不预合并**；根缺省清单 DEFAULT_USER_TOOLS 退役（推荐实值迁 defaults.ts 首启模板，harness 缺省跟随），boot 三律上线（根 access_reply ≠ allow 拒启 / config.extensions.tools 点名不可解析拒启 / 家学 model 照旧）。extensions.tools 数组形→{名:权限词}（装载与出生一句话），**custom 目录扫描废止**（未点名=不存在于世界；agent 类/策略目录即真相不变）；bus_send/bus_participants 更名 mail_*。行为翻转：类清单藏匿父面 allow（→ignore）现在**实例化即拒**（旧=物化压回），modelTools/agentUpdate 测试按新律改写。附带 kernel 模块死代码清扫（listAgentsBySpace/finishReason/counter/fold 死参数/双校验助手合并/导出面收窄/MemoryInstanceStore 迁 test/support）。门槛：typecheck 0 + 367/367 + 离线双档 29/9。实况卷对拍零偏差（arch §2.2 窗口声明收窄至身份节待 b）；实施事实与 b/c 交接见 s11-plan §K。
