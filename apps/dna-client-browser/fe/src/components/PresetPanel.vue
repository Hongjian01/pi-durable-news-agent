<script setup lang="ts">
import { ref } from "vue";
import type { PresetPreview } from "@dna/sdk";
import { api, attempt, notify } from "../client/store";
const preview = ref<PresetPreview>(),
  selected = ref<string[]>([]),
  busy = ref(false);
const emit = defineEmits<{ applied: [] }>();
async function load() {
  preview.value = await attempt(() => api.preset());
  selected.value = preview.value?.entries.filter((e) => !e.current).map((e) => e.id) ?? [];
}
async function apply() {
  if (!preview.value) return;
  busy.value = true;
  const result = await attempt(() => api.applyPreset(preview.value!.revision, selected.value));
  busy.value = false;
  if (result) {
    notify("已应用所选项；偏好从下一轮扫描生效。");
    await load();
    emit("applied");
  }
}
</script>
<template>
  <section class="preset-panel">
    <h3>开发者情报预设</h3>
    <p class="muted">
      8 个来源 · 4
      个关注主题。已有配置默认保留；勾选已有项将恢复预设权重并启用，新偏好从下一轮扫描生效。
    </p>
    <button class="button secondary" data-testid="preview-preset" @click="load">预览差异</button
    ><template v-if="preview"
      ><label v-for="entry in preview.entries" :key="entry.id" class="preset-row"
        ><input v-model="selected" type="checkbox" :value="entry.id" /><span>{{
          entry.proposed.name ?? entry.proposed.term
        }}</span
        ><small
          >{{ entry.current ? "已有：默认保留手工设置" : "新增" }} · 预设权重
          {{ entry.proposed.weight ?? 1 }}</small
        >
        <details v-if="entry.current">
          <summary>查看当前与预设</summary>
          <pre>{{ JSON.stringify({ 当前: entry.current, 预设: entry.proposed }, null, 2) }}</pre>
        </details></label
      ><button
        class="button"
        data-testid="apply-preset"
        :disabled="busy || !selected.length"
        @click="apply"
      >
        应用所选 {{ selected.length }} 项
      </button></template
    >
  </section>
</template>
