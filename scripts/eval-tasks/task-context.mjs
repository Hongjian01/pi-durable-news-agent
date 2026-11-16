/** A directed evidence question supplies reader intent, never reference labels or target IDs. */
export function taskKeywords(task, defaults) {
  if (task.taskType !== "evidence_qa") return defaults;
  if (typeof task.goal !== "string" || !task.goal.trim())
    throw Error("Evidence QA requires a non-empty user goal");
  return { ...defaults, topic: [task.goal.trim()] };
}
