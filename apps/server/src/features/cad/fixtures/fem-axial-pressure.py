"""FreeCAD 1.1.4 的真实 Gmsh → CalculiX 轴向压力验收夹具。

宿主预置 App、Part、doc、output_directory；调用 run_axial_case(options) 返回普通 JSON。
本文件独立编写，依据随包 ObjectsFem.py、femmesh/gmshtools.py、
femtools/ccxtools.py、femsolver/calculix/write_constraint_pressure.py、
feminout/importCcxFrdResults.py；不使用官方示例的预制网格回退。
每次调用创建新目录，复用同一文档的几何、材料、约束、网格和求解器对象。
"""

import json
import math
import os
import re
import subprocess
import time
import uuid

import Fem
import ObjectsFem
from femmesh.gmshtools import GmshTools
from femresult.resulttools import purge_results
from femtools.ccxtools import FemToolsCcx


YOUNGS_MODULUS = 210000.0
RELATIVE_TOLERANCE = 0.01
PROCESS_TIMEOUT_SECONDS = 9
STRESS_PROPERTIES = {
    "sxx": "NodeStressXX", "syy": "NodeStressYY", "szz": "NodeStressZZ",
    "sxy": "NodeStressXY", "sxz": "NodeStressXZ", "syz": "NodeStressYZ",
    "vonMises": "vonMises",
}


def _require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _options(options):
    _require(isinstance(options, dict), "FEM options 必须是对象")
    _require(not set(options).difference({"length", "pressure", "reversed", "meshSize"}),
             "FEM options 含未知字段")
    values = {}
    for name, default in (("length", 100.0), ("pressure", 1.0), ("meshSize", 5.0)):
        value = options.get(name, default)
        _require(isinstance(value, (int, float)) and not isinstance(value, bool),
                 "FEM 参数必须是数字: " + name)
        value = float(value)
        _require(math.isfinite(value) and value > 0, "FEM 参数必须为有限正数: " + name)
        values[name] = value
    values["reversed"] = options.get("reversed", False)
    _require(isinstance(values["reversed"], bool), "reversed 必须是布尔值")
    return values


def _inside(root, path):
    path = os.path.realpath(path)
    _require(os.path.commonpath((root, path)) == root, "FEM 文件超出本次目录: " + path)
    return path


def _persist(report, root):
    for path in (os.path.join(root, "fem-report.json"), report["paths"]["report"]):
        with open(_inside(root, path), "w", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, allow_nan=False, indent=2)


def _phase(report, root, name):
    report["activePhase"] = name
    _persist(report, root)


def _object(name, type_id, factory):
    obj = doc.getObject(name)
    if obj is None:
        obj = factory(doc, name)
    _require(obj.Name == name and obj.TypeId == type_id,
             "FEM 对象类型或名称不符: " + name + " " + obj.TypeId)
    return obj


def _references(obj):
    return [{"object": target.Name, "subelements": list(subelements)}
            for target, subelements in obj.References]


def _face_at_x(box, x):
    matches = ["Face" + str(index) for index, face in enumerate(box.Shape.Faces, 1)
               if abs(face.CenterOfMass.x - x) < 1e-7 and face.BoundBox.XLength < 1e-7]
    _require(len(matches) == 1, "无法唯一识别 x=" + str(x) + " 的端面")
    return matches[0]


def _model(options, report):
    box = _object("Box", "Part::Box", lambda document, name: document.addObject("Part::Box", name))
    box.Length, box.Width, box.Height = options["length"], 10.0, 10.0
    box.Placement = App.Placement()
    doc.recompute()
    _require(not box.Shape.isNull() and box.Shape.isValid() and len(box.Shape.Solids) == 1,
             "FEM Box 不是有效单实体")
    analysis = _object("Analysis", "Fem::FemAnalysis", ObjectsFem.makeAnalysis)
    report["removedPriorResults"] = [obj.Name for obj in analysis.Group
                                      if obj.isDerivedFrom("Fem::FemResultObject")]
    purge_results(analysis)
    material = _object("MaterialSolid", "App::MaterialObjectPython", ObjectsFem.makeMaterialSolid)
    material.Material = {"Name": "AxialSteelNuZero", "YoungsModulus": "210000 MPa",
                         "PoissonRatio": "0.0"}
    material.References = [(box, ["Solid1"])]
    fixed = _object("ConstraintFixed", "Fem::ConstraintFixed", ObjectsFem.makeConstraintFixed)
    fixed.References = [(box, [_face_at_x(box, 0.0)])]
    load = _object("ConstraintPressure", "Fem::ConstraintPressure", ObjectsFem.makeConstraintPressure)
    load.References = [(box, [_face_at_x(box, options["length"])])]
    load.Pressure = str(options["pressure"]) + " MPa"
    load.Reversed = options["reversed"]
    mesh = _object("MeshGmsh", "Fem::FemMeshShapeBaseObjectPython", ObjectsFem.makeMeshGmsh)
    mesh.Shape = box
    mesh.FemMesh = Fem.FemMesh()
    mesh.ElementDimension, mesh.ElementOrder = "3D", "1st"
    mesh.CharacteristicLengthMin = mesh.CharacteristicLengthMax = options["meshSize"]
    mesh.WorkingDirectory = report["paths"]["gmshDirectory"]
    solver = _object("SolverCcxTools", "Fem::FemSolverObjectPython", ObjectsFem.makeSolverCalculiXCcxTools)
    solver.AnalysisType = "static"
    solver.GeometricalNonlinearity = solver.MaterialNonlinearity = "linear"
    solver.MatrixSolverType = "default"
    solver.SplitInputWriter = False
    solver.IterationsControlParameterTimeUse = False
    solver.WorkingDir = report["paths"]["ccxDirectory"]
    for obj in (material, fixed, load, mesh, solver):
        if obj not in analysis.Group:
            analysis.addObject(obj)
    doc.recompute()
    report["model"] = {"document": doc.Name, "box": box.Name, "analysis": analysis.Name,
                       "mesh": mesh.Name, "solver": solver.Name,
                       "boundary": {"object": fixed.Name, "references": _references(fixed)},
                       "load": {"object": load.Name, "references": _references(load),
                                "pressureMPa": load.Pressure.getValueAs("MPa").Value,
                                "reversed": bool(load.Reversed)},
                       "material": {"object": material.Name, "references": _references(material),
                                    "values": dict(material.Material)}}
    return analysis, mesh, solver, fixed


def _binary(name, report):
    home_path, resource_dir = App.getHomePath(), App.getResourceDir()
    candidates = [os.path.realpath(os.path.join(home_path, "bin", name))]
    # 本机 1.1.4 的 resource dir 指向 Resources/share；bin 在其同级。
    if os.path.basename(os.path.normpath(resource_dir)) == "share":
        candidates.append(os.path.realpath(os.path.join(resource_dir, "..", "bin", name)))
    candidates = list(dict.fromkeys(candidates))
    discovery = report.setdefault("binaryDiscovery", {})
    discovery["getHomePath"], discovery["getResourceDir"] = home_path, resource_dir
    details = {"candidates": candidates, "actualBinary": None}
    discovery[name] = details
    for path in candidates:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            details["actualBinary"] = path
            return path
    raise ValueError("应用随包程序不可执行: " + ", ".join(candidates))


def _process(name, argv, cwd, report, root):
    stdout_path = _inside(root, os.path.join(cwd, name + ".stdout.log"))
    stderr_path = _inside(root, os.path.join(cwd, name + ".stderr.log"))
    details = {"binary": argv[0], "argv": argv, "cwd": cwd, "exitCode": None,
               "stdout": stdout_path, "stderr": stderr_path, "ompNumThreads": 1}
    report["processes"][name] = details
    _persist(report, root)
    env = dict(os.environ)
    env["OMP_NUM_THREADS"] = "1"
    started = time.monotonic()
    try:
        with open(stdout_path, "x", encoding="utf-8") as stdout:
            with open(stderr_path, "x", encoding="utf-8") as stderr:
                completed = subprocess.run(argv, cwd=cwd, env=env, stdout=stdout, stderr=stderr,
                                           timeout=PROCESS_TIMEOUT_SECONDS, check=False, shell=False)
        details["exitCode"] = completed.returncode
    except Exception as error:
        details["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        details["elapsedSeconds"] = time.monotonic() - started
        _persist(report, root)
    with open(stdout_path, encoding="utf-8", errors="replace") as stream:
        stdout_text = stream.read()
    with open(stderr_path, encoding="utf-8", errors="replace") as stream:
        stderr_text = stream.read()
    _require(completed.returncode == 0, name + " 退出码非零: " + str(completed.returncode))
    _require(not re.search(r"(^|\n)\s*(?:\*+ERROR\b|Error\s*:)", stdout_text + "\n" + stderr_text,
                           re.IGNORECASE), name + " 日志包含错误，请查看本次 stdout/stderr")
    return stdout_text, stderr_text


def _new_mesh(mesh, report, root):
    gm = GmshTools(mesh)
    gm.update_mesh_data()
    gm.get_tmp_file_paths(report["paths"]["gmshDirectory"])
    gm.gmsh_bin = _binary("gmsh", report)
    _require(os.path.realpath(gm.working_dir) == report["paths"]["gmshDirectory"],
             "Gmsh 回退到了本次目录之外")
    for name, path in (("brep", gm.temp_file_geometry), ("geo", gm.temp_file_geo),
                       ("unv", gm.temp_file_mesh)):
        report["paths"][name] = _inside(root, path)
        _require(not os.path.lexists(path), "拒绝复用旧 Gmsh 文件: " + path)
    gm.write_gmsh_input_files()
    # 仅修改此次生成的 Gmsh 输入；不修改 FreeCAD 用户偏好或官方源码。
    with open(gm.temp_file_geo, encoding="utf-8") as stream:
        geo = stream.read()
    geo, count = re.subn(r"(?m)^General\.NumThreads\s*=\s*[^;]+;",
                        "General.NumThreads = 1;", geo)
    _require(count == 1, "Gmsh 输入没有唯一的线程配置")
    with open(gm.temp_file_geo, "w", encoding="utf-8") as stream:
        stream.write(geo)
    report["gmshNumOfThreads"] = 1
    _process("gmsh", [gm.gmsh_bin, "-v", "3", "-", gm.temp_file_geo], gm.working_dir, report, root)
    _require(os.path.isfile(gm.temp_file_mesh) and os.path.getsize(gm.temp_file_mesh) > 0,
             "Gmsh 未产生新的非空 UNV")
    gm.update_properties()
    doc.recompute()
    report["counts"] = {"node": int(mesh.FemMesh.NodeCount),
                        "volumeElement": int(mesh.FemMesh.VolumeCount)}
    _require(report["counts"]["node"] > 0 and report["counts"]["volumeElement"] > 0,
             "实际 Gmsh 网格没有节点或三维体单元")


def _inp_sections(text):
    sections = []
    current = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("**"):
            continue
        if line.startswith("*"):
            current = {"header": line.upper(), "rows": []}
            sections.append(current)
        elif current is not None:
            current["rows"].append(line)
    return sections


def _check_inp(path, fixed, options):
    with open(path, encoding="utf-8") as stream:
        sections = _inp_sections(stream.read())
    boundary = [row for section in sections if section["header"] == "*BOUNDARY"
                for row in section["rows"]]
    dload = [row for section in sections if section["header"].split(",")[0] == "*DLOAD"
             for row in section["rows"]]
    elastic = [row for section in sections if section["header"] == "*ELASTIC"
               for row in section["rows"]]
    fixed_nodes = [row for section in sections
                   if re.search(r"(?:^|,)\s*NSET\s*=\s*" + re.escape(fixed.Name.upper()) + r"(?:,|$)",
                                section["header"])
                   and section["header"].startswith("*NSET") for row in section["rows"]]
    _require(fixed_nodes and {fixed.Name + "," + str(axis) for axis in (1, 2, 3)}.issubset(boundary),
             "INP 没有真实固定端节点集或三个平动约束")
    _require(len(elastic) == 1, "INP 没有唯一的线弹性材料")
    constants = [float(value) for value in elastic[0].split(",")]
    _require(len(constants) == 2 and constants == [YOUNGS_MODULUS, 0.0],
             "INP 材料模量或泊松比不符")
    _require(dload, "INP 没有真实 DLOAD 压力记录")
    expected = -options["pressure"] if options["reversed"] else options["pressure"]
    for row in dload:
        fields = [value.strip() for value in row.split(",")]
        _require(len(fields) == 3 and int(fields[0]) > 0 and re.fullmatch(r"P[1-9]\d*", fields[1]),
                 "INP 压力未绑定体单元面: " + row)
        _require(math.isclose(float(fields[2]), expected, rel_tol=1e-10, abs_tol=1e-12),
                 "INP 压力数值或方向错误")
    return {"fixedNodeRows": len(fixed_nodes), "boundaryRows": len(boundary),
            "pressureElementFaces": len(dload), "elastic": constants}


def _solve(analysis, mesh, solver, fixed, options, report, root):
    tool = FemToolsCcx(analysis=analysis, solver=solver, test_mode=False)
    tool.update_objects()
    _require(tool.mesh is mesh, "CalculiX 选中了非本次网格")
    tool.setup_working_dir(report["paths"]["ccxDirectory"])
    _require(os.path.realpath(tool.working_dir) == report["paths"]["ccxDirectory"],
             "CalculiX 回退到了本次目录之外")
    prerequisites = tool.check_prerequisites()
    _require(not prerequisites, "CalculiX 前置条件不满足: " + prerequisites)
    tool.write_inp_file()
    _require(bool(tool.inp_file_name) and os.path.isfile(tool.inp_file_name), "未生成新 INP")
    inp = _inside(root, tool.inp_file_name)
    _require(os.path.dirname(inp) == tool.working_dir, "INP 未写入本次求解目录")
    frd = os.path.splitext(inp)[0] + ".frd"
    _require(not os.path.lexists(frd), "拒绝复用旧 FRD")
    report["paths"].update({"inp": inp, "frd": frd})
    report["inputValidation"] = _check_inp(inp, fixed, options)
    stdout, stderr = _process("ccx", [_binary("ccx", report), "-i", os.path.splitext(os.path.basename(inp))[0]],
                              tool.working_dir, report, root)
    _require(os.path.isfile(frd) and os.path.getsize(frd) > 0, "CalculiX 未生成新 FRD")
    tool.ccx_stdout, tool.ccx_stderr = stdout, stderr
    existing = {obj.Name for obj in doc.Objects}
    tool.load_results()
    results = [obj for obj in analysis.Group if obj.isDerivedFrom("Fem::FemResultObject")
               and obj.Name not in existing]
    _require(tool.results_present and results, "新 FRD 未装载出新的结果对象")
    report["resultObjects"] = [obj.Name for obj in results]
    return results[-1]


def _read_arrays(result_obj, report):
    node_ids = [int(node) for node in result_obj.NodeNumbers]
    arrays = {"nodeNumbers": node_ids,
              "displacement": [[float(vector.x), float(vector.y), float(vector.z)]
                               for vector in result_obj.DisplacementVectors]}
    for name, property_name in STRESS_PROPERTIES.items():
        arrays[name] = [float(value) for value in getattr(result_obj, property_name)]
    report["counts"]["resultNode"] = len(node_ids)
    report["arrayValidation"] = {"lengths": {name: len(values) for name, values in arrays.items()},
                                 "finite": False, "matchingLengths": False, "completeNodeCoverage": False}
    _require(node_ids and len(set(node_ids)) == len(node_ids), "FRD 节点为空或存在重复编号")
    _require(all(len(values) == len(node_ids) for values in arrays.values()), "FRD 位移／应力数组长度不匹配")
    report["arrayValidation"]["matchingLengths"] = True
    for name, values in arrays.items():
        scalars = (component for vector in values for component in vector) if name == "displacement" else values
        _require(all(math.isfinite(value) for value in scalars), "FRD 包含非有限数据: " + name)
    result_nodes = result_obj.Mesh.FemMesh.Nodes
    report["counts"]["resultMeshNode"] = int(result_obj.Mesh.FemMesh.NodeCount)
    _require(len(node_ids) == len(result_nodes) == report["counts"]["node"],
             "FRD 结果没有完整覆盖本次一阶体网格节点")
    _require(all(node in result_nodes for node in node_ids), "compact 结果网格缺少节点")
    report["arrayValidation"]["completeNodeCoverage"] = True
    arrays["positions"] = [[float(result_nodes[node].x), float(result_nodes[node].y), float(result_nodes[node].z)]
                           for node in node_ids]
    _require(all(math.isfinite(value) for point in arrays["positions"] for value in point),
             "结果网格坐标包含非有限值")
    report["arrayValidation"]["finite"] = True
    return arrays


def _analytical_check(arrays, options, report):
    pressure, length = options["pressure"], options["length"]
    signed_stress = pressure if options["reversed"] else -pressure
    expected_tip = signed_stress * length / YOUNGS_MODULUS
    ux, uy, uz = zip(*arrays["displacement"])
    positions = arrays["positions"]
    errors = {"ux": max(abs(displacement - signed_stress * point[0] / YOUNGS_MODULUS)
                         for point, displacement in zip(positions, ux, strict=True)) / abs(expected_tip),
              "uy": max(map(abs, uy)) / abs(expected_tip),
              "uz": max(map(abs, uz)) / abs(expected_tip),
              "vonMises": max(abs(value - pressure) for value in arrays["vonMises"]) / pressure,
              "sxx": max(abs(value - signed_stress) for value in arrays["sxx"]) / pressure}
    for name in ("syy", "szz", "sxy", "sxz", "syz"):
        errors[name] = max(map(abs, arrays[name])) / pressure
    free_end = [displacement for point, displacement in zip(positions, ux, strict=True)
                if abs(point[0] - length) < 1e-7]
    fixed_end = [displacement for point, displacement in zip(positions, ux, strict=True)
                 if abs(point[0]) < 1e-7]
    _require(free_end and fixed_end, "结果网格缺少固定端或加载端节点")
    mean_ux = sum(free_end) / len(free_end)
    errors["freeEndMeanUx"] = abs(mean_ux - expected_tip) / abs(expected_tip)
    report["analytical"] = {"youngsModulusMPa": YOUNGS_MODULUS, "poissonRatio": 0.0,
                            "expectedSignedStressMPa": signed_stress, "expectedTipUxMm": expected_tip,
                            "relativeTolerance": RELATIVE_TOLERANCE, "relativeErrors": errors,
                            "freeEndMeanUx": mean_ux, "freeEndNodeCount": len(free_end),
                            "fixedEndNodeCount": len(fixed_end),
                            "displacementBounds": {name: [min(values), max(values)]
                                                   for name, values in (("ux", ux), ("uy", uy), ("uz", uz))}}
    _require(max(map(abs, ux)) > 0 and max(arrays["vonMises"]) > 0, "FEM 位移或应力全零")
    _require(all(math.isfinite(error) and error <= RELATIVE_TOLERANCE for error in errors.values()),
             "FEM 解析误差超过严格 1%: " + json.dumps(errors, allow_nan=False))


def run_axial_case(options=None):
    options = _options({} if options is None else options)
    root = os.path.realpath(output_directory)
    _require(os.path.isdir(root), "FEM output_directory 必须是已存在目录")
    run_id = uuid.uuid4().hex
    run_directory = _inside(root, os.path.join(root, "fem-axial-" + run_id))
    os.mkdir(run_directory)
    paths = {"runDirectory": run_directory, "report": os.path.join(run_directory, "report.json"),
             "gmshDirectory": os.path.join(run_directory, "gmsh"),
             "ccxDirectory": os.path.join(run_directory, "ccx")}
    for path in (paths["gmshDirectory"], paths["ccxDirectory"]):
        os.mkdir(path)
    report = {"fixture": "fem-axial-pressure", "fixtureStatus": "running", "runId": run_id,
              "options": options, "paths": paths, "processes": {},
              "freecadVersion": [str(value) for value in App.Version()]}
    started = time.monotonic()
    try:
        _phase(report, root, "model")
        analysis, mesh, solver, fixed = _model(options, report)
        _phase(report, root, "gmsh")
        _new_mesh(mesh, report, root)
        _phase(report, root, "calculix")
        result_obj = _solve(analysis, mesh, solver, fixed, options, report, root)
        _phase(report, root, "result-arrays")
        arrays = _read_arrays(result_obj, report)
        report["resultData"] = arrays
        _phase(report, root, "analytical-check")
        _analytical_check(arrays, options, report)
        report["fixtureStatus"] = "passed"
        report["activePhase"] = "complete"
    except Exception as error:
        report["fixtureStatus"] = "failed"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        report["elapsedSeconds"] = time.monotonic() - started
        _persist(report, root)
    return report
