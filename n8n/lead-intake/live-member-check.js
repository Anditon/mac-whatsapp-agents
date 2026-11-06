// n8n Code node "Live Member Check — Day 1" from the workflow "Automation 1+3 v4 — Class-Aware Trial Routing".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

// Live Member Check: runs right BEFORE the Day-1/Day-3 gate.
// Airtable Status is only as fresh as the daily 10:00 sync (5a), so someone who joins later that
// day still reads 'Lead' and would get a lead follow-up as a brand-new member (a new member was sent
// the "want to keep training?" offer three days after signing up, 2026-10-12). So we ask Virtuagym
// directly. A loose match (email OR phone) is the safe direction: we look for a reason NOT to send.
// A match rewrites Status to 'Active Member' so the gate's existing 'Lead' / 'Trial Completed'
// condition fails; nothing else about the item changes.
// FAILS CLOSED: if Virtuagym can't be reached, Status becomes 'VG check failed' and the gate stops.
// Only contacts the gate would otherwise PASS cost any API calls.
const http = this.helpers.httpRequest.bind(this.helpers);
const VG = 'https://api.virtuagym.com/api/v1/club/<CLUB_ID>/member';
const AUTH = 'api_key=${VG_API_KEY}&club_secret=${VG_CLUB_SECRET}';
const WINDOW_DAYS = 180;      // members edited in the last 180 days = ~97% of active members, 4 pages
const PLACEHOLDER = 'johnsnow@nightswatch.com';

async function get(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await http({ method: 'GET', url, json: true }); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
  throw last;
}
function last9(s) { const d = String(s || '').replace(/[^0-9]/g, ''); return d.length >= 9 ? d.slice(-9) : ''; }
function mail(s) { return String(s || '').trim().toLowerCase(); }

async function findMember(email, p9) {
  if (email && email !== PLACEHOLDER) {
    const r = await get(`${VG}?${AUTH}&email=${encodeURIComponent(email)}`);
    const hit = ((r && r.result) || []).find(m => m.active === true);
    if (hit) return hit;
  }
  let cursor = String(Date.now() - WINDOW_DAYS * 86400000);
  for (let p = 0; p < 20; p++) {
    const r = await get(`${VG}?${AUTH}&limit=500&sync_from=${cursor}`);
    const recs = (r && r.result) || [];
    const hit = recs.find(m => m.active === true &&
      ((p9 && last9(m.mobile || m.phone) === p9) || (email && email !== PLACEHOLDER && mail(m.email) === email)));
    if (hit) return hit;
    const st = (r && r.status) || {};
    if (!st.next_page || st.results_remaining === 0 || !recs.length) return null;
    const nc = (String(st.next_page).split('sync_from=')[1] || '').split('&')[0];
    if (!nc || nc === cursor) return null;
    cursor = nc;
  }
  throw new Error('member scan hit the page cap: incomplete');
}

const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const item = items[i].json || {};
  const status = String(item.Status || '');
  const wouldPass = (status === 'Lead' || status === 'Trial Completed') && item['Do Not Contact'] !== true;
  if (!wouldPass) { out.push({ json: item, pairedItem: { item: i } }); continue; }
  try {
    const hit = await findMember(mail(item.Email), last9(item.Phone));
    if (hit) {
      out.push({ json: { ...item, Status: 'Active Member',
        liveMemberCheck: `Virtuagym member ${hit.member_id} (${hit.firstname || ''} ${hit.lastname || ''}): follow-up skipped` }, pairedItem: { item: i } });
    } else {
      out.push({ json: { ...item, liveMemberCheck: 'not a Virtuagym member' }, pairedItem: { item: i } });
    }
  } catch (e) {
    out.push({ json: { ...item, Status: 'VG check failed',
      liveMemberCheck: 'Virtuagym unreachable, follow-up skipped (fails closed): ' + String((e && e.message) || e).slice(0, 200) }, pairedItem: { item: i } });
  }
}
return out;

