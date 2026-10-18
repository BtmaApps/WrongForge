#!/usr/bin/env bash
# Offline integration test: only release downloads are replaced.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
tmp="$(cd "$tmp" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
mkdir -p "$HOME" "$tmp/elsewhere"
export WRONGFORGE_VERSION=0.0.0 WRONGFORGE_OS=Linux WRONGFORGE_ARCH=x64
export WRONGFORGE_INSTALL_DIR="$HOME/tools with space's/\$bin"
export ZDOTDIR="$HOME/zsh" XDG_CONFIG_HOME="$HOME/config"
mkdir -p "$ZDOTDIR"
printf '# existing bash config\n' > "$HOME/.bashrc"
printf '# existing login config\n' > "$HOME/.bash_profile"
curl() {
  local out=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -o ]; then out="$2"; shift; fi
    shift
  done
  case "$out" in
    */SHA256SUMS.txt) : > "$out" ;;
    *oauth.json.tmp) printf '{"clientId":"test-client-id"}' > "$out" ;;
    *) printf '#!/usr/bin/env bash\nprintf "fixture-version\\n"\n' > "$out" ;;
  esac
}
export -f curl
bash "$ROOT/scripts/install.sh"
test -x "$WRONGFORGE_INSTALL_DIR/wrongforge" || { echo 'FAIL: missing canonical wrongforge command'; exit 1; }
grep -q '"clientId"' "$HOME/.wrongforge/oauth.json" || { echo 'FAIL: oauth.json was not written'; exit 1; }
oauth_before="$(cat "$HOME/.wrongforge/oauth.json")"
for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.bash_profile" "$ZDOTDIR/.zshrc" "$ZDOTDIR/.zprofile"; do
  bash -c 'source "$1"; cd "$2"; test "$(wrongforge version)" = fixture-version' _ "$profile" "$tmp/elsewhere"
done
grep -q '# existing bash config' "$HOME/.bashrc"
grep -q '# existing login config' "$HOME/.bash_profile"
before="$(cat "$HOME/.bashrc")"
bash "$ROOT/scripts/install.sh"
test "$(cat "$HOME/.bashrc")" = "$before" || { echo 'FAIL: duplicate startup entries'; exit 1; }
test -f "$XDG_CONFIG_HOME/fish/conf.d/wrongforge.fish"
test "$(cat "$HOME/.wrongforge/oauth.json")" = "$oauth_before" || { echo 'FAIL: oauth.json rewritten on repeat install'; exit 1; }
# A relative custom destination must stay usable after changing directories.
cd "$tmp"
export WRONGFORGE_INSTALL_DIR='relative tools'
bash "$ROOT/scripts/install.sh"
bash -c 'source "$HOME/.bashrc"; cd "$1"; test "$(command -v wrongforge)" = "$2/wrongforge"; wrongforge version' _ "$tmp/elsewhere" "$tmp/relative tools"
echo 'PASS: Unix canonical command, startup PATH, quoting, existing config, repeat install, relative destination'
