#!/bin/bash
# Claude Code Statusline Automatic Installation Script
# Usage: curl -fsSL <url> | bash
# Or: bash install-statusline.sh

set -e  # Exit immediately if any command fails

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
  echo -e "${RED}✗${NC} $1"
}

# Print header
echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║     BitYoungjae Claude Code Statusline         ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# 1. Check and create directory
CLAUDE_DIR="$HOME/.claude"
STATUSLINE_PATH="$CLAUDE_DIR/statusline.sh"
SETTINGS_PATH="$CLAUDE_DIR/settings.json"

if [ ! -d "$CLAUDE_DIR" ]; then
  mkdir -p "$CLAUDE_DIR"
  log_success "Created installation directory"
else
  log_success "Verified installation directory"
fi

# 2. Check dependencies (jq)
if ! command -v jq >/dev/null 2>&1; then
  log_error "jq is not installed."
  echo ""
  echo "How to install jq:"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "  macOS: brew install jq"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "  Ubuntu/Debian: sudo apt-get install jq"
    echo "  CentOS/RHEL: sudo yum install jq"
    echo "  Arch: sudo pacman -S jq"
  fi
  echo ""
  read -p "Continue after installing jq? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_warning "Installation cancelled."
    exit 1
  fi

  # Re-check
  if ! command -v jq >/dev/null 2>&1; then
    log_error "jq is still not installed. Aborting installation."
    exit 1
  fi
fi

log_success "Verified dependencies"

# 3. Backup existing files
BACKUP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/byj-cc-statusline/backups/$(date +%Y%m%d_%H%M%S)"

if [ -f "$STATUSLINE_PATH" ] || [ -f "$SETTINGS_PATH" ]; then
  log_warning "Existing files detected."
  echo ""
  echo "Existing files:"
  [ -f "$STATUSLINE_PATH" ] && echo "  - statusline.sh"
  [ -f "$SETTINGS_PATH" ] && echo "  - settings.json"
  echo ""
  read -p "Backup and overwrite? (Y/n) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Nn]$ ]]; then
    log_warning "Installation cancelled."
    exit 0
  fi

  # Create backup
  mkdir -p "$BACKUP_DIR"
  [ -f "$STATUSLINE_PATH" ] && cp "$STATUSLINE_PATH" "$BACKUP_DIR/statusline.sh"
  [ -f "$SETTINGS_PATH" ] && cp "$SETTINGS_PATH" "$BACKUP_DIR/settings.json"
  log_success "Backup completed: $BACKUP_DIR"
fi

# 4. Copy statusline.sh file
# Check for STATUSLINE_SOURCE env var first (for remote install), then local path
if [ -n "$STATUSLINE_SOURCE" ] && [ -f "$STATUSLINE_SOURCE" ]; then
  SOURCE_STATUSLINE="$STATUSLINE_SOURCE"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SOURCE_STATUSLINE="$SCRIPT_DIR/bin/statusline.sh"
fi

# Check if source file exists
if [ ! -f "$SOURCE_STATUSLINE" ]; then
  log_error "Source file not found: $SOURCE_STATUSLINE"
  echo ""
  echo "Installation methods:"
  echo "  1. Clone and run: git clone ... && bash install-statusline.sh"
  echo "  2. Remote install (no clone):"
  echo "     curl -fsSL https://raw.githubusercontent.com/bityoungjae/byj-cc-statusline/main/install-statusline.sh -o /tmp/install.sh && \\"
  echo "     curl -fsSL https://raw.githubusercontent.com/bityoungjae/byj-cc-statusline/main/bin/statusline.sh -o /tmp/statusline.sh && \\"
  echo "     STATUSLINE_SOURCE=/tmp/statusline.sh bash /tmp/install.sh"
  exit 1
fi

# Copy statusline.sh
cp "$SOURCE_STATUSLINE" "$STATUSLINE_PATH"
chmod +x "$STATUSLINE_PATH"
log_success "Installed statusline.sh"

# 5. Update or create settings.json
if [ -f "$SETTINGS_PATH" ]; then
  # If settings.json exists
  # Update only the statusLine section using jq
  TEMP_SETTINGS=$(mktemp)

  jq '.statusLine = {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 0
  }' "$SETTINGS_PATH" > "$TEMP_SETTINGS"

  mv "$TEMP_SETTINGS" "$SETTINGS_PATH"
  log_success "Updated settings.json"
else
  # Create new settings.json if it doesn't exist
  cat > "$SETTINGS_PATH" << 'EOF'
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 0
  }
}
EOF
  log_success "Created settings.json"
fi

# 6. Installation complete
echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║       Installation completed! 🎉                ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

if [ -d "$BACKUP_DIR" ]; then
  log_info "If you encounter any issues, you can restore from the backup:"
  echo -e "  ${YELLOW}cp $BACKUP_DIR/* $CLAUDE_DIR/${NC}"
  echo ""
fi

log_success "Restart Claude Code to apply the new statusline!"
echo ""
