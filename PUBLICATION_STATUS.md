# Public snapshot status

**Status: Windows PREVIEW accepted for the stated scope; not GA.** This is a source-only snapshot with no prior Git history. It describes the 0.1.0 bundle and the `preview.1` batch.

The Windows preview checks passed: isolated install/uninstall/reinstall preserved the synthetic data sentinel; the independent Native Host gate passed 8 checks across 9 routes; and the actual desktop DSH Studio iframe rendered its overview after DSH was reopened. The desktop-auth browser test used the real UI and GovernanceStore SQLite with a mocked engine; its Save operation persisted across reload and store reopen. The final mock E2E passed 65 checks, and the TypeScript suite passed 260/260.

The desktop's model endpoint is not configured. The preview did not copy credentials or enable external model traffic. No real model API call was made for these final checks.

Linux, macOS, a native Agent turn, and live DSH multi-agent acceptance remain **NOT_RUN**. The acceptance boundary and evidence are described in [the remediation report](docs/REMEDIATION_REPORT.md) and [the Windows preview guide](docs/RELEASE_PREVIEW.zh-CN.md).

The exported snapshot excludes Git history, local screenshots, environment files, databases, private profile data, and workstation-specific paths. Synthetic secret-shaped test fixtures remain test data. The final QA-owned Host tests are included; local run logs and private desktop verification records are not.
