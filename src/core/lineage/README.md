# lineage —— 族谱树：拓扑 + 能力物化（权限/模型）+ 可见域

> 模块自述：实现细节见本文件；权限书写面与收敛律见 `docs/architecture.md` 与 `src/core/tools/README.md`。

## 职责

- **拓扑**：由 id 路径纯推导（`parentIdOf`：`1.3`→`1`；`3`→`0`；`0`→null）。`getChildren` 扫活体实例 `parentIdOf(child)===parent`；`getAncestors` 逐段去尾；`isAncestorOf` = 前缀律（根是全树祖先）。**父不落库**。
- **能力物化**：注册期 `attach`/`replay` 把类清单 → [策略 raise 清单] → 实例清单逐层折叠，经出生表 caps 封顶，产出每位 agent 的生效访问档案（`AccessLedger` 内部实现）。
- **模型配置相**：出生解析落地（显式 > 类基因 > 父继承 > 家学）→ `modelBinding` 随实例行持久；改父不级联；无运行期全树 replay。
- **可见域唯一谓词**：`canReach(viewer, target)` ⟺ 自身 ∨ viewer 是 target 的祖先。一切跨 agent 操作面（销毁/中断/上下文/telemetry/审批）统一走它。

## 文件

| 文件 | 内容 |
|---|---|
| `LineageTree.ts` | 门面：拓扑 + 能力查询 + canReach（`NodeConfig = { access, model? }`） |
| `AccessLedger.ts` | 权限台账（收敛链折叠 + fallback 本地封闭 + always 豁免不在台账） |

## 关键语义

- `profileOf` 返回 `{ explicit, fallback? }`：`fallback='deny'` = 本地封闭（自身定义了清单）。
- `effectiveAccess(key) = explicit[key] ?? fallback ?? undefined`；undefined → 调用方落出生值。
- **禁止直连 AccessLedger**：kernel/tools 一律经 LineageTree 门面。
- **红线**：权限/模型档案可启动按拓扑序重放重建；**实例全属性与运行时（status/turnCount/tokens/ctxTokens）住实例行**，不在此层；零类层依赖（own/类基因由 kernel 算好传入）。

## 依赖

`tools`（access 代数）、`kernel`（领域类型与 `parentIdOf`）。kernel 反向持有 LineageTree（聚合）。
