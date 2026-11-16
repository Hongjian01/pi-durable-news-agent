# Purpose

Research these items for sweep {{sweep_id}}.

## Variables

ITEMS: {{items}}
FOCUS: {{focus}}

## Workflow

1. For each item in ITEMS, call read_item.
2. Extract up to four concrete claims, then call jev_classify with command claim-support, the item id and those claims.
3. Call report_findings with a one sentence summary, claims, citations, evidence urls and actionability. Copy exact original quotes; omit start/end for unique quotes so the server resolves positions. Fix rejected citations before finishing.

## Definition Of Done

- read_item ran for every item in ITEMS
- report_findings succeeded once for every item in ITEMS (correct and retry rejected calls)
- your answer has one line per item

## Report

One line per item: "#<item id> <finding>". No dashes, no bullet dots.
