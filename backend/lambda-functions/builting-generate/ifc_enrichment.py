"""
ifc_enrichment.py — Post-processing BIM enrichment pass.

Runs after IFC generation, before S3 upload. Adds:
  - Property sets (Pset_WallCommon, Pset_DistributionFlowElementCommon, etc.)
  - Material assignments (IfcRelAssociatesMaterial + IfcMaterialLayerSetUsage)
  - Distribution ports (IfcDistributionPort + IfcRelConnectsPortToElement)
  - Topology connections (IfcRelConnectsPathElements) inferred from geometry proximity
  - MEP systems (IfcSystem + IfcRelServicesBuildings)

This does NOT modify geometry — it enriches BIM metadata only.
Non-fatal: any exception returns the original content unchanged.
"""

import re
import uuid
import numpy as np
import ifcopenshell
import ifcopenshell.guid


def enrich_ifc(ifc_path: str) -> str:
    """
    Read IFC from ifc_path, enrich in-place, write back, return enriched content.
    Returns original file content on any error.
    """
    with open(ifc_path, 'r') as f:
        original = f.read()

    try:
        model = ifcopenshell.open(ifc_path)
        _run_enrichment(model)
        model.write(ifc_path)
        with open(ifc_path, 'r') as f:
            return f.read()
    except Exception as e:
        print(f"[enrichment] Non-fatal error — returning original IFC: {e}")
        return original


def _new_guid():
    return ifcopenshell.guid.compress(uuid.uuid4().hex)


def _run_enrichment(f):
    owner_histories = f.by_type("IfcOwnerHistory")
    if not owner_histories:
        print("[enrichment] No IfcOwnerHistory — skipping enrichment")
        return
    oh = owner_histories[0]

    walls   = f.by_type("IfcWall")
    flows   = f.by_type("IfcFlowSegment")
    lights  = f.by_type("IfcLightFixture")
    cables  = f.by_type("IfcCableCarrierSegment")

    tunnel_walls = [w for w in walls if re.search(r'Tunnel|TunnelChain|Shaft|PORTAL', w.Name or '')]
    duct_flows   = [fl for fl in flows if 'DUCT' in (fl.Name or '')]
    pipe_flows   = [fl for fl in flows if 'DUCT' not in (fl.Name or '')]

    print(f"[enrichment] {len(walls)} walls ({len(tunnel_walls)} tunnel), "
          f"{len(duct_flows)} ducts, {len(pipe_flows)} pipes, "
          f"{len(lights)} lights, {len(cables)} cables")

    _add_property_sets(f, oh, tunnel_walls, duct_flows, pipe_flows)
    _add_materials(f, oh, tunnel_walls, duct_flows, lights, cables)
    # Distribution ports skipped — xeokit renders them as visual indicators (clutter)
    _add_path_connections(f, oh, walls, flows)
    _add_mep_systems(f, oh, list(flows), list(lights), list(cables))

    print("[enrichment] Done")


# ─────────────────────────────────────────────────────────────────────────────
# Property sets
# ─────────────────────────────────────────────────────────────────────────────

def _make_pset(f, oh, name, props_dict, elements_list):
    if not elements_list:
        return
    prop_entities = []
    for pname, pval in props_dict.items():
        if isinstance(pval, bool):
            nom = f.create_entity("IfcLogical", wrappedValue=("TRUE" if pval else "FALSE"))
        elif isinstance(pval, float):
            nom = f.create_entity("IfcReal", wrappedValue=pval)
        elif isinstance(pval, int):
            nom = f.create_entity("IfcInteger", wrappedValue=pval)
        else:
            nom = f.create_entity("IfcLabel", wrappedValue=str(pval))
        prop_entities.append(
            f.create_entity("IfcPropertySingleValue", Name=pname, NominalValue=nom)
        )
    pset = f.create_entity("IfcPropertySet",
        GlobalId=_new_guid(), OwnerHistory=oh,
        Name=name, HasProperties=prop_entities)
    f.create_entity("IfcRelDefinesByProperties",
        GlobalId=_new_guid(), OwnerHistory=oh,
        RelatedObjects=elements_list,
        RelatingPropertyDefinition=pset)


def _add_property_sets(f, oh, tunnel_walls, duct_flows, pipe_flows):
    if tunnel_walls:
        _make_pset(f, oh, "Pset_WallCommon", {
            "Reference": "TunnelWall",
            "IsExternal": False,
            "LoadBearing": True,
            "FireRating": "120",
            "AcousticRating": "50",
            "Combustible": False,
            "SurfaceSpreadOfFlame": "Class 0",
            "ThermalTransmittance": 0.35,
        }, tunnel_walls)

    if duct_flows:
        _make_pset(f, oh, "Pset_FlowSegmentDuctSegment", {
            "Shape": "Circular",
            "Roughness": 0.00015,
        }, duct_flows)
        _make_pset(f, oh, "Pset_DistributionFlowElementCommon", {
            "Reference": "VentDuct",
            "Status": "EXISTING",
        }, duct_flows)

    if pipe_flows:
        _make_pset(f, oh, "Pset_FlowSegmentPipeSegment", {
            "Shape": "Circular",
            "InternalRoughness": 0.000046,
        }, pipe_flows)
        _make_pset(f, oh, "Pset_DistributionFlowElementCommon", {
            "Reference": "VentPipe",
            "Status": "EXISTING",
        }, pipe_flows)

    print(f"[enrichment] Property sets added")


# ─────────────────────────────────────────────────────────────────────────────
# Materials
# ─────────────────────────────────────────────────────────────────────────────

def _assign_material(f, oh, mat_name, elements_list):
    if not elements_list:
        return
    mat = f.create_entity("IfcMaterial", Name=mat_name)
    f.create_entity("IfcRelAssociatesMaterial",
        GlobalId=_new_guid(), OwnerHistory=oh,
        RelatedObjects=elements_list,
        RelatingMaterial=mat)


def _add_materials(f, oh, tunnel_walls, duct_flows, lights, cables):
    if tunnel_walls:
        _assign_material(f, oh, "Concrete, Cast-in-Place gray", tunnel_walls)

    if duct_flows:
        steel = f.create_entity("IfcMaterial", Name="Metal - Painted - Grey")
        layer = f.create_entity("IfcMaterialLayer", Material=steel, LayerThickness=0.002)
        layer_set = f.create_entity("IfcMaterialLayerSet",
            MaterialLayers=[layer], LayerSetName="Duct Wall")
        for fl in duct_flows:
            usage = f.create_entity("IfcMaterialLayerSetUsage",
                ForLayerSet=layer_set,
                LayerSetDirection="AXIS2",
                DirectionSense="POSITIVE",
                OffsetFromReferenceLine=0.0)
            f.create_entity("IfcRelAssociatesMaterial",
                GlobalId=_new_guid(), OwnerHistory=oh,
                RelatedObjects=[fl],
                RelatingMaterial=usage)

    if lights:
        _assign_material(f, oh, "Aluminum", list(lights))

    if cables:
        _assign_material(f, oh, "Metal - Painted - Grey", list(cables))

    print("[enrichment] Materials assigned")


# ─────────────────────────────────────────────────────────────────────────────
# Distribution ports
# ─────────────────────────────────────────────────────────────────────────────

def _make_port(f, oh, name, flow_direction):
    pt = f.create_entity("IfcCartesianPoint", Coordinates=(0., 0., 0.))
    ax = f.create_entity("IfcAxis2Placement3D", Location=pt, Axis=None, RefDirection=None)
    placement = f.create_entity("IfcLocalPlacement", PlacementRelTo=None, RelativePlacement=ax)
    return f.create_entity("IfcDistributionPort",
        GlobalId=_new_guid(), OwnerHistory=oh,
        Name=name, ObjectPlacement=placement,
        FlowDirection=flow_direction)


def _add_distribution_ports(f, oh, flow_elems):
    elem_ports = {}
    for fl in flow_elems:
        in_p  = _make_port(f, oh, f"InPort_{fl.Name}",  "SINK")
        out_p = _make_port(f, oh, f"OutPort_{fl.Name}", "SOURCE")
        elem_ports[fl.id()] = (in_p, out_p)
        f.create_entity("IfcRelConnectsPortToElement",
            GlobalId=_new_guid(), OwnerHistory=oh,
            RelatingPort=in_p, RelatedElement=fl)
        f.create_entity("IfcRelConnectsPortToElement",
            GlobalId=_new_guid(), OwnerHistory=oh,
            RelatingPort=out_p, RelatedElement=fl)
    print(f"[enrichment] Created {len(flow_elems) * 2} distribution ports")
    return elem_ports


# ─────────────────────────────────────────────────────────────────────────────
# Path element connections (topology)
# ─────────────────────────────────────────────────────────────────────────────

def _brep_bbox(elem):
    reps = elem.Representation
    if not reps:
        return None
    for rep in reps.Representations:
        for item in rep.Items:
            if item.is_a("IfcFacetedBrep"):
                pts = []
                for face in item.Outer.CfsFaces:
                    for bound in face.Bounds:
                        for pt in bound.Bound.Polygon:
                            pts.append(pt.Coordinates)
                if pts:
                    arr = np.array(pts, dtype=float)
                    return arr.min(axis=0), arr.max(axis=0)
    return None


def _add_path_connections(f, oh, walls, flows, topo_tol=2.5):
    candidates = []
    for elem in list(walls) + list(flows):
        result = _brep_bbox(elem)
        if result:
            mn, mx = result
            candidates.append({"elem": elem, "min": mn, "max": mx, "center": (mn + mx) / 2})

    count = 0
    for i, a in enumerate(candidates):
        for j, b in enumerate(candidates):
            if j <= i:
                continue
            gx = max(a["min"][0] - b["max"][0], b["min"][0] - a["max"][0], 0)
            gy = max(a["min"][1] - b["max"][1], b["min"][1] - a["max"][1], 0)
            gz = max(a["min"][2] - b["max"][2], b["min"][2] - a["max"][2], 0)
            dist = (gx**2 + gy**2 + gz**2) ** 0.5
            if dist < topo_tol:
                a_start = a["center"][0] < b["center"][0]
                f.create_entity("IfcRelConnectsPathElements",
                    GlobalId=_new_guid(), OwnerHistory=oh,
                    Name=f"{a['elem'].Name}|{b['elem'].Name}",
                    RelatingElement=a["elem"],
                    RelatedElement=b["elem"],
                    RelatingPriorities=[], RelatedPriorities=[],
                    RelatedConnectionType="ATEND" if a_start else "ATSTART",
                    RelatingConnectionType="ATSTART" if a_start else "ATEND")
                count += 1

    print(f"[enrichment] {count} path element connections")


# ─────────────────────────────────────────────────────────────────────────────
# MEP systems
# ─────────────────────────────────────────────────────────────────────────────

def _add_mep_systems(f, oh, flow_elems, lights, cables):
    buildings = f.by_type("IfcBuilding")
    if not buildings:
        print("[enrichment] No IfcBuilding — skipping MEP systems")
        return
    building = buildings[0]

    def make_system(name, desc, members):
        if not members:
            return
        sys = f.create_entity("IfcSystem",
            GlobalId=_new_guid(), OwnerHistory=oh,
            Name=name, Description=desc)
        f.create_entity("IfcRelAssignsToGroup",
            GlobalId=_new_guid(), OwnerHistory=oh,
            RelatedObjects=members, RelatedObjectsType="PRODUCT",
            RelatingGroup=sys)
        f.create_entity("IfcRelServicesBuildings",
            GlobalId=_new_guid(), OwnerHistory=oh,
            RelatingSystem=sys, RelatedBuildings=[building])

    make_system("Mechanical Ventilation", "Tunnel ventilation duct network", flow_elems)
    make_system("Lighting System",        "Tunnel lighting fixtures",         lights)
    make_system("Cable Management System","Tunnel cable trays",               cables)

    print("[enrichment] MEP systems created")
