#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v pi >/dev/null 2>&1; then
  echo "pi was not found in PATH. Install Pi Coding Agent first." >&2
  exit 1
fi

pi install "$ROOT"
echo "Installed pi-gvs-lite from: $ROOT"
echo "Start pi in a trusted project. gvs-lite will create .pi/work on the first task."
