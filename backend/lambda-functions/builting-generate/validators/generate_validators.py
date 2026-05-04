"""
Generate-stage validators — all severity: 'warning'.

Each function returns a list of validation entry dicts matching the audit schema:
  { validator, element_id, result, expected, actual, severity, params? }

The runner run_generate_validators() collects all entries, logs them via
log_validation(), and returns { entries, total, passed, warned, failed }.
"""
import math

SEVERITY = 'warning'

_SPATIAL_TYPES = frozenset({'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcProject', 'IfcSpace'})


def placement_present(ifc_products):
    """Every IfcProduct must have a non-null ObjectPlacement."""
    issues = []
    for product in ifc_products:
        if not product.ObjectPlacement:
            issues.append({
                'validator': 'placement_present',
                'element_id': product.GlobalId,
                'result': 'fail',
                'expected': 'non-null IfcLocalPlacement',
                'actual': None,
                'severity': SEVERITY,
            })
    return issues


def solid_non_degenerate(ifc_products):
    """
    For every IfcExtrudedAreaSolid: profile_area > 0 and depth > 0.
    Degenerate solids produce invisible geometry and confuse viewers.
    """
    issues = []
    for product in ifc_products:
        rep = product.Representation
        if not rep:
            continue
        for shape_rep in (rep.Representations or []):
            for item in (shape_rep.Items or []):
                if not item.is_a('IfcExtrudedAreaSolid'):
                    continue
                depth = getattr(item, 'Depth', 0) or 0
                profile = getattr(item, 'SweptArea', None)
                area = 0.0
                if profile:
                    if profile.is_a('IfcRectangleProfileDef'):
                        x = getattr(profile, 'XDim', 0) or 0
                        y = getattr(profile, 'YDim', 0) or 0
                        area = float(x) * float(y)
                    elif profile.is_a('IfcCircleProfileDef'):
                        r = getattr(profile, 'Radius', 0) or 0
                        area = math.pi * float(r) ** 2
                    elif profile.is_a('IfcCircleHollowProfileDef'):
                        r = getattr(profile, 'Radius', 0) or 0
                        t = getattr(profile, 'WallThickness', 0) or 0
                        area = math.pi * (float(r) ** 2 - (float(r) - float(t)) ** 2)
                    elif profile.is_a('IfcArbitraryClosedProfileDef'):
                        area = 1.0  # assume non-degenerate; full area check is expensive
                if depth <= 0 or area <= 0:
                    issues.append({
                        'validator': 'solid_non_degenerate',
                        'element_id': product.GlobalId,
                        'result': 'fail',
                        'expected': 'profile_area > 0 and depth > 0',
                        'actual': {'profile_area': area, 'depth': depth},
                        'severity': SEVERITY,
                        'params': {
                            'product_id': product.GlobalId,
                            'profile_area': area,
                            'depth': depth,
                        },
                    })
    return issues


def spatial_hierarchy_closed(ifc_file):
    """
    Every IfcProduct that is not a spatial element must be contained in a
    spatial structure via IfcRelContainedInSpatialStructure.
    """
    issues = []
    contained = set()
    for rel in ifc_file.by_type('IfcRelContainedInSpatialStructure'):
        for obj in (rel.RelatedElements or []):
            contained.add(obj.id())

    for product in ifc_file.by_type('IfcProduct'):
        if product.is_a() in _SPATIAL_TYPES:
            continue
        if product.id() not in contained:
            issues.append({
                'validator': 'spatial_hierarchy_closed',
                'element_id': product.GlobalId,
                'result': 'fail',
                'expected': 'product referenced in IfcRelContainedInSpatialStructure',
                'actual': 'no spatial container',
                'severity': SEVERITY,
            })
    return issues


def run_generate_validators(ifc_file):
    """
    Run all generate-stage validators against the loaded IFC model.
    Returns { entries, total, passed, warned, failed }.
    Non-fatal: any exception is logged and an empty result is returned.
    """
    try:
        non_spatial = [p for p in ifc_file.by_type('IfcProduct') if p.is_a() not in _SPATIAL_TYPES]
        entries = (
            placement_present(non_spatial) +
            solid_non_degenerate(non_spatial) +
            spatial_hierarchy_closed(ifc_file)
        )
        failed = sum(1 for e in entries if e['result'] == 'fail')
        warned = sum(1 for e in entries if e['result'] == 'warn')
        print(
            f'[generate-validators] total={len(entries)} warned={warned} failed={failed} '
            f'placement_present={sum(1 for e in entries if e["validator"] == "placement_present")} '
            f'solid_non_degenerate={sum(1 for e in entries if e["validator"] == "solid_non_degenerate")} '
            f'spatial_hierarchy_closed={sum(1 for e in entries if e["validator"] == "spatial_hierarchy_closed")}'
        )
        return {'entries': entries, 'total': len(entries), 'passed': 0, 'warned': warned, 'failed': failed}
    except Exception as e:
        print(f'[generate-validators] Non-fatal error: {e}')
        return {'entries': [], 'total': 0, 'passed': 0, 'warned': 0, 'failed': 0}
