"""
clean_building_export.py — Clean building export (Phase 1).

Universal building exporter: handles any engineered structure with walls,
spaces, and systems — residential, office, hospital, warehouse, school, etc.
Tunnel remains its own profile (clean_tunnel_export.py). This module fires
for every non-tunnel CSS.

Pipeline
--------
    1. Parse and validate SPACE, WALL, SLAB, DOOR, WINDOW, DUCT elements.
    2. For each CSS storey, create an IfcBuildingStorey.
    3. Emit:
         - IfcSpace  per SPACE  with bounding-box extrusion.
         - IfcWall   per WALL   extruded vertically from a rectangular profile.
         - IfcSlab   per SLAB   extruded vertically from a rectangular profile.
         - IfcDoor   per DOOR   (standalone box; IfcRelVoidsElement in Phase 2).
         - IfcWindow per WINDOW (standalone box; IfcRelVoidsElement in Phase 2).
         - IfcDuctSegment per DUCT with a path-swept rectangular or circular profile.
    4. Dump normalized scene to S3 debug/<render_id>_building_scene.json.

This module is self-contained: it does NOT import helpers from the legacy
generator or from clean_tunnel_export. Any geometry primitive used here is
defined in this file or imported from secondary_geometry.*.

Validation rules (Phase 1)
--------------------------
SPACE  : width > 0 AND depth > 0 AND height > 0.
WALL   : run length > 0 AND height > 0 AND thickness > 0.
SLAB   : width > 0 AND depth > 0 AND thickness > 0.
DOOR   : width > 0 AND height > 0 AND hostWallId references a known wall.
WINDOW : width > 0 AND height > 0 AND hostWallId references a known wall.
DUCT   : pathPoints has >= 2 points, run length > 0, profile width > 0 AND height > 0.
"""

import json
import math
import os
from datetime import datetime, timezone

import ifcopenshell
import ifcopenshell.guid

from secondary_geometry.profile_config import load_profile, format_profile


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WALL_COLOR          = (0.753, 0.753, 0.753)   # concrete/frame gray
SLAB_COLOR          = (0.65,  0.65,  0.65)    # floor concrete
DOOR_COLOR          = (0.50,  0.30,  0.15)    # wood brown
WINDOW_COLOR        = (0.60,  0.82,  0.95)    # glass sky blue
SPACE_COLOR         = (0.88,  0.92,  0.96)    # light tint — rooms
DUCT_SUPPLY_COLOR   = (0.10,  0.45,  0.88)    # supply air blue
DUCT_RETURN_COLOR   = (0.15,  0.68,  0.30)    # return air green
DUCT_EXHAUST_COLOR  = (0.92,  0.55,  0.10)    # exhaust orange
DUCT_DEFAULT_COLOR  = (0.00,  0.72,  0.87)    # HVAC cyan fallback

WALL_HEIGHT_DEFAULT = 2.74       # m (9 ft) — used when geometry.depth is absent
WALL_THICKNESS_MIN  = 0.01       # m — below this: reject wall
WALL_LENGTH_MIN     = 0.10       # m — below this: reject wall
WALL_HEIGHT_MIN     = 0.10       # m — below this: reject wall
SLAB_THICKNESS_MIN  = 0.01       # m
SLAB_DIM_MIN        = 0.10       # m — width or depth below this: reject slab
DOOR_WIDTH_MIN      = 0.40       # m
DOOR_HEIGHT_MIN     = 1.50       # m
WINDOW_WIDTH_MIN    = 0.20       # m
WINDOW_HEIGHT_MIN   = 0.20       # m
DUCT_LENGTH_MIN     = 0.10       # m
DUCT_DIM_MIN        = 0.01       # m — profile dim below this: reject duct


# ---------------------------------------------------------------------------
# Mode detection
# ---------------------------------------------------------------------------

_BUILDING_PROFILES = frozenset({
    'building', 'residential', 'office', 'hospital', 'warehouse',
    'school', 'retail', 'industrial', 'mixed_use', 'civic',
})

_BUILDING_DOMAINS = frozenset({
    'BUILDING', 'RESIDENTIAL', 'OFFICE', 'HOSPITAL', 'WAREHOUSE',
    'SCHOOL', 'RETAIL', 'INDUSTRIAL', 'MIXED_USE', 'CIVIC',
    # Architectural/design domain names Claude extract may produce
    'ARCH', 'ARCHITECTURAL', 'COMMERCIAL', 'INSTITUTIONAL', 'HEALTHCARE',
    'EDUCATION', 'MULTIFAMILY', 'SINGLEFAMILY', 'MIXED',
})


def is_clean_building_mode_enabled(css):
    """True iff CSS is a non-tunnel building structure.

    Fires for any engineered structure with walls/spaces/systems that is NOT
    a tunnel. Tunnel detection runs first in the router; if it claims the CSS
    this function is never called. This guard is a belt-and-suspenders check.

    Activation triggers (any one is sufficient):
        - CLEAN_EXPORT_PROFILE env var set to a known building profile name
        - css.domain  in BUILDING_DOMAINS
        - css.facility.type  in BUILDING_PROFILES
        - css.metadata.exportProfile  in BUILDING_PROFILES
    """
    elements = css.get('elements', []) or []
    if any(e.get('type') == 'TUNNEL_SEGMENT' for e in elements):
        return False

    profile_env = (os.environ.get('CLEAN_EXPORT_PROFILE') or '').strip().lower()
    if profile_env in _BUILDING_PROFILES:
        return True

    domain = (css.get('domain') or '').strip().upper()
    if domain in _BUILDING_DOMAINS:
        return True

    fac_type = (css.get('facility', {}) or {}).get('type', '').strip().lower()
    if fac_type in _BUILDING_PROFILES:
        return True

    export_profile = (css.get('metadata', {}) or {}).get('exportProfile', '').strip().lower()
    if export_profile in _BUILDING_PROFILES:
        return True

    return False


# ---------------------------------------------------------------------------
# IFC helpers
# ---------------------------------------------------------------------------

def _new_guid():
    return ifcopenshell.guid.new()


def _safe_float(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _make_axis2_3d(f, origin, axis, ref_dir):
    """IfcAxis2Placement3D from plain Python tuples."""
    o = f.create_entity('IfcCartesianPoint', Coordinates=tuple(float(c) for c in origin))
    z = f.create_entity('IfcDirection', DirectionRatios=tuple(float(c) for c in axis))
    x = f.create_entity('IfcDirection', DirectionRatios=tuple(float(c) for c in ref_dir))
    return f.create_entity('IfcAxis2Placement3D', Location=o, Axis=z, RefDirection=x)


def _local_placement(f, parent_lp, origin, axis=(0, 0, 1), ref=(1, 0, 0)):
    a2p = _make_axis2_3d(f, origin, axis, ref)
    return f.create_entity('IfcLocalPlacement',
                           PlacementRelTo=parent_lp, RelativePlacement=a2p)


def _rgba(f, rgb, alpha=1.0):
    col = f.create_entity('IfcColourRgb', Red=rgb[0], Green=rgb[1], Blue=rgb[2])
    return f.create_entity('IfcSurfaceStyleRendering',
                           SurfaceColour=col, Transparency=1.0 - alpha,
                           ReflectanceMethod='FLAT')


def _add_color(f, ifc_elem, rgb, alpha=1.0):
    style = f.create_entity('IfcSurfaceStyle',
                             Name='Color', Side='BOTH',
                             Styles=(_rgba(f, rgb, alpha),))
    psa = f.create_entity('IfcPresentationStyleAssignment', Styles=(style,))
    items = list(ifc_elem.Representation.Representations
                 if ifc_elem.Representation else [])
    for rep in items:
        for item in (rep.Items or []):
            f.create_entity('IfcStyledItem', Item=item,
                            Styles=(psa,))


def _rect_profile(f, width, height, label=''):
    return f.create_entity('IfcRectangleProfileDef',
                            ProfileType='AREA', ProfileName=label,
                            XDim=float(width), YDim=float(height))


def _extrude(f, subctx, profile, depth, placement_3d):
    """IfcExtrudedAreaSolid — always extrudes along local +Z."""
    pt = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    pos = f.create_entity('IfcAxis2Placement3D', Location=pt)
    z_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    solid = f.create_entity('IfcExtrudedAreaSolid',
                             SweptArea=profile,
                             Position=pos,
                             ExtrudedDirection=z_dir,
                             Depth=float(depth))
    shape_rep = f.create_entity('IfcShapeRepresentation',
                                ContextOfItems=subctx,
                                RepresentationIdentifier='Body',
                                RepresentationType='SweptSolid',
                                Items=(solid,))
    return f.create_entity('IfcProductDefinitionShape',
                           Representations=(shape_rep,)), solid


def _sweep_rect_path(f, subctx, path_pts, width, height):
    """IfcSweptDiskSolid approximation for rectangular ducts via extrusion.

    For a simple two-point straight run, use extrusion along the run direction.
    """
    if len(path_pts) < 2:
        return None, None

    p0, p1 = path_pts[0], path_pts[-1]
    dx = float(p1[0]) - float(p0[0])
    dy = float(p1[1]) - float(p0[1])
    dz = float(p1[2]) - float(p0[2])
    length = math.sqrt(dx * dx + dy * dy + dz * dz)
    if length < DUCT_LENGTH_MIN:
        return None, None

    # Normalize run direction
    rx, ry, rz = dx / length, dy / length, dz / length

    # Build a perpendicular ref axis: prefer Z-cross, fall back to X-cross
    if abs(rz) < 0.9:
        ux, uy, uz = 0.0, 0.0, 1.0
    else:
        ux, uy, uz = 1.0, 0.0, 0.0
    # ref_dir = up cross run_dir (so section XY = duct cross-section plane)
    cx = uy * rz - uz * ry
    cy = uz * rx - ux * rz
    cz = ux * ry - uy * rx
    cl = math.sqrt(cx * cx + cy * cy + cz * cz)
    if cl < 1e-9:
        cx, cy, cz = 1.0, 0.0, 0.0
    else:
        cx, cy, cz = cx / cl, cy / cl, cz / cl

    # Profile: duct cross-section in local XY (profile extrudes along local Z = run)
    profile = _rect_profile(f, width, height, 'DuctProfile')
    pt = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    pos = f.create_entity('IfcAxis2Placement3D', Location=pt)
    run_dir = f.create_entity('IfcDirection', DirectionRatios=(rx, ry, rz))
    solid = f.create_entity('IfcExtrudedAreaSolid',
                             SweptArea=profile, Position=pos,
                             ExtrudedDirection=run_dir, Depth=float(length))
    shape_rep = f.create_entity('IfcShapeRepresentation',
                                ContextOfItems=subctx,
                                RepresentationIdentifier='Body',
                                RepresentationType='SweptSolid',
                                Items=(solid,))
    pds = f.create_entity('IfcProductDefinitionShape',
                          Representations=(shape_rep,))
    return pds, solid


def _containment(f, owner, storey, elements):
    """IfcRelContainedInSpatialStructure — all elements placed in storey."""
    if not elements:
        return
    f.create_entity('IfcRelContainedInSpatialStructure',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingStructure=storey, RelatedElements=tuple(elements))


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _resolve_wall_dims(elem):
    """Extract (run_length, wall_thickness, wall_height) from a CSS WALL element.

    Returns None if any dimension fails validation.
    """
    geom = elem.get('geometry') or {}
    prof = geom.get('profile') or {}
    run_len = _safe_float(prof.get('width'), 0.0)
    thickness = _safe_float(prof.get('height'), 0.0)
    height = _safe_float(geom.get('depth'), WALL_HEIGHT_DEFAULT)

    # Fall back to start/end distance when profile width is missing/zero
    if run_len <= WALL_LENGTH_MIN:
        props = elem.get('properties') or {}
        sp = props.get('startPoint') or {}
        ep = props.get('endPoint') or {}
        sx, sy = _safe_float(sp.get('x')), _safe_float(sp.get('y'))
        ex, ey = _safe_float(ep.get('x')), _safe_float(ep.get('y'))
        run_len = math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2)

    if run_len < WALL_LENGTH_MIN:
        return None
    if thickness < WALL_THICKNESS_MIN:
        return None
    if height < WALL_HEIGHT_MIN:
        return None
    return run_len, thickness, height


def _resolve_slab_dims(elem):
    """Extract (width, depth, thickness) from a CSS SLAB element."""
    geom = elem.get('geometry') or {}
    prof = geom.get('profile') or {}
    width = _safe_float(prof.get('width'), 0.0)
    depth = _safe_float(prof.get('height'), 0.0)
    thickness = _safe_float(geom.get('depth'), 0.0)
    if width < SLAB_DIM_MIN or depth < SLAB_DIM_MIN or thickness < SLAB_THICKNESS_MIN:
        return None
    return width, depth, thickness


def _resolve_opening_dims(elem):
    """Extract (width, height) from a CSS DOOR or WINDOW element."""
    geom = elem.get('geometry') or {}
    prof = geom.get('profile') or {}
    width = _safe_float(prof.get('width'), 0.0)
    height = _safe_float(geom.get('depth'), 0.0)
    return width, height


def _resolve_duct_dims(elem):
    """Extract (path_pts, profile_w, profile_h) from a CSS DUCT element."""
    geom = elem.get('geometry') or {}
    path_pts_raw = geom.get('pathPoints') or []
    prof = geom.get('profile') or {}
    pw = _safe_float(prof.get('width'), 0.0)
    ph = _safe_float(prof.get('height'), pw)   # square fallback

    # Convert list-of-dicts or list-of-lists
    pts = []
    for p in path_pts_raw:
        if isinstance(p, dict):
            pts.append((_safe_float(p.get('x')), _safe_float(p.get('y')),
                        _safe_float(p.get('z'))))
        elif isinstance(p, (list, tuple)) and len(p) >= 3:
            pts.append((_safe_float(p[0]), _safe_float(p[1]), _safe_float(p[2])))

    if len(pts) < 2:
        return None
    if pw < DUCT_DIM_MIN or ph < DUCT_DIM_MIN:
        return None

    dx = pts[-1][0] - pts[0][0]
    dy = pts[-1][1] - pts[0][1]
    dz = pts[-1][2] - pts[0][2]
    if math.sqrt(dx * dx + dy * dy + dz * dz) < DUCT_LENGTH_MIN:
        return None

    return pts, pw, ph


# ---------------------------------------------------------------------------
# Normalized scene dump
# ---------------------------------------------------------------------------

def _dump_building_scene(css, render_id, user_id, walls_kept, slabs_kept,
                          spaces_kept, doors_kept, windows_kept, ducts_kept,
                          skipped, profile):
    """Write the full interpreted scene state to S3 BEFORE IFC emission.

    Output: s3://builting-ifc/debug/<render_id>_building_scene.json
    """
    try:
        import boto3
    except Exception as ex:
        print(f"[RES-DUMP] boto3 unavailable, skipping: {ex}")
        return

    IFC_BUCKET = os.environ.get('IFC_BUCKET', 'builting-ifc')

    facility = css.get('facility', {}) or {}
    metadata = css.get('metadata', {}) or {}

    # Bounding box over all placed element origins + endpoints
    bbox_xs, bbox_ys, bbox_zs = [], [], []

    def _ingest(pt):
        if pt is None:
            return
        try:
            bbox_xs.append(float(pt[0]))
            bbox_ys.append(float(pt[1]))
            bbox_zs.append(float(pt[2]))
        except (TypeError, ValueError, IndexError):
            pass

    for info in walls_kept + slabs_kept + spaces_kept:
        _ingest(info.get('origin'))
    for info in doors_kept + windows_kept:
        _ingest(info.get('origin'))
    for info in ducts_kept:
        for pt in info.get('path', []):
            _ingest(pt)

    bbox = None
    if bbox_xs:
        bbox = {
            'min': {'x': min(bbox_xs), 'y': min(bbox_ys), 'z': min(bbox_zs)},
            'max': {'x': max(bbox_xs), 'y': max(bbox_ys), 'z': max(bbox_zs)},
        }

    # Histogram
    histogram = {}
    for e in (css.get('elements') or []):
        t = e.get('type', 'UNKNOWN')
        histogram[t] = histogram.get(t, 0) + 1

    scene = {
        'render_id': render_id,
        'user_id': user_id,
        'facility_name': facility.get('name'),
        'profile_kind': 'building',
        'profile_resolved': format_profile(profile),
        'bbox': bbox,
        'element_type_histogram': histogram,
        'css_metadata_keys': sorted(list(metadata.keys())),
        'spaces': spaces_kept,
        'walls': walls_kept,
        'slabs': slabs_kept,
        'doors': doors_kept,
        'windows': windows_kept,
        'ducts': ducts_kept,
        'skipped': skipped,
        'counts': {
            'spaces': len(spaces_kept),
            'walls': len(walls_kept),
            'slabs': len(slabs_kept),
            'doors': len(doors_kept),
            'windows': len(windows_kept),
            'ducts': len(ducts_kept),
            'skipped': len(skipped),
        },
    }

    safe_render = str(render_id or 'unknown').replace('/', '_')
    key = f'debug/{safe_render}_building_scene.json'
    try:
        s3 = boto3.client('s3')
        s3.put_object(
            Bucket=IFC_BUCKET,
            Key=key,
            Body=json.dumps(scene, indent=2, default=str).encode('utf-8'),
            ContentType='application/json',
        )
        print(f"[BLD-DUMP] Scene written to s3://{IFC_BUCKET}/{key}")
    except Exception as ex:
        print(f"[BLD-DUMP] S3 write failed: {ex}")


# ---------------------------------------------------------------------------
# Main generator
# ---------------------------------------------------------------------------

def generate_clean_building_ifc(css):
    """Phase 1 clean building export — universal non-tunnel structures.

    Returns the same 5-tuple as the legacy generator:
        (ifc_string, element_count, error_count, orientation_warnings, report)
    """
    profile = load_profile()
    print(f'[BLD] profile resolved: {format_profile(profile)}')

    facility      = css.get('facility', {}) or {}
    facility_name = facility.get('name', 'Residential Building')
    levels        = css.get('levelsOrSegments', []) or []
    elements      = css.get('elements', []) or []
    ts = int(datetime.now(timezone.utc).timestamp())

    # Log input histogram
    hist = {}
    for e in elements:
        t = e.get('type', 'UNKNOWN')
        hist[t] = hist.get(t, 0) + 1
    print(f'[BLD] CSS input histogram: {json.dumps(hist)}')

    # Build index of all wall IDs for door/window host validation
    wall_ids = {e.get('id') for e in elements if e.get('type') == 'WALL'}

    # ---- IFC boilerplate ----
    f = ifcopenshell.file(schema='IFC4')

    person = f.create_entity('IfcPerson', GivenName='Person')
    org    = f.create_entity('IfcOrganization', Name='Builting')
    pando  = f.create_entity('IfcPersonAndOrganization',
                             ThePerson=person, TheOrganization=org)
    app    = f.create_entity('IfcApplication',
                             ApplicationDeveloper=org, Version='res-1',
                             ApplicationFullName='Builting CleanBuildingExport',
                             ApplicationIdentifier='BCBE')
    owner  = f.create_entity('IfcOwnerHistory',
                             OwningUser=pando, OwningApplication=app,
                             ChangeAction='ADDED', CreationDate=ts)

    u_len  = f.create_entity('IfcSIUnit', UnitType='LENGTHUNIT',  Name='METRE')
    u_area = f.create_entity('IfcSIUnit', UnitType='AREAUNIT',    Name='SQUARE_METRE')
    u_vol  = f.create_entity('IfcSIUnit', UnitType='VOLUMEUNIT',  Name='CUBIC_METRE')
    u_ang  = f.create_entity('IfcSIUnit', UnitType='PLANEANGLEUNIT', Name='RADIAN')
    units  = f.create_entity('IfcUnitAssignment', Units=(u_len, u_area, u_vol, u_ang))

    wcs     = _make_axis2_3d(f, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
    context = f.create_entity('IfcGeometricRepresentationContext',
                              ContextIdentifier='Model', ContextType='Model',
                              CoordinateSpaceDimension=3, Precision=1e-5,
                              WorldCoordinateSystem=wcs)
    body_sub = f.create_entity('IfcGeometricRepresentationSubContext',
                               ContextIdentifier='Body', ContextType='Model',
                               ParentContext=context, TargetView='MODEL_VIEW')

    project = f.create_entity('IfcProject',
                              GlobalId=_new_guid(), OwnerHistory=owner,
                              Name=facility_name,
                              RepresentationContexts=(context,),
                              UnitsInContext=units)
    proj_lp = f.create_entity('IfcLocalPlacement',
                              PlacementRelTo=None, RelativePlacement=wcs)
    site = f.create_entity('IfcSite',
                           GlobalId=_new_guid(), OwnerHistory=owner, Name='Site',
                           ObjectPlacement=proj_lp, CompositionType='ELEMENT')
    bld_lp = f.create_entity('IfcLocalPlacement',
                             PlacementRelTo=site.ObjectPlacement,
                             RelativePlacement=wcs)
    building = f.create_entity('IfcBuilding',
                               GlobalId=_new_guid(), OwnerHistory=owner,
                               Name=facility_name, ObjectPlacement=bld_lp,
                               CompositionType='ELEMENT')

    f.create_entity('IfcRelAggregates', GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingObject=project, RelatedObjects=(site,))
    f.create_entity('IfcRelAggregates', GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingObject=site, RelatedObjects=(building,))

    # ---- Build storey objects ----
    # Map levelId → (storey IFC object, local placement) for element assignment
    storey_map = {}   # levelId → (ifc_storey, storey_lp)
    storey_list = []

    if levels:
        for lv in levels:
            lv_id   = lv.get('id', f'storey-{len(storey_map)}')
            lv_name = lv.get('name', lv_id)
            lv_elev = _safe_float(lv.get('elevation_m'), 0.0)
            lv_lp   = f.create_entity('IfcLocalPlacement',
                                      PlacementRelTo=bld_lp, RelativePlacement=wcs)
            lv_storey = f.create_entity('IfcBuildingStorey',
                                        GlobalId=_new_guid(), OwnerHistory=owner,
                                        Name=lv_name, ObjectPlacement=lv_lp,
                                        CompositionType='ELEMENT', Elevation=lv_elev)
            storey_map[lv_id] = (lv_storey, lv_lp)
            storey_list.append(lv_storey)
    else:
        # No levels in CSS — create one default storey
        def_lp = f.create_entity('IfcLocalPlacement',
                                  PlacementRelTo=bld_lp, RelativePlacement=wcs)
        def_storey = f.create_entity('IfcBuildingStorey',
                                     GlobalId=_new_guid(), OwnerHistory=owner,
                                     Name='Ground Floor', ObjectPlacement=def_lp,
                                     CompositionType='ELEMENT', Elevation=0.0)
        storey_map['_default'] = (def_storey, def_lp)
        storey_list.append(def_storey)

    f.create_entity('IfcRelAggregates', GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingObject=building, RelatedObjects=tuple(storey_list))

    # ---- Helper: resolve storey for an element ----
    def _storey_for(elem):
        lid = elem.get('levelId') or elem.get('level_id') or '_default'
        if lid in storey_map:
            return storey_map[lid]
        # fuzzy match: first partial match
        for k, v in storey_map.items():
            if k in lid or lid in k:
                return v
        # default to first storey
        return next(iter(storey_map.values()))

    # ---- Helper: element origin tuple ----
    def _origin_of(elem):
        pl = elem.get('placement') or {}
        o  = pl.get('origin') or {}
        return (
            _safe_float(o.get('x'), 0.0),
            _safe_float(o.get('y'), 0.0),
            _safe_float(o.get('z'), 0.0),
        )

    def _ref_dir_of(elem):
        pl = elem.get('placement') or {}
        r  = pl.get('refDirection') or {}
        rx = _safe_float(r.get('x'), 1.0)
        ry = _safe_float(r.get('y'), 0.0)
        rz = _safe_float(r.get('z'), 0.0)
        l  = math.sqrt(rx * rx + ry * ry + rz * rz)
        if l < 1e-9:
            return (1.0, 0.0, 0.0)
        return (rx / l, ry / l, rz / l)

    # Per-storey element buckets for IfcRelContainedInSpatialStructure
    storey_elements = {k: [] for k in storey_map}

    # Diagnostic tracking
    skipped          = []
    walls_kept       = []
    slabs_kept       = []
    spaces_kept      = []
    doors_kept       = []
    windows_kept     = []
    ducts_kept       = []
    element_count    = 0
    error_count      = 0

    counts = {
        'spaces_emitted': 0, 'spaces_skipped': 0,
        'walls_emitted': 0,  'walls_skipped': 0,
        'slabs_emitted': 0,  'slabs_skipped': 0,
        'doors_emitted': 0,  'doors_skipped_invalid': 0,
        'doors_skipped_no_host': 0,
        'windows_emitted': 0, 'windows_skipped_invalid': 0,
        'windows_skipped_no_host': 0,
        'ducts_emitted': 0,  'ducts_skipped': 0,
    }

    # ========== Process elements ==========
    for elem in elements:
        css_type = (elem.get('type') or '').upper()
        elem_id  = elem.get('id', '<no-id>')
        elem_name = elem.get('name') or elem_id

        storey_obj, storey_lp = _storey_for(elem)
        storey_key = elem.get('levelId') or '_default'
        origin = _origin_of(elem)
        ref    = _ref_dir_of(elem)

        # ---- SPACE --------------------------------------------------------
        if css_type == 'SPACE':
            geom = elem.get('geometry') or {}
            prof = geom.get('profile') or {}
            w = _safe_float(prof.get('width'),  0.0)
            d = _safe_float(prof.get('height'), 0.0)
            h = _safe_float(geom.get('depth'),  WALL_HEIGHT_DEFAULT)
            if w <= 0 or d <= 0 or h <= 0:
                msg = f"SPACE {elem_id}: invalid dims w={w} d={d} h={h} — skip"
                print(f"[BLD][SKIP] {msg}")
                skipped.append({'id': elem_id, 'type': 'SPACE', 'reason': msg})
                counts['spaces_skipped'] += 1
                error_count += 1
                continue

            # Rect profile centered at origin, extrude up
            profile_def = _rect_profile(f, w, d, 'SpaceProfile')
            lp = _local_placement(f, storey_lp, origin, (0, 0, 1), ref)
            pds, _ = _extrude(f, body_sub, profile_def, h, None)
            sp = f.create_entity('IfcSpace',
                                 GlobalId=_new_guid(), OwnerHistory=owner,
                                 Name=elem_name, ObjectPlacement=lp,
                                 Representation=pds)
            _add_color(f, sp, SPACE_COLOR, alpha=0.35)
            storey_elements[storey_key].append(sp)
            spaces_kept.append({'id': elem_id, 'name': elem_name,
                                 'w': w, 'd': d, 'h': h, 'origin': origin})
            counts['spaces_emitted'] += 1
            element_count += 1

        # ---- WALL ---------------------------------------------------------
        elif css_type == 'WALL':
            dims = _resolve_wall_dims(elem)
            if dims is None:
                msg = f"WALL {elem_id}: invalid dims — skip"
                print(f"[BLD][SKIP] {msg}")
                skipped.append({'id': elem_id, 'type': 'WALL', 'reason': msg})
                counts['walls_skipped'] += 1
                error_count += 1
                continue

            run_len, thickness, height = dims
            # Profile: width = run length (along local X), height = thickness (along local Y)
            profile_def = _rect_profile(f, run_len, thickness, 'WallProfile')
            lp = _local_placement(f, storey_lp, origin, (0, 0, 1), ref)
            pds, _ = _extrude(f, body_sub, profile_def, height, None)
            wall = f.create_entity('IfcWall',
                                   GlobalId=_new_guid(), OwnerHistory=owner,
                                   Name=elem_name, ObjectPlacement=lp,
                                   Representation=pds)
            _add_color(f, wall, WALL_COLOR)
            storey_elements[storey_key].append(wall)
            walls_kept.append({'id': elem_id, 'name': elem_name,
                                'run_len': run_len, 'thickness': thickness,
                                'height': height, 'origin': origin, 'ref': ref})
            counts['walls_emitted'] += 1
            element_count += 1

        # ---- SLAB ---------------------------------------------------------
        elif css_type == 'SLAB':
            dims = _resolve_slab_dims(elem)
            if dims is None:
                msg = f"SLAB {elem_id}: invalid dims — skip"
                print(f"[BLD][SKIP] {msg}")
                skipped.append({'id': elem_id, 'type': 'SLAB', 'reason': msg})
                counts['slabs_skipped'] += 1
                error_count += 1
                continue

            width, depth, thickness = dims
            profile_def = _rect_profile(f, width, depth, 'SlabProfile')
            lp = _local_placement(f, storey_lp, origin, (0, 0, 1), ref)
            pds, _ = _extrude(f, body_sub, profile_def, thickness, None)
            props = elem.get('properties') or {}
            predef = 'FLOOR' if props.get('slabType', 'FLOOR').upper() == 'FLOOR' else 'ROOF'
            slab = f.create_entity('IfcSlab',
                                   GlobalId=_new_guid(), OwnerHistory=owner,
                                   Name=elem_name, ObjectPlacement=lp,
                                   Representation=pds, PredefinedType=predef)
            _add_color(f, slab, SLAB_COLOR)
            storey_elements[storey_key].append(slab)
            slabs_kept.append({'id': elem_id, 'name': elem_name,
                                'width': width, 'depth': depth,
                                'thickness': thickness, 'origin': origin})
            counts['slabs_emitted'] += 1
            element_count += 1

        # ---- DOOR ---------------------------------------------------------
        elif css_type == 'DOOR':
            props    = elem.get('properties') or {}
            host_id  = props.get('hostWallId') or props.get('hostWall')
            w, h     = _resolve_opening_dims(elem)

            if w < DOOR_WIDTH_MIN or h < DOOR_HEIGHT_MIN:
                msg = (f"DOOR {elem_id}: invalid dims w={w:.3f} h={h:.3f} "
                       f"(min {DOOR_WIDTH_MIN}x{DOOR_HEIGHT_MIN}) — skip")
                print(f"[BLD][SKIP] {msg}")
                skipped.append({'id': elem_id, 'type': 'DOOR', 'reason': msg})
                counts['doors_skipped_invalid'] += 1
                error_count += 1
                continue

            if host_id and host_id not in wall_ids:
                msg = f"DOOR {elem_id}: hostWallId '{host_id}' not found in wall index — skip"
                print(f"[BLD][SKIP] {msg}")
                skipped.append({'id': elem_id, 'type': 'DOOR', 'reason': msg})
                counts['doors_skipped_no_host'] += 1
                error_count += 1
                continue

            thickness = 0.05   # door panel depth along wall normal
            profile_def = _rect_profile(f, w, thickness, 'DoorProfile')
            lp = _local_placement(f, storey_lp, origin, (0, 0, 1), ref)
            pds, _ = _extrude(f, body_sub, profile_def, h, None)
            door = f.create_entity('IfcDoor',
                                   GlobalId=_new_guid(), OwnerHistory=owner,
                                   Name=elem_name, ObjectPlacement=lp,
                                   Representation=pds,
                                   OverallWidth=float(w), OverallHeight=float(h))
            _add_color(f, door, DOOR_COLOR)
            storey_elements[storey_key].append(door)
            doors_kept.append({'id': elem_id, 'name': elem_name,
                                'w': w, 'h': h, 'hostWallId': host_id,
                                'origin': origin})
            counts['doors_emitted'] += 1
            element_count += 1

        # ---- WINDOW -------------------------------------------------------
        elif css_type == 'WINDOW':
            props   = elem.get('properties') or {}
            host_id = props.get('hostWallId') or props.get('hostWall')
            w, h    = _resolve_opening_dims(elem)

            if w < WINDOW_WIDTH_MIN or h < WINDOW_HEIGHT_MIN:
                msg = (f"WINDOW {elem_id}: invalid dims w={w:.3f} h={h:.3f} "
                       f"(min {WINDOW_WIDTH_MIN}x{WINDOW_HEIGHT_MIN}) — skip")
                print(f"[BLD][SKIP] {msg}")
                skipped.append({'id': elem_id, 'type': 'WINDOW', 'reason': msg})
                counts['windows_skipped_invalid'] += 1
                error_count += 1
                continue

            if host_id and host_id not in wall_ids:
                msg = f"WINDOW {elem_id}: hostWallId '{host_id}' not found in wall index — skip"
                print(f"[BLD][SKIP] {msg}")
                skipped.append({'id': elem_id, 'type': 'WINDOW', 'reason': msg})
                counts['windows_skipped_no_host'] += 1
                error_count += 1
                continue

            thickness = 0.05
            profile_def = _rect_profile(f, w, thickness, 'WindowProfile')
            lp = _local_placement(f, storey_lp, origin, (0, 0, 1), ref)
            pds, _ = _extrude(f, body_sub, profile_def, h, None)
            win = f.create_entity('IfcWindow',
                                  GlobalId=_new_guid(), OwnerHistory=owner,
                                  Name=elem_name, ObjectPlacement=lp,
                                  Representation=pds,
                                  OverallWidth=float(w), OverallHeight=float(h))
            _add_color(f, win, WINDOW_COLOR, alpha=0.6)
            storey_elements[storey_key].append(win)
            windows_kept.append({'id': elem_id, 'name': elem_name,
                                  'w': w, 'h': h, 'hostWallId': host_id,
                                  'origin': origin})
            counts['windows_emitted'] += 1
            element_count += 1

        # ---- DUCT ---------------------------------------------------------
        elif css_type == 'DUCT':
            if not profile.enable_ducts:
                print(f"[BLD] DUCT {elem_id}: ducts disabled by profile — skip")
                continue

            duct_dims = _resolve_duct_dims(elem)
            if duct_dims is None:
                msg = f"DUCT {elem_id}: invalid path or profile dims — skip"
                print(f"[BLD][SKIP] {msg}")
                skipped.append({'id': elem_id, 'type': 'DUCT', 'reason': msg})
                counts['ducts_skipped'] += 1
                error_count += 1
                continue

            pts, pw, ph = duct_dims
            lp = _local_placement(f, storey_lp, pts[0], (0, 0, 1), (1, 0, 0))
            pds, _ = _sweep_rect_path(f, body_sub, pts, pw, ph)
            if pds is None:
                msg = f"DUCT {elem_id}: sweep geometry failed — skip"
                print(f"[BLD][SKIP] {msg}")
                skipped.append({'id': elem_id, 'type': 'DUCT', 'reason': msg})
                counts['ducts_skipped'] += 1
                error_count += 1
                continue

            sys_type = ((elem.get('properties') or {}).get('systemType') or '').upper()
            duct_color = {
                'SUPPLY_AIR': DUCT_SUPPLY_COLOR,
                'RETURN_AIR': DUCT_RETURN_COLOR,
                'EXHAUST_AIR': DUCT_EXHAUST_COLOR,
            }.get(sys_type, DUCT_DEFAULT_COLOR)

            duct = f.create_entity('IfcDuctSegment',
                                   GlobalId=_new_guid(), OwnerHistory=owner,
                                   Name=elem_name, ObjectPlacement=lp,
                                   Representation=pds)
            _add_color(f, duct, duct_color)
            storey_elements[storey_key].append(duct)
            ducts_kept.append({'id': elem_id, 'name': elem_name,
                                'pw': pw, 'ph': ph, 'path': pts,
                                'systemType': sys_type})
            counts['ducts_emitted'] += 1
            element_count += 1

        # ---- Unknown type -------------------------------------------------
        else:
            print(f"[BLD] {elem_id} type={css_type}: not handled by residential exporter — skip")

    # ---- Spatial containment ----
    for storey_key, ifc_elems in storey_elements.items():
        if storey_key in storey_map:
            storey_obj, _ = storey_map[storey_key]
            _containment(f, owner, storey_obj, ifc_elems)

    # ---- Scene dump (debug) ----
    render_id = os.environ.get('DEBUG_RENDER_ID')
    user_id   = os.environ.get('DEBUG_USER_ID')
    _dump_building_scene(css, render_id, user_id,
                            walls_kept, slabs_kept, spaces_kept,
                            doors_kept, windows_kept, ducts_kept,
                            skipped, profile)

    # ---- Serialize ----
    ifc_string = f.to_string()

    print(f"[BLD] Done. elements={element_count} errors={error_count}")
    print(f"[BLD] counts: {json.dumps(counts)}")

    report = {
        'mode': 'CLEAN_BUILDING_EXPORT_PHASE_1',
        **counts,
        'element_count': element_count,
        'error_count': error_count,
    }

    return ifc_string, element_count, error_count, 0, report
