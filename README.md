# Codex Remote

通过 ds-harness-remote，在另一台设备的浏览器或 Android 应用中使用已授权主机的 Codex。接收端可以选择主机和项目、查看聊天、发送文字和图片、接收流式回复。Codex 登录保留在主机，接收端只需完成 Remote 设备授权。

## Windows 和 Linux

安装 Node.js（已验证 24.16.0）后，在仓库根目录执行：

```sh
npm ci --prefix web/vendor
```

Windows 运行 `web\start.cmd`，Linux 运行 `sh web/start.sh`。脚本会打开 Remote 授权页和本机工作台。默认地址为 `http://127.0.0.1:47831/`。从设备列表选择在线主机，之后可在连接信息里切换设备。浏览器草稿和接收服务的任务记录按设备 ID 隔离。主机需已安装并授权可用的 ds-harness-remote 和 Codex。详细步骤见 [使用说明](web/使用说明.txt)。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `web/` | 浏览器工作台、Node 接收服务、Remote 连接适配与主机辅助脚本 |
| `web/vendor/` | 当前适配的 ds-harness-remote SDK 快照、上游许可及 npm 锁文件 |
| `android/` | WebView、原生输入和生命周期处理、嵌入式 Node 入口、JNI 与测试包构建脚本 |
| `scripts/` | Web 分发包的文件清单和构建入口 |
| `tests/` | Android 包内容、授权交接、回环监听与路由访问测试 |

## 构建 Web 包

安装 Web 依赖后，在根目录运行 `python scripts/package_web.py`。产物为 `dist/Codex-Remote-Web.zip`。打包脚本按清单收集源码及锁定的运行依赖。SDK 对应的上游项目为 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)，许可见 [DSH-LICENSE](web/vendor/DSH-LICENSE)。

## 构建 Android 测试包

当前打包脚本使用 Windows。先构建 Web 包，然后准备 Python 3、Node、JDK 17、Android SDK Platform 35、Build Tools 35、NDK r24 和解压后的 Node.js Mobile Android 18.20.4。设置以下环境变量。

| 环境变量 | 指向 |
| --- | --- |
| `JAVA_HOME` | JDK 根目录 |
| `ANDROID_BUILD_TOOLS` | 含 aapt2、d8、zipalign、apksigner 的目录 |
| `ANDROID_PLATFORM_JAR` | Platform 35 的 android.jar 文件 |
| `ANDROID_NDK_HOME` | Windows 版 NDK r24 根目录 |
| `NODE_MOBILE_ANDROID` | 含 bin/arm64-v8a/libnode.so 和 bin/x86_64/libnode.so 的目录 |

首次构建会在 android/build/local-test.jks 创建测试签名。要覆盖安装先前交付的测试版，可通过 CODEX_REMOTE_TEST_KEYSTORE 指向原构建脚本生成的测试密钥文件。保留该文件在本机。

```sh
npm ci --prefix android
python android/build_native.py
python android/build.py
python tests/android_package.py
```

产物为 `dist/Codex-Remote-Android-test.apk`，支持 arm64-v8a 和 x86_64。首次构建在本机生成测试签名。可设置 `TEST_NODE` 为 Node 18 可执行文件路径来运行包测试。

## 验证范围

Windows 接收端已在两台授权主机上分别收发并切回原聊天，也已验证图片压缩后的双图识别。Linux 接收端在 WSL2 用双设备夹具验证切换。Android 已做模拟器交互和测试包检查。实体平板、豆包小语音面板直连、完整桌面交互一致性仍待验证。
