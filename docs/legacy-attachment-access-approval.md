# Approving access to legacy attachments

This offline operation creates **new account-level permission** for explicitly
reviewed legacy objects. It does not establish who originally uploaded them.
History references may identify review candidates, but do not authorize access.
The person approving the document must have authority to disclose every listed
object to its listed account, including any cross-account reference conflicts.

The runtime provider, startup path and replay guard do not scan history or
recognize a legacy compatibility environment variable. Unlisted objects and
unapproved accounts continue to be denied. Administrators require explicit
entries too. There is no startup or per-request fallback.

## Approval document

Prepare a frozen review inventory, record its SHA256, and review the exact
account/object pairs. Then prepare an approval document containing only accepted
pairs:

```json
{
  "schema": "dsh-passwords/legacy-attachment-access@1",
  "scope": "account",
  "approvedBy": "operator identity recorded by the approval process",
  "approvedAt": "2026-10-29T12:00:00.000Z",
  "inventorySha256": "<64 lowercase hexadecimal characters>",
  "entries": [
    {
      "source": "dsh-passwords",
      "accountId": "123",
      "username": "reviewed-current-account-name",
      "role": "user",
      "sessionId": "exact-existing-owned-session",
      "attachmentId": "sha256:<64 lowercase hexadecimal characters>",
      "objectPath": "objects/<first two digest characters>/<64-character digest>"
    }
  ]
}
```

`file-objects/` is also accepted for canonical file objects. File aliases,
arbitrary paths, symbolic links and noncanonical IDs are rejected. Each
account/object pair appears exactly once. `username` and `role` must still match
the reviewed account.

The session must already belong to that account and pass current database
account/session policy checks. It is a review context, **not the read scope**:
the existing attachment table grants the account access to that object across
its other authorized uses. This tool does not claim or adopt sessions and does
not independently recreate the Host's workspace-header authorization.
If the intended approval is limited to one session, do not use this operation.

The `approvedBy` field is an audit declaration, not a digital signature.
Protect the document as an operator-owned file, not group/world writable.
Keep the approval record and frozen inventory outside tenant-writable directories.
Human approval must name the SHA256 of the final approval document's exact bytes.
Computing that hash is not itself approval. Inventory hashes are retained as
review context, not treated as automatic ownership evidence.

## Dry run and application

Build the package first. Use the installed package's protected environment file
and the explicit canonical `attachments/v1` root:

```sh
DSH_PASSWORDS_ENV_FILE=/absolute/protected.env \
  node scripts/approve-legacy-attachment-access.mjs \
  /absolute/approved.json /absolute/attachments/v1
```

The result prints the approval document SHA256 and validated entry count, without
object contents or database credentials. Dry run does not persist grants;
database initialization can create the additive schema.

Only after human approval of that exact digest, apply it:

```sh
DSH_PASSWORDS_ENV_FILE=/absolute/protected.env \
  node scripts/approve-legacy-attachment-access.mjs \
  /absolute/approved.json /absolute/attachments/v1 \
  --apply --approved-sha256 <human-approved-sha256>
```

Application refuses a missing or mismatched approved hash. It reads the document
through one file descriptor and hashes/parses the same byte snapshot. Every
canonical object is hashed and every identity/owner is preflighted before grant
writes. Run against a consistent offline snapshot with tenant writes stopped;
this is not a concurrent filesystem migration service.

Each entry then rechecks identity, permissions and session ownership within the
existing database transaction. SQLite and MySQL use the same checks.
Provenance is `operator-approved-legacy-access:<approval-document-sha256>`.
Existing grants retain their original provenance; retrying is idempotent.
`applied` counts processed approved entries, including ones already granted,
and is not a count of newly inserted rows.

A concurrent revocation or failure can leave a committed prefix. Retain a
consistent database backup and the pre-application grant state; partial failure
does not authorize continuing with a changed document. Rollback must preserve
unrelated preexisting/new-upload grants. Revoking access cannot retract bytes
already downloaded or sent to a model.

## Focused validation

```sh
npm run build
DSH_TEST_MYSQL_PORT=<isolated-loopback-test-port> \
  node --import tsx --test --test-isolation=none \
  test/legacy-attachment-access.test.ts \
  test/attachment-grants.test.ts \
  test/attachment-replay-guard.test.ts
```

The MySQL tests create and drop a randomly named disposable database on loopback.
Without the explicit test port, MySQL coverage is reported as skipped.
