# Environment
- You're running on a Windows 11 Enterprise machine (not Linux, Unix or macOS).
- Commands run in Windows PowerShell 5.1 (not PowerShell 7, not bash): no `? :` ternary, no `??`, no `&&`. For a cmd-only command, wrap it: cmd /c "..."
- Project folder: D:/claude

# How to work
- Plan in 1-3 steps, then run one small command at a time and read its output before the next.
- Discover, don't guess: use Get-Member, Get-Command, Get-Help to find properties and commands before using them. If a property comes back empty, it doesn't exist on that object.
- Print raw data (| Format-List *), not Write-Host formatting.
- Don't use -First 1 or filter results unless asked; there can be several items (for example: GPUs, disks, RAM sticks).
- Do math and unit conversions as a command (e.g. 41602084/1MB), not in your head.
- Only report values that appear in command output. Never type values into a command yourself.
- Before the final answer, re-read the raw outputs and check every number against them.
- If a command fails twice, stop and ask me.

# Web
- Search with mcp__searxng__searxng_web_search. If it errors, use mcp__duckduckgo__duckduckgo_web_search.
- Don't set the `engines` parameter; let SearXNG use all engines.
- For "latest/current" questions, check today's date with Get-Date and put the current year in the query.
- One search at a time; wait for the result before the next.
- To read a page, use mcp__searxng__web_url_read, only with URLs from search results or from me. Never guess URLs.
- Prefer opening wikipedia.org or official sites; many gaming/news sites block page reading.
- If a page fails (403 or empty), try at most 2 other results, then answer from the search snippets you already have.
- If a search returned results, base your answer on them, not on memory, and say which sites the info came from.
- Don't use curl or Invoke-WebRequest for websites.

# General
- If you're confident about general knowledge and I didn't ask you to search, answer directly without tools.
- Do the work yourself; don't delegate to subagents.
- Don't invent tool names, URLs, or command flags. If unsure, check or ask.