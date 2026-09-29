# Plugs $WELL into the live deployment after launching it on Pons. One transaction, permanent.
#
#   .\set-token.ps1
#
# Asks for the $WELL address and the deployer private key (hidden; it stays in this PowerShell process only
# and is cleared when the script ends).
# "Continue": Windows PowerShell 5.1 turns stderr from node into terminating errors under "Stop"; each step checks
# $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$contracts = Join-Path $root "contracts"

function Stop-Setup($msg) { Write-Host "`nSTOPPED: $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path (Join-Path $contracts "deployments\robinhood.json"))) {
  Stop-Setup "No live deployment found (contracts\deployments\robinhood.json). Run .\launch.ps1 first."
}

try {
  $env:WELL_TOKEN_ADDRESS = (Read-Host "Paste the `$WELL token address from Pons").Trim()
  if ($env:WELL_TOKEN_ADDRESS -notmatch '^0x[0-9a-fA-F]{40}$') { Stop-Setup "That isn't a token address (0x followed by 40 characters)." }
  $secure = Read-Host "Paste the DEPLOYER private key (hidden; right-click or Ctrl+Shift+V to paste)" -AsSecureString
  $env:DEPLOYER_PRIVATE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  $env:DEPLOYER_PRIVATE_KEY = ($env:DEPLOYER_PRIVATE_KEY -replace '\s', '')
  if ($env:DEPLOYER_PRIVATE_KEY -notmatch '^(0x)?[0-9a-fA-F]{64}$') {
    if ($env:DEPLOYER_PRIVATE_KEY -match '[\x00-\x1F]' -or $env:DEPLOYER_PRIVATE_KEY.Length -lt 8) { Stop-Setup "The paste didn't reach the prompt (this terminal types Ctrl+V as a character). Run it again and paste with right-click or Ctrl+Shift+V." }
    Stop-Setup "That isn't a private key (64 hexadecimal characters). Copy it again from your wallet's export screen."
  }

  Write-Host "`nThis permanently sets `$WELL to $env:WELL_TOKEN_ADDRESS. It can never be changed." -ForegroundColor Yellow
  if ((Read-Host "Type SET to continue") -ne "SET") { Stop-Setup "Cancelled." }

  Push-Location $contracts
  $ok = $false
  for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
    npx hardhat run scripts/set-well-token.js --network robinhood 2>&1 | Where-Object { $_ -notmatch '^\s+at ' }
    $ok = $LASTEXITCODE -eq 0
    if (-not $ok -and $attempt -lt 3) { Write-Host "Attempt $attempt failed; retrying (usually a dropped RPC connection)." -ForegroundColor Yellow; Start-Sleep -Seconds 8 }
  }
  if (-not $ok) { Pop-Location; Stop-Setup "Could not set `$WELL. Read the message above; nothing was changed if it says so." }
  npm run export-abis | Select-Object -Last 1
  Pop-Location
  Write-Host "`n`$WELL is set. The site shows it straight from the contract; commit contracts\deployments\robinhood.json so the keeper and docs match." -ForegroundColor Green
} finally {
  Remove-Item env:DEPLOYER_PRIVATE_KEY -ErrorAction SilentlyContinue
}
