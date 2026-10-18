import { CAD_GUI_NATIVE_STATE_SOURCE } from "./gui-native-state-source.js";

/** copy/save 共用的只读外链及 FCStd 归档验证；不调度、不写入文档。 */
export const CAD_GUI_DOCUMENT_FILE_SOURCE =
  CAD_GUI_NATIVE_STATE_SOURCE +
  String.raw`
import zipfile as _kfw_cad_file_zip


def _kfw_cad_native_document_links(app, target, documents, read, failure):
    if read(lambda: target.InList) or read(lambda: target.OutList):
        raise failure('external_dependencies')
    target_file = read(lambda: target.FileName)
    target_path = _kfw_cad_os.path.realpath(target_file) if target_file else None
    for name, doc in documents.items():
        for obj, property_name in _kfw_cad_native_link_properties(app, doc, read, failure):
            files = read(lambda: _kfw_cad_native_link_files(obj, property_name, read, failure))
            if doc is target and files:
                raise failure('external_dependencies')
            if doc is not target and files and target_path is None:
                raise failure('unsupported_external_reference')
            for file_name in files:
                if doc is target:
                    continue
                if file_name.startswith('https://') or '://' in file_name:
                    if file_name == target_file:
                        raise failure('external_referrers')
                    raise failure('unsupported_external_reference')
                if target_file.startswith('https://') or '://' in target_file:
                    raise failure('unsupported_external_reference')
                source_file = read(lambda: doc.FileName)
                if not _kfw_cad_os.path.isabs(file_name):
                    if not source_file:
                        raise failure('unsupported_external_reference')
                    file_name = _kfw_cad_os.path.join(_kfw_cad_os.path.dirname(_kfw_cad_os.path.realpath(source_file)), file_name)
                matches = _kfw_cad_os.path.realpath(file_name) == target_path
                if not matches:
                    try:
                        matches = _kfw_cad_os.path.samefile(file_name, target_path)
                    except OSError:
                        pass
                if matches:
                    raise failure('external_referrers')


def _kfw_cad_native_document_archive(path, guard, failure, code):
    guard()
    descriptor = _kfw_cad_os.open(path, _kfw_cad_os.O_RDONLY | _kfw_cad_os.O_NOFOLLOW | _kfw_cad_os.O_NONBLOCK)
    with _kfw_cad_os.fdopen(descriptor, 'rb') as stream:
        before = _kfw_cad_os.fstat(stream.fileno())
        if not _kfw_cad_stat.S_ISREG(before.st_mode) or not 0 <= before.st_size <= _KFW_CAD_MAX_REVISION:
            raise failure(code)
        digest = _kfw_cad_hashlib.sha256()
        while True:
            chunk = stream.read(1048576)
            if not chunk:
                break
            digest.update(chunk)
            guard()
        stream.seek(0)
        with _kfw_cad_file_zip.ZipFile(stream) as archive:
            names = archive.namelist()
            if names.count('Document.xml') != 1 or names.count('GuiDocument.xml') != 1:
                raise failure(code)
            for item in archive.infolist():
                if item.is_dir():
                    continue
                with archive.open(item) as member:
                    while member.read(1048576):
                        guard()
                guard()
        after = _kfw_cad_os.lstat(path)
        current = _kfw_cad_os.fstat(stream.fileno())
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        if not _kfw_cad_stat.S_ISREG(after.st_mode) or identity(before) != identity(after) or identity(before) != identity(current):
            raise failure(code)
    guard()
    return {'size': before.st_size, 'sha256': digest.hexdigest(), 'hasGuiDocument': True}
`;
