import { evaluationService } from "../evaluation/service.ts";
import { bodyOf, str } from "./types.ts";
import type { RouteDeps, Handlers } from "./types.ts";
export function evaluationRoutes({
  app,
}: RouteDeps): Handlers<
  | "evaluations.list"
  | "evaluations.start"
  | "evaluations.get"
  | "evaluations.cancel"
  | "evaluations.resume"
  | "evaluations.trial"
> {
  const service = evaluationService(app);
  return {
    "evaluations.list": (_req, res) => res.json(service.list()),
    "evaluations.start": (req, res) =>
      res
        .status(202)
        .json(
          service.start({ ...bodyOf(req), requestId: str(bodyOf(req), "requestId", { max: 128 }) }),
        ),
    "evaluations.get": (req, res) => res.json(service.detail(String(req.params.id))),
    "evaluations.cancel": (req, res) => res.json(service.stop(String(req.params.id))),
    "evaluations.resume": (req, res) => res.json(service.resume(String(req.params.id))),
    "evaluations.trial": (req, res) =>
      res.json(service.trial(String(req.params.id), String(req.query.artifact ?? ""))),
  };
}
