# CI/CD 与发版方案

> 角色：GitHub Actions 的分工口径、双平台出包的可复现前提、签名/公密的**分档**清单，以及未签名包怎么交付。
> 权威边界：产品形态与阶段仍以《多端产品设计》为准，服务端架构以《改造计划》为准；本稿只管「怎么把包自动化打出来、怎么发」。
> 实施回执与未完成项记《日志》对应轮次。

## 一、为什么现在能做

| 事实 | 出处 |
| --- | --- |
| 打包链**不能交叉编译**：mac 只认 darwin/arm64，win 只认 win32，运行时下载也没有 `--platform` | `scripts/package-mac.mjs:135`、`scripts/package-win.mjs:79`、`scripts/fetch-runtimes.mjs` 的 `darwin-x64: null` |
| 两条管线**有意不抽公共库**（分属两台打包机、两人维护） | `scripts/package-mac.mjs:12-19` |
| 仓库已转公开 → 标准 runner 分钟不计费；安装包体积（DMG ~285MB / setup.exe ~69MB）适合走 Actions 产物与 Release 资产 | GitHub 计费文档；`apps/desktop/README.md:39,64` |
| 体积预算实测：`node_modules` 1.8G + `target/release` 3.1G + `release/` 0.7G + `runtime/` 0.44G ≈ 6.0G | `du -sh` 实测，托管 runner 14GB 盘 / 7GB 内存 |

结论：**双平台出包可以全跑在托管 runner 上**，不需要自建机器；代价是每个出包 job 必须分步清理（见 `build-debug.yml` 的「清中间产物」一步）。这推翻了私有仓库时期「必须 self-hosted」的判断——那时真正的瓶颈是分钟与存储配额，不是硬件。

## 二、工作流分工

| 文件 | 触发 | 干什么 | 不干什么 |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | PR / push 到 `main`、`啃啃在开发` | 根门禁（`pnpm test:workspace`）、**只判改动文件**的 Biome、`typecheck`、各包 vitest（`--concurrency=1`）、迁移空库重放 + 二次 no-op + 篡改自检 | 不打包。出包失败不许染红 PR |
| `.github/workflows/build-debug.yml` | 仅手动 `workflow_dispatch` | 矩阵出 mac / win 安装包，产 `dist-manifest.json`，跑打包态冒烟；`channel=rc` 另建 draft Release | 不挂 push |
| `.github/workflows/codeql.yml` + `.github/codeql/codeql-config.yml` | PR / push / 每日 schedule | 四门语言（js-ts、python、rust、actions），扫描面排除测试、夹具与 vendored ZCode UI | 不扫 swift / csharp（见 §五） |
| `.github/dependabot.yml` | weekly | npm(pnpm workspace 根) / cargo(两处 manifest) / github-actions | 不开 majors 自动 PR |

三条硬口径：

1. **桌面壳的检查不在 ubuntu 跑**：`apps/desktop/package.json:11-12` 的 `typecheck`/`test` 实为 cargo，ubuntu runner 没有 Rust + webkit2gtk，故 `ci.yml` 用 `--filter=!@kenfutwork/desktop` 排除，改由 mac lane 负责。
2. **`runtime/` 绝不能跨 job upload**：里面是符号链农场（`pg-symlinks.json` 复刻的 dylib 软链、pnpm 布局），artifact 打平后装上去必崩。所以「组装 `release/` → `tauri build` → 收包」必须同 job 完成。
3. **fork PR 拿不到 secrets**，且禁止 `pull_request_target` + 检出 PR 代码；所有 lane 都带 `if: github.repository == 'IsKenKenYa/KenFutWork'`。

## 三、可复现性的四个前置（没它们，CI 会「全绿但不可复现」）

| 项 | 落点 | 口径 |
| --- | --- | --- |
| Node 版本 | 根 `.nvmrc`（24.11.1）+ `engines.node`；`package-win.mjs` 的 `assertNodeMatchesPin()` | SEA 宿主是 `process.execPath`，构建机的 node 就是随包服务端的运行版本。`--sentinel-fuse` 那个字符串是 Node 源码里的**固定常量**（本机实测 node 22.20.0 与 24.11.1 同值），别把它当版本指纹 |
| 随包运行时 | `runtime-lock.json` + `scripts/runtime-lock.mjs`；`fetch-runtimes.mjs --write-lock` | python/uv/jdk/git 原本解析「最新发布」→ 同一 commit 隔天出包内容可以不同。lock 有的条目严格对账（**下载前**比资产名、下载后比哈希），没有的沿用解析。升级运行时是显式动作：重跑 `--write-lock` 并提交 |
| 版本号 | `pnpm version:bump <x.y.z>` 一处改四处（`tauri.conf.json` 权威 + `Cargo.toml` + `Cargo.lock` + `desktop/package.json`），`tests/workspace.test.mjs` 对账 | 历史上 0.1.1→0.1.3 每轮手改四处；漏改的代价是安装包元数据与产物互不相认 |
| 出包读数 | `collect-bundle.mjs` 产根 `dist-manifest.json` | 记 version/commit/ref/构建宿主 node/`rustc`/tauri-cli/runtime 版本/**签名状态**/逐 Mach-O 封印计数/DMG 用了哪档布局引擎/产物 sha256 |

GitHub API 匿名额度按 IP 计（runner 共享出口，60/h 很容易打满）：`fetch-runtimes.mjs:152-170` 已有 `gh api` 回落，CI 里导出 `GH_TOKEN` 即可自愈——本机实测命中过 403 并成功回落。

## 四、macOS 在没有付费开发者身份时怎么交付

机制层面的三个事实（这决定了「不签名也能发测试包」是否成立）：

- Apple Silicon 上 **ad-hoc 签名是运行下限**：完全未签的 Mach-O 直接 `Killed: 9`。现链路已经补了 ad-hoc 封印（`apps/desktop/scripts/macos-signing.mjs`，且它遇到已有证书签名**拒绝降级**，将来买证书不会被覆盖）。
- Gatekeeper 只评估带 `com.apple.quarantine` 的产物；**浏览器下载会写这个属性，`curl -LO` 不写**。所以出包同时产 `.app` 的 zip（`ditto -c -k --sequesterRsrc --keepParent`），给测试者一条免弹窗路径。
- 已被拦时：先拷出挂载点到 `/Applications`，再 `xattr -cr /Applications/KenFutWork.app`（对只读挂载点执行无效）。

CI 侧的两个必修点：`bundle_dmg.sh --skip-jenkins`（脚本自述「跳过美化 Finder 的 AppleScript，适用非 GUI 环境」，不带它托管 runner 会挂在那一步而不是降级）；hdiutil 兜底不再写死 `-size 2g`。

新增的**逐 Mach-O 校验**：`codesign --verify --deep` 通过证明不了 Resources 下的散装可执行体已封印，故遍历整个 `.app` 逐个 `--verify --strict` 并把 `total / failedTotal` 写进清单。当前实测本机那个 812MB 的 `.app`：194 个 Mach-O，0 个未封印，耗时 6.1s。将来上公证时，这批读数就是第一手靶子（`libjvm.dylib`、`@rpath libvips-cpp` 会被 hardened runtime 的库校验杀掉，需要 entitlements）。

如实表述的口径不变（沿用《日志》里「无有效 Developer ID 身份，不冒称证书/公证完成」）：清单与 Release body 里签名状态只写 `adhoc` / `unsigned` / `developer-id`，没有就是没有。

`pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 补了 `macos-alias` 与 `fs-xattr`（appdmg 的两个原生件，此前分裂在 `package.json:40` 与 workspace 文件两处）。实测这两个包都带 `os` 约束（`macos-alias: ["darwin"]`、`fs-xattr: ["!win32"]`），Linux/Windows 不会尝试构建；但 `fs-xattr` 在 ubuntu 上会变成**安装期编译**，若 runner 缺构建工具就会让所有 CI job 卡在 `pnpm install`——首轮若红，摘掉 `fs-xattr` 即可回到「collect-bundle 里 node-gyp 现场重编」的既有兜底路径（那条路径本身是可用的）。

## 五、签名相关：secrets 与 variables 分档

**档 0（现在）— 零机密。** `ci.yml` 与 `build-debug.yml` 不读任何 secret。

**档 1 — Windows 走 SignPath Foundation（开源项目免费 OV 签名，需先申请）。**

| 名称 | 类型 |
| --- | --- |
| `SIGNPATH_API_TOKEN` | secret（放 `release` environment） |
| `SIGNPATH_ORGANIZATION_ID` / `SIGNPATH_PROJECT_ID` / `SIGNPATH_SIGN_POLICY_NAME` | variables（非机密） |

机制是把未签工件上传签名服务再取回签名副本，所以 win lane 要拆 `win-build → win-sign`。**排除项**：Azure Artifact Signing（原 Trusted Signing）个人身份仅限美/加、组织限美/加/欧/英，本仓不具备资格；EV 证书自 2024 起不再秒过 SmartScreen，付溢价无依据；**不要把 `.pfx` 导出进 secrets**（CA/B 要求私钥在 HSM/云 HSM，且等于把私钥落在 runner 上）。

**档 2 — 若将来买到 Apple Developer ID（¥688/年）才创建：** secret `APPLE_CERTIFICATE`（.p12 base64，约 5KB；单个 secret 上限 48KB、每仓库/每环境各 100 个）、`APPLE_CERTIFICATE_PASSWORD`、`KEYCHAIN_PASSWORD`、公证二选一（`.p8` API 三件套，或 Apple ID + app 专用口令）；variables `APPLE_SIGNING_IDENTITY` / `APPLE_TEAM_ID`。
**先决条件不是 secret 而是代码**：`tauri.macos.conf.json` 目前既无 `signingIdentity` 也无 `hardenedRuntime`/`entitlements`，全仓无 `.entitlements` 文件；`bundle_dmg.sh --notarize` 只吃**已存在的 keychain profile**（脚本内不做 `store-credentials`），需先 `xcrun notarytool store-credentials` 再把 `--notarize <profile>` 传进 `collect-bundle.mjs`。

**现在明确不要建**（无消费方就是债）：updater 的 minisign 密钥 `TAURI_SIGNING_PRIVATE_KEY*`（`Cargo.toml` 里没有 updater 插件，更新=重装完整包）；任何 `.env.local` 内容（CI 跑不了 `pnpm dev`，它写死 `--env-file=../../.env.local`）。

## 六、扫描与依赖告警的收敛依据

- **CodeQL 默认设置恒红的原因**：全仓只有 1 个孤立 Swift 文件与 1 个 C# 文件，都没有构建系统 → `Analyze (swift)` 在 Autobuild 必挂，C# 「成功」但零产出。默认设置又不支持排除路径，于是 100 条告警里 85 条落在测试与夹具、5 条落在 vendored ZCode UI。
- 改高级设置后保留的四门语言：`javascript-typescript`（第一方主体）、`python`（`computer-use/atspi.py`、`wayland-portal.py` 是 Linux 侧真产品代码，无需构建）、`rust`（19 个第一方 `.rs`，含换票与进程沙箱）、`actions`（扫 workflow 自身）。`c-cpp` 暂不纳入（2 个 `.c` 由 `build.rs` 的 cc 编译，独立索引价值低）。
- **告警判定**：`apps/server/src/http/cors.ts:14` 是误报（origin 仅在等于配置值或回环 `http://<host>` 且 `isLoopbackHost` 时才回显，见 `:60-79`）；`scripts/诊断联网搜索.mjs:79` 打印 key 前 6 位，按 BYOK 边界口径去掉前缀即可；**`apps/server/src/http/image-proxy.ts:45,50` 是真问题**——`hostname.endsWith(domain)` 可被 `replicate.delivery.攻击者域名` 绕过，且 `fetch` 不限跳转，可指向 `http://127.0.0.1:<端口>`，而本架构的信任锚就是回环（`local-trust`）。本轮不动产品代码，已另立工单。
- **Dependabot 的批量红不是配置错**：那些包（brace-expansion / fast-uri / dompurify / ip-address / cargo 侧 glib）都是**纯传递依赖**，直接声明在父包里，本仓又是 pnpm + `patches/` 两处 `patchedDependencies`，Dependabot 重解不出这棵树，于是报 `security_update_not_possible` 且 `conflicting-dependencies: []`。出路是自己跑 `pnpm update` / `cargo update -p glib`，并关掉「分组安全更新」（它就是每包一个 run、失败刷一排红 X 的元凶）。
- **`pnpm lint` 现在不能当硬门**：仓库既存约 92 处 Biome 报错（非本轮引入），全仓门禁会让每个 PR 都红。故 `ci.yml` 只对本次改动文件跑 Biome，全仓欠债另立收敛工单。

## 七、发版三档与未完成项

版本语义（0.y.z 阶段）：MINOR = 里程碑（决策批次落地 / 新运行形态上线），PATCH = 安装包轮次。`git tag` 此前为 0 个——第一个正式 tag 就是本方案的起点。

| 档 | tag / 载体 | 状态 |
| --- | --- | --- |
| debug | Actions 产物（retention 30 天，公开仓库直接下载） | 本轮落地 |
| rc | `v<版本>-rc.<时间戳>` 的 draft Release（prerelease） | 本轮落地 |
| 正式 | `v<版本>` + 签名 + 公证 + CHANGELOG + 源码归档 | **未落地**：`release.yml` 待写，且依赖 SignPath 批准（档 1） |

后续待办（按性价比）：① `release.yml` 与 `version:bump` 串起来的 tag 流程；② **升级冒烟**——拿上一版的数据目录装新版跑首启迁移（本仓数据目录归用户、迁移只许前向，这是真实发版风险，现无任何自动化覆盖）；③ win lane 跑 `scripts/验收打包桌面端.mjs`（CDP 有头断言，托管 runner 上是否可行待实测）；④ SignPath 申请；⑤ 公开仓库免费项里还没用的：Pages 发文档站、GHCR 公共 server 镜像（匿名拉取不计流）、`FUNDING.yml`；⑥ 全仓 Biome 欠债与 `image-proxy` 的 SSRF 修复。

## 八、验证命令

```sh
# 前置四件套（本机）
node scripts/fetch-runtimes.mjs --write-lock          # 重锁运行时
pnpm version:bump 0.1.4                                # 一处改四处
node --test tests/workspace.test.mjs                   # 版本一致 / runtime-lock / env 表 / 文档治理
node --test apps/desktop/scripts/*.test.mjs            # 含 dist-manifest 与 macos-signing 夹具

# 门禁与出包（推送后）
gh workflow run ci.yml
gh workflow run build-debug.yml -f platform=both -f channel=debug
gh run list --workflow CodeQL                          # 应只剩 4 个 job，无 swift 恒红
gh api repos/IsKenKenYa/KenFutWork/code-scanning/alerts?state=open --jq 'length'
```
