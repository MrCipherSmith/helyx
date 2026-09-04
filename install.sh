#!/bin/bash
# Helyx — one-line installer
# Usage: curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/helyx/main/install.sh | bash
#
# Install a specific version:
#   HELYX_VERSION=v1.57.0 curl -fsSL ... | bash
# Install to custom directory:
#   HELYX_DIR=~/my-bot curl -fsSL ... | bash
#
# What it does:
# 1. Checks prerequisites (git, bun, docker, claude)
# 2. Clones the repo (or updates if exists)
# 3. Installs dependencies
# 4. Installs 'helyx' CLI globally
# 5. Fresh install: runs the setup wizard.
#    Existing install (.env present): updates code + MCP/hooks only, and
#    prints how to apply it — the wizard never touches a live .env.

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

REPO="https://github.com/MrCipherSmith/helyx.git"
REPO_API="https://api.github.com/repos/MrCipherSmith/helyx"
INSTALL_DIR="${HELYX_DIR:-$HOME/bots/helyx}"
BIN_DIR="${HOME}/.local/bin"

# An existing .env means this is an update, not a fresh install — decided
# before anything below runs so both the version-pull logic and the final
# step can act on it.
UPDATE_MODE=0
[ -f "$INSTALL_DIR/.env" ] && UPDATE_MODE=1

# --- Arguments ---
#
# Anything not consumed here is forwarded to `helyx setup`, so a provisioning
# script can drive the whole install in one call:
#   install.sh --profile minimal --bot-token … --allowed-users … --api-key …

BUILD_LOCAL=0
SETUP_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-local) BUILD_LOCAL=1 ;;
    --help|-h)
      cat <<'USAGE'
Usage: install.sh [--build-local] [setup flags...]

  --build-local   Build the image from source instead of pulling it.

Any other flags are passed to `helyx setup`. Passing --profile makes the
whole install unattended; see `helyx setup --help`.
USAGE
      exit 0
      ;;
    *) SETUP_ARGS+=("$1") ;;
  esac
  shift
done

# Resolve version: explicit > latest release from GitHub API. No silent
# fallback here — a rate-limited or unreachable API used to fall back to
# v1.0.0, the very first tagged release, and the install looked exactly like
# a working one until something from years of changes turned out missing.
if [ -n "$HELYX_VERSION" ]; then
  VERSION="$HELYX_VERSION"
else
  VERSION=$(curl -fsSL "$REPO_API/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  if [ -z "$VERSION" ]; then
    echo -e "${RED}Could not resolve the latest helyx version from the GitHub API.${NC}"
    echo -e "${DIM}Usually a rate limit or a network hiccup, not a broken release.${NC}"
    echo -e "Retry in a moment, or pin a version explicitly:\n"
    echo -e "  ${CYAN}HELYX_VERSION=v1.57.0 curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/helyx/main/install.sh | bash${NC}\n"
    exit 1
  fi
fi

echo -e "\n${BOLD}Helyx Installer${NC}\n"

# --- Check prerequisites ---

check() {
  if command -v "$1" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $1 $(command -v "$1")"
    return 0
  else
    echo -e "  ${RED}✗${NC} $1 not found"
    return 1
  fi
}

echo -e "${BOLD}Checking prerequisites...${NC}"
MISSING=0
check git || MISSING=1
check docker || MISSING=1

if ! check bun; then
  MISSING=1
  echo -e "    ${DIM}Install: curl -fsSL https://bun.sh/install | bash${NC}"
fi

if ! check claude; then
  echo -e "    ${DIM}Install: npm install -g @anthropic-ai/claude-code${NC}"
  echo -e "    ${DIM}Optional — needed only for Claude Code sessions${NC}"
fi

if ! check opencode; then
  echo -e "    ${DIM}Optional — needed for opencode sessions. Setup wizard will install it.${NC}"
fi

if [ "$MISSING" -eq 1 ]; then
  echo -e "\n  ${RED}Install missing dependencies and try again.${NC}\n"
  exit 1
fi

# --- Clone or update ---

echo -e "\n${BOLD}Installing helyx...${NC}"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "  ${CYAN}Updating${NC} existing installation at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || {
    echo -e "  ${DIM}Pull failed (local changes?), skipping update${NC}"
  }
  INSTALLED_VERSION=$(git -C "$INSTALL_DIR" describe --tags --exact-match 2>/dev/null \
    || git -C "$INSTALL_DIR" rev-parse --short HEAD)
  echo -e "  ${GREEN}✓${NC} version $INSTALLED_VERSION"
else
  echo -e "  ${CYAN}Cloning${NC} $VERSION to $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --branch "$VERSION" --depth 1 "$REPO" "$INSTALL_DIR"
  echo -e "  ${GREEN}✓${NC} version $VERSION"
fi

# --- Install dependencies ---

echo -e "  ${CYAN}Installing${NC} dependencies..."
cd "$INSTALL_DIR"
bun install --silent 2>/dev/null || bun install

# --- Install CLI wrapper ---

mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/helyx" << EOF
#!/bin/bash
exec bun --cwd "$INSTALL_DIR" "$INSTALL_DIR/cli.ts" "\$@"
EOF

chmod +x "$BIN_DIR/helyx"

# Ensure ~/.local/bin is in PATH
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  SHELL_RC=""
  [ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"
  [ -f "$HOME/.bashrc" ] && SHELL_RC="${SHELL_RC:-$HOME/.bashrc}"
  if [ -n "$SHELL_RC" ]; then
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
    echo -e "  ${DIM}Added $BIN_DIR to PATH in $SHELL_RC${NC}"
    export PATH="$BIN_DIR:$PATH"
  fi
fi

# --- Pull the published image ---
#
# Building locally is not required: a dashboard-off build fits in 256 MB, so
# almost any host can do it. Pulling is simply faster and needs no toolchain.
# --build-local skips this and lets `docker compose` build from source.

# .github/workflows/publish.yml pushes a version tag alongside `latest` on
# every `vX.Y.Z` push, specifically so a deployment can name what it runs
# instead of whatever `latest` happens to be — pulling `latest` here while the
# checkout sat on an older $VERSION let the two silently diverge.
IMAGE_BASE="ghcr.io/mrciphersmith/helyx"
IMAGE="${IMAGE_BASE}:${VERSION}"

if [ "$BUILD_LOCAL" -eq 0 ]; then
  echo -e "  ${CYAN}Pulling${NC} $IMAGE"
  if docker pull "$IMAGE" >/dev/null 2>&1; then
    docker tag "$IMAGE" helyx-bot:latest
    echo -e "  ${GREEN}✓${NC} image ready (skipping local build)"
  elif [ "$IMAGE" != "${IMAGE_BASE}:latest" ] && docker pull "${IMAGE_BASE}:latest" >/dev/null 2>&1; then
    docker tag "${IMAGE_BASE}:latest" helyx-bot:latest
    echo -e "  ${YELLOW}!${NC} no image published for $VERSION — using :latest instead"
    echo -e "  ${DIM}(code checked out is $VERSION; the image running is whatever :latest currently is)${NC}"
  else
    echo -e "  ${DIM}Pull failed — will build locally instead.${NC}"
    echo -e "  ${DIM}If this is unexpected, the GHCR package may still be private.${NC}"
  fi
fi

# --- Done ---

echo -e "\n${GREEN}${BOLD}Installed!${NC}\n"
echo -e "  CLI:  ${CYAN}helyx${NC} (in $BIN_DIR)"
echo -e "  Repo: $INSTALL_DIR\n"

# Update vs fresh install forks here instead of both falling into
# `helyx setup`: setup() correctly refuses to touch an existing .env, which
# used to mean every update run ended in that refusal (exit 1) instead of
# "updated, here is how to apply it".
if [ "$UPDATE_MODE" -eq 1 ]; then
  echo -e "${BOLD}Already configured — updating code only.${NC}\n"
  if [ ${#SETUP_ARGS[@]} -gt 0 ]; then
    echo -e "  ${DIM}Setup flags ignored: .env already exists, the wizard did not run.${NC}\n"
  fi

  echo -e "  ${CYAN}Syncing${NC} MCP servers and hooks..."
  if helyx mcp-register >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} done"
  else
    echo -e "  ${DIM}skipped (run manually: helyx mcp-register)${NC}"
  fi

  echo -e "\n${GREEN}${BOLD}Updated.${NC}\n"
  echo -e "  New code is on disk but nothing is running it yet. Per CLAUDE.md a"
  echo -e "  change here can reach the container, the host sessions, or both —"
  echo -e "  apply with:\n"
  echo -e "    ${CYAN}helyx full-restart${NC}   rebuild the bot AND bounce sessions (safe default)"
  echo -e "    ${CYAN}helyx restart${NC}        rebuild the bot container only"
  echo -e "    ${CYAN}helyx bounce${NC}         restart sessions only\n"
  exit 0
fi

# Forward any setup flags. With flags the run is unattended and must not be
# given a tty — a provisioning script has no terminal to attach.
if [ ${#SETUP_ARGS[@]} -gt 0 ]; then
  echo -e "${BOLD}Running setup (unattended)...${NC}\n"
  exec helyx setup "${SETUP_ARGS[@]}"
fi

echo -e "${BOLD}Running setup wizard...${NC}\n"
exec helyx setup < /dev/tty
