#!/usr/bin/env bash
# Désinstalle Slopify : supprime le symlink du PATH et le bloc export
# correspondant dans le fichier rc du shell. Le build (dist/) est conservé ;
# utilisez `npm run clean` pour le supprimer aussi.
# Usage : scripts/uninstall.sh [répertoire-bin] (défaut : ~/.local/bin)

set -euo pipefail

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

if [ -L "$BIN_DIR/slopify" ] || [ -e "$BIN_DIR/slopify" ]; then
  rm -f "$BIN_DIR/slopify"
  echo "==> Supprimé : $BIN_DIR/slopify"
else
  echo "==> Aucun lien slopify dans $BIN_DIR"
fi

RC="$(rc_file)"
remove_block "$RC"
echo "==> Bloc PATH supprimé de $RC (s'il existait)"

echo "==> OK. slopify n'est plus sur le PATH. dist/ reste présent (npm run clean pour le retirer)."
