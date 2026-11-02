#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 6 ]]; then
    printf 'Usage: %s BUNDLE SHA256 RELEASE_ID ENV_FILE APP_DIR SERVICE\n' "$0" >&2
    exit 2
fi

BUNDLE_PATH=$1
EXPECTED_SHA=$2
RELEASE_ID=$3
ENV_FILE=$4
APP_DIR=$5
SERVICE_NAME=$6

[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]]
[[ "$RELEASE_ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
[[ "$APP_DIR" == '/opt/pr6spr-paper-copybot' ]]
[[ "$SERVICE_NAME" == 'pr6spr-paper-copybot.service' ]]
[[ "$BUNDLE_PATH" == /tmp/pr6spr-paper-copybot-* ]]
[[ "$ENV_FILE" == /tmp/pr6spr-paper-copybot-* ]]
[[ -f "$BUNDLE_PATH" && -f "$ENV_FILE" ]]

sudo -n true

NODE_VERSION='24.22.2'
NODE_ROOT="$APP_DIR/tools/node-v$NODE_VERSION-linux-x64"
NODE_BIN="$NODE_ROOT/bin/node"
RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"
SHARED_DIR="$APP_DIR/shared"
DATA_DIR="$SHARED_DIR/data"
SECRETS_DIR="$SHARED_DIR/secrets"
CURRENT_LINK="$APP_DIR/current"
NEXT_LINK="$APP_DIR/.current-$RELEASE_ID"
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME"
STAGING_DIR=$(mktemp -d)
SWITCHED=0
RELEASE_CREATED=0
PREVIOUS_RELEASE=''

cleanup() {
    rm -rf "$STAGING_DIR"
    rm -f "$BUNDLE_PATH" "$ENV_FILE"
}

rollback() {
    local previous_exit=$?
    local exit_code=${1:-$previous_exit}
    local failed_line=${BASH_LINENO[0]:-unknown}
    trap - EXIT ERR
    set +e
    if [[ "$SWITCHED" == 1 && -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
        rm -f "$NEXT_LINK"
        ln -s "$PREVIOUS_RELEASE" "$NEXT_LINK"
        mv -Tf "$NEXT_LINK" "$CURRENT_LINK"
        sudo systemctl restart "$SERVICE_NAME"
    fi
    if [[ "$RELEASE_CREATED" == 1 && "$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)" != "$RELEASE_DIR" ]]; then
        rm -rf -- "$RELEASE_DIR"
    fi
    cleanup
    printf 'Deployment failed near line %s; previous release restored when available.\n' "$failed_line" >&2
    exit "$exit_code"
}

trap cleanup EXIT
trap rollback ERR

if [[ "$(sha256sum "$BUNDLE_PATH" | awk '{print $1}')" != "$EXPECTED_SHA" ]]; then
    printf 'Bundle checksum mismatch.\n' >&2
    exit 1
fi

sudo install -d -o ubuntu -g ubuntu -m 0755 \
    "$APP_DIR" "$APP_DIR/releases" "$APP_DIR/tools" "$SHARED_DIR" "$DATA_DIR"
sudo install -d -o ubuntu -g ubuntu -m 0700 "$SECRETS_DIR"
tar -xzf "$BUNDLE_PATH" -C "$STAGING_DIR"
[[ -f "$STAGING_DIR/package.json" && -f "$STAGING_DIR/package-lock.json" && -f "$STAGING_DIR/src/index.js" ]]

if [[ ! -x "$NODE_BIN" ]]; then
    NODE_FILENAME="node-v$NODE_VERSION-linux-x64.tar.xz"
    NODE_ARCHIVE=$(mktemp)
    NODE_SUMS=$(mktemp)
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_FILENAME" -o "$NODE_ARCHIVE"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$NODE_SUMS"
    NODE_EXPECTED_SHA=$(awk -v filename="$NODE_FILENAME" '$2 == filename {print $1}' "$NODE_SUMS")
    NODE_ACTUAL_SHA=$(sha256sum "$NODE_ARCHIVE" | awk '{print $1}')
    [[ -n "$NODE_EXPECTED_SHA" && "$NODE_EXPECTED_SHA" == "$NODE_ACTUAL_SHA" ]]
    tar -xJf "$NODE_ARCHIVE" -C "$APP_DIR/tools"
    rm -f "$NODE_ARCHIVE" "$NODE_SUMS"
fi
[[ -x "$NODE_BIN" ]]

if [[ -e "$RELEASE_DIR" ]]; then
    printf 'Release already exists: %s\n' "$RELEASE_ID" >&2
    exit 1
fi
cp -a "$STAGING_DIR" "$RELEASE_DIR"
RELEASE_CREATED=1
(
    cd "$RELEASE_DIR"
    PATH="$NODE_ROOT/bin:$PATH" "$NODE_ROOT/bin/npm" ci \
        --omit=dev --ignore-scripts --no-audit --no-fund
)
chown -R ubuntu:ubuntu "$RELEASE_DIR"

grep -Eq '^TRADING_MODE=(paper|live)$' "$ENV_FILE"
if grep -q '^TARGET_WALLETS=' "$ENV_FILE"; then
    grep -Eq '^TARGET_WALLETS=([A-Za-z0-9_-]+:)?[1-9A-HJ-NP-Za-km-z]{32,44}(,([A-Za-z0-9_-]+:)?[1-9A-HJ-NP-Za-km-z]{32,44})*$' "$ENV_FILE"
else
    grep -Eq '^TARGET_WALLET=[1-9A-HJ-NP-Za-km-z]{32,44}$' "$ENV_FILE"
fi
grep -Eq '^RPC_HTTP_URL=https://' "$ENV_FILE"
grep -Eq '^RPC_WS_URL=wss://' "$ENV_FILE"
if grep -q '^RPC_FALLBACK_HTTP_URL=.' "$ENV_FILE"; then
    grep -Eq '^RPC_FALLBACK_HTTP_URL=https://' "$ENV_FILE"
fi
if grep -q '^RPC_FALLBACK_WS_URL=.' "$ENV_FILE"; then
    grep -Eq '^RPC_FALLBACK_WS_URL=wss://' "$ENV_FILE"
fi
grep -Fqx "LOG_FILE=$DATA_DIR/paper-trades.jsonl" "$ENV_FILE"
grep -Fqx "STATE_FILE=$DATA_DIR/paper-state.json" "$ENV_FILE"
grep -Fqx "INGESTION_STATE_FILE=$DATA_DIR/ingestion-state.json" "$ENV_FILE"
grep -Fqx "LIVE_LOG_FILE=$DATA_DIR/live-trades.jsonl" "$ENV_FILE"
grep -Fqx "LIVE_STATE_FILE=$DATA_DIR/live-state.json" "$ENV_FILE"
grep -Fqx "SHADOW_LOG_FILE=$DATA_DIR/shadow-trades.jsonl" "$ENV_FILE"
grep -Fqx "SHADOW_STATE_DIR=$DATA_DIR/shadow-state" "$ENV_FILE"
grep -Fqx "LIVE_KILL_SWITCH_FILE=$DATA_DIR/STOP_LIVE" "$ENV_FILE"
grep -Fqx "LIVE_AUTO_PAUSE_FILE=$DATA_DIR/AUTO_PAUSE_BUYS" "$ENV_FILE"
if grep -Fqx 'TRADING_MODE=live' "$ENV_FILE"; then
    grep -Fqx 'LIVE_CONFIRMATION=I_UNDERSTAND_REAL_FUNDS' "$ENV_FILE"
    grep -Eq '^LIVE_WALLET_FILE=/opt/pr6spr-paper-copybot/shared/secrets/[^/]+\.json$' "$ENV_FILE"
    grep -Fqx "JUPITER_API_KEY_FILE=$SECRETS_DIR/jupiter-api-key" "$ENV_FILE"
    grep -Fqx "TELEGRAM_BOT_TOKEN_FILE=$SECRETS_DIR/telegram-bot-token" "$ENV_FILE"
    [[ -f "$SECRETS_DIR/live-wallet.json" && ! -L "$SECRETS_DIR/live-wallet.json" ]]
    [[ -s "$SECRETS_DIR/jupiter-api-key" && ! -L "$SECRETS_DIR/jupiter-api-key" ]]
    [[ -s "$SECRETS_DIR/telegram-bot-token" && ! -L "$SECRETS_DIR/telegram-bot-token" ]]
fi
sudo install -o ubuntu -g ubuntu -m 0600 "$ENV_FILE" "$SHARED_DIR/bot.env"

PREVIOUS_RELEASE=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
if [[ "$PREVIOUS_RELEASE" == "$CURRENT_LINK" || ! -d "$PREVIOUS_RELEASE" ]]; then
    PREVIOUS_RELEASE=''
fi
rm -f "$NEXT_LINK"
ln -s "$RELEASE_DIR" "$NEXT_LINK"
mv -Tf "$NEXT_LINK" "$CURRENT_LINK"
SWITCHED=1

sudo install -m 0644 "$RELEASE_DIR/deploy/systemd/$SERVICE_NAME" "$UNIT_PATH"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

for attempt in {1..20}; do
    RECENT_LOGS=$(sudo journalctl -u "$SERVICE_NAME" --since "2 minutes ago" --no-pager -o cat)
    if sudo systemctl is-active --quiet "$SERVICE_NAME" && \
       grep -Fq '"event":"subscribed"' <<<"$RECENT_LOGS" && \
       grep -Fq '"event":"backfill_ok"' <<<"$RECENT_LOGS"; then
        break
    fi
    if [[ "$attempt" == 20 ]]; then
        sudo systemctl --no-pager --full status "$SERVICE_NAME" >&2 || true
        sudo journalctl -u "$SERVICE_NAME" -n 80 --no-pager -o cat | cut -c1-2000 >&2 || true
        rollback 1
    fi
    sleep 1
done

mapfile -t OLD_RELEASES < <(
    find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
        sort -nr | tail -n +4 | cut -d' ' -f2-
)
for old_release in "${OLD_RELEASES[@]:-}"; do
    [[ -n "$old_release" && "$old_release" != "$(readlink -f "$CURRENT_LINK")" ]] && rm -rf -- "$old_release"
done

printf 'release=%s\n' "$RELEASE_ID"
printf 'service=active\n'
printf 'subscription=active\n'
printf 'backfill=active\n'
printf 'node=%s\n' "$($NODE_BIN --version)"
