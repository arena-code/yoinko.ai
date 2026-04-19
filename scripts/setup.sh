#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# yoınko — setup script
# run from an empty folder:  curl -fsSL https://raw.githubusercontent.com/arena-code/yoinko.ai/main/scripts/setup.sh | bash
# or, after cloning:         bash scripts/setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOLD="\033[1m"
CYAN="\033[0;36m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

info()    { echo -e "${CYAN}▸${RESET} $*"; }
success() { echo -e "${GREEN}✔${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
error()   { echo -e "${RED}✖ $*${RESET}" >&2; exit 1; }
header()  { echo -e "\n${BOLD}$*${RESET}\n"; }

# ── 0. Banner ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}"
echo "  ██╗   ██╗ ██████╗ ██╗███╗   ██╗██╗  ██╗ ██████╗ "
echo "  ╚██╗ ██╔╝██╔═══██╗██║████╗  ██║██║ ██╔╝██╔═══██╗"
echo "   ╚████╔╝ ██║   ██║██║██╔██╗ ██║█████╔╝ ██║   ██║"
echo "    ╚██╔╝  ██║   ██║██║██║╚██╗██║██╔═██╗ ██║   ██║"
echo "     ██║   ╚██████╔╝██║██║ ╚████║██║  ██╗╚██████╔╝"
echo "     ╚═╝    ╚═════╝ ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝ "
echo -e "${RESET}"
echo -e "  ${BOLD}yoınko.ai${RESET} — fewer buttons. more yoınking."
echo ""

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
header "Checking prerequisites…"

# Node.js
if ! command -v node &>/dev/null; then
  error "Node.js not found. Install it from https://nodejs.org (v20+ required)"
fi
NODE_VERSION=$(node --version | cut -d. -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 20 ]; then
  error "Node.js v20+ required (found $(node --version)). Visit https://nodejs.org"
fi
success "Node.js $(node --version)"

# npm (ships with Node, always present)
success "npm $(npm --version)"

# git (only needed if cloning)
if ! command -v git &>/dev/null; then
  warn "git not found — skipping clone check"
fi

# ── 2. Clone or use existing repo ─────────────────────────────────────────────
header "Setting up yoınko…"

# Detect if we're already inside the repo
if [ -f "package.json" ] && grep -q '"name": "yoinko"' package.json 2>/dev/null; then
  info "Already inside the yoınko repo — skipping clone"
else
  info "Cloning yoınko.ai…"
  git clone https://github.com/arena-code/yoinko.ai.git yoinko
  cd yoinko
  success "Cloned into ./yoinko/"
fi

# ── 3. Install dependencies ────────────────────────────────────────────────────
header "Installing dependencies…"
npm install --silent
success "Dependencies installed"

# ── 4. Build assets ───────────────────────────────────────────────────────────
header "Building client bundle…"
npm run build:client --silent
npm run build:editor --silent
success "Client bundle ready"

# ── 5. Create data directory ──────────────────────────────────────────────────
mkdir -p data
success "Data directory ready → ./data/"

# ── 6. .env / config hint ─────────────────────────────────────────────────────
header "Configuration"
if [ ! -f ".env" ]; then
  cat > .env <<'ENV'
# yoınko environment — edit this file to set defaults
# All of these can also be changed in-app via Settings ⚙️

# Server port (default: 4567)
PORT=4567

# Optionally seed an LLM provider on first run
# LLM_PROVIDER=openai
# LLM_API_KEY=sk-...
# LLM_MODEL=gpt-4o-mini
# LLM_BASE_URL=
ENV
  success ".env created — open it to pre-configure your LLM"
else
  info ".env already exists — skipping"
fi

# ── 7. Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✔  yoınko is ready!${RESET}"
echo ""
echo -e "  Start the server:"
echo -e "  ${BOLD}npm run dev${RESET}   (hot-reload, dev mode)"
echo -e "  ${BOLD}npm start${RESET}     (production, after npm run build)"
echo ""
echo -e "  Then open ${CYAN}http://localhost:4567${RESET} in your browser."
echo -e "  Configure your LLM via ⚙️ Settings inside the app."
echo ""
