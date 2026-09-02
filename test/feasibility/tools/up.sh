#!/bin/bash
# 用法: up.sh [webui|dashboard|both] [space] —— 幂等起/重启常驻服务（双 fork 脱组 + 探活）
# 密钥经 powershell 读 Windows 用户 env（只进子进程，零打印零落盘）。
SVC="${1:-both}"; SPACE="${2:-test/space-v10}"
cd "$(dirname "$0")/../../.." || exit 1
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
NODE="$HOME/.nvm/versions/node/v24.16.0/bin/node"
rdkey(){ timeout 15 powershell.exe -NoProfile -Command "[Environment]::GetEnvironmentVariable('$1','User')" 2>/dev/null | tr -d '\r\n'; }
export OPENCODE_API_KEY="$(rdkey OPENCODE_API_KEY)"
export ALIBABA_API_KEY="$(rdkey ALIBABA_API_KEY)"
export DEEPSEEK_API_KEY="$(rdkey DEEPSEEK_API_KEY)"
mkdir -p "$SPACE/.artifacts"
start(){ # $1=name $2=port
  pkill -f "$1/serve[r].ts" 2>/dev/null; sleep 0.6
  ( setsid "$NODE" --import tsx "shell/$1/server.ts" "$SPACE" >> "$SPACE/.artifacts/$1.log" 2>&1 < /dev/null & ) >/dev/null 2>&1
  for i in $(seq 1 40); do sleep 0.7; curl -s --max-time 2 "http://127.0.0.1:$2/api/health" >/dev/null 2>&1 && { echo "$1 up :$2"; return 0; }; done
  echo "$1 TIMEOUT :$2"; return 1
}
case "$SVC" in
  webui) start webui 4321 ;;
  dashboard) start dashboard 4421 ;;
  both) start webui 4321 && start dashboard 4421 ;;
esac
# SSE 全程记录器（用例 #13 证据件；断线自续）。webui 重启后重跑本脚本即重挂。
if [ "$SVC" = "both" ] || [ "$SVC" = "webui" ]; then
  pkill -f "sse-recor[d]" 2>/dev/null
  ( setsid bash -c 'exec -a sse-recorder curl -sN --max-time 3500 http://127.0.0.1:4321/api/events >> '"$PWD/$SPACE"'/.artifacts/sse-events.log 2>/dev/null & while pgrep -x sse-recorder >/dev/null; do sleep 5; done' >/dev/null 2>&1 </dev/null & ) >/dev/null 2>&1
  echo "sse recorder armed"
fi
