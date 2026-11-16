<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { usd, type SweepInspection } from "@dna/sdk";
import { api, attempt } from "../client/store";
import JsonView from "./JsonView.vue";
const props = defineProps<{ id: number }>(),
  detail = ref<SweepInspection>();
const load = async () => {
  detail.value = await attempt(() => api.sweepInspection(props.id));
};
async function more() {
  if (!detail.value?.next) return;
  const next = await attempt(() => api.sweepInspection(props.id, detail.value!.next));
  if (next) detail.value = { ...next, judgments: [...detail.value.judgments, ...next.judgments] };
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(load, 15000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(() => props.id, load);
const kind = (s: string) =>
  ({
    jev: "Jev 全链路",
    research_model: "研究模型",
    desk_model: "主 Agent",
    quick_model: "快速模型",
    http: "来源抓取",
    search: "搜索",
    firecrawl: "Firecrawl",
    image: "图片",
  })[s] ?? s;
</script>
<template>
  <section v-if="detail" class="inspection" data-testid="sweep-inspection">
    <h3>持久执行与费用</h3>
    <p>提交关联：{{ detail.submission ?? "旧版记录" }} · 重启后复用本轮上下文与稳定提交标识</p>
    <div class="cost-rows">
      <article v-for="row in detail.costs" :key="row.kind" class="cost-row">
        <strong>{{ kind(row.kind) }}</strong
        ><span>{{ row.requests }} 次请求</span
        ><span>报告 {{ usd(row.reported_usd) }} / 估算 {{ usd(row.estimated_usd) }}</span
        ><span :class="{ bad: row.unknown_cost_attempts > 0 }"
          >费用未知 {{ row.unknown_cost_attempts }} 次 · 执行未知
          {{ row.unknown_execution_attempts }} 次</span
        ><span>费用覆盖 {{ Math.round(row.cost_coverage * 100) }}%</span>
      </article>
    </div>
    <p class="muted small">
      报告与估算分开累计；mock 为离线零费用。未知费用不计作零，缓存引用不重复计费。
    </p>
    <details>
      <summary>条目处置与来源错误</summary>
      <JsonView :value="{ 条目: detail.items, 来源: detail.sources }" />
    </details>
    <h3>Jev 判断与尝试记录</h3>
    <details
      v-for="judgment in detail.judgments"
      :key="String(judgment.operation_key)"
      class="judgment-row"
    >
      <summary>
        <strong>{{ judgment.command }}</strong> · v{{ judgment.command_version ?? "legacy" }} ·
        {{ judgment.status }} ·
        {{ judgment.cache_source_operation ? "缓存引用" : `${judgment.attempts ?? 0} 次尝试` }}
      </summary>
      <p class="mono small">
        context #{{ judgment.context_id ?? "legacy" }} · {{ judgment.operation_key }}
      </p>
      <JsonView :value="judgment" />
    </details>
    <button v-if="detail.next" class="button secondary" @click="more">加载更早判断</button>
  </section>
</template>
