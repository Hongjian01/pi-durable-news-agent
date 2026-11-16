# 自动评测 CI 配置与验收

## 已实现

- `.github/workflows/evaluation.yml`：PR 自动触发，也可手动运行；Linux Node 24.21.0，安装锁定依赖和 Chromium，工作区类型检查，离线回归，48 条确定性评分回归，七题免费 fixture 烟测及专用门禁。不注入供应商密钥。
- `.github/workflows/evaluation-live.yml`：每日北京时间 09:17 定时运行，另支持 workflow_dispatch 手动勾选付费调用；仅默认分支运行，使用 agent-evaluation-live 环境密钥。先检查密钥是否配置、冻结数据和 OpenRouter 剩余额度，再执行七题真实调用与同模型复评，专用门禁要求全部通过。固定 DeepSeek flash 主/研究/评分模型和实验候选上限 2，不改变生产默认配置。
- 两个 workflow 均在步骤失败时上传现存 test-results。离线 artifact 保留 14 天，真实 artifact 保留 30 天。超时与缺题、重复任务、执行失败、引用/预算/重放失败均不能通过门禁。真实评审失败或 needs_review 也不能通过。
- 开发基线 `evaluation/baselines/pilot-v4-k2.json` 来自 pilot-suite-k2-1794839214 的七题成功复评，冻结每题输入哈希及终态、卡片数；保留 humanReviewed=false、independent=false。原始 test-results 不纳入 Git；基线元数据可版本管理，完整报告留在本地和后续 Actions artifact。
- fixture 只验证结构执行，允许未解决的事实语义 needs_review，不能替代真实语义评审。真实评审仍属于已暴露开发题的同模型辅助判断。

## GitHub 上需要配置

1. 将工作区所需的项目文件及新增 CI、scripts、evaluation 基线提交并推送至你的仓库，通过 PR 合入默认分支。当前工作区有大量既有改动，请选择确认过的文件提交；此任务没有自动提交、推送或修改远程配置。
2. 仓库 Settings → Environments → New environment，名称必须为 `agent-evaluation-live`。在该环境的 Environment secrets 添加：
   - `OPENROUTER_API_KEY`：供 Jev 使用的专用评测密钥；供应商账户设置无周期重置的额度，剩余额度须大于零且不超过 1 美元。
   - `DEEPSEEK_API_KEY`：供主 Agent、研究与同模型评分使用。
   不需要 GitHub Secret 来配置 SQLite；运行时为每项实验自动创建隔离数据库，包含在 test-results 报告中。
3. 打开一个 PR，确认 `Agent evaluation / offline` 状态检查出现并通过。
4. 在 Settings 的分支保护或 Rulesets 中，对默认分支启用 Require status checks to pass，选择上一步实际出现的 `Agent evaluation / offline` 检查。workflow 只能提供红绿检查；设置为必需检查后，失败才会阻止合并。手动 live 检查不要设为每个 PR 的必需项。
5. 默认分支包含 workflow 且 Actions 已启用后，每日北京时间 09:17 自动运行，无需打开 WSL。首次可在 Actions → Agent evaluation live → Run workflow，选择默认分支、勾选 accept_paid_calls 后运行。无人值守环境不要设置每次必需的人工审批；可将环境允许分支限制到默认分支。费用由供应商账户承担，DeepSeek 直连费用不在 OpenRouter 1 美元额度内，DNA_COST_ALERT_USD 也不是硬封顶。OpenRouter 无重置专用额度耗尽或密钥过期时，前置校验失败，须账户持有人补充额度或更新密钥。
6. 查看运行页面 Jobs 和 Artifacts。真实评测成功时 `ci-live/ci-gate.json` 应为 passed:true、tasks:7、humanReviewed:false、independent:false。失败先检查 summary、每题 score、review 和日志，不覆盖原实验或反复重跑掩盖失败。

GitHub 环境与分支保护的可用性取决于仓库可见性和账户计划。如私有免费仓库无法使用环境，需先解决环境功能可用性，或明确调整 workflow 使用仓库 Secrets；当前实现保留环境隔离。

官方配置说明：
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

## 定时运行与通知

cron 使用 UTC：`17 1 * * *` 对应北京时间每日 09:17。GitHub 可能延迟执行；公开仓库无活动 60 天会停用定时任务，fork 的 Actions 也需要先在 GitHub 启用，不能视为保证准点的调度服务。

每轮均生成 daily-summary.md，并发布 Actions Job Summary；即使缺密钥或任务失败，也会尽力保存摘要和现有报告。通知使用 GitHub 自带功能，不需要额外邮件密码：个人 Settings → Notifications → Actions，开启 Email/Web，按需选择仅失败通知。定时运行通知通常发给最后修改 cron 的用户，需确认是你自己的账户。配置后可用手动运行验证邮件；未启用个人通知时不承诺发送邮件。

只要环境 Secrets 配好、没有人工审批等待、默认分支代码可用，定时任务就会自动执行。DeepSeek 前置只检查密钥存在，不声称验证了余额或硬预算；密钥无效、网络问题等会由实际调用和门禁报错。

- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs

2026-11-17 新增定时调度、前置校验和摘要，31 项免费离线回归全部通过；未新增付费模型调用。

## 本地验证（2026-11-16）

- WSL Linux Node 24.21.0 工作区类型检查通过。
- 最终 29 项离线测试全部通过，包含门禁测试 4/4，确认缺题退出码 1。
- 确定性评分回归 48/48，七题 fixture 门禁通过。
- 对已有七题真实输出执行新版 CI 门禁通过，没有重新调用付费模型。
- 两份 workflow YAML 解析通过。尚未在 GitHub 托管 runner 上实际运行，待上述配置与推送后验收。

重新验证免费流程：

```bash
npm run check
node --import tsx --test scripts/eval-tasks/*.test.mjs apps/dna-server-api/tests/research-plan.test.ts apps/dna-server-api/tests/report-citations.test.ts apps/dna-server-api/tests/model-policy.test.ts apps/dna-server-api/tests/snapshot-window.test.ts apps/dna-server-api/tests/evaluations.test.ts
npm run eval:calibrate -- --labels evaluation/annotations/v4 --check --out test-results/local-ci-calibration
npm run eval:tasks -- --config evaluation/experiment.v4.json --backend fixture --research-candidates 2 --out test-results/local-ci-fixture
node scripts/eval-tasks/ci-gate.mjs --input test-results/local-ci-fixture --mode fixture
```

输出目录必须是新的；重复验证请换目录名。
