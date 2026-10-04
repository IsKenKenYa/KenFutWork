# 终端迁移审计与 PTY 接口

2026-10-03，只读源码审计；本轮未运行既有终端测试。

## 已核实事实

- `code-git/terminal-session.ts` 使用真实 node-pty；Windows 明确走 ConPTY DLL，公开 raw write、resize 与 stop。它直接继承服务端 `process.env`；stop 的 1500ms finish 兜底不能证明管理范围为空。
- WS terminal sessions 属于连接，close 全部 stop；已启动的同 ID 会话复用，但异步 start 前无 pending 预留，存在并发同 ID、close 后迟到 spawn、旧 exit 回调删除新记录的窗口。
- WS start 契约仍为 `canvasId?`，但 `CodeGitService.terminalWorkDir` 已按 Task ExecutionScopes 解析；不带 canvasId 仍从服务端 cwd 直接开宿主 shell。
- 现有 ProcessSandbox Unix 与 Windows 均为 pipes，不能宣称保留 PTY、resize、PSReadLine/TUI。
- bounded OutputCapture 保存开头的字节；满额后永久丢弃后续输出。PTY 实时流必须与历史 capture 分开，否则满额后终端画面冻结。

## 原 ZCode consumer interface

唯一原类型：`packages/zcode-services/src/terminal/terminal.ts`，channel `terminal`。

- create({cols,rows,cwd?}) -> {id,shell,fontFamily,fontSize?,theme?,fontFamilySource,windowsPty?}
- write({id,data}), resize({id,cols,rows}), dispose({id}) -> Promise<void>
- onDynamicData(id) -> Event<string>；onDynamicExit(id) -> Event<number>

当前 CodeUi hostRpc 没有 terminal 分支，HTTP 返回 501；hello localTerminal 为 false。CodeHttpChannelClient.listen 只注册本地 Emitter、按 workspacePath 过滤，尚未支持动态 terminal ID 的 owned 订阅与 initial output activation。

## Provider interface 与归属

在同一 ProcessSandbox Provider 上新增 spawnPty(request)，request 保留 scope/agentId/invocationId/argv/cwd/background/deadline/limits/env，并要求 pty:{cols,rows}。返回 ManagedTerminalProcess extends ManagedProcess，增加真实 resize 与带回压的实时 output 订阅。固定同 Task helper，不另建 runtime。

PTY 命令在 SRT OS policy 内启动，精确 argv、sanitized env、私有 HOME、同代际撤销、restore writer admission、范围停止及 rangeEmpty 确认均复用。node-pty 仅作为同 helper 内的 PTY primitive。Windows 未完成 PSEC/MXC/Job+ConPTY 实机验证前明确 fail closed，绝不以 pipes 替代。

父代理负责 WS/shared/CodeUI consumer：显式 Task 身份、连接 owned 会话、pending 预留、generation/object identity 防迟到、动态事件激活与 ID 过滤。人类终端不伪装成要求 originRunId/toolCallId 的模型 TaskWork。

## 验收切片

1. 公共真实 PTY tracer：TTY、创建尺寸、交互输入、stop 后范围为空。
2. resize 与原始键/ANSI；live 输出越过 capture cap 仍更新。
3. Task 授权与隔离、收紧/close、restore 冲突、同 invocation 幂等、迟到操作。
4. Windows capability fail closed；Windows 真实 ConPTY 支持另需原生与实机证据。

测试只由当前唯一 test token 持有人运行，不并发启动 runner。

## 最新回执（2026-10-03）

- 真 PTY first tracer 经 `spawnPty` missing RED 后 GREEN；native spawn-helper 0644 已确认，以 Task 私有真实 native 副本 0755 修复，不改共享安装包。SRT 官方 allowPty 仅该次 PTY policy 启用，否则 macOS stty ioctl 返回 EPERM。
- resize/raw-key tracer RED 后 GREEN：113×37；方向键与 Ctrl+C 的 raw 字节 `1b5b4103` 保留。
- live/capture tracer RED 后 GREEN：capture 保留 128 bytes，后续 ANSI LIVE_END 仍由实时流送达。
- cursor tracer RED 后 GREEN；四条 public PTY tracer 完整 GREEN 4/4，日志 `/private/tmp/kfw-code-harness-pty-cursor-green.log`。
- onOutput 第二参数为 `{sequence,offset,nextOffset}`，按完整送达 UTF8 字节计数，从 0 起；sequence 每进程从 1 按帧递增。真实游标与 retained cap 独立；初始未消费帧保留，listener Promise 完成才 ACK，native pause/resume 实施回压。
- job-control 第五条 actual RED：shell stop 返回 rangeEmpty:true 后背景作业 heartbeat count 98→105，证明仅杀 leader PGID 不够。日志 `/private/tmp/kfw-code-harness-pty-jobs-red.log`；测试清理只杀自己创建的 job。
- 同 helper 内正在增加 macOS getsid/libproc 原生 SID/birth inspector；不信任 ps sess（本机显示 0），不按可复用 tty 名称杀进程。检查 SID 全部 PGIDs，冻结后 TERM/CONT/KILL，扫描确认 session 真空，未确认返回 stop_unconfirmed。尚未 GREEN。
- Linux SRT bwrap `--new-session` 影响 controlling-terminal/job-control/SIGWINCH；Linux 与 Windows 真沙箱 PTY 尚未实机/CI 验证，暂需明确 fail closed，仍为整体 Goal 未完成项。
- 最后一次测试 token 已交回 parent；本 worker 当前无测试 runner、无 commit/push。

## macOS 完成回执

- 第五条 job-control tracer actual GREEN；PTY public suite GREEN 5/5，日志 `/private/tmp/kfw-code-harness-pty-jobs-green.log`。
- 同一串行 runner 验既有 ProcessSandbox 25 + PTY 5，实际 GREEN 30/30；日志 `/private/tmp/kfw-code-harness-process-pty-regression.log`（16.32s）。
- 本地 SDK 的 C inspector 真实编译通过；SID 与 leader start sec/usec 防 PID/tty 复用误杀。关闭与自然 shell 退出都 join session stop，冻结全部组后 TERM/CONT，治理宽限期后 KILL，最终扫描空才回 rangeEmpty。无法证明即 stop_unconfirmed；没有 timer/PTY exit 假完成。
- server tsc 当前本域零诊断，全 server 仍有并行 BYOK provider fixtures/wire 与旧 OpenAPI schema 错误；日志 `/private/tmp/kfw-process-pty-types.log`，不能宣称全仓 typecheck 成功。
- Linux/Windows 所有 public spawn(pty)/spawnPty 当前显式 fail closed，Mac tracer 的平台限定反映实现范围，未把 Linux/Windows 标成完成；整体三平台 Goal 仍有剩余工作。
- macOS 范围为可核验的 POSIX session 与其进程组，不是 PID namespace/cgroup；用户进程主动 setsid 派生新 session 的逃逸限制仍存在，不能宣称任意后代容器。
- 该 worker 已正式归还唯一测试 token，当前无 runner、无 commit/push。

## 输出关闭与最后尾部回执

- 第六条 public tracer actual RED：短输出350ms内 native 已退出，但异步 reader gate 尚未完成，waitForExit 提前resolve。修复后活跃 reader 的 waitForExit join delivery/ACK，未订阅的 pending 不伪造已交付；GREEN 6/6。
- 第七条 native-tail tracer actual RED：1000bytes首帧暂停350ms，50ms后TAIL_END+退出，上游200ms socket destroy截去尾部。修复只在 Task 私有node-pty副本执行结构校验适配，保留原安装包和许可证。
- helper outputreader RPC 在listener执行前完成注册；活跃reader暂停时禁止强制destroy，无reader的native reaper恢复读取到有界capture。该适配不增加第二runtime，也不取消Task scope/真实range证明。
- ProcessSandbox 25 + PTY 7 单runner实际 GREEN 32/32，`/private/tmp/kfw-code-harness-pty-native-tail-green.log`（20.97s）。
- 有活跃reader时保证最后已收到的所有帧完成consumer Promise/ACK才返回waitForExit；未订阅时保持首pending供晚激活，完整历史仍受显式capture cap限制，晚订阅消费方需用capture/totalBytes游标重放和去重。Task已关闭/IPC失联不宣称能继续晚读。
- reader取消时排空至capture；权限撤销与host关闭仍以物理范围empty作屏障，不能由UI drain回执假造。


## Linux 验证环境阶段（2026-10-03）

- 已安装 Docker Desktop 通过 CLI 启动，曾实际返回 linux/aarch64；缓存node:22-slim为linux/arm64。没有更改用户Docker配置、没有触碰既有镜像或容器。
- 启动前16GiB/10逻辑核、CPU约86.8% idle、memory_pressure可用55%；启动后约37-39%可用，physical unused约140-176MiB、compressor5.4-6.3GiB。计划单临时1GiB/2CPU，不与其他test runner并发。
- 临时Linux包只复制本域TypeScript源和最小依赖清单到 `/private/tmp/kfw-linux-platform-iye775rb`；不含原checkout/env/credentials。docker run在连接daemon阶段失败，未创建容器；不存在需清理的验证容器。
- 窄日志确认13:01:12 Electron pid55453请求backend shutdown，dockerd成功退出、hypervisor显式cancel、ExitHealthyState、services exit0；13:31:25重新启动VM。谁触发Electron请求尚未知，不能归因用户、CUA或OOM。
- CUA getApp(Docker)发生约1767s timeout且未返回UI状态/未执行UI操作，停止该异常路径。后续只用CLI。
- 目前test/platform token已正式归还parent；本worker无测试或容器runner。Linux/WindowsPTY仍fail closed、尚未实测。
- Linuxpublic tracer `linux-pty.test.ts` 已写，等待真实Linux窗口确认RED：TTY/controlling resize、raw keys、PID namespace inode隔离、Task outside deny与reference只读。尚未执行，不能宣称GREEN。
- Linux候选保留node-pty为每command创建的独占session/TTY，仅移除SRT生成的leading --new-session，完整保留PID/user namespace/proc/fs/network/seccomp；必须先实测，否则保持fail closed。
- Windows pinned MXC一手源码只有Pipes/Inherit；BaseContainerRunner Inherit明确为ConPTY console-sharing，保留suspended→Job assign→Resume。可用同nativebroker per-command controller模式，不新增业务runtime；需source接线和真实Windows host验收，crosscheck不能替代。


## Linux 完成回执（2026-10-03，覆盖前述待验证状态）

真实 Linux/arm64 容器已建立并断网，不挂载host checkout/env/credentials。首public seam actual RED是显式Linux PTY guard；环境的UID501/0700测试根与Docker masked `/proc` 分别独立复现并只在本任务容器修正。强SRT probe进一步发现内部socket bind先于tmpfs与private mask可写两项问题，已按精确wrapper适配修复，不开启弱隔离或授予父目录。

native Linux namespace inspector +同Task helper已完成范围控制：pin namespace FD、查nested parent namespace、pidfd/birth信号、冻结→TERM叶子/CONT→宽限→KILL→scan empty。真实TTY、keys、resize、job-control后台不同PGID的stop/natural exit/revoke全部验证。Linux全域最终49/49 GREEN（22.89s），`/private/tmp/kfw-linux-sandbox-final-green.log`；额外UID1000无rootcapabilities真PTY/stdio 11/11 GREEN（11.49s），`/private/tmp/kfw-linux-unprivileged-green.log`。

源开发态编译固定nativeC，发布态随包Linux inspector。服务端本域tsc零诊断，当前全server仍有OpenAPI三个旧schema导出错误。WindowsConPTY/native逐流ACK/真实Windowshost仍未完成；两平台绿色不能替代三平台验收。最新唯一发布helper路径及token归还由下一条回执登记。


## 最终产物与测试令牌回执（2026-10-03）

macOS 同一最终源码全域48 GREEN +1 Linux-only skipped，`/private/tmp/kfw-process-sandbox-macos-final.log`（28.68s）。Linux49 GREEN、额外UID1000的11条真实PTY/stdio GREEN；本域Biome通过，服务端本域tsc零诊断。最新macOS helper是 `/private/tmp/kfw-process-helper-linux-pty-n2WampHy/task-helper.mjs`，最新Linux/arm64 helper是 `/private/tmp/kfw-process-helper-final-linux-iye775rb/task-helper.mjs`（含Linux inspector和Linux pty.node）；按平台选用，不再使用旧stdio/PTY artifact。

只回收本任务创建的 `codex-kfw-linux-iye775rb` 与 `codex-kfw-linux-iye775rb-ns` 容器和 `codex-kfw-linux:iye775rb` 临时快照镜像；没有修改用户Docker配置/既有容器/基础node镜像。真实验证日志与两平台发布产物保留在 `/private/tmp`。测试/platform令牌归还父任务，当前无本worker runner；未commit/push。Windows ConPTY、原生完整stdio ACK与实机验收仍未完成，主任务整体Goal不能标完成。


## Windows 源码与可做验证回执（2026-10-03）

固定 MXC 的 ordinary `kill/wait` 一手源码使用 `terminate_best_effort`，Job drain timeout只是warning后继续teardown，故不能将其单独当strict rangeEmpty证明。当前实现保留原固定依赖与许可，没有vendor/patch共享SDK。每个Windows command使用同nativebinary的可信controller；broker将controller以CREATE_SUSPENDED创建、赋外层Job后才resume，再经private anonymous handles发送launch DTO。用户argv/env只由原MXC/PSEC消费，不在controller/broker之外裸跑。controller在SDK wait/teardown前确认外层Job只剩自己，broker最后确认Job为0。query handle只有JOB_OBJECT_QUERY，control/query继承位在user spawn前清除；SDK仍走原suspended→Job assign→resume与独立PSEC读取域。

PTY使用真实CreatePseudoConsole与ResizePseudoConsole，broker读写原始ConPTY流，controller在其console中用MXC Inherit；双流stdio使用MXC Pipes。private control IPC与raw tty分离；Root stdin写不会占住stop/ACK循环。raw base64 native frame每stream单帧ACK，helper StringDecoder将native raw序号映射到独立UTF8交付序号，空分片先ACK、EOF刷新尾部、active reader原生exit时保留回压与最后ANSI。capture上限不截协议。自然退出等待user range、输出reader与ACK；早停不等待spawn ready。输出交付失败与物理退出Promise分开，未知Job/IPC失联不能借输出结束解锁。Windows默认HOME/USERPROFILE/APPDATA/LOCALAPPDATA落Task private temp/home，显式env只应用到PSEC用户命令。

native v2 probe真实检查PSEC/deny path、Job与ConPTY，公开spawnPty/spawnStdio按实际capability握手接线；旧binary/能力缺失fail closed，不以pipes伪装TTY。非空network域列表仍因固定SDK不支持client-only受限代理而拒绝，不扩大权限。

源事实与验证事实分层：

- Windows GNU `cargo check --target x86_64-pc-windows-gnu --tests --locked` 实际GREEN，包含native与测试源码；`cargo fmt -- --check`通过。本域Biome通过；该次server tsc本域零诊断，全server仍有其它模块施工诊断。日志 `/private/tmp/kfw-windows-conpty-cross-check.log`、`/private/tmp/kfw-windows-conpty-types.log`。
- Portable TS初跑actual RED 2/8：新增physicalExit Promise漏resolve导致早停与stop reply失败后的真实范围事件仍挂起。修复后同2文件8/8 GREEN（168ms），`/private/tmp/kfw-windows-portable-green.log`，先前RED `/private/tmp/kfw-windows-portable-red-green.log`。
- Native ACK同步3/3 GREEN（host cfg(test)，0.00s，首次编译15.30s），`/private/tmp/kfw-windows-native-ack-green.log`。这些测试不调用Windows OS API，不是ConPTY/PSEC/Job实机。
- `windows-native.integration.test.ts` 有6条真实case：TTY/raw/resize+Task外read/参考只读、PowerShell PSReadLine/Console、背景writer stop/natural exit/revoke、完整双流UTF8/ACK/EOF/capture。仅win32且 `KENFUTWORK_WINDOWS_NATIVE_TESTS=1`开启，可选 `KENFUTWORK_WINDOWS_BROKER_PATH` 指向实际compiled broker；两env已登记 `tests/env-registry.json` 为test-gate/inExamples:false。当前无Windows host，6条全部未执行；crosscompile、skip和portable green都不替代实机。
- 当前未发现 `x86_64-w64-mingw32-gcc`，尚未产出可运行Windows EXE；现有GNU证据是type/cross-check。已有macOS/Linux最新helper保留，不覆盖其产物。生产Windows必须在有真实toolchain的host完成native build与integration。

实际验证命令（串行、唯一runner）：

```sh
pnpm --filter @kenfutwork/server exec vitest run src/features/process-sandbox/windows-live-output.test.ts src/features/process-sandbox/windows-process.test.ts --no-file-parallelism
CARGO_BUILD_JOBS=1 cargo test --manifest-path apps/server/src/features/process-sandbox/native/Cargo.toml --locked windows_output::tests -- --test-threads=1
CARGO_BUILD_JOBS=1 cargo check --manifest-path apps/server/src/features/process-sandbox/native/Cargo.toml --target x86_64-pc-windows-gnu --tests --locked
cargo fmt --manifest-path apps/server/src/features/process-sandbox/native/Cargo.toml -- --check
```

Windows host待执行（PowerShell，不是本机已执行命令）：

```powershell
cargo build --manifest-path apps/server/src/features/process-sandbox/native/Cargo.toml --release --locked
$env:KENFUTWORK_WINDOWS_NATIVE_TESTS="1"
$env:KENFUTWORK_WINDOWS_BROKER_PATH=(Resolve-Path "apps/server/src/features/process-sandbox/native/target/release/kenfutwork-process-broker.exe").Path
pnpm --filter @kenfutwork/server exec vitest run src/features/process-sandbox/windows-native.integration.test.ts --no-file-parallelism
```

本worker已归还test token，无runner、无commit/push。Windows源码/portable与cross-check不等于三平台Goal完成；主任务仍需真实Windows环境与最后整体门禁。
