"""Re-score the archived M4 fixture runs against the engineering sidecar."""
import json
from pathlib import Path


def main():
    folder = Path(__file__).resolve().parent
    archive = folder.parents[2] / "test-results" / "m4-verified"
    rows = [json.loads(line) for line in
            (folder / "engineering-v1.jsonl").read_text(encoding="utf8").splitlines()]
    report = []
    for path in sorted(archive.glob("*/repeat-*/result.json")):
        trial = json.loads(path.read_text(encoding="utf8"))
        if trial["backend"] != "fixture":
            raise ValueError(f"Unexpected backend in {path}")
        labels = {r["sampleId"]: r["label"] for r in rows if r["split"] == trial["split"]}
        predictions = trial["predictions"]
        if {p["sampleId"] for p in predictions} != labels.keys() or len(predictions) != len(labels):
            raise ValueError(f"Archive does not cover the labeled split in {path}")
        useful_ids = {k for k, v in labels.items() if v["relevant"] and v["useful"]}
        chosen = {p["sampleId"] for p in predictions if p["selected"]}
        kept = {p["sampleId"] for p in predictions if p["gate"] is True}
        report.append({
            "trial": path.relative_to(archive).as_posix(),
            "protocolHash": trial["protocolHash"],
            "terminalState": trial["status"],
            "selectedUsefulDocuments": len(chosen & useful_ids),
            "selectedDocuments": len(chosen),
            "usefulGateRecallCounts": [len(kept & useful_ids), len(useful_ids)]
            if trial["arm"] == "B" else None
        })
    if len(report) != 18:
        raise ValueError("Expected both archived splits, three arms and three repeats")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
