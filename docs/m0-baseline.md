# AgentRadar M0 基线与首批 Outbox 改造

记录时间：2026-10-26 至 2026-10-27（Asia/Shanghai）。规范依据为 `SPEC.md`；风险审查作为设计输入。原始源码提交为 `273b79bb8d3d8907cae9fbd6abd3da163ee2a343`。本记录区分原始失败、环境修复与新实现；不将 fixture 结果视为真实模型效果。

## M0 结论

离线基线通过。真实付费 API 根据用户要求未运行；真实模型、Jev 服务及供应商计时/费用能力仍未验证，不属于本次已通过的范围。

- 未找到适用的 `AGENTS.md`；保留用户原有的 SPEC、开发计划和风险审查。
- Ubuntu 24.04.3 / WSL2，Linux 内核 `6.6.87.2-microsoft-standard-WSL2`。
- 找到 Linux Node `24.21.0`，位置为 `~/.nvm/versions/node/v24.21.0/bin/node`，npm `11.19.0`；初始登录 PATH 没有它，`npm` 曾指向 `/mnt/e/nodejs/npm`。
- Windows Node 为 `24.13.0`，npm `11.6.2`。首版验收使用 Linux，未作全面 Windows 兼容承诺。
- 两次按原锁文件 `npm ci` 安装成功，各安装 261 个包；Linux 临时目录第二次使用 npm 本地缓存离线安装。未更新依赖版本。
- 安装 zsh `5.9`。Ubuntu 的 just `1.21.0` 无法解析 `check: test::unit`，改用官方 Linux just `1.59.0`，`just --list` 成功。
- 安装 Playwright 对应的 Chrome for Testing `156.0.8078.4` 及缺少的 `libnss3`、`libasound2t64`。浏览器测试保留原 Chrome 默认入口，增加 `DNA_BROWSER_EXECUTABLE` 可选路径。

## 原始失败及修复

初始 `/mnt/e` 工作目录中，类型检查通过，但恢复子进程出现启动超时，后续 API/Cron 也触及外层 300 秒保护。保留该次部分日志于 `test-results/m0-original/`，不当成业务正确性结论。将相同源码、锁文件放到 WSL Linux 文件系统 `/tmp/agent-radar-m0`，重新安装依赖后，Durable 包的 19 项测试全部通过。后续验收统一在 Linux 文件系统运行，Windows 工作目录用于编辑和结果归档。

Linux 原始基线还发现：

1. `stream.test.ts` 断言 `feed.state.agent.busy === false` 时，转录已追平，但独立的 500ms 合并状态尚未到达。增加等待这个实际状态的条件，保留原断言；没有改变 SSE 或业务状态的含义。
2. Git `core.autocrlf=true` 的 CRLF 检出导致 311 个文件格式检查失败。添加 `.gitattributes` 固定 LF，并归一化已有受跟踪文本。归一化没有源码内容差异，也没有修改依赖解析结果。
3. UI 初次因缺少 Linux Chrome 失败。安装浏览器后原有完整 UI 测试 `ALL PASS`。浏览器启动早于原 `try/finally`，增加进程退出清理，避免启动失败遗留 fixture 服务。

原始 Linux 结果保存在 `baselines/m0-linux-original.json`，最终 M0 汇总在 `baselines/m0-offline-results.json`。汇总保留首次 UI 缺少浏览器的失败尝试，另列安装后通过的日志，不覆盖原始失败。

## M0 验证结果

- `npm run check`：通过，包含 Web 类型检查。
- Jev：18 通过、1 个付费测试跳过；Durable：19 通过；SDK：18 通过。
- API：105 通过、1 个付费测试跳过；Cron：8；CLI：5；TUI：14；Hub：2，均通过。
- `npm run build -w dna-client-browser`、lint、fmt:check：通过。
- 原 faux/恢复/鉴权/workflow/stream/executions 组合：22 通过。
- 原 fixture UI：`ALL PASS`。
- 新 SDK 契约测试：2 通过。验证同会话并发同 requestId、SIGKILL 后重开数据库、终态后重交，均保留一个 submission、一条用户输入和一次 memoized effect。
- 契约同时确认：`harness.submission(id)` 可重取句柄；`status`、`inspect` 可读取状态；`tx.submissionByRequest` 可查询持久接纳。`abortSubmission` 只能撤回 queued 输入，对 placed 返回 `already_placed`；执行取消必须使用会话/任务 abort，后续还需要业务 fencing。
- 上游安全工具、非安全工具与两个研究子 Agent 的真实进程恢复测试通过。未重写 durable 引擎。

保留的原始流程演示在 `test-results/m0-fixture/`：12 条采集、8 条保留、4 张唯一 news 卡、每张 H/F/S 三维排序、2 个研究子 Agent、四阶段完成、审计无缺项、SQLite 完整性 `ok`、外键错误 0。目录含关闭写入后的两个数据库与 `summary.json`；演示数据不是生产库备份方案。

## M1 首批：提交 Outbox

M0 离线通过后新增 `002_submission_outbox.sql`，未改写历史 `001_schema.sql`。

- `BEGIN IMMEDIATE` 内完成 requestId 查询、活动位检查、sweep 创建、不可变上下文记录、已渲染提交 payload 和 outbox 写入。不同请求遇到活动扫描留下 `skipped / active_sweep`；重复请求返回原记录并尝试补交。
- 上下文保存六类 Jev 命令、研究提示、偏好/来源、配置模型标识、预算配置和 referenceTime；只选取配置字段，不序列化含密钥的整个 Config。
- Outbox 使用 `sweep:<id>` 稳定 SDK requestId；保存 `contextId` 和 `executionEpoch`。状态为 pending / submitting / linked / failed，30 秒租约，随机 token 隔离迟到持有者。
- 启动及每 15 秒对账。租约未到期时不会抢占；默认最迟下一周期领取过期租约。重交使用原 payload，submissionId 与 linked 状态在同一业务事务关联。SDK 已完成而尚未关联时，也能补齐关系而不重开业务。
- 未知错误保留 pending；明确永久错误记录 failed，并结束仍 queued 的业务。API 增加可选 submissionStatus，SDK 同步识别；现有路由、包名、CLI/TUI 保留。
- 新受理扫描不再走旧的创建时间 stalled/withdraw 检查。**可信进展检测和取消替代机制尚待下一批实现**；本批不能因此视为具备完整运行健康管理。

新增 `submissions.test.ts` 共 7 项，全部通过：

1. 业务事务提交后 SIGKILL，再启动自动补交。
2. SDK 已接纳但提交包装层尚未交出回执时 SIGKILL，恢复关联原 submission。
3. 收到回执、关联回写前 SIGKILL，恢复关联原 submission。
4. 事务回滚、租约互斥、租约过期、迟到持有者不能覆盖、终态后的关联修复、上下文不可变。
5. SDK 已接纳但响应丢失后，重复请求使用原 payload；并发同 requestId 去重，不同请求占用检查有效。
6. **真实 15 秒定时器**补交 pending；明确永久错误结束受理。
7. 带来源、卡片、反馈和历史终态的 001 数据库升级到 002，数据保留、重复迁移无操作、完整性与外键检查通过。

三个故障窗口均执行真实子进程 SIGKILL/重启，检查同一个 sweep、同一个逻辑 submission、epoch 未增加、原 payload/context 未变化、4 张无重复卡片。为避免每个测试等待 30 秒，进程停止后仅将测试库租约截止改为已过期；真实租约边界另有显式时钟测试。因此不把这三项说成验证了实际停机时长或完整取消恢复。

改动后的全量回归全部通过：API 112 通过、1 个付费测试跳过；其他核心包与 M0 相同，faux 组合 22 通过，Web 构建、类型、lint、格式和完整 UI 均通过。汇总在 `baselines/m1-outbox-results.json`，完整日志在 `test-results/m1-outbox/`。新增脚本独立严格类型检查、lint、格式检查通过；`git diff --check` 通过。带 Outbox 的保留演示位于 `test-results/m1-fixture/`。

## 复现

在 Windows 仓库中执行：

```powershell
wsl -d Ubuntu -- bash /mnt/e/agent/Jev/pi-durable-news-agent/scripts/m0/run-wsl.sh
```

脚本选择 Linux Node 24，创建独立 Linux 临时目录，排除 `.env`、现有数据库与 Windows node_modules，按锁文件安装，再跑全部离线基线、SDK 契约和 fixture。浏览器已装在 Playwright 缓存时自动使用；自定义浏览器可设置 `DNA_BROWSER_EXECUTABLE`。结果复制回仓库 `test-results/agentradar-m0.*/`，首次失败日志不会被下一次覆盖。临时工作目录保留用于排查，可在确认不再需要后自行清理。

已有 Linux 副本也可直接执行：

```bash
node scripts/m0-baseline.mjs test-results/current
npx tsc -p scripts/m0
NODE_NO_WARNINGS=1 node --import tsx --test scripts/m0/sdk-contract.test.ts
NODE_NO_WARNINGS=1 node --import tsx scripts/m0/fixture-smoke.ts test-results/fresh-fixture
NODE_NO_WARNINGS=1 node --import tsx --test apps/dna-server-api/tests/submissions.test.ts
```

完整日志和双库 fixture 放在已忽略的 `test-results/`，精简结果快照放在 `docs/baselines/`，便于后续提交代码时保留证据而不提交运行数据库。

## 后续边界

本节为 Outbox 第一批完成时的历史状态。2026-10-27 的完整 M1 离线验收见 [m1-verification.md](m1-verification.md)。

当前完成 M0 离线门槛与 M1 的提交恢复小批次，**没有完成整个 M1，更没有完成 M2–M4**。

- 接下来按 SPEC 做可信进展/等待、120 秒恢复宽限、24 小时截止、取消及全业务写入 epoch fencing。
- 本批保存的 evaluation context 尚未驱动所有判断/研究读取；当前只保证提交 payload 恢复不重新渲染。逐判断绑定、版本化缓存与完整配置重放仍待实现。
- item 级唯一发布、原子衍生关联、可恢复 finalization、错误与 no_news 分离尚待实现；当前 4 张无重复卡片只证明这些测试路径。
- 旧库缺少已渲染提交意图的 queued 记录不自动套用当前配置补造 payload。升级仍应排空/明确取消活动任务、停止写入，并按 SPEC 一致备份双库。
- 真实付费 API、长时间无人值守、完整 D01–D10/P01/P06、评测与成本结果未验收。

Durable 封装、Jev 六类判断与研究子 Agent 沿用上游。本批个人改造集中在提交事务、Outbox、对账及其故障证据，不将继承能力描述为独立原创。
