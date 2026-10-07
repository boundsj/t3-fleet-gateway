#!/usr/bin/env bash
# Install (or remove) t3-fleet-gateway as a per-user launchd agent on macOS.
#
#   deploy/launchd/install.sh              render the plist and load it
#   deploy/launchd/install.sh --dry-run    print the rendered plist and exit
#   deploy/launchd/install.sh --uninstall  unload the agent and remove its plist
#
# Every path can be overridden with an environment variable; defaults are shown below.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LABEL="${LABEL:-local.t3-fleet-gateway}"
REPO_DIR="${REPO_DIR:-$(cd "$script_dir/../.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
T3_BIN="${T3_BIN:-$(command -v t3 || true)}"
CONFIG_PATH="${CONFIG_PATH:-$HOME/.config/t3-fleet-gateway/config.json}"
DATA_DIR="${DATA_DIR:-$HOME/.local/share/t3-fleet-gateway}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/t3-fleet-gateway}"
PLIST_DIR="${PLIST_DIR:-$HOME/Library/LaunchAgents}"
plist_path="$PLIST_DIR/$LABEL.plist"
domain="gui/$(id -u)"

die() { echo "install.sh: $*" >&2; exit 1; }

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

# Escape a value for use as a sed replacement with | as the delimiter.
sed_value() { xml_escape "$1" | sed -e 's/[|&\\]/\\&/g'; }

render() {
  local path_value="/usr/bin:/bin:/usr/sbin:/sbin"
  [[ -n "$T3_BIN" ]] && path_value="$(dirname "$T3_BIN"):$path_value"
  path_value="$(dirname "$NODE_BIN"):$path_value"
  sed \
    -e "s|__LABEL__|$(sed_value "$LABEL")|g" \
    -e "s|__NODE_BIN__|$(sed_value "$NODE_BIN")|g" \
    -e "s|__REPO_DIR__|$(sed_value "$REPO_DIR")|g" \
    -e "s|__CONFIG_PATH__|$(sed_value "$CONFIG_PATH")|g" \
    -e "s|__DATA_DIR__|$(sed_value "$DATA_DIR")|g" \
    -e "s|__LOG_DIR__|$(sed_value "$LOG_DIR")|g" \
    -e "s|__PATH__|$(sed_value "$path_value")|g" \
    "$script_dir/t3-fleet-gateway.plist.template"
}

case "${1:-}" in
  --uninstall)
    launchctl bootout "$domain/$LABEL" 2>/dev/null || true
    rm -f "$plist_path"
    echo "Removed $LABEL. Config, data and logs are left in place."
    exit 0
    ;;
  --dry-run | "") ;;
  *) die "unknown option $1 (use --dry-run or --uninstall)" ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || die "launchd is macOS only; see deploy/systemd for Linux"
[[ -x "$NODE_BIN" ]] || die "node not found; set NODE_BIN"
node_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
(( node_major >= 24 )) || die "Node.js 24 or newer is required (found $node_major)"
[[ -f "$REPO_DIR/bin/t3-fleet-gateway.js" ]] || die "no gateway checkout at $REPO_DIR; set REPO_DIR"
[[ -n "$T3_BIN" ]] || echo "install.sh: warning: t3 not found on PATH; set T3_BIN if your pairing command uses it" >&2

if [[ "${1:-}" == "--dry-run" ]]; then
  render
  exit 0
fi

[[ -f "$CONFIG_PATH" ]] || die "no config at $CONFIG_PATH; copy config.example.json there first"
mkdir -p "$PLIST_DIR" "$LOG_DIR"
chmod 700 "$LOG_DIR"
render >"$plist_path"
plutil -lint "$plist_path" >/dev/null
launchctl bootout "$domain/$LABEL" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist_path"
echo "Loaded $LABEL from $plist_path"
echo "Logs: $LOG_DIR/gateway.log   Check: $NODE_BIN $REPO_DIR/bin/t3-fleet-gateway.js doctor"
