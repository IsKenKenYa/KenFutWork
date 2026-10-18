import { CAD_GUI_PROCESS_IDENTITY_SOURCE } from "./gui-process-identity-source.js";

/** 固定 stdlib 客户端；不执行输入源码，不读取文档，不启动或激活 FreeCAD。 */
export const FREECAD_GUI_TRANSPORT_SOURCE =
  CAD_GUI_PROCESS_IDENTITY_SOURCE +
  String.raw`
import json
import math
import os
import socket
import stat
import struct
import sys
import time

MAX_REQUEST_BYTES = 262144
may_have_sent = False


def emit(ok, action_sent, code=None):
    result = {"ok": ok, "actionSent": action_sent}
    if code is not None:
        result["code"] = code
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def valid_path(value):
    return (isinstance(value, str) and os.path.isabs(value)
            and not any(char in value for char in ("\0", "\r", "\n")))


def valid_application(application):
    if (not isinstance(application, dict)
            or set(application) != {"pid", "bundleId", "name", "executablePath", "bundlePath", "launchedAt", "birth"}
            or type(application["pid"]) is not int or not 2 <= application["pid"] <= 2147483647
            or application["bundleId"] != "org.freecad.FreeCAD"
            or not isinstance(application["name"], str)
            or not valid_path(application["executablePath"])
            or not valid_path(application["bundlePath"])
            or type(application["launchedAt"]) not in (int, float)
            or not math.isfinite(application["launchedAt"]) or application["launchedAt"] <= 0):
        return False
    birth = application["birth"]
    return (isinstance(birth, dict) and set(birth) == {"startSeconds", "startMicroseconds"}
            and type(birth["startSeconds"]) is int and 0 < birth["startSeconds"] <= 9007199254740991
            and type(birth["startMicroseconds"]) is int and 0 <= birth["startMicroseconds"] < 1000000)


def main():
    global may_have_sent
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        emit(False, False, "invalid_request")
        return
    request = json.loads(raw)
    if (not isinstance(request, dict)
            or set(request) != {"application", "macroPath", "socketPaths", "timeoutMs"}
            or not valid_application(request["application"])
            or not valid_path(request["macroPath"])
            or type(request["timeoutMs"]) is not int or request["timeoutMs"] <= 0
            or not isinstance(request["socketPaths"], list)
            or not request["socketPaths"]
            or any(not valid_path(path) or os.path.basename(path) != "FreeCAD"
                   for path in request["socketPaths"])):
        emit(False, False, "invalid_request")
        return
    application = request["application"]
    deadline = time.monotonic() + request["timeoutMs"] / 1000.0
    message = ("OpenFile:" + request["macroPath"] + "\n").encode("utf-8")
    for path in request["socketPaths"]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            before = os.lstat(path)
        except FileNotFoundError:
            continue
        except OSError:
            emit(False, False, "socket_invalid")
            return
        if not stat.S_ISSOCK(before.st_mode) or before.st_uid != os.getuid():
            emit(False, False, "socket_invalid")
            return
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(remaining)
            try:
                connection.connect(path)
            except OSError:
                # 尚未发送任何消息，可以尝试其它已发现候选。
                continue
            try:
                peer = connection.getsockopt(0, 0x002, struct.calcsize("=i"))
                peer_pid = struct.unpack("=i", peer)[0]
            except (OSError, struct.error):
                emit(False, False, "peer_unavailable")
                return
            if peer_pid != application["pid"]:
                emit(False, False, "peer_mismatch")
                return
            try:
                current = os.lstat(path)
            except OSError:
                emit(False, False, "socket_invalid")
                return
            if (not stat.S_ISSOCK(current.st_mode) or current.st_uid != os.getuid()
                    or current.st_dev != before.st_dev or current.st_ino != before.st_ino):
                emit(False, False, "socket_invalid")
                return
            # 连接仍由本次请求持有：出生时间和可执行路径必须精确匹配原身份。
            try:
                identity = read_process_identity(peer_pid)
            except Exception:
                emit(False, False, "identity_unavailable")
                return
            if (identity["birth"] != application["birth"]
                    or identity["executablePath"] != application["executablePath"]):
                emit(False, False, "identity_changed")
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                emit(False, False, "socket_unavailable")
                return
            connection.settimeout(remaining)
            # 只在这个已经验证 peer PID 的连接上发送。此后任何失败均不得重试。
            may_have_sent = True
            try:
                connection.sendall(message)
            except OSError:
                emit(False, None, "send_failed")
                return
        emit(True, True)
        return
    emit(False, False, "socket_unavailable")


try:
    main()
except Exception:
    # 不向 stderr 或公共错误回显路径、环境、异常字符串或请求。
    emit(False, None if may_have_sent else False, "internal")
`;
