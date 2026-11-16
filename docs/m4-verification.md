# M4 评测工程验收（人工质量验收待完成）

按 `docs/SPEC.md` 第 15 节及用户“尚无，先完成评测工程与待标注集”的范围交付。本轮没有运行真实付费 API，没有升级、替换或导出已有运行数据目录。**M4 工程部分已验证，M4 真实质量发布尚未通过。**

## 实现

- 新增独立 A/B/C runner，复用 Jev 六类判断、Durable 研究子 Agent、研究提示构建、引用/声明校验、HFS 和终态核验。每次每组新建业务/执行双库及冷缓存，不通过生产扫描发布上限模拟全量。
- A 对全部合格输入研究，明确扩大研究条数和模型调用预算；B 筛选/事件关联/排序后 Top-K；C 时间排序后同 K。输入快照、研究模型/提示、输出 token 上限及下游校验一致，评测禁用额外网页获取。
- 冻结数据、referenceTime、预设、策略、六类命令、提示、请求模型、每组预算、源码和锁文件指纹；运行前和每组启动前拒绝漂移。输出记录实际研究报告、请求/解析型号、时间、技术失败、缓存及费用来源，未完成的实验不产生成功 summary。
- 加入快照只读导出、标签导入和新版本保存；校验 story cluster/正文跨集泄漏、快照哈希、过期标签、自我复核及裁决前置条件。指标保留精确分母、Wilson 区间、小样本警告、技术失败及 unknown 费用。
- 交付 `evaluation/corpora/engineering-v1`：40 dev +120 test，共 160 条自行编写的合成候选，80 个保守事件组，含 zh/en/mixed、负例、传闻、冲突来源和相邻版本。人工标签 **0**；32 条复核分配为 dev 8 / test 24，已完成复核 **0**。标注定义、HFS 0–4 rubric、真实来源导出和独立复核流程见 `evaluation/README.md` 与 `evaluation/rubric.md`。
- 完整实验发现条目录入仍写死生产候选上限 100，现改为读取原冻结 context 的候选预算，默认仍为 100；独立测试验证 100/120 两个边界和越界拒绝。独立研究绑定沿用最初 epoch，取消后的旧任务不能预留模型请求或写研究报告。

保留上游许可、包名兼容和原创归属说明；没有新增依赖。Durable 引擎、Jev 与研究子 Agent 仍是核心；评测框架与恢复/证据/预算边界属于本项目改造。没有用规则或参考标签替代真实研究链条。

## 受测环境和结果

WSL Ubuntu，Linux Node **24.21.0**，隔离副本 `/var/tmp/agentradar-m4-20261027`，沿用已经安装的锁定依赖；lock SHA256 为 `2d61a1e8410b1fba5704ad7a5d65b1be1a365e1499d1567e44f016f351939a37`。

开发集三次：A 每次选择并落库研究报告 **40** 条，B/C 每次各 **6** 条。测试集三次：A 每次 **120** 条，B/C 每次各 **6** 条。共 **18** 个隔离组次，无预测技术错误；每组最终为 `no_news`。当前 faux 研究使用既定模拟声明，未通过合成来源的发布证据门槛，因此没有新闻卡片发布。这验证全量研究与保守收敛行为，**不能证明模型质量或人工支持率**。原有正向证据发布路径继续由 API/产品测试验证。

测试集三次 fixture 时长中位数：A 5981 ms，B 2055 ms，C 415 ms；仅用于本机工程诊断，含测试并发影响，不是生产延迟对比。每组只有三次，P95 为 null。真实重复次数 **0**，人工门控召回、重复精度、中文召回与 Top-K 精度均无人工分母；实际账单费用和节省比例均为 null。`releaseReady=false` 正确保留合成数据、缺标签/复核、真实重复不足及质量样本不足等阻塞原因。

全仓免费回归全部退出码 0：

- 完整 API **171 通过、1 个付费测试跳过**（172 项，含最初 8 项 M4 测试）；随后补充候选边界断言的 M4 定向套件 **9/9 通过**。二者有重叠，不能相加为独立测试总数。
- Jev **18 通过/1 跳过**，Durable **20**，SDK **18**，Cron **8**，CLI **5**，TUI **14**，Hub **2**，独立 faux/recovery **22**，均通过。
- 旧 Web **79 项检查**、M3 产品 **24 项检查**通过，包括进程中断恢复、证据交互、取消和状态重载。类型、CLI 脚本类型、Web 构建、lint 和格式通过；lint 保留原有 **9 warning、0 error**。
- 故障矩阵继续执行真实 SIGKILL：Outbox after_commit/after_sdk_accept/before_link；gather/gate/dedupe/rank；Jev 和工具 retry_sleep；external_returned；snapshot_committed；finalization_requested。取消后旧 epoch 拒写、并发唯一发布、修复上限、迁移和双库备份恢复亦通过。详细定义沿用 M1/M2 验收文档，不以模拟崩溃代替子进程终止。
- 167 个应用/配置/脚本/测试文件与受测 Linux 副本逐文件 SHA256 一致，`git diff --check` 通过。

版本化证据：`docs/baselines/m4-engineering-results.json`、`m4-dev-fixture.json`、`m4-test-fixture.json`、`m4-protocol.json` 和 `m4-source-sha256.txt`。完整日志、冻结包、18 组双库与每组结果在 `test-results/m4-verified/`；全仓日志在 `test-results/m4-regression/`。早期 100 条候选限制失败保留在隔离副本，不计入最终通过。

## 复现与剩余工作

执行 `evaluation/README.md` 的 validate → freeze → dev → test 命令，所有输出使用新目录。独立工程测试为 `node --import tsx --test apps/dna-server-api/tests/evaluation.test.ts`；全仓免费回归脚本为 `node scripts/m0-baseline.mjs test-results/m4-local`。浏览器测试需要已有兼容 Chromium，可设置 `DNA_BROWSER_EXECUTABLE`。`scripts/m4` 类型检查为 `node_modules/.bin/tsc -p scripts/m4`。

真实质量发布仍需：真实来源与使用许可/脱敏审查、人工主标注、每 split 至少 20% 独立复核和分歧裁决、关键正例分母补足、冻结后至少三次真实模型重复，以及可核对的费用证据。真实采集费缺失保持 unknown；别名模型版本与费用不能推断。完成这些工作之前，不将 fixture 零费用、模型自评或本机时长用于质量、成本节省或简历量化结论。
