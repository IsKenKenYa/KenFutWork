import { CAD_GUI_DOCUMENT_OBSERVER_SOURCE } from "./gui-document-observer-source.js";
import { CAD_GUI_PROPERTY_INSPECTION_SOURCE } from "./gui-property-source.js";

/** 固定提供方代码；模型只能提交应用身份，不能提交 source、宏路径或端点。 */
export const CAD_GUI_DOCUMENT_QUERY_SOURCE =
  CAD_GUI_DOCUMENT_OBSERVER_SOURCE +
  CAD_GUI_PROPERTY_INSPECTION_SOURCE +
  `
def _kfw_cad_query_documents(request_path, reply_path, cancelled_path):
    import json, os, time
    import FreeCAD as App
    import FreeCADGui as Gui
    from PySide import QtCore, QtWidgets

    def execute_query():
        try:
            with open(request_path, 'r', encoding='utf-8') as stream:
                request = json.load(stream)
        except (OSError, ValueError):
            return
        if (not isinstance(request, dict)
                or request.get('operation') not in ('list-document-metadata', 'inspect-document')
                or request.get('pid') != os.getpid()):
            return
        inspecting = request['operation'] == 'inspect-document'
        qapp = QtWidgets.QApplication.instance()
        gui_thread = qapp is not None and QtCore.QThread.currentThread() == qapp.thread()
        reply = {'protocol': 'kfw-cad-gui-inspect/1' if inspecting else 'kfw-cad-gui-query/2',
                 'requestId': request['requestId'],
                 'pid': os.getpid(), 'completed': True, 'guiThread': bool(gui_thread),
                 'success': False, 'version': [],
                 'bridgeEpoch': None, 'applicationRevision': None}
        empty_payload = {'document': None, 'objects': []} if inspecting else {'documents': []}
        reply.update(empty_payload)
        bridge = None
        try:
            if not gui_thread:
                raise RuntimeError('GUI thread required')
            if os.path.exists(cancelled_path) or time.time() * 1000 > request['expiresAt']:
                reply['error'] = 'cancelled_or_expired'
            else:
                bridge = _kfw_cad_document_bridge(App, Gui)
                observation = (_kfw_cad_inspect_document(bridge, request)
                               if inspecting else bridge.snapshot())
                version = list(App.Version())
                bridge.require_valid()
                if os.path.exists(cancelled_path) or time.time() * 1000 > request['expiresAt']:
                    reply['error'] = 'cancelled_or_expired'
                else:
                    reply.update(observation)
                    reply['version'] = version
                    reply['success'] = True
        except _KfwCadInspectionError as error:
            reply['error'] = error.code
        except BaseException:
            if bridge is not None:
                bridge.valid = False
            reply.update(success=False, bridgeEpoch=None, applicationRevision=None, version=[])
            reply.update(empty_payload)
            reply['error'] = 'document_metadata_unavailable'
        temporary = reply_path + '.tmp'
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump(reply, stream, ensure_ascii=False)
            os.replace(temporary, reply_path)
        except OSError:
            # 宿主可能已取消并收束本次临时请求，不在用户 Report 面板输出私有内容。
            pass

    # 官方 OpenFile 宏在 GUI 线程执行；再次推迟到事件循环并验证实际线程。
    QtCore.QTimer.singleShot(0, execute_query)
`;
