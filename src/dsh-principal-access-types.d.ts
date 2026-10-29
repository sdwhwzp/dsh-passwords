declare module '@deepseek-ai/dsh-principal-access' {
  export interface PrincipalAccessSubjects {
    readonly sessionIds?: readonly import('@deepseek-ai/dsh-session/types').SessionId[];
    readonly workspaceIds?: readonly import('@deepseek-ai/dsh-workspace').WorkspaceId[];
    readonly attachmentIds?: readonly import('@deepseek-ai/dsh-attachment').AttachmentId[];
  }

  export interface PrincipalAccessResult {
    readonly readableSessionIds: ReadonlySet<import('@deepseek-ai/dsh-session/types').SessionId>;
    readonly readableWorkspaceIds: ReadonlySet<import('@deepseek-ai/dsh-workspace').WorkspaceId>;
    readonly readableAttachmentIds?: ReadonlySet<import('@deepseek-ai/dsh-attachment').AttachmentId>;
  }

  export interface PrincipalAttachmentGrant {
    readonly sessionId: import('@deepseek-ai/dsh-session/types').SessionId;
    readonly attachmentIds: readonly import('@deepseek-ai/dsh-attachment').AttachmentId[];
  }
}
