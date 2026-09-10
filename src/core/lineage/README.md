# lineage —— 族谱树：拓扑 + 能力物化（权限/模型）+ 可见域

> 模块自述：实现细节见本文件；权限书写面与收敛律见 `docs/architecture.md` 与 `src/core/tools/README.md`。

## 职责

- **拓扑**：由实例 `parentId` 实时推导（`getChildren`/`getAncestors`/`getDescendants`/`getRoot`/`isAncestorOf`），纯派生态不入库。
- **能力物化**：注册期 `attach`/`replay` 把类清单 → [策略 raise 清单] → 实例清单逐层折叠，经出生表 caps 封顶，产出每位 agent 的生效访问档案（`AccessLedger` 内部实现）。
- **模型配置相**：四级律物化（显式 > 类基因 > 出生快照 > 父继承 > 家学）。
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

## 依赖

`tools`（access 代数）、`kernel`（领域类型）。kernel 反向持有 LineageTree（聚合）。
