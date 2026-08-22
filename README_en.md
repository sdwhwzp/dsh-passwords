# dsh-passwords

[简体中文](README.md) | English

Adds login, account management, and access controls to the DeepSeek Harness (dsh) web entry point. Use it when dsh is running on a server for a team or for customers.

dsh's web UI is designed for local use by default. Once a server address is shared, anyone with the URL can enter and consume the same model quota. dsh-passwords sits in front of dsh: users sign in first, then workspace, session, sandbox, and usage limits are applied per account.

You do not need it for a local-only dsh setup. Install it when you need remote access, shared use, or managed subuser accounts.

Listed in [Awesome DeepSeek Harness](https://github.com/0xsline/awesome-deepseek-harness) (Infrastructure & Development) and [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (Development & Runtime).

## Features

### 1️⃣ Remote access

- Login page + first-time setup page (on first visit you create the owner account; afterwards everyone goes through the login page)
- One login lasts 12 hours (cookie session, survives browser restarts)
- **Automatic HTTPS**: a Let's Encrypt certificate is requested on the first dsh start and renewed automatically; port 80 redirects to 443
- The login page follows dsh's theme automatically (dark when dsh is dark)
- dsh settings are available from remote browsers; if a dsh upgrade affects the settings page, use “Reload patch” in the plugin card

### 2️⃣ Multi-user

- One **owner** (created at first-time setup) + any number of **subusers**, each with their own login
- All account management happens in a card on dsh's settings page — no SSH needed: change passwords, change usernames, create/delete subusers
- Creating a subuser also creates and registers a private host workspace (default `~/dsh-user-workspaces/u<user-id>`) with an initial `workspace-write` sandbox; existing subusers are backfilled on the first startup after upgrade
- A **Sign out** button beside the current identity immediately revokes the server-side session and clears the cookie after confirmation
- The owner manages all subusers; subusers can only change themselves
- Changing a password immediately invalidates all old sessions; every login and failure is logged — one command shows who signed in when

### 3️⃣ Permissions & quotas

The owner can configure, per subuser, from the settings page:

- **Workspace and session permissions**: the owner enables workspaces per subuser with switches; enabled workspaces expose active sessions by default, with per-session checkboxes to turn individual sessions off. Archived sessions are excluded from the settings list
- **Session and message isolation**: subusers only see enabled workspaces and enabled sessions; messages are limited to broadcasts, messages addressed to them, and messages they sent
- **DM-by-default messages**: subuser messages go to the owner by default; broadcasting is owner-only and must be explicitly chosen
- **Hourly token limit** and **daily usage-time limit**: requests are rejected once the cap is hit
- **Monthly model-spend allowance**: stored as integer CNY micros with ¥0.01 admin precision; shows used, remaining and an 80% warning, and rejects the next model step at 100%
- **Sandbox level**: read-only / workspace-write / full access; when a subuser's AI tries to escalate beyond its level, the gateway forces the approval to "reject"
- **Upload / git-download toggles** and **ban subusers**

### 4️⃣ Collaboration

- A chat button in the bottom-left corner: owner ↔ subuser messages with tags (issue / pull request / discussion / announcement / question); every account can hide its own chat entry from Settings

### 5️⃣ Local workspaces

- Every signed-in user can pair one or more folders from their own computer as independent workspaces without uploading those files to the dsh server
- dsh `read`, `write`, `edit`, `glob`, and `grep` operations act on the original authorized folder through the local companion
- The Windows one-click companion adds `--allow-shell` automatically; command-line mode keeps Shell off until the user adds it explicitly

## Identity and spend synchronization

Owners and subusers always sign in with local accounts and bcrypt passwords stored in this project's SQLite database. The gateway removes browser-supplied identity headers and creates a 30-second HMAC assertion for upstream requests; Harness verifies it and durably attaches the principal to each message, model step and tool execution.

Every model step checks bans, hourly tokens, daily time and the personal monthly allowance together; any failure rejects the step. When a customer submits a question after exhausting an allowance, the conversation explicitly shows the amount used, the limit, that the question was not sent to the model, and that the administrator must increase the allowance. A model call already in flight may finish, so the final amount can exceed the allowance slightly. `dsh-spend` accounts by `(sessionId, turn, step)` idempotently. Natural months use `Asia/Shanghai`; changing an allowance never removes history, and administrators have no personal amount cap by default. The plugin registers the current account's allowance resolver with `dsh-spend`, so subusers see their own remaining CNY allowance in the Spend hover preview and overview.

External file services and their accounts, passwords and databases are managed by their own standalone plugins and are outside dsh-passwords sign-in and configuration.

## Screenshots

| Login page · light | Login page · dark | Login page · English |
|:---:|:---:|:---:|
| <img src="docs/screenshots/white-login.png" width="360"> | <img src="docs/screenshots/black-login.png" width="360"> | <img src="docs/screenshots/white-login-en.png" width="360"> |

| dsh main UI (after login) | Chat / messages | Settings card · account management |
|:---:|:---:|:---:|
| <img src="docs/screenshots/main-ui.png" width="360"> | <img src="docs/screenshots/chat.png" width="360"> | <img src="docs/screenshots/card-front.png" width="360"> |

| | Settings card · permissions & quotas | |
|:---:|:---:|:---:|
| | <img src="docs/screenshots/card-back.png" width="360"> | |
## Quick start

### 0. Prerequisites (three things)

1. **Node.js 22.5+**: check with `node -v` (Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`; Windows: download from nodejs.org)
2. **dsh installed**: `npm install -g @deepseek-ai/dsh`, with your model connection working (dsh's own model config is enough; this plugin needs no extra configuration)
3. **git**: Linux: `apt-get install -y git`; Windows: download from git-scm.com (pnpm is auto-installed by the script when missing)

### 1. Install (by platform)

```bash
# Linux / macOS — Option A: download and install directly
curl -fsSL https://raw.githubusercontent.com/sdwhwzp/dsh-passwords/main/install.sh | bash

# Linux / macOS — Option B: clone first, then install
git clone https://github.com/sdwhwzp/dsh-passwords
cd dsh-passwords
bash install.sh
```

**Windows**: download `install.bat` from the repo and double-click it (or run it after cloning). It installs the project into `%USERPROFILE%\dsh-passwords` and completes all configuration. Binding ports 80/443 needs **no admin rights** on Windows; if a port is occupied, the gate exits with error code 32.

**npm users**:

```bash
npm install -g dsh-passwords
dsh-passwords install     # generates a random SETUP_KEY, registers the plugin and applies the patch (one-click equivalent)
```

(`dsh-passwords --version` prints the version; `dsh-passwords serve-gateway` runs the gateway manually.)

The installer checks for prebuilt files, installing dependencies and building only when they are missing. It then generates `SETUP_KEY`, registers the plugin, and applies the remote-settings patch.

At the end it prints the `SETUP_KEY` for first-time setup and writes it to `setup-key.txt` in the install directory. The file is deleted after setup succeeds; the active keys are kept as independent values in `.env`.

### 2. Finish setup in three steps

1. Start dsh the way you normally do (with dsh's model key already configured, just run `dsh web` — the gate itself needs no extra configuration) — **the password gate starts automatically, no extra commands**
2. Open `https://<server-IP>.sslip.io` in a browser — on the first visit it **automatically shows the first-time setup page**; enter the SETUP_KEY and create the owner account (no need to type `/gateway/setup` manually)
3. From now on, everyone visiting `https://<server-IP>.sslip.io` must pass the login page first

Remember to open ports **80 and 443** in both the server firewall **and** your cloud provider's security group (can't open port 80? See the deployment matrix below).

## Local workspace companion

The companion is for deployments where dsh runs on a server while files remain on each user's computer. The user's computer initiates the connection, so it needs no inbound port. Once paired, the folder appears as a workspace in the dsh sidebar.

Windows users do not need Node.js:

1. Sign in to dsh, expand **Choose a local folder** in the lower-left corner, and download `山东梯智物联AI本机助手.exe` from its fallback section (it is also available under Local workspace in Settings)
2. Put the EXE somewhere permanent and double-click it once. It registers the web-launch protocol for the current Windows user, without administrator access or prompts for a server address or folder
3. Return to dsh, click **Choose a local folder** in the lower-left corner, and select the folder in the native Windows picker. The server address and one-time launch ticket are handled in the background
4. Keep the companion window open. Once connected, the folder appears in the lower-left panel; click **Open conversation** to create or reuse its blank session and show the composer. Credentials are saved per folder, and later double-clicking the same EXE reconnects every authorized folder

The current EXE is unsigned, so Windows may display a SmartScreen warning. Before production distribution, sign it with a valid company code-signing certificate and publish its SHA-256 checksum.

Windows one-click selection adds `--allow-shell` automatically and enables PowerShell. Shell runs as the current Windows user and may access files outside the authorized folder. `山东梯智物联AI本机助手.exe --setup` and the macOS/Linux command-line flow still keep Shell off by default and can enable it explicitly when needed. The Settings page keeps the server address, six-digit approval, and legacy long pairing code for compatibility.

On macOS or Linux, install Node.js 22.5+ and run `npm install -g github:sdwhwzp/dsh-passwords#dev` to install the CLI companion. On first use, provide only the server address shown by the page and the real folder, for example:

```bash
dsh-local-workspace --server ws://192.168.1.10:3082 --folder "/home/user/projects/demo"
```

The CLI displays the same six-digit code; approve it while signed in to finish pairing. Older companions can still use a long `--pair` command from the collapsed **Legacy command-line companion** section, but new devices no longer expose or require that long secret.

The default config file is `~/.dsh-local-workspace/config.json`. Each folder selected by the Windows one-click flow gets its own `~/.dsh-local-workspace/profiles/<workspace-id>.json`, and double-clicking the companion restores them together. For multiple CLI folders, use a different config file for each one, such as `--config ~/.dsh-local-workspace/project-b.json`.

The companion port defaults to the gateway port plus one. If the dsh web gateway uses `3081`, the companion uses `3082`. Allow it through the server firewall. Behind NAT or a reverse proxy, or when the browser-derived address is incorrect, set `MCP_LOCAL_WORKSPACE_PUBLIC_URL=wss://your-domain:port`.

The one-click web entry issues a random 256-bit launch ticket bound to the signed-in user; it expires after two minutes, can be consumed once, and is never written to companion configuration or logs. The fallback six-digit code is not a device credential either: the companion initiates it, it expires after ten minutes, only a signed-in user can approve it once, and failed attempts and pending connections are limited. The real high-entropy token is delivered over the existing WebSocket, stays on the user's computer, and is stored by the server only as a one-way hash. File operations accept only paths within the authorized folder and re-check resolved symlinks. `--allow-shell` is a high-privilege option: the Windows web protocol handler adds it automatically, while other command-line flows require it explicitly. The shell runs as the current OS user and may access files outside the authorized folder. Plain `ws://` is only for trusted LANs; use HTTPS/WSS across untrusted networks.

Maintainers can run `npm run build:windows-assistant` to create `release/山东梯智物联AI本机助手.exe`. The repository's `Build Windows Local Workspace Assistant` workflow also builds and uploads the same artifact on a Windows runner.

## The gate follows dsh

No systemd unit, no manual gateway process, no extra flags for dsh:

```
dsh starts → plugin loads → plugin spawns the password gate (logs appear in dsh's console)
dsh exits  → the gate stops with it (no orphan process holding ports)
```

- Advanced: to run the gateway standalone, use `node dist/cli.js serve-gateway` or set up your own systemd unit.
- Temporarily disable the auto-start (debugging): start dsh with `DSH_PASSWORDS_NO_AUTOSTART=1`.

## Automatic HTTPS

- By default, the server's public IP is detected and a 90-day Let's Encrypt certificate is requested for `<IP>.sslip.io`. It renews 30 days before expiry; new certificates are used without restarting.
- For your own domain, add `MCP_GATEWAY_DOMAIN=your.domain` to `.env` and point its A record at the server.
- If the first issuance fails, the gate does not fall back to plaintext HTTP. If renewal fails while the old certificate remains valid, it keeps serving the old certificate and retries.

| Error code | Meaning | What to do |
|---|---|---|
| **30** | Certificate issuance failed | Check 80/443 are open (firewall + cloud security group), 80 isn't occupied, and Let's Encrypt is reachable |
| **31** | No public IP/domain detected | The server has no public IP or detection failed. Set `MCP_GATEWAY_DOMAIN` if you have a domain; use HTTP mode for LAN-only setups |
| **32** | Port already in use | Change `MCP_GATEWAY_PORT` in `.env` or free the port |

> Why the `.sslip.io` in the URL? Browsers require the certificate name to match the URL, and Let's Encrypt does not issue certificates for bare IPs — `<IP>.sslip.io` is a free name-borrowing service. Opening the bare IP over `https://` directly will still warn about a hostname mismatch; that's expected. Entering via port 80 redirects to the correct address automatically.

## Deployment scenarios

Let's Encrypt http-01 validation needs to reach port 80 on the server's public IP. Allow it through the security group, OS firewall, and any NAT forwarding. If port 80 cannot be opened, choose the matching setup below:

| Scenario | What to do | What users see | Ports to open |
|---|---|---|---|
| ✅ Public server, can open 80/443 | Nothing — the default | HTTPS (auto certificate) | 80 + 443 |
| ✅ You already have a domain certificate | Set `MCP_GATEWAY_TLS_CERT/KEY` in `.env` (any port) | HTTPS (your certificate) | Only your gateway port — 80 not needed at all |
| ✅ nginx/caddy reverse proxy already on the machine | The proxy terminates TLS on 80/443 with a real certificate and forwards to the gate; set `MCP_GATEWAY_AUTO_TLS=0` + a high port + `MCP_GATEWAY_HOST=127.0.0.1` in `.env` | HTTPS (the proxy's certificate) | The proxy owns 80/443; the gate listens on loopback only |
| ✅ Domain on Cloudflare | Cloudflare terminates TLS at the edge; keep automatic HTTPS at the origin or use a Cloudflare Origin Certificate, then use Full (strict) for the CF origin connection | HTTPS (Cloudflare's certificate) | Origin open to Cloudflare only |
| ⚠ No public IP / LAN only | `scripts/start-http.mjs` or `MCP_GATEWAY_AUTO_TLS=0` in `.env` | Plain HTTP | Any port |
| ⚠ Bare IP only, port 80 blocked | HTTP is the only option (protocol limit: http-01 always uses port 80, and a bare IP has no DNS to validate) | Plain HTTP | Any port |

> Note: http-01 only touches port 80 during issuance and renewal (a few seconds, roughly every 60 days). `MCP_GATEWAY_REDIRECT_PORT` defaults to 80 — it handles both the challenge answers and the 301 redirect.

## HTTP mode

The gate does not start in plaintext HTTP by default. Use this mode only for a LAN-only setup where you explicitly accept the risk:

```bash
node scripts/start-http.mjs [port]    # default 8080, asks for y/N confirmation
```

The script prints a plaintext-risk warning first and only starts after you type `y`. Over plain HTTP, passwords and session cookies can be sniffed on the network — for public deployments prefer automatic HTTPS (the default mode; use HTTP mode only when a certificate truly cannot be issued).

For a permanent setup: put `MCP_GATEWAY_AUTO_TLS=0` and `MCP_GATEWAY_PORT=8080` in `.env`; the plugin will then start the gate in HTTP mode whenever dsh starts.

## The gate card in dsh settings

After logging in to dsh, open **Settings → Plugins** to find the "dsh-passwords · Password gate" card:

| Feature | Who can use it | Notes |
|---|---|---|
| **Remote settings + reload patch** | All signed-in users | Remote settings are applied (always on); after a dsh upgrade, click "Reload patch" to fix the settings page in one click (restarts the web service and refreshes the page — no SSH) |
| **Change password** | Yourself; the owner can change anyone's | Old sessions are invalidated immediately |
| **Change username** | Yourself; the owner can change anyone's | Sign in with the new username afterwards |
| **Subuser management** | Owner only | Create/delete subusers (subusers can sign in but have no admin rights) |
| **Subuser permissions** | Owner only | Workspace switches, per-session checkboxes, hourly token limit, daily time limit, sandbox level, upload/git-download toggles, ban |
| **Local workspaces** | All signed-in users | Download the Windows companion, generate a one-time pairing command, inspect online state, and revoke their own paired devices |
| **Chat / messages** | All signed-in users | Chat button in the bottom-left corner, with tags (issue/pull request/discussion/announcement/question); subusers DM the owner by default, broadcasting is owner-only; every account can hide its own chat entry in Settings |

- **Owner** = the account created at first-time setup; everything added later is a **subuser**.
- Passwords follow the same rule as the login page: at least 12 characters with uppercase, lowercase, digits and symbols.

## Configuration reference (.env)

| Variable | Default | Purpose |
|---|---|---|
| `SETUP_KEY` | auto-generated by the installer | First-time setup key. After setup succeeds, it is rotated and the JWT/internal/database keys are frozen independently. Keep `.env`; `setup-key.txt` is deleted automatically |
| `MCP_JWT_SECRET` | derived from SETUP_KEY before first-time setup | Session signing key. It is frozen as an independent value after setup; changing it invalidates existing sign-ins |
| `MCP_DB_PATH` | `./data/platform.db` | Account/permission SQLite file; relative paths resolve from the `.env` directory |
| `MCP_DB_ENC_KEY` | auto-generated by the installer | Data-at-rest encryption key, frozen after setup. **Never change it for an existing database**; back up `.env` with the database |
| `MCP_MANAGED_WORKSPACE_ROOT` | `~/dsh-user-workspaces` | Root for private host workspaces. New/backfilled accounts normally use stable `u<user-id>` children; a random suffix is added when a retained directory already exists so old data is never assigned to a new account. It cannot be inside the database data directory; relative paths resolve from `.env` |
| `MCP_GATEWAY_HOST` | `0.0.0.0` | Gateway listen address |
| `MCP_GATEWAY_PORT` | `443` on first installer setup; `8080` when unset | Gateway port |
| `MCP_GATEWAY_UPSTREAM` | `http://127.0.0.1:3080` | dsh web address (the plugin points it at dsh's actual port automatically — usually leave as-is) |
| `MCP_GATEWAY_REDIRECT_PORT` | `80` | Port 80: ACME challenge answers + 301 redirect to 443 |
| `MCP_GATEWAY_DOMAIN` | empty | Your own domain; when empty, `<public-IP>.sslip.io` is used |
| `MCP_GATEWAY_AUTO_TLS` | on | Empty = auto; `0` disables it (plaintext HTTP, dangerous) |
| `MCP_GATEWAY_ACME_EMAIL` | empty | Optional email for expiry notifications |
| `MCP_GATEWAY_ACME_STAGING` | off | `1` = issue from the LE staging environment (for testing; browsers won't trust it) |
| `MCP_GATEWAY_TLS_CERT` / `MCP_GATEWAY_TLS_KEY` | empty | When both are set, your own certificate is used (takes priority over auto HTTPS) |
| `MCP_GATEWAY_PUBLIC_HOST` | empty | Public IP/domain used for redirects (prevents Host-header reflection) |
| `MCP_LOCAL_WORKSPACE_HOST` | `0.0.0.0` | Local companion WebSocket listen address |
| `MCP_LOCAL_WORKSPACE_PORT` | gateway port + 1 | Local companion port; allow it through the server firewall |
| `MCP_LOCAL_WORKSPACE_PUBLIC_URL` | empty | Full `ws://` or `wss://` URL used in pairing commands; set it explicitly behind NAT/reverse proxies |
| `MCP_DSH_ROOT` | auto-detected | dsh install directory (where `@deepseek-ai/dsh` lives); set manually if detection fails |
| `MCP_DSH_RESTART_SERVICE` | `dsh-web` | systemd service to restart after a patch reload; an explicit empty value disables auto-restart |
| `DSH_PASSWORDS_ENV_FILE` | empty | Explicit path to `.env` (the plugin passes it automatically — usually not needed) |

## Common commands

```bash
node dist/cli.js audit --limit 20             # last 20 audit-log entries (auto-decrypted)
node dist/cli.js patch status                 # remote-settings patch status
node dist/cli.js patch                        # reload the patch (re-applies + restarts dsh-web)
node dist/cli.js serve-gateway --port 9000    # run the gateway manually on another port
node scripts/start-http.mjs 8080              # plaintext HTTP mode (dangerous, y/N confirmation)
dsh-local-workspace                           # reconnect with the saved local device token
```

## FAQ

- **The login page keeps showing "First-time setup"?** The user table is empty (fresh or wiped database). Enter the `SETUP_KEY` as prompted to create the owner account again.
- **Forgot the owner password?** Stop the service and run `node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/platform.db');db.exec('DELETE FROM users;')"`, then restart and redo first-time setup.
- **Does deleting a subuser delete their host files?** No. The workspace registration and account access are revoked, but that account's `u<user-id>` directory (or its collision-safe suffixed form) under `MCP_MANAGED_WORKSPACE_ROOT` is retained until an administrator archives or removes it manually.
- **dsh's console shows error code 30 / 31 and the gate didn't start?** See the error-code table under "Automatic HTTPS" above. After fixing, restarting dsh pulls the gate up again.
- **Port 443 fails to bind (non-root user)?** On Linux, ports below 1024 need root: start dsh as root/sudo, or set `MCP_GATEWAY_PORT` to a high port (e.g. 8443) and forward traffic yourself.
- **The local companion cannot connect?** Confirm the dsh console shows the local-companion listener and allow `MCP_LOCAL_WORKSPACE_PORT` through the server firewall. A web gateway on `3081` defaults the companion to `3082`; set `MCP_LOCAL_WORKSPACE_PUBLIC_URL` across NAT.
- **The local workspace is online but has no composer?** Expand **Choose a local folder** in the lower-left corner and click **Open conversation** beside the online folder. `¥0` disables model calls; after submitting a question, the customer sees an explicit exhausted-allowance notice in the conversation.
- **Nothing opens after clicking “Choose a local folder”?** Expand **Companion did not open?**, download the EXE, and double-click it once to register the protocol, then retry on the original page. Do not move or delete the registered EXE; if you move it, double-click it again at the new location. The web flow never opens `about:blank`, so the current conversation remains intact.
- **The six-digit code is rejected?** Enter only the current six digits shown by the companion. A code expires after ten minutes and can be approved only once; keep the companion running after expiry and it will reconnect with a new code.
- **dsh fails to start with `duplicate loader entry id`?** You used `dsh plugin add` in the profile. It reconciles ALL dependencies declaring `dsh.bundle` into the bundles layer, which crashes dsh when they overlap with already-installed plugins. Uninstall dsh-passwords and register precisely with `node scripts/register-plugin.mjs` (it appends only this plugin).
- **npm fails installing dsh (allow-scripts / node-pty)?** Newer npm blocks install scripts. Allow them first, then reinstall: `npm config set allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs --location=user` followed by `npm install -g @deepseek-ai/dsh` again (this project itself has no such issue — it's dsh's dependencies that run native builds).
- **`dsh-passwords install` reports TS5058 after an npm `--prefix` install?** Upgrade to `dsh-passwords@2.5.4`. It correctly detects runtime dependencies hoisted to `<prefix>/node_modules` and no longer falls back to a source build.
- **dsh reports `crypto.randomUUID is not a function`?** An older gateway build lacks the HTML injection compat layer — update the code and **hard-refresh the browser** (Ctrl+Shift+R).
- **Is it a problem if the database file is stolen?** No. Sensitive fields are encrypted or hashed; without the keys in `.env` they can't be read, and passwords only exist as bcrypt hashes anyway.
- **Can I change `MCP_DB_ENC_KEY` later?** No. Once enabled it must never change, or all historical data becomes unreadable. Back up `.env` together with the database.
- **Stuck on "Loading plugins…" every time?** dsh loads ~30 plugin scripts and answers `no-cache` for them, so the browser re-downloads everything each visit. The gateway forces one-year immutable caching for `/assets/*` and rev-hashed `/plugins/*` (URLs change whenever dsh updates). After an upgrade the first visit still downloads everything once, then refreshes are instant; if it's still slow, hard-refresh once so the new headers apply.
- **Access feels slow?** The gate itself adds only ~1-2ms per request. Check the TLS handshake first: `curl -s -o /dev/null -w "TCP:%{time_connect}s TLS:%{time_appconnect}s\n" https://your-host/gateway/login` — TLS should be tens of milliseconds. If both TCP and TLS are fast, the latency is your network path to the server, which no code can fix.

## Manual install (step by step)

> Windows users: use `install.bat` instead. This section uses Linux as the example; the steps are equivalent.

1. `git clone https://github.com/sdwhwzp/dsh-passwords && cd dsh-passwords`
2. `npm install && npm run build`
3. `cp .env.example .env`, replace `SETUP_KEY` with a random string (`openssl rand -hex 24`)
4. Register the plugin: `node scripts/register-plugin.mjs` (equivalent to adding `link:$(pwd)` to the dependencies and `dsh.profile.bundles` of `~/.dsh/profiles/web/package.json`, then `pnpm install`. **Don't use `dsh plugin add`** — see the FAQ)
5. Apply the patch: `node dist/cli.js patch` (if the dsh directory isn't found, set `MCP_DSH_ROOT=/path/to/@deepseek-ai/dsh`)

Then as usual: start dsh → the gate starts automatically → open `https://<your-host>` to finish first-time setup.

## Security & privacy

Passwords are stored as bcrypt hashes only. Usernames, IPs, and audit records are encrypted in the database; successful and failed logins are recorded. Keys live in the deployment `.env` and database, so back them up together and restrict file access.

- **Brute-force protection**: failed logins lock the account, and the lock duration backs off per round (1 → 5 → 15 → 60 minutes, capped). Owner accounts can't be globally locked out by IP-rotation (per-IP locking still applies) — prevents account-level DoS.
- **Password-spray protection (per-IP throttle)**: 50 failed logins from the same IP within 15 minutes → that IP is globally throttled for 15 minutes (accumulated across usernames — aimed at the "one IP rotating many usernames" spraying technique; bcrypt is not consumed while throttled, and a successful login lifts the throttle). If a large NAT/shared egress trips it by accident, it auto-recovers after 15 minutes with no manual action.
- **Session revocation**: logging out revokes the token server-side immediately; changing the password/username invalidates all old sessions.
- **Subuser isolation (third-party plugin surface)**: ops endpoints such as dsh-ssh (SSH hosts/tunnels), skin-center, modlens, and the dsh-uploads list/delete are owner-only; upload/download stay gated by `allow_upload` / `allowGitDownload`, and **new subusers default to git download off** (including dsh-uploads download and other exfiltration channels) — the owner enables it per-user, so subusers can't enumerate or exfiltrate files from the shared upload storage.
- **Slow-connection protection**: explicit request timeouts (half-open headers cut off at 20s) plus a concurrent-connection cap (512 gateway / 256 redirect) to resist slowloris-style resource exhaustion.
- **Path normalization**: the gate resolves the prefix from the raw URL with iterative decoding (blocks double-encoding), slash collapsing and WHATWG normalization — `%2f..%2f` / `%252f..` SPA-shell bypass variants are all rejected.
- **Hardening tips**:
  1. **After the first-time setup the system automatically deletes `setup-key.txt`, freezes the JWT/internal/field-encryption keys into independent `.env` variables, and rotates SETUP_KEY** — no manual steps needed; only if you deploy against an already-initialized instance (never visiting the setup page) should you delete `setup-key.txt` manually;
  2. `MCP_JWT_SECRET`, `MCP_INTERNAL_SECRET`, and `MCP_DB_ENC_KEY` are frozen automatically after first-time setup. **Do not change `MCP_DB_ENC_KEY` for an existing database**; rotating JWT/internal secrets invalidates current sessions, so plan a maintenance window;
  3. Point `MCP_DSH_RESTART_SERVICE` at the correct systemd service name.

## Language

The UI is bilingual (Chinese/English) and follows dsh's language setting:

- **Login / setup pages**: follow dsh's language (Settings → General → Language), then the browser language; a 中文/English toggle at the top-right persists your choice.
- **Settings card**: follows dsh's language setting, switches instantly.
- **CLI**: follows the `LANG` / `LC_ALL` environment variables (`en` prefix = English).

## Release notes

### v2.5.4 (2026-08-20)

- Fixes `TS5058` after `npm install --prefix <dir>` followed by `dsh-passwords install`; thanks to the Issue #7 report.
- Supports dsh `0.1.0-rc.8` workspace bundle layout and hardens patch preflight, rollback validation, and legacy backup migration.
- Final review hardening: completes the `198.18.0.0/15` public-IP check, validates ACME private-key reuse, fixes HTTP-mode piped input and chat error fallback, and adds regression coverage.

## License

[BSD 3-Clause](./LICENSE) © 2026 slywalker2006 — free to use, modify and distribute; keep the copyright notice.

This project is an independent extension for dsh and is not affiliated with DeepSeek. dsh itself is licensed under its own terms (MIT).
