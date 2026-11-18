#!/usr/bin/env bash
# Build the firmware in the official ESP-IDF container — no local toolchain needed.
#   scripts/build.sh            # idf.py build
#   scripts/build.sh fullclean  # any idf.py action
# Output: build/knob_starter.bin (+ bootloader, partition table). Flash with scripts/flash.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-build}"; shift || true
IMAGE="${IDF_IMAGE:-espressif/idf:release-v5.3}"

cd "$ROOT"
if command -v idf.py >/dev/null 2>&1; then
  idf.py "$@" "$ACTION"
else
  echo "idf.py not found — building in $IMAGE"
  # -u keeps build/ owned by you; HOME=/tmp gives the container a writable idf-component cache.
  docker run --rm -v "$ROOT":/project -w /project -u "$(id -u):$(id -g)" -e HOME=/tmp \
    "$IMAGE" idf.py "$@" "$ACTION"
fi
