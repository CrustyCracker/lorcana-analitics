@echo off
REM XAMPP PlayHub cache poller — keeps cache_*.json fresh so the UI stays fast.
REM Double-click or schedule via Task Scheduler.
setlocal
set PHP=C:\xampp\php\php.exe
if not exist "%PHP%" set PHP=php
cd /d "%~dp0.."
echo Polling PlayHub cache (Ctrl+C to stop)...
"%PHP%" refresh_cache.php --loop --sleep=30
endlocal
