import Foundation

public enum HelperLaunchOptionsError: Error, Equatable, LocalizedError {
  case missingValue(String)
  case missingArgument(String)
  case invalidArgument(String, String)
  case unknownArgument(String)

  public var errorDescription: String? {
    switch self {
    case .missingValue(let flag):
      return "\(flag) 缺少参数值"
    case .missingArgument(let flag):
      return "缺少启动参数 \(flag)"
    case .invalidArgument(let flag, let reason):
      return "\(flag) 参数无效：\(reason)"
    case .unknownArgument(let flag):
      return "未知启动参数 \(flag)"
    }
  }
}

public struct HelperLaunchOptions: Equatable, Sendable {
  public let socketPath: String
  public let token: String
  public let bundleId: String
  public let helperPath: String
  public let helperVersion: String
  public let teamIdentifier: String?
  public let parentPid: Int32?

  public init(
    socketPath: String,
    token: String,
    bundleId: String,
    helperPath: String,
    helperVersion: String,
    teamIdentifier: String?,
    parentPid: Int32? = nil
  ) {
    self.socketPath = socketPath
    self.token = token
    self.bundleId = bundleId
    self.helperPath = helperPath
    self.helperVersion = helperVersion
    self.teamIdentifier = teamIdentifier
    self.parentPid = parentPid
  }

  public static func parse(_ arguments: [String]) throws -> HelperLaunchOptions {
    let allowed = Set([
      "--socket",
      "--token",
      "--bundle-id",
      "--helper-path",
      "--version",
      "--team-id",
      "--parent-pid",
    ])
    var values: [String: String] = [:]
    var index = 0
    while index < arguments.count {
      let flag = arguments[index]
      guard allowed.contains(flag) else {
        throw HelperLaunchOptionsError.unknownArgument(flag)
      }
      guard index + 1 < arguments.count else {
        throw HelperLaunchOptionsError.missingValue(flag)
      }
      values[flag] = arguments[index + 1]
      index += 2
    }

    func required(_ flag: String) throws -> String {
      guard let value = values[flag], !value.isEmpty else {
        throw HelperLaunchOptionsError.missingArgument(flag)
      }
      return value
    }

    let socketPath = try required("--socket")
    let token = try required("--token")
    guard token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    else {
      throw HelperLaunchOptionsError.invalidArgument(
        "--token",
        "必须是 64 位小写十六进制字符串"
      )
    }
    let bundleId = try required("--bundle-id")
    let helperPath = try required("--helper-path")
    guard helperPath.hasPrefix("/") else {
      throw HelperLaunchOptionsError.invalidArgument(
        "--helper-path",
        "必须是绝对路径"
      )
    }
    let helperVersion = try required("--version")
    let teamIdentifier: String?
    if let team = values["--team-id"] {
      guard !team.isEmpty else {
        throw HelperLaunchOptionsError.invalidArgument(
          "--team-id",
          "不能为空"
        )
      }
      teamIdentifier = team
    } else {
      teamIdentifier = nil
    }

    let parentPid: Int32?
    if let rawParent = values["--parent-pid"] {
      guard let parsed = Int32(rawParent), parsed > 0 else {
        throw HelperLaunchOptionsError.invalidArgument(
          "--parent-pid",
          "必须是正整数"
        )
      }
      parentPid = parsed
    } else {
      parentPid = nil
    }

    return HelperLaunchOptions(
      socketPath: socketPath,
      token: token,
      bundleId: bundleId,
      helperPath: helperPath,
      helperVersion: helperVersion,
      teamIdentifier: teamIdentifier,
      parentPid: parentPid
    )
  }
}
