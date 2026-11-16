<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import type { Sweep } from "@dna/sdk";
import { api, attempt, connection, feedState } from "../client/store";
import { go } from "../client/route";
import { activeSweep, statusName, phaseName, localTime } from "../client/product";
const scans = ref<Sweep[]>([]),
  sending = ref(false),
  pendingId = ref<string>();
watch(
  () => feedState.value.sweeps,
  (rows) => {
    scans.value = [...rows].sort((a, b) => b.id - a.id);
  },
);
const latest = computed(() => scans.value.find(activeSweep) ?? scans.value[0]);
const refresh = async () => {
  const rows = await api.sweeps({ limit: 10 }).catch(() => undefined);
  if (rows) scans.value = rows;
};
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void refresh();
  timer = setInterval(refresh, 3000);
});
onBeforeUnmount(() => clearInterval(timer));
async function start() {
  sending.value = true;
  pendingId.value ??= crypto.randomUUID();
  const result = await attempt(() => api.startSweep(pendingId.value!));
  if (result) pendingId.value = undefined;
  sending.value = false;
  await refresh();
}
async function cancel() {
  if (latest.value) {
    await attempt(() => api.cancelSweep(latest.value!.id));
    await refresh();
  }
}
</script>
<template>
  <section class="scan-panel" aria-label="扫描控制" data-testid="scan-panel">
    <div class="scan-heading">
      <div>
        <span class="eyebrow">AGENT INTELLIGENCE / 技术情报</span>
        <h1>发现变化，查验来源。</h1>
        <p>Durable 执行 · Jev 六类判断 · 受控研究 Agent</p>
      </div>
      <button
        class="button"
        data-testid="manual-scan"
        :disabled="sending || !!(latest && activeSweep(latest))"
        @click="start"
      >
        {{ sending ? "正在提交…" : pendingId ? "重试本次提交" : "立即扫描" }}
      </button>
    </div>
    <p v-if="connection !== 'live'" class="muted" role="status">
      正在重连，连接恢复后从服务端重新读取进度。
    </p>
    <div v-if="latest" class="scan-progress" :data-status="latest.status">
      <button class="link" @click="go(`/executions/sweep/${latest.id}`)">
        扫描 #{{ latest.id }} · {{ statusName(latest.status) }}
      </button>
      <span v-if="latest.status === 'queued'">提交状态由持久记录对账恢复</span>
      <span v-else-if="latest.waitReason"
        >{{ latest.waitReason === "retry" ? "等待重试" : latest.waitReason
        }}<template v-if="latest.nextWakeAt">
          · 下次尝试 {{ localTime(latest.nextWakeAt) }}</template
        ></span
      >
      <span v-else>{{ phaseName(latest.phases.at(-1)?.phase ?? "research") }}</span>
      <span>发现 {{ latest.gathered }} → 保留 {{ latest.kept }} → 发布 {{ latest.presented }}</span>
      <button
        v-if="activeSweep(latest) && latest.status !== 'cancelling'"
        class="button secondary small"
        data-testid="cancel-scan"
        @click="cancel"
      >
        取消扫描
      </button>
    </div>
    <p v-if="latest?.audit?.missing.length" class="bad">
      处理缺口：{{ latest.audit.missing.join("；") }}
    </p>
    <p v-if="latest?.reason || latest?.error" class="muted">{{ latest.reason ?? latest.error }}</p>
    <p v-if="latest?.status === 'no_news'" class="muted">
      本轮来源与必要处理已结束；可能全部重复、被筛选，或没有足够来源证据。详情可查看条目处置。
    </p>
  </section>
</template>
