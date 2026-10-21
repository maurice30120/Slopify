#!/usr/bin/env bash
# Installe Slopify : build du workspace puis exposition de la CLI via un
# symlink dans un répertoire présent sur le PATH.
# Usage : scripts/install.sh [répertoire-bin] (défaut : ~/.local/bin)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_ROOT/apps/cli/dist/src/cli.js"
BIN_DIR="${1:-${SLOPIFY_BIN_DIR:-$HOME/.local/bin}}"
MARKER_BEGIN="# >>> slopify install >>>"
MARKER_END="# <<< slopify install <<<"

rc_file() {
  case "$(basename "${SHELL:-/bin/sh}")" in
    zsh)  echo "$HOME/.zshrc" ;;
    bash) echo "$HOME/.bashrc" ;;
    *)    echo "$HOME/.profile" ;;
  esac
}

remove_block() {
  local file="$1"
  [ -f "$file" ] || return 0
  sed -i.bak "/^${MARKER_BEGIN}$/,/^${MARKER_END}$/d" "$file" && rm -f "$file.bak"
}

echo "==> Build du workspace Slopify"
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  npm --prefix "$REPO_ROOT" install
fi
npm --prefix "$REPO_ROOT" run build

if [ ! -f "$CLI" ]; then
  echo "Erreur : $CLI introuvable après le build." >&2
  exit 1
fi
chmod +x "$CLI"

echo "==> Installation du lien slopify dans $BIN_DIR"
mkdir -p "$BIN_DIR"
ln -sf "$CLI" "$BIN_DIR/slopify"

case ":$PATH:" in
  *":$BIN_DIR:"*) echo "==> $BIN_DIR est déjà sur le PATH" ;;
  *)
    RC="$(rc_file)"
    remove_block "$RC"
    {
      echo ""
      echo "$MARKER_BEGIN"
      echo "export PATH=\"$BIN_DIR:\$PATH\""
      echo "$MARKER_END"
    } >> "$RC"
    echo "==> $BIN_DIR ajouté au PATH via $RC (rechargez votre shell ou : source $RC)"
    ;;
esac

echo "==> OK. Test : slopify --help"
