#!/bin/sh
# Install the TagMails agent on macOS or Linux without Homebrew.
#
#   curl -fsSL https://tagmails.com/install.sh | sh
#
# Installs into ~/.local/lib/tagmails and links ~/.local/bin/tagmails.
# Needs Node.js 20+ with npm. Prebuilt binaries cover macOS and Linux on arm64
# and x86_64; elsewhere (or with TAGMAILS_FROM_SOURCE=1) it builds with Rust.
# With Homebrew, prefer: brew install swaymun/tagmails/tagmails
set -eu

VERSION="${TAGMAILS_VERSION:-0.2.0}"
RELEASE_BASE="${TAGMAILS_RELEASE_BASE:-https://github.com/swaymun/homebrew-tagmails/releases/download/v${VERSION}}"
PREFIX="${TAGMAILS_PREFIX:-$HOME/.local/lib/tagmails}"
BIN_DIR="${TAGMAILS_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'tagmails install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=apple-darwin ;;
  Linux) OS=unknown-linux-gnu ;;
  *) fail "TagMails supports macOS and Linux. On Windows, use WSL." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=aarch64 ;;
  x86_64|amd64) ARCH=x86_64 ;;
  *) ARCH="" ;;
esac

command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required: https://nodejs.org (or your package manager)."
command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node.js)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required; found $(node --version)."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  else wget -qO "$2" "$1"
  fi
}

STAGE=""
# Prebuilt binary: no Rust needed.
if [ -z "${TAGMAILS_FROM_SOURCE:-}" ] && [ -n "$ARCH" ]; then
  ASSET="tagmails-${VERSION}-${ARCH}-${OS}.tar.gz"
  say "Downloading TagMails $VERSION for $ARCH-$OS…"
  if fetch "$RELEASE_BASE/$ASSET" "$WORK/agent.tar.gz"; then
    tar -xzf "$WORK/agent.tar.gz" -C "$WORK"
    STAGE="$WORK/tagmails-$VERSION"
  else
    say "No prebuilt download available; building from source instead."
  fi
fi

# Source build: an extracted source tree beside this script, or the source release.
if [ -z "$STAGE" ]; then
  command -v cargo >/dev/null 2>&1 || fail "Rust is required to build from source: curl https://sh.rustup.rs -sSf | sh"
  SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/install.sh" ] && [ -f "$SCRIPT_DIR/../Cargo.toml" ] && [ -d "$SCRIPT_DIR/../agent" ]; then
    SOURCE="$(cd "$SCRIPT_DIR/.." && pwd)"
  else
    fetch "$RELEASE_BASE/tagmails-${VERSION}.tar.gz" "$WORK/source.tar.gz" || fail "Download failed: $RELEASE_BASE"
    tar -xzf "$WORK/source.tar.gz" -C "$WORK"
    SOURCE="$WORK/tagmails-$VERSION"
  fi
  say "Building the agent (this takes a minute the first time)…"
  (cd "$SOURCE" && cargo build --release --locked -p tagmails-daemon --quiet) || fail "cargo build failed."
  STAGE="$WORK/stage"
  mkdir -p "$STAGE/bin" "$STAGE/libexec/tagmails"
  cp "$SOURCE/target/release/tagmails" "$STAGE/bin/"
  cp "$SOURCE"/agent/*.mjs "$SOURCE/agent/package.json" "$SOURCE/agent/package-lock.json" "$STAGE/libexec/tagmails/"
  rm -f "$STAGE"/libexec/tagmails/*.test.mjs
fi

say "Installing into $PREFIX…"
(cd "$STAGE/libexec/tagmails" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent) || fail "npm ci failed."
mkdir -p "$PREFIX/bin" "$PREFIX/libexec" "$BIN_DIR"
rm -rf "$PREFIX/libexec/tagmails.previous"
if [ -d "$PREFIX/libexec/tagmails" ]; then mv "$PREFIX/libexec/tagmails" "$PREFIX/libexec/tagmails.previous"; fi
mv "$STAGE/libexec/tagmails" "$PREFIX/libexec/tagmails"
rm -rf "$PREFIX/libexec/tagmails.previous"
cp "$STAGE/bin/tagmails" "$PREFIX/bin/tagmails.next"
chmod 755 "$PREFIX/bin/tagmails.next"
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
