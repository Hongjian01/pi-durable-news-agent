# 剩余四项的实施与操作

2026-11-17。全部模型辅助审核记录保持 humanReviewed=false、independent=false。核心运行修复为 028b8d2，两题追踪配置修复为 43a5bb3；以下区分历史结果、最新代码验证及尚需业务使用证明的部分。

## 已执行的结果

- 实现提交 69864e7，真实运行 [44030087132](https://github.com/Hongjian01/pi-durable-news-agent/actions/runs/44030087132)：复评七题全部 passed，最终严格门禁通过，自动失败队列为零。
- 初版八例校准 4/8；将相关性与事实支持拆成物理隔离状态后为 7/8；澄清“回答所问范围”与“提供完整教程”的区别，并增加八例能力/操作细节、缺失机制及否定反例后，运行 [44082021485](https://github.com/Hongjian01/pi-durable-news-agent/actions/runs/44082021485) 的 publication-v2 达 16/16。随后运行 44083620574 重复为 15/16，resume-positive 的相关性为 0.79，低于 0.8。原有八题标签和阈值未改。单次成功不等于稳定校准，eligibleForEnforcement 显式为 false，不据此开启生产硬阻断。
- 实际两例失败已完成模型辅助审核、脱敏版本入库、可执行配置编译和一键回归/复评/追踪。PR 自动运行免费烟测，真实工作流执行相同两题及同模型复评；等待复评不冒充修复成功。脱敏改变来源正文时保留原哈希和新哈希；输入文档、完整题面和预算条件漂移会标 input_mismatch。
- 生产负反馈通过数据库迁移自动写入持久审核队列，保存反馈 ID 引用，不复制私人 note。应用启动迁移会回填历史负反馈，重启不丢队列；没有真实用户反馈时不伪造线上修复效果。

## 1. 发布检查校准

保留 publication-v1 八条挑战原样；当前 publication-v2 包含它们及八个扩展反例，覆盖未请求操作细节与明确请求具体命令的区别、多项能力缺失、候选集合机制遗漏、跨语言改写和否定反转。没有把旧失败输出改成标准答案。题库都由模型辅助准备、已暴露，不能用于独立准确率估计。

```bash
node --import tsx scripts/eval-tasks/calibrate-publication.mjs --enable-paid --check --out "test-results/publication-calibration-$(date +%s)"
```

必须明确付费与供应商额度检查。每例分别判断相关性和事实支持，共最多 32 次请求、单次不重试，逐样本保存渲染输入、answers、usage、解析 model、费用元数据、题库和命令 hash。每次真实评测运行并归档，也可手动触发 Publication calibration only；后者使用 --check，任一失配会失败。前者观察式记录诊断匹配率，最终七题质量门禁仍严格阻断。observe 不代表通过了生产语义准入。

## 2. 核心事实与引用保障

定向取证（selectionMode=evidence）最终渲染为服务端生成的 brief：标题使用来源身份，正文仅来自当前候选最终 supported 声明；verifiedClaims/引用仍由服务端生成。主模型原始提交保留在工具日志，未验证的 why/action/summary 不混入实际卡片。新闻默认模式不改变。

该方法提供“交付事实来自验证记录”的确定性约束，但无法形式化保证判断模型不会误认证，或选材永远覆盖问题；最终独立阶段的语义评分与严格七题门禁仍必需。

并发发布在最后一次 await 之后同步重查容量，防止两个候选都通过早期检查后各发布一张卡。已加入控制并发交错的回归测试。

长来源使用章节导航的绝对 UTF-16 位置定位正文，代码示例中的伪标题不进入导航。章节索引只帮助定位，不作为证据。原文快照的 sourceTruncated 与正常局部窗口 contextIsExcerpt 分开；真实来源截断仍直接拒绝进入支持判断。report_findings 返回支持/充分性/冲突概率，并提示补主语或简化到用户所需的最小能力，而不是对同一缺失上下文反复同义改写。

## 3. 真实验收状态

历史结果全部保留：

- 479b88f / 44028770091：6/7，pilot-01 把 PASSTHROUGH 构造方法误算为第四种最终决策。
- 69864e7 / 44030087132：7/7 开发回归通过。
- 3d1d611 / 44053802406：6/7，pilot-02 漏掉候选集合机制。说明一次 7/7 不等于长期稳定。
- 96a01b9：免费烟测暴露异步发布容量竞态；单独校准首次创建输出父目录失败。1f384bd 已修复，免费云端运行 44081161494 通过。
- 45d4219 / 44082021485：5/7，pilot-02 修正后通过；pilot-04 浏览耗尽预算后两次报告引文错误，零卡 partial；pilot-05 模型配置的充分性被拒绝后丢弃核心事实。校准 16/16，但真实任务失败，明确证明两类验收不能混同。
- 028b8d2：改进来源上下文语义与导航、最小交付、回流追踪；本地类型检查、46/46 离线测试、七题及两题回流免费烟测通过。[免费 CI 44083588214](https://github.com/Hongjian01/pi-durable-news-agent/actions/runs/44083588214) 通过。
- [真实运行 44083620574](https://github.com/Hongjian01/pi-durable-news-agent/actions/runs/44083620574)：七题复评 7/7，严格七题门禁通过；整个 workflow 仍为 failure，因为新增两题步骤漏传 DNA_COST_ALERT_USD，在模型调用之前退出，并非两题内容失败。43a5bb3 已修复告警环境传递并增加只验证这两题的手动 workflow，不重复七题生成。
- 43a5bb3：[免费 CI 44084503066](https://github.com/Hongjian01/pi-durable-news-agent/actions/runs/44084503066) 通过；[两题定向真实验证 44084542147](https://github.com/Hongjian01/pi-durable-news-agent/actions/runs/44084542147) 整体成功，pilot-02、pilot-05 均复评 passed，完整题面和正文一致，tracking 均为 resolved_in_this_run。它们与上一条七题属于分开的运行，不能拼成单轮“9/9”或称旧红色 workflow 已转绿。

后续新实现使用新提交和新报告验收，不以旧成功覆盖新失败。当前定向实验仍为 K=2，生产默认候选数未改。

## 4. 生产与评测失败回流

### 自动采集

GitHub 真实复评完成后，失败与 needs_review 自动导出到 artifact/feedback-queue。合并复评结果，避免原始 needs_review 但已复评通过的题被误报。

已审核回归另存 feedback-regression-queue；它与原始七题候选队列分开，避免将不同输入版本混为同一失败。两题回归不会因为七题门禁失败而丢失独立验证机会。

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

审核工具默认提供实际已引文档的完整正文，或在无有效来源关联时提供完整候选池；显式记录选择范围，绝不静默截取正文前缀。超过 150000 字符会要求显式整理来源，失败答案与旧分数不发送为参考。privacyChecked 是模型辅助检查，范围以 evidenceScope 为准，不构成整池或所有隐私的人工认证；来源不足应拒绝提升。

### 重测与效果追踪

```bash
npm run eval:tasks -- --config evaluation/regressions/feedback-v2/experiment.json --out NEW_RUN
npm run eval:regrade -- --input NEW_RUN --out NEW_REVIEW
node scripts/eval-tasks/feedback-loop.mjs --action track --input evaluation/regressions/feedback-v2 --experiment NEW_RUN --review NEW_REVIEW --out NEW_TRACKING
```

默认免费流程验证管线，语义未审核时追踪为 awaiting_review。付费需显式添加 live/enable-paid/预算及 judge 参数。状态包括 input_mismatch、not_exercised、awaiting_review、recurred、resolved_in_this_run。输入不同不能声称修复；一次成功只表示本轮解决，不能证明永久稳定。生产中有新用户反馈后，重复这条管线，统计同类失败变化；没有真实反馈时不补造线上改善数据。

一键执行现有两题：

```bash
node scripts/eval-tasks/feedback-regressions.mjs --out "test-results/feedback-smoke-$(date +%s)"
# 真实模型；另需两个环境密钥，DeepSeek 费用不在 OpenRouter $1 范围内
node scripts/eval-tasks/feedback-regressions.mjs --live --enable-paid --out "test-results/feedback-live-$(date +%s)"
```

云端可单独触发 Reviewed feedback regressions only，勾选付费确认；该入口只运行两题及复评/追踪，仍限定默认分支和已有 Secrets 环境。每日主工作流自动包含同一组验证。

已有 SQLite 启动迁移会创建队列，不需要另配数据库服务。必须使用实际生产库路径；CI 的每题双库是隔离实验库，不是产品用户数据。

## 5. 负责人仍需做的事

1. 维护现有 Secrets 有效性和两个供应商的余额/额度；这些已配置，本轮无需重新输入密钥。
2. 实际使用产品并提供有意义的反馈。当前已完成工程闭环，尚无真实业务样本证明线上同类失败率下降。
3. 若以后要宣称独立验收，再准备未暴露任务与独立评分/人员复核。按本轮授权继续同模型辅助开发评审，无需现在安排真人复核。

发布诊断保持 observe。启用生产硬阻断之前，需要新增未暴露的正反例、重复运行并评估误拦截及循环代价；16/16 开发挑战不替代这项质量证据。

## 6. 合并门禁配置

仅 workflow 返回失败还不足以阻止合并。main 的必需检查应绑定 GitHub Actions（app_id=15368）的 `Agent evaluation / offline`，strict=true，管理员也执行，禁止强推和删除。真实付费任务保持手动/定时，不作为每次 PR 的必需付费检查。日常修改通过分支和 PR 等待免费门禁后合并；七题与两题真实评测继续单独归档，任一质量失败都使对应 job 失败。

生产反馈的工程链路和开发回归已具备，但没有实际产品反馈与重复线上观测，仍不能称“线上质量飞轮已证实有效”。同模型偏差、已暴露题和小样本也是后续要解决的质量问题，不应通过更改标签或降低门槛消除。
