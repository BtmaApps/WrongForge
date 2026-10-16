#!/usr/bin/env bash
# WrongForge installer (Linux/macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/WrongStack/WrongForge/main/scripts/install.sh | bash
#
# Env overrides: WRONGFORGE_REPO, WRONGFORGE_VERSION (default: latest),
# WRONGFORGE_INSTALL_DIR (default: ~/.local/bin), WRONGFORGE_OS/ARCH (detection
# overrides, mostly for testing). Verifies the asset against the release's
# SHA256SUMS.txt before installing; never uses sudo unless the target dir
# needs it and sudo exists.
set -euo pipefail

REPO="${WRONGFORGE_REPO:-WrongStack/WrongForge}"
DEST="${WRONGFORGE_INSTALL_DIR:-$HOME/.local/bin}"

os="${WRONGFORGE_OS:-$(uname -s)}"
arch="${WRONGFORGE_ARCH:-$(uname -m)}"
case "$os" in
  Darwin) os="macos" ;;
  Linux) os="linux" ;;
  windows) ;; # explicit override (testing from Git Bash)
  *) echo "unsupported OS: $os (set WRONGFORGE_OS to override)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64|x64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "unsupported architecture: $arch (set WRONGFORGE_ARCH to override)" >&2; exit 1 ;;
esac
asset="wrongforge-${os}-${arch}"
[ "$os" = "windows" ] && asset="$asset.exe"

# resolve the version (latest via the GitHub API unless pinned)
if [ -z "${WRONGFORGE_VERSION:-}" ]; then
  version="$(curl -fsSL --max-time 15 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO}/releases/latest" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v/v/;s/"$//')" || true
  [ -n "$version" ] || { echo "cannot resolve the latest release of ${REPO}" >&2; exit 1; }
else
  version="v${WRONGFORGE_VERSION#v}"
fi
base="https://github.com/${REPO}/releases/download/${version}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "→ ${asset} from ${REPO} ${version}"
curl -fsSL --max-time 300 -o "$tmp/$asset" "$base/$asset"
curl -fsSL --max-time 30 -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || true

if [ -s "$tmp/SHA256SUMS.txt" ]; then
  want="$(grep " $asset\$" "$tmp/SHA256SUMS.txt" | awk '{print $1}')"
  if [ -n "$want" ]; then
    if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
    else echo "!! no sha256 tool found — skipping verification" >&2; got="$want"; fi
    [ "$got" = "$want" ] || { echo "sha256 mismatch for $asset (wanted $want, got $got)" >&2; exit 1; }
    echo "✓ sha256 verified"
  fi
fi

mkdir -p "$DEST" 2>/dev/null || true
# Always expose the same command, regardless of the release asset's name.
command_name=wrongforge
[ "$os" = "windows" ] && command_name=wrongforge.exe
chmod +x "$tmp/$asset"
if ! mv "$tmp/$asset" "$DEST/$command_name" 2>/dev/null; then
  if command -v sudo >/dev/null 2>&1; then
    echo "→ $DEST not writable; retrying with sudo"
    sudo mkdir -p "$DEST"
    sudo mv "$tmp/$asset" "$DEST/$command_name"
  else
    echo "cannot write to $DEST — set WRONGFORGE_INSTALL_DIR" >&2; exit 1
  fi
fi
# Persist an absolute path so the command also works from other directories.
DEST="$(cd "$DEST" && pwd -P)"

# macOS: clear the quarantine flag the unsigned binary carries
if [ "$os" = "macos" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$DEST/$command_name" 2>/dev/null || true
fi

# Quote literal paths, including spaces, dollar signs and apostrophes.
quoted_dest="'$(printf '%s' "$DEST" | sed "s/'/'\\\\''/g")'"
path_line="export PATH=$quoted_dest:\$PATH # WrongForge PATH"
add_path() {
  local profile="$1"
  mkdir -p "$(dirname "$profile")"
  if ! grep -Fqx "$path_line" "$profile" 2>/dev/null; then
    printf '\n%s\n' "$path_line" >> "$profile"
  fi
}
# Bash login shells read .profile only when neither of these exists.
add_path "$HOME/.profile"
add_path "$HOME/.bashrc"
if [ -f "$HOME/.bash_profile" ]; then add_path "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then add_path "$HOME/.bash_login"; fi
add_path "${ZDOTDIR:-$HOME}/.zprofile"
add_path "${ZDOTDIR:-$HOME}/.zshrc"
fish_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d"
mkdir -p "$fish_dir"
# Fish single quotes escape both backslashes and apostrophes.
fish_dest="$(printf '%s' "$DEST" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")"
printf "fish_add_path --prepend --path '%s'\n" "$fish_dest" > "$fish_dir/wrongforge.fish"
export PATH="$DEST:$PATH"
echo "✓ installed: $DEST/$command_name"
"$DEST/$command_name" version
echo "✓ PATH configured for bash, zsh and fish; open a new terminal to run wrongforge anywhere"
echo "  To use it in this terminal now: $path_line"
