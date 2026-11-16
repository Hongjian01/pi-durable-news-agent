# AgentRadar 开发评测资料 · 2026-11-12

此版本以 Codex 对两个现有资料包的判断作为银标。适合比较模型与参考标注的差异，定位筛选、去重和证据判断问题。所有题目均为 exposed_diagnostic。两个原语料包的 dev/test、正文、许可、采集信息与编号保留原义。独立人工复核数为 0。

- [180 条真实来源标注](public-doc-updates-v1.jsonl) 对应 AgentScope Java、Pydantic AI 和 NumPy 文档。按技术情报读者的需求，156 条标作有用。25 条同版本同主题的双语文档标作重复。不同章节描述同一产品时仍可能提供独立技术信息。
- [160 条合成工程标注](engineering-v1.jsonl) 覆盖 80 个双条目事件组，其中 60 对重复、10 对后续反证、10 对版本进展。基于已知模板类别标注，只用于回归和演示。
- [56 个声明判断案例](claim-evidence.jsonl) 包含 12 个真实来源各派生的三种语义表述，以及 10 组合成的肯定/撤回公告各派生的两种判断。共 12 个 supported、22 个 unsupported、12 个 insufficient、10 个 conflicting。后者检查来源立场是否相互矛盾；撰写最新新闻时还须说明后续撤回。每题包括参考判定及证据；向被测模型只提供 claim 和 evidence。
- [6 个取证任务](tasks.jsonl) 每题有同一原 split 的 12 个候选快照对应条目。用 sampleId 回查原 samples.jsonl、snapshots.jsonl 构建输入。每题要求最多一张卡片，覆盖权限、工具筛选、草稿日期、持久快照、子任务预算与 SSH 工作区。[评分答案](task-keys.jsonl) 保存必需事实、替代证据要求、禁止声明与终态断言。

## 标签如何使用

以 sampleId 和 snapshotHash 连接到原始正文。读取 label 下的 relevant、useful、importance、hfs、relation、duplicateOf。引用位置使用 Python Unicode 码点的左闭右开区间，JS 读取时用 Array.from(body).slice(startCodePoint,endCodePoint).join('')。不要直接当作 JS UTF-16 偏移。每条的 rationale 与 evidence 应一起展示。

标注方法包括按来源及用途审阅标题、正文节选、文档说明，按主题归类赋分，按同版本中英对应路径或合成事件组定位重复代表。HFS 和 importance 为粗粒度参考。文档修改时间无法单独证明功能刚发布；真实资料中的 useful 衡量对目标读者的技术使用价值，线上新事件召回需要历史版本对照。按路径识别的双语重复仍可能有翻译滞后或局部差异。合成案例和真实文档的质量指标分别计算。

例如发布草稿的准备日期有正文依据，可以得分；“当日已向所有客户开放”在同一证据下得 insufficient。若评分器一律接受含有正确日期的答案，这个成对样例会直接暴露误判。在评估公开模型和策略时，把结果表述为“与本版银标的一致率”。独立人员未参与该版，不能计算其与标注者的一致率。

本包与 M4 的人工签名型 import-annotations 格式用途不同。以 sidecar 连接方式消费，保留生产者身份。正式的跨事件留出、600 条来源配额、300 条声明与 80 个完整任务仍按主方案建设。

## 已执行的离线诊断

从仓库根目录运行 `python evaluation/annotations/2026-11-12/score_fixture.py` 可重算[18 个历史组次的分子分母](fixture-scores.json)。脚本读原始 M4 预测，用本版合成工程标签按文档重计。以 test 第一次为例，A 选中 120 条中的 88 条有用文档，B 选中 6 条中的 5 条，C 选中 6 条中的 4 条。B 的组合门控放行 88 条参考有用文档中的 50 条。三组均以 no_news 结束。这里的计数单位是文档，转载亦分别计数，独立事件交付收益需另测。在 mock 后端得到的差异仅用于检验指标、归因和报告流程。
