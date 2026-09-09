#!/usr/bin/env bash
# ============================================================
# deploy.sh —— stem 容器一键部署（WSL + 纯 Linux 通用）
#
# 与 deploy.ps1（Windows/Docker Desktop）同参数面，run-docker.py 的 shell 化替身：
#   解析密钥 → 镜像（缺则 build）→ 卷配置安检 → 同名接管 → 启动 → health 轮询。
# 密钥治理：值只注入 docker 子进程环境（-e 只传变量名永不回显）；解析顺序
#   进程 env → （WSL 时）powershell interop 读 Windows 用户级 env → 视为无密钥。
#
# 用法：
#   ./deploy.sh                          # 一键（stem:1.0 / stem-data / 4321 / 容器名 stem）
#   ./deploy.sh --build --force          # 强制重建 + 接管占用者
#   ./deploy.sh --reset-config           # 卷内旧配置安检不过时升级（只删 stem.jsonc，DB 无损）
#   OPENCODE_API_KEY=<key> ./deploy.sh   # 纯 Linux 显式注入
# 详见 docs/deploy.md。
# ============================================================
set -euo pipefail

IMAGE="stem:1.0"; NAME="stem"; VOLUME="stem-data"; PORT=4321
KEY_NAME="OPENCODE_API_KEY"; FORCE=0; REBUILD=0; RESET_CONFIG=0

for arg in "$@"; do
  case "$arg" in
    --build) REBUILD=1 ;;
    --force) FORCE=1 ;;
    --reset-config) RESET_CONFIG=1 ;;
    --image=*) IMAGE="${arg#*=}" ;;
    --name=*) NAME="${arg#*=}" ;;
    --volume=*) VOLUME="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    --key-name=*) KEY_NAME="${arg#*=}" ;;
    --help|-h) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "[deploy] 未知参数 $arg（--help）" >&2; exit 2 ;;
  esac
done

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ✗ $*" >&2; exit 1; }
cd "$(dirname "$0")"

command -v docker >/dev/null || die "docker 不在 PATH（WSL 见 docs/deploy.md 坑 2：daemon/集成未启动）"
docker info >/dev/null 2>&1 || die "docker daemon 失联：docker.sock 不可达——启动 Docker Desktop（勾选 WSL 集成）或 sudo service docker start"

# ---------- 密钥解析（进程 env → WSL interop Windows 用户级 env） ----------
KEY_VALUE="${!KEY_NAME:-}"
if [[ -z "$KEY_VALUE" ]] && command -v powershell.exe >/dev/null 2>&1; then
  KEY_VALUE="$(powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('$KEY_NAME','User')" 2>/dev/null | tr -d '\r\n' || true)"
  [[ -n "$KEY_VALUE" ]] && log "$KEY_NAME 取自 Windows 用户级环境变量（长度 ${#KEY_VALUE}）"
fi
[[ -z "$KEY_VALUE" ]] && log "警告：$KEY_NAME 未解析到——以无密钥形态启动（LLM 调用硬错，其余功能可演示）"

# ---------- 镜像 ----------
if [[ "$REBUILD" == 1 ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "构建镜像 $IMAGE …"
  docker build -t "$IMAGE" .
else
  log "镜像 $IMAGE 已存在（--build 强制重建）"
fi

# ---------- 卷配置安检（只判 user.model 引用的 provider 的 key_env——
#             无关 provider 缺钥匙是合法形态，旧卷配置错位才是真风险） ----------
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  CFG="$(docker run --rm -v "$VOLUME:/data" --entrypoint cat "$IMAGE" /data/.stem/stem.jsonc 2>/dev/null || true)"
  if [[ -n "$CFG" ]]; then
    FLAT="$(printf '%s' "$CFG" | tr -d ' \t\r\n')"
    MODEL="$(printf '%s' "$FLAT" | grep -o '"model":"[^"]*/[^"]*"' | head -1 | cut -d'"' -f4)"
    PROV="${MODEL%%/*}"
    REFKEY=""
    [[ -n "$MODEL" ]] && REFKEY="$(printf '%s' "$FLAT" | grep -o "\"$PROV\":{[^}]*}" | grep -o '"key_env":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
    if [[ -n "$REFKEY" && "$REFKEY" != "$KEY_NAME" && -z "${!REFKEY:-}" ]]; then
      if [[ "$RESET_CONFIG" == 1 ]]; then
        log "--reset-config：删除卷内旧配置（DB/类清单无损），下次启动落默认模板"
        docker run --rm -v "$VOLUME:/data" --entrypoint rm "$IMAGE" -f /data/.stem/stem.jsonc
      else
        die "卷 $VOLUME 的旧配置引用密钥 $REFKEY（$PROV），与本次注入 $KEY_NAME 错位且其值不在环境——--reset-config 升级配置（详见 docs/deploy.md）"
      fi
    fi
  fi
fi

# ---------- 接管 + 启动 ----------
if [[ "$(docker ps -q -f name=^"$NAME"$ || true)" != "" ]]; then
  if [[ "$FORCE" == 1 ]]; then log "停止既有容器 $NAME"; docker stop "$NAME" >/dev/null
  else die "容器 $NAME 运行中——--force 接管"; fi
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --restart unless-stopped -p "$PORT:4321" -v "$VOLUME:/data" \
  --name "$NAME" ${KEY_VALUE:+--env-file /dev/stdin} "$IMAGE" <<<"${KEY_NAME}=${KEY_VALUE}" >/dev/null

# ---------- 健康轮询 ----------
log "等待 /api/health …"
for i in $(seq 1 30); do
  H="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  [[ -n "$H" ]] && { log "OK：$H"; log "访问 http://localhost:$PORT（容器 $NAME / 卷 $VOLUME）"; exit 0; }
  sleep 1
done
docker logs --tail 20 "$NAME" >&2 || true
die "30s 内健康探针未通过——上方为容器日志"
