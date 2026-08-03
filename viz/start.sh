#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[brain-viz] Node.js not found. Install from https://nodejs.org"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[brain-viz] First run - installing dependencies..."
  npm install
fi

echo "[brain-viz] Building brain data..."
npm run build:data

echo "[brain-viz] Starting dev server (browser will open)..."
npm run dev
