#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
log_file=$(mktemp)
trap 'rm -f "$log_file"' EXIT
for stream in stdout stderr; do
  : > "$log_file"
  SURFACE_LOG_FILE="$log_file" SURFACE_TEST_STREAM="$stream" node --no-warnings --input-type=module 2>&1 <<'JS' | head -1
import { hookProcess } from './src/log.ts';
hookProcess();
const output = process[process.env.SURFACE_TEST_STREAM];
output.write('ready\n');
setTimeout(() => {
  output.write('reader has closed\n');
  setTimeout(() => process.exit(0), 30);
}, 100);
JS
  rg -q 'output pipe closed' "$log_file"
done
echo 'Logging: Surface survives closed stdout and stderr pipes.'
