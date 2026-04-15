@echo off
cls
cd /d "%~dp0"

set "script=%~dp0task_runner-2.py"
set "identifier=%USERNAME%"

powershell.exe -ExecutionPolicy Bypass -File "%~dp0is_process_running.ps1" -Keyword "qwen"
if %errorlevel% equ 0 goto :skip_qwen
start /b pythonw.exe %script% %identifier% --type opencli-analysis-qwen
:skip_qwen

powershell.exe -ExecutionPolicy Bypass -File "%~dp0is_process_running.ps1" -Keyword "deepseek"
if %errorlevel% equ 0 goto :skip_deepseek
start /b pythonw.exe %script% %identifier% --type opencli-analysis-deepseek
:skip_deepseek

powershell.exe -ExecutionPolicy Bypass -File "%~dp0is_process_running.ps1" -Keyword "yuanbao"
if %errorlevel% equ 0 goto :skip_yuanbao
start /b pythonw.exe %script% %identifier% --type opencli-analysis-yuanbao
:skip_yuanbao

powershell.exe -ExecutionPolicy Bypass -File "%~dp0is_process_running.ps1" -Keyword "doubao"
if %errorlevel% equ 0 goto :skip_doubao
start /b pythonw.exe %script% %identifier% --type opencli-analysis-doubao
:skip_doubao

echo OK
pause >nul