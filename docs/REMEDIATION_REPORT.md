# 补缺、优化与复验记录（更新于 2026-10-22）

本报告只陈述本轮实际实现和验证结果。Windows 预览范围已由主 Agent 验收：TypeScript 22 files / 260 tests passed、完整 mock E2E、真实 DSH Host/Studio iframe、首次设置保存与 SQLite 持久化均通过，并已安装到用户当前桌面配置、重新打开后实际看见 Studio 总览。合成数据在线 smoke 也已通过。完整原生 Agent 回合、活 DSH 多智能体会话、跨平台运行和完整 gold set 仍未验证，因此不代表完整 GA 计划完成。

前期 DSH CLI 验证只操作隔离的临时 home/profile；随后用户明确要求安装到当前 DSH，已备份并更新 `desktop` profile，沿用现有记忆目录。默认 `dist/bundle` 未重建。在线请求只使用下文记录的合成项目事实，没有把用户代码、会话或真实记忆发送给模型。协作调用没有提供实际费用，费用记为 UNKNOWN。

## 实现内容

| 范围 | 已实现内容 |
|---|---|
| 检索和治理 | 授权精确匹配 memory/project/workspace；候选先过 ACL 再评分；跨项目单条共享需显式授权；缓存命中重新检查状态、版本、权限、有效期和墓碑；按完整渲染结果硬性裁剪 token 预算，保留 140-token 边界行为。 |
| 采集、证据和队列 | 先脱敏再截断；修复重复 JSON 编码；队列租约由 owner/attempt fence；关闭 capture 时不租用旧任务；取消后拒绝迟到完成；统计按实际 injection receipt 的记忆 ID 归属并去重。 |
| 模型外发策略 | SDK 构造和 warmup 前核对许可；Host 对每次数据请求复核当前策略；默认拒绝外发；只允许显式配置的 HTTP(S) 外发；`localOnly` 无法验证端点时拒绝；worker 请求不跟随重定向；健康探针计入请求 deadline。 |
| 原生 DSH hook 与生命周期 | 新增 pre-step 适配器，保留并等待下游 waterfall 决策，识别普通用户消息数组中的文本；只追加、替换或清理插件自己拥有的 surface 节点。真实 Session 路径不调用弃用的 `eventAt`，50 轮后仍只有一条线索，清理线索不删除普通用户消息。关闭时取消 hook、queue drain、Studio 重试和 worker 启动的迟到 continuation；bounded dispose 后迟到结果不再访问已关闭 store。加入 Plugins 设置入口，不展示未实现的 MemHub 后端。 |
| SDK 失败处理 | `hy-memory` 的 `add()` 返回 `success: false` 时，在 readback 前抛出固定文本的 `E_BACKEND_UNAVAILABLE`（HTTP 503），计入 error metric，不返回候选且不回显 SDK 错误原文；正常 `success: true` 仍执行 readback。 |
| Worker 与 Windows 安装边界 | 每个 worker 使用 UUID token/port 文件，只停止和清理自己持有的进程与文件；托管 Python 启动时禁止写入字节码缓存，保持包目录不变。Windows 在进入 shell 前拒绝含 `%` 的 profile/launcher/参数，安装预检早于任何事务写入；修正桌面 exe 推导，launcher/pnpm 从显式配置、当前用户安装目录及 ProgramFiles 发现，移除个人路径硬编码。 |
| CLI 与维护 | `restore` 从显式 source 恢复到不存在或为空的显式 data 目录；`reindex` 默认实际重建索引并排除墓碑；`migrate --dry-run` 只读；检查 SQLite 完整性、schema、审计链和墓碑 ID 一致性；JSON 失败仍返回可解析对象。 |
| 构建与安装 | 构建输出可指向隔离绝对路径；SHA-256 清单覆盖包文件；中断发布时用受校验 journal/备份恢复，保持输出根目录；build 与 installer 共用路径策略拒绝私密文件。安装器只向用户指定 dataDir 的私有 bundle 副本写入端口、token 和实际 dataDir，源 bundle 保持占位符。 |
| 测试运行器 | mock E2E 在独立临时 dataDir 和随机端口启动；只停止自己启动并持有所有权的进程；缺文件或跳过不算成功；报告分列通过、失败和跳过。在线 smoke 与 A/B 也各自使用临时目录、显式隔离配置和有界请求。 |

保留了进入本轮前已有的 Studio bind retry 和 `conversation.view` UI 修改。在线 harness 使用的 `artifacts/validation-20261021/bundle-verified` 在 SDK 在线导入后产生了 `__pycache__`；后续构建保护正确拒绝复用含运行时缓存的非空目录，证据在 `build-reuse-runtime-cache-rejection.log`，该诊断目录未删除。随后将 bundle 构建到新目录 `artifacts/validation-20261021/bundle-delivery-clean-20261022` 并 exit 0（`final-bundle-build.log`）；该交付目录的 20 个文件 SHA-256 全部匹配清单、UI 占位符保留（`final-bundle-proof.log`），完整 mock E2E 也在该目录上通过。默认 `dist/bundle` 的 `index.js`、`client.js` 和 `package.json` 构建前后 SHA-256 相同（`existing-dist-before.json`、`existing-dist-after.json`）。

## 运行环境与依赖来源

- Windows 11 x64，DSH 随附 Node v24.21.0，Python 3.12.14；Python 测试使用仓库锁定虚拟环境。
- `hy-memory==2.0.4` 由 `pyproject.toml` 和 `uv.lock` 固定。官方本地源码 checkout HEAD 为 `8f1c4045e913566a6f40eb4451d68218b2307773`；锁文件同时固定 PyPI sdist SHA-256 `ae68837a55afdd50143003608e586350da36c5bd90f4dafcf460c34377179a11` 和 wheel SHA-256 `1d6fd4120185cc6cbcf04f9d81d5bf47e33c467f52787e5d175a412d4e687cd1`。
- DSH Session surface 测试使用本地安装的 `@deepseek-ai/dsh-session`；内部 API map 对照的官方 DSH 源码 commit 为 `687f282e`（`docs/internal/DSH_API_MAP.md`）。这只证明本地 Session API 兼容，不证明真实 profile 安装或桌面端全流程。
- uv lock 检查解析 109 个包。Linux/macOS 和 CI 远端 runner 未实际运行。

## 离线验证结果

证据目录为 `artifacts/validation-20261021/`；验证跨越至 10 月 22 日，保留原始文件名。

| 检查 | 实际结果 | 证据 |
|---|---|---|
| Host/CLI/scripts 与 UI TypeScript 类型检查 | 主 Agent 在桌面认证修复后复核，两条命令均 exit 0 | `final-desktop-typecheck-host.log`、`final-desktop-typecheck-ui.log` |
| oxlint | 桌面修复后全仓 exit 0 | `final-desktop-lint.log` |
| Python pytest 与 Ruff | 40/40 passed；Ruff clean | `final-python-tests.log`、`final-ruff.log` |
| uv 锁定依赖 | `uv lock --check` exit 0，109 packages | `final-uv-lock.log` |
| 隔离 UI 与 bundle 构建 | exit 0；输出至自定义验证目录 | `final-ui-build.log`、`final-bundle-build.log` |
| Bundle 完整性 | 最终 `bundle-delivery-clean-20261022`：20 文件 SHA-256 全部匹配，UI 占位符保留；旧在线运行目录产生运行时缓存后被保护逻辑拒绝复用 | `final-bundle-proof.log`、`build-reuse-runtime-cache-rejection.log` |
| Bundle policy / build recovery / installer | 临时目录定向测试 41/41；覆盖 5 种 installer 私密路径拒绝、更多构建文件名拒绝，以及 publisher 中途 exit 77 后恢复旧 bundle | `shared-bundle-policy.log`、`tests/unit/build-options.spec.ts`、`tests/unit/install-transaction.spec.ts` |
| 原生 Session 与生命周期 | `native-clear-green.log` 当时记录的定向范围为 23/23；包含不用 `eventAt`、50 轮 surface、更改/清理自有节点、late-dispose、lease fence、Plugins 页面和取消 Studio retry。后续代码仍以最终全量复跑为准 | `native-clear-green.log` |
| 外发策略 | 10/10 定向检查通过；覆盖默认 deny、策略变更复核、localOnly 无法验证时拒绝、显式外发许可、deadline 与不跟随重定向 | `egress-fixture-green.log` |
| 完整 mock E2E（桌面认证修复后的最终 bundle） | 5 套件、65 检查、0 失败、0 跳过 | `final-desktop-mock-e2e.log` |
| 真实本地 DSH Session proof | 50 轮保留 50 条普通消息；每轮最多一条 HyMemory 节点；清理后 HyMemory 节点为 0；网络调用 0 | `dsh-surface-proof.log`、`native-clear-green.log` |
| TypeScript 全量测试 | 22 files、260/260 passed | `final-desktop-ts-tests.log` |
| 最终交付 bundle | `bundle-desktop-auth-test-20261022` 构建 exit 0，20 项 SHA 验证通过；manifest SHA-256 为 `6bf7b2d1d31fcc2399051f7df75a24e2315d0f27a54b01f280decf207d3725e3` | `desktop-auth-bundle-final.log`、最终真实 Host 报告 |
| 跨站真实 Studio UI 设置写入 | 14/14 检查通过；真实 SQLite、真实 UI 点击保存、刷新及重开 store 持久化；bootstrap 503 时不发送 PUT | `desktop-auth-e2e-xWPiOV/summary.json` |
| 真实隔离 DSH Host 与浏览器 | 8 项 gate、9/9 页面、Plugins 详情和设置 iframe、认证 health 全通过；Host 日志无 substantive errors；所有自有进程与端口关闭 | `native-host-2026-10-22T10-26-19-379Z/native-host-report.json` |

负向硬门回归的通过证据包括：ACL 在打分前过滤未授权候选（`tests/unit/retrieval.spec.ts`）；缺少真实 validation 时拒绝自动 `verified`（`tests/unit/governance.spec.ts`、`tests/security/pollution.spec.ts`）；既定诱捕密钥在治理事件、证据与队列 payload 中脱敏（同两文件）；删除墓碑不被列表、缓存或 reindex 复活（`governance.spec.ts`、`retrieval.spec.ts`、`cli-maintenance.spec.ts`）；140-token 上限内缩减线索（`retrieval.spec.ts`）；Host 外发在默认拒绝或许可改变后被阻断（`tests/security/egress.spec.ts`）。这些测试证明相应边界，不代表全部 GA 计划通过。

mock E2E 的 65 项来自跨进程 11、API 15、UI 验收 20、UI 往返 10、运维 9。运维路径实际执行 backup/restore/reindex 并检查墓碑；worker 故障测试只终止 runner 自己启动的 mock worker，验证 worker 不可用时 memory list/overview 仍可读并显示 degraded。此检查不声称 Host 会自动重启 worker。

## 合成数据在线验证

本节汇总 `bundle-verified` 上的正式 harness 结果。更早的主 Agent 隔离 CLI capture/search 与 source 诊断分别保留在 `online-live-capture.json`、`online-live-search.json`、`online-semantic-before.json` 和 `online-semantic-exact-before.json`，不计入下方 15/15 或 A/B 数字：早期 capture/search 产生 1 条合成记忆并返回 1 条 clue（1088 ms）；source 修复前 exact semantic probe 为 SDK 1 hit / Host 0 hit。其临时复制 env 清理报告为 `online-live-config-cleanup.json`，记录副本已删、源文件仍在。早期失败 harness 见下方。正式 online smoke 与 A/B 配置文件两次读取 hash 相同（`b247a7e6033b198165c4ad76cca50da81c6261c1f549e25c427f8f19e3fb4e6e`）。端点、密钥和原始 env 值没有写入报告。

复现使用 DSH Node 24.21、锁定 Python、`bundle-verified` 和测试 env 文件；命令、exit code、stdout JSON 分别保存在 `online-harness-run-bundle-verified-20261022.command.txt`、`.exit.txt`、`.stdout.json`，A/B 对应 `ab-harness-run-bundle-verified-20261022.command.txt`、`.exit.txt`、`.stdout.json`。两条正式 harness 记录均为 exit code 0。在线 bundle 与首次 clean 交付 bundle 的历史比较有 `cli.js`、`index.js` 两项变化，其余 18 个文件（包括 Python worker）完全一致；Host 的精确差异只有托管 worker 启动环境新增 `PYTHONDONTWRITEBYTECODE=1`，CLI 另有 Windows 参数保护、exe 推导与安装路径发现修复。证据为 `online-to-delivery-bundle-comparison.json`、`online-to-delivery-host.diff`。召回和 SDK 处理逻辑未变；这些启动/安装变化由最终全量 TypeScript、mock E2E 与隔离安装检查验证，没有重复付费模型请求。此后最终桌面包另包含本文下方的 Cookie、CSP、CSRF bootstrap 与 UI 修复，已运行最终 260 项 TypeScript、65 项 mock、14 项真实 UI 和真实 Host gate；这些页面与安装变更没有重新调用付费模型。入口分别是 `tests/e2e/online-engine.mjs` 和 `scripts/ab-recall.mjs`。配置允许列表只包含模型参数，并强制每次运行使用临时数据目录；原始 env 内容未保存。Sidecar 记录的三个源行为控制值没有传给 child，因此本结果适用于该隔离 harness 配置，不应用来推断这些开关开启时的差异。

| 检查 | 实测结果 |
|---|---|
| Online SDK/CLI smoke | `online-harness-2026-10-22T05-00-50-621Z.json`：15/15 checks；SDK `hy-memory` 2.0.4，embedding dims 1024；capture 和 search 子进程 exit 0；捕获 1 条合成记忆；语义-only source 返回 1 条 clue，`keywordChannelUsed=false`，reported clue token count 193，耗时 1031 ms。 |
| A/B smoke | `ab-harness-2026-10-22T05-01-20-919Z.json`：seed 42、3 paired runs、9/9 harness checks；固定事实为 CUDA 12.4、pytest、release codename `amber-kite-7319`。No-memory 事实命中与答案实际引用 ID 均为 0/3；with-recall 两者均为 3/3。 |
| A/B 请求顺序 | pair 1 和 2 为 no-memory → with-recall；pair 3 为 with-recall → no-memory。相同问题与固定 synthetic fact；这是三组 smoke，不是显著性检验。 |
| Token 与费用解释 | provider 对 A/B 直接 chat 响应报告 no-memory 338 tokens、with-recall 988 tokens；费用未提供，UNKNOWN。SDK worker 的 `tokens: 0` 是 adapter counter，不是 provider usage；sidecar 将 provider token usage 标为 UNKNOWN。 |
| 清理 | Online smoke 启动/停止自有 worker 2/2、临时 run 已移除、未关闭 child/worker PID 为 0；A/B 启停自有 worker 1/1、临时 run 已移除、未关闭 PID 为 0。 |

必须保留早期失败：`online-harness-2026-10-22T04-52-18-471Z.json` 是部分证据重建，不是原始 stdout。该次配置把 LLM 最大尝试次数设为 0，SDK 语义是零次尝试，未产生向量记忆，Host semantic-only 为 0 clue；此外报告写入缺少 `writeFileSync` import，最初报告持久化失败，记录的临时目录清理标记为 false（worker 已停止）。随后根据该新证据将 LLM attempts 改为 1、embedder retries 保持 0，修复报告写入并使用更新 bundle 完成后续定向周期。该失败文件仍保留，未算通过，没有盲目重试相同配置。

对该失败 run 做了限定清理：临时根目录由该 run 的重建报告明确记录，且只移除了其两个普通文件 `cli-data/memory-engine.env` 和 `sdk-probe-data/memory-engine.env`。没有读取、打印或改动源 env；数据库与 SDK 日志仍保留以供复现。最终两次 run 的清理状态见上表。脱敏清理记录：

```json
{
  "runId": "online-harness-2026-10-22T04-52-18-471Z",
  "tempRoot": "%TEMP%/<synthetic-online-harness>",
  "configCopiesFound": 2,
  "configCopiesRemoved": [
    "cli-data/memory-engine.env",
    "sdk-probe-data/memory-engine.env"
  ],
  "databaseAndSdkLogsPreserved": true,
  "workerPidsClosedInRunRecord": 2,
  "unclosedWorkerPidsInRunRecord": 0,
  "sourceEnvReadOrModified": false
}
```

Online semantic latency 只有一次合成查询，不能代表负载性能。A/B 仅一个事实、一个问题、一个模型、三组配对；不能据此声称通用召回质量改善或统计显著。SDK provider token usage 和美元费用都 UNKNOWN。

## 性能适用范围

离线基准使用同一机器、同一合成数据生成器，每组 40 个查询，测关键词通道，不调用模型；不能替代在线语义准确率或生产负载测试。

| 数据集 | p50 | p95 | 平均注入估算 token | 最大 token / 600 | 预算违规 |
|---|---:|---:|---:|---:|---:|
| 改前 10,000 | 14.82 ms | 20.68 ms | 407.2 | 409 / 600 | 0 |
| 改后 10,000 | 14.84 ms | 20.43 ms | 353.2 | 355 / 600 | 0 |
| 改后 50,000 | 59.69 ms | 92.47 ms | 353.2 | 355 / 600 | 0 |

10k 对照中平均注入估算 token 降低约 13.3%，延迟基本持平。单机小样本、未严格控制后台负载，不据此宣称统计显著加速。记录为 `baseline-benchmark-10k.json`、`after-benchmark-10k.json`、`after-benchmark-50k.json`。

## 真实 DSH 临时安装链

已在安装清单版本 `0.2.1-rc.2` 上运行真实 CLI，使用独立 `DSH_HOME`、`DSH_AGENTS_HOME`、缓存、非保留随机 profile 和合成 SQLite 数据。成功证据为 `isolated-install-6184f9e65cac48eba452afeb84b17052/summary.json`、`commands.jsonl`；复现脚本为 `isolated-install-20261022.ps1`。10 个子命令均 exit 0，无超时：

- bootstrap 后安装；profile 的 bundle 与依赖引用指向 dataDir 下的私有副本。
- `--dump-config` 中实际 dataDir、UI 端口与测试指定值一致。
- 卸载、重装、再次卸载；两次卸载后 bundle 和依赖引用都已移除。
- 安装与卸载后，哨兵文件和 SQLite 中的测试行均保留；源 bundle 树摘要前后一致。

独立审查接受上述安装链证据。卸载后私有 bundle 历史副本仍保留在 dataDir；本项未声称清理所有安装缓存。流程没有启动 Host、worker 或模型回合，因此不能代替运行时验收。

失败证据均保留：`isolated-install-49569c972b5e4cf7ae35af10a86ea6a9` 因运行缓存拒绝输入；`5eba4bf4970a4e11b939b8030d2b497a` 缺测试 launcher 环境配置；`7a4080ef42684c308be8f449044318c2` 暴露 npm 隐式 `package.json` 与安装器清单合同不一致；`59b7c9161be64c479db406ea5fb461cd` 暴露客户端注释重复占位符。后两项分别修正为始终复制并校验隐式 manifest（定向红绿记录 `npm-implicit-manifest-*.log`，42/42）和从注释去掉重复占位符。没有放宽 SHA、普通文件、私密文件或单次占位符校验。

上述 mock 运行后的 bundle 已无新增缓存，20 项 SHA 一致且 `unexpectedFiles=[]`。上述隔离测试未通过删除数据或修改用户既有 profile 来绕过问题。

## 用户当前桌面安装与空白页面修复

用户随后明确要求将预览版装到当前 DSH。首次 CSP 修复安装以及最终认证修复安装均 exit 0，配置快照与私有 bundle 均已创建，manifest 从旧 `dist/bundle` 改为私有副本；原记忆目录和数据库保留。`desktop-install-result.json`、`desktop-final-install-result.json` 只在本地保留，不随公开源码导出。

已确认旧 Studio CSP 未包含官方桌面来源 `dsh-app://app`；默认白名单已加入该精确来源，显式用户白名单仍覆盖默认。`desktop-csp-red.log`/`desktop-csp-green.log` 记录真实 HTTP 回归先失败后 2/2 通过。桌面版本构建记录为 `desktop-preview-build.log`。

独立跨站代理探针复现：`localhost` 父页嵌入 `127.0.0.1` iframe 时，原 Strict Cookie 登录后返回 401。修复使用 HttpOnly/SameSite=None/Secure/Partitioned Cookie，并保留 HMAC 会话和 token-free redirect。经现有会话鉴权的 `GET /api/session` 用 no-store 返回 CSRF；客户端首次写入按同源 singleflight 初始化，已有写入 CSRF 校验保持生效。真实 UI 的旧客户端保存红证据为 403；修复后 14 项浏览器检查全部通过。该自动化跨站测试使用真实 GovernanceStore/SQLite，只有 engine runtime 被替换，不调用模型。

独立审查未发现阻断问题。审查指出清理摘要 `ownedServersClosed` 原先只代表服务曾启动，主 Agent 将其改为两端口关闭后均拒绝连接；两项实际端口证据原已为 true，修正经 node check、lint 和独立复核，未改写历史报告。

最终隔离 Host 报告为 PASSED/VERIFIED，使用同一 20 文件 bundle。首次引导弹窗和插件卡片 selector 的早期失败均保留，最终按官方真实 UI 控件与属性修正后通过，未绕过遮罩或鉴权。随后主 Agent 通过应用菜单正常退出并重新打开实际 DSH，在精确 `dsh-app://app` 的记忆台 iframe 看见 `local loopback Studio overview` 和正常总览；之前的 `chrome-error://chromewebdata/` 空白页已消失。实际用户界面截图未复制到公开源码。当前实际后端因尚未配置模型端点处于 mock/degraded，数据库与 worker 健康；没有擅自复制测试密钥或开启用户会话外发。

## 未覆盖与验收边界

| 项目 | 当前状态 |
|---|---|
| Windows 预览、本轮选定硬门回归、定向检查与完整 mock E2E | ACCEPTED；260/260 TypeScript、65/65 mock、14/14 跨站 UI 检查和真实 Host gate 通过。 |
| 完整计划/GA 全部验收 | 未达成；本轮结果不代表全计划 ACCEPTED。 |
| 真实 DSH 临时 profile 安装、卸载、重装 | 已通过，见上述实际 CLI 证据；随后按用户新授权安装到了 desktop，见单独记录。 |
| 真实 Host 与 Studio iframe | 已通过隔离 Host gate；实际桌面 iframe 也已观察到正常总览。 |
| 原生 Agent 完整回合 | NOT_RUN；真实 Host/iframe 与 Session class 单测不代替该项。 |
| 活 DSH 多智能体会话 | NOT_RUN；离线构造的 principal/CAS 检查不证明真实 spawn 身份。 |
| Linux/macOS、远端 CI | NOT_RUN；只在 Windows 本机验证。 |
| 完整研究 gold set、七路消融、置信区间 | NOT_RUN；仅完成 3-pair synthetic smoke。 |
| MemHub 后端 | 未实现。 |
| SDK 实际 token usage 与在线费用 | UNKNOWN；SDK adapter counter 不提供供应商 usage。 |

另保留旧 PATH Node v24.16.0 子进程运行的失败日志 `integration-e2e.log`，退出码 3221226505；此轮主要命令改用 DSH Node v24.21.0。主 Agent 已审阅最终工件、差异和上述检查，验收范围仅为本轮 Windows 预览，不包括未运行项目。
