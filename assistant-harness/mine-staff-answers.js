#!/usr/bin/env node
// mine-staff-answers.js — pull every staff reply out of the Airtable
// Conversations "Full Thread" field, so we can see what the front desk actually
// answers and feed the recurring ones back into faq.md.
//
// Run this PERIODICALLY (e.g. every couple of weeks) to keep the bot learning
// from real staff answers. It's read-only — it never writes to Airtable.
//
//   node mine-staff-answers.js              # prints customer→staff Q&A pairs
//   node mine-staff-answers.js > out.txt    # save for review
//
// Then read the output, spot questions that recur (prices, passes, policies,
// classes, scans, etc.), and add any missing facts to faq.md → redeploy.
//
// Token and ids come from the environment so nothing private is committed:
//   AIRTABLE_PAT=... AIRTABLE_BASE_ID=app... AIRTABLE_CONVERSATIONS_TABLE=tbl... node mine-staff-answers.js
// The output holds real customer messages: keep it local and delete it after use.

const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.AIRTABLE_BASE_ID;
const CONVS = process.env.AIRTABLE_CONVERSATIONS_TABLE || 'Conversations';
if (!PAT || !BASE) {
  console.error('Set AIRTABLE_PAT and AIRTABLE_BASE_ID first.');
  process.exit(2);
}

async function fetchAll() {
  const out = [];
  let offset = '';
  do {
    const url =
      `https://api.airtable.com/v0/${BASE}/${CONVS}?pageSize=100` +
      `&fields%5B%5D=Full%20Thread` +
      (offset ? `&offset=${offset}` : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + PAT } });
    if (!r.ok) throw new Error('Airtable ' + r.status + ': ' + (await r.text()));
    const d = await r.json();
    out.push(...d.records);
    offset = d.offset || '';
  } while (offset);
  return out;
}

// Split a Full Thread into {author, text} blocks (same delimiter the inbox uses).
function parseThread(ft) {
  const blocks = ft.split(/\n+(?=\[\d{1,2}-\d{1,2}-\d{4})/);
  const msgs = [];
  for (const b of blocks) {
    const m = b.match(/^\[([^\]]+)\]\s*(.+?):\s*\n?([\s\S]+)$/);
    if (!m) continue;
    const author = m[2].trim();
    const text = m[3].trim();
    let who = 'them';
    if (author.startsWith('🤖')) who = 'bot';
    else if (author.startsWith('💬') || author.startsWith('🧑') || /staff/i.test(author)) who = 'staff';
    msgs.push({ who, author, text });
  }
  return msgs;
}

function isNoise(text) {
  const t = text.toLowerCase().trim();
  if (t.length < 3) return true;
  if (/^(test|hi|hii+|hello|hey|ok|oke|okay|bedankt|dank|thanks?|👍|💪|yes|no)$/i.test(t)) return true;
  if (/^\[(image|reaction|automated)/i.test(t)) return true;
  if (/(.)\1{20,}/.test(t)) return true; // long repeated-char junk
  return false;
}

(async () => {
  const recs = await fetchAll();
  let convs = 0, pairs = 0, staffLines = 0;
  const out = [];

  for (const r of recs) {
    const ft = r.fields['Full Thread'];
    if (!ft) continue;
    const msgs = parseThread(ft);
    const staff = msgs.filter((m) => m.who === 'staff');
    if (!staff.length) continue;
    convs++;
    staffLines += staff.length;

    // Pair each staff reply with the most recent preceding customer message.
    // Names are not printed: mining FAQ facts doesn't need to know who asked.
    let lastCustomer = null;
    const localPairs = [];
    for (const m of msgs) {
      if (m.who === 'them') lastCustomer = m.text;
      else if (m.who === 'staff' && lastCustomer && !isNoise(m.text) && !isNoise(lastCustomer)) {
        localPairs.push({ q: lastCustomer, a: m.text });
        lastCustomer = null; // consume
      }
    }
    if (!localPairs.length) continue;
    out.push(`=== conversation ${convs} ===`);
    for (const p of localPairs) {
      out.push('  Q: ' + p.q.replace(/\s+/g, ' ').slice(0, 300));
      out.push('  A: ' + p.a.replace(/\s+/g, ' ').slice(0, 500));
      out.push('');
      pairs++;
    }
  }

  console.log(out.join('\n'));
  console.error(
    `\n[summary] ${recs.length} conversations · ${convs} with staff replies · ` +
      `${staffLines} staff lines · ${pairs} customer→staff Q&A pairs extracted`
  );
  console.error('[next] skim for RECURRING questions, add missing facts to faq.md, redeploy.');
})();
