# extension —— 矩阵 extension 层（目录形态资源）

> 仓库级可选扩展的家：与用户空间 `.stem/` 的 custom 层同构，差别只在**启用方式**（点名 vs 目录即真相）与**归属**（仓库发布物 vs 用户空间）。
> 装载顺序与覆盖律：internal → extension → custom，后层同名覆盖（`src/core/main/loader.ts`）。

## 结构（一资源一目录、入口与目录同名）

```
extension/
├── tools/<名>/<名>.ts      工具（默认导出 ToolCapability 或工厂 (projectRoot) => ToolCapability）
├── agent/<名>/<名>.md       AgentClass（与 .stem/agent 同契约）
└── context/<名>/<名>.ts     上下文策略（ContextStrategyModule）
```

- 由 `config.extensions.{tools,agent,context}` 分键点名启用；**未点名 = 不存在于世界**（tools 点名即注册声明：`{"名": 权限词}`）。
- 加载顺序 internal → extension → custom，**后层同名覆盖前层**（registry/template register replace）。
- `_lib/` 下划线前缀目录 = 共享辅助代码，不参与扫描。

## 当前住户

- **tools/**：fs 五件套（`read`/`write`/`edit`/`grep`/`glob`，工厂形态收 projectRoot 做路径沙箱）+ web 两件（`websearch` = 百炼 WebSearch MCP，密钥 `ALIBABA_API_KEY` 走 env；`webfetch` = 零依赖抓取转换，无密钥）+ `_lib/` 共享辅助。
- **agent/**：`creator` 调度者示例类（父子调度 dogfood）。
- **context/**：暂无内置条目（用户策略住 `.stem/context/`）。

## 与 custom 的差别

| | extension | custom（`.stem/`） |
|---|---|---|
| 归属 | 仓库发布物 | 用户空间 |
| 启用 | config 分键点名 | 工具：点名；类/策略：目录即真相 |
| 加载 | `main/loader` 同一管线 | 同一管线 |

> **不设系统级 skill / MCP 子系统**：二者都是 **extension 外部领域工具**——core 只认 `ToolCapability` 契约；机制在 extension，**定义/内容在 stem 空间**，格式对齐常见 harness。
> **skill**：机制 = `extension/tools/skill/`（config 点名）；内容 = stem 空间 **`SKILL.md`**（与 opencode/claude 等通用格式兼容）。
> **MCP**：机制 = `extension/tools/mcp/` **一枚通用客户端**（不按服务器写死包）；定义 = stem 空间 **`.stem/mcp.jsonc`**，规范形态 = 主流 harness 的 **`mcpServers`**（stdio：`command/args/env`；http/sse：`type/url/headers`）；init 按各服务器 `tools/list` 投影内存工具入表，**不为远程工具落 stem 源文件**。
> 工具三层与 init drain 见 `docs/architecture.md` 2.3b / 2.3c / 2.8。
