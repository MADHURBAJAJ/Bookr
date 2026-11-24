# Sets the listener to start when Windows starts, with nobody signed in, and to start again if it stops.
# Run once, in PowerShell opened with "Run as administrator", from the listener folder:
#   powershell -ExecutionPolicy Bypass -File windows\install-task.ps1
# Run it again after moving the folder or updating Node. windows\uninstall-task.ps1 removes it.

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$name = 'Bookr WhatsApp listener'
$dir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path (Join-Path $dir '.env'))) { throw "No .env in $dir. Copy .env.example to .env and fill it in first." }
if (-not (Test-Path (Join-Path $dir 'node_modules\baileys'))) { throw "Run 'npm ci' in $dir first." }
if (-not (Test-Path (Join-Path $dir 'auth\creds.json'))) { Write-Warning "Not linked yet: run 'npm run link' and scan the QR. The task waits until then." }

# Started at boot (a minute later, for the network), and checked every 5 minutes: if it is not running, it is started.
# Only one copy ever runs (IgnoreNew here, and the listener's own lock file).
$action = New-ScheduledTaskAction -Execute $node -Argument 'src\main.js' -WorkingDirectory $dir
$atBoot = New-ScheduledTaskTrigger -AtStartup
$atBoot.Delay = 'PT1M'
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($atBoot, $every5) -Principal $principal -Settings $settings -Force | Out-Null

# The WhatsApp login in auth\ is as sensitive as the reception phone's WhatsApp: only Windows itself (SYSTEM) and
# administrators may open this folder.
icacls $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C /Q | Out-Null

Write-Host "Done. '$name' runs $node src\main.js in $dir at startup, and is started again if it stops."
Write-Host "Start it now:  Start-ScheduledTask -TaskName '$name'"
Write-Host "Log:           $dir\logs\"
