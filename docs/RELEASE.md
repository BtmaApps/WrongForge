# Releases

WrongForge ships as a **single-file executable** — no npm install, no Node on
the target machine. The webui dashboard and the default prompt guides are
embedded in the binary; everything else (tasks, sessions, logs, tokens) lives
in `~/.wrongforge` as before.

## Build locally

```bash
npm run build:binary        # needs bun on PATH (or BUN=/path/to/bun)
release/wrongforge-windows-x64.exe version
release/wrongforge-windows-x64.exe serve
```

What it does: `webui:build` → regenerate `src/embedded-webui.ts` from dist +
`prompts/` → `bun build --compile src/main.ts`. The checked-in
`src/embedded-webui.ts` is a stub (empty maps) so a source checkout keeps
typechecking; the build overwrites it — do not commit the generated copy.

## Release on GitHub

```bash
npm version patch          # or minor / major
git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/release.yml`: Windows + Linux
builds, sha256 checksums, assets attached to a GitHub Release
(`WrongStack/WrongForge`). Asset names are the contract `wrongforge update`
downloads — `wrongforge-<os>-<arch>[.exe]` (see `scripts/build-binary.mjs`).

## One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/WrongStack/WrongForge/main/scripts/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/WrongStack/WrongForge/main/scripts/install.ps1 | iex
```

Both verify the download against the release's SHA256SUMS.txt. Env overrides
for install.sh: `WRONGFORGE_REPO`, `WRONGFORGE_VERSION`, `WRONGFORGE_INSTALL_DIR`
(default `~/.local/bin`); install.ps1: `-Version`, `-Repo`, `-InstallDir`
(default `%LOCALAPPDATA%\Programs\WrongForge`, added to the user and current
PowerShell PATH). Both installers expose `wrongforge` regardless of the asset
name. Unix installs `~/.local/bin/wrongforge` and adds its absolute directory
to bash, zsh and fish startup files. Open a new terminal on Unix or use the
printed export command in bash/zsh. Existing unrelated terminals may need
restarting on Windows. Custom install directories are supported, including
paths containing spaces.

## Binary commands

| Command | Meaning |
|---|---|
| `wrongforge serve` | the HTTP API + dashboard (what `npm run serve` was) |
| `wrongforge update` | download the newest release asset for this platform, verify its sha256 digest, swap it in place of the running executable, restart with the same arguments |
| `wrongforge version` | version + repo |
| `wrongforge models` / `import` / `login` / `status` / `url` / (chat) | the source-mode commands, unchanged |

## Update checks

`serve` checks `github.com/<WRONGFORGE_UPDATE_REPO>/releases/latest` at
startup and daily (off with `WRONGFORGE_UPDATE_CHECK=0`; `WRONGFORGE_UPDATE_REPO`
overrides the repo). A newer release shows in the serve banner, the log
(`update.available`), `/v1/info` → `update`, and as a red chip in the
dashboard's top bar.

The swap: download → sha256 verify against the release digest → rename the
running exe to `<exe>.old.<pid>` (allowed on Windows) → move the new one in →
respawn with the same argv → exit. The rollback copy is pid-owned, so a
concurrent update never deletes another instance's copy; copies whose owning
process is gone are cleaned up on the next start. A release that publishes no
sha256 digest for the asset is **not installed** — the update fails closed
rather than installing unverified bytes. If the digest does not match, nothing
is installed either.

## macOS note

The macOS binaries are **unsigned** — Gatekeeper quarantines them on first
run. Clear it once with:

```bash
xattr -d com.apple.quarantine wrongforge-macos-*
```

(or right-click → Open the first time). Code signing would require an Apple
Developer ID; it is not part of this workflow.
