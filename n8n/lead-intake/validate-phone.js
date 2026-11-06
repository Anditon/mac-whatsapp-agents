// n8n Code node "Validate Phone" from the workflow "Automation 1+3 v4 — Class-Aware Trial Routing".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

const items = $input.all();
const results = [];
for (const item of items) {
  let raw = item.json.phone || '';
  // Drop the "(0)" trunk-zero notation FIRST: the plain separator strip below keeps that
  // 0 and produces an undialable +3106... number (2 such rows exist in Contacts).
  // Strip INVISIBLE bidi/zero-width marks first: phones wrap a copied number in
  // U+202A...U+202C, which JS \s does NOT match, leaving a number that looks valid to a
  // human but fails every downstream check and can never be messaged (2026-09-13).
  raw = String(raw).replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').trim();
  let cleaned = raw.replace(/\(0\)/g, '').replace(/[\s\-\(\)\.]/g, '');
  let formatted = ''; let valid = false;
  if (!cleaned) { formatted = ''; valid = false; }
  else if (cleaned.startsWith('+')) { formatted = cleaned; }
  else if (cleaned.startsWith('00')) { formatted = '+' + cleaned.substring(2); }
  else if (cleaned.startsWith('0')) { const w = cleaned.substring(1); if (/^0(15|16|17)\d/.test(cleaned)) { formatted = '+49' + w; } else { formatted = '+31' + w; } }
  else { formatted = '+31' + cleaned; }
  // Repair a trunk zero that survived after an explicit country code ("+31 0 6...").
  // A national number never starts with 0 in E.164, so this is always a typo.
  const trunk = formatted.match(/^\+(31|32|49|41|44|43|33|352)0(\d+)$/);
  if (trunk) formatted = '+' + trunk[1] + trunk[2];
  const digits = formatted.replace(/\D/g, '');
  valid = digits.length >= 10 && digits.length <= 15 && /^\+[1-9]/.test(formatted);
  results.push({ json: { ...item.json, phoneFormatted: formatted, phoneValid: valid, phoneOriginal: raw }});
}
return results;

