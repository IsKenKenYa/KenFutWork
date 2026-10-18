/** GUI 操作共用的只读原生状态与持久链接投影，不承担调度或写入。 */
export const CAD_GUI_NATIVE_STATE_SOURCE = `
import io as _kfw_cad_native_io
import xml.etree.ElementTree as _kfw_cad_native_xml
import zipfile as _kfw_cad_native_zip


def _kfw_cad_native_document_state(app, gui, documents, read, failure):
    result = {}
    if read(lambda: app.getActiveTransaction()) is not None:
        raise failure('document_busy')
    for name, doc in documents.items():
        gui_doc = read(lambda: gui.getDocument(name))
        if read(lambda: gui_doc.getInEdit()) is not None or read(lambda: gui_doc.Transacting):
            raise failure('document_busy')
        flags = tuple(read(lambda key=key: bool(getattr(doc, key)))
                      for key in ('Restoring', 'Partial', 'Importing', 'Recomputing', 'Transacting', 'HasPendingTransaction'))
        if any(flags):
            raise failure('document_busy')
        result[name] = {
            'fileName': read(lambda: doc.FileName), 'label': read(lambda: doc.Label),
            'uid': read(lambda: str(doc.Uid)), 'modified': read(lambda: bool(gui_doc.Modified)),
            'touched': read(lambda: bool(doc.isTouched())), 'flags': flags,
            'frozen': read(lambda: bool(doc.RecomputesFrozen)),
            'undoMode': read(lambda: doc.UndoMode), 'undoCount': read(lambda: doc.UndoCount),
            'redoCount': read(lambda: doc.RedoCount),
            'undo': _kfw_cad_history_summary(read(lambda: doc.UndoNames)),
            'redo': _kfw_cad_history_summary(read(lambda: doc.RedoNames)),
        }
    return result


def _kfw_cad_native_link_properties(app, doc, read, failure):
    for obj in read(lambda: list(doc.Objects)):
        for name in read(lambda: list(obj.PropertiesList)):
            type_name = read(lambda: obj.getTypeIdOfProperty(name))
            kind = read(lambda: app.Base.TypeId.fromName(type_name))
            if read(lambda: kind.isBad()):
                raise failure('unsupported_external_reference')
            if any(read(lambda base=base: kind.isDerivedFrom(base))
                   for base in ('App::PropertyXLink', 'App::PropertyXLinkSubList', 'App::PropertyXLinkContainer')):
                yield obj, name


def _kfw_cad_native_link_files(obj, name, read, failure):
    raw = read(lambda: obj.dumpPropertyContent(name, Compression=0))
    if type(raw) not in (bytes, bytearray):
        raise failure('unsupported_external_reference')
    try:
        with _kfw_cad_native_zip.ZipFile(_kfw_cad_native_io.BytesIO(raw)) as archive:
            if archive.namelist().count('Persistence.xml') != 1:
                raise ValueError('missing property persistence')
            root = _kfw_cad_native_xml.fromstring(archive.read('Persistence.xml'))
        if root.tag != 'Content':
            raise ValueError('unsupported property persistence')
        files = []
        for link in root.iter('XLink'):
            file_name = link.get('file')
            if file_name is None:
                raise failure('unsupported_external_reference')
            if file_name:
                files.append(file_name)
        for links in root.iter('XLinks'):
            count = links.get('count')
            children = list(links)
            entries = [link for link in children if link.tag == 'XLink']
            if count is None or not count.isdecimal() or int(count) != len(entries):
                raise ValueError('unsupported external link list')
            if any(link.tag not in ('XLink', 'DocMap') for link in children):
                raise failure('unsupported_external_reference')
        return files
    except failure:
        raise
    except BaseException:
        raise failure('unsupported_external_reference')
`;
