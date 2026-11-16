# M2：判断、研究证据与持久预算验收

2026-10-27。开发基线为 `SPEC.md` 第 8–13、16.2、17 节。本文接续 `m2-context-cache.md` 的第一批历史记录；完成研究配置接入、来源快照、中文召回、逐声明证据和扫描全链路出站预算。Durable 执行、Jev 六类判断、研究子 Agent 均保留。

## 实现

- 受理时冻结研究系统/用户提示词、研究模型、desk 实际模型、quick 设置、来源计划、预算及证据阈值。研究子会话在创建事务中保存原 sweep、epoch、item 集合、deadline 和系统提示词。生成与工具通过原 Durable 任务祖先绑定上下文，不能采用下一轮配置。
- 新增 `005_evidence_budget.sql`：不可变正文快照及本轮 URL 绑定、研究报告、claims、quote/hash/UTF-16 字符区间、预算预约与费用结算。正文按 NFC 与 LF 规范化；快照保留实际获取时间。已有快照的 page/deep/hyper 读取直接重放原文，新抓取内容不覆盖旧绑定。全局缓存持久保存截断标记；旧缓存缺少完整性信息，升级后保守标为截断。
- quote 校验与 claim-support 分别执行。缺失正文、链接、摘要、伪引用和截断正文不能成为 supported；抓取失败保存 source error。足够材料下的否定是 unsupported，材料不足为 insufficient，多来源的明确冲突为 conflicting。最多五条声明，每条最多三个引用；发布时重新核对本轮成功判断、正文 hash 与区间，只将 supported 声明放入 `verifiedClaims`。其他文案明确标记为分析。没有有效声明则不足以发布。
- 中文检索使用 NFKC、英文实体/版本 token 和 Han bigram，保留否定词；按已知日期收缩到 14 天窗口，每项最多 12 个候选，同分按 ID 稳定排序。same-story 最多五个历史发展片段，每片段正文 2,000 字符，总 JSON 不超过 16,000 字符；缺失历史材料时保守返回 uncertain。
- 出站统一执行持久事务预约，覆盖 Jev、desk/research/quick 模型、HTTP、搜索、Firecrawl 和启用后的图片请求。所有重试、重定向和 unknown attempt 占用硬计数；每项研究最多 12 次模型调用，每次生成请求最多 2,000 output tokens，禁用供应商隐藏重试。批次研究的每次模型请求同时计入该批各 item。
- 每轮默认 10 个来源、100 个候选、6 个研究项、研究并发 2、Jev 800 次。已有启用来源超过十个时，受理快照保存稳定选取的十个与未选 ID，不改全局来源偏好。扫描内禁止通过交互式 deep-dive 工具绕过持久研究计划；使用 `research_items`。
- 来源 HTTP 使用校验后的 DNS 地址连接，阻断私网/本地地址，每跳重校验、跨源去认证头；流式限制解压后 1 MiB，DNS 与 socket 均受超时控制。受理扫描中的正文抓取使用本地受控 HTTP，不交给远程 scrape 隐藏抓取链。
- 费用独立保存 reported/estimated/mock/not_applicable/unknown 与覆盖率；缓存引用不再次计费。模型价格完整时按 input/output/cache token 单价估算；缺少 usage、缺少价格且 SDK 只有默认零值时保持 unknown，已知免费缓存 token 可以计算为零。真实扫描前必须显式设置正数 `DNA_COST_ALERT_USD`；价格/usage 不完整时是软金额告警，不保证实付绝不超支。fixture 的零费用明确为 mock。业务完成后的最后一条确认使用本地零费用响应，Durable 提交正常结束。

## 验收与复现

平台为 WSL Ubuntu、Linux Node 24.21.0，锁文件 SHA256 见机器记录；锁定依赖以 offline npm ci 安装。副本为 `/var/tmp/agentradar-m2-20261027`，所有数据库均为新建的隔离 fixture。未调用真实付费 API，未升级或替换已有运行目录。

- J01：`context-judgments.test.ts` 的配置变更/缓存/SIGKILL 测试，加上 `m2-complete.test.ts` 的冻结研究模型、提示词和短正文 page/deep/hyper 重放测试。
- J02：严格 schema、一次非法响应重试、importance 不产生替代零分的既有回归继续通过。
- J03：纯中文同标题、中文不同表述、中英混合、全角版本、相邻版本候选及稳定顺序；单独检查历史输入上限。该小型构造集不能代表真实 recall@12 达标。
- J04/J05：引用/hash/区间、未抓取 URL、摘要、截断、来源失败、unsupported/insufficient/conflicting 分流，以及完整出卡时服务端证据断言。
- J06/J07：最后一个研究请求额度的并发竞争、unknown attempt 不退还、已知零费用与未知费用、缓存不重复计费；所有原始恢复/重试用例同时运行。
- J08：取消后的快照/证据/模型预约写入隔离，以及允许迟到费用仅作审计结算；既有终态/发布竞争测试继续执行。
- 增加真实进程 `snapshot_committed` SIGKILL：落库后中断，重启完成同一 sweep，原快照 ID/绑定不变，不重做已成功判断、不重复发卡。

完整检查结果及通过数保存在 `docs/baselines/m2-complete-results.json`；原始日志为隔离副本的 `test-results/m2-complete-final/`。早期失败日志保留在 `m2-complete-first/` 与 `m2-complete/`，不计作最终通过。

最终结果：API **161 通过、1 个付费测试跳过**（共 162 项，含 16 项新增 M2 综合测试）；Jev **18 通过、1 跳过**，Durable **20**，SDK **18**，Cron **8**，CLI **5**，TUI **14**，Hub **2**，faux/recovery 组合 **22**，浏览器 **79 个检查**全部通过。工作区类型、Web 构建、lint、格式通过；lint 保留原有 **9 warning、0 error**。M2 诊断/演示脚本单独类型检查通过。106 个受测应用/脚本文件逐文件 SHA256 与工作区一致，清单保存在 `docs/baselines/m2-complete-source-sha256.txt`，`git diff --check` 通过。

完整基线 API 为 160 通过；之后修正缺价时 SDK 默认零费用的边界，新增一项 J07 测试，16 项 M2 综合测试、工作区类型、完整 API 162 项与 lint/格式再次通过。补充日志在 `test-results/m2-cost-final/`，机器记录的 `finalValidation` 保存该批结果；无需重复运行未受影响的其他客户端测试。

```bash
export DNA_BROWSER_EXECUTABLE="$HOME/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome"
node scripts/m0-baseline.mjs test-results/m2-local
./node_modules/.bin/tsc -p scripts/m2
NODE_NO_WARNINGS=1 node --import tsx scripts/m2/fixture-smoke.ts test-results/fresh-m2-fixture
```

保留演示位于隔离副本 `test-results/m2-evidence-fixture/`：gathered=11、kept=7、4 张有 supported 声明的新闻卡片、2 个研究运行、9 份正文快照、4 条声明；业务终态 completed，audit.missing 为空，双库保留。来源计划上限使数量与第一批演示不同。所有请求成本均为 fixture mock，不能据此宣称真实模型质量或成本收益。

## 数据边界与下一阶段

005 为本轮尚未部署的追加迁移；001–004 历史文件保持原状。升级拒绝旧活动扫描；真实升级应排空/取消、停写并成对备份业务库与执行库。回滚使用同一次停机备份恢复两个库，不做单库降级。本轮只在 fixture 验证迁移与成对备份恢复。

M2 的 J01–J08 为离线工程验收。模型别名背后的权重不可冻结；首次未执行的抓取仍可能获得更新页面，实际获取时间保留。生成 output cap 依赖供应商遵守请求参数，金额计量不完整时仍有 unknown。交互式独立 deep-dive 保留上游功能，不属于已受理扫描的预算上下文。

后续 M3 接入中文产品页面、声明证据、状态恢复和费用覆盖率展示；M4 建立冻结标注集，执行真实模型 A/B/C 与质量/成本评测。当前不宣称质量目标、实付节省或真实供应商故障恢复成功率已获验证。
