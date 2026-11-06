// n8n Code node "Classify Trial Message" from the workflow "Automation 1+3 v4 — Class-Aware Trial Routing".
// Exported from production; secrets appear as ${NAME} placeholders and IDs are scrubbed.

// Parse Claude's classification response and merge with upstream data.
const items = $input.all();
const results = [];

for (const item of items) {
  let path = 'C';
  let className = '';
  try {
    const raw = item.json?.content?.[0]?.text || '';
    const cleaned = raw.replace(/```json\s*|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (['A', 'B', 'R', 'C'].includes(parsed.path)) {
      path = parsed.path;
    }
    if (typeof parsed.className === 'string') {
      className = parsed.className.trim();
    }
  } catch (err) {
    console.log('Classifier parse failed, defaulting to Path C:', err.message);
  }

  const upstream = $('Extract & Classify').first().json;
  const humanReason = (path === 'C' && /\b(and|en|und|,)\b/i.test(String(upstream.tryoutMessage || '')) && className === '')
    ? 'multi' : 'question';
  results.push({ json: { ...upstream, path, className, humanReason } });
}
return results;
