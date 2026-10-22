#!/usr/bin/env bash
# Surface installer: gets the code and Node in place, then hands off to `surface setup`,
# which installs and configures everything else (packages, web UI, PATH, database, workspace).
#
#   git clone https://github.com/Cody-Design-Build/Surface.git ~/Developer/Surface
#   ~/Developer/Surface/install.sh            # local: this computer's own database, no account
#   ~/Developer/Surface/install.sh --service  # also start the web UI at login
#
# Any flags are passed to `surface setup`. Existing installations update only with `surface update`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEED_MAJOR=23 NEED_MINOR=6

say() { printf '%s\n' "$*"; }
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v; v="$(node -p 'process.versions.node')"
  local maj="${v%%.*}" rest="${v#*.}"; local min="${rest%%.*}"
  [ "$maj" -gt "$NEED_MAJOR" ] || { [ "$maj" -eq "$NEED_MAJOR" ] && [ "$min" -ge "$NEED_MINOR" ]; }
}


if ! node_ok; then
  say "Surface needs Node $NEED_MAJOR.$NEED_MINOR or newer (found: $(node -v 2>/dev/null || echo none))."
  if command -v fnm >/dev/null 2>&1; then
    fnm install 24 && eval "$(fnm env)" && fnm use 24
  elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install 24 && nvm use 24
  elif command -v mise >/dev/null 2>&1; then
    mise use -g node@24 && eval "$(mise env -s bash)"
  elif [ "$(uname)" = Darwin ] && command -v brew >/dev/null 2>&1; then
    brew install node
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --needed --noconfirm nodejs npm
  else
    say "Installing Node 24 with fnm (no sudo; into ~/.local/share/fnm)…"
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
    export PATH="$HOME/.local/share/fnm:$PATH"
    eval "$(fnm env)" && fnm install 24 && fnm use 24
    say "  Add fnm to your shell so new terminals find Node: https://github.com/Schniz/fnm#shell-setup"
  fi
  node_ok || { say "Node is still too old. Install Node 24 from https://nodejs.org and re-run."; exit 1; }
fi
say "Node $(node -v)"

CONFIG="${SURFACE_CONFIG_DIR:-$HOME/.config/surface-cli}"
ACTIVE="$CONFIG/runtime/current"
if [ -f "$ACTIVE/cli/src/main.ts" ]; then
  node --no-warnings "$ACTIVE/cli/src/main.ts" update
  exec node --no-warnings "$ACTIVE/cli/src/main.ts" setup "$@"
fi

# A pre-stable-path installation must be stopped explicitly before bootstrap migration.
node --input-type=module - "$CONFIG" <<'NODE'
import fs from "node:fs";
let pid;
try { pid = JSON.parse(fs.readFileSync(process.argv[2] + "/serve.json","utf8")).pid; } catch {}
if (Number.isInteger(pid) && pid > 0) {
  let alive = true;
  try { process.kill(pid,0); } catch (error) { if (error.code === "ESRCH") alive = false; }
  if (alive) throw new Error("Stop the existing Surface server before migrating, or use its surface update command.");
}
NODE

# Bootstrap dependencies only to reuse the CLI's exact stable-tag resolver.
# The development checkout itself is never pulled, reset or checked out.
say "Preparing release discovery…"
(cd "$ROOT/cli" && npm ci --no-fund --no-audit --loglevel=error)
read -r TAG COMMIT VERSION < <(node --no-warnings --input-type=module - "$ROOT" <<'NODE'
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
const root = process.argv[2];
const {latestRelease} = await import(pathToFileURL(root + "/cli/src/update.ts").href);
const refs = execFileSync("git",["ls-remote","--tags","origin"],{cwd:root,encoding:"utf8",timeout:60000,env:{...process.env,GIT_TERMINAL_PROMPT:"0",GCM_INTERACTIVE:"never"}});
const release = latestRelease(refs);
console.log(release.tag,release.commit,release.version);
NODE
)
[ -n "${TAG:-}" ] || { say "No stable release could be resolved from origin."; exit 1; }
mkdir -p "$CONFIG/runtime/releases"
RELEASE="$(mktemp -d "$CONFIG/runtime/releases/$VERSION-${COMMIT:0:12}-XXXXXX")"
trap 'rm -rf "$RELEASE"' EXIT
ORIGIN="$(git -C "$ROOT" remote get-url origin)"
case "$ORIGIN" in /*|*:* ) ;; *) ORIGIN="$ROOT/$ORIGIN";; esac
say "Installing published release $TAG…"
git clone --no-checkout --no-hardlinks --no-tags -- "$ORIGIN" "$RELEASE"
git -C "$RELEASE" fetch --no-tags origin "refs/tags/$TAG"
git -C "$RELEASE" checkout --detach FETCH_HEAD
[ "$(git -C "$RELEASE" rev-parse HEAD)" = "$COMMIT" ] || { say "Release tag moved; installation cancelled."; exit 1; }
(cd "$RELEASE/cli" && npm ci --no-fund --no-audit --loglevel=error)
# setup activates the stable path only after its packages and web build succeed.
# Retain a failed setup once activated; its data or service may already refer to it.
trap 'if [ ! -L "$ACTIVE" ] || [ "$(readlink "$ACTIVE")" != "$RELEASE" ]; then rm -rf "$RELEASE"; fi' EXIT
node --no-warnings "$RELEASE/cli/src/main.ts" setup "$@"
