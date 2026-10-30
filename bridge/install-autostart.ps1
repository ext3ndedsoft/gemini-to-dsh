# Registers the bridge to start at logon, so gemini-3.8-flash is available
# whenever DSH is running. Run from an elevated-or-normal PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
# Remove with:
#   Unregister-ScheduledTask -TaskName 'GeminiToDshBridge' -Confirm:$false

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$here\bridge.js`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'GeminiToDshBridge' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'OpenAI-compatible local bridge to Gemini' -Force | Out-Null
Start-ScheduledTask -TaskName 'GeminiToDshBridge'
Write-Host "Registered and started 'GeminiToDshBridge'."
