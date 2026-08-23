#!/usr/bin/env bash
# Clone / update br-g/openf1 into ./openf1 for docker compose builds.
set -euo pipefail
cd "$(dirname "$0")"
REPO="${OPENF1_GIT_URL:-https://github.com/br-g/openf1.git}"
REF="${OPENF1_GIT_REF:-main}"

if [[ -d openf1/.git ]]; then
  echo "Updating existing openf1 checkout ($REF)…"
  git -C openf1 fetch origin
  git -C openf1 checkout "$REF"
  git -C openf1 pull --ff-only origin "$REF" || true
else
  echo "Cloning $REPO ($REF) → ./openf1"
  git clone --depth 1 --branch "$REF" "$REPO" openf1
fi

echo "OK: $(git -C openf1 rev-parse --short HEAD) @ $(git -C openf1 rev-parse --abbrev-ref HEAD)"
