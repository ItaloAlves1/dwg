@echo off
rem Instala o agente DWG neste PC (dois cliques). Detalhes em instalar.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
pause
