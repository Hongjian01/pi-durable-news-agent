import { defineDoc } from "@earendil-works/pi-durable";
export const ResearchBinding = defineDoc<{
  sweepId?: number;
  epoch?: number;
  itemIds?: number[];
  deadline?: number;
  system?: string;
}>({
  kind: "dna.research-binding",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});
