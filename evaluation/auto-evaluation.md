# 运行自动评测

2026-11-15 七题真实实验逐题复核、定向问答排序与长文读取修复见 [BATCH-bfd6dd46-REVIEW.md](BATCH-bfd6dd46-REVIEW.md)。新增 `eval:regrade -- --input 原实验目录 --out 新复核目录`，默认仅准备离线复核包；显式指定 judge-model 并授权付费后，只对已保存卡片执行语义评分，不重跑 Agent。

## 2026-11-13 扩展入口

默认使用 evaluation/annotations/v3，包含六个取证任务、一个合法无新闻任务和 48 个评分器正反例。旧版本资料保留。

```sh
npm run eval:calibrate
npm run eval:auto -- --config evaluation/experiment.example.json
npm run eval:tasks -- --compare --repeat 3
npm run eval:capture -- --input EXPERIMENT_DIRECTORY --out NEW_REVIEW_DIRECTORY
```

--config 的配置优先于默认值，显式 CLI 选项覆盖配置。--out 指定新结果目录，--resume 指定已有结果目录。续跑时使用相同的配置及选项，代码、数据或协议指纹变化会被拒绝。技术失败重新建立 attempt 目录，历史尝试保留。已完成的质量失败继续使用原结果。

评测结果现在按 task-variant-arm-trial/attempt-N 保存，单项 result.json 指向实际产物。progress.json 持久保存进度，支持 SIGTERM/SIGINT 取消。--check 同时检查内容质量门槛和运行错误。

组件评测覆盖 relevance/worth、事件关系、中文候选召回、importance 排序、HFS 三轴误差和声明四分类。独立事件、语种与错误数分别可查。关系精度是给定历史配对的诊断，候选检索另外报告。语料池排序为诊断统计，正式用户偏好比较应使用任务级标注。组件通过冻结 context 和 submission intent 进入生产 Operations，原始尝试保存在 attempts.json。

--compare 调用已有的独立策略服务 runner 执行 A/B/C。A 扩大研究预算，B 使用 Jev 策略，C 按时间选同 K。服务层生成的卡片按固定交付容量投影，完整原始副作用保留在 arm/dna.sqlite，报告标记 scope=strategy_services。普通任务运行标记 production_workflow。两类结果各自解释。

--security 对任务冻结正文注入三个模板，比较对应干净版本，并记录攻击目标、违规来源和业务输出。--reliability 执行原有四套恢复与上下文测试，保存每套日志和通过状态。

网页增加“评测中心”，路由为 /#/evaluations。可启动模拟评测、查看进度、取消、续跑和展开某个 trial 的输入/输出/评分。网页使用业务 dataDir 下独立的 evaluations 目录。真实付费实验使用 CLI 和明确的模型/预算设置。

主 Agent 与研究模型现支持 `--provider deepseek` 官方直连（`DEEPSEEK_API_KEY`，模型 `deepseek-flash` 或 `deepseek-v4-pro`）；默认 `--provider openrouter` 保持原行为。Jev 和可选 judge 继续使用 `OPENROUTER_API_KEY`。直连时 `--max-usd` 只覆盖 OpenRouter 侧，DeepSeek 官方账户需单独控制消费。完整步骤及 SQLite 自动建库说明见 [ACCOUNT-SETUP.md](ACCOUNT-SETUP.md)。CLI 不自动加载 `.env`，需在运行 shell 中 export 变量。

GitHub Actions 工作流为 .github/workflows/evaluation.yml。提交后会执行评分器测试、校准回归、离线任务及 API 验收，并上传报告。远程 CI 实际结果以仓库中的运行记录为准。

额度范围默认为 `--budget-scope including-byok`。若普通密钥界面无包含 BYOK 的选项，可显式选择 `--budget-scope openrouter-credits`，仍要求正数、无重置且不超过 `--max-usd` 的供应商余额消费额度，但 BYOK 与直连供应商费用不在该范围。选择会记录到实验 settings 和 manifest 中。

以下为早期入口的基础说明，路径与数据版本以本节为准。

在本仓库根目录的 Linux 或 WSL 环境下，使用 Linux Node 24、npm 和本仓库锁定的 Linux 依赖。首次安装运行 `npm ci`。每次运行自动建立新的结果目录。

```sh
npm run eval:auto
npm run eval:tasks -- --task pilot-03
npm run eval:auto -- --repeat 3 --check
```

第一条命令评测 340 条文档的 Jev relevance/worth 组合门控、56 个声明的生产 assessClaims 判定，以及 6 次完整扫描。组件批量测一次；repeat 作用于端到端任务。第二条只跑指定任务。第三条按任务统计三次全部通过的比例，并检查质量门槛。终端打印结果目录，默认位于 test-results/eval-tasks。

输入来自 2026-11-12 模型辅助标注包。真实公开文档 180 条、合成工程文档 160 条分开计算。报告中的精度分母为实际放行数，召回分母包括全部参考有用文档。声明测试验证 Unicode 码点与生产 UTF-16 引文偏移，并使用 assessClaims 的实际快照、上下文截取和四分类规则。工程语料源自重复模板，声明挑战也含成对变体；所有比例属于开发诊断。

每题冻结 12 个候选、参考时刻和任务目标。运行器把候选转为隔离的 RSS 数据源，预先按原文保存来源快照。主 Agent 和研究子 Agent 的评测提示都带任务目标。原 startNewsSweep 执行采集、判断、研究和发布；第二次提交同一 requestId 检查重放。每个 trial 有单独的执行库、业务库和日志。自动评测和网页运行实例使用独立目录。

评分器读取最终卡片，检查候选集合、卡片数、终态审计、引用哈希及区间、请求预算和重放唯一性。离线规则按参考事实或完整参考引文精确匹配关键声明。遇到改写、替代证据或主题可能不符的表述时返回 needs_review。passed 在这种模式下指列出的规则断言通过。可选语义评审还能检查整张卡片是否覆盖所需事实以及是否存在过度推断。它记录理由并核对所返回答案片段、引用片段是否真实存在。评审模型的判定仍需独立校准。

- report.md 给出命中数、分母、任务状态和逐题链接。
- summary.json、manifest.json 保存汇总、重复稳定性、运行环境和输入文件指纹。
- components/scores.json 包含每条门控预测、声明判定、混淆矩阵和质量门槛。
- 每个任务目录的 input.json 是模型可用的冻结环境；observed.json 记录卡片、工具、子任务及费用；score.json 记录断言和失败原因。worker.log 可诊断超时或运行错误。
- 技术错误返回非零退出码。默认允许带着质量失败生成报告。--check 对失败、待复核及未达标的组件指标也返回非零。组件门槛为真实文档有用召回 90%、已判支持声明精度 95%，有效分母至少 20。这些指标比较的是银标。

真实推理使用显式的 `--backend live --enable-paid --max-usd N`，可叠加 `--judge-model MODEL_ID` 指定独立语义评分模型。环境需要 OPENROUTER_API_KEY 和正数 DNA_COST_ALERT_USD。运行前会核验专用 OpenRouter 密钥具有不重置且覆盖 BYOK 的额度，其剩余额度在 N 美元以内。费用提醒与供应商密钥限额分别生效。CLI 不输出密钥。建议先用 eval:tasks 与 --task 执行一题估算实际成本。默认 fixture 不调用供应商。

使用 `node --test scripts/eval-tasks/grade.test.mjs` 验证评分器的正例和故障反例。已有策略 A/B/C 基线可通过 scripts/m4/cli.ts 的 freeze、run、report 命令运行，详见本目录 README。这里的任务工作流测试的是正常产品策略，指标和 M4 各组的服务层指标分别解释。
