// n8n Code node "Bot Gate + Prep" from the workflow "WhatsApp Webhook — Incoming Messages".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

// ============================================================================
// AI Bot — TEST MODE · Node 1/3: Gate + Prep
// Wired after "Find + Route Conversation" (w015). Decides whether the bot runs,
// builds the Anthropic request, and passes it to the Call Claude HTTP node.
// Self-contained; failure-tolerant. For non-allowlisted phones it returns a
// {run:false} item so the HTTP node is skipped (see "Should Call Claude?" IF).
// ============================================================================
const TEST_MODE = true;
const ALLOWLIST = ['+490000000000'];            // the builder's own test number only
const MODEL = 'claude-sonnet-4-6';
const AIRTABLE_PAT = '${AIRTABLE_PAT}';
const BASE_ID = 'appXXXXXXXXXXXXXX';
const CONVS = 'tblCONVERSATIONS';
const CONTACTS = 'tblCONTACTS';
const CACHE = 'tblBOT_CACHE';               // Bot Cache (class schedule snapshot)
const SETTINGS = 'tblGYM_SETTINGS';            // Gym Settings (Phase 2: editable FAQ/tone/mode/threshold/enabled)

// ── Phase-1 fallbacks (used ONLY if the Gym Settings row can't be read) ──
// Phase 2 moved FAQ / tone / mode / confidence threshold / kill-switch into the
// Gym Settings table so staff can edit them from the inbox. We still keep the
// last-known-good values inlined here so an Airtable hiccup can never silently
// break the bot's brain or its safety gates — if the live read fails or returns
// empty, we fall back to these. Keep them roughly in sync with the live row.
const MODE_FALLBACK = 'draft';
const CONF_FALLBACK = 0.75;
const GYM_PHONE = '+31639277868';
const A_HEADERS = { Authorization: 'Bearer ' + AIRTABLE_PAT, 'Content-Type': 'application/json' };

// Built-in copy of the FAQ, used when the settings row can't be read.
// Identical to assistant-harness/faq.md, so it is left out here.
const FAQ_FALLBACK = `(see assistant-harness/faq.md)`;
// Built-in copy of the tone, identical to assistant-harness/tone.md.
const TONE_FALLBACK = `(see assistant-harness/tone.md)`;

const routed = $json || {};
const exItems = $('Extract Message').all();
const msg = (exItems[0] && exItems[0].json) || {};
const phone = routed.phone || msg.from || '';

function stop(reason) { return [{ json: { run: false, reason, phone } }]; }
function norm(s) { return (s || '').toLowerCase().trim(); }

const OPT_OUT = ['stop', 'unsubscribe', 'opt out', 'opt-out', 'afmelden', 'uitschrijven',
  'geen berichten meer', 'no more messages', 'stop berichten', 'stop met berichten'];
function isOptOut(text) {
  const t = norm(text);
  if (!t) return false;
  for (const k of OPT_OUT) if (k.includes(' ') && t.includes(k)) return true;
  if (t.includes('?')) return false;
  const toks = t.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 3) return false;
  const single = OPT_OUT.filter((k) => !k.includes(' '));
  return toks.some((x) => single.includes(x));
}

if (!TEST_MODE) return stop('disabled');
if (!phone || !ALLOWLIST.includes(phone)) return stop('not_allowlisted');
// Idempotency: only act on a genuinely new/updated inbound (never on a Meta
// at-least-once redelivery that w015 already marked duplicate_skipped).
if (routed.action && routed.action !== 'created' && routed.action !== 'updated') return stop('w015_' + routed.action);
if (!msg.from) return stop('no_message');
if ((msg.messageType || 'text') !== 'text') return stop('non_text');
if (isOptOut(msg.messageText)) return stop('opt_out');
if (!norm(msg.messageText)) return stop('empty');

try {
  const cf = encodeURIComponent("{Phone}='" + phone + "'");
  const convResp = await this.helpers.httpRequest({ method: 'GET',
    url: 'https://api.airtable.com/v0/' + BASE_ID + '/' + CONVS + '?maxRecords=1&filterByFormula=' + cf,
    headers: A_HEADERS, json: true });
  const conv = (convResp.records || [])[0];
  if (!conv) return stop('no_conv');

  const contactResp = await this.helpers.httpRequest({ method: 'GET',
    url: 'https://api.airtable.com/v0/' + BASE_ID + '/' + CONTACTS + '?maxRecords=1&filterByFormula=' + cf,
    headers: A_HEADERS, json: true });
  const contact = ((contactResp.records || [])[0] || {}).fields || {};

  // ── Phase 2: live bot config from the Gym Settings table ──
  // Staff edit FAQ / tone / mode / threshold / the master kill switch from the
  // inbox; we read the row fresh each message. Best-effort: if the read fails or
  // a field is blank, fall back to the inlined last-known-good values so an
  // Airtable hiccup can never break the brain or drop the safety gates.
  let FAQ = FAQ_FALLBACK, TONE = TONE_FALLBACK, MODE = MODE_FALLBACK;
  let confThreshold = CONF_FALLBACK, botEnabled = true;
  try {
    const setResp = await this.helpers.httpRequest({ method: 'GET',
      url: 'https://api.airtable.com/v0/' + BASE_ID + '/' + SETTINGS + '?maxRecords=1',
      headers: A_HEADERS, json: true });
    const sf = ((setResp.records || [])[0] || {}).fields || {};
    if (typeof sf['Bot FAQ'] === 'string' && sf['Bot FAQ'].trim()) FAQ = sf['Bot FAQ'];
    if (typeof sf['Bot Tone'] === 'string' && sf['Bot Tone'].trim()) TONE = sf['Bot Tone'];
    if (sf['Bot Mode'] === 'auto' || sf['Bot Mode'] === 'draft') MODE = sf['Bot Mode'];
    const t = Number(sf['Confidence Threshold']);
    if (Number.isFinite(t) && t >= 0 && t <= 1) confThreshold = t;
    // Master kill switch. Airtable returns the checkbox as `true` when ticked and
    // OMITS the field (undefined/null) when unticked — never literal `false`. So we
    // disable whenever a row exists and Bot Enabled is anything other than `true`.
    // A missing row / failed read leaves it enabled (the fallbacks keep it safe),
    // matching the pre-Phase-2 behaviour.
    if ((setResp.records || []).length && sf['Bot Enabled'] !== true) botEnabled = false;
  } catch (e) { /* non-fatal — keep fallbacks, bot stays enabled */ }
  if (!botEnabled) return stop('bot_disabled');

  if (contact['Do Not Contact'] === true) return stop('do_not_contact');
  // Stand down only if a human has actually CLAIMED the thread (Assigned To set).
  // Do NOT mute on Automation Context='Needs Human' alone — the BOT sets that when
  // it escalates, and since nothing auto-clears it, muting on it would make the bot
  // skip every future message forever after one escalation. A fresh inbound is a
  // fresh question worth answering.
  if (conv.fields['Assigned To']) return stop('assigned');
  if (phone === GYM_PHONE) return stop('own_number');

  // Class schedule snapshot (refreshed daily by the Bot Schedule Snapshot cron).
  // Best-effort — if it's missing/stale the bot just falls back to the link.
  let scheduleText = '';
  let scheduleUpdated = '';
  try {
    const sf = encodeURIComponent("{Key}='class_schedule'");
    const sResp = await this.helpers.httpRequest({ method: 'GET',
      url: 'https://api.airtable.com/v0/' + BASE_ID + '/' + CACHE + '?maxRecords=1&filterByFormula=' + sf,
      headers: A_HEADERS, json: true });
    const row = (sResp.records || [])[0];
    if (row) { scheduleText = row.fields['Value'] || ''; scheduleUpdated = row.fields['Updated At'] || ''; }
  } catch (e) { /* non-fatal */ }

  const lastRun = conv.fields['Bot Last Run At'] ? new Date(conv.fields['Bot Last Run At']).getTime() : 0;
  if (lastRun && Date.now() - lastRun < 20000) return stop('rate_capped');

  // Claim the slot early (before the slow Claude call) so two concurrent inbounds
  // can't both pass the cap and double-send. Best-effort.
  const claimIso = new Date().toISOString();
  try {
    await this.helpers.httpRequest({ method: 'PATCH',
      url: 'https://api.airtable.com/v0/' + BASE_ID + '/' + CONVS + '/' + conv.id,
      headers: A_HEADERS, json: true, body: { fields: { 'Bot Last Run At': claimIso } } });
  } catch (e) { /* non-fatal */ }

  // thread tail (last ~10 blocks) → alternating user/assistant
  const ft = conv.fields['Full Thread'] || '';
  const blocks = ft ? ft.split(/\n+(?=\[\d{1,2}-\d{1,2}-\d{4})/) : [];
  const tail = [];
  for (const b of blocks.slice(-10)) {
    const m = b.match(/^\[[^\]]+\]\s*(.+?):\s*\n?([\s\S]+)$/);
    if (!m) continue;
    const author = (m[1] || '').trim();
    const text = m[2].trim();
    if (!text) continue;
    const isOutbound = author.startsWith('🤖') || author.startsWith('💬') || author.startsWith('🧑') || /^staff\b/i.test(author);
    tail.push({ role: isOutbound ? 'assistant' : 'user', content: text });
  }
  const raw = tail.concat([{ role: 'user', content: msg.messageText }]);
  const messages = [];
  for (const mm of raw) {
    const p = messages[messages.length - 1];
    if (p && p.role === mm.role) p.content += '\n' + mm.content;
    else messages.push({ role: mm.role, content: mm.content });
  }
  while (messages.length && messages[0].role === 'assistant') messages.shift();

  const firstName = ((contact['Name'] || conv.fields['Customer Name'] || msg.fromName || '') + '').split(' ')[0] || '';
  const systemPrefix =
`You are the WhatsApp assistant for MAC SportsClub, a gym in Maastricht. You reply to leads and members in the gym's shared inbox. You are in TEST mode: your replies are sent directly to one test user.

=== HOW TO WRITE (tone) ===
${TONE}

=== WHAT YOU KNOW (the only facts you may use) ===
${FAQ}

=== THIS WEEK'S CLASS SCHEDULE (live, refreshed daily) ===
${scheduleText
  ? scheduleText + '\n\nUse this to answer "what time is <class>?" / "is there <class> on <day>?" with the real day + time when it IS in the list. If a class is NOT in this list, do NOT flatly claim it is not running (the list can be incomplete) — instead say you don\'t see it in the upcoming days here and point them to the full live schedule https://macmaastricht.nl/lesrooster/ . To actually book/reserve a spot they reply with the class + day/time and the front desk books it (you do NOT confirm the booking yourself).'
  : '(schedule unavailable right now — for class times, point them to the live schedule https://macmaastricht.nl/lesrooster/ and offer to have the front desk reserve a spot if they reply with a day/time.)'}

=== THE GOLDEN RULE ===
Only answer from the facts above. If the answer is not clearly there, do NOT guess, invent, or estimate — escalate.

=== ALWAYS ESCALATE (decision="escalate", reply="") ===
1. Anything not covered by the facts. 2. Personal Training or Nutrition pricing/specifics. 3. Membership MONEY/PLAN changes: refunds, billing/payment disputes, switching plans, freezing/pausing. (BUT the plain "how do I cancel my membership?" procedure IS in the facts above, give it directly, do NOT escalate that one.) 4. Anything medical: injury, pregnancy, health conditions. 5. Complaints / upset / negative messages. 6. Confirming a specific booked slot ("you're booked Tuesday 6pm"). 7. Asking for a person / asking if this is a bot.

=== BOOKING NUANCE (rule 6) ===
You MAY give the standard line: book a free 15-min tour via the tour link, OR reply with a day/time and the front desk books it. Only escalate when they ask you to CONFIRM a specific slot.

=== LANGUAGE ===
Reply in the language of the customer's LATEST message: Dutch -> Dutch, English -> English.
This is decided by the message you are replying to, and NOTHING else. The "Language pref"
in the context below is only a stored CRM guess, often wrong (many Dutch-registered members
are international students who write in English). If it disagrees with the message in front
of you, the MESSAGE WINS, every time. Only if the latest message is too short or ambiguous
to tell (e.g. "ok", an emoji) fall back to that stored pref, and to Dutch if it is unknown.
Set the "language" field to the language you actually replied in.

=== OUTPUT ===
Always call emit_reply exactly once. Never write a plain text reply.`;
  // Real current date (Amsterdam) so the bot resolves "tomorrow" / "this weekend"
  // / "Monday" correctly instead of inventing a date. en-GB gives "Saturday,
  // 14 June 2026"; we also pass the ISO date for unambiguous arithmetic.
  const nowAms = new Date();
  const todayLabel = nowAms.toLocaleDateString('en-GB', {
    timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const todayIso = nowAms.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }); // YYYY-MM-DD
  const systemContext =
`CONTEXT:
- Today is ${todayLabel} (${todayIso}, Europe/Amsterdam timezone).
  Use this real date to work out "today", "tomorrow", "this weekend", "next Monday",
  etc. Never guess or invent a date or weekday. If a customer asks about a day and
  you are unsure which calendar date it maps to, ask them to confirm the date.
- First name: ${firstName || '(unknown)'}
- Stored language pref (a WEAK hint only, the customer's latest message overrides it): ${contact['Language'] || '(unknown)'}
- CRM status: ${contact['Status'] || '(unknown)'}
- Membership: ${contact['Membership Type'] || '(none)'}`;

  const tool = { name: 'emit_reply', description: 'Return the bot decision. Always call exactly once.',
    input_schema: { type: 'object', properties: {
      decision: { type: 'string', enum: ['reply', 'escalate'] },
      reply: { type: 'string' }, confidence: { type: 'number' },
      language: { type: 'string', enum: ['EN', 'NL'] }, reason: { type: 'string' },
    }, required: ['decision', 'reply', 'confidence', 'language', 'reason'] } };

  // Body for the Call Claude HTTP node (it attaches the Anthropic credential).
  const anthropicBody = {
    model: MODEL, max_tokens: 1200,
    system: [
      { type: 'text', cache_control: { type: 'ephemeral' }, text: systemPrefix },
      { type: 'text', text: systemContext },
    ],
    tools: [tool], tool_choice: { type: 'tool', name: 'emit_reply' }, messages,
  };

  return [{ json: {
    run: true, mode: MODE, confThreshold, convId: conv.id, phone,
    firstName, language: contact['Language'] || '',
    inboundText: msg.messageText,
    existingThread: conv.fields['Full Thread'] || '',
    anthropicBody,
  } }];
} catch (e) {
  return stop('prep_error: ' + e.message);
}

