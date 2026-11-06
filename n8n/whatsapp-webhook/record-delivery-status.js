// n8n Code node "Record Delivery Status" from the workflow "WhatsApp Webhook — Incoming Messages".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

// Record WhatsApp delivery statuses (sent / delivered / read / failed). Meta posts one to
// this webhook for every message we send. Runs once per webhook call BESIDE the message
// path (own branch off Ack 200, onError: continue, never throws), so a status can never
// get in the way of a customer message.
//  - Messages row with that wamid: Delivery Status only moves forward
//    (pending < sent < failed < delivered < read), plus Status At and Delivery Error.
//  - Conversation: a failure stamps Delivery Failed At + Delivery Error (the inbox shows a
//    "not delivered" warning); a LATER message that gets delivered clears it again.
const AIRTABLE_PAT = '${AIRTABLE_PAT}';
const BASE_ID = 'appXXXXXXXXXXXXXX';
const MSGS_TABLE = 'tblMESSAGES';
const CONV_TABLE = 'tblCONVERSATIONS';
const H = { Authorization: 'Bearer ' + AIRTABLE_PAT, 'Content-Type': 'application/json' };
const RANK = { '': -1, pending: 0, sent: 1, failed: 1.5, delivered: 2, read: 3 };
const SETTLE_MS = { pending: 6000, sent: 6000, failed: 3000, delivered: 3000, read: 0 };
const esc = s => String(s == null ? '' : s).replace(/'/g, "\\'");
const http = (o) => this.helpers.httpRequest({ json: true, headers: H, ...o });
const at = (table, rest) => 'https://api.airtable.com/v0/' + BASE_ID + '/' + table + rest;

let body = {};
try { body = $('Webhook Receive').first().json.body || {}; } catch (e) { return [{ json: { statuses: 0 } }]; }
const statuses = [];
for (const entry of (body.entry || [])) {
  for (const change of (entry.changes || [])) {
    for (const s of (((change || {}).value || {}).statuses || [])) statuses.push(s);
  }
}
if (!statuses.length) return [{ json: { statuses: 0 } }];

const results = [];
for (const s of statuses) {
  const r = { wamid: s.id || '', status: s.status || '' };
  try {
    const st = String(s.status || '');
    if (!s.id || !(st in RANK) || st === '') { r.action = 'ignored'; results.push({ json: r }); continue; }
    const when = new Date((parseInt(s.timestamp, 10) || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const err = (s.errors || [])[0];
    const errText = err ? (String(err.code || '') + ' ' + String(err.title || err.message || '')).trim() : '';
    const phone = s.recipient_id ? '+' + String(s.recipient_id).replace(/\D/g, '') : '';

    // Meta often posts 'sent' and 'delivered' for one message in the same second, as two
    // webhook calls that run at the same time; a plain read-then-write in both lets the
    // lower state land last (seen 2026-09-23: 'delivered' overwritten by 'sent'). Lower
    // states therefore wait a moment and re-read before writing; 'read' never waits.
    if (SETTLE_MS[st]) await new Promise(res => setTimeout(res, SETTLE_MS[st]));

    // 1) the message row(s) with this wamid
    const found = await http({ method: 'GET', url: at(MSGS_TABLE, '?maxRecords=5&filterByFormula=' + encodeURIComponent("{WA Message ID}='" + esc(s.id) + "'")) });
    const rows = found.records || [];
    if (rows.length) {
      const notes = [];
      for (const rw of rows) {
        const cur = rw.fields['Delivery Status'] || '';
        if (RANK[st] > RANK[cur]) {
          await http({ method: 'PATCH', url: at(MSGS_TABLE, '/' + rw.id),
            body: { fields: { 'Delivery Status': st, 'Status At': when, 'Delivery Error': st === 'failed' ? errText : '' } } });
          notes.push((cur || 'empty') + ' -> ' + st);
        } else {
          notes.push('kept ' + cur);
        }
      }
      r.row = notes.join(', ');
    } else if (st !== 'read') {
      // No row yet: the automation that sent it may still be logging it (a batch run takes
      // up to a minute). Park the receipt as a stub row — same wamid, NO phone, so the inbox
      // never shows it — which the automation's logger takes over. 'read' is not parked: it
      // can arrive days later for messages that will never get a row.
      await http({ method: 'POST', url: at(MSGS_TABLE, ''),
        body: { fields: { 'WA Message ID': s.id, 'Delivery Status': st, 'Status At': when,
          'Delivery Error': st === 'failed' ? errText : '', 'Label': 'delivery receipt (no message row yet)' } } });
      r.row = 'parked';
    } else {
      r.row = 'none';
    }
    const row = rows.find(x => x.fields['Sent At']) || null;

    // 2) the conversation warning
    if (phone && (st === 'failed' || st === 'delivered' || st === 'read')) {
      const cf = await http({ method: 'GET', url: at(CONV_TABLE, '?maxRecords=1&fields%5B%5D=' + encodeURIComponent('Delivery Failed At') +
        '&filterByFormula=' + encodeURIComponent("{Phone}='" + esc(phone) + "'")) });
      const conv = (cf.records || [])[0] || null;
      if (conv) {
        const failedAt = conv.fields['Delivery Failed At'] || '';
        if (st === 'failed') {
          if (!failedAt || when > failedAt) {
            await http({ method: 'PATCH', url: at(CONV_TABLE, '/' + conv.id),
              body: { fields: { 'Delivery Failed At': when, 'Delivery Error': errText } } });
            r.conv = 'flagged';
          }
        } else if (failedAt && row && row.fields['Sent At'] && row.fields['Sent At'] > failedAt) {
          await http({ method: 'PATCH', url: at(CONV_TABLE, '/' + conv.id),
            body: { fields: { 'Delivery Failed At': null, 'Delivery Error': '' } } });
          r.conv = 'cleared';
        }
      }
    }
  } catch (e) {
    r.error = e.message;
  }
  results.push({ json: r });
}
return results;

