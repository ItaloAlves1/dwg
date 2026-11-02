@echo off
rem Para o agente DWG que está rodando em segundo plano.
cd /d "%~dp0"
if not exist agente.pid (
  echo O agente nao esta rodando.
  pause
  exit /b 0
)
set /p PID=<agente.pid
taskkill /PID %PID% /F >nul 2>&1 && echo Agente parado. || echo O agente ja nao estava rodando.
del agente.pid >nul 2>&1
pause
