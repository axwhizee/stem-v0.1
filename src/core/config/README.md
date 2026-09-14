# config —— 配置载体 + `.stem/agent` 用户文件契约

> 模块自述：实现细节见本文件；架构定位见 `docs/architecture.md`。

## 职责

- **唯一配置文件** `.stem/stem.jsonc`（或 `.json`）的读取/解析/归一化（JSONC，允许注释与尾逗号）。
- **`.stem/agent/<name>.md` 用户文件契约**：类模板解析（读）与序列化（写）同源（`agentFile.ts`）——契约与配置同属「用户主权面」，故在此模块。

## 配置项（顶层键全表）

- **全量有效原则**：非已知顶层键 **boot fail-fast**；`custom` 是唯一合法扩展位。历史键 `model`/`agents`/`strategies` 与数组形态 `tools` 出现即报可行动迁移错误（静默丢弃兼容已废除）。
- `providers`：模型提供商注册表——`base_url`（必填 http(s)）/`key_env`（密钥**环境变量名**，配置文件永不承载明文；缺省 = 匿名端点）/`models`（启用白名单）；一切模型引用的 provider 必须在此注册。
- `user`：根的完整类对象——`description`/`systemPrompt`/`tools`（纯收敛清单）/`contextStrategy`/`model`（**家学锚点，boot 必填硬校验**——全链缺省的本体）/`sendCountdown`/`temperature`/`effort`/`name`（根出生名，缺省 `user`）。
- `autoApprove`、`sendCountdown`：运行策略参数。
- `context`：`window`、`compact{threshold, keepRecentTurns, summarizeModel, instruction, replyTimeoutMs}`。
- `bash`：`path`/`defaultTimeoutMs`/`maxOutputChars`/`cwd`。
- `tools`：`{outputLimit?}`（结果落上下文的字符窗口；0/未设 = 不启用 = 零行为变更）。
- `extensions`：分键对象 `{tools?, agent?, context?}` = `extension/<键>/` 下启用的目录形态条目名；tools 缺省 = fs 五件套，agent/context 缺省 = 不启用（旧数组形态 fail-fast 指路）。
- **目录即真相**（类/策略层）+ **config 即全部配置**；首启模板 = `defaults.ts` 的 `DEFAULT_CONFIG_TEXT`（唯一预设；文件缺失时 `defaultStemConfig` 兼作内存等效——首启装配必有锚）。

## 文件

| 文件 | 内容 |
|---|---|
| `types.ts` | `StemConfig` 及各配置块（providers/user/context/bash/tools/extensions） |
| `parse.ts` | JSONC → StemConfig（全量有效原则：未知顶层键 fail-fast） |
| `defaults.ts` | 首启模板 `DEFAULT_CONFIG_TEXT`（唯一「预设」= 数据；也是内存缺省） |
| `store.ts` | `ConfigStore`/`ConfigPaths` 端口（文件读写由宿主注入） |
| `agentFile.ts` | `parseAgentFile` / `serializeAgentClass` / `agentFileName` / `agentFileOf` |

## `.stem/agent` 文件契约

- 自由式 YAML frontmatter：`description` / `tools`（键即白名单，四态动作）/ `send_countdown` / `context_strategy` / `model` / `temperature` / `effort`；**未知字段拒收**；正文 = systemPrompt。
- 文件名即类名（id/name 均取文件名）。
- **往返律**：`parse(serialize(cls), name) ≡ normalize(cls)`。
- **红线**：系统机制类永不回写；类名字符集守卫（拒路径穿越）。

## 依赖

`gateway`（ModelRef）、`tools`（ToolAccess）、`kernel`（`AgentClass`，**仅 type-only** ——编译擦除，无运行期反向依赖）。
