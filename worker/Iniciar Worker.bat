@echo off
title Conversor PDF - DWG (worker)
cd /d "%~dp0"
if not exist .env (
  echo Falta o arquivo .env - copie .env.example para .env e preencha as chaves do Supabase.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm install
)
echo Worker ligado. Feche esta janela (ou Ctrl+C) para desligar.
call npm start
pause
