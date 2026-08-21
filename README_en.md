# dsh-passwords

[简体中文](README.md) | English

`dsh-passwords` is the authentication and access-control layer for DeepSeek Harness (dsh). It provides login, account management, workspace and session authorization, sandbox restrictions, and usage limits.

It supports two deployment paths:

- Existing dsh installation: install the plugin with npm.
- New deployment: use the Docker image, which includes dsh `0.1.0-rc.8` and dsh-passwords.

You do not need dsh-passwords for a local-only dsh installation.

## Features

### Remote access

- Login and first-time setup pages
- Cookie sessions lasting 12 hours by default
- Automatic HTTPS, certificate issuance, and renewal for npm deployments
- Login UI follows the dsh theme and language
- Remote access to dsh settings after authentication
- Remote settings patch reload after dsh upgrades

### Account management

- The first account is the owner; later accounts are subusers
- Owners can create, delete, and manage subusers
- Users can change their own username and password; owners can manage every account
- Password and username changes immediately invalidate related sessions
- Successful logins, failed logins, and administrative actions are recorded in the audit log

### Permissions and quotas

Owners can configure each subuser's:

- Workspace and active-session access
- Session and message visibility
- Hourly token limit
- Daily usage-time limit
- Sandbox level
- Upload and git-download permissions
- Account ban status

Subusers can access only the workspaces and sessions granted to them. Subuser messages are private to the owner by default; broadcasts must be explicitly enabled by the owner.

### Collaboration

The settings page and dsh UI provide account-to-account chat and messages with labels for issues, pull requests, discussions, announcements, and questions. Each account can hide the chat entry independently.

## Quick start

### Prerequisites

Choose the requirements for your deployment path:

- npm deployment: Node.js 22.5+, npm, and a working dsh installation.
- Docker deployment: Docker Engine or Docker Desktop and a valid DeepSeek API key. The host does not need Node.js or dsh.
- Production deployment: a domain name or `<public-ip>.sslip.io`. When using nginx or Caddy, route public ports 80 and 443 to the proxy.

### npm installation

Use this path when dsh already runs on the host:

```bash
npm install -g dsh-passwords
dsh-passwords install
```

The installer checks dsh, pnpm, and the prebuilt runtime, generates configuration, registers `dsh-passwords` in the dsh web profile, and applies the remote-settings patch. The npm package already contains `dist/`, so a normal installation does not compile locally.

Check the version or run the gateway manually:

```bash
dsh-passwords --version
dsh-passwords serve-gateway
```

Under normal operation, start dsh web after installation and let the plugin start the gateway.

### Docker installation

The Docker image is `skywalker237234/dsh-passwords`. Omitting the tag uses `latest`. Create `.env`:

```env
DEEPSEEK_API_KEY=your-deepseek-api-key
```

Start the container:

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

The bundled dsh web service listens on `3080` and the password gate listens on `3088`. The host exposes only `127.0.0.1:3088`; public traffic should be terminated by nginx or Caddy and proxied to that address.

Persistent volumes:

- `dsh-home` stores the dsh profile, dependencies, and plugin configuration.
- `dsh-passwords-state` stores `.env`, the SQLite database, and setup state.

Do not remove these volumes. They contain the dsh configuration, accounts, database, and keys.

### First-time setup

For Docker, read the one-time setup key:

```bash
docker exec dsh-passwords cat /data/dsh-passwords/setup-key.txt
```

For npm, the key is stored in `setup-key.txt` in the installation directory. Open the HTTPS URL and enter `SETUP_KEY` to create the owner account. After initialization succeeds, the bootstrap file is deleted.

## Reverse proxy

Docker deployments use nginx or Caddy to terminate TLS on ports 80 and 443. The gateway remains bound to the host loopback address:

```text
HTTPS 443 -> nginx/Caddy -> http://127.0.0.1:3088 -> http://127.0.0.1:3080
```

An nginx proxy must support WebSocket, SSE, and long-lived connections:

```nginx
location / {
    proxy_pass http://127.0.0.1:3088;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Configure HTTP-to-HTTPS redirection in nginx or Caddy. Open ports 80 and 443 in the system firewall and cloud security group. Do not expose Docker administration, dsh RPC, or gateway administration ports publicly.

## Automatic HTTPS

npm deployments can let the gateway manage HTTPS:

- The gateway detects the public IP and requests a Let's Encrypt certificate for `<IP>.sslip.io`.
- Certificates are valid for 90 days and are renewed automatically.
- Set `MCP_GATEWAY_DOMAIN` in `.env` to use your own domain.
- The gateway does not silently fall back to plaintext HTTP if the first certificate request fails.

Docker deployments should terminate TLS in nginx or Caddy. Do not enable two independent TLS terminators for the same public endpoint.

| Code | Meaning | Action |
|---|---|---|
| `30` | Certificate issuance failed | Check ports 80/443, firewalls, DNS, and connectivity to Let's Encrypt |
| `31` | Public IP or domain could not be determined | Set `MCP_GATEWAY_DOMAIN` or use a reverse proxy |
| `32` | A required port is already in use | Free the port or change `MCP_GATEWAY_PORT` |

`sslip.io` keeps the certificate hostname aligned with the URL. Direct HTTPS access through a bare IP may cause a hostname mismatch; use `<public-ip>.sslip.io` or your own domain.

## HTTP mode

Use plaintext HTTP only for internal deployments where the risk is understood:

```bash
node scripts/start-http.mjs 8080
```

Do not use HTTP for public deployments. Passwords and session cookies can be read by a network attacker in plaintext mode.

## Settings card

After signing in to dsh, open **Settings -> Plugins** and use the `dsh-passwords` card:

| Feature | Access | Description |
|---|---|---|
| Remote settings and patch reload | All signed-in users | Reapply the remote-settings patch after a dsh upgrade |
| Change password | User; owner can manage everyone | Existing sessions are invalidated |
| Change username | User; owner can manage everyone | Sign in again with the new username |
| Subuser management | Owner | Create and delete subusers |
| Subuser permissions | Owner | Configure workspaces, sessions, quotas, sandbox, uploads, git downloads, and bans |
| Chat and messages | All signed-in users | Supports labels and an account-level visibility switch |

Passwords must be at least 12 characters and include uppercase, lowercase, a number, and a symbol.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SETUP_KEY` | Generated by the installer | Key for creating the first owner; rotated after initialization |
| `MCP_JWT_SECRET` | Derived from `SETUP_KEY` before setup | Session signing key; changing it invalidates existing sessions |
| `MCP_INTERNAL_SECRET` | Generated during setup | Internal request authentication key |
| `MCP_DB_ENC_KEY` | Generated by the installer | SQLite field-encryption key; do not replace it |
| `MCP_DB_PATH` | `./data/platform.db` | SQLite database path |
| `MCP_GATEWAY_HOST` | `0.0.0.0` | Gateway bind address |
| `MCP_GATEWAY_PORT` | `8080` | Gateway port |
| `MCP_GATEWAY_UPSTREAM` | `http://127.0.0.1:3080` | dsh web upstream |
| `MCP_GATEWAY_DOMAIN` | Empty | Domain used by automatic HTTPS |
| `MCP_GATEWAY_AUTO_TLS` | Enabled | Set to `0` behind Docker reverse proxy |
| `MCP_GATEWAY_REDIRECT_PORT` | `80` | ACME validation and HTTP redirect port |
| `MCP_GATEWAY_PUBLIC_HOST` | Empty | Fixed public hostname to prevent Host-header reflection |
| `MCP_DSH_ROOT` | Auto-detected | dsh installation directory |
| `MCP_DSH_RESTART_SERVICE` | `dsh-web` | systemd service restarted after patch reload; leave empty to disable |
| `DSH_PASSWORDS_ENV_FILE` | Empty | Explicit `.env` path |

The Docker image sets the internal paths and ports required by bundled mode. In most deployments, only `DEEPSEEK_API_KEY` and the reverse-proxy configuration are needed.

## Common commands

For npm deployments:

```bash
dsh-passwords audit --limit 20
dsh-passwords patch status
dsh-passwords patch
dsh-passwords serve-gateway --port 9000
```

For Docker deployments:

```bash
docker ps --filter name=dsh-passwords
docker logs dsh-passwords --tail 100
docker restart dsh-passwords
docker exec dsh-passwords cat /data/dsh-passwords/setup-key.txt
```

## Troubleshooting

- **The login page still shows first-time setup**: the database has no owner account. Enter `SETUP_KEY` again as prompted.
- **The Docker container is running but inaccessible**: inspect `docker logs dsh-passwords`, then check `127.0.0.1:3088`, the nginx/Caddy configuration, and firewall rules for ports 80 and 443.
- **The page loads but chat or settings disconnect**: verify HTTP/1.1, WebSocket, SSE, and disabled proxy buffering.
- **dsh reports `duplicate loader entry id`**: do not use `dsh plugin add` to reconcile the entire profile. Run `dsh-passwords install` so the registration script adds only the dsh-passwords entry.
- **npm reports `allow-scripts` or `node-pty` errors while installing dsh**: this is an upstream dsh native-build requirement. Follow dsh's installation instructions to allow the required scripts, then reinstall dsh.
- **The settings page is broken after a dsh upgrade**: reload the patch from the settings card or run `dsh-passwords patch`, then restart dsh web.
- **You want to change `MCP_DB_ENC_KEY`**: do not change it after it has been used. Back up the database and `.env` together.

## Security and privacy

Passwords are stored only as bcrypt hashes. Sensitive username, IP, and audit details are encrypted with the database key. Keep `.env` and Docker volumes private.

- Repeated login failures trigger account and IP backoff and throttling.
- Logout, password changes, and username changes revoke related sessions.
- Subusers cannot access unauthorized workspaces or sessions.
- Operational endpoints such as dsh-ssh, skin-center, modlens, and dsh-uploads are permission-gated; git downloads are disabled for new subusers by default.
- The gateway limits slow connections, concurrent connections, and unsafe path normalization cases.
- Never commit `.env`, database files, DeepSeek API keys, Docker credentials, or `setup-key.txt`.

## Language

- The login and first-time setup pages follow the dsh or browser language and can switch between Chinese and English.
- The settings card follows the dsh language setting.
- The CLI chooses its language from `LANG`, `LC_ALL`, or `LC_MESSAGES`.

## Version compatibility

The current release is `dsh-passwords 2.6.0`, targeting dsh `0.1.0-rc.8`. Client slot registrations include the `options.key` values required by keyed slots and remain compatible with dsh `0.1.0-rc.6` and later. rc.8 is recommended for matching dependencies and profile layout.

The npm package contains the prebuilt `dist/`, TypeScript source, installation and registration scripts, Docker files, `cordis.yml`, README files, and the license. The Docker image uses the same `src/`, `dist/`, and `scripts/` as npm `2.6.0`.

## License

This project is licensed under the GNU General Public License v3.0 only. See [LICENSE](LICENSE).

Copyright (C) 2026 slywalker2006. You may use, study, modify, commercially use, distribute, and redistribute the project under the GPLv3 terms. Modified or redistributed versions must preserve the applicable copyright and license notices and provide the corresponding source as required by GPLv3.

This is an independent dsh extension and is not affiliated with DeepSeek. dsh itself is licensed separately by its own project.
