# Main branch protection

GitHub repository rulesets are configured in the repository settings, not from a committed file. Use this checklist for the `main` branch.

1. Open `Settings` -> `Rules` -> `Rulesets`.
2. Create or edit a branch ruleset named `Protect main branch`.
3. Set `Enforcement status` to `Active`.
4. Under `Target branches`, add `Include default branch` or `Include by pattern` with `main`.
5. Enable `Require a pull request before merging`.
6. Require at least 1 approval.
7. Enable `Dismiss stale pull request approvals when new commits are pushed`.
8. Enable `Require status checks to pass` and select the stable checks from CI.
9. Enable `Require conversation resolution before merging`.
10. Block force pushes and branch deletion.

Recommended required checks:

- `前端构建与检查`
- `后端构建与测试`
- `CodeQL 分析 (javascript-typescript)`
- `CodeQL 分析 (go)`
- `Go 官方漏洞检查`

Enable Dependabot auto-merge only after this ruleset is active and the required checks are consistently green.
