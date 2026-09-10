/** Full-page account directory and native editor dialog layout. */
export const ACCOUNTS_CSS = `
:root{--dsw-alias-label-primary:var(--txt);--dsw-alias-label-secondary:var(--sub);--dsw-alias-label-tertiary:var(--muted);--dsw-alias-label-dimmed:var(--caption);--dsw-alias-bg-layer-1:var(--bg);--dsw-alias-bg-layer-2:var(--field);--dsw-alias-bg-layer-3:var(--card);--dsw-alias-border-l2:var(--border);--dsw-alias-brand-primary:var(--brand);--dsw-alias-label-primary-inverted:#fff}
body{display:block;overflow:auto;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0}
button,input,select{font-family:inherit}a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}
.dshpw-accounts-page{max-width:1560px;margin:auto;padding:24px 32px 48px;box-sizing:border-box}
.dshpw-accounts-nav{display:flex;justify-content:space-between;gap:16px;font-size:13px;margin-bottom:28px}
.dshpw-accounts-root{display:flex;flex-direction:column;gap:16px}
.dshpw-directory-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:24px}
.dshpw-directory-heading h1{font-size:26px;letter-spacing:-.02em;margin:0 0 8px}.dshpw-directory-heading p{color:var(--sub);font-size:14px;margin:0}
.dshpw-directory-actions,.dshpw-row-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshpw-directory-toolbar{display:flex;gap:14px;padding:18px;background:var(--card);border:1px solid var(--border);border-radius:12px 12px 0 0}
.dshpw-filter{display:flex;flex-direction:column;gap:7px;font-size:12px;color:var(--sub);min-width:130px}.dshpw-search{flex:1;min-width:180px}
.dshpw-table-scroll{overflow-x:auto;border:1px solid var(--border);border-top:0;border-radius:0 0 12px 12px}
.dshpw-account-table{width:100%;border-collapse:collapse;font-size:13px;text-align:left;white-space:nowrap}
.dshpw-account-table thead{background:var(--bg);color:var(--sub);font-size:12px}
.dshpw-account-table th,.dshpw-account-table td{padding:16px 14px;vertical-align:middle;border-bottom:1px solid var(--border-soft)}
.dshpw-account-table tbody tr:last-child>*{border-bottom:0}.dshpw-account-table tbody tr:hover{background:var(--border-soft)}
.dshpw-account-table th[scope=row]{font-weight:500;min-width:130px}.dshpw-account-table small{display:block;font-size:11px;font-weight:400;color:var(--muted);margin-top:5px}
.dshpw-account-table .dshpw-money{font-variant-numeric:tabular-nums}.dshpw-date{font-size:12px;color:var(--sub)}
.dshpw-row-actions{flex-wrap:nowrap}.dshpw-row-actions .ghost{border-color:transparent;background:none;padding-left:5px;padding-right:5px;color:var(--brand)}
.dshpw-pagination{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:18px 0;font-size:13px;color:var(--sub)}
.dshpw-pagination>span:first-child{margin-right:auto}.dshpw-pagination .dshpw-filter{flex:0 0 auto;flex-direction:row;align-items:center;min-width:0;white-space:nowrap}.dshpw-pagination select{width:72px}
.dshpw-account-dialog{color:var(--txt);background:var(--bg);border:1px solid var(--border);border-radius:18px;width:min(760px,calc(100vw - 32px));max-height:calc(100dvh - 40px);padding:0;box-sizing:border-box;box-shadow:0 18px 70px #0003;overscroll-behavior:contain}
.dshpw-account-dialog::backdrop{background:#0005;backdrop-filter:blur(3px)}
.dshpw-account-dialog>header{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 24px;background:var(--bg);border-bottom:1px solid var(--border)}
.dshpw-account-dialog h2{font-size:17px;margin:0;overflow-wrap:anywhere}.dshpw-dialog-body{padding:8px 24px 24px}.dshpw-dialog-body>.dshpw-banner{margin-top:12px}.dshpw-dialog-body .dshpw-section{border:0}
@media(max-width:800px){.dshpw-accounts-page{padding:18px 16px}.dshpw-directory-heading{align-items:flex-start;flex-direction:column}.dshpw-directory-toolbar{flex-wrap:wrap}.dshpw-search{flex-basis:100%}.dshpw-filter{flex:1;min-width:110px}.dshpw-dialog-body{padding:8px 16px 16px}.dshpw-account-dialog>header{padding:16px}.dshpw-row-actions{flex-wrap:wrap;min-width:180px}}
`;
