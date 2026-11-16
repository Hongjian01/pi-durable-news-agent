import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { execution, ACTIVE } from "../../db/execution.ts";
import { requestFinalization, finalize } from "../../news/finalization.ts";

export function completeSweep(deps: Deps) {
  return defineAppTool({
    name: "complete_sweep",
    description:
      "Request business completion. The server checks all items, research, evidence, HFS, sources and retries; it computes completed/no_news/partial/failed. Repair reported gaps when asked.",
    returns: "Computed sweep status or structured repair gaps.",
    parameters: Type.Object({
      sweep_id: Type.Integer(),
      status: Type.Union([Type.Literal("presented"), Type.Literal("no_news")]),
      summary: Type.String({ minLength: 5, maxLength: 400 }),
    }),
    replay: "safe",
    execute: async (args) => {
      const sweep = deps.store.sweeps.get(args.sweep_id);
      if (!sweep) return toolError(`No sweep #${args.sweep_id}.`);
      if (!ACTIVE.includes(sweep.status)) return toolText(`Sweep #${sweep.id} ${sweep.status}.`);
      const scope = execution.getStore() ?? { sweepId: sweep.id, epoch: sweep.executionEpoch ?? 0 };
      requestFinalization(deps.store, scope, args.summary);
      if (
        deps.config.provider === "faux" &&
        process.env.DNA_TEST_CRASH_POINT === "finalization_requested"
      )
        process.kill(process.pid, "SIGKILL");
      const result = finalize(deps.store, scope);
      deps.bus.publish({ type: "sweep", sweep: deps.store.sweeps.get(sweep.id)! });
      return result.status === "repair"
        ? toolError(`Business completion requires repair: ${JSON.stringify(result.gaps)}`)
        : toolText(`Sweep #${sweep.id} ${result.status}.`, {
            status: result.status,
            gaps: result.gaps,
          });
    },
  });
}
