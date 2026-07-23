# friday-gmail-cli

**A zero-dependency Gmail CLI for AI agents that structurally cannot send email.**
It reads, labels, and drafts. A human clicks send.

Named after Friday, the AI assistant. Built as the Gmail hands of an autonomous
inbox-triage agent fleet, and useful anywhere you want an agent (or a script) to
work an inbox without ever being able to speak on your behalf.

## Why

Most Gmail integrations hand an agent the `gmail.send` scope and hope the prompt
holds. This tool inverts that: the safety property lives in the code and the OAuth
scope, not in instructions.

- **No send capability exists.** Not a flag, not a hidden command, not an API path.
  `draft` creates an unsent Gmail draft; nothing leaves your outbox until a human
  opens Gmail and clicks send.
- **Scope is `gmail.modify` only**, so it cannot permanently delete mail either.
  Trash is Gmail's trash, with its normal 30-day recovery.
- **Every action leaves an audit trail.** `archive` and `trash` tag messages under
  a configurable label prefix (`friday/archived`, `friday/trashed`), and `restore`
  undoes them in one command.

This makes it safe to give to an autonomous agent running on a schedule: the worst
it can do is mislabel something, and you can see and undo everything it did.

## Features

- Multiple Gmail accounts from one config file (the account argument is optional
  when you configure just one)
- Inbox listing and full Gmail query search, output as JSON lines built for agent
  and script consumption
- Full message fetch (headers, text body, attachment metadata) and attachment
  download
- Rich draft creation: reply threading into an existing conversation, HTML
  signatures, attachments, and multipart text + HTML bodies so paragraph breaks
  survive editing in HTML mail clients
- Non-ASCII-safe headers (RFC 2047 encoding for names and subjects)
- Deep links into Gmail web for every message, pinned to the right account
- PKCE OAuth flow you complete in any browser, on any device
- Single file, zero npm dependencies, Node 18+

## Install

```sh
npm install -g friday-gmail-cli
# or run without installing:
npx friday-gmail-cli accounts
```

Or just copy `gmail.js` into your project. It is one file with no dependencies;
vendoring is a supported lifestyle.

## Setup

### 1. Create a Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project
   and enable the **Gmail API**.
2. Configure the OAuth consent screen. For personal use, add yourself as a user.
   Note: while the app's publishing status is "Testing", Google expires refresh
   tokens after 7 days; set it to "In production" for long-lived tokens (the
   unverified-app warning during consent is fine for personal use).
3. Create an **OAuth client ID** of type **Web application** and add
   `http://127.0.0.1:8479` as an authorized redirect URI (match the
   `redirectPort` in your config).

### 2. Write a config file

Copy [`friday-gmail.example.json`](./friday-gmail.example.json) to
`~/.config/friday-gmail/config.json` (or `./friday-gmail.json`, or anywhere via
`--config <file>` / `$FRIDAY_GMAIL_CONFIG`):

```json
{
  "accounts": {
    "personal": { "email": "you@gmail.com", "tokenEnv": "GMAIL_REFRESH_TOKEN_PERSONAL" }
  },
  "labelPrefix": "friday",
  "stateDir": "~/.config/friday-gmail",
  "redirectPort": 8479
}
```

### 3. Provide secrets via environment variables

```sh
export GMAIL_OAUTH_CLIENT_ID="...apps.googleusercontent.com"
export GMAIL_OAUTH_CLIENT_SECRET="..."
```

Secrets never touch the config file or disk. Use your secret manager of choice
(Doppler, 1Password CLI, direnv) to inject them.

### 4. Authorize each account

```sh
friday-gmail auth-url personal
# open the printed URL, sign in, land on a dead http://127.0.0.1:8479/?code=... page
friday-gmail auth-exchange 'http://127.0.0.1:8479/?code=...'
# prints the refresh token and which mailbox it belongs to
export GMAIL_REFRESH_TOKEN_PERSONAL="1//..."
```

## Usage

The `[account]` argument is the account key from your config. Omit it if you
configured exactly one account.

```sh
friday-gmail accounts                      # list accounts and token status
friday-gmail count                         # inbox/thread/unread counts
friday-gmail inbox personal --max 20       # inbox as JSON lines
friday-gmail search personal 'from:amazon newer_than:7d'
friday-gmail get personal 18c2a4b7d3e5f601
friday-gmail attachment personal <msgId> <attachmentId> ./invoice.pdf

friday-gmail drafts personal               # list unsent drafts
friday-gmail draft-discard personal <draftId>   # delete an unsent draft

friday-gmail archive personal <msgId>...   # out of inbox, labeled friday/archived
friday-gmail trash personal <msgId>...     # to trash, labeled friday/trashed
friday-gmail restore personal <msgId>...   # undo either of the above
friday-gmail label personal "receipts/2026" <msgId>...
```

### Drafting

Write the email as a plain file: header lines, a blank line, then the body.
German header names (`An:`, `Betreff:`) work too.

```
To: alex@example.com
Subject: Re: invoice 2026-041

Hi Alex,

thanks for the reminder. Payment went out today.

Best,
Nick
```

```sh
friday-gmail draft personal reply.txt --reply 18c2a4b7d3e5f601 --sig sig.html invoice.pdf
```

- `--reply <msgId>` threads the draft into that message's conversation
  (correct `In-Reply-To`/`References` headers and Gmail thread id).
- `--sig <htmlFile>` appends an HTML signature.
- Remaining arguments are attachment paths.
- The draft lands unsent in your Drafts folder; the JSON output includes a link
  that opens it.

## Claude Code skill

This repo doubles as a Claude Code plugin that teaches Claude how to drive the
CLI correctly (draft file format, reply threading, triage etiquette, and the
no-send guarantee). Install it with:

```
/plugin marketplace add nickponomar/friday-gmail-cli
/plugin install friday-gmail@friday-gmail-cli
```

The skill itself is [`skills/friday-gmail/SKILL.md`](./skills/friday-gmail/SKILL.md);
you can also copy or symlink that directory into `~/.claude/skills/` directly.

## Using with AI agents

The JSON-lines output and the no-send guarantee make this a natural tool for
agent harnesses like Claude Code. A minimal loop:

```sh
# let the agent read and triage, and prepare replies for your review
friday-gmail inbox --max 30          # agent reads
friday-gmail archive <ids>           # agent tidies (reversible)
friday-gmail draft reply.txt --reply <id>   # agent proposes; you click send
```

Because the tool cannot send, you can run an agent on a schedule against your
real inbox without a human in the loop and review its work asynchronously:
drafts wait in Drafts, and every archive/trash carries an undoable label.

## Design notes

- **Two-step auth on purpose.** `auth-url` prints a URL you can open on any
  device; `auth-exchange` takes the pasted redirect. No local server is spun up,
  which makes authorizing from a headless machine trivial.
- **State on disk is minimal**: only the PKCE verifier between the two auth
  steps, in `stateDir`. Tokens stay in environment variables.
- **Errors are loud and final.** Any API failure prints the status and body and
  exits non-zero, which is what you want under an agent harness.

## License

[MIT](./LICENSE)
