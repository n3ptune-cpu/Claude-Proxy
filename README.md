# Claude-Proxy

A small Node.js router that lets **Claude Code** run on **locally hosted models**. It translates Claude Code's Anthropic API requests into the OpenAI format, so any OpenAI-compatible server (LM Studio, llama.cpp server, etc.) can sit behind it.
I have used Claude Opus 5.5 to help me write the router code since I obviously don't know JavaScript.

<img width="1113" height="626" alt="Claude Code running on a local model" src="https://github.com/user-attachments/assets/7dc7974a-3ab7-41b4-b00f-8cee92980f17" />

```
Claude Code  ──Anthropic API──▶  router.js (:4000)  ──OpenAI API──▶  LM Studio (:8805/v1)
```

My setup runs on Windows, so treat the configs here as a baseline and adjust them for your system.

## What you need

- [LM Studio](https://lmstudio.ai) (or any OpenAI-compatible server)
- [Node.js](https://nodejs.org)
- [Claude Code](https://docs.claude.com/en/docs/claude-code)
- Optional but recommended: a self-hosted [SearXNG](https://github.com/searxng/searxng) instance for web search

## Model

The model that came closest to Claude on my hardware (RTX 2080 Super 8 GB, 24 GB RAM, i7-8700K  is `qwen3.6-35b-a3b-claude-4.7-opus-reasoning-distilled-apex`. I'm not sharing my exact model settings because they depend on your hardware, but these are to take into consideration:

- **Context length of at least 32K, ideally 64K.** Claude Code's system prompt and tool list alone are about 20K tokens.
- **Turn off "Truncate Middle"** (context overflow). It silently cuts Claude Code's prompt, and the model starts inventing tools and commands.
- **MoE models:** use LM Studio's "force MoE weights onto CPU" setting and lower it until VRAM is nearly full without spilling into shared GPU memory.
- **Save the settings as the model's default**, so they're used however the model gets loaded.

## Setup

### 1. Start the model server

Start LM Studio's server (GUI or `lms server start`) and note its address. Mine runs on `http://localhost:8805/v1`.

### 2. Configure the router

Create a `.env` file in the same folder as `router.js`:

```ini
# Server
PORT=4000
HOST=0.0.0.0

# LM Studio, or any OpenAI-compatible server
TARGET_BASE=http://localhost:8805/v1
LOCAL_MODEL=qwen3.6-35b-a3b-claude-4.7-opus-reasoning-distilled-apex

# Auth: must match ANTHROPIC_AUTH_TOKEN in Claude Code's settings. Leave empty to disable.
PROXY_KEY=PutYourGeneratedTokenHere

# Paths that skip auth (comma separated)
PUBLIC_PATHS=/api/hello,/health

# 1 = print raw upstream payloads
DEBUG=1
```

It is important to also generate the token to have auth, so do this you need to run:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
This token will also be the same token used for step 3.

Then start it with `node router.js`.

### 3. Point Claude Code at the router

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

- `ENABLE_TOOL_SEARCH: "false"` loads the MCP tools up front. Without it they can stay hidden and the model claims it has no search.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` compacts earlier, because Claude Code assumes a 200K context. The yellow "model isn't recognized" warning is harmless.
- `Agent` and `WebSearch` are denied because they don't work with a local model.
- On Linux, swap `PowerShell(Get-*)` for read-only `Bash(...)` rules such as `Bash(ls:*)`, `Bash(cat:*)` and `Bash(grep:*)`.

### 4. Add web search

Claude Code's built-in web search doesn't work with local models, so search goes through MCP servers. Public search engines rate-limit quickly, so self-host SearXNG with the JSON format enabled, and keep DuckDuckGo as a fallback.

Linux / macOS:

```bash
npm install -g mcp-searxng
claude mcp add -s user searxng -e SEARXNG_URL=http://SEARXNG-IP:8888 -- mcp-searxng
claude mcp add -s user duckduckgo -- npx -y duckduckgo-mcp-server
claude mcp list
```

Windows (npm commands need a `cmd /c` wrapper):

```bat
npm install -g mcp-searxng
claude mcp add -s user searxng -e SEARXNG_URL=http://SEARXNG-IP:8888 -- cmd /c mcp-searxng
claude mcp add -s user duckduckgo -- cmd /c npx -y duckduckgo-mcp-server
claude mcp list
```

Both should show **Connected**. After starting Claude Code, wait until `/mcp` shows them connected before your first prompt.

### 5. Add a CLAUDE.md

`CLAUDE.md` tells the model what environment it's in (Windows/PowerShell or Linux/bash), which tools to use for search, and rules that keep a smaller model honest: check before stating things, only report real command output, and don't guess tool names or URLs. Put it in `~/.claude/CLAUDE.md` to apply it everywhere. The one in this repo is written for Windows.

## Extras

- `start.bat` starts the LM Studio server, the router and `Caffeinate.ps1` in one window, with an `lms log stream` window beside it. Press any key in the main window to shut everything down.
- `Caffeinate.ps1` keeps the host from sleeping while the model is in use.

Both are just my preferences, so change them to suit your setup.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Model invents tools or commands | Context too small, or "Truncate Middle" is on |
| "I don't have search access" | MCP servers not connected yet, `ENABLE_TOOL_SEARCH` missing, or no CLAUDE.md telling it to search |
| Search returns 403 or empty pages | The site blocks plain HTTP fetches; the model should try another result |
| Slow responses | VRAM spilling into shared GPU memory, or MoE layers that could be on the GPU are on the CPU |

<img width="1903" height="210" alt="image" src="https://github.com/user-attachments/assets/cd5f9be6-92d3-4111-9630-29670aca6a0a" />
