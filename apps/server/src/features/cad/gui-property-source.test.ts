import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { cadGuiObjectInspectionSchema } from "./gui-document-contracts.js";
import { CAD_GUI_DOCUMENT_QUERY_SOURCE } from "./gui-document-source.js";

const execute = promisify(execFile);
const fixtureSource = `
import json

class Unit:
    Signature = (1, 0, 0, 0, 0, 0, 0, 0)

class Quantity:
    def __init__(self, value):
        self.Value, self.Unit = value, Unit()

class NativeObject:
    Name, Label, TypeId = 'Box', '盒子', 'Part::Box'
    def __init__(self):
        self.values = {
            'Length': ('App::PropertyLength', Quantity(10)),
            'Width': ('App::PropertyLength', Quantity(20)),
            'Note': ('App::PropertyString', '说明'),
            'Flag': ('App::PropertyBool', False),
            'Count': ('App::PropertyInteger', 7),
            'Locked': ('App::PropertyFloat', 3.5),
            'Forwarded': ('App::PropertyFloat', 42.0),
            'Choice': ('App::PropertyEnumeration', 'A'),
            'Percent': ('App::PropertyPercent', 50),
            'Placement': ('App::PropertyPlacement', object()),
            'ExpressionEngine': ('App::PropertyExpressionEngine', [('.Width', 'Length * 2')]),
        }
        self.PropertiesList = list(self.values)
        self.reads = []
    def getTypeIdOfProperty(self, name):
        return self.values[name][0]
    def getEditorMode(self, name):
        return ['ReadOnly'] if name == 'Count' else []
    def getPropertyStatus(self, name):
        return ['Immutable', 21] if name == 'Locked' else [21]
    def getPropertyByName(self, name, mode):
        assert mode == 2
        self.reads.append(name)
        if name == 'Placement':
            raise RuntimeError('complex property getter must not run')
        return (object() if name == 'Forwarded' else self, self.values[name][1])

class NativeDocument:
    def __init__(self):
        self.Objects = [NativeObject()]
    def getObject(self, name):
        return next((obj for obj in self.Objects if obj.Name == name), None)

class Bridge:
    epoch, application_revision, valid = 'bridge-epoch', 2, True
    def __init__(self):
        self.doc = NativeDocument()
        self.metadata = {'documentHandle': 'document-handle', 'revision': 3}
        self.record = {'object': self.doc, 'closed': False, 'handle': 'document-handle', 'revision': 3}
        self.documents = {id(self.doc): self.record}
        self.snapshots = 0
    def snapshot(self):
        self.snapshots += 1
        return {'bridgeEpoch': self.epoch, 'applicationRevision': self.application_revision,
                'documents': [self.metadata.copy()]}
    def require_valid(self):
        assert self.valid
    def find(self, doc):
        return self.record if doc is self.doc else None
    def listed(self, doc):
        return doc is self.doc

bridge = Bridge()
request = {'bridgeEpoch': 'bridge-epoch', 'documentHandle': 'document-handle',
           'expectedApplicationRevision': 2, 'expectedDocumentRevision': 3}
`;

async function evaluate(source: string) {
  const result = await execute(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `${CAD_GUI_DOCUMENT_QUERY_SOURCE}\n${fixtureSource}\n${source}`,
    ],
    { timeout: 10_000, maxBuffer: 100_000 },
  );
  return JSON.parse(result.stdout);
}

test("省略对象选择仅列原生对象摘要，不访问任何属性值", async () => {
  const result = await evaluate(`
result = _kfw_cad_inspect_document(bridge, request)
print(json.dumps({'objects': result['objects'], 'reads': bridge.doc.Objects[0].reads}))
`);
  expect(result).toEqual({
    objects: [{ name: "Box", label: "盒子", typeId: "Part::Box" }],
    reads: [],
  });
});

test("安全标量投影保留数字status、驱动属性和其它属性的表达式绑定", async () => {
  const result = await evaluate(`
request['objectNames'] = ['Box']
result = _kfw_cad_inspect_document(bridge, request)
print(json.dumps(result['objects'][0]))
`);
  const inspected = cadGuiObjectInspectionSchema.parse(result);
  const properties = new Map(
    inspected.properties?.map((property) => [property.name, property]),
  );
  expect(properties.get("Length")).toMatchObject({
    value: {
      kind: "quantity",
      value: 10,
      unitSignature: [1, 0, 0, 0, 0, 0, 0, 0],
    },
    readOnly: false,
    editable: true,
  });
  expect(properties.get("Width")).toMatchObject({
    value: { kind: "quantity", value: 20 },
    expression: "Length * 2",
    editable: false,
  });
  expect(properties.get("Note")).toMatchObject({
    value: "说明",
    editable: true,
  });
  expect(properties.get("Flag")).toMatchObject({
    value: false,
    editable: true,
  });
  expect(properties.get("Count")).toMatchObject({
    value: 7,
    readOnly: true,
    editable: false,
  });
  expect(properties.get("Locked")).toMatchObject({
    value: 3.5,
    immutable: true,
    editable: false,
  });
  expect(properties.get("Choice")).toMatchObject({
    value: "A",
    editable: false,
    unsupportedReason: "enumeration_requires_choices",
  });
  expect(properties.get("Percent")).toMatchObject({
    value: 50,
    editable: true,
  });
  for (const name of ["Forwarded", "Placement"]) {
    expect(properties.get(name)).toMatchObject({ editable: false });
    expect(properties.get(name)).not.toHaveProperty("value");
  }
  expect(properties.get("Forwarded")?.unsupportedReason).toBe(
    "forwarded_property",
  );
});

test.each([
  ["bridgeEpoch", "other-epoch"],
  ["documentHandle", "other-document"],
  ["expectedApplicationRevision", 1],
  ["expectedDocumentRevision", 2],
])("过期target %s 在属性读取前拒绝且保留健康桥", async (field, value) => {
  const result = await evaluate(`
request[${JSON.stringify(field)}] = ${JSON.stringify(value)}
request['objectNames'] = ['Box']
try:
    _kfw_cad_inspect_document(bridge, request)
except _KfwCadInspectionError as error:
    print(json.dumps({'error': error.code, 'valid': bridge.valid, 'reads': bridge.doc.Objects[0].reads}))
`);
  expect(result).toEqual({ error: "stale_target", valid: true, reads: [] });
});

test("缺失对象和读取期间的代际变化不发布迟到属性", async () => {
  const missing = await evaluate(`
request['objectNames'] = ['Missing']
try:
    _kfw_cad_inspect_document(bridge, request)
except _KfwCadInspectionError as error:
    print(json.dumps({'error': error.code, 'valid': bridge.valid, 'reads': bridge.doc.Objects[0].reads}))
`);
  expect(missing).toEqual({ error: "object_missing", valid: true, reads: [] });
  const changed = await evaluate(`
request['objectNames'] = ['Box']
original = bridge.doc.Objects[0].getPropertyByName
def changing(name, mode):
    value = original(name, mode)
    bridge.application_revision += 1
    return value
bridge.doc.Objects[0].getPropertyByName = changing
try:
    _kfw_cad_inspect_document(bridge, request)
except _KfwCadInspectionError as error:
    print(json.dumps({'error': error.code, 'valid': bridge.valid, 'reads': bridge.doc.Objects[0].reads}))
`);
  expect(changed).toEqual({
    error: "stale_target",
    valid: true,
    reads: ["ExpressionEngine"],
  });
});

test("非有限值与超出JSON安全整数范围的属性不投影为可编辑数值", async () => {
  const result = await evaluate(`
request['objectNames'] = ['Box']
obj = bridge.doc.Objects[0]
obj.values['Length'] = ('App::PropertyLength', Quantity(float('nan')))
obj.values['Count'] = ('App::PropertyInteger', 9007199254740992)
result = _kfw_cad_inspect_document(bridge, request)
print(json.dumps([row for row in result['objects'][0]['properties'] if row['name'] in ('Length', 'Count')]))
`);
  expect(result).toHaveLength(2);
  for (const property of result) {
    expect(property).toMatchObject({
      editable: false,
      unsupportedReason: "unsupported_property_value",
    });
    expect(property).not.toHaveProperty("value");
  }
});
