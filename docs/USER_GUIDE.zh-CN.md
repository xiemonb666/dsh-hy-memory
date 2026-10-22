# HyMemory Studio 用户指南（中文）

> 本指南保留历史操作说明；本轮新增 CLI 恢复、安装事务、外发许可及实际验证以[复验记录](REMEDIATION_REPORT.md)为准。模型策略默认为 ask-first；仅配置端点和密钥不会自动允许调用模型。

适用版本：插件 `dsh-hy-memory` 0.1.0，DSH 0.2.1-rc.2，Hy-Memory SDK 2.0.4，
Node ≥ 24，Python ≥ 3.12（本机 3.12.14）。

本文只描述**已经实现并能跑通**的行为。文中每条命令都可以直接复制执行；
凡是当前做不到的事，都写在「已知限制」一节里，不做承诺。

---

## 1. 它是什么

HyMemory Studio 是 DeepSeek Harness 的一个原生插件，给会话加上**带证据的长期记忆**：

- **采集**：会话里发生的事（用户消息、助手结论、工具结果）被切片、脱敏、入队，
  再交给记忆引擎抽取候选；
- **治理**：候选不会直接变成「事实」。每条记忆带状态
  （`proposed → needs_review → supported → verified` 等）、证据、版本和审计记录；
- **召回**：任务开始时按 ACL 先鉴权、再排序、再按硬性 token 预算裁剪，最后以
  `<memory_clues provenance="untrusted-retrieved-data">` 数据容器注入，
  明确标注为「不可信的检索数据」；
- **记忆台**：9 个页面的本地 Web UI，用来浏览、审查、解决冲突、管权限、看诊断。

### 三条硬规则

1. **模型说的不算证据。** 只有真实工具结果、仓库观察、通过的测试才能支撑
   `verified`，而且还需要一条真实的 validation 记录。
2. **召回内容不能回写成新事实。** 检测到回声会被拒绝。
3. **跨项目默认拒绝。** 即使你是 owner，检索也不会返回别的项目的数据。

---

## 2. 安装前检查

在仓库根目录执行：

```powershell
node dist\bundle\cli.js doctor --json
```

会逐项检查 node、python、数据目录、hy_memory SDK、DSH profiles、Studio 静态资源、
审计链。`hyMemorySdk` 失败不算致命（mock 引擎可以跑），其他项失败需要先修。

确认 DSH 可用：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --version
# 0.2.1-rc.2
```

---

## 3. 安装

### 3.1 构建安装包

```powershell
# 1) 先构建 Studio 前端（必须，否则 build 会报错退出）
$node = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
& $node $pnpm --filter @dsh-hy-memory/ui-client build

# 2) 再打包宿主插件 + Studio + Python worker
node scripts\build.mjs
# 输出：bundle written to …\dist\bundle (host entry … bytes)
```

### 3.2 建一个专用 profile 并安装

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$env:DSH_DESKTOP_NODE_EXECUTABLE = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"

# 用官方 web 模板新建 profile（已有可跳过）
& cmd /d /s /c "`"$dsh`" --profile hymem-spike --from-default-profile web --dump-config"

# 安装（先备份 profile 文件，再调用 dsh plugin add）
node dist\bundle\cli.js install --profile hymem-spike --json
```

`install` 会：

1. 把 profile 的 `package.json` 和 `cordis.patch.yml` 备份到
   `%LOCALAPPDATA%\dsh-hy-memory\profile-backups\<ISO 时间戳>\`（附 `manifest.json` 含 sha256）；
2. 把 UI 端口和 token 写进 `dist/bundle/client.js`（替换占位符）；
3. 执行 `dsh plugin --profile hymem-spike add <bundleRoot>`。

只想看会做什么、不落盘：

```powershell
node dist\bundle\cli.js install --profile hymem-spike --dry-run --json
```

---

## 4. 启用并打开记忆台

### 4.1 从 DSH 侧边栏打开（推荐）

1. 启动 profile：`& cmd /d /s /c "`"$dsh`" --profile hymem-spike"`（或直接启动桌面端）；
2. 浏览器打开启动时打印的带 token 的地址；
3. 左侧栏找到 **「HyMemory 记忆台」** 一行，点击；
4. 主区域出现一个内嵌 iframe，标题栏右侧有「在新标签页打开」。

### 4.2 直接用浏览器打开

```powershell
$token = (Get-Content "$env:LOCALAPPDATA\dsh-hy-memory\ui-token" -Raw).Trim()
Start-Process "http://127.0.0.1:48731/studio/?token=$token"
```

**令牌文件位置（真实路径）**

| 文件 | 路径 | 说明 |
|---|---|---|
| UI 令牌 | `%LOCALAPPDATA%\dsh-hy-memory\ui-token` | 首次启动 Studio 时生成，权限 0600，长度 ≥ 24 |
| Worker 令牌 | `<dataDir>/worker-token-<UUID>` | 每个托管实例独立；确认该子进程关闭后清理，0600 |
| Worker 端口 | `<dataDir>/worker-port-<UUID>` | 与令牌文件属于同一托管实例 |

首次使用有效的 `?token=` 打开 Studio 时，Host 会设置由 HMAC-SHA256 派生的
`hymem_session` Cookie（`HttpOnly; SameSite=None; Secure; Partitioned`），随后
302 跳转到不含 token 的 `/studio/`。此 Cookie 用于 DSH iframe 中的跨站会话；
所有 `/api/*` 请求仍须携带它。`POST`、`PUT`、`DELETE` 等写方法还必须带
`X-HyMemory-CSRF`。如果页面启动时没有可用的 CSRF 值，前端会先用同源凭据请求
`GET /api/session`，该接口在完成相同的 Cookie 会话认证后返回 `{ "csrf": "…" }`
并设置 `Cache-Control: no-store`；并发首次写入会共用这次请求。之后前端将值放入
`X-HyMemory-CSRF`，不会因 bootstrap 而绕过写操作校验。服务端不开放 CORS。

> 这两个服务都只监听 `127.0.0.1`。token 等于管理员凭据，不要贴给别人。

### 4.3 无 DSH 的独立运行

```powershell
node dist\bundle\cli.js serve --json --ui-port 48731 --engine auto
```

它会拉起 worker + Studio，并在 stdout 打印 `studio`、`token`、`workerPort`、
`engine` 和当前 `workspace`。

---

## 5. 第一次采集

### 5.1 真实会话（自动）

插件激活后，`session/event` 监听器会自动收集 `user/message`、`assistant/message`、
`tool/result`，在 `turn/end` 时切片入队。不需要手动操作。

### 5.2 用 CLI 走一遍完整管线（验证安装）

```powershell
$env:HYMEM_DATA_DIR = (Resolve-Path artifacts\e2e-data).Path

node dist\bundle\cli.js capture --json --text "Please remember the project uses pytest and that I prefer Python 3.12 for this repo."
```

真实输出（本机实测）：

```json
{ "ok": true, "command": "capture",
  "jobId": "01a15a0e-1205-7275-9159-737483310884",
  "created": ["01a15a0e-12b7-7fea-9047-ce74a1799ac4"],
  "needsReview": [], "rejected": 0 }
```

- `created` = 直接存为 `supported` 的记录；
- `needsReview` = 证据不足、需要人工看的记录；
- `rejected` = 没有证据 / 回声 / 被闸门拒绝。

带工具结果的采集（用来验证「测试通过才算证据」）：

```powershell
node dist\bundle\cli.js capture --json `
  --text "guard divide by zero" `
  --tool-output "pytest: 12 passed" --tool-exit 0
```

### 5.3 立刻召回一次

```powershell
node dist\bundle\cli.js search --json --query "Which Python version and test runner does the project use?"
```

实测：1 条线索、`tokenCount` 105（预算 600）、`elapsedMs` 16，渲染为：

```
<memory_clues provenance="untrusted-retrieved-data" scope="workspace">
[01a15a0e-12b7-7fea-9047-ce74a1799ac4][SUPPORTED][applies_to: workspace:ws_…] evidence=1 | Python 3.12 for this repo | Python 3.12 for this repo | memory_get({ id: "…" })
</memory_clues>
```

---

## 6. 记忆浏览器（记忆浏览器页）

- 按状态、场景、类型、agent、全文关键词过滤，分页每页最多 100；
- 点任意一行打开详情抽屉：正文、声明三元组、证据、版本历史、代码绑定、注入成本；
- 详情里的 `injectableTokens` 是**真的**按渲染容器算出来的，不是估算占位；
- 状态流转必须填原因，并且带 `expectedRevision`（乐观并发）；别人先改了你会拿到 409。

状态词表（UI 与 API 一致）：`proposed`（模型提出，无证据）、
`needs_review`（有证据但不足）、`supported`（有真实证据）、
`verified`（证据 + 真实通过的 validation）、`conflicted`（冲突未解决）、
`stale`（代码/环境已变）、`superseded` / `rejected` / `deleted`（终态，永不召回）。

---

## 7. 证据与版本（证据与版本页）

- 证据有信任级别：`user_explicit` > `tool_observed` / `repository_observed` /
  `test_verified` > `external_cited` > `model_generated`；
- 证据是**不可变**的：只追加，不修改；正文里的密钥在落盘前就被替换为
  `[REDACTED:<kind>]`；
- 版本历史记录每次内容变更和每次状态流转，旧版本永远可读；
- 代码绑定区会给出 `fresh / conditional / stale / unknown` 判定。
  `unknown` 表示**无法证明**（浅克隆、游离 HEAD、缺哈希），绝不等于 `fresh`。

---

## 8. 冲突（冲突页）

当两条记忆的主语+谓语相同、宾语不同（或极性相反）时，会生成一条冲突用例，
而不是悄悄覆盖。

- 页面并排显示两条声明（older / newer）和各自状态；
- 解决方式四选一：**保留两者** / **用新的取代旧的** / **驳回新的** / **标记未解决**；
- 必须填写原因，解决动作写审计链；
- 冲突中的记忆默认不会被召回。

---

## 9. 代理与权限（代理与权限页）

- 展示 agent 树（主 agent / 子 agent）、角色、所属项目与工作区；
- 授权编辑器可以预览「这次授权到底改变了什么」再提交；
- 支持单条撤销和「全部撤销」（二次确认）；
- 权限模型（默认拒绝）：

| 主体 | 可读范围 |
|---|---|
| owner（本地用户） | 全部 |
| 主 agent | 自己项目/工作区的 `workspace`、`project` 记忆、自己写的 `private` |
| 子 agent | 自己写的 `private`/`agent` 记忆；其他一律需要显式授权 |
| 未知主体 | 无 |

`shared` 作用域**任何主体**都需要显式授权。作用域不是可见性阶梯——
父 agent 不会因为「是父」就继承子 agent 的私有记忆。

授权动作：`read`、`propose`、`review`、`feedback`、`delete`、`admin`；
授权可设过期时间，撤销后下一次检索立刻生效（缓存按 ACL 版本失效）。

---

## 10. 采集与队列（采集与队列页）

- 开关：总开关、chat / working / coding 三类场景、自动采集、历史导入；
- 队列分栏：排队 / 运行中 / 重试中 / 隔离 / 完成；
- 单个任务可「重试」；
- **「取消」按钮不可用**：`POST /api/jobs/:id/cancel` 未实现，
  `/api/studio-config` 返回 `capabilities.canCancelJobs: true`，前端据此启用；
- 脱敏报告只显示**数量**，从不显示被脱敏的内容。

采集关键默认值（可在设置页改）：证据保留 90 天；超过 32 KB 的工具输出不入库；
不保存原始工具输出；离线队列上限 128 MiB；单批事件 60 条。

---

## 11. 用量与质量（用量与质量页）

- 24 小时窗口内的召回次数、注入 token 数、错误数；
- 每 agent 拆分、质量指标、成本区块；
- 成本区块在不知道单价时显示 `unknown`，**不会编造金额**；
- 注入回执（injection receipt）记录每次召回注入了哪些 id、多少 token、
  耗时、是否命中缓存、当时的 ACL 版本。

---

## 12. 设置（设置页，7 个分区）

后端 / 模型 / 召回 / 采集 / 安全 / 存储 / 高级。

保存采用**乐观并发**：只提交改动的分区 + `expectedRevision`；版本对不上会弹冲突
对话框，让你重新加载再改。

常用召回项与默认值：

| 设置 | 默认 | 含义 |
|---|---|---|
| `mode` | `clue-first` | 线索优先；`tool-only` 则只走工具 |
| `trigger` | `task-boundary` | 只在任务第一步召回 |
| `clueLimit` | 4 | 最多几条线索 |
| `maxInjectionTokens` | 600 | 单次注入硬上限（按渲染结果计算） |
| `maxSingleClueTokens` | 150 | 单条线索上限 |
| `searchTimeoutMs` | 900 | 检索超时，超时返回空而不是阻塞 |
| `cacheTtlSeconds` | 180 | 缓存存活时间 |
| `allowUnverifiedAsFact` | false | 未验证记忆不得当事实 |
| `staleGuidance` | `clue-only` | 过期记忆仍显示但标注 |

安全项：`denyCrossProjectByDefault: true`、`auditLog: true`、
`exportConfirmation: true`、`autoPromoteModelClaims` 固定为 `false`（不可改）。

模型项：`mode`（pro/ultra/lite）、`extractionEndpointEnv`
（默认 `MEMORY_LLM_BASE_URL`）、`embeddingEndpointEnv`
（默认 `MEMORY_EMBEDDER_BASE_URL`）、`externalEgress`（默认 `ask-first`）、
`localOnly: true`。**本机没有配置任何模型端点**，所以引擎是 mock。

---

## 13. 诊断（诊断页）

- 版本：DSH / profile / 插件 / worker / Studio UI / Node / Python；
- 依赖检查：`node:sqlite`、Python worker、审计链；
- 数据路径、日志位置；
- 审计链：长度、头哈希、校验时间、断点 id；权限矩阵；最近审计事件（已脱敏）。

审计链是哈希链：每条事件的 `hash = sha256(canonicalJson({actor, operation,
target, outcome, detail, createdAt, prev}))`，`verifyAuditChain` 从头重算，
第一处不一致会返回 `brokenAt`。命令行等价物：
`node dist\bundle\cli.js status --json` →
`{ "ok": true, "counts": {...}, "audit": { "valid": true }, "dataDir": "..." }`。

---

## 14. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| DSH 侧边栏没有「HyMemory 记忆台」 | 客户端插件没加载 / profile 没装 | 确认 profile 的 `package.json` 依赖里有 `dsh-hy-memory`；重新 `install` 后重启 DSH |
| 面板空白或提示「无法连接记忆台服务」 | Studio 端口没起来，或 iframe 被 CSP 拦 | 看 `%LOCALAPPDATA%\dsh-hy-memory\logs\plugin.log`；确认 `ui.enabled: true`；确认 `ui.allowedFrameOrigins` 包含你的 DSH Web 源 |
| 日志里 `cannot get required service "tools" in inactive context` | 旧版本的已知缺陷：工具在 `ctx.effect` 的异步续体里注册，丢失了插件上下文 | **已在当前版本修复**（`index.ts:186-197` 改为同步注册）；升级并重启 DSH |
| 浏览器 401 | 没带 token 或 Cookie 过期 | 重新用 `?token=<ui-token>` 打开 |
| 写操作 403 | 缺少 `X-HyMemory-CSRF` 头 | 用页面操作，不要手搓请求 |
| 页面资源报 MIME 错误 | 旧版本会把缺失的 JS 回退成 HTML（已修复） | 重新构建 Studio 并重装 |
| 采集一直不出现记忆 | 证据不足 / 被闸门拒绝 / 被判定回声 | 看 `capture` 返回的 `rejected` 与 `needsReview`；看诊断页的审计事件 |
| 召回总是 0 条 | 查询太短（如「ok」「继续」）会被信息下限短路 | 用有实际意图的查询；或直接调用 `memory_search` |
| 引擎显示 degraded | 未配置 `memory-engine.env`，走 mock | 正常现象；`reason: "no model endpoint configured"`。配置见 `docs/ONLINE_ENGINE_EVIDENCE.md` |
| `reindex` 未改动索引 | 指定了 `--dry-run` 或使用旧构建 | 当前构建不加 `--dry-run` 会实际执行；见复验记录 |
| worker 起不来 | Python 路径不对 | 设 `HYMEM_PYTHON` 指向 `.venv\Scripts\python.exe` |
| 日志里 `worker exited with code N` | worker 崩溃 | 宿主会在 3 秒后自动重启；反复崩溃才需要看 Python 侧报错 |
| 端口 48731 被占 | 另一个实例在跑 | 用 `--ui-port` 换端口，或在设置里改 `ui.port` |

---

## 15. 卸载

```powershell
node dist\bundle\cli.js uninstall --profile hymem-spike --json
```

它会调用 `dsh plugin --profile hymem-spike remove dsh-hy-memory`，
**保留** `%LOCALAPPDATA%\dsh-hy-memory` 下的全部记忆数据，并在输出里提示
`memoryDataRetained: true` 与清理建议。

彻底删除（不可逆，先确认）：

```powershell
# 1) 先备份
node dist\bundle\cli.js backup --json
# 2) 确认备份文件存在且 sha256 正确
# 3) 再删目录（这一步需要你自己确认路径）
Remove-Item "$env:LOCALAPPDATA\dsh-hy-memory" -Recurse -Force
```

---

## 16. 智能体工具（给模型用的）

插件注册 6 个工具：`memory_search`（检索，返回线索容器）、`memory_get`
（按 id 读完整记录，含证据引用与注入成本）、`memory_propose`（提出候选，
只能是 `proposed`，不能自证）、`memory_feedback`（有用/错误/过期；错误或过期
转 `stale`）、`memory_link_code`（绑定到当前分支/提交/文件）、`memory_status`
（引擎健康 + 本项目计数）。`memory_get` 对「无权访问」和「不存在」返回
**同一个** 404，不泄露存在性。

---

## 17. 已知限制（必须知道）

1. **没有模型端点。** 本机跑的是确定性 mock 引擎：`degraded: true`，
   `reason: "no model endpoint configured"`（仅当未配置引擎时）。真实 SDK 路径由
   `python/research_smoke.py` 证明（对着本地 mock [OI] 服务器，15/15 检查通过）。
2. **`POST /api/jobs/:id/cancel` 未实现**，取消按钮被禁用。
3. **MemHub 后端未实现。** `backend: 'memhub'` 只是设置里的枚举值。
4. **SDK 2.0.4 的编码记忆 id 无法用 `/v1/get` 寻址**（`L1_RAW` 被 SDK 隐藏），
   所以编码记忆以治理库中的正文为准。
5. **`symbolsFromDiff` 是启发式行扫描**，不是 AST，符号定位可能不准。
6. **维护命令需使用当前构建。** `reindex` / `migrate` 默认实际执行，
   `--dry-run` 只预览；`restore` 只恢复到新的或空的目录，保留已有数据。
7. **20 项验收场景中 2 项只是部分覆盖**：E2E-02（真实双子智能体 DSH 会话）与
   E2E-11（浏览器里编辑→刷新的完整往返）；其余 18 项都有可执行断言。
   详见 [E2E_MATRIX.md](E2E_MATRIX.md)。
8. **Studio 以 `owner` 身份运行**：拿到 UI token 就等于拿到全部管理权限。
9. **系统 Node 24.16.0 下 `api-e2e.mjs` 收尾会崩**（libuv 断言，
   退出码 `-1073740791`），但 15 项检查全部通过；用 DSH 自带的
   Node 24.21.0 跑则正常退出 0。请用自带 Node 运行运维脚本。
10. **Linux / macOS 未验证。** 代码按跨平台写（XDG 数据目录、POSIX 路径分隔符），
    但从未在那些平台运行。
