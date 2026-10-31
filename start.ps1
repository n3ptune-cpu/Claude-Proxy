# start-all.ps1 - starts llama-server (via start-llama.ps1) and the router in their own windows,
# plus Caffeinate.ps1 (keeps the PC awake) if it is next to this script.
# Press Enter in this window to stop everything.

# ---------- edit these ----------
$llamaScript = Join-Path $PSScriptRoot 'start-llama.ps1'  # llama-server start script
$caffeinate  = $true                                      # $false = let the PC sleep as usual

# ---------- start ----------
$routerDir = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $routerDir 'router.js'))) { Write-Host "router.js not found in $routerDir" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
if (-not (Test-Path -LiteralPath $llamaScript)) { Write-Host "Not found: $llamaScript - edit `$llamaScript in $PSCommandPath" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'node not found - install Node.js 20.12 or newer' -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

$Host.UI.RawUI.WindowTitle = 'Claude-Proxy'
$procs = @()

# llama-server first: loading the model takes a while, and the router waits for it anyway.
# -NoExit keeps the window open if llama-server stops with an error.
$procs += Start-Process powershell.exe -PassThru -WorkingDirectory (Split-Path -Parent $llamaScript) `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$llamaScript`""

$procs += Start-Process cmd.exe -PassThru -WorkingDirectory $routerDir `
    -ArgumentList '/k', 'title Claude-Proxy router & node router.js'

$caffeinateScript = Join-Path $PSScriptRoot 'Caffeinate.ps1'
if ($caffeinate -and (Test-Path -LiteralPath $caffeinateScript)) {
    $procs += Start-Process powershell.exe -PassThru -WindowStyle Minimized -WorkingDirectory $PSScriptRoot `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$caffeinateScript`""
}

Write-Host ''
Write-Host 'llama-server and the router are starting in their own windows.'
try {
    Read-Host 'Press Enter here to stop both' | Out-Null
} finally {
    # also runs on Ctrl+C; /T kills each window's child processes (llama-server.exe, node.exe)
    foreach ($p in $procs) {
        if (-not $p.HasExited) { taskkill.exe /T /F /PID $p.Id | Out-Null }
    }
    Write-Host 'Stopped.'
}
