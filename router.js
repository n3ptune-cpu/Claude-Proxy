// Anthropic Messages API  ->  OpenAI Chat Completions (llama.cpp llama-server) proxy
// Node 18+ (uses built-in fetch). No dependencies.

try { process.loadEnvFile(); } catch { /* no .env file, use real environment */ }

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';          // set to your Tailscale IP to avoid listening on LAN
const TARGET_BASE = process.env.TARGET_BASE || 'http://localhost:8805/v1';
const LOCAL_MODEL = process.env.LOCAL_MODEL;
const PROXY_KEY = process.env.PROXY_KEY || '';        // optional shared secret (Claude Code's ANTHROPIC_AUTH_TOKEN)
const DEBUG = process.env.DEBUG === '1';
const PING_MS = Number(process.env.PING_MS || 5000); // heartbeat interval while the model is thinking
// Paths answered with 200 before the auth check (Claude Code's startup ping hits /api/hello)
const PUBLIC_PATHS = (process.env.PUBLIC_PATHS || '/api/hello,/health')
  .split(',').map((p) => p.trim()).filter(Boolean);
// llama-server's own endpoints (/health, /slots) live at TARGET_BASE without /v1
const SERVER_BASE = TARGET_BASE.replace(/\/+$/, '').replace(/\/v1$/, '');
// llama-server health endpoint (used to wait while the model loads)
const HEALTH_URL = process.env.HEALTH_URL || `${SERVER_BASE}/health`;
const LOAD_WAIT_MS = Number(process.env.LOAD_WAIT_MS || 10 * 60 * 1000); // max wait for the model to load
const SHOW_PROGRESS = process.env.SHOW_PROGRESS !== '0'; // set SHOW_PROGRESS=0 to turn off the "thinking" status block
const THINKING_SIGNATURE = 'llama-cpp-local'; // dummy; thinking blocks are never sent upstream, so it is never checked
// Tool superset: always send every tool seen so far (remembered in router-data/known-tools.json), so the tool list,
// and with it the prompt prefix, does not change when MCP servers connect after the first message.
// TOOL_SUPERSET=0 turns it off. To forget the remembered tools: stop the router, delete
// router-data/known-tools.json, start it.
const TOOL_SUPERSET = process.env.TOOL_SUPERSET !== '0';
// Folder for every file the router writes (known-tools.json, prompt-fingerprints.log, last-*/prev-* diff files).
// Default: router-data/ next to router.js. DATA_DIR overrides it (a relative path is relative to router.js).
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || 'router-data');
// Automatic cache snapshot: after an answer whose prompt prefix (system text + tools) differs from the last
// snapshot, ask llama-server to save slot 0 to SLOT_FILE (needs --slot-save-path), so a restart that restores
// it starts warm. AUTO_SAVE=0 turns it off. Results below AUTO_SAVE_MIN_TOKENS cached tokens are not accepted.
const AUTO_SAVE = process.env.AUTO_SAVE !== '0';
const SLOT_FILE = process.env.SLOT_FILE || 'warm.bin';
const AUTO_SAVE_MIN_TOKENS = Number(process.env.AUTO_SAVE_MIN_TOKENS || 8000);
const SAVE_TIMEOUT_MS = 30 * 1000;
// Automatic restore: before the first request after the router starts, and after llama-server was seen loading
// or not running (a restart), load SLOT_FILE back into slot 0 so the first prompt starts warm. AUTO_RESTORE=0
// turns it off (e.g. if your start script restores the file itself).
const AUTO_RESTORE = process.env.AUTO_RESTORE !== '0';
const RESTORE_TIMEOUT_MS = 60 * 1000;

if (!LOCAL_MODEL) {
  console.error('LOCAL_MODEL is not set. Add it to .env, e.g. LOCAL_MODEL=your-model-name');
  process.exit(1);
}

// ---------- logging ----------
const C = { dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };
const ts = () => new Date().toLocaleTimeString('en-GB');
const info = (rid, color, msg) => console.log(`${C.dim}${ts()}${C.reset} ${C.dim}#${rid}${C.reset} ${color}${msg}${C.reset}`);
const log = (...a) => DEBUG && console.log(C.dim + ts(), ...a, C.reset); // verbose, only with DEBUG=1
let reqCounter = 0;

function describeRequest(p) {
  const msgs = p.messages || [];
  const last = msgs[msgs.length - 1];
  let lastDesc = '-';
  if (last) {
    const blocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
    const results = blocks.filter((b) => b.type === 'tool_result').length;
    lastDesc = results ? `${last.role}: ${results} tool_result(s)` : `${last.role}: text`;
  }
  const chars = JSON.stringify([p.system, p.messages, p.tools]).length;
  return `${msgs.length} msgs, ${(p.tools || []).length} tools, ~${Math.round(chars / 3.5)} tok in, max_tokens ${p.max_tokens || '-'}, stream=${!!p.stream}, last=[${lastDesc}]`;
}

// ---------- helpers ----------
const textOf = (c) =>
  typeof c === 'string' ? c : (c || []).map((b) => (b.type === 'text' ? b.text : '')).join('');

// Anthropic image block -> OpenAI image_url part (null if not an image / unsupported source)
const imagePart = (b) => {
  const s = b.type === 'image' && b.source;
  const url = s?.type === 'base64' ? `data:${s.media_type};base64,${s.data}` : s?.type === 'url' ? s.url : null;
  return url ? { type: 'image_url', image_url: { url } } : null;
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const sendError = (res, status, message, type = 'api_error') =>
  sendJson(res, status, { type: 'error', error: { type, message } });

const STOP_REASONS = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use' };

const num = (n) => Number(n || 0).toLocaleString('en-US');
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// ---------- prompt fingerprints (why does the prompt cache miss between sessions?) ----------
// For every /v1/messages request with tools: log hashes of the final system text and tools, keep the
// last two DIFFERENT versions per tool count in DATA_DIR (last-N-*, prev-N-*), and print where they differ.
const FP_LOG = path.join(DATA_DIR, 'prompt-fingerprints.log');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const firstDiff = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const around = (s, i) => JSON.stringify(s.slice(Math.max(0, i - 50), i + 100));

function fingerprint(rid, p, body) {
  try {
    if (!body.tools?.length) return;
    const n = body.tools.length; // tools actually sent (with the superset this can be more than the request had)
    const cur = (p.tools || []).length;
    const sys = body.messages[0]?.role === 'system' ? String(body.messages[0].content) : '';
    const tools = JSON.stringify(body.tools, null, 2);
    const inner = (p.messages || []).filter((m) => m.role === 'system').length;
    const files = [['system', sys, 'txt'], ['tools', tools, 'json']].map(([kind, text, ext]) => {
      const last = path.join(DATA_DIR, `last-${n}-${kind}.${ext}`);
      let old = null;
      try { old = fs.readFileSync(last, 'utf8'); } catch { /* first time */ }
      return { kind, text, last, prev: path.join(DATA_DIR, `prev-${n}-${kind}.${ext}`), old };
    });
    const changed = files.filter((f) => f.old !== null && f.old !== f.text);
    const lines = [`${new Date().toISOString()} #${rid} tools=${cur === n ? n : `${cur}->${n}`} msgs=${body.messages.length} ` +
      `system=${sha(sys)} (${sys.length} chars, ${inner} system msg(s) merged from messages) tools=${sha(tools)}` +
      (changed.length ? ` CHANGED: ${changed.map((f) => f.kind).join('+')}` : '')];
    for (const f of changed) {
      const at = firstDiff(f.old, f.text);
      lines.push(`  ${f.kind} differs from previous ${n}-tool request at char ${at}:`,
        `    old: ${around(f.old, at)}`, `    new: ${around(f.text, at)}`);
    }
    fs.appendFileSync(FP_LOG, lines.join('\n') + '\n');
    if (changed.length) {
      info(rid, C.yellow, `prompt prefix changed (${changed.map((f) => f.kind).join('+')}), cache will be re-read from there:\n${lines.slice(1).join('\n')}`);
      for (const f of files) if (f.old !== null) fs.copyFileSync(f.last, f.prev); // rotate the pair
    }
    for (const f of files) if (f.old !== f.text) fs.writeFileSync(f.last, f.text);
    log(`fingerprint system=${sha(sys)} tools=${sha(tools)}`);
  } catch (e) {
    info(rid, C.dim, `(fingerprint skipped: ${e.message})`);
  }
}

// ---------- automatic cache snapshot (llama-server slot save) ----------
// DATA_DIR/snapshot.json remembers which prompt prefix the last good snapshot holds:
// {prefixHash, savedAt, n_saved}. A new snapshot is only needed when the prefix changes.
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const SAVE_URL = `${SERVER_BASE}/slots/0?action=save`;
const RESTORE_URL = `${SERVER_BASE}/slots/0?action=restore`;
let snapshot = null;          // contents of snapshot.json
let saving = false;           // a save request is in flight
let saveDisabled = !AUTO_SAVE; // set for the rest of this run when llama-server refuses to save
let inFlight = 0;             // /v1/messages requests currently being answered
let restoreDisabled = !AUTO_RESTORE; // set for the rest of this run when llama-server refuses to restore
let needRestore = true;       // slot 0 may be empty: router just started, or llama-server was seen (re)loading
let noSnapshotFile = false;   // last restore found no usable SLOT_FILE; don't try again until the next save
let restoring = null;         // promise of the restore in flight (concurrent requests wait for the same one)

// sha1 of the final system text + tools JSON exactly as sent upstream
function prefixHash(body) {
  const sys = body.messages[0]?.role === 'system' ? String(body.messages[0].content) : '';
  return crypto.createHash('sha1').update(sys).update('\0').update(JSON.stringify(body.tools || [])).digest('hex');
}

function loadSnapshot() {
  try {
    const s = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (s && typeof s.prefixHash === 'string') snapshot = s;
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(`${C.yellow}snapshot.json could not be read (${e.message}), the next answer will save a new snapshot${C.reset}`);
  }
}

function writeSnapshot(rid, s) {
  try {
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch (e) {
    info(rid, C.yellow, `(could not write snapshot.json: ${e.message})`);
  }
  snapshot = s; // remember it for this run even if the file could not be written
}

// Called after a successful streaming answer with tools (the client response has already ended).
// Fire-and-forget: never throws, never blocks the request.
async function maybeSaveSnapshot(rid, hash, promptTokens) {
  if (saveDisabled || saving || hash === snapshot?.prefixHash) return;
  if (inFlight > 0) {
    info(rid, C.dim, `snapshot postponed (another request is running), will retry next answer`);
    return;
  }
  if (promptTokens && promptTokens < AUTO_SAVE_MIN_TOKENS) {
    // too small to be worth it, and saving would overwrite a good snapshot file with a small one
    info(rid, C.dim, `snapshot skipped (only ${num(promptTokens)} tokens in cache), will retry next answer`);
    return;
  }
  saving = true;
  const started = Date.now();
  const t = new AbortController();
  const timer = setTimeout(() => t.abort(), SAVE_TIMEOUT_MS);
  try {
    const r = await fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: SLOT_FILE }),
      signal: t.signal,
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok || data?.error || typeof data?.n_saved !== 'number') {
      saveDisabled = true;
      if (r.status === 501) restoreDisabled = true; // no --slot-save-path: restore cannot work either
      const msg = (data?.error?.message || text || '').replace(/\s+/g, ' ').slice(0, 200);
      info(rid, C.yellow, `auto snapshot off for this run: llama-server answered ${r.status} to ${SAVE_URL}` +
        (msg ? ` (${msg})` : '') + `. Add --slot-save-path <folder> to the llama-server command to enable it.`);
      return;
    }
    noSnapshotFile = false; // the file exists now
    needRestore = false;    // slot 0 holds what was just saved
    if (data.n_saved < AUTO_SAVE_MIN_TOKENS) {
      info(rid, C.dim, `snapshot skipped (only ${num(data.n_saved)} tokens in cache), will retry next answer`);
      return;
    }
    writeSnapshot(rid, { prefixHash: hash, savedAt: new Date().toISOString(), n_saved: data.n_saved });
    const secs = (data.timings?.save_ms ?? Date.now() - started) / 1000;
    const mb = (data.n_written || 0) / (1024 * 1024);
    info(rid, C.green, `saved cache snapshot ${SLOT_FILE} (${num(data.n_saved)} tokens, ${mb.toFixed(0)} MB, ${secs.toFixed(1)} s)`);
  } catch (e) {
    const why = t.signal.aborted ? `no answer after ${SAVE_TIMEOUT_MS / 1000} s` : e.message;
    info(rid, C.yellow, `snapshot save failed (${why}), will retry next answer`);
  } finally {
    clearTimeout(timer);
    saving = false;
  }
}

// Load SLOT_FILE into slot 0. Leaves needRestore set only when llama-server is not ready yet (the request
// will then wait for the model and call this again). Never throws.
async function restoreSnapshot(rid) {
  const started = Date.now();
  const t = new AbortController();
  const timer = setTimeout(() => t.abort(), RESTORE_TIMEOUT_MS);
  try {
    const r = await fetch(RESTORE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: SLOT_FILE }),
      signal: t.signal,
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    const msg = (data?.error?.message || text || '').replace(/\s+/g, ' ').slice(0, 200);
    if (r.ok && typeof data?.n_restored === 'number') {
      needRestore = false;
      const secs = (data.timings?.restore_ms ?? Date.now() - started) / 1000;
      info(rid, C.green, `restored cache snapshot ${SLOT_FILE} (${num(data.n_restored)} tokens, ${secs.toFixed(1)} s)`);
      return;
    }
    if (r.status === 503) return; // still loading the model: try again once it is ready
    needRestore = false;
    // llama-server answers 400 "Unable to restore slot: ... invalid slot save file" when the file does not exist
    if (r.status === 404 || (r.status === 400 && /unable to restore slot|no such file|failed to open|not found/i.test(msg))) {
      noSnapshotFile = true;
      info(rid, C.dim, `no snapshot yet (${SLOT_FILE} could not be restored: ${msg || r.status}); will restore after the next save`);
      return;
    }
    restoreDisabled = true;
    if (r.status === 501) {
      saveDisabled = true;
      info(rid, C.yellow, `auto snapshot/restore off for this run: llama-server answered 501 to ${RESTORE_URL}` +
        (msg ? ` (${msg})` : '') + `. Add --slot-save-path <folder> to the llama-server command to enable it.`);
    } else {
      info(rid, C.yellow, `auto restore off for this run: llama-server answered ${r.status} to ${RESTORE_URL}${msg ? ` (${msg})` : ''}`);
    }
  } catch (e) {
    if (!t.signal.aborted && isConnRefused(e)) return; // not running yet: try again once it is ready
    needRestore = false;
    info(rid, C.yellow, `snapshot restore failed (${t.signal.aborted ? `no answer after ${RESTORE_TIMEOUT_MS / 1000} s` : e.message}), continuing without it`);
  } finally {
    clearTimeout(timer);
  }
}

// Before a request goes upstream: restore the snapshot if slot 0 may be empty. Concurrent requests wait
// for the same restore. w (streaming only) shows "Restoring cached prompt..." if it takes a moment.
async function ensureRestored(rid, w) {
  if (!needRestore || restoreDisabled || noSnapshotFile) return;
  if (!restoring) restoring = restoreSnapshot(rid).finally(() => { restoring = null; });
  const note = setTimeout(() => w?.thinking('Restoring cached prompt...\n'), 250);
  try { await restoring; } finally { clearTimeout(note); }
}

// ---------- request translation ----------
function toOpenAIMessages(p) {
  const out = [];

  // Collect ALL system text (top-level + any role:"system" messages Claude Code puts inside
  // `messages`) into ONE leading system message. Qwen's Jinja template requires system first.
  const sysParts = [];
  if (p.system) sysParts.push(textOf(p.system));

  for (const m of p.messages || []) {
    if (m.role === 'system') {
      const t = textOf(m.content);
      if (t.trim()) sysParts.push(t);
      continue;
    }
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content || [];

    if (m.role === 'user') {
      const parts = [];
      // tool_result blocks become role:"tool" messages (must come right after the assistant tool_calls).
      // role:"tool" can't carry images, so images inside a tool_result move into the user message below.
      for (const b of blocks.filter((b) => b.type === 'tool_result')) {
        const body = typeof b.content === 'string' ? b.content : textOf(b.content);
        const imgs = Array.isArray(b.content) ? b.content.map(imagePart).filter(Boolean) : [];
        parts.push(...imgs);
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: (b.is_error ? '[error] ' : '') + (body || '') + (imgs.length ? `${body ? '\n' : ''}[${imgs.length} image(s) attached below]` : ''),
        });
      }
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (imagePart(b)) parts.push(imagePart(b));
      }
      if (parts.length) {
        const allText = parts.every((x) => x.type === 'text');
        out.push({ role: 'user', content: allText ? parts.map((x) => x.text).join('\n') : parts });
      }
    } else {
      // assistant: text + tool_use -> content + tool_calls (thinking blocks are dropped, so the
      // progress/reasoning "thinking" this router streams never changes the prompt)
      if (blocks.length && blocks.every((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) continue;
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const tool_calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      const msg = { role: 'assistant', content: text || (tool_calls.length ? null : '') };
      if (tool_calls.length) msg.tool_calls = tool_calls;
      out.push(msg);
    }
  }
  if (sysParts.length) out.unshift({ role: 'system', content: sysParts.join('\n\n') });
  return out;
}

const toOpenAITool = (t) => ({
  type: 'function',
  function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
});
const toolName = (t) => String(t.function?.name || '');

// Deterministic tool order so the prompt prefix (and llama.cpp's cache) stays the same between sessions:
// built-in tools keep the order they are given in, then MCP tools (mcp__*) sorted by name.
function orderTools(tools) {
  const isMcp = (t) => toolName(t).startsWith('mcp__');
  const mcp = tools.filter(isMcp).sort((a, b) => (toolName(a) < toolName(b) ? -1 : toolName(a) > toolName(b) ? 1 : 0));
  return [...tools.filter((t) => !isMcp(t)), ...mcp];
}

// ---------- tool superset ----------
// Claude Code often sends its first message before the MCP servers have connected (e.g. 25 tools), and the
// next one with all of them (e.g. 57). Tools are rendered before the first user message, and llama-server
// can only reuse cache up to a user-message start, so the changed tool list makes it re-read the whole
// prompt. So: remember every tool ever seen (name -> OpenAI tool, in order of first sighting, saved to
// DATA_DIR/known-tools.json) and send all of them with every request that has tools. Built-in tools keep the
// remembered order (not the request's), so the list is byte-identical once all tools have been seen.
const KNOWN_TOOLS_FILE = path.join(DATA_DIR, 'known-tools.json');
const knownTools = new Map();

function loadKnownTools() {
  if (!TOOL_SUPERSET) return;
  try {
    const arr = JSON.parse(fs.readFileSync(KNOWN_TOOLS_FILE, 'utf8'));
    if (!Array.isArray(arr)) throw new Error('not a list');
    for (const t of arr) if (t?.function?.name) knownTools.set(t.function.name, t);
  } catch (e) {
    knownTools.clear();
    if (e.code !== 'ENOENT') console.log(`${C.yellow}known-tools.json could not be read (${e.message}), starting with no remembered tools${C.reset}`);
  }
}

function saveKnownTools(rid) {
  try {
    const tmp = `${KNOWN_TOOLS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...knownTools.values()], null, 2));
    fs.renameSync(tmp, KNOWN_TOOLS_FILE);
  } catch (e) {
    info(rid, C.yellow, `(could not save known-tools.json: ${e.message})`);
  }
}

// Returns the tools to send upstream and the names that were added from memory.
function buildTools(rid, current) {
  if (!TOOL_SUPERSET) return { tools: orderTools(current), added: new Set() };
  let fresh = 0, updated = 0;
  for (const t of current) {
    const name = toolName(t);
    const old = knownTools.get(name);
    if (!old) fresh++;
    else if (JSON.stringify(old) !== JSON.stringify(t)) updated++;
    else continue;
    knownTools.set(name, t); // an existing name keeps its position
  }
  if (fresh || updated) {
    saveKnownTools(rid);
    info(rid, C.dim, `known-tools.json: ${fresh} new, ${updated} changed, ${knownTools.size} remembered`);
  }
  const currentNames = new Set(current.map(toolName));
  const added = new Set([...knownTools.keys()].filter((n) => !currentNames.has(n)));
  const tools = orderTools([...knownTools.values()]);
  if (added.size) info(rid, C.cyan, `tools ${currentNames.size} + ${added.size} remembered = ${tools.length}`);
  return { tools, added };
}

// The model may call a remembered tool that this request did not have (an MCP server not connected yet);
// Claude Code will answer that the tool is unknown, which is fine, but say so here.
function checkToolCall(rid, name, added) {
  if (added?.has(name)) info(rid, C.yellow, `model called tool ${name} not in this request (superset)`);
}

function toOpenAIPayload(p, stream, rid) {
  const body = {
    model: LOCAL_MODEL, // ignore whatever model name Claude Code sends (incl. its haiku/small model)
    messages: toOpenAIMessages(p),
    max_tokens: p.max_tokens || 4096,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (stream && SHOW_PROGRESS) body.return_progress = true; // llama-server: stream prompt_progress chunks
  if (p.temperature != null) body.temperature = p.temperature;
  if (p.top_p != null) body.top_p = p.top_p;
  if (p.stop_sequences?.length) body.stop = p.stop_sequences;

  let added = new Set();
  if (p.tools?.length) {
    ({ tools: body.tools, added } = buildTools(rid, p.tools.map(toOpenAITool)));
    const tc = p.tool_choice;
    if (tc?.type === 'any') body.tool_choice = 'required';
    else if (tc?.type === 'tool') body.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') body.tool_choice = 'none';
    else body.tool_choice = 'auto';
  }
  return { body, added };
}

// ---------- non-streaming response ----------
function toAnthropicMessage(data) {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* leave empty */ }
    content.push({ type: 'tool_use', id: tc.id || `toolu_${Date.now()}`, name: tc.function?.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: data.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: LOCAL_MODEL,
    stop_reason: STOP_REASONS[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

// ---------- streaming translation ----------
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// Open the SSE stream immediately (before llama.cpp answers) and send heartbeats while the
// model processes the prompt, so Claude Code doesn't think the connection has stalled.
function startSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${Date.now()}`, type: 'message', role: 'assistant', content: [],
      model: LOCAL_MODEL, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  return setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), PING_MS);
}

// Writes Anthropic content blocks to the SSE stream and keeps their indices right.
// A "thinking" block carries status lines (loading model, reading prompt) and the model's own
// reasoning; it is always closed (with a dummy signature) before the first text/tool block opens.
function blockWriter(res) {
  const send = (event, data) => sse(res, event, data);
  const w = { index: -1, open: null, answered: false };
  w.close = () => {
    if (!w.open) return;
    if (w.open === 'thinking') {
      send('content_block_delta', { type: 'content_block_delta', index: w.index, delta: { type: 'signature_delta', signature: THINKING_SIGNATURE } });
    }
    send('content_block_stop', { type: 'content_block_stop', index: w.index });
    w.open = null;
  };
  w.start = (kind, content_block) => {
    w.close();
    w.index++; w.open = kind;
    if (kind !== 'thinking') w.answered = true;
    send('content_block_start', { type: 'content_block_start', index: w.index, content_block });
  };
  // returns false if the text was not shown (turned off, or the answer has already started)
  w.thinking = (text) => {
    if (!SHOW_PROGRESS || w.answered || res.writableEnded) return false;
    if (w.open !== 'thinking') w.start('thinking', { type: 'thinking', thinking: '', signature: '' });
    send('content_block_delta', { type: 'content_block_delta', index: w.index, delta: { type: 'thinking_delta', thinking: text } });
    return true;
  };
  w.text = (text) => {
    if (w.open !== 'text') w.start('text', { type: 'text', text: '' });
    send('content_block_delta', { type: 'content_block_delta', index: w.index, delta: { type: 'text_delta', text } });
  };
  return w;
}

// "Reading prompt: 8,192 / 30,197 tokens (27%), 2,048 from cache, ~70 s left"
// llama-server prompt_progress: {total, cache, processed (includes cache), time_ms}
function describeProgress(pp) {
  const secs = (pp.time_ms || 0) / 1000;
  const fresh = (pp.processed || 0) - (pp.cache || 0);
  if (pp.total && pp.processed >= pp.total) {
    return `Prompt read: ${num(pp.total)} tokens (${num(pp.cache)} from cache, ${num(fresh)} new) in ${secs.toFixed(0)} s`;
  }
  const rate = fresh > 0 && secs > 0 ? fresh / secs : 0;
  const left = rate ? `, ~${Math.round((pp.total - pp.processed) / rate)} s left` : '';
  const pct = pp.total ? Math.floor((100 * pp.processed) / pp.total) : 0;
  return `Reading prompt: ${num(pp.processed)} / ${num(pp.total)} tokens (${pct}%), ${num(pp.cache)} from cache${left}`;
}

async function streamResponse(upstream, res, abort, rid, t0, w, added) {
  const send = (event, data) => sse(res, event, data);

  const toolBlocks = new Map(); // openai tool_call index -> anthropic block index
  let finish = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let firstTokenAt = null, textChars = 0, reasoningChars = 0, chunks = 0;
  let lastProgress = null, lastNoteAt = 0, reasoningShown = false;
  const toolNames = [];

  const onProgress = (pp) => {
    const first = !lastProgress;
    lastProgress = pp;
    const line = describeProgress(pp);
    info(rid, C.dim, line);
    const now = Date.now();
    if (first || pp.processed >= pp.total || now - lastNoteAt >= 2000) { w.thinking(line + '\n'); lastNoteAt = now; }
  };

  const handleChunk = (json) => {
    if (json.usage) {
      usage = { input_tokens: json.usage.prompt_tokens || 0, output_tokens: json.usage.completion_tokens || 0 };
    }
    if (json.prompt_progress) onProgress(json.prompt_progress); // these chunks also carry an empty delta
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    chunks++;
    if (!firstTokenAt && (delta.content || delta.tool_calls || delta.reasoning_content)) {
      firstTokenAt = Date.now();
      info(rid, C.cyan, `first token after ${((firstTokenAt - t0) / 1000).toFixed(1)}s (prompt processing)`);
    }

    // the model's own reasoning (Qwen <think>) -> same thinking block, only before the answer starts
    if (delta.reasoning_content) {
      reasoningChars += delta.reasoning_content.length;
      const sep = !reasoningShown && w.open === 'thinking' ? '\n' : '';
      if (w.thinking(sep + delta.reasoning_content)) reasoningShown = true;
    }

    if (delta.content) {
      textChars += delta.content.length;
      w.text(delta.content);
    }

    for (const tc of delta.tool_calls || []) {
      const key = tc.index ?? 0;
      if (!toolBlocks.has(key)) {
        toolNames.push(tc.function?.name || '?');
        checkToolCall(rid, tc.function?.name, added);
        w.start('tool', { type: 'tool_use', id: tc.id || `toolu_${Date.now()}_${key}`, name: tc.function?.name || '', input: {} });
        toolBlocks.set(key, w.index);
      }
      const args = tc.function?.arguments;
      if (args) {
        send('content_block_delta', {
          type: 'content_block_delta', index: toolBlocks.get(key),
          delta: { type: 'input_json_delta', partial_json: args },
        });
      }
    }

    if (choice.finish_reason) finish = choice.finish_reason;
  };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let streamFailed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { handleChunk(JSON.parse(data)); } catch (e) { log('bad chunk', data.slice(0, 200)); }
      }
    }
  } catch (e) {
    streamFailed = true;
    if (!abort.signal.aborted) console.error('Stream error:', e.message);
  }

  w.close();
  const total = (Date.now() - t0) / 1000;
  const genTime = firstTokenAt ? (Date.now() - firstTokenAt) / 1000 : 0;
  const tps = genTime > 0 && usage.output_tokens ? ` (${(usage.output_tokens / genTime).toFixed(1)} tok/s)` : '';
  info(rid, abort.signal.aborted ? C.yellow : C.green,
    `${abort.signal.aborted ? 'ABORTED' : 'done'} in ${total.toFixed(1)}s | stop=${STOP_REASONS[finish] || finish || '?'} | ` +
    `${usage.input_tokens} in / ${usage.output_tokens} out${tps}` +
    (lastProgress ? ` | prompt cache ${num(lastProgress.cache)}/${num(lastProgress.total)}` : '') +
    (reasoningChars ? ` | ${reasoningChars} chars reasoning` : '') +
    (toolNames.length ? ` | tool calls: ${toolNames.join(', ')}` : '') +
    (textChars ? ` | ${textChars} chars text` : '') +
    (!textChars && !toolNames.length ? ' | WARNING: EMPTY RESPONSE' : ''));
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: STOP_REASONS[finish] || 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
  // finished normally: not aborted, no stream error, upstream sent a finish reason
  return { ok: !abort.signal.aborted && !streamFailed && !!finish, promptTokens: usage.input_tokens };
}

// ---------- upstream call, waiting while llama.cpp loads the model ----------
// While llama-server starts it refuses connections (not listening yet) or answers 503 "Loading model".
// In both cases poll /health every 2 s (up to LOAD_WAIT_MS), then send the real request.
const isConnRefused = (e) => /ECONNREFUSED/.test(`${e?.cause?.code} ${e?.cause?.errors?.map((x) => x.code)} ${e?.cause?.message}`);

async function waitForModel(rid, abort, w, deadline, why) {
  const started = Date.now();
  let lastNote = 0;
  info(rid, C.yellow, `llama.cpp ${why}, waiting for the model to load (polling ${HEALTH_URL})`);
  for (;;) {
    const secs = Math.round((Date.now() - started) / 1000);
    if (Date.now() - lastNote >= 5000) {
      lastNote = Date.now();
      w?.thinking(`Loading model... ${secs} s\n`);
      if (secs) info(rid, C.dim, `loading model... ${secs} s`);
    }
    const t = new AbortController();
    const timer = setTimeout(() => t.abort(), 5000);
    const onAbort = () => t.abort();
    abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await fetch(HEALTH_URL, { signal: t.signal });
      await r.text().catch(() => {});
      if (r.ok) { info(rid, C.green, `model ready after ${secs} s`); w?.thinking(`Model loaded after ${secs} s.\n`); return; }
      needRestore = true; // loading: the slot will be empty
    } catch { needRestore = true; /* not listening yet */ } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', onAbort);
    }
    if (abort.signal.aborted) throw new Error('client disconnected');
    if (Date.now() > deadline) throw new Error(`llama.cpp model not ready after ${Math.round(LOAD_WAIT_MS / 1000)} s (${why})`);
    await sleep(2000, abort.signal);
  }
}

async function fetchUpstream(body, abort, rid, w) {
  const deadline = Date.now() + LOAD_WAIT_MS;
  for (;;) {
    await ensureRestored(rid, w);
    let why;
    try {
      const upstream = await fetch(`${TARGET_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (upstream.ok) return upstream;
      const t = await upstream.text();
      if (upstream.status !== 503 || !/loading model/i.test(t)) throw new Error(`llama.cpp ${upstream.status}: ${t.slice(0, 500)}`);
      why = 'is loading the model (503)';
    } catch (e) {
      if (abort.signal.aborted || !isConnRefused(e)) throw e;
      why = 'is not running yet (connection refused)';
    }
    needRestore = true; // llama-server is (re)starting: its slot will be empty
    if (Date.now() > deadline) throw new Error(`llama.cpp model not ready after ${Math.round(LOAD_WAIT_MS / 1000)} s (${why})`);
    await waitForModel(rid, abort, w, deadline, why);
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const rid = ++reqCounter;
  const t0 = Date.now();
  log(req.method, url);

  // Unauthenticated pings (configurable via PUBLIC_PATHS); HEAD requests never need auth
  if (req.method === 'HEAD' || PUBLIC_PATHS.includes(url)) {
    res.writeHead(200);
    return res.end();
  }

  if (PROXY_KEY) {
    const given = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (given !== PROXY_KEY) return (info(rid, C.red, `401 rejected ${req.method} ${url} (bad key)`), sendError(res, 401, 'Unauthorized', 'authentication_error'));
  }

  if (req.method === 'GET' && (url === '/' || url === '/health')) return sendJson(res, 200, { ok: true });

  if (req.method === 'GET' && url === '/v1/models') {
    return sendJson(res, 200, {
      data: [{ type: 'model', id: LOCAL_MODEL, display_name: LOCAL_MODEL, created_at: new Date().toISOString() }],
      has_more: false, first_id: LOCAL_MODEL, last_id: LOCAL_MODEL,
    });
  }

  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed', 'invalid_request_error');

  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return sendError(res, 400, 'Invalid JSON', 'invalid_request_error'); }

  // Rough token estimate; Claude Code calls this to track context usage
  if (url === '/v1/messages/count_tokens') {
    const chars = JSON.stringify([payload.system, payload.messages, payload.tools]).length;
    info(rid, C.dim, `count_tokens ~${Math.ceil(chars / 3.5)}`);
    return sendJson(res, 200, { input_tokens: Math.ceil(chars / 3.5) });
  }

  if (url !== '/v1/messages') return info(rid, C.yellow, `404 ${req.method} ${url}`), sendError(res, 404, `Unknown route ${url}`, 'not_found_error');

  const wantStream = !!payload.stream;
  let keepalive = null;
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) { info(rid, C.yellow, 'client disconnected, cancelling upstream'); abort.abort(); } });
  info(rid, C.cyan, `-> ${describeRequest(payload)}`); // client hung up -> stop generation

  inFlight++;
  let saveAfter = null; // set when a snapshot should be considered once this response has ended
  try {
    const { body, added } = toOpenAIPayload(payload, wantStream, rid);
    log('upstream request', JSON.stringify(body).slice(0, 500));
    fingerprint(rid, payload, body);
    let w = null;
    if (wantStream) { keepalive = startSSE(res); w = blockWriter(res); }

    const upstream = await fetchUpstream(body, abort, rid, w);

    if (wantStream) {
      const result = await streamResponse(upstream, res, abort, rid, t0, w, added);
      if (result.ok && body.tools?.length && !saveDisabled) saveAfter = { hash: prefixHash(body), promptTokens: result.promptTokens };
      return;
    }

    const data = await upstream.json();
    if (data.error) throw new Error(data.error.message || 'llama.cpp returned an error');
    const out = toAnthropicMessage(data);
    const tools = out.content.filter((b) => b.type === 'tool_use').map((b) => b.name);
    for (const name of tools) checkToolCall(rid, name, added);
    info(rid, C.green, `done in ${((Date.now() - t0) / 1000).toFixed(1)}s | stop=${out.stop_reason} | ${out.usage.input_tokens} in / ${out.usage.output_tokens} out` + (tools.length ? ` | tool calls: ${tools.join(', ')}` : ''));
    sendJson(res, 200, out);
  } catch (err) {
    if (abort.signal.aborted) return;
    info(rid, C.red, `ERROR after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}`);
    if (!res.headersSent) sendError(res, 500, err.message);
    else { sse(res, 'error', { type: 'error', error: { type: 'api_error', message: err.message } }); res.end(); }
  } finally {
    clearInterval(keepalive);
    inFlight--;
    if (saveAfter) {
      const { hash, promptTokens } = saveAfter;
      setImmediate(() => maybeSaveSnapshot(rid, hash, promptTokens).catch(() => {}));
    }
  }
});

// ---------- data folder ----------
// Older versions wrote their files next to router.js. Move any found there into DATA_DIR (unless DATA_DIR
// already has a file of that name). Never fatal: on any error the file just stays where it is.
const DATA_FILE_RE = /^(known-tools\.json(\.tmp)?|prompt-fingerprints\.log|(last|prev)-\d+-(system\.txt|tools\.json))$/;

function prepareDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.log(`${C.yellow}could not create data folder ${DATA_DIR} (${e.message}); known tools and fingerprints will not be saved${C.reset}`);
    return;
  }
  if (DATA_DIR === __dirname) return;
  let moved = 0;
  let names = [];
  try { names = fs.readdirSync(__dirname).filter((f) => DATA_FILE_RE.test(f)); } catch { /* cannot list, skip */ }
  for (const f of names) {
    try {
      const to = path.join(DATA_DIR, f);
      if (fs.existsSync(to)) continue;
      fs.renameSync(path.join(__dirname, f), to);
      moved++;
    } catch { /* e.g. different drive or locked file: leave it */ }
  }
  if (moved) console.log(`${C.dim}moved ${moved} old file(s) from next to router.js into ${DATA_DIR}${C.reset}`);
}

prepareDataDir();
loadKnownTools();
if (AUTO_SAVE) loadSnapshot();
server.listen(PORT, HOST, () => {
  console.log(`Anthropic->OpenAI proxy on ${HOST}:${PORT} -> ${TARGET_BASE}`);
  console.log(`model: ${LOCAL_MODEL} | auth: ${PROXY_KEY ? 'on' : 'off'} | debug: ${DEBUG ? 'on' : 'off'}`);
  console.log(`data folder: ${DATA_DIR}`);
  console.log(TOOL_SUPERSET
    ? `tool superset: on, ${knownTools.size} remembered tools (to reset: stop the router, delete ${path.join(DATA_DIR, 'known-tools.json')})`
    : 'tool superset: off (TOOL_SUPERSET=0)');
  console.log(AUTO_SAVE
    ? `auto snapshot: on (${SLOT_FILE}, last saved ${snapshot?.savedAt ? new Date(snapshot.savedAt).toLocaleString('en-GB') : 'never'})`
    : 'auto snapshot: off (AUTO_SAVE=0)');
  console.log(AUTO_RESTORE
    ? `auto restore: on (${SLOT_FILE} is loaded before the first request and after llama-server restarts)`
    : 'auto restore: off (AUTO_RESTORE=0)');
});