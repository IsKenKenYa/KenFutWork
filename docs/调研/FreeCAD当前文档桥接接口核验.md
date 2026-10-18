# FreeCAD 当前文档桥接接口核验

> **角色：调研。** 核验日期：2026-10-18。范围：已安装 FreeCAD 1.1.4 对应官方提交 `4fd3bf320d9566a27e60069fc8387448aaa3a094` 的 GUI 启动、官方本地消息通道、宏与主线程调度及当前文档接口。第2—7节保留最初只读桥调研；后续固定查询、属性读写、副本及显式撤销接线登记在第8—15节。方向与权限仍以[CAD 控制插件规划](../插件/CAD控制插件规划.md)为准。
>
> 资料核验阶段只读取官方资料、源码和既有诊断文件；第6节是旧回执的复核。后续实现与原生验收另行登记，不将源码／API探针与产品整链验收混算。

## 1. 结论与证据层级

FreeCAD 1.1.4 自带的是**本地文件打开通道**，可以请求 GUI 进程执行指定 `.FCMacro` 文件；它不是带请求身份、鉴权、业务 ACK 或取消的 RPC。可以用它加载固定桥，但后续请求身份、结果、去重与授权代际必须由 KFW 桥补齐。官方 Qt 事件循环足以让固定只读查询在 GUI 主线程完成，无须经过 AX。

| 判断 | 证据与范围 |
| --- | --- |
| 官方源码已证实 | `GUISingleApplication` 监听本地消息；`OpenFile:` 经主窗口交给 `App::Application::processFiles()`；宏在该进程 Python 解释器执行。见第 2～4 节。 |
| 已有本机原生证据 | 独立 GUI 实例实际收到宏路径，返回真实 PID／版本／隔离路径；另一固定行为探针完成 13 步、55 断言。见第 6 节；不是产品桥验收。 |
| 本文最初建议 | 独立 endpoint、bootstrap nonce、请求／文档代际、鉴权及回执。见第5节；现行逐次固定宏的接线见第8—15节，尚未建立独立持久endpoint。 |
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

- 持久 `QLocalServer` bridge 尚未实现；逐次固定宏查询／观察／检查／属性写入／副本及显式撤销接线见第8—15节，不能据此声称持久server或任意GUI Python已交付。
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

本机独立 GUI 的 Task 工具完整链约48秒通过：Length 20→25mm、Width绑定重算为50mm；no-op不增加撤销记录；绑定目标、只读属性及“第一项有效、第二项不可变”的混合批均零写；重建服务和store后同一编号返回原回执，撤销记录未增加，源FCStd SHA-256不变。原生验收未覆盖任意工作台回调、全部FreeCAD属性或用户现存GUI；部分失败、取消、无回执及回执落盘失败另由固定源码与控制器边界测试验证。该次验收只覆盖属性写入；后续副本／Task发布及显式撤销接线分别见第13、15节，覆盖保存源文件仍未交付。


## 12. 跨宿主停止与迟到固定宏

冷启动的新CAD service没有旧在途内存，单纯取消当前内存集合会遗漏已持久认领但尚未执行的宏。新增私有记录对账：官方插件停用／卸载／替换／shutdown和宿主dispose扫描无回执记录并持久取消；Run关闭筛原始来源Run。完整终态不改，未发布slot不重建；损坏已发布记录及unsafe路径报stop_unconfirmed，仍尽力取消其它合法记录。旁杂非hash文件不进入或跟随；已知其它Run在定向关闭中跳过，全量撤销仍完整验证。

关闭屏障等待内存取消与持久对账均完成；任一失败都不能由afterStateChanged启用绕过，成功重试全量撤销后才可恢复。此对账本身不连接FreeCAD、不重发，也不把“取消标记已持久化”称为已回滚或已中断当前原生函数。

真实隔离GUI回归复用生产固定宏builder：制造旧宿主claim后无内存调用的持久记录，创建新service并停用，再让同一固定宏迟到进入官方socket。回执为rejected/cancelled且mutationStarted=false，实际Length仍25mm、表达式Width仍50mm、撤销记录与源FCStd SHA-256不变。随后启用仅读原状态，不重发。该场景模拟旧宿主消失，不声称做过任意时刻真实系统崩溃注入；GUI迟到执行是真实工具路径，独立实例全链约52秒通过。

## 13. GUI 副本与 Task 新文件发布

`cad_gui_copy_document` 复用固定宏、现有观察器及持久操作记录，显式选择的目标可以不是活动文档。GUI 只向本次私有操作目录的 `document.FCStd` 调用 `saveCopy`；模型的 `outputPath` 只供后续 Task 发布，不进入 GUI 保存路径。工具不调用源文件保存、重算、清除修改状态或事务关闭 API。FreeCAD 序列化可能执行文档 provider，因此沿独立 GUI 执行审批，不能称为 Task OS 沙箱内的文件复制；不整对象拒绝 Python Proxy，意外可观察改变则报告 `partial` 并保留现场。

官方 `saveCopy` 返回 None，且相同文件名可能不写入，返回值或保存事件均不足以证明副本成功。实现复验新文件为稳定常规文件而非符号链接，流式校验完整 ZIP／CRC、`Document.xml`／`GuiDocument.xml`、SHA-256 与大小；不套固定工作区字节预算。几何检查不在此时重算源文档，touched 或错误模型可以按原貌复制；后续可由 `cad_describe_document` 在 Task 沙箱中打开发布文件作独立几何检查。源码见固定版本 [DocumentPyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentPyImp.cpp) 与 [Document.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Document.cpp)。

链接检查不能以空的 `doc.InList`／`OutList` 或 `getDependentDocuments(False)` 证明无依赖；这些视图只覆盖已加载且经标志筛选的关系。固定检查逐属性使用 `App.Base.TypeId.fromName(typeId)`／`isDerivedFrom(str)`，只对 `App::PropertyXLink`、`App::PropertyXLinkSubList`、`App::PropertyXLinkContainer` 的派生属性调用 `dumpPropertyContent(name, Compression=0)`，不 dump Shape。ExpressionEngine、Spreadsheet 属性也在继承范围内，不能只按名称前缀识别。转储为含 `Persistence.xml` 的 ZIP，根为 Content；本地表达式没有 XLinks 也合法。API 与继承依据分别见 [TypePyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Base/TypePyImp.cpp)、[PropertyContainerPyImp.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyContainerPyImp.cpp#L516) 和 [PropertyLinks.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyLinks.cpp)。

`XLink file=''` 是 owner 自己文档内的引用，name 非空但对象未解析仍属本地状态，不因它自动拒绝复制。非空 file 在目标关闭、getter 为 None 后仍保留，须据此识别外链。XLinks 的 count 只数 XLink 子项，可附 DocMap 元数据；数量或结构无法解释时明确拒绝。官方导出态另有省略 file 的分支，当前固定快照不把这种未确认状态当作“无外链”。相对 file 以 owner 工程真实文件所在目录解析（先解析工程文件自身的符号链接），https 保持 URI，不拼成本地相对路径。对应原生实现见 [本地恢复语义](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyLinks.cpp#L4261)、[导出态分支](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyLinks.cpp#L4149)、[XLinks 保存](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyLinks.cpp#L5771)及 [DocInfo 路径](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyLinks.cpp#L3317)。首期也扫描其它打开文档的此类属性以补充隐藏引用者；目标尚无文件名、URI 或未知结构导致归属无法确认时拒绝，不将空的已加载关系当作完整证明。

安装版 FreeCAD 1.1.4 的后台真实 Task 已核对上述 TypeId、bytearray 转储、本地／未设值 Link、关闭目标后仍保留的外链 file，以及 Undo／Redo 名称、计数、模式和 Gui 编辑／事务字段。该 API 探针不是副本产品工具验收。保存前后复验打开身份、活动文档、FileName／Label／UID、Modified／touched、原生状态及 Undo／Redo 历史摘要；完整历史名称不写进回执。`statePreserved` 仅表示这些已观察状态保持，不能包装成完整内容 CAS。

`copied` 仅表示私有 FCStd 与原生回执已经验证；宿主还须按当前 Task 目录权限、授权代际及停止状态，把相同大小／SHA-256 的稳定字节作为新文件发布，确认后才是 `published`。既有输出拒绝覆盖；副本生成与 Task 发布分别持久认领并对账。`cad_gui_operation_status` 只查询原编号，不连接 FreeCAD或发布文件。已认领无可信回执、复制完成但发布未确认等窗口保留 `unknown`；不重发、不换新编号掩盖未知，也不靠撤销／关闭用户文档伪造取消。请求、回执和私有副本保留见《隐私政策》§4.2；具体请求／回执契约以 [gui-document-copy-contracts.ts](../../apps/server/src/features/cad/gui-document-copy-contracts.ts) 为准。

本批第二轮真实独立 GUI 整链约67.64秒通过：GUI 内存模型的12500 mm³副本经固定工具发布到Task，后台 `cad_describe_document` 读回；再用后台 Python 改 Height=15，得到18750 mm³并导出 STEP。源 GUI 状态、Undo／Redo、活动文档及源 FCStd SHA-256保持，未保存文档复制后 FileName仍空；其它打开文档有pending时拒绝，同编号重放与状态查询一致。首轮体积断言遇到12500与12499.999999999996的浮点差异，改用容差后完成第二轮复验。

该整链只操作自有隔离实例，没有用户现存GUI／AX、任意provider或全部工作台保存的验收。预检拒绝、坏副本、原生状态改变、持久重放及未知窗口另由固定源码、控制器和发布边界测试覆盖；这些层级各自保留，不把API探针替代产品工具链。正式证据与遗留项由《日志》记账。


## 14. 自身事务归属与显式撤销前提

成功的 `cad_gui_set_properties` 可选回传 `undoProvenance`：KFW 自己生成的准确随机事务名，以及 Undo／Redo 名称列表的项数和 SHA-256。只有原生栈顶确为该事务、计数与名称长度一致、原生／GUI 非忙碌、提交后快照可靠且读取期间观察修订未推进时才记录；回执不包含完整用户历史名。宿主还匹配原请求的桥代际、打开句柄及两项观察修订不倒退。历史或快照不可确认时不签归属，仍保留原生实际 committed；旧无字段回执继续可查。事务名称不是权限令牌；这些观察记录不提供完整内容 CAS，也不授予撤销权限。

原生 Python `App.Document.undo()` 不接事务 ID，返回 None；底层遇到 pending 会先提交 pending，调用方不能把它当作“只撤销指定事务”的安全原语。GUI `Document::undo()`／`Std_Undo` 还会按内部事务 ID 扫描其它文档，可能连带撤销或弹窗。正式固定工具直接使用 App 文档入口，观察 `slotUndoDocument(doc)` 并核对实际恢复，而不等待 GUI 层才发的无参 `slotUndo()`。依据固定版本 [Python 绑定](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentPyImp.cpp#L601)、[原生撤销](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Document.cpp)及 [GUI 跨文档分派](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/Document.cpp#L2866)。

本节的归属证据与原生夹具不单独授予撤销权限；正式工具的接线及真实 Task 验收另见第15节。原生接口与固定观察器都不提供强内容 CAS，不能把一次成功探针扩大成任意工作台回调下安全撤销。


本批独立 LaunchServices GUI 与 Task 工具整链约70.16秒通过：修改回执的随机事务名、历史项数／摘要与原生 Undo／Redo 栈一致；自有夹具直接调用无参数 App `doc.undo()`，收到 `slotUndoDocument(doc)`，Length／表达式宽度恢复20／40mm，真实 Shape 体积恢复8000mm³，原名称移入 Redo 栈顶。随后原生 redo 恢复25／50mm与12500mm³，原历史列表恢复，另一打开文档的状态和历史保持。固定观察器计数随此次回绕推进，即使值与历史再相同也不会重用原完成快照。后续副本→Task→后台修改／STEP链继续通过，源FCStd SHA-256不变，自有实例正常退出。此处 undo／redo 来自专用夹具，不是已暴露的产品撤销工具。

## 15. 显式撤销自身已提交属性操作

`cad_gui_undo_operation` 已接到共享 CAD 工具、Service／Provider、持久控制器及独立 `cad-gui-undo` 执行审批。新 `operationId` 引用同一实例／Task 的 `sourceOperationId`，宿主只从可信持久记录取得原 committed 请求、回执、`undoProvenance` 和提交后 snapshot，并冻结到本次请求；模型不能提供证明、事务名、代码或私有路径。新 Run 按当前 Task 的 scope／branch 代际和权限准入；原操作可以来自历史代际，其记录仅证明历史归属，不为当前操作授予权限。

应用身份沿用原操作，桥代际、打开句柄和两个预期修订严格匹配原提交 snapshot。新的 inspect 不能刷新已经变化的原撤销前提。预检还匹配准确事务栈顶、Undo／Redo 摘要、当前属性与原 observed 值，拒绝后来事务、同名重开、待提交事务、编辑或恢复态。会检查外部引用方及无法确认的引用关系，不因目标只有向外依赖就一刀切；隐藏表达式可在源属性变化时直接写入引用方，不能由空 InList 推断无影响。此边界来自 [PropertyExpressionEngine 的变化订阅与赋值](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/PropertyExpressionEngine.cpp#L230)，不是套用 saveCopy 的保存通知副作用。

固定宏在主线程只调用一次无参数 App `doc.undo()`，不调用 recompute、redo、保存、关闭或事务补偿。原生 apply 期间会为 Redo 建立临时 pending，此时 Transacting／HasPendingTransaction 可为 true；调用前后仍须确认无用户 pending，并核对目标 `slotUndoDocument`、原 before 值及完整历史迁移。属性恢复顺序不固定，原生 Paste 的部分异常还可能被内部捕获，因此事件或 None 返回值都不单独证明成功。成功回执为 `undone`；partial 保留现场，不自动 redo／保存或关闭用户事务。取消不能中断已经开始的原生 undo，原生操作和回执也不是原子事务。

同编号终态重放只使用本次冻结请求和可信回执，不依赖原修改记录、原 GUI 或新的来源读取；新编号仍须重新通过全部前提。认领后没有可信回执时保持 unknown，不重发；停止或结果未知先查原编号，不通过更换编号或重新 inspect 绕过。请求与实际撤销值、历史摘要的留存见《隐私政策》§4.2，契约见 [gui-undo-contracts.ts](../../apps/server/src/features/cad/gui-undo-contracts.ts)。

本批独立 LaunchServices GUI 的真实 Task 工具整链约89.52秒通过：正式工具将 Length=26 与已改 Note 的批次恢复至25及原 Note，Width 绑定恢复50，真实 Shape 体积恢复12500mm³；工具本身没有额外重算。删除原修改记录后重建 service／store，同一撤销编号仍返回冻结 ACK；直接重复原宏不再执行第二次 undo。后来事务、改用刷新后的目标和其它文档 pending 均拒绝，后来事务的值／历史及用户 pending 保留。源 FCStd SHA-256 不变，既有副本→Task→后台修改／STEP链继续通过。

上述证据只覆盖该隔离实例和代表性多属性操作，没有操作用户现存 GUI／AX，也不代表全部属性、工作台、原生回调或任意撤销均已验收。固定源码、控制器及工具消费方的边界回归与原生场景有重叠，不相加；本批最终全仓门禁由《日志》单独记账。

## 16. 显式保存前置核验

**覆盖保存当前 GUI 文档的源 FCStd 尚未交付。** 第13节的私有 `saveCopy` 与 Task 新文件发布不覆盖原位保存；本节记录固定版本源码和现有宿主边界，以及后续保存切片需要补齐的最小接线。第16.5节是独立 GUI 内自有文档的原生 API 探针，不代表产品保存工具已接线。

### 16.1 原生保存的三个完成边界

`doc.save()`／`doc.saveAs(path)` 是同步调用，但**原生方法完成、目标文件实际写入／替换、KFW 持久回执发布是三个边界**。调用返回 None、收到某个保存事件或方法抛异常，都不能单独推导文件未写入、已经可靠保存或可以重试。以下事实来自固定版本 [App 保存实现](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/Document.cpp#L1700)与 [Python 绑定](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/DocumentPyImp.cpp#L124)。

| 已核验行为 | 保存接线的含义 |
| --- | --- |
| Python `save()`、`saveAs()` 成功均返回 None；`save()` 检查底层 bool 与文件可读，`saveAs()` 忽略底层 bool。 | 返回值不是文件完成证明，两种入口的失败语义也不能合并。 |
| C++ `save()` 遇到 PartialDoc 直接返回 true，不写文件。`isSaved()` 只判断 FileName 非空。 | 保存前须识别并拒绝 PartialDoc；已有文件名不证明当前内存已经保存。 |
| IO 前会更新 TipName、LastModifiedDate，并按设置更新 LastModifiedBy。 | 保存失败也可能已有内存元数据变化，不能按异常盲目恢复旧值。 |
| `saveAs()` 在 IO 前改 FileName、Label，再 `Uid.touch()` 触发临时目录迁移，没有生成新的 UID。 | 失败可能保留新身份；另存为不是只更换一个磁盘目标，不能隐含在原位保存权限中。 |
| App save 不主动重算、purgeTouched、commit／abort 或清除事务历史。 | 不能为了“保存成功”额外做这些操作；provider 与保存通知的影响仍需验证。 |
| App 保存路径没有清除 Gui.Modified；GUI 保存流程在 App 调用之后另行 `setModified(false)`。 | 原生保存与 GUI 脏状态分别观察，不能把 App 返回当成清脏授权或清脏完成。 |

同步 IO 顺序是：StartSave 通知 → 规范化目标、创建父目录并检查可写性 → 写 ZIP／Document.xml／GUI 数据及附属文件 → C++ `App.signalSaveDocument` → ZipWriter 析构关闭 ZIP 与文件流 → 按备份策略处理旧文件并把临时文件 rename 到目标 → FinishSave 通知 → 方法返回。`App.signalSaveDocument` 发出时 ZIP writer 尚未离开作用域，最终替换也尚未完成；FinishSave 在替换之后，但没有与之对应的独立失败完成通知。见 [ZIP 关闭](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Base/Writer.cpp#L359)和 [GUI 保存后清脏](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/Gui/Document.cpp#L1670)。

备份策略也不是整个保存过程的原子事务：关闭 BackupPolicy 时直接写目标，失败可能留下已截断或不完整文件；启用时先写 `目标.UUID`，再移动／删除旧文件及替换目标。时间戳策略可能在**目标已经替换完成后**，因备份清理失败抛出 `Save complete, but error while managing backup history`。因此异常不能标为零写入，也不能触发自动重试、恢复旧元数据或盲目覆盖补偿。见 [BackupPolicy.cpp](https://github.com/FreeCAD/FreeCAD/blob/4fd3bf320d9566a27e60069fc8387448aaa3a094/src/App/BackupPolicy.cpp)。已核验路径中未见文件／目录 fsync；FinishSave 只表示这条同步应用流程走完，不提供断电持久性保证，也不等于 KFW 回执已落盘。

保存通知可能触碰引用方 Comment；`saveAs()` 改路径后还可能重建引用路径。App save 不自动保存全部依赖文档，GUI 保存流程另有依赖遍历。后续固定保存必须按实际调用的 App 路径核对这些影响，不能拿 `saveCopy` 的检查或 GUI 菜单行为替代。

### 16.2 当前 Task 权限、停止与恢复边界

现有 Scope 的 `resolvePath()` 在真实路径解析前后都重新加载持久授权，拒绝分支改变及非 ready 的普通操作；保存目标仍需按当前 Task／Run 的真实权限和代际校验，历史文档路径或旧操作归属不能代替当前写权限。见 [scope-service.ts 的 resolvePath 与 load](../../apps/server/src/features/execution/scope-service.ts)。但外部 FreeCAD 不继承 Task OS 沙箱，对目标路径的宿主校验不能声称约束了 GUI／provider 的所有 IO 副作用。

| 现有机制 | 能保证的范围与缺口 |
| --- | --- |
| [runFileOperation](../../apps/server/src/features/code-tools/file-operations.ts) 在回调启动前登记 active，回调 Promise 的 `finally` 才删除。 | abort 本身不会释放仍在执行的回调；但回调返回 unknown 或抛错就会释放，即使外部 GUI 仍可能写入。`revokeTaskFileOperations()` 使用 `Promise.allSettled`，不会保留回调拒绝所表达的外部停止未知。 |
| 同文件的 active、revoking、restoreBarriers、restorePermits 是模块内 Map／Set／WeakMap。 | 它们不是持久记录，服务重建后不存在；当前 [ScopedFilesystemScope](../../apps/server/src/features/execution/scoped-filesystem.ts) 也没有持久外部写域登记接口。 |
| 文件恢复屏障拒绝其他 Task 的相交 active 写域，同 Task 由调用方另行 drain。 | [applyFileRewind](../../apps/server/src/features/code-ui/file-rewind.ts) 关闭进程、撤销文件操作并检查 active 后才写恢复文件，但成功或异常最终都会释放临时文件／进程屏障。仅把 GUI 保存包在一个会提前结束的 Node 回调里不足以保护恢复。 |
| [进程恢复协调器](../../apps/server/src/features/process-sandbox/restore-barrier.ts) 只在可信 `exit.rangeEmpty` 后移除受管进程写域；不确认退出时保留。 | 该机制明确不宣称管理外部 shell／editor。加载宏的 helper 退出，不证明外部 FreeCAD 原生保存已停止。 |
| [Scope repository](../../apps/server/src/features/execution/scope-repository.ts) 持久保存 revoking／failed 与代际，所有 `onRevoke` 成功后才转 ready。 | 此状态能阻止本 Task 新操作，但不是跨 Task 的目录写域 fence，不能阻止其他 Task 对相交目录恢复。 |

CAD 现有 [持久操作 store](../../apps/server/src/features/cad/gui-operation-store.ts) 能保留 dispatched／executing／unknown 并阻止重发，但尚未接到 Task 文件恢复的相交写域检查。`cancelPending()` 对无回执请求持久写取消 marker；marker 仅供尚未进入原生调用的固定宏检查，**不是外部 GUI 已停止、保存已中断或已经回滚的证明**。dispatched／executing 即使已有取消 marker，仍可能是 unknown。当前 store 对账无法核验记录时会报 `stop_unconfirmed`，也不能反向把“取消 marker 写入成功”当作原生停止确认。

### 16.3 后续保存切片的最小接线建议

本节建议只连接 CAD 外部保存与既有文件操作／Task 生命周期，不扩展通用 Harness，不新增 ctx key，也不把用户 GUI 变成受管子进程。

1. **在既有 CAD durable operation record 中保存写域事实。** 冻结 canonical 目标与当前 Task／scope／branch 绑定，在派发保存宏之前建立持久外部写域 fence。原生保存开始后，取消、超时、缺失／非法 ACK、回调结束和服务重建均不解除；只有可信的“尚未开始写入”或“写入已经结束”事实才能解除。业务保存失败与写入是否仍在进行分别判断，不能因备份异常自动推导仍未写入或安全重试。
2. **让现有文件操作管理器看见这份写域。** 增加有限的外部写域参与者注册口，由 CAD plugin 注册，事实仍读取既有 store。保存写域准入与恢复屏障安装共用原子准入步骤，覆盖检查后派发竞态；相交目录检查跨 Task 生效。临时恢复 lease 的 finally 清理不能删除或掩盖尚未确认结束的持久外部写域。
3. **复用现有撤销与关闭扩展点。** `executionScopes.onRevoke` 和 [task-before-process-close](../../apps/server/src/features/task-work/close-resources.ts) 请求持久取消并核对外部写入结束；unknown 必须拒绝报告关闭成功，让现有 Task revoking／failed 纪律继续生效。不能只等待 Node helper、只等当前回调或只写取消 marker。服务重建后先恢复未确认写域，再开放保存工具与恢复准入。
4. **沿同一 operationId 对账。** 原生文件写入／替换与 KFW 回执无法组成一个原子事务。原生已完成但回执未发布时保持 unknown，状态查询只读原编号；不重发、不换编号、不通过清 Modified、undo、改回 FileName／Label 或覆盖旧文件伪造取消和补偿。

### 16.4 保存实现前仍需取得的原生证据

- 正常 `save()` 与首次 `saveAs()`：核对实际文件、重开参数及 GUI 数据，并分别记录 FileName／Label／Uid／TransientDir、保存元数据、Modified／touched、事务／历史、通知顺序与实际扩展名。
- 失败分界：不可写目标、序列化失败、备份处理失败；检查目标／临时文件／备份及内存身份，覆盖“目标已替换但方法抛异常”，不得只断言工具报错。
- 引用与回执窗口：用自有链接文档核对 Comment／路径副作用；原生完成后阻断回执发布，确认同编号保留 unknown 且不再次保存；同时验证停止、服务重建与相交 Task 恢复不会越过未确认外部写域。

这些是后续切片的验收前置条件；下节只覆盖其中的代表性原生行为，不替代完整矩阵。

### 16.5 隔离 GUI 原生保存探针

复用独立 LaunchServices 实例和主线程诊断夹具，新增自有文档核验 `saveAs` 首次保存、改尺寸后 `save`、坏父路径的 `saveAs` 失败，再关闭重开已保存文件。成功调用返回 None，Start／Finish 顺序成对；实际 ZIP／CRC 包含 Document.xml 与 GuiDocument.xml。UID 保持，保存不清 GUI Modified；首次保存前主动 touch 的状态和 Undo／Redo 历史保留，第二次保存后历史也保持。重开得到 Height=13mm、真实体积约1300mm³。

失败目标的父路径为常规文件。安装版抛 FreeCADError，目标不存在，但 FileName 已改成失败目标，Label 已改成其文件名；记录只有 Start、没有本次 Finish。原已成功保存的文件仍可重开到 Height=13mm。因此不能把此异常解释成“内存身份未改变”，也不能用 FileName 或保存开始事件判定成功。该场景不覆盖序列化失败、备份替换后异常、跨文档保存通知副作用、断电或 KFW 回执丢失。

首轮原生断言已完成，但 TS 将1299.9999999999995与1300精确比较而失败；改为几何容差后，同一 GUI 整链90.79秒通过，并确认自有实例正常退出。既有属性写入、副本发布、后台接力、显式撤销与源FCStd SHA-256保护同时通过；结果有重叠，不相加。此处直接原生保存来自专用夹具 [gui-native-save.py](../../apps/server/src/features/cad/fixtures/gui-native-save.py)，不是暴露给Agent的新工具，也不证明现有Task停止／恢复屏障已覆盖外部GUI写入。没有用户现存GUI／AX操作，没有继续崩溃根因调查。
