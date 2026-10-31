# start-llama.ps1 - starts llama.cpp's llama-server for Claude-Proxy.
#
# The values below are for an 8 GB GPU + 24 GB RAM (RTX 2080 Super, i7-8700K) running Qwen3.6-35B-A3B.
# Tune them for your hardware; the README explains each flag.

# ---------- edit these ----------
$llama  = 'C:\llama.cpp'                          # folder with llama-server.exe (unzipped llama.cpp release)
$model  = 'C:\models\your-model.gguf'             # the model GGUF
$mmproj = ''                                      # optional vision projector GGUF for images,
                                                  # e.g. 'C:\models\mmproj-F16.gguf'; leave '' for none
$slots  = Join-Path $PSScriptRoot 'router-data\slots'  # cache snapshots (--slot-save-path); can be large
$port   = 8805                                    # must match TARGET_BASE in .env (http://127.0.0.1:8805/v1)

# ---------- checks ----------
$exe = Join-Path $llama 'llama-server.exe'
if (-not (Test-Path -LiteralPath $exe))   { Write-Host "llama-server.exe not found in $llama - edit `$llama in $PSCommandPath" -ForegroundColor Red; exit 1 }
if (-not (Test-Path -LiteralPath $model)) { Write-Host "Model not found: $model - edit `$model in $PSCommandPath" -ForegroundColor Red; exit 1 }
if (-not (Test-Path -LiteralPath $slots)) { New-Item -ItemType Directory -Path $slots -Force | Out-Null }

# ---------- flags ----------
$llamaArgs = @(
    '-m', $model,
    '-c', '131072',             # context length; Claude Code needs 32K+ (its prompt + tools are ~20-30K)
    '-ngl', '99',               # all layers on the GPU...
    '--n-cpu-moe', '29',        # ...except the MoE experts of the first N layers (in RAM). Lower N until VRAM
                                #    is nearly full without spilling into "Shared GPU memory"
    '-fa', 'on',                # flash attention (needed for the quantized V cache)
    '-ctk', 'q8_0',             # 8-bit KV cache, about half the memory of f16
    '-ctv', 'q8_0',
    '-t', '6',                  # CPU threads = physical cores
    '--jinja',                  # model's own chat template (tool calls, reasoning)
    '-np', '1',                 # one slot; the router snapshots/restores slot 0
    '--cache-ram', '4096',      # MiB of prompt cache kept in RAM (side requests don't wipe the main cache)
    '--ctx-checkpoints', '32',  # checkpoints per slot (hybrid models roll back to these instead of re-reading)
    '--load-mode', 'mmap+mlock', # keep the model locked in RAM
    '--temp', '1.0',            # sampling: use your model card's recommendation
    '--top-k', '20',
    '--top-p', '0.95',
    '--min-p', '0',
    '--reasoning-budget', '8192', # max thinking tokens per answer
    '--slot-save-path', $slots, # needed for the router's auto snapshot/restore
    '--host', '127.0.0.1',      # only the router talks to llama-server
    '--port', "$port"
)

# Image support: only when $mmproj is set and exists. --no-mmproj-offload keeps the projector on the CPU,
# leaving VRAM for the model and context (remove it if you have VRAM to spare).
if ($mmproj) {
    if (Test-Path -LiteralPath $mmproj) {
        $llamaArgs += @('--mmproj', $mmproj, '--no-mmproj-offload')
    } else {
        Write-Host "mmproj not found: $mmproj - starting without image support" -ForegroundColor Yellow
    }
}

$Host.UI.RawUI.WindowTitle = 'llama-server'
Write-Host "$exe $($llamaArgs -join ' ')" -ForegroundColor DarkGray
& $exe @llamaArgs
