# 真实公开技术资料包 v1（待人工审核/标注）

本包包含实际下载的 **180 份固定版本文档**，不是合成数据。开发集 40 / 测试集 140；自动识别中文 22、英文 154、中英混合 4；36 条独立复核分配尚未完成。人工主标签和已完成复核均为 **0**。可用于学习、试标注和真实来源研究，但当前不是经过认证的新闻质量基准。

来源为 AgentScope Java 51 份、Pydantic AI 122 份、NumPy 7 份。根许可分别为 Apache-2.0、MIT、BSD-3-Clause，完整许可及原文中的归属已保留；检查了子目录许可文件，属于例外目录的内容不会自动按根许可收录。对外再发布前仍须人工复核文件许可范围和隐私筛查。

## 从哪里开始

- `INDEX.md`：可点击的原始来源索引，先看 dev。
- `samples.jsonl`：样本 ID、分组、语种、真实来源和日期依据。
- `snapshots.jsonl`：完整正文（只规范化 NFC/LF，没有模型改写或静默删改）。
- `source-index.jsonl`：固定提交、最近可证明的文档修改提交、原始下载链接和正文哈希。
- `annotations.template.jsonl`：待人工填写，空身份/时间/label 不能直接导入。
- `annotation-starter.dev.jsonl`：已挑出的 5 条 dev 空白模板（覆盖三种语种），适合第一次试标注；选取 ID 记录在 `starter-selection.json`，不含参考答案。
- `review-assignments.json`：36 条待复核任务，独立完成后再比较，不是已经复核。
- `licenses/`、`acquisition.json`：来源许可和采集/排除记录。
- `preparation-report.json`：数据分布、待审核项及适用边界。
- `integrity-audit.json`：180 条逐条核对正文哈希、修改提交时间、修改时与抓取版本的 Git 文件对象一致性结果。

原始发布时间不可证明时没有伪造日期：这里 `publishedAt` 明确指 **最后一次可证明的源文件更新提交时间**，`originalPublicationDate=null`。采集结束时间是 referenceTime，不是发布时间。仅使用此前 14 天内、Git 历史完整可验证的修改；浅克隆根边界无法证明的日期已剔除。快照固定至仓库提交，不随 main 漂移。

为保留可验证证据，本次对命中邮箱、凭据形式、私钥头或带敏感参数 URL 的文档**整份排除**，而不是改掉正文却继续沿用原文哈希。未导出 Git 作者邮箱和提交消息。自动筛查不能证明绝对无敏感信息，人工审核仍需逐条检查。

## 当前不能据此宣称什么

这批主要是开发者文档更新，不能代表互联网新闻、营销噪声或真实生产来源的整体分布。NumPy 变更记录只是候选负例，必须由人工按 AgentRadar 关注主题判断。相关性、重复关系、HFS、可用性等没有由模型预填 gold。

自动分组共 85 组，合并同一更新批次、规范化后的中英/相邻版本路径和完全相同正文，结构上没有跨集组；**语义上的事件隔离仍需人工确认**。同一次功能发布可能跨多个提交，不应把结构校验当成无泄漏证明。确认时如需合并跨集组，应建立新的 split/数据版本，再进行质量冻结；不能通过修改测试标签迎合结果。

当前 test 只有中文 15 / 混合 3，共 18 条，无法提供 20 个有效中文重复正例。后续应补采更多真实中文、混合语言的重复/补证/版本演进，以及更多明确负例与非文档新闻；不能用自动翻译、复制正文或拆分同一页面凑真实样本数。

## 你需要做什么

1. 先选 5 条 dev 阅读原文，确认资料主题和标注规则适合你的展示目标；再完成全体来源、语种、隐私与事件分组复核。
2. 按 `evaluation/rubric.md` 填主标注，并找另一位能读懂相关资料的人独立复核每个 split 至少 20%。有分歧再找第三人裁决。模型可以解释术语，但不能代签人工标注或复核。
3. 导入到新目录，保留这份原始包：

   ```bash
   node --import tsx scripts/m4/cli.ts validate --input evaluation/corpora/public-doc-updates-v1
   node --import tsx scripts/m4/cli.ts import-annotations --input evaluation/corpora/public-doc-updates-v1 --annotations /path/to/actual-human-labels.jsonl --out evaluation/corpora/public-doc-updates-labeled-v2
   ```

4. 完成补采和人工验收后再冻结。当前包会被质量冻结门槛拒绝，因为标签/复核未完成。真实付费 A/B/C 仍未执行，需要用户之后明确授权预算。

重采命令在项目根目录运行（Python 3、Git；输出目录必须新建）：

```bash
python3 scripts/m4/collect-public-sources.py --cache /var/tmp/agentradar-public-repositories-new --out test-results/real-source-acquisition/new
node --import tsx scripts/m4/build-public-corpus.ts test-results/real-source-acquisition/new evaluation/corpora/public-doc-updates-new
```

公开仓库后续的文档数和日期可能不同，重采不保证仍有 180 条；固定版本、正文、哈希和许可是复现本包的依据。无须提供 GitHub/模型密钥；本次没有付费 API，也没有读取或替换任何运行数据库。
