<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from "vue";
import type { EvaluationRecord } from "@dna/sdk";
import { api } from "../client/store";
import { route, go } from "../client/route";
import JsonView from "./JsonView.vue";
const jobs = ref<EvaluationRecord[]>([]),
  error = ref(""),
  busy = ref(false),
  repeat = ref(1);
const components = ref(true),
  compare = ref(false),
  security = ref(false),
  reliability = ref(false);
const chosen = ref(""),
  trial = ref<Record<string, unknown>>(),
  loadingTrial = ref(false);
const selected = computed(() => jobs.value.find((job) => job.id === chosen.value));
const active = computed(() =>
  jobs.value.some((job) => ["queued", "running"].includes(job.progress.status)),
);
const requestId = ref<string>();
let timer: ReturnType<typeof setInterval>;
async function refresh() {
  try {
    jobs.value = await api.evaluations();
    const current = route.value;
    if (current.view === "evaluations" && current.id) chosen.value = current.id;
    if (!chosen.value && jobs.value[0]) chosen.value = jobs.value[0].id;
  } catch (e) {
    error.value = String(e);
  }
}
async function start() {
  busy.value = true;
  error.value = "";
  requestId.value ??= crypto.randomUUID();
  try {
    const job = await api.startEvaluation({
      requestId: requestId.value,
      repeat: repeat.value,
      components: components.value,
      compare: compare.value,
      security: security.value,
      reliability: reliability.value,
    });
    requestId.value = undefined;
    chosen.value = job.id;
    go("/evaluations/" + job.id);
    await refresh();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
async function control(action: "cancel" | "resume") {
  if (!selected.value) return;
  busy.value = true;
  try {
    if (action === "cancel") await api.cancelEvaluation(selected.value.id);
    else await api.resumeEvaluation(selected.value.id);
    await refresh();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
async function openTrial(artifact: string) {
  if (!selected.value) return;
  loadingTrial.value = true;
  try {
    trial.value = await api.evaluationTrial(selected.value.id, artifact);
  } catch (e) {
    error.value = String(e);
  } finally {
    loadingTrial.value = false;
  }
}
function select(id: string) {
  chosen.value = id;
  trial.value = undefined;
  go("/evaluations/" + id);
}
onMounted(() => {
  void refresh();
  timer = setInterval(refresh, 2000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>
<template>
  <section class="eval-page" aria-label="评测中心" role="dialog">
    <header class="eval-heading">
      <div>
        <h1>评测中心</h1>
        <p class="muted">冻结来源 · 隔离执行 · 逐项核验</p>
      </div>
      <button class="button secondary" @click="go('/')">返回情报</button>
    </header>
    <form class="eval-controls" @submit.prevent="start">
      <label
        >重复次数
        <select v-model.number="repeat">
          <option v-for="n in [1, 2, 3, 5]" :key="n" :value="n">{{ n }}</option>
        </select></label
      >
      <label><input type="checkbox" v-model="components" /> 六类组件</label>
      <label><input type="checkbox" v-model="compare" /> A/B/C 策略</label>
      <label><input type="checkbox" v-model="security" /> 注入挑战</label>
      <label><input type="checkbox" v-model="reliability" /> 故障恢复回归</label>
      <button class="button" :disabled="busy || active">
        {{ busy ? "正在提交…" : "运行离线评测" }}
      </button>
    </form>
    <p class="muted small">
      此入口使用模拟模型和已公开的参考标签。真实模型实验通过 CLI 配置模型与费用预算。
    </p>
    <p v-if="error" role="alert" class="bad">{{ error }}</p>
    <div class="eval-layout">
      <nav class="eval-history" aria-label="评测历史">
        <button
          v-for="job in jobs"
          :key="job.id"
          :class="{ selected: job.id === chosen }"
          @click="select(job.id)"
        >
          <strong>{{ new Date(job.createdAt).toLocaleString() }}</strong
          ><span>{{ job.progress.status }}</span>
          <small
            >{{ job.id.slice(0, 8) }} · {{ job.progress.completed ?? 0 }} /
            {{ job.progress.total ?? "—" }}</small
          >
        </button>
        <p v-if="!jobs.length" class="muted">启动一次评测后，将在此显示进度和结果。</p>
      </nav>
      <article v-if="selected" class="eval-detail">
        <div class="eval-result-heading">
          <h2>
            {{ selected.progress.status }} · {{ selected.progress.completed ?? 0 }} /
            {{ selected.progress.total ?? "—" }}
          </h2>
          <button
            v-if="['running', 'queued'].includes(selected.progress.status)"
            class="button secondary"
            :disabled="busy"
            @click="control('cancel')"
          >
            取消
          </button>
          <button
            v-else
            class="button secondary"
            :disabled="busy || active"
            @click="control('resume')"
          >
            续跑未完成项
          </button>
        </div>
        <p v-if="selected.progress.error" class="bad">{{ selected.progress.error }}</p>
        <template v-if="selected.summary">
          <div class="eval-counts">
            <div v-for="(count, name) in selected.summary.counts" :key="name">
              <strong>{{ count }}</strong
              ><span>{{ name }}</span>
            </div>
          </div>
          <details v-if="selected.summary.components">
            <summary>组件指标与置信区间</summary>
            <JsonView :value="selected.summary.components" />
          </details>
          <details v-if="selected.summary.comparisons">
            <summary>任务配对比较</summary>
            <JsonView :value="selected.summary.comparisons" />
          </details>
          <details v-if="selected.summary.diagnostics">
            <summary>故障恢复验证</summary>
            <JsonView :value="selected.summary.diagnostics" />
          </details>
          <details v-if="selected.summary.securityPairs">
            <summary>攻击与干净任务比较</summary>
            <JsonView :value="selected.summary.securityPairs" />
          </details>
          <div class="eval-trials">
            <button
              v-for="row in selected.summary.results"
              :key="row.artifact"
              @click="openTrial(row.artifact)"
            >
              <span
                >{{ row.taskId }} · {{ row.arm }} · {{ row.variant }} · 第 {{ row.trial }} 次</span
              ><strong>{{ row.outcome }}</strong>
            </button>
          </div>
          <p v-if="loadingTrial">读取证据…</p>
          <section v-if="trial">
            <h3>本次试验的输入、输出与评分依据</h3>
            <JsonView :value="trial" />
          </section>
        </template>
      </article>
    </div>
  </section>
</template>
<style scoped>
.eval-page {
  position: fixed;
  inset: 52px 0 0;
  background: var(--bg);
  z-index: 30;
  padding: 24px 32px;
  overflow: auto;
}
.eval-heading,
.eval-result-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}
h1 {
  font-size: 24px;
  margin: 0;
}
h2 {
  font-size: 18px;
}
.eval-heading p {
  margin: 4px 0 16px;
}
.eval-controls {
  display: flex;
  gap: 18px;
  align-items: center;
  flex-wrap: wrap;
  padding: 16px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.eval-controls label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.eval-layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 32px;
  margin-top: 24px;
}
.eval-history {
  border-right: 1px solid var(--line);
  padding-right: 18px;
}
.eval-history button {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  padding: 14px 12px;
  width: 100%;
  border-bottom: 1px solid var(--line);
}
.eval-history button.selected {
  background: var(--panel);
  border-left: 2px solid var(--accent);
}
.eval-counts {
  display: flex;
  gap: 28px;
  padding: 20px 0;
  border-bottom: 1px solid var(--line);
}
.eval-counts div {
  display: flex;
  flex-direction: column;
}
.eval-counts strong {
  font-size: 24px;
}
.eval-trials {
  margin: 20px 0;
}
.eval-trials button {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
  padding: 12px 0;
  width: 100%;
  border-bottom: 1px solid var(--line);
}
details {
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
small,
.eval-counts span {
  color: var(--muted);
}
@media (max-width: 800px) {
  .eval-page {
    padding: 20px 16px;
  }
  .eval-layout {
    grid-template-columns: 1fr;
  }
  .eval-history {
    border-right: 0;
  }
  .eval-counts {
    flex-wrap: wrap;
  }
}
</style>
