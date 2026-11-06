// n8n Code node "Live Activity Re-Check" from the workflow "Automation 6 — Inactive Member Nudge".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

// LIVE ACTIVITY RE-CHECK — the last gate before a nudge is sent.
//
// WHY: 'Evaluate Inactivity' judges on Airtable fields written by the 5a (10:00) and
// 5c (10:15) syncs. A6 runs at 11:00, so anything that happens in the gym THIS MORNING
// is invisible to it. Worse, 5c only counts a class where the instructor ticked
// present:true — a booking that is never marked present NEVER reaches Airtable at all
// (measured 2026-09-18: 50 of 257 members with a real class booking in the last 3 days
// were never marked present). One member booked a 10:30 class on
// 2026-09-18 and received 'everything okay?' at 11:00, 30 minutes into her class.
//
// WHAT: re-query Virtuagym directly for each candidate and drop anyone who has
// checked in OR booked/attended a real class inside RECHECK_DAYS. A BOOKING counts,
// not just a present:true attendance — someone who booked today is plainly engaged.
//
// FAIL-CLOSED: if Virtuagym cannot be reached we send NOTHING this run. A nudge is
// never urgent and the run repeats tomorrow; sending a wrong 'we miss you' to someone
// who is in the building costs trust, which is the whole point of this gate.

const VG_BASE = 'https://api.virtuagym.com/api/v1/club/<CLUB_ID>';
const VG_Q = 'api_key=${VG_API_KEY}&club_secret=${VG_CLUB_SECRET}';
const RECHECK_DAYS = 3;          // covers the sync gap plus a safety margin
const MAX_PAGES = 12;
const FRONT_DESK_ID = 10000001;  // shared front-desk account, never a real member

const candidates = $input.all();
if (!candidates.length) return [];

// Map recordId -> Virtuagym ID. A candidate with no VG ID cannot be re-checked;
// it is passed through (its Airtable data is all we will ever have for them).
const airtable = $('Find Active Members').all();
const vgById = {};
for (const a of airtable) {
  const vg = String(a.json['Virtuagym ID'] || '').trim();
  if (vg) vgById[a.json.id] = vg;
}

const nowSec = Math.floor(Date.now() / 1000);
const nowMs = Date.now();
const sinceSec = nowSec - RECHECK_DAYS * 86400;
const sinceMs = sinceSec * 1000;
const untilSec = nowSec + 86400;

async function getJson(url) {
  return await this.helpers.httpRequest({ url, method: 'GET', json: true, timeout: 20000 });
}

// Virtuagym pages via a sync_from CURSOR, not a page number. Passing &page=N silently
// re-serves the same first 500 rows (verified 2026-09-18), so the cursor is mandatory.
async function pageAll(path, extra) {
  const rows = [];
  let cursor = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    let url = VG_BASE + '/' + path + '?' + VG_Q + '&limit=500' + (extra || '');
    if (cursor) url += '&sync_from=' + cursor;
    const d = await getJson.call(this, url);
    const res = (d && d.result) || [];
    rows.push(...res);
    const st = (d && d.status) || {};
    if (!(st.results_remaining > 0) || !st.next_page) break;
    const m = /sync_from=(\d+)/.exec(String(st.next_page));
    const next = m ? m[1] : null;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return rows;
}

const activeVg = new Set();
try {
  // 1) Card check-ins. check_in_timestamp is MILLISECONDS — never multiply by 1000.
  const checkins = await pageAll.call(this, 'checkin', '&sync_from=' + sinceMs);
  for (const c of checkins) {
    const ts = Number(c.check_in_timestamp);
    if (ts >= sinceMs && ts <= nowMs + 86400000) activeVg.add(String(c.member_id));
  }

  // 2) Class bookings in the window. Open-gym 'Fitness' rows are a floor slot, not a
  //    class, and Virtual/Online/On Demand are filler — both are excluded, matching 5c.
  const win = '&timestamp_start=' + sinceSec + '&timestamp_end=' + untilSec;
  const events = await pageAll.call(this, 'events', win);
  const realEvent = new Set();
  for (const e of events) {
    const t = String(e.title || '').trim().toLowerCase();
    if (!t) continue;
    if (t === 'fitness' || t === 'fitness en balie') continue;
    if (t.includes('virtual') || t.includes('online') || t.includes('on demand')) continue;
    if (e.canceled === true) continue;
    realEvent.add(e.event_id);
  }
  const parts = await pageAll.call(this, 'eventparticipants', win);
  for (const p of parts) {
    if (!realEvent.has(p.event_id)) continue;
    const mid = String(p.member_id);
    if (!mid || mid === '0' || mid === String(FRONT_DESK_ID)) continue;
    activeVg.add(mid);   // a BOOKING is enough; present:true is not required
  }
} catch (err) {
  // Fail closed: no live proof means no send.
  console.log('A6 live re-check FAILED (' + (err && err.message) + ') — sending 0 nudges this run.');
  return [];
}

const passed = [];
const blocked = [];
for (const item of candidates) {
  const vg = vgById[item.json.recordId];
  if (vg && activeVg.has(String(vg))) {
    blocked.push(item.json.name + ' (vg ' + vg + ')');
    continue;
  }
  passed.push(item);
}

if (blocked.length) {
  console.log('A6 live re-check blocked ' + blocked.length +
    ' nudge(s) — active in Virtuagym within ' + RECHECK_DAYS + 'd: ' + blocked.join(', '));
}
console.log('A6 live re-check: ' + passed.length + ' of ' + candidates.length + ' cleared to send.');

return passed;

