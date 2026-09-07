# S11 终案：法则收敛（公理化演进第一轮）

> **性质**：plan 卷——执行依据不回改，落地即随批退役（contributor §1.1）。
> **一句话**：把工具权限收敛为"注册表 + 单操作收敛链"，身份收敛为"路径 id + 全局 name + 带时戳"，cortex 收敛为"纯既有接口组合"，feishu 收敛为"CLI 式显式会话"——全系统零特判、零缺省注入、零历史兼容。
> **实况卷先行**：architecture.md 相关节已同步升级为本案目标形（实现最高参考），卷与卷冲突时以本案裁决链 + architecture 对拍。

## 0. 元律与方法论

**元律**：一切语义由最近的意图持有者**显式表达**；系统永不替实体说话——缺省是债，特例要么升格为律、要么被消灭。

**公理化演进工作流**（本案的立法过程本身，入 architecture 扉页节）：

1. 加法期不设防——特征先当定理长出来，唯一使命是让隐藏例外实例化（没有 S8 的 set_* 双工具与 S10 的权限撞墙，就没有本轮的减法）；
2. 减法由债触发——"需要打补丁 / 需要特判分支 / 同一意图说两遍"是收敛信号；
3. 减法三判据——**等价清单**（§G，被杀机制的行为逐条指名新家，列不出 = 不能杀）、**定律可审判**（§H，每条律配审计测试进 CI）、**不对称账**（删错比加错贵；没有测试的行为 ≠ 不存在的机制——realign 教训）；
4. 终局判据：加法不再需要动旧机制；源码不存在不属于任何定律的分支。

## A. 工具模型：注册表 + 单操作收敛链

### A1 注册 = 出生声明（无"临时表"概念，注册行为生成总工具表（即注册表本身，无新结构））

- **internal**：core 注册点代码携带出生权限（**盘点时缺声明的工具一律补上**）。已定实值：`access_reply: allow`（根答复义务的自然出生）、`bash: allow`（对外操作面）；**其余 internal 通例出生 `ignore`**（agent_* 系、mail_* 系（原 bus_*，§J-3 改名）、context_*、telemetry_query、agent_pause……上台面由各级清单显式化）；
- **extension / custom**：`config.extensions.tools: { "名": "权限词" }`——装载与出生一句话说完；**custom 目录扫描废止**（未点名 = 不存在于世界；`.stem/tools/` 里放什么文件都不如 config 点名有权威——注入面闭合）；extension 装载源（仓库 `extension/tools/`）同理必须点名；
- **策略注册工具**（`registerTool` 窄口保留）：出生恒 `ignore`——注册只是给系统添零件，抬上台面走收敛链；
- **key 可解析性 boot 校验**：config 声明的键必须在装载源命中（internal 注册表 / repo extension / `.stem/tools/` 点名解析），命中不了 = boot 硬错（R12 同律）。

### A2 全链单操作 = 收敛（user0 与所有 agent 一律平等：输入表 + 清单 → 输出表）

```
注册表 ─user0清单─▶ user0 生效表 ─交付─▶ 类清单 ─▶ 策略声明清单* ─▶ 实例化清单 ─▶ 生效表
```

- **清单语义对所有层级同一把尺**：写了表 → 键即白名单（未列键出局）；每键只能沿 `ignore→allow→ask→deny` 显式化链**收紧**，扩张即拒（错误文本带归因）；整表缺席（undefined）= 完整继承接收表；空表 = 表态全关；
- **两步独立**：类收敛与实例化收敛分步套用（不做预合并）——省一份合并逻辑，免费获得失败归因（"类收敛被拒"与"实例收敛被锁"两句话）；
- **策略声明清单**（契约新增唯一字段 `ContextStrategyModule.tools?: Record<string, ToolAccess>`）：宿主类实例化时插在类清单之后执行；祖先已 ask/deny 某键而策略需 allow → **实例化拒绝**（复用收敛检查，零专门判断——"策略与类配置矛盾"由法则自然宣判）；
- **模型可见清单 = allow ∪ ask**；ignore = 背景在场（**不设防**：不假设 agent 对不可见工具产生幻觉调用，系统严守族谱即无事——用户裁决）；
- **grant 双门面保留**（spawn 受限 / `agent_update.grantTools`）：语义不变——清单形整表替换 + 逐键父面封顶，正是"白名单自限 + 收紧"的组合便利形；
- **session 豁免备忘**（always）照旧：ask 环节备忘，非权限层。

### A3 boot 校验律（替代一切代码兜底）

- user0 生效表 `access_reply ≠ allow` → **拒启**（明示死锁理由）；
- config.extensions.tools 键不可解析 → 拒启；
- 未知 config 顶层键 R12 照旧。

### A4 退役物

`DEFAULT_USER_TOOLS`（代码兜底表→其值转入 `defaults.ts` 首启模板的 user0 清单实值——**模板不是机制，只是一份写好的 config**；推荐值叙述移交模块自述文档体系）；`extensions: {tools: [...]}` 数组形；custom 目录扫描；`kind → 权限`的一切推导（kind 降为纯 provenance：装载源/信级/审计展示，架构保留其叙事价值）。

## B. 身份：路径 id + 全局 name + 时间戳（存储 v3，零兼容）

### B1 id = 出生路径，系统全托管

- 根 = `0`（一切 agent 平等：根只是唯一没有"接收父表"的那次收敛）；子 = `<父id>-<出生序号>`：`0-3`、`0-3-2-7`；
- 序号 1 起、**永不回收**（terminate 留空洞；计数含归档墓碑——地址复用 = 历史信件指错实体，绝对禁止）；重启装载扫描全库（含墓碑）立计数器地板；
- **纯推导零查询**：代际 = 段数、父 = 去尾段、祖先链 = 前缀；`前缀 ⇔ isAncestorOf` 做审计断言（Ledger 与字符串互验，但权限裁决权威仍是物化——编码不是旁路）；
- 分隔符裁定：`-`（URL/文件名/shell 参数三安全；`.` 与版本号/类名歧义弃；`/` 与 REST 路径冲突弃）；id 段只含数字，与含 `-` 的类名一眼可辨；
- **`instantiate` 显式 `agentId` 参数退役**（pilot 与模型面同）；`"user0"` 字符串整体退役。

### B2 name = 可变称呼，全局唯一

- 出生：显式指定（**撞全局名 = 拒绝并明示**，绝不自动后缀）或缺省确定性推导 `类名-下一号`（扫描含墓碑，可复现无随机）；
- **user0 的 name 缺省 `"user"`** → 全名 `user#0`（验收空间的"船长"只是 config.user.name 的实值）；
- 可变面：`agent_update.name`（撞名拒）；`displayName` 字段名全局改 `name`；
- 装载期唯一性校验：DB 出现重复 name（文件真相被手改）= boot 硬错；
- role/worker 等机制实例同规（不造第二等公民）。

### B3 解析与呈现

- 呈现面（信件戳 / agent_list / descendants / 审批卡 / 错误 message）统一 **`name#id`**；
- 写面双解析：**`name` 优先**（全局唯一无歧义，模型的舒适区），`name#id` 精确制导；裸 id 兼容（三级：精确 id → 唯一 id 前缀 → name）；

### B4 信件戳升级（时间 + 身份，一次改动）

`<sender id="user#0-3" at="260907.0039">`——分钟精度（秒位烧 token 且模型无秒级推理需求）；打戳器一处改，全断言面连动；读 aloud 保真（feishu 出口不剥——信件忠于原文，裁决已入 log1 时代账）。

### B5 存储

`PRAGMA user_version` → **v3**；**版本不符 = 拒载硬错 + 明示"旧格式，重建"**；零迁移脚本零兼容层；开发空间（space-demo/v10/v11）随批重建。

## C. cortex 适配：策略 = 纯既有接口组合的完成时

1. **`cortex_set_ltm/set_stm` 与全局梦 token 暂存/分流机制整体退役**（等价清单见 §G）；
2. **dreamer**（原 dream worker/cortex-dream，术语全链改名）：spawn 走标准通道（contextRefs 全景重放、清单收敛到无工具或最小），它的正职是**说**——输出 = **回信**（通信 = 消息交换的第一性回归）；策略侧 parse + schema 校验：不合 → `sendMessage` 回信指出错处令其再改（worker 生命周期内循环）；双份齐 → 策略 runDream 收口段执行轮替（旧组 markInvalid / 新组 append / 镜像 / `context.dreamed` 事件——原子性本就住在这里，载体换回信）；
3. **笔记工具**（add/del_note）：出生移策略注册面（ignore），启用 cortex 的类经**策略声明清单**抬 allow——"全树白拿"退役；非 cortex 类不再持有；
4. bash 直改 `.stem/mem/` 笔记文件 = **合法且受保护**（文件层 = 人机共读，dream 目录再生会吸收人工编辑；记忆组 ltm/stm = 仓库行，DB 天然墙；`.memory.json` 是单向镜像——文档写明勿手改投影）；
5. 类文件（cortex-pet 等）手写的策略配套 tools 面随声明清单自动化而精简；水位线/阈值点火/教学样板组装/镜像四机制不动；
6. 契约增量总计：**一个字段**（`strategy.tools`）。

## D. feishu shell：CLI 式显式会话 + 上下线 + 补偿

1. 秘书中转降级为可选项，会话模型改显式：`/new <class> [任务]`（实例化并设为当前目标）、`/use <name|id>`（切换；支持 B3 三形态解析）、`/exit`（解绑）、`/agents`（选人面板）；每会话当前目标持久化进 `feishu.jsonc`；
2. **上下线主动提示**：连接就绪时通知 owner"上线"、SIGTERM 优雅发"离线"；
3. **断线消息补偿**（与 2 配套成必需品）：重连后 `im.v1.message.list` 按 chat 增量拉取 + message_id 去重（router 现有 LRU 复用）；
4. 审批卡/命令面细节适配 B 的新寻址（`name#id` 呈现、按钮 value 仍存精确 id）。

## E. 命名总表（本轮全部改名一览，防漏改）

`bus_send→mail_send`、`bus_participants→mail_participants`（"bus 已死名不灭"清除，邮局叙事归位）；`displayName→name`（实例字段/config/agent_update/呈现全链）；`cortex-dream→cortex-dreamer`、"dream worker"→`dreamer`（文档/事件文案/日志）；`USER_CLASS_ID` 等 id 相关常量随 B1 重定义；`cortex_set_ltm/stm` 注销。

## F. 批次与验证

| 批 | 内容 | 依赖 | 门槛 |
|---|---|---|---|
| S11-a | 工具模型：出生声明盘点补全 / config 形制 / 收敛链重构（含两步归因）/ boot 律 / 可见面过滤 / E 表改名（mail_*）/ 审计测试 a 组 | 无 | typecheck + 全量 + 离线双档 |
| S11-b | id/name/戳/存储 v3（一个原子破坏批：路径 id 生成器、name 唯一注册、戳升级、三空间重建、断言面大连动）/ E 表改名（name/dreamer 文档面）/ 审计测试 b 组 | 与 a 仅现场交叠 | + 在线档抽查（v10-live 复跑改形后） |
| S11-c | cortex：strategy.tools 契约字段 / set_* 退役 / dreamer 回信循环 / 笔记出生迁移 / 类文件精简 / 审计测试 c 组 | a（b 的 id 形态连动）| + cortex probe 在线复跑（重建空间） |
| S11-d | feishu：会话模型 + 上下线 + 补偿 | b（寻址） | router 单测 + 真机 |

每批 commit 按 conventional 分功能面；**批内文档对拍义务**：AGENTS/contributor/dev-guide/README/api 各表所列节随行同步（architecture 已先行升级，实现批做"卷与码对拍回写"——若实现发现卷有误，修卷并 log 记账）。

## G. 等价清单（被杀机制 → 行为新家）

| 被杀 | 承载行为 | 新家 |
|---|---|---|
| DEFAULT_USER_TOOLS 兜底 | user0 出生即管理面齐 | defaults.ts 模板实值 + boot 校验律 |
| custom 目录扫描 | 装载用户代码 | config 点名 + 可解析性校验（更强：注入面闭合） |
| `kind→权限`推导（internal 默认隐藏等） | 可见性语义 | 出生值 + 收敛链（A2）；清单过滤 = allow∪ask |
| `cortex_set_ltm/stm` 暂存区 + 全局梦 token 分流 | 记忆对写入 | dreamer 回信 + 策略 parse（schema 校验住策略侧）|
| 同上 | 双 set 原子轮替 | runDream 收口段（本就在此）|
| 同上 | worker 权限隔离 | spawn 清单收敛（grant 语义未变）|
| 笔记工具根表白拿 | 便捷笔记面 | 策略声明清单（cortex 选定者的权利，A2）|
| `agentId` 显式参数 | 出生命名控制 | `name` 参数（B2；id 归系统全托管）|
| `user0` 字符串 id | 根可寻址 | `0` + name（B1/B2）|

清单穷举不出来的 = 还不能杀——实现中每发现一处"旧行为无新家"，回到本表补条，禁止就地特判。

## H. 审计测试清单（定律的 CI 形态）

1. **kind 不参与权限推断**：三 kind × 四态 × (出生/类/策略/实例) 层位表驱动，断言 effectiveAccess 与 kind 无关；
2. **收敛链失败归因**：类层越权拒 / 策略层被祖先锁拒 / 实例层越权拒 三案分立断言；
3. **boot 律**：缺 access_reply 拒启、不可解析键拒启、R12 回归；
4. **id 纯推导 ⇔ 树一致**：前缀匹配 ⇔ isAncestorOf（含空洞序号/墓碑场景随机生成对拍）；
5. **name 全局唯一**：出生撞名拒、改名撞名拒、装载撞名拒启；
6. **寻址三形态往返**：name / name#id / 唯一 id 前缀 → 同一实例；歧义前缀 → 明示候选；
7. **戳升级**：打戳格式断言（`name#id` + `at`）一处收口；
8. **策略零特权 e2e**：假策略（纯接口实现，非 cortex）走通"注册 ignore 出生→声明清单抬升→被锁拒造"全链；
9. **dreamer 回信循环**：坏 schema 回信 → 错误回信 → 修正回信 → 轮替落定；半途夭折 = 水位不动下拍重触发（旧断言迁移）；
10. **schema v3 拒载**：旧版本 DB = boot 硬错。

## I. 迁移与连动面（诚实账）

- **重建**：space-demo / space-v10 / space-v11（在线验收现场换 space-v12 留档）；
- **代码连动大头**：AccessLedger/InstanceManager/systemTools（全表）/config parse+defaults/logging 事件断言/Runtime 工具面构造/Cortex 全套/feishu router/pilot/Kernel 根注册——预期全量测试 1/3 以上文件有断言级改动（这正是"原子破坏批"集中做的理由）；
- **文档连动**：api.md 全表对拍脚本跑一遍；dev-guide §2/§4/§5/§9 重写；README 权限叙事；contributor §3 命名表/§5 权限纪律整节；shell/feishu/README §2.1；
- **旧断言里的手写乱码 id**（bso2/p0rw 等）随路径 id 全部重写。

## J. 已裁决记录（本案立法账，防翻案）

1. 注册表 + 单操作收敛链（A）——注册管出生、清单管收敛，两机制边界分明互补；
2. 无"首启清单"机制——模板是实值不是机制；internal 出生权限必须逐一在 core 写定（缺失即补）；
3. 寻址裁定 `user#0` 折衷形——root name="user"；
4. `bus_*`→`mail_*`；
5. 路径 id 用 `-` 分隔，无 `user` 前缀，根 `0`；
6. name 全局唯一（邮局面向全体）；写面 name 优先解析；
7. 时间戳分钟精度、与身份戳合并一次改动；
8. **零历史兼容**（v1.0 开发期特权：schema 不对就是错，拒绝加载即正确行为）；
9. 策略注册工具出生 ignore、机制 agent（dreamer 等）实例化收敛抬 allow、"策略与类配置矛盾 = 实例化拒绝"；
10. 不防 ignore 幻觉盲调（法则自洽优先于臆测防御）；
11. bash 可改笔记文件（文件层人机共读），记忆组有 DB 墙；
12. 读 aloud 保留发件人戳（出口美化留给未来的多用户决策）；
13. dream worker 更名 dreamer；
14. architecture.md 先行升级为实现最高参考（本卷落地期间"卷在码前"，实现批完成对拍回写——与常态纪律"码为真"的窗口期契约，特此记录）；
15. **实况卷禁步骤代号**：architecture/AGENTS/dev-guide/api/README 等实况卷正文**不得残留 `S*`/`R*` 步骤代号**（"S7 起""S2′修正"这类是死文字温床——描述机制现在是什么，不描述哪一步加的）；代号只住 plan 卷与日志卷（contributor §7 既有律的贯彻）。architecture 全卷已清（64 处）；
16. **根更名 `user0`→`user`，name 全局唯一**：`USER_ID`/`USER_CLASS_ID`/字符串 `user0` 随 B1 重定义为根 id=`0`、name=`user`（全名 `user#0`）；"user"名唯一（族谱唯一根实例），派生名 `user-N` 归未来的 `user` 类其他实例（若开放）。
