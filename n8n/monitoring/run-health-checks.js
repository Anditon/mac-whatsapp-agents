// n8n Code node "Run Health Checks" from the workflow "MAC Health Check — Daily".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

// MAC SportsClub — Daily Health Check
// Pings every external connection (Virtuagym / WhatsApp / Airtable) + n8n-internal
// workflow & execution health, composes an HTML report, and decides whether an
// urgent alert is needed. Sandbox: NO fetch, NO URLSearchParams -> this.helpers.httpRequest + manual query strings.

const http = this.helpers.httpRequest.bind(this.helpers);

// ---- config / secrets ----
const N8N_API = 'https://n8n.example.com/api/v1';
const N8N_KEY = '${N8N_API_KEY}';

const VG_KEY = '${VG_API_KEY}';
const VG_SEC = '${VG_CLUB_SECRET}';
const VG_MEMBER = 'https://api.virtuagym.com/api/v1/club/<CLUB_ID>/member';

const WA_TOKEN = '${WA_TOKEN}';
const WA_PHONE_ID = '<PHONE_NUMBER_ID>';
const WA_WABA_ID = '<WABA_ID>';
const GRAPH = 'https://graph.facebook.com/v25.0';

const AIRTABLE_PAT = '${AIRTABLE_PAT}';
const BASE = 'appXXXXXXXXXXXXXX';
const T_CONTACTS = 'tblCONTACTS';

const MAC_WORKFLOWS = {
  'WF_LEAD_INTAKE': 'A1+3 v4 (Lead/Trial intake)',
  'WF_QR_WALKIN': 'A2 (QR Walk-In)',
  'WF_POST_TRIAL': 'A3 (Post-Trial Follow-Up)',
  'WF_CHECKIN_SYNC': '5a (Check-In Sync)',
  'WF_UPSELL': '5b (Upsell Evaluator)',
  'WF_CLASS_SYNC': '5c (Class-Booking Sync)',
  'WF_INACTIVE_NUDGE': 'A6 (Inactive Nudge)',
  'WF_PLAN_UPGRADE': 'A7 (Plan Upgrade)',
  'WF_BOOKING_RECONCILE': 'A8 (Booking Reconcile)',
  'WF_WHATSAPP_WEBHOOK': 'WhatsApp Webhook (Inbound + Bot)',
  'WF_SEND_REPLY': 'WA Inbox - Send Reply',
  'WF_INBOX_API': 'MAC Inbox UI',
  'WF_CHANGE_PINGS': 'Inbox Change Pings (Airtable webhooks)',
  'WF_WEBHOOK_KEEPER': 'Inbox Webhook Keeper',
  'WF_SCHEDULE_SNAPSHOT': 'Bot Schedule Snapshot',
  'WF_WEEKLY_REPORT': 'Weekly Summary Report',
  'WF_HEALTH_CHECK': 'MAC Health Check (self)',
};
const MAC_IDS = Object.keys(MAC_WORKFLOWS);

const now = new Date();
const checks = [];
const add = (name, status, detail, critical) => checks.push({ name, status, detail: detail || '', critical: !!critical });
const errStr = (e) => {
  try { if (e && e.response && e.response.body) return JSON.stringify(e.response.body).slice(0, 200); } catch (x) {}
  return (e && e.message) ? e.message : String(e);
};
async function get(url, headers) {
  return await http({ method: 'GET', url, headers: headers || {}, json: true, timeout: 25000 });
}

// 1. Virtuagym
try {
  const body = await get(`${VG_MEMBER}?api_key=${VG_KEY}&club_secret=${VG_SEC}&limit=1`);
  if (body && Array.isArray(body.result)) add('Virtuagym API', 'ok', 'Member fetch OK');
  else add('Virtuagym API', 'fail', 'Unexpected response shape', true);
} catch (e) { add('Virtuagym API', 'fail', `Request failed: ${errStr(e)}`, true); }

// 2. WhatsApp token + number
try {
  const body = await get(`${GRAPH}/${WA_PHONE_ID}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,name_status&access_token=${WA_TOKEN}`);
  if (body && body.id) {
    const q = body.quality_rating || 'UNKNOWN';
    const qOk = q === 'GREEN' || q === 'UNKNOWN';
    add('WhatsApp token + number', qOk ? 'ok' : 'warn', `${body.display_phone_number || ''} (${body.verified_name || ''}) · quality: ${q}`);
  } else add('WhatsApp token + number', 'fail', 'No phone-number data returned', true);
} catch (e) { add('WhatsApp token + number', 'fail', `Graph error (token revoked / number issue?): ${errStr(e)}`, true); }

// 3. WhatsApp template health
try {
  const body = await get(`${GRAPH}/${WA_WABA_ID}/message_templates?fields=name,status,language&limit=250&access_token=${WA_TOKEN}`);
  const tpls = (body && body.data) || [];
  const bad = tpls.filter(t => ['REJECTED', 'PAUSED', 'DISABLED', 'PENDING_DELETION'].includes(String(t.status || '').toUpperCase()));
  if (!bad.length) add('WhatsApp templates', 'ok', `${tpls.length} templates, all healthy`);
  else add('WhatsApp templates', 'warn', `${bad.length} not-approved: ` + bad.map(t => `${t.name}/${t.language}=${t.status}`).join(', '));
} catch (e) { add('WhatsApp templates', 'warn', `Could not fetch templates: ${errStr(e)}`); }

// 4. Airtable PAT
try {
  const body = await get(`https://api.airtable.com/v0/${BASE}/${T_CONTACTS}?maxRecords=1`, { Authorization: `Bearer ${AIRTABLE_PAT}` });
  if (body && Array.isArray(body.records)) add('Airtable API', 'ok', 'PAT valid, base reachable');
  else add('Airtable API', 'fail', 'Unexpected response', true);
} catch (e) { add('Airtable API', 'fail', `Request failed (PAT expired?): ${errStr(e)}`, true); }

// 5. Data-sync freshness — 5a (check-ins) and 5c (class attendance)
async function freshness(fieldName, label, workflow, maxDays) {
  try {
    let qs = 'pageSize=1';
    qs += '&sort%5B0%5D%5Bfield%5D=' + encodeURIComponent(fieldName);
    qs += '&sort%5B0%5D%5Bdirection%5D=desc';
    qs += '&filterByFormula=' + encodeURIComponent('{' + fieldName + '} != BLANK()');
    const body = await get(`https://api.airtable.com/v0/${BASE}/${T_CONTACTS}?${qs}`, { Authorization: `Bearer ${AIRTABLE_PAT}` });
    const rec = ((body && body.records) || [])[0];
    const last = rec && rec.fields && rec.fields[fieldName];
    if (!last) { add(label, 'warn', `No ${fieldName} data found`); return; }
    const ageDays = (now.getTime() - new Date(last).getTime()) / 86400000;
    if (ageDays <= maxDays) add(label, 'ok', `Newest ${ageDays.toFixed(1)}d ago`);
    else add(label, 'warn', `Newest ${ageDays.toFixed(1)}d ago — ${workflow} may be stalled`);
  } catch (e) { add(label, 'warn', `Check failed: ${errStr(e)}`); }
}
await freshness('Last Check-In', '5a sync freshness', 'daily check-in sync', 2.5);
await freshness('Last Class Date', '5c class-sync freshness', 'daily class sync', 2.5);

// 6. n8n workflows active
let n8nReachable = true;
try {
  const body = await get(`${N8N_API}/workflows?limit=250`, { 'X-N8N-API-KEY': N8N_KEY, accept: 'application/json' });
  const wfs = (body && body.data) || [];
  const byId = {}; for (const w of wfs) byId[w.id] = w;
  const inactive = [], missing = [];
  for (const id of MAC_IDS) { const w = byId[id]; if (!w) missing.push(MAC_WORKFLOWS[id]); else if (!w.active) inactive.push(MAC_WORKFLOWS[id]); }
  if (!missing.length && !inactive.length) add('n8n workflows active', 'ok', `All ${MAC_IDS.length} MAC workflows active`);
  else {
    const parts = [];
    if (inactive.length) parts.push('INACTIVE: ' + inactive.join(', '));
    if (missing.length) parts.push('NOT FOUND: ' + missing.join(', '));
    add('n8n workflows active', 'fail', parts.join(' | '), true);
  }
} catch (e) { n8nReachable = false; add('n8n workflows active', 'fail', `n8n API unreachable: ${errStr(e)}`, true); }

// 7. n8n execution health (24h) per workflow — critical only if the MOST RECENT run errored
if (n8nReachable) {
  try {
    const since = now.getTime() - 24 * 60 * 60 * 1000;
    // These workflows have saveDataSuccessExecution=none (high poll volume) — only their
    // ERROR runs are persisted, so "latest saved run errored" is meaningless for them.
    // Judge them by error count in 24h instead (warn, never critical-by-latest).
    // WF_CHANGE_PINGS (Airtable change pings) saves every run until its ping count is checked,
    // then goes to none as well; judging it by error count is right either way.
    const ERRORS_ONLY_LOG = { 'WF_INBOX_API': true, 'WF_CHANGE_PINGS': true };
    const broken = [], recovered = [];
    for (const id of MAC_IDS) {
      let body;
      try { body = await get(`${N8N_API}/executions?workflowId=${id}&limit=20`, { 'X-N8N-API-KEY': N8N_KEY, accept: 'application/json' }); }
      catch (e2) { continue; }
      const exs = ((body && body.data) || []).filter(ex => { const t = ex.stoppedAt || ex.startedAt; return t && new Date(t).getTime() >= since; });
      if (!exs.length) continue;
      // The n8n API orders executions by ID (allocation order), NOT by time. A workflow
      // with parked Wait nodes (QR/v4 wait 24h+48h) finishes runs far out of ID order,
      // so exs[0] is frequently NOT the newest run. Sort by start time explicitly.
      exs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
      const latest = exs[0];
      const errCount = exs.filter(ex => ex.status === 'error').length;
      if (ERRORS_ONLY_LOG[id]) {
        if (errCount > 0) recovered.push(`${MAC_WORKFLOWS[id]} ${errCount}× (errors-only log)`);
      }
      else if (latest.status === 'error') broken.push(`${MAC_WORKFLOWS[id]} (latest run failed, ${errCount}×/24h)`);
      else if (errCount > 0) recovered.push(`${MAC_WORKFLOWS[id]} ${errCount}×`);
    }
    if (broken.length) add('n8n executions (24h)', 'fail', 'CURRENTLY FAILING: ' + broken.join(', '), true);
    else if (recovered.length) add('n8n executions (24h)', 'warn', 'Errored then recovered: ' + recovered.join(', '));
    else add('n8n executions (24h)', 'ok', 'No errored runs in last 24h');
  } catch (e) { add('n8n executions (24h)', 'warn', `Could not fetch executions: ${errStr(e)}`); }
}

// 8. Unsendable leads — contacts whose stored phone Meta will always reject.
// These people are in Airtable (and usually Virtuagym) but can never receive a
// WhatsApp; without this they are invisible until someone opens the record.
// Only recent ones are actionable, so old rows are reported separately.
try {
  const E164 = /^\+[1-9]\d{7,14}$/;
  let recs = [], offset = null, pages = 0;
  do {
    let qs = 'pageSize=100&fields%5B%5D=' + ['Name','Last Name','Phone','Status','Source','Email']
      .map(encodeURIComponent).join('&fields%5B%5D=');
    if (offset) qs += '&offset=' + encodeURIComponent(offset);
    const body = await get(`https://api.airtable.com/v0/${BASE}/${T_CONTACTS}?${qs}`, { Authorization: `Bearer ${AIRTABLE_PAT}` });
    recs = recs.concat((body && body.records) || []);
    offset = body && body.offset;
  } while (offset && ++pages < 25);

  const cutoff = now.getTime() - 14 * 86400000;
  const bad = recs.filter(r => {
    const p = ((r.fields || {}).Phone || '').trim();
    return p && !E164.test(p);
  });
  const recent = bad.filter(r => new Date(r.createdTime).getTime() >= cutoff);

  const fmt = r => `${(r.fields.Name || '') + ' ' + (r.fields['Last Name'] || '')}`.trim() + ` ("${r.fields.Phone}")`;
  if (!bad.length) add('Unsendable leads', 'ok', `All ${recs.length} contacts have a sendable phone`);
  else if (recent.length) add('Unsendable leads', 'warn',
    `${recent.length} new in 14d: ` + recent.map(fmt).join(', ') + ` · ${bad.length} total — follow up by e-mail`);
  else add('Unsendable leads', 'ok', `${bad.length} older unsendable rows, none new in 14d`);
} catch (e) { add('Unsendable leads', 'warn', `Check failed: ${errStr(e)}`); }

// ---- aggregate + compose ----
const fails = checks.filter(c => c.status === 'fail');
const warns = checks.filter(c => c.status === 'warn');
const urgent = fails.length > 0;

const stamp = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const dateLabel = now.toISOString().slice(0, 10);
const icon = s => s === 'ok' ? '✅' : (s === 'warn' ? '⚠️' : '❌');
const color = s => s === 'ok' ? '#16a34a' : (s === 'warn' ? '#d97706' : '#dc2626');

const rowsHtml = checks.map(c => `
  <tr>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:18px;text-align:center">${icon(c.status)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-weight:600">${c.name}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;color:${color(c.status)};font-size:13px">${c.detail || ''}</td>
  </tr>`).join('');

const overall = urgent ? '❌ ACTION NEEDED' : (warns.length ? '⚠️ OK — warnings present' : '✅ All systems healthy');
const headColor = urgent ? '#dc2626' : (warns.length ? '#d97706' : '#16a34a');

const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;max-width:680px;margin:0 auto;padding:24px">
<div style="border-bottom:3px solid ${headColor};padding-bottom:12px;margin-bottom:20px">
  <h1 style="margin:0;font-size:21px;color:${headColor}">MAC Health Check — ${overall}</h1>
  <div style="color:#666;font-size:13px;margin-top:4px">${stamp} · ${fails.length} failing · ${warns.length} warning(s) · ${checks.length} checks</div>
</div>
<table style="border-collapse:collapse;width:100%;margin-bottom:20px">${rowsHtml}</table>
<div style="color:#999;font-size:12px;margin-top:24px;padding-top:14px;border-top:1px solid #eee">
Daily automated health check · n8n · <a href="https://n8n.example.com" style="color:#999">open n8n</a>
</div></body></html>`;

const subject = urgent
  ? `❌ MAC Health Check — ${fails.length} FAILING (${dateLabel})`
  : (warns.length ? `⚠️ MAC Health Check — OK, ${warns.length} warning(s) (${dateLabel})`
                  : `✅ MAC Health Check — all healthy (${dateLabel})`);

const failList = fails.map(c => `<li style="margin-bottom:10px"><strong style="color:#dc2626">${c.name}</strong><br><span style="color:#555;font-size:13px">${c.detail || ''}</span></li>`).join('');
const urgentHtml = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#222;max-width:600px;margin:0 auto;padding:24px">
<div style="background:#dc2626;color:#fff;padding:14px 18px;border-radius:8px;margin-bottom:18px">
  <div style="font-size:20px;font-weight:700">🚨 MAC automation needs attention</div>
  <div style="font-size:13px;opacity:.9;margin-top:4px">${fails.length} check(s) failing · ${stamp}</div>
</div>
<ul style="padding-left:18px">${failList}</ul>
<p style="font-size:13px;color:#555">Open <a href="https://n8n.example.com">n8n</a> to investigate. The full daily report is sent separately.</p>
</body></html>`;
const urgentSubject = (`🚨 URGENT — MAC automation: ` + fails.map(c => c.name).join(', ')).slice(0, 180);

return [{ json: { subject, html, urgent, urgentSubject, urgentHtml, failCount: fails.length, warnCount: warns.length, checks } }];

