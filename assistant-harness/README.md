# Assistant harness

A local rig for tuning the WhatsApp assistant's prompt and gate before anything reaches production. It feeds test messages through the same gate, prompt and forced-tool Claude call the live n8n nodes use, and prints what the assistant would draft or escalate. It never touches the live system.

Node 18 or newer, no `npm install`.

```bash
node run.js --gate-only                          # gate logic only, no API key needed
ANTHROPIC_API_KEY=sk-ant-... node run.js         # all 33 cases against the real model
ANTHROPIC_API_KEY=sk-ant-... node run.js cancel-nl hours-en   # selected cases
ANTHROPIC_API_KEY=sk-ant-... node chat.js --nl --member       # interactive chat
```

`run.js` exits non-zero when any case fails, so it works as a regression check.

## Files

| File | What it is | Who edits it |
| --- | --- | --- |
| `faq.md` | The gym's facts: hours, prices, classes, offers. The only facts the assistant may use. | Staff (in production, from the inbox) |
| `tone.md` | How the assistant writes. | Staff |
| `prompt.js` | Fixed machinery: identity, the golden rule, seven escalation rules, language rule, the `emit_reply` tool. | Locked |
| `gate.js` | `shouldBotRun()`: the checks that run before any API call. | Locked |
| `claude.js` | The Messages API call. Any error or a truncated response becomes an escalation. | Locked |
| `cases.js` | 33 cases: 20 should reply, 10 should escalate, 3 the gate should stop. | Add real messages over time |
| `run.js`, `chat.js` | The eval runner and the terminal chat. | |
| `mine-staff-answers.js` | Pulls real front-desk answers out of the conversation store so missing or wrong FAQ facts can be found. Read-only. | |

## What gets scored

- **Decisions are objective.** Every escalate case must escalate and every gate case must be stopped. That is the regression signal.
- **Wording is a human call.** Does it sound like the gym, in the right language, short and warm? Read the drafts.

## Grounding the FAQ in real answers

`mine-staff-answers.js` pairs each staff reply with the customer question it answered. The first run found six facts the FAQ had missing or wrong; the main one was that the trial costs €14.50 (taken off the first invoice if you join that day), where the FAQ had said it was free. The output contains real customer messages, so it stays on the machine that ran it and is deleted after use.

## Known gaps

- The FAQ's pausing section says the no-pause policy "can be stated plainly", while prompt rule 3 and the FAQ's own hand-over list escalate every freeze or pause request. The eval follows the rule (`freeze-en` expects an escalation); the FAQ line should be brought in line.
- Wording isn't scored automatically. The next step is an LLM judge with a short rubric, checked against human ratings before it is trusted.
- The live gate also reads the conversation's timing fields (rate cap) and the settings row, which the harness stubs.
