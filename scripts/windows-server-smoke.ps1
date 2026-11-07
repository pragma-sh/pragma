<#
.SYNOPSIS
  Starts a real pragma-server.exe the way a user's machine does and proves it serves.

.DESCRIPTION
  Regression check for #212. Unit tests could not catch that bug: the CI runner's
  admin account and newer toolchain hid it, and the release pipeline never started
  the server at all. This drives the shipped binary end to end, on Windows only:

    1. a fresh start on an empty data directory must answer with a Hello frame;
    2. after a forced kill (which leaves the socket behind, as a crash does), a
       second start must clear that stale socket and serve again;
    3. while it serves, a *different* account must not be able to connect,
       because the socket is meant to be owner-only.

  Each scenario runs as the invoking account and, with -StandardUser, as a freshly
  created non-administrator local account, which is what a real user is.

  Requires PowerShell 7 (`pwsh`), for .NET's Unix-domain socket support.

.EXAMPLE
  pwsh -File scripts/windows-server-smoke.ps1 -Server target/release/pragma-server.exe -StandardUser
#>
[CmdletBinding()]
param(
  # The pragma-server.exe to test.
  [Parameter(Mandatory, ParameterSetName = 'Drive')]
  [string] $Server,

  # Also run every scenario as a newly created non-admin local account.
  [Parameter(ParameterSetName = 'Drive')]
  [switch] $StandardUser,

  # Internal: run the serve scenarios as the current account.
  [Parameter(Mandatory, ParameterSetName = 'Serve')]
  [string] $ServeWith,

  # Internal: try to connect to a socket and report whether it was refused.
  [Parameter(Mandatory, ParameterSetName = 'Probe')]
  [string] $ProbeSocket,

  # Internal: where the serve/probe modes write their result.
  [Parameter(Mandatory, ParameterSetName = 'Serve')]
  [Parameter(Mandatory, ParameterSetName = 'Probe')]
  [string] $ResultFile,

  # Internal: leave the second server running and write its socket path here.
  [Parameter(ParameterSetName = 'Serve')]
  [string] $LeaveRunning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ReadyTimeoutSeconds = 30
$WorkRoot = 'C:\pragma-smoke'

function Write-Result([string] $Path, [string] $Text) {
  Set-Content -LiteralPath $Path -Value $Text -Encoding utf8
}

# Opens the socket and reads the first bytes, which the server always sends (the
# Hello frame). Returns $null on success, or the reason it failed.
function Test-Serves([string] $SocketPath) {
  $socket = [System.Net.Sockets.Socket]::new(
    [System.Net.Sockets.AddressFamily]::Unix,
    [System.Net.Sockets.SocketType]::Stream,
    [System.Net.Sockets.ProtocolType]::Unspecified)
  try {
    $socket.ReceiveTimeout = 5000
    $socket.Connect([System.Net.Sockets.UnixDomainSocketEndPoint]::new($SocketPath))
    $buffer = [byte[]]::new(64)
    $read = $socket.Receive($buffer)
    if ($read -le 0) { return 'connected, but the server sent no Hello frame' }
    return $null
  } catch {
    return $_.Exception.Message
  } finally {
    $socket.Dispose()
  }
}

# Finds daemon.sock under the data directory without opening it: enumeration reads
# directory entries, whereas Test-Path follows the socket's reparse point and can
# report a socket that is there as missing.
function Find-Socket([string] $DataDir) {
  if (-not [System.IO.Directory]::Exists($DataDir)) { return $null }
  $found = [System.IO.Directory]::GetFiles($DataDir, 'daemon.sock', 'AllDirectories')
  if ($found.Count -gt 0) { return $found[0] }
  return $null
}

# Starts the server and waits until it serves. Returns the process, or throws with
# the server's own output when it exits or never becomes ready.
function Start-Server([string] $Exe, [string] $DataDir, [string] $LogStem) {
  $env:PRAGMA_APP_DATA_DIR = $DataDir
  $process = Start-Process -FilePath $Exe -PassThru -NoNewWindow `
    -RedirectStandardOutput "$LogStem.out.log" -RedirectStandardError "$LogStem.err.log"
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
  $lastError = 'no daemon.sock yet'
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
      $stderr = Get-Content -Raw -LiteralPath "$LogStem.err.log" -ErrorAction SilentlyContinue
      throw "pragma-server exited with code $($process.ExitCode) before serving:`n$stderr"
    }
    $socket = Find-Socket $DataDir
    if ($socket) {
      $lastError = Test-Serves $socket
      if (-not $lastError) { return @{ Process = $process; Socket = $socket } }
    }
    Start-Sleep -Milliseconds 250
  }
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  $stderr = Get-Content -Raw -LiteralPath "$LogStem.err.log" -ErrorAction SilentlyContinue
  throw "pragma-server did not serve within ${ReadyTimeoutSeconds}s (last: $lastError):`n$stderr"
}

# `Start-Process -Credential` hands the child the *parent's* environment, so
# USERNAME/USERDOMAIN/TEMP still name the admin account. pragma-server grants its
# owner-only ACL to USERDOMAIN\USERNAME, so left alone that would lock the
# standard account out of its own socket — a harness artifact, not what a real
# logon produces. Rebuild them from the process token, as a real logon does,
# and return what was inherited so the verdict can show it.
function Reset-IdentityEnvironment {
  $who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $inherited = "$env:USERDOMAIN\$env:USERNAME"
  $domain, $user = $who.Split('\', 2)
  $env:USERDOMAIN = $domain
  $env:USERNAME = $user
  $temp = Join-Path $WorkRoot "temp-$user"
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  $env:TEMP = $temp
  $env:TMP = $temp
  return @{ Who = $who; Inherited = $inherited }
}

# --- Serve mode: the scenarios, run as whichever account invoked us. -----------
function Invoke-Serve {
  try {
    $identity = Reset-IdentityEnvironment
    $who = $identity.Who
    # Deliberately *not* inside the account's profile, which other accounts
    # cannot enter anyway: the work area grants BUILTIN\Users access, so the
    # only thing keeping another account off the socket is the restriction the
    # server applies itself — which is what the probe scenario checks.
    $dataDir = Join-Path (Split-Path $ResultFile) "data-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $logStem = Join-Path (Split-Path $ResultFile) ("server-" + ($who -replace '[\\/:]', '_'))

    $first = Start-Server $ServeWith $dataDir "$logStem-1"
    Stop-Process -Id $first.Process.Id -Force
    $first.Process.WaitForExit()
    if (-not (Find-Socket $dataDir)) {
      throw 'a killed server left no socket behind, so the stale-socket restart is not being exercised'
    }

    $second = Start-Server $ServeWith $dataDir "$logStem-2"
    if ($LeaveRunning) {
      Write-Result $LeaveRunning "$($second.Process.Id)`n$($second.Socket)"
    } else {
      Stop-Process -Id $second.Process.Id -Force
    }
    Write-Result $ResultFile "PASS as ${who} (inherited env named $($identity.Inherited)): fresh start served; restart over a stale socket served"
  } catch {
    Write-Result $ResultFile "FAIL: $($_.Exception.Message)"
  }
}

# --- Probe mode: another account trying to reach someone else's socket. ---------
function Invoke-Probe {
  Reset-IdentityEnvironment | Out-Null
  $reason = Test-Serves $ProbeSocket
  if ($reason) {
    Write-Result $ResultFile "PASS: refused ($reason)"
  } else {
    Write-Result $ResultFile 'FAIL: a different account connected to an owner-only socket'
  }
}

# --- Drive mode: set up accounts, run the scenarios, collect verdicts. ----------
function New-StandardAccount {
  $name = 'pragmasmoke'
  $password = 'Ps1!' + [guid]::NewGuid().ToString('N')
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  Get-LocalUser -Name $name -ErrorAction SilentlyContinue | Remove-LocalUser
  New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -AccountNeverExpires | Out-Null
  Add-LocalGroupMember -Group 'Users' -Member $name -ErrorAction SilentlyContinue
  [System.Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name", $secure)
}

# Runs this script in another mode, as $Credential if given, and returns its verdict.
function Invoke-Self([string[]] $Arguments, [string] $ResultPath, $Credential) {
  Remove-Item -LiteralPath $ResultPath -ErrorAction SilentlyContinue
  $pwsh = (Get-Process -Id $PID).Path
  $all = @('-NoProfile', '-NonInteractive', '-File', (Join-Path $WorkRoot 'smoke.ps1')) + $Arguments + @('-ResultFile', $ResultPath)
  $start = @{ FilePath = $pwsh; ArgumentList = $all; PassThru = $true; WorkingDirectory = $WorkRoot }
  if ($Credential) { $start.Credential = $Credential; $start.LoadUserProfile = $true }
  else { $start.NoNewWindow = $true }
  $process = Start-Process @start
  # WaitForExit, not -Wait: -Wait also waits for a server left running on purpose.
  if (-not $process.WaitForExit(180000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    return 'FAIL: the scenario did not finish within 180s'
  }
  if (Test-Path -LiteralPath $ResultPath) { return (Get-Content -Raw -LiteralPath $ResultPath).Trim() }
  return "FAIL: the scenario wrote no result (exit code $($process.ExitCode))"
}

function Invoke-Drive {
  if (-not $IsWindows) { throw 'windows-server-smoke runs on Windows only' }
  $resolved = (Resolve-Path -LiteralPath $Server).Path

  # A world-readable work area: the standard account must be able to run the
  # binary and this script, and write its verdict.
  Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $WorkRoot | Out-Null
  & icacls $WorkRoot /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null  # BUILTIN\Users
  $exe = Join-Path $WorkRoot 'pragma-server.exe'
  Copy-Item -LiteralPath $resolved -Destination $exe
  Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $WorkRoot 'smoke.ps1')

  $os = Get-CimInstance Win32_OperatingSystem
  Write-Host "OS: $($os.Caption) build $($os.BuildNumber); pwsh $($PSVersionTable.PSVersion)"

  $credential = New-StandardAccount
  $verdicts = [ordered]@{}

  # As the invoking (admin) account; leave its server up for the cross-account probe.
  $lease = Join-Path $WorkRoot 'admin-lease.txt'
  $verdicts['serve as runner account'] = Invoke-Self @('-ServeWith', $exe, '-LeaveRunning', $lease) (Join-Path $WorkRoot 'admin.txt') $null
  if (Test-Path -LiteralPath $lease) {
    $serverPid, $socket = (Get-Content -LiteralPath $lease)
    $verdicts['standard account cannot reach the runner account socket'] =
      Invoke-Self @('-ProbeSocket', $socket) (Join-Path $WorkRoot 'probe.txt') $credential
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
  }

  if ($StandardUser) {
    $verdicts['serve as standard account'] = Invoke-Self @('-ServeWith', $exe) (Join-Path $WorkRoot 'standard.txt') $credential
  }

  $failed = $false
  foreach ($entry in $verdicts.GetEnumerator()) {
    Write-Host "[$($entry.Key)] $($entry.Value)"
    if (-not $entry.Value.StartsWith('PASS')) { $failed = $true }
  }
  Get-ChildItem -LiteralPath $WorkRoot -Filter 'server-*.log' | ForEach-Object {
    Write-Host "----- $($_.Name)"
    Get-Content -LiteralPath $_.FullName -Tail 40 | Write-Host
  }
  Get-LocalUser -Name 'pragmasmoke' -ErrorAction SilentlyContinue | Remove-LocalUser
  if ($failed) { exit 1 }
}

switch ($PSCmdlet.ParameterSetName) {
  'Drive' { Invoke-Drive }
  'Serve' { Invoke-Serve }
  'Probe' { Invoke-Probe }
}
