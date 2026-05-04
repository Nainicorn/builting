"""
csg_ifc.py — Bake a manifold3d Manifold into an IfcTriangulatedFaceSet.

Phase 6D.1 chooses IfcTriangulatedFaceSet (IFC4) over the older IfcFacetedBrep
because it represents triangulated meshes natively without the
IfcFace/IfcPolyLoop/IfcFaceOuterBound triple-wrapping overhead, keeping the
IFC file ~3× smaller for an equivalent face count.

Vertices are written as a single IfcCartesianPointList3D and indexed by
1-based triplets in CoordIndex (per IFC4 spec).
"""
from __future__ import annotations

import math
from typing import Iterable, List, Sequence, Tuple

import numpy as np

from .csg import Manifold, to_arrays, is_empty


def _weld_vertices(verts: np.ndarray, tris: np.ndarray,
                   tol: float = 1e-4) -> Tuple[np.ndarray, np.ndarray]:
    """Merge vertices that lie within `tol` (metres) of each other. Returns
    (welded_verts, remapped_tris). Reduces duplicate-face risk at boolean
    seams without changing geometry."""
    if verts.shape[0] == 0:
        return verts, tris
    q = np.round(verts / tol).astype(np.int64)
    _, first_idx, inverse = np.unique(
        q, axis=0, return_index=True, return_inverse=True)
    inverse = np.asarray(inverse).reshape(-1)
    welded = verts[first_idx]
    new_tris = inverse[tris]
    a = new_tris[:, 0]
    b = new_tris[:, 1]
    c = new_tris[:, 2]
    keep = (a != b) & (b != c) & (a != c)
    return welded, new_tris[keep]


def emit_triangulated_face_set(
    f,
    body_sub,
    storey_lp,
    owner,
    mesh: Manifold,
    *,
    name: str,
    color_rgb: Tuple[float, float, float] = (0.85, 0.85, 0.85),
    transparency: float = 0.0,
    object_type: str = 'CSG_CARVED',
    weld_tol_m: float = 1e-4,
):
    """Emit `mesh` as a single IfcBuildingElementProxy backed by an
    IfcTriangulatedFaceSet. Returns (proxy_entity, face_count, vertex_count)
    or (None, 0, 0) if the mesh is empty / degenerate.

    `transparency` (0..1) lets debug-mode callers tag patches as visibly
    semi-transparent overlay so they can be A/B'd against the host shell.
    `object_type` is written into IfcBuildingElementProxy.ObjectType — used
    by validators / downstream tooling to distinguish CSG_CARVED (replace)
    from CSG_DEBUG (overlay) and CSG_REPLACE_PENDING (additive but tagged)."""
    if is_empty(mesh):
        return None, 0, 0

    verts, tris = to_arrays(mesh)
    verts, tris = _weld_vertices(verts, tris, tol=weld_tol_m)
    if verts.shape[0] < 4 or tris.shape[0] < 4:
        return None, 0, 0

    coord_list = f.create_entity(
        'IfcCartesianPointList3D',
        CoordList=tuple(
            (float(p[0]), float(p[1]), float(p[2])) for p in verts
        ),
    )
    # CoordIndex is 1-based per IFC spec.
    coord_index = tuple(
        (int(t[0]) + 1, int(t[1]) + 1, int(t[2]) + 1) for t in tris
    )
    tfs = f.create_entity(
        'IfcTriangulatedFaceSet',
        Coordinates=coord_list,
        Closed=True,
        CoordIndex=coord_index,
    )

    # Style assignment via IfcStyledItem (matches existing _apply_style flow).
    rgb = f.create_entity('IfcColourRgb',
                          Red=float(color_rgb[0]),
                          Green=float(color_rgb[1]),
                          Blue=float(color_rgb[2]))
    rendering = f.create_entity(
        'IfcSurfaceStyleRendering',
        SurfaceColour=rgb,
        Transparency=float(max(0.0, min(1.0, transparency))),
        ReflectanceMethod='NOTDEFINED',
    )
    surface_style = f.create_entity(
        'IfcSurfaceStyle',
        Name=f'CSG-{name}',
        Side='BOTH',
        Styles=(rendering,),
    )
    style_assignment = f.create_entity(
        'IfcPresentationStyleAssignment',
        Styles=(surface_style,),
    )
    f.create_entity(
        'IfcStyledItem',
        Item=tfs,
        Styles=(style_assignment,),
        Name=None,
    )

    rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=body_sub,
        RepresentationIdentifier='Body',
        RepresentationType='Tessellation',
        Items=(tfs,),
    )
    product_def = f.create_entity('IfcProductDefinitionShape',
                                  Representations=(rep,))

    # Build a fresh local placement under storey (identity transform — vertices
    # are already in world coordinates).
    loc = f.create_entity('IfcCartesianPoint',
                          Coordinates=(0.0, 0.0, 0.0))
    z = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    placement = f.create_entity('IfcAxis2Placement3D',
                                Location=loc, Axis=z, RefDirection=x)
    obj_lp = f.create_entity(
        'IfcLocalPlacement',
        PlacementRelTo=storey_lp,
        RelativePlacement=placement,
    )

    import ifcopenshell.guid as _guid
    proxy = f.create_entity(
        'IfcBuildingElementProxy',
        GlobalId=_guid.new(),
        OwnerHistory=owner,
        Name=name,
        ObjectType=object_type,
        ObjectPlacement=obj_lp,
        Representation=product_def,
    )
    return proxy, int(tris.shape[0]), int(verts.shape[0])
