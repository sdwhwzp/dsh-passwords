#!/bin/sh
set -eu

# Docker creates a named-volume mount as root even when the image directory is
# owned by node. Correct only persistent state, then run all application code
# as the unprivileged node user.
mkdir -p /data/dsh /data/dsh-passwords
chown -R node:node /data/dsh /data/dsh-passwords

exec su node -s /bin/sh -c '
set -eu
node /opt/dsh-passwords/dist/cli.js docker-init
node /opt/dsh-passwords/scripts/register-plugin.mjs
if ! node /opt/dsh-passwords/dist/cli.js patch; then
  echo "[dsh-passwords] dsh patch failed; refusing to start bundled mode." >&2
  exit 1
fi
echo "[dsh-passwords] dsh patch applied; starting dsh so it loads the patched web bundle."

# Start the gateway first. When dsh loads the plugin it sees the occupied port
# and skips spawning a second gateway process.
node /opt/dsh-passwords/dist/cli.js serve-gateway &
gateway_pid=$!
dsh web --no-open &
dsh_pid=$!
trap "kill $dsh_pid $gateway_pid 2>/dev/null || true" INT TERM EXIT
wait "$gateway_pid"
'
