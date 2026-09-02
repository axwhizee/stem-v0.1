#!/bin/bash
# 用法: waitidle.sh <agentId> [timeoutSec] —— 先等进 thinking（0.6s 宽限后若有）再等离开
# （防"上轮 holding 瞬间即退"竞态，test-plan §4）
A="$1"; T="${2:-180}"; P=4321
sleep 0.8
# 阶段1：若进入 thinking 则等它离开；若已是 holding/idle 也等它变化或离开
S0=$(curl -s --max-time 5 "http://127.0.0.1:$P/api/agents" | python3 -c "import json,sys;print(next((a['status'] for a in json.load(sys.stdin) if a['id']=='$A'),'?'))")
[ "$S0" = "thinking" ] && sleep 1
END=$((SECONDS+T))
while [ $SECONDS -lt $END ]; do
  S=$(curl -s --max-time 5 "http://127.0.0.1:$P/api/agents" | python3 -c "import json,sys;print(next((a['status'] for a in json.load(sys.stdin) if a['id']=='$A'),'?'))")
  # holding = 等子 agent 回信/等审批 —— 对父轮来说仍算活跃，除非超时
  if [ "$S" = "holding" ] || [ "$S" = "idle" ] || [ "$S" = "interrupted" ] || [ "$S" = "terminated" ]; then echo "final=$S"; exit 0; fi
  if [ "$S" = "?" ]; then echo "final=vanished"; exit 0; fi
  sleep 2
done
echo "TIMEOUT last=$S"; exit 1
