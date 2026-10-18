#!/usr/bin/env bash
# Surface installer: gets the code and Node in place, then hands off to `surface setup`,
# which installs and configures everything else (packages, web UI, PATH, database, workspace).
#
#   git clone https://github.com/Cody-Design-Build/Surface.git ~/Developer/Surface
#   ~/Developer/Surface/install.sh            # local: this computer's own database, no account
#   ~/Developer/Surface/install.sh --service  # also start the web UI at login
#
# Any flags are passed to `surface setup` (see `surface help`). Safe to re-run; it also updates.
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

if [ -d "$ROOT/.git" ] && [ "${SURFACE_NO_PULL:-}" != 1 ]; then
  say "Updating the code…"
  git -C "$ROOT" pull --ff-only --quiet || say "  (couldn't fast-forward; using the code as it is)"
fi

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

say "Installing the CLI's packages…"
(cd "$ROOT/cli" && npm install --no-fund --no-audit --loglevel=error)

exec node --no-warnings "$ROOT/cli/src/main.ts" setup "$@"
