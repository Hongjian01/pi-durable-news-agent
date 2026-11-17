# 剩余四项的实施与操作

2026-11-17。全部模型辅助审核记录保持 humanReviewed=false、independent=false。

## 已执行的结果

- 实现提交 69864e7，真实运行 [44030087132](https://github.com/Hongjian01/pi-durable-news-agent/actions/runs/44030087132)：复评七题全部 passed，最终严格门禁通过，自动失败队列为零。
- 八例前置诊断校准完成，但仅 4/8 整例匹配。未降低阈值或修改标签来迎合输出，当前不具备启用硬阻断的资格。校准工具、报告和自动执行已完成，诊断模型质量仍是已知局限。
- 实际两例失败已完成模型辅助审核、脱敏版本入库、可执行配置编译、免费重测和 pending 状态追踪。脱敏改变来源正文时，保留原哈希和新哈希；不能将不同输入的成功合并为原任务的精确重放。
- 生产负反馈通过数据库迁移自动写入持久审核队列，保存反馈 ID 引用，不复制私人 note。应用启动迁移会回填历史负反馈，重启不丢队列；没有真实用户反馈时不伪造线上修复效果。

## 1. 发布检查校准

新增 publication-v1 八条挑战：正常恢复、相邻权限主题、预算有证据但模型缺证据、完整模型配置、工具筛选正例与否定反转、草稿正确限定与过度发布主张。没有把旧失败输出改成标准答案。

```bash
node --import tsx scripts/eval-tasks/calibrate-publication.mjs --enable-paid --check --out "test-results/publication-calibration-$(date +%s)"
```

必须明确付费与供应商额度检查，最多八次请求、单次不重试，逐样本保存实际 answers/usage/model 和命令 hash。GitHub 每次真实评测会运行本集合并归档。当前发布命令仍 observe：开发挑战全通过也不自动证明其能作为普遍硬门禁，先保留覆盖不足的说明，严禁盲目回到引发循环的 enforce。

## 2. 核心事实与引用保障

定向取证（selectionMode=evidence）最终渲染为服务端生成的 brief：标题使用来源身份，正文仅来自当前候选最终 supported 声明；verifiedClaims/引用仍由服务端生成。主模型原始提交保留在工具日志，未验证的 why/action/summary 不混入实际卡片。新闻默认模式不改变。

该方法提供“交付事实来自验证记录”的确定性约束，但无法形式化保证判断模型不会误认证，或选材永远覆盖问题；最终独立阶段的语义评分与严格七题门禁仍必需。

## 3. 真实验收状态

479b88f 已实测，运行 44028770091：6 passed、pilot-01 failed。pilot-02/05 本轮通过；pilot-01 将 PASSTHROUGH 构造方法误算为第四种最终决策。不能把“最新版已真实运行”写成“最新版全部通过”。后续新实现以新提交的新报告验收，旧报告不覆盖。

## 4. 生产与评测失败回流

### 自动采集

GitHub 真实复评完成后，失败与 needs_review 自动导出到 artifact/feedback-queue。合并复评结果，避免原始 needs_review 但已复评通过的题被误报。

本地生产反馈（应用的真实 SQLite，可安全只读）：

```bash
node scripts/eval-tasks/capture-production-feedback.mjs --database data/dna.sqlite --out "test-results/production-feedback-$(date +%s)"
```

采集 less 与包含 note 的反馈，绑定原卡片和来源快照；去敏 credential/token/email/URL 用户信息和查询参数，按内容 hash 去重，保留事件分组。模式去敏不等于所有隐私已可靠清理，仍需来源与内容复核。

### 审核与提升

```bash
node scripts/eval-tasks/feedback-loop.mjs --action capture --input ORIGINAL_RUN --review ORIGINAL_REVIEW --out NEW_QUEUE
node scripts/eval-tasks/review-feedback.mjs --input NEW_QUEUE --out DECISIONS_JSONL --enable-paid
node scripts/eval-tasks/feedback-loop.mjs --action promote --input NEW_QUEUE --decisions DECISIONS_JSONL --out NEW_VERSION
```

decisions 每行必须含 caseId、fingerprint、decision=accept/reject、origin=model_assisted、reviewer、rationale、privacyChecked=true 和审核后的 key。key 必须对应任务、有 requiredFacts 和有效 referenceEvidence；引用/hash/原文范围验证失败则拒绝入库。脱敏后的正文重新计算 hash，保留 originalBodyHash，不能伪装成原样来源。

新版本同时产出可加载 corpus、labels、experiment.json；不是只有一个无法执行的队列。未审核样本不自动提升。已有两条实际失败按保留的事实和引用审核为 `evaluation/regressions/feedback-v2`，它们是已暴露模型辅助回归题，非独立盲测。feedback-v1 是调试中未完成版本，不应发布或使用。

### 重测与效果追踪

```bash
npm run eval:tasks -- --config evaluation/regressions/feedback-v2/experiment.json --out NEW_RUN
npm run eval:regrade -- --input NEW_RUN --out NEW_REVIEW
node scripts/eval-tasks/feedback-loop.mjs --action track --input evaluation/regressions/feedback-v2 --experiment NEW_RUN --review NEW_REVIEW --out NEW_TRACKING
```

默认免费流程验证管线，语义未审核时追踪为 awaiting_review。付费需显式添加 live/enable-paid/预算及 judge 参数。状态包括 input_mismatch、not_exercised、awaiting_review、recurred、resolved_in_this_run。输入不同不能声称修复；一次成功只表示本轮解决，不能证明永久稳定。生产中有新用户反馈后，重复这条管线，统计同类失败变化；没有真实反馈时不补造线上改善数据。
