# KenFutWork 桌面壳（Tauri 2）

> 状态（2026-09-18 更新）：**本机已能构建**——Rust（rustup，cargo 1.98.1）+ MSVC（VS 2022 生成工具）
> + **Windows SDK 10.0.26100（装在 `D:\Windows Kits\10`，非默认盘）** + WebView2 运行时 153。
> 实测 `pnpm --filter @kenfutwork/desktop exec tauri build --debug --no-bundle` 通过，产物
> `src-tauri/target/debug/kenfutwork-desktop.exe`。设计依据：`docs/方案设计/多端产品设计.md` §4
> （Tauri 2 + 系统 WebView + 服务端 sidecar，拒 Electron）。

## 构建前置（逐项自查，2026-09-18 实测）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| MSVC（C++ 桌面开发） | ✅ VS 2022 生成工具 17.14.37628.2 | `link.exe` 在 `BuildTools/VC/Tools/MSVC/…/bin/Hostx64/x64` |
| Windows SDK | ✅ 10.0.26100，装在 **`D:\Windows Kits\10`** | 装在非默认盘也算数：链接器按注册表 `InstallationFolder` 找它 |
| WebView2 运行时 | ✅ 153.0.4234.32 | Win10 1803+ 自带；LTSC/精简版需另行安装 |
| Rust 工具链 | ✅ rustup + `stable-x86_64-pc-windows-msvc` | **新装的 rustup 只对新终端生效**：老 shell 里要给 PATH 加 `~/.cargo/bin`（Git Bash 用 `/c/Users/<你>/.cargo/bin`） |
| Tauri CLI | ✅ `@tauri-apps/cli ^2`（本包 devDependency） | `pnpm install` 即得；也可 `cargo install tauri-cli --version "^2" --locked` |

**构建两步**（缺一不可——Rust 侧要把 web 静态产物嵌进去）：

```sh
pnpm --filter @kenfutwork/web build                       # 产出 apps/web/out（静态导出）
pnpm --filter @kenfutwork/desktop exec tauri build        # 出安装包；加 --debug --no-bundle 只出 exe
```

> 踩过的坑：`tauri.conf.json` 的 `frontendDist` 是**相对 `src-tauri/`** 解析的——原来写
> `../web/out` 会指到 `apps/desktop/web/out`（永远找不到），已改成 `../../web/out`。
> 同理 `bundle.resources` 里引 `release/` 要写**三级** `../../../release/...`
> （src-tauri → apps/desktop → apps → 仓库根；少一级会报「resource path 不存在」）。

## 出 macOS DMG（Apple Silicon，自包含 .app）

```sh
pnpm fetch:runtimes                                       # 1) 拉随包运行时（darwin-arm64 资产，sha256 校验）
pnpm package:mac                                          # 2) 出 release/（server.cjs + web + pg + runtime + node_modules）
pnpm --filter @kenfutwork/desktop build                   # 3) tauri 出 .app → bundle_dmg.sh 摆布局 → DMG 收到仓库根
```

产物：仓库根 `KenFutWork_0.1.0_arm64.dmg`（约 285 MB；.app 818 MB 自包含：服务端 CJS + 内嵌
Postgres + 随包 Node/Python/uv/JRE，用户机器无需预装）。**安装引导**：Docker 式拖拽布局——
品牌背景（标题/箭头/中文提示，源文件 `src-tauri/dmg/background.svg` 经 sharp 渲染）+ 左 .app
右 Applications，由 `scripts/dmg/bundle_dmg.sh`（tauri 的 create-dmg 分叉，AppleScript 真实
设置窗口 bounds 与图标坐标）生成；无头环境 AppleScript 受限时自动降级 appdmg → hdiutil。

**形态要点（2026-09-23 落地）**：
- **不做 Node SEA 单文件**：darwin 27 上 postject 注入后必崩（SIGSEGV，node 22/24 双载体 +
  remove-signature 官方流程均复现）。改为「随包官方静态 node（runtime/node/bin/node）+
  esbuild CJS（`server/server.cjs`，`KFW_PACKAGED_CJS` define 定位资源根）」——node 二进制
  零修改、签名天然有效，壳的 mac 分支按 `node server/server.cjs` 拉起（lib.rs）。
- **签名**：默认 ad-hoc（临时签名）。本机双击可用；**拷给别的 mac** 首开被 Gatekeeper 拦，
  右键 → 打开，或 `xattr -cr /Applications/KenFutWork.app`。对外分发需 Developer ID + 公证。
- **数据目录**：`~/Library/Application Support/com.kenfutwork.desktop/`（与 dev 态同目录，
  首启直接复用已有数据）；检查点与沙箱由壳注入到该目录（.app 包内只读且受签名保护，不可写）。
- **PG 软链**：darwin 包的 `pg-symlinks.json` 由 `package-mac.mjs` 复刻（libicudata 前车之鉴）；
  pgmq shim 预装进 `pg/share/postgresql/extension`（darwin 是 PG 标准 share 布局，win 才平铺）。

## 出 Windows 安装包（NSIS，一键装）

```sh
pnpm package:win                                          # 1) 先出 release/（服务端 exe + web + pg + runtime）
pnpm --filter @kenfutwork/desktop build                   # 2) 出安装包
```

产物：**仓库根目录** `KenFutWork_<版本>_x64-setup.exe`（约 69 MB，压缩自约 300 MB 资源）——
`tauri build` 之后由 `scripts/collect-bundle.mjs` 自动收过去（根目录只留最新一份）；原始产物仍在
`apps/desktop/src-tauri/target/release/bundle/nsis/` 下（发布流水线要它就在那）。安装包做的是原生那套向导：**选安装模式**（所有用户 / 仅我）→
**选安装目录** → **开始菜单目录** → 安装 → 完成页（勾选创建桌面快捷方式、直接启动），
另写**注册表卸载项 + 卸载器**、**环境变量**（见下）、**中英双语**（默认跟系统，简体优先）。
装完点快捷方式即用：壳拉起随包的 `app/KenFutWork-server.exe`（内嵌 Postgres + 免登录 + 进程内队列），
并把窗口指向**服务端托管的 UI**。

- **环境变量与注册表**（`src-tauri/installer-hooks.nsh`，走 Tauri 的 `installerHooks` 缝）：
  装完写 `KENFUTWORK_HOME=<安装目录>`、把安装目录挂到 PATH（命令行可直接敲 `kenfutwork-desktop`），
  并广播 `WM_SETTINGCHANGE`；`HKCU|HKLM\Software\KenFutWork` 另记 `InstallDir`/`Version`。
  **卸载时逐项撤掉**（PATH 只删自己那一段），再广播一次；按安装模式自动选 HKCU / HKLM 的 `Environment`。
- **图标**：`node scripts/icons.mjs`（在 `apps/desktop` 下跑）从品牌 logo 唯一权威源
  `docs/视觉设计/logo/新版.png` 生成 `src-tauri/icons/`（多尺寸 `icon.ico` 16→256 + `icon.png`）。
  exe 资源图标、安装包图标、开始菜单与任务栏图标都吃这一份，换标只需重跑这条命令。
- **窗口指向 `http://127.0.0.1:<端口>` 而不是加载壳自带的 UI**：本机免登录的可信来源只认回环
  （`server/src/features/auth/local-trust.ts`），而且壳自带的 `tauri://localhost` 的资源协议
  **解析不了 `/canvas` 这种无扩展名路由**（服务端托管那份走 `canvas.html` 回退，见
  `server/src/http/static-web.ts`）——Design 模式的画布 iframe 正好是 `/canvas?id=…`，
  在壳自带 UI 上**画布必然空白**（2026-09-17 用户报的「design 模式改坏了」就是这个）。
- **端口不是死守 3001**：壳按 `3001…3010` 找「探活 200 **且首页是 HTML**」的服务端；撞上别人的服务
  （例如你自己跑的 dev API：探活 200 但 `/` 是 404 JSON）就换下一个端口，都不行才在窗口里如实报错。
  换端口能成立的前提是前端按**同源**解析 API base（`apps/web/src/lib/env.ts`）。
- **静默装/卸（CI 或脚本用）**：`setup.exe /S /currentuser`；卸载
  `"%LOCALAPPDATA%\Programs\KenFutWork\uninstall.exe" /S`
- **`tauri build` 需要 PATH 里有 `cargo`**：rustup 装在 `~/.cargo/bin`，Git Bash 里先
  `export PATH="$HOME/.cargo/bin:$PATH"`，否则报 `failed to run 'cargo metadata' … program not found`
- **安装目录里不该有测试夹具**：`src/bin/loomic-test-fake-server.rs` 是生命周期测试的子进程替身，
  挂在 `test-fixture` feature 下（`pnpm --filter @kenfutwork/desktop test` 自动带上），
  默认构建不编，于是不会被打进安装包。

## 形态与职责

- **Rust 层保持薄**：窗口/托盘/自更新/深链/系统对话框归这里；**业务一律在服务端**
  （同一份 `apps/server` 代码）——保证桌面与自托管行为一致。
- `tauri.conf.json`：dev 态 `devUrl` 指向 web dev server（`localhost:3000`）；
  打包态 `frontendDist` 用 web 静态导出（`apps/web/out`）。
- **服务端 sidecar 是下一步**（见「路线」）：把 `apps/server` 打成单文件可执行
  （Node SEA / `bun build --compile`），随 Tauri 资源分发，桌面数据落本地数据目录。

## 本机运行

前置（一次性）：Rust 工具链（本机已装在**外置盘** `DevTools/rust/`，`~/.zshenv` 已配好，
任何终端直接可用）+ tauri-cli：

```sh
pnpm install   # 本包已把 @tauri-apps/cli 列为 devDependency（等价：cargo install tauri-cli --version "^2" --locked）
```

**一键桌面形态**（推荐——自动拉起服务端内嵌 PG + web + Tauri 窗口，已在跑的自动复用，
退出时回收自己拉起的进程）：

```sh
pnpm desktop          # 仓库根执行；等价于 bash apps/desktop/dev.sh
```

手动分步（需要单独验证某一层时）：

```sh
pnpm --filter @kenfutwork/server dev:server   # 桌面形态：KENFUTWORK_EMBEDDED_PG=1 …（见仓库根 .env.local 样例）
pnpm --filter @kenfutwork/web dev             # web UI（3000）
cd apps/desktop/src-tauri && cargo tauri dev
```

## macOS 系统权限与行为对齐（2026-09-20 盘点）

壳的内核是 WKWebView，与浏览器/WebView2 行为有差异；「系统 API」逐项对齐如下。

| 能力 | 现状 | 机制 / 权限 |
| --- | --- | --- |
| 系统文件夹对话框（选工作目录） | ✅ 可用 | 服务端 `osascript choose folder`（NSOpenPanel，无需特殊权限）。曾经的「Request failed」是前端 POST 带空 JSON 体被 Fastify 400，已修（`pickDirectory` 带 `{}`） |
| 文件夹访问（TCC） | ✅ 系统自动弹窗 | agent 读用户选定目录时，若落在 `~/Desktop` / `~/Documents` / `~/Downloads`，macOS 首次访问会弹授权框（责任进程为 KenFutWork 壳），允许一次后不再问 |
| 下载（图片/视频/画布/插件导出） | ✅ 已对齐 | 统一走 `triggerDownload`（`lib/download.ts`）→ Rust `save_file` 落系统下载目录（重名顺延）→ `reveal_path` 在访达中定位。首次写 `~/Downloads` 可能弹一次 TCC 授权 |
| 打开访达窗口 | ✅ 已对齐 | 即下载完成后的 `reveal_path`（macOS `open -R`）；外链类「打开」见下行 |
| 外部链接（target=_blank） | ✅ 已对齐 | WKWebView 开不了新窗口：工作台挂 `installDesktopExternalLinks`（捕获阶段拦截）→ Rust `open_external` 交给系统默认浏览器（只放行 http/https） |
| 麦克风 / 摄像头 | 未使用 | 全仓无 `getUserMedia` 调用；未来加语音输入需 `NSMicrophoneUsageDescription` + WKWebView 媒体权限，到时再登记 |
| Apple Events 自动化 | 未使用 | `osascript` 只弹 NSOpenPanel，不控制其他 App，不触发「控制 Finder」授权 |

**IPC 能力面**：主窗口最终加载的是本机服务端托管的 UI（回环 http），Tauri 默认不给远程页面任何
IPC——`capabilities/loopback-remote.json` 只对 `main` 窗口放行 `http://localhost:*` /
`http://127.0.0.1:*`（都是我们自己的服务端）；子 webview（browser-embed）刻意不在列，嵌进来的
外部站点拿不到任何壳命令。

## 路线（对齐《多端产品设计》D1–D3）

1. **本壳可开**（当前提交）：窗口加载 web dev server。
2. **sidecar**：Node SEA 打包 `apps/server` → Tauri `externalBin`；Rust 侧管理生命周期
   （启动/健康探活/退出停库——`desktop/runtime.ts` 的 `shutdown()` 已就位）。
3. **本地数据目录**：`KENFUTWORK_DATA_DIR` 指向用户数据目录（Rust `app_data_dir` 注入）；
   内嵌 Postgres + 同源迁移已在服务端跑通（46 条迁移全过）。
4. 之后才是托盘/自更新/深链与 Windows 打包（NSIS）。

## 已知限制

- 本脚手架未经 `cargo build` 验证（本机无 Rust）；首次构建需下载 crates 并编译数分钟。
- `frontendDist` 指向的 `apps/web/out` 需要 `apps/web` 以静态导出构建（现有配置已支持）。
- 前端「供应商设置」等 API 调用依赖 `NEXT_PUBLIC_SERVER_BASE_URL` 指向 sidecar 回环端口
  （桌面形态的接线点，随 sidecar 一起做）。
