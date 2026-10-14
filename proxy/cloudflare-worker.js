// Team proxy for the AI business-writing editor (Cloudflare Worker).
//
// Holds the organisation's Anthropic API key so it is never shipped to
// phones. It only forwards report-editing requests from the app's own site,
// requires a team access code, pins the model and caps the request size.
//
// Secrets / variables to set in Cloudflare:
//   ANTHROPIC_API_KEY  (secret)  the organisation's Anthropic API key
//   TEAM_ACCESS_CODE   (secret)  the code colleagues enter in the app
//   ALLOWED_ORIGINS    (var)     e.g. https://your-username.github.io

const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 16000;
const MAX_BODY_BYTES = 200000;

function corsHeaders(origin, allowed) {
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json' } });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const originOk = allowedOrigins.includes(origin);
    const cors = corsHeaders(origin, originOk);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/messages') return json(404, { error: 'Not found' }, cors);
    if (!originOk) return json(403, { error: 'Origin not allowed' }, cors);
    if (!safeEqual(request.headers.get('x-team-code') || '', env.TEAM_ACCESS_CODE || '')) {
      return json(401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid team access code' } }, cors);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'Request too large' }, cors);
    let body;
    try { body = JSON.parse(raw); } catch { return json(400, { error: 'Invalid JSON' }, cors); }

    // Only plain text editing is allowed through this proxy.
    if (body.tools || body.mcp_servers || body.container || body.stream) return json(400, { error: 'Unsupported request' }, cors);
    body.model = MODEL;
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);

    const headers = {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01'
    };
    const beta = request.headers.get('anthropic-beta');
    if (beta) headers['anthropic-beta'] = beta;

    const upstream = await fetch(UPSTREAM, { method: 'POST', headers, body: JSON.stringify(body) });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'content-type': upstream.headers.get('content-type') || 'application/json' }
    });
  }
};
