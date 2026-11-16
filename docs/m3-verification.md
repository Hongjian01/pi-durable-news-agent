# M3：AgentRadar 产品展示与兼容性验收

2026-10-27。基于 `SPEC.md` 第 1、13、14、16.3、17 节，接续 M2 的 J01–J08 离线工程基线。本阶段保留 Durable 执行、Jev 六类判断、研究子 Agent，以及原有包名、路由、存储目录和 CLI/TUI。

## 产品改动

- Web 品牌改为 AgentRadar，主要入口、偏好、阶段、证据和费用说明使用中文。深色青绿工作台保留原有执行树和双栏结构；紧凑窗口可纵向查看，支持键盘焦点和减少动效偏好。
- 增加手动扫描控制。每次明确新提交生成 UUID，网络失败重试复用本次 UUID；活动扫描期间禁用新的扫描入口。通过新增 `POST /v1/sweeps` 的 client/chat 权限调用，不向浏览器提供 cron token，也不改变原 workflow 的鉴权。
- 扫描展示来自持久业务记录的状态、真实阶段、等待原因、下一次尝试、计数、缺口及取消入口。SSE 重连重新载入服务端快照，REST 轮询补充当前业务状态；扫描详情同时展示进展时间、截止、epoch 和原执行树。
- 卡片显示中文研究分析、为什么值得关注、Hype/Facts/Signal 三维、来源核验入口和事件时间线。详情展示声明原文、引用、快照获取时间、正文 hash、UTF-16 区间和判断标识；服务端重新查询有效声明，不信任 Agent 自填的 verifiedClaims。历史卡片缺少证据时明确显示未核验。研究提示使用中文，原文 quote 保持原样。
- 收藏通过业务设置持久化，有独立收藏页；分页按原卡片 ID 查询，避免旧事件卡片不再出现在最新情报时丢失收藏。赞同、减少推荐和主题/来源权重继续保留，并说明从下一轮扫描生效。不会用反馈文案承诺默认关闭的自动发现来源将在下轮执行。
- 执行详情展示持久 Jev operation、上下文/命令版本、输入、规范化结果、policy、attempt、raw response 和缓存来源；每页 50 个 operation，可加载更早记录。保留原有 Agent/工具/子 Agent 树。
- 每类出站费用分别展示报告金额、估算金额、费用未知次数、执行未知次数和覆盖率。顶部链接称“费用与覆盖”；旧版每日统计明确标为历史投影，不能当作完整费用。未知费用不显示成已知零。

## 预设与已有数据

新增 `config/agentradar-preset.json`：8 个来源（GitHub Releases、官方 RSS/更新页及开发者博客），4 个关注主题。H/F/S 的词表继续保留；四个主题可以编辑，不把主题数与 HFS 特征词总数混为一谈。

首次空库初始化在事务中种入预设。已有用户启动时不再自动导入 config 新增来源；即使旧初始化标记缺失，只要已有业务数据或偏好，也保留原配置。旧用户通过“偏好设置 → 预览差异 → 应用所选项”更新，已有项默认不勾选。明确勾选的已有项才恢复预设权重并启用；不选的手工设置保持原样。应用前核对偏好版本，避免过期预览覆盖新修改；抓取时间等健康信息变化不会使预览无故过期。

图片和自动发现来源默认关闭。自动发现可显式设置 `DNA_AUTO_DISCOVER_SOURCES=1`；该开关随扫描上下文冻结，旧上下文没有该新增字段时保留原兼容行为。本阶段不增加 schema 迁移，收藏沿用已有 settings 存储。

## 验证和演示

平台：WSL Ubuntu、Linux Node 24.21.0；依赖来自 M2 已安装的锁定 workspace，未新增依赖。独立副本为 `/var/tmp/agentradar-m3-20261027`。未调用真实付费 API，也未升级或替换已有运行数据目录。headless Chromium 使用本机已安装的中文字体进行视觉检查；未下载或分发字体文件。

- **P02**：`ui-m3.mjs` 对 queued、running/retry、finalizing、partial、cancelled 使用真实隔离数据库状态，逐一刷新后核对界面；检查下一次重试、partial 缺口、未知费用与已知零费用的区别。取消通过真实 UI → 代理 → API 改变业务状态。
- **P03**：SDK、CLI、TUI、Cron、Hub 及原有 Web capability 检查继续执行。新路由归入已有能力，不向 CLI/TUI 强加新复杂页面。修复 SDK 无正文 POST 在浏览器代理上缺少 JSON 类型的问题，保持代理原有 JSON 写入校验。
- **P04**：新用户八源四主题；旧用户删除、禁用及手工权重在重启后保留，包括初始化标记缺失场景；选择性补回单项不覆盖其他项；过期预览拒绝应用。
- 独立 API 集成检查 client/cron/匿名权限隔离、同 requestId 并发手动提交、声明证据、持久费用、收藏和重启恢复。
- 演示一：在 `snapshot_committed` 真正 SIGKILL API，使用同一数据目录重启。sweep、submission、context、epoch 和原快照绑定不变，最终四张新闻卡片且 item 唯一；等待 SSE 重新连接并重新载入卡片后再截图。
- 演示二：新建另一套隔离数据目录，从手动扫描开始，经过 Jev 筛选、子 Agent 研究、核验与发布，展开引用和执行判断记录。使用中文 faux 数据说明交互，不把 fixture 判断称为真实模型质量验证。

两条演示均由 Playwright 录制真实浏览器视频，同时保留 screenshot 和 SQLite 断言；不是使用截图代替恢复测试。状态分支和费用覆盖 probe 是明确构造的隔离展示 fixture，与真实进程中断验证分开记录。

最终通过数、命令、锁文件 hash、日志路径与文件一致性见 `docs/baselines/m3-results.json`。应用/脚本的受测源码 SHA256 清单在 `docs/baselines/m3-source-sha256.txt`。早期失败日志保留，不计作最终通过。

完整 API **163 通过、1 个付费测试跳过**（共 164 项）；旧用户标记缺失保护及来源开关兼容补充回归 **10 通过**。原 Web **79 项检查**与 M3 产品 **24 项检查**全部通过。Jev **18 通过、1 跳过**，Durable **20**，SDK **18**，Cron **8**，CLI **5**，TUI **14**，Hub **2**，faux/recovery **22** 全部通过。类型、Web 构建、lint、格式通过，保留原有 **9 warning、0 error**。142 个应用/脚本文件与受测 Linux 副本逐文件 SHA256 一致，`git diff --check` 通过。

本机最终演示和截图位于 `test-results/m3-verified/`：`recovery-demo.webm`、`evidence-demo.webm`、`02-recovered.png`、`03-source-evidence.png` 等；双库也一并保留。fixture 保留上游故意提交非法 poster 组件的一次调用，用于展示工具纠错；随后合法组件正常发布，不是未处理的业务失败。原始日志在 `test-results/m3-final/`，兼容包运行日志在 `test-results/m3-compatibility/`；后者早期中文标签断言失败已由最终 Web 79 项检查覆盖。

复现（独立 Linux Node 24 副本，已安装锁定依赖及浏览器）：

```bash
npm run check
npm test -w dna-server-api
npm run build -w dna-client-browser
export DNA_BROWSER_EXECUTABLE=/path/to/chromium
node apps/dna-client-browser/tests/ui-faux.mjs
node apps/dna-client-browser/tests/ui-m3.mjs test-results/m3-local
```

`ui-m3.mjs` 每次生成独立 run 子目录，保留两套 fixture 数据及两条视频。离线演示数据库不能合并或复制覆盖运行数据目录。

## 边界与下一阶段

本阶段通过离线产品与兼容性验证，不代表真实供应商可用性、质量阈值或实付费用已验证。HFS/claim-support 模型值不等于经过校准的事实真实概率。价格或 usage 缺失仍为 unknown，金额告警是软边界。

后续 M4 建立按事件隔离的冻结标注集，执行 A/B/C 和真实重复实验，报告分母、区间、失败和未知费用，再完成评测与开源交付。本轮继续暂缓真实付费 API 测试。
