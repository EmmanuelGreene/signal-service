#!/bin/bash
set -e
# Push signal-service to GitHub
# Uses the existing gh auth from /opt/data/.config/gh/hosts.yml

cd /opt/data/crypto-signals

# Get token
TOKEN=$(python3 -c "
import re
text = open('/opt/data/.config/gh/hosts.yml').read()
m = re.findall(r'oauth_token:\s*(\S+)', text)
print(m[-1])
")

export PATH="/opt/data/tools/gh_2.92.0_linux_amd64/bin:$PATH"

# Init git if needed
if [ ! -d .git ]; then
  git init
  git config user.email "emmanuel@users.noreply.github.com"
  git config user.name "EmmanuelGreene"
fi

# Set remote with token in URL (GitHub allows oauth2:TOKEN@ format)
git remote set-url origin "https://oauth2:${TOKEN}@github.com/EmmanuelGreene/signal-service.git" 2>/dev/null || \
  git remote add origin "https://oauth2:${TOKEN}@github.com/EmmanuelGreene/signal-service.git"

git add -A
git commit -m "Initial commit: crypto signals dashboard with AI chat" --allow-empty 2>/dev/null
git branch -M main
git push -u origin main 2>&1

echo "DONE"
