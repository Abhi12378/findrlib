param([int]$Port = 8766)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$report = Join-Path $root "audit"
New-Item -ItemType Directory -Path $report -Force | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$python = (Get-Command python -ErrorAction Stop).Source
$lighthouse = Join-Path $root "node_modules/lighthouse/cli/index.js"
if (-not (Test-Path -LiteralPath $lighthouse)) {
    throw "Install audit dependencies first: npm install --prefix `"$root`""
}
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path -LiteralPath $chrome)) { throw "Google Chrome is required for Lighthouse." }
$env:CHROME_PATH = $chrome
$url = "http://127.0.0.1:$Port/"
$started = $null
try {
    try { Invoke-WebRequest -Uri $url -TimeoutSec 3 | Out-Null }
    catch {
        $started = Start-Process -FilePath $python -ArgumentList @("app.py","--port","$Port","--no-browser") -WorkingDirectory $root -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 2
        Invoke-WebRequest -Uri $url -TimeoutSec 5 | Out-Null
    }
    & $node $lighthouse $url "--quiet" "--chrome-flags=--headless=new" "--only-categories=performance,accessibility,best-practices,seo" "--output=json" ("--output-path=" + (Join-Path $report "mobile-audit.json"))
    if ($LASTEXITCODE -ne 0) { throw "Lighthouse mobile audit failed." }
    & $node $lighthouse $url "--quiet" "--chrome-flags=--headless=new" "--only-categories=performance,accessibility,best-practices,seo" "--output=html" ("--output-path=" + (Join-Path $report "mobile-audit.html"))
    if ($LASTEXITCODE -ne 0) { throw "Lighthouse HTML report failed." }
    $data = Get-Content -LiteralPath (Join-Path $report "mobile-audit.json") -Raw | ConvertFrom-Json
    $data.categories.PSObject.Properties | ForEach-Object { Write-Output ("{0}: {1:N0}/100" -f $_.Name, ($_.Value.score * 100)) }
    Write-Output ("Reports: " + $report)
}
finally {
    if ($started) { Stop-Process -Id $started.Id -ErrorAction SilentlyContinue }
}


