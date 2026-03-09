#!/bin/sh
# Build the Gondolin guest image.
#
# 1. Ensure Claude Code OAuth token + account info is cached
# 2. Docker builds the rootfs image (cached layers for fast rebuilds)
# 3. Gondolin assembles the VM from the OCI image + Alpine kernel/initramfs
cd "$(dirname "$0")"

set -e

# --- Claude Code OAuth setup ---
CACHE_DIR="$HOME/.config/pi-sandbox"
TOKEN_CACHE="$CACHE_DIR/claude-code-token"
ACCOUNT_CACHE="$CACHE_DIR/claude-code-account.json"
HOST_CLAUDE_JSON="$HOME/.claude.json"
mkdir -p "$CACHE_DIR"

if [ ! -s "$TOKEN_CACHE" ]; then
  echo "No cached Claude Code token found."
  echo "Run 'claude setup-token' and paste the token here:"
  printf "> "
  read -r TOKEN
  if [ -z "$TOKEN" ]; then
    echo "Error: no token provided" >&2
    exit 1
  fi
  echo "$TOKEN" > "$TOKEN_CACHE"
  echo "Token cached at $TOKEN_CACHE"
fi

# Cache oauthAccount from host ~/.claude.json (needed to skip login in VM)
if [ ! -s "$ACCOUNT_CACHE" ] && [ -f "$HOST_CLAUDE_JSON" ]; then
  python3 -c "
import json, sys
d = json.load(open('$HOST_CLAUDE_JSON'))
acct = d.get('oauthAccount')
if not acct:
    print('Warning: no oauthAccount in ~/.claude.json', file=sys.stderr)
    sys.exit(0)
json.dump(acct, open('$ACCOUNT_CACHE', 'w'))
print('Account info cached at $ACCOUNT_CACHE')
"
fi

# --- Build guest image ---
BUILD_INFO="Built $(date -u +%Y-%m-%dT%H:%M:%SZ) | $(git -C .. log -1 --format='%h %s')"

docker build --build-arg BUILD_INFO="$BUILD_INFO" -t gondolin-sandbox-base .

gondolin build --config build-config.json --output ./guest-image
