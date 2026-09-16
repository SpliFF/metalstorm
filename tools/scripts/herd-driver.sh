#!/bin/bash
# Dumb taskherd driver: fires one runnable step every INTERVAL seconds while slots are free.
# No scheduler exists; the hourly LaunchAgent stays disabled. Stop: touch .tasks/driver.stop
REPO="${REPO:-/Users/shannon/WarriorHut/Projects/springrts-web}"
INTERVAL="${INTERVAL:-120}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/v22.13.0/bin:/usr/bin:/bin:$PATH"
LOG="$REPO/.tasks/logs/driver.log"
mkdir -p "$REPO/.tasks/logs"
echo "$(date '+%F %T') driver start pid $$ interval ${INTERVAL}s" >> "$LOG"
while true; do
  if [ -f "$REPO/.tasks/driver.stop" ]; then echo "$(date '+%F %T') stop file seen, exiting" >> "$LOG"; exit 0; fi
  if [ -f "$REPO/.tasks/PAUSED" ] || [ -f "$REPO/.tasks/pause" ]; then sleep "$INTERVAL"; continue; fi
  line=$(taskherd status -C "$REPO" 2>/dev/null | head -1)
  max=$(echo "$line" | sed -n 's/.*max \([0-9]*\).*/\1/p'); running=$(echo "$line" | sed -n 's/.*running \([0-9]*\).*/\1/p')
  if [ -n "$max" ] && [ -n "$running" ] && [ "$running" -lt "$max" ]; then
    # fire in the background: `taskherd run` stays attached for the whole step
    ( nohup taskherd run -C "$REPO" >> "$REPO/.tasks/logs/driver-runs.log" 2>&1 & )
    echo "$(date '+%F %T') running=$running/$max fired one step" >> "$LOG"
    sleep 30
  fi
  sleep "$INTERVAL"
done
