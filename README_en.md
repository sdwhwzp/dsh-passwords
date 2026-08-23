# dsh-passwords

[简体中文](README.md) | English

A server-grade gateway for DeepSeek Harness (dsh): it turns dsh from a local, single-user tool into a multi-tenant platform people can use remotely.

dsh's built-in web UI has no login, no permissions, and no usage controls — put it on a server and anyone with the URL can use it and burn your model credits. dsh-passwords puts a gateway in front of dsh: unauthenticated visitors see the login page first; after sign-in, every account is subject to per-account permission and quota enforcement. Installation takes a single command — no extra configuration required, works out of the box.

Listed in the [Awesome DeepSeek Harness](https://github.com/0xsline/awesome-deepseek-harness) ecosystem index (Infrastructure & Development) and the [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) list (Development & Runtime).

## Features

### Remote access

- Login page + first-time setup page (on first visit you create the owner account; afterwards everyone goes through the login page)
- One login lasts 12 hours (cookie session, survives browser restarts)
- Automatic HTTPS: a browser-trusted Let's Encrypt certificate is issued automatically at install — zero config, auto-renewing; port 80 redirects to 443
- The login page follows dsh's theme automatically (dark when dsh is dark)
- Remote browsers can use every dsh settings feature (dsh by default only lets local browsers edit settings; dsh-passwords handles this automatically — and if the settings page breaks after a dsh upgrade, the in-settings card has a one-click "Reload patch" fix)

### Multi-user

- One owner (created at first-time setup) + any number of subusers, each with their own login
- All account management happens in a card on dsh's settings page — no SSH needed: change passwords, change usernames, create/delete subusers
- The owner manages all subusers; subusers can only change themselves
- Changing a password immediately invalidates all old sessions; every login and failure is logged — one command shows who signed in when

### Permissions & quotas

The owner can configure, per subuser, from the settings page:

- Workspace allowlist: a subuser only sees and opens the folders you assign; sessions inside an allowed workspace can also be toggled individually
- Hourly token limit and daily usage-time limit: requests are rejected once the cap is hit
- Sandbox level: read-only / workspace-write / full access; when a subuser's AI tries to escalate beyond its level, the gateway forces the approval to "reject"
- Upload / git-download toggles and ban subusers

### Collaboration

- A chat button in the bottom-left corner: owner ↔ subuser messages with tags (issue / pull request / discussion / announcement / question); subuser messages default to a private DM to the owner, only the owner can broadcast

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

### Prerequisites

Host installs need Node.js 22.5+, a working dsh installation, and git. dsh's model connection is all you need to configure — this plugin requires nothing extra. Docker installs only need Docker Engine or Docker Desktop plus a DeepSeek API key; no Node.js or dsh on the host.

### Install

dsh-passwords offers 5 install methods — pick one for your platform:

- Linux / macOS: download and install directly, or clone first and install
- Any platform: npm global install
- Windows: run install.bat
- Any platform: Docker

Host installs (the first four) all do the same thing automatically: install dependencies, build, generate a random SETUP_KEY, register as a dsh plugin, and apply the remote-settings patch. The installer checks Node.js 22.5+, dsh and git, and installs pnpm automatically if it's missing; an existing `.env` is never overwritten, so re-running is safe; the setup key is printed and written to `setup-key.txt` only on the first install, so re-running with an existing `.env` never re-exposes the key. Docker initializes on first container start and launches the bundled dsh and the gate itself.

#### Download and install directly (Linux / macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/slywalker2006/dsh-passwords/main/install.sh | bash
```

Installs to `/opt/dsh-passwords` (root) or `$HOME/dsh-passwords` (regular user) by default; set the `DSH_PASSWORDS_DIR` environment variable to change the location. If the target directory already exists the installer exits with an error — to reinstall, delete the old directory first (back up `.env` and `data/` inside). Non-root accounts need sudo to bind 80/443 for automatic HTTPS.

The installer prints the SETUP_KEY at the end; it's also written to `setup-key.txt` in the install directory.

First-time setup:

1. Note the SETUP_KEY, then start dsh the way you normally do: `dsh web`.
2. Open `https://<server-IP>.sslip.io` in a browser — the first visit automatically shows the setup page; enter the SETUP_KEY and create the owner account.
3. From now on everyone visiting that address must pass the login page first. `setup-key.txt` is deleted automatically once first-time setup succeeds, and the keys in `.env` are frozen and rotated.

#### Clone first, then install (Linux / macOS)

```bash
git clone https://github.com/slywalker2006/dsh-passwords
cd dsh-passwords
bash install.sh
```

The installer prints the SETUP_KEY at the end; it's also written to `setup-key.txt` in the current project directory.

First-time setup:

1. Note the SETUP_KEY, then start dsh the way you normally do: `dsh web`.
2. Open `https://<server-IP>.sslip.io` in a browser — the first visit automatically shows the setup page; enter the SETUP_KEY and create the owner account.
3. From now on everyone visiting that address must pass the login page first. `setup-key.txt` is deleted automatically once first-time setup succeeds, and the keys in `.env` are frozen and rotated.

#### npm install (any platform)

```bash
npm install -g dsh-passwords
dsh-passwords install
```

The installer prints the SETUP_KEY at the end. To view it again, run `npm root -g` to get the global directory and open `dsh-passwords/setup-key.txt` inside it. Same on Windows.

First-time setup:

1. Note the SETUP_KEY, then start dsh the way you normally do: `dsh web`.
2. Open `https://<server-IP>.sslip.io` in a browser — the first visit automatically shows the setup page; enter the SETUP_KEY and create the owner account.
3. From now on everyone visiting that address must pass the login page first. `setup-key.txt` is deleted automatically once first-time setup succeeds, and the keys in `.env` are frozen and rotated.

#### Windows

Download `install.bat` from the repo and double-click it, or run it after cloning. It installs to `%USERPROFILE%\dsh-passwords` by default; set `DSH_PASSWORDS_DIR` to change the location. The installer prints the SETUP_KEY at the end; the key file is `setup-key.txt` in that directory. Binding 80/443 needs no admin rights on Windows; if a port is occupied, the gate exits with error code 32.

First-time setup:

1. Note the SETUP_KEY, then start dsh the way you normally do: `dsh web`.
2. Open `https://<server-IP>.sslip.io` in a browser — the first visit automatically shows the setup page; enter the SETUP_KEY and create the owner account.
3. From now on everyone visiting that address must pass the login page first. `setup-key.txt` is deleted automatically once first-time setup succeeds, and the keys in `.env` are frozen and rotated.

#### Docker

Image: `skywalker237234/dsh-passwords` (no tag = `latest`). The image already bundles dsh and dsh-passwords, so the host needs neither Node.js nor dsh.

Create a `.env` with your DeepSeek API key:

```env
DEEPSEEK_API_KEY=your-deepseek-api-key
MCP_GATEWAY_PUBLIC_HOST=your.domain.example
```

`MCP_GATEWAY_PUBLIC_HOST` may be left empty; fill in the actual address when using your own domain or `<public-IP>.sslip.io`.

Start the container (example — adjust the parameters to your setup):

```bash
docker run -d \
  --name dsh-passwords \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:3088:3088 \
  -v dsh-home:/data/dsh \
  -v dsh-passwords-state:/data/dsh-passwords \
  skywalker237234/dsh-passwords
```

Wait for initialization and confirm the container is healthy:

```bash
docker logs -f dsh-passwords
```

Press Ctrl+C after you see `dsh patch applied; starting dsh` — this does not stop the container.

First-time setup:

1. Read the one-time SETUP_KEY the container generated: `docker exec dsh-passwords cat /data/dsh-passwords/setup-key.txt`.
2. Reverse-proxy 80/443 to `http://127.0.0.1:3088` with nginx or Caddy, open the proxied HTTPS address, enter the SETUP_KEY and create the owner account.
3. From now on that address requires the login page. The bundled dsh is started by the entrypoint script — no need to run `dsh web`.

Don't delete the two named volumes: `dsh-home` holds the dsh profile, dependencies and plugin config; `dsh-passwords-state` holds `.env`, the SQLite database, certificates and initialization state. Deleting them loses accounts, config and keys.

> The container listens on `127.0.0.1:3088` only — don't expose 3088 to the public internet. Public traffic should be TLS-terminated by nginx or Caddy and forwarded to it; open 80/443 in the firewall and security group.

For split-container deployments (dsh and the gate in separate containers), dsh only binds loopback by default, so the gateway container can't reach dsh web. Set `MCP_DSH_PATCH_ALLOW_BIND_ALL=1` on the dsh container to let dsh web bind 0.0.0.0 (this widens the security surface — use it only for split-container setups).

Host installs: `dsh-passwords --version` prints the version. Docker: `docker logs dsh-passwords --tail 100` shows the logs.

## Automatic HTTPS

- By default the server's public IP is detected and a 90-day Let's Encrypt certificate is issued for `<IP>.sslip.io`; it renews automatically 30 days before expiry (hot-loaded, no restart) — zero ongoing effort
- Own a domain? Add `MCP_GATEWAY_DOMAIN=your.domain` to `.env` and point an A record at the server; the certificate is re-issued for your domain
- If issuance fails the gate refuses to start (with an error code) — it never silently downgrades to plaintext HTTP. If a renewal fails while the old certificate is still valid, it keeps serving it and retries in the background.

| Error code | Meaning | What to do |
|---|---|---|
| 30 | Certificate issuance failed | Check 80/443 are open (firewall + cloud security group), 80 isn't occupied, and Let's Encrypt is reachable |
| 31 | No public IP/domain detected | The server has no public IP or detection failed. Set `MCP_GATEWAY_DOMAIN` if you have a domain; use HTTP mode for LAN-only setups |
| 32 | Port already in use | Change `MCP_GATEWAY_PORT` in `.env` or free the port |

> Why the `.sslip.io` in the URL? Browsers require the certificate name to match the URL, and Let's Encrypt does not issue certificates for bare IPs — `<IP>.sslip.io` is a free name-borrowing service. Opening the bare IP over `https://` directly will still warn about a hostname mismatch; that's expected. Entering via port 80 redirects to the correct address automatically.

## Configuration options

There are 6 ways to configure access and HTTPS — pick the one that matches your network:

| Scenario | What to do | What users see | Ports to open |
|---|---|---|---|
| Public server, can open 80/443 | Nothing — the default | HTTPS (auto certificate) | 80 + 443 |
| You already have a domain certificate | Set `MCP_GATEWAY_TLS_CERT/KEY` in `.env` (any port) | HTTPS (your certificate) | Only your gateway port — 80 not needed at all |
| nginx/caddy reverse proxy already on the machine | The proxy terminates TLS on 80/443 with a real certificate and forwards to the gate; set `MCP_GATEWAY_AUTO_TLS=0` + a high port in `.env`, gate listens on loopback only | HTTPS (the proxy's certificate) | The proxy owns 80/443; the gate has zero public exposure |
| Domain on Cloudflare | Cloudflare terminates TLS at the edge and forwards to any origin port (same `.env` settings as the reverse-proxy case) | HTTPS (Cloudflare's certificate) | Origin open to Cloudflare only |
| No public IP / LAN only | `scripts/start-http.mjs` or `AUTO_TLS=0` in `.env` | Plain HTTP | Any port |
| Bare IP only, port 80 blocked | HTTP is the only option (protocol limit: http-01 always uses port 80, and a bare IP has no DNS to validate) | Plain HTTP | Any port |

> Note: http-01 only touches port 80 during issuance and renewal (a few seconds, roughly every 60 days). `MCP_GATEWAY_REDIRECT_PORT` defaults to 80 — it handles both the challenge answers and the 301 redirect.

## HTTP mode

The gate refuses to run in plaintext HTTP by default. If you really must (LAN-only, and you accept the risk):

```bash
node scripts/start-http.mjs [port]    # default 8080, asks for y/N confirmation
```

The script prints a plaintext-risk warning first and only starts after you type `y`. Over plain HTTP, passwords and session cookies can be sniffed on the network — for public deployments prefer automatic HTTPS (the default mode; use HTTP mode only when a certificate truly cannot be issued).

For a permanent setup: put `MCP_GATEWAY_AUTO_TLS=0` and `MCP_GATEWAY_PORT=8080` in `.env`; the plugin will then start the gate in HTTP mode whenever dsh starts.

## The gate card in dsh settings

After logging in to dsh, open Settings → Plugins to find the "dsh-passwords · Password gate" card:

| Feature | Who can use it | Notes |
|---|---|---|
| Remote settings + reload patch | All signed-in users | Remote settings are applied (always on); after a dsh upgrade, click "Reload patch" to fix the settings page in one click (restarts the web service and refreshes the page — no SSH) |
| Software updates | Status visible to all; actions owner-only | Auto-checks for new versions, rate-limited download, auto-install + restart after 1h of idle; or manual "Check now" / "Install & restart" |
| Change password | Yourself; the owner can change anyone's | Old sessions are invalidated immediately |
| Change username | Yourself; the owner can change anyone's | Sign in with the new username afterwards |
| Subuser management | Owner only | Create/delete subusers (subusers can sign in but have no admin rights) |
| Subuser permissions | Owner only | Workspace allowlist, hourly token limit, daily time limit, sandbox level, upload/git-download toggles, ban |
| Chat / messages | All signed-in users | Chat button in the bottom-left corner, with tags (issue/pull request/discussion/announcement/question) |
| Sign out | All signed-in users | Log out of the current account and return to the login page |

- Owner = the account created at first-time setup; everything added later is a subuser.
- Passwords follow the same rule as the login page: at least 12 characters with uppercase, lowercase, digits and symbols.

## Software updates

The settings card has a "Software updates" section that auto-checks GitHub for new releases by default:

- Checks once at startup, then every 24 hours; downloads are rate-limited (default ≤1MiB/s, change with `MCP_DSH_UPDATE_MAX_BPS`) and verified against the npm registry's sha512 integrity before use (mismatch = discarded)
- After verification, it waits for 1 hour of continuous idle before installing and restarting the dsh web service; or click "Install now" to skip the idle window (10-minute cooldown)
- Auto-update is on by default; the owner can turn it off in the card, and `MCP_DSH_AUTO_UPDATE=0` forces it off at the deployment level. The owner can still check and install manually
- npm installations use the verified release package. A Git source tree is updated only when clean and after `npm ci`, tests, and the build pass. Docker auto-update is only suitable when the runtime can call the host's Compose setup; set `MCP_DSH_DOCKER_COMPOSE_DIR` and the engine will verify that the `dsh-passwords` service is running after the update

## Configuration reference

`.env` quick reference:

| Variable | Default | Purpose |
|---|---|---|
| `SETUP_KEY` | auto-generated by the installer | First-time setup key; rotated automatically after first-time setup, and the JWT session key is frozen into an independent variable |
| `MCP_JWT_SECRET` | empty (derived from SETUP_KEY) | Session signing key. For production, set it independently (`openssl rand -hex 32`) so a leaked SETUP_KEY can't forge sessions |
| `MCP_DB_PATH` | `./data/platform.db` | Database file (SQLite, created automatically — no MySQL needed) |
| `MCP_DB_ENC_KEY` | empty | Data-at-rest encryption key. Generate with `openssl rand -hex 32`. Once set it must never change, or old data becomes unreadable |
| `MCP_GATEWAY_HOST` | `0.0.0.0` | Gateway listen address |
| `MCP_GATEWAY_PORT` | `443` | Gateway port |
| `MCP_GATEWAY_UPSTREAM` | `http://127.0.0.1:3080` | dsh web address (the plugin points it at dsh's actual port automatically — usually leave as-is) |
| `MCP_GATEWAY_REDIRECT_PORT` | `80` | Port 80: ACME challenge answers + 301 redirect to 443 |
| `MCP_GATEWAY_DOMAIN` | empty | Your own domain; when empty, `<public-IP>.sslip.io` is used |
| `MCP_GATEWAY_AUTO_TLS` | on | Empty = auto; `0` disables it (plaintext HTTP, dangerous) |
| `MCP_GATEWAY_ACME_EMAIL` | empty | Optional email for expiry notifications |
| `MCP_GATEWAY_ACME_STAGING` | off | `1` = issue from the LE staging environment (for testing; browsers won't trust it) |
| `MCP_GATEWAY_TLS_CERT` / `MCP_GATEWAY_TLS_KEY` | empty | When both are set, your own certificate is used (takes priority over auto HTTPS) |
| `MCP_GATEWAY_PUBLIC_HOST` | empty | Public IP/domain used for redirects (prevents Host-header reflection) |
| `MCP_DSH_ROOT` | auto-detected | dsh install directory (where `@deepseek-ai/dsh` lives); set manually if detection fails |
| `MCP_DSH_RESTART_SERVICE` | `dsh-web` | systemd service to restart after a patch reload; an explicit empty value disables auto-restart |
| `MCP_DSH_AUTO_UPDATE` | on | Deployment-level auto-update master switch; `0/false/no` forces it off (manual check/install still available in the settings page) |
| `MCP_DSH_UPDATE_MAX_BPS` | 1MiB/s | Update download rate limit (bytes/sec) |
| `MCP_DSH_DOCKER_COMPOSE_DIR` | empty | Compose directory used for Docker auto-updates; it only works when the runtime can call the host Docker/Compose setup, and stays off when unset |
| `MCP_DSH_PATCH_ALLOW_BIND_ALL` | off | For split-container Docker: `1` lets dsh web bind 0.0.0.0 so a gateway in another container can reach it |
| `DSH_PASSWORDS_ENV_FILE` | empty | Explicit path to `.env` (the plugin passes it automatically — usually not needed) |

## Common commands

```bash
node dist/cli.js audit --limit 20             # last 20 audit-log entries (auto-decrypted)
node dist/cli.js patch status                 # remote-settings patch status
node dist/cli.js patch                        # reload the patch (re-applies + restarts dsh-web)
node dist/cli.js serve-gateway --port 9000    # run the gateway manually on another port
node scripts/start-http.mjs 8080              # plaintext HTTP mode (dangerous, y/N confirmation)
DSH_PASSWORDS_NO_AUTOSTART=1 dsh web         # temporarily disable gate auto-start (debugging)
curl -s https://your-host/gateway/healthz     # liveness check, 200
curl -s https://your-host/gateway/readyz      # readiness check (includes DB), 200/503
```

## FAQ

- The login page keeps showing "First-time setup"? The user table is empty (fresh or wiped database). Enter the `SETUP_KEY` as prompted to create the owner account again.
- Forgot the owner password? Stop the service and run `node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/platform.db');db.exec('DELETE FROM users;')"`, then restart and redo first-time setup.
- dsh's console shows error code 30 / 31 and the gate didn't start? See the error-code table under "Automatic HTTPS" above. After fixing, restarting dsh pulls the gate up again.
- Port 443 fails to bind (non-root user)? On Linux, ports below 1024 need root: start dsh as root/sudo, or set `MCP_GATEWAY_PORT` to a high port (e.g. 8443) and forward traffic yourself.
- dsh fails to start with `duplicate loader entry id`? You used `dsh plugin add` in the profile. It reconciles ALL dependencies declaring `dsh.bundle` into the bundles layer, which crashes dsh when they overlap with already-installed plugins. Uninstall dsh-passwords and register precisely with `node scripts/register-plugin.mjs` (it appends only this plugin).
- npm fails installing dsh (allow-scripts / node-pty)? Newer npm blocks install scripts. Allow them first, then reinstall: `npm config set allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs --location=user` followed by `npm install -g @deepseek-ai/dsh` again (this project itself has no such issue — it's dsh's dependencies that run native builds).
- dsh reports `crypto.randomUUID is not a function`? An older gateway build lacks the HTML injection compat layer — update the code and hard-refresh the browser (Ctrl+Shift+R).
- Is it a problem if the database file is stolen? No. Sensitive fields are encrypted or hashed; without the keys in `.env` they can't be read, and passwords only exist as bcrypt hashes anyway.
- Can I change `MCP_DB_ENC_KEY` later? No. Once enabled it must never change, or all historical data becomes unreadable. Back up `.env` together with the database.
- Stuck on "Loading plugins…" every time? dsh loads ~30 plugin scripts and answers `no-cache` for them, so the browser re-downloads everything each visit. The gateway forces one-year immutable caching for `/assets/*` and rev-hashed `/plugins/*` (URLs change whenever dsh updates). After an upgrade the first visit still downloads everything once, then refreshes are instant; if it's still slow, hard-refresh once so the new headers apply.
- Access feels slow? The gate itself adds only ~1-2ms per request. Check the TLS handshake first: `curl -s -o /dev/null -w "TCP:%{time_connect}s TLS:%{time_appconnect}s\n" https://your-host/gateway/login` — TLS should be tens of milliseconds. If both TCP and TLS are fast, the latency is your network path to the server, which no code can fix.

## Manual install

> Windows users: use `install.bat` instead. This section uses Linux as the example; the steps are equivalent.

1. `git clone https://github.com/slywalker2006/dsh-passwords && cd dsh-passwords`
2. `npm install && npm run build`
3. `cp .env.example .env`, replace `SETUP_KEY` with a random string (`openssl rand -hex 24`)
4. Register the plugin: `node scripts/register-plugin.mjs` (equivalent to adding `link:$(pwd)` to the dependencies and `dsh.profile.bundles` of `~/.dsh/profiles/web/package.json`, then `pnpm install`. Don't use `dsh plugin add` — see the FAQ)
5. Apply the patch: `node dist/cli.js patch` (if the dsh directory isn't found, set `MCP_DSH_ROOT=/path/to/@deepseek-ai/dsh`)

Then as usual: start dsh → the gate starts automatically → open `https://<your-host>` to finish first-time setup.

## Security & privacy

Passwords are stored only as bcrypt hashes; usernames, IPs and audit records are encrypted at rest; every login and failure is audited; certificate-issuance failure stops the service instead of downgrading to plaintext. All keys live in your own `.env` and database — open source code does not weaken security.

- Brute-force protection: failed logins lock the account, and the lock duration backs off per round (1 → 5 → 15 → 60 minutes, capped). Owner accounts can't be globally locked out by IP-rotation (per-IP locking still applies) — prevents account-level DoS.
- Password-spray protection (per-IP throttle): 30 failed logins from the same IP within 15 minutes → that IP is globally throttled for 30 minutes (accumulated across usernames — aimed at the "one IP rotating many usernames" spraying technique; bcrypt is not consumed while throttled, and a successful login lifts the throttle). If a large NAT/shared egress trips it by accident, it auto-recovers after 30 minutes with no manual action.
- Session revocation: logging out revokes the token server-side immediately; changing the password/username invalidates all old sessions.
- Subuser isolation (third-party plugin surface): ops endpoints such as dsh-ssh (SSH hosts/tunnels), skin-center, modlens, and the dsh-uploads list/delete are owner-only; upload/download stay gated by `allow_upload` / `allowGitDownload`, and new subusers default to git download off (including dsh-uploads download and other exfiltration channels) — the owner enables it per-user, so subusers can't enumerate or exfiltrate files from the shared upload storage.
- Slow-connection protection: explicit request timeouts (half-open headers cut off at 20s) plus a concurrent-connection cap (512 gateway / 256 redirect) to resist slowloris-style resource exhaustion.
- Path normalization: the gate resolves the prefix from the raw URL with iterative decoding (blocks double-encoding), slash collapsing and WHATWG normalization — `%2f..%2f` / `%252f..` SPA-shell bypass variants are all rejected.
- Hardening tips:
  1. After the first-time setup the system automatically deletes `setup-key.txt`, freezes the JWT/internal/field-encryption keys into independent `.env` variables, and rotates SETUP_KEY — no manual steps needed; only if you deploy against an already-initialized instance (never visiting the setup page) should you delete `setup-key.txt` manually;
  2. For stronger isolation you can set an independent `MCP_JWT_SECRET` and `MCP_DB_ENC_KEY` in `.env` (both via `openssl rand -hex 32`) — after first-time setup these are already frozen automatically; setting them manually just swaps in new keys;
  3. Point `MCP_DSH_RESTART_SERVICE` at the correct systemd service name.

## Language

The UI is bilingual (Chinese/English) and follows dsh's language setting:

- Login / setup pages: follow dsh's language (Settings → General → Language), then the browser language; a 中文/English toggle at the top-right persists your choice.
- Settings card: follows dsh's language setting, switches instantly.
- CLI: follows the `LANG` / `LC_ALL` environment variables (`en` prefix = English).

## Version compatibility

Current release: dsh-passwords 2.6.0, fully compatible with dsh 0.1.1-rc.2 (keyed slots, the patch chain and profile layout stay aligned since rc.8), and still compatible with dsh 0.1.0-rc.6 and later.

The npm package ships the prebuilt `dist/`, TypeScript source, install/register scripts, Docker files, `cordis.yml`, READMEs and the license. The Docker image uses the same `src/`, `dist/` and `scripts/` as npm 2.6.0.

## License

This project is licensed under the [GNU General Public License v3.0 only](https://www.gnu.org/licenses/gpl-3.0.html). See the repository copy in [LICENSE](LICENSE).

Copyright (C) 2026 slywalker2006. You may use, study, modify, commercially use, distribute, and redistribute the project under the GPLv3 terms. Modified or redistributed versions must preserve the applicable copyright and license notices and provide the corresponding source as required by GPLv3.

This is an independent dsh extension and is not affiliated with DeepSeek. dsh itself is licensed separately by its own project.
