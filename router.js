// Anthropic Messages API  ->  OpenAI Chat Completions (LM Studio) proxy
// Node 18+ (uses built-in fetch). No dependencies.

try { process.loadEnvFile(); } catch { /* no .env file, use real environment */ }

const http = require('http');

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
      // tool_result blocks become role:"tool" messages (must come right after the assistant tool_calls)
      for (const b of blocks.filter((b) => b.type === 'tool_result')) {
        const body = typeof b.content === 'string' ? b.content : textOf(b.content);
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: (b.is_error ? '[error] ' : '') + (body || ''),
        });
      }
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source?.type === 'base64')
          parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
      if (parts.length) {
        const allText = parts.every((x) => x.type === 'text');
        out.push({ role: 'user', content: allText ? parts.map((x) => x.text).join('\n') : parts });
      }
    } else {
      // assistant: text + tool_use -> content + tool_calls (thinking blocks are dropped)
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

function toOpenAIPayload(p, stream) {
  const body = {
    model: LOCAL_MODEL, // ignore whatever model name Claude Code sends (incl. its haiku/small model)
    messages: toOpenAIMessages(p),
    max_tokens: p.max_tokens || 4096,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (p.temperature != null) body.temperature = p.temperature;
  if (p.top_p != null) body.top_p = p.top_p;
  if (p.stop_sequences?.length) body.stop = p.stop_sequences;

  if (p.tools?.length) {
    body.tools = p.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));
    const tc = p.tool_choice;
    if (tc?.type === 'any') body.tool_choice = 'required';
    else if (tc?.type === 'tool') body.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') body.tool_choice = 'none';
    else body.tool_choice = 'auto';
  }
  return body;
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

// Open the SSE stream immediately (before LM Studio answers) and send heartbeats while the
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

async function streamResponse(upstream, res, abort, rid, t0) {
  const send = (event, data) => sse(res, event, data);

  let index = -1;            // current anthropic content block index
  let open = null;           // 'text' | 'tool' | null
  const toolBlocks = new Map(); // openai tool_call index -> anthropic block index
  let finish = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let firstTokenAt = null, textChars = 0, chunks = 0;
  const toolNames = [];

  const closeBlock = () => {
    if (open) { send('content_block_stop', { type: 'content_block_stop', index }); open = null; }
  };

  const handleChunk = (json) => {
    if (json.usage) {
      usage = { input_tokens: json.usage.prompt_tokens || 0, output_tokens: json.usage.completion_tokens || 0 };
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    chunks++;
    if (!firstTokenAt && (delta.content || delta.tool_calls)) {
      firstTokenAt = Date.now();
      info(rid, C.cyan, `first token after ${((firstTokenAt - t0) / 1000).toFixed(1)}s (prompt processing)`);
    }

    if (delta.content) {
      textChars += delta.content.length;
      if (open !== 'text') {
        closeBlock();
        index++; open = 'text';
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      }
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta.content } });
    }

    for (const tc of delta.tool_calls || []) {
      const key = tc.index ?? 0;
      if (!toolBlocks.has(key)) {
        closeBlock();
        index++; open = 'tool';
        toolBlocks.set(key, index);
        toolNames.push(tc.function?.name || '?');
        send('content_block_start', {
          type: 'content_block_start', index,
          content_block: { type: 'tool_use', id: tc.id || `toolu_${Date.now()}_${key}`, name: tc.function?.name || '', input: {} },
        });
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
    if (!abort.signal.aborted) console.error('Stream error:', e.message);
  }

  closeBlock();
  const total = (Date.now() - t0) / 1000;
  const genTime = firstTokenAt ? (Date.now() - firstTokenAt) / 1000 : 0;
  const tps = genTime > 0 && usage.output_tokens ? ` (${(usage.output_tokens / genTime).toFixed(1)} tok/s)` : '';
  info(rid, abort.signal.aborted ? C.yellow : C.green,
    `${abort.signal.aborted ? 'ABORTED' : 'done'} in ${total.toFixed(1)}s | stop=${STOP_REASONS[finish] || finish || '?'} | ` +
    `${usage.input_tokens} in / ${usage.output_tokens} out${tps}` +
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

  try {
    const body = toOpenAIPayload(payload, wantStream);
    log('upstream request', JSON.stringify(body).slice(0, 500));
    if (wantStream) keepalive = startSSE(res);

    const upstream = await fetch(`${TARGET_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort.signal,
    });

    if (!upstream.ok) {
      const t = await upstream.text();
      throw new Error(`LM Studio ${upstream.status}: ${t.slice(0, 500)}`);
    }

    if (wantStream) return await streamResponse(upstream, res, abort, rid, t0);

    const data = await upstream.json();
    if (data.error) throw new Error(data.error.message || 'LM Studio returned an error');
    const out = toAnthropicMessage(data);
    const tools = out.content.filter((b) => b.type === 'tool_use').map((b) => b.name);
    info(rid, C.green, `done in ${((Date.now() - t0) / 1000).toFixed(1)}s | stop=${out.stop_reason} | ${out.usage.input_tokens} in / ${out.usage.output_tokens} out` + (tools.length ? ` | tool calls: ${tools.join(', ')}` : ''));
    sendJson(res, 200, out);
  } catch (err) {
    if (abort.signal.aborted) return;
    info(rid, C.red, `ERROR after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}`);
    if (!res.headersSent) sendError(res, 500, err.message);
    else { sse(res, 'error', { type: 'error', error: { type: 'api_error', message: err.message } }); res.end(); }
  } finally {
    clearInterval(keepalive);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Anthropic->OpenAI proxy on ${HOST}:${PORT} -> ${TARGET_BASE}`);
  console.log(`model: ${LOCAL_MODEL} | auth: ${PROXY_KEY ? 'on' : 'off'} | debug: ${DEBUG ? 'on' : 'off'}`);
});
