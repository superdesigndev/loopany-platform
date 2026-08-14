# loopany-kernel-live 使用说明

团队共用的 kernel 任务环境：**服务器管状态和时钟，执行发生在每个人自己的机器上**。
你在服务器上创建 task / loop 并指派给某台机器的 agent；那台机器上的 daemon 领取任务、
拉起真实的 coding agent 会话完成工作、把结果写回服务器。所有人看同一份任务树。

- 服务器：`https://loopany-kernel-live.fly.dev`（真实时钟，cron 每 30s 扫描；数据持久化）
- 模型：task（一次性/审批）、loop（cron 循环）、run（一次执行）、事件流全程可审计
- 执行：BYOA —— 任务指派到 `<机器别名>/<agent>`，就在那台机器上跑真实 agent
- 接入需要**设备码登录 + workspace 成员身份**，自造 token 不再能注册

> **信任边界**：登录门已经生效，但一个 workspace 内是**完全共享**的 —— 所有成员都能看到
> 彼此的 task 正文、note、事件流和产物，也能把任务指派到你的机器上执行。**不要在
> task 正文 / note / 产物里放密钥、内网信息或隐私。**

---

## 1. 前提

- Node.js ≥ 20
- 至少一个 coding agent 已安装并登录，`claude` / `codex` / `grok` 命令可用 ——
  daemon 会自动探测 PATH 上有哪几个，并把它们作为可指派的 agent 上报给服务器
- 本仓库的 `fm/kernel-cli` 分支 checkout

## 2. 安装（一次）

```bash
git clone git@github.com:superdesigndev/loopany-platform.git && cd loopany-platform
git checkout fm/kernel-cli
bash scripts/install-daemon.sh     # 全局装 loopany daemon（正式环境用的那个）
bash scripts/install-kernel-cli.sh # 内测期：lk / lk-runtime 直接指向本 checkout 源码
```

第二个脚本装三个可执行文件：

| 命令 | 作用 |
|---|---|
| `lk`（`loopany-kernel` 的软链） | kernel CLI，日常都用它 |
| `lk-runtime` | kernel-live 的 **daemon 半边**，`up` / `status` / `down` 都走它 |
| `loopany` | 由第一个脚本安装，**属于正式环境，本文档不会用到它** |

内测期间 `lk` 直接读当前 checkout，切分支或修改源码会立即改变它的行为，不需要重新安装。

### 为什么会多一个 `lk-runtime`

kernel CLI 和 daemon **共用一个凭证目录**（`server-url`、机器密钥、pid、日志都在同一个
home 里），这是设计如此。所以有两件事必须钉死，脚本已经把它们烤进 wrapper，你不需要在
每个 shell 里 export：

1. **独立的 home**：`lk` 和 `lk-runtime` 默认使用 `~/.loopany-kernel-live`，**不碰正式环境
   的 `~/.loopany`**。没有这层隔离，一次 `lk setup` 就会把正式环境的 server URL 和机器
   密钥就地改写，让你线上的 daemon 指向错误的环境。
2. **runtime 指向本 checkout**：`lk setup` 注册机器时要调一个 runtime 二进制。它先找发布
   版布局里紧挨着 launcher 的 `cli.js`，源码安装下找不到，就会回退到 PATH 上的裸
   `loopany` —— 那可能是另一个更旧的 checkout，既不认识 `--runtime-only` 也没有 `mk_`
   注册逻辑，结果是卡在 `starting daemon…` 一路 401。

两个默认值都是 `${VAR:-default}` 形式，显式设置环境变量仍然优先。

## 3. 接入这台机器（一条命令）

```bash
lk setup /<workspace> --server https://loopany-kernel-live.fly.dev
```

它一次做完四件事：设备码登录 → 注册这台机器 → 启动 daemon → 绑定 workspace。

```
Open https://loopany-kernel-live.fly.dev/device?user_code=XXXXXXXX
Code: XXXXXXXX
Waiting for approval...
starting daemon…
daemon online — this machine is connected (Your-Machine)
Ready
Signed in as you@superdesign.dev
Machine: Your-Machine
Workspace: /<workspace>
Daemon: running
```

- 浏览器打开那个 URL 批准设备码，命令会自己继续。
- `--server` 只有**首次**需要；之后 `lk setup /另一个空间` 会复用已有会话。换服务器会自动
  清掉旧会话要求重新登录。
- 不是该 workspace 的成员会直接报 `you are not a member of /<workspace>` —— 找管理员把你
  加进去，不要换个名字重试。
- 如果服务器上已经有一台 **hostname 相同**的机器，会问你 `Reclaim it? [y/N]`：接管旧身份
  选 y，注册成新机器选 n。非交互环境（脚本/CI）必须显式给 `--reclaim` 或 `--new`。

机器密钥是 `mk_` 前缀，由你的登录会话换取，存在 `~/.loopany-kernel-live/machine.json`
（0600）。**它等于这台机器的完全控制权**，别提交、别贴到聊天里。遗留的 `dk_` 自造 token
不再被 daemon 采信。

### 机器别名

别名是任务路由的地址（`<别名>/claude` 里的前半段），默认取**短主机名**（`mbp.local` → `mbp`）。
想自定义就在启动 daemon 的环境里设 `LOOPANY_MACHINE_ALIAS`，daemon 每次 poll 都会上报它：

```bash
LOOPANY_MACHINE_ALIAS=tim-mbp lk-runtime up
```

别名在**同一个 workspace 内唯一**：注册时如果撞名，服务器会自动追加一段机器 id 片段
（`mbp` → `mbp-3f9a2c`），所以撞名不会失败，但你会得到一个不好记的地址。**定下来就别改**，
任务指派靠它路由；`lk team` 显示的永远是当前真实地址，以它为准。

### 管理 kernel-live 的 daemon

一律用 `lk-runtime`，它已经钉住隔离 home，所以永远不会碰到正式环境：

```bash
lk-runtime status   # daemon 是否在跑、连的哪个 server
lk-runtime up       # 幂等：没跑就后台起，跑着就只确认状态
lk-runtime down     # 只停 kernel-live 这个 daemon
```

正式环境依旧用裸 `loopany status` / `loopany down`，两个 daemon 因为 home 和 pidfile 不同
可以同时运行，互不干扰。日志分别在各自 home 的 `daemon.log`：

```bash
tail -f ~/.loopany-kernel-live/daemon.log
```

daemon 必须保持运行，才能 claim 指派给本机的 pending run 并拉起 agent。服务器负责铸 run，
但不会执行 agent；daemon 停止期间 run 只会排队，不会丢失（笔记本合盖不丢任务）。

## 4. 确认身份和空间

```bash
lk me      # 当前登录的人 + 选中的 team
lk team    # 空间里的人（person:<id>）和可执行的 agent 地址
lk logout  # 只撤销 CLI 会话，机器注册不受影响
```

`lk team` 的 Agents 一栏就是**所有可以写进 `--assignee` 的地址**，例如：

```
Agents
  tim-mbp/claude     available  last-success 2026-08-14T01:30:15.655Z
  tim-mbp/codex      available
  alice-mba/claude   available
```

CLI 解析顺序：环境变量 > 当前目录的 `.loopany` 工作区 > 当前 home 的远端绑定。站在某个
本地 workspace 里想强制访问 kernel-live，命令加 `--remote`。

## 5. 日常使用

```bash
# 一次性任务，指派到自己机器的 agent
lk create "调研 X 方案" --id research-x --assignee tim-mbp/claude \
  --workdir /Users/tim/Workspace/proj --body-file brief.md

# cron 循环（loop）：每天 07:00 跑一轮
lk create "每日发布雷达" --id release-radar --cron "0 7 * * *" --timezone Asia/Shanghai \
  --status in-progress --assignee tim-mbp/claude --body-file radar-brief.md

# 指派给同事的机器：写对方的别名
lk update research-x assignee=alice-mba/claude

# 交给人决策（email = 人，进对方 inbox，不会派发 agent）
lk update research-x assignee=alice@superdesign.dev --note "两个方案你选一个"

# 手动跑一轮（不等 cron）
lk run release-radar

# 观察
lk-runtime status    # daemon 必须 online；否则 run 会停在 pending
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
- 机器别名或 agent 名写错不会报错 —— run 会 pending，task 上出现一条 "dispatch blocked"
  note，**里面列出本空间所有可用地址**，改一下 assignee 即可。
- agent 静默退出不算成功：没有留下任何事件的 "done" 会被服务器改判 failed（协议要求
  每轮至少留一条诚实 note）。连续失败会自动 park，不会无限重试烧钱。
- 谁的机器执行，消耗谁机器上的 coding agent 账号额度。

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

## 6. 故障排查

| 现象 | 查什么 |
|---|---|
| 卡在 `starting daemon…` | 用的是不是 `lk`（而不是手写的 wrapper）。`lk setup` 必须能拿到本 checkout 的 runtime；回退到 PATH 上别的 `loopany` 会一路 401。看 `~/.loopany-kernel-live/daemon.log` 里有没有连续的 `poll non-ok status: 401` |
| `you are not a member of /x` | workspace 名写错，或还没被加进去 —— 找管理员，别换名重试 |
| `lk` 报 not logged in | 会话过期，重跑 `lk setup /<workspace>`（或 `lk login <server>`）批准新设备码 |
| 任务一直 pending | `lk-runtime status` 看 daemon 是否 online；再用 `lk show <id> --log` 看 blocked note（别名错 / agent 没装 / 机器离线） |
| agent 起不来 | 目标机器上对应的 `claude` / `codex` / `grok` 是否可用且已登录；看 `~/.loopany-kernel-live/daemon.log` |
| run 被改判 failed | agent 静默退出（没写任何事件）—— 完善 body 里的收尾要求 |
| 正式环境被带偏 | `env \| grep LOOPANY_HOME` 应该是空的；正式命令用裸 `loopany`，kernel-live 用 `lk` / `lk-runtime`，不要混 |
| 想看服务器日志 | `fly logs -a loopany-kernel-live`（需要 fly 权限） |
