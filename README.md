# Codex Remote

通过 ds-harness-remote，在另一台设备的浏览器或 Android 应用中使用已授权主机的 Codex。接收端可以选择主机和项目、查看聊天、发送文字和图片、接收流式回复。Codex 登录保留在主机，接收端只需完成 Remote 设备授权。

## Windows 和 Linux

安装 Node.js（已验证 24.16.0）后，在仓库根目录执行：

```sh
npm ci
npm ci --prefix web/vendor
npm run build
```

Windows 运行 `web\start.cmd`，Linux 运行 `sh web/start.sh`。脚本会打开 Remote 授权页和本机工作台。默认地址为 `http://127.0.0.1:47831/`。从设备列表选择在线主机，之后可点击最左下角的主机缩写切换设备。浏览器草稿和接收服务的任务记录按设备 ID 隔离。主机需已安装并授权可用的 ds-harness-remote 和 Codex。详细步骤见 [使用说明](web/使用说明.txt)。

## 在平板上查看主机项目

选择主机和项目后，在新聊天顶部点「切换侧面板」，或在已有聊天顶部点「显示标签页」。在「新标签页」的「搜索文件或输入 URL」中输入文件名或开发服务地址即可打开结果。点面板里的加号还可以选择以下工具。

- 选择「文件资源管理器」可以展开项目目录、读取工作树中的文本文件。点击回复中的项目文件链接可定位到相应文件和行。
- 选择「浏览器」可以打开主机上的开发服务。先在主机的 ds-harness-remote 设置中允许服务端口，再选择该端口或输入带路径的地址，例如 `http://localhost:5173/app/`。这里的 `localhost` 指所选主机。聊天回复中的本地网页链接也可以直接打开预览。

Android 返回前台或切换网络时会检查所选主机的连接。工作台显示「正在等待」时会自动重试，也可以点「立即重试」。恢复后，工作台按原任务标识继续接收回复。

Android 选定主机后默认开启「后台保持连接」，通过系统前台服务检查并恢复连接。可在「当前连接」中关闭，也可以在允许通知后从系统通知中停止。升级时保留此前手动设置的开关状态。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `apps/workbench/src/` | TypeScript 工作台、Preact 设备选择页、首页标题与附件栏 |
| `apps/receiver/src/` | Node 接收服务与 Remote 传输适配 |
| `apps/workbench/public/` | 工作台 HTML、样式、图标及安装清单 |
| `apps/host/` | 在 Codex 主机运行的 Python 辅助脚本 |
| `packages/protocol/` | 设备目录的共享类型与校验 |
| `web/` | Web 接收端运行目录，构建时生成脚本并复制静态资源 |
| `web/vendor/` | 当前适配的 ds-harness-remote SDK 快照、上游许可及 npm 锁文件 |
| `android/` | WebView、原生输入和生命周期处理、嵌入式 Node 入口、JNI 与测试包构建脚本 |
| `scripts/` | Web 分发包的文件清单和构建入口 |
| `tests/` | Android 包内容、授权交接、回环监听与路由访问测试 |

### 开发与验证

修改 `apps/`、`packages/` 或 `android/src/` 中的源码后运行 `npm run build`。构建使用 TypeScript、esbuild 和 Preact，将页面依赖打进本地资源，运行时无需前端 CDN。设备选择页、首页标题、模型命令搜索框、推理强度滑块、速度菜单和附件栏由 Preact 渲染。聊天流式更新、模型菜单和语音流程仍保留命令式实现。

`npm run typecheck` 严格检查组件、设备协议与目录服务、Markdown 适配、听写控制器、录音处理器、离线恢复页、构建脚本和浏览器测试。esbuild 将工作台浏览器脚本编译为 Chromium 83 支持的语法。Android 11 模拟器的 WebView 83 已使用模拟主机验证选择设备、打开聊天、收发消息和回到前台后重新连接。运行 `npm run test:ui` 可在 Edge 中验证同名设备选择、图片预览、草稿恢复，以及流式回复期间切换设备再返回的行为；其他 Chromium 安装可用 `CHROMIUM_PATH` 指定可执行文件。

## 在原生主机上选择模型速度

在模型与推理强度菜单里点闪电图标，选择当前模型提供的 Fast 或 Ultrafast。接收端会记住当前聊天的选择，并在每次发送时传给主机。「标准」使用标准速度，「沿用主机设置」使用主机上的会话配置。

通过 Codex 原生接口连接的主机需要支持 `turn/start.serviceTierForTurn`。原版 ds-harness-remote 0.6.8 能列出模型速度，但其接口会拒绝逐轮指定速度。连接这类主机时，速度菜单会标明只能沿用主机设置。

仓库提供 0.6.8 的主机插件兼容补丁。下列 PowerShell 命令在仓库根目录运行，使用本机已安装的插件生成独立 npm 包。构建需要 Python 3、Git 和 npm。

```powershell
$plugin = Join-Path $env:USERPROFILE '.dsh/profiles/desktop/node_modules/ds-harness-remote'
python scripts/host-compat/package_plugin.py $plugin dist/ds-harness-remote-0.6.8-codex-speed.tgz
```

构建脚本只在临时副本中应用补丁。要让 Windows 主机使用兼容包，等主机当前任务结束后完全退出 DeepSeek Harness，再通过其自带的 `dsh.cmd` 安装到 `desktop` 配置。安装完成后重新打开 DeepSeek Harness。

```powershell
$dsh = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
$package = (Resolve-Path 'dist/ds-harness-remote-0.6.8-codex-speed.tgz').Path
& $dsh plugin --profile desktop add -w $package
```

已用本机 `dsh.cmd` 将生成的 tarball 安装到隔离的 `web` 配置，并核对安装后的插件入口与通过实测的副本一致。该副本已连接本机 Codex App Server，使用 GPT-6.2 Sol 以 Fast 和 Ultrafast 各完成一轮。运行中主机的插件替换和重启尚未实测。

## 构建 Web 包

安装依赖后，在根目录运行 `npm run package:web`。产物为 `dist/Codex-Remote-Web.zip`。打包脚本按清单收集源码及锁定的运行依赖。SDK 对应的上游项目为 [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)，许可见 [DSH-LICENSE](web/vendor/DSH-LICENSE)。

## 构建 Android 测试包

支持 Windows 和 x86_64 Linux。先构建 Web 包，然后准备 Python 3、Node、JDK 17、Android SDK Platform 35、Build Tools 35、NDK r24 和解压后的 Node.js Mobile Android 18.20.4。设置以下环境变量。

| 环境变量 | 指向 |
| --- | --- |
| `JAVA_HOME` | JDK 根目录 |
| `ANDROID_BUILD_TOOLS` | 含 aapt2、d8、zipalign、apksigner 的目录 |
| `ANDROID_PLATFORM_JAR` | Platform 35 的 android.jar 文件 |
| `ANDROID_NDK_HOME` | 与构建机器系统匹配的 NDK r24 根目录 |
| `NODE_MOBILE_ANDROID` | 含 bin/arm64-v8a/libnode.so 和 bin/x86_64/libnode.so 的目录 |

下列命令使用 Linux 的 `python3`。Windows 可用 `python`。首次构建会在 android/build/local-test.jks 创建测试签名。要覆盖安装先前交付的测试版，可通过 CODEX_REMOTE_TEST_KEYSTORE 指向原构建脚本生成的测试密钥文件。保留该文件在本机。

```sh
npm ci --prefix android
npm run build
python3 scripts/package_web.py
python3 android/build_native.py
python3 android/build.py
python3 tests/android_package.py
```

产物为 `dist/Codex-Remote-Android-test.apk`，支持 arm64-v8a 和 x86_64。首次构建在本机生成测试签名。可设置 `TEST_NODE` 为 Node 18 可执行文件路径来运行包测试。

## 验证范围

Windows 接收端已在两台授权主机上分别收发、切回原聊天并探测连接。从 Windows 原生主机展开项目目录后，读取的工作树文本与本机文件一致。Linux 接收端在 WSL2 用双设备夹具验证了切换。

Android 14 模拟器已验证返回前台、进程重开、切网后的恢复，以及后台连接通知的开启与停止。使用模拟主机链路验证了草稿恢复、侧面板加载网页、相对资源和 WebSocket、关闭预览释放连接，以及在 WebView 113 上触摸选择速度档位。Android 11 模拟器的 WebView 83 已验证选机、进入聊天、模拟收发和返回前台恢复。

OPPO 平板真机已验证跨网主机的消息收发、流式回复、远程项目选择、工作树文件读取，以及切换主机后的草稿与在途回复隔离。划掉最近任务后，系统可能冻结进程，重新打开时仍可能触发 Remote 握手。真实主机网页到平板的预览、豆包小语音面板直连及完整桌面交互一致性仍待验证。
