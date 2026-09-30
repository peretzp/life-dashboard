# Practices

> Synced copy. The canonical file is `docs/PRACTICES.md` in `peretzp/memoryatlas`. Edit it there; a weekly tickler routine syncs this copy.

## Personal data

- **Nothing personal goes into git unless the repo exists to hold it.** That covers contact details, message text, health, money and location. Repos get mirrored (GitHub, NAS) and cloned onto new machines, so treat anything committed as widely copied.
- **Lookups print; they don't save.** Tools that read personal stores write to stdout or to the Obsidian vault. If output must sit inside a repo tree, it goes in a git-ignored folder (`data/private/`).
- **Public pages about real people** carry first names, town-level places and public links only: no phone numbers, emails, street addresses or children's names. People are connected through a direct intro email or group text instead, so each person can say yes.
- **Tests use synthetic stores**, never real exports. Build a small SQLite with the same schema, including one row of Cyrillic and one of emoji.

## Apple's local stores (Contacts, Messages, Voice Memos, Photos, Notes)

- **Read-only, always.** Never open Apple's files for writing, checkpoint or vacuum them, or take an exclusive write lock. Normal brief SQLite read locks are part of a consistent read; never claim that a live read has no locks.
- **Tools that change data go through Apple's own interfaces** (the Contacts framework, AppleScript, Shortcuts), never by editing the SQLite files. Export a backup first. Direct edits bypass iCloud sync and can corrupt the store on every device.
- **Small stores (a few MB) need a consistent snapshot.** Where access is authorized, use SQLite's online backup API with a read-only source connection and a separate temporary destination, or `sqlite3 -readonly` with `.backup` to a separate destination. Check successful completion and the destination's integrity before querying it. A successful integrity check alone does not prove an arbitrary file copy was consistent.
  - Do not copy a live database and its `-wal` in separate filesystem operations and call the result a snapshot: concurrent transactions or checkpoints can produce mismatched versions. Copying is safe only when the source is demonstrably quiescent for the whole copy and any required recovery files belong to that same state; do not stop Apple's services to force this.
  - If the consistent read/export is denied, report the access limitation and defer. Do not bypass it with raw file copies. Apple's supported export interfaces are another option where available and authorized.
  - Source: SQLite's [online backup documentation](https://sqlite.org/backup.html) and [backup corruption guidance](https://sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active).
- **Big stores (GBs, such as `chat.db` or `Photos.sqlite`) are opened in place with `mode=ro`,** for one short query, then closed. Copying gigabytes per lookup wastes disk and I/O.
- **Every query on a big store is bounded** by a date window and a LIMIT, goes through indexed join tables, and filters out non-content rows in SQL (for Messages: tapbacks and thread events). Never scan message text across a whole table.
- **Check the schema before selecting** (`PRAGMA table_info`). Apple adds and drops columns between macOS releases.
- **Full Disk Access is the usual blocker.** Report it with the exact fix (System Settings > Privacy & Security > Full Disk Access). Report "store not found" separately; a missing file isn't a permission problem.
- **One optional store failing doesn't discard results from another.** For example, if Messages can't be read, still show the Contacts cards and say why messages are missing.

## Local compute

- **Use the Mac's own hardware for heavy work** (mlx-whisper, Ollama) and keep models warm instead of reloading them per file.
- **Batch jobs are resumable and crash-safe.** They record progress per item, so a reboot or upgrade loses at most the item in flight.
- **Measure before tuning.** Record chunk sizes, durations and failure rates in the repo (see `CHUNK LAW` in memoryatlas's transcriber) so the next machine starts from evidence.

## Cloud and local agent sessions

- **Cloud sessions can't see the Mac.** They run in a container, with no access to Messages, Contacts, Photos, local files or the logged-in browser. Say so plainly rather than guessing around it.
- **Hand off through the repo.** Write the remaining step into `CLAUDE.md` under a dated "Open threads" heading, with the exact commands to run. A session on the Mac (the Claude desktop app, or `claude remote-control` in the repo folder) picks it up there.
- **Logged-in websites** (Facebook, LinkedIn, Instagram) are read from a session on the Mac through Claude in Chrome. Don't copy what you find about other people into committed files.
- **Each repo's `CLAUDE.md` is its memory**: where its data lives, its rules, how to run and test it, and its open threads. Keep it current when behavior changes.

## Changes and review

- **Before pushing:** run the repo's tests, then smoke-test any CLI against a fake `$HOME` with synthetic stores.
- **Automated review findings are bug reports.** Verify each one; if it's real, fix it with a regression test, reply on the thread naming the commit, and resolve it. If it's wrong, say why on the thread.
- **Prefer PRs to direct pushes on shared branches.** Drafts are fine; a person decides when to merge.
- **Separate what was verified from what was inferred.** Where a fact is unknown, show a visible placeholder ("elev. TBD", "retreat name unconfirmed") instead of a plausible guess.
