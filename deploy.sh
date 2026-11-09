#!/usr/bin/env bash
# VoidPixelatr — deploy to the LAN host.
#
# Usage:
#   ./deploy.sh              # deploy to the registered host
#   ./deploy.sh <host>       # deploy to a specific host (key auth)
#
# What it does:
#   1. rsyncs the site files into the webroot
#   2. installs the nginx vhost and the shared security-headers snippet
#   3. validates the nginx config and reloads
#   4. smoke tests the result
#
# The site is static: no service to start, no runtime to install. Only the
# files and the nginx vhost change.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# The umbrella repo holds the shared nginx snippets and the host keys. This
# project is standalone: it is a SIBLING of the umbrella on the Desktop
# (~/Desktop/voidpixelatr and ~/Desktop/TheVoidCo), not a child of it. So the
# umbrella is found by walking up the tree, and then by looking at the
# siblings of this folder. Set REPO_ROOT to override both.
find_repo_root() {
  local dir="$1"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/ops/nginx-snippets/security-headers.conf" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname -- "$dir")"
  done

  # A sibling of this folder — the usual layout for a standalone project.
  local parent sibling
  parent="$(dirname -- "$1")"
  for sibling in "$parent"/*/; do
    [ -d "$sibling" ] || continue
    if [ -f "$sibling/ops/nginx-snippets/security-headers.conf" ]; then
      echo "${sibling%/}"
      return 0
    fi
  done

  return 1
}

REPO_ROOT="$(find_repo_root "$SCRIPT_DIR" || true)"
if [ -z "${REPO_ROOT:-}" ]; then
  echo "error: could not find the umbrella repo (ops/nginx-snippets/security-headers.conf)." >&2
  echo "       It normally sits next to this folder on the Desktop." >&2
  echo "       Point REPO_ROOT at it, or set VOIDPIXELATR_KEY and copy the snippet by hand." >&2
  exit 1
fi

# The host address is reserved in the router at provisioning time and
# registered in the umbrella's ops/vm.sh. Override it here if it changes.
#
# 192.0.2.0 is the RFC 5737 documentation address. It is deliberately NOT a
# real address: the deploy refuses to run against it, so a half-provisioned
# host can never be overwritten by accident.
HOST="${1:-${VOIDPIXELATR_HOST:-192.0.2.0}}"
USER="${VOIDPIXELATR_USER:-root}"

# There is ONE deploy key for TheVoidCo's infrastructure
# (ops/keys/thevoidco-lxc-id_ed25519). A container cloned from the template
# inherits it in /root/.ssh/authorized_keys, so this is the same key every
# other Void* host uses — not a per-project key.
KEY="${VOIDPIXELATR_KEY:-$REPO_ROOT/ops/keys/thevoidco-lxc-id_ed25519}"
WEBROOT="/var/www/voidpixelatr"

# The token in the checked-in vhost that stands in for the real address.
PLACEHOLDER_IP="192.0.2.0"

if [ "$HOST" = "$PLACEHOLDER_IP" ]; then
  echo "error: no host address is configured." >&2
  echo "" >&2
  echo "  The address is reserved in the router by the container's MAC," >&2
  echo "  so it is only known once the container is provisioned." >&2
  echo "" >&2
  echo "  Pass it explicitly:   ./deploy.sh 192.168.100.xxx" >&2
  echo "  or set it for a run:  VOIDPIXELATR_HOST=192.168.100.xxx ./deploy.sh" >&2
  echo "" >&2
  echo "  The placeholder is ${PLACEHOLDER_IP} (RFC 5737 documentation range)." >&2
  echo "  Deploying to it would be meaningless; refusing." >&2
  exit 1
fi

case "$HOST" in
  *[!0-9.]*|"")
    echo "error: the host address '${HOST}' is not an IP address." >&2
    exit 1
    ;;
esac

if [ ! -f "$KEY" ]; then
  echo "error: the ssh key ${KEY} is missing." >&2
  echo "       Generate it with: ssh-keygen -t ed25519 -f ${KEY} -N ''" >&2
  echo "       and install the public key on the host." >&2
  exit 1
fi

SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes
     -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
     -o ConnectTimeout=8 -o LogLevel=ERROR)
SCP=(scp -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes
     -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
     -o ConnectTimeout=8 -o LogLevel=ERROR)
RSYNC_SSH="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
RSYNC=(rsync -az --delete --chmod=D755,F644
       -e "$RSYNC_SSH"
       --exclude='.git' --exclude='node_modules' --exclude='.next'
       --exclude='dist' --exclude='www' --exclude='__pycache__'
       --exclude='*.pyc' --exclude='.env'
       --exclude='/docs/' --exclude='/tests/' --exclude='/scripts/'
       --exclude='/tools/' --exclude='/ops/' --exclude='*.md'
       --exclude='/serve.sh' --exclude='/deploy.sh')

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# 1. Ship the site files.
say "Uploading site files to ${HOST}:${WEBROOT}"
"${SSH[@]}" "$USER@$HOST" "mkdir -p '$WEBROOT' /var/log/webapps"
"${RSYNC[@]}" --rsync-path="mkdir -p '$WEBROOT' && rsync" \
  "$SCRIPT_DIR/" "$USER@$HOST:$WEBROOT/"

# 2. Install the nginx vhost and the shared security headers.
#    The source files live here, so they are copied across first — `install`
#    runs on the remote box and cannot see local paths.
say "Installing nginx configuration"
"${SSH[@]}" "$USER@$HOST" "install -d -m 755 /etc/nginx/snippets /etc/nginx/sites-available"

"${SCP[@]}" "$REPO_ROOT/ops/nginx-snippets/security-headers.conf" \
  "$USER@$HOST:/tmp/security-headers.conf"
"${SCP[@]}" "$SCRIPT_DIR/ops/nginx/voidpixelatr.conf" \
  "$USER@$HOST:/tmp/voidpixelatr.conf"

"${SSH[@]}" "$USER@$HOST" \
  "sed 's|${PLACEHOLDER_IP//./\\.}|${HOST}|g' /tmp/voidpixelatr.conf > /tmp/voidpixelatr.conf.new && \
   install -m 644 /tmp/security-headers.conf /etc/nginx/snippets/security-headers.conf && \
   install -m 644 /tmp/voidpixelatr.conf.new /etc/nginx/sites-available/voidpixelatr.conf && \
   ln -sf /etc/nginx/sites-available/voidpixelatr.conf /etc/nginx/sites-enabled/voidpixelatr.conf && \
   rm -f /tmp/security-headers.conf /tmp/voidpixelatr.conf /tmp/voidpixelatr.conf.new"

# 3. One container, one site.
#
#    The template the container was cloned from carries its own base landing
#    page, and that vhost is `listen 80 default_server` — exactly like
#    VoidPixelatr's. Two default servers on one port is a hard nginx error:
#
#      [emerg] a duplicate default server for 0.0.0.0:80
#
#    so nginx would refuse to start with the template's site still enabled.
#    Only the *link* is removed, never the file in sites-available, so the
#    template's page is one `ln -sf` away from coming back.
say "Disabling the template's own site"
"${SSH[@]}" "$USER@$HOST" \
  "find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 ! -name 'voidpixelatr.conf' -print -delete"

# 4. Validate and reload. nginx -t runs first, so a broken config never
#    takes the running site down.
say "Validating and reloading nginx"
"${SSH[@]}" "$USER@$HOST" "nginx -t && systemctl reload nginx"

# 5. Smoke test.
say "Smoke test"
for path in / /404.html /css/style.css /js/app.js /js/quantise.js; do
  code="$("${SSH[@]}" "$USER@$HOST" \
    "curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${HOST}' http://127.0.0.1$path")"
  printf '  %-18s %s\n' "$path" "$code"
done

say "Live at http://${HOST}/"
