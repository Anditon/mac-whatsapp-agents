// chat.js — interactive conversation with the bot, in your terminal.
//
// Have a real back-and-forth: type a message, see what the bot would draft (or
// that it escalated to a human). The conversation thread is kept in memory and
// fed back each turn, so multi-turn behaviour (context, language switching, loop
// guard) works exactly like production. Same gate → Claude path as run.js.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node chat.js
//   ANTHROPIC_API_KEY=sk-ant-... node chat.js --nl --member --name=Anton
//
// Flags (all optional — they set the simulated contact):
//   --name=X     customer first name (default: Anton)
//   --nl|--en    language preference (default: EN)
//   --member     CRM status = Active Member (default: Lead)
//   --status=X   any CRM status string
//
// Commands inside the chat:
//   /reset   start a fresh conversation (clears the thread)
//   /thread  print the raw thread as the bot sees it
//   /quit    exit (or Ctrl-C)

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { shouldBotRun } = require('./gate');
const { callClaude } = require('./claude');

const MODEL = 'claude-sonnet-4-6';
const GYM_PHONE = '+31639277868';

const faq = fs.readFileSync(path.join(__dirname, 'faq.md'), 'utf8');
const tone = fs.readFileSync(path.join(__dirname, 'tone.md'), 'utf8');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('\n  ✖ ANTHROPIC_API_KEY is not set.\n    Run:  ANTHROPIC_API_KEY=sk-ant-... node chat.js\n');
  process.exit(2);
}

// --- parse flags into a simulated contact ---
const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes('--' + name);
}
function val(name, def) {
  const a = argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.split('=').slice(1).join('=') : def;
}
const contact = {
  firstName: val('name', 'Anton'),
  language: flag('nl') ? 'NL' : 'EN',
  status: val('status', flag('member') ? 'Active Member' : 'Lead'),
  membership: flag('member') ? 'mac GYM 52wk' : undefined,
};

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  pink: (s) => `\x1b[95m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// the live conversation thread, in the {from:'them'|'me', text} shape the bot uses
let thread = [];

function printBanner() {
  console.log('');
  console.log(C.bold('  💬 MAC bot — interactive chat') + C.dim(`  ·  ${MODEL}`));
  console.log(
    C.dim(
      `  you are: ${contact.firstName} · ${contact.language} · ${contact.status}` +
        `${contact.membership ? ' · ' + contact.membership : ''}`
    )
  );
  console.log(C.dim('  type a message and press enter. commands: /reset /thread /quit'));
  console.log(C.dim('  ' + '─'.repeat(64)));
}

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

async function handleTurn(text) {
  // gate first (same as production)
  const gate = shouldBotRun({
    inboundText: text,
    messageType: 'text',
    fromPhone: '+0000000000',
    gymPhone: GYM_PHONE,
    contact,
    thread,
  });

  // record the customer's message in the thread regardless
  thread.push({ from: 'them', text });

  if (!gate.run) {
    console.log('  ' + C.yellow(`⏭  gate skipped: ${gate.reason}`) + C.dim('  (bot stays silent — a human would handle this)'));
    console.log('');
    return;
  }

  process.stdout.write(C.dim('  …thinking\r'));
  const r = await callClaude({ apiKey, faq, tone, contact, thread, inboundText: text, model: MODEL });
  process.stdout.write('                \r');

  if (r.decision === 'escalate') {
    console.log('  ' + C.red('🚩 ESCALATE → human') + C.dim(`  (conf ${r.confidence.toFixed(2)})`));
    console.log('  ' + C.dim('reason: ' + r.reason));
    // production leaves the conversation Open/Needs-Human and does NOT send.
  } else {
    console.log('  ' + C.pink('🤖 bot') + C.dim(`  ·  ${r.language}  ·  conf ${r.confidence.toFixed(2)}`));
    console.log(C.pink(wrap(r.reply, 60, '    ')));
    console.log('  ' + C.dim('reason: ' + r.reason));
    // mirror production: the bot's reply becomes an assistant turn in the thread
    thread.push({ from: 'bot', text: r.reply });
  }
  console.log('');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.cyan('  you ▸ ') });

printBanner();
rl.prompt();

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }
  if (text === '/quit' || text === '/exit') {
    rl.close();
    return;
  }
  if (text === '/reset') {
    thread = [];
    console.log('  ' + C.dim('— conversation reset —'));
    console.log('');
    rl.prompt();
    return;
  }
  if (text === '/thread') {
    console.log('  ' + C.dim(JSON.stringify(thread, null, 2).split('\n').join('\n  ')));
    console.log('');
    rl.prompt();
    return;
  }

  rl.pause();
  try {
    await handleTurn(text);
  } catch (e) {
    console.log('  ' + C.red('error: ' + e.message));
    console.log('');
  }
  rl.resume();
  rl.prompt();
});

rl.on('close', () => {
  console.log('');
  console.log(C.dim('  bye 👋'));
  process.exit(0);
});
