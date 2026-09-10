/** Shared account and settings controls, using the host theme tokens. */
export const CARD_CSS = `
.dshpw-card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s;font-size:13px;line-height:1.5;overflow:hidden}
.dshpw-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshpw-body{display:flex;flex-direction:column;gap:0;padding:4px 16px 16px}
.dshpw-section{display:flex;flex-direction:column;gap:10px;padding:16px 0;border-top:1px solid var(--dsw-alias-border-l2)}
.dshpw-section:first-child{border-top:0}
.dshpw-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:22px}
.dshpw-label{display:block;font-size:12px;font-weight:650;letter-spacing:.01em;color:var(--dsw-alias-label-secondary)}
.dshpw-action-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dshpw-action-copy{flex:1;min-width:180px}
.dshpw-form-actions{justify-content:flex-end}
.dshpw-preference{padding-top:12px}
.dshpw-switch{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:border-color .15s,background .15s}
.dshpw-switch:hover{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-1)}
.dshpw-switch-copy{display:flex;flex-direction:column;gap:2px;min-width:0;color:var(--dsw-alias-label-primary)}
.dshpw-switch-copy strong{font-size:13px;font-weight:600;line-height:1.35}
.dshpw-switch-copy small{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.dshpw-switch-control{position:relative;display:inline-flex;flex:0 0 auto;width:42px;height:24px}
.dshpw-switch-control input{position:absolute;width:1px;height:1px;opacity:0}
.dshpw-switch-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-label-dimmed);transition:background .18s,box-shadow .18s}
.dshpw-switch-thumb{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-3);box-shadow:0 1px 3px #0004;transition:transform .18s}
.dshpw-switch-control input:checked + .dshpw-switch-track{background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)}
.dshpw-switch-control input:checked + .dshpw-switch-track .dshpw-switch-thumb{transform:translateX(18px)}
.dshpw-switch-control input:focus-visible + .dshpw-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.dshpw-input{width:100%;box-sizing:border-box;min-width:0;min-height:34px;padding:7px 10px;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;transition:border-color .15s,box-shadow .15s}
.dshpw-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.dshpw-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshpw-btn{appearance:none;border:0;border-radius:8px;padding:7px 14px;font-size:13px;line-height:1.35;font-weight:600;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff);cursor:pointer;white-space:nowrap;transition:filter .15s,transform .08s}
.dshpw-btn:active:not(:disabled){transform:translateY(1px)}
.dshpw-btn:hover:not(:disabled){filter:brightness(1.1)}
.dshpw-btn:disabled{opacity:.4;cursor:default}
.dshpw-btn.danger{background:none;border:1px solid var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshpw-btn.danger:hover:not(:disabled){filter:none;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent)}
.dshpw-btn.ghost{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dshpw-btn.ghost:hover:not(:disabled){filter:none;border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}
.dshpw-btn.sm{padding:5px 10px;font-size:12px}
.dshpw-general-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshpw-general-row-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;padding-right:48px}
.dshpw-general-row-title{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.dshpw-general-row-desc{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshpw-general-logout{display:inline-flex;align-items:center;height:36px;padding:0 14px;border:1px solid var(--dsw-alias-state-error-primary,#ef4444);border-radius:18px;background:transparent;color:var(--dsw-alias-state-error-primary,#ef4444);font:inherit;font-size:14px;line-height:22px;cursor:pointer;white-space:nowrap}
.dshpw-general-logout:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent)}
/* ── 用户管理：身份头、提示条、表单字段、账号列表、权限卡片 ── */
.dshpw-identity{display:flex;align-items:center;gap:12px;padding:14px 0 16px}
.dshpw-avatar{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:var(--dsw-alias-brand-primary);font-size:16px;font-weight:700;line-height:1;text-transform:uppercase}
.dshpw-avatar.sm{width:28px;height:28px;font-size:12px}
.dshpw-identity-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshpw-identity-cap{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.dshpw-identity-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:15px;font-weight:650;line-height:1.25;color:var(--dsw-alias-label-primary);word-break:break-all}
.dshpw-identity>.dshpw-chip{margin-left:auto}
.dshpw-banner{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border:1px solid;border-radius:10px;font-size:12px;line-height:1.5;word-break:break-word}
.dshpw-banner.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 9%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshpw-banner.ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 9%,transparent);color:var(--dsw-alias-state-success-primary,#22c55e)}
.dshpw-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.dshpw-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dshpw-field.wide{grid-column:1/-1}
.dshpw-field-label{font-size:12px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.dshpw-field-hint{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.dshpw-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshpw-chip.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f7ad31) 55%,transparent);color:var(--dsw-alias-state-warn-primary,#f7ad31)}
.dshpw-chip.danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 55%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshpw-users{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshpw-user{display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dshpw-user:first-child{border-top:0}
.dshpw-user-copy{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.dshpw-user-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary);word-break:break-all}
.dshpw-user-meta{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.dshpw-empty{padding:14px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshpw-subpanel{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.dshpw-subpanel-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dshpw-perm{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshpw-perm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:13px;color:var(--dsw-alias-label-primary)}
.dshpw-perm-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.dshpw-perm-body{display:flex;flex-direction:column;gap:14px;padding:12px}
.dshpw-perm-group{display:flex;flex-direction:column;gap:8px}
.dshpw-perm-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dshpw-budget{display:flex;flex-direction:column;gap:5px}
.dshpw-budget-bar{position:relative;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}
.dshpw-budget-bar>span{position:absolute;top:0;bottom:0;left:0;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,transparent);transition:width .2s}
.dshpw-budget-bar.warn>span{background:var(--dsw-alias-state-warn-primary,#f7ad31)}
.dshpw-budget-bar.over>span{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dshpw-checks{display:flex;gap:8px;flex-wrap:wrap}
.dshpw-fold{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}
.dshpw-fold-summary{display:flex;align-items:center;gap:10px;min-height:38px;padding:8px 12px;border-radius:9px;list-style:none;cursor:pointer}
.dshpw-fold-summary::-webkit-details-marker{display:none}
.dshpw-fold-summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshpw-fold-summary>.dshpw-hint{margin-left:auto;text-align:right}
.dshpw-fold-summary::after{content:"";flex:none;width:6px;height:6px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg);transition:transform .18s}
.dshpw-fold[open]>.dshpw-fold-summary::after{transform:rotate(225deg)}
.dshpw-fold-body{padding:0 12px 12px}
.dshpw-workspaces{display:flex;flex-direction:column;gap:8px}
.dshpw-workspace{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.dshpw-workspace-switch{border:0;border-radius:0;background:transparent}
.dshpw-workspace-switch:hover{background:var(--dsw-alias-bg-layer-1)}
.dshpw-session-list{display:flex;flex-direction:column;gap:6px;padding:8px 12px 10px 18px;border-top:1px solid var(--dsw-alias-border-l2)}
.dshpw-session-check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;min-height:26px}
.dshpw-session-check input{accent-color:var(--dsw-alias-brand-primary);flex:0 0 auto}
.dshpw-session-check span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpw-check{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-3);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.dshpw-check:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshpw-check:has(input:checked){border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary)}
.dshpw-check.danger:has(input:checked){border-color:var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}
.dshpw-check input{accent-color:var(--dsw-alias-brand-primary)}
/* 下拉框自身带 dshpw-input class：用 select.dshpw-input（旧 .dshpw-input select 永远不命中，是死选择器） */
select.dshpw-input{height:auto;min-height:36px}
.dshpw-badge{font-size:11px;line-height:1.6;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);white-space:nowrap}
.dshpw-badge.admin{border-color:var(--dsw-alias-state-warn-primary,#f7ad31);color:var(--dsw-alias-state-warn-primary,#f7ad31)}
.dshpw-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px}
.dshpw-ok{color:var(--dsw-alias-state-success-primary,#22c55e);font-size:12px}
.dshpw-warn{color:var(--dsw-alias-state-warn-primary,#f7ad31);font-size:12px}
.dshpw-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dshpw-local-download{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshpw-download-btn{display:inline-flex;align-items:center;text-decoration:none}
.dshpw-local-workspace{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshpw-managed-files-path{max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshpw-managed-files-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshpw-managed-files-form{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshpw-managed-files-form>.dshpw-input{flex:1;min-width:180px;width:auto}
.dshpw-managed-files-form>.dshpw-managed-files-git-folder{flex:0 1 220px;min-width:140px}
.dshpw-managed-files-git{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dshpw-managed-files-git-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshpw-managed-files-git-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.dshpw-managed-files-clipboard{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;border:1px dashed var(--dsw-alias-brand-primary);border-radius:10px}
.dshpw-managed-files-output{max-height:220px;margin:0;padding:10px 12px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.dshpw-managed-files-upload{display:inline-flex;align-items:center}
.dshpw-managed-files-upload.disabled{pointer-events:none;opacity:.4}
.dshpw-managed-files-upload input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.dshpw-managed-files-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.dshpw-managed-files-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:10px;min-height:40px;padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l2)}
.dshpw-managed-files-row:first-child{border-top:0}
.dshpw-managed-files-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
button.dshpw-managed-files-name{appearance:none;padding:4px;border:0;background:transparent;cursor:pointer}
button.dshpw-managed-files-name:hover{color:var(--dsw-alias-brand-primary)}
.dshpw-managed-files-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.dshpw-sidebar-workspace-action{appearance:none;display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 10px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.dshpw-sidebar-workspace-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshpw-sidebar-workspace-action>svg{flex:none}
.dshpw-sidebar-workspace-action>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpw-sidebar-workspace-action.compact{justify-content:center;width:36px;padding:0;border-radius:10px}
.dshpw-managed-files-dialog{width:min(900px,calc(100vw - 32px));max-width:900px;max-height:calc(100vh - 32px)}
.dshpw-managed-files-dialog-content{max-height:calc(100vh - 64px);overflow:auto}
.dshpw-local-launcher{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:1.45}
.dshpw-local-launcher-seat{position:relative;display:inline-flex;min-width:0}
.dshpw-local-launcher-trigger{display:inline-flex;align-items:center;gap:4px;min-height:28px;max-width:240px;padding:0 8px;border:0;border-radius:16px;list-style:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;white-space:nowrap}
.dshpw-local-launcher-trigger::-webkit-details-marker{display:none}
.dshpw-local-launcher-trigger>svg{flex:none}
.dshpw-local-launcher-trigger>span{overflow:hidden;text-overflow:ellipsis}
.dshpw-local-launcher-trigger:hover,.dshpw-local-launcher-seat[open]>.dshpw-local-launcher-trigger{background:var(--dsw-alias-interactive-bg-hover)}
.dshpw-local-launcher-trigger[aria-disabled=true]{cursor:default;opacity:.5}
.dshpw-local-launcher-seat>.dshpw-local-launcher{position:absolute;top:calc(100% + 8px);left:0;z-index:2147482800;width:min(380px,calc(100vw - 28px));box-sizing:border-box;box-shadow:0 12px 36px rgba(0,0,0,.3)}
.dshpw-local-launcher-main{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dshpw-local-launcher-copy{display:flex;flex-direction:column;gap:2px;min-width:0;color:var(--dsw-alias-label-primary)}
.dshpw-local-launcher-copy strong{font-size:13px;font-weight:650}
.dshpw-local-launcher-copy small,.dshpw-local-launcher-fallback{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshpw-local-launcher-status{font-size:12px;color:var(--dsw-alias-state-success-primary,#22c55e)}
.dshpw-local-launcher-fallback summary{width:max-content;max-width:100%;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshpw-local-launcher-help{display:flex;gap:6px 10px;align-items:baseline;flex-wrap:wrap;padding-top:7px}
.dshpw-local-launcher-help a{color:var(--dsw-alias-brand-primary);font-weight:600;text-decoration:none}
.dshpw-local-launcher-help a:hover{text-decoration:underline}
.dshpw-local-guide-link{appearance:none;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.dshpw-local-guide-link:hover{text-decoration:underline}
.dshpw-local-guide-backdrop{position:fixed;inset:0;z-index:2147483640;display:grid;place-items:center;box-sizing:border-box;padding:24px;background:rgba(0,0,0,.58);backdrop-filter:blur(3px)}
.dshpw-local-guide-dialog{width:min(560px,100%);max-height:min(720px,calc(100vh - 48px));overflow:auto;box-sizing:border-box;padding:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-3);box-shadow:0 24px 80px rgba(0,0,0,.45);color:var(--dsw-alias-label-primary)}
.dshpw-local-guide-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dshpw-local-guide-head h2{margin:0;font-size:20px;line-height:1.35}
.dshpw-local-guide-close{appearance:none;flex:none;width:30px;height:30px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:22px;line-height:30px;cursor:pointer}
.dshpw-local-guide-dialog>p{margin:12px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.65}
.dshpw-local-guide-steps{display:flex;flex-direction:column;gap:10px;margin:18px 0;padding-left:24px;font-size:13px;line-height:1.6}
.dshpw-local-guide-steps li::marker{color:var(--dsw-alias-brand-primary);font-weight:700}
.dshpw-local-guide-note{padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55}
.dshpw-local-guide-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:18px;flex-wrap:wrap}
.dshpw-local-guide-dismiss{appearance:none;padding:7px 12px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.dshpw-local-launcher-workspaces{display:flex;flex-direction:column;gap:6px}
.dshpw-local-launcher-workspace{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dshpw-local-launcher-workspace>span{display:flex;flex-direction:column;min-width:0}
.dshpw-local-launcher-workspace strong,.dshpw-local-launcher-workspace small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshpw-local-launcher-workspace small{color:var(--dsw-alias-label-tertiary)}
@media(max-width:640px){.dshpw-fields{grid-template-columns:minmax(0,1fr)}.dshpw-perm-chips{margin-left:0}.dshpw-identity>.dshpw-chip{margin-left:0}.dshpw-local-download,.dshpw-local-launcher-main,.dshpw-general-row{align-items:stretch;flex-direction:column}.dshpw-general-row-copy{padding-right:0}.dshpw-general-logout{justify-content:center}.dshpw-local-workspace{grid-template-columns:minmax(0,1fr) auto}.dshpw-local-workspace>.dshpw-switch-copy{grid-column:1/-1}.dshpw-managed-files-row{grid-template-columns:minmax(0,1fr) auto}.dshpw-managed-files-row>.dshpw-hint{display:none}.dshpw-local-launcher-seat>.dshpw-local-launcher{width:calc(100vw - 28px)}.dshpw-local-guide-backdrop{padding:12px}.dshpw-local-guide-dialog{max-height:calc(100vh - 24px);padding:18px}.dshpw-local-guide-actions{align-items:stretch;flex-direction:column}.dshpw-local-guide-actions>*{justify-content:center;width:100%;box-sizing:border-box;text-align:center}}
`;
