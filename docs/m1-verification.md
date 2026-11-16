# M1：Durable 闭环验收

2026-10-27，按 `SPEC.md` 的 M1 门槛完成离线 fixture 验证。此记录接续 `m0-baseline.md` 中的 Outbox 第一批结果；SPEC 是开发基线。

## 完成内容

- 保留原 Durable 执行、Jev 六类判断与研究子 Agent。扫描仍采用 gather/gate/dedupe/rank，研究和发布仍通过 Agent 工具完成。
- 保留提交 Outbox、稳定 requestId 与启动/15 秒周期对账，恢复三个跨库提交窗口中的原 sweep/submission。
- 新增 `003_sweep_lifecycle.sql` 版本化表重建迁移；历史 `001_schema.sql` 未改。保留旧记录，检查重复卡片、外键和完整性，拒绝活动旧任务及未知未来 schema。
- 新生命周期与合法转换；可信进展、持久等待、120 秒启动宽限、15/20 分钟无进展策略和 24 小时截止。旧 telemetry watchdog 不再产生 stalled。
- 显式按 sweep 取消，先提交 epoch fencing，再请求执行器 abort。原始 epoch 沿持久任务归属传播，不能从当前扫描取得新写权限；60 秒未结束的执行登记为 lingering 后释放业务活动位。
- item 级唯一发布；卡片、item/sweep 关联、发布事件与计数在同一事务中提交。崩溃重放修复关联，历史卡片保持原发布归属。
- 持久 finalization，检查本轮所有 item 的处置、研究/HFS/证据、来源、判断失败与重试，最多两轮修复。由服务端计算 completed/no_news/partial/failed，模型回答不能直接宣布完成。
- Jev 操作、真实 attempt 与预算预约持久化；成功操作恢复复用，未知响应成本保留 unknown，有限退避重试。工具内重试使用持久子任务等待，设备分类并发最多 4，研究并发最多 2；默认 Top K=6、图片关闭。
- 新增双库一致备份/新目录恢复脚本和只读重复卡片审阅方案生成器。修复同进程重入数据库锁绕过备份保护的问题。

## 验证结果

平台：WSL Ubuntu，Linux Node **24.21.0**，锁文件依赖；独立工作副本 `/var/tmp/agentradar-m1-20261027`。没有运行真实付费 API，没有升级或替换已有运行数据目录。

- 全量工作区类型检查、Web 构建、lint、格式检查通过；lint 保留原有 9 个 warning，0 error，新增维护脚本为 0 warning / 0 error。
- API 最终 **135 通过、1 个付费测试跳过**，共 136 项。最后的日期过滤修复另跑完整 API 类型检查和全部 API 测试。
- Jev **18 通过、1 跳过**；Durable **20 通过**；SDK **18 通过**；Cron **8 通过**；CLI **5 通过**；TUI **14 通过**；Hub **2 通过**。
- 原始 faux/recovery 组合 **22 通过**；浏览器 UI **79 个检查通过**；独立 SDK 接纳/abort 契约 **2 通过**。
- 最后清理 lint 后，生命周期/写入隔离回归 **13 通过**；72 个改动源码/脚本文件与受测 Linux 副本逐文件 SHA256 核对一致。
- 最新 fixture：gathered=12、kept=8、4 张卡片、2 个研究运行，终态 completed，audit.missing 为空。该演示明确选择 4 张，以维持原始 fixture 基线；产品默认值为 6。

机器可读记录：`baselines/m1-complete-results.json`。完整日志保留在忽略目录 `test-results/m1-acceptance/`、`test-results/m1-final-addendum/`，双库演示在 `test-results/m1-fixture/`。全套验收运行中的 API 为 134 通过；补测新增日期处置用例后为上述 135 通过，两个结果均保留。

## 故障验收覆盖

- **D01/D02**：并发去重/活动位；业务已提交、执行已接纳、submissionId 回写前，分别真实 SIGKILL/重启，恢复同一逻辑提交。
- **D03/D04**：四个扫描阶段、实际 30 秒 retry sleep、工具内 HFS retry sleep 的真实 SIGKILL/重启；已成功操作不重做。relevance 成功后只重试 worth；关闭未来 Cron 不撤销本轮等待。
- **D05**：持续进展超过 30 分钟、合法等待、恢复宽限和硬截止用显式时钟测试；读取持久执行状态辅助健康判定。60 秒 abort 未完成时验证原 root task 的 lingering 记录和旧 epoch 仍被拒绝。没有以真实等待 24 小时替代时钟测试。
- **D06/D07**：独立进程并发发布、发布提交后 SIGKILL、取消与发布竞争、携带旧 epoch 的进程重启。允许取消前已提交的卡片；取消提交后拒绝业务写入和终态覆盖。相同 item 不同 tool call 仍只有一张卡片，重放补齐计数。
- **D08**：缺研究/HFS/证据不能 completed；finalization 请求提交后真实 SIGKILL/重启；两轮修复耗尽得到 partial/failed。旧正文日期过滤具有明确最终处置，正常过滤可得到 no_news。
- **D09**：实际 fixture 控制流中所有 Jev 401、所有 GET/POST 抓取失败均不能得到 no_news；部分来源成功且判断失败为 partial，全部来源失败为 failed。
- **D10**：供应商返回后、本地响应落库前真实 SIGKILL，保留 unknown attempt；有限重试和预算计数包含重复真实请求。相同操作并发共享接纳，设备 Jev 请求并发上限为 4。
- **P01/P06**：带卡片、反馈、来源的旧库升级后保留数据；重复 item 卡片明确拒绝迁移且不删除。升级前双库快照恢复到新目录仍可被旧迁移集合读取；真实 SDK/业务双库停机备份恢复保留原 submission、卡片及 attempts。未来 schema 拒绝启动，活动库备份拒绝执行。

## 复现与升级边界

在安装锁定依赖的 Linux Node 24 独立副本中执行：

```bash
node scripts/m0-baseline.mjs test-results/m1-local
npx tsc -p scripts/m0
npx tsc -p scripts/m1
NODE_NO_WARNINGS=1 node --import tsx --test scripts/m0/sdk-contract.test.ts
NODE_NO_WARNINGS=1 node --import tsx scripts/m0/fixture-smoke.ts test-results/fresh-m1-fixture
```

升级前排空/明确取消活动任务并停止全部写入者，备份两个数据库与必要运行配置。双库工具使用 SQLite backup 获取 WAL 中的已提交数据，目标必须是新目录：

```bash
node --import tsx scripts/m1/backup.ts backup <stopped-data-directory> <new-backup-directory>
node --import tsx scripts/m1/backup.ts restore <backup-directory> <new-restore-directory>
node --import tsx scripts/m1/inspect-duplicates.ts <dna.sqlite>
```

工具只处理双库；必要配置需一并单独保存。回滚恢复同一停机快照中的两个库及匹配代码/配置，不做单库降级。重复卡片脚本只输出内容、反馈/问题引用及候选合并步骤，未实现或执行自动删除/合并。

## 下一阶段

M1 的验收证据限于上述离线 fixture。M2 仍需将全部判断/研究读取接入冻结评估上下文、补齐版本化缓存隔离、不可变来源快照与 claim 引用绑定，以及覆盖研究模型/搜索等所有外部请求的预算预约与费用结算。当前 Jev 持久预算和保存正文检查不能替代这些完整能力。真实供应商行为、长时间无人值守和评测成本仍未验收。
