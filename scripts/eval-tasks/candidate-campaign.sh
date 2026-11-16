#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mode="${1:---fixture}"
[[ "$mode" == --fixture || "$mode" == --live ]] || { echo 'Use --fixture or --live'; exit 1; }
repeats="${REPEATS:-1}"
[[ "$repeats" =~ ^[1-3]$ ]] || { echo 'REPEATS must be 1..3'; exit 1; }
run_dir="test-results/candidate-campaign-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$run_dir"
trap 'echo "Campaign stopped; partial artifacts remain in $run_dir" >&2' ERR
config="${CAMPAIGN_CONFIG:-evaluation/experiment.v4.json}"
task_id="${CAMPAIGN_TASK:-pilot-02}"
paid=();judge=()
if [[ "$mode" == --live ]]; then
 for key_name in OPENROUTER_API_KEY DEEPSEEK_API_KEY; do
  if [[ -z "${!key_name:-}" ]]; then read -r -s -p "$key_name: " "$key_name"; printf '\n'; export "$key_name"; fi
  [[ -n "${!key_name}" ]] || { echo "$key_name is empty"; exit 1; }
 done
 export DNA_COST_ALERT_USD="${DNA_COST_ALERT_USD:-1}"
 paid=(--backend live --enable-paid --max-usd 1 --budget-scope openrouter-credits)
 judge=(--judge-provider deepseek --judge-model "${DNA_JUDGE_MODEL:-${DNA_MODEL:-deepseek-flash}}" --enable-paid)
 echo 'Real Top-1/2/3 runs plus same-model review. DeepSeek fees are separate from the OpenRouter cap. One delivered card per arm. Fixed K order, not randomized.'
fi
for k in 1 2 3; do
 npm run eval:tasks -- --config "$config" --task "$task_id" --repeat "$repeats" --research-candidates "$k" --out "$run_dir/k$k" "${paid[@]}"
 npm run eval:regrade -- --input "$run_dir/k$k" --out "$run_dir/review-k$k" "${judge[@]}"
done
node scripts/eval-tasks/candidate-report.mjs --input "$run_dir"
echo "Campaign results: $run_dir"
