# 发现 Kiro extension host 进程及其 mux 监听端口
# 输出 JSON: { "pid": <int>, "ports": [ <int>, ... ] }
#
# 判定依据：进程为 kiro.exe，命令行含 node.mojom.NodeService（即扩展宿主），
#           且持有 127.0.0.1 上的监听端口（AgentMuxServer 绑定的即为其中之一）

$ErrorActionPreference = 'Stop'

$result = @{ pid = 0; ports = @(); error = $null }

$kiroProcs = Get-CimInstance Win32_Process -Filter "Name='kiro.exe'" -ErrorAction SilentlyContinue
$extHosts = @()
foreach ($p in $kiroProcs) {
  if ($p.CommandLine -and $p.CommandLine -match 'node\.mojom\.NodeService') {
    $extHosts += $p
  }
}

if ($extHosts.Count -eq 0) {
  $result.error = 'NO_EXTENSION_HOST'
  $result | ConvertTo-Json -Compress
  exit 1
}

$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue

$best = $null
$bestPorts = @()
foreach ($h in $extHosts) {
  $ports = @($listeners |
    Where-Object { $_.OwningProcess -eq $h.ProcessId -and $_.LocalAddress -in @('127.0.0.1', '::1') } |
    Select-Object -ExpandProperty LocalPort -Unique |
    Sort-Object)
  if ($ports.Count -gt 0 -and ($best -eq $null -or $ports.Count -gt $bestPorts.Count)) {
    $best = $h
    $bestPorts = $ports
  }
}

if ($best -eq $null) {
  # 有扩展宿主但没有监听端口：可能是多窗口场景，取第一个候选便于后续逐个试连
  $best = $extHosts[0]
}

$result.pid = [int]$best.ProcessId
$result.ports = @($bestPorts | ForEach-Object { [int]$_ })
$result | ConvertTo-Json -Compress
