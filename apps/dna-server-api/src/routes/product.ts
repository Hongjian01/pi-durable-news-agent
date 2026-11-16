import type { Handlers, RouteDeps } from "./types.ts";
import { bodyOf, str } from "./types.ts";
import { int, invalid, notFound } from "../errors.ts";
import { startNewsSweep } from "../news/sweep.ts";
import { previewPreset, applyPreset } from "../news/presets.ts";
import { costSummary } from "../news/budgets.ts";
import { tx } from "../db/db.ts";

export function productRoutes({
  app,
}: RouteDeps): Handlers<
  | "sweeps.start"
  | "sweeps.inspection"
  | "preset.preview"
  | "preset.apply"
  | "bookmarks.get"
  | "cards.bookmark"
> {
  return {
    "bookmarks.get": (_req, res) => res.json(app.store.settings.get<number[]>("bookmarks", [])),
    "cards.bookmark": (req, res) => {
      const id = int(req.params.id, "id"),
        saved = bodyOf(req).saved;
      if (typeof saved !== "boolean") throw invalid("saved must be boolean");
      if (!app.store.news.card(id)) throw notFound(`No card ${id}`);
      const result = tx(app.store.db, () => {
        const ids = new Set(app.store.settings.get<number[]>("bookmarks", []));
        if (saved) ids.add(id);
        else ids.delete(id);
        app.store.settings.set("bookmarks", [...ids]);
        return [...ids];
      });
      res.json(result);
    },
    "sweeps.start": async (req, res) => {
      const requestId = str(bodyOf(req), "requestId", { max: 128 });
      const result = await startNewsSweep(app, app.main, app.ctx, { requestId, trigger: "manual" });
      res.status(result.status === "accepted" ? 202 : 200).json(result);
    },
    "preset.preview": (_req, res) => res.json(previewPreset(app.store, app.config.configDir)),
    "preset.apply": (req, res) => {
      const body = bodyOf(req),
        revision = str(body, "revision", { max: 128 });
      if (
        !Array.isArray(body.selected) ||
        body.selected.length > 100 ||
        body.selected.some((id) => typeof id !== "string")
      )
        throw invalid("selected must be a list of preset entry ids");
      try {
        res.json(applyPreset(app.store, app.config.configDir, revision, body.selected as string[]));
      } catch (error) {
        throw invalid(String(error));
      }
      app.bus.publish({ type: "taste.keywords", keywords: app.store.taste.keywords() });
    },
    "sweeps.inspection": (req, res) => {
      const id = int(req.params.id, "id");
      if (!app.store.sweeps.get(id)) throw notFound(`No sweep ${id}`);
      const before = int(req.query.before, "before", Number.MAX_SAFE_INTEGER);
      const operations = app.store.db
        .prepare(
          "SELECT rowid cursor,* FROM judgment_operations WHERE sweep_id=? AND rowid<? ORDER BY rowid DESC LIMIT 50",
        )
        .all(id, before) as any[];
      const judgments = operations.map((operation) => ({
        ...operation,
        input: JSON.parse(operation.input_json),
        result: operation.result_json ? JSON.parse(operation.result_json) : null,
        policy: operation.decision_json ? JSON.parse(operation.decision_json) : null,
        attemptsLog: app.store.db
          .prepare("SELECT * FROM external_attempts WHERE operation_key=? ORDER BY id")
          .all(operation.operation_key),
      }));
      res.json({
        costs: costSummary(app.store, id),
        submission: app.store.submissions.get(id)?.status,
        items: app.store.db
          .prepare(
            "SELECT item_id,disposition,reason,research_status,card_id FROM sweep_items WHERE sweep_id=? ORDER BY item_id",
          )
          .all(id),
        sources: app.store.db.prepare("SELECT * FROM sweep_sources WHERE sweep_id=?").all(id),
        judgments,
        next: operations.length === 50 ? operations.at(-1)!.cursor : undefined,
      });
    },
  };
}
