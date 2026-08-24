# 发布流程（RELEASE）

本仓库采用 **tag 驱动的自动发布**：推送 `vX.Y.Z` 格式的 tag，GitHub Actions 自动完成校验与 npm 发布。全程零凭据——发布身份由 npm Trusted Publishing（OIDC）验证，不使用任何长期令牌。

## 发布步骤

```bash
# 1. 本地预检
node scripts/smoke.mjs

# 2. 升版本号（两处必须同步）
echo "0.X.Y" > VERSION
# 同时修改 package.json 的 "version" 字段

# 3. 提交推送
git add -A && git commit -m "release: v0.X.Y <变更摘要>" && git push

# 4. 打 tag 触发流水线
git tag -a v0.X.Y -m "<描述>" && git push origin v0.X.Y
```

推送 tag 后流水线自动执行：

1. **版本一致性校验**——tag、`package.json`、`VERSION` 三者必须一致，不一致直接失败
2. **Smoke 自检**——临时仓库全链路验证
3. **OIDC 发布**——升级 npm ≥11.5 后 `npm publish --access public --provenance`，附供应链溯源签名

进度看仓库 **Actions** 页；绿勾即发布成功，所有接入仓库执行 `reqbank update` 即可拉到新版。

## 版本号规则（semver）

| 变更类型 | 版本动作 | 示例 |
|---|---|---|
| 引擎行为修复 / 新命令 | 次版本 +1 | 0.5.1 → 0.6.0 |
| bug 修复 / 文档 | 修订号 +1 | 0.5.1 → 0.5.2 |
| 真源格式破坏性变更 | 大版本 +1 + README 标迁移说明 | 0.x → 1.0.0 |

## 一次性前置配置（仓库管理员）

发布依赖 npm 侧的 Trusted Publisher 绑定，配置一次即可：

1. 打开包的设置页：`npmjs.com → 包页面 → Settings（Access）`
2. 完成 2FA 验证后，找到 **Trusted Publisher** 区块
3. 选择 **GitHub Actions**，填写：
   - Repository owner: `cirscn`
   - Repository name: `reqbank`
   - Workflow filename: `publish.yml`
4. **Allowed actions 至少勾选 "Allow npm publish"**（必填项；⚠️ 保存后刷新页面复查勾选状态，该表单存在勾选被回滚的情况）
5. 点 **Set up connection** 保存

> 若重命名工作流文件，需同步更新此绑定，否则 CI 发布会报 404/403。

## 手动兜底发布（CI 不可用时）

```bash
npm publish --access public --registry https://registry.npmjs.org/
```

前提：本地 `~/.npmrc` 配置了官方源的有效令牌。若终端打印 `auth/cli` 授权链接，点开 → Authenticate → 完成 2FA 即可；同 IP 二次发布通常直接放行。

## 常见失败对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `PUT ... 404 Not Found` | Trusted Publisher 未绑定 / 绑定信息不匹配 | 按上方一次性配置核对三项值 |
| `403 OIDC permission denied for this action` | 绑定的 Allowed actions 未勾选 "Allow npm publish" | Edit 绑定勾选后保存，**刷新页面复查** |
| `tag != package.json` 校验失败 | 三处版本号不同步 | 统一后重新打 tag |
| 授权会话超时（auth/cli 链接失效） | 浏览器确认超过约 2 分钟 | 重新执行发布命令，链接会重新生成 |
