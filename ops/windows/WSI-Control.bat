@echo off
setlocal
set "OPS=%~dp0.."
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%OPS%\wsi_control_app.py" %*
  exit /b %ERRORLEVEL%
)
python "%OPS%\wsi_control_app.py" %*
exit /b %ERRORLEVEL%
