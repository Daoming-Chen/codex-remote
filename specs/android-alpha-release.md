# Android Alpha 发布规则

GitHub 只保留一个 Android Alpha 预发布。日常开发和测试使用本地构建，需要分发时再更新现有发布。

- 复用 [Alpha 发布页](https://github.com/Daoming-Chen/codex-remote/releases/tag/v0.1.0-alpha.4) 和标签 `v0.1.0-alpha.4`，保持 GitHub 的 Pre-release 标记。
- 每次发布前递增 Android 的 `versionCode`，沿用现有应用包名和签名证书，确保已安装的平板可以覆盖升级。
- 验证新 APK 后，将其命名为 `Codex-Remote-Android-alpha.4.apk`。在仓库根目录运行以下命令，替换发布页上的同名附件。

  ```powershell
  gh release upload v0.1.0-alpha.4 dist/Codex-Remote-Android-alpha.4.apk --clobber
  ```

- 更新发布说明，记录本次更新日期、`versionCode` 和主要改动。通过[固定下载链接](https://github.com/Daoming-Chen/codex-remote/releases/download/v0.1.0-alpha.4/Codex-Remote-Android-alpha.4.apk)重新下载 APK，核对 SHA-256 与本地构建一致。
