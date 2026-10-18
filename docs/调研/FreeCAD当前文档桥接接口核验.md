# FreeCAD 当前文档桥接接口核验

> **角色：调研。** 核验日期：2026-10-18。范围：已安装 FreeCAD 1.1.4 对应官方提交 `4fd3bf320d9566a27e60069fc8387448aaa3a094` 的 GUI 启动、官方本地消息通道、宏与主线程调度；为下一批固定只读桥提供依据，不声明当前文档控制已交付。方向与权限仍以[CAD 控制插件规划](../插件/CAD控制插件规划.md)为准。
>
> 资料核验阶段只读取官方资料、源码和既有诊断文件；第 6 节是旧回执的复核。随后 KFW 固定文档查询的实现与新原生验收单独记在第 8 节，不将两种证据混算。

## 1. 结论与证据层级

FreeCAD 1.1.4 自带的是**本地文件打开通道**，可以请求 GUI 进程执行指定 `.FCMacro` 文件；它不是带请求身份、鉴权、业务 ACK 或取消的 RPC。可以用它加载固定桥，但后续请求身份、结果、去重与授权代际必须由 KFW 桥补齐。官方 Qt 事件循环足以让固定只读查询在 GUI 主线程完成，无须经过 AX。

| 判断 | 证据与范围 |
| --- | --- |
| 官方源码已证实 | `GUISingleApplication` 监听本地消息；`OpenFile:` 经主窗口交给 `App::Application::processFiles()`；宏在该进程 Python 解释器执行。见第 2～4 节。 |
| 已有本机原生证据 | 独立 GUI 实例实际收到宏路径，返回真实 PID／版本／隔离路径；另一固定行为探针完成 13 步、55 断言。见第 6 节；不是产品桥验收。 |
| 本文建议，尚未实现 | 固定只读桥的独立 endpoint、bootstrap nonce、请求／文档代际、鉴权及回执。见第 5 节。 |
| 尚不能证明 | 任意现存 GUI 的通用自动附着、跨平台产品桥、长期稳定、GUI 内任意 Python 的 Task OS 沙箱隔离。 |

## 2. CLI 与官方本地消息协议

### 2.1 启动参数和单实例行为

官方 `App/Application.cpp::parseProgramOptions` 定义 `--user-cfg`、`--system-cfg`、`--macro-path`、`--single-instance`、`--pass`；另有隐藏的 `--hidden`，映射为 `StartHidden`。参数不是通用 RPC：`--pass` 是脚本参数入口，不能据此推断现存 GUI 会接收这些参数。[参数定义与映射源码](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Application.cpp)

`Gui/Application.cpp::onlySingleInstance` 仅在设置了 `SingleInstance` **且**检测到现存服务时，将命令行文件改为绝对路径，逐项发送 `OpenFile:` 消息，然后结束新实例启动流程。`GUISingleApplication` 本身无条件尝试探测服务；省略单实例选项不等于获得另一个可接收消息的独立 server。因此隔离实例需要独立的 socket 命名空间，不能只省略 `--single-instance`。[单实例判断](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/Application.cpp)、[连接建立](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/GuiApplication.cpp)

官方[启动配置文档](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Start_up_and_Configuration.md)列出通过文件参数运行 `.FCMacro`／`.py` 的用法，但该文档仓库已归档，页面示例面向 1.0；本次版本细节以固定提交源码为准。该页同时说明 FreeCAD 专用目录环境变量与 `HOME`／`TMPDIR` 的不同用途，不能只设 `HOME` 就声称已隔离 FreeCAD 配置。

### 2.2 实际 wire 格式及缺少的保证

`GUISingleApplication::sendMessage` 使用 UTF-8 文本并追加换行；接收端 `readFromSocket()` 只处理完整行。每收到一行就重启 1000 ms 单次定时器，随后 `processMessages()` 将累计列表发给 `messageReceived`。这是共享队列的延迟批处理，时间间隔不是每个请求的独立完成时限。[发送、读取与排队源码](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/GuiApplication.cpp)

当前分派路径识别的文件打开消息形状为：

```text
OpenFile:/absolute/path/fixed-bridge.FCMacro\n
```

这里的 `\n` 表示一个实际换行字节。主窗口只提取该前缀之后的路径，再调用 `processFiles()`。宏分支对 `fcmacro`／`fcscript` 调用解释器 `runFile(..., true)`；`.py` 则先尝试模块加载，失败再执行脚本。固定 bootstrap 应选 `.FCMacro`，不依赖 `.py` 的导入缓存行为。[主窗口分派](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/MainWindow.cpp)、[文件类型分派](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Application.cpp)

`sendMessage()` 的成功条件是 `waitForBytesWritten()`，没有读取执行结果；接收函数没有回写业务 ACK。协议没有 requestId、结果关联、去重或撤销指令。文件处理异常可能只进入日志，连接成功或发送成功都不足以证明宏完成。客户端应拒绝路径中的 CR／LF／NUL，不能让一条路径变成多行消息。以上“没有 ACK”的判断限于已核验的这条通道，不概括所有 FreeCAD 扩展接口。

“固定只读宏”也不等于 bootstrap 无副作用：主窗口会对处理过的文件设置 FileDialog 工作目录，加载桥还会建立 Python／Qt 对象及通信资源。生产应把**首次装载桥**作为外部应用执行接入审批，不能仅因宏随后读取文档就标为 `access:read`；已装载桥中的固定查询才另行声明只读效果。

## 3. socket 地址与实例身份

`serverName` 来自 `App::Application::getExecutableName()`，即配置 `ExeName`，官方 GUI 入口将其设为 `FreeCAD`；它不是 PID、bundleId、安装路径或配置路径的哈希。[名称来源](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/GuiApplication.cpp)、[GUI 默认名称](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Main/MainGui.cpp)

Qt 6.8.3 Unix 实现对相对 serverName 使用 `QDir::tempPath()/serverName`；绝对名字才直接作为地址。本机隔离记录实际对应 `/private/tmp/kfw-fc-gui.i7t6d6mh/qt-tmp/FreeCAD`，大小写也是身份的一部分。不同 `TMPDIR` 可以让相同 ExeName 使用不同 Unix 地址；不能据此保证 Windows 命名管道也随 TMPDIR 隔离。[Qt 固定版本地址规则](https://github.com/qt/qtbase/blob/v6.8.3/src/network/socket/qlocalserver_unix.cpp)

| 场景 | 可依赖的发现方式 | 不能据此推断 |
| --- | --- | --- |
| KFW 新建的独立 GUI | 由启动器持有实际环境；固定 bootstrap 回报 `QDir.tempPath()`、ExeName、PID／版本／启动 nonce；与预期地址及 peer 身份交叉核验。 | “目录中存在 FreeCAD socket”不等于它属于本次进程。 |
| 用户已有 GUI | NSWorkspace 只能提供应用身份，未提供该进程的 Qt 临时目录或官方 socket 地址。本次未核验一种 FreeCAD 自带的进程外地址查询 API。 | 不能从默认 `/tmp`、当前 KFW 的 TMPDIR、bundleId 或最近日志猜选。 |
| KFW 自建固定桥 | 自己的 `QLocalServer` 可以用 `fullServerName()` 报告实际 endpoint；由私有 bootstrap 回执交给宿主。 | stock FreeCAD 的私有 server 对象并未因此自动成为公共 Python API。 |

Qt 的 `fullServerName()` 是平台相关完整地址。官方同时提示不要删除仍运行实例的 socket；FreeCAD 的 server 建立流程在地址占用时含 `removeServer` 重试，因此生产实现更应使用独立目录，而非到用户实例目录尝试监听或清理。[QLocalServer API](https://doc.qt.io/qt-6.8/qlocalserver.html)

macOS 还需验证**所连接 socket 的 peer PID**，不是只验文件属主。Apple 官方 `sys/un.h` 定义 `SOL_LOCAL`／`LOCAL_PEERPID`；本机 SDK 同样存在这些定义。之前诊断使用实际连接的 peer PID 与预期 GUI PID 比较，成功后才发送宏。[Apple 头文件](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h)

**鉴权边界：** Qt 文档明确指出 macOS 不以 Unix socket 文件权限 flags 提供访问限制。socket owner、0700 目录、随机地址能减少误连，但不能单独充当完整应用鉴权。新桥仍需私有 bootstrap secret／连接身份核验；敏感值不能放进 `OpenFile:` 文本，原实现会记录收到的消息。[Qt socketOptions](https://doc.qt.io/qt-6.8/qlocalserver.html#socketOptions-prop)

## 4. 主线程调度与宏生命周期

官方启动流程在 GUI 主线程创建 `GUISingleApplication`、`Gui::Application`、`MainWindow`，`StartupPostProcess::setProcessMessages()` 将消息信号连接至主窗口 slot；启动后进入 Qt 主事件循环。[GUI 生命周期](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/Application.cpp)、[信号接线](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/StartupProcess.cpp)

Qt 要求 QWidget 系列在主线程使用；queued connection 在接收对象所属线程的事件循环执行。`QTimer.singleShot` 的 context 重载也保证在 context 的线程执行，且依赖该线程事件循环。**在 socket worker 中调用无 context 的 timer，不自动等于回到 GUI 主线程。**[Qt 线程规则](https://doc.qt.io/qt-6.8/threads-qobject.html)、[QTimer context](https://doc.qt.io/qt-6.8/qtimer.html)

据此，下一批最小固定只读桥可在 bootstrap 宏所在 GUI 线程建立并保留 QObject／QLocalServer，让 `readyRead` 只解析有界固定请求，真正查询交给该 QObject 的主线程 slot；若另有 I/O 线程，必须显式 queued 调度。每次操作前检查 `QThread.currentThread() == QApplication.instance().thread()`，拒绝错误线程，不以捕获异常代替线程约束。不要在 GUI 主线程使用阻塞 `waitForNewConnection()`。[非阻塞 server 建议](https://doc.qt.io/qt-6.8/qlocalserver.html#waitForNewConnection)

宏的 `local=true` 只复制 Python 执行字典，不是安全沙箱；它仍在目标进程解释器执行。宏返回后要保留桥对象的强引用或正确 Qt parent，不能依赖临时局部变量继续存活。[InterpreterSingleton::runFile](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Base/Interpreter.cpp)

## 5. 固定只读桥的最小实施边界（建议）

本节是由上述接口推导的 KFW 设计建议，不是 FreeCAD 自带协议或本轮已实现内容。

1. **先用独立实例。** 直接启动已核验安装中的 GUI executable，持有新的 PID／出生身份；每次使用独立配置、数据、cache、Qt TMPDIR 和明确的启动宏。不要用 `open -a` 或复用用户的默认 socket。可选隐藏主窗口只改变显示，并不把 GUI 变成 headless，也不保证 Cocoa 全局状态完全隔离。
2. **bootstrap 固定且可核验。** 宿主发布固定来源/hash 的 `.FCMacro` 和私有配置；不允许模型提交 Python、宏路径或 endpoint。启动宏或已核验的官方文件通道只用来加载它，不对每个请求拼任意源代码。
3. **第一批只返回快照。** 固定操作限版本、应用/桥实例身份、文档列表、当前文档及有限名称／文件名／原生 Modified／模型 touched 信息；不新建、保存、关闭、重算、清 Modified、开事务或执行任意 Python。所有读取仍在主线程，限制结果大小与工作量。
4. **建立自己的请求回执。** 至少关联 requestId、参数指纹、bridge 实例 nonce、PID／出生身份、状态和结果；宿主持有真实 Task／Run／toolCall／授权代际。文档使用每次打开的新句柄和观察修订，不能只用 Name／Uid。重复 ID 不同参数拒绝，同参只对账原结果，不默认重放。
5. **保留不确定状态。** 官方消息已发但没有对应回执时，记录 actionSent／未知；不能超时即重发。取消尚未执行的主线程请求可以拒绝，已进入 GUI 原生调用则不能承诺强制中断；不通过杀用户 app 或盲目 undo 伪造取消。插件停用先封锁新请求、回收自己的桥与排队工作，不能把外部应用宣称为 Task OS 沙箱进程。
6. **执行后再检查稳定性。** 匹配回执后还核验该进程身份和桥可响应。两者仅证明观察时刻存活，不等于长期稳定；不使用 AX 完成此检查。

新建受 KFW 托管实例与未来显式连接用户实例是不同接入方式。后者必须另验 bootstrap 的授权、不可控原生操作及应用失联恢复，不能由第一种方式的通过自动覆盖。

## 6. 已有本机证据的重新对账

本轮读取以下原文件，未重新执行：

| 文件 | 核验到的事实 | 限制 |
| --- | --- | --- |
| `/private/tmp/kfw-fc-gui.i7t6d6mh/ready-verified.FCMacro` 与 `ready-verified.json` | 固定宏由 GUI 事件循环后发布；PID 65575，版本 1.1.4／上述提交；空文档；配置／data／cache 各在独立目录，`QDir.tempPath()` 是独立 `qt-tmp`。 | 旧时刻的应用事实，不是当前活性查询；只读宏仍会写自己的回执文件。 |
| 同目录 `FreeCAD.log` | 记录 `Local server 'FreeCAD' started`，收到两个既有 `OpenFile:` 宏路径。 | 日志中的接收行不是业务完成 ACK。 |
| `/private/tmp/kfw-cad-research/probe-20261018/current-gui-prototype/执行与观察.py` 与 `dispatch.json` | 对独立地址先校验 socket 类型／属主，再用连接 peer PID 核对 65575；派发前登记 requestId／actionSent，观察脚本不因超时重发。 | 该 requestId 未经 stock 协议传入宏；宏生成的是另一 nonce，因此尚非生产级端到端请求关联。 |
| 同目录 `current-document-probe.FCMacro` 与 `latest.json` | 终态 `passed/completed`；13 步、55 断言、898 个 events、43 个 observations；`guiThreadVerified:true`、errors 为空、自有句柄与文档均清空。结束时间为 `2026-10-18T08:18:02.443686Z`。 | 这是会修改自有文档的固定行为探针，不能作为只读桥源码；不是 KFW 工具／审批／持久恢复验收。 |

主要证据 SHA-256：

```text
ready-verified.FCMacro  b47c5e908a88bb2d672b4fa3fb51c3c795111049615852e5b8c7eccc270c395c
ready-verified.json     5e1efced99039bfe07d69ffc6f38e84b40c0a757a737416b4c35080cafa62ecd
current-document-probe.FCMacro  298a54a70376571e57f088e7b1f43a8773fc2a5e9f39876b03ab0c982000252c
latest.json             04c9eca94eb205cddbdc49826c78c9de45ec86713b5962c440bdead1005f88f2
```

探针目录的早期说明仍含“尚未执行”措辞；已有终态回执比这句准备说明更新。完整步骤与事务／saveCopy／旧句柄事实继续归[原 CAD 调研](CAD官方接口与插件接入调研.md) §9.17，本篇不复制验收矩阵。

## 7. 未验证项与下一批验收要求

- 持久 `QLocalServer` bridge 尚未实现；已交付的逐次固定宏查询／观察／检查／属性写入见第8—11节，不能据此声称持久server或任意GUI Python已交付。
- 未在用户当前 GUI 加载桥或建立连接；不默认恢复 AX 自动化。Qt 6.8.3 的既有崩溃证据与未证实因果仍见原调研 §9.16；避免 AX 不等于修复了 Qt。
- `--hidden`、独立目录和 Qt socket 规则有源码依据；本轮没有另做隐藏实例启动、恶意 peer、socket 替换、请求排队或回执后长期存活验收。
- Windows／Linux 的控制与身份机制需各自验证；不能照搬 macOS peer PID 常量、Unix 地址或权限结论。
- 官方 socket 只证明可加载宏，不提供 KFW 授权、沙箱或业务日志。首次验收应保持“固定只读、独立 GUI、真实 Task”范围，随后再增加已确认的当前文档操作。

## 8. KFW 固定文档查询切片与原生验收

`cad_gui_documents` 已接到现有 CAD Service／Provider／工具消费方及插件生命周期，参数只接受 `cad_gui_status` 的完整应用身份。实现使用每次查询的固定宏与私有请求／回执，不是上文建议的持久 server。宏在 GUI 主线程读取文档元数据；加载的 FileDialog 目录副作用按执行权限与独立审批证据呈现。Task 只读、授权／插件代际变化、并发重放、取消和未知送达由行为回归覆盖。

macOS 的 LaunchServices `launchDate` 与 libproc 出生时间不是等价字段。本机同一进程实际相差约 51 ms，不用容差或四舍五入拼成同一身份；新增 `birth` 精确保留内核秒／微秒。状态签发和复验分别检查该身份，实际发送在同一已连接 socket 上核对 peer PID、出生整数及内核可执行路径。受控客户端测试覆盖出生相差 1 微秒、可执行路径变化、暂停进程时零字节发送；这些是协议行为测试，不冒充真实 PID 复用实验。

原生测试命令：

```sh
KENFUTWORK_CAD_GUI_DOCUMENTS_INTEGRATION=1 pnpm --filter @kenfutwork/server exec vitest run src/features/cad/gui-documents.integration.test.ts --maxWorkers=1 --no-file-parallelism
```

本机 FreeCAD 1.1.4 实测通过：独立实例创建保存及未保存的自有文档，经真实 Task 工具连续两次查询，原生 Modified／touched／待提交事务／活动文档均保持，保存文件 SHA-256 不变，返回不同观察 ID；随后由持有 nonce 和原文档对象的固定清理宏关闭自有文档及实例。未向用户现存 FreeCAD 发宏或读取 AX；没有依据此结果认定 Qt 崩溃已修复或长期稳定。

验收启动方式也单独核对：直接 exec 内部 bin／官方 launcher 在本环境只登记为无 bundleId 的进程，生产探针正确拒绝，不补造身份；测试改经 NSWorkspace／LaunchServices 的 NewInstance 与 WithoutActivation，传入隔离配置／HOME／data／cache／TMPDIR。外部 GUI 不作为 Task 子进程或 OS 沙箱成员，清理只请求该测试实例的 nonce／文档对象，另设自有超时宏，不按裸 PID 杀应用。完整检查与提交记录见《日志》本批。

## 9. 打开代际与观察计数

固定宏 v2 在同一解释器保留一个按固定版本复用的 App／Gui 观察器，不新增 socket 或任意 GUI Python 入口。每次文档打开签发随机句柄，桥重建换代际；查询必须先按 Python 对象 `is` 确认仍在实际清单中，再读取属性。官方 `getPyObject()` 返回缓存包装对象，关闭信号则早于 DocMap 移除，故删除回调只墓碑，不枚举重新发现。见固定版本 [Document.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Document.cpp)、[Application.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Application.cpp)。

App 观察器能收到创建／删除、文档及对象属性、重算、文档 undo／redo、事务与保存事件；无文档参数的事件只增加全局观察计数。Gui ViewProvider 的删除／退出编辑参数可能正在失效，本实现完全不解引用，只计全局事件。回调源与签名见 [App 观察器](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentObserverPython.cpp)、[Gui 观察器](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/DocumentObserverPython.cpp)。

**事件不完整，不能包装成内容版本。** `DocumentObject::touch()` 没有该 Python observer 接线，GUI Modified setter 也不发观察事件；查询重读 primitive 元数据的差异会补增计数，但无法发现两次查询间改动后恢复原值。相机、选区和恢复完成也不由这些回调完整表达。见 [DocumentObject.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentObject.cpp)、[Gui Document.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/Document.cpp)。观察器本身只返回标识，不授权编辑；固定写入还须复验原生状态、事务与预期属性。

同一独立 GUI、真实 Task 的回绕验收已通过：连续查询保持代际／句柄／计数不变；自有夹具改尺寸并重算、undo、对象 touch、清除 Modified 后均观察到对应计数变化；关闭后重开同名同 UID 的 FCStd，旧句柄消失、新句柄不同，源文件 SHA-256 不变。测试中的修改来自专用夹具宏，产品工具仍只有元数据查询，不将该结果称为受控编辑交付。合法失败 ACK 不签发桥身份并可清理请求，迟到／畸形／旧协议回执仍拒绝。

额外边界已获得真实 RED→GREEN：非空 `doc.clearDocument()` 在同一缓存 wrapper 上发 Delete→Created，原 Created 复用普通枚举逻辑会一直跳过旧墓碑，实际查询漏掉仍存活的文档。修复将显式 Created 单独处理：重新签打开代际，Deleted 仍不枚举、不读代理。原生回归同时调用 `clearDocument()` 和 `restore()`，确认 `App.getDocument(name) is 原doc`、新句柄不同且旧句柄消失，恢复后 Box.Length 仍是源文件20 mm，文件 SHA-256 不变。`restore()` 的 NewDocument 信号早于 ZIP 读取及 Restoring 状态设置；该信号不能单独成为后续编辑就绪证明。[公开 Python 入口](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentPyImp.cpp)与 [Document 实现](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Document.cpp)分别核对。


## 10. 当前对象与直接标量属性读取

`cad_gui_inspect_document` 已在同一固定宏、进程复验和私有请求管线中接线。每次读取先匹配桥代际、文档打开句柄和两个观察修订；省略对象选择只列对象摘要，指定对象才投影直接标量属性。复杂类型不取值，原生 getter 之间立即复验，失效／缺失对象不发布部分对象清单。此读取本身不保存、重算或修改，但外部工程的 getter 不是 Task 沙箱内的纯文件读取，审批据实声明。

固定官方版本的 `getPropertyByName(name, 2)` 返回 `(实际属性容器, 属性值)`，不能仅凭 `getTypeIdOfProperty` 判断 Link 属性归属；`.pyi` 对 mode 1 的描述与实现不同，因此直接使用 mode 2 核对 Python 对象 `is`。见 [PropertyContainerPyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyContainerPyImp.cpp#L49) 和 [Link.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Link.cpp#L2541)。`App.Units.Quantity(value, current.Unit)` 有 `(double, UnitPy)` 构造，值使用内部基础单位口径；[QuantityPyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Base/QuantityPyImp.cpp#L84)。本机后台真实 Task 另验证 owner、Link 转发、23.5 的单位构造，以及 `Immutable` 字符串状态，作为后续写入依据。

安装版 FreeCAD 1.1.4 的 `getEditorMode` 是字符串列表，`getPropertyStatus` 混合字符串与数字，数字并不一律代表只读；文档没有 `.State`、ViewObject 没有 `ShapeColor`，未按旧文档猜接。读取以明确的 `ReadOnly`／`Immutable` 标志识别不可编辑属性，仅阻止表达式绑定的目标属性，保留 Length 驱动 Width 的形态。Quantity 返回八维单位签名；枚举只读并标明后续需要候选值验证。

同一隔离 GUI 的真实 Task 工具验收通过：默认只列 Box；指定 Box 返回 Length=20 mm、Width=40 mm 及 `Length * 2`、只读整数、不可变字符串、布尔／字符串和枚举值；缺失对象、改变尺寸后的旧修订均拒绝。读取后观察快照和源 FCStd SHA-256 不变，随后既有 undo、touch、重开、同 wrapper clear／restore 回绕仍通过。运行时间约33秒；仅操作自有实例，没有用户现存 GUI／AX 验收。该结果不代表受控写入、保存或撤销已完成。


## 11. 持久属性写入与原生事务

`cad_gui_set_properties` 的固定提供方代码已能实际修改当前活动文档，`cad_gui_operation_status` 仅读持久结果。请求和模型参数不能携带宏路径或源码。GUI 内执行仍不继承 Task OS 沙箱，使用独立 `cad-gui-mutate` 审批；结构化预检检查原生状态、所有者、类型、标志、表达式与预期值，全部通过才开启唯一事务。原生类型及单位已由第10节本机证据核对，枚举和带 Python Proxy 的对象暂不支持该固定写入，完整后台 Python 保持可用。

安装版真实后台 Task 事务探针确认：`getActiveTransaction()` 初始为 None，`setActiveTransaction(name, True)` 返回整数ID，读取活动事务得到 `(name, id)`；此时文档尚无 pending，首项属性改动才创建 pending 及 `UndoNames[0]`。正常 `doc.commitTransaction()` 后全局活动事务为 None、pending 为 False，撤销名保留。回调顺序是 `slotBeforeCloseTransaction(False)`、`slotCommitTransaction(doc)`、`slotCloseTransaction(False)`；commit回调时活动事务已清空，不判成外来事务。正常 Length 赋值会触发多次 Shape 改变，重算还会触发 Shape 与文档重算事件。固定版本源码中的全局事务关闭及其多文档影响见 [Application.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Application.cpp) 和 [Document.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Document.cpp)。

短寿命操作观察器只捕获原始wrapper和primitive参数，不解引用删除对象；正常事务和已确认派生变化允许通过。操作在原生调用之间检查目标、控制文件身份、取消／过期和事务；夹取、意外回调或控制路径丢失即停止后续步骤，保留现场。不会在 finally 盲目 abort／undo，不把全局事务ID当 CAS 锁，不关闭后来出现的事务。`partial` 与 `unknown` 均需查询原操作并检查现场，不能解释为已回滚。

派发与执行各有持久认领，文件写齐和fsync后再用硬链接独占发布；重复宏不覆盖首回执。准备时间不因重启延长，已有认领无回执永不自动重发。只有严格匹配原请求及行为语义的回执才报告成功。FreeCAD提交与磁盘回执落盘之间仍有不可消除的未知窗口，不能宣称最终恰好一次。

本机独立 GUI 的 Task 工具完整链约48秒通过：Length 20→25mm、Width绑定重算为50mm；no-op不增加撤销记录；绑定目标、只读属性及“第一项有效、第二项不可变”的混合批均零写；重建服务和store后同一编号返回原回执，撤销记录未增加，源FCStd SHA-256不变。原生验收未覆盖任意工作台回调、全部FreeCAD属性或用户现存GUI；部分失败、取消、无回执及回执落盘失败另由固定源码与控制器边界测试验证。保存、副本发布和显式撤销仍未交付。
