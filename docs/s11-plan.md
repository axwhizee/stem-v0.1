# S11 终案（残工卷）：法则收敛——feishu 会话

> **性质**：plan 卷——执行依据，落地即随批退役（contributor §1.1）。
> **已完成并落地**：工具模型批（出生声明+收敛链+boot 律，`5fc155d`）、身份代数批（路径 id + name + 时戳 + 存储 v3）、cortex 纯接口化批（raise 声明清单 + dreamer 回信 + set_*/暂存退役，见 log2）。实现事实以代码 + `docs/architecture.md` + `docs/log2.md` 为准。
> **本卷只承载**：尚未开工的 d（feishu）批终案设计与依赖的已落地接口事实。
> **实况锚**：architecture.md §五（feishu）节仍"卷在码前"（落地后删窗口声明）。冲突裁决链：本卷裁决记录 → 对拍回写卷并 log2 记账。

## 0. 残工元律

- **零历史兼容**（v1.x 开发期特权）：配置形制不对 = 拒载硬错，重建即正义（feishu.jsonc 扩展形制适用）。
- 机制大于判断：会话目标解析直接吃 `kernel.resolveAgent` 三形态，不造 feishu 私有寻址。

**裁决记录（d 相关，防翻案）**：
1. 秘书中转降级为可选项，会话模型 = **CLI 式显式目标**（对齐"用户主权 + 面板性"——飞书对面就是根）；
2. 断线补偿与上下线提示配套成必需品（离线期间的用户信不丢 = 根的答复义务不因链路中断豁免）；
3. 呈现面统一 `name#id`（身份批已就位），按钮 value 存精确 id（点按零歧义）。

## 1. S11-d：feishu shell——CLI 式显式会话 + 上下线 + 补偿

1. 命令面：`/new <class> [任务]`（实例化并设为当前目标）、`/use <name|id>`（切换；直接吃 B3 三形态解析）、`/exit`（解绑）、`/agents`（选人面板）；每会话当前目标持久化进 `.stem/feishu.jsonc`；
2. **上下线主动提示**：连接就绪时通知 owner"上线"、SIGTERM 优雅发"离线"；
3. **断线消息补偿**：重连后 `im.v1.message.list` 按 chat 增量拉取 + message_id 去重（router 现有 LRU 复用）；
4. 审批卡/命令面适配新寻址（router 正则已随身份批跟齐，本条为回归确认）。

**d 批审计测试**：router 单测覆盖命令面/解析（含 resolveAgent 三形态转发与歧义回报文案）/补偿去重（fake list API 回放含重叠页）。
**d 批门槛**：`npm test` 全绿 + 真机冒烟（飞书单聊：/new → 干活 → /use 切换 → kill -TERM 看离线通知 → 重连看上线通知与补偿信）。

## 2. 接口事实账（a/b/c 已落地——d 照此对拍）

- **收敛链**：`foldConvergenceSteps(parentExplicit, caps, steps)` 单一代数；steps 元素 `[层名, 清单, mode?]`，mode='raise' = 只抬不封（策略声明清单步）；物化端静默钳制、写入端拒绝带层归因。
- **策略契约**：`ContextStrategyModule` 七面（note/role/**tools**/assemble/process/actions/init）；`StrategyApi.spawn(task, spec, opts?)` 内建回信纠错循环（validate/maxCorrections，缺省 ≤2 轮；先登记等待者后发信）。
- **寻址/呈现**：`kernel.resolveAgent(ref)` 三形态（`name#id`→精确 id→唯一前缀→name；歧义抛 `agent_ref_ambiguous` 带候选）、`kernel.displayOf(id)` 全名、`ROOT_ID='0'`/`ROOT_NAME='user'`；feishu router 的审批卡解析正则吃 `<access_request agent="name#id">`。
- **信件戳**：`context/stamp.ts`；打戳唯一在 ContextManager.applyStamps（identityOf 注入端口）。
- **持久**：terminate 自动落墓碑（`status:'terminated'` 活体面不可见）；schema v3 拒载硬错；`InstanceStore.delete` = 宿主法医专属。
- **config**：`.stem/feishu.jsonc` 自治理配置（d 批扩展"每会话当前目标"形制——注意 defaults 模板与 parse 同步 + 未知键处理）；`providers.<p>.key_env` 密钥只走 env。
- **pilot**：`sendMessage/instantiate/setModel/replyAccess` 四口（d 批 `/new` 走 instantiate + 呈现 displayOf）。

## 3. 尾账（随批执行）

- **d 批随行文档**：architecture §五 对拍回写 + **窗口声明终删**（至此全卷实况化）；shell/feishu/README（显式会话模型 + 命令面表）；dev-guide 若涉 feishu 配置节；log2 记账。
- **死代码巡检站（非阻塞穿插）**：extension / shell 两站（kernel/lineage/tools/context 已毕——context 站随 c 批整文件重写顺带清完）。
- **验收**：v10-live 全场景复跑留档 space-v12（c 批已跑 warm/probe/dream，d 批回归 1/3 即可）；场景 4 自进化按前裁决不追新。
- **plan 卷退役**：d 落地后本卷整卷删除随功能批提交（沿革归 log2）。
