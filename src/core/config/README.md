# config —— 配置载体 + `.stem/agent` 用户文件契约

> 模块自述：实现细节见本文件；架构定位见 `docs/architecture.md`。

## 职责

- **唯一配置文件** `.stem/stem.jsonc`（或 `.json`）的读取/解析/归一化（JSONC，允许注释与尾逗号）。
- **`.stem/agent/<name>.md` 用户文件契约**：类模板解析（读）与序列化（写）同源（`agentFile.ts`）——契约与配置同属「用户主权面」，故在此模块。

## 文件

| 文件 | 内容 |
|---|---|
| `types.ts` | `StemConfig` 及各配置块（providers/user/context/bash/tools/extensions） |
| `parse.ts` | JSONC → StemConfig（全量有效原则：未知顶层键 fail-fast） |
| `defaults.ts` | 首启模板 `DEFAULT_CONFIG_TEXT`（唯一「预设」= 数据；也是内存缺省） |
| `store.ts` | `ConfigStore`/`ConfigPaths` 端口（文件读写由宿主注入） |
| `agentFile.ts` | `parseAgentFile` / `serializeAgentClass` / `agentFileName` / `agentFileOf` |

## 配置纪律

- **全量有效原则（R12）**：非 `KNOWN_KEYS` 顶层键 fail-fast；`custom` 是唯一合法扩展位。已废除键（`model`/`agents`/`strategies`）给可行动迁移错误；`tools` 已升级为配置块 `{ outputLimit? }`（数组 = 历史清单形态，专属迁移错误）。
- providers 注册表：`base_url` + `key_env`（只存变量名，永不落明文密钥）+ `models` 白名单。
- 模型引用一律 `提供商/模型`；config 内部引用在解析期交叉校验 providers。
- 类/策略目录即真相，config **永不回写**（仅文件不存在时写首启模板）。

## `.stem/agent` 文件契约

- 自由式 YAML frontmatter：`description` / `tools`（键即白名单，四态动作）/ `send_countdown` / `max_steps` / `context_strategy` / `model`；未知字段透传 `AgentClass.custom`；正文 = systemPrompt。
- 文件名即类名（id/name 均取文件名）。
- **往返律**：`parse(serialize(cls), name) ≡ normalize(cls)`。
- **红线**：`panel===true` 的机制类永不回写；类名字符集守卫（拒路径穿越）。

## 依赖

`gateway`（ModelRef）、`tools`（ToolAccess）、`kernel`（`AgentClass`，**仅 type-only** ——编译擦除，无运行期反向依赖）。
