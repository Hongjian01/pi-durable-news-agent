# Purpose

Research these items for sweep {{sweep_id}}.

## Variables

ITEMS: {{items}}
FOCUS: {{focus}}

## Workflow

1. For each item in ITEMS, call read_item.
2. Use source navigation heading offsets or find_text to locate the requested capabilities. Save only the minimal requested claims early; do not read every page or add unrelated capabilities. report_findings verifies citations itself, so a separate jev_classify precheck is optional.
3. Call report_findings with a one sentence summary, claims, citations, evidence urls and actionability. Copy exact original quotes; omit start/end for unique quotes so the server resolves positions. Fix rejected citations before finishing.

## Definition Of Done

- read_item ran for every item in ITEMS
- report_findings succeeded once for every item in ITEMS (correct and retry rejected calls)
- your answer has one line per item

## Report

One line per item: "#<item id> <finding>". No dashes, no bullet dots.
