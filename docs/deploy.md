# stem 部署指南（容器发布形态）

> 发布镜像 = **WebUIShell 服务形态**（`shell/webui/server.ts`）。安全模型：**容器即边界**——
> 挂载的 `/data` volume 就是 bash 工具的爆炸半径；非 root（`node` 用户）运行；密钥只经
> 环境变量注入，绝不写入镜像与配置。机制细节见 `shell/*/README.md` 与 `docs/architecture.md`；本文为操作面。

## 前置

- Docker ≥ 24（`docker build` 支持 BuildKit；Windows 走 Docker Desktop，WSL 走其 WSL 集成或原生 dockerd）。
- Node ≥ 23.4 **不需要**（构建产物直跑于镜像内 node:24；本机只做 docker 操作）。
- 真实网关：`config providers.<p>.key_env` 声明的变量名（默认模板 = `OPENCODE_API_KEY`）注入密钥。
  无密钥启动是合法形态（系统照常起、LLM 调用硬错——冒烟/演示可用）。

## 一键脚本（推荐入口）

| 平台 | 脚本 | 密钥来源 |
|---|---|---|
| Windows（Docker Desktop） | `powershell -File deploy.ps1` | 进程 env → Windows **用户级 env**（自动回落） |
| WSL | `./deploy.sh` | 进程 env → **powershell interop 读 Windows 用户级 env**（自动回落） |
| 纯 Linux（服务器/局域网主机） | `./deploy.sh` | 进程 env（`OPENCODE_API_KEY=<k> ./deploy.sh` 或 systemd/secret 管理） |

两脚本同参数面（幂等，可反复执行）：

```text
--build            强制重建镜像（缺省 = 缺才建）
--force            接管占用同名卷/端口的其它容器
--reset-config     卷内旧 stem.jsonc 安检不过时，删除它（DB 与 .stem/agent 无损；下次启动落默认模板）
--port <n>         宿主端口（默认 4321）
--name <s>         容器名（默认 stem）
--volume <s>       数据卷（默认 stem-data）
--image <s>        镜像（默认 stem:1.0）
--key-name <s>     密钥变量名（默认 OPENCODE_API_KEY）
```

流程：解析密钥 → 镜像（缺则 build）→ **卷配置安检**（卷里已有 stem.jsonc 但其中 key_env
声明的变量本次没注入 → 拒启并指路 `--reset-config`）→ 同名容器替换 → `-e <变量名>` 注入
（值只进子进程环境，不上命令行不落文件）→ 轮询 `/api/health` → 打印访问地址。

## 手工流程（等价）

```bash
docker build -t stem:1.0 .
docker run -d -p 4321:4321 -v stem-data:/data \
  -e OPENCODE_API_KEY="$OPENCODE_API_KEY" --name stem stem:1.0
# 浏览器 http://localhost:4321；探针 GET /api/health（含网关接通状态）
```

## 远程主机部署（局域网/服务器通用，无 git 远端时）

在 WSL/开发机执行（密钥经管道注入，零落盘零命令行）：

```bash
tar cz Dockerfile .dockerignore package.json package-lock.json src shell extension \
  | ssh <user>@<host> "mkdir -p ~/workspace/stem && tar xz -C ~/workspace/stem"
ssh <user>@<host> "cd ~/workspace/stem && docker build -t stem:1.0 ."
powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('OPENCODE_API_KEY','User')" \
  | tr -d '\r\n' | sed 's/^/OPENCODE_API_KEY=/' \
  | ssh <user>@<host> "docker rm -f stem >/dev/null 2>&1; docker run -d -p 4321:4321 -v stem-data:/data --name stem --env-file /dev/stdin stem:1.0"
```

之后与本机同一访问面（`http://<host>:4321`）。

## 已踩坑实录（2026-09 局域网主机现场）

1. **`FROM node:24-slim` 拉层在境内镜像源卡死**：单层 1.05MB/28.23MB 停滞 600s+（三条
   mirror 均无法救该层）。规避已入 Dockerfile：**钉 `node:24-bookworm-slim`**（当前 24-slim
   即 bookworm，钉 codename 更可复现；目标机本地已有该 base 时构建仅 20s）。若你干净环境
   复现缓慢：`docker pull node:24-bookworm-slim` 预热或换镜像源。
2. **WSL docker daemon 失联**（`docker.sock: No such file or directory`，client 正常）：
   Docker Desktop 未运行/WSL 集成关闭，或原生 dockerd 未随 WSL 启。短期用远程主机绕过；
   本地修复 = 启动 Docker Desktop 并在 Settings→Resources→WSL integration 勾选当前发行版，
   或 WSL 内 `sudo service docker start`。
3. **两个 build 并发打架**：交互超时掐掉 ssh 客户端 **不等于**杀死远端 docker build——重连
   先 `pgrep -fa 'docker build'` 盘点再动手，避免双构建抢同一层拉取。
4. **健康判读**：`docker inspect stem --format '{{.State.Health.Status}}'` 应为 `healthy`
   （HEALTHCHECK 打 `/api/health`，30s 间隔 / 15s 起步宽限）。启动日志里 provider「未接通」
   warn 是**预期降级提示**，非故障。

## 验收清单（部署后）

- `curl http://<host>:4321/api/health` → `ok:true` + 网关来源（`providers: <p>` = 已接通）；
- 首启自举：卷内出现 `.stem/stem.jsonc`（默认模板）+ `.stem/stem.db`（个体层）+ `.stem/mem/`；
- WebUI 冒烟：实例化一个后代 → 流式正文/思维链折叠直播 → 工具 chip（无参数摘要，详情走
  telemetry 面）→ 底部占用条随对话增长变色；
- 数据持久：`docker rm` 重建容器指同一 volume → 族谱/语料原样恢复（类/策略文件真相亦在卷内）。
