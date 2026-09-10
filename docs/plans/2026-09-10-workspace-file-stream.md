# Workspace file subscriptions for restricted accounts

Status: implemented in dsh-passwords 2.6.30.

The Harness sidebar subscribes to `workspaceFiles/changes` when it opens a file resource. The restricted-account Remote mux must admit that endpoint so file previews can share a physical connection with session history. Cancelling a file subscription retires only that logical stream; late items are discarded until its terminal frame.

The Host resolves the wire argument `workspaceFileScopeId` from a Session header. That resolver does not authorize the account. The gateway therefore accepts exactly one nonempty Session id in `payload.args.workspaceFileScopeId` and verifies its recorded owner, allowed workspace path, and disabled status before forwarding the open frame. It rechecks permissions before each change item. The existing account-connection registry also revokes connections on permission and credential changes.

A gateway integration case opens history and file subscriptions together, receives a file-ready item, cancels files, and verifies history still arrives. Removing the new endpoint from the allowlist reproduces the failure. Rejection cases cover foreign, unknown, disabled, missing, and forged scopes, and permission revocation prevents an already-open stream from delivering another item.

The model catalog policy is independent of file subscriptions and is unchanged by this fix.
