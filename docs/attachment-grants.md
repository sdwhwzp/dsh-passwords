# Account attachment grants

`2.7.8-dsh.20261029.4` implements the Host `recordAttachments` and
`readableAttachmentIds` contract. Deploy it with the matching core attachment
admission/read changes. SQLite and MySQL initialize an additive
`account_attachment_grants` table; no history or attachment objects are rewritten.

The key is the passwords account ID plus a digest of the **opaque attachment ID**.
The original ID is also compared exactly. IDs must be nonempty lossless UTF-8,
at most 4096 bytes; case, whitespace and Unicode are never normalized.
The table stores the receiving session, provenance and creation time. Deleting an
account removes its grants. Even administrators need their own attachment grant.
Two accounts can independently upload the same bytes and obtain the same content
ID without sharing any other grants.

Only trusted Host admission may call the provider, after validating bytes or a
receipt bound to the exact receiving session. The provider rechecks the current
identity, active account, session owner and permissions. It never creates or
adopts session ownership. Account, permission and ownership rows are locked for
the MySQL transaction; SQLite uses `BEGIN IMMEDIATE`. Every upload batch commits
together. Abort before commit rolls back; cancellation after commit can leave a
safe, idempotent grant without delivering the prompt.

The paired local-workspace `read` tool also checks an independent grant before
reading any Host attachment bytes, including same-store symlink aliases.

The global `llm/stream` guard checks all assembled image/file blocks, including
assistant/tool history and offloaded images, before model adapters read bytes
or the runtime projects files into paths. Identity comes only from the current
trusted `agent/pre-step` or `agent/request` hook, matched to the exact signal and
Session. Historical message principals never confer authority. Same-step
compaction and prepared calls use the same guard. Attachment calls with an
unbound or different auxiliary signal fail closed; text-only calls remain usable.
The guard does not grant historical objects. A continued conversation containing
ungranted legacy attachments can therefore be blocked before model dispatch,
even when its newest prompt contains text only. Release `.3` lacks this replay
boundary and must be superseded by `.4` and the corresponding corrected core cohort.

## Legacy backfill

Old attachments without grants remain denied. A fresh validated upload can
establish a grant. For offline recovery, an operator must review an independent,
trusted upload/ownership record and explicitly map:

```json
[
  {
    "source": "dsh-passwords",
    "accountId": "123",
    "sessionId": "exact-existing-owned-session",
    "attachmentId": "sha256:<64 lowercase hexadecimal characters>",
    "objectPath": "file-objects/<first two digest characters>/<64-character digest>",
    "provenance": {
      "kind": "operator-reviewed-upload",
      "reference": "trusted-upload-ledger:reviewed-record-id"
    }
  }
]
```

Do not generate this mapping from user-controlled messages, imported history,
filenames or attachment references. Object presence and matching bytes prove
integrity, **not account ownership**. The operator attestation is the ownership
evidence. Unknown or ambiguous ownership must stay ungranted.

This migration supports the core local store's `sha256:` IDs only. The live
provider supports opaque IDs. `objectPath` must name a canonical `file-objects`
or `objects` entry relative to the explicitly supplied `attachments/v1` root.
The tool rejects symlinks, non-files, integrity mismatch, missing accounts,
inactive accounts and non-owned sessions. The mapping must be operator-owned
and not group/world writable. Keep the reviewed mapping with the backup record;
do not include credentials in provenance.

Run from the installed passwords package, with its existing protected environment
file (the same SQLite or MySQL credentials and encryption key as the service):

```sh
DSH_PASSWORDS_ENV_FILE=/absolute/protected.env \
  node scripts/backfill-attachment-grants.mjs \
  /absolute/reviewed.json /absolute/attachments/v1

DSH_PASSWORDS_ENV_FILE=/absolute/protected.env \
  node scripts/backfill-attachment-grants.mjs \
  /absolute/reviewed.json /absolute/attachments/v1 --apply
```

The default is a dry run: schema initialization can create the additive table,
but no grants persist. All entries are preflighted before application. Apply
then rechecks and commits each mapping separately; interruption or concurrent
revocation may leave a prefix applied. Retrying is idempotent. No online endpoint
exposes this tool and it never scans history.

Take a consistent database backup before activation/backfill and retain the old
immutable packages. Rollback is coordinated with the core package cohort; use
the corresponding backup for the desired grant state. The additive table can
remain during rollback. This package does not change runtime secrets or keys.

## Local validation

Build first, then run against a disposable local MySQL instance on an explicit
test port (loopback root with no password; the test creates and drops only a
random `dshpw_attachment_test_*` database):

```sh
npm run build
DSH_TEST_MYSQL_PORT=13376 node --import tsx --test --test-isolation=none \
  test/attachment-grants.test.ts test/principal-access.test.ts \
  test/host-attachment-read.test.ts
```

`--test-isolation=none` avoids this Node distribution's child-test process
injecting process-only flags into the existing MySQL worker's `execArgv`.
Without the explicit test port, SQLite runs and MySQL is visibly skipped.
