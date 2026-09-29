# Stonkwell launch: checks, deploys to Robinhood Chain, and prepares the website.
#
#   .\launch.ps1              real deploy to Robinhood Chain
#   .\launch.ps1 -Rehearsal   same steps on a local copy of the live chain; spends nothing
#
# Put the four role addresses and the $WELL address in launch.env (copy launch.env.example).
# The deployer private key is asked for with hidden input, lives only in this PowerShell process
# for the duration of the script, and is never written to disk or printed.
param([switch]$Rehearsal, [switch]$Force)

# "Continue": Windows PowerShell 5.1 turns any stderr line from node/npx into a terminating error under "Stop".
# Every native step below checks $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
$contracts = Join-Path $root "contracts"
$app = Join-Path $root "app"

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Stop-Launch($msg) { Write-Host "`nSTOPPED: $msg" -ForegroundColor Red; exit 1 }

# 1. Settings
Step "Settings"
$envFile = Join-Path $root "launch.env"
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(\S+)\s*$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
  }
  Write-Host "Loaded launch.env"
}
foreach ($name in "ADMIN_MULTISIG", "GUARDIAN_MULTISIG", "KEEPER_ADDRESS", "TREASURY_MULTISIG") {
  if (-not (Get-Item "env:$name" -ErrorAction SilentlyContinue)) { Stop-Launch "$name is not set. Add it to launch.env." }
}
if (-not $env:WELL_TOKEN_ADDRESS) {
  Write-Host "No WELL_TOKEN_ADDRESS: deploying before `$WELL. After launching it on Pons, run .\set-token.ps1 to plug it in (one transaction)." -ForegroundColor Cyan
}

$outFile = Join-Path $contracts "deployments\robinhood.json"
if (-not $Rehearsal -and (Test-Path $outFile) -and -not $Force) {
  Stop-Launch "deployments\robinhood.json already exists, so Stonkwell is already deployed. Use -Force only if you really want a second deployment."
}

try {
  # 2. Deployer key (real deploy only)
  if (-not $Rehearsal) {
    Step "Deployer wallet"
    if (-not $env:DEPLOYER_PRIVATE_KEY) {
      $secure = Read-Host "Paste the deployer private key (hidden)" -AsSecureString
      $env:DEPLOYER_PRIVATE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    Push-Location $contracts
    $env:DEPLOYER_ADDRESS = node -e "const k=process.env.DEPLOYER_PRIVATE_KEY.trim(); console.log(new (require('ethers').Wallet)(k.startsWith('0x')?k:'0x'+k).address)"
    Pop-Location
    if ($LASTEXITCODE -ne 0 -or -not $env:DEPLOYER_ADDRESS) { Stop-Launch "That doesn't look like a valid private key." }
    Write-Host "Deployer: $env:DEPLOYER_ADDRESS"
  }

  # 3. Checks
  Push-Location $contracts
  Step "Refreshing live pool data"
  node scripts/probe-pools.js | Select-String -Pattern "TSLA|NVDA|AAPL|PLTR|META|chainId"
  if ($LASTEXITCODE -ne 0) { Stop-Launch "Could not read the live pools. Check your internet connection and run again." }
  Step "Preflight checks"
  node scripts/preflight.js
  if ($LASTEXITCODE -ne 0) { Stop-Launch "Preflight failed. Fix the FAIL lines above and run again." }

  # 4. Deploy
  if ($Rehearsal) {
    Step "Rehearsal deploy on a local copy of Robinhood Chain"
    $env:FORK = "1"; $env:DEPLOY_LIVE = "1"
    $deployArgs = @("hardhat", "run", "scripts/deploy.js")
    $written = Join-Path $contracts "deployments\fork.json"
  } else {
    Write-Host "`nThis deploys Stonkwell to Robinhood Chain with real gas from $env:DEPLOYER_ADDRESS." -ForegroundColor Yellow
    if ((Read-Host "Type DEPLOY to continue") -ne "DEPLOY") { Stop-Launch "Cancelled." }
    Step "Deploying to Robinhood Chain"
    $deployArgs = @("hardhat", "run", "scripts/deploy.js", "--network", "robinhood")
    $written = $outFile
  }
  $ok = $false
  for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
    $before = if (Test-Path $written) { (Get-Item $written).LastWriteTimeUtc } else { $null }
    npx @deployArgs 2>&1 | Tee-Object -Variable deployLog | Where-Object { $_ -notmatch '^\s+at ' }
    $after = if (Test-Path $written) { (Get-Item $written).LastWriteTimeUtc } else { $null }
    $ok = ($LASTEXITCODE -eq 0) -and $after -and ($after -ne $before)
    if (-not $ok) {
      # Contracts from a half-finished attempt hold no funds and are never listed by the app; a retry deploys a full fresh set.
      Write-Host "Attempt $attempt did not finish (usually a dropped connection to the Robinhood RPC)." -ForegroundColor Yellow
      if ($attempt -lt 3) { Start-Sleep -Seconds 10 }
    }
  }
  Remove-Item env:FORK, env:DEPLOY_LIVE -ErrorAction SilentlyContinue
  if (-not $ok) { Stop-Launch "Deploy did not finish after 3 attempts. Try another internet connection or set ROBINHOOD_RPC_URL to a private RPC, then run again." }

  if ($Rehearsal) {
    git -C $root checkout -- contracts/deployments/fork.json 2>$null
    Pop-Location
    Step "Rehearsal complete. Nothing was sent to Robinhood Chain."
    exit 0
  }

  # 5. Website
  Step "Exporting addresses to the website"
  npm run export-abis
  Pop-Location
  Push-Location $app
  Step "Building the website"
  $env:NEXT_PUBLIC_ENABLE_LOCAL = $null
  npm run build 2>&1 | Select-String -Pattern "Compiled|error|Error"
  if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Launch "The website build failed. The contracts ARE deployed; share the output above to get it fixed." }
  Pop-Location

  Step "Deployed"
  Write-Host "Contract addresses: contracts\deployments\robinhood.json"
  Write-Host "Next:"
  Write-Host "  1. Commit and push contracts\deployments\robinhood.json and app\src\generated so Netlify publishes the live site."
  Write-Host "  2. Admin multisig: node contracts\scripts\timelock-accept.js  (schedule now, execute after 48h)."
  Write-Host "  3. Start the keeper bot (keeper\README.md) with the keeper wallet."
} finally {
  Remove-Item env:DEPLOYER_PRIVATE_KEY -ErrorAction SilentlyContinue
}
