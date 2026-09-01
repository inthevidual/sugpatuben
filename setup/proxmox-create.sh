#!/usr/bin/env bash
#
# proxmox-create.sh — create an Ubuntu LTS LXC container on a Proxmox host
# and install sugpatuben-cs inside it, end to end.
#
# Run on the Proxmox host shell as root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/inthevidual/sugpatuben/main/setup/proxmox-create.sh) <domain>
#
# Overridable via environment:
#   CTID       container ID          (default: next free ID)
#   CT_NAME    container hostname    (default: sugpatuben-cs)
#   STORAGE    rootfs storage        (default: local-lvm)
#   TSTORE     template storage     (default: local)
#   DISK_GB    rootfs size in GB     (default: 8)
#   MEMORY_MB  container RAM in MB   (default: 2048)
#   CORES      CPU cores             (default: 2)
#   BRIDGE     network bridge        (default: vmbr0)
#   APP_PORT   app port inside CT    (default: 3001)

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root on the Proxmox host." >&2
  exit 1
fi
if ! command -v pct >/dev/null; then
  echo "pct not found — this must run on a Proxmox VE host." >&2
  exit 1
fi

DOMAIN="${1:-${DOMAIN:-}}"
if [[ -z "$DOMAIN" ]]; then
  read -rp "Domain for this site [sugpatuben-cs.cptjanst.se]: " DOMAIN
  DOMAIN="${DOMAIN:-sugpatuben-cs.cptjanst.se}"
fi

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
CT_NAME="${CT_NAME:-sugpatuben-cs}"
STORAGE="${STORAGE:-local-lvm}"
TSTORE="${TSTORE:-local}"
DISK_GB="${DISK_GB:-8}"
MEMORY_MB="${MEMORY_MB:-2048}"
CORES="${CORES:-2}"
BRIDGE="${BRIDGE:-vmbr0}"
APP_PORT="${APP_PORT:-3001}"

echo "==> Finding latest Ubuntu LTS template"
pveam update >/dev/null
TMPL=$(pveam available --section system | awk '{print $2}' | grep -E '^ubuntu-[0-9]+\.04-standard' | sort -V | tail -1)
if [[ -z "$TMPL" ]]; then
  echo "No Ubuntu LTS template found in 'pveam available'." >&2
  exit 1
fi
echo "    $TMPL"
if ! pveam list "$TSTORE" | grep -q "$TMPL"; then
  echo "==> Downloading template to $TSTORE"
  pveam download "$TSTORE" "$TMPL"
fi

echo "==> Creating container $CTID ($CT_NAME)"
pct create "$CTID" "$TSTORE:vztmpl/$TMPL" \
  --hostname "$CT_NAME" \
  --memory "$MEMORY_MB" \
  --cores "$CORES" \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 \
  --features nesting=1 \
  --onboot 1

echo "==> Starting container"
pct start "$CTID"

echo "==> Waiting for network in the container"
for i in $(seq 1 45); do
  if pct exec "$CTID" -- bash -c 'getent hosts github.com' >/dev/null 2>&1; then
    break
  fi
  sleep 2
  if [[ $i -eq 45 ]]; then
    echo "Container never got network/DNS — check bridge/DHCP, then run:" >&2
    echo "  pct exec $CTID -- bash -c 'curl -fsSL https://raw.githubusercontent.com/inthevidual/sugpatuben/main/setup/setup-lxc.sh | bash -s -- $DOMAIN $APP_PORT'" >&2
    exit 1
  fi
done

echo "==> Running sugpatuben-cs setup inside container $CTID"
pct exec "$CTID" -- bash -c "curl -fsSL https://raw.githubusercontent.com/inthevidual/sugpatuben/main/setup/setup-lxc.sh -o /root/setup-lxc.sh && chmod +x /root/setup-lxc.sh && /root/setup-lxc.sh '$DOMAIN' '$APP_PORT'"

CT_IP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
cat <<DONE

============================================================================
  Container $CTID ($CT_NAME) is up: $CT_IP
  sugpatuben-cs is running on port $APP_PORT.

  The Nginx Proxy Manager instructions for $DOMAIN are printed above
  (forward $DOMAIN -> http://$CT_IP:$APP_PORT with proxy_buffering off).

  Handy commands:
    pct enter $CTID
    pct exec $CTID -- systemctl status sugpatuben-cs
    pct exec $CTID -- journalctl -u sugpatuben-cs -f
============================================================================
DONE
