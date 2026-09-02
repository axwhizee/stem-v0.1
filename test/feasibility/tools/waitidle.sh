#!/bin/bash
# 用法: waitidle.sh <agentId> [timeoutSec] [minTurn]
# minTurn 给定时：确定性等待 turnCount>=minTurn 且脱离 thinking（轮末统计走
# recordTurnEnd 显式通道，turn 增长 = 该轮真正闭合）。
# 不给定时：先等进 thinking（0.8s 宽限）再等离开——仅首轮可用。
A="$1"; T="${2:-180}"; MT="${3:-}"; P=4321
get(){ curl -s --max-time 5 "http://127.0.0.1:$P/api/agents" | python3 -c "
import json,sys
a=next((x for x in json.load(sys.stdin) if x['id']=='$A'),None)
print((a['status'] if a else '?'),(a['turnCount'] if a else -1))"; }
END=$((SECONDS+T))
while [ $SECONDS -lt $END ]; do
  read -r S TN <<<"$(get)"
  if [ "$S" = "?" ] || [ "$S" = "terminated" ]; then echo "final=$S"; exit 0; fi
  if [ -n "$MT" ]; then
    if [ "$TN" -ge "$MT" ] 2>/dev/null && [ "$S" != "thinking" ]; then echo "final=$S turn=$TN"; exit 0; fi
  else
    case "$S" in holding|idle|interrupted) echo "final=$S turn=$TN"; exit 0;; esac
  fi
  sleep 2
done
echo "TIMEOUT last=$S turn=$TN"; exit 1
