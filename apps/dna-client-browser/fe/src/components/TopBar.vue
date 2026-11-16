<script setup lang="ts">
import { computed } from "vue";
import {
  Activity,
  Clock,
  Coins,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Server,
  SlidersHorizontal,
  WifiOff,
  Zap,
} from "@lucide/vue";
import { usd } from "@dna/sdk";
import { layout, toggle } from "../client/layout";
import { go } from "../client/route";
import { agentState, api, attempt, connection, feed, info, now, ui } from "../client/store";

const busy = computed(() => agentState.value?.busy ?? false);
const schedule = computed(() => agentState.value?.schedule);
const countdown = computed(() => {
  if (schedule.value && schedule.value.everyMinutes === null) return "计划扫描已关闭";
  const at = agentState.value?.nextSweepAt ?? info.value?.nextSweepAt;
  if (!at) return "尚未安排扫描";
  const s = Math.max(0, Math.round((Date.parse(at) - now.value) / 1000));
  return `下次扫描 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
});
const every = (m: number) => (m === 60 ? "每小时" : m === 1 ? "每分钟" : `每 ${m} 分钟`);
const CARD_CHOICES = [3, 5, 6, 7, 10, 15, 20, 30];
async function setCards(value: string) {
  const next = await attempt(() => api.setCardsPerSweep(Number(value)));
  if (next) feed.apply({ type: "schedule", schedule: next });
}
async function setSchedule(value: string) {
  const next = await attempt(() => api.setSchedule(value === "off" ? null : Number(value)));
  if (next) feed.apply({ type: "schedule", schedule: next });
}
/** All time: what the agent's model, jev and image generation have cost on this device. */
const spend = computed(() => agentState.value?.spend);
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true"><Zap :size="17" /></span>
      <div>
        <strong>AgentRadar</strong>
        <span class="tagline">开发者技术情报雷达</span>
      </div>
    </div>
    <div class="agent-status" data-cap="status" :class="{ working: busy }" aria-live="polite">
      <template v-if="connection !== 'live'"
        ><WifiOff :size="16" /><span>{{
          connection === "unauthorized" ? "令牌无效" : "正在重连"
        }}</span></template
      >
      <template v-else-if="busy"
        ><LoaderCircle :size="16" class="spin" /><span>执行中</span></template
      >
      <template v-else
        ><Clock :size="16" /><span>待命 · {{ countdown }}</span></template
      >
      <select
        v-if="schedule"
        class="schedule-select"
        data-cap="schedule"
        aria-label="Sweep schedule"
        :value="schedule.everyMinutes ?? 'off'"
        @change="setSchedule(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="m in schedule.presets" :key="m" :value="m">{{ every(m) }}</option>
        <option value="off">关闭</option>
      </select>
      <select
        v-if="schedule"
        class="schedule-select"
        aria-label="Cards per sweep"
        title="The most cards one sweep presents; jev ranks the candidates and keeps the top ones"
        :value="schedule.cardsPerSweep"
        @change="setCards(($event.target as HTMLSelectElement).value)"
      >
        <option
          v-for="n in [...new Set([...CARD_CHOICES, schedule.cardsPerSweep])].sort((a, b) => a - b)"
          :key="n"
          :value="n"
        >
          最多 {{ n }} 张
        </option>
      </select>
    </div>
    <div class="topbar-right">
      <button
        class="stat link"
        data-cap="usage"
        :title="
          spend
            ? `旧版已知费用投影：模型 ${usd(spend.modelUsd)}，Jev ${usd(spend.jevUsd)}，图片 ${usd(spend.imageUsd)}。完整费用和未知覆盖请查看扫描详情。`
            : '查看扫描费用与未知覆盖'
        "
        @click="go('/executions/usage')"
      >
        <Coins :size="15" />费用与覆盖
      </button>
      <span class="stat device" :title="`Device ${info?.device ?? ''}`" data-testid="device"
        ><Server :size="15" />{{ info?.deviceName ?? info?.device ?? "device" }}</span
      >
      <button
        class="bar-button"
        data-cap="runs.read"
        aria-label="Executions"
        title="Executions"
        @click="go('/executions')"
      >
        <Activity :size="16" /><span>执行记录</span>
      </button>
      <button class="bar-button" @click="go('/evaluations')"><span>评测中心</span></button>
      <button class="bar-button" aria-label="Settings" title="Settings" @click="ui.settings = true">
        <SlidersHorizontal :size="16" /><span>偏好设置</span>
      </button>
      <button
        class="bar-button"
        :class="{ on: layout.feed }"
        :aria-pressed="layout.feed"
        aria-label="Toggle the news column"
        title="News column"
        @click="toggle('feed')"
      >
        <PanelLeft :size="16" /><span>情报</span>
      </button>
      <button
        class="bar-button"
        :class="{ on: layout.agent }"
        :aria-pressed="layout.agent"
        aria-label="Toggle the agent column"
        title="Agent column"
        @click="toggle('agent')"
      >
        <PanelRight :size="16" /><span>研究 Agent</span>
      </button>
    </div>
  </header>
</template>
