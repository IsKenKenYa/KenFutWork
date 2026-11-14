import AppKit
import HelperProtocol

public enum MacOSApplicationCatalog {
  /// 只列出用户可激活的应用；后台代理（prohibited）不可作为桌面操作目标。
  public static func list() -> ComputerUseHelperApplicationsResult {
    let applications = NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy != .prohibited }
      .compactMap { application -> ComputerUseHelperApplication? in
        guard application.processIdentifier > 0 else { return nil }
        let name =
          application.localizedName
          ?? application.bundleIdentifier
          ?? "pid \(application.processIdentifier)"
        return ComputerUseHelperApplication(
          pid: Int(application.processIdentifier),
          name: name,
          bundleId: application.bundleIdentifier,
          path: application.bundleURL?.path,
          active: application.isActive,
          hidden: application.isHidden
        )
      }
      .sorted { left, right in
        if left.active != right.active { return left.active }
        return left.name.localizedStandardCompare(right.name) == .orderedAscending
      }
    return ComputerUseHelperApplicationsResult(applications: applications)
  }
}
