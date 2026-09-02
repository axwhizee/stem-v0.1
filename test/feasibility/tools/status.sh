#!/bin/bash
# 全空间状态一行表：id classRef status turn model(origin)
curl -s --max-time 5 http://127.0.0.1:4321/api/agents | python3 -c "
import json,sys
for a in json.load(sys.stdin):
    print(f\"{a['id']:<12} {a.get('classRef','?'):<12} {a.get('status','?'):<12} turn={a.get('turnCount',0)} {a.get('displayName','')}\")"
