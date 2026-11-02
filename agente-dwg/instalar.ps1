# Instala o agente DWG neste PC (sem precisar de administrador):
#   - copia o agente para %LOCALAPPDATA%\ConversorDWG
#   - baixa o ODA File Converter oficial e extrai na pasta do agente
#   - cria o .env e o atalho para iniciar junto com o Windows
# Uso: clique com o botão direito → "Executar com o PowerShell"
#      (ou: powershell -ExecutionPolicy Bypass -File instalar.ps1 [-SupabaseUrl https://xxx.supabase.co])
param([string]$SupabaseUrl = "")

$ErrorActionPreference = "Stop"
$origem  = $PSScriptRoot
$destino = Join-Path $env:LOCALAPPDATA "ConversorDWG"
New-Item -ItemType Directory -Force $destino | Out-Null

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js nao encontrado. Instale a versao LTS de https://nodejs.org e rode de novo." -ForegroundColor Red
  exit 1
}

# 1. Arquivos do agente
foreach ($f in "agente.mjs", "iniciar-oculto.vbs", "parar.bat", "ver-log.bat", ".env.example") {
  Copy-Item (Join-Path $origem $f) $destino -Force
}

# 2. ODA File Converter (extração administrativa do instalador oficial: nao mexe no sistema)
$oda = Join-Path $destino "oda"
if (-not (Test-Path (Join-Path $oda "ODAFileConverter.exe"))) {
  Write-Host "Baixando o ODA File Converter..."
  $msi = Join-Path $env:TEMP "ODAFileConverter.msi"
  Invoke-WebRequest "https://www.opendesign.com/guestfiles/get?filename=ODAFileConverter_QT6_vc16_amd64dll.msi" -OutFile $msi
  $assinatura = Get-AuthenticodeSignature $msi
  if ($assinatura.Status -ne "Valid" -or $assinatura.SignerCertificate.Subject -notmatch "OPEN DESIGN ALLIANCE") {
    Write-Host "Assinatura do instalador do ODA invalida; instalacao cancelada." -ForegroundColor Red
    exit 1
  }
  Start-Process msiexec.exe -ArgumentList "/a `"$msi`" /qn TARGETDIR=`"$oda`"" -Wait
  Remove-Item $msi -Force
}

# 3. Configuração (.env): mantém a existente; senão cria a partir do exemplo
$envFile = Join-Path $destino ".env"
if (-not (Test-Path $envFile)) {
  if (-not $SupabaseUrl) { $SupabaseUrl = Read-Host "URL do projeto Supabase (ex.: https://xxxx.supabase.co)" }
  $texto = Get-Content (Join-Path $destino ".env.example") -Raw -Encoding UTF8
  if ($SupabaseUrl) { $texto = $texto -replace "https://SEU-PROJETO.supabase.co", $SupabaseUrl }
  [IO.File]::WriteAllText($envFile, $texto, (New-Object Text.UTF8Encoding $false))
}

# 4. Iniciar junto com o Windows (atalho na pasta Inicializar do usuário)
$startup = [Environment]::GetFolderPath("Startup")
$atalho = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup "Conversor DWG.lnk"))
$atalho.TargetPath = "wscript.exe"
$atalho.Arguments = "`"$(Join-Path $destino 'iniciar-oculto.vbs')`""
$atalho.WorkingDirectory = $destino
$atalho.Description = "Agente que gera DWG para o Conversor PDF"
$atalho.Save()

Write-Host ""
Write-Host "Instalado em $destino" -ForegroundColor Green
if ((Get-Content $envFile -Raw) -notmatch "SUPABASE_SERVICE_ROLE_KEY=\S") {
  Write-Host "Falta colar a chave service_role no arquivo .env (abrindo no Bloco de Notas)." -ForegroundColor Yellow
  Start-Process notepad $envFile
} else {
  Start-Process wscript.exe "`"$(Join-Path $destino 'iniciar-oculto.vbs')`""
  Write-Host "Agente iniciado em segundo plano."
}
