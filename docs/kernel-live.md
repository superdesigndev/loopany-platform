# loopany-kernel-live 使用说明

团队共用的 kernel 任务环境：**服务器管状态和时钟，执行发生在每个人自己的机器上**。
你在服务器上创建 task / loop 并指派给某台机器的 agent；那台机器上的 daemon 领取任务、
拉起真实的 Claude Code 会话完成工作、把结果写回服务器。所有人看同一份任务树。

- 服务器：`https://loopany-kernel-live.fly.dev`（真实时钟，cron 每 30s 扫描；数据持久化）
- 模型：task（一次性/审批）、loop（cron 循环）、run（一次执行）、事件流全程可审计
- 执行：BYOA —— 任务指派到 `<机器别名>/claude`，就在那台机器上跑真实 agent

> **安全边界（重要）**：当前是 open mode —— 知道 URL 的任何人都能自注册进同一个共享
> 空间，且 URL 公网可达。**当作低信任沙盒用：task 正文 / note / 产物里不要放任何
> 密钥、内网信息、隐私。** 收紧到 GitHub 登录门是二阶段（见文末）。

---

## 1. 前提

- Node.js ≥ 20
- Claude Code 已安装并登录（`claude` 命令可用）—— agent 会话用的就是它
- 本仓库的 `fm/kernel-cli` 分支 checkout

## 2. 安装（一次）

```bash
git clone git@github.com:superdesigndev/loopany-platform.git && cd loopany-platform
git checkout fm/kernel-cli
bash scripts/install-daemon.sh     # 全局装 loopany daemon
bash scripts/install-kernel-cli.sh # 内测期：lk 直接指向本 checkout 源码
```

安装脚本只替换全局可执行文件，不会主动停止一个已经运行的 daemon；真正决定 daemon
连接哪个环境的是下面的 `LOOPANY_HOME`。内测期间 `lk` 直接读当前 checkout，切分支或
修改源码会立即改变它的行为。

## 3. 接入这台机器（token 从哪来）

open mode 下 **token 是你自己造的**：一段 `dk_` 前缀随机串就是这台机器的身份凭证
（服务器用它的哈希派生机器 id，首次 poll 即注册）。造一次、传给 `loopany up`，之后
它保存在 `$LOOPANY_HOME/device-token`（0600），重启复用，不需要再管。

### 先隔离正式环境（必须）

kernel-live 使用独立 home。它把 device token、server URL、daemon pid、日志以及 `lk`
的远端凭证一起放在 `~/.loopany-kernel-live`，不会读取或改写正式环境默认使用的
`~/.loopany`：

```bash
export LOOPANY_HOME="$HOME/.loopany-kernel-live"
export LOOPANY_MACHINE_ALIAS=<你的名字>-<机器名>    # 例如 tim-mbp；团队内保持唯一且稳定
```

以上两个变量必须出现在每个操作 kernel-live 的 shell 中。建议写进项目专用的
`.envrc` 或 shell function，**不要全局写进 `~/.zshrc`**，否则日常 `loopany` 命令也会
默认切到测试环境。

确认当前 shell 指向隔离 home 后，首次连接并启动 daemon：

```bash
loopany up \
  --server-url https://loopany-kernel-live.fly.dev \
  --connect-key "dk_$(openssl rand -hex 24)"

loopany status
```

- `loopany up` 是幂等的：daemon 未运行时后台启动；已运行时只确认状态。
- daemon 必须保持运行，才能 claim 指派给本机的 pending run 并启动 Claude Code。
  服务器负责铸 run，但不会执行 agent；daemon 停止期间 run 只会排队，不会丢失。
- `loopany status` 查看这个隔离 home 的 daemon、server 和连接状态；日志在
  `$LOOPANY_HOME/daemon.log`。
- `loopany down` 只停止当前 `LOOPANY_HOME` 的 daemon。先确认变量，避免误停正式环境。
- **token = 机器的完全控制权**，别提交、别贴到聊天里。

正式环境与 kernel-live 可以同时运行两个 daemon，因为 pidfile 和身份目录不同。分别检查：

```bash
env -u LOOPANY_HOME loopany status
LOOPANY_HOME="$HOME/.loopany-kernel-live" loopany status
```

## 4. 绑定 CLI（在任何目录使用 lk）

`loopany up` 和 `lk` 共用当前 `LOOPANY_HOME` 里的 `server-url` 与 `device-token`，因此
不需要再执行一次 `lk connect`。先确认当前 shell 仍有隔离变量，然后直接读取：

```bash
export LOOPANY_HOME="$HOME/.loopany-kernel-live"
lk list
```

CLI 优先级：环境变量 > 当前目录的 `.loopany` 工作区 > 当前 home 的远端绑定。站在
某个本地 workspace 里想强制访问 kernel-live，命令加 `--remote`。不要在未设置隔离
home 时运行 `lk connect` 指向 kernel-live，它会覆盖正式环境使用的共享凭证文件。

## 5. 日常使用

```bash
# 一次性任务，指派到自己机器的 agent（<别名>/claude）
lk create "调研 X 方案" --id research-x --assignee tim-mbp/claude \
  --workdir /Users/tim/Workspace/proj --body-file brief.md

# cron 循环（loop）：每天 07:00 跑一轮
lk create "每日发布雷达" --id release-radar --cron "0 7 * * *" --timezone Asia/Shanghai \
  --status in-progress --assignee tim-mbp/claude --body-file radar-brief.md

# 指派给同事的机器：写对方的别名
lk update research-x assignee=alice-mba/claude

# 交给人决策（email = 人，进对方 inbox，不会派发 agent）
lk update research-x assignee=alice@superdesign.dev --note "两个方案你选一个"

# 观察
loopany status       # daemon 必须 online；否则 run 会停在 pending
lk kanban            # 交互式看板（q 退出，/ 搜索，f 切换列）
lk list              # 任务树
lk show research-x --log   # 单任务全事件流
lk timeline          # 团队最近动态
lk inbox --assignee alice@superdesign.dev   # 某人的决策收件箱（附交还命令）
lk loops             # 所有 loop：下次触发、上次结果、卡住原因
```

### 可选 Workflow 前置阶段

Task 可以安装一个版本化的确定性前置脚本。目前唯一格式是 `loopany-js-v1`：脚本是
async 函数体，可直接使用 `prev`、`agent(message, data)`、`tools.call(name, args)` 和
`fetch`。没有调用 `agent()` 时本轮可以 silent/direct 完成；调用后信号会注入同一 Run
的 CORE prompt，再启动 Task 的 assignee Agent；脚本失败则带诊断上下文回退给 Agent。

```bash
lk workflow validate --file workflow.js
lk workflow set release-radar --file workflow.js --if-version 1
lk workflow show release-radar
lk workflow clear release-radar --if-version 2
```

成功返回的 `state` 记录在 Run 上，并作为下一轮的 `prev`。Workflow 是 Task 的可选
执行配置，不是独立实体；set/clear 使用普通 Task update 的团队权限、CAS 和审计事件。
整个 Workflow 默认最多运行 180 秒，可通过 daemon 的
`LOOPANY_WORKFLOW_TIMEOUT_SECONDS` 调整；单次 `tools.call` 仍默认最多 30 秒。

要点：

- **task 的 body 就是 agent 的任务书**（`--body-file`），写清楚做什么、边界、怎样算完成。
- `--workdir` 必须是**目标机器上存在的绝对路径**（agent 在那里工作）；不存在会 fail loud。
- 指派了 agent 的 task 创建即派发一次；loop 按 cron 触发；给人的（email）只进 inbox。
- 机器别名写错不会报错——run 会 pending，task 上出现一条 "dispatch blocked" note，
  **里面列出本空间所有可用别名**，改一下 assignee 即可。
- agent 静默退出不算成功：没有留下任何事件的 "done" 会被服务器改判 failed（协议要求
  每轮至少留一条诚实 note）。连续失败会自动 park，不会无限重试烧钱。

## 6. 多机协作规则

- 全员一个共享空间：所有 task / 事件互相可见（这也是特性——直接把任务丢给同事的机器）。
- 别名在空间内唯一：重名会自动加 `-2` 后缀；`LOOPANY_MACHINE_ALIAS` 定下来就别改，
  任务指派靠它路由。
- 谁的机器执行，消耗谁机器上的 Claude 账号额度；daemon 掉线时任务会排队等它回来
  （笔记本合盖不丢任务）。

## 7. 二阶段：收紧访问（待办）

给 fly app 配 `GITHUB_CLIENT_ID/SECRET + LOOPANY_AUTH_SECRET + LOOPANY_ALLOWED_LOGINS`
后进入 gated mode：自造 token 不再能注册，机器需经 Web UI 的 GitHub 登录 + connect
流程发 key，每人有独立 team。到时会更新本文档；现有机器的身份不受影响需重新接入。

## 8. 故障排查

| 现象 | 查什么 |
|---|---|
| `lk` 报 401 | token 没注册过（daemon 先 `loopany up` 一次）或 token 打错 |
| 任务一直 pending | 先确认 `echo $LOOPANY_HOME` 是隔离 home，再运行 `loopany status`；然后用 `lk show <id> --log` 看 blocked note（别名错/机器离线） |
| agent 起不来 | 目标机器 `claude` 是否可用已登录；`$LOOPANY_HOME/daemon.log` |
| run 被改判 failed | agent 静默退出（没写任何事件）——完善 body 里的收尾要求 |
| 想看服务器日志 | `fly logs -a loopany-kernel-live`（需要 fly 权限） |
