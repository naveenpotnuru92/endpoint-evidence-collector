# ============================================================================
# Endpoint Evidence Collector - Windows collector (PowerShell 5.1+)
# Static, reviewed template. collection-plan.json is parsed as DATA (ConvertFrom-Json);
# no plan value is ever passed to Invoke-Expression, dot-sourced, or concatenated into
# a command string. Native tools are called with argument arrays from fixed allowlists.
#
# Invoke explicitly (do NOT use execution-policy bypass):
#   powershell.exe -NoProfile -NonInteractive -File collector.ps1 -Run
# Exit codes: 0 complete | 10 partial | 20 preflight failure | 30 interrupted/timeout | 40 packaging failure
#
# STATUS: implemented but UNVERIFIED on target Windows builds (see docs/support-matrix.md).
# ============================================================================
[CmdletBinding()]
param(
  [switch]$Run,
  [switch]$PreflightOnly,
  [string]$Cleanup = '',
  [switch]$Yes
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$EXIT = @{ Complete = 0; Partial = 10; Preflight = 20; Interrupted = 30; Packaging = 40 }
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------- helpers ----------
function Now-Utc { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
function Say([string]$m) { [Console]::Error.WriteLine($m) }

function Safe-Name([string]$n) {
  $s = [regex]::Replace($n, '[^A-Za-z0-9._-]', '_')
  if ($s -eq '' -or $s -eq '.' -or $s -eq '..') { $s = '_' + $s }
  if ($s.Length -gt 100) { $s = $s.Substring(0, 100) }
  return $s
}

# ---------- cleanup (only validated collector-owned run directories) ----------
if ($Cleanup -ne '') {
  if (-not $Yes) { Say 'refusing: -Yes is required'; exit 2 }
  if (-not (Test-Path -LiteralPath $Cleanup -PathType Container)) { Say 'not a directory'; exit 2 }
  $item = Get-Item -LiteralPath $Cleanup -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Say 'refusing: run directory is a reparse point'; exit 2 }
  if ($item.Name -notmatch '^run-\d{8}T\d{6}Z-[0-9a-f]{8}$') { Say 'refusing: name does not look like a collector run directory'; exit 2 }
  $marker = Join-Path $item.FullName '.eec-run-owner'
  if (-not (Test-Path -LiteralPath $marker) -or ((Get-Content -LiteralPath $marker -Raw).Trim() -ne $item.Name)) { Say 'refusing: ownership marker missing or mismatched'; exit 2 }
  Remove-Item -LiteralPath $item.FullName -Recurse -Force
  Say "removed $($item.FullName) (ordinary deletion; NOT secure erasure)"
  exit 0
}
if (-not $Run -and -not $PreflightOnly) {
  Say 'Usage: collector.ps1 -Run | -PreflightOnly | -Cleanup <run-dir> -Yes'; exit 2
}

# ---------- load plan as data ----------
$PlanPath = Join-Path $Here 'collection-plan.json'
$PkgManifestPath = Join-Path $Here 'package-manifest.json'
try { $Plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json } catch { Say 'PREFLIGHT FAILED: plan unreadable'; exit $EXIT.Preflight }

$PreFail = New-Object System.Collections.Generic.List[string]
if ($Plan.targetOs -ne 'windows') { $PreFail.Add("plan targets $($Plan.targetOs), not windows") }
$PlanSha = (Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash.ToLower()
if (Test-Path -LiteralPath $PkgManifestPath) {
  $pm = Get-Content -LiteralPath $PkgManifestPath -Raw | ConvertFrom-Json
  $expected = ($pm.files | Where-Object { $_.name -eq 'collection-plan.json' }).sha256
  if ($expected -ne $PlanSha) { $PreFail.Add('collection-plan.json digest does not match package-manifest.json (package altered?)') }
} else { $PreFail.Add('package-manifest.json missing') }

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Elevated = (New-Object Security.Principal.WindowsPrincipal($Identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$OsCaption = ''; try { $OsCaption = (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + (Get-CimInstance Win32_OperatingSystem).Version } catch { }

$OutRoot = [string]$Plan.outputRoot
if ($OutRoot -notmatch '^[A-Za-z]:\\') { $PreFail.Add('output root must be an absolute local drive path') }
if ($PreFail.Count -eq 0) {
  try {
    if (-not (Test-Path -LiteralPath $OutRoot)) { New-Item -ItemType Directory -Path $OutRoot -Force | Out-Null }
    $rootItem = Get-Item -LiteralPath $OutRoot -Force
    if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { $PreFail.Add('output root is a junction/symlink') }
    $drive = New-Object IO.DriveInfo($OutRoot.Substring(0, 1))
    if ($drive.AvailableFreeSpace -lt [int64]$Plan.sizeLimits.freeSpaceReserveBytes) { $PreFail.Add('free space below configured reserve') }
  } catch { $PreFail.Add("output root unusable: $($_.Exception.Message)") }
}
if ($PreFail.Count -gt 0) { Say 'PREFLIGHT FAILED:'; $PreFail | ForEach-Object { Say "  - $_" }; exit $EXIT.Preflight }
Say "Preflight OK: os=$OsCaption identity=$($Identity.Name) elevated=$Elevated output_root=$OutRoot"
if ($PreflightOnly) { exit $EXIT.Complete }

# ---------- run directory with restrictive ACL (fails safely if it cannot be constrained) ----------
$StartedUtc = Now-Utc
$RunId = 'run-{0}-{1}' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$RunDir = Join-Path $OutRoot $RunId
if (Test-Path -LiteralPath $RunDir) { Say 'run directory already exists'; exit $EXIT.Preflight }
New-Item -ItemType Directory -Path $RunDir | Out-Null
try {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)   # disable inheritance, drop inherited rules
  foreach ($sid in @($Identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {   # current user, SYSTEM, Administrators
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $RunDir -AclObject $acl
} catch { Say "PREFLIGHT FAILED: cannot restrict run directory permissions: $($_.Exception.Message)"; Remove-Item -LiteralPath $RunDir -Recurse -Force -ErrorAction SilentlyContinue; exit $EXIT.Preflight }
$RunDir = (Resolve-Path -LiteralPath $RunDir).Path
$Stage = Join-Path $RunDir '.staging'; New-Item -ItemType Directory -Path $Stage | Out-Null
Set-Content -LiteralPath (Join-Path $RunDir '.eec-run-owner') -Value $RunId -NoNewline -Encoding ASCII
$Receipt = [ordered]@{ runId = $RunId; runDirectory = $RunDir; statusPath = (Join-Path $RunDir 'status.json') } | ConvertTo-Json -Compress
Set-Content -LiteralPath (Join-Path $RunDir 'launch-receipt.json') -Value $Receipt -Encoding UTF8
Set-Content -LiteralPath (Join-Path $OutRoot ("latest-{0}.json" -f $Plan.planId)) -Value $Receipt -Encoding UTF8
Say "RUN_ID=$RunId"; Say "RUN_DIR=$RunDir"; Say "STATUS=$(Join-Path $RunDir 'status.json')"

# ---------- state ----------
$Script:State = 'preflight'; $Script:Current = $null; $Script:Bytes = [int64]0
$Script:Ok = 0; $Script:Partial = 0; $Script:Failed = 0; $Script:Skipped = 0; $Script:LimitSkips = 0
$Script:Entries = New-Object System.Collections.Generic.List[object]
$Script:Failures = New-Object System.Collections.Generic.List[string]
$Script:TimedOut = $false; $Script:Finished = $false
$PerFile = [int64]$Plan.sizeLimits.perFileBytes; $TotalLimit = [int64]$Plan.sizeLimits.totalBytes
$Reserve = [int64]$Plan.sizeLimits.freeSpaceReserveBytes; $PartBytes = [int64]$Plan.sizeLimits.archivePartBytes; $MaxParts = [int]$Plan.sizeLimits.maxArchiveParts
$Clock = [Diagnostics.Stopwatch]::StartNew()
$ResBudget = [Math]::Max(15, [int]($Plan.runtimeBudgetSeconds / 10))
$CollectSeconds = $Plan.runtimeBudgetSeconds - $ResBudget

function Write-Status {
  $s = [ordered]@{
    schemaVersion = 1; runId = $RunId; planId = $Plan.planId; state = $Script:State; currentArtifact = $Script:Current
    startedUtc = $StartedUtc; updatedUtc = (Now-Utc); collectedBytes = $Script:Bytes
    counts = [ordered]@{ ok = $Script:Ok; partial = $Script:Partial; failed = $Script:Failed; skipped = $Script:Skipped }
    failureSummary = @($Script:Failures | Select-Object -First 100 | ForEach-Object { if ($_.Length -gt 480) { $_.Substring(0, 480) } else { $_ } })
  }
  $tmp = Join-Path $RunDir '.status.tmp'
  ($s | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination (Join-Path $RunDir 'status.json') -Force   # atomic replace on same volume
}
function Clip([string]$s, [int]$n) { if ($null -eq $s) { return $null }; if ($s.Length -gt $n) { return $s.Substring(0, $n) }; return $s }
function Record($art, $prof, $src, $dest, $method, $outcome, [int64]$bytes, $sha, $err, $skip, $note, [bool]$tf) {
  $Script:Entries.Add([ordered]@{
    artifactId = $art; profile = (Clip $prof 128); sourcePath = (Clip $src 2048); destination = $dest; method = $method; outcome = $outcome
    acquiredUtc = (Now-Utc); bytes = $bytes; sha256 = $sha; error = (Clip $err 1000); skipReason = $skip; consistencyNote = (Clip $note 300); timeFilterApplied = $tf })
  switch ($outcome) {
    'collected' { $Script:Ok++ }
    'partial' { $Script:Partial++; $Script:Failures.Add("${art}: partial - $err") }
    'failed' { $Script:Failed++; $Script:Failures.Add("${art}: failed - $err") }
    'skipped' { $Script:Skipped++; if ($skip -like 'limit:*' -or $skip -like 'interactive-users:*' -or $skip -eq 'named-account-not-found') { $Script:LimitSkips++; $Script:Failures.Add("${art}: skipped ($skip)") } }
  }
}
function Skip($art, $prof, $src, $why) { Record $art $prof $src $null 'metadata' 'skipped' 0 $null $null $why $null $false }
function Fail($art, $prof, $src, $err) { Record $art $prof $src $null 'metadata' 'failed' 0 $null $err $null $null $false }
function In-Budget { if ($Clock.Elapsed.TotalSeconds -ge $CollectSeconds) { $Script:TimedOut = $true; return $false }; return $true }

function Is-Reparse([string]$p) { $i = Get-Item -LiteralPath $p -Force -ErrorAction Stop; return [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint) }

# Open with FileShare.ReadWrite|Delete so files held open by other processes (locked logs/DBs) can still be read.
function Copy-SharedRead([string]$src, [string]$dest) {
  $in = New-Object IO.FileStream($src, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try { $out = New-Object IO.FileStream($dest, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $in.CopyTo($out) } finally { $out.Dispose() } } finally { $in.Dispose() }
}

function Copy-Guarded($art, $prof, [string]$src, [string]$rel, $note = $null) {
  $Script:Current = $art
  if (-not (In-Budget)) { Skip $art $prof $src 'limit:runtime-budget'; return }
  if (-not (Test-Path -LiteralPath $src)) { Skip $art $prof $src 'source-not-present'; return }
  try {
    if (Is-Reparse $src) { Skip $art $prof $src 'symlink-or-junction-not-followed'; return }
    $fi = Get-Item -LiteralPath $src -Force
    if ($fi.PSIsContainer) { Skip $art $prof $src 'not-a-regular-file'; return }
    if ($fi.FullName.StartsWith($RunDir, [StringComparison]::OrdinalIgnoreCase)) { Skip $art $prof $src 'inside-output-directory'; return }
    if ($fi.Length -gt $PerFile) { Skip $art $prof $src "limit:per-file-bytes ($($fi.Length) > $PerFile)"; return }
    if ($Script:Bytes + $fi.Length -gt $TotalLimit) { Skip $art $prof $src 'limit:total-bytes'; return }
    $drive = New-Object IO.DriveInfo($RunDir.Substring(0, 1))
    if ($drive.AvailableFreeSpace -lt ($Reserve + $fi.Length)) { Skip $art $prof $src 'limit:free-space-reserve'; return }
    $dest = Join-Path $Stage $rel; $n = 1
    while (Test-Path -LiteralPath $dest) { $dest = (Join-Path $Stage $rel) + ".$n"; $n++ }          # never overwrite
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    Copy-SharedRead $src $dest
    $h = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    $Script:Bytes += $fi.Length
    Record $art $prof $src ($dest.Substring($Stage.Length + 1) -replace '\\', '/') 'copy' 'collected' $fi.Length $h $null $null $note $false
  } catch { Fail $art $prof $src $_.Exception.Message }
}

function Copy-Tree($art, $prof, [string]$dir, [string]$relDir, [int]$depth, $note = $null, [string]$filter = '*') {
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Skip $art $prof $dir 'source-not-present'; return }
  try { if (Is-Reparse $dir) { Skip $art $prof $dir 'symlink-or-junction-not-followed'; return } } catch { }
  $base = (Get-Item -LiteralPath $dir -Force).FullName.TrimEnd('\')
  try {
    # -Depth limits recursion; reparse-point children are rejected per file in Copy-Guarded
    Get-ChildItem -LiteralPath $dir -Recurse -Depth ($depth - 1) -File -Force -Filter $filter -ErrorAction Stop | ForEach-Object {
      if (-not (In-Budget)) { return }
      $relf = $_.FullName.Substring($base.Length).TrimStart('\')
      $relf = [regex]::Replace($relf, '[^A-Za-z0-9._\\-]', '_') -replace '\\', '/'
      Copy-Guarded $art $prof $_.FullName "$relDir/$relf" $note
    }
  } catch { Fail $art $prof $dir $_.Exception.Message }
}

# JSON snapshot of an object collection, bounded by per-file limit.
function Write-Json($art, [string]$rel, $obj, $note) {
  $Script:Current = $art
  if (-not (In-Budget)) { Skip $art $null $null 'limit:runtime-budget'; return }
  try {
    $dest = Join-Path $Stage $rel; New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    $json = ConvertTo-Json -InputObject @($obj) -Depth 5
    [IO.File]::WriteAllText($dest, $json, (New-Object Text.UTF8Encoding($false)))
    $len = (Get-Item -LiteralPath $dest).Length
    if ($len -gt $PerFile) { Remove-Item -LiteralPath $dest; Skip $art $null $null "limit:per-file-bytes ($len > $PerFile)"; return }
    $Script:Bytes += $len
    Record $art $null $null ($rel -replace '\\', '/') 'snapshot' 'collected' $len ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()) $null $null $note $false
  } catch { Fail $art $null $null $_.Exception.Message }
}

# wevtutil export with native XPath time filter. Channel is from a fixed allowlist in this script.
function Export-EventLog($art, [string]$channel, [string]$rel) {
  $Script:Current = $art
  if (-not (In-Budget)) { Skip $art $null $channel 'limit:runtime-budget'; return }
  $dest = Join-Path $Stage $rel; New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
  $wargs = @('epl', $channel, $dest)
  $tf = $false
  if ($TWStart -and $TWEnd) {
    $wargs += ('/q:*[System[TimeCreated[@SystemTime>=''{0}'' and @SystemTime<=''{1}'']]]' -f $TWStart, $TWEnd); $tf = $true
  }
  try {
    $out = & "$env:SystemRoot\System32\wevtutil.exe" @wargs 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $dest)) {
      $msg = ($out | Out-String).Trim()
      if ($msg -match 'not found|could not be found|channel') { Skip $art $null $channel 'channel-not-present-or-disabled' }
      elseif ($msg -match 'denied|privilege') { Fail $art $null $channel 'Access denied (insufficient privilege)' }
      else { Fail $art $null $channel $msg }
      return
    }
    $len = (Get-Item -LiteralPath $dest).Length
    if ($len -gt $PerFile) { Remove-Item -LiteralPath $dest; Skip $art $null $channel "limit:per-file-bytes ($len > $PerFile)"; return }
    if ($Script:Bytes + $len -gt $TotalLimit) { Remove-Item -LiteralPath $dest; Skip $art $null $channel 'limit:total-bytes'; return }
    $Script:Bytes += $len
    Record $art $null $channel ($rel -replace '\\', '/') 'export' 'collected' $len ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()) $null $null 'exported through the event log API; live log may change during export' $tf
  } catch { Fail $art $null $channel $_.Exception.Message }
}

# ---------- time window ----------
$TWStart = $null; $TWEnd = $null
switch ($Plan.timeWindow.mode) {
  'last-days' { $e = (Get-Date).ToUniversalTime(); $TWEnd = $e.ToString('yyyy-MM-ddTHH:mm:ss.000Z'); $TWStart = $e.AddDays(-[int]$Plan.timeWindow.days).ToString('yyyy-MM-ddTHH:mm:ss.000Z') }
  'range' { $TWStart = ([datetime]::Parse($Plan.timeWindow.startUtc, $null, 'AdjustToUniversal')).ToString('yyyy-MM-ddTHH:mm:ss.000Z'); $TWEnd = ([datetime]::Parse($Plan.timeWindow.endUtc, $null, 'AdjustToUniversal')).ToString('yyyy-MM-ddTHH:mm:ss.000Z') }
}

# ---------- profile discovery (no passwords, no unloading/loading of hives) ----------
$AllProfiles = @()
try {
  $AllProfiles = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -and (Test-Path -LiteralPath $_.LocalPath -PathType Container) } | ForEach-Object {
    [pscustomobject]@{ Name = (Split-Path -Leaf $_.LocalPath); Home = $_.LocalPath; Sid = $_.SID; Loaded = [bool]$_.Loaded
      Kind = $(if ($_.Special -or $_.LocalPath -notlike "$env:SystemDrive\Users\*") { 'system' } else { 'normal' }) } })
} catch { $Script:Failures.Add("profile discovery failed: $($_.Exception.Message)") }
$InteractiveUsers = @(); try { $cu = (Get-CimInstance Win32_ComputerSystem).UserName; if ($cu) { $InteractiveUsers = @($cu.Split('\')[-1]) } } catch { }

$Selected = @()
switch ($Plan.userScope.mode) {
  'all-normal' { $Selected = @($AllProfiles | Where-Object { $_.Kind -eq 'normal' -or $Plan.includeSystemProfiles }) }
  'named' {
    $want = @($Plan.userScope.names)
    $Selected = @($AllProfiles | Where-Object { $want -contains $_.Name })
    foreach ($w in $want) { if (-not ($AllProfiles | Where-Object { $_.Name -eq $w })) { Skip 'user-discovery' $w $null 'named-account-not-found' } }
  }
  'interactive' {
    if ($InteractiveUsers.Count -eq 1) { $Selected = @($AllProfiles | Where-Object { $_.Name -eq $InteractiveUsers[0] }) }
    else { Record 'user-discovery' $null $null $null 'metadata' 'skipped' 0 $null $null "interactive-users:$($InteractiveUsers.Count) (expected exactly 1)" $null $false
           $Script:Failures.Add("interactive-user discovery found $($InteractiveUsers.Count) account(s); per-user artifacts were NOT collected. Use 'named' scope.") }
  }
}

function Each-Profile([scriptblock]$body) { foreach ($p in $Selected) { if (-not (In-Budget)) { return }; & $body $p } }

# ---------- artifacts (static allowlist; dispatch table, never string-built function names) ----------
$Artifacts = @{}
$Artifacts['win.baseline.system'] = {
  $os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem
  $hf = @(); try { $hf = Get-CimInstance Win32_QuickFixEngineering | Select-Object HotFixID, InstalledOn, Description } catch { }
  Write-Json 'win.baseline.system' 'baseline/system.json' ([pscustomobject]@{ collectedUtc = (Now-Utc); os = $os.Caption; version = $os.Version; build = $os.BuildNumber; lastBoot = "$($os.LastBootUpTime)"; computerName = $cs.Name; domain = $cs.Domain
    identity = $Identity.Name; elevated = $Elevated; hotfixes = $hf }) 'point-in-time'
}
$Artifacts['win.volatile.processes'] = {
  Write-Json 'win.volatile.processes' 'volatile/processes.json' (@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate)) 'point-in-time; no command lines'
}
$Artifacts['win.volatile.processes.cmdline'] = {
  if (@($Plan.sensitiveSelections) -notcontains 'process-command-lines') { Skip 'win.volatile.processes.cmdline' $null $null 'sensitive-selection-not-granted'; return }
  Write-Json 'win.volatile.processes.cmdline' 'volatile/process-cmdlines.json' (@(Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine)) 'SENSITIVE: arguments may contain secrets'
}
$Artifacts['win.volatile.network'] = {
  $tcp = @(); $udp = @()
  try { $tcp = @(Get-NetTCPConnection | Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess) } catch { }
  try { $udp = @(Get-NetUDPEndpoint | Select-Object LocalAddress, LocalPort, OwningProcess) } catch { }
  Write-Json 'win.volatile.network' 'volatile/network.json' ([pscustomobject]@{ tcp = $tcp; udp = $udp }) 'point-in-time'
}
$Artifacts['win.logs.security'] = { if (-not $Elevated) { Fail 'win.logs.security' $null 'Security' 'requires elevation'; return }; Export-EventLog 'win.logs.security' 'Security' 'logs/Security.evtx' }
$Artifacts['win.logs.system'] = { Export-EventLog 'win.logs.system' 'System' 'logs/System.evtx' }
$Artifacts['win.logs.application'] = { Export-EventLog 'win.logs.application' 'Application' 'logs/Application.evtx' }
$Artifacts['win.logs.powershell'] = { Export-EventLog 'win.logs.powershell' 'Microsoft-Windows-PowerShell/Operational' 'logs/PowerShell-Operational.evtx' }
$Artifacts['win.scheduled.tasks'] = {
  $art = 'win.scheduled.tasks'
  try {
    $i = 0
    foreach ($t in @(Get-ScheduledTask)) {
      if (-not (In-Budget)) { break }
      $i++
      $xml = Export-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
      $rel = 'scheduled/tasks/{0:D4}_{1}.xml' -f $i, (Safe-Name ($t.TaskPath + $t.TaskName))
      $dest = Join-Path $Stage $rel; New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
      [IO.File]::WriteAllText($dest, $xml, (New-Object Text.UTF8Encoding($false)))
      $len = (Get-Item -LiteralPath $dest).Length; $Script:Bytes += $len
      Record $art $null ($t.TaskPath + $t.TaskName) $rel 'export' 'collected' $len ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()) $null $null 'exported via Export-ScheduledTask' $false
    }
  } catch { Fail $art $null 'Task Scheduler' $_.Exception.Message }
}
$Artifacts['win.scheduled.history'] = { Export-EventLog 'win.scheduled.history' 'Microsoft-Windows-TaskScheduler/Operational' 'scheduled/TaskScheduler-Operational.evtx' }
$Artifacts['win.persistence.services'] = {
  Write-Json 'win.persistence.services' 'persistence/services.json' (@(Get-CimInstance Win32_Service | Select-Object Name, DisplayName, State, StartMode, PathName, StartName)) 'point-in-time'
}
$Artifacts['win.persistence.startup'] = {
  $items = @()
  $dirs = @([pscustomobject]@{ P = "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Startup"; Who = 'all-users' })
  foreach ($p in $Selected) { $dirs += [pscustomobject]@{ P = (Join-Path $p.Home 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'); Who = $p.Name } }
  foreach ($d in $dirs) { if (Test-Path -LiteralPath $d.P -PathType Container) { $items += @(Get-ChildItem -LiteralPath $d.P -Force | Select-Object @{n='scope';e={$d.Who}}, Name, Length, LastWriteTimeUtc) } }
  Write-Json 'win.persistence.startup' 'persistence/startup-folders.json' $items 'metadata only; files not copied'
}
$Artifacts['win.registry.autoruns'] = {
  $rows = @()
  $paths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run')
  foreach ($p in @($Selected)) {
    $paths += "Registry::HKEY_USERS\$($p.Sid)\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
    $paths += "Registry::HKEY_USERS\$($p.Sid)\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce"
  }
  foreach ($k in $paths) {
    if (Test-Path -LiteralPath $k) { $props = Get-ItemProperty -LiteralPath $k; foreach ($n in $props.PSObject.Properties) { if ($n.Name -notlike 'PS*') { $rows += [pscustomobject]@{ key = $k; name = $n.Name; value = "$($n.Value)" } } } }
    elseif ($k -like 'Registry::HKEY_USERS*') { Record 'win.registry.autoruns' $k $k $null 'metadata' 'skipped' 0 $null $null 'user-hive-not-loaded' $null $false }
  }
  Write-Json 'win.registry.autoruns' 'registry/autoruns.json' $rows 'values read from loaded hives only; unloaded user hives are not mounted'
}
$Artifacts['win.registry.services'] = {
  $rows = @(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Services' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
    if ($p) { [pscustomobject]@{ name = $_.PSChildName; imagePath = "$($p.ImagePath)"; start = $p.Start; objectName = "$($p.ObjectName)" } } })
  Write-Json 'win.registry.services' 'registry/services.json' $rows 'point-in-time'
}

function Sqlite-Set($art, $prof, [string]$src, [string]$rel) {
  $note = 'live copy of a SQLite database read with shared access; -wal/-journal copied when present; may be internally inconsistent'
  Copy-Guarded $art $prof $src $rel $note
  foreach ($s in @('-wal', '-journal')) { if (Test-Path -LiteralPath ($src + $s)) { Copy-Guarded $art $prof ($src + $s) ($rel + $s) $note } }
}
function Chromium-Roots($home_) { @(
  [pscustomobject]@{ N = 'Chrome'; P = "$home_\AppData\Local\Google\Chrome\User Data" }
  [pscustomobject]@{ N = 'Edge'; P = "$home_\AppData\Local\Microsoft\Edge\User Data" }
  [pscustomobject]@{ N = 'Brave'; P = "$home_\AppData\Local\BraveSoftware\Brave-Browser\User Data" }) }
function Chromium-Profiles([string]$root) {
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return @() }
  @(Get-ChildItem -LiteralPath $root -Directory -Force | Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' })
}
$Artifacts['win.browser.chromium.history'] = {
  Each-Profile { param($p) foreach ($b in (Chromium-Roots $p.Home)) {
    $profs = Chromium-Profiles $b.P
    if (@($profs).Count -eq 0 -and (Test-Path -LiteralPath $b.P)) { Skip 'win.browser.chromium.history' "$($p.Name)/$($b.N)" $b.P 'no-profiles-found' }
    foreach ($d in $profs) { Sqlite-Set 'win.browser.chromium.history' "$($p.Name)/$($b.N)/$($d.Name)" (Join-Path $d.FullName 'History') ("browser/{0}/{1}/{2}/History" -f (Safe-Name $p.Name), $b.N, (Safe-Name $d.Name)) } } }
}
$Artifacts['win.browser.chromium.config'] = {
  Each-Profile { param($p) foreach ($b in (Chromium-Roots $p.Home)) { foreach ($d in (Chromium-Profiles $b.P)) {
    $pf = "$($p.Name)/$($b.N)/$($d.Name)"; $base = "browser/{0}/{1}/{2}/config" -f (Safe-Name $p.Name), $b.N, (Safe-Name $d.Name)
    Copy-Guarded 'win.browser.chromium.config' $pf (Join-Path $d.FullName 'Preferences') "$base/Preferences"
    Copy-Tree 'win.browser.chromium.config' $pf (Join-Path $d.FullName 'Extensions') "$base/Extensions" 3 'extension manifest only' 'manifest.json' } } }
}
$Artifacts['win.browser.firefox.history'] = {
  Each-Profile { param($p)
    $root = Join-Path $p.Home 'AppData\Roaming\Mozilla\Firefox\Profiles'
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
    foreach ($d in (Get-ChildItem -LiteralPath $root -Directory -Force)) {
      if (Test-Path -LiteralPath (Join-Path $d.FullName 'places.sqlite')) { Sqlite-Set 'win.browser.firefox.history' "$($p.Name)/firefox/$($d.Name)" (Join-Path $d.FullName 'places.sqlite') ("browser/{0}/firefox/{1}/places.sqlite" -f (Safe-Name $p.Name), (Safe-Name $d.Name)) } }
  }
}
$Artifacts['win.browser.firefox.config'] = {
  Each-Profile { param($p)
    $root = Join-Path $p.Home 'AppData\Roaming\Mozilla\Firefox\Profiles'
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
    foreach ($d in (Get-ChildItem -LiteralPath $root -Directory -Force)) {
      $b = "browser/{0}/firefox/{1}/config" -f (Safe-Name $p.Name), (Safe-Name $d.Name)
      foreach ($f in @('extensions.json', 'prefs.js')) { Copy-Guarded 'win.browser.firefox.config' "$($p.Name)/firefox/$($d.Name)" (Join-Path $d.FullName $f) "$b/$f" } }
  }
}
$Artifacts['win.userlogs.temp'] = {
  Copy-Guarded 'win.userlogs.temp' $null "$env:SystemRoot\Logs\CBS\CBS.log" 'userlogs/CBS.log'
  Copy-Guarded 'win.userlogs.temp' $null "$env:SystemRoot\INF\setupapi.dev.log" 'userlogs/setupapi.dev.log'
}

# ---------- main collection (try/finally guarantees finalization on Ctrl+C / stop) ----------
$Interrupted = $true
$PartsJson = @(); $FailedParts = @(); $PackOk = $true
try {
  $Script:State = 'collecting'; Write-Status
  $ids = @($Plan.artifactIds)
  foreach ($phase in @('volatile', 'durable')) {
    foreach ($id in $ids) {
      $isVol = $id -like 'win.volatile.*'
      if (($phase -eq 'volatile') -ne $isVol) { continue }
      if (-not (In-Budget)) { break }
      $Script:Current = $id; Write-Status
      if ($Artifacts.ContainsKey($id)) {
        try { & $Artifacts[$id] } catch { Fail $id $null $null $_.Exception.Message }
      } else { Skip $id $null $null 'collector-not-implemented-for-this-os' }
    }
  }
  $ci = 0
  foreach ($cp in @($Plan.customPaths)) {
    $ci++; if (-not (In-Budget)) { break }
    if ($cp -match '[\*\?\[]') { Skip 'custom' $null $cp 'glob-not-supported'; continue }
    Copy-Guarded 'custom' $null $cp ('custom/{0:D3}_{1}' -f $ci, (Safe-Name (Split-Path -Leaf $cp))) 'operator-supplied path'
  }
  if ($Script:TimedOut) { $Script:Failures.Add('runtime budget exhausted; collection stopped early') }

  # ---------- packaging: independent zip parts ----------
  $Script:State = 'packaging'; $Script:Current = $null; Write-Status
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $files = @(Get-ChildItem -LiteralPath $Stage -Recurse -File -Force | Sort-Object FullName)
  $partNo = 0; $cur = $null; $curBytes = [int64]0; $curMembers = 0; $zip = $null
  function Close-Part {
    if ($null -ne $zip) { $zip.Dispose(); $script:zip = $null
      $pf = Join-Path $RunDir $partName
      $script:PartsJson += [ordered]@{ name = $partName; bytes = (Get-Item -LiteralPath $pf).Length; sha256 = (Get-FileHash -LiteralPath $pf -Algorithm SHA256).Hash.ToLower(); members = $curMembers } }
  }
  foreach ($f in $files) {
    if ($null -ne $zip -and ($curBytes + $f.Length) -gt $PartBytes) { Close-Part; $curBytes = 0; $curMembers = 0 }
    if ($null -eq $zip) {
      $partNo++
      if ($partNo -gt $MaxParts) { $FailedParts += 'limit:max-archive-parts exceeded; remaining files not packaged'; $PackOk = $false; $Script:Failures.Add('packaging: max archive parts exceeded'); break }
      $partName = 'part-{0:D3}.zip' -f $partNo
      $zip = [IO.Compression.ZipFile]::Open((Join-Path $RunDir $partName), [IO.Compression.ZipArchiveMode]::Create)
    }
    $member = ($f.FullName.Substring($Stage.Length + 1)) -replace '\\', '/'
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $member, [IO.Compression.CompressionLevel]::Optimal)
    $curBytes += $f.Length; $curMembers++
  }
  Close-Part
  $Interrupted = $false
} catch {
  $PackOk = $false; $FailedParts += "packaging error: $($_.Exception.Message)"; $Script:Failures.Add("packaging: $($_.Exception.Message)")
  if ($null -ne $zip) { try { $zip.Dispose() } catch { } }
  $Interrupted = $false
} finally {
  # Finalize whatever exists. If we get here with $Interrupted still true, the run was stopped (Ctrl+C / stop signal).
  if ($Interrupted) { $Script:Failures.Add('run interrupted; finalized with data collected so far') }
  $final = if (-not $PackOk) { 'failed' } elseif ($Interrupted) { 'cancelled' } elseif ($Script:TimedOut -or $Script:Partial -gt 0 -or $Script:Failed -gt 0 -or $Script:LimitSkips -gt 0) { 'partial' } else { 'complete' }
  try {
    $manifest = [ordered]@{
      schemaVersion = 1; runId = $RunId; planId = $Plan.planId; planDigest = $PlanSha; catalogVersion = $Plan.catalogVersion; generatorVersion = $Plan.generatorVersion; targetOs = 'windows'
      host = [ordered]@{ name = $env:COMPUTERNAME; osVersion = $OsCaption; identity = $Identity.Name; elevated = $Elevated }
      startedUtc = $StartedUtc; finishedUtc = (Now-Utc); entries = @($Script:Entries) }
    $mf = Join-Path $RunDir 'manifest.json'
    [IO.File]::WriteAllText($mf, ($manifest | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    $index = [ordered]@{ schemaVersion = 1; runId = $RunId; planId = $Plan.planId; planDigest = $PlanSha; finalizationState = $final; manifestName = 'manifest.json'
      manifestSha256 = (Get-FileHash -LiteralPath $mf -Algorithm SHA256).Hash.ToLower(); expectedParts = @($PartsJson); failedParts = @($FailedParts) }
    [IO.File]::WriteAllText((Join-Path $RunDir 'retrieval-index.json'), ($index | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    if ($PackOk) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }   # drop plaintext staging once parts exist
    $Script:State = $final; $Script:Current = $null; Write-Status
    if ($PackOk) { Set-Content -LiteralPath (Join-Path $RunDir 'FINALIZED') -Value $final -Encoding ASCII }   # marker only after successful finalization
    Say "FINISHED state=$final bytes=$($Script:Bytes) ok=$($Script:Ok) partial=$($Script:Partial) failed=$($Script:Failed) skipped=$($Script:Skipped)"
    Say "Pull: $RunDir (retrieval-index.json, manifest.json, status.json, part-*.zip)"
  } catch { Say "FINALIZATION ERROR: $($_.Exception.Message)" }
}
if (-not $PackOk) { exit $EXIT.Packaging }
if ($Interrupted -or $Script:TimedOut) { exit $EXIT.Interrupted }
if ($final -eq 'complete') { exit $EXIT.Complete }
exit $EXIT.Partial
