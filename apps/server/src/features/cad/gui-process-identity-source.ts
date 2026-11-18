/** 固定只读 libproc ABI；与 Task、NSWorkspace 展示时间及 GUI 文档查询分离。 */
export const CAD_GUI_PROCESS_IDENTITY_SOURCE = `
import ctypes
import os


class _KfwProcBsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "pbi_flags", "pbi_status", "pbi_xstatus", "pbi_pid", "pbi_ppid",
        "pbi_uid", "pbi_gid", "pbi_ruid", "pbi_rgid", "pbi_svuid", "pbi_svgid", "rfu_1")]
    _fields_ += [("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32)]
    _fields_ += [(name, ctypes.c_uint32) for name in (
        "pbi_nfiles", "pbi_pgid", "pbi_pjobc", "e_tdev", "e_tpgid")]
    _fields_ += [("pbi_nice", ctypes.c_int32),
                ("pbi_start_tvsec", ctypes.c_uint64), ("pbi_start_tvusec", ctypes.c_uint64)]


_kfw_libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
_kfw_libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                   ctypes.c_void_p, ctypes.c_int]
_kfw_libproc.proc_pidinfo.restype = ctypes.c_int
_kfw_libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
_kfw_libproc.proc_pidpath.restype = ctypes.c_int


def _kfw_process_info(pid):
    info = _KfwProcBsdInfo()
    size = ctypes.sizeof(info)
    if size != 136 or _kfw_libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), size) != size:
        raise RuntimeError("process identity unavailable")
    # Darwin: SRUN=2、SSLEEP=3；创建中、暂停、僵尸、INEXIT 均不签发活动身份。
    if (info.pbi_pid != pid or info.pbi_status not in (2, 3) or info.pbi_flags & 4
            or info.pbi_start_tvsec <= 0 or info.pbi_start_tvusec >= 1000000):
        raise RuntimeError("process is not active")
    return info


def read_process_identity(pid):
    if type(pid) is not int or not 2 <= pid <= 2147483647:
        raise ValueError("invalid process id")
    before = _kfw_process_info(pid)
    path = ctypes.create_string_buffer(4096)
    length = _kfw_libproc.proc_pidpath(pid, path, len(path))
    if length <= 0 or length >= len(path):
        raise RuntimeError("process executable unavailable")
    reported_path = path.value.decode("utf-8", "strict")
    if not os.path.isabs(reported_path):
        raise RuntimeError("process executable invalid")
    executable = os.path.realpath(reported_path)
    after = _kfw_process_info(pid)
    if (before.pbi_start_tvsec != after.pbi_start_tvsec
            or before.pbi_start_tvusec != after.pbi_start_tvusec):
        raise RuntimeError("process changed during identity query")
    return {"pid": pid,
            "birth": {"startSeconds": int(after.pbi_start_tvsec),
                      "startMicroseconds": int(after.pbi_start_tvusec)},
            "executablePath": executable}
`;

/** 单次身份查询入口：不连接 socket，不读取 AX，不操作或启动任何应用。 */
export const CAD_GUI_PROCESS_IDENTITY_QUERY_SOURCE =
  CAD_GUI_PROCESS_IDENTITY_SOURCE +
  String.raw`
import json
import sys

try:
    raw = sys.stdin.buffer.read(257)
    if len(raw) > 256:
        raise ValueError("request too large")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {"pid"}:
        raise ValueError("invalid request")
    result = {"ok": True, **read_process_identity(request["pid"])}
except Exception:
    result = {"ok": False}
sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
`;
