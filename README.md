# byj-cc-statusline

> **byj** = **B**it**Y**oung**J**ae

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT) ![Shell](https://img.shields.io/badge/shell-bash-green.svg)

## 📊 Overview

A curated statusline for Claude Code (CC) - showing only the essentials. Displays context usage like a car's fuel gauge, helping you track how close you are to the autocompact threshold.

```
🤖 Sonnet 4.5 | 📁 my-project | 🌿 main ✓ | ⛽ 36% (57K)
```

## 📖 What Each Part Shows

### 🤖 Model Name

Shows the current Claude model you're using.

```
🤖 Sonnet 4.5
```

### 📁 Directory

Current working directory name (not full path, just the folder name).

```
📁 my-project
```

### 🌿 Git Status

Git branch name with status indicators:

| Symbol | Meaning                   | Example            |
| ------ | ------------------------- | ------------------ |
| ✓      | Clean - no changes        | `🌿 main ✓`        |
| 🔴     | Modified files (unstaged) | `🌿 main 🔴`       |
| 🟢     | Staged files              | `🌿 main 🟢`       |
| 🟡     | Untracked files           | `🌿 main 🟡`       |

Symbols can combine: `🌿 main 🔴🟢` = modified + staged files

### ⛽ Fuel Gauge

Shows remaining safe context before autocompact triggers.

**Format:** `⛽ XX% (XXK)` where:

- **XX%** = Percentage of safe space remaining
- **(XXK)** = Actual token count remaining

**Color coding:**

- 🟢 Green (≥70%): Safe - plenty of space
- 🟡 Yellow (30-70%): Caution - moderate usage
- 🔴 Red (<30%): Warning - autocompact imminent

**Example:** `⛽ 36% (57K)` means:

- 36% of safe space left (out of 155K safe limit)
- 57,000 tokens remaining before autocompact

## 🚀 Installation

### Recommended: Clone and install

```bash
git clone https://github.com/BitYoungjae/byj-cc-statusline.git
cd byj-cc-statusline
bash install-statusline.sh
```

The installer will:

- ✅ Check dependencies (jq)
- ✅ Backup existing configuration to `~/.local/share/byj-cc-statusline/backups/`
- ✅ Copy `bin/statusline.sh` to `~/.claude/`
- ✅ Update `~/.claude/settings.json`

### Alternative: One-liner download and install

```bash
curl -fsSL https://github.com/BitYoungjae/byj-cc-statusline/archive/main.tar.gz | tar -xz && \
cd byj-cc-statusline-main && \
bash install-statusline.sh
```

### Manual install

```bash
# 1. Copy statusline script
cp bin/statusline.sh ~/.claude/
chmod +x ~/.claude/statusline.sh

# 2. Update settings.json
# Add to ~/.claude/settings.json:
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 0
  }
}

# 3. Restart Claude Code
```

## 📋 Requirements

- **Claude Code** v2.0+
- **jq** - JSON parser

Install jq:

```bash
# macOS
brew install jq

# Linux
sudo apt install jq  # Ubuntu/Debian
sudo yum install jq  # CentOS/RHEL
```

## ⚙️ How the Fuel Gauge Works

Claude Code auto-compacts old messages when context exceeds **155K tokens** (200K total - 45K buffer).

**Calculation example:**

```
Total context:     200,000 tokens
Autocompact buffer: 45,000 tokens (22.5%)
─────────────────────────────────────────
Safe limit:        155,000 tokens

Current usage:      97,830 tokens
Remaining fuel:     57,170 tokens → ⛽ 36%
```

The percentage shows how much safe space you have left before autocompact triggers.

## 📁 Project Structure

```
byj-cc-statusline/
├── README.md                  # This file
├── LICENSE                    # MIT License
├── .gitignore                 # Git ignore rules
├── install-statusline.sh      # Automated installer
└── bin/
    └── statusline.sh          # Core statusline script
```

## 🛠️ Troubleshooting

**Statusline not working?**
- Ensure jq is installed: `which jq`
- Restart Claude Code

**Fuel gauge shows nothing?**
- Start a conversation first (requires usage data)

## 🔄 Updates

```bash
cd byj-cc-statusline
git pull
bash install-statusline.sh
```

Your existing settings will be automatically backed up to:
`~/.local/share/byj-cc-statusline/backups/`

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Links

- Repository: [https://github.com/BitYoungjae/byj-cc-statusline](https://github.com/BitYoungjae/byj-cc-statusline)
- Issues: [https://github.com/BitYoungjae/byj-cc-statusline/issues](https://github.com/BitYoungjae/byj-cc-statusline/issues)
