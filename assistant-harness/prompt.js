// prompt.js — LOCKED machinery. A worker never edits this.
//
// Builds the Anthropic request pieces from the two editable blobs (faq, tone)
// plus the per-message context. The identity, the 7 escalation rules, the
// language-matching rule, and the output contract live here and are NOT
// worker-editable.
//
// PORT NOTE: this file is pure string-building with no I/O — it ports into the
// n8n `Call Claude` HTTP Request node body unchanged. faq/tone come from the
// const (Phase 1) or the Gym Settings row (Phase 2) instead of local files.

// The forced-tool output contract. Claude MUST call this tool, which guarantees
// schema-valid JSON (no prose-parsing). Mirrored exactly in production.
const EMIT_REPLY_TOOL = {
  name: 'emit_reply',
  description:
    'Return the bot decision for this customer message. Always call this tool ' +
    'exactly once. Either draft a reply, or escalate to a human.',
  input_schema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['reply', 'escalate'],
        description:
          "'reply' = you are confident and the answer is in the FAQ. " +
          "'escalate' = hand to a human (anything not in the FAQ, or any of " +
          'the always-escalate rules).',
      },
      reply: {
        type: 'string',
        description:
          'The WhatsApp message to send the customer. Empty string when ' +
          "decision is 'escalate'.",
      },
      confidence: {
        type: 'number',
        description:
          'Your confidence 0.0–1.0 that this reply is correct and safe. ' +
          'Be honest; low confidence is fine and useful.',
      },
      language: {
        type: 'string',
        enum: ['EN', 'NL'],
        description: 'The language you replied in (match the customer).',
      },
      reason: {
        type: 'string',
        description:
          'One short sentence: why you replied, or which rule made you escalate.',
      },
    },
    required: ['decision', 'reply', 'confidence', 'language', 'reason'],
  },
};

// The fixed scaffolding wrapped around the editable tone + faq.
// Worker-editable content (tone, faq) is INSERTED; everything else is locked.
function buildSystemBlocks(faq, tone) {
  const identityAndRules = `You are the WhatsApp assistant for MAC SportsClub, a gym in Maastricht.
You reply to messages from leads and members in the gym's shared inbox.

You work in DRAFT MODE: your reply is shown to a staff member who approves it
before it is sent. Write as if the customer will read it directly.

=== HOW TO WRITE (tone) ===
${tone.trim()}

=== WHAT YOU KNOW (the only facts you may use) ===
${faq.trim()}

=== THE GOLDEN RULE ===
Only answer from the facts above. If the answer is not clearly in those facts,
do NOT guess, invent, estimate, or reason your way to an answer — escalate to a
human instead. A wrong confident answer is far worse than handing it to a person.

=== ALWAYS ESCALATE (decision = "escalate", reply = "") ===
Escalate, no matter how the question is phrased, when it involves:
1. Anything not covered by the facts above.
2. Personal Training prices/specifics, or Nutrition coaching specifics.
3. Membership MONEY/PLAN changes: refunds, billing/payment disputes, switching
   plans, freezing/pausing. (BUT the plain "how do I cancel my membership?"
   procedure IS in the facts above — give it directly, do NOT escalate that one.)
4. Anything medical: injuries, pregnancy, health conditions, "can I train
   with <condition>".
5. Complaints, or any upset / angry / negative message.
6. Confirming a specific booked appointment slot (e.g. "yes, you're booked
   Tuesday at 6pm"). You have no booking ability.
7. A request to speak to a person, or asking whether this is a bot/automated.

=== BOOKING (the one nuance on rule 6) ===
You MAY give the standard booking line: tell them they can book a free 15-min
tour via the tour link, OR reply with a day and time and the front desk will
book it for them. That is allowed and confident — it's not a confirmation.
Only escalate when they ask you to CONFIRM a specific slot is reserved.

=== LANGUAGE ===
Reply in the language of the customer's latest message: Dutch → Dutch,
English → English. If genuinely unclear, default to Dutch (the gym is in NL).
Set the "language" field to match.

=== OUTPUT ===
Always call the emit_reply tool exactly once. Never write a normal text reply.`;

  // Two blocks: block 1 is the large static prefix (cached in production via
  // cache_control); block 2 is per-message context (small, uncached).
  return [
    {
      type: 'text',
      text: identityAndRules,
      cache_control: { type: 'ephemeral' }, // ~90% input-token discount on the prefix
    },
  ];
}

// Per-message dynamic context → a second system block (uncached). Kept separate
// from the cached prefix so the big FAQ stays cacheable across messages.
// GDPR: only first name + status/membership/language go here — NO email/phone/IDs.
function buildContextBlock(contact) {
  const c = contact || {};
  // Real current date (Amsterdam) so the bot resolves relative days ("tomorrow",
  // "this weekend", "Monday") correctly instead of inventing one. A test case may
  // pin `c.now` (a Date) for determinism; otherwise use the real clock.
  const now = c.now instanceof Date ? c.now : new Date();
  const todayLabel = now.toLocaleDateString('en-GB', {
    timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const todayIso = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
  const lines = [
    'CONTEXT FOR THIS CONVERSATION:',
    `- Today is ${todayLabel} (${todayIso}, Europe/Amsterdam timezone). Use this real`,
    '  date to work out "today"/"tomorrow"/"this weekend"/"next Monday". Never guess',
    '  a date or weekday; if unsure which date a day maps to, ask them to confirm.',
    `- Customer first name: ${c.firstName || '(unknown)'}`,
    `- Known language preference: ${c.language || '(unknown — detect from message)'}`,
    `- CRM status: ${c.status || '(unknown)'}`,
    `- Membership: ${c.membership || '(none / unknown)'}`,
  ];
  return { type: 'text', text: lines.join('\n') };
}

// The message array: prior thread tail (already classified them/me) + the new
// inbound message. Thread lines are {from:'them'|'me', text}. We map them to
// user/assistant turns so Claude sees the back-and-forth.
function buildMessages(thread, inboundText) {
  const raw = [];
  for (const line of thread || []) {
    if (!line || !line.text) continue;
    raw.push({
      role: line.from === 'me' || line.from === 'bot' ? 'assistant' : 'user',
      content: line.text,
    });
  }
  // The current inbound message Claude must respond to.
  raw.push({ role: 'user', content: inboundText || '' });

  // The Anthropic API REQUIRES strictly alternating user/assistant turns. On
  // WhatsApp a customer routinely sends two messages in a row → two consecutive
  // 'them' lines → two consecutive 'user' turns → the API 400s. Merge any run of
  // same-role turns into one (newline-joined) so the array always alternates.
  const msgs = [];
  for (const m of raw) {
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === m.role) {
      prev.content += '\n' + m.content;
    } else {
      msgs.push({ role: m.role, content: m.content });
    }
  }

  // The first message must be a user turn. If the (now-merged) array starts with
  // an assistant turn, drop it.
  while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
  return msgs;
}

// Assemble the full request body for POST /v1/messages.
function buildRequest({ faq, tone, contact, thread, inboundText, model }) {
  return {
    model: model || 'claude-sonnet-4-6',
    // 400 was too small: a timetable answer was cut off mid tool call (production fix, 2026-09-04).
    max_tokens: 1200,
    system: [...buildSystemBlocks(faq, tone), buildContextBlock(contact)],
    tools: [EMIT_REPLY_TOOL],
    tool_choice: { type: 'tool', name: 'emit_reply' }, // FORCE the tool
    messages: buildMessages(thread, inboundText),
  };
}

module.exports = {
  EMIT_REPLY_TOOL,
  buildSystemBlocks,
  buildContextBlock,
  buildMessages,
  buildRequest,
};
