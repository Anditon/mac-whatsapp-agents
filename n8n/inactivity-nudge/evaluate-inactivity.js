// n8n Code node "Evaluate Inactivity" from the workflow "Automation 6 — Inactive Member Nudge".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

const items = $input.all();
const now = Date.now();
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const INACTIVE_MIN_DAYS = 14;
const INACTIVE_MAX_DAYS = 60;
const NUDGE_COOLDOWN_DAYS = 90;
const MAX_PER_RUN = 5; // TEST DAYS: gentle 5/day rollout to gauge reactions; bump once validated. // TEST DAYS: gentle 5/day rollout to gauge reactions; bump once validated.

// One-off guard (2026-09-23): members who WERE nudged but whose cooldown date was never
// written, because Carry Recipient credited sends to the wrong member (bug fixed the same
// day). Their date here counts as their last nudge. Remove an entry once
// 'Last Inactive Nudge Date' holds it in Airtable.
const KNOWN_NUDGES = { 'recXXXXXXXXXXXXXX': '2026-09-23' };

// Cooldown is per PHONE, not per contact row: duplicate rows for one person (a funnel row
// plus a Virtuagym Import row) share a number, and a nudge to either counts for both.
const digits = s => String(s || '').replace(/\D/g, '');
const lastNudgeByPhone = {};
for (const it of items) {
  const k = digits(it.json.Phone);
  const d = it.json['Last Inactive Nudge Date'] || KNOWN_NUDGES[it.json.id] || '';
  if (k && d && (!lastNudgeByPhone[k] || d > lastNudgeByPhone[k])) lastNudgeByPhone[k] = d;
}

const eligible = [];
let skippedEnded = 0, skippedNotStarted = 0, skippedCancelled = 0;
for (const item of items) {
  const r = item.json;
  if (r['Do Not Contact']) continue;            // HARD DNC gate (filter also excludes)

  // ACTIVITY = most recent of card check-in (5a) and attended class (5c). Class regulars
  // often never swipe a card; judging by check-ins alone mis-flags them as inactive
  // (30 such members measured 2026-07-05) and hides card-less yoga-goers entirely.
  const ciMs = r['Last Check-In'] ? new Date(r['Last Check-In']).getTime() : NaN;
  const clMs = r['Last Class Date'] ? new Date(r['Last Class Date']).getTime() : NaN;
  const lastActivityMs = Math.max(isNaN(ciMs) ? 0 : ciMs, isNaN(clMs) ? 0 : clMs);
  if (!lastActivityMs) continue;

  // CONTRACT-END GATE: never nudge an ex-member. Status can lag (4a deactivated), so
  // trust the synced contract end date. Skip if it exists AND is in the past — that member
  // has left; they belong to win-back, not an 'everything okay?' nudge. Empty/future = still active.
  const endRaw = r['Contract End Date'];
  if (endRaw) {
    const endMs = new Date(endRaw).getTime();
    if (!isNaN(endMs) && endMs < now) { skippedEnded++; continue; }
  }

  // CONTRACT-NOT-STARTED GATE: 5a picks the member's ACTIVE instance, which can be a future
  // contract (old plan ended, new one starts next month - a member was nudged 2026-07-15 in that gap).
  // A start date in the future means no membership is running today: nothing to nudge about.
  const startRaw = r['Contract Start Date'];
  if (startRaw) {
    const startMs = new Date(startRaw).getTime();
    if (!isNaN(startMs) && startMs > now) { skippedNotStarted++; continue; }
  }

  // CANCELLED-NOTICE GATE: member gave notice but the contract still runs (VG instance
  // active+cancelled, synced daily by 5a - a member was nudged 2026-07-16 after cancelling).
  // They chose to leave; a 'we miss you' nudge reads tone-deaf. Filter also excludes;
  // this is the hard gate. Checkbox is OMITTED when unticked, so test === true.
  if (r['Membership Cancelled'] === true) { skippedCancelled++; continue; }

  // Key name kept: 'Carry Recipient' downstream reads daysSinceCheckin.
  const daysSinceCheckin = (now - lastActivityMs) / MS_PER_DAY;
  if (daysSinceCheckin < INACTIVE_MIN_DAYS || daysSinceCheckin > INACTIVE_MAX_DAYS) continue;

  const lastNudge = lastNudgeByPhone[digits(r.Phone)] || '';
  if (lastNudge) {
    const daysSinceNudge = (now - new Date(lastNudge).getTime()) / MS_PER_DAY;
    if (daysSinceNudge < NUDGE_COOLDOWN_DAYS) continue;
  }

  const lang = r.Language === 'EN' ? 'en' : 'nl';
  const languageCode = lang === 'en' ? 'en_US' : 'nl';

  eligible.push({
    json: {
      recordId: r.id,
      phone: r.Phone,
      name: r.Name || '',
      language: lang,
      languageCode,
      templateName: 'inactive_nudge_' + lang,
      daysSinceCheckin: Math.round(daysSinceCheckin)
    }
  });
}

if (skippedEnded || skippedNotStarted || skippedCancelled) {
  console.log('Inactive nudge skips: ' + skippedEnded + ' contract ended, ' +
    skippedNotStarted + ' contract not started yet, ' + skippedCancelled + ' cancelled-notice.');
}

// Volume cap: serve the most-inactive first (closest to aging out of the 60-day window),
// so a large backlog drains over several daily runs instead of firing in one burst.
// The 90-day cooldown means served members drop out next run, so this self-drains.
eligible.sort((a, b) => b.json.daysSinceCheckin - a.json.daysSinceCheckin);
// One nudge per phone per run, even if two contact rows for that number are eligible.
const seenPhones = new Set();
const unique = eligible.filter(e => { const k = digits(e.json.phone); if (seenPhones.has(k)) return false; seenPhones.add(k); return true; });
const capped = unique.slice(0, MAX_PER_RUN);
if (unique.length > capped.length) {
  console.log('Inactive nudge: ' + unique.length + ' eligible, sending ' + capped.length +
    ' this run (cap ' + MAX_PER_RUN + '); ' + (unique.length - capped.length) + ' deferred to next run.');
}

return capped;

