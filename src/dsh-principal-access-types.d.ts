declare module '@deepseek-ai/dsh-principal-access' {
  export interface PrincipalAccessSubjects {
    readonly sessionIds?: readonly import('@deepseek-ai/dsh-session/types').SessionId[];
    readonly workspaceIds?: readonly import('@deepseek-ai/dsh-workspace').WorkspaceId[];
  }

  export interface PrincipalAccessResult {
    readonly readableSessionIds: ReadonlySet<import('@deepseek-ai/dsh-session/types').SessionId>;
    readonly readableWorkspaceIds: ReadonlySet<import('@deepseek-ai/dsh-workspace').WorkspaceId>;
  }
}
