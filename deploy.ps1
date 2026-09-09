# ============================================================
# deploy.ps1 —— stem 容器一键部署（Windows / Docker Desktop）
#
# 与 deploy.sh（WSL + Linux）同参数面：解析密钥 → 镜像（缺则 build）→
# 卷配置安检 → 同名接管 → 启动 → health 轮询。
# 密钥治理：值只注入 docker 子进程环境；解析顺序 进程 env → Windows
#   用户级 env（自动回落）；全程不回显、不上命令行、不落文件。
#
# 用法（仓库根，PowerShell 5+）：
#   powershell -ExecutionPolicy Bypass -File deploy.ps1
#   .\deploy.ps1 -Build -Force
#   .\deploy.ps1 -ResetConfig              # 卷内旧配置安检不过时升级（只删 stem.jsonc）
#   .\deploy.ps1 -Port 5000 -Volume stem-dev-data -Name stem-dev
# 详见 docs/deploy.md。
# ============================================================
param(
  [switch]$Build,
  [switch]$Force,
  [switch]$ResetConfig,
  [string]$Image = 'stem:1.0',
  [string]$Name = 'stem',
  [string]$Volume = 'stem-data',
  [int]$Port = 4321,
  [string]$KeyName = 'OPENCODE_API_KEY'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Log($msg) { Write-Host "[deploy] $msg" }
function Die($msg) { Write-Host "[deploy] ✗ $msg" -ForegroundColor Red; exit 1 }

# Docker Desktop 的 CLI 常不在纯 PATH（模块 shim 需宿主 env）——where 失败即死心。
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($null -eq $docker) { Die 'docker 不在 PATH——请启动 Docker Desktop 并确认其 CLI 集成已启用' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Die 'docker daemon 失联——启动 Docker Desktop（引擎需 Linux 容器模式）' }

# ---------- 密钥解析（进程 env → Windows 用户级 env） ----------
$KeyValue = if ([Environment]::GetEnvironmentVariable($KeyName)) { [Environment]::GetEnvironmentVariable($KeyName) } else { [Environment]::GetEnvironmentVariable($KeyName, 'User') }
if ($KeyValue) { Log "$KeyName 已解析（长度 $($KeyValue.Length)）" }
else { Log "警告：$KeyName 未解析到——无密钥形态启动（LLM 调用硬错，其余功能可演示）" }

# ---------- 镜像 ----------
docker image inspect $Image *> $null
if ($Build -or $LASTEXITCODE -ne 0) { Log "构建镜像 $Image …"; docker build -t $Image . ; if ($LASTEXITCODE -ne 0) { Die '构建失败' } }
else { Log "镜像 $Image 已存在（-Build 强制重建）" }

# ---------- 卷配置安检（只判 user.model 引用的 provider 的 key_env——
#             无关 provider 缺钥匙是合法形态，旧卷配置错位才是真风险） ----------
$volExists = docker volume inspect $Volume *> $null; $volExists = ($LASTEXITCODE -eq 0)
if ($volExists) {
  $Cfg = docker run --rm -v "${Volume}:/data" --entrypoint cat $Image /data/.stem/stem.jsonc 2>$null | Out-String
  if ($Cfg) {
    $Flat = ($Cfg -replace '[ \t\r\n]', '')
    $Model = [regex]::Match($Flat, '"model":"([^"]*/[^"]*)"').Groups[1].Value
    if ($Model) {
      $Prov = $Model.Split('/')[0]
      $Block = [regex]::Match($Flat, "`"$Prov`":\{[^}]*\}").Value
      $RefKey = [regex]::Match($Block, '"key_env":"([^"]+)"').Groups[1].Value
      if ($RefKey -and $RefKey -ne $KeyName -and -not ([Environment]::GetEnvironmentVariable($RefKey) -or [Environment]::GetEnvironmentVariable($RefKey, 'User'))) {
        if ($ResetConfig) {
          Log '-ResetConfig：删除卷内旧配置（DB/类清单无损），下次启动落默认模板'
          docker run --rm -v "${Volume}:/data" --entrypoint rm $Image -f /data/.stem/stem.jsonc | Out-Null
        } else { Die "卷 $Volume 的旧配置引用密钥 $RefKey（$Prov），与本次注入 $KeyName 错位且其值不可得——-ResetConfig 升级配置（详见 docs/deploy.md）" }
      }
    }
  }
}

# ---------- 接管 + 启动（密钥经临时 env 文件走 stdin，不显式落盘） ----------
$running = docker ps -q -f "name=^$Name$"
if ($running) {
  if ($Force) { Log "停止既有容器 $Name"; docker stop $Name | Out-Null }
  else { Die "容器 $Name 运行中——-Force 接管" }
}
docker rm -f $Name *> $null
$runArgs = @('run', '-d', '--restart', 'unless-stopped', '-p', "${Port}:4321", '-v', "${Volume}:/data", '--name', $Name)
if ($KeyValue) {
  # env-file 经 /dev/stdin 管道注入（值不进命令行/不落盘）。
  $runArgs += @('--env-file', '/dev/stdin')
  "$KeyName=$KeyValue" | docker @runArgs $Image | Out-Null
} else {
  docker @runArgs $Image | Out-Null
}
if ($LASTEXITCODE -ne 0) { Die 'docker run 失败' }

# ---------- 健康轮询 ----------
Log '等待 /api/health …'
for ($i = 1; $i -le 30; $i++) {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    Log "OK：ok=$($h.ok) gateway=$($h.gateway) agents=$($h.agents)"
    Log "访问 http://localhost:$Port（容器 $Name / 卷 $Volume）"
    exit 0
  } catch { Start-Sleep -Seconds 1 }
}
docker logs --tail 20 $Name
Die '30s 内健康探针未通过——上方为容器日志'
