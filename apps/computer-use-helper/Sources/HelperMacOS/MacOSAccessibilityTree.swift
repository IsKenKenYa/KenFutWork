import ApplicationServices
import CoreGraphics
import Foundation
import HelperProtocol

public enum MacOSAccessibilityTree {
  /// 读取应用的 AX 树。遍历有节点数、深度、子节点数和文本长度上限；
  /// 安全输入框的值一律不采集，避免把密码送进模型上下文。
  public static func read(
    pid: Int,
    limits: ComputerUseHelperAxTreeLimits
  ) throws -> ComputerUseHelperAxTreeResult {
    guard AXIsProcessTrusted() else {
      throw HelperOperationError(
        code: "permission_denied",
        message: "辅助功能未授权，无法读取 AX 树"
      )
    }
    guard pid > 0, pid <= Int(Int32.max) else {
      throw HelperOperationError(
        code: "invalid_request",
        message: "AX 树需要合法的进程号"
      )
    }
    let application = AXUIElementCreateApplication(pid_t(pid))
    AXUIElementSetMessagingTimeout(
      application,
      Float(limits.timeoutMs) / 1_000
    )
    guard attribute(application, kAXRoleAttribute) != nil else {
      throw HelperOperationError(
        code: "application_not_found",
        message: "目标应用不存在或未提供 AX 接口"
      )
    }

    let builder = Builder(limits: limits)
    guard
      let root = builder.build(
        element: application,
        depth: 0,
        visited: Set()
      )
    else {
      throw HelperOperationError(
        code: "ax_tree_unavailable",
        message: "目标应用没有可读取的 AX 根节点"
      )
    }
    return ComputerUseHelperAxTreeResult(
      pid: pid,
      root: root,
      nodeCount: builder.nodeCount,
      truncated: builder.truncated
    )
  }

  private final class Builder {
    private let limits: ComputerUseHelperAxTreeLimits
    private(set) var nodeCount = 0
    private(set) var truncated = false

    init(limits: ComputerUseHelperAxTreeLimits) {
      self.limits = limits
    }

    func build(
      element: AXUIElement,
      depth: Int,
      visited: Set<CFHashCode>
    ) -> ComputerUseHelperAxNode? {
      guard nodeCount < limits.maxNodes else {
        truncated = true
        return nil
      }
      let identity = CFHash(element)
      guard !visited.contains(identity) else {
        truncated = true
        return nil
      }
      nodeCount += 1

      let subrole = string(element, kAXSubroleAttribute)
      let secure = subrole == "AXSecureTextField"
      let title = truncatedString(
        string(element, kAXTitleAttribute),
        limit: limits.titleMaxChars
      )
      let value =
        secure
        ? nil
        : truncatedString(
          string(element, kAXValueAttribute),
          limit: limits.valueMaxChars
        )
      let description = truncatedString(
        string(element, kAXDescriptionAttribute),
        limit: limits.titleMaxChars
      )
      let identifier = truncatedString(
        string(element, kAXIdentifierAttribute),
        limit: limits.titleMaxChars
      )
      let actions = actionNames(element, limit: limits.maxActions)

      var children: [ComputerUseHelperAxNode]? = nil
      if depth < limits.maxDepth {
        let rawChildren = elements(element, kAXChildrenAttribute)
        if rawChildren.count > limits.maxChildren {
          truncated = true
        }
        var nextVisited = visited
        nextVisited.insert(identity)
        var collected: [ComputerUseHelperAxNode] = []
        for child in rawChildren.prefix(limits.maxChildren) {
          if let node = build(
            element: child,
            depth: depth + 1,
            visited: nextVisited
          ) {
            collected.append(node)
          }
          if nodeCount >= limits.maxNodes {
            truncated = true
            break
          }
        }
        children = collected
      } else if !elements(element, kAXChildrenAttribute).isEmpty {
        truncated = true
      }

      return ComputerUseHelperAxNode(
        role: string(element, kAXRoleAttribute) ?? "AXUnknown",
        subrole: subrole,
        title: title,
        value: value,
        description: description,
        identifier: identifier,
        enabled: boolean(element, kAXEnabledAttribute),
        focused: boolean(element, kAXFocusedAttribute),
        position: point(element, kAXPositionAttribute),
        size: size(element, kAXSizeAttribute),
        actions: actions,
        children: children
      )
    }
  }

  private static func attribute(
    _ element: AXUIElement,
    _ name: String
  ) -> CFTypeRef? {
    var value: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, name as CFString, &value)
        == .success
    else { return nil }
    return value
  }

  private static func string(_ element: AXUIElement, _ name: String) -> String? {
    attribute(element, name) as? String
  }

  private static func boolean(
    _ element: AXUIElement,
    _ name: String
  ) -> Bool? {
    (attribute(element, name) as? NSNumber)?.boolValue
  }

  private static func elements(
    _ element: AXUIElement,
    _ name: String
  ) -> [AXUIElement] {
    attribute(element, name) as? [AXUIElement] ?? []
  }

  private static func actionNames(
    _ element: AXUIElement,
    limit: Int
  ) -> [String]? {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else {
      return nil
    }
    return (names as? [String])?.prefix(limit).map { $0 }
  }

  private static func point(
    _ element: AXUIElement,
    _ name: String
  ) -> ComputerUseHelperPoint? {
    guard
      let raw = attribute(element, name),
      CFGetTypeID(raw) == AXValueGetTypeID()
    else { return nil }
    let value = unsafeBitCast(raw, to: AXValue.self)
    var point = CGPoint.zero
    guard AXValueGetValue(value, .cgPoint, &point) else { return nil }
    return ComputerUseHelperPoint(x: point.x, y: point.y)
  }

  private static func size(
    _ element: AXUIElement,
    _ name: String
  ) -> ComputerUseHelperSize? {
    guard
      let raw = attribute(element, name),
      CFGetTypeID(raw) == AXValueGetTypeID()
    else { return nil }
    let value = unsafeBitCast(raw, to: AXValue.self)
    var size = CGSize.zero
    guard AXValueGetValue(value, .cgSize, &size) else { return nil }
    return ComputerUseHelperSize(width: size.width, height: size.height)
  }

  private static func truncatedString(
    _ value: String?,
    limit: Int
  ) -> String? {
    guard let value else { return nil }
    if value.count <= limit { return value }
    return String(value.prefix(limit))
  }
}
