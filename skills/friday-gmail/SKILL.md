---
name: friday-gmail
description: Read, search, triage, and draft (never send) email in Gmail via the friday-gmail CLI. Use when asked to check mail, find a message or attachment, clean up an inbox, or prepare an email or reply draft in an account configured for friday-gmail.
---

# friday-gmail: Gmail from the command line, drafts only

`friday-gmail` (npm: `friday-gmail-cli`) is a zero-dependency Gmail CLI with a
hard safety property: it has NO send command. `draft` creates unsent Gmail
drafts; a human reviews and clicks send in Gmail. Never look for a send path,
never suggest adding one, and never present a created draft as "sent".

## Setup expectations

- The binary is `friday-gmail` (global install) or `npx friday-gmail-cli`.
- Config file (accounts, label prefix, state dir) resolves in this order:
  `--config <file>`, `$FRIDAY_GMAIL_CONFIG`, `./friday-gmail.json`,
  `~/.config/friday-gmail/config.json`. If a command fails with "no config
  found" or an unexpected account list, the wrong config was picked up; pass
  `--config` explicitly.
- Secrets come from env vars (`GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`,
  plus one refresh-token var per account). If they are missing, ask the user how
  they inject secrets (Doppler, direnv, 1Password CLI) rather than hunting for
  token files; tokens are never stored on disk.
- First-time auth is `auth-url` then `auth-exchange` (see the README); only walk
  the user through it if a token is genuinely missing.

## Commands

- `accounts` — account keys + token status. Run this first when unsure.
- `count` — inbox/thread/unread counts per account.
- `inbox [account] [--max N]` — JSON lines: id, threadId, from, subject, date,
  labels, snippet, deep link.
- `search [account] <gmail-query> [--max N]` — full Gmail query syntax
  (`from:x newer_than:7d has:attachment` etc.).
- `get [account] <msgId>` — full headers + text body + attachment metadata.
- `attachment [account] <msgId> <attachmentId> <outPath>` — download.
- `draft [account] <emailFile> [--sig <htmlFile>] [--reply <msgId>] [attach...]`
- `drafts [account] [--max N]` / `draft-discard [account] <draftId>` — list or
  delete UNSENT drafts.
- `archive` / `trash` / `restore` / `label` — triage verbs; archive and trash
  tag messages under the configured label prefix and `restore` undoes both.
- The `[account]` key is optional when the config defines exactly one account.

## Drafting correctly

1. The email file is: `To:` (+ optional `Cc:`) and `Subject:` header lines
   (German `An:`/`Kopie:`/`Betreff:` also accepted), one blank line, then a
   PLAIN TEXT body. The tool builds multipart text+HTML itself and converts
   newlines to `<br>`, so paragraph breaks survive HTML mail editors. Never put
   HTML in the body.
2. For a reply, ALWAYS pass `--reply <msgId>` (find the id via `search`/`inbox`).
   It sets the thread id and In-Reply-To/References headers so the draft lands
   inside the existing conversation; without it Gmail starts a new thread. Keep
   the `Re: <original subject>` subject and set `To:` yourself.
3. `--sig <htmlFile>` appends an HTML signature after the body.
4. Report back the draftId and the `#drafts` deep link from the JSON output, and
   state clearly that the draft is unsent and awaiting review. To remove a bad
   draft, use `draft-discard <draftId>`.

## Triage etiquette

- Reading is always safe. `archive`/`trash`/`label` modify the user's mailbox:
  do them when the user asked for triage, and summarize what was moved with
  message ids so any action can be undone with `restore <msgId...>`.
- Trash is Gmail's trash (recoverable ~30 days); the tool's `gmail.modify`
  scope cannot permanently delete anything.
