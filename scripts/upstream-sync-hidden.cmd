@echo off
rem Hidden shim for the hourly pi-goal-x upstream sync.
rem Invoked by upstream-sync-hidden.vbs (wscript, window style 0) so node.exe
rem never gets a visible console in the interactive session. The sync writes
rem its own log to D:\tmp; this shim additionally keeps the last run's console
rem output for forensics. %~dp0 = this file's directory (trailing backslash).
"C:\Program Files\nodejs\node.exe" "%~dp0upstream-sync.mjs" > "%TEMP%\pi-goalx-sync-console.log" 2>&1
exit /b %ERRORLEVEL%
