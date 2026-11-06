# Lessons from production

Each rule below came from a real incident in this system. They are the checklist I work from before changing anything that sends messages to people.

## Before any message reaches a person

1. **"Active member" doesn't mean "staying".** Every member-facing send checks do-not-contact, notice given, a contract end in the past and a contract start in the future. *Incident:* a member who had given notice was offered a 52-week plan four days before their contract ended. A back-check found five such sends.
2. **Ask the source of truth at send time.** Lead follow-ups ask Virtuagym live whether the person has already joined, and send nothing if the check fails. *Incident:* two people who had just signed up got trial follow-ups ("how was your trial?", a sign-up offer), because the CRM still listed them as leads.
3. **Morning syncs can't see this morning.** Inactivity nudges re-check today's activity live right before sending. *Incident:* a member got "everything okay?" thirty minutes into a class they had booked.
4. **Never send to a number known to be bad.** Flag it for the front desk instead. A permanent Meta error also aborted the rest of that run.
5. **Template parameters can't hold line breaks, tabs or long runs of spaces.** Collapse whitespace first, or Meta rejects the send.
6. **Join items back by phone or id, never by position.** *Incident:* after a filter dropped one person mid-list, nudges were credited to the wrong members.
7. **A fixed sequence step must not point at rotating content.** *Incident:* walk-in students got a €595 coaching pitch as their third message, because that step used the monthly-offer template.

## Agents and models

8. **A closed list fails silently and confidently.** *Incident:* Reformer Pilates was missing from the classifier's class list, so all ten Reformer requests were matched to the nearest class, and eight people were told their Pilates trial was reserved, implying a free trial of a paid module. Check the list against the live source.
9. **Replay real history before shipping a prompt change.** Old prompt against new on the same real messages, and read every answer that changed (75 messages, 24 changes for the Reformer fix).
10. **Test the hand-over path as hard as the happy path.** *Incident:* the "a person replies" path had never worked, so 14 of 19 people sent to a human got nothing.
11. **Never trust a model output to be complete.** *Incident:* a long answer hit `max_tokens`; the partial tool input held only the decision, read as confidence 0, and escalated with a blank reason. Truncation is now its own named error.
12. **An agent must not mute itself.** *Incident:* the assistant set a "needs human" flag on escalation, and the gate skipped flagged threads, so after one escalation it never replied again. Only a person claiming the thread stops it now.
13. **Silent hand-overs look like being ignored.** Answer the simple procedural questions (how to cancel) directly, and keep escalation for what really needs a person.

## Lead intake

14. **Never throw in an intake validator, and never end a branch before the lead reaches both systems.** Normalize, flag, continue. *Incident:* a walk-in typed a local-format number, the validator threw, and the lead was lost.
15. **Retries on every step whose failure loses a lead.** *Incident:* a 28-minute Airtable outage lost a walk-in lead and two customer messages; a duplicate check during an outage silently answers "not a duplicate".
16. **Strip invisible direction marks before normalizing phone numbers.** Numbers copied from a phone's contact card carry them, and JavaScript's `\s` doesn't match them.
17. **Never guess a country code.** An ambiguous number is flagged for the desk, because a guess can message a stranger.

## n8n

18. Code nodes use `this.helpers.httpRequest`; `fetch` and `URLSearchParams` don't exist in the sandbox, and a run stops at 300 seconds. A thrown HTTP error loses its body, so read responses with `returnFullResponse` and `ignoreHttpStatusErrors`.
19. `node --check` every Code node before deploying. A raw line break inside a string is a parse error that no try/catch can catch.
20. Deploy by REST `PUT`: back up first, read back byte-identical, connections unchanged, still active.
21. A parked Wait run resumes from a frozen copy of the workflow, so an edit never reaches someone mid-sequence. Change the template text instead.
22. The IF node's boolean "not equal" operator is `notEquals`; `notEqual` silently evaluates false. *Incident:* two weeks of follow-ups sent nothing while every run looked green.
23. Airtable leaves an unticked checkbox out of the API response: test `=== true` or `!== true`, never `=== false`.
24. After a run-once-for-all-items step, Airtable nodes can write to the wrong record, and a search node resolves its filter once for the whole batch. Write through a Code node with an explicit record id.
25. The executions API is ordered by id, not time. Sort by start time before calling a run "the latest".

## Virtuagym API

26. Check-in timestamps are milliseconds; invoice timestamps are seconds. `/events` needs an explicit time window, events and participants need `limit=500`, and paging uses the `sync_from` cursor (invoices are the exception and use `page`). The key allows 500 requests an hour, so fetch full lists and join in memory.
27. `PUT /member` inserts a new member; `PUT /member/{id}` updates one.

## Data and measurement

28. **A status flag is not a measurement.** Both the member system and the CRM said 19% of leads became members. Matching leads to members on e-mail and phone said 40%.
29. **Check for duplicate contact rows before changing a status.** Two rows for one person means two messages.
30. **Monitoring needs a second channel.** The health check, its alerts and the weekly report all used one e-mail credential; when it expired, everything went quiet for eight days.

## Testing

31. Test on your own number, use a temporary every-minute schedule for headless runs, and restore the exact previous state afterwards.
