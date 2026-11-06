// n8n Code node "Bot Decide + Act" from the workflow "WhatsApp Webhook — Incoming Messages".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

// ============================================================================
// AI Bot — TEST MODE · Node 3/3: Decide + Act
// Input: $json = Claude's /v1/messages response; prep data via $('Bot Gate + Prep').
// Parses emit_reply, then either SENDS via WhatsApp + logs a bot line, or
// ESCALATES (flag Needs Human, no send). Fail-safe to escalate. UI-safe writes.
// ============================================================================
const CONF_FALLBACK = 0.75;
const AIRTABLE_PAT = '${AIRTABLE_PAT}';
const BASE_ID = 'appXXXXXXXXXXXXXX';
const CONVS = 'tblCONVERSATIONS';
const WA_TOKEN = '${WA_TOKEN}';
const WA_PHONE_ID = '<PHONE_NUMBER_ID>';
const A_HEADERS = { Authorization: 'Bearer ' + AIRTABLE_PAT, 'Content-Type': 'application/json' };

function out(o) { return [{ json: o }]; }

const prep = $('Bot Gate + Prep').first().json;
if (!prep || !prep.run) return out({ bot: 'skip', reason: (prep && prep.reason) || 'no_prep' });

// Confidence threshold comes live from Gym Settings (via prep); fall back if absent.
const CONF_THRESHOLD = (Number.isFinite(prep.confThreshold) && prep.confThreshold >= 0 && prep.confThreshold <= 1)
  ? prep.confThreshold : CONF_FALLBACK;

// WhatsApp uses *single* asterisks for bold, not Markdown **double**. Claude
// sometimes emits Markdown (**bold**, __underline__, `code`), which WhatsApp shows
// literally. Convert to WhatsApp formatting / strip it so the customer never sees
// stray asterisks or backticks. Order matters: collapse ** before * so we don't
// turn **x** into *x* and then mangle it.
function waFormat(s) {
  return String(s)
    .replace(/\*\*\*(.+?)\*\*\*/g, '*$1*')   // ***bold-italic*** -> *bold*
    .replace(/\*\*(.+?)\*\*/g, '*$1*')         // **bold** -> *bold* (WhatsApp bold)
    .replace(/__(.+?)__/g, '_$1_')             // __underline__ -> _italic_
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')      // `code` / ```code``` -> plain
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')         // # headings -> plain line
    .replace(/^\s{0,3}>\s?/gm, '')              // > blockquote markers -> plain
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2'); // [text](url) -> text: url
}

const convId = prep.convId;
const phone = prep.phone;
const nowIso = new Date().toISOString();
const tsNow = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

// --- parse Claude response (forced tool) ---
let parsed;
try {
  const resp = $json || {};
  // A max_tokens cut-off returns a PARTIAL tool input (e.g. only {decision:'reply'}),
  // which would otherwise read as confidence 0 and escalate with a blank reason.
  if (resp.stop_reason === 'max_tokens') throw new Error('truncated_max_tokens');
  const tu = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'emit_reply');
  if (!tu || !tu.input) throw new Error('no_tool_use');
  parsed = tu.input;
} catch (e) {
  parsed = { decision: 'escalate', reply: '', confidence: 0, language: 'NL', reason: 'bot_error: ' + e.message };
}

let decision = parsed.decision === 'reply' ? 'reply' : 'escalate';
let confidence = Number(parsed.confidence);
if (!Number.isFinite(confidence)) confidence = 0;
confidence = Math.max(0, Math.min(1, confidence));
if (decision === 'reply' && confidence < CONF_THRESHOLD) { decision = 'escalate'; parsed.reason = 'low_confidence: ' + (parsed.reason || ''); }
// A 'reply' with no actual text → escalate (never draft/send a blank, which would
// leave an unread conv with no card and no human flag).
if (decision === 'reply' && !String(parsed.reply || '').trim()) { decision = 'escalate'; parsed.reason = 'empty_reply: ' + (parsed.reason || ''); }
const reply = decision === 'reply' ? waFormat(parsed.reply || '') : '';

try {
  // ---------- ESCALATE ----------
  if (decision === 'escalate') {
    await this.helpers.httpRequest({ method: 'PATCH',
      url: 'https://api.airtable.com/v0/' + BASE_ID + '/' + CONVS + '/' + convId,
      headers: A_HEADERS, json: true,
      body: { fields: {
        'Automation Context': 'Needs Human', 'Unread': true, 'Last Activity At': nowIso,
        'Bot Decision': 'escalate: ' + (parsed.reason || '').slice(0, 200),
        'Bot Confidence': confidence, 'Bot Last Run At': nowIso, 'Bot Draft': '',
      } } });
    return out({ bot: 'escalated', reason: parsed.reason });
  }

  // ---------- DRAFT MODE → write a suggestion for staff, DO NOT send ----------
  if (prep.mode === 'draft') {
    await this.helpers.httpRequest({ method: 'PATCH',
      url: 'https://api.airtable.com/v0/' + BASE_ID + '/' + CONVS + '/' + convId,
      headers: A_HEADERS, json: true,
      body: { fields: {
        'Bot Draft': reply,
        'Bot Confidence': confidence,
        'Bot Decision': 'draft: ' + (parsed.reason || '').slice(0, 180),
        'Bot Last Run At': nowIso,
        'Unread': true,
        'Last Activity At': nowIso,
      } } });
    return out({ bot: 'drafted', confidence });
  }

  // ---------- AUTO MODE → send WhatsApp, then log ----------
  let wamid = '';
  try {
    const send = await this.helpers.httpRequest({ method: 'POST',
      url: 'https://graph.facebook.com/v25.0/' + WA_PHONE_ID + '/messages',
      headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: { messaging_product: 'whatsapp', to: phone.replace('+', ''), type: 'text', text: { body: reply } },
      json: true });
    wamid = (send.messages && send.messages[0] && send.messages[0].id) || '';
  } catch (e) {
    await this.helpers.httpRequest({ method: 'PATCH',
      url: 'https://api.airtable.com/v0/' + BASE_ID + '/' + CONVS + '/' + convId,
      headers: A_HEADERS, json: true,
      body: { fields: { 'Automation Context': 'Needs Human', 'Unread': true,
        'Bot Decision': 'send_failed: ' + e.message, 'Bot Last Run At': nowIso } } });
    return out({ bot: 'send_failed', error: e.message });
  }

  // UI-SAFETY: neutralize any reply line starting with "[D-M-YYYY" so the inbox
  // Full-Thread split can't mis-parse it into a phantom bubble.
  const safeReply = String(reply).replace(/(^|\n)(\s*)\[(\d{1,2}-\d{1,2}-\d{4})/g, '$1$2 [$3');
  const existing = prep.existingThread || '';
  const newLine = '[' + tsNow + '] 🤖 AI Bot:\n' + safeReply;
  await this.helpers.httpRequest({ method: 'PATCH',
    url: 'https://api.airtable.com/v0/' + BASE_ID + '/' + CONVS + '/' + convId,
    headers: A_HEADERS, json: true,
    body: { fields: {
      'Full Thread': existing ? existing + '\n\n' + newLine : newLine,
      'Last Message': '🤖 ' + safeReply.replace(/\s*\n\s*/g, ' ').slice(0, 200),
      'Last Activity At': nowIso,
      'Bot Decision': 'sent: ' + (parsed.reason || '').slice(0, 180),
      'Bot Confidence': confidence, 'Bot Last Run At': nowIso, 'Bot Draft': '',
    } } });
  return out({ bot: 'sent', wamid, confidence });
} catch (e) {
  return out({ bot: 'error', error: e.message });
}

