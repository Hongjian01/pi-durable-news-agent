# M2 第一批：冻结判断上下文与精确缓存

> 后续状态：M2 的剩余工程实现与 J01–J08 离线验收已完成，见 [M2 完整验收记录](m2-verification.md)。本文保留第一批交付时的结果和缺口，不代表当前完成状态。

2026-10-27。基于 `SPEC.md` 第 8、9 节推进，接续 M1 离线验收。本批是可验证的 M2 增量，**没有完成整个 M2，也不代表 J01–J08 全部验收**。

## 修改

- 新受理记录使用 context v2。规范化 JSON 只排序对象键，保留文本和数组顺序；保存六类完整命令、逐命令 hash、`policy-v1`、偏好/反馈、来源权重、模型与实际 Jev provider、referenceTime。配置仍使用字段白名单，不保存密钥。
- Jev 判断、gate 策略、搜索主题/来源计划、importance 权重与 freshness 排序读取本轮 context。后续修改命令、模型别名、偏好和权重只影响新 context。恢复时 provider 不匹配会在出站前失败，不静默切换供应商。
- 将原有 gate、pre-attention、freshness 和 claim-support 数值收录到 `policy-v1.ts`；六类命令自己的策略仍保留在 command.json。本批没有调参。
- 判断操作补足 contextId、commandVersion/hash、inputHash、requested/resolved model、策略结果、原始响应 attempt 引用。结果携带 `judgment` 回执，供应商 raw 数据保持原样。
- 增加精确内容缓存：key 覆盖规范化输入、完整命令及 context hash，包括偏好、policy、referenceTime、供应商/模型。命中时创建本轮 operation 引用，attemptCount=0，不预约新请求、不重复记入 Jev ledger；原响应与费用作为来源保留，回执标 `cache_reference`。
- HFS、same-story、claim-support 的材料版本参与操作标识；研究材料变化后的 HFS 不会直接复用研究前结果。HFS 仅使用本轮关联的 finding。
- 所有 Decide 结果统一通过现有严格响应校验。非法响应保存原结果并标 `invalid_response`，最多一次同预算重试；不会变成零分或进入成功缓存。无法确认是否已执行的网络错误保留 unknown 成本状态。
- 新增追加式迁移 `004_judgment_context.sql`，不改历史 001–003。旧 judgment/classification/story 记录标 `legacy_unversioned`；新扫描不把旧 same-story cache 当作精确判断缓存。新增缓存记录不可原地改写。
- 004 升级拒绝 queued/running/finalizing/cancelling 的旧活动任务，继续遵守排空/取消、停写、成对备份后升级的边界。

关键实现：`src/news/context.ts`、`acceptance-context.ts`、`hfs.ts`、`operations.ts`、`policy-v1.ts`、`rank.ts`、`taste.ts`、`stories.ts`、`sweep-task.ts`，以及 runtime、提交仓库和迁移入口。路径均以 `apps/dna-server-api/` 为根。

## 验证

WSL Ubuntu + Linux Node **24.21.0**。工作副本 `/var/tmp/agentradar-m2-20261027`，`npm ci --offline --no-audit --no-fund` 安装锁定依赖。所有数据库均为隔离 fixture；未打开升级已有运行数据目录，未调用真实付费 API。

- 新增 context/判断测试 **9 项通过**：旧偏好/命令/模型/策略隔离、精确缓存与费用引用、非法 schema 重试、取消后的缓存写入隔离、provider 切换拒绝、旧库迁移、referenceTime 排序、HFS 材料版本，以及真实 SIGKILL/重启后的原配置读取与成功操作复用。
- 最终完整 API 回归 **144 通过、1 个付费测试跳过**，共 145 项；包含 M1 的真实进程故障矩阵。最后增加活动升级保护与审计断言后，context + 数据库回归 **14 通过**，类型检查再过。
- 工作区全量类型、Web 构建、lint、格式通过；最后静态检查仍为原有 **9 个 warning、0 error**。
- Jev **18 通过、1 跳过**；Durable **20 通过**；SDK **18 通过**；Cron **8 通过**；CLI **5 通过**；TUI **14 通过**；Hub **2 通过**；faux/recovery 组合 **22 通过**；浏览器 **79 个检查通过**。
- 最新保留演示：gathered=12、kept=8、4 张卡片、2 个研究运行，终态 completed，audit.missing 为空。4 张为显式 fixture 基线，产品默认仍为 6。
- 源码与受测 Linux 副本逐文件 SHA256 核对；`git diff --check` 通过。

完整基线记录在 `test-results/m2-context-cache/`；HFS 输入版本/权重修正后的完整 API 与最终迁移回归在 `test-results/m2-final/`；保留演示双库在 `test-results/m2-fixture/`。机器可读记录为 `baselines/m2-context-cache-results.json`。首次全套基线 API 为 143 通过，新增 HFS 材料版本用例后补测为上述 144 通过，均保留原日志。

复现（在安装锁定依赖的独立 Linux Node 24 副本中）：

```bash
npm run check
NODE_NO_WARNINGS=1 node --import tsx --test apps/dna-server-api/tests/context-judgments.test.ts
npm test -w dna-server-api
node scripts/m0-baseline.mjs test-results/m2-local
NODE_NO_WARNINGS=1 node --import tsx scripts/m0/fixture-smoke.ts test-results/fresh-m2-fixture
```

## 剩余 M2 工作

- **J01 尚需补齐研究侧**：研究子 Agent 提示词/模型的运行时读取，以及逐份实际抓取正文的不可变快照。当前保存了研究配置，但并非所有研究执行路径已经使用它。
- **J03**：中文 Han bigram、Unicode 规范化、相邻版本回归、same-story 历史片段数/长度限制及召回验收。
- **J04/J05**：claim 与已抓取 snapshot、正文 hash、quote 字符区间的绑定和验证；明确 supported/unsupported/insufficient/conflicting，不用链接或摘要代替证据。
- **J06/J07**：将持久预算预约和费用结算扩展到研究模型、搜索和抓取等全部出站路径，包括每项模型调用/token 限制、大小与 URL/重定向检查。当前 Jev 请求预算仍沿用 M1 的持久硬计数，不能称为全流水线预算。
- **J08**：已有取消/fencing 回归通过；后续快照、claim 和预算新写入路径仍须逐一纳入。

当前缓存是完整输入的保守精确匹配；referenceTime 等任一上下文字段不同都会失效，不宣称跨时间扫描的命中率或实时模型收益。模型别名背后的权重不能由本地快照冻结。网页快照与研究配置接入完成前，不把本批描述为完整流水线确定性重放。
