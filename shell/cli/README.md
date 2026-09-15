# shell/cli —— 参考 shell（平台装配 + SQLite + CLI）

> 宿主层参考实现：把 `core` 的平台能力接口落成 node 实现，供任何 shell 复用。
> 定位见 `docs/architecture.md`「stem 空间与 SQLite」。

## 职责

- **平台装配 `platform.ts`（`bootStem`）**：config 读 → 构建网关（providers 路由）→ `createStemSystem`（注入 stateStore / classFs / extensionRoots / shellRunner / onEvent）→ 返回可运行系统。任何 shell（webui/dashboard/feishu）复用此装配，只替换 UI 与事件消费。
- **网关路由 `gateway.ts`**：见下「厂商适配收容所」。
- **持久化 `storage/`**：`createSqliteStateStore`（`node:sqlite` `DatabaseSync` 实现 `MessageStore`/`InstanceStore` 两端口）；行 = 记录全量 JSON + `agent_id`/`seq` 冗余列；`PRAGMA user_version` 守卫（**当前 v4**：身份模型换代零兼容，版本不符 = boot 拒载硬错，无迁移脚本）；rollback journal（9P/WAL-shm 安全）；默认 `<projectRoot>/.stem/stem.db`（`STEM_DB_PATH` 覆盖，`stateStore:false` 显式纯内存）。**空间语义**：`.stem` = 世界——一进程 = 一空间 = 一 projectRoot = 一 `.stem` = 一 `stem.db`；定位 opencode-style（`stem [path]` > `STEM_PROJECT_ROOT` > cwd），无注册表无切换器。
- **配置端口 `config/`**：node fs 实现 `ConfigStore`/`ConfigPaths`。
- **bash 端口 `bash.ts`**：`ShellRunner` 的 `child_process` 实现（core 只定义端口，执行住这里）。
- **CLI 命令 `main.ts`**：直接对话 + `/new` `/use` `/agents` `/templates` `/tools` `/config` `/compact` `/stop`。
- **测试支撑 `mockSse.ts` / `ui/`**：mock 网关 SSE（零密钥冒烟）+ 交互对话框。

## 厂商适配收容所（`gateway.ts`）

- **providers 路由门面**：逐 provider 装配 + 按 `req.model.provider` 分发；两段式 = `key_env` 未命中启动 warn 点名（不印值）+ 用到才硬错（产品无 mock 回落）。
- `providerFetch` 经 openaiCompatible 的 fetch 端口注入请求头——全体 provider 补 `User-Agent: stem/<version>`；baseUrl 命中 `*.opencode.ai` 再补 `x-opencode-session` = **每进程一个随机 uuid**（opencode 运营要求「每会话稳定 id」：进程/容器即会话，进程间随机、零持久化、不编码 agent/空间身份；刻意拒绝全局硬编码值——镜像分发会共享一个 session 被限流连坐）。
- **core 对一切厂商头零感知**，此类适配只准住本文件。

## 文件

| 文件 | 内容 |
|---|---|
| `platform.ts` | `bootStem`：平台装配（任何 shell 复用） |
| `gateway.ts` | providers 路由 + 厂商头适配 |
| `bash.ts` | `ShellRunner`（node child_process） |
| `config/` | node fs `ConfigStore`/`ConfigPaths` |
| `storage/` | `createSqliteStateStore`（node:sqlite） |
| `main.ts` | CLI 入口与命令 |
| `mockSse.ts` | mock 网关 SSE（测试/冒烟） |
| `ui/dialog.ts` | 交互对话框 |

## 依赖

`src/core/main`（组合根）、`src/core/*` 模块接口、`tsx`/`jsonc-parser`/`yaml` 运行时；**平台能力只在此层落地**，core 零平台依赖不破。
