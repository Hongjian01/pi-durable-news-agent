export function rate(numerator, denominator) {
  if (!denominator) return { numerator, denominator, value: null, interval95: null };
  const p = numerator / denominator,
    z = 1.95996398454,
    d = 1 + (z * z) / denominator;
  const center = (p + (z * z) / (2 * denominator)) / d;
  const half =
    (z * Math.sqrt((p * (1 - p)) / denominator + (z * z) / (4 * denominator * denominator))) / d;
  return {
    numerator,
    denominator,
    value: p,
    interval95: [Math.max(0, center - half), Math.min(1, center + half)],
  };
}
export function classification(rows, labels) {
  const confusion = {};
  const perClass = {};
  for (const row of rows) {
    const key = row.expected + " -> " + (row.predicted ?? "technical_error");
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  for (const label of labels) {
    const tp = rows.filter((r) => r.expected === label && r.predicted === label).length;
    const predicted = rows.filter((r) => r.predicted === label).length;
    const expected = rows.filter((r) => r.expected === label).length;
    perClass[label] = {
      precision: rate(tp, predicted),
      recall: rate(tp, expected),
      f1: expected + predicted ? (2 * tp) / (expected + predicted) : null,
    };
  }
  const f1 = Object.values(perClass)
    .map((v) => v.f1)
    .filter((v) => v !== null);
  return {
    accuracy: rate(rows.filter((r) => r.expected === r.predicted).length, rows.length),
    confusion,
    perClass,
    macroF1: f1.length ? f1.reduce((a, b) => a + b, 0) / f1.length : null,
  };
}
export function ndcg(rows, k = 6) {
  const gain = (level) => 2 ** level - 1;
  const dcg = (ordered) =>
    ordered.slice(0, k).reduce((sum, row, i) => sum + gain(row.gold) / Math.log2(i + 2), 0);
  const ideal = dcg([...rows].sort((a, b) => b.gold - a.gold));
  return ideal ? dcg([...rows].sort((a, b) => b.score - a.score)) / ideal : null;
}
export function pairedBootstrap(pairs, seed = 173, iterations = 10000) {
  if (!pairs.length) return { n: 0, difference: null, interval95: null };
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < pairs.length; j++) {
      const [a, b] = pairs[Math.floor(random() * pairs.length)];
      total += a - b;
    }
    means.push(total / pairs.length);
  }
  means.sort((a, b) => a - b);
  return {
    n: pairs.length,
    difference: pairs.reduce((sum, [a, b]) => sum + a - b, 0) / pairs.length,
    interval95: [means[Math.floor(iterations * 0.025)], means[Math.floor(iterations * 0.975)]],
    seed,
    iterations,
  };
}
export function compareTasks(results) {
  const parents = new Map();
  const find = (id) => {
    const parent = parents.get(id) ?? id;
    return parent === id ? id : find(parent);
  };
  const owners = new Map();
  for (const row of results) {
    if (!parents.has(row.taskId)) parents.set(row.taskId, row.taskId);
    for (const group of row.sharedGroups ?? []) {
      if (owners.has(group)) parents.set(find(row.taskId), find(owners.get(group)));
      else owners.set(group, row.taskId);
    }
  }
  const groups = new Map();
  for (const row of results) {
    const cluster = find(row.taskId);
    if (!groups.has(cluster)) groups.set(cluster, []);
    groups.get(cluster).push(row);
  }
  function compare(left, right) {
    const pairs = [];
    for (const rows of groups.values()) {
      const a = rows.filter((r) => r.arm === left),
        b = rows.filter((r) => r.arm === right);
      if (a.length && a.length === b.length)
        pairs.push([
          a.filter((r) => r.outcome === "passed").length / a.length,
          b.filter((r) => r.outcome === "passed").length / b.length,
        ]);
    }
    return pairedBootstrap(pairs);
  }
  return {
    B_vs_C: compare("B", "C"),
    B_vs_A: compare("B", "A"),
    knownCosts: Object.fromEntries(
      ["A", "B", "C"].map((arm) => {
        const rows = results.filter((r) => r.arm === arm),
          costs = rows.flatMap((r) => r.costs ?? []);
        return [
          arm,
          {
            trials: rows.length,
            knownUsd: costs.reduce(
              (n, c) => n + Number(c.reported_usd ?? 0) + Number(c.estimated_usd ?? 0),
              0,
            ),
            unknownAttempts: costs.reduce((n, c) => n + Number(c.unknown_cost_attempts ?? 0), 0),
            actualInvoiceUsd: null,
          },
        ];
      }),
    ),
    meaning:
      "Paired pass rates grouped by connected shared-event clusters; repeated trials remain nested. Fixture costs cannot support savings claims",
  };
}
