# Codex Remote

通过 ds-harness-remote，在另一台设备的浏览器或 Android 应用中使用已授权主机的 Codex。接收端可以选择主机和项目、查看聊天、发送文字和图片、接收流式回复。Codex 登录保留在主机，接收端只需完成 Remote 设备授权。

## Windows 和 Linux

安装 Node.js（已验证 24.16.0）后，在仓库根目录执行：

```sh
npm ci
npm ci --prefix web/vendor
npm run build
```

Windows 运行 `web\start.cmd`，Linux 运行 `sh web/start.sh`。脚本会打开 Remote 授权页和本机工作台。默认地址为 `http://127.0.0.1:47831/`。从设备列表选择在线主机，之后可在左侧栏顶部点击主机名称，从下拉列表切换设备。浏览器草稿和接收服务的任务记录按设备 ID 隔离。主机需已安装并授权可用的 ds-harness-remote 和 Codex。详细步骤见 [使用说明](web/使用说明.txt)。

## 在平板上查看主机项目

首次安装 Android 应用后，在「打开设备授权」中完成 Remote 授权，再选择该身份可访问的主机。授权保存在这台设备的应用私有数据中。覆盖更新 APK 会保留授权，另一台设备首次安装时需要单独授权。

主机同时提供 Codex 和 Antigravity 时，项目侧栏按最近活动混排两种会话，标题旁标明助手。点会话即可继续工作，点项目右侧的新建按钮可为新会话选择助手。切到另一条会话后，在途回复仍写入原会话，每条会话单独保留草稿。

选择主机和项目后，在新聊天顶部点「切换侧面板」，或在已有聊天顶部点「显示标签页」。右侧栏提供「文件资源管理器」和「侧边聊天」。主聊天开始后可以使用侧边聊天。

文件资源管理器可展开项目目录并预览文件。工具栏的搜索入口支持文件名和主机开发服务地址，例如 `http://localhost:5173/app/`。网页预览要求主机的 ds-harness-remote 已放行对应端口。聊天回复中的项目文件和本地网页链接也可以直接打开。

左侧「账号用量」显示 Codex 与 Antigravity CLI 各模型组的剩余百分比和重置时间。Antigravity 数据来自所选主机的 `agy /usage`，对应主机 Antigravity CLI 登录的账号。原生主机需要更新下方的兼容插件。

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

## 在平板和主机之间交换文件

在主聊天或侧聊打开「＋ → 添加本地文件」，从 Android 系统文件选择器选择文件。支持上传的主机会把原文件保存到当前项目下独立的 `.codex-upload-<编号>` 目录。发送消息时附上主机路径，Codex 可以按该轮的任务权限读取文件。原文件保留在主机项目中，删除平板草稿里的附件不会删除主机副本。每个文件最多 64 MiB。

在文件资源管理器中，点击文件名可预览，点右侧的下载按钮可直接保存到平板。聊天回复中的项目 APK、PDF 或压缩包链接，以及点开的项目图片，也提供「保存文件」。Android 10 及以上直接保存到系统「下载」目录。Android 8、9 首次保存时选择文件夹，之后自动沿用。保存完成后可点「打开文件」。原生主机上的任意格式上传和超过 4 MiB 的下载需要新版的 ds-harness-remote 0.6.8 兼容包，单个下载文件上限为 64 MiB。

## 查看上下文窗口

在设置中开启「显示上下文使用情况」。主机返回用量后，输入框旁会出现一个圆环。点按圆环可查看已用比例和 token 用量。四舍五入后的已用比例低于 50% 时，详情还会显示剩余百分比。该设置默认关闭。

## 在平板上设置目标和任务权限

在主聊天输入框旁点「＋」并选择「目标」，或输入 `/goal` 并点选命令。写下目标后发送。已有目标的聊天会显示目标卡，可以查看、编辑、暂停、继续或清除目标。替换进行中的目标需要确认。主机暂时无法接受目标时，平板会保留草稿。

普通聊天默认沿用主机的权限设置。旧版原生 Codex 插件使用「请求批准」。权限菜单中的「请求批准」由你决定是否允许需要审批的操作。「帮我批准」使用主机的自动审批。「完全访问权限」需要再次确认。通过原生接口连接的主机需要下方的兼容插件才能启用目标和自动审批。旧插件的能力会显示在平板界面上。

### 复查桌面端交互

`npm run test:ui` 会在安装了商店版 Codex 的 Windows 上读取桌面端版本，并与上次核对的版本比较。版本变化时，测试会列出需要重新核对的入口。触摸和键盘测试覆盖斜杠命令、创建及替换目标、模型、推理强度、速度、权限选择，以及主聊天和侧聊运行中的发送和停止。Markdown 样例覆盖含中文引号的加粗、项目文件链接和列表排版。

构建 APK 后可用 `python tests/android_markdown.py emulator-5554 reply.png` 在独立的模拟器 WebView 中渲染样例并保存截图。将设备编号替换为实际模拟器编号，构建环境沿用下方 Android 配置，可通过 `ADB` 指定 adb 可执行文件。测试从 APK 读取工作台资源，使用独立测试应用和模拟会话数据。

## 在原生主机上选择模型速度

打开模型与推理强度菜单。如果模型只提供标准和快速两档，点闪电图标即可在两者之间切换。如果模型还提供超快等档位，点图标会展开速度列表。首次打开时显示当前生效的速度；手动选择后，接收端会记住当前聊天的选择，并在发送时传给主机。

通过 Codex 原生接口连接的主机需要支持 `turn/start.serviceTierForTurn`。原版 ds-harness-remote 0.6.8 能列出模型速度，但其接口会拒绝逐轮指定速度。连接这类主机时，速度菜单会标明只能沿用主机设置。

仓库提供 0.6.8 的主机插件兼容补丁。下列 PowerShell 命令在仓库根目录运行，使用本机已安装的插件生成独立 npm 包。构建需要 Python 3、Git 和 npm。

```powershell
$plugin = Join-Path $env:USERPROFILE '.dsh/profiles/desktop/node_modules/ds-harness-remote'
python scripts/host-compat/package_plugin.py $plugin dist/ds-harness-remote-0.6.8-codex-agy.tgz
```

构建脚本只在临时副本中应用补丁。要让 Windows 主机使用兼容包，等主机当前任务结束后完全退出 DeepSeek Harness，再通过其自带的 `dsh.cmd` 安装到 `desktop` 配置。安装完成后重新打开 DeepSeek Harness。

```powershell
$dsh = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
$package = (Resolve-Path 'dist/ds-harness-remote-0.6.8-codex-agy.tgz').Path
& $dsh plugin --profile desktop add -w $package
```

此前的速度兼容包已安装到隔离的 `web` 配置，并通过本机 Codex App Server 分别完成 Fast 和 Ultrafast 会话。上述兼容包含沿用主机权限和读取 Antigravity 用量所需的更新。

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

Windows 接收端在独立进程中使用 SDK 的 `forceRelay` 连接 tim-SER。首次连接及关闭连接再打开后，`/api/connection` 均报告 `Relay` 且主机 App Server 已响应，`/api/thread-activity` 均读到了测试聊天最近一轮的完成状态。

Android 14 模拟器已验证返回前台、进程重开、切网后的恢复，以及后台连接通知的开启与停止。使用模拟主机链路验证了草稿恢复、侧面板加载网页、相对资源和 WebSocket、关闭预览释放连接，以及在 WebView 113 上触摸选择速度档位。Android 11 模拟器的 WebView 83 已验证选机、进入聊天、模拟收发和返回前台恢复。

Android 14 模拟器连接真实主机 tim-SER 时，在后台开启飞行模式，确认 Android 已失去默认网络。先恢复网络再返回 App，以及先返回 App 再恢复网络，两种顺序都能在第一次返回后通过「连接信息 → 重新检查」读到主机的当前会话状态。第二种顺序下，离线提示在网络恢复后自行消失。SDK 在这两次检查中均报告局域网直连。

同一台模拟器还验证了离线冷启动。在飞行模式下确认 Android 没有默认网络，强制停止 App，再启动一次。恢复网络后，从「设置 → 连接信息」读到 tim-SER 的 Codex App Server 已响应、当前会话空闲、最近轮次已完成。此次检查走局域网直连。

在 tim-SER 的测试聊天中打开侧边聊天一次，主机新增一条分支记录，子会话 ID 与主会话不同。在线强制停止并重新打开 App 后，原主聊天和侧聊标签均已恢复，主机分支记录数量保持不变。两次冷启动检查均未发送模型消息。

在 Android 14 模拟器上，仅对接收端 App 临时阻断到 tim-SER 内网 IPv4 地址的访问，再强制停止并冷启动 App。第一次打开即恢复原聊天，「连接信息」显示 TURN 中继、主机 Codex App Server 已响应，当前会话空闲、最近轮次已完成。测试结束后已移除模拟器的网络规则。该测试覆盖真实主机的中继链路，OPPO 平板在不同网络间切换仍待真机验证。

同一台模拟器在 1200 × 1600 竖屏及旋转后的横屏下，收起侧栏均可看到新建聊天、设置和主机按钮。竖屏下已从新建按钮打开空白聊天，也已从左下角的 TS 按钮打开授权主机列表，再返回原聊天。

### OPPO 平板真机

OPPO 平板真机已验证跨网主机的消息收发、流式回复、远程项目选择、工作树文件读取，以及切换主机后的草稿与在途回复隔离。

在 OPPO 平板（OPD2515）上覆盖安装新版后，从最近任务划掉 App，确认主进程退出。第一次重开恢复了 tim-SER 的原聊天。「连接信息」显示 TURN 中继、主机 Codex App Server 已响应、当前会话空闲。

从安卓桌面返回仍在后台的 App，两次启动均复用了同一个聊天界面实例，输入框保留草稿和光标。另一次测试中，先断网再返回聊天，在平板离线期间更改 tim-SER 测试会话的标题。恢复原 Wi-Fi 后，侧栏自动显示新标题，当前聊天保持可见，App 进程未重启。测试后已还原标题。

在 tim-SER 的 `codex-tps-panel` 项目中，冷启动后首次打开模型选择器即看到主机目录中的 10 个模型。选择标准速度并留下新聊天草稿，再强制停止并启动一次，首次发送即收到预期回复。文件资源管理器打开该项目的 `README.md` 后冷启动，也能恢复文件标签和正文。

在同一台平板上，从聊天菜单新建侧边聊天，确认软键盘弹出。输入草稿后收起工作区，再通过聊天标题栏的面板按钮展开，草稿保留。在主聊天显式选择标准速度后，新建另一个侧聊并发送一条测试消息。看到首段且轮次仍在运行时，将 App 切入后台并开启飞行模式。确认默认网络消失后强制停止 App，关闭飞行模式并只启动一次。原侧聊先恢复首段和运行状态，随后收到最终回复，页面上各有一条测试提问和最终回复。收起工作区后回到原主聊天。

OPPO 横屏实测，侧聊输入七行草稿时输入框由 120 个物理像素增高到 387 个，清空后恢复到 120 个。主聊天输入框高度保持不变。

竖屏打开软键盘后，侧聊输入框、附件入口和发送按钮均可见。实测添加平板文本文件和 tim-SER 项目文件，两种附件都只出现在对应侧聊。保留本地附件和侧聊文字后强制停止 App，冷启动一次即恢复两者。侧聊中复制的最终回复粘贴后与原文一致。

在平板上关闭一条已有回复的侧聊后，tim-SER 的分支仍在会话索引中。通过「搜索聊天」输入测试问题里的关键词，能重新打开该分支，读到父聊天上下文、侧聊问题和最终回复。

OPPO 横屏收起左栏后，可在当前项目新建聊天、打开设置，或点左下角的 TS 查看授权主机。重新展开左栏可选回原会话。打开「账号用量」并手动刷新后，tim-SER 返回的七天剩余额度以进度条显示，旁边列出重置时间。

真实主机网页预览已暂缓验收。模拟主机已验证网页、相对资源和 WebSocket。

豆包小语音面板直连仍待单独验证。
