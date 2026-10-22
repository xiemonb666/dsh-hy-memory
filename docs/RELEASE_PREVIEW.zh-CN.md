# Windows 预览包安装说明

**状态：Windows PREVIEW（候选预览版，非 GA）**

此包包含 `dsh-hy-memory` 0.1.0 bundle，预览批次为 `preview.1`。bundle 内 `SHA256SUMS.json` 对 20 个 payload 文件逐项校验；该清单文件的 SHA-256 为 `6bf7b2d1d31fcc2399051f7df75a24e2315d0f27a54b01f280decf207d3725e3`。本说明、运行依赖清单、许可和第三方声明随包提供。

## 支持范围

- 本轮安装链在 Windows 11 x64、DSH 0.2.1-rc.2、Node 24.21.0、Python 3.12.14 上完成了隔离 profile 的安装、配置导出、卸载、重装和再次卸载验证。
- 预览已安装到桌面 DSH；退出并重新打开 DSH 后，真实 `dsh-app://app` 页面中的 Studio iframe 显示了总览。
- 独立 QA Native Host gate 已通过：8 项检查为真，覆盖 9 条路由；没有实质错误。它不等同于真实 Agent 对话验收。
- 独立浏览器测试通过真实 UI Save 按钮写入 SQLite，并在页面刷新及关闭、重开数据库后读回设置。测试使用模拟运行时，不调用模型 API。
- Linux、macOS 和原生 Agent 对话尚未验证。当前桌面未配置模型端点；本预览不会自动复制凭据或开启外发。
- 需要 Node 24 或 DSH 随附的 Node 24、Python 3.12 或更新版本，以及独立安装的 `uv`。不要把依赖装入 DSH 自带的 Python 环境。

## 包含内容

- `bundle/`：经过 checksum 清单验证的插件 bundle，不含 profile、数据库、环境文件、凭据、虚拟环境或模型配置。
- `runtime-requirements.txt`：从仓库锁文件导出的 Hy-Memory SDK 运行依赖；不包含项目本身或测试依赖。
- `LICENSE`、`NOTICE`：项目许可和第三方声明。

## 准备 Python 运行环境

解压候选包到一个固定目录，打开 PowerShell，并在该目录执行：

```powershell
$runtime = Join-Path $env:LOCALAPPDATA 'dsh-hy-memory-preview\python-runtime'
uv venv --python 3.12 $runtime
$python = Join-Path $runtime 'Scripts\python.exe'
uv pip sync --python $python -r .\runtime-requirements.txt
& $python --version
node --version
$env:HYMEM_PYTHON = $python
```

`node --version` 应显示 24.x。`uv pip sync` 使用机器上 uv 当前配置的默认 Python 包索引；本包不附带私有索引、凭据或模型 endpoint。若依赖已在本机缓存中，可由 uv 使用缓存完成同步。

## 选择 DSH 安装路径

如果 DSH 安装位置未被自动发现，显式设置 `DSH_LAUNCHER` 和 `HYMEM_PNPM_DIR`。以下示例适用于当前用户级安装；若 DSH 安装在 `ProgramFiles` 或其他目录，请改成对应的真实路径：

```powershell
$dshRoot = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'
$env:DSH_LAUNCHER = Join-Path $dshRoot 'resources\runtime\cli\bin\dsh.cmd'
$env:HYMEM_PNPM_DIR = Join-Path $dshRoot 'resources\runtime\primary-runtime\dependencies\pnpm\bin'
$node = Join-Path $dshRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node --version
```

先选择一个专用 DSH profile 和一个稳定的数据目录。不要把预览安装到默认 profile，也不要复用包含重要记忆数据的目录进行首次试用：

```powershell
$profile = 'hymem-preview'
$dataDir = Join-Path $env:LOCALAPPDATA 'dsh-hy-memory-preview\data'
```

profile 必须是单个安全名称。确认 `DSH_LAUNCHER` 指向预期的 DSH 安装后，用官方 `web` 模板初始化一个新的自定义 profile：

```powershell
# 仅对全新的 profile 名称执行；--from-default-profile 会替换同名自定义 profile。
& cmd /d /s /c "`"$env:DSH_LAUNCHER`" --profile $profile --from-default-profile web --dump-config"
```

不要对已有 profile 使用这条初始化命令：DSH 的 `--from-default-profile` 会用模板副本替换目标，并清空该 profile 已安装的依赖和用户 patch。

## 预览安装与检查

先执行无写入预览，再安装到选定 profile：

```powershell
& $node .\bundle\cli.js install --profile $profile --data-dir $dataDir --ui-port 48731 --dry-run --json
& $node .\bundle\cli.js install --profile $profile --data-dir $dataDir --ui-port 48731 --json
```

安装器会在调用 DSH 前验证 bundle 和 checksum，并在修改 profile 受管文件前建立快照；失败时尝试回滚这些文件。私有 bundle 副本和记忆数据存放在 `$dataDir` 下。Studio 使用本机回环地址，默认端口为 48731；桌面 DSH 的 Studio iframe 已实际显示总览，独立 Native Host QA gate 也已通过。

设置 `HYMEM_PYTHON` 后，确保后续启动或重启的 DSH Host 进程能继承此变量。若现有 DSH Host 是在不同环境中启动的，仅在 PowerShell 中设置变量不会改变那个已运行进程。

## 卸载与数据保留

卸载会从所选 profile 移除插件引用，不删除记忆数据库或数据目录：

```powershell
& $node .\bundle\cli.js uninstall --profile $profile --data-dir $dataDir --json
```

已验证的隔离卸载保留了数据目录中的 sentinel 文件和 SQLite 行。卸载后，`$dataDir\installed-bundles` 中的私有 bundle 副本仍可能保留；该目录也包含用于本地运行的配置副本。保留数据目录可保留记忆、快照和诊断材料。重新安装会生成新的私有 bundle 副本。

## 验收边界

本地隔离验证覆盖了 DSH profile 引用、私有 bundle 路径、导出的 `dataDir` 与 UI 端口、卸载后的引用移除、数据 sentinel 保留，以及 source bundle 的逐文件校验和。桌面 DSH iframe 和独立 Native Host gate 已验证；这不证明原生 Agent 对话成功，也不代表模型 API 调用通过。不要把本候选包作为正式发行版发布。
