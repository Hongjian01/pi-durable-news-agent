# 候选实验修复及验证

2026-11-16。旧实验、旧标签及原始评分保持不变，生产默认候选数保持不变。

## 已实施

- 显式启用 researchCandidates 的实验将研究批次展开为每个候选一个子任务，最多并发两项，三个任务由队列执行。模型上下文及每项请求预算分别绑定，不再让一个多候选研究对话的每一轮调用同时占用组内全部候选的额度。旧默认批次行为不变，请求、输出及美元限制不增加。
- 研究返回保留支持结论，并要求发布前按原始问题的每个部分比较候选。此项为模型指引，不是独立的语义硬门禁，真实发布质量尚待验证。
- 评分协议改为 coverage-separated-v4：明确接受语义等价，仍拒绝弱表述、范围变化、否定反转和遗漏。已有 36/36 属于旧评分协议结果，不能用于证明新版有效。
- 新增不可覆盖的 alignment-v1 六条模型辅助校准数据：两条等价表达，四条反例。含真实冻结来源和引用，humanReviewed=false；不是独立人工验收或未暴露测试集。

## 本地验证

- Linux Node 24.21.0 服务端 TypeScript 检查通过。
- research-plan、report-citations、grade、regrade 共 13 项离线测试通过。
- 六条新增样例的引用及非语义结构检查通过，尚未运行真实语义校准。
- 免费 fixture Top-3：三个候选分别研究完成，一张卡片，另外两项 not_published，终态 completed，审计无缺项；评分 needs_review。它验证流程执行，不能证明真实模型问题对齐或通过率提升。
- 免费结果：test-results/candidate-fix-fixture-20261116，Windows 与 WSL 均已保存。

## 接下来运行

在已导出 DEEPSEEK_API_KEY 的 Ubuntu 中执行。修复及新增数据已同步到 /var/tmp/agentradar-complete-1794537884179。

```bash
cd /var/tmp/agentradar-complete-1794537884179
npm run eval:calibrate -- --labels evaluation/calibration/alignment-v1 --suite semantic --provider deepseek --model deepseek-flash --enable-paid --check --out "test-results/alignment-calibration-$(date +%s)"
```

直接 DeepSeek 计费，OpenRouter 的 1 美元额度不覆盖这些调用。此步只运行六条校准，不重新生成 Agent 答案。

六条全部匹配且无技术错误后，再对旧 36 条运行新版评分器，确认未退化：

```bash
npm run eval:calibrate -- --labels evaluation/annotations/v4 --suite semantic --provider deepseek --model deepseek-flash --enable-paid --check --out "test-results/coverage-v4-calibration-$(date +%s)"
```

两个集合均通过后，用相邻主题题组的一个任务做一次 Top-1/2/3 真实烟测，先不做三轮：

```bash
CAMPAIGN_CONFIG=evaluation/experiment.adjacent.json CAMPAIGN_TASK=adjacent-1-1 REPEATS=1 npm run eval:candidates -- --live
```

如校准或烟测失败，保留结果并定位具体样例，不继续重复付费或修改标签以迎合输出。新增合成题组是开发诊断，后续仍需要扩大真实任务覆盖才可选择默认配置。
