#!/usr/bin/env bash
# Run with: wsl -d Ubuntu -- bash /mnt/e/agent/Jev/pi-durable-news-agent/scripts/m0/run-wsl.sh
set -euo pipefail
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
if ! command -v node >/dev/null || [[ $(node -p 'process.platform') != linux ]]; then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.nvm/nvm.sh"
    nvm use 24
  fi
fi
[[ $(node -p 'process.platform') == linux && $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || {
  echo "Linux Node 24 is required; install it with nvm and rerun." >&2
  exit 1
}
work=$(mktemp -d /tmp/agentradar-m0.XXXXXX)
destination="$source_root/test-results/$(basename "$work")"
mkdir -p "$destination"
echo "Linux work directory: $work"
echo "Results will be copied to: $destination"
save_results() {
  if [[ -d "$work/test-results" ]]; then cp -a "$work/test-results/." "$destination/"; fi
}
trap save_results EXIT
# Credentials, existing databases and the Windows dependency tree stay out of the run.
tar -C "$source_root" --exclude=.git --exclude=node_modules --exclude=test-results \
  --exclude=data --exclude=logs --exclude=.env --exclude=dna-network.yaml -cf - . |
  tar -C "$work" -xf -
cd "$work"
npm ci --no-audit --no-fund 2>&1 | tee "$destination/install.log"
browser=$(node -p 'require("playwright-core").chromium.executablePath()')
if [[ -z ${DNA_BROWSER_EXECUTABLE:-} && -x "$browser" ]]; then
  export DNA_BROWSER_EXECUTABLE="$browser"
fi
export DNA_BASELINE_REVISION
DNA_BASELINE_REVISION=$(git -C "$source_root" rev-parse HEAD 2>/dev/null || echo working-copy)
result=0
node scripts/m0-baseline.mjs || result=1
npx --no-install tsc -p scripts/m0 || result=1
NODE_NO_WARNINGS=1 node --import tsx --test scripts/m0/sdk-contract.test.ts 2>&1 | tee "$destination/sdk-contract.log" || result=1
NODE_NO_WARNINGS=1 node --import tsx scripts/m0/fixture-smoke.ts test-results/fixture 2>&1 | tee "$destination/fixture.log" || result=1
exit "$result"
