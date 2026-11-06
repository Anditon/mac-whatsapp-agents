# Production Code nodes

Code exported from the live n8n workflows, one file per node. Each file starts with the node and workflow it came from.

- Secrets appear as `${NAME}` placeholders. The live nodes hold the real values.
- Account ids are replaced: `appXXXXXXXXXXXXXX`, `tblCONTACTS`, `<PHONE_NUMBER_ID>`, `<CLUB_ID>`, `WF_...` for n8n workflow ids.
- `$json`, `$input` and `$('Node name')` are n8n's way of reading the previous node's output. `this.helpers.httpRequest` is n8n's HTTP client; the sandbox has no `fetch`.

| Folder | Workflow | What the nodes do |
| --- | --- | --- |
| `whatsapp-assistant/` | Inbound WhatsApp webhook | `1-bot-gate-prep.js` checks whether the assistant may run and builds the Claude request; an HTTP Request node (2) sends it; `3-bot-decide-act.js` reads the forced tool call and drafts, sends or hands over |
| `whatsapp-webhook/` | Inbound WhatsApp webhook | Records Meta's delivery receipts per message, moving the status forward only |
| `trial-classifier/` | Website lead intake | The Claude Haiku request and the parser that turns its answer into path A, B, R or C |
| `lead-intake/` | Website and QR intake | Phone normalization and the live Virtuagym check before each follow-up |
| `inactivity-nudge/` | Inactive member nudge | Who is due a nudge, and the live activity re-check right before sending |
| `monitoring/` | Daily health check | API probes, workflow and execution health, and the e-mail report |
