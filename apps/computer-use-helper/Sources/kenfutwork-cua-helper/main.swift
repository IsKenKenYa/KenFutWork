import Darwin
import Foundation
import HelperCore
import HelperMacOS
import HelperProtocol
import HelperTransport

do {
  let options = try HelperLaunchOptions.parse(
    Array(CommandLine.arguments.dropFirst())
  )
  let identity = HelperPermissionIdentity(
    bundleId: options.bundleId,
    path: options.helperPath,
    teamIdentifier: options.teamIdentifier
  )
  let server = HelperSocketServer(
    configuration: HelperSocketConfiguration(
      socketPath: options.socketPath,
      token: options.token,
      helperBundleId: options.bundleId,
      helperPath: options.helperPath,
      helperVersion: options.helperVersion,
      teamIdentifier: options.teamIdentifier
    ),
    permissionStatus: { probe in
      MacOSPermissionProbe.currentStatus(identity: identity, probe: probe)
    },
    permissionRequest: MacOSPermissionPrompt.request,
    applications: MacOSApplicationCatalog.list,
    windows: MacOSWindowCatalog.list,
    displays: MacOSDisplayCatalog.list,
    accessibilityTree: MacOSAccessibilityTree.read,
    screenshot: { pid, windowId, maxBytes, maxDimension in
      try MacOSWindowCapture.capture(
        pid: pid,
        windowId: windowId,
        maxBytes: maxBytes,
        maxDimension: maxDimension
      )
    },
    input: MacOSInputController(),
    onShutdown: { exit(0) }
  )
  try server.start()
  var signalSources: [DispatchSourceSignal] = []
  for signalNumber in [SIGTERM, SIGINT] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(
      signal: signalNumber,
      queue: DispatchQueue.global(qos: .utility)
    )
    source.setEventHandler {
      unlink(options.socketPath)
      exit(0)
    }
    source.resume()
    signalSources.append(source)
  }
  // 服务端被强杀时没人能发 shutdown；父进程消失后 Helper 自退，避免 TCC 主体变孤儿。
  let parentSource: DispatchSourceTimer? = options.parentPid.map { parentPid in
    let timer = DispatchSource.makeTimerSource(
      queue: DispatchQueue.global(qos: .utility)
    )
    timer.schedule(deadline: .now() + 2, repeating: 2)
    timer.setEventHandler {
      if kill(parentPid, 0) != 0 && errno == ESRCH {
        unlink(options.socketPath)
        exit(0)
      }
    }
    timer.resume()
    return timer
  }
  var lifetime: [Any] = signalSources
  if let parentSource { lifetime.append(parentSource) }
  FileHandle.standardError.write(
    Data(
      "KenFutWork Computer Use Helper 已监听 \(options.socketPath)\n".utf8
    )
  )
  withExtendedLifetime(lifetime) {
    RunLoop.main.run()
  }
  server.stop()
} catch {
  FileHandle.standardError.write(
    Data("KenFutWork Computer Use Helper 启动失败：\(error)\n".utf8)
  )
  exit(2)
}
