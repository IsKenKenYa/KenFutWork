"""独立合成工程探针；仅用本机 FreeCAD 内置 API，不改已有文档。"""
import json
import math
from pathlib import Path
import time
import traceback
import tempfile
import FreeCAD as App
import Part
import Sketcher

root = Path(tempfile.mkdtemp(prefix='kfw-cad-probe-'))
records = []

def near(actual, expected, tolerance=1e-6):
    assert abs(actual-expected) <= tolerance * max(1, abs(expected)), (actual, expected)

def shape_check(shape, volume=None):
    assert not shape.isNull()
    assert shape.isValid()
    assert len(shape.Solids) == 1
    shape.check(True)
    if volume is not None:
        near(shape.Volume, volume)
    return {'volume': shape.Volume, 'solids': len(shape.Solids),
            'bounds': [shape.BoundBox.XLength, shape.BoundBox.YLength, shape.BoundBox.ZLength]}

def probe(name, callback):
    start = time.monotonic()
    try:
        result = callback()
        records.append({'name':name, 'ok':True, 'result':result, 'seconds':time.monotonic()-start})
    except Exception:
        records.append({'name':name, 'ok':False, 'error':traceback.format_exc()})
    (root/'model-probe.json').write_text(json.dumps({'version':App.Version(), 'cases':records}, indent=2))

def booleans():
    a = Part.makeBox(10,10,10)
    b = Part.makeBox(10,10,10,App.Vector(5,0,0))
    return {'fuse':shape_check(a.fuse(b),1500), 'cut':shape_check(a.cut(b),500),
            'common':shape_check(a.common(b),500)}

probe('boolean-specific-volume-invariants', booleans)

doc = App.newDocument('KfwFlange')
body = doc.addObject('PartDesign::Body','Body')
ring = body.newObject('Sketcher::SketchObject','RingSketch')
for radius in (40,15):
    geometry = ring.addGeometry(Part.Circle(App.Vector(0,0,0),App.Vector(0,0,1),radius),False)
    ring.addConstraint(Sketcher.Constraint('Coincident',geometry,3,-1,1))
    ring.addConstraint(Sketcher.Constraint('Radius',geometry,radius))
ring.renameConstraint(1,'OuterRadius')
ring.renameConstraint(3,'InnerRadius')
pad = body.newObject('PartDesign::Pad','Pad')
pad.Profile = ring
pad.Length = 10
doc.recompute()
probe('constrained-sketch-and-pad', lambda: {'dof':ring.DoF, 'solve':ring.solve(),
    **shape_check(pad.Shape,math.pi*(40**2-15**2)*10)})

hole_sketch = body.newObject('Sketcher::SketchObject','HoleSketch')
hole_sketch.Placement.Base.z = 10
g = hole_sketch.addGeometry(Part.Circle(App.Vector(30,0,0),App.Vector(0,0,1),4),False)
hole_sketch.addConstraint(Sketcher.Constraint('DistanceX',g,3,30.0))
hole_sketch.addConstraint(Sketcher.Constraint('DistanceY',g,3,0.0))
hole_sketch.addConstraint(Sketcher.Constraint('Radius',g,4.0))
pocket = body.newObject('PartDesign::Pocket','Pocket')
pocket.Profile = hole_sketch
pocket.Length = 10
doc.recompute()
pattern = body.newObject('PartDesign::PolarPattern','PolarPattern')
pattern.Originals = [pocket]
pattern.Axis = (hole_sketch,['N_Axis'])
pattern.Angle = 360
pattern.Occurrences = 6
body.Tip = pattern
ring.Visibility = False
pad.Visibility = False
hole_sketch.Visibility = False
pocket.Visibility = False
doc.recompute()
probe('pocket-and-six-hole-native-polar-pattern',lambda: shape_check(pattern.Shape,math.pi*(40**2-15**2-6*4**2)*10))

def change_and_reopen():
    ring.setDatum(1,App.Units.Quantity('45 mm'))
    doc.recompute()
    expected = math.pi*(45**2-15**2-6*4**2)*10
    before = shape_check(pattern.Shape,expected)
    for obj in (ring,pad,hole_sketch,pocket,pattern):
        assert 'Invalid' not in obj.State, (obj.Name,obj.State,obj.getStatusString())
    file = root/'flange.FCStd'
    doc.saveAs(str(file))
    App.closeDocument(doc.Name)
    reopened = App.openDocument(str(file))
    after = shape_check(reopened.getObject('PolarPattern').Shape,expected)
    assert reopened.getObject('Body').Tip.Name == 'PolarPattern'
    assert reopened.getObject('Pad').Profile[0].Name == 'RingSketch'
    return {'before':before, 'reopened':after, 'file':str(file), 'feature_tree_preserved':True}

probe('dimension-recompute-save-reopen',change_and_reopen)
doc = App.activeDocument()
body = doc.getObject('Body')
pattern = doc.getObject('PolarPattern')

def step_roundtrip():
    file=root/'flange.step'
    Part.export([body],str(file))
    restored=Part.read(str(file))
    original=shape_check(pattern.Shape)
    roundtrip=shape_check(restored,pattern.Shape.Volume)
    return {'original':original,'roundtrip':roundtrip,'bytes':file.stat().st_size}

probe('step-export-and-reimport',step_roundtrip)

def stl_roundtrip():
    import Mesh
    import MeshPart
    mesh=MeshPart.meshFromShape(Shape=pattern.Shape,LinearDeflection=0.05,AngularDeflection=0.1,Relative=False)
    file=root/'flange.stl'
    mesh.write(str(file))
    restored=Mesh.Mesh(str(file))
    assert restored.isSolid()
    assert restored.CountFacets > 0
    assert abs(restored.Volume-pattern.Shape.Volume)/pattern.Shape.Volume < 0.01
    return {'facets':restored.CountFacets,'volume':restored.Volume,'bytes':file.stat().st_size}

probe('stl-mesh-export-and-reimport',stl_roundtrip)

def conflict():
    d=App.newDocument('KfwConflict')
    sk=d.addObject('Sketcher::SketchObject','Conflict')
    g=sk.addGeometry(Part.Circle(App.Vector(),App.Vector(0,0,1),5),False)
    sk.addConstraint(Sketcher.Constraint('Radius',g,5.0))
    sk.addConstraint(Sketcher.Constraint('Radius',g,8.0))
    solved=sk.solve()
    d.recompute()
    assert solved != 0 or 'Invalid' in sk.State
    result={'solve':solved,'state':sk.State,'status':sk.getStatusString()}
    App.closeDocument(d.Name)
    return result

probe('conflicting-constraints-not-success',conflict)

def techdraw():
    import TechDraw
    from PySide import QtCore
    application = QtCore.QCoreApplication.instance() or QtCore.QCoreApplication([])
    d=App.newDocument('KfwDrawing')
    box=d.addObject('Part::Box','Box')
    box.Length,box.Width,box.Height=40,20,10
    page=d.addObject('TechDraw::DrawPage','Page')
    template=d.addObject('TechDraw::DrawSVGTemplate','Template')
    template.Template=App.getResourceDir()+'Mod/TechDraw/Templates/Default_Template_A4_Landscape.svg'
    page.Template=template
    view=d.addObject('TechDraw::DrawViewPart','View')
    page.addView(view)
    view.Source=[box]
    view.Direction=App.Vector(0,0,1)
    d.recompute()
    loop=QtCore.QEventLoop()
    QtCore.QTimer.singleShot(2000,loop.quit)
    loop.exec_()
    edges=view.getVisibleEdges()
    assert len(edges)==4,(len(edges),view.State)
    assert 'Up-to-date' in view.State
    d.saveAs(str(root/'drawing.FCStd'))
    result={'visible_edges':len(edges),'state':view.State,'gui_up':App.GuiUp}
    App.closeDocument(d.Name)
    return result

probe('techdraw-projection-headless-event-loop',techdraw)
for name in list(App.listDocuments()):
    App.closeDocument(name)
print('CAD 探针结果目录:', root)
print(json.dumps({'passed': sum(case['ok'] for case in records), 'total': len(records)}, ensure_ascii=False))
