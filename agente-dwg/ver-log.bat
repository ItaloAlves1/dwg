@echo off
rem Abre o registro do agente DWG no Bloco de Notas.
cd /d "%~dp0"
if exist agente.log (start "" notepad agente.log) else (echo Ainda nao ha registro. & pause)
