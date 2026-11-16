<script setup lang="ts">
import { computed } from "vue";
import { BadgeCheck, Megaphone, ThumbsDown, ThumbsUp, Zap } from "@lucide/vue";
import { HFS_CATEGORIES, type Card, type HfsCategory } from "@dna/sdk";
import { api, attempt, notify, bookmarks } from "../client/store";

const props = defineProps<{ card: Card }>();
async function save() {
  const result = await attempt(() =>
    api.bookmark(props.card.id, !bookmarks.value.includes(props.card.id)),
  );
  if (result) bookmarks.value = result;
}
const ICONS = { hype: Megaphone, facts: BadgeCheck, signal: Zap };
const NAMES: Record<HfsCategory, string> = { hype: "Hype", facts: "Facts", signal: "Signal" };
/** Label buttons in the same order as the card's ranked H/F/S chips. */
const order = computed<HfsCategory[]>(
  () => props.card.hfs?.ranked.map((r) => r.category) ?? [...HFS_CATEGORIES],
);

async function signal(value: "more" | "less") {
  const r = await attempt(() => api.feedback(props.card.id, { signal: value }));
  if (r)
    notify(
      value === "more"
        ? "已增加这类内容的推荐权重，新偏好从下一轮扫描生效。"
        : "已从最新情报隐藏，并减少这类内容的推荐权重。",
    );
}
async function label(category: HfsCategory) {
  const current = props.card.feedback?.labels ?? [];
  const next = current.includes(category)
    ? current.filter((c) => c !== category)
    : [...current, category];
  await attempt(() => api.feedback(props.card.id, { labels: next }));
}
</script>

<template>
  <div class="feedback">
    <button
      class="fb"
      :aria-pressed="bookmarks.includes(card.id)"
      :aria-label="bookmarks.includes(card.id) ? '取消收藏' : '收藏卡片'"
      @click="save"
    >
      {{ bookmarks.includes(card.id) ? "已收藏" : "收藏" }}
    </button>
    <button
      class="fb"
      data-cap="feedback.more"
      :class="{ on: card.feedback?.signal === 'more' }"
      :aria-pressed="card.feedback?.signal === 'more'"
      title="增加这类推荐"
      aria-label="Show me more"
      @click="signal('more')"
    >
      <ThumbsUp :size="14" />
    </button>
    <button
      class="fb"
      data-cap="feedback.less"
      :class="{ on: card.feedback?.signal === 'less' }"
      :aria-pressed="card.feedback?.signal === 'less'"
      title="减少这类推荐"
      aria-label="Show me less"
      @click="signal('less')"
    >
      <ThumbsDown :size="14" />
    </button>
    <span class="fb-labels" data-cap="feedback.label" role="group" aria-label="Your label">
      <span class="fb-prefix" aria-hidden="true">Label</span>
      <button
        v-for="c in order"
        :key="c"
        class="fb tag"
        :class="[c, { on: card.feedback?.labels.includes(c) }]"
        :aria-pressed="!!card.feedback?.labels.includes(c)"
        :aria-label="`Label ${NAMES[c]}`"
        :title="`Label this ${NAMES[c]}`"
        @click="label(c)"
      >
        <component :is="ICONS[c]" :size="13" />
      </button>
    </span>
  </div>
</template>
