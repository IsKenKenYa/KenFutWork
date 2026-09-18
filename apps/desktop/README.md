# KenFutWork 桌面壳（Tauri 2）

> 状态（2026-09-18 更新）：**本机已能构建**——Rust（rustup，cargo 1.98.1）+ MSVC（VS 2022 生成工具）
> + **Windows SDK 10.0.26100（装在 `D:\Windows Kits\10`，非默认盘）** + WebView2 运行时 153。
> 实测 `pnpm --filter @kenfutwork/desktop exec tauri build --debug --no-bundle` 通过，产物
> `src-tauri/target/debug/kenfutwork-desktop.exe`。设计依据：`docs/tech/多端产品设计.md` §4
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

## 出 Windows 安装包（NSIS，一键装）

```sh
pnpm package:win                                          # 1) 先出 release/（服务端 exe + web + pg + runtime）
pnpm --filter @kenfutwork/desktop build                   # 2) 出安装包
```

产物：`apps/desktop/src-tauri/target/release/bundle/nsis/KenFutWork_<版本>_x64-setup.exe`（约 72 MB，
压缩自约 300 MB 资源）。安装包做的是原生那套：**可选安装目录**（向导页）、**开始菜单快捷方式**、
**注册表卸载项 + 卸载器**、**中英双语**（默认跟系统，简体优先）。装完点快捷方式即用：壳会拉起随包的
`app/KenFutWork-server.exe`（内嵌 Postgres + 免登录 + 进程内队列），并把窗口指向服务端托管的 UI。

- **静默装/卸（CI 或脚本用）**：`setup.exe /S /currentuser`；卸载
  `"%LOCALAPPDATA%\Programs\KenFutWork\uninstall.exe" /S`
- **`tauri build` 需要 PATH 里有 `cargo`**：rustup 装在 `~/.cargo/bin`，Git Bash 里先
  `export PATH="$HOME/.cargo/bin:$PATH"`，否则报 `failed to run 'cargo metadata' … program not found`
- **为什么窗口指向 `http://127.0.0.1:3001` 而不是加载壳自带的 UI**：本机免登录的可信来源只认回环
  （`server/src/features/auth/local-trust.ts`），壳自带的 `tauri://localhost` 不是回环会被 401/403
- **已知瑕疵**：`src-tauri/src/bin/loomic-test-fake-server.rs`（集成测试夹具）会被一起打进安装目录
  （Tauri 会打包同一 crate 的所有 bin 目标）；无害但属噪音，待清理。

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
