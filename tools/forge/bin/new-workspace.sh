#!/bin/bash
# new-workspace.sh <dir> <stem> [sample]  — scaffold an agent workspace
set -e
FORGE="$(cd "$(dirname "$0")/.." && pwd)"
DIR=${1:?usage: new-workspace.sh <dir> <stem> [sample-to-copy]}; STEM=${2:?need stem}
mkdir -p "$DIR/out"
if [ -n "$3" ] && [ -d "$FORGE/samples/$3" ]; then
  for f in "$FORGE/samples/$3"/*.py; do
    b=$(basename "$f"); cp "$f" "$DIR/${b//$3/$STEM}"
  done
  echo "copied sample $3 as starting point (rename internals to $STEM)"
fi
echo "workspace ready: $DIR — source $FORGE/bin/env.sh, build with \$PY"
