import {
  GenerationTask,
  CompactionTask,
  hook,
  type HookApi,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Deps } from "../deps.ts";
import { execution, assertExecution, type Execution } from "../db/execution.ts";
import { toolExecution } from "./execution.ts";
import { reserve, settle, limits, estimatedModelCost } from "./budgets.ts";
import { evaluation } from "./context.ts";
import { ResearchBinding } from "./research-binding.ts";
import { researchRemaining } from "./research-budget.ts";
import type { Context } from "@earendil-works/chord";
import { cappedModelOptions } from "./model-policy.ts";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

export function modelBudget(deps: Deps, session: () => Pick<Harness, "commit"> | undefined) {
  const requests = new WeakMap<object, { scope: Execution | undefined; taskId: number }>();
  const terminal = (scope: Execution) => {
    const row = deps.store.sweeps.get(scope.sweepId);
    return row &&
      row.executionEpoch === scope.epoch &&
      ["completed", "no_news", "partial", "failed"].includes(row.status)
      ? row
      : undefined;
  };
  const register = async (messages: readonly object[], api: HookApi, ctx: Context) => {
    const reader = session();
    if (!reader) throw new Error("Model budget needs a session reader");
    const scope = await execution.run(undefined, () =>
      toolExecution(deps, { taskId: api.taskId, commit: reader.commit.bind(reader) }, ctx),
    );
    if (!scope) {
      for (const message of messages)
        requests.set(message, { scope: undefined, taskId: api.taskId as number });
      return;
    }
    const binding = await api.snapshot(ResearchBinding, api.conversationId, ctx);
    const scoped = {
      ...scope,
      ...(binding?.itemIds ? { itemIds: binding.itemIds, researchDeadline: binding.deadline } : {}),
    };
    if (!terminal(scoped)) assertExecution(deps.store.db, scoped);
    for (const message of messages)
      requests.set(message, { scope: scoped, taskId: api.taskId as number });
    return scoped;
  };
  const models = deps.catalog.models;
  const stream = models.streamSimple.bind(models),
    complete = models.completeSimple.bind(models);
  const dispatch = (original: any, model: any, context: any, options: any = {}) => {
    const registered = context.messages?.map((m: object) => requests.get(m)).find(Boolean);
    const scope = registered ? registered.scope : execution.getStore();
    if (!scope) return original(model, context, cappedModelOptions(model, options, 2000));
    const finished = terminal(scope);
    if (finished) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: `Sweep #${finished.id} ${finished.status}.` }],
        api: model.api,
        provider: "local",
        model: "business-finalizer",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      deps.log.debug("model.local_completion", { sweepId: scope.sweepId });
      if (original === complete) return Promise.resolve(message);
      const events = createAssistantMessageEventStream();
      events.push({ type: "done", reason: "stop", message });
      events.end(message);
      return events;
    }
    return execution.run(scope, () => {
      assertExecution(deps.store.db);
      const frozen = evaluation(deps.store)?.value;
      if (frozen && frozen.models.provider !== deps.catalog.provider)
        throw new Error("frozen_model_provider_unavailable");
      const kind = scope.itemIds?.length
        ? "research_model"
        : registered
          ? "desk_model"
          : "quick_model";
      const requested = kind === "desk_model" ? frozen?.models.requestedModel : model.id;
      const selected = requested ? models.getModel(model.provider, requested) : model;
      if (!selected) throw new Error("frozen_model_unavailable");
      const id = reserve(deps.store, kind, `model:${registered?.taskId ?? "quick"}`, {
        itemIds: scope.itemIds,
        model: selected.id,
      });
      const result = original(
        selected,
        context,
        cappedModelOptions(
          selected,
          options,
          limits(deps.store).outputTokens,
          frozen?.modelOutputPolicy,
        ),
      );
      const promise = result && typeof result.result === "function" ? result.result() : result;
      void Promise.resolve(promise).then(
        (message: any) => {
          const usage = message.usage;
          const ok = !["error", "aborted"].includes(message.stopReason);
          const amount =
            ok && deps.catalog.provider === "faux"
              ? 0
              : ok
                ? estimatedModelCost(selected, usage)
                : null;
          settle(deps.store.db, id, {
            status: ok ? "succeeded" : "unknown",
            amount,
            source: deps.catalog.provider === "faux" ? "mock" : "estimated",
            model: message.model,
            input: usage?.input,
            output: usage?.output,
          });
        },
        () => settle(deps.store.db, id, { status: "unknown" }),
      );
      return result;
    });
  };
  models.streamSimple = ((model: any, context: any, options: any) =>
    dispatch(stream, model, context, options)) as typeof models.streamSimple;
  models.completeSimple = ((model: any, context: any, options: any) =>
    dispatch(complete, model, context, options)) as typeof models.completeSimple;
  return [
    hook(CompactionTask, {
      beforeCompact: async (request, api, ctx) => {
        await register(request.messages, api, ctx);
        return undefined;
      },
    }),
    hook(GenerationTask, {
      beforeRequest: async (request, api, ctx) => {
        const scope = await register(request.messages, api, ctx);
        if (!scope) return;
        const frozen = evaluation(deps.store, scope.sweepId)?.value;
        const binding = await api.snapshot(ResearchBinding, api.conversationId, ctx);
        const messages = request.messages.map((message) =>
          message.role === "system" && message.sections
            ? {
                ...message,
                sections: {
                  ...message.sections,
                  ...("news-desk" in message.sections && frozen?.renderedDeskSystem
                    ? { "news-desk": frozen.renderedDeskSystem }
                    : {}),
                  ...("news-researcher" in message.sections && binding?.system
                    ? { "news-researcher": binding.system + (binding.itemIds?.length
                        ? `\nResearch budget: ${researchRemaining(deps.store, scope.sweepId, binding.itemIds)} model requests remain before this request. Reserve the last two for report_findings and citation repair. Submit only the requested facts; stop exploratory reading/classification when remaining <= 3. A new research task does not reset the budget.`
                        : "") }
                    : {}),
                },
              }
            : message,
        );
        for (const message of messages)
          requests.set(message, { scope, taskId: api.taskId as number });
        return { messages };
      },
    }),
  ];
}
