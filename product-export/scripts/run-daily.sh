#!/usr/bin/env bash
# Daily run of the product report, for cron. (On the server the systemd timer in
# deploy/product-export.timer is the recommended way.) Output goes to logs/daily.log.
cd "$(dirname "$0")/.." || exit 1
# cron and launchd start with a bare PATH; add the usual places node is installed
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p logs
echo "===== $(date '+%Y-%m-%d %H:%M:%S') =====" >> logs/daily.log
node src/index.js >> logs/daily.log 2>&1
