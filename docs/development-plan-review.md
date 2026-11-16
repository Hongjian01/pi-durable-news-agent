# AgentRadar v1.0 改造方案深度审查

日期：2026-10-26。审查对象：`agentradar-development-plan.md` v1.0。

对照仓库：`E:/agent/Jev/pi-durable-news-agent`，提交 `273b79bb8d3d8907cae9fbd6abd3da163ee2a343`。

## 1. 结论

**有条件可行，建议继续；原方案适合作为方向和范围说明，尚不足以直接作为可靠实现的规格。** Durable、Jev、研究子 Agent 的组合有真实代码基础，保留主链路并收缩外围功能是合理选择。主要问题在于：对原系统某些保证的描述仍偏强，恢复语义、失败分类、证据关系和评测准入条件需要补齐。

可以立即执行 M0 的环境检查与离线基线。正式功能改造之前，优先修订扫描受理、失活检测、发布幂等及重放快照规则。暂不能宣布已验证端到端可靠性或实际成本优势。

本次未安装项目依赖、未执行全套测试、未调用真实供应商、未修改原方案或业务代码。做了源码与 SQL 审查，以及四项无网络隔离验证。隔离验证确认的是具体风险条件，不代表应用通过验收。

## 2. 已有方案中值得保留的决定

- 保留 Durable 与 Jev 主线，避免把项目收缩成定时摘要脚本。
- 区分扫描持久任务与后续研究/分类/发布工具，符合真实结构。
- 明确外部调用成功与本地提交之间存在歧义窗口，不承诺端到端 exactly-once。
- 先保留 CLI/TUI 代码，避免破坏能力覆盖契约。
- 不先重命名包、API、工具标识和数据库目录，降低迁移面。
- 保留 HFS 三维评分，并把 Facts 解释为文本证据可核验程度。
- 固定数据、隔离实验数据库、区分 reported/estimated/unknown 成本，方向正确。

## 3. 四项隔离验证结果

验证脚本：[agentradar-review-probes.mjs](E:/agent/Jev/jev-cookbook/output/resume/agentradar-review-probes.mjs)。执行运行时为 Node v24.22.1；脚本只读目标源码并使用内存 SQLite 和桩依赖。

1. 直接调用原始 `shortlist()`：两篇完全相同的纯中文标题召回 0 个候选；英文对照召回 1 个。证明中文问题发生在 Jev 之前的召回层。
2. 在内存中执行原始 `001_schema.sql`，开启外键、插入真实关联 item：同 item、不同 tool_call_id 可以插入两张新闻卡片；相同 tool_call_id 被唯一约束拒绝。证明现有数据库保证仅覆盖调用标识，未覆盖 item 唯一发布。
3. 对原 `closeStalledSweeps()` 函数体做类型擦除与依赖隔离：submission 状态仍为 running，创建超过 31 分钟、阈值 30 分钟时，业务扫描被标记 stalled。
4. 对原 `startNewsSweep()` 函数体隔离执行：已存在 queued 扫描但没有 submissionId 时，重复请求返回 replay，submit 调用次数为 0。证明重复请求路径不会补交这类扫描。

第 3、4 项的数据库、日志与投影依赖使用桩；尚未进行完整进程崩溃实验。第 2 项只证明数据库约束边界，不代表所有 API 路径都已复现并发重复。

## 4. 必须优先补充的可靠性设计

### R1｜高优先级：业务扫描与 Agent 提交之间存在受理空窗

原方案位置：D2、D4、必测场景 1。

证据：[sweep.ts:116](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/news/sweep.ts:116) 先创建业务记录，[sweep.ts:159](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/news/sweep.ts:159) 再提交 Agent，随后写回 submissionId。业务库为 dna.sqlite，运行状态库为 agent.sqlite，已确认是两个文件。

风险路径：创建 queued 记录 → 进程中断 → 同 requestId 重试 → 命中已有记录直接 replay。系统不一定立即续作；以后把它判 stalled 也不等同于恢复原请求。

建议：增加最小持久提交意图。将 sweepId、稳定 requestId、完整已渲染提示内容、必要配置快照和待提交状态一起保存到业务库；启动时及周期性 reconciliation 对未完成受理记录使用同一个稳定 requestId 重交，取得已有或新 submission 后补写关联。先核实上游幂等提交 API 的返回语义，不发明其未提供的查询方法。

验收：分别在业务记录提交后、Agent 接纳后、submissionId 回写前中断；重启后相同扫描继续，无新增重复扫描和重复接纳。重复请求除了返回已有记录，还必须能确认受理状态或触发安全对账。

### R2｜高优先级：stalled 检测与持久恢复可能互相冲突

证据：[sweep.ts:40](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/news/sweep.ts:40) 使用创建时间判断超时，即使 submission 仍 running 也会关闭；[runtime.ts:148](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/runtime.ts:148) 每分钟执行检查。关闭方法只更新业务状态，没有同步终止对应 durable 工作。

风险：长研究或长时间停机后恢复，业务状态先被判 stalled；下一轮扫描可以进入，旧任务还可能继续写入。UI 所示终态和实际执行不一致。

建议：区分运行截止时间、无进展时间、持久等待、队列等待和真正失去执行者。超时依据最近可信进展、执行状态和重试截止时间；不要把 telemetry 投影的短暂落后当成任务已死。若明确到达硬截止时间，协调 abort 并等待终态，或以执行代次/fencing 防止旧任务继续发布后，再允许替代执行。

验收：长于 30 分钟但持续推进不误判；retry 等待不误判；离线超过阈值后恢复有明确策略；取消后旧工作不能重新发布。不能只增大 stallMinutes 掩盖问题。

### R3｜高优先级：阶段重试、条目失败与降级并非同一种行为

证据：[sweep-task.ts:294](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/news/sweep-task.ts:294) 中 relevance/worth 并行调用，失败被捕获并调用 failItem，随后游标仍可前移。[news.ts:355](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/db/repos/news.ts:355) 的 retryable 由后续采集获取。[sweep-task.ts:424](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/news/sweep-task.ts:424) 中 importance 出错会保存 attention 派生值。

影响：方案中的“短暂失败后按持久 retry 恢复”只适用于抛出到阶段包装器的失败，不能覆盖所有 Jev 失败。有些条目依赖未来扫描重试；importance 则已进入替代路径。若供应商持续故障，零候选可能被误解为没有新闻。

建议定义 command 级策略：哪些失败重试，哪些进入 deferred，哪些允许显式降级；记录 fallback_used、decision_source 和 retry_exhausted。区分成功判为不相关与没有取得判断。增加“部分失败/不可完成”的业务表示，避免 no_news 吸收所有失败。

验收：429/超时、契约错误、401/402 分开测试；用户关闭后续调度时，当前失败条目的命运仍明确。relevance 成功但 worth 失败的分支不能在统计上假装两者都未执行。重试预算跨重启保持，客户端内重试与阶段重试合并计费。

### R4｜高优先级：item 级唯一发布与发布后对账尚未落到约束

证据：[001_schema.sql:191](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/db/migrations/001_schema.sql:191) 的 cards 只有 tool_call_id 唯一；[news.ts:941](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/db/repos/news.ts:941) 的 addCard 按调用去重。present_news 先查 item，再进行异步日期/图片处理，不能用先查后写代替数据库唯一约束。

建议：先决定业务规则。如果每个 item 只有一张 news 卡片，则先对旧数据做重复检查，再增加条件唯一索引，例如 news 且 item_id 非空；如果允许版本化卡片，就明确 publication_key 的组成。冲突后返回已存在结果。新增索引前不得盲删旧记录。

还需检查“卡片已存在”提前返回路径是否补齐卡片计数、发布审计与关联状态，避免只做到不重复卡片却留下旧计数。

验收：同一 tool 重放、两个不同 tool 并发发布同 item、业务写入后崩溃、带旧重复数据升级。既检查记录数量，也检查 item 状态、扫描计数与返回 cardId。

### R5｜高优先级：任务完成与业务完成需要独立定义

证据：[complete-sweep.ts:35](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/agents/tools/complete-sweep.ts:35) 主要检查 presented 时至少有卡片，之后先写 completed，再执行 audit。[audit.ts:21](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/news/audit.ts:21) 只检查是否存在成功 research_items 调用，不证明每张已发布卡片都有完整研究。延迟 1.5 秒补审计使用普通 setTimeout，进程中断时不会作为 durable 工作恢复。

建议：定义三种不同概念：task terminal、sweep execution ended、business acceptance passed。最终验收以业务事实为准：目标卡片、判定、研究或允许跳过原因、必需证据是否齐全。工具调用轨迹作为诊断证据，不作为唯一完成门禁。需要延迟审计时用可恢复对账或下次启动补审计，避免依赖任意固定等待时长。

验收：研究缺失、只有一次成功研究但其他发布项未研究、审计前崩溃、投影延迟、真实零候选分别处理。错误必须返回可修正信息或清楚终态，不默默标为 completed。

### R6｜高优先级：缓存失效策略必须服从同一任务的重放一致性

原方案 D3 要求偏好/题目改变时不能复用旧结果，但尚未规定运行中的扫描该用哪个版本。

现状：gate 仅以 item.relevance/worth 非空跳过；rank 仅以 importance 非空跳过。same-story 已有 evidence_hash + version 的缓存；JevLedger 是计费记录，不是统一推理结果缓存。

风险：同一任务恢复时采用新偏好、新问题或新模型，会混合两套决策；相反，无条件沿用旧 item 分数也无法完成显式重评。

建议：每次扫描冻结 evaluation_context，包含内容快照引用、题目内容哈希、策略版本、偏好快照、模型/供应商和抽取版本。相同逻辑操作恢复复用原上下文；新偏好从下一轮或显式 rescore 生效。缓存记录区分 raw judgment 与后续 policy decision，阈值变更可以重算决策而不必重复推理。仅生成 hash 而不保存可还原输入不足以审计。

验收：扫描中途修改偏好/题目，原扫描恢复保持旧版本，新扫描采用新版本；人工重评能产生新决策并保留旧证据。模型 latest 无法钉死时注明版本不可完全复现。

## 5. 业务与评测可行性缺口

### R7｜高优先级：证据 URL 与支持判断没有绑定

证据：[report-findings.ts:35](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/agents/tools/report-findings.ts:35) 使用当前 item 缓存正文验证 claims，随后独立保存 evidence_urls；不逐条抓取这些 URL，且 claim-support 失败会记录警告后继续保存。

建议新增最小结构：claimId、sourceId/规范 URL、抓取时间、contentHash、quote、supportStatus。quote 应能在持久化抽取文本中定位；抓取失败、未评估、不支持和支持是不同状态。Jev 接收实际对应片段，返回只说明所给材料的支持关系。先支持原文章中的证据定位，不必一步做多源事实核查系统。

验收：虚构 URL、没有抓取过的 URL、片段不存在、来源冲突、供应商故障分别返回明确状态。文字看起来有来源不等于证据可追溯。

### R8｜中优先级：中文支持必须覆盖召回层

证据：[story-policy.ts:32](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/news/story-policy.ts:32) 使用 ASCII 正则提词，随后只保留共享词大于 0 的候选。隔离测试已确认纯中文相同标题无法召回。

建议：若首版宣称中英文内容支持，增加 Unicode 分词或汉字 n-gram 与英文实体召回的组合；明确候选上限。先用词法与字符方法，不引入向量数据库。若暂不改召回，只能声明中文界面、英文来源，不能声明中文去重已支持。

验收分别统计候选召回率和 Jev 条件分类质量；遗漏于 shortlist 的样本必须计入端到端漏合并。

### R9｜中优先级：配置收敛不会自动应用到旧数据库

证据：[store.ts:52](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/db/store.ts:52) 仅首次 seed 关键词；已有数据库只补充新来源，不移除旧来源，也不会自动替换原关键词。

建议提供显式预览/应用 preset，区分默认种子与用户修改。首版演示可使用独立新数据目录，但升级验收必须验证旧库保持用户偏好；不能靠删除数据使新默认配置生效。

### R10｜中优先级：全局资源预算与成本账本还不充分

现有 Firecrawl credit cap 不等于全系统预算。去重可能为多个候选故事抓页面并调用 Jev；模型轮次、研究次数和重试都影响总成本。importance 评分还会把偏好作为模型输入，代码再次乘权重，需用实验判断是否过度放大偏好。

建议限制单轮输入条目、页面字节、同故事比较数、研究数、并发和模型请求次数；真实实验设软费用上限与停止条件。预算终止时保留已完成结果，并区分正常完成与预算耗尽。费用未知时按请求数等硬限制止损，不能等账单回来才决定是否继续。

证据：[telemetry.ts:791](E:/agent/Jev/pi-durable-news-agent/apps/dna-server-api/src/db/repos/telemetry.ts:791) 的 sweepCost 对 SUM(cost_usd) 使用 COALESCE，结果不包含 unknown call 数与覆盖率。因此不能直接把原 UI 总价当作完整账单。benchmark 应按来源分别汇总，记录 unknown、failed、attempts 和漏失可能；被杀进程中尚未落盘的供应商调用仍是未观测成本。

### R11｜中优先级：对照实验需要更强的公平性与可操作规则

A 全量研究、B 筛选后研究，可以验证整体方案，但不能单独证明 Jev 优于其他筛选方式。应把等研究数的对照从“可选”提升为主要实验之一：固定 Top-K，在简单规则/时间排序与 Jev 排序之间比较，研究部分使用相同配置。

建议先 30–50 条开发样本调通流程，再扩至约 100–200 条分组标注集；先写标注准则再标注。HFS 主观维度需要抽样复标与分歧记录；小样本结果只支撑该测试集，不作为广泛准确率保证。测试按故事簇分割，并覆盖跨语言、低证据与新进展。

不直接通过生产 sweep 跑“全量研究”基线，因为该入口自带 Jev 与卡片上限。开发独立 eval adapter，复用相同 research tool/path，绕开 gate/rank 的控制必须显式且只用于评测。研究接口有 batch 限制，不能把全部样本硬塞一次。

建议验收：冻结配置；列出两组实际研究数、所有组件成本和端到端漏报；固定样本重复运行并报告波动。质量达到预先约定底线后，才讨论省费。质量底线在开发集确定、测试前冻结，不事后挑指标。

### R12｜中优先级：环境与真实模型可用性仍未通过准入

本机确认存在 node/npm/wsl 可执行入口，未确认 WSL 发行版或 just 可用。工具捆绑 Node 是 24.22.1，这不证明用户默认 shell 的 Node 版本和项目依赖可安装。

证据：[models.ts:125](E:/agent/Jev/pi-durable-news-agent/apps/shared/packages/durable-agent/src/models.ts:125) 要求整个硬编码 CATALOG 均出现在 SDK 的模型清单中；任何缺项会在 live 初始化时抛错，甚至不涉及实际选中的模型。faux 通过不能证明 live 可启动。

建议 M0 分两个独立闸门：离线依赖/测试/界面成功；选定的一个主模型和 Jev 真实请求成功。真实可用性验证独立控制费用。模型目录若遇到缺项，只让实际必需模型缺失阻断，其他不可用项从选择器过滤并说明；不得 silently fallback 成 mock。

原 `just` 流程使用 zsh，Windows 的进程终止语义也不能直接等同 Unix SIGKILL。首版选定单一运行目标：已有可用 WSL/Linux则优先保持原语义；若只有原生 Windows，先验证 Node 核心与手动 tick，调度服务与崩溃实验分别实现。不要在 M0 同时承担完整双平台迁移。

## 6. 个人贡献与项目价值判断

现有方案多数功能已由上游提供：持久执行、六类判断、子 Agent、反馈和执行面板。改名、中文化和换来源不足以独立体现工程贡献。

最有价值且与项目主线一致的新增工作是：

1. 提交意图对账、正确的失活检测、发布唯一约束与恢复故障矩阵。
2. 单次扫描的判定上下文快照，以及明确的重评/缓存失效语义。
3. 中文候选召回和 claim—source—quote 的证据关联。
4. 可复现的质量—成本对照与未知费用披露。

这些工作能提供真实代码、失败案例、修复前后实验，适合作为简历主要贡献。上游核心运行引擎仍应如实说明。

## 7. 修订后的实施顺序

### 阶段 A：基线与最小真实可用性

只做依赖和环境、fixture/faux、选定真实模型/Jev smoke；冻结 baseline。先保存至少一份离线完整结果，再修改默认模型或启动逻辑。

退出条件：能区分环境故障、依赖故障和业务缺陷；live smoke 若被凭据/服务阻断，应标为未验证，不假定已过。

### 阶段 B：端到端恢复正确性

先实现 R1、R2、R4，并定义 R3/R5 的失败与完成语义。把代码层不变量落实到测试，之后再增加 UI 恢复展示。

退出条件：受理三个中断点、长任务/长停机、发布重放、取消后不再发布都有断言；仅 gate 中断测试通过不够。

### 阶段 C：Jev 可重复判断与领域输出

实现 R6 的上下文快照，完善 R3 失败策略；再做中文召回和证据关联。判定质量可复现后再进行阈值微调。

退出条件：同一任务恢复不混用配置；新偏好下一轮生效；不把未评估当成不相关或不支持；中文候选召回可测。

### 阶段 D：产品收敛与展示

品牌、中文文案、受控 preset、无图片路径、三类视图。CLI/TUI 保留实现；新增 Web 诊断能力与 SDK 能力映射协调，避免为了过旧测试硬凑每端同样界面。

退出条件：图片关闭不产生新增生成任务；历史未完成图像任务的处置已规定；刷新不重启扫描，执行面板反映业务与运行两层状态。

### 阶段 E：评测与发布

做冻结数据的全量/分层以及等 K 对照，复用 benchmark 原始日志生成报告；完成源代码、README、演示和贡献列表。

退出条件：质量与成本同时报告；unknown 不按 0；恢复实验可重复；简历中的每项个人实现都有对应提交与证据。

## 8. 建议补入方案的工程合同

开发前至少写清这些不变量，作为代码评审和验收依据：

1. 接受的扫描有可恢复提交意图；相同 requestId 不产生两个逻辑扫描。
2. 同一运行代次使用固定判定上下文，恢复不混用偏好/题目/模型配置。
3. 一个逻辑发布键最多一份可见业务产物；重放能修复衍生计数。
4. timeout/stalled/failed/cancelled/completed 的含义明确；取消任务不得继续写可见产物。
5. 已终止的业务扫描不再被旧执行者更新；如果允许恢复，必须是显式状态转移。
6. completed 表示通过约定业务验收，工具调用存在不自动等同完整研究。
7. 供应商失败、模型否定、证据不足和零新闻具有不同结果表示。
8. 引用的证据片段可定位到保存的材料版本，支持度可追溯到具体 claim。
9. 成本估算和账单金额分开；未知调用不会被总价隐含为 0。
10. 旧库升级和新库初始化都经过测试，不靠删库修复。

具体数据库 schema 和状态枚举在实现前评审一次。不要只在文档中增加上述术语，而不绑定到 API 返回、持久字段与测试断言。

## 9. 可行性、可靠性和投入判断

**技术可行性：较高，条件是基础依赖及 live 模型通过 M0。** 主要修改集中在应用协调层、判断上下文、数据约束和评测，不需要重写执行引擎。

**当前可靠性：不能认证为可长期无人值守。** 已有恢复能力有价值，但四项验证与静态检查显示业务接纳、失活、召回和发布约束存在边界。应先完成阶段 B，再做连续运行试验。

**工程复杂度：中高。** 无图片路径和中文界面相对简单；跨库对账、取消/超时协调、重放快照和公平 benchmark 是主要投入。一次性同时完成全部六类命令调优、跨平台迁移和多端能力变更会放大风险。

**成本收益：待实测。** Jev 的优势取决于被筛掉的研究成本是否超过新增判断、抓取与重试成本。近似关系为：节省的研究成本 > Jev 总成本 + 新增预处理成本。过滤率很低、文章很短或去重候选过多时，未必更便宜。

**求职展示价值：有条件较高。** 以可靠性修复、领域判断和对照实验作为个人贡献，比单纯功能清单更有支撑。不要以缺少质量约束的省费百分比代替工程证明。

最终建议：保留原方案的产品目标与功能边界，将恢复协调和判断快照前移，缩小首版运行环境，明确业务完成与失败策略；按阶段 A–E 执行。原 v1.0 应修订后再作为后续自动开发的唯一指令源。
