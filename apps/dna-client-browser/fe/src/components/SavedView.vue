<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import type { Card } from "@dna/sdk";
import { api, attempt, bookmarks } from "../client/store";
import FeedRow from "./FeedRow.vue";
import LoadingRows from "./LoadingRows.vue";
const cards = ref<Card[]>([]),
  cursor = ref(0),
  loading = ref(false);
let version = 0;
async function load(reset = false) {
  if (reset) {
    version++;
    cards.value = [];
    cursor.value = 0;
  }
  const request = version;
  loading.value = true;
  const ids = bookmarks.value.slice(cursor.value, cursor.value + 20);
  const result: Card[] = [];
  for (let i = 0; i < ids.length; i += 4) {
    const batch = await Promise.all(ids.slice(i, i + 4).map((id) => attempt(() => api.card(id))));
    result.push(...batch.flatMap((row) => (row ? [row.card] : [])));
  }
  if (request === version) {
    cards.value.push(...result);
    cursor.value += ids.length;
    loading.value = false;
  }
}
onMounted(() => load());
watch(bookmarks, () => load(true));
</script>
<template>
  <section class="feed-list" aria-label="收藏情报" style="overflow: auto">
    <p v-if="!bookmarks.length" class="empty">
      尚无收藏。点击卡片上的“收藏”，保留值得再次查看的来源与分析。
    </p>
    <FeedRow v-for="card in cards" :key="card.id" :card="card" /><LoadingRows
      v-if="loading"
      kind="cards"
      :count="2"
      label="正在读取收藏"
    /><button v-if="cursor < bookmarks.length && !loading" class="button secondary" @click="load()">
      加载更多收藏
    </button>
  </section>
</template>
