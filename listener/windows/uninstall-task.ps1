# Stops the listener and removes it from startup. Run in PowerShell opened with "Run as administrator":
#   powershell -ExecutionPolicy Bypass -File windows\uninstall-task.ps1
# The WhatsApp login (auth\) stays; to unlink the PC, remove it on the reception phone under Linked devices.

#Requires -RunAsAdministrator
$name = 'Bookr WhatsApp listener'
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*src\main.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "Removed '$name'."
