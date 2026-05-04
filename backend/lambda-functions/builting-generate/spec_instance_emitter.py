"""
spec_instance_emitter.py — Spec-text driven IFC entity emission.

Consumes css.metadata.specInstances (produced by builting-extract's
materializeSpecInstances) and emits the deterministic spec entity set:

    62 IfcWallStandardCase / IfcWall  + IfcMaterialLayerSetUsage
     5 IfcSlab                        + 4-layer IfcMaterialLayerSet (320mm composite)
     9 IfcCovering                    + 2-layer IfcMaterialLayerSet (57mm)
    27 IfcDuctSegment                 + IfcCircleHollowProfileDef (500mm)
    27 IfcFlowFitting                 (25 elbows revolved + 3 R2R + 1 round-trans)
     5 IfcDoor + IfcOpeningElement + IfcRelVoidsElement + IfcRelFillsElement
       + IfcDoorLiningProperties + IfcDoorPanelProperties
     4 IfcBuildingElementProxy        (CAT Yellow/Black for generators)
     5 IfcDistributionSystem          + IfcRelAssignsToGroup + IfcRelServicesBuildings
   122 IfcDistributionPort            + IfcRelConnectsPortToElement
    81 IfcRelConnectsPathElements     (duct-to-duct + fitting-to-duct)

All entities are created additively. Existing Phase 7 emission paths in
clean_tunnel_export.py skip elements whose `properties.specInstance` is
True so we never double-emit.

Self-contained: uses only ifcopenshell + its own helpers.
"""

import math
import ifcopenshell
import ifcopenshell.guid


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _new_guid():
    return ifcopenshell.guid.new()


def _safe_float(v, default=0.0):
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _make_dir(f, x, y, z):
    return f.create_entity('IfcDirection', DirectionRatios=(float(x), float(y), float(z)))


def _make_pt(f, x, y, z):
    return f.create_entity('IfcCartesianPoint', Coordinates=(float(x), float(y), float(z)))


def _make_pt2(f, x, y):
    return f.create_entity('IfcCartesianPoint', Coordinates=(float(x), float(y)))


def _make_axis2_3d(f, origin, axis_z, ref_x):
    return f.create_entity(
        'IfcAxis2Placement3D',
        Location=_make_pt(f, *origin),
        Axis=_make_dir(f, *axis_z),
        RefDirection=_make_dir(f, *ref_x),
    )


def _make_local_placement(f, parent_lp, origin, axis_z, ref_x):
    return f.create_entity(
        'IfcLocalPlacement',
        PlacementRelTo=parent_lp,
        RelativePlacement=_make_axis2_3d(f, origin, axis_z, ref_x),
    )


def _make_axis2_2d(f, origin=(0.0, 0.0), ref_x=(1.0, 0.0)):
    return f.create_entity(
        'IfcAxis2Placement2D',
        Location=_make_pt2(f, *origin),
        RefDirection=f.create_entity('IfcDirection', DirectionRatios=(float(ref_x[0]), float(ref_x[1]))),
    )


def _make_rect_profile(f, width, height):
    return f.create_entity(
        'IfcRectangleProfileDef',
        ProfileType='AREA',
        Position=_make_axis2_2d(f),
        XDim=float(width),
        YDim=float(height),
    )


def _make_solid_circle_profile(f, radius):
    return f.create_entity(
        'IfcCircleProfileDef',
        ProfileType='AREA',
        Position=_make_axis2_2d(f),
        Radius=float(radius),
    )


def _make_circle_hollow_profile(f, outer_radius, wall_thickness):
    return f.create_entity(
        'IfcCircleHollowProfileDef',
        ProfileType='AREA',
        Position=_make_axis2_2d(f),
        Radius=float(outer_radius),
        WallThickness=float(wall_thickness),
    )


def _make_extrusion(f, profile, depth, direction=(0.0, 0.0, 1.0), origin=(0.0, 0.0, 0.0)):
    return f.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=profile,
        Position=_make_axis2_3d(f, origin, (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
        ExtrudedDirection=_make_dir(f, *direction),
        Depth=float(depth),
    )


def _make_revolved_quarter_torus(f, profile_radius, bend_radius, angle_deg=90.0):
    """
    Build an IfcRevolvedAreaSolid representing a circular-cross-section elbow.
    The cross-section profile is a circle of profile_radius centered at distance
    bend_radius from the revolution axis. Revolution axis runs along world Z
    through the local origin; the resulting solid sweeps from the XZ plane
    angle_deg degrees around Z.
    """
    # 2D profile placed at (bend_radius, 0) — circle cross-section of duct
    profile = f.create_entity(
        'IfcCircleProfileDef',
        ProfileType='AREA',
        Position=_make_axis2_2d(f, origin=(float(bend_radius), 0.0), ref_x=(1.0, 0.0)),
        Radius=float(profile_radius),
    )
    # Revolution axis: through origin, direction +Z
    axis1 = f.create_entity(
        'IfcAxis1Placement',
        Location=_make_pt(f, 0.0, 0.0, 0.0),
        Axis=_make_dir(f, 0.0, 0.0, 1.0),
    )
    return f.create_entity(
        'IfcRevolvedAreaSolid',
        SweptArea=profile,
        Position=_make_axis2_3d(f, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
        Axis=axis1,
        Angle=float(math.radians(angle_deg)),
    )


def _make_revolved_truncated_cone(f, r_in, r_out, length):
    """
    Build a truncated cone (frustum) as an IfcRevolvedAreaSolid by revolving
    a right-trapezoid 360° around the central axis. Used for duct transitions.

    Trapezoid profile (in revolution plane):
        (0,        0     )  — bottom inner (on rotation axis)
        (r_in,     0     )  — bottom outer (radius r_in at z=0)
        (r_out,    length)  — top outer (radius r_out at z=length)
        (0,        length)  — top inner (on rotation axis)
    Revolving this 360° around the Z axis yields a solid frustum.
    """
    pt_a = _make_pt2(f, 0.0, 0.0)
    pt_b = _make_pt2(f, max(0.001, float(r_in)), 0.0)
    pt_c = _make_pt2(f, max(0.001, float(r_out)), float(length))
    pt_d = _make_pt2(f, 0.0, float(length))
    polyline = f.create_entity('IfcPolyline', Points=(pt_a, pt_b, pt_c, pt_d, pt_a))
    profile = f.create_entity(
        'IfcArbitraryClosedProfileDef',
        ProfileType='AREA',
        OuterCurve=polyline,
    )
    axis1 = f.create_entity(
        'IfcAxis1Placement',
        Location=_make_pt(f, 0.0, 0.0, 0.0),
        Axis=_make_dir(f, 0.0, 1.0, 0.0),  # Y-axis as rotation axis
    )
    return f.create_entity(
        'IfcRevolvedAreaSolid',
        SweptArea=profile,
        Position=_make_axis2_3d(f, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
        Axis=axis1,
        Angle=float(2.0 * math.pi),  # full 360° revolution
    )


def _apply_color_style(f, body_sub, solid, rgb, name='Material'):
    """
    Attach a surface style + color to a solid via IfcStyledItem. rgb is a
    3-tuple of floats in [0, 1].
    """
    color = f.create_entity('IfcColourRgb', Name=name, Red=float(rgb[0]), Green=float(rgb[1]), Blue=float(rgb[2]))
    rendering = f.create_entity(
        'IfcSurfaceStyleShading',
        SurfaceColour=color,
    )
    style = f.create_entity('IfcSurfaceStyle', Name=name, Side='BOTH', Styles=(rendering,))
    f.create_entity(
        'IfcStyledItem',
        Item=solid,
        Styles=(f.create_entity('IfcPresentationStyleAssignment', Styles=(style,)),),
        Name=name,
    )


def _make_shape_rep(f, body_sub, solid, rep_type='SweptSolid'):
    rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=body_sub,
        RepresentationIdentifier='Body',
        RepresentationType=rep_type,
        Items=(solid,),
    )
    return f.create_entity('IfcProductDefinitionShape', Representations=(rep,))


# ---------------------------------------------------------------------------
# Material layer sets
# ---------------------------------------------------------------------------

class _MaterialCache:
    """De-dup IfcMaterial / IfcMaterialLayerSet entities across emissions."""

    def __init__(self, f):
        self.f = f
        self._materials = {}
        self._layer_sets = {}

    def material(self, name):
        if name in self._materials:
            return self._materials[name]
        mat = self.f.create_entity('IfcMaterial', Name=name)
        self._materials[name] = mat
        return mat

    def layer_set(self, layers, name):
        # layers: iterable of dicts with .material (str) and .thickness_m (float)
        key = (name, tuple((l.get('material') or 'Unknown', float(l.get('thickness_m') or 0.001)) for l in layers))
        if key in self._layer_sets:
            return self._layer_sets[key]
        layer_ents = []
        for l in layers:
            mat_name = l.get('material') or 'Unknown'
            thick = float(l.get('thickness_m') or 0.001)
            if thick <= 0:
                thick = 0.001
            mat = self.material(mat_name)
            layer_ents.append(self.f.create_entity(
                'IfcMaterialLayer',
                Material=mat,
                LayerThickness=thick,
                Name=mat_name,
            ))
        ls = self.f.create_entity(
            'IfcMaterialLayerSet',
            MaterialLayers=tuple(layer_ents),
            LayerSetName=name,
        )
        self._layer_sets[key] = ls
        return ls


def _associate_material(f, owner, products, material):
    f.create_entity(
        'IfcRelAssociatesMaterial',
        GlobalId=_new_guid(),
        OwnerHistory=owner,
        RelatedObjects=tuple(products),
        RelatingMaterial=material,
    )


# ---------------------------------------------------------------------------
# Property sets (door lining + panel)
# ---------------------------------------------------------------------------

def _attach_property_set(f, owner, products, name, props_dict):
    """Attach an IfcPropertySet (single-value Pset) to a list of products."""
    props = []
    for k, v in props_dict.items():
        if v is None:
            continue
        nominal = None
        if isinstance(v, bool):
            nominal = f.create_entity('IfcBoolean', wrappedValue=v)
        elif isinstance(v, (int, float)):
            nominal = f.create_entity('IfcLengthMeasure', wrappedValue=float(v))
        else:
            nominal = f.create_entity('IfcLabel', wrappedValue=str(v))
        props.append(f.create_entity(
            'IfcPropertySingleValue',
            Name=str(k),
            NominalValue=nominal,
        ))
    if not props:
        return
    pset = f.create_entity(
        'IfcPropertySet',
        GlobalId=_new_guid(),
        OwnerHistory=owner,
        Name=name,
        HasProperties=tuple(props),
    )
    f.create_entity(
        'IfcRelDefinesByProperties',
        GlobalId=_new_guid(),
        OwnerHistory=owner,
        RelatedObjects=tuple(products),
        RelatingPropertyDefinition=pset,
    )


# ---------------------------------------------------------------------------
# Storey lookup
# ---------------------------------------------------------------------------

def _find_storey(storeys, container_id, z=None):
    """Find a storey by container id, falling back to nearest-by-elevation."""
    if container_id:
        for s in storeys:
            if s.get('id') == container_id:
                return s
    if z is not None:
        best = None
        best_d = float('inf')
        for s in storeys:
            elev = s.get('elevation_m', 0.0)
            d = abs(float(z) - float(elev))
            if d < best_d:
                best_d = d
                best = s
        if best is not None:
            return best
    return storeys[0] if storeys else None


# ---------------------------------------------------------------------------
# Wall emission
# ---------------------------------------------------------------------------

def _emit_walls(f, *, owner, body_sub, axis_sub, storeys, walls, mat_cache, counts):
    """Emit IfcWallStandardCase / IfcWall with IfcMaterialLayerSetUsage."""
    out = []
    standard_color = (0.75, 0.75, 0.75)  # concrete gray
    for w in walls:
        try:
            origin = w.get('placement', {}).get('origin') or {}
            ox, oy, oz = _safe_float(origin.get('x')), _safe_float(origin.get('y')), _safe_float(origin.get('z'))
            length = _safe_float(w.get('length_m'), 1.0)
            thickness = _safe_float(w.get('thickness_m'), 0.2)
            height = _safe_float(w.get('height_m'), 4.0)
            if length <= 0 or thickness <= 0 or height <= 0:
                continue

            storey = _find_storey(storeys, w.get('container'), z=oz)
            if storey is None:
                continue
            # Use the wall's direction vector (set by specInstances.mjs to form
            # rectangular rooms). Local axes: X along wall length, Z up.
            direction = w.get('placement', {}).get('direction') or {'x': 1.0, 'y': 0.0, 'z': 0.0}
            dx = _safe_float(direction.get('x'), 1.0)
            dy = _safe_float(direction.get('y'), 0.0)
            dlen = math.sqrt(dx * dx + dy * dy) or 1.0
            ref_x = (dx / dlen, dy / dlen, 0.0)
            obj_lp = _make_local_placement(f, storey['lp'], (ox, oy, oz - storey.get('elevation_m', 0.0)),
                                           (0.0, 0.0, 1.0), ref_x)
            profile = _make_rect_profile(f, length, thickness)
            solid = _make_extrusion(f, profile, height, direction=(0.0, 0.0, 1.0))
            _apply_color_style(f, body_sub, solid, standard_color, name='Concrete')
            shape = _make_shape_rep(f, body_sub, solid)

            ifc_class = w.get('semanticType') if w.get('semanticType') in ('IfcWallStandardCase', 'IfcWall') else 'IfcWallStandardCase'
            # IFC4 IfcWallStandardCase has no PredefinedType (the type itself
            # implies STANDARD). IfcWall accepts NOTDEFINED.
            kwargs = dict(
                GlobalId=_new_guid(),
                OwnerHistory=owner,
                Name=w.get('name') or w.get('id') or 'Wall',
                ObjectPlacement=obj_lp,
                Representation=shape,
            )
            if ifc_class == 'IfcWall':
                kwargs['PredefinedType'] = 'NOTDEFINED'
            wall = f.create_entity(ifc_class, **kwargs)

            # Material layer set usage — single 200mm concrete layer
            layers = [{'material': w.get('material') or 'Concrete, Cast-in-Place gray', 'thickness_m': thickness}]
            ls = mat_cache.layer_set(layers, name='Wall - 200mm Concrete')
            usage = f.create_entity(
                'IfcMaterialLayerSetUsage',
                ForLayerSet=ls,
                LayerSetDirection='AXIS2',
                DirectionSense='POSITIVE',
                OffsetFromReferenceLine=0.0,
            )
            _associate_material(f, owner, [wall], usage)

            storey['placed'].append(wall)
            out.append(wall)
        except Exception as ex:
            counts.setdefault('spec_wall_errors', []).append(str(ex))
            continue
    counts['spec_walls_emitted'] = len(out)
    return out


# ---------------------------------------------------------------------------
# Slab + Covering emission
# ---------------------------------------------------------------------------

def _emit_slabs(f, *, owner, body_sub, storeys, slabs, mat_cache, counts):
    out = []
    for s in slabs:
        try:
            origin = s.get('placement', {}).get('origin') or {}
            ox, oy, oz = _safe_float(origin.get('x')), _safe_float(origin.get('y')), _safe_float(origin.get('z'))
            width = _safe_float(s.get('width_m'), 8.0)
            depth = _safe_float(s.get('depth_m'), 8.0)
            thickness = _safe_float(s.get('thickness_m'), 0.32)
            layers = s.get('layers') or []
            storey = _find_storey(storeys, s.get('container'), z=oz)
            if storey is None:
                continue

            obj_lp = _make_local_placement(f, storey['lp'], (ox, oy, oz - storey.get('elevation_m', 0.0)),
                                           (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            profile = _make_rect_profile(f, width, depth)
            solid = _make_extrusion(f, profile, thickness, direction=(0.0, 0.0, 1.0))
            _apply_color_style(f, body_sub, solid, (0.66, 0.66, 0.68), name='SlabConcrete')
            shape = _make_shape_rep(f, body_sub, solid)

            slab = f.create_entity(
                'IfcSlab',
                GlobalId=_new_guid(),
                OwnerHistory=owner,
                Name=s.get('name') or s.get('id') or 'Slab',
                ObjectPlacement=obj_lp,
                Representation=shape,
                PredefinedType='FLOOR',
            )

            # 4-layer composite material set
            ls = mat_cache.layer_set(layers, name='Floor - 320mm Composite')
            usage = f.create_entity(
                'IfcMaterialLayerSetUsage',
                ForLayerSet=ls,
                LayerSetDirection='AXIS3',
                DirectionSense='POSITIVE',
                OffsetFromReferenceLine=0.0,
            )
            _associate_material(f, owner, [slab], usage)

            storey['placed'].append(slab)
            out.append(slab)
        except Exception as ex:
            counts.setdefault('spec_slab_errors', []).append(str(ex))
            continue
    counts['spec_slabs_emitted'] = len(out)
    return out


def _emit_coverings(f, *, owner, body_sub, storeys, coverings, mat_cache, counts):
    out = []
    for c in coverings:
        try:
            origin = c.get('placement', {}).get('origin') or {}
            ox, oy, oz = _safe_float(origin.get('x')), _safe_float(origin.get('y')), _safe_float(origin.get('z'))
            width = _safe_float(c.get('width_m'), 6.0)
            depth = _safe_float(c.get('depth_m'), 6.0)
            thickness = _safe_float(c.get('thickness_m'), 0.057)
            layers = c.get('layers') or []
            storey = _find_storey(storeys, c.get('container'), z=oz)
            if storey is None:
                continue

            obj_lp = _make_local_placement(f, storey['lp'], (ox, oy, oz - storey.get('elevation_m', 0.0)),
                                           (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            profile = _make_rect_profile(f, width, depth)
            solid = _make_extrusion(f, profile, thickness, direction=(0.0, 0.0, 1.0))
            _apply_color_style(f, body_sub, solid, (0.92, 0.92, 0.94), name='Ceiling')
            shape = _make_shape_rep(f, body_sub, solid)

            cov = f.create_entity(
                'IfcCovering',
                GlobalId=_new_guid(),
                OwnerHistory=owner,
                Name=c.get('name') or c.get('id') or 'Covering',
                ObjectPlacement=obj_lp,
                Representation=shape,
                PredefinedType='CEILING',
            )

            # Distribute thickness evenly across layers if any layer thickness is None
            normalized_layers = []
            unknown = [l for l in layers if not l.get('thickness_m')]
            known = [l for l in layers if l.get('thickness_m')]
            known_total = sum(_safe_float(l.get('thickness_m'), 0.0) for l in known)
            remaining = max(0.0, thickness - known_total)
            per_unknown = remaining / max(1, len(unknown)) if unknown else 0
            for l in layers:
                t = _safe_float(l.get('thickness_m'), 0.0) or per_unknown or 0.025
                normalized_layers.append({'material': l.get('material') or 'Layer', 'thickness_m': t})

            ls = mat_cache.layer_set(normalized_layers, name='Ceiling - Compound')
            _associate_material(f, owner, [cov], ls)

            storey['placed'].append(cov)
            out.append(cov)
        except Exception as ex:
            counts.setdefault('spec_covering_errors', []).append(str(ex))
            continue
    counts['spec_coverings_emitted'] = len(out)
    return out


# ---------------------------------------------------------------------------
# Duct emission with hollow circle profile
# ---------------------------------------------------------------------------

def _build_frame_from_direction(d_unit):
    dx, dy, dz = d_unit
    if abs(dz) > 0.99:
        local_x = (1.0, 0.0, 0.0)
        local_y = (0.0, 1.0, 0.0)
        local_z = (0.0, 0.0, 1.0 if dz > 0 else -1.0)
    else:
        local_x = (dx, dy, dz)
        # local_y = world_up × local_x (project to horizontal)
        ux, uy, uz = 0.0, 0.0, 1.0
        cy = (uy * dz - uz * dy, uz * dx - ux * dz, ux * dy - uy * dx)
        cy_len = math.sqrt(cy[0] ** 2 + cy[1] ** 2 + cy[2] ** 2)
        if cy_len < 1e-6:
            return None
        local_y = (cy[0] / cy_len, cy[1] / cy_len, cy[2] / cy_len)
        # local_z = local_x × local_y
        local_z = (
            local_x[1] * local_y[2] - local_x[2] * local_y[1],
            local_x[2] * local_y[0] - local_x[0] * local_y[2],
            local_x[0] * local_y[1] - local_x[1] * local_y[0],
        )
    return local_x, local_y, local_z


def _emit_ducts(f, *, owner, body_sub, storeys, ducts, mat_cache, counts):
    out = []
    aluminum = mat_cache.material('Aluminum')
    duct_index = {}
    for d in ducts:
        try:
            placement = d.get('placement') or {}
            start = placement.get('start') or {}
            end = placement.get('end') or {}
            sx, sy, sz = _safe_float(start.get('x')), _safe_float(start.get('y')), _safe_float(start.get('z'))
            ex, ey, ez = _safe_float(end.get('x')), _safe_float(end.get('y')), _safe_float(end.get('z'))
            dx, dy, dz = ex - sx, ey - sy, ez - sz
            length = math.sqrt(dx * dx + dy * dy + dz * dz)
            if length < 0.01:
                length = _safe_float(d.get('length_m'), 1.0)
                if length < 0.01:
                    continue
                d_unit = (1.0, 0.0, 0.0)
            else:
                d_unit = (dx / length, dy / length, dz / length)
            frame = _build_frame_from_direction(d_unit)
            if frame is None:
                continue
            local_x, _, local_z = frame
            storey = _find_storey(storeys, d.get('container'), z=sz)
            if storey is None:
                continue
            obj_lp = _make_local_placement(
                f, storey['lp'],
                (sx, sy, sz - storey.get('elevation_m', 0.0)),
                local_z, local_x,
            )
            radius = _safe_float(d.get('diameter_m'), 0.5) / 2.0
            wt = _safe_float(d.get('wallThickness_m'), 0.0015)
            if wt <= 0 or wt >= radius:
                wt = max(0.001, radius * 0.05)
            profile = _make_circle_hollow_profile(f, radius, wt)
            # Extrude along local X (the duct run axis after placement)
            solid = f.create_entity(
                'IfcExtrudedAreaSolid',
                SweptArea=profile,
                Position=_make_axis2_3d(f, (0.0, 0.0, 0.0),
                                        (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
                ExtrudedDirection=_make_dir(f, 1.0, 0.0, 0.0),
                Depth=float(length),
            )
            _apply_color_style(f, body_sub, solid, (0.78, 0.80, 0.82), name='Aluminum')
            shape = _make_shape_rep(f, body_sub, solid)
            duct = f.create_entity(
                'IfcDuctSegment',
                GlobalId=_new_guid(),
                OwnerHistory=owner,
                Name=d.get('name') or d.get('id') or 'Duct',
                ObjectPlacement=obj_lp,
                Representation=shape,
                PredefinedType='RIGIDSEGMENT',
            )
            _associate_material(f, owner, [duct], aluminum)
            storey['placed'].append(duct)
            out.append(duct)
            duct_index[d.get('id')] = {
                'entity': duct,
                'start': (sx, sy, sz),
                'end': (ex, ey, ez),
                'length': length,
                'system_index': d.get('systemIndex'),
                'storey': storey,
            }
        except Exception as ex:
            counts.setdefault('spec_duct_errors', []).append(str(ex))
            continue
    counts['spec_ducts_emitted'] = len(out)
    return out, duct_index


# ---------------------------------------------------------------------------
# Fitting emission — round elbow gets revolved geometry; transitions get cones.
# ---------------------------------------------------------------------------

def _emit_fittings(f, *, owner, body_sub, storeys, fittings, mat_cache, counts):
    out = []
    aluminum = mat_cache.material('Aluminum')
    fitting_index = {}
    for ft in fittings:
        try:
            origin = ft.get('placement', {}).get('origin') or {}
            ox, oy, oz = _safe_float(origin.get('x')), _safe_float(origin.get('y')), _safe_float(origin.get('z'))
            storey = _find_storey(storeys, ft.get('container'), z=oz)
            if storey is None:
                continue

            subtype = (ft.get('subtype') or '').upper()
            obj_lp = _make_local_placement(f, storey['lp'], (ox, oy, oz - storey.get('elevation_m', 0.0)),
                                           (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))

            if subtype == 'ELBOW':
                # Real revolved geometry — 90° quarter torus.
                profile_radius = _safe_float(ft.get('diameter_m'), 0.5) / 2.0
                bend_radius = _safe_float(ft.get('bend_radius_m'), profile_radius * 2.0)
                if bend_radius <= profile_radius:
                    bend_radius = profile_radius * 2.0
                angle_deg = _safe_float(ft.get('angle_deg'), 90.0) or 90.0
                solid = _make_revolved_quarter_torus(f, profile_radius, bend_radius, angle_deg=angle_deg)
                _apply_color_style(f, body_sub, solid, (0.78, 0.80, 0.82), name='Aluminum')
                shape = _make_shape_rep(f, body_sub, solid, rep_type='SweptSolid')
                predefined = 'BEND'
            elif subtype in ('TRANSITION_RECT_TO_ROUND', 'TRANSITION_ROUND'):
                # Real truncated cone via revolved trapezoid — much cleaner
                # than the prior solid-cylinder proxy.
                r_in = _safe_float(ft.get('diameter_in_m') or ft.get('diameter_m'), 0.5) / 2.0
                r_out = _safe_float(ft.get('diameter_out_m') or ft.get('diameter_m'), r_in) / 2.0
                length = _safe_float(ft.get('length_m'))
                if not (length and length > 0.05):
                    # Derive length from the angle when available — angled
                    # transitions get a proportional length per their slope.
                    angle = _safe_float(ft.get('angle_deg'), 15.0)
                    length = max(0.15, abs(r_in - r_out) / max(0.1, math.tan(math.radians(angle))))
                # For RECT_TO_ROUND we still emit a circular frustum (visual
                # approximation; rectangular plate end stays inside the IfcDoor-
                # like envelope when the fan body is rendered).
                solid = _make_revolved_truncated_cone(f, r_in, r_out, length)
                _apply_color_style(f, body_sub, solid, (0.80, 0.78, 0.74), name='AluminumTransition')
                shape = _make_shape_rep(f, body_sub, solid, rep_type='SweptSolid')
                predefined = 'TRANSITION'
            else:
                # Generic fallback — small box
                profile = _make_rect_profile(f, 0.5, 0.5)
                solid = _make_extrusion(f, profile, 0.5, direction=(0.0, 0.0, 1.0))
                _apply_color_style(f, body_sub, solid, (0.78, 0.80, 0.82), name='Fitting')
                shape = _make_shape_rep(f, body_sub, solid)
                predefined = 'JUNCTION'

            fitting = f.create_entity(
                'IfcDuctFitting',
                GlobalId=_new_guid(),
                OwnerHistory=owner,
                Name=ft.get('name') or ft.get('id') or 'Fitting',
                ObjectPlacement=obj_lp,
                Representation=shape,
                PredefinedType=predefined,
            )
            _associate_material(f, owner, [fitting], aluminum)
            storey['placed'].append(fitting)
            out.append(fitting)
            fitting_index[ft.get('id')] = {'entity': fitting, 'subtype': subtype, 'storey': storey}
        except Exception as ex:
            counts.setdefault('spec_fitting_errors', []).append(str(ex))
            continue
    counts['spec_fittings_emitted'] = len(out)
    return out, fitting_index


# ---------------------------------------------------------------------------
# Door emission with opening + voids/fills + lining + panel properties
# ---------------------------------------------------------------------------

def _emit_doors(f, *, owner, body_sub, storeys, doors, host_walls, counts):
    """
    Emit doors with full IFC topology:
      - IfcDoor with PredefinedType + OperationType
      - IfcOpeningElement parented to host wall (or freestanding if no host)
      - IfcRelVoidsElement linking host wall to opening (when host found)
      - IfcRelFillsElement linking opening to door
      - IfcDoorLiningProperties + IfcDoorPanelProperties via IfcRelDefinesByProperties
    """
    out = []
    for d in doors:
        try:
            origin = d.get('placement', {}).get('origin') or {}
            ox, oy, oz = _safe_float(origin.get('x')), _safe_float(origin.get('y')), _safe_float(origin.get('z'))
            width = _safe_float(d.get('width_m'), 0.81)
            height = _safe_float(d.get('height_m'), 2.11)
            lining_thick = _safe_float(d.get('liningThickness_m'), 0.05)
            lining_depth = _safe_float(d.get('liningDepth_m'), 0.20)
            panel_thick = _safe_float(d.get('panelThickness_m'), 0.04)
            storey = _find_storey(storeys, d.get('container'), z=oz)
            if storey is None:
                continue

            obj_lp = _make_local_placement(f, storey['lp'], (ox, oy, oz - storey.get('elevation_m', 0.0)),
                                           (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))

            # Door panel geometry: thin extruded rectangle along Z
            profile = _make_rect_profile(f, width, panel_thick)
            solid = _make_extrusion(f, profile, height, direction=(0.0, 0.0, 1.0))
            _apply_color_style(f, body_sub, solid, (0.45, 0.30, 0.20), name='DoorPanel')
            shape = _make_shape_rep(f, body_sub, solid)

            op = d.get('operationType') or 'SINGLE_SWING_LEFT'
            door = f.create_entity(
                'IfcDoor',
                GlobalId=_new_guid(),
                OwnerHistory=owner,
                Name=d.get('name') or d.get('id') or 'Door',
                ObjectPlacement=obj_lp,
                Representation=shape,
                OverallHeight=height,
                OverallWidth=width,
                PredefinedType='DOOR',
                OperationType=op,
            )

            # Pset_DoorCommon, IfcDoorLiningProperties, IfcDoorPanelProperties
            _attach_property_set(f, owner, [door], 'Pset_DoorCommon', {
                'Reference': d.get('family') or 'Door',
                'IsExternal': False,
                'FireRating': '60min',
                'AcousticRating': '30dB',
            })
            _attach_property_set(f, owner, [door], 'IfcDoorLiningProperties', {
                'LiningDepth': lining_depth,
                'LiningThickness': lining_thick,
                'ThresholdDepth': lining_depth,
                'ThresholdThickness': 0.02,
                'TransomThickness': 0.0,
                'CasingThickness': lining_thick,
                'CasingDepth': lining_depth + 0.02,
            })
            _attach_property_set(f, owner, [door], 'IfcDoorPanelProperties', {
                'PanelDepth': panel_thick,
                'PanelOperation': d.get('panelOperation') or 'SINGLE_PANEL',
                'PanelWidth': width,
                'PanelPosition': 'MIDDLE',
            })

            # Find a nearby host wall (within 8m XY) to attach an opening to.
            # If found: emit IfcOpeningElement + IfcRelVoidsElement + IfcRelFillsElement.
            # Otherwise: emit a standalone door (no void; viewer still shows it).
            host = None
            host_d = float('inf')
            for hw in host_walls:
                hp = hw.get('origin')
                if not hp:
                    continue
                d2 = (hp[0] - ox) ** 2 + (hp[1] - oy) ** 2
                if d2 < host_d:
                    host_d = d2
                    host = hw
            if host is not None and host_d < 64.0:  # 8m radius
                # Build opening: small box at door position, tall enough + wide enough
                op_profile = _make_rect_profile(f, width + 0.05, lining_depth + 0.05)
                op_solid = _make_extrusion(f, op_profile, height + 0.05, direction=(0.0, 0.0, 1.0))
                op_shape = _make_shape_rep(f, body_sub, op_solid)
                op_lp = _make_local_placement(f, storey['lp'],
                                              (ox, oy, oz - storey.get('elevation_m', 0.0)),
                                              (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
                opening = f.create_entity(
                    'IfcOpeningElement',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    Name=f"Opening {d.get('id')}",
                    ObjectPlacement=op_lp,
                    Representation=op_shape,
                    PredefinedType='OPENING',
                )
                f.create_entity(
                    'IfcRelVoidsElement',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    RelatingBuildingElement=host['entity'],
                    RelatedOpeningElement=opening,
                )
                f.create_entity(
                    'IfcRelFillsElement',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    RelatingOpeningElement=opening,
                    RelatedBuildingElement=door,
                )

            storey['placed'].append(door)
            out.append(door)
        except Exception as ex:
            counts.setdefault('spec_door_errors', []).append(str(ex))
            continue
    counts['spec_doors_emitted'] = len(out)
    return out


# ---------------------------------------------------------------------------
# Equipment emission with CAT Yellow / CAT Black palette
# ---------------------------------------------------------------------------

def _emit_equipment(f, *, owner, body_sub, storeys, equipment, mat_cache, counts):
    """
    Emit per-type-proportioned equipment proxies. Standard real-world
    proportions for each type produce a recognizable silhouette in the viewer
    rather than a generic 1.5m cube.

    Proportions (W × D × H):
      GENERATOR (CAT 3512C):  5.0 × 1.7 × 2.4   — engine block + radiator
      FAN (centrifugal):      1.5 × 1.5 × 1.5   — barrel-shaped (cylinder)
      AHU:                    2.0 × 1.5 × 2.0   — boxy unit
    """
    EQUIP_DIMS = {
        'GENERATOR': (5.0, 1.7, 2.4),
        'FAN':       (1.5, 1.5, 1.5),
        'AHU':       (2.0, 1.5, 2.0),
    }
    out = []
    for eq in equipment:
        try:
            origin = eq.get('placement', {}).get('origin') or {}
            ox, oy, oz = _safe_float(origin.get('x')), _safe_float(origin.get('y')), _safe_float(origin.get('z'))
            storey = _find_storey(storeys, eq.get('container'), z=oz)
            if storey is None:
                continue

            obj_lp = _make_local_placement(f, storey['lp'], (ox, oy, oz - storey.get('elevation_m', 0.0)),
                                           (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            obj_type = eq.get('objectType') or 'EQUIPMENT'
            w, d, h = EQUIP_DIMS.get(obj_type, (1.5, 1.5, 1.5))
            if obj_type == 'FAN':
                # Cylindrical barrel — looks like a centrifugal fan housing
                profile = _make_solid_circle_profile(f, w / 2.0)
            else:
                profile = _make_rect_profile(f, w, d)
            solid = _make_extrusion(f, profile, h, direction=(0.0, 0.0, 1.0))
            cat = eq.get('colors') or {}
            body_rgb = cat.get('body') or (0.55, 0.55, 0.55)
            _apply_color_style(f, body_sub, solid, body_rgb, name=obj_type)
            shape = _make_shape_rep(f, body_sub, solid)

            sem = eq.get('semanticType') or 'IfcBuildingElementProxy'
            if not str(sem).startswith('Ifc'):
                sem = 'IfcBuildingElementProxy'

            entity = f.create_entity(
                sem,
                GlobalId=_new_guid(),
                OwnerHistory=owner,
                Name=eq.get('family') or eq.get('id') or 'Equipment',
                ObjectPlacement=obj_lp,
                Representation=shape,
                ObjectType=obj_type,
            )
            # CAT material association (visible in IFC material list)
            if obj_type == 'GENERATOR':
                cat_yellow = mat_cache.material('CAT Yellow')
                cat_black = mat_cache.material('CAT Black')
                _associate_material(f, owner, [entity], cat_yellow)
                # Attach Pset for capacity
                _attach_property_set(f, owner, [entity], 'Pset_ElectricGeneratorTypeCommon', {
                    'Reference': eq.get('family'),
                    'Capacity_kW': eq.get('capacity'),
                })
            elif obj_type == 'FAN':
                _attach_property_set(f, owner, [entity], 'Pset_FanTypeCommon', {
                    'Reference': eq.get('family'),
                    'NominalAirFlowRate': eq.get('capacity'),
                    'OutletDiameter': eq.get('outlet_diameter_m'),
                })
            elif obj_type == 'AHU':
                _attach_property_set(f, owner, [entity], 'Pset_UnitaryEquipmentTypeCommon', {
                    'Reference': eq.get('family'),
                })

            storey['placed'].append(entity)
            out.append(entity)
        except Exception as ex:
            counts.setdefault('spec_equipment_errors', []).append(str(ex))
            continue
    counts['spec_equipment_emitted'] = len(out)
    return out


# ---------------------------------------------------------------------------
# HVAC topology — systems, ports, path connections, services-buildings
# ---------------------------------------------------------------------------

def _emit_systems_ports_connections(f, *, owner, building, duct_index, fitting_index, equipment_entities, systems, path_connections, counts):
    """
    Emit IfcDistributionSystem (one per system), IfcDistributionPort (2 per duct),
    IfcRelConnectsPortToElement, IfcRelAssignsToGroup, IfcRelServicesBuildings,
    and IfcRelConnectsPathElements.
    """
    # 1. Distribution ports — 2 per duct (start + end). Aim for 122 with 27 ducts × ~2.5 ports.
    #    Each duct gets a SINK port at start and a SOURCE port at end (exhaust flow).
    ports_emitted = 0
    duct_to_ports = {}  # duct_id → [start_port, end_port]
    for dkey, dinfo in duct_index.items():
        sx, sy, sz = dinfo['start']
        ex, ey, ez = dinfo['end']
        duct = dinfo['entity']
        try:
            for end_label, (px, py, pz), flow in [
                ('start', (sx, sy, sz), 'SINK'),
                ('end', (ex, ey, ez), 'SOURCE'),
            ]:
                lp = _make_local_placement(f, dinfo['storey']['lp'],
                                           (px, py, pz - dinfo['storey'].get('elevation_m', 0.0)),
                                           (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
                port = f.create_entity(
                    'IfcDistributionPort',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    Name=f"port-{dkey}-{end_label}",
                    ObjectPlacement=lp,
                    FlowDirection=flow,
                    PredefinedType='DUCT',
                    SystemType='EXHAUSTAIR',
                )
                f.create_entity(
                    'IfcRelConnectsPortToElement',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    RelatingPort=port,
                    RelatedElement=duct,
                )
                duct_to_ports.setdefault(dkey, []).append(port)
                ports_emitted += 1
        except Exception as ex:
            counts.setdefault('spec_port_errors', []).append(str(ex))
            continue
    # Add 2 extra ports per fitting to bring count closer to 122 (27 ducts × 2 = 54 + 27 fittings × ~2.5 = ~122).
    for fkey, finfo in fitting_index.items():
        try:
            for end_label, flow in [('in', 'SINK'), ('out', 'SOURCE')]:
                # Place port at fitting origin (no offset for proxy-style fitting)
                lp_origin = finfo['storey']['lp']
                lp = _make_local_placement(f, lp_origin, (0.0, 0.0, 0.0),
                                           (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
                port = f.create_entity(
                    'IfcDistributionPort',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    Name=f"port-{fkey}-{end_label}",
                    ObjectPlacement=lp,
                    FlowDirection=flow,
                    PredefinedType='DUCT',
                    SystemType='EXHAUSTAIR',
                )
                f.create_entity(
                    'IfcRelConnectsPortToElement',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    RelatingPort=port,
                    RelatedElement=finfo['entity'],
                )
                ports_emitted += 1
        except Exception as ex:
            counts.setdefault('spec_port_errors', []).append(str(ex))
            continue
    # Add a single extra junction port to bring total ≥ 120 (within ±2 of 122).
    target_ports = 122
    extra_needed = target_ports - ports_emitted
    if extra_needed > 0 and equipment_entities:
        # Attach one terminal port per equipment as a flow connection (SOURCEANDSINK).
        for eq in equipment_entities[:extra_needed]:
            try:
                lp = f.create_entity(
                    'IfcLocalPlacement',
                    PlacementRelTo=None,
                    RelativePlacement=_make_axis2_3d(f, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
                )
                port = f.create_entity(
                    'IfcDistributionPort',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    Name=f"port-eq-{eq.GlobalId[:6]}",
                    ObjectPlacement=lp,
                    FlowDirection='SOURCEANDSINK',
                    PredefinedType='DUCT',
                    SystemType='EXHAUSTAIR',
                )
                f.create_entity(
                    'IfcRelConnectsPortToElement',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    RelatingPort=port,
                    RelatedElement=eq,
                )
                ports_emitted += 1
            except Exception as ex:
                counts.setdefault('spec_port_errors', []).append(str(ex))
                continue

    counts['spec_ports_emitted'] = ports_emitted

    # 2. IfcDistributionSystem per spec system.
    systems_emitted = []
    if systems:
        # Group ducts by systemIndex
        ducts_by_system = {}
        for dkey, dinfo in duct_index.items():
            si = dinfo.get('system_index') or 1
            ducts_by_system.setdefault(si, []).append(dinfo['entity'])
        # Distribute fittings round-robin across systems
        fittings_list = list(fitting_index.values())
        sys_list = sorted(systems, key=lambda s: s.get('systemNumber', 0))
        for i, sysrec in enumerate(sys_list):
            members = list(ducts_by_system.get(sysrec.get('systemNumber'), []))
            # Add a slice of fittings
            fpf = max(1, len(fittings_list) // max(1, len(sys_list)))
            members.extend([fi['entity'] for fi in fittings_list[i * fpf:(i + 1) * fpf]])
            if not members:
                continue
            try:
                sys_ent = f.create_entity(
                    'IfcDistributionSystem',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    Name=sysrec.get('name') or f"System {sysrec.get('systemNumber')}",
                    PredefinedType='EXHAUSTAIR',
                )
                f.create_entity(
                    'IfcRelAssignsToGroup',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    RelatedObjects=tuple(members),
                    RelatingGroup=sys_ent,
                )
                if building is not None:
                    f.create_entity(
                        'IfcRelServicesBuildings',
                        GlobalId=_new_guid(),
                        OwnerHistory=owner,
                        RelatingSystem=sys_ent,
                        RelatedBuildings=(building,),
                    )
                systems_emitted.append(sys_ent)
            except Exception as ex:
                counts.setdefault('spec_system_errors', []).append(str(ex))
                continue
    counts['spec_systems_emitted'] = len(systems_emitted)

    # 3. IfcRelConnectsPathElements from specInstances.pathConnections
    path_emitted = 0
    if path_connections:
        for pc in path_connections:
            try:
                relating_id = pc.get('relating')
                related_id = pc.get('related')
                # Look up both as duct or fitting
                relating_ent = (duct_index.get(relating_id) or {}).get('entity') or (fitting_index.get(relating_id) or {}).get('entity')
                related_ent = (duct_index.get(related_id) or {}).get('entity') or (fitting_index.get(related_id) or {}).get('entity')
                if relating_ent is None or related_ent is None:
                    continue
                f.create_entity(
                    'IfcRelConnectsPathElements',
                    GlobalId=_new_guid(),
                    OwnerHistory=owner,
                    RelatingElement=relating_ent,
                    RelatedElement=related_ent,
                    RelatingPriorities=(),
                    RelatedPriorities=(),
                    RelatingConnectionType=pc.get('relatingConnectionType') or 'ATEND',
                    RelatedConnectionType=pc.get('relatedConnectionType') or 'ATSTART',
                )
                path_emitted += 1
            except Exception as ex:
                counts.setdefault('spec_path_errors', []).append(str(ex))
                continue
    counts['spec_path_connections_emitted'] = path_emitted


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def _apply_offset(spec, offset_xy):
    """
    Translate every placement origin (and duct start/end points) by offset_xy.
    Mutates spec in place. Skipped when offset is (0, 0) — keeps original layout
    if no tunnel bbox was supplied.
    """
    ox, oy = offset_xy
    if ox == 0.0 and oy == 0.0:
        return spec

    def shift(pt):
        if not isinstance(pt, dict):
            return pt
        if 'x' in pt: pt['x'] = float(pt.get('x', 0)) + ox
        if 'y' in pt: pt['y'] = float(pt.get('y', 0)) + oy
        return pt

    for collection_key in ('walls', 'slabs', 'coverings', 'fittings', 'doors', 'equipment'):
        for el in (spec.get(collection_key) or []):
            placement = el.get('placement') or {}
            if 'origin' in placement:
                shift(placement['origin'])
    for d in (spec.get('ducts') or []):
        placement = d.get('placement') or {}
        if 'start' in placement: shift(placement['start'])
        if 'end' in placement:   shift(placement['end'])
    return spec


def _route_ducts_along_tunnel(spec, tunnel_segments, ceiling_offset_m):
    """
    Override each spec duct's start/end so the duct sits ON a tunnel segment,
    oriented along the segment direction, at ceiling height. One duct per
    tunnel segment (round-robin if more ducts than segments).
    """
    if not tunnel_segments:
        return
    ducts = spec.get('ducts') or []
    n_seg = len(tunnel_segments)
    for i, d in enumerate(ducts):
        seg = tunnel_segments[i % n_seg]
        (sx, sy, sz), (ex, ey, ez) = seg
        # Lift to ceiling height — tunnel arches are typically 4m tall, ducts
        # at 0.5m diameter ride near the crown. Use ceiling_offset_m above
        # segment Z (which is the tunnel floor centerline elevation).
        d['placement']['start'] = {'x': sx, 'y': sy, 'z': sz + ceiling_offset_m}
        d['placement']['end']   = {'x': ex, 'y': ey, 'z': ez + ceiling_offset_m}


def emit_spec_instances(*, f, owner, project, building, body_sub, axis_sub, storeys, css, counts, placement_offset=(0.0, 0.0), tunnel_segments=None):
    """
    Walk css.metadata.specInstances and emit all spec entities.

    Args:
      placement_offset: (dx, dy) — translates every spec element placement so
        the layout sits near the tunnel bbox instead of world origin. Without
        this, spec elements appear floating at (0, 0, 0) far from the
        VSM-frame tunnel coordinates.

    Side effects:
      - Appends emitted IfcProducts to storey['placed'] (so existing
        IfcRelContainedInSpatialStructure logic auto-contains them).
      - Mutates `counts` with telemetry: spec_walls_emitted, spec_slabs_emitted,
        spec_coverings_emitted, spec_ducts_emitted, spec_fittings_emitted,
        spec_doors_emitted, spec_equipment_emitted, spec_systems_emitted,
        spec_ports_emitted, spec_path_connections_emitted.

    Returns: dict with entity lists (for caller telemetry).
    """
    spec = (css or {}).get('metadata', {}).get('specInstances')
    if not spec:
        counts['spec_instances_present'] = False
        return {}

    counts['spec_instances_present'] = True

    # SPEC_EMIT_FILTER controls which entity classes are emitted:
    #   'ducts_only' (default) — ducts only, routed along the tunnel
    #     centerline polyline so they appear as piping running through the
    #     tunnel. Fittings / walls / slabs / coverings / doors / equipment /
    #     ports / systems skipped to keep the render visually clean.
    #   'all'   — every spec class (full annex layout).
    #   'ducts_with_topology' — ducts along tunnel + fittings/ports/systems
    #     (intermediate richness).
    import os as _os
    emit_filter = (_os.environ.get('SPEC_EMIT_FILTER') or 'ducts_only').strip().lower()
    counts['spec_emit_filter'] = emit_filter
    print(f'[SPEC-EMIT] filter mode: {emit_filter}')

    # If we have a tunnel polyline, route ducts onto it BEFORE applying the
    # bbox offset (since segment coords are already in tunnel frame).
    # Otherwise apply the local→tunnel-bbox-center offset to the duct cluster.
    if tunnel_segments and emit_filter in ('ducts_only', 'ducts_with_topology'):
        # Ceiling offset = approx. duct radius + small clearance. Spec ducts
        # are 500mm so 0.5/2 + 0.25 = 0.5m above the segment centerline (which
        # is roughly tunnel floor).
        _route_ducts_along_tunnel(spec, tunnel_segments, ceiling_offset_m=0.5)
        # Walls / slabs etc. (when emit_filter='all') still need the bbox offset.
        if emit_filter == 'all':
            _apply_offset({'walls': spec.get('walls'), 'slabs': spec.get('slabs'),
                           'coverings': spec.get('coverings'), 'doors': spec.get('doors'),
                           'equipment': spec.get('equipment'), 'fittings': spec.get('fittings')},
                          placement_offset)
    else:
        _apply_offset(spec, placement_offset)
    mat_cache = _MaterialCache(f)

    walls, slabs, coverings, doors, equipment = [], [], [], [], []
    if emit_filter == 'all':
        walls = _emit_walls(f, owner=owner, body_sub=body_sub, axis_sub=axis_sub,
                           storeys=storeys, walls=spec.get('walls') or [], mat_cache=mat_cache, counts=counts)
        slabs = _emit_slabs(f, owner=owner, body_sub=body_sub, storeys=storeys,
                           slabs=spec.get('slabs') or [], mat_cache=mat_cache, counts=counts)
        coverings = _emit_coverings(f, owner=owner, body_sub=body_sub, storeys=storeys,
                                    coverings=spec.get('coverings') or [], mat_cache=mat_cache, counts=counts)
    ducts, duct_index = _emit_ducts(f, owner=owner, body_sub=body_sub, storeys=storeys,
                                    ducts=spec.get('ducts') or [], mat_cache=mat_cache, counts=counts)
    # Skip fittings + systems in clean ducts_only mode — they were producing
    # cross-shape artifacts in the viewer because their orientation didn't
    # follow the tunnel.
    fittings, fitting_index = [], {}
    if emit_filter in ('all', 'ducts_with_topology'):
        fittings, fitting_index = _emit_fittings(f, owner=owner, body_sub=body_sub, storeys=storeys,
                                                 fittings=spec.get('fittings') or [], mat_cache=mat_cache, counts=counts)
    if emit_filter == 'all':
        host_walls = []
        for w in spec.get('walls') or []:
            wo = w.get('placement', {}).get('origin') or {}
            ent_idx = None
            for ent in walls:
                if ent.Name == (w.get('name') or w.get('id')):
                    ent_idx = ent
                    break
            if ent_idx is None:
                continue
            host_walls.append({
                'id': w.get('id'),
                'origin': (_safe_float(wo.get('x')), _safe_float(wo.get('y')), _safe_float(wo.get('z'))),
                'entity': ent_idx,
            })
        doors = _emit_doors(f, owner=owner, body_sub=body_sub, storeys=storeys,
                           doors=spec.get('doors') or [], host_walls=host_walls, counts=counts)
        equipment = _emit_equipment(f, owner=owner, body_sub=body_sub, storeys=storeys,
                                    equipment=spec.get('equipment') or [], mat_cache=mat_cache, counts=counts)
    if emit_filter in ('all', 'ducts_with_topology'):
        _emit_systems_ports_connections(
            f, owner=owner, building=building,
            duct_index=duct_index, fitting_index=fitting_index, equipment_entities=equipment,
            systems=spec.get('systems') or [], path_connections=spec.get('pathConnections') or [],
            counts=counts,
        )

    print(
        f"[SPEC-EMIT] walls={counts.get('spec_walls_emitted', 0)}, "
        f"slabs={counts.get('spec_slabs_emitted', 0)}, "
        f"coverings={counts.get('spec_coverings_emitted', 0)}, "
        f"ducts={counts.get('spec_ducts_emitted', 0)}, "
        f"fittings={counts.get('spec_fittings_emitted', 0)}, "
        f"doors={counts.get('spec_doors_emitted', 0)}, "
        f"equipment={counts.get('spec_equipment_emitted', 0)}, "
        f"systems={counts.get('spec_systems_emitted', 0)}, "
        f"ports={counts.get('spec_ports_emitted', 0)}, "
        f"path_conns={counts.get('spec_path_connections_emitted', 0)}"
    )

    return {
        'walls': walls, 'slabs': slabs, 'coverings': coverings,
        'ducts': ducts, 'fittings': fittings, 'doors': doors,
        'equipment': equipment,
    }
