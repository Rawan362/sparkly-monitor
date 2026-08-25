# n8n Workflow Snapshots

This folder is a **version history backup** of the n8n workflows that power Sparkly AI's backend — it is not a live-editing pipeline.

## How this works

- Each `.json` file is a full snapshot of one n8n workflow (all nodes, code, settings).
- **Edits still happen directly in n8n's editor**, not here. This folder just gives us a record of what the workflow looked like at a point in time.
- After any manual edit in n8n (a bug fix, a new feature), pull a fresh snapshot and commit it here. Going forward, this gives:
  - A real diff between any two versions (exactly what changed, line by line)
  - A way to see the working version before a change, if something breaks
  - A record of *why* a change was made (via the commit message)

## Workflows tracked

| File | Workflow | What it does |
|---|---|---|
| `whatsapp-sales-closer.json` | whatsapp sales closer | The core customer-facing AI — receives WhatsApp messages, builds the sales prompt, calls Claude, sends replies |
| `sparkly-telegram-control-panel.json` | sparkly telegram control panel | The seller-side Telegram bot (being migrated to the web app) |
| `sparkly-followup-and-broadcast.json` | Sparkly Follow-up & Broadcast | Runs every 10 min — sends follow-up messages and scheduled broadcasts |
| `sparkly-auto-trigger-messages.json` | Sparkly Auto-Trigger Messages | Runs hourly — near-duplicate logic to Follow-up & Broadcast (flagged as a possible cleanup item) |
| `sparkly-daily-summary.json` | Sparkly Daily Summary | Sends each seller a daily performance summary |
| `system-error-notifier.json` | System Error Notifier | Checks for new system errors every few minutes and notifies the seller |
| `storage-guardian.json` | Storage Guardian | Deletes chat media older than 48 hours (WhatsApp-style storage cleanup) |
| `monitor-manual-send-handler.json` | Monitor Manual Send Handler | Handles manual "send message" actions triggered from the web app |

## Known issues already flagged (see project notes)
- 36 of 41 Supabase tables have Row Level Security disabled (parked, not yet fixed)
- Several live secrets (Meta token, Telegram bot token, Anthropic API key) are hardcoded in plaintext inside these workflows rather than stored as n8n credentials (parked, not yet fixed)
- `pause_all`/`resume_all` in the Telegram control panel writes to `bot_settings` without a `chat_id` filter — may affect all sellers, not just the one who triggered it (parked, not yet fixed)
- `Sparkly Follow-up & Broadcast` and `Sparkly Auto-Trigger Messages` appear to run near-identical code on different schedules — likely redundant, worth consolidating

## ⚠️ Secrets are redacted in these files
These workflows currently store live credentials (Meta token, Telegram bot token, Anthropic API key, Supabase anon key) as plaintext inside the JS code — see the "known issues" above. Before committing any snapshot, all four are replaced with placeholders like `[REDACTED_ANTHROPIC_KEY]`. **These files are not directly usable to restore a workflow as-is** — if you ever need to restore from a snapshot, copy the code back into n8n and re-paste the real values from n8n's existing credentials/config, not from this repo. This redaction step should happen for every future snapshot too, not just this first one.

## Snapshot taken
2026-08-25 — initial snapshot, right after tonight's fixes to global pause, VIP, referral, and win-back logic in `whatsapp-sales-closer.json`. All live secrets redacted before commit.
