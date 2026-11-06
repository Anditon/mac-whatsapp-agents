// run.js — runs the 33-case corpus through gate → Claude, prints each result,
// and tallies pass/fail against each case's expected decision.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node run.js
//   ANTHROPIC_API_KEY=sk-ant-... node run.js cancel-nl hours-en   # only these case ids
//   node run.js --gate-only                                       # no API calls; just test the gate
//
// Exit code is non-zero if any case fails — handy for a quick regression check.

const fs = require('fs');
const path = require('path');
const { shouldBotRun } = require('./gate');
const { callClaude } = require('./claude');
const cases = require('./cases');

const MODEL = 'claude-sonnet-4-6';
const GYM_PHONE = '+31639277868';

const faq = fs.readFileSync(path.join(__dirname, 'faq.md'), 'utf8');
const tone = fs.readFileSync(path.join(__dirname, 'tone.md'), 'utf8');

// ---- args ----
const args = process.argv.slice(2);
const gateOnly = args.includes('--gate-only');
const idFilter = args.filter((a) => !a.startsWith('--'));
const selected = idFilter.length ? cases.filter((c) => idFilter.includes(c.id)) : cases;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!gateOnly && !apiKey) {
  console.error('\n  ✖ ANTHROPIC_API_KEY is not set.');
  console.error('    Run:  ANTHROPIC_API_KEY=sk-ant-... node run.js');
  console.error('    Or test just the gate logic with no API:  node run.js --gate-only\n');
  process.exit(2);
}

// ---- tiny color helpers (no deps) ----
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function wrap(text, width, indent) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if ((line + word).length > width) {
        out.push(indent + line.trimEnd());
        line = '';
      }
      line += word + ' ';
    }
    out.push(indent + line.trimEnd());
  }
  return out.join('\n');
}

// Run one case: gate first, then (if it passes) Claude.
async function runCase(tc) {
  const gate = shouldBotRun({ ...tc, gymPhone: tc.gymPhone || GYM_PHONE });

  if (!gate.run) {
    return { actual: 'skip', gateReason: gate.reason, result: null };
  }
  if (gateOnly) {
    // Gate says run, but we're not calling the API.
    return { actual: 'run', gateReason: null, result: null };
  }

  const result = await callClaude({
    apiKey,
    faq,
    tone,
    contact: tc.contact,
    thread: tc.thread,
    inboundText: tc.inboundText,
    model: MODEL,
  });
  return { actual: result.decision, gateReason: null, result };
}

// Decide pass/fail for a case.
function judge(tc, outcome) {
  // In --gate-only mode, only 'skip' cases are objectively checkable; others we
  // just confirm the gate let them through ('run').
  if (gateOnly) {
    if (tc.expect === 'skip') return outcome.actual === 'skip';
    return outcome.actual === 'run'; // gate correctly let a real case proceed
  }
  // Full run: compare decision.
  if (tc.expect === 'skip') return outcome.actual === 'skip';
  const decisionOk = outcome.actual === tc.expect;
  // Language assertion only when expectLang is set and we got a reply.
  let langOk = true;
  if (tc.expectLang && outcome.result && outcome.result.decision === 'reply') {
    langOk = outcome.result.language === tc.expectLang;
  }
  return decisionOk && langOk;
}

(async () => {
  console.log('');
  console.log(C.bold('  MAC bot harness') + C.dim(`  ·  model ${MODEL}  ·  ${selected.length} cases${gateOnly ? '  ·  GATE-ONLY (no API)' : ''}`));
  console.log(C.dim('  ' + '─'.repeat(70)));

  let pass = 0;
  const fails = [];
  let cacheRead = 0;
  let cacheCreate = 0;
  let inputTok = 0;
  let outputTok = 0;

  for (const tc of selected) {
    let outcome;
    try {
      outcome = await runCase(tc);
    } catch (e) {
      outcome = { actual: 'ERROR', gateReason: e.message, result: null };
    }

    const ok = judge(tc, outcome);
    if (ok) pass++;
    else fails.push(tc.id);

    const mark = ok ? C.green('✔') : C.red('✘');
    const exp = C.dim(`expect=${tc.expect}${tc.expectLang ? '/' + tc.expectLang : ''}`);
    let got = outcome.actual;
    if (outcome.actual === 'skip') got = `skip(${outcome.gateReason})`;
    else if (outcome.result) got = `${outcome.result.decision}/${outcome.result.language} conf=${outcome.result.confidence.toFixed(2)}`;

    console.log(`  ${mark} ${C.bold(tc.id.padEnd(26))} ${exp}  ${C.dim('→')}  ${ok ? got : C.red(got)}`);
    console.log('    ' + C.dim(tc.note));
    console.log('    ' + C.cyan('“' + tc.inboundText.replace(/\n/g, ' ') + '”'));

    if (outcome.result) {
      const r = outcome.result;
      if (r.decision === 'reply' && r.reply) {
        console.log(wrap(r.reply, 68, '      '));
      }
      console.log('      ' + C.dim('reason: ' + r.reason));
      if (r._usage) {
        const u = r._usage;
        inputTok += u.input_tokens || 0;
        outputTok += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreate += u.cache_creation_input_tokens || 0;
      }
    }
    console.log('');
  }

  console.log(C.dim('  ' + '─'.repeat(70)));
  const tally = `${pass}/${selected.length} passed`;
  console.log('  ' + (pass === selected.length ? C.green(C.bold(tally)) : C.yellow(C.bold(tally))));
  if (fails.length) console.log('  ' + C.red('failed: ' + fails.join(', ')));

  if (!gateOnly && (inputTok || cacheRead)) {
    console.log(
      '  ' +
        C.dim(
          `tokens: in ${inputTok} · out ${outputTok} · cache-read ${cacheRead} · cache-write ${cacheCreate}`
        )
    );
    console.log('  ' + C.dim('(cache-read climbing across cases = prompt caching is working)'));
  }
  console.log('');

  process.exit(fails.length ? 1 : 0);
})();
