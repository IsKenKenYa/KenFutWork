"""仅在自有隔离 GUI 中核验原生保存 API；不是产品保存工具。"""

import hashlib
import zipfile


def native_save_hash(path):
    with open(path, "rb") as stream:
        return hashlib.sha256(stream.read()).hexdigest()


def native_save_failure(probe):
    # 父路径是常规文件：失败可以已改变内存身份，不能靠返回值猜是否写入。
    blocker = os.path.join(save_probe_root, "blocked-parent")
    with open(blocker, "x") as stream:
        stream.write("KFW fixture")
    bad_path = os.path.join(blocker, "cannot-save.FCStd")
    failure = None
    try:
        probe.saveAs(bad_path)
    except Exception as error:
        failure = type(error).__name__
    assert not os.path.isfile(bad_path)
    return {"failureType": failure, "fileNameAfterFailure": probe.FileName,
            "labelAfterFailure": probe.Label}


def check_native_save():
    original_active = App.ActiveDocument
    probe = App.newDocument("KfwNativeSave")
    probe_name = probe.Name
    owned.append(probe)
    events = []

    class SaveObserver:
        def slotStartSaveDocument(self, document, path):
            if document is probe:
                events.append("start")

        def slotFinishSaveDocument(self, document, path):
            if document is probe:
                events.append("finish")

    observer = SaveObserver()
    App.addDocumentObserver(observer)
    try:
        probe.UndoMode = 1
        box = probe.addObject("Part::Box", "SaveBox")
        probe.recompute()
        probe.openTransaction("KFW save fixture edit")
        box.Height = 12
        probe.recompute()
        probe.commitTransaction()
        box.touch()
        Gui.getDocument(probe.Name).Modified = True
        uid = str(probe.Uid)
        history = (list(probe.UndoNames), list(probe.RedoNames))
        path = os.path.join(save_probe_root, "native-save.FCStd")
        assert not os.path.lexists(path)
        assert probe.saveAs(path) is None
        assert probe.FileName == path and str(probe.Uid) == uid
        assert probe.isSaved() and Gui.getDocument(probe.Name).Modified
        assert probe.isTouched()
        assert (list(probe.UndoNames), list(probe.RedoNames)) == history
        assert events == ["start", "finish"], events
        with zipfile.ZipFile(path) as archive:
            assert archive.testzip() is None
            assert {"Document.xml", "GuiDocument.xml"}.issubset(archive.namelist())
        first_hash = native_save_hash(path)

        probe.openTransaction("KFW save fixture second edit")
        box.Height = 13
        probe.recompute()
        probe.commitTransaction()
        history = (list(probe.UndoNames), list(probe.RedoNames))
        assert probe.save() is None
        assert events == ["start", "finish", "start", "finish"], events
        assert (list(probe.UndoNames), list(probe.RedoNames)) == history
        assert Gui.getDocument(probe.Name).Modified
        assert native_save_hash(path) != first_hash

        observation = native_save_failure(probe)
        assert str(probe.Uid) == uid
        observation["events"] = events

        owned.remove(probe)
        App.closeDocument(probe_name)
        probe = None
        probe = App.openDocument(path)
        probe_name = probe.Name
        owned.append(probe)
        assert probe.getObject("SaveBox").Height.Value == 13
        assert abs(probe.getObject("SaveBox").Shape.Volume - 1300) < 1e-6
        observation.update(success=True, height=13, volume=probe.getObject("SaveBox").Shape.Volume)
        with open(os.path.join(save_probe_root, "native-save-result.json"), "x") as stream:
            json.dump(observation, stream)
    finally:
        App.removeDocumentObserver(observer)
        if probe is not None and App.listDocuments().get(probe_name) is probe:
            App.closeDocument(probe_name)
        if probe in owned:
            owned.remove(probe)
        if original_active is not None and App.listDocuments().get(original_active.Name) is original_active:
            App.setActiveDocument(original_active.Name)


check_native_save()
