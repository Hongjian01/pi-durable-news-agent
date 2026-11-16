<script setup lang="ts">
import { computed } from "vue";
import { localTime } from "../client/product";
const props = defineProps<{ value: Record<string, unknown> }>();
interface Claim {
  claimId: number;
  text: string;
  supportStatus: string;
  operationId: string;
  sources: {
    snapshotId: number;
    url: string;
    bodyHash: string;
    quote: string;
    start: number;
    end: number;
    fetchedAt: string;
  }[];
}
const claims = computed(
  () => (Array.isArray(props.value.verifiedClaims) ? props.value.verifiedClaims : []) as Claim[],
);
</script>
<template>
  <section class="evidence-panel" data-testid="source-evidence">
    <h3>
      已核验于来源 <small>{{ claims.length }} 条声明</small>
    </h3>
    <p class="muted small">表示下列材料支持该声明，不代表已证明事实绝对真实。</p>
    <p v-if="!claims.length" class="muted">历史卡片没有逐声明证据记录，未标为已核验。</p>
    <article v-for="claim in claims" :key="claim.claimId" class="evidence-claim">
      <strong>{{ claim.text }}</strong>
      <details v-for="source in claim.sources" :key="source.snapshotId">
        <summary>来源快照 #{{ source.snapshotId }} · {{ localTime(source.fetchedAt) }}</summary>
        <blockquote>{{ source.quote }}</blockquote>
        <a :href="source.url" target="_blank" rel="noopener noreferrer">打开原文</a>
        <p class="mono small">
          SHA256 {{ source.bodyHash }}<br />正文区间 {{ source.start }}–{{ source.end }}（UTF-16）
        </p>
        <p class="mono small">{{ claim.operationId }}</p>
      </details>
    </article>
    <p v-if="claims.length" class="muted small">卡片其余内容为研究分析；核验范围仅包含以上声明。</p>
  </section>
</template>
