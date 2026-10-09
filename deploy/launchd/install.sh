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

# launchctl bootout returns before launchd has finished removing the service, and a bootstrap in
# that window fails with "Bootstrap failed: 5: Input/output error". Wait (up to about 10 s) until
# launchd no longer knows the label: `launchctl print` exits 113 ("Could not find service"). Any
# other failure says nothing about the service, so it is reported rather than taken as unloaded.
wait_until_unloaded() {
  local tries status
  for ((tries = 0; tries < 50; tries++)); do
    status=0
    launchctl print "$domain/$LABEL" >/dev/null 2>&1 || status=$?
    case "$status" in
      0) sleep 0.2 ;;
      113) return 0 ;;
      *)
        echo "install.sh: warning: launchctl print $domain/$LABEL failed with exit $status (not 113, \"service not found\"), so whether $LABEL is still loaded is unknown" >&2
        return 1
        ;;
    esac
  done
  echo "install.sh: warning: $LABEL is still loaded after 10 s (launchctl print still finds it)" >&2
  return 1
}

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
    wait_until_unloaded || die "$LABEL did not unload; check: launchctl print $domain/$LABEL"
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
# T3 installs each version in its own directory (~/.t3/runtime/versions/<version>/). A service PATH holding
# one of them keeps running that version's `t3` after T3 updates itself, and loses it if the directory goes.
if [[ "$T3_BIN" == */runtime/versions/* ]]; then
  echo "install.sh: warning: T3_BIN ($T3_BIN) is inside one T3 version's directory. After T3 updates itself the" \
    "service keeps running that old t3 to renew its T3 credential, and renewal fails if the directory is removed." \
    "Set T3_BIN to a t3 that follows T3's updates (see docs/operations.md, \"A t3 that follows T3's updates\")." >&2
fi

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
wait_until_unloaded || true
if ! launchctl bootstrap "$domain" "$plist_path"; then
  echo "install.sh: bootstrap failed; waiting for launchd and retrying once" >&2
  sleep 1
  wait_until_unloaded || true
  launchctl bootstrap "$domain" "$plist_path"
fi
echo "Loaded $LABEL from $plist_path"
echo "Logs: $LOG_DIR/gateway.log   Check: $NODE_BIN $REPO_DIR/bin/t3-fleet-gateway.js doctor"
