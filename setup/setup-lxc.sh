#!/usr/bin/env bash
#
# setup-lxc.sh — install sugpatuben-cs on a fresh Ubuntu LTS LXC container (Proxmox).
#
# Usage (as root inside the container):
#   ./setup-lxc.sh [domain] [port] [git-ref]
#
#   domain   Public domain for the site (prompted for if omitted)
#   port     Local app port NPM will forward to (default: 3001)
#   git-ref  Branch or tag of the repo to deploy (default: main)
#
# The app is fetched from https://github.com/inthevidual/sugpatuben
# (the sugpatuben-cs/ directory). Override the repo with REPO=owner/name.
# While the repo is private, export GITHUB_TOKEN=<fine-grained PAT with
# contents:read on the repo> before running.
#
# What it does: installs ffmpeg, yt-dlp (standalone binary + weekly auto-update
# timer) and Deno; creates the service user; fetches the app to /var/www/sugpatuben-cs;
# installs and starts a sandboxed systemd service; then prints the Nginx Proxy
# Manager configuration for your chosen domain.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (inside the LXC container)." >&2
  exit 1
fi

# ---- Inputs -----------------------------------------------------------------
DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  read -rp "Domain for this site [sugpatuben-cs.cptjanst.se]: " DOMAIN
  DOMAIN="${DOMAIN:-sugpatuben-cs.cptjanst.se}"
fi
APP_PORT="${2:-3001}"
GIT_REF="${3:-main}"
REPO="${REPO:-inthevidual/sugpatuben}"

APP_DIR=/var/www/sugpatuben-cs
APP_USER=sugpatuben
APP_HOME=/var/lib/sugpatuben-cs   # service user home; Deno's dep cache lives here,
                                  # deliberately NOT inside downloads/ (the cleanup sweep dir)

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C.UTF-8 LANG=C.UTF-8   # avoid locale warnings during install
apt-get update -qq
apt-get install -y -qq --no-install-recommends curl ca-certificates unzip ffmpeg python3 locales

echo "==> Generating locales (silences 'Cannot set LC_ALL' warnings on login)"
sed -i -E 's/^# *(en_US\.UTF-8|sv_SE\.UTF-8)/\1/' /etc/locale.gen
locale-gen >/dev/null
update-locale LANG=en_US.UTF-8

echo "==> Installing yt-dlp (standalone binary)"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod 755 /usr/local/bin/yt-dlp
/usr/local/bin/yt-dlp --version

echo "==> Installing Deno"
if ! command -v deno >/dev/null; then
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y >/dev/null
fi
deno --version | head -1

echo "==> Creating service user"
if ! id "$APP_USER" &>/dev/null; then
  useradd --system --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_HOME"
chown "$APP_USER:$APP_USER" "$APP_HOME"

echo "==> Fetching app from github.com/$REPO ($GIT_REF)"
FETCH_DIR=$(mktemp -d)
trap 'rm -rf "$FETCH_DIR"' EXIT
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  # Private repo: authenticated tarball via the API
  curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" \
    "https://api.github.com/repos/$REPO/tarball/$GIT_REF" -o "$FETCH_DIR/repo.tar.gz"
else
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$GIT_REF.tar.gz" -o "$FETCH_DIR/repo.tar.gz" \
    || curl -fsSL "https://github.com/$REPO/archive/refs/tags/$GIT_REF.tar.gz" -o "$FETCH_DIR/repo.tar.gz"
fi
tar xzf "$FETCH_DIR/repo.tar.gz" -C "$FETCH_DIR"
SRC_DIR=$(find "$FETCH_DIR" -maxdepth 2 -type d -name "sugpatuben-cs" | head -1)
if [[ -z "$SRC_DIR" ]]; then
  echo "sugpatuben-cs/ not found in the fetched repo" >&2
  exit 1
fi
mkdir -p "$APP_DIR"
cp -r "$SRC_DIR"/. "$APP_DIR"/
mkdir -p "$APP_DIR/downloads"
chown "$APP_USER:$APP_USER" "$APP_DIR/downloads"
chmod 750 "$APP_DIR/downloads"

# Set the app port if it differs from what the source used
sed -i "s/^const PORT = [0-9]\+;/const PORT = $APP_PORT;/" "$APP_DIR/server.ts"

echo "==> Pre-caching Deno dependencies as $APP_USER"
runuser -u "$APP_USER" -- env DENO_DIR="$APP_HOME/deno-cache" deno cache "$APP_DIR/server.ts"

echo "==> Installing systemd service"
cat > /etc/systemd/system/sugpatuben-cs.service <<EOF
[Unit]
Description=Sug på tuben CS - YouTube downloader (client-side conversion)
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=DENO_DIR=$APP_HOME/deno-cache
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/deno run --allow-net --allow-read --allow-write=$APP_DIR/downloads --allow-run=/usr/local/bin/yt-dlp,/usr/bin/ffprobe server.ts
Restart=on-failure
RestartSec=5

# Sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$APP_DIR/downloads
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF

echo "==> Installing weekly yt-dlp auto-update timer"
cat > /etc/systemd/system/yt-dlp-update.service <<'EOF'
[Unit]
Description=Update yt-dlp to latest release

[Service]
Type=oneshot
ExecStart=/usr/local/bin/yt-dlp -U
EOF
cat > /etc/systemd/system/yt-dlp-update.timer <<'EOF'
[Unit]
Description=Weekly yt-dlp update

[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now yt-dlp-update.timer
systemctl enable --now sugpatuben-cs

echo "==> Waiting for the app to come up"
for i in $(seq 1 15); do
  sleep 1
  if curl -fsS -o /dev/null "http://localhost:$APP_PORT/"; then
    break
  fi
  if [[ $i -eq 15 ]]; then
    echo "App did not respond on port $APP_PORT — check: journalctl -u sugpatuben-cs" >&2
    exit 1
  fi
done
echo "App is running on port $APP_PORT."

CONTAINER_IP=$(hostname -I | awk '{print $1}')

cat <<INSTRUCTIONS

============================================================================
  sugpatuben-cs is installed and running.

  Container IP : $CONTAINER_IP
  App port     : $APP_PORT
  Domain       : $DOMAIN
============================================================================

NGINX PROXY MANAGER SETUP
-------------------------
In NPM, go to  Hosts -> Proxy Hosts -> Add Proxy Host  and fill in:

  Details tab:
    Domain Names          : $DOMAIN
    Scheme                : http
    Forward Hostname / IP : $CONTAINER_IP
    Forward Port          : $APP_PORT
    Block Common Exploits : ON
    Websockets Support    : ON

  SSL tab:
    SSL Certificate : request a new Let's Encrypt certificate for $DOMAIN
                      (if the domain is Cloudflare-proxied, use a DNS
                      challenge with a Cloudflare API token), or pick an
                      existing wildcard certificate that covers it.
    Force SSL       : ON
    HTTP/2 Support  : ON

  Advanced tab -> Custom Nginx Configuration (required — the progress
  updates are Server-Sent Events and downloads can be large/slow):

    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    client_max_body_size 0;

DNS
---
Point $DOMAIN at the machine running NPM. If you keep the current
Cloudflare topology (proxied CNAME -> your origin host, with an Origin Rule
routing this hostname to the port your router forwards to NPM), add both
the CNAME and the Origin Rule for $DOMAIN.

NOTE: the app's Nordic geo-gate reads Cloudflare's cf-ipcountry header.
If the domain is NOT behind the Cloudflare proxy, that header is absent
and all visitors are allowed.

Manage the service with:
  systemctl status sugpatuben-cs
  journalctl -u sugpatuben-cs -f
INSTRUCTIONS
