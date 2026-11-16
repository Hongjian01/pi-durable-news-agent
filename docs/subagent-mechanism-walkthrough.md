# 跟着六条新闻学懂研究子 Agent：五阶段学习计划

日期：2026-10-30。适合已经知道整体扫描流程，但还不能解释子 Agent 怎样创建、工作、返回和恢复的学习者。

配套数据：[subagent-study-case.json](subagent-study-case.json)。前置材料：[单条新闻案例](single-news-walkthrough.md)。

## 一、怎么学，以及“完整数据”指什么

本文采用同一轮扫描、同一组六条新闻、同一对研究子会话贯穿五个阶段。不要每阶段重新设想一组对象。

建议五个学习时段，每段 90 分钟，共 7.5 小时；可每天一段，也可按现有七天计划分散阅读。它是 subagent 专题，不是额外要求再完成一套七天任务。

每阶段按“10 分钟复述→30 分钟阅读案例→20 分钟跟踪数据→15 分钟练习→15 分钟过关”执行。过关均为 5 题、每题 4 分，答案列出四个得分点；至少 16 分且无关键错误后进入下一阶段。无需调用付费 API，无需修改代码，也不要求背文件路径。

五阶段：

1. **委派与创建：**六条新闻怎样分成两个研究任务，变成子会话。
2. **模型与工具循环：**一个子 Agent 怎样研究三条新闻，另外一个如何并行。
3. **报告、汇总与业务交接：**数据如何落库，主 Agent 实际拿到什么。
4. **并发、预算、超时、恢复与取消：**沿原案例分析异常。
5. **抽象与对照：**用统一问题理解其他系统，完成面试口述。

### 数据使用约定

- 所有新闻、网址、ID、时间线和分数都是**教学假设**，不是一次真实运行或质量评测。
- JSON 包含六条完整教学正文、正文 SHA256、引用区间、工具参数、提示文本、报告和归一化结果；它不是生产数据库备份，也不是可直接导入的生产请求包。
- SHA256 根据配套文件中保存的正文实际计算；引用偏移也按这些正文计算。正文使用 LF 换行，文本超过 200 字符，不用缺省正文占位来解释抓取成功。
- `teaching-research-model` 是教学模型标识，不是实际可调用模型；Jev 的 0.90 等数值是假设的业务判断，不是实测事实正确率。
- 记录中的 `selected`、`researchStatus` 等有些是跨表关联后的便读视图，不能把示意 JSON 全部当成某张表的原生字段。
- 整个研究案例从“四阶段扫描已选出候选”开始，到 `research_items` 返回为止。此前采集、此后 HFS 与发布不计入本案例调用账目。
- “完整”指六条新闻在所讲机制中都有明确输入和输出；不伪造网络包、全部 token、供应商原始 JSON 和账单。实际费用未知，保留 null。

## 二、固定案例：请先认清这些对象

### 1. 研究起点

```text
本轮扫描：sweep 42，running
上下文：context 77
执行版本：epoch 0
参考时间：2026-10-30 09:00:00，北京时间
本次 research_items 工具任务：task 500
本次研究截止：2026-10-30 09:05:00，北京时间
已经选中的条目：101、102、103、104、105、106
```

假设这六条均已通过筛选和排序，没有待复核的事件关系；来源都可取得完整正文。研究开始时没有本轮研究报告，没有本轮新闻卡片。

### 2. 六条新闻

- **101**：OrbitKit 2.4 发布：增加可恢复会话；来源 OrbitKit Official；`https://orbitkit.example/releases/2.4`。
- **102**：QueryNest 1.8 发布：增加混合检索；来源 QueryNest Official；`https://querynest.example/releases/1.8`。
- **103**：ToolBridge 3.1 发布：增加工具参数校验；来源 ToolBridge Official；`https://toolbridge.example/releases/3.1`。
- **104**：CacheLeaf 0.9 发布：增加版本化缓存；来源 CacheLeaf Official；`https://cacheleaf.example/releases/0.9`。
- **105**：TraceDock 1.2 发布：增加执行轨迹；来源 TraceDock Official；`https://tracedock.example/releases/1.2`。
- **106**：EvalHarbor 2.0 发布：增加冻结评测集；来源 EvalHarbor Official；`https://evalharbor.example/releases/2.0`。

六条发布时间均为北京时间 2026-10-29 09:00。每条先只核验“该版本已发布”一个事实声明，其余建议是分析，不扩展成已经验证所有功能。

### 3. 稳定身份对应

```text
research_items task 500：一次研究调度工具任务，涵盖六条

批次 A，index 0：items [101,102,103]
  子会话 conversation 201
  输入提交 submission 901
  requestId = research:500:0

批次 B，index 1：items [104,105,106]
  子会话 conversation 202
  输入提交 submission 902
  requestId = research:500:1

item 101 → snapshot 301 → report 401 → finding 501 → claim 801
item 102 → snapshot 302 → report 402 → finding 502 → claim 802
item 103 → snapshot 303 → report 403 → finding 503 → claim 803
item 104 → snapshot 304 → report 404 → finding 504 → claim 804
item 105 → snapshot 305 → report 405 → finding 505 → claim 805
item 106 → snapshot 306 → report 406 → finding 506 → claim 806
```

一个研究调度 task 不等于一个子会话；一个子会话可研究多条；每条报告提交又是自己的工具任务。本例 report_findings task 为 7001～7006，不能六份报告都错误使用同一个 task 500 作为报告幂等身份。

## 阶段一：主 Agent 怎样把任务交出去

### 1. 学习目标

理解“工具调用参数→研究任务规格→子会话→输入提交”四个不同对象。这个阶段不要求解释引用校验。

### 2. 第一步：主 Agent 提出调用

工具名：`research_items`。参数完整示例：

```json
{
  "sweep_id":42,
  "batches":[
    {"item_ids":[101,102,103],"focus":"核实版本是否已发布并保留原文证据"},
    {"item_ids":[104,105,106],"focus":"核实版本是否已发布并保留原文证据"}
  ]
}
```

**输入：**已经选中的六个 ID，不是六篇完整正文。

**处理：**工具先检查最多两个批次、每批最多四项、ID 不重复、数量不超预算、ID 属于本轮已选计划。通过后保存 `research_jobs`，身份是 task 500，并开始计算五分钟截止。

**输出：**允许安排研究。此时不是主 Agent 自己已经把新闻研究完。

**数据变化：**

```text
之前：六项 selected，尚无 task 500 的研究工作记录
之后：task 500，sweep 42，epoch 0，items [101..106]，running
        截止 09:05；候选条目状态进入 researching
```

`[101..106]` 在解释文字中表示连续 ID，实际参数数组在上方已完整列出。

### 3. 第二步：把批次变成研究规格

代码针对两个批次分别构造：

```text
spec A = 批次 A 的用户提示 + 研究角色配置
spec B = 批次 B 的用户提示 + 研究角色配置
```

两者可以使用同一模型和角色提示；因为任务与会话不同，仍然是两个子 Agent，不要求一定使用不同模型。

批次 A 的完整任务内容见 JSON 的 `batches[0].userPrompt`；核心任务材料为：

```text
Research these items for sweep 42.

ITEMS:
#101 OrbitKit 2.4 发布：增加可恢复会话 (OrbitKit Official) https://orbitkit.example/releases/2.4
#102 QueryNest 1.8 发布：增加混合检索 (QueryNest Official) https://querynest.example/releases/1.8
#103 ToolBridge 3.1 发布：增加工具参数校验 (ToolBridge Official) https://toolbridge.example/releases/3.1

FOCUS: 核实版本是否已发布并保留原文证据
```

此代码块展示任务材料，不冒充完整系统消息；实际模板还包含 Workflow、Definition Of Done 和 Report，配套 JSON 已保留完整渲染文本。

角色配置包含研究模型、low thinkingLevel、五个研究工具及观测/预算等扩展。系统提示要求读取资料、提供原文引用、提交报告，完整文本保存在各批次的 `binding.system`。

### 4. 第三步：创建或查找子会话

`spawnSubagents()` 在一次 Durable commit 中：

1. 查找 ownerTaskId=500 的已有子会话。
2. 没有则创建 conversation 201、202，归属于工具任务 500。
3. 配置研究角色，并为每个会话初始化原执行绑定。

批次 A 的绑定为：

```json
{
  "sweepId":42,
  "epoch":0,
  "itemIds":[101,102,103],
  "deadline":1793322300000
}
```

其中 deadline 对应北京时间 09:05。完整绑定还含系统提示，见 JSON。批次 B 的 itemIds 为 `[104,105,106]`。

这里创建的是独立会话，不是通过 shell 启动两个 `pi` 子进程；复制 Agent 配置也不等于复制主会话全部历史。

### 5. 第四步：向子会话提交输入

```text
conversation 201.submit(批次 A 提示，requestId=research:500:0)
  → submission 901

conversation 202.submit(批次 B 提示，requestId=research:500:1)
  → submission 902
```

同一会话内复用原 requestId，用于恢复时找回原提交；`index` 与原规格对应，不应恢复时随意调换 A、B 的身份。子会话运行有自己的模型与工具循环，主 Agent 的工具调用等待其结果。

### 6. 练习与答案

**练习 1：六条新闻对应几个子 Agent、几个研究调度任务？**

答案：本例两个子 Agent 会话、一个 research_items task=500。报告提交时还会产生六个 report_findings 工具任务，不能与调度任务混淆。

**练习 2：将条目 107 加到批次 B 会怎样？**

答案：本例原有六项再加 107，总量变七项，超过正常研究条目限制；107 也不在已选计划中。不能仅因 B 批容量还没到四项就认为合法。若要单独检验未选中规则，用 107 替换 106，总量仍六项，也会因 107 不在计划而被拒绝。

### 7. 过关题

1. **主 Agent 实际传了什么？** 四点：sweep ID；两个批次；每批 item ID；研究重点，未传全部正文。
2. **为什么是两个子 Agent？** 四点：两个 spec；各有会话；各有任务输入；不是按每个 item 创建会话。
3. **创建前检查什么？** 四点：Schema/批次容量；重复 ID；总量预算；本轮 selected 计划。
4. **ResearchBinding 保存什么？** 四点：sweep/epoch；条目集合；截止；系统提示。
5. **requestId 为什么稳定？** 四点：标识原提交；归属原子会话；重试找回已有结果；不能恢复时任意换身份。

关键错误：认为六项就启动六个进程；认为子 Agent 自动拥有全部主历史；认为传入任意 item ID 都会研究。

## 阶段二：子 Agent 怎样通过工具循环研究

### 1. 学习目标

理解子 Agent 不是“一次模型调用”，而是一个独立会话中持续的模型—工具循环。用 A 批展开，B 批按同一模式处理其三条。

### 2. 固定正常轨迹

本例为了明确计数，假设每批恰好四次模型生成：

1. **生成 1：**提出三个 read_item 调用。
2. **生成 2：**读取返回材料，提出三个初步 claim-support 调用。
3. **生成 3：**提出三个 report_findings 调用。
4. **生成 4：**阅读报告保存结果，返回每条一行的最终回答。

这是合法教学轨迹，不是代码保证每批恰好四次；真实模型可能逐项操作、纠错或补充资料。工具可能交错执行，两个会话也不要求同步进入同一阶段。

### 3. 读取正文：从 ID 取得材料

A 批的生成 1 提出以下工具参数：

```json
[
  {"item_id":101,"max_chars":3000},
  {"item_id":102,"max_chars":3000},
  {"item_id":103,"max_chars":3000}
]
```

数组只是三次调用的展示，每一项分别传给 read_item，不是把数组作为单次 read_item 参数。

运行时读取条目、取得或抓取正文，并返回快照信息。本例假设六份正文都在 09:00:20 已取得，未截断，显示长度足以覆盖完整教学正文。

item 101 的完整教学正文是：

```text
OrbitKit 2.4 is available.
This release adds resumable agent sessions. The release notes describe configuration, expected behavior, and documented limitations. Developers should review compatibility before updating their applications. This announcement does not claim independent verification, universal reliability, or measured cost savings.
```

读取结果还带有：

```text
item=101；status=researching；relevance=90；worth=85
snapshot=301；fetched_at=2026-10-30T01:00:20Z
body_hash=d8a9640c9f31a088a374cd83f0f71a5ef80cdf59027985f71813b98d96f8137f
offsets=UTF-16
```

完整工具文本在 JSON 的 `records[0].readItem.toolText`，其他五条对应 `records[1]` 至 `records[5]`。每条都有自己的完整正文、hash 和快照，不能拿 301 给所有六条共用。

**数据变化：**候选的 URL/摘要，变成可定位正文与引用的材料；快照绑定到本轮，主 Agent 不需要把这些正文全部搬进自己的会话。

### 4. 初步声明判断

A 批生成 2 为三条分别提出：

```json
[
  {"command":"claim-support","item_id":101,"claims":["OrbitKit 2.4 版本已发布"]},
  {"command":"claim-support","item_id":102,"claims":["QueryNest 1.8 版本已发布"]},
  {"command":"claim-support","item_id":103,"claims":["ToolBridge 3.1 版本已发布"]}
]
```

分别调用 jev_classify；本例不显式传 evidence，使用当前可用材料。假设每条简化分数为 0.90，工具文字分别返回 `supported 90: …`。

这里是子 Agent 获得的初步判断，不是已经写入正式 research_reports 的逐声明引用校验结论。后面的 report_findings 仍会正式检查本轮引用，并按支持、充分、冲突策略产生状态。

### 5. 提交报告：从模型分析到业务记录

A 批生成 3 为 item 101 提交的完整参数如下：

```json
{
  "item_id":101,
  "summary":"OrbitKit 已发布 2.4 版本；建议先阅读兼容性与限制说明。",
  "claims":["OrbitKit 2.4 版本已发布"],
  "citations":[{
    "claim_index":0,
    "snapshot_id":301,
    "quote":"OrbitKit 2.4 is available.",
    "start":0,
    "end":26,
    "body_hash":"d8a9640c9f31a088a374cd83f0f71a5ef80cdf59027985f71813b98d96f8137f"
  }],
  "evidence_urls":["https://orbitkit.example/releases/2.4"],
  "actionability":"medium"
}
```

这次报告工具任务为 7001，与 research_items task 500 不同。服务端从实际保存的快照取正文，检查 `[0,26)` 切片等于 quote、hash 一致、来源允许且属于本轮，再调用正式 claim-support 评估。

假设正式判断：supported=.90、sufficient=.90、conflicting=.10，故得到 supported，保存 report 401、finding 501、claim 801 与证据关系。其余五份报告参数完整保存在 JSON，均包含各自 hash 与正确区间：

```text
101 → snapshot 301 → quote "OrbitKit 2.4 is available."   → [0,26)
102 → snapshot 302 → quote "QueryNest 1.8 is available."  → [0,27)
103 → snapshot 303 → quote "ToolBridge 3.1 is available." → [0,28)
104 → snapshot 304 → quote "CacheLeaf 0.9 is available."  → [0,27)
105 → snapshot 305 → quote "TraceDock 1.2 is available."  → [0,27)
106 → snapshot 306 → quote "EvalHarbor 2.0 is available." → [0,28)
```

字段位置：`records[i].reportFindings.arguments`。不要把上面索引说明理解为需要自己补齐其余五份数据，文件中已经实际存在。

### 6. 独立会话到底隔离了什么？

conversation 201 中有 A 批任务、工具结果、模型分析和最终回答；conversation 202 对应 B 批。主会话只有委派请求和返回概要，不自动接收全部中间材料。

当前研究工具白名单只有 read_item、scrape_url、search_web、jev_classify、report_findings；没有 present_news、complete_sweep、修改调度等工具。

要准确理解隔离边界：独立上下文不等于进程级沙箱；绑定 itemIds 参与分工和预算，也不应被夸大为所有单项工具都严格逐条验证只能访问该批条目。当前已有工具白名单、原执行版本与跨扫描检查，批次级更细权限仍需逐条看实际校验。

### 7. 练习与答案

**练习 1：生成 2 已返回 supported，为什么生成 3 还要检查？**

答案：前者是辅助判断，不能替代正式报告对本轮快照、hash、quote、区间和完整性等检查。报告工具不会只相信模型转述“我已经核验”。

**练习 2：item 103 复制了 item 101 的 snapshot 和引用会怎样？**

答案：至少会因提交的允许来源与引用快照不一致，或材料无法支持 ToolBridge 声明等问题被识别；不能把一条有效引用自动视为任何声明的证据。若刻意连 URL 等也改写，仍需要语义支持判断，不能承诺确定性字段匹配单独阻止所有伪造。

### 8. 过关题

1. **一个子 Agent 是一次请求吗？** 四点：独立会话；可多轮模型生成；模型提出工具调用；工具执行后再继续。
2. **A 批一开始有全部正文吗？** 四点：主要任务含 ID/标题/URL；工具读取；返回正文快照；过程材料留在子会话。
3. **item 101 正式报告核验什么？** 四点：本轮来源；hash；quote 与区间；语义支持与充分/冲突判断。
4. **什么约束是硬的，什么是提示指导？** 四点：工具白名单由代码控制；版本/截止由代码检查；研究任务内容由提示指导；不能将提示等同所有细粒度权限校验。
5. **本例研究调用怎么计数？** 四点：每批四次生成；共八次研究模型生成；六次 read_item；六次 report_findings，另有 Jev 请求不混为同一计数。

关键错误：认为一个子 Agent 只能调用模型一次；认为独立会话就是独立机器；认为初步 supported 自动免去正式报告校验。

## 阶段三：结果如何落库并交回主 Agent

### 1. 学习目标

分清“工具任务返回”“子会话回答”“报告完整”“整轮扫描完成”四种状态。掌握谁读取哪份结果。

### 2. 每条报告怎样保存

以 task 7001 为例，report_findings 先检查当前工具任务是否已经保存报告；没有则验证声明，再在业务事务中保存 finding、研究报告、claim 和引用关联，并把 reportId/findingId 关联到本轮条目。

六条正常研究后的便读视图为：

```json
[
  {"itemId":101,"conversationId":201,"reportTaskId":7001,"reportId":401,"findingId":501,"claimId":801,"snapshotId":301,"claimStatus":"supported","researchStatus":"completed"},
  {"itemId":102,"conversationId":201,"reportTaskId":7002,"reportId":402,"findingId":502,"claimId":802,"snapshotId":302,"claimStatus":"supported","researchStatus":"completed"},
  {"itemId":103,"conversationId":201,"reportTaskId":7003,"reportId":403,"findingId":503,"claimId":803,"snapshotId":303,"claimStatus":"supported","researchStatus":"completed"},
  {"itemId":104,"conversationId":202,"reportTaskId":7004,"reportId":404,"findingId":504,"claimId":804,"snapshotId":304,"claimStatus":"supported","researchStatus":"completed"},
  {"itemId":105,"conversationId":202,"reportTaskId":7005,"reportId":405,"findingId":505,"claimId":805,"snapshotId":305,"claimStatus":"supported","researchStatus":"completed"},
  {"itemId":106,"conversationId":202,"reportTaskId":7006,"reportId":406,"findingId":506,"claimId":806,"snapshotId":306,"claimStatus":"supported","researchStatus":"completed"}
]
```

这不是把上述所有列插入同一张表的 SQL。完整参数、评估视图与保存身份在 JSON 的每个 record 中。

**特别注意：**此时条目处置仍可为 selected，尚未 published；researchStatus=completed 不等于条目已经发布，六份报告不等于六张卡片。

### 3. 子 Agent 最后说了什么

生成 4 时，conversation 201 输出：

```text
#101 OrbitKit 已发布 2.4 版本；建议先阅读兼容性与限制说明。
#102 QueryNest 已发布 1.8 版本；建议先阅读兼容性与限制说明。
#103 ToolBridge 已发布 3.1 版本；建议先阅读兼容性与限制说明。
```

conversation 202 输出：

```text
#104 CacheLeaf 已发布 0.9 版本；建议先阅读兼容性与限制说明。
#105 TraceDock 已发布 1.2 版本；建议先阅读兼容性与限制说明。
#106 EvalHarbor 已发布 2.0 版本；建议先阅读兼容性与限制说明。
```

通用 spawnSubagents 返回两个 SubagentResult，字段包括 index、conversationId、status 和 answerText。正常结果为 index 0/1、conversationId 201/202、status done，并携带上面的文本；完整结构在 JSON 的 `batches[].normalizedResult`。

`done` 表示输入提交已得到回答，不自动证明所有条目都提交了合格报告。生成文本说完成不是可信的业务完结凭证。

### 4. research_items 实际怎样汇总

当前业务工具不会直接把 answerText 当最终研究事实拼接给主 Agent。它等待子会话后：

1. 校验原执行仍有效。
2. 在正常返回路径更新 task 500 的 research_jobs 状态。
3. 记录子会话 ID，供执行树展示。
4. 有关系不确定的条目时，用新增研究重新判断；本例没有该分支。
5. 按条目 ID 从数据库读取最新 finding，构造概要。
6. 附上子 Agent 未完成等信息，再返回工具结果。

本例主 Agent 收到的完整工具概要为：

```text
#101 medium actionability: OrbitKit 已发布 2.4 版本；建议先阅读兼容性与限制说明。 (1 of 1 claims supported)
#102 medium actionability: QueryNest 已发布 1.8 版本；建议先阅读兼容性与限制说明。 (1 of 1 claims supported)
#103 medium actionability: ToolBridge 已发布 3.1 版本；建议先阅读兼容性与限制说明。 (1 of 1 claims supported)
#104 medium actionability: CacheLeaf 已发布 0.9 版本；建议先阅读兼容性与限制说明。 (1 of 1 claims supported)
#105 medium actionability: TraceDock 已发布 1.2 版本；建议先阅读兼容性与限制说明。 (1 of 1 claims supported)
#106 medium actionability: EvalHarbor 已发布 2.0 版本；建议先阅读兼容性与限制说明。 (1 of 1 claims supported)
```

附加信息为 `children=[201,202]`，位于 JSON 的 `parentToolResult.details`。模型可见的短概要与后台可检查的完整报告各有职责，不能要求每次都把所有正文发回主会话。

### 5. 研究返回后还剩什么

```text
task 500 研究调度：正常返回
子会话 201、202：done
研究报告：6 份
有效 supported 声明：教学设定为 6 条
研究阶段新建新闻卡片：0
整轮 sweep 42：仍不能仅据此宣布 completed
```

主 Agent 接下来还要组织 HFS 分类、请求发布；服务端重新验证证据和其他发布条件，最后检查整轮缺口。本文不模拟这些后续调用，因此不能把 0 卡片错误解读为 no_news 或失败。

另外，当前汇总中“支持条数”来自 finding 中的简化支持分数统计；正式发布仍使用完整声明状态与有效证据记录，不能把概要里某个数当作全部校验已通过的替代品。

### 6. 练习与答案

**练习 1：202 返回 done，但漏交 item 106 的报告，能正常宣布全部研究成功吗？**

答案：不能。按当前工具实现，工作记录可能进入 completed 返回路径，但条目报告缺口不会因此消失；汇总可能出现 `#106 no findings reported`，后续发布和最终核验还会检查。研究 job 状态不是所有 item 均合格的唯一证明。

**练习 2：子 Agent 最后回答称 105 是 1.3，数据库报告仍写 1.2，汇总取哪个？**

答案：当前 research_items 主要读取数据库 finding，故概要取 1.2 版本的保存报告，不直接拿 answerText 改写事实。这仍不证明 1.2 客观真实；它说明正式产物路径与会话总结路径分开。

### 7. 过关题

1. **报告数据关联有哪些？** 四点：item；report/finding；claim；snapshot/引用。
2. **为什么不能把 task 500 当六份报告身份？** 四点：500 是调度工具；每次 report_findings 是独立工具任务；报告按工具任务幂等；不同条目需要各自报告关联。
3. **子会话 done 等于业务成功吗？** 四点：仅表示有回答；可能漏报告；可能证据不足；后续业务检查仍必要。
4. **主 Agent 收到什么？** 四点：数据库 finding 概要；行动价值/支持摘要；异常信息；children 身份，而非全部研究正文。
5. **研究结束后还要什么？** 四点：HFS；发布检查；卡片写入；整轮终态核验。

关键错误：把短回答当唯一落库结果；认为报告完成必然发布；认为工具 job completed 可替代逐条与整轮核验。

## 阶段四：同一组对象如何处理并发、预算与异常

### 1. 学习目标

不更换 sweep 42、task 500、会话 201/202，分析出错时到底有哪些记录、什么能继续、什么必须拒绝。下面每个异常是独立分支，不是正常轨迹中连续发生。

### 2. 正常调用账目

按第二阶段四次生成的教学轨迹：

```text
A 批：4 次研究模型生成，负责 101、102、103
B 批：4 次研究模型生成，负责 104、105、106
研究模型请求合计：8
每条研究 item 计入的模型调用：4

read_item：6 次
初步 jev_classify claim-support：6 次
report_findings：6 次
report_findings 内正式 claim-support：6 次
本例新增 Jev 请求：12 次（假设均无缓存、无重试）
```

这些不是整个扫描的总请求量。此前 gate、same-story、importance，之后 HFS、主 Agent 生成等都不在此账目内。

每次研究模型生成同时计入其批次的三个 item，因此“8 次实际请求”对应“24 次 item 参与计数”。**不是向供应商发送 24 次请求，也不是把账单乘三。** 后者只是限制每条在批次研究中消耗的调用机会。

实际费用保持 unknown/null，因为案例没有真实供应商 usage 和价格数据。不能由请求条数推断实付金额。

配套 JSON 的 `modelRequestLedger` 实际列出八条教学预约账目，分别关联 conversation、生成轮次与批内 itemIds；`teachingTimeline` 按固定时间记录创建、提交、生成和工具返回。它们是可跟踪的教学视图，不是伪造的生产日志或 Durable 原始事件协议。

### 3. 并发槽位：限制在途研究，不是限制新闻数量

09:00 task 500 申请两个研究槽位，A/B 两个批次各一个；当前池容量为 2。假设同一服务中另有研究调用要申请一个槽位，它需要等待，不能因为同样通过 Schema 就超出当前容量。

这里有两层实现：外层 withResearchCapacity 约束该服务 Store 下实际在途研究容量；内层 runParallel 约束本次规格的并行执行。不能把内存容量池描述成跨机器分布式锁。

### 4. 异常一：进程在子会话创建后退出

**断点数据：**201/202 和绑定已持久化，901/902 可能尚未全部提交或完成，task 500 仍是原工具任务。

**恢复动作：**重新打开原存储，工具安全重放，查找 ownerTaskId=500 的既有会话，复用 201/202；分别使用 research:500:0 / research:500:1 提交或找回原输入。

**正确预期：**不无条件创建 203/204 代替原研究。若只有一部分已完成，按实际任务记录继续。不能说外部已发请求在任何窗口都绝不重复。

**进阶边界：**当前工具重入会再次尝试写入一条带五分钟截止的 research_jobs，但使用 INSERT OR IGNORE；原任务已存在时，不应因恢复就重置其既有截止。原 binding 也不能变成下一轮的新版本。

### 5. 异常二：报告 401 已提交，返回前退出

**断点数据：**item 101 的 report_findings task=7001 已在业务库保存 report=401，模型可能尚未收到工具返回。

**恢复动作：**同一个工具任务重放时，按 taskId=7001 检查 research_reports，找到已有报告，返回“已保存，原声明与快照保留”。不再新插 report=407，也不因重放覆盖原证据。

**范围：**这不表示所有“语义上相同但 taskId 不同”的新工具调用都自动合并；它首先是当前工具任务的幂等路径，其他重复行为另有业务约束。

### 6. 异常三：A 已完成，B 到 09:05 仍未结束

**断点数据：**401～403 已保存，404～406 的情况必须逐条查看；A 有结果，B 的底层请求可能在途。

**当前处理：**research_items 的整体等待与截止竞争，超时路径可把 task 500 标记 failed，并将该调用覆盖条目的研究状态记为 failed、处置记为 error，返回研究错误。不能假设只标记 B 批失败而完全不影响 A 批条目状态。

**已存数据：**A 的报告不会因此自动被删除，但“报告存在”与“本轮条目研究状态合格”是两回事，后续发布核验仍可能受阻。

**槽位：**调用者已经收到超时不代表 B 已结束；外层容量要等真实研究 promise 结束才释放。不能立刻当作两个槽位全空，再无限启动新研究。

**是否退费：**不保证。已有外部请求可能继续产生费用，按实际审计结算。

### 7. 异常四：用户 09:02 取消

**变化：**sweep 42 的 epoch 从 0 增至 1，旧研究会话仍持有 epoch 0。先持久使旧执行失效，再请求执行器中止。

**后果：**201/202 不能凭当前扫描的新 epoch 自动取得新权限。旧执行提交报告、请求发布或预约新模型请求时，受保护路径应拒绝；已经发送请求的费用可以继续审计，不构成研究继续的授权。

**结果：**用户取消按生命周期正常收敛 cancelled。它不是把缺少卡片解释成 no_news，也不是保证供应商立即停算。

### 8. 异常五：并非所有 supported 都代表正式证据充分

**分支设定：**保持 105 的初步 supported=.90，但正式报告找不到有效引用。

**结果：**正式声明为 insufficient，不能凭初步分数替代。当前汇总的简化支持统计与正式声明状态可能不完全等价，最终发布重新查完整有效声明。

**学习重点：**同一名称“支持”可能出现在不同层：模型初步判断、finding 简化分数、claims 正式状态、发布时有效声明集合。面试中应说清使用的是哪一层。

### 9. 练习与答案

**练习 1：A/B 各四次生成，101 计入几次？全系统新增多少次研究生成？**

答案：101 计入 A 的四次；合计八次真实研究生成。三条共享同批额度参与计数不等于三倍供应商请求。

**练习 2：09:05 超时，A 的三份报告就可以不经检查直接发布吗？**

答案：不可以。当前超时路径可能将整个研究调用覆盖的条目状态记为 failed/error，报告虽保留，发布还要核验本轮状态、HFS、证据等条件。

**练习 3：重放 7001 能否改成另一句摘要并覆盖 401？**

答案：当前幂等路径找到原 task 报告后直接复用，保留原证据。改变研究结果应作为明确的新业务动作处理，不能假定工具重放可以原地改写旧报告。

### 10. 过关题

1. **并发 2 限制什么？** 四点：实际在途研究；本例 A/B；不等于两条新闻；不等于两个模型请求总量。
2. **八次请求为何每条计四次？** 四点：每批四次；各批三条共享研究；每请求计入批内各 item；计数不是重复账单。
3. **创建后崩溃怎样恢复？** 四点：原存储；原 ownerTask；原子会话；原 requestId。
4. **超时怎样准确解释？** 四点：调用者不再等待；底层可能未停；容量不立即释放；当前整调用条目状态可能记失败，已有报告仍需检查。
5. **取消怎样准确解释？** 四点：epoch 改变；旧绑定保留；拒绝旧业务动作/新预约；迟到费用可审计。

关键错误：声称超时必然只影响未完成批次；认为重启额度清零；把幂等受理等同所有外部请求只执行一次；把内部 item 计数当供应商三倍收费。

## 阶段五：抽象机制、对照其他系统并用于面试

### 1. 学习目标

能用本案例解释通用 subagent 机制，再带问题看其他实现。这个阶段不要求研究 Codex 或 Claude Code 全部内部源码，也不把未公开机制当成事实。

建议将本阶段 90 分钟分为：10 分钟复述；20 分钟整理下面七问；20 分钟阅读一个官方资料；20 分钟案例练习；20 分钟口述与评分。

### 2. 七个问题，全部用本例回答

**何时委派？** 扫描已选出六项，主 Agent 决定调用研究工具，工具校验计划；不是子 Agent 自行创造任意新目标。

**怎样创建？** task 500 创建/复用会话 201、202，建立归属并提交 901/902；当前路径不是独立 pi 子进程。

**上下文是什么？** 每批 ID/标题/URL、研究重点、角色提示；正文由工具读取。不是自动继承全部主会话历史。

**权限是什么？** 五类研究工具、原执行绑定、预算/截止及跨扫描检查；没有发布与修改调度工具。细粒度批次权限不能靠提示假定已经全部强制执行。

**怎样协作？** 本例是主 Agent 委派后等待本次工具结果，两个子会话各研究自己的任务；没有展示子 Agent 之间聊天、投票或协商，也没有实现完整自由通信团队。

**怎样交付？** report_findings 正式落库；通用封装收集 answerText；业务工具主要读数据库 finding 构造概要，附 children 返回给主 Agent。

**怎样结束？** 子提交 done 与报告完备、研究工作状态、整轮终态分层检查；超时、取消、恢复各有机制，不用一句“子 Agent 结束”代替所有状态。

### 3. 看其他实现时如何保持同一组数据

使用同样的两份逻辑任务：

```text
任务 A：研究 item 101、102、103；只核实版本发布，保留引用。
任务 B：研究 item 104、105、106；只核实版本发布，保留引用。
输出要求：每条的声明、来源、原文引用、证据状态与失败原因。
```

但不要把当前项目的 read_item、report_findings 或数据库 ID 视为其他产品自带能力。对照时先问：它从什么地方取得六份材料？有没有对应工具？结果只是返回文本还是也会落到你指定的业务存储？

只阅读或纸面推演即可。若实际试用，给模型提供本地虚构资料，明确范围与预算，不要求它访问这些 `.example` 网址。本文不会自动调用其他产品或发送付费请求。

可用资料：

- [Pi 官方 subagent 扩展示例](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)：比较子进程与当前持久子会话的区别。
- [Codex 官方子 Agent 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)：围绕调度、后续指令、等待和汇总阅读。
- [Claude Code 官方子 Agent 文档](https://code.claude.com/docs/en/sub-agents)：围绕角色配置、上下文、工具权限和运行方式阅读。

文档和产品可能更新，应按当时实际页面确认行为，不从配置示例推断全部内部实现。任选一个先读，不要求本阶段同时通读三套。

### 4. 纸面对照练习与答案

**练习：把 task 500 的两个批次交给另一套 Agent 系统，最少要重新明确哪些东西？**

答案：材料如何送入；两批怎么建立独立上下文；哪些工具允许调用；模型能否实际取得正文；输出如何结构化并保存；超时/取消/恢复的行为；同一工作重复委派如何识别。不能只替换工具名称就声称行为与 Pi Durable 相同。

**练习：为了“更先进”，现在是否必须加入子 Agent 之间自由互发消息？**

答案：不必须。本例两个批次互相独立，主 Agent 汇总足以完成需求。只有出现确切协作需求，例如跨条目冲突需要共享材料，才比较集中汇总或直接通信的成本与正确性。

### 5. 最终口述参考

> 项目的研究子 Agent 是基于 Pi Durable 持久会话与任务原语组织的。主 Agent 调用 research_items，将已选条目分批，工具校验计划后为每批创建或复用子会话，绑定原扫描、执行版本和截止。子 Agent 使用受限工具读取资料、提取声明、调用判断并提交报告，正式证据校验由服务端执行。通用封装等待子会话结束，业务工具再从数据库汇总研究概要返回主 Agent。并发容量、持久预算、稳定提交身份和 epoch 分别约束执行规模、重复受理、恢复与取消，但不保证所有外部调用绝不重复，也不把子会话 done 当整轮业务成功。

涉及个人工作时，区分 Pi Durable 原语、沿用的通用封装和实际参与的业务改造，不把这段机制说明直接当个人原创范围证明。

### 6. 最终过关题

1. **从任务参数讲到 201/202。** 四点：选中名单；分批规格；创建/复用子会话；稳定输入提交。
2. **从 read_item 讲到 report 401。** 四点：正文快照；声明与引用；正式服务端校验；保存报告和关联。
3. **从两个 done 讲到主 Agent 返回。** 四点：通用结果；数据库 findings；概要与 children；后续发布/终态检查。
4. **解释一次恢复或取消。** 四点：出错位置与已有记录；原身份；恢复/拒绝动作；外部请求与费用边界。
5. **怎样学习别的系统？** 四点：用同一任务；比较上下文/权限；比较交付与生命周期；不凭产品使用体验杜撰内部实现。

关键错误：认为更多 Agent 必然更好；只会背工具名不能描述数据变化；把当前数据库工具当其他产品天然具备；把所有代码与框架原语都归为个人从零实现。

## 六、学习结束时应能写出的数据总账

```text
起点：sweep 42 / epoch 0，选中 101～106，无本轮报告。
委派：research_items task 500，两个批次。
执行：conversation 201、202；submission 901、902。
材料：snapshot 301～306；各有独立正文/hash/区间。
提交：report_findings task 7001～7006。
产物：report 401～406；finding 501～506；claim 801～806。
返回：六条概要 + children [201,202]。
计数：本例八次研究生成；十二次新增 Jev 判断；六次读取与六次报告工具。
尚未发生：主 Agent 后续 HFS、新闻卡片发布、整轮完成。
费用：未提供真实账单；不推断节省与准确率。
```

总账必须与 JSON 一致。异常场景修改哪条记录，要明确是独立分支，不覆盖并冒充正常轨迹。

## 七、源码核对与阅读顺序

只在需要确认机制时查阅，不作为背诵要求：

1. [research-items.ts](../apps/dna-server-api/src/agents/tools/research-items.ts)：计划校验、绑定、超时与汇总。
2. [research-prompt.ts](../apps/dna-server-api/src/news/research-prompt.ts)：任务材料如何构造。
3. [subagents.ts](../apps/shared/packages/durable-agent/src/subagents.ts)：会话创建、复用与稳定提交。
4. [agents/index.ts](../apps/dna-server-api/src/agents/index.ts)：研究角色与工具白名单。
5. [read-item.ts](../apps/dna-server-api/src/agents/tools/read-item.ts)：模型读取材料的工具返回。
6. [report-findings.ts](../apps/dna-server-api/src/agents/tools/report-findings.ts)、[evidence.ts](../apps/dna-server-api/src/news/evidence.ts)：正式报告与证据状态。
7. [research-capacity.ts](../apps/dna-server-api/src/news/research-capacity.ts)、[model-budget.ts](../apps/dna-server-api/src/news/model-budget.ts)：容量与模型请求计量。
8. [research-binding.ts](../apps/dna-server-api/src/news/research-binding.ts)、[execution.ts](../apps/dna-server-api/src/news/execution.ts)：原执行身份与受保护动作。

## 八、每阶段打卡模板

```text
阶段：
学习时间：
本阶段开始时的数据状态：
发生的调用与处理者：
本阶段结束时新增/改变的数据：
我能解释但不必背的术语：
练习答案：
五题得分：__/4、__/4、__/4、__/4、__/4
总分：__/20
是否有关键错误：
修正后的口述：
```

最终完成标准：不用源码，能够沿固定 ID 把正常案例讲完整，正确解释一项异常，再用七个通用问题比较另一套子 Agent 设计。
