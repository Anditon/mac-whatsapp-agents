// claude.js — the Anthropic call. Sends the forced-tool request, returns the
// validated emit_reply object.
//
// PORT NOTE (the ONE translation to n8n):
//   Harness:    const r = await fetch(url, {...})            // global fetch, Node 18+
//   n8n node:   const r = await this.helpers.httpRequest({...})  // fetch is undefined in the sandbox
// Everything else (headers, body shape, tool-result extraction) is identical.

const { buildRequest } = require('./prompt');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Calls Claude and returns the emit_reply tool input as a plain object:
//   { decision, reply, confidence, language, reason }
// On ANY error (network, HTTP, malformed, no tool_use) we FAIL SAFE to escalate —
// the same behavior the n8n error-output path enforces. A dropped message is
// never acceptable; a human-flag is.
async function callClaude({ apiKey, faq, tone, contact, thread, inboundText, model }) {
  const body = buildRequest({ faq, tone, contact, thread, inboundText, model });

  let res, json;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return failSafe(`network_error: ${e.message}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch (_) {}
    return failSafe(`http_${res.status}: ${detail.slice(0, 200)}`);
  }

  try {
    json = await res.json();
  } catch (e) {
    return failSafe(`bad_json: ${e.message}`);
  }

  // A max_tokens cut-off returns a PARTIAL tool input (e.g. only {decision:'reply'}),
  // which would otherwise read as confidence 0 and escalate with a blank reason.
  if (json.stop_reason === 'max_tokens') return failSafe('truncated_max_tokens');

  // Extract the forced tool_use block.
  const toolUse = (json.content || []).find((b) => b.type === 'tool_use' && b.name === 'emit_reply');
  if (!toolUse || !toolUse.input) {
    return failSafe('no_tool_use_in_response');
  }

  const out = validate(toolUse.input);

  // Attach token usage (incl. cache stats) so run.js can report cost/caching.
  out._usage = json.usage || null;
  return out;
}

// Clamp / default the fields so downstream never sees garbage. Mirrors the n8n
// `Parse Claude` node.
function validate(input) {
  let decision = input.decision === 'reply' ? 'reply' : 'escalate';
  let confidence = Number(input.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const language = input.language === 'EN' ? 'EN' : input.language === 'NL' ? 'NL' : 'NL';
  let reply = typeof input.reply === 'string' ? input.reply : '';
  if (decision === 'escalate') reply = ''; // never carry a reply on escalate
  const reason = typeof input.reason === 'string' ? input.reason : '';
  return { decision, reply, confidence, language, reason };
}

function failSafe(reason) {
  return { decision: 'escalate', reply: '', confidence: 0, language: 'NL', reason: `bot_error: ${reason}`, _failSafe: true };
}

module.exports = { callClaude, validate, failSafe, ANTHROPIC_URL, ANTHROPIC_VERSION };
