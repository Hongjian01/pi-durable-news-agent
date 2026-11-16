# 从打开 WSL 到完成第一次真实评测

适用于当前电脑，核对于 2026-11-13：Ubuntu（WSL 2）已安装，Linux Node v24.21.0 和项目依赖已准备好。本流程运行自动评测，不要求另开网页或启动数据库服务。代码会自行启动并结束所需的评测 worker。

## 1. 打开 PowerShell，再进入 Ubuntu

按 Windows 键，输入 PowerShell 并打开。普通权限即可。输入：

```powershell
wsl -d Ubuntu
```

提示符从 `PS E:\...>` 变为类似 `用户名@电脑名:~$`，说明已进入 Linux。后面的 bash 命令都在这个 Ubuntu 窗口执行，不要在 PowerShell 中执行。代码块中的命令不包含提示符。

## 2. 进入已安装依赖的项目目录

```bash
cd /var/tmp/agentradar-complete-1794537884179
source "$HOME/.nvm/nvm.sh"
nvm use 24
pwd
node -p 'process.platform + " " + process.version'
```

最后一行应是 `linux v24.21.0`，或其他 Linux Node 24 版本。此目录是已准备好的 Linux 验收副本；Windows 原源码在 E:\agent\Jev\pi-durable-news-agent。为避免混用原生依赖，本次使用 Linux 副本，不在 /mnt/e 的 Windows node_modules 上运行。两个副本不自动同步，后续 Windows 代码修改需要同步。

若 cd 提示目录不存在，先停止本流程，按 IMPLEMENTATION-CHECKLIST.md 第 0 步准备新副本并安装依赖。不要在任意目录直接执行 npm 命令。

## 3. 先验证免费离线流程

```bash
npm run eval:tasks -- --task pilot-empty
```

预期出现 `Report directory: ...` 和 `pilot-empty-clean-B-1 passed`，结束后重新显示 `$` 提示符。这一步不需要密钥，不请求真实模型。之后继续留在同一个窗口和项目目录。

## 4. 先在供应商网页配置账户

OpenRouter：在 https://openrouter.ai/settings/keys 为实验准备专用密钥。设置 Credit limit 为 1 美元，Reset limit 为 N/A，并确认账户支持调用 Jev。当前界面可能没有包含 BYOK 的开关；下面命令显式选择 --budget-scope openrouter-credits，仅核验普通 OpenRouter 余额消费，要求剩余额度大于 0、不超过 1 美元且无周期重置。若 OpenRouter 中配置了 BYOK，上游费用不在此模式核验范围。DeepSeek 官方直连与 OpenRouter BYOK 是不同的路径。

DeepSeek：确认官方账户余额与可用的消费控制。主 Agent 和研究调用在这里单独结算。

--max-usd 1 只核验 OpenRouter 侧；DNA_COST_ALERT_USD 是告警阈值。两者均不保证 DeepSeek + OpenRouter 合计花费不超过 1 美元。首次只执行一题，先查看结果再扩大实验。

## 5. 输入两把密钥

先复制执行这一小段：

```bash
read -rsp 'OpenRouter API key: ' OPENROUTER_API_KEY
```

出现 `OpenRouter API key:` 后，粘贴真实密钥并按 Enter。输入时不显示字符或星号，属于正常现象。在 Windows Terminal 一般可用 Ctrl+Shift+V 粘贴；如果无效，可尝试右键粘贴。密钥只是输入给 read，不是作为一条 shell 命令执行。

然后执行：

```bash
echo
export OPENROUTER_API_KEY
read -rsp 'DeepSeek API key: ' DEEPSEEK_API_KEY
```

出现 `DeepSeek API key:` 后，粘贴 DeepSeek 官方密钥并按 Enter，再执行：

```bash
echo
export DEEPSEEK_API_KEY
export DNA_MODEL=deepseek-flash
export DNA_RESEARCH_MODEL=deepseek-flash
export DNA_COST_ALERT_USD=1
```

不要将包括 read 和后续命令的所有代码一次性粘贴，避免后续命令被当作密钥输入。不要使用 echo 打印密钥。

可用下面两行只检查是否配置成功，不显示密钥：

```bash
test -n "$OPENROUTER_API_KEY" && echo 'OpenRouter key configured'
test -n "$DEEPSEEK_API_KEY" && echo 'DeepSeek key configured'
```

这些 export 只作用于当前 shell 及其启动的程序。关闭窗口或换一个新窗口后需要重新配置。自动评测 CLI 不自动加载项目 .env；本次无需编辑 .bashrc 或 .env。

## 6. 执行第一道真实单题评测

以下命令会产生真实费用：

```bash
npm run eval:tasks -- --task pilot-03 --backend live --provider deepseek --enable-paid --max-usd 1 --budget-scope openrouter-credits
```

程序先检查 OpenRouter 额度，然后启动隔离评测。主 Agent 和研究模型使用 DeepSeek 官方 API；Jev 使用 OpenRouter。当前命令未配置模型评审器，使用离线规则评分。

运行期间不要再次执行同一命令，也不要关闭窗口。出现 `Report directory: ...` 时，复制保存这条目录路径。命令结束、重新出现 `$` 提示符表示该次命令已经退出；若是报错，按下面第 9 节处理。不要直接将终端关闭当作正常结束步骤。

## 7. 阅读结果

将程序打印的完整报告目录粘贴到下面引号内，替换示例路径：

```bash
cd '/var/tmp/agentradar-complete-1794537884179/test-results/eval-tasks/run-实际编号'
cat report.md
python3 -m json.tool summary.json | less
```

`less` 中按上下方向键滚动，按 q 返回 shell。`summary.json` 的 status=completed 表示执行完成，不代表内容质量通过。passed 表示规则通过；needs_review 表示待复核；failed 表示质量断言失败；technical_error 表示执行或协议错误。

report.md 中每个 trial 的链接指向 score.json；同一个 attempt 目录保存 observed.json、输入和运行日志，可用来定位失败。先查看具体评分和日志，再决定是否重跑，重跑可能再次产生费用。

也可以从 Windows 文件资源管理器打开结果：按 Win+E，将下面地址粘贴到地址栏，进入对应 run 目录：

```text
\\wsl.localhost\Ubuntu\var\tmp\agentradar-complete-1794537884179\test-results\eval-tasks
```

结果目录是 CLI 产物，不会自动出现在正在运行的另一实例的网页评测列表中。

## 8. 正常结束与下次继续

完成后，留在 Ubuntu 窗口执行：

```bash
unset OPENROUTER_API_KEY DEEPSEEK_API_KEY
unset DNA_MODEL DNA_RESEARCH_MODEL DNA_COST_ALERT_USD
exit
```

exit 返回 PowerShell，之后可关闭窗口。评测结果和 SQLite 文件会保留；不需要手动关数据库。不要运行 wsl --shutdown，本机可能还有其他 WSL 项目正在运行。

运行中确实需要停止时，在原窗口按一次 Ctrl+C，等待程序取消并返回提示符，然后再 exit。已经完成的 API 请求仍会计费。

下次使用：重复第 1、2、5、6 步；免费离线验证可按需执行。每次正常新跑都会生成新报告目录。续跑需使用原配置及 --resume 原目录，并保持代码和数据指纹一致。

## 9. 常见错误

- `npm: command not found`：确认在 Ubuntu 内执行过 source 和 nvm use 24。
- Node 显示 win32 或不是 24：回到第 2 步，不要继续用 Windows Node 执行此 runner。
- `Live needs explicit ...`：检查第 5 步的环境变量，并确认命令包含 --enable-paid 和 --max-usd 1。
- `Cannot verify provider budget` 或 401/403：检查 OpenRouter 密钥及账户权限；不要把密钥原文发到聊天中。
- `Configure an equivalent provider-enforced evaluation budget ...`：密钥可用，但额度配置未满足程序要求。按第 4 步设置，而不是反复重跑。
- DeepSeek 模型或鉴权错误：确认使用官方密钥，模型填 deepseek-flash 或 deepseek-v4-pro，不能填 OpenRouter 的 deepseek/ 前缀型号。
- `needs_review`：程序已经生成待复核结果，先检查评分，不能把它直接视为系统启动失败。
- SQLite：程序自动建库，无需安装 sqlite3、配置用户名密码或手动建表。

如果需要启动日常网页服务，那是另一个流程，涉及 API 服务、浏览器 hub 和客户端 token。本教程的自动评测无需先启动它们，也不会更换原网页的业务数据库。
