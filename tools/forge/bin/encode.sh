#!/bin/bash
# encode.sh <workspace> <stem> — PNG set -> KTX2 set via ../fable-model-forge/encode.mjs
set -e
FORGE="$(cd "$(dirname "$0")/.." && pwd)"
cd "${1:?usage: encode.sh <workspace> <stem>}"
node "$FORGE/../fable-model-forge/encode.mjs" "${2:?need stem}"
