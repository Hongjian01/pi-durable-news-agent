# 从零复刻 AgentRadar 自动评测

本手册与 [实现总览](HANDBOOK.md)、[方法论](METHODOLOGY.md) 配套。目标是复刻代码、环境、数据和操作协议；真实模型输出受随机性/供应商版本影响，不承诺重现同一分数。

后续补齐的发布诊断校准、并发发布限制和反馈闭环步骤见 [最新实施与操作](COMPLETION-RUNBOOK.md)。每日真实任务现在包含七题基线和两题已审核历史失败；PR 同时执行两题免费回流烟测。所有参考与复评仍为模型辅助。

## 1. 新 Windows 电脑：进入 Linux

已有 Ubuntu/WSL 可跳到第 2 节。首次以管理员打开 PowerShell：

```powershell
wsl --install -d Ubuntu
```

按提示重启，打开 Ubuntu，设置 Linux 用户名与密码。密码输入不显示字符属正常。之后每次可在普通 PowerShell 输入：

```powershell
wsl -d Ubuntu
```

以下除明确说明外都是 Ubuntu 的 Bash 命令，不要把终端提示符一起复制。

## 2. 安装 Linux Node 24.21.0 和项目

本项目依赖 Linux Node 24 的 SQLite 等能力，不要沿用 Windows node_modules。建议安装在 Linux home 下，不依赖旧机器的 /var/tmp 路径。

```bash
sudo apt-get update
sudo apt-get install -y git curl xz-utils ca-certificates

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo '本手册仅覆盖 x64/arm64'; exit 1 ;;
esac
NODE_PACKAGE="node-v24.21.0-linux-${NODE_ARCH}"
mkdir -p "$HOME/.local/node24-download" "$HOME/.local/lib"
cd "$HOME/.local/node24-download"
curl -fLO "https://nodejs.org/dist/v24.21.0/${NODE_PACKAGE}.tar.xz"
curl -fLO 'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt'
awk -v name="${NODE_PACKAGE}.tar.xz" '$2==name' SHASUMS256.txt > selected.sha256
test -s selected.sha256 && sha256sum -c selected.sha256
# 校验成功后再执行解压。
tar -xJf "${NODE_PACKAGE}.tar.xz" -C "$HOME/.local/lib"
export PATH="$HOME/.local/lib/${NODE_PACKAGE}/bin:$PATH"
node -p 'process.platform + " " + process.version'
```

预期 `linux v24.21.0`。如果已装 nvm，可用 `nvm install 24.21.0 && nvm use 24.21.0` 替代下载步骤。此手册不要求把密钥写入 shell 启动文件；PATH 重启后需重设或使用你的版本管理器。

```bash
mkdir -p "$HOME/projects"
cd "$HOME/projects"
git clone https://github.com/Hongjian01/pi-durable-news-agent.git
cd pi-durable-news-agent
git checkout --detach 23e8af95f59683b0789c6c374c83ecf1130b645b
npm ci
npx playwright install --with-deps chromium
```

固定提交用于复现实验实现；要继续开发用 `git switch -c my-evaluation-work` 创建自己的分支。实际部署到自己的 fork 时将确认过的提交合入默认分支，不在 detached HEAD 上直接修改云端配置。

数据已经随仓库版本化保存，无需重新抓网。不要为了“初始化”覆盖 v3/v4 标签或基线。`eval:prepare` 是历史构建程序，复现时直接加载已有文件；需要新数据时使用新版本目录。

## 3. 不填密钥，完成免费验收

```bash
npm run check
node --import tsx --test scripts/eval-tasks/*.test.mjs apps/dna-server-api/tests/research-plan.test.ts apps/dna-server-api/tests/report-citations.test.ts apps/dna-server-api/tests/model-policy.test.ts apps/dna-server-api/tests/snapshot-window.test.ts apps/dna-server-api/tests/evaluations.test.ts

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
npm run eval:calibrate -- --labels evaluation/annotations/v4 --check --out "test-results/reproduce-calibration-$STAMP"
npm run eval:tasks -- --config evaluation/experiment.v4.json --backend fixture --research-candidates 2 --out "test-results/reproduce-fixture-$STAMP"
node scripts/eval-tasks/ci-gate.mjs --input "test-results/reproduce-fixture-$STAMP" --mode fixture
```

验收：类型检查无错误、离线测试通过、48 条评分参考案例匹配、七题流程结构门禁通过。六题 needs_review + 空题 passed 在免费烟测中可以是正常结果；fixture 并未完成模型语义判断。

不需要启动浏览器产品或数据库服务。runner 启动 worker，代码建立隔离 SQLite 并执行迁移。数据库位于实验目录内，不是让你填写 MySQL/PostgreSQL 地址。重放与恢复的目标是“不多发布、不写入旧执行结果”，不是每次重新利用生产库。

如果遇到错误先停止后续付费步骤；上述独立命令不会替你在失败时终止整个交互 shell。

## 4. 配置真实调用账户

两个供应商的用途：DeepSeek 官方 key 用于主 Agent、研究和当前同模型评分；OpenRouter key 用于 Jev。模型名以固定版本配置为准，未来模型下线时先创建新实验协议再升级，不能只改名称后声称同基线复现。

OpenRouter 专用 key 设置：Credit limit 1 美元，Reset limit 为 N/A，无周期重置，实际剩余额度需满足 `0 < remaining <= 1`。使用 `openrouter-credits` 不要求 include_byok_in_limit=true，但不覆盖 BYOK 账单。DeepSeek 账户应有可用余额，现有系统没有验证其美元硬封顶。

逐段输入，看到提示后才粘贴密钥；不要把后续代码连同密钥一起粘进去：

```bash
read -r -s -p 'OpenRouter API key: ' OPENROUTER_API_KEY
```

按回车，然后执行：

```bash
echo
export OPENROUTER_API_KEY
read -r -s -p 'DeepSeek API key: ' DEEPSEEK_API_KEY
```

再次粘贴密钥回车，再执行：

```bash
echo
export DEEPSEEK_API_KEY
export DNA_MODEL=deepseek-flash
export DNA_RESEARCH_MODEL=deepseek-flash
export DNA_COST_ALERT_USD=1
test -n "$OPENROUTER_API_KEY" && echo 'OpenRouter configured'
test -n "$DEEPSEEK_API_KEY" && echo 'DeepSeek configured'
node scripts/eval-tasks/live-preflight.mjs
```

前置成功只证明当前检查通过：DeepSeek 只核对 key 非空，未验证其账户余额/模型可用性。关闭终端后 export 消失，重新打开需重新配置。不要 echo 密钥，也不要将它放进 Git。

## 5. 第一次付费：单题生成与复评

```bash
OUT="test-results/reproduce-pilot02-$(date +%s)"
npm run eval:tasks -- --config evaluation/experiment.v4.json --task pilot-02 --repeat 1 --research-candidates 2 --out "$OUT" --backend live --enable-paid --max-usd 1 --budget-scope openrouter-credits &&
npm run eval:regrade -- --input "$OUT" --out "${OUT}-review" --judge-provider deepseek --judge-model deepseek-flash --enable-paid
```

`&&` 只保证前一个进程没有技术性退出失败；原 runner 默认允许内容 failed/needs_review 后退出零。复评也可能输出 failed 而进程退出零。判断任务成功必须读报告，完整 CI 则有专用门禁，不能只看命令退出成功。

查看原目录 summary.json、逐题 observed.json（实际卡片、研究、引用、终态）与复评目录 summary.json/review-1.json。第一次遇到 failed 不要直接增加重复次数，先按第 10 节归因。

## 6. 校准评分器

改变 semantic.mjs 或 judge 模型后，应重新运行正负校准集。模型标签有偏差，校准通过不是独立验收。

```bash
npm run eval:calibrate -- --labels evaluation/calibration/alignment-v1 --suite semantic --provider deepseek --model deepseek-flash --enable-paid --check --out "test-results/reproduce-alignment-$(date +%s)"
npm run eval:calibrate -- --labels evaluation/annotations/v4 --suite semantic --provider deepseek --model deepseek-flash --enable-paid --check --out "test-results/reproduce-semantic-$(date +%s)"
```

分别要求 6/6 与 36/36 匹配且没有 technical_error。先读 falsePass 与 false-negative 案例，禁止把错误标签改成模型输出以强行通过。保留旧协议结果。每日现有 workflow 不会每轮重新运行这两组收费校准。

## 7. 七题真实开发回归与严格门禁

```bash
OUT="test-results/reproduce-live-$(date +%s)"
npm run eval:tasks -- --config evaluation/experiment.v4.json --repeat 1 --research-candidates 2 --out "$OUT" --backend live --enable-paid --max-usd 1 --budget-scope openrouter-credits &&
npm run eval:regrade -- --input "$OUT" --out "${OUT}-review" --judge-provider deepseek --judge-model deepseek-flash --enable-paid &&
node scripts/eval-tasks/ci-gate.mjs --input "$OUT" --mode live --review "${OUT}-review"
```

要求七题集合完整、输入未漂移、终态正确、交付数量正确、研究完成、复评全 passed、评分协议与来源匹配。任何一条违反，门禁退出非零。不要对单题使用此七题基线门禁。

这里已经是自动执行，不需要人在每题之间点击；人的责任是定义协议、管理费用、判断争议，以及决定什么时候更新基线。

## 8. 策略实验与失败回流

```bash
# 免费三臂流程，不能证明模型质量。
npm run eval:candidates

# 付费：同一题 K=1/2/3 各一次；按需运行，不是复刻必跑步骤。
REPEATS=1 npm run eval:candidates -- --live

# 相邻概念开发题，合成资料上的真实模型调用。
CAMPAIGN_CONFIG=evaluation/experiment.adjacent.json CAMPAIGN_TASK=adjacent-1-1 REPEATS=1 npm run eval:candidates -- --live

# 导出已有实验的未通过项，不生成新模型答案。
npm run eval:capture -- --input "$OUT" --out "test-results/review-queue-$(date +%s)"
```

原始 A/B/C `--compare` 是 strategy_services 对照，不能与生产工作流 `--research-candidates` 混用。所有 K 三臂固定顺序，需在正式实验前补交错/随机化控制。

旧 `eval:capture` 产物停在 awaiting_review。新版闭环用 `feedback-loop.mjs` capture/promote/track 和 `review-feedback.mjs`，新版本可直接执行；一键验证已入库两题运行 `node scripts/eval-tasks/feedback-regressions.mjs --out NEW_OUTPUT`，真实模型再加 `--live --enable-paid`。它不自动训练模型或把模型标签宣称为 gold。`--security --reliability --components` 可扩展执行，但额外模式不是当前每日七题门禁的完整覆盖范围。

## 9. GitHub 全自动配置

用自己的 fork，确认 workflow 文件已在默认分支。现有项目是 [Hongjian01/pi-durable-news-agent](https://github.com/Hongjian01/pi-durable-news-agent)。GitHub Secrets 和环境属于这个仓库，不随 Git 代码传给上游。

1. 仓库 Settings → Environments → 创建 `agent-evaluation-live`；已有则直接打开。
2. Environment secrets 添加 OPENROUTER_API_KEY、DEEPSEEK_API_KEY，值分别为两家供应商密钥。不放到普通 Variables；SQLite 不需要 Secret。
3. 允许环境使用默认分支；要无人值守就不要启用每次 Required reviewers。
4. Actions 启用 fork 的工作流；默认分支 push/PR 会触发免费 CI。
5. 对默认分支配置必需检查 `Agent evaluation / offline`，失败才能阻止合并；单有 YAML 不会自动替你设置保护规则。
6. Actions → Agent evaluation live → Run workflow → 默认分支 → 勾选 accept_paid_calls → Run workflow。未勾会 skipped；不是运行成功。
7. 查看 Jobs：前置、生成复评、七题门禁、摘要、artifact。只有门禁通过才称本轮验收成功。点击 Artifacts 下载完整记录。
8. 个人 Settings → Notifications → System/Actions 开启 Email/On GitHub，初次可接收所有结果，稳定后只失败。通知依赖个人设置和定时任务 actor，不是本项目自己发送邮件。

每日 cron `17 1 * * *` 为北京时间 09:17。GitHub 可能延迟，公开仓库长期无活动会停用定时任务，首次成功后仍需定期检查。账户额度耗尽/密钥过期不是系统自动充值能解决的事情。

报告保留：离线 14 天、真实 30 天。需要长期审计应另存对象存储或定期下载。云端 runner 的工作目录会销毁，artifact 是跨运行保留途径。网页评测中心默认不自动拉取 GitHub artifact。

官方依据：[环境配置](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)、[定时事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[通知设置](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)。

## 10. 排错顺序

- Missing DEEPSEEK_API_KEY：终端 export 已丢失或 GitHub 环境 Secret 名称/环境引用错误；不要在日志里打印值。
- OpenRouter budget check failed：检查无重置、剩余额度范围和 budget-scope；不要通过删除校验继续扣费。
- 401/403：单独核查有效期、账户权限、供应商响应与网络；403 不一定是额度或 IP。`npm run eval:jev-check` 先检查元数据，添加付费参数才做小额模型探测。
- needs_review：检查事实改写是否超出字面规则，再复评已有输出，不必重新生成。
- failed/partial：先看审计 missing、budget_denials、researchPlan 和原始工具错误，再看全文质量。
- Source drift/输入 hash 不一致：不要在运行中改源码/题库；新协议另建 out 和版本，不能篡改 manifest。
- 云端“Run live tasks and same-model review”成功，但门禁失败：前一阶段退出零不等于评分全部 passed。下载 artifact 检查 summary、review、ci-gate 错误和任务集合。
- 免费 fixture 与真实结果不同：模拟模型用于测试工程路径，不负责模拟真实语义能力。
- 用尽预算：检查重复调用、批次绑定、无效引用修复和输出截断；不要首先增加上限。

## 11. 复刻完成的标准

工程复刻：新 Linux 环境安装成功，免费测试和结构门禁通过，输入 hash 对齐，报告可阅读，GitHub workflow 能触发并保存 artifact。

真实验收：至少一轮有效真实调用完成且七题严格门禁通过；若失败也应完整保存并能定位。模型结果不会因“复刻成功”而自动保证通过。

长期上线验收：增加未暴露事件、真实用户任务、安全/恢复切片、独立复核及成本对账；不属于当前七题成功的推论。完整升级方案见 [方法论](METHODOLOGY.md)。

## 12. 如何在这个框架里新增自己的数据

复刻现有系统直接使用仓库内快照；扩展业务则按下面顺序建设，不能只修改 prompt。

1. 在新的 `evaluation/corpora/你的版本/` 中准备 samples.jsonl 与 snapshots.jsonl，参考 public-doc-updates-v1 的实际字段。每份文档有唯一 ID/URL、正文 hash、采集时间、版本/许可、语言/事件分组；必须保存真实正文，不能用搜索摘要冒充原文。
2. 新建 `evaluation/annotations/你的版本/`，以 v4 tasks.jsonl、task-keys.jsonl 的结构为模板。题目 candidateIds 必须存在，来源 URL 一致，legacySplit 与样本分组一致；referenceEvidence 的 snapshotId/hash/原文 code point 范围必须能验证。labelOrigin 记录实际来源，不能直接复制 humanReviewed=true。
3. 写出可满足题面的参考交付，检验每个 requiredFact 是否真的能从允许来源得到；不可解题改为正确拒绝/证据不足任务或移出，不能留在“必须回答”的集合中。
4. 为每题派生正确改写、缺事实、错引用、过度推断等 grader cases。合成样例改变答案但不要偷偷改变来源。运行评分器校准检查结构，再运行真实语义 judge。
5. 复制 experiment.v4.json 到新配置，改 corpus/labels，模型与预算显式记录。`npm run eval:tasks -- --config evaluation/experiment.你的版本.json --backend fixture` 先验证加载与执行，再单题 live。
6. 输入验证以 `protocol.mjs/loadTasks` 为准，它校验快照、候选和参考引用；请调用现有加载器，不另写一套宽松校验绕过失败。
7. 现有 `ci-gate.mjs` 特意绑定七题开发合同，新题不要直接替换 v4 来通过旧门禁。验证新协议后创建新基线版本，并评审其门禁、预期终态、评分协议及任务集合。`freeze-ci-baseline.mjs` 是原七题基线的一次性固化程序，不是任意数据集的自动入库工具。
8. 新实验保留原始失败，先不把结果写回标准答案；经过标注审核后再提升为新回归集。

现有 `prepare.mjs`、`prepare-v4.mjs`、`prepare-adjacent.mjs`、`prepare-alignment-calibration.mjs` 可用于阅读学习如何生成各版本。它们具有特定输入路径/领域假设，不能当成通用数据标注 API；生成新版本时保留来源与变更理由。
