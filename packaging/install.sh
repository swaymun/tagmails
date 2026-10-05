#!/bin/sh
# Install the TagMails agent on macOS or Linux without Homebrew.
#
#   curl -fsSL https://tagmails.com/install.sh | sh
#
# Builds from source into ~/.local/lib/tagmails and links ~/.local/bin/tagmails.
# Needs Node.js 20+ (with npm) and Rust (cargo). With Homebrew, prefer:
#   brew install swaymun/tagmails/tagmails
set -eu

VERSION="${TAGMAILS_VERSION:-0.2.0}"
SOURCE_URL="${TAGMAILS_SOURCE_URL:-https://github.com/swaymun/homebrew-tagmails/releases/download/v${VERSION}/tagmails-${VERSION}.tar.gz}"
PREFIX="${TAGMAILS_PREFIX:-$HOME/.local/lib/tagmails}"
BIN_DIR="${TAGMAILS_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'tagmails install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) fail "TagMails supports macOS and Linux. On Windows, use WSL." ;;
esac

command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required: https://nodejs.org (or your package manager)."
command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node.js)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required; found $(node --version)."
command -v cargo >/dev/null 2>&1 || fail "Rust is required to build the agent: curl https://sh.rustup.rs -sSf | sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

# Use an extracted source tree when the script runs from one; otherwise download.
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/install.sh" ] && [ -f "$SCRIPT_DIR/../Cargo.toml" ] && [ -d "$SCRIPT_DIR/../agent" ]; then
  SOURCE="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  say "Downloading TagMails $VERSION…"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$SOURCE_URL" -o "$WORK/source.tar.gz" || fail "Download failed: $SOURCE_URL"
  else
    wget -qO "$WORK/source.tar.gz" "$SOURCE_URL" || fail "Download failed: $SOURCE_URL"
  fi
  tar -xzf "$WORK/source.tar.gz" -C "$WORK"
  SOURCE="$WORK/tagmails-$VERSION"
fi

say "Building the agent (this takes a minute the first time)…"
(cd "$SOURCE" && cargo build --release --locked -p tagmails-daemon --quiet) || fail "cargo build failed."

say "Installing into $PREFIX…"
mkdir -p "$PREFIX/bin" "$PREFIX/libexec/tagmails" "$BIN_DIR"
rm -rf "$PREFIX/libexec/tagmails.next"
mkdir -p "$PREFIX/libexec/tagmails.next"
cp "$SOURCE"/agent/*.mjs "$SOURCE/agent/package.json" "$SOURCE/agent/package-lock.json" "$PREFIX/libexec/tagmails.next/"
rm -f "$PREFIX"/libexec/tagmails.next/*.test.mjs
(cd "$PREFIX/libexec/tagmails.next" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent) || fail "npm ci failed."
rm -rf "$PREFIX/libexec/tagmails"
mv "$PREFIX/libexec/tagmails.next" "$PREFIX/libexec/tagmails"
cp "$SOURCE/target/release/tagmails" "$PREFIX/bin/tagmails.next"
mv "$PREFIX/bin/tagmails.next" "$PREFIX/bin/tagmails"
ln -sf "$PREFIX/bin/tagmails" "$BIN_DIR/tagmails"

say ""
say "Installed $("$PREFIX/bin/tagmails" --version)."
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add $BIN_DIR to your PATH, for example: echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile" ;;
esac
say "Next: create a pairing code at https://tagmails.com/setup, then run"
say "  tagmails pair <code>"
say "  tagmails start"
