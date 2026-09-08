# Creates a Desktop shortcut to the WSI Control app. Run in PowerShell:
#   powershell -ExecutionPolicy Bypass -File ops\windows\install-desktop-shortcut.ps1
$ErrorActionPreference = "Stop"
$ops = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $PSScriptRoot "WSI-Control.bat"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "WSI Control.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $bat
$shortcut.WorkingDirectory = $ops
$shortcut.WindowStyle = 1
$shortcut.Description = "Launch, quit, or relaunch the WSI image server and ingestion engine"
$shortcut.Save()
Write-Host "Created $shortcutPath"
