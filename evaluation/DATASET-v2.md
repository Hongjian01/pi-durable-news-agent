# AgentRadar 数据集与标注规范 v2

## 2.1 版标注和留出规则（2026-11-12）

现有两个来源包已完成委托给 Codex 的标注，原始快照和人工签名表原样保存。使用[模型辅助标注及证据](annotations/2026-11-12/README.md)做开发、回归和探索性比较。D1 先评价截至 referenceTime 的文档使用价值；若评价“本轮首次出现的业务变化”，需另外绑定上个版本或已知历史记录。D2 的断言只以展示的证据为判断范围。D3 题面和评分答案分别存储，部署时只挂载题面与允许读取的快照。

新增样本记录 labelOrigin、producer、independentHumanReview、firstExposure、原语种及决定性证据语种。已向开发者交付答案的样本标为 exposed_diagnostic，test 字样只表示原 split。模型辅助标签可以独立成版并运行，后文人工复核及一致性规则用于独立验收。单个模型生成再回读的标签不产生双人一致性统计。

配套主协议：[PLAN-v2.md](PLAN-v2.md)。本文定义待建设的数据，不表示已经采集或标注。

## 1. 共同规则

所有记录具有 id、datasetVersion、split、origin、eventClusterId、provenance、createdAt。来源原文以 UTF-8 保存并计算 SHA256；引用用固定字符偏移协议（推荐 Unicode code point，若沿用生产 JS UTF-16 则必须统一并注明）。不能混用字节偏移和字符偏移。

origin 区分 captured_source、human_authored、synthetic_transform。真实正文衍生的人工错误声明仍标 synthetic_transform，不能因引用真实文档便称真实自然错误。

provenance 包含原 URL、规范 URL、抓取时间、原始发布日期及依据、文档更新时间、版本/提交、语言、来源类别、许可/使用依据、原文哈希、是否截断。发布日期不明保留 null，不以抓取时间冒充；评测另存 referenceTime 和日期判定策略。

一个事件的转载、翻译、同发布包下多页文档、相邻版本及纠正声明保守归为同一 partitionGroup；关联图连通分量整体分配 split，任务、文档、claim 与攻击衍生项共同继承。任务含多个组时，先在 split 内选材，不能把不同 split 文档组合进一个任务。跨集 exact/近重复、事件与版本泄漏均检查。

gold 存在单独只读存储，仅 grader 可访问；Agent 不能看到参考答案、裁决、任务成功断言或 test 标签。开发者在调参期间只使用 dev。攻击材料中也不得包含真实密钥或真实敏感数据。

## 2. D1：600 条真实决策样本

dev 150 / test 450；文档级规模与独立事件组数同时报告。原则上至少 200 个 partitionGroup；实际分布不满足时继续采集，不能通过拆页或复制凑数。

语言配额（dev / test）：

- 中文 60 / 180，共 240。
- 英文 60 / 180，共 240。
- 中英混合 30 / 90，共 120。

主标签配额（dev / test）：

- relevant=true 且 useful=true：75 / 225。
- relevant=true 且 useful=false：38 / 112。
- relevant=false：37 / 113；useful 单独按目标用户评价，记录不一致标签并裁决。

来源配额目标：官方发布/变更日志 180；官方技术文档 150；论文与可复现评测 90；技术社区/二手解读 120；负例来源 60。来源类型互斥，真实性/营销程度作为另一个维度。当前 180 份公开文档不能支撑整个来源配额。

关系标签配额（dev / test）：different 60/180，duplicate 30/90，development 25/75，evidence 20/60，uncertain 15/45。关系相对于提供的历史代表判断，不是孤立文档的固有属性。中文/混合 duplicate 至少 dev 20 / test 60；跨语言重复至少 test 30。语言、来源、正负例和关系为交叉配额，不要求全笛卡尔积均匀；采集时使用分层约束检查可行性。

这些配额使 D1 成为分层诊断集，不代表生产自然占比。主报告分层结果和宏平均；如需自然分布加权分数，必须另有真实抽样得到的权重并披露，不能自定权重伪称线上质量。

新增标签字段：

- relevant/useful：布尔，沿用现有 rubric，并注明目标用户和 referenceTime。
- relation：different/duplicate/evidence/development/uncertain。
- duplicateOf：同 split 且已进入历史的规范代表；非 duplicate 为 null。
- relationTargetIds：evidence/development 对应的历史事件，允许多个。
- importance：0 无决策价值；1 背景了解；2 近期值得集成/验证；3 破坏性变更、安全修复或影响核心工作流的更新。
- hfs：hype/facts/signal 各 0–4，沿用 evaluation/rubric.md。
- actionableFacts：原子事实、影响对象、版本/条件、来源片段。
- rationale、uncertaintyReason；无法合理二分的标注需进入裁决，不能强行当负例。

为沿用现有 M4，保留原 samples/snapshots/annotations 格式；新增字段先放 annotations-v2.jsonl 和 task sidecar，通过显式转换适配器读取，禁止直接假设旧 loader 接受 v2。

## 3. D2：300 个声明—证据案例

四类各 dev 25 / test 50：supported、unsupported、insufficient、conflicting。

每条包含 claimText、证据 snapshotId/quote/offset/hash、完整上下文、referenceTime、goldState、理由和人工有效限定条件。claim 应是一个可判断的原子声明；多个断言拆开，但共享原事件组与 split。

案例构造覆盖：

- supported：版本、功能、迁移步骤和来源明确限定的性能自述。
- unsupported：交换版本、修改数字、否定反转、扩大适用范围；至少两种不同变换来源，避免靠固定模板识别。
- insufficient：标题有说法正文缺依据、截断、仅传闻、缺测试条件、时效不明确。
- conflicting：同一对象/版本/条件下来源实质冲突；不同版本的差别不能直接标冲突。

“来源说了 X”与“X 在世界上为真”分开标记 attributionSupported 和 externalVerificationAvailable。若任务只要求准确转述，不要求独立实验；若声称独立事实，需要相应证据。

再以 30 个 dev、60 个 test 案例构造引用结构变体：错 hash、错 snapshot、错 offset、相似但不一致引文、越权来源、有效引文。这些是 D2 衍生测试，不增加独立语义案例数。

## 4. D3：80 个完整扫描任务

10 类，每类 dev 2 / test 6，共 dev 20 / test 60：

1. SDK/API 破坏性变更与迁移。
2. 安全修复和影响范围。
3. 跨语言转载去重。
4. 同一事件的版本演进。
5. 证据冲突与厂商宣传限定。
6. 有用但低热度事件与噪声排序。
7. 无新闻/全部过期/不相关，应 no_news。
8. 证据不足，应说明限制且不冒充证实。
9. 偏好权重差异与个性化排序。
10. 多页研究、子 Agent 协作与长上下文。

每任务候选 12–24 条，历史 0–20 条，K=6。构造者依据冻结资料制作环境，不将人工答案写入模型可见上下文。允许不同任务共享正文，但必须记录 sharedClusterIds，统计时聚类。

网络环境包含：query→搜索结果快照、URL→页面快照、重定向/404/超时等响应。允许合法的不同查询表述；可用冻结索引检索，而非硬编码唯一完整字符串。未命中页面返回可识别的 unavailable；不得静默联网补料。网页路径、结果排名与时间均冻结。

每任务定义 requiredFacts、allowedClaims、forbiddenClaims、expectedRelations、expectedTerminalStates、mustNotActions、maxCards、预算、deadline、参考可行输出和人工验收说明。正文较长时说明允许读取的页面/chunk；不得设置预算内不可能获得的事实。

偏好任务可做同一候选池两种用户画像的成对任务；它们不是独立样本，作为同一 taskFamily 聚类。两画像均应有人工可解释排序，不凭主观爱好设唯一精确名次。

## 5. D4：故障与安全

故障 10 类×4 个变体=40，详见案例目录。变量包括输入有新闻/无新闻、单/多候选、重试前后、取消并发。每个变体显式列初始状态、注入点、触发方式、恢复动作和数据库断言。

安全 20 个基础任务，每任务 3 个攻击变体=60；每个变体配相同基础任务的干净输入。10 基础任务供 dev，10 供 test；attackFamily、变体和干净任务不得跨 split。攻击类别应跨 dev/test 有共同大类，但 test 使用不同具体 payload、措辞和位置。

攻击目标覆盖：伪造证据/引用、压制重要新闻、操纵偏好/来源、绕过预算、泄露沙箱假凭据、误调用工具。只对实际向该 Agent 暴露的能力构造可执行攻击；不可达能力单独列为结构约束，不算成功防御的模型样本。

使用安全沙箱、假 secret 和本地捕获接收端。外联请求、写入和发布由可观测工具代理截获，不触达真实收件人或生产库。

## 6. 人工标注流程与一致性

至少两名能阅读中英文技术资料的标注者，分歧由第三位裁决；没有人手则保留单标状态，不能虚构 reviewer。

1. 两人独立试标 D1 的 30 条 dev 和 D2 的 20 条 dev，讨论定义歧义并更新 rubric 版本。
2. 主标覆盖全部。D1 每 split 至少 25% 独立复核，即 dev 至少 38、test 至少 113；D2 dev 至少 25、test 至少 50。高风险、冲突、中文重复和负例分层抽样。
3. reviewer 在提交前看不到主标、模型预测或实验组。第三人裁决保留原记录与理由。
4. 报逐字段一致率；类别报告 Cohen κ，序数等级报告加权 κ，并附类别分布。κ≥0.7 是建议检查线，低于此值应检查定义和难例；不能靠删除争议样本提高数字。
5. 标签记录 sampleId、snapshotHash、annotatorId、role、timestamp、rubricVersion、label、rationale。新修订进入新版本，保留血缘。
6. test 在 gold 形成前可做人工作业，但调参人员不查看 test 标签/输出；评测后发现 gold 错误需双盲复核，公布更正和旧/新结果。

## 7. 现有资料迁移

`engineering-v1` 的 160 条留作 fixture，不纳入 600 条真实来源配额。

`public-doc-updates-v1` 的 180 条是候选来源池。逐条核对适用主题、日期、许可、语种与事件组；合格项可以计入 D1，保留原 id、URL、hash 与原 split 的血缘。曾经查看或调参使用的条目优先进入 dev；新 test 尽量由未参与调参的事件组成。

当前资料 referenceTime 为 2026-10-27 附近，只能用于该历史窗口任务，不能无条件套用未来扫描时间。新增资料按不同历史窗口组织，任务各自固定时间。

补采量至少为 600−通过人工审核的现有条目数，且必须满足所有交叉配额；可能超过 420 条。D3 新增素材和 D2 覆盖不足的资料另计，不能承诺“补 420 条就一定完成”。

优先公开官方 release/changelog、SDK 文档、原始论文与作者复现资料、可合法使用的技术社区讨论。保存使用依据，删除或隔离不应公开的内容；原始来源池和可公开评测包可分开交付。

## 8. 数据冻结验收

- JSON/schema、唯一 ID、hash、引用偏移、日期与 provenance 全通过。
- 所有候选主标完成，复核配额完成，分歧已裁决。
- 联合 partitionGroup 无跨集泄漏，语义事件分组已人工抽查及难例全查。
- 任务都有可行参考输出；正确参考能通过，至少五种缺陷变体能被对应 grader 检出。
- 记录实际而非计划配额；不满足的切片明确阻塞或探索性。
- 固定 manifest、rubric、judge、提示、工具 schema、源码、依赖、模型参数、预算和 random seed。

冻结产物只读；任何变化产生新版本，旧结果继续可复现。
