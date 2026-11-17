# M4 离线评测与标注入口

**2026-11-17 完整手册**：[最新修复、验收与剩余事项](COMPLETION-RUNBOOK.md) · [体系复盘与实现总览](HANDBOOK.md) · [从零复刻](REPRODUCE.md) · [行业对照与通用方法论](METHODOLOGY.md)。下文和历史交付文档保留各阶段状态；请按实际提交与运行报告判断验收，不将部署完成等同于质量通过。

云端失败已完成取证：[43907971612 失败原因](CI-FAILURE-43907971612.md)。唯一失败为 pilot-04 的研究预算耗尽，伴随默认声明验证证据截断和无效重试；门禁正确拒绝未完成的交付。

最新工程交付与验证见 [DELIVERY.md](DELIVERY.md)，负责人待办见 [USER-ACTIONS.md](USER-ACTIONS.md)。网页评测入口为 `/#/evaluations`。

继续建设自动评测请按[逐步实现检查清单](IMPLEMENTATION-CHECKLIST.md)执行。每步包含修改位置、验证方法、完成条件和产物。

**自动评测入口**：在安装好仓库依赖的 WSL/Linux Node 24 环境执行 `npm run eval:auto`。[运行说明与评分口径](auto-evaluation.md)

2026-11-12 已增加[六家机构的评测实践](industry-methods-2026-11.md)、[2.1 修订方案](PLAN-v2.md)和[340 条已标注文档及配套任务](annotations/2026-11-12/README.md)。该包使用 Codex 银标，供开发诊断；下文 M4 人工标注数描述独立人工记录。

已新增 [真实公开文档包](corpora/public-doc-updates-v1/README.md)：180 份固定版本的真实技术资料，dev 40 / test 140，保留原文、更新提交、哈希和许可，人工标签仍为空。它是待审核/标注的文档来源池，不代表最终新闻质量基准；中文重复正例、更多负例和语义分组仍需补齐。学习及免费演示入口见 `docs/learning-and-demo.md`。

当前交付评测工程和待标注包。`corpora/engineering-v1` 是项目自行编写的 160 条**合成工程候选**（dev 40 / test 120），不是正式真实来源质量数据集。中文、英文、中英混合及负例用于验证管线；`annotations.jsonl` 为空。32 条复核分配仅表示任务分配，未表示完成复核。不得把 fixture 的输出、零 mock 费用或模型判断当成人工质量、真实节省或事实正确率。

开发基线为 `docs/SPEC.md` 第 15 节。先在 dev 集调试，按 story cluster 切分；同一事件的翻译、转载、增补和相邻版本应保守归为同一组，不得跨 dev/test。测试集冻结后不得根据结果调阈值或提示。

## 免费复现

在 WSL Ubuntu、Linux Node 24 和已安装锁定依赖的仓库中执行，所有输出目录必须为新目录：

```bash
npm ci
node --import tsx scripts/m4/cli.ts validate --input evaluation/corpora/engineering-v1
node --import tsx scripts/m4/cli.ts freeze --input evaluation/corpora/engineering-v1 --out test-results/m4-frozen
node --import tsx scripts/m4/cli.ts run --frozen test-results/m4-frozen --out test-results/m4-dev --split dev
node --import tsx scripts/m4/cli.ts run --frozen test-results/m4-frozen --out test-results/m4-test --split test
node --import tsx scripts/m4/cli.ts report --input test-results/m4-test
```

默认 backend=fixture、K=6、重复 3 次。生成另一份候选包可用 `fixture --out NEW_DIR`。冻结包含来源正文及哈希、referenceTime、策略、六类 Jev 命令、研究提示、预设、模型、实验预算和源码/锁文件指纹。运行前和各组启动前检查漂移；源码改动后必须重新冻结。固定输入不意味着真实供应商输出确定。

A 研究所有满足日期窗口的输入，预算显式按样本数扩大；B 复用 Jev 筛选、事件关联和重要性服务后取 Top-K；C 按时间取相同 K。B 筛选后不足 K 时保留实际数量，不补入被拒绝样本。每组每次独立双库和冷缓存；共用真实研究子 Agent、提示构建、声明验证、HFS、发布与终态校验。评测 HTTP 被阻断，只能使用冻结快照；研究中要求额外页面会显式失败。截断快照仍是输入，证据不足不得作为删减 A 工作量的借口。

## 准备真实来源与人工标注

1. 从获得许可且经过脱敏的来源准备 >=150 条真实记录，dev 30–50 条、test >=100 条。保留原文、采集时间、URL、哈希、版权/使用依据；去除访问令牌、个人信息及私有内容。当前合成包不能通过改 origin 字段变成真实样本。
2. 可用只读导出命令，从**显式指定**的兼容库导出已持久化快照，不升级库、不抓取新页面：

   ```bash
   node --import tsx scripts/m4/cli.ts export-snapshots --database /absolute/path/dna.sqlite --selection evaluation/selection.example.json --out evaluation/corpora/captured-v1 --reference-time 2026-10-26T12:00:00Z
   ```

   selection 示例中的 ID 是占位符，执行前必须换成实际 item/snapshot 对及人工确定的 cluster、split、language、source、license。缺少可验证真实采集上下文的快照保守导出为 synthetic，不能用于真实质量发布。导出不包含人工标签，也不会自动判定转载许可。
3. 标注者按 [rubric](rubric.md) 独立阅读快照，填写 `sampleId/snapshotHash/annotator/role/at/label`。当前模板中的空字段和 `label:null` 必须由人工填写，不能直接导入。时间使用 UTC ISO；身份可用稳定匿名代号，不能由程序虚构签名。
4. 主标注覆盖全部样本。每个 split 至少 20% 由另一人独立复核，按语言和难例分层；复核前隐藏主标签和模型输出。保存 reviewer 独立行；分歧交由第三人 adjudicator 逐项解释。系统报告完整标签及逐字段一致率；仅 rationale 文案不同不算标签分歧。
5. 使用 `import-annotations --input OLD_CORPUS --annotations ACTUAL_ROWS.jsonl --out NEW_CORPUS` 创建新版本，保留旧包。每个角色每条样本只能一行；修订应在新的数据版本中整理替换行，不能向同版本重复追加。哈希不符、自我复核、越集 duplicateOf 或无前置复核的裁决会被拒绝。
6. `validate` 查看覆盖与分歧；真实质量包冻结前要求主标签完整、分歧解决、每 split 复核达标。现阶段不执行 live。未来需另行授权真实付费调用，并满足真实数据、人工复核、明确 live 开关和正数费用告警；开关不会绕过质量数据门槛。

## 解释报告

`summary.json` 与各组 `result.json` 保存样本和 prompt 哈希、已落库研究报告数、技术失败、模型请求/解析型号及时间、缓存引用和费用分类。`progress.json` 支持定位中断组；中断不伪装为完成报告，已有输出不自动覆盖或热缓存续跑。

质量指标只使用已解决的人工标签，显示分子、分母、Wilson 95% 区间；关键分母 <20 标为样本不足。缺失预测/技术错误不能从门控召回分母移除。中文召回含 zh/mixed 的人工重复正例，检查指定历史代表是否进入候选前 12。重复精度按人工指定的规范代表严格匹配。A/C 未使用门控，其门控召回不适用。来源支持比例是服务端逐声明校验结果，不是人工事实正确率。重复实验不把同一批样本重复计为新增独立样本；3 次仅报中位数，P95 在 <20 次时为 null。

公共采集成本与边际决策成本分开；真实采集费用未提供时明确 unknown，不能当作免费。reported、estimated、mock 和 unknown 不混为账单实付，`actualUsd` 保持 null。fixture 不产生节省结论。真实别名模型仍需记录解析型号和运行时间；未解析信息不能冒充供应商版本。目标 90%/95%/90% 是验收阈值，不是当前实测效果。真实重复不足三次、标签未完成或指标样本不足时 `releaseReady=false`。
