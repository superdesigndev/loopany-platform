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
- 本仓库的 `fm/kernel-cli` 分支 checkout（安装脚本从源码打包）

## 2. 安装（一次）

```bash
git clone git@github.com:superdesigndev/loopany-platform.git && cd loopany-platform
git checkout fm/kernel-cli
bash scripts/install-daemon.sh     # 全局装 loopany + loopany-kernel（npm -g，自包含）
echo 'alias lk=loopany-kernel' >> ~/.zshrc && source ~/.zshrc   # 可选的短名
```

## 3. 接入这台机器（token 从哪来）

open mode 下 **token 是你自己造的**：一段 `dk_` 前缀随机串就是这台机器的身份凭证
（服务器用它的哈希派生机器 id，首次 poll 即注册）。造一次、传给 `loopany up`，之后
它保存在 `~/.loopany/device-token`（0600），重启复用，不需要再管。

```bash
export LOOPANY_MACHINE_ALIAS=<你的名字>-<机器名>    # 例如 tim-mbp。这是任务指派用的地址，起个稳定的名字
loopany up \
  --server-url https://loopany-kernel-live.fly.dev \
  --connect-key "dk_$(openssl rand -hex 24)"
```

- `loopany`（不带参数）随时查看本机连接状态。
- **token = 机器的完全控制权**，别提交、别贴到聊天里。
- 本机已有连着正式环境的 loopany？用 `LOOPANY_HOME=~/.loopany-kernel-live` 前缀
  隔离所有命令（身份、pidfile、日志都会分家）。

## 4. 绑定 CLI（在任何目录使用 lk）

```bash
lk connect https://loopany-kernel-live.fly.dev --token "$(cat ~/.loopany/device-token)"
```

绑定存 `~/.loopany/kernel-backend.json`（0600）。优先级：环境变量 > 当前目录的
`.loopany` 工作区 > 这个全局绑定；站在某个本地工作区里想强制打远端，任何命令加
`--remote`。

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
lk kanban            # 交互式看板（q 退出，/ 搜索，f 切换列）
lk list              # 任务树
lk show research-x --log   # 单任务全事件流
lk timeline          # 团队最近动态
lk inbox --assignee alice@superdesign.dev   # 某人的决策收件箱（附交还命令）
lk loops             # 所有 loop：下次触发、上次结果、卡住原因
```

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
| 任务一直 pending | `lk show <id> --log` 看 blocked note（别名错/机器离线）；`loopany` 看本机 daemon 状态 |
| agent 起不来 | 目标机器 `claude` 是否可用已登录；`~/.loopany/daemon.log` |
| run 被改判 failed | agent 静默退出（没写任何事件）——完善 body 里的收尾要求 |
| 想看服务器日志 | `fly logs -a loopany-kernel-live`（需要 fly 权限） |
