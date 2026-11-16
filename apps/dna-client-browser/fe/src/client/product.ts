import type { Sweep } from "@dna/sdk";
export const activeSweep = (s: Sweep) =>
  ["queued", "running", "finalizing", "cancelling"].includes(s.status);
export const statusName = (s: string) =>
  ({
    queued: "待提交",
    running: "执行中",
    finalizing: "完成检查中",
    cancelling: "正在取消",
    completed: "已完成",
    no_news: "本轮无可发布新闻",
    partial: "部分完成",
    cancelled: "已取消",
    failed: "处理失败",
    skipped: "已跳过",
    stalled: "旧版中断",
  })[s] ?? s;
export const phaseName = (s: string) =>
  ({
    gather: "发现来源",
    gate: "Jev 筛选",
    dedupe: "事件关联",
    rank: "研究排序",
    research: "子 Agent 研究",
    retry: "等待重试",
  })[s] ?? s;
export const localTime = (s?: string) =>
  s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "—";
