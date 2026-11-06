// gate.js — the pre-Claude guard. Decides whether the bot runs AT ALL before
// we spend an API call. Maps 1:1 to the future n8n `Bot Gate` Code node.
//
// Two halves:
//   PURE LOGIC (tested in this harness): opt-out keywords, message type,
//     human-owns-thread, gym's-own-number, loop-vs-last-bot-line.
//   LIVE-STATE TIMING (stubbed here, wired in n8n): <120s automation-just-fired,
//     per-conversation rate cap. These need Airtable's clock + Bot Last Run At,
//     which the harness has no access to, so faking them would be artificial.
//
// Returns { run: true } OR { run: false, reason: '<why>' }.

// Opt-out / STOP keywords (EN + NL). A missed one is a compliance problem, so
// this list is deliberately broad and matched as whole-word, case-insensitive.
const OPT_OUT_KEYWORDS = [
  'stop',
  'unsubscribe',
  'opt out',
  'opt-out',
  'afmelden',
  'uitschrijven',
  'geen berichten meer',
  'no more messages',
  'stop berichten',
  'stop met berichten',
];

// Message types the bot handles. Anything else (image/audio/video/sticker/etc.)
// is skipped in Phase 1 — media handling is deferred.
const HANDLED_TYPES = ['text'];

function normalize(s) {
  return (s || '').toLowerCase().trim();
}

// Opt-out detection. The hard part is NOT missing real opt-outs while NOT
// swallowing genuine questions that happen to contain "stop":
//   - "STOP"                              → opt-out (skip)
//   - "stop please" / "graag stoppen aub" → opt-out (short, command-like)
//   - "how do I stop my membership?"      → NOT opt-out → must reach Claude,
//                                           which escalates it (rule 3). A false
//                                           positive here SILENTLY swallows a
//                                           real cancellation question.
// Rule: a single-word keyword (stop/afmelden/…) only counts as opt-out when the
// message is SHORT and essentially just that command (few words, no question
// mark). Multi-word phrases ("no more messages", "geen berichten meer") match
// as a substring anywhere — they're unambiguous.
function isOptOut(text) {
  const t = normalize(text);
  if (!t) return false;

  // Unambiguous multi-word opt-out phrases: substring match anywhere.
  for (const kw of OPT_OUT_KEYWORDS) {
    const k = kw.toLowerCase();
    if (k.includes(' ') && t.includes(k)) return true;
  }

  // Single-word keywords: only when the message is a short, command-like opt-out
  // (not a question, ≤3 words). Strip punctuation, split into word tokens.
  const hasQuestion = t.includes('?');
  const tokens = t.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (hasQuestion || tokens.length === 0 || tokens.length > 3) return false;
  const singleWordKw = OPT_OUT_KEYWORDS.filter((k) => !k.includes(' ')).map((k) => k.toLowerCase());
  return tokens.some((tok) => singleWordKw.includes(tok));
}

// Does the inbound message essentially echo the last thing the BOT/staff said?
// Cheap loop guard: if the customer's message is (nearly) identical to the last
// outbound line, something is looping — skip. Real n8n version also compares to
// the last *bot* line specifically.
function echoesLastOutbound(inboundText, thread) {
  const last = [...(thread || [])].reverse().find((l) => l && l.from === 'me');
  if (!last) return false;
  return normalize(inboundText) && normalize(inboundText) === normalize(last.text);
}

/**
 * @param {object} tc  test case / live context, shape:
 *   {
 *     inboundText, messageType ('text'|'image'|...),
 *     fromPhone, gymPhone,                       // loop: ignore our own number
 *     contact: { doNotContact, assignedTo, automationContext, ... },
 *     thread: [{from,text}],
 *     // timing (live-state, ignored in harness unless _testTiming set):
 *     _timing: { lastRunAtMsAgo, lastAutomationMsAgo }
 *   }
 */
function shouldBotRun(tc) {
  const c = (tc && tc.contact) || {};

  // --- PURE LOGIC (tested here) ---

  // 1. Do Not Contact — hard skip (also a GDPR requirement).
  if (c.doNotContact === true) return { run: false, reason: 'do_not_contact' };

  // 2. A human has actually CLAIMED the thread → stand down.
  //    NOTE: we do NOT mute on `automationContext === 'needs human'` alone. That
  //    flag is set BY THE BOT when it escalates; if it also muted the bot, then
  //    after a single escalation the bot would skip every future message forever
  //    (the flag is never auto-cleared). A human "owning" the thread is signalled
  //    by `Assigned To` being set (a staff member claimed it) — that's the real
  //    stand-down signal. A fresh inbound is always a fresh question worth a try.
  if (c.assignedTo) return { run: false, reason: 'assigned_to_human' };

  // 3. Message is from the gym's own number (loop / self-message).
  if (tc.fromPhone && tc.gymPhone && tc.fromPhone === tc.gymPhone)
    return { run: false, reason: 'own_number' };

  // 4. Non-text message type — deferred in Phase 1.
  const type = tc.messageType || 'text';
  if (!HANDLED_TYPES.includes(type)) return { run: false, reason: `unhandled_type:${type}` };

  // 5. Opt-out / STOP keyword.
  if (isOptOut(tc.inboundText)) return { run: false, reason: 'opt_out_keyword' };

  // 6. Empty message.
  if (!normalize(tc.inboundText)) return { run: false, reason: 'empty_message' };

  // 7. Loop: inbound echoes the last outbound line.
  if (echoesLastOutbound(tc.inboundText, tc.thread))
    return { run: false, reason: 'echo_loop' };

  // --- LIVE-STATE TIMING (STUBBED — wired in n8n with Airtable clock) ---
  // These only evaluate if a test deliberately supplies _timing; real cases
  // leave them undefined so the harness never fakes them.
  if (tc._timing) {
    const RATE_CAP_MS = 45 * 1000; // skip if bot ran <45s ago (burst debounce)
    const AUTOMATION_GUARD_MS = 120 * 1000; // skip if automation fired <120s ago
    if (typeof tc._timing.lastRunAtMsAgo === 'number' && tc._timing.lastRunAtMsAgo < RATE_CAP_MS)
      return { run: false, reason: 'rate_capped' };
    if (
      typeof tc._timing.lastAutomationMsAgo === 'number' &&
      tc._timing.lastAutomationMsAgo < AUTOMATION_GUARD_MS
    )
      return { run: false, reason: 'automation_just_fired' };
  }
  // NOTE for n8n port: replace the _timing block with reads of the conversation's
  // `Bot Last Run At` and `Last Activity At` fields vs Date.now().

  return { run: true };
}

module.exports = { shouldBotRun, isOptOut, OPT_OUT_KEYWORDS, HANDLED_TYPES };
