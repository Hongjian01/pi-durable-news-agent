# 真实评测的账户与本地数据库配置

核对日期为 2026-11-13。以下对应当前实现，使用 WSL/Linux Node 24。

首次使用 WSL，请先按 [从打开 WSL 到完成第一次真实评测](WSL-FIRST-RUN.md) 逐步操作，包含输入密钥、查看报告、退出及常见错误。

## 密钥和模型的对应关系

在 OpenRouter 创建的密钥配置为 OPENROUTER_API_KEY。Jev 是被调用的模型，本项目通过 OpenRouter Decisions 接口调用它，模型标识为 ~typesafe/jev-latest。同一个 OpenRouter 账户密钥可以调用该账户允许使用的其他模型，费用由 OpenRouter 对应路由结算。

TypeSafe 官网创建的直连密钥配置为 TYPESAFE_API_KEY，配合 JEV_BACKEND=typesafe 供业务运行时使用。目前自动评测的 live worker 明确选择 openrouter，单独设置 TYPESAFE_API_KEY 不会改变该评测链路。

DeepSeek 官网创建的密钥配置为 DEEPSEEK_API_KEY，供 https://api.deepseek.com 使用。项目已增加 deepseek provider，主 Agent 和研究模型可直连官方 API，模型填写 deepseek-flash 或 deepseek-v4-pro。自动评测用 --provider deepseek 选择该路径；正常业务服务用 DNA_PROVIDER=deepseek。Jev 与可选语义评分器仍走 OpenRouter，因此此组合需要两把密钥。

如果全部走 OpenRouter，则使用 --provider openrouter 和该平台的模型 ID，例如 deepseek/deepseek-v4-pro-0813。两家平台的密钥、模型 ID 和账户费用分别管理。OpenRouter 文本 Responses 接口与 Jev 的 Decisions 接口承担不同任务，无需将 Jev 改成文本生成调用。

源码对应 apps/shared/packages/jev/src/client.ts、apps/shared/packages/durable-agent/src/models.ts 与 scripts/eval-tasks/workflow.mjs。

## 按当前入口执行一次单题实验

1. 登录 OpenRouter 的 API keys 页面，为本项目创建专用密钥，并给它设置一次实验的额度。下面用 1 美元作为配置示例。该数值不代表一题的预期费用。
2. 当前 runner 会核验供应商预算。默认要求覆盖 BYOK、无周期重置、剩余额度为正且不超过 --max-usd。普通密钥页面可能只提供额度和重置周期：设置限额 1、重置周期 N/A 后，可显式使用 --budget-scope openrouter-credits，仅核验 OpenRouter 余额消费额度。此模式不覆盖 OpenRouter BYOK 消费；若在 OpenRouter 中绑定了上游供应商密钥，可能产生额度外费用。DeepSeek 官方直连不属于 OpenRouter BYOK。
3. 打开 WSL，进入已安装依赖的 Linux 仓库目录。现有隔离验收副本为 /var/tmp/agentradar-complete-1794537884179。长期使用可以按 IMPLEMENTATION-CHECKLIST.md 第 0 步准备自己的目录。
4. 在同一个 WSL shell 配置变量。read 输入隐藏，实际密钥不会写入此命令的历史文本。

```bash
cd /var/tmp/agentradar-complete-1794537884179
source "$HOME/.nvm/nvm.sh"
nvm use 24
read -rsp 'OpenRouter API key: ' OPENROUTER_API_KEY
echo
export OPENROUTER_API_KEY
read -rsp 'DeepSeek API key: ' DEEPSEEK_API_KEY
echo
export DEEPSEEK_API_KEY
export DNA_MODEL='deepseek-flash'
export DNA_RESEARCH_MODEL='deepseek-flash'
export DNA_COST_ALERT_USD='1'
```

自动评测 CLI 当前读取进程环境，没有自动载入仓库 .env。按上面的 shell export 配置即可。正常 API 服务启动时的 .env 加载行为由 main.ts 管理。

5. 先读取密钥预算检查配置。此调用查询账户信息，不请求模型生成。

```bash
curl -fsS https://openrouter.ai/api/v1/key \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print({k:d.get(k) for k in ["limit","limit_remaining","limit_reset","include_byok_in_limit"]})'
```

若使用密钥额度方式，预期 limit_remaining 为大于 0 且不超过 1 的数字，limit_reset 为 null。默认模式还要求 include_byok_in_limit 为 true；下列命令显式选择 openrouter-credits，允许该字段为 false，保留普通消费额度核验。若账户只提供等价组织预算，则核对 budgets 中对应的配置。不要把完整账户响应和密钥贴到公开报告。

6. 下列命令会调用真实模型并产生费用，先确认账户限额和本次预算。

```bash
npm run eval:tasks -- --task pilot-03 --backend live --provider deepseek --enable-paid --max-usd 1 --budget-scope openrouter-credits
```

命令使用 DeepSeek 官方 API 调用主 Agent 和研究模型，使用 OpenRouter 调用 Jev。输出目录包含卡片、来源、用量、费用记录和评分。该命令使用离线结构/参考事实评分，合理改写可能进入 needs_review。

费用边界：此时 --max-usd 1 只核验 OpenRouter 账户侧的预算，不能限制 DeepSeek 官方账户消费。DNA_COST_ALERT_USD 是告警阈值，也不是两家平台合计费用的硬上限。DeepSeek 侧需要在官方账户自行控制余额或设置可用的消费限额；运行器已有的请求次数限制继续生效。若希望所有模型调用共享已核验的 OpenRouter 账户额度，改用 --provider openrouter，并同时把两个 DNA_MODEL 变量改为 OpenRouter 模型 ID。

需要独立语义评审时，在上面命令后追加 --judge-model，并填写 OpenRouter 上实际可调用的另一模型 ID。评分器调用同样消耗该密钥额度。先用单题检查，再增加任务数和重复次数。

本次已通过全工作区类型检查、DeepSeek provider 离线测试和 pilot-empty 离线回归。尚未用真实密钥验证 DeepSeek 工具调用、流式恢复和整题质量；首个 pilot-03 实验用于验证这些实际行为。

## SQLite 如何创建

程序使用 Node 自带的 node:sqlite，自动创建目录、数据库、表和迁移。无需安装数据库服务、建立用户密码或填写数据库连接串。

- 正常业务库位于 DNA_DATA_DIR 指定目录的 dna.sqlite，执行引擎状态位于同一数据目录下的 agent.sqlite。
- 自动评测每个 task/variant/arm/trial/attempt 有独立运行目录及数据库。
- 网页评测存放在业务 DNA_DATA_DIR/evaluations 下的独立实验目录。
- A/B/C 独立策略运行的数据库进一步位于 trial 的 arm 目录。

单题命令不需要设置 DNA_DATA_DIR，运行器会分配隔离位置。运行器还会为组件评测创建自己的库。

可以用以下命令检查刚生成的数据库。将 RESULT_DIRECTORY 替换为终端打印的结果目录。

```bash
find RESULT_DIRECTORY -type f \( -name dna.sqlite -o -name agent.sqlite \)
```

sqlite3 命令行是可选检查工具。手动创建空表、复制正在写入的单个 SQLite 文件都不属于启动步骤。

## 文档依据

- [OpenRouter 鉴权](https://openrouter.ai/docs/api_reference/authentication)
- [OpenRouter 账户额度](https://openrouter.ai/docs/api_reference/limits)
- [已注册 DeepSeek 模型页面](https://openrouter.ai/deepseek/deepseek-v4-pro-0813)
- [DeepSeek 官方 API](https://api-docs.deepseek.com/)
