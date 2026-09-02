#!/usr/bin/env python3
# ============================================================
# run-docker.py —— stem 容器一键启动（S6 形态）
#
# 职责（幂等，可反复执行）：
#   1. 解析密钥：优先当前进程环境（WSL export），缺失则回落读取
#      **Windows 用户级环境变量**（powershell.exe，WSL interop）——
#      密钥值只注入 docker 子进程环境（-e 只传变量名），永不打印、
#      不上命令行、不落任何文件（对齐 config key_env 治理）。
#   2. 镜像：缺则自动 docker build（--build 强制重建）。
#   3. 接管：同名容器直接替换；其它容器占用同一卷/端口时需 --force。
#   4. 卷配置安检：卷里已有 stem.jsonc 但不引用 OPENCODE_API_KEY →
#      拒启并指路 --reset-config（仅删配置文件，DB 与 .stem/agent 类
#      清单无损；下次启动 runInit 自动落 S6 默认模板 opencode-go）。
#   5. 启动后轮询 /api/health，打印网关来源与访问地址。
#
# 双平台：Windows（python run-docker.py，需 Docker Desktop）与 WSL
#（python3 run-docker.py）皆可——同用 Docker Desktop 的 daemon 与命名卷。
#
# 用法（Windows 把 python3 换成 python）：
#   python3 run-docker.py                  # 一键（默认 stem:1.0 / stem-data / 4321）
#   python3 run-docker.py --force          # 顺带接管他容占用
#   python3 run-docker.py --force --reset-config   # 老卷配置升级为默认模板
#   python3 run-docker.py --port 5000 --name stem-dev --volume stem-dev-data
# ============================================================

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

# Windows 双保险：控制台走 UTF-8（PEP 528 覆盖交互式，重定向到管道/文件时
# 默认码表是 cp936，中文日志会炸 UnicodeEncodeError）；失败仅旧版本 Python。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

KEY_NAME = "OPENCODE_API_KEY"
CONTAINER_PORT = 4321  # 镜像内固定监听（PORT env 默认值）
# Windows 上 docker 常是 Docker Desktop 的 PowerShell 模块/带上下文 env 的 shim，
# 纯 PATH 查找可能缺 DOCKER_* 变量而报错 → 一律注入宿主完整环境。
DOCKER_ENV = dict(os.environ)


def log(msg: str) -> None:
    print(f"[run-docker] {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"[run-docker] ✗ {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def sh(args: list[str], check: bool = True, env: dict | None = None) -> subprocess.CompletedProcess:
    """跑外部命令；失败即 die（stderr 透传）。"""
    r = subprocess.run(args, capture_output=True, text=True, env=env,
                       encoding="utf-8", errors="replace")  # docker 日志含中文，防 cp936 解码炸
    if check and r.returncode != 0:
        die(f"命令失败: {' '.join(args)}\n{(r.stderr or r.stdout).strip()}")
    return r


# ---------- 密钥解析（WSL env → Windows 用户级 env） ----------

def resolve_key() -> str:
    value = (os.environ.get(KEY_NAME) or "").strip()
    if value:
        log(f"{KEY_NAME} 取自当前环境（长度 {len(value)}）")
        return value
    ps = shutil.which("powershell.exe") or shutil.which("powershell")
    if ps:
        try:
            r = subprocess.run(
                [ps, "-NoProfile", "-Command",
                 f"[Environment]::GetEnvironmentVariable('{KEY_NAME}','User')"],
                capture_output=True, text=True, timeout=20,
                encoding="utf-8", errors="replace",
            )
            value = (r.stdout or "").strip()
            if value:
                log(f"{KEY_NAME} 取自 Windows 用户环境变量（长度 {len(value)}）")
                return value
        except Exception:
            pass  # interop 不可用/超时 → 走下方统一报错
    die(
        f"未找到 {KEY_NAME}。三选一：\n"
        f"  1) Windows 设置里配置用户环境变量 {KEY_NAME}（本脚本会自动读取）\n"
        f"  2) WSL 中 export {KEY_NAME}=<key> 后重跑\n"
        f"  3) PowerShell: setx {KEY_NAME} <key>（新开 shell 生效）"
    )
    return ""  # unreachable


# ---------- 镜像 / 卷 / 容器状态 ----------

def image_exists(image: str) -> bool:
    r = sh(["docker", "images", "-q", image], check=False, env=DOCKER_ENV)
    return bool(r.stdout.strip())


def volume_exists(vol: str) -> bool:
    # 注意：volume 名不带 "/" 前缀，`--filter name=^/x$` 永不命中——直接 inspect 探。
    return sh(["docker", "volume", "inspect", vol], check=False, env=DOCKER_ENV).returncode == 0


def containers_state() -> list[dict]:
    r = sh(["docker", "ps", "-a", "--format", "{{json .}}"], env=DOCKER_ENV)
    out = []
    for line in r.stdout.splitlines():
        if line.strip():
            out.append(json.loads(line))
    return out


def take_over(name: str, vol: str, port: int, force: bool) -> None:
    """同名容器无条件替换；异名但占同一卷/同一端口的容器需 --force。"""
    for c in containers_state():
        cname = c.get("Names", "")
        ports = c.get("Ports", "") or ""
        busy_by_port = f"0.0.0.0:{port}->" in ports or f"*:{port}->" in ports
        mounts_vol = False
        if busy_by_port or cname != name:
            insp = sh(["docker", "inspect", "--format",
                       "{{range .Mounts}}{{.Name}} {{end}}", cname], check=False, env=DOCKER_ENV)
            mounts_vol = vol in (insp.stdout or "").split()
        if cname == name:
            log(f"移除旧同名容器 {cname}（{c.get('Status','')}）")
            sh(["docker", "rm", "-f", cname], check=False, env=DOCKER_ENV)
        elif mounts_vol or busy_by_port:
            if not force:
                die(
                    f"异名容器 {cname} 占用卷 {vol}{'/端口 ' + str(port) if busy_by_port else ''}"
                    f"（{c.get('Status','')}）。确认接管请加 --force（会 docker rm -f {cname}）"
                )
            log(f"--force 接管：移除 {cname}")
            sh(["docker", "rm", "-f", cname], check=False, env=DOCKER_ENV)


def inspect_volume_config(vol: str, image: str) -> str | None:
    """读卷内 stem.jsonc 原文（首次启动卷为空 → None）。借目标镜像执行（免拉第二镜像）。"""
    r = sh(["docker", "run", "--rm", "-v", f"{vol}:/data", image,
            "cat", "/data/.stem/stem.jsonc"], check=False, env=DOCKER_ENV)
    return r.stdout if r.returncode == 0 and r.stdout.strip() else None


def reset_volume_config(vol: str, image: str) -> None:
    r = sh(["docker", "run", "--rm", "-v", f"{vol}:/data", image,
            "rm", "-f", "/data/.stem/stem.jsonc"], check=False, env=DOCKER_ENV)
    if r.returncode == 0:
        log("已删除卷内 stem.jsonc（DB 与类清单无损），启动时将自举 S6 默认模板（opencode-go）")
    else:
        log("卷内无 stem.jsonc（首启自举模板即可）")


# ---------- 启动与健康 ----------

def wait_healthy(port: int, name: str, timeout_s: int = 45) -> dict:
    deadline = time.time() + timeout_s
    last_err = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=3) as res:
                return json.loads(res.read().decode())
        except Exception as e:
            last_err = str(e)
            time.sleep(1.5)
    log(f"docker logs {name} 尾部：")
    print(sh(["docker", "logs", "--tail", "20", name], check=False, env=DOCKER_ENV).stdout)
    die(f"健康检查超时（{last_err}）")
    return {}


def main() -> None:
    ap = argparse.ArgumentParser(description="stem 容器一键启动（注入主机 OPENCODE_API_KEY）")
    ap.add_argument("--name", default="stem", help="容器名（默认 stem）")
    ap.add_argument("--image", default="stem:1.0", help="镜像（默认 stem:1.0，缺则自动构建）")
    ap.add_argument("--volume", default="stem-data", help="数据卷（默认 stem-data → /data）")
    ap.add_argument("--port", type=int, default=4321, help="宿主端口（默认 4321）")
    ap.add_argument("--build", action="store_true", help="强制重建镜像")
    ap.add_argument("--force", action="store_true", help="接管移除占用同卷/同端口的异名容器")
    ap.add_argument("--reset-config", action="store_true",
                    help="卷配置与 OPENCODE key 不匹配时删除卷内 stem.jsonc 让其重自举（DB/类清单无损）")
    args = ap.parse_args()

    if not shutil.which("docker"):
        die("未找到 docker CLI（WSL 里请先启动 Docker Desktop 并开启 WSL 集成）")

    key = resolve_key()

    if args.build or not image_exists(args.image):
        log(f"构建镜像 {args.image} …（npm 层有缓存，通常很快）")
        root = os.path.dirname(os.path.abspath(__file__))
        sh(["docker", "build", "-t", args.image, root], env=DOCKER_ENV)

    first_boot = not volume_exists(args.volume)

    # 配置安检先行（避免删完旧容器后因配置问题拒启，留服务空窗）
    if not first_boot:
        text = inspect_volume_config(args.volume, args.image)
        if text is not None and KEY_NAME not in text:
            if args.reset_config:
                reset_volume_config(args.volume, args.image)
            else:
                die(
                    f"卷 {args.volume} 内的 stem.jsonc 不引用 {KEY_NAME}"
                    "（providers 用的是别家 key_env），容器虽能启动但对话必然硬错。\n"
                    "  二选一：1) 重跑加 --reset-config（删除卷配置令其重自举 opencode-go 模板，DB/类清单无损）"
                    "  2) 手工编辑卷内 .stem/stem.jsonc"
                )

    take_over(args.name, args.volume, args.port, args.force)

    log("启动容器…")
    env = {**DOCKER_ENV, KEY_NAME: key}  # 值只进子进程环境；命令行仅变量名，防 ps 泄漏
    sh(["docker", "run", "-d", "--pull", "never", "--name", args.name,
        "-p", f"{args.port}:{CONTAINER_PORT}",
        "-v", f"{args.volume}:/data",
        "-e", KEY_NAME,  # 只传变量名 = 从上面 env 取值的透传形态
        args.image], env=env)  # env 已含 DOCKER_ENV 基底（见下）

    health = wait_healthy(args.port, args.name)
    log(f"docker logs 头部：")
    print(sh(["docker", "logs", "--tail", "6", args.name], check=False, env=DOCKER_ENV).stdout)
    log(f"✔ 已就绪  gateway={health.get('gateway')}  agents={health.get('agents')}  "
        f"{'（首启，模板已自举）' if first_boot else ''}")
    log(f"→ 浏览器打开 http://localhost:{args.port}")


if __name__ == "__main__":
    main()
