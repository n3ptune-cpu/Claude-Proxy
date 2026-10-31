# Claude-Proxy

A small Node.js router that lets **Claude Code** run on a **locally hosted model** served by [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`. Claude Code speaks the Anthropic Messages API; the router translates each request to the OpenAI Chat Completions format that `llama-server` understands, and translates the answer (text, tool calls, reasoning) back.
I have used Claude Opus 5.5 to help me write the router code since I obviously don't know JavaScript.

<img width="1113" height="626" alt="Claude Code running on a local model" src="https://github.com/user-attachments/assets/8c34dc1d-7365-4aa6-bb63-064d31e888a6" />

```
Claude Code  --Anthropic API-->  router.js (:4000)  --OpenAI API-->  llama-server (127.0.0.1:8805/v1)
```

It is a single file with no dependencies. On top of the translation it does a few things that make a local model much faster to use with Claude Code (see [What the router does](#what-the-router-does)).

My setup runs on Windows (RTX 2080 Super 8 GB, 24 GB RAM, i7-8700K), so treat the configs here as a baseline and tune them for your system.

## Requirements

- **Windows** (the start scripts are PowerShell; the router itself also runs on Linux/macOS)
- **[Node.js](https://nodejs.org) 20.12 or newer** (22 LTS recommended). The router uses Node's built-in `.env` loader, which older versions don't have.
- **llama.cpp** release build from [GitHub releases](https://github.com/ggml-org/llama.cpp/releases). For NVIDIA cards take the Windows CUDA zip (`llama-<build>-bin-win-cuda-12.x-x64.zip`) plus the matching `cudart-llama-bin-win-cuda-12.x-x64.zip`, and unzip both into the same folder.
- **A GGUF model**, plus its **mmproj** GGUF if you want to paste images. The one that came closest to Claude on my hardware is a Qwen3.6-35B-A3B fine-tune (`qwen3.6-35b-a3b-claude-4.7-opus-reasoning-distilled-apex`).
- **[Claude Code](https://docs.claude.com/en/docs/claude-code)**
- Optional but recommended: a self-hosted [SearXNG](https://github.com/searxng/searxng) instance for web search

## Files

| File | What it is |
|---|---|
| `router.js` | The router |
| `.env.example` | Router settings template; copy to `.env` |
| `start-llama.ps1` | Starts `llama-server` with the flags below; edit the paths at the top |
| `start.ps1` / `start.bat` | Starts the router and `start-llama.ps1` in their own windows; Enter stops everything |
| `settings.json` | Example Claude Code settings |
| `claude.md` | Example `CLAUDE.md` for Windows |

## Setup

### 1. Get the files

Download or clone this repo into a folder, e.g. `C:\claude-proxy`. Unzip llama.cpp somewhere (e.g. `C:\llama.cpp`) and put the model GGUF (and mmproj) somewhere (e.g. `C:\models`).

### 2. Configure the router

Copy `.env.example` to `.env` in the same folder as `router.js` and set at least:

```ini
TARGET_BASE=http://127.0.0.1:8805/v1
LOCAL_MODEL=your-model-name
PROXY_KEY=PutYourGeneratedTokenHere
```

Generate the token with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The same token goes into Claude Code's settings in step 5. **Never commit `.env`**; it's in `.gitignore`.

### 3. Configure llama-server

Open `start-llama.ps1` and set `$llama` (folder with `llama-server.exe`), `$model`, and optionally `$mmproj`. Then go through the [flags](#llama-server-flags) and tune them for your GPU.

### 4. Start everything

Double-click `start-all.bat` (or run `start-all.ps1`). It opens one window for `llama-server` and one for the router. Press Enter in the launcher window to stop both.

You can also start them by hand: `.\start-llama.ps1` in one window, `node router.js` in another.

### 5. Point Claude Code at the router

Add this to Claude Code's `settings.json` (`~/.claude/settings.json`, or `C:\Users\<you>\.claude\settings.json` on Windows):

```json
{
  "model": "MODEL-GOES-HERE",
  "env": {
    "ANTHROPIC_BASE_URL": "http://ROUTER-IP:4000",
    "ANTHROPIC_AUTH_TOKEN": "GENERATED-TOKEN-GOES-HERE",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "25",
    "ENABLE_TOOL_SEARCH": "false"
  },
  "permissions": {
    "allow": [
      "PowerShell(Get-*)",
      "mcp__searxng__searxng_web_search",
      "mcp__searxng__web_url_read",
      "mcp__duckduckgo__duckduckgo_web_search"
    ],
    "deny": ["Agent", "WebSearch"]
  }
}
```

- `ANTHROPIC_BASE_URL` is the router, not llama-server. On the same PC use `http://127.0.0.1:4000`.
- `ANTHROPIC_AUTH_TOKEN` must equal `PROXY_KEY` in `.env`.
- `model` can be any name; the router always uses `LOCAL_MODEL`. The yellow "model isn't recognized" warning is harmless.
- `CLAUDE_CODE_ATTRIBUTION_HEADER: "0"` keeps Claude Code's attribution header out of the system prompt so the prompt stays the same between requests (good for the cache).
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` makes Claude Code compact earlier, because it assumes a 200K context. Lower it if you run a smaller `-c`.
- `ENABLE_TOOL_SEARCH: "false"` loads the MCP tools up front. Without it they can stay hidden and the model claims it has no search.
- `Agent` and `WebSearch` are denied because they don't work with a local model.
- On Linux, swap `PowerShell(Get-*)` for read-only `Bash(...)` rules such as `Bash(ls:*)`, `Bash(cat:*)` and `Bash(grep:*)`.

### 6. Add web search

Claude Code's built-in web search doesn't work with local models, so search goes through MCP servers. Public search engines rate-limit quickly, so self-host SearXNG with the JSON format enabled, and keep DuckDuckGo as a fallback.

Windows (npm commands need a `cmd /c` wrapper):

```bat
npm install -g mcp-searxng
claude mcp add -s user searxng -e SEARXNG_URL=http://SEARXNG-IP:8888 -- cmd /c mcp-searxng
claude mcp add -s user duckduckgo -- cmd /c npx -y duckduckgo-mcp-server
claude mcp list
```

Linux / macOS: the same commands without `cmd /c`.

Both should show **Connected**. The model can only call a search tool once `/mcp` shows it connected, so give it a moment after starting Claude Code.

### 7. Add a CLAUDE.md

`CLAUDE.md` tells the model what environment it's in (Windows/PowerShell or Linux/bash), which tools to use for search, and rules that keep a smaller model honest: check before stating things, only report real command output, and don't guess tool names or URLs. Put it in `~/.claude/CLAUDE.md` to apply it everywhere. The `claude.md` in this repo is written for Windows. Keep it short and don't change it often: it is part of the prompt prefix, and every change means one full re-read of the prompt.

## Router settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Port the router listens on |
| `HOST` | `0.0.0.0` | Address to listen on. `0.0.0.0` = all interfaces; `127.0.0.1` = this PC only; a Tailscale IP = tailnet only |
| `TARGET_BASE` | `http://localhost:8805/v1` | llama-server's OpenAI endpoint. Use `127.0.0.1` rather than `localhost` (see Troubleshooting) |
| `LOCAL_MODEL` | (required) | Model name sent upstream and shown in Claude Code. llama-server serves one model, so any label works |
| `PROXY_KEY` | empty (auth off) | Shared secret; must equal Claude Code's `ANTHROPIC_AUTH_TOKEN` |
| `PUBLIC_PATHS` | `/api/hello,/health` | Paths answered with 200 without auth (Claude Code's startup ping) |
| `DEBUG` | off | `1` = log raw upstream payloads |
| `PING_MS` | `5000` | Heartbeat interval while the model reads the prompt, so Claude Code doesn't time out |
| `TOOL_SUPERSET` | on | `0` = send only the tools of each request (see below) |
| `SHOW_PROGRESS` | on | `0` = no "Loading model / Reading prompt" status in the thinking block |
| `LOAD_WAIT_MS` | `600000` | How long a request waits for llama-server to finish loading the model (ms) |
| `HEALTH_URL` | `TARGET_BASE` without `/v1` + `/health` | Polled while waiting for the model |
| `AUTO_SAVE` | on | `0` = don't save cache snapshots |
| `AUTO_RESTORE` | on | `0` = don't restore the snapshot on start / after a llama-server restart |
| `SLOT_FILE` | `warm.bin` | Snapshot file name (a name, not a path; it lives in llama-server's `--slot-save-path` folder) |
| `AUTO_SAVE_MIN_TOKENS` | `8000` | Snapshots smaller than this are not kept |
| `DATA_DIR` | `router-data` | Folder for the router's own files (relative to `router.js`) |

## What the router does

**Translation.** Anthropic messages, tool definitions, tool calls/results and images are converted to OpenAI format and back. The model's reasoning (`reasoning_content`) is shown as Claude Code's thinking block. Thinking blocks are never sent back upstream, so they don't change the prompt.

**Stable prompt prefix (tool superset).** llama-server can reuse its cache only for the part of the prompt that is identical to last time, and the tool list sits at the very start. Claude Code usually sends its first message before the MCP servers have connected (say 25 tools) and the next one with all of them (say 57). That changes the start of the prompt, so the whole prompt (~30k tokens with Claude Code's system prompt and tools) has to be read again. On hybrid models like Qwen3.6-35B-A3B this is especially costly, because their recurrent state can't be partially reused. The router therefore remembers every tool it has seen (`router-data/known-tools.json`), always sends all of them, and keeps them in a fixed order (built-ins first, then `mcp__*` sorted by name). If the model calls a remembered tool that isn't connected yet, Claude Code just answers that the tool is unknown. To forget the remembered tools: stop the router, delete `known-tools.json`, start it.

**Progress in the thinking block.** While llama-server reads the prompt, the router streams lines like `Reading prompt: 8,192 / 30,197 tokens (27%), 2,048 from cache, ~70 s left` into a thinking block, followed by the model's own reasoning. Press **Ctrl+O** in Claude Code to see it.

**Waits while the model loads.** If llama-server isn't listening yet or answers `503 Loading model`, the router polls `/health` and shows `Loading model... N s` instead of failing. You can start the router and send a message before the model is loaded.

**Automatic cache snapshot and restore.** After an answer whose prompt prefix (system text + tools) differs from the last snapshot, the router asks llama-server to save slot 0 to `SLOT_FILE`. When the router starts, or after llama-server was restarted, it restores that file before the first request, so the first message after a restart starts warm instead of re-reading ~30k tokens. This needs `--slot-save-path` on llama-server; without it the router says so once and carries on.

**Fingerprint log.** For each request with tools, the router writes hashes of the system text and tool list to `router-data/prompt-fingerprints.log`. When either changes it prints a yellow `prompt prefix changed` line showing where the old and new versions differ, and keeps both versions (`last-*` / `prev-*`) so you can diff them.

### `router-data/`

| File | Contents |
|---|---|
| `known-tools.json` | Every tool seen so far (tool superset) |
| `snapshot.json` | Which prompt prefix the last saved snapshot holds |
| `prompt-fingerprints.log` | One line per request: system/tools hashes, and what changed |
| `last-N-system.txt`, `last-N-tools.json`, `prev-N-*` | The last two different versions of the system text and tools, per tool count N |
| `slots\` | Snapshot files (only if `start-llama.ps1` keeps its default `$slots`) |

It's all safe to delete while the router is stopped; it is rebuilt on the next run.

## llama-server flags

`start-llama.ps1` runs:

```
llama-server -m <model.gguf> [--mmproj <mmproj.gguf> --no-mmproj-offload]
  -c 131072 -ngl 99 --n-cpu-moe 29 -fa on -ctk q8_0 -ctv q8_0 -t 6 --jinja -np 1
  --cache-ram 4096 --ctx-checkpoints 32 --load-mode mmap+mlock
  --temp 1.0 --top-k 20 --top-p 0.95 --min-p 0 --reasoning-budget 8192
  --slot-save-path <slots folder> --host 127.0.0.1 --port 8805
```

These values are for an **8 GB GPU + 24 GB RAM** (RTX 2080 Super, i7-8700K) with Qwen3.6-35B-A3B. Tune them for your hardware.

| Flag | Why |
|---|---|
| `-c 131072` | Context length. Claude Code's system prompt and tools alone are ~20-30K tokens, so use at least 32K, ideally 64K or more |
| `-ngl 99` | Put all layers on the GPU (the MoE experts are then moved back with `--n-cpu-moe`) |
| `--n-cpu-moe 29` | Keep the expert weights of the first N layers in system RAM. Lower it until VRAM is nearly full without spilling into shared GPU memory |
| `-fa on` | Flash attention: less VRAM, and needed for a quantized V cache |
| `-ctk q8_0 -ctv q8_0` | 8-bit KV cache: about half the memory of f16 with little quality loss |
| `-t 6` | CPU threads; use your physical core count |
| `--jinja` | Use the model's own chat template; needed for tool calling and reasoning |
| `-np 1` | One slot: the whole context goes to one conversation, and the router's snapshot/restore works on slot 0 |
| `--cache-ram 4096` | Keep up to 4 GB (MiB value) of prompt cache in RAM, so a side request (e.g. Claude Code's title generation) doesn't throw away the main conversation's cache |
| `--ctx-checkpoints 32` | Checkpoints per slot. Hybrid models can't roll their cache back to an arbitrary point, so llama-server goes back to the nearest checkpoint instead of re-reading from the start |
| `--load-mode mmap+mlock` | Map the model file and lock it in RAM so Windows doesn't page it out |
| `--temp 1.0 --top-k 20 --top-p 0.95 --min-p 0` | Sampling settings; use what your model's card recommends |
| `--reasoning-budget 8192` | Cap the thinking length, so the model can't think for minutes before acting |
| `--no-mmproj-offload` | Keep the vision projector on the CPU to leave VRAM for the model and context. Only added when `$mmproj` is set |
| `--slot-save-path` | Folder for slot snapshots. Required for the router's auto snapshot/restore |
| `--host 127.0.0.1 --port 8805` | Only the router talks to llama-server. Must match `TARGET_BASE` |

## Using it from another PC

The router can serve Claude Code on other machines, e.g. a laptop over [Tailscale](https://tailscale.com):

- Keep `PROXY_KEY` set.
- Set `HOST` to the router PC's Tailscale IP (only reachable over the tailnet) or leave `0.0.0.0`. With a Tailscale IP, Tailscale must be up before the router starts.
- Allow the port in Windows Firewall on the router PC (admin PowerShell):
  `New-NetFirewallRule -DisplayName "Claude-Proxy" -Direction Inbound -Protocol TCP -LocalPort 4000 -RemoteAddress 100.64.0.0/10 -Action Allow`
- On the other PC, use the same `settings.json` with `ANTHROPIC_BASE_URL` set to `http://<router-pc-tailscale-ip>:4000`.

llama-server itself stays on `127.0.0.1`; only the router is exposed. With `-np 1`, two clients share one slot, so they will evict each other's cache.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Second message re-reads the whole prompt (slow) | The prompt prefix changed. Check the router window for `prompt prefix changed` and `router-data/prompt-fingerprints.log`; it shows whether the system text or the tools changed and where. Common causes: editing `CLAUDE.md`, an MCP server added or removed, `TOOL_SUPERSET=0` |
| Slow overall, GPU memory in Task Manager spilling into "Shared GPU memory" | VRAM is full. Use `--no-mmproj-offload`, lower `-c`, or raise `--n-cpu-moe`. In NVIDIA Control Panel, "CUDA - Sysmem Fallback Policy: Prefer No Sysmem Fallback" makes it fail loudly instead of slowing down |
| `Loading model...` in the thinking block | Normal: llama-server is still loading (it answers 503), and the router waits up to `LOAD_WAIT_MS` |
| Router waits forever although llama-server is up | `TARGET_BASE` uses `localhost`, which can resolve to IPv6 `::1` while llama-server listens on `127.0.0.1`. Use `127.0.0.1` |
| `LOCAL_MODEL is not set` | No `.env` next to `router.js`, or Node older than 20.12 (can't read `.env`) |
| `auto snapshot off for this run ... --slot-save-path` | llama-server was started without `--slot-save-path` |
| 401 in the router window | `ANTHROPIC_AUTH_TOKEN` doesn't match `PROXY_KEY` |
| Error that the request exceeds the context size | Raise `-c`, or lower `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` so Claude Code compacts earlier |
| Model invents tools or commands | Context too small, or a weak model/quant |
| "I don't have search access" | MCP servers not connected yet, `ENABLE_TOOL_SEARCH` missing, or no CLAUDE.md telling it to search |
| Search returns 403 or empty pages | The site blocks plain HTTP fetches; the model should try another result |

Never commit your `.env`: it holds your `PROXY_KEY`.
