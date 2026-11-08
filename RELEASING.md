# Releasing

`.github/workflows/publish.yml` runs on every push to `main`. If the version in
`package.json` is not on npm yet, it publishes it (trusted publishing, no token)
and creates the `v<version>` tag and GitHub release. Otherwise it does nothing.

Agents that install `friday-gmail-cli@latest` pick up a release within minutes,
so a release is never a side effect of merging a feature.

## Rules

- **Feature PRs never change the version.** The `check` workflow fails a PR
  whose `package.json` version differs from `main`'s. Merging a PR therefore
  never publishes anything.
- **A release is one commit on `main`** that bumps the version in
  `package.json` and `.claude-plugin/plugin.json` together (both workflows
  fail if they differ).
- Semver while on 0.x: new commands, flags or output fields are a minor bump;
  fixes that change no output are a patch. A renamed or removed output field
  or flag, or a change in how drafts are built that callers would notice, is a
  minor bump and gets called out in the release notes.
- The repo is public: no real names, addresses or mail content in commits, PR
  text or fixtures. Use `example.com`. The `check` workflow runs gitleaks over
  the whole history on every PR and push to `main` and fails on any finding;
  it cannot see PR descriptions or comments, so check those yourself.

## Steps

1. Merge the feature PRs (squash). Each merge to `main` runs `publish.yml`,
   which reports that the current version is already on npm.
2. On a branch from the new `main`, check that README and
   `skills/friday-gmail/SKILL.md` describe everything that landed, then run
   `node --check gmail.js` and `npm test` (offline: the tests run the real CLI
   against canned API responses; CI runs them on every PR and push to `main`).
3. Smoke test the merged code against a real mailbox. Reading and drafting
   only: never `archive`, `trash` or `label` while testing, and discard every
   test draft. Replace `<acct>` and `<msgId>`; pick a `<msgId>` with a Cc.

   ```sh
   node gmail.js --version
   node gmail.js search <acct> 'newer_than:7d' --max 5      # cc, reply_to on each line
   node gmail.js get <acct> <msgId>                          # cc, reply_to
   node gmail.js get <acct> <msgId> --html                   # plus html
   node gmail.js draft <acct> reply-no-cc.txt --reply <msgId>    # warns, not_included
   node gmail.js draft <acct> reply-with-cc.txt --reply <msgId>  # silent
   node gmail.js draft <acct> formatting.txt --sig sig.html      # open it in Gmail
   node gmail.js drafts <acct>
   node gmail.js draft-discard <acct> <draftId>                  # for every test draft
   ```

   `formatting.txt` should cover paragraphs, a numbered list with a wrapped
   item and a blank line between items, a bullet list with an indented
   continuation line, `**bold**` in a paragraph and in a list item, a lone
   `1. ...` line and a `- Name` sign-off.
4. Bump the version in `package.json` and `.claude-plugin/plugin.json`, commit
   (`release: <version>`) and push to `main`.
5. Watch the run and confirm the result:

   ```sh
   gh run watch "$(gh run list -w publish.yml -L 1 --json databaseId -q '.[0].databaseId')" --exit-status
   npm view friday-gmail-cli version
   gh release view "v<version>"
   ```

6. Update installed copies (`npm update -g friday-gmail-cli`, with `--prefix`
   if installed under one) on every machine that runs it, and check
   `friday-gmail --version`.

If a release turns out broken, fix forward with a patch release; do not
unpublish (agents may already have installed it).
