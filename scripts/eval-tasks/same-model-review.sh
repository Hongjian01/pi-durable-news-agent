#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  read -r -s -p 'DeepSeek API key: ' DEEPSEEK_API_KEY
  printf '\n'
  export DEEPSEEK_API_KEY
fi
test -n "$DEEPSEEK_API_KEY" || { echo 'DeepSeek key is empty'; exit 1; }
export DNA_JUDGE_PROVIDER=deepseek
judge_model="${DNA_JUDGE_MODEL:-${DNA_MODEL:-deepseek-flash}}"
review_dir="test-results/same-model-review-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$review_dir"
echo "This run calls DeepSeek for calibration/review only, using $judge_model. Direct-account fees apply; no USD hard cap is verified. No Agent reruns. All labels/reviews are model assisted, not independent human acceptance."
npm run eval:calibrate -- --labels evaluation/annotations/v4 --suite semantic --provider deepseek --model "$judge_model" --enable-paid --check --out "$review_dir/calibration"
# A failed calibration exits before the remaining judge calls; artifacts are retained.
for experiment in run-bfd6dd46-b852-4c9f-a00e-91ec53c081ec run-68ea65d4-bb19-49e0-be12-43bc62d2b3d9 run-d10c0018-8981-4117-a43c-e3e69b4ca519; do
  npm run eval:regrade -- --input "test-results/eval-tasks/$experiment" --out "$review_dir/$experiment" --judge-provider deepseek --judge-model "$judge_model" --enable-paid
done
echo "Saved review results to $review_dir"
