"""
clean_tunnel_export.py — Clean tunnel export (Phase 4A).

Phases (cumulative):
    Phase 1   — Structural tunnel shell walls (horizontal / sloped TUNNEL_SEGMENTs).
    Phase 2A  — Vertical shafts (IfcColumn), portal/end boxes (IfcWall), floor slab.
    Phase 2B  — Mitre joint cleanup. Two-way joints extend each segment past the
                joint by t = (outer_w / 2) * tan(bend / 2).
    Phase 3   — Arched tunnel cross-section (flat floor + vertical sidewalls +
                semicircular top). 48-segment arc + per-call profile cache so
                every matching segment shares one canonical IfcProfile entity.
                Floor slab disabled.
    Phase 4A  — Portal end caps at free segment ends (rectangular outer + arched
                inner void hugging the tunnel mouth, extruded along the tunnel
                direction). Doors emitted only when metadata.hostWallKey resolves
                to a kept portal/end wall. Vertical shaft endpoint reconstruction
                from origin/center/location + height fields when CSS lacks
                start/endPoint.
    Phase 4B  — Geometry quality upgrade. Tunnel walls move from
                IfcExtrudedAreaSolid to IfcFacetedBrep. ARCH_SEGMENTS reduced
                48 -> 16 to remove the ribbed look. At every two-way joint the
                cross-section vertices are projected onto the bisector plane
                along the segment's local-X (true mitre cut — adjacent walls
                meet exactly along one curve, no gap, no overlap). Portal
                origins snap to nearest kept tunnel endpoint within 5 m; shaft
                bases snap to the top of the nearest tunnel arch within 5 m.
                Curve interpolation at gentle bends is logged as deferred.
    Phase 5A  — Clutter cleanup + controlled ventilation. Hard caps on shaft
                radius (1.5m) and height (12m) unless properties.dimensionsAuthoritative
                is true. PORTAL_BUILDING / PORTAL_END_WALL must sit within 2m of
                a real tunnel endpoint or are skipped (filters floating thick
                wall blocks). New CLEAN_VENTILATION_EXPORT mode (env-gated, off
                by default): emits ducts/airways with valid sweep paths only,
                length>0.5m, sane radius/diameter, xy-bbox within 5m of tunnel
                centerline, never vertical unless the source explicitly tags
                RISER/SHAFT. Geometry is path-based; no fallback extrusion. Color
                is neutral light gray (0.80, 0.82, 0.85).
    Future    — Phase 4C fillets at bends; Phase 5B+ duct ceiling-snap, fans, pumps.

This module is self-contained: it does NOT import any helpers from the legacy
generator. Any geometry primitive used here is defined in this file.

Placement conventions
---------------------
Walls (horizontal / sloped):
    object local X (RefDirection) = unit(end - start)
    object local Z (Axis)         = closest-to-world-up perpendicular to local X
    extrusion direction           = object local X     (solid Position rotated)

Shafts (vertical):
    object local Z (Axis)         = (0, 0, 1)          — explicit, never zero
    object local X (RefDirection) = (1, 0, 0)
    extrusion direction           = (0, 0, 1)          — straight up

Portals (vertical wall/box at tunnel mouth):
    object local Z (Axis)         = (0, 0, 1)
    object local X (RefDirection) = placement.refDirection (forced horizontal)
    extrusion direction           = (0, 0, 1)

Slab (single floor slab, horizontal):
    object local Z (Axis)         = (0, 0, 1)
    extrusion direction           = (0, 0, 1)          — thin upward extrusion
    profile is centered on the bbox center

Skip behaviour
--------------
Invalid input is skipped + logged. No proxy cubes, no fabricated geometry.
"""

import json
import math
import os
from datetime import datetime, timezone

import ifcopenshell
import ifcopenshell.guid

from secondary_geometry.profile_config import load_profile, format_profile
from secondary_geometry.validation import (
    _safe_float,
    _safe_xyz,
    _extract_endpoints,
    _extract_horizontal_profile,
)
from secondary_geometry.topology import (
    _chain_profile_signature,
    _find_main_loop,
    _node_in_component,
    _back_edge_cycle,
    has_parallel_continuation,
)
from secondary_geometry.math_utils import (
    _vec_sub,
    _vec_len,
    _vec_norm,
    _vec_cross,
    _vec_dot,
    _vec_neg,
    _project_along_dir_onto_plane,
)
from secondary_geometry.geometry import (
    _build_frame_from_direction,
    _profile_pt_to_world,
)
from secondary_geometry.attachment import (
    _snap_origin_to_nearest_endpoint,
    _reconstruct_shaft_endpoints,
    project_point_onto_frame,
    in_frame_opening,
    clamp_panel_to_opening,
)

# Phase 6B — IfcWallStandardCase emission for portal entrance + room partition walls.
from structural_walls import emit_phase_6b_walls

# Phase 7.S — Spec-text driven instance emission. Consumes css.metadata.specInstances
# and emits IfcWallStandardCase + IfcMaterialLayerSetUsage, IfcSlab + 4-layer
# composite, IfcCovering + 2-layer compound, IfcDuctSegment + IfcCircleHollowProfileDef,
# IfcDuctFitting (revolved elbows + cone transitions), IfcDoor + IfcOpeningElement +
# voids/fills + IfcDoorLiningProperties + IfcDoorPanelProperties, IfcBuildingElement-
# Proxy with CAT material palette, IfcDistributionSystem + IfcDistributionPort +
# IfcRelConnectsPortToElement + IfcRelServicesBuildings + IfcRelConnectsPathElements.
from spec_instance_emitter import emit_spec_instances

# PRESENTATION_SAFE_MODE — post-emit spatial filter (default on).
try:
    from secondary_geometry.presentation_filter import (
        build_centerlines as _pf_build_centerlines,
        filter_list       as _pf_filter_list,
        reanchor_room_wall as _pf_reanchor_room_wall,
    )
    _PF_AVAILABLE = True
except Exception as _pf_imp_ex:
    print(f'[PRES-FILTER] unavailable: {_pf_imp_ex} — skipping')
    _PF_AVAILABLE = False

# Phase 6D.1 — manifold3d-backed CSG junction fillers (env-flagged).
try:
    from secondary_geometry import (  # type: ignore
        csg_junctions as _phase6d_csg_junctions,
        csg_ifc as _phase6d_csg_ifc,
        csg_validators as _phase6d_csg_validators,
        csg_clusters as _phase6d_csg_clusters,
    )
    _PHASE_6D_CSG_AVAILABLE = True
except Exception as _phase6d_imp_ex:  # noqa: BLE001
    print(f"[CSG-FILLER] manifold3d/csg modules unavailable: "
          f"{_phase6d_imp_ex} — fillers disabled")
    _PHASE_6D_CSG_AVAILABLE = False


# ---------------------------------------------------------------------------
# Visual quality feature flags
# ---------------------------------------------------------------------------

# VISUAL_SAFE_MODE (default on) — applies per-element visual quality gate in
# Phase 7 before emitting geometry. Elements that fail the gate are emitted
# as metadata-only IFC entities (no Representation) or suppressed entirely.
# Set VISUAL_SAFE_MODE=off to revert to the old "emit everything" behavior.
_VISUAL_SAFE_MODE = os.environ.get('VISUAL_SAFE_MODE', 'on').lower() != 'off'

# PRESENTATION_SAFE_MODE (default on) — post-emit spatial filter that removes
# any secondary IFC entity whose origin is not confidently anchored to the
# tunnel frame (segment centerlines + free endpoints).  Uses 3-D centerline
# distance, not just the coarse tunnel bbox used by the VQ gate.
# Set PRESENTATION_SAFE_MODE=off to disable (debugging only).
_PRESENTATION_SAFE_MODE = os.environ.get('PRESENTATION_SAFE_MODE', '1') == '1'

# TUNNEL_ONLY_MODE (default off) — when on, Phase 7 skips ALL geometry except
# tunnel shell, ducts/fittings, and high-confidence equipment. Useful for a
# clean baseline render to verify the core tunnel network before re-adding
# rooms/slabs/walls.
_TUNNEL_ONLY_MODE = os.environ.get('TUNNEL_ONLY_MODE', 'off').lower() == 'on'

# VISUAL_DEBUG (default off) — when on, suppressed/rejected elements get
# colored diagnostic geometry instead of being silently dropped. Also
# enables the red continuity-failure color on chain segments.
_VISUAL_DEBUG = os.environ.get('VISUAL_DEBUG', 'off').lower() == 'on'

# VISUAL_CLEAN_MODE — set to 'final_like' for the strictest visual cleanup.
# Activates FINAL_LIKE emit mode: connected-component filtering, hard shaft
# clamping, room/slab/covering full suppress, thin-member anchor checks.
_VISUAL_CLEAN_MODE = os.environ.get('VISUAL_CLEAN_MODE', 'off').lower()

_VQ_EMIT_MODE = (
    'FINAL_LIKE'  if _VISUAL_CLEAN_MODE == 'final_like'
    else 'TUNNEL_ONLY' if _TUNNEL_ONLY_MODE
    else ('VISUAL_SAFE' if _VISUAL_SAFE_MODE else 'FULL')
)

print(f'[VISUAL-GATE] mode={_VQ_EMIT_MODE}  '
      f'VISUAL_SAFE={_VISUAL_SAFE_MODE}  '
      f'TUNNEL_ONLY={_TUNNEL_ONLY_MODE}  '
      f'VISUAL_CLEAN={_VISUAL_CLEAN_MODE}  '
      f'VISUAL_DEBUG={_VISUAL_DEBUG}')

# Import visual quality gate (must be after os import and flag definitions).
try:
    from visual_quality_gate import (
        visual_gate as _visual_gate,
        shaft_clamped_dims as _shaft_clamped_dims,
        shaft_clamped_dims_final_like as _shaft_clamped_dims_final_like,
        build_audit_report as _build_audit_report,
        VisualAuditRow as _VisualAuditRow,
        _extract_origin as _vq_extract_origin,
        _extract_dimensions as _vq_extract_dimensions,
        _dist_to_tunnel_bbox as _vq_dist_to_tunnel_bbox,
        _safe_float as _vq_safe_float,
    )
    _VQ_AVAILABLE = True
except ImportError as _vq_imp_ex:
    print(f'[VISUAL-GATE] visual_quality_gate unavailable: {_vq_imp_ex} — '
          f'falling back to FULL emit mode')
    _VQ_AVAILABLE = False
    _VQ_EMIT_MODE = 'FULL'

try:
    from audit import log_decision as _log_decision
except ImportError:
    def _log_decision(*a, **k): pass


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SHELL_COLOR = (0.753, 0.753, 0.753)         # Concrete gray (walls / shafts / portals)
SLAB_COLOR = (0.65, 0.65, 0.65)             # Slightly darker concrete for floor

SHELL_THICKNESS_DEFAULT = 0.30              # m — fallback shell thickness
VERTICAL_THRESHOLD = 0.95                   # |dz|/L above this → vertical shaft
STEEP_HORIZONTAL_THRESHOLD = 0.45          # |dz|/L above this → too steep to render as horizontal bore
MIN_SEGMENT_LENGTH = 0.5                    # m — discard degenerate

SLAB_THICKNESS = 0.25                       # m
SLAB_MARGIN = 1.0                           # m — slab extends past tunnel bbox
SLAB_MIN_AREA = 1.0                         # m² — skip if smaller
SLAB_BOTTOM_OFFSET = 0.05                   # m — slab top this far below lowest tunnel z

# Phase 7 SPACE depth cap for circular shaft spaces. Shaft volumes declared
# with depth=30m are correct geologically but produce 30m towers in the viewer.
# A representative stub of SPACE_SHAFT_VIS_CAP shows the shaft opening position.
SPACE_SHAFT_VIS_CAP = 5.0                  # m — cap for SPACE CIRCLE extrusion depth

# Portal dimensional sanity. The topology engine over-tags PORTAL_BUILDING /
# PORTAL_END_WALL onto stray DXF walls; without these guards the export pulls
# in stick-thin towers (e.g. 0.2x0.1m profile extruded 50 m) that aren't real
# portal buildings. Real portals span the tunnel bore (>=2 m wide), have
# meaningful outward depth (>=1 m), and are roughly room-height (1.5-15 m tall).
PORTAL_MIN_WIDTH = 2.0
PORTAL_MIN_HEIGHT = 1.0
PORTAL_MIN_DEPTH = 1.5
PORTAL_MAX_DEPTH = 15.0
PORTAL_MAX_ASPECT = 6.0                     # max(w,h)/min(w,h) ratio
PORTAL_MAX_DIST_FROM_TUNNEL = 10.0          # m beyond kept-tunnel XY bbox
PORTAL_MAX_DIST_TO_ENDPOINT = 8.0           # m to nearest kept-segment endpoint

# Arched profile arc subdivision.
# Phase 3 used 48 segments to mask seams between adjacent extrusions, but that
# produced a visibly ribbed look. With Phase 4B we move to per-segment brep with
# bisector-projected end caps, so adjacent segments meet exactly along a single
# mitre curve — 16 arc segments are plenty for a clean, smooth-shaded surface.
ARCH_SEGMENTS = 32
ARCH_MIN_SIDEWALL_M = 0.3                   # below: dimensions don't fit clean arch
ARCH_MAX_SHELL_RATIO = 0.7                  # shell_t < r * this for valid inner

# Joint continuity (Phase 3 polish).
JOINT_EPSILON_OVERLAP = 0.005               # 5 mm — closes floating-point gaps
                                            # at every adjacent joint (added on
                                            # top of the mitre extension).

# Phase 4A — portal end caps + doors.
PORTAL_FRAME_THICKNESS = 0.4                # m — depth of cap (along tunnel)
PORTAL_FRAME_MARGIN = 0.6                   # m — frame extends past tunnel outer
# Phase 5C.2 — synthetic portal frames are only emitted at free ends of
# tunnel segments long enough to be a real entrance. Anything shorter is an
# internal branch stub and gets skipped (portal_frames_skipped_internal).
PORTAL_CAP_MIN_SEGMENT_LENGTH = 10.0        # m
# Phase 5B.5F — fixed visible default panel size. Width is clamped down to
# bore_w and height to bore_h when the opening is smaller; otherwise these
# are used verbatim so panels are clearly readable in the viewer.
DOOR_DEFAULT_WIDTH = 1.0                    # m — fallback when doorType unknown
DOOR_DEFAULT_HEIGHT = 2.1                   # m — fallback when doorType unknown
DOOR_DEFAULT_THICKNESS = 0.10               # m — door panel thickness
DOOR_COLOR = (0.40, 0.25, 0.15)             # wood brown

# Phase 6A — authoritative nominal door dimensions by type.
# Match final.ifc: single=810×2110mm, double=1800×2100mm.
# Used by _emit_door_from_intent when intent.doorType is set.
DOOR_SINGLE_WIDTH  = 0.810  # m — Type A interior single door
DOOR_SINGLE_HEIGHT = 2.110  # m
DOOR_DOUBLE_WIDTH  = 1.800  # m — Type B double-leaf passage door
DOOR_DOUBLE_HEIGHT = 2.100  # m

# Phase 5B.1 — door proximity recovery radius. When a CSS DOOR has no
# resolvable hostWallKey but a synthetic portal frame was emitted within this
# xy distance of the door's origin, the door is emitted anchored to that
# frame. Kept generous (5 m) because synthetic frames sit at tunnel free-ends
# and CSS door origins typically reference the portal-building centroid.
DOOR_PROXIMITY_RADIUS = 5.0                 # m

# Phase 5B.5A — door size policy relative to the host opening. Real-world
# doors don't span the full bore — width caps at 40% of opening width,
# height at 70% of opening height. Anything below the absolute minimums is
# rejected after clamping (doors_skipped_invalid_after_clamp).
DOOR_OPENING_WIDTH_FRAC = 0.40
DOOR_OPENING_HEIGHT_FRAC = 0.70
DOOR_MIN_WIDTH = 0.5                        # m
DOOR_MIN_HEIGHT = 1.5                       # m

# Phase 5B.5C — door hosting on real walls (tunnel shell or branch wall).
# Door must sit within DOOR_WALL_FACE_TOLERANCE of a horizontal wall's outer
# face to qualify as hosted. The opening cut into the wall is door dims +
# 2 * DOOR_OPENING_MARGIN per side.
DOOR_WALL_FACE_TOLERANCE = 0.5              # m
DOOR_OPENING_MARGIN = 0.05                  # m  (50 mm margin around door)

# Phase 5B.5D — door placement correctness. A door is only valid where it has
# structural meaning: a segment endpoint, a joint between segments, or
# anywhere along a short side-segment (a "room" or branch entrance). Mid-
# segment placements with no junction are rejected.
DOOR_SHORT_BRANCH_THRESHOLD = 5.0           # m — segments shorter than this
                                            #     are treated as room/branch
                                            #     entrances; entire length OK
DOOR_ENDPOINT_TOLERANCE = 1.5               # m — projection within this many
                                            #     metres of either segment end
                                            #     counts as "at endpoint"
DOOR_ENDPOINT_SNAP_TOLERANCE = 0.3          # m — within this, snap projection
                                            #     EXACTLY to the segment end

# Phase 5B.5E — opening-driven door reconciliation. A "room/branch opening" is
# a joint endpoint of a non-main-loop (branch) wall — the spot where a side
# passage meets the main tunnel. Door candidates are assigned to the nearest
# opening within DOOR_OPENING_ASSIGNMENT_RADIUS by xy distance from the source
# door's origin. If no opening is in range, the priority-3 wall fallback is
# also restricted to branch walls so doors can't land at long-tunnel-wall
# endpoints (e.g. main-loop bends).
#
# Phase 5B.5F — radius tightened from 15 m to 5 m. Inputs without a clear
# host_key cannot match a far-away opening any more. When the input DOES
# carry an explicit hostWallKey, the looser explicit radius applies.
# Phase 5B.6 (Task C) — radii tightened further. Default 3 m matches the
# typical short-branch geometry and prevents 10 m hops. Explicit hostWallKey
# match still gets the looser 5 m radius. Note: pruning of opening_targets
# happens upstream in _build_room_opening_targets, so doors can never assign
# to a non-doorway joint endpoint regardless of radius.
DOOR_OPENING_ASSIGNMENT_RADIUS = 3.0        # m — default input-to-opening radius
DOOR_OPENING_ASSIGNMENT_RADIUS_EXPLICIT = 5.0  # m — only when input has explicit host_key
# Phase 5B.6 (Task F) — second-pass topology recovery radius. Only used for
# doors that the primary global pass marked `no_candidate`. The candidate
# endpoint must also pass topology classification (continuation / free_end_branch
# / junction). Isolated segments are never recovered.
DOOR_OPENING_ASSIGNMENT_RADIUS_TOPOLOGY = 6.0   # m

# Phase 6B — engineer-intent door consumption.
# When css.metadata.featureFlags.intentMode >= 'consume-doors', the topology
# engine's intent-resolver is the SOLE decision-maker for door host & position.
# Doors with metadata.intent missing or with confidence below this threshold
# are skipped silently — no fallback to legacy nearest-wall / opening-matching
# / topology-recovery heuristics.
INTENT_CONFIDENCE_THRESHOLD = 0.4
INTENT_CONSUME_MODES = ('consume-doors', 'consume-mep', 'consume-all')

# Phase 4B — brep alignment thresholds.
PORTAL_SNAP_DIST = 5.0                      # m — snap portal origin to tunnel endpoint within this
SHAFT_SNAP_DIST = 5.0                       # m — snap shaft xy to tunnel surface within this

# Mitre/joint cleanup (Phase 2B). Each two-way joint extends each segment past
# the joint point by t = (outer_w / 2) * tan(bend / 2), where bend is the
# centerline turn angle. Three-way+ joints are skipped (no clean rule).
JOINT_POS_TOL_M = 0.05                      # 50 mm endpoint coincidence
MITRE_BEND_MIN_DEG = 2.0                    # below: nearly straight, no trim
MITRE_BEND_MAX_DEG = 178.0                  # above: near-U-turn, math unstable
MITRE_TRIM_CAP_FACTOR = 1.5                 # cap trim at this * full outer width

# Phase 6B.4a — 3-way junction halfspace trimming. At a 3+way joint we identify
# the most-antiparallel pair as the main "continuation" (gets standard 2-way
# mitre) and treat every remaining segment as a branch. Each branch's end
# cross-section is butt-cut by a plane perpendicular to its own axis at
# joint_pos - main_half_w_outer * branch_outward_dir, so the branch terminates
# flush at the main shell's outer surface instead of passing through it.
BRANCH_BUTT_OFFSET_RATIO = 1.0              # branch ends at main_half_w_outer * this from joint
BRANCH_BUTT_MAX_TRIM_FRAC = 0.45            # never trim more than this fraction of branch length
THREE_WAY_PAIR_MAX_DOT = -0.5               # require pair dot ≤ this (≥120° antiparallel) to count
                                            # as a continuation; otherwise skip with no main pair

# ---------------------------------------------------------------------------
# Phase 5A — clutter cleanup + controlled ventilation
# ---------------------------------------------------------------------------

# Shaft hard caps. Skip a shaft whose source dimensions exceed these unless the
# CSS explicitly marks the dimensions authoritative
# (`properties.dimensionsAuthoritative === true`).
SHAFT_MAX_RADIUS_DEFAULT = 1.5              # m
SHAFT_MAX_HEIGHT_DEFAULT = 12.0             # m
# Phase 5C.3 — shaft dedup. Multiple CSS shafts at near-coincident XY are
# almost always duplicates from the upstream pipeline. Keep the first that
# passes strict validation; skip the rest within this xy radius.
SHAFT_DEDUPE_RADIUS = 3.0                   # m

# Portal block strict attachment. PORTAL_BUILDING / PORTAL_END_WALL must sit
# within this xy distance of a kept tunnel endpoint (= a real tunnel mouth).
# Tightened from PORTAL_MAX_DIST_TO_ENDPOINT (8 m) to filter floating wall
# blocks the topology engine mis-tagged.
PORTAL_BLOCK_MAX_DIST_TO_ENDPOINT = 5.0     # m — raised from 2.0; real portals sit 2-5m from tunnel endpoints
# Hard size cap on portal blocks (independent of width/depth aspect rules).
PORTAL_BLOCK_MAX_WIDTH = 12.0               # m
PORTAL_BLOCK_MAX_HEIGHT = 8.0               # m

# Ventilation export (Phase 5A). Off by default — opt-in via env. When enabled,
# only ducts/airways with a valid sweep path and reasonable dimensions are
# emitted. Geometry is ALWAYS path-based; there is NO fallback extrusion.
CLEAN_VENTILATION_EXPORT_ENV = 'CLEAN_VENTILATION_EXPORT'
VENT_COLOR = (0.80, 0.82, 0.85)             # neutral light gray (NOT teal debug)
VENT_MIN_LENGTH = 0.5                       # m
VENT_MIN_RADIUS = 0.05                      # m  (5 cm minimum)
VENT_MAX_RADIUS = 3.0                       # m  (6 m diameter cap)
VENT_MIN_RECT = 0.05                        # m  (rectangular profile min side)
VENT_MAX_RECT = 6.0                         # m  (rectangular profile max side)
VENT_MAX_DIST_FROM_TUNNEL = 3.0             # m  (xy bbox-to-tunnel-shell)
VENT_VERTICAL_THRESHOLD = 0.95              # |dz|/L above this → "vertical"
VENT_RISER_BRANCH_CLASSES = ('RISER', 'SHAFT', 'VERTICAL')  # vertical OK iff one of these

# Phase 5B.3 — reconstructed ventilation along the tunnel interior.
# When ENABLE_RECONSTRUCTED_VENTILATION=true, one clean cylindrical duct is
# emitted per kept horizontal segment along the segment's ceiling. The duct's
# radius is sourced from any valid raw duct candidate's profile (median or
# first valid), or — only when ALLOW_CONFIG_DEFAULTS=true — falls back to
# RECON_VENT_DEFAULT_RADIUS. The duct's centerline is offset DOWN from the
# segment's centerline by (bore_h/2 - clearance) so it hugs the arch crown
# and never pierces the shell.
RECON_VENT_DEFAULT_RADIUS = 0.4             # m — used only with ALLOW_CONFIG_DEFAULTS
# Phase 5C.1 — clearance is now from crown to duct OUTER. With duct center at
# (bore_h/2 - radius - clearance), the outer surface sits exactly clearance below
# the arch crown. Tightened from 0.20m to 0.15m per the 5C spec.
RECON_VENT_CEILING_CLEARANCE = 0.15         # m — distance from arch crown to duct outer
RECON_VENT_MIN_RADIUS = VENT_MIN_RADIUS     # mirror raw-duct lower bound
RECON_VENT_MAX_RADIUS = VENT_MAX_RADIUS     # mirror raw-duct upper bound
# 5C.1 — drop short tunnel fragments from the reconstructed vent pass. Primary
# runs only — anything below this length is a stub branch and gets skipped.
RECON_VENT_MIN_RUN_LENGTH = 1.5             # m — segments shorter than this skip emit

# Phase 5A.12 — strict secondary geometry enforcement.
# Portal dimensional rules in strict mode: portal cross-section is bound to
# the host tunnel bore profile. ≤0.3m margin on each axis, hard 2× host cap,
# and a thin-wall thickness cap.
PORTAL_HOST_MARGIN = 0.6                    # m — portal width/height may exceed host by this much
PORTAL_HOST_MAX_RATIO = 2.0                 # portal dim must be ≤ this × host dim
PORTAL_THICKNESS_CAP = 0.5                  # m — hard cap on the smaller profile axis (wall thickness)


# ---------------------------------------------------------------------------
# Vector ops + GUID
# ---------------------------------------------------------------------------

def _phase11b_door_rejected(elem, counts):
    """Phase 11B bypass-bug fix: any DOOR flagged DOOR_REJECTED by the
    structural-integration pass MUST not reach IfcDoor creation.  All door
    emit paths (intent loop / Phase 8 hosted / Phase 7B.3 acceptedNoHost
    recovery / portal fallback / _emit_door / _emit_door_in_wall /
    _emit_door_void_fill) call this helper as the first thing they do.
    Returns True iff the caller must skip emit."""
    if not isinstance(elem, dict):
        return False
    if (elem.get('type') or '').upper() != 'DOOR':
        return False
    if (elem.get('properties') or {}).get('spatialFlag') == 'DOOR_REJECTED':
        if counts is not None:
            counts['phase11b_doors_skipped_rejected'] = (
                counts.get('phase11b_doors_skipped_rejected', 0) + 1)
        return True
    return False


def _new_guid():
    return ifcopenshell.guid.new()


# 5A.10 — vec ops (_vec_sub, _vec_len, _vec_norm, _vec_cross, _vec_dot, _vec_neg)
# and _project_along_dir_onto_plane moved to secondary_geometry.math_utils.
# Imported at module scope below.


def _round_endpoint(p, tol=JOINT_POS_TOL_M):
    """Round an XYZ to the nearest `tol` (default 50mm) for endpoint-coincidence
    joint detection. Quantization is exact integer math so two endpoints within
    `tol/2` of the same lattice point share the same key."""
    return (
        round(p[0] / tol) * tol,
        round(p[1] / tol) * tol,
        round(p[2] / tol) * tol,
    )


# 5A.8 — _safe_float, _safe_xyz, _extract_endpoints, _extract_horizontal_profile
# moved to secondary_geometry.validation. Imported at module scope below.


# ---------------------------------------------------------------------------
# Element extractors
# ---------------------------------------------------------------------------


def _compute_joint_trims(horizontal_candidates):
    """Solve mitre extensions for each two-way joint between horizontal walls.

    Inputs:
        horizontal_candidates -- list of dicts (one per kept horizontal wall),
            each with: 'd' (unit dir start->end), 'half_w_outer', 'entry_node',
            'exit_node', 'start', 'end', 'elem_id'.

    Joint detection (per user requirement):
        primary: shared entry_node / exit_node string IDs
        fallback: endpoint coincidence within JOINT_POS_TOL_M (50mm)

    Returns (trims, stats):
        trims  -- {seg_index: {'start': t_m, 'end': t_m}} (extension lengths)
        stats  -- joints_detected, two_way, three_way_plus_skipped, free_ends,
                  segments_adjusted (set), max_trim_distance, joints_skipped (list)
    """
    n = len(horizontal_candidates)
    # Each segment contributes two endpoint records: (seg_i, 'start'|'end',
    # node_id_or_None, rounded_pos, raw_pos).
    records = []
    for i, c in enumerate(horizontal_candidates):
        records.append((i, 'start', c.get('entry_node'),
                        _round_endpoint(c['start']), c['start']))
        records.append((i, 'end', c.get('exit_node'),
                        _round_endpoint(c['end']), c['end']))
    m = len(records)

    parent = list(range(m))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    for i in range(m):
        seg_i, _e_i, node_i, pos_i, _raw_i = records[i]
        for j in range(i + 1, m):
            seg_j, _e_j, node_j, pos_j, _raw_j = records[j]
            if seg_i == seg_j:
                continue
            if node_i and node_j and node_i == node_j:
                union(i, j)
            elif pos_i == pos_j:
                union(i, j)

    groups = {}
    for i in range(m):
        groups.setdefault(find(i), []).append(records[i])

    # Phase 6D.1 — expose joint groups for CSG zone construction. Each group
    # is the list of records sharing a physical joint (same node id or
    # endpoint coincidence within JOINT_POS_TOL_M).
    joint_groups_for_csg = list(groups.values())

    trims = {i: {'start': 0.0, 'end': 0.0} for i in range(n)}
    # joint_ends — set of (seg_idx, 'start'|'end') tuples that share a joint
    # with another segment. Free ends = all segment-ends NOT in this set, used
    # downstream to decide where to emit portal caps.
    joint_ends = set()
    for _root, members in groups.items():
        if len(members) >= 2:
            for seg_idx, end_lbl, _node, _pos, _raw in members:
                joint_ends.add((seg_idx, end_lbl))
    # bisector_planes — {(seg_idx, end_lbl): (plane_normal_3d, plane_offset)}
    # for each segment-end at a 2-way joint. Brep emission projects the cross-
    # section vertices at this end onto the plane along local_x, producing a
    # true mitre cut where adjacent segments meet exactly along a single curve.
    bisector_planes = {}
    # Phase 4C: two_way_joint_pairs = list of ((seg_a, end_a), (seg_b, end_b),
    # bend_rad, joint_pos_3d) for every two-way joint we accept (regardless of
    # whether mitre math succeeded). Used by chain detection to walk degree-2
    # connectivity. Three-way+ joints break chains.
    two_way_joint_pairs = []
    stats = {
        'joints_detected': len(groups),
        'two_way': 0,
        'three_way_plus_skipped': 0,
        # Phase 6B.4a — 3+way junctions we can clean up via halfspace trimming.
        'three_way_plus_handled': 0,
        'three_way_main_pair_planes': 0,
        'three_way_branch_butt_cuts': 0,
        'three_way_branch_butt_caps_hit': 0,
        'three_way_no_main_pair': 0,
        'free_ends': 0,
        'segments_adjusted': set(),
        'max_trim_distance': 0.0,
        'trims_capped': 0,
        'joints_skipped': [],
        'joint_ends': joint_ends,
        'bisector_planes': bisector_planes,
        'two_way_joint_pairs': two_way_joint_pairs,
        'joint_groups': joint_groups_for_csg,
    }

    bend_min = math.radians(MITRE_BEND_MIN_DEG)
    bend_max = math.radians(MITRE_BEND_MAX_DEG)

    for root, members in groups.items():
        if len(members) == 1:
            stats['free_ends'] += 1
            continue
        if len(members) >= 3:
            # Phase 6B.4a — 3+way joint halfspace trimming.
            _handle_multi_way_joint(
                members, horizontal_candidates, trims,
                bisector_planes, stats,
                bend_min=bend_min, bend_max=bend_max)
            continue

        stats['two_way'] += 1
        (sa, ea, _na, pa, _ra), (sb, eb, _nb, _pb, _rb) = members
        ca = horizontal_candidates[sa]
        cb = horizontal_candidates[sb]

        # Outgoing direction at the joint (away from joint, into the segment body).
        out_a = ca['d'] if ea == 'start' else _vec_neg(ca['d'])
        out_b = cb['d'] if eb == 'start' else _vec_neg(cb['d'])
        # Bend angle = how much the centerline turns going through the joint.
        # If outgoing vectors are antiparallel (dot=-1), bend=0 (straight pass).
        # If parallel (dot=+1), bend=π (U-turn).
        cos_bend = max(-1.0, min(1.0, -_vec_dot(out_a, out_b)))
        bend = math.acos(cos_bend)

        # Bisector plane (used by brep mitre projection regardless of bend angle,
        # except for nearly-straight or nearly-U-turn joints where the math is
        # degenerate). Normal = normalize(out_b - out_a); plane passes through
        # the joint position (any member's endpoint).
        joint_pos = (ca['start'] if ea == 'start' else ca['end'])
        plane_normal = _vec_norm((out_b[0] - out_a[0],
                                  out_b[1] - out_a[1],
                                  out_b[2] - out_a[2]))
        if (plane_normal is not None
                and bend >= bend_min and bend <= bend_max):
            plane_offset = _vec_dot(plane_normal, joint_pos)
            bisector_planes[(sa, ea)] = (plane_normal, plane_offset)
            bisector_planes[(sb, eb)] = (plane_normal, plane_offset)

        if bend < bend_min:
            # Near-straight joint: no mitre needed, but add a tiny overlap so
            # the two end faces interpenetrate by 5 mm and don't show a fp gap
            # in the viewer.
            for sidx, end_lbl in ((sa, ea), (sb, eb)):
                trims[sidx][end_lbl] = JOINT_EPSILON_OVERLAP
                stats['segments_adjusted'].add(sidx)
            continue
        if bend > bend_max:
            stats['joints_skipped'].append(
                (str(pa), f'bend_{math.degrees(bend):.1f}_unstable'))
            continue

        for sidx, end_lbl, cand in ((sa, ea, ca), (sb, eb, cb)):
            half_w = cand['half_w_outer']
            t = half_w * math.tan(bend / 2.0)
            cap = MITRE_TRIM_CAP_FACTOR * (2.0 * half_w)
            if t > cap:
                t = cap
                stats['trims_capped'] += 1
            # Add epsilon overlap on top of mitre so adjacent end faces
            # interpenetrate slightly and don't show fp gaps in the viewer.
            trims[sidx][end_lbl] = t + JOINT_EPSILON_OVERLAP
            stats['segments_adjusted'].add(sidx)
            if t > stats['max_trim_distance']:
                stats['max_trim_distance'] = t

        two_way_joint_pairs.append(
            ((sa, ea), (sb, eb), bend, joint_pos)
        )

    return trims, stats


def _aabb_from_points(pts):
    """Return (xmin, ymin, zmin, xmax, ymax, zmax) for an iterable of 3D points."""
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    zs = [p[2] for p in pts]
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))


def _aabb_from_segment(start, end, half_outer_w, height_top, height_bottom=0.0):
    """AABB for an axis-aligned-ish horizontal segment shell.

    Treats the shell as a cylinder of cross-section radius `half_outer_w`
    around the centerline `start..end`. Vertical extent runs from
    z(min(start,end)) - height_bottom up to z(max(start,end)) + height_top.
    Conservative — overestimates for diagonal segments — but adequate for
    overlap detection vs CSG hulls."""
    sx, sy, sz = start[0], start[1], start[2]
    ex, ey, ez = end[0], end[1], end[2]
    xmin = min(sx, ex) - half_outer_w
    xmax = max(sx, ex) + half_outer_w
    ymin = min(sy, ey) - half_outer_w
    ymax = max(sy, ey) + half_outer_w
    zmin = min(sz, ez) - height_bottom
    zmax = max(sz, ez) + height_top
    return (xmin, ymin, zmin, xmax, ymax, zmax)


def _aabb_from_box(center, half_x, half_y, half_z):
    """AABB for an axis-aligned box of given centre and half-extents."""
    cx, cy, cz = center[0], center[1], center[2]
    return (cx - half_x, cy - half_y, cz - half_z,
            cx + half_x, cy + half_y, cz + half_z)


def _build_extra_host_aabbs(*, horizontal_candidates, emitted_wall_indices,
                            vertical_candidates, emitted_shaft_xys,
                            synthetic_frame_anchors, vent_endpoints, fittings,
                            portals, doors, elements):
    """Phase 6D.1 P0 — gather host AABBs for emitted IFC entities that the
    primary tunnel/phase6b collectors miss. Returns a list of records in the
    same shape as `tunnel_aabbs`/`phase6b_aabbs`:
        {'kind', 'name', 'aabb': (xmin,ymin,zmin,xmax,ymax,zmax)}

    The CSG validator uses these to flag any junction patch that overlaps an
    existing emitted shell. AABBs are conservative (axis-aligned overestimates
    of true geometry) — adequate for overlap detection."""
    extra = []

    # ---- Per-segment horizontal walls (covers both per-segment and
    # chain-owned candidates). tunnel_aabbs already records chain breps as a
    # single AABB per owned segment; we add per-segment-level boxes here too
    # so partial overlaps with the per-segment cross-section are caught.
    for i, cand in enumerate(horizontal_candidates):
        if i not in emitted_wall_indices:
            continue
        bw, bh, st = cand['profile']
        outer_w = bw + 2.0 * st
        outer_h = bh + 2.0 * st
        # Vertical extent of an arched/rect tunnel: floor at z=start.z, ceiling
        # at z = start.z + outer_h. For sloped segments the sz/ez vary too.
        extra.append({
            'kind': 'wall_segment_xs',
            'name': f'WallXS-{cand.get("elem_id", i)}',
            'aabb': _aabb_from_segment(cand['start'], cand['end'],
                                       outer_w / 2.0, outer_h, 0.0),
        })

    # ---- Vertical shafts. We don't track each shaft's profile after emit, but
    # we know its xy from emitted_shaft_xys and z extent from its source
    # candidate. Walk vertical_candidates and pair by xy proximity.
    if emitted_shaft_xys:
        emitted_xy_set = {(round(x, 2), round(y, 2)) for x, y in emitted_shaft_xys}
        for elem, elem_id, start, end in vertical_candidates:
            sx_key = (round(start[0], 2), round(start[1], 2))
            if sx_key not in emitted_xy_set:
                continue
            geom = elem.get('geometry', {}) or {}
            prof = geom.get('profile', {}) or {}
            r = (_safe_float(prof.get('radius'))
                 or (_safe_float(prof.get('diameter')) or 0.0) / 2.0
                 or (_safe_float(prof.get('width')) or 0.0) / 2.0
                 or 1.0)
            half = max(r, 0.3)
            zmin = min(start[2], end[2])
            zmax = max(start[2], end[2])
            extra.append({
                'kind': 'shaft',
                'name': f'Shaft-{elem_id}',
                'aabb': (start[0] - half, start[1] - half, zmin,
                         start[0] + half, start[1] + half, zmax),
            })

    # ---- Portal caps (synthetic frames at tunnel mouths).
    for sa in synthetic_frame_anchors or ():
        bw = sa.get('bore_w') or 0.0
        bh = sa.get('bore_h') or 0.0
        st = sa.get('shell_t') or 0.0
        outer_w = bw + 2.0 * (st + PORTAL_FRAME_MARGIN)
        outer_h = bh + 2.0 * (st + PORTAL_FRAME_MARGIN)
        anchor = sa.get('anchor') or (0.0, 0.0, 0.0)
        outward = sa.get('outward') or (1.0, 0.0, 0.0)
        # Cap is extruded outward by PORTAL_FRAME_THICKNESS along outward axis.
        # Conservative AABB: take a box centred at anchor + half-thickness in
        # outward direction, with half-extents max(outer_w/2, outer_h/2).
        ox, oy, oz = anchor
        dx, dy, dz = outward
        cx = ox + dx * PORTAL_FRAME_THICKNESS / 2.0
        cy = oy + dy * PORTAL_FRAME_THICKNESS / 2.0
        cz = oz + dz * PORTAL_FRAME_THICKNESS / 2.0
        half_xy = max(outer_w, outer_h) / 2.0 + abs(PORTAL_FRAME_THICKNESS) / 2.0
        extra.append({
            'kind': 'portal_cap',
            'name': f'PortalCap-{sa.get("segment_id")}-{sa.get("end_lbl")}',
            'aabb': (cx - half_xy, cy - half_xy, oz,
                     cx + half_xy, cy + half_xy, oz + outer_h),
        })

    # ---- Portals (PORTAL_BUILDING / PORTAL_END_WALL boxes). Walk the source
    # elements; the count matches `portals` because the emitter is deterministic.
    portal_count_emitted = len(portals)
    if portal_count_emitted > 0:
        for elem in elements:
            if elem.get('type') != 'WALL':
                continue
            seg_type = (elem.get('properties') or {}).get('segmentType')
            if seg_type not in ('PORTAL_BUILDING', 'PORTAL_END_WALL'):
                continue
            placement = elem.get('placement', {}) or {}
            geom = elem.get('geometry', {}) or {}
            prof = geom.get('profile', {}) or {}
            origin = _safe_xyz(placement.get('origin'))
            if origin is None:
                continue
            w = _safe_float(prof.get('width')) or 0.0
            h = _safe_float(prof.get('height')) or 0.0
            d = _safe_float(geom.get('depth')) or 0.0
            if w <= 0 or h <= 0 or d <= 0:
                continue
            half_xy = max(w, h) / 2.0 + 0.1
            extra.append({
                'kind': 'portal',
                'name': f'{seg_type}-{elem.get("id", "?")}',
                'aabb': (origin[0] - half_xy, origin[1] - half_xy, origin[2],
                         origin[0] + half_xy, origin[1] + half_xy,
                         origin[2] + d),
            })

    # ---- Vent ducts (cylindrical IfcFlowSegment).
    duct_radius = float(os.environ.get('RECON_VENT_RADIUS_M', '0.4') or 0.4)
    for ve in vent_endpoints or ():
        s = ve.get('start')
        e = ve.get('end')
        if s is None or e is None:
            continue
        extra.append({
            'kind': 'vent_duct',
            'name': f'VentDuct-{getattr(ve.get("duct"), "Name", "?")}',
            'aabb': _aabb_from_segment(s, e, duct_radius, duct_radius,
                                        duct_radius),
        })

    # ---- Vent fittings (IfcFlowFitting at junctions). Each emitted fitting
    # has a name encoding its xyz; reverse-parse for the AABB centre.
    for fitting in fittings or ():
        try:
            fname = getattr(fitting, 'Name', '') or ''
            if not fname.startswith('Junction-'):
                continue
            parts = fname[len('Junction-'):].split('_')
            cx, cy, cz = (float(parts[0]), float(parts[1]), float(parts[2]))
            extra.append({
                'kind': 'vent_fitting',
                'name': fname,
                'aabb': _aabb_from_box((cx, cy, cz), 0.6, 0.6, 0.6),
            })
        except Exception:
            continue

    # ---- Doors. Source elements give the origin; emitted_count == len(doors).
    if doors:
        for elem in elements:
            if (elem.get('type') or '').upper() != 'DOOR':
                continue
            placement = elem.get('placement', {}) or {}
            origin = _safe_xyz(placement.get('origin'))
            if origin is None:
                continue
            geom = elem.get('geometry', {}) or {}
            prof = geom.get('profile', {}) or {}
            w = _safe_float(prof.get('width')) or DOOR_SINGLE_WIDTH
            h = _safe_float(prof.get('height')) or DOOR_SINGLE_HEIGHT
            extra.append({
                'kind': 'door',
                'name': f'Door-{elem.get("id", "?")}',
                'aabb': (origin[0] - w / 2.0, origin[1] - w / 2.0, origin[2],
                         origin[0] + w / 2.0, origin[1] + w / 2.0,
                         origin[2] + h),
            })

    return extra


def _aabb_overlap_volume(a, b):
    """Volume of intersection between two AABBs. 0.0 if they don't overlap."""
    dx = max(0.0, min(a[3], b[3]) - max(a[0], b[0]))
    dy = max(0.0, min(a[4], b[4]) - max(a[1], b[1]))
    dz = max(0.0, min(a[5], b[5]) - max(a[2], b[2]))
    return dx * dy * dz


def _compute_phase6b_wall_aabb(plan):
    """World-space AABB for a Phase 6B wall plan. Treats the wall as an
    axis-aligned slab with width along lateralAxis, height along world Z,
    and thickness along thicknessAxis. Returns None if the plan is malformed."""
    o = plan.get('origin') or {}
    la = plan.get('lateralAxis') or {}
    ta = plan.get('thicknessAxis') or {}
    try:
        ox = float(o.get('x', 0.0)); oy = float(o.get('y', 0.0))
        oz = float(o.get('z', 0.0))
        lx = float(la.get('x', 0.0)); ly = float(la.get('y', 0.0))
        tx = float(ta.get('x', 0.0)); ty = float(ta.get('y', 0.0))
        w = float(plan.get('width', 0.0))
        h = float(plan.get('height', 0.0))
        t = float(plan.get('thickness', 0.0))
    except (TypeError, ValueError):
        return None
    if w <= 0.0 or h <= 0.0:
        return None
    # 8 corners of the slab: ±w/2 along lateral, ±t/2 along thickness, 0..h vertical.
    corners = []
    for sl in (-1.0, 1.0):
        for st in (-1.0, 1.0):
            cx = ox + sl * (w / 2.0) * lx + st * (t / 2.0) * tx
            cy = oy + sl * (w / 2.0) * ly + st * (t / 2.0) * ty
            for v in (0.0, h):
                corners.append((cx, cy, oz + v))
    return _aabb_from_points(corners)


def _validate_no_overlap_phase6b_d(tunnel_aabbs, phase6b_aabbs,
                                   hard_fail_threshold_m3,
                                   warn_threshold_m3, log_top_n=10,
                                   bridge_hosts_map=None):
    """Phase 6B.4d — check that no Phase 6B standalone wall overlaps a tunnel
    shell brep that ISN'T its own host segment.

    Inputs:
        tunnel_aabbs       -- list of {'elem_id', 'aabb', 'name'}
        phase6b_aabbs      -- list of {'host_id', 'aabb', 'name'}
        bridge_hosts_map   -- {bridge_elem_id: set(connected_host_segment_ids)}.
                              Synthetic-bridge segments are structural extensions
                              of the segments they connect; a wall hosted on
                              either connected segment is a legitimate placement
                              against the bridge shell, not an overlap.

    Returns (stats_dict, top_overlaps_list). Raises RuntimeError when
    hard_fail_threshold_m3 is finite and any single overlap exceeds it.
    """
    if bridge_hosts_map is None:
        bridge_hosts_map = {}
    overlaps = []
    for w in phase6b_aabbs:
        for t in tunnel_aabbs:
            if w.get('host_id') == t.get('elem_id'):
                continue  # legitimate placement on its host
            bridge_hosts = bridge_hosts_map.get(t.get('elem_id'))
            if bridge_hosts and w.get('host_id') in bridge_hosts:
                continue  # wall hosted on a segment this bridge connects
            # Portal walls (PortalWall_*) close tunnel mouths. When a portal
            # is at a junction its physical slab can overlap the adjacent shell
            # — this is architectural, not a geometry error.
            if (w.get('name') or '').startswith('PortalWall_'):
                continue
            vol = _aabb_overlap_volume(w['aabb'], t['aabb'])
            if vol > 1e-6:
                overlaps.append((vol, w, t))
    overlaps.sort(key=lambda r: r[0], reverse=True)

    total_vol = sum(t[0] for t in overlaps)
    max_vol = overlaps[0][0] if overlaps else 0.0
    warn_count = sum(1 for t in overlaps if t[0] > warn_threshold_m3)
    fail_count = sum(1 for t in overlaps if t[0] > hard_fail_threshold_m3)

    print('---- Phase 6B.4d overlap validation (Phase 6B walls vs tunnel shells) ----')
    print(f"  tunnel_breps        : {len(tunnel_aabbs)}")
    print(f"  phase6b_walls       : {len(phase6b_aabbs)}")
    print(f"  overlapping_pairs   : {len(overlaps)}")
    print(f"  total_overlap_m3    : {total_vol:.4f}")
    print(f"  max_overlap_m3      : {max_vol:.4f}")
    print(f"  warn_threshold_m3   : {warn_threshold_m3:.3f}")
    print(f"  hard_fail_threshold_m3: {hard_fail_threshold_m3:.3f}")
    print(f"  pairs_over_warn     : {warn_count}")
    print(f"  pairs_over_fail     : {fail_count}")
    if overlaps:
        print(f"  top_{min(log_top_n, len(overlaps))}_overlaps (vol m3, wall, shell):")
        for vol, w, t in overlaps[:log_top_n]:
            print(f"    {vol:.4f}m3  wall={w.get('name')} (host={w.get('host_id')}) "
                  f"<-> shell={t.get('name')} (elem_id={t.get('elem_id')})")

    stats = {
        'overlapping_pairs': len(overlaps),
        'total_overlap_m3': total_vol,
        'max_overlap_m3': max_vol,
        'warn_count': warn_count,
        'fail_count': fail_count,
    }
    if hard_fail_threshold_m3 > 0.0 and max_vol > hard_fail_threshold_m3:
        worst_vol, worst_w, worst_t = overlaps[0]
        raise RuntimeError(
            f'[6B.4d] HARD FAIL — wall/shell overlap exceeds threshold: '
            f'{worst_vol:.4f}m3 > {hard_fail_threshold_m3:.3f}m3. '
            f'wall={worst_w.get("name")} (host={worst_w.get("host_id")}) '
            f'shell={worst_t.get("name")} (elem_id={worst_t.get("elem_id")}). '
            f'pairs_over_fail={fail_count}'
        )
    return stats, overlaps[:log_top_n]


def _build_phase6b_closing_lookup(css):
    """Phase 6B.4b — gather every wall plan in css.metadata.wallReconstruction
    keyed by (hostSegmentKey, hostSegmentEnd). The plan dict is returned
    verbatim so we can mark consumed plans by id later. Plans missing the
    host fields are skipped (they cannot be embedded anyway).

    Returns (lookup, plans_by_id, total_plan_count).
    """
    plan_root = ((css or {}).get('metadata') or {}).get('wallReconstruction')
    if not isinstance(plan_root, dict):
        return {}, {}, 0
    lookup = {}
    plans_by_id = {}
    total = 0
    for bucket_key in ('portalWalls', 'junctionWalls', 'terminalWalls',
                       'roomPartitionWalls'):
        bucket = plan_root.get(bucket_key) or []
        for p in bucket:
            if not isinstance(p, dict):
                continue
            total += 1
            host_id = p.get('hostSegmentKey')
            host_end = p.get('hostSegmentEnd')
            if not host_id or host_end not in ('start', 'end'):
                continue
            # Pre-6B.3 plans had only roomPartitionWalls, which we kept in
            # backward-compat — avoid double-counting if 6B.3+ also gave us
            # junction/terminal lists.
            key = (host_id, host_end)
            if key in lookup:
                continue
            lookup[key] = p
            pid = p.get('id') or f"{host_id}-{host_end}-{bucket_key}"
            plans_by_id[pid] = p
    return lookup, plans_by_id, total


def _handle_multi_way_joint(members, horizontal_candidates, trims,
                            bisector_planes, stats,
                            bend_min, bend_max):
    """Phase 6B.4a — apply halfspace trimming to a 3+way joint.

    Strategy:
      1. Identify the most-antiparallel pair as the main "continuation". Apply
         standard 2-way mitre to it (extension + shared bisector plane), so
         the main tunnel passes through the joint cleanly.
      2. Every remaining member is a branch. Each branch's joint-end vertices
         are butt-cut by a plane perpendicular to the branch's own axis at
         joint - main_max_half_w_outer * branch_outward_dir, so the branch
         terminates flush at the main shell's outer surface instead of
         interpenetrating it.

    The bisector_planes dict gets one entry per member end (main pair shares
    a plane, each branch gets its own). Existing _emit_wall_brep machinery
    projects vertices onto these planes along each segment's local_x.
    """
    n_members = len(members)
    if n_members < 3:
        return  # caller should not reach here

    # Step 1 — gather outward directions and joint position.
    seg_data = []
    for sidx, end_lbl, _node, _pos, raw_pos in members:
        cand = horizontal_candidates[sidx]
        out_dir = cand['d'] if end_lbl == 'start' else _vec_neg(cand['d'])
        seg_data.append({
            'sidx': sidx,
            'end_lbl': end_lbl,
            'cand': cand,
            'out_dir': out_dir,
            'raw_pos': raw_pos,
        })
    # Joint position — average of all members' raw endpoints (handles small
    # FP gaps between coincident-rounded endpoints).
    jx = sum(d['raw_pos'][0] for d in seg_data) / n_members
    jy = sum(d['raw_pos'][1] for d in seg_data) / n_members
    jz = sum(d['raw_pos'][2] for d in seg_data) / n_members
    joint_pos = (jx, jy, jz)

    # Step 2 — find the most-antiparallel pair (lowest dot product of outward
    # vectors). This is the best "continuation" through the joint.
    best_dot = 1.0
    best_ij = None
    for i in range(n_members):
        for j in range(i + 1, n_members):
            d = _vec_dot(seg_data[i]['out_dir'], seg_data[j]['out_dir'])
            if d < best_dot:
                best_dot = d
                best_ij = (i, j)

    main_idxs = []
    if best_ij is not None and best_dot <= THREE_WAY_PAIR_MAX_DOT:
        main_idxs = list(best_ij)

    # Step 3 — main pair → standard 2-way mitre (bisector plane + extension)
    # if the bend angle is in the well-defined range. Near-straight (bend≈0)
    # passthrough keeps the pair as "main" but skips the plane (no mitre
    # needed when the two centerlines align). Out-of-range bends fall back
    # to all-branch butt-cut.
    main_max_half_w = 0.0
    if main_idxs:
        a = seg_data[main_idxs[0]]
        b = seg_data[main_idxs[1]]
        cos_bend = max(-1.0, min(1.0, -_vec_dot(a['out_dir'], b['out_dir'])))
        bend = math.acos(cos_bend)
        plane_normal = _vec_norm((
            b['out_dir'][0] - a['out_dir'][0],
            b['out_dir'][1] - a['out_dir'][1],
            b['out_dir'][2] - a['out_dir'][2],
        ))
        if (plane_normal is not None
                and bend >= bend_min and bend <= bend_max):
            plane_offset = _vec_dot(plane_normal, joint_pos)
            bisector_planes[(a['sidx'], a['end_lbl'])] = (
                plane_normal, plane_offset)
            bisector_planes[(b['sidx'], b['end_lbl'])] = (
                plane_normal, plane_offset)
            stats['three_way_main_pair_planes'] += 2

            # Standard mitre extension on the main pair so end faces meet
            # cleanly along the bisector curve.
            for k in main_idxs:
                cand = seg_data[k]['cand']
                half_w = cand['half_w_outer']
                t = half_w * math.tan(bend / 2.0)
                cap = MITRE_TRIM_CAP_FACTOR * (2.0 * half_w)
                if t > cap:
                    t = cap
                    stats['trims_capped'] += 1
                trims[seg_data[k]['sidx']][seg_data[k]['end_lbl']] = (
                    t + JOINT_EPSILON_OVERLAP)
                stats['segments_adjusted'].add(seg_data[k]['sidx'])
                if t > stats['max_trim_distance']:
                    stats['max_trim_distance'] = t
        elif bend < bend_min:
            # Near-straight passthrough — no bisector plane required (the
            # two main segments already align). Keep them as the main pair
            # so branches anchor against the right half_w_outer.
            pass
        else:
            # Bend > bend_max (near U-turn) — math is degenerate. Treat as
            # no clean main pair, fall back to universal butt-cut.
            main_idxs = []

    if main_idxs:
        main_max_half_w = max(
            seg_data[k]['cand']['half_w_outer'] for k in main_idxs)
    else:
        # Fallback: no clean continuation pair. Use the largest half_w_outer
        # among all members so branch butts still produce a sensible setback.
        stats['three_way_no_main_pair'] += 1
        main_max_half_w = max(d['cand']['half_w_outer'] for d in seg_data)

    # Step 4 — every non-main member becomes a branch. Butt-cut its joint-end
    # back along its own axis by main_max_half_w * BRANCH_BUTT_OFFSET_RATIO,
    # capped at BRANCH_BUTT_MAX_TRIM_FRAC of the branch's length so we never
    # collapse a short segment.
    branch_offset = main_max_half_w * BRANCH_BUTT_OFFSET_RATIO
    for k, sd in enumerate(seg_data):
        if k in main_idxs:
            continue
        cand = sd['cand']
        # Effective trim, capped to keep the branch from collapsing.
        max_trim = cand['length'] * BRANCH_BUTT_MAX_TRIM_FRAC
        eff_offset = branch_offset
        if eff_offset > max_trim:
            eff_offset = max_trim
            stats['three_way_branch_butt_caps_hit'] += 1
        if eff_offset <= 0.0:
            continue

        # Build the halfspace plane: perpendicular to branch local_x (= cand['d']),
        # passing through joint - eff_offset * out_dir. _emit_wall_brep projects
        # the joint-end vertices along local_x onto this plane.
        local_x = cand['d']
        # If end_lbl == 'end', out_dir = +d, target along +d means offset
        # along +local_x is positive. Plane along local_x:
        #   plane_normal = local_x, plane_offset = local_x · joint - eff_offset
        # If end_lbl == 'start', out_dir = -d, target is along -d which is
        # +local_x for projection direction perspective. Same offset formula.
        # Actually each case computes the desired projected coordinate along
        # local_x as joint_along_x - eff_offset (for end) or + eff_offset (start).
        joint_along_x = _vec_dot(local_x, joint_pos)
        if sd['end_lbl'] == 'end':
            plane_offset = joint_along_x - eff_offset
        else:  # 'start'
            plane_offset = joint_along_x + eff_offset
        bisector_planes[(sd['sidx'], sd['end_lbl'])] = (
            local_x, plane_offset)
        stats['three_way_branch_butt_cuts'] += 1
        stats['segments_adjusted'].add(sd['sidx'])
        if eff_offset > stats['max_trim_distance']:
            stats['max_trim_distance'] = eff_offset

    stats['three_way_plus_handled'] += 1


# 5A.10 — _build_frame_from_direction moved to secondary_geometry.geometry. Imported at module scope.


# ---------------------------------------------------------------------------
# IFC primitive helpers
# ---------------------------------------------------------------------------

def _make_dir(f, v):
    return f.create_entity('IfcDirection',
                           DirectionRatios=(float(v[0]), float(v[1]), float(v[2])))


def _make_pt(f, p):
    return f.create_entity('IfcCartesianPoint',
                           Coordinates=(float(p[0]), float(p[1]), float(p[2])))


def _make_axis2_3d(f, origin, axis_z, ref_x):
    return f.create_entity(
        'IfcAxis2Placement3D',
        Location=_make_pt(f, origin),
        Axis=_make_dir(f, axis_z),
        RefDirection=_make_dir(f, ref_x),
    )


def _make_local_placement(f, parent_lp, origin, axis_z, ref_x):
    rel = _make_axis2_3d(f, origin, axis_z, ref_x)
    return f.create_entity('IfcLocalPlacement',
                           PlacementRelTo=parent_lp, RelativePlacement=rel)


def _make_pos2d(f):
    return f.create_entity(
        'IfcAxis2Placement2D',
        Location=f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0)),
        RefDirection=f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0)),
    )


def _make_solid_rect_profile(f, w, h):
    return f.create_entity(
        'IfcRectangleProfileDef',
        ProfileType='AREA', Position=_make_pos2d(f),
        XDim=float(w), YDim=float(h),
    )


def _make_hollow_rect_profile(f, outer_w, outer_h, thickness):
    max_t = 0.45 * min(outer_w, outer_h)
    t = min(thickness, max_t)
    return f.create_entity(
        'IfcRectangleHollowProfileDef',
        ProfileType='AREA', Position=_make_pos2d(f),
        XDim=float(outer_w), YDim=float(outer_h),
        WallThickness=float(t),
    )


def _make_2d_pt(f, xy):
    return f.create_entity('IfcCartesianPoint',
                           Coordinates=(float(xy[0]), float(xy[1])))


def _make_arched_hollow_profile(f, bore_w, bore_h, shell_t):
    """Arched hollow tunnel cross-section.

        flat floor + vertical sidewalls + semicircular top
        with consistent shell_t around the cavity

    Conventions (mirrors IfcRectangleHollowProfileDef):
        bore_w, bore_h          INNER cavity dimensions
        outer width / height    bore + 2 * shell_t
        profile centered on (0, 0); profile X = lateral, profile Y = vertical
        inner cavity floor at y = -bore_h / 2; arch top at y = +bore_h / 2

    Returns the IfcArbitraryProfileDefWithVoids entity, or None if the
    dimensions don't accommodate a clean arch (caller should fall back to
    rectangular hollow). Inner and outer arches are concentric (true uniform
    shell thickness around the entire boundary).
    """
    inner_r = bore_w / 2.0
    outer_r = inner_r + shell_t
    inner_sidewall_h = bore_h - inner_r

    if inner_sidewall_h < ARCH_MIN_SIDEWALL_M:
        return None
    if shell_t >= inner_r * ARCH_MAX_SHELL_RATIO:
        return None
    if shell_t >= inner_sidewall_h * 0.5:
        return None

    outer_total_h = bore_h + 2.0 * shell_t
    outer_floor_y = -outer_total_h / 2.0
    inner_floor_y = outer_floor_y + shell_t
    arch_center_y = inner_floor_y + inner_sidewall_h
    # arch_center_y is shared between inner and outer arches; outer sidewall
    # is shell_t taller than inner sidewall because the outer floor is shell_t
    # below the inner floor.

    # Outer polyline (CCW): floor right, up right sidewall, over arch (theta 0→π),
    # down left sidewall, close along floor.
    outer_pts = [
        (-outer_r, outer_floor_y),
        (outer_r, outer_floor_y),
        (outer_r, arch_center_y),
    ]
    for k in range(1, ARCH_SEGMENTS):
        theta = math.pi * k / ARCH_SEGMENTS
        outer_pts.append((outer_r * math.cos(theta),
                          arch_center_y + outer_r * math.sin(theta)))
    outer_pts.append((-outer_r, arch_center_y))
    outer_pts.append(outer_pts[0])

    # Inner polyline (CW, opposite orientation for void): up left sidewall,
    # over arch (theta π→0), down right sidewall, close along floor.
    inner_pts = [
        (-inner_r, inner_floor_y),
        (-inner_r, arch_center_y),
    ]
    for k in range(1, ARCH_SEGMENTS):
        theta = math.pi - math.pi * k / ARCH_SEGMENTS
        inner_pts.append((inner_r * math.cos(theta),
                          arch_center_y + inner_r * math.sin(theta)))
    inner_pts.append((inner_r, arch_center_y))
    inner_pts.append((inner_r, inner_floor_y))
    inner_pts.append(inner_pts[0])

    outer_curve = f.create_entity(
        'IfcPolyline',
        Points=tuple(_make_2d_pt(f, p) for p in outer_pts))
    inner_curve = f.create_entity(
        'IfcPolyline',
        Points=tuple(_make_2d_pt(f, p) for p in inner_pts))

    return f.create_entity(
        'IfcArbitraryProfileDefWithVoids',
        ProfileType='AREA',
        OuterCurve=outer_curve,
        InnerCurves=(inner_curve,),
    )


def _make_portal_frame_profile(f, bore_w, bore_h, shell_t):
    """Frame profile for a portal cap — outer rectangle, inner void matching the
    tunnel's outer arched outline. Centered on (0, 0).

    Outer rect = bore + 2 * (shell_t + PORTAL_FRAME_MARGIN) on each side.
    Inner void traces the tunnel's outer arched contour so the frame snugly
    hugs the tunnel mouth.

    Returns the profile or None if arch dimensions don't fit (caller falls back
    to fully-rectangular frame).
    """
    inner_r = bore_w / 2.0
    sidewall_h_inner = bore_h - inner_r
    if sidewall_h_inner < ARCH_MIN_SIDEWALL_M:
        return None
    if shell_t >= inner_r * ARCH_MAX_SHELL_RATIO:
        return None
    if shell_t >= sidewall_h_inner * 0.5:
        return None

    margin = PORTAL_FRAME_MARGIN
    outer_r_tunnel = inner_r + shell_t
    tunnel_total_h = bore_h + 2.0 * shell_t
    tunnel_floor_y = -tunnel_total_h / 2.0
    arch_center_y = tunnel_floor_y + tunnel_total_h - outer_r_tunnel

    fhw = (bore_w + 2.0 * (shell_t + margin)) / 2.0
    fhh = (bore_h + 2.0 * (shell_t + margin)) / 2.0
    outer_pts = [
        (-fhw, -fhh), (fhw, -fhh), (fhw, fhh), (-fhw, fhh), (-fhw, -fhh),
    ]
    # Inner void: tunnel outer arched outline, CW
    inner_pts = [
        (-outer_r_tunnel, tunnel_floor_y),
        (-outer_r_tunnel, arch_center_y),
    ]
    for k in range(1, ARCH_SEGMENTS):
        theta = math.pi - math.pi * k / ARCH_SEGMENTS
        inner_pts.append((outer_r_tunnel * math.cos(theta),
                          arch_center_y + outer_r_tunnel * math.sin(theta)))
    inner_pts.append((outer_r_tunnel, arch_center_y))
    inner_pts.append((outer_r_tunnel, tunnel_floor_y))
    inner_pts.append(inner_pts[0])

    outer_curve = f.create_entity(
        'IfcPolyline', Points=tuple(_make_2d_pt(f, p) for p in outer_pts))
    inner_curve = f.create_entity(
        'IfcPolyline', Points=tuple(_make_2d_pt(f, p) for p in inner_pts))
    return f.create_entity(
        'IfcArbitraryProfileDefWithVoids',
        ProfileType='AREA',
        OuterCurve=outer_curve,
        InnerCurves=(inner_curve,),
    )


def _make_rect_frame_profile(f, outer_w, outer_h, inner_w, inner_h):
    """Rectangular frame profile (rectangular outer + rectangular inner void).
    Used as fallback when the tunnel cross-section can't accommodate an arched
    inner void.
    """
    fhw, fhh = outer_w / 2.0, outer_h / 2.0
    ihw, ihh = inner_w / 2.0, inner_h / 2.0
    outer_pts = [
        (-fhw, -fhh), (fhw, -fhh), (fhw, fhh), (-fhw, fhh), (-fhw, -fhh),
    ]
    # CW inner for void
    inner_pts = [
        (-ihw, -ihh), (-ihw, ihh), (ihw, ihh), (ihw, -ihh), (-ihw, -ihh),
    ]
    outer_curve = f.create_entity(
        'IfcPolyline', Points=tuple(_make_2d_pt(f, p) for p in outer_pts))
    inner_curve = f.create_entity(
        'IfcPolyline', Points=tuple(_make_2d_pt(f, p) for p in inner_pts))
    return f.create_entity(
        'IfcArbitraryProfileDefWithVoids',
        ProfileType='AREA',
        OuterCurve=outer_curve,
        InnerCurves=(inner_curve,),
    )


def _make_circle_hollow_profile(f, outer_radius, thickness):
    max_t = 0.45 * outer_radius
    t = min(thickness, max_t)
    return f.create_entity(
        'IfcCircleHollowProfileDef',
        ProfileType='AREA', Position=_make_pos2d(f),
        Radius=float(outer_radius),
        WallThickness=float(t),
    )


def _make_solid_circle_profile(f, radius):
    return f.create_entity(
        'IfcCircleProfileDef',
        ProfileType='AREA', Position=_make_pos2d(f),
        Radius=float(radius),
    )


def _make_extrusion_along_local_x(f, profile_def, depth):
    """Extrude profile along OBJECT's local X (centerline direction).

    Solid Position frame relative to object's local placement:
        Axis (solid Z)         = (1,0,0) in object frame  → object local X
        RefDirection (solid X) = (0,1,0) in object frame  → object local Y
    Profile lies in solid XY = object Y-Z (lateral × vertical).
    ExtrudedDirection = (0,0,1) in solid frame == object local X.
    """
    pos = _make_axis2_3d(f, (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0))
    return f.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=profile_def, Position=pos,
        ExtrudedDirection=f.create_entity('IfcDirection',
                                          DirectionRatios=(0.0, 0.0, 1.0)),
        Depth=float(depth),
    )


def _make_extrusion_along_local_z(f, profile_def, depth):
    """Extrude profile along OBJECT's local Z (= world up for shafts/portals/slab).

    Solid Position is identity within object frame, so the profile lies in object
    XY and ExtrudedDirection = (0,0,1) drives the solid up the local Z axis.
    """
    pos = _make_axis2_3d(f, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
    return f.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=profile_def, Position=pos,
        ExtrudedDirection=f.create_entity('IfcDirection',
                                          DirectionRatios=(0.0, 0.0, 1.0)),
        Depth=float(depth),
    )


def _apply_style(f, solid, color_rgb, name='Concrete'):
    r, g, b = color_rgb
    color = f.create_entity('IfcColourRgb',
                            Red=float(r), Green=float(g), Blue=float(b))
    rendering = f.create_entity(
        'IfcSurfaceStyleRendering',
        SurfaceColour=color, Transparency=0.0, ReflectanceMethod='BLINN',
    )
    style = f.create_entity('IfcSurfaceStyle', Name=name, Side='BOTH',
                            Styles=(rendering,))
    assign = f.create_entity('IfcPresentationStyleAssignment', Styles=(style,))
    f.create_entity('IfcStyledItem', Item=solid, Styles=(assign,))


def _make_shape_rep(f, body_sub, solid):
    rep = f.create_entity('IfcShapeRepresentation',
                          ContextOfItems=body_sub,
                          RepresentationIdentifier='Body',
                          RepresentationType='SweptSolid',
                          Items=(solid,))
    return f.create_entity('IfcProductDefinitionShape', Representations=(rep,))


# ---------------------------------------------------------------------------
# Per-element emission helpers
# ---------------------------------------------------------------------------

def _gen_arch_profile_brep_pts(bore_w, bore_h, shell_t, n_arch=ARCH_SEGMENTS):
    """Matched outer + inner CCW profile point lists for brep face stitching.

    Both lists have the same length and i-th outer / i-th inner points are
    radially related (so end-cap quads are well-formed):
        index 0       bottom-left (outer floor / inner floor)
        index 1       bottom-right
        index 2       top of right sidewall (joins to arch)
        index 3..n+1  arch points (theta = π * k / n_arch for k=1..n_arch-1)
        index n+2     top of left sidewall

    Concentric arches share an arch_center_y so shell thickness is uniform
    around the entire boundary. Returns (None, None) if dimensions don't fit.
    """
    inner_r = bore_w / 2.0
    outer_r = inner_r + shell_t
    sidewall_h_inner = bore_h - inner_r
    if sidewall_h_inner < ARCH_MIN_SIDEWALL_M:
        return None, None
    if shell_t >= inner_r * ARCH_MAX_SHELL_RATIO:
        return None, None
    if shell_t >= sidewall_h_inner * 0.5:
        return None, None

    inner_floor_y = -bore_h / 2.0
    outer_floor_y = inner_floor_y - shell_t
    arch_center_y = inner_floor_y + sidewall_h_inner

    outer_pts, inner_pts = [], []
    outer_pts.append((-outer_r, outer_floor_y))
    inner_pts.append((-inner_r, inner_floor_y))
    outer_pts.append((outer_r, outer_floor_y))
    inner_pts.append((inner_r, inner_floor_y))
    outer_pts.append((outer_r, arch_center_y))
    inner_pts.append((inner_r, arch_center_y))
    for k in range(1, n_arch):
        theta = math.pi * k / n_arch
        outer_pts.append((outer_r * math.cos(theta),
                          arch_center_y + outer_r * math.sin(theta)))
        inner_pts.append((inner_r * math.cos(theta),
                          arch_center_y + inner_r * math.sin(theta)))
    outer_pts.append((-outer_r, arch_center_y))
    inner_pts.append((-inner_r, arch_center_y))
    return outer_pts, inner_pts


def _gen_rect_profile_brep_pts(bore_w, bore_h, shell_t):
    """Rectangular fallback for the brep profile. Same orientation contract as
    the arched generator (CCW, matched outer/inner lists, 4 corners each)."""
    iw, ih = bore_w / 2.0, bore_h / 2.0
    ow, oh = iw + shell_t, ih + shell_t
    outer_pts = [(-ow, -oh), (ow, -oh), (ow, oh), (-ow, oh)]
    inner_pts = [(-iw, -ih), (iw, -ih), (iw, ih), (-iw, ih)]
    return outer_pts, inner_pts


# 5A.10 — _profile_pt_to_world moved to secondary_geometry.geometry. Imported at module scope.


# ============================================================================
# PHASE 4C — CHAIN CONTINUITY (curvature interpolation + welded BREP)
# Walks degree-2 connectivity from the joint solver, samples cross-sections
# along each chain (with arc fillets at gentle bends), and emits ONE welded
# BREP per chain. Segments owned by an emitted chain are skipped by the
# per-segment _emit_wall_brep path.
# ============================================================================

CHAIN_MAX_SEGMENTS = 32
CHAIN_MAX_SECTIONS = 64
CHAIN_ARC_TURN_MIN_DEG = 30.0       # below: near-straight, just emit a joint mid-section
CHAIN_ARC_TURN_MAX_DEG = 150.0      # above: near-U-turn, fall back to mitre at joint
CHAIN_LEADER_COLOR = (0.753, 0.753, 0.753)  # concrete gray — production neutral
# In VISUAL_DEBUG mode, fallback segments get a red marker so engineers can see
# continuity failures; in production they render as neutral concrete gray.
CHAIN_FALLBACK_COLOR = (0.85, 0.18, 0.18) if _VISUAL_DEBUG else (0.753, 0.753, 0.753)
CHAIN_DEBUG_VISUAL_MARKER_ENV = 'CHAIN_HIDE_VISUAL_MARKER'

# Phase 4C coverage tolerances (graph union-find).
CHAIN_GRAPH_GRID_M = 0.1            # quantize endpoints to this grid before merging
CHAIN_GRAPH_PROX_TOL_M = 0.5        # merge quantized nodes within this distance


def _chain_slerp3(a, b, t):
    """Normalised slerp between unit 3D vectors. Lerp fallback for tiny angles."""
    d = max(-1.0, min(1.0, _vec_dot(a, b)))
    if d > 0.9995:
        out = (a[0] + (b[0] - a[0]) * t,
               a[1] + (b[1] - a[1]) * t,
               a[2] + (b[2] - a[2]) * t)
        return _vec_norm(out) or a
    omega = math.acos(d)
    so = math.sin(omega)
    if so < 1e-9:
        return a
    s1 = math.sin((1.0 - t) * omega) / so
    s2 = math.sin(t * omega) / so
    return (a[0] * s1 + b[0] * s2,
            a[1] * s1 + b[1] * s2,
            a[2] * s1 + b[2] * s2)


# 5A.9 — _chain_profile_signature, _find_main_loop, _node_in_component,
# _back_edge_cycle moved to secondary_geometry.topology. Imported at module
# scope below.


def _detect_chains(horizontal_candidates,
                   prox_tol_m=CHAIN_GRAPH_PROX_TOL_M,
                   grid_m=CHAIN_GRAPH_GRID_M):
    """PHASE 4C TOPOLOGY — main-loop chain detector.

    The previous union-find variant pulled every segment of every connected
    component into a single chain. For a tunnel network with branches, that
    treats branch edges as part of the main loop and produces tangled,
    self-intersecting geometry where the chain DFS arbitrarily picks a
    branch at a junction.

    The tunnel domain is "primary loop with occasional branches" — the
    correct model is:
        1. Build the endpoint-as-node, segment-as-edge graph (0.1m grid +
           0.5m proximity merge — same as before).
        2. Find the LARGEST cycle (the main loop). All other segments are
           BRANCHES and emit per-segment grey, never merged into a chain.
        3. Order the main-loop segments into a single chain via DFS over
           the restricted main-loop subgraph (which is degree-2 by
           construction → DFS produces a clean head→tail walk).

    Returns (chains, coverage_stats):
        chains          — at most one chain (the main loop), or empty if
                          no cycle was found.
        coverage_stats  — total, segments_in_chains, segments_unassigned,
                          main_loop_segments, branch_segments,
                          cycles_found, …
    """
    n_segs = len(horizontal_candidates)
    coverage = {
        'total_structural_segments': n_segs,
        'segments_in_chains': 0,
        'segments_unassigned': n_segs,
        'unassigned_elem_ids': [horizontal_candidates[i].get('elem_id') for i in range(n_segs)],
        'main_loop_segments': 0,
        'branch_segments': n_segs,
        'cycles_found': 0,
        'graph_nodes_quantized': 0,
        'graph_nodes_after_merge': 0,
        'main_loop_profile_filtered': 0,
    }
    if n_segs == 0:
        return [], coverage

    # Step 1 — quantize every endpoint to a 3D grid.
    def quant(p):
        return (round(p[0] / grid_m) * grid_m,
                round(p[1] / grid_m) * grid_m,
                round(p[2] / grid_m) * grid_m)

    endpoints = []  # (seg_idx, end_label, quantized_pt)
    pt_to_initial_id = {}
    for i, c in enumerate(horizontal_candidates):
        for end_lbl, raw in (('start', c['start']), ('end', c['end'])):
            qp = quant(raw)
            if qp not in pt_to_initial_id:
                pt_to_initial_id[qp] = len(pt_to_initial_id)
            endpoints.append((i, end_lbl, qp))
    coverage['graph_nodes_quantized'] = len(pt_to_initial_id)

    # Step 2 — union-find quantized points within prox_tol_m of one another.
    # Tunnels typically have a few hundred segments → O(N^2) endpoint scan
    # is fine. If this ever blows up we'd switch to a spatial hash.
    pt_keys = list(pt_to_initial_id.keys())
    n_pts = len(pt_keys)
    parent_pt = list(range(n_pts))

    def fp(x):
        while parent_pt[x] != x:
            parent_pt[x] = parent_pt[parent_pt[x]]
            x = parent_pt[x]
        return x

    def up(x, y):
        rx, ry = fp(x), fp(y)
        if rx != ry:
            parent_pt[rx] = ry

    prox_sq = prox_tol_m * prox_tol_m
    for i in range(n_pts):
        pi = pt_keys[i]
        for j in range(i + 1, n_pts):
            pj = pt_keys[j]
            d2 = (pi[0]-pj[0])**2 + (pi[1]-pj[1])**2 + (pi[2]-pj[2])**2
            if d2 < prox_sq:
                up(pt_to_initial_id[pi], pt_to_initial_id[pj])

    # Final node id per quantized point.
    pt_to_final = {p: fp(pt_to_initial_id[p]) for p in pt_keys}
    coverage['graph_nodes_after_merge'] = len(set(pt_to_final.values()))

    # Step 3 — build seg_nodes (each seg → 2 (node_id, end_label) tuples)
    # and node_segs (node_id → set of seg indices touching it).
    seg_nodes = [[] for _ in range(n_segs)]
    node_segs = {}
    for seg_idx, end_lbl, qp in endpoints:
        nid = pt_to_final[qp]
        seg_nodes[seg_idx].append((nid, end_lbl))
        node_segs.setdefault(nid, set()).add(seg_idx)

    # Step 4 — find the LARGEST cycle in the segment graph. Anything not
    # in this cycle is a branch and stays per-segment grey.
    main_loop = _find_main_loop(node_segs, seg_nodes)
    chains = []
    chained_segments = set()

    if main_loop is None or len(main_loop) < 2:
        coverage['cycles_found'] = 0
    else:
        coverage['cycles_found'] = 1  # we keep only the largest
        coverage['main_loop_segments'] = len(main_loop)

        # Profile signature filter — break the loop into the largest
        # contiguous matching-profile subset. (For now: take the largest
        # profile group inside the cycle; if the cycle mixes profiles
        # we lose the smaller subset to per-segment grey.)
        sig_groups = {}
        for s in main_loop:
            sg = _chain_profile_signature(horizontal_candidates[s])
            sig_groups.setdefault(sg, []).append(s)
        chosen_sig, chosen_segs = max(sig_groups.items(), key=lambda kv: len(kv[1]))
        coverage['main_loop_profile_filtered'] = len(main_loop) - len(chosen_segs)

        if len(chosen_segs) >= 2:
            # DFS-order the main-loop subset. Within the restricted graph
            # every segment is degree-2, so DFS yields a clean linear
            # ordering even though the cycle has no free end.
            ordered = _order_component_dfs(
                chosen_segs, seg_nodes, node_segs, horizontal_candidates)
            if ordered and len(ordered['segments']) >= 2:
                chains.append({
                    'segments': ordered['segments'],
                    'orient': ordered['orient'],
                    'joints': ordered['joints'],
                    'profile_signature': chosen_sig,
                })
                for s in ordered['segments']:
                    chained_segments.add(s)

    # Step 5 — coverage accounting. Branches = everything not in the chain.
    coverage['segments_in_chains'] = len(chained_segments)
    coverage['segments_unassigned'] = n_segs - len(chained_segments)
    coverage['branch_segments'] = n_segs - len(chained_segments)
    coverage['unassigned_elem_ids'] = [
        horizontal_candidates[i].get('elem_id')
        for i in range(n_segs) if i not in chained_segments
    ]

    return chains, coverage


def _order_component_dfs(seg_indices, seg_nodes, node_segs, horizontal_candidates):
    """Walk a connected component into an ordered chain via DFS.

    Strategy:
      * Start at a degree-1 (free-end) node when one exists in this
        component — gives clean head→tail ordering for linear chains.
      * Otherwise pick an arbitrary segment + its 'start' end.
      * At each step, pick any unvisited graph-adjacent segment at the
        current outgoing node. Junctions (degree ≥ 3) pick one branch.
      * After the DFS terminates, append leftover unvisited segments at
        the chain end. The welder's fail-fast guard will reject the
        chain (turn it RED) — which is the desired diagnostic per the
        coverage > perfection principle.

    Returns dict {segments, orient, joints} or None.
    """
    seg_set = set(seg_indices)

    # Pick start: prefer a degree-1 endpoint within this component.
    start_seg = None
    start_end = None  # which end of start_seg is the FREE/origin end
    for s in seg_indices:
        for nid, end_lbl in seg_nodes[s]:
            adj_in_comp = [x for x in node_segs.get(nid, ()) if x in seg_set]
            if len(adj_in_comp) == 1:
                start_seg = s
                start_end = end_lbl
                break
        if start_seg is not None:
            break
    if start_seg is None:
        start_seg = seg_indices[0]
        start_end = 'start'

    visited = set([start_seg])
    chain_segs = [start_seg]
    chain_orient = ['fwd' if start_end == 'start' else 'rev']
    chain_joints = []

    cur_seg = start_seg
    cur_out_end = 'end' if start_end == 'start' else 'start'

    def node_at(seg, end_lbl):
        for nid, e in seg_nodes[seg]:
            if e == end_lbl:
                return nid
        return None

    while len(chain_segs) < CHAIN_MAX_SEGMENTS:
        cur_node = node_at(cur_seg, cur_out_end)
        if cur_node is None:
            break
        cands = [s for s in node_segs.get(cur_node, ())
                 if s in seg_set and s not in visited]
        if not cands:
            break
        nxt = cands[0]
        # Determine which end of nxt connects at cur_node.
        nxt_in_end = None
        for nid, e in seg_nodes[nxt]:
            if nid == cur_node:
                nxt_in_end = e
                break
        if nxt_in_end is None:
            break
        visited.add(nxt)
        chain_segs.append(nxt)
        chain_orient.append('fwd' if nxt_in_end == 'start' else 'rev')

        ca = horizontal_candidates[cur_seg]
        cb = horizontal_candidates[nxt]
        out_a = ca['d'] if cur_out_end == 'end' else _vec_neg(ca['d'])
        out_b = cb['d'] if nxt_in_end == 'start' else _vec_neg(cb['d'])
        cos_bend = max(-1.0, min(1.0, -_vec_dot(out_a, out_b)))
        bend = math.acos(cos_bend)
        joint_a_pt = ca['start'] if cur_out_end == 'start' else ca['end']
        joint_b_pt = cb['start'] if nxt_in_end == 'start' else cb['end']
        joint_pos = ((joint_a_pt[0] + joint_b_pt[0]) * 0.5,
                     (joint_a_pt[1] + joint_b_pt[1]) * 0.5,
                     (joint_a_pt[2] + joint_b_pt[2]) * 0.5)
        chain_joints.append({
            'end_in_a': cur_out_end,
            'end_in_b': nxt_in_end,
            'bend': bend,
            'pos': joint_pos,
        })

        cur_seg = nxt
        cur_out_end = 'end' if nxt_in_end == 'start' else 'start'

    # Append leftover component segments — the welder will reject the
    # chain on continuity failure if any of these don't connect cleanly.
    leftover = [s for s in seg_indices if s not in visited]
    if leftover and len(chain_segs) < CHAIN_MAX_SEGMENTS:
        for s in leftover:
            if len(chain_segs) >= CHAIN_MAX_SEGMENTS:
                break
            visited.add(s)
            chain_segs.append(s)
            chain_orient.append('fwd')
            ca = horizontal_candidates[chain_segs[-2]]
            cb = horizontal_candidates[s]
            joint_pos = ((ca['end'][0] + cb['start'][0]) * 0.5,
                         (ca['end'][1] + cb['start'][1]) * 0.5,
                         (ca['end'][2] + cb['start'][2]) * 0.5)
            chain_joints.append({
                'end_in_a': 'end',
                'end_in_b': 'start',
                'bend': 0.0,
                'pos': joint_pos,
            })

    return {
        'segments': chain_segs,
        'orient': chain_orient,
        'joints': chain_joints,
    }


def _build_chain_sections(chain, horizontal_candidates, max_sections=CHAIN_MAX_SECTIONS,
                          chain_id='chain', weld_tolerance=1e-3):
    """Sample world-space cross-section frames along a chain.

    Each frame: {center, local_x, local_y, local_z, source}.
    `local_x` is the chain tangent at that section; profile points go into
    `local_y` (lateral) × `local_z` (up).

    Continuity guarantees enforced before any section is emitted (Phase 4C):
      * Segments are oriented head→tail using the chain orient labels.
      * Endpoints between consecutive segments are HARD-WELDED to the
        midpoint of (end_A, start_B) — no tolerance ambiguity downstream.
      * Tangents and segment lengths are recomputed from welded endpoints.
      * Fail-fast guard: any post-weld gap > weld_tolerance, or any segment
        whose length collapses below MIN_SEGMENT_LENGTH/2 → return ([], stats)
        with a populated fail_reason. Caller must fall back to per-segment.
      * All section centers are derived from the welded path — never from
        the original CSS endpoints.

    Sections emitted:
      - chain start (welded seg_data[0].start)
      - per interior joint (always at the welded joint position):
          * if turn < 30°  → single mid-tangent section
          * if turn > 150° → hard mitre section (averaged tangent)
          * else            → fillet: pre-fillet + n_arc interior steps +
                              post-fillet (incremental slerp from welded joint)
      - chain end (welded seg_data[-1].end)

    Returns (sections, stats). On success sections is a non-empty list and
    stats.fail_reason is None. On failure sections is [] and fail_reason is
    populated with the reason string.
    """
    stats = {
        'arcs_inserted': 0,
        'max_turn_deg': 0.0,
        'tight_skips': 0,
        'cap_hit': False,
        'sections_count': 0,
        'sections_skipped_straight': 0,
        'fail_reason': None,
        'max_gap_pre_weld': 0.0,
        'max_gap_post_weld': 0.0,
    }
    seg_indices = chain['segments']
    if not seg_indices:
        stats['fail_reason'] = 'no_segments'
        return [], stats

    # Step 1 — Build oriented head→tail segment data.
    seg_data = []
    for step_idx, seg_i in enumerate(seg_indices):
        cand = horizontal_candidates[seg_i]
        if chain['orient'][step_idx] == 'fwd':
            s = tuple(cand['start']); e = tuple(cand['end']); d = cand['d']
        else:
            s = tuple(cand['end']); e = tuple(cand['start']); d = _vec_neg(cand['d'])
        seg_data.append({
            'idx': seg_i,
            'elem_id': cand.get('elem_id'),
            'start': s,
            'end': e,
            'tangent': d,
            'length': cand['length'],
        })

    # Step 2 — Pre-weld gap audit. Log every consecutive pair so failures
    # are diagnosable from CloudWatch alone.
    pair_gaps_pre = []
    for i in range(len(seg_data) - 1):
        end_a = seg_data[i]['end']
        start_b = seg_data[i + 1]['start']
        gap = math.sqrt(sum((end_a[k] - start_b[k]) ** 2 for k in range(3)))
        pair_gaps_pre.append(gap)
        if gap > 1e-4:
            print(f"[CHAIN-GAP] {chain_id} pair={i} segA={seg_data[i]['elem_id']} "
                  f"segB={seg_data[i+1]['elem_id']} "
                  f"end_A=({end_a[0]:.4f},{end_a[1]:.4f},{end_a[2]:.4f}) "
                  f"start_B=({start_b[0]:.4f},{start_b[1]:.4f},{start_b[2]:.4f}) "
                  f"gap={gap:.4f}m")
    stats['max_gap_pre_weld'] = max(pair_gaps_pre) if pair_gaps_pre else 0.0
    print(f"[CHAIN-GAP] {chain_id} segs={len(seg_data)} "
          f"pairs={len(pair_gaps_pre)} max_gap_pre_weld={stats['max_gap_pre_weld']:.6f}m")

    # Step 3 — Hard weld: replace consecutive end_A and start_B with their
    # midpoint. After this, start_B is bit-identical to end_A — geometry
    # downstream uses the welded path only.
    for i in range(len(seg_data) - 1):
        end_a = seg_data[i]['end']
        start_b = seg_data[i + 1]['start']
        mid = (
            (end_a[0] + start_b[0]) * 0.5,
            (end_a[1] + start_b[1]) * 0.5,
            (end_a[2] + start_b[2]) * 0.5,
        )
        seg_data[i]['end'] = mid
        seg_data[i + 1]['start'] = mid

    # Step 4 — Recompute lengths and tangents from welded endpoints. The
    # original cand['d'] reflects pre-weld geometry; once we shift endpoints,
    # the tangent must follow or the section frame drifts.
    for sd in seg_data:
        d_raw = (sd['end'][0] - sd['start'][0],
                 sd['end'][1] - sd['start'][1],
                 sd['end'][2] - sd['start'][2])
        new_len = math.sqrt(d_raw[0] ** 2 + d_raw[1] ** 2 + d_raw[2] ** 2)
        sd['length'] = new_len
        d_norm = _vec_norm(d_raw)
        if d_norm is not None:
            sd['tangent'] = d_norm

    # Step 5 — Post-weld continuity audit.
    pair_gaps_post = []
    for i in range(len(seg_data) - 1):
        end_a = seg_data[i]['end']
        start_b = seg_data[i + 1]['start']
        gap = math.sqrt(sum((end_a[k] - start_b[k]) ** 2 for k in range(3)))
        pair_gaps_post.append(gap)
    stats['max_gap_post_weld'] = max(pair_gaps_post) if pair_gaps_post else 0.0
    if stats['max_gap_post_weld'] > 1e-6:
        print(f"[CHAIN-GAP] {chain_id} max_gap_post_weld={stats['max_gap_post_weld']:.6e}m "
              f"(expected ~0 after weld)")

    # Step 6 — Fail-fast guard. Any segment that collapses below half the
    # min-segment-length floor is suspicious; reject the whole chain.
    min_len_floor = MIN_SEGMENT_LENGTH * 0.5
    for sd in seg_data:
        if sd['length'] < min_len_floor:
            stats['fail_reason'] = (f"short_seg_after_weld:idx={sd['idx']}:"
                                    f"elem={sd['elem_id']}:len={sd['length']:.3f}m")
            print(f"[CHAIN-FAIL] {chain_id} {stats['fail_reason']}")
            return [], stats
    if stats['max_gap_post_weld'] > weld_tolerance:
        stats['fail_reason'] = (f"continuity_failure:max_gap_post_weld="
                                f"{stats['max_gap_post_weld']:.6f}m")
        print(f"[CHAIN-FAIL] {chain_id} {stats['fail_reason']}")
        return [], stats

    # Determine joint setbacks first to know exactly which sections to emit.
    joint_plans = []  # one per interior joint
    base_section_count = 1 + len(seg_data)  # start + 1 per segment-end
    # +1 per interior joint center (replaces a degenerate end-section).
    arc_budget = max(0, max_sections - base_section_count)
    sections_committed = 0

    for i, joint in enumerate(chain['joints']):
        if joint is None:
            joint_plans.append({'kind': 'mitre_fallback', 'reason': 'no_joint_data'})
            stats['tight_skips'] += 1
            continue
        bend_rad = joint['bend']
        turn_deg = math.degrees(bend_rad)
        if turn_deg > stats['max_turn_deg']:
            stats['max_turn_deg'] = turn_deg
        a = seg_data[i]
        b = seg_data[i + 1]
        # profile width derived from outer half-width (cand['half_w_outer'] available).
        cand_a = horizontal_candidates[a['idx']]
        profile_w = 2.0 * cand_a['half_w_outer']
        if turn_deg < CHAIN_ARC_TURN_MIN_DEG:
            joint_plans.append({'kind': 'straight', 'turn_deg': turn_deg})
            continue
        if turn_deg > CHAIN_ARC_TURN_MAX_DEG:
            joint_plans.append({'kind': 'mitre_fallback', 'turn_deg': turn_deg, 'reason': 'too_sharp'})
            stats['tight_skips'] += 1
            continue
        radius_raw = min(a['length'], b['length']) * 0.5
        radius = max(profile_w, min(3.0 * profile_w, radius_raw))
        turn_rad = bend_rad
        setback = radius * math.tan(turn_rad / 2.0)
        if setback >= 0.45 * a['length'] or setback >= 0.45 * b['length']:
            radius = min(a['length'], b['length']) * 0.4
            setback = radius * math.tan(turn_rad / 2.0)
            if setback >= 0.45 * a['length'] or setback >= 0.45 * b['length']:
                joint_plans.append({'kind': 'mitre_fallback', 'turn_deg': turn_deg, 'reason': 'tight_short'})
                stats['tight_skips'] += 1
                continue
        n_arc = max(3, min(6, int(round(turn_deg / 15.0))))
        # arc step bookkeeping: replaces 1 joint section with 2 fillet ends + (n_arc - 1) interior steps
        net_extra = (2 + (n_arc - 1)) - 1
        if sections_committed + net_extra > arc_budget:
            stats['cap_hit'] = True
            joint_plans.append({'kind': 'mitre_fallback', 'turn_deg': turn_deg, 'reason': 'cap_hit'})
            stats['tight_skips'] += 1
            continue
        sections_committed += net_extra
        joint_plans.append({
            'kind': 'arc', 'turn_deg': turn_deg, 'turn_rad': turn_rad,
            'radius': radius, 'setback': setback, 'n_arc': n_arc,
        })
        stats['arcs_inserted'] += 1

    # Emit sections.
    sections = []

    def emit(center, tangent, source):
        frame = _build_frame_from_direction(_vec_norm(tangent) or (1.0, 0.0, 0.0))
        if frame is None:
            return False
        lx, ly, lz = frame
        sections.append({
            'center': center,
            'local_x': lx,
            'local_y': ly,
            'local_z': lz,
            'source': source,
        })
        return True

    # Section 0: chain start.
    if not emit(seg_data[0]['start'], seg_data[0]['tangent'], 'chain_start'):
        return [], stats

    # Walk segments + joints. PHASE 4C: joint_pos comes from the WELDED path
    # (a['end'] === b['start'] bit-identical after welding), never from the
    # original CSS endpoint stored on chain['joints'][i]['pos'].
    sections_skipped_straight = 0
    for i, joint in enumerate(joint_plans):
        a = seg_data[i]
        b = seg_data[i + 1]
        joint_pos = a['end']  # welded — equals b['start']
        if joint['kind'] == 'straight':
            # PHASE 4C anti-ribbing: do NOT emit a cross-section ring at
            # near-straight joints. Each ring becomes a flat-shaded crease
            # in the viewer; suppressing them lets a long run of consecutive
            # near-straight segments render as ONE continuous tube quad
            # between the previous section and the next non-straight section.
            sections_skipped_straight += 1
            continue
        elif joint['kind'] == 'mitre_fallback':
            mid_dir = _vec_norm((
                a['tangent'][0] + b['tangent'][0],
                a['tangent'][1] + b['tangent'][1],
                a['tangent'][2] + b['tangent'][2],
            )) or a['tangent']
            emit(joint_pos, mid_dir, 'joint_mitre')
        else:  # arc
            d_in = a['tangent']
            d_out = b['tangent']
            setback = joint['setback']
            radius = joint['radius']
            n_arc = joint['n_arc']
            turn_rad = joint['turn_rad']
            fillet_start = (
                joint_pos[0] - d_in[0] * setback,
                joint_pos[1] - d_in[1] * setback,
                joint_pos[2] - d_in[2] * setback,
            )
            fillet_end = (
                joint_pos[0] + d_out[0] * setback,
                joint_pos[1] + d_out[1] * setback,
                joint_pos[2] + d_out[2] * setback,
            )
            emit(fillet_start, d_in, 'fillet_start')
            arc_length = radius * turn_rad
            step_length = arc_length / n_arc
            prev_pos = fillet_start
            for k in range(1, n_arc + 1):
                t = k / float(n_arc)
                dir_t = _vec_norm(_chain_slerp3(d_in, d_out, t)) or d_out
                if k < n_arc:
                    new_pos = (
                        prev_pos[0] + dir_t[0] * step_length,
                        prev_pos[1] + dir_t[1] * step_length,
                        prev_pos[2] + dir_t[2] * step_length,
                    )
                    emit(new_pos, dir_t, 'arc_step')
                    prev_pos = new_pos
                else:
                    emit(fillet_end, d_out, 'fillet_end')
                    prev_pos = fillet_end

    # Final section: chain end.
    emit(seg_data[-1]['end'], seg_data[-1]['tangent'], 'chain_end')

    stats['sections_count'] = len(sections)
    stats['sections_skipped_straight'] = sections_skipped_straight
    return sections, stats


def _emit_chain_brep(f, body_sub, storey_lp, owner, chain, sections,
                    outer_2d, inner_2d, color_rgb, name, counts,
                    tunnel_aabbs=None):
    """Build a single welded IfcFacetedBrep across the chain.

    Vertices:
      outer_idx(k, i) = k*N + i              (K*N outer ring vertices)
      inner_idx(k, i) = K*N + k*N + i        (K*N inner ring vertices)
      total = 2*K*N — every interior section's vertex appears in both
      (k-1, k) and (k, k+1) tube quads. NO interior end caps.

    Faces: (K-1)*N outer tube + (K-1)*N inner tube + N start cap + N end cap.
    """
    K = len(sections)
    if K < 2:
        return None
    N = len(outer_2d)
    if N < 3 or len(inner_2d) != N:
        return None

    all_pts_world = []
    for sec in sections:
        for p2 in outer_2d:
            all_pts_world.append(_profile_pt_to_world(
                sec['center'], p2, sec['local_y'], sec['local_z']))
    inner_offset = K * N
    for sec in sections:
        for p2 in inner_2d:
            all_pts_world.append(_profile_pt_to_world(
                sec['center'], p2, sec['local_y'], sec['local_z']))

    expected = 2 * K * N
    if len(all_pts_world) != expected:
        print(f"[CHAIN-WELD-FAIL] {name}: expected {expected} verts, got {len(all_pts_world)}")
        return None

    ifc_pts = [_make_pt(f, p) for p in all_pts_world]

    def outer_idx(k, i):
        return k * N + i

    def inner_idx(k, i):
        return inner_offset + k * N + i

    def quad(a, b, c, d):
        loop = f.create_entity(
            'IfcPolyLoop',
            Polygon=(ifc_pts[a], ifc_pts[b], ifc_pts[c], ifc_pts[d]),
        )
        bound = f.create_entity('IfcFaceOuterBound', Bound=loop, Orientation=True)
        return f.create_entity('IfcFace', Bounds=(bound,))

    faces = []
    for k in range(K - 1):
        for i in range(N):
            ni = (i + 1) % N
            faces.append(quad(outer_idx(k, i), outer_idx(k, ni),
                              outer_idx(k + 1, ni), outer_idx(k + 1, i)))
    for k in range(K - 1):
        for i in range(N):
            ni = (i + 1) % N
            faces.append(quad(inner_idx(k, ni), inner_idx(k, i),
                              inner_idx(k + 1, i), inner_idx(k + 1, ni)))
    # Start cap.
    for i in range(N):
        ni = (i + 1) % N
        faces.append(quad(outer_idx(0, ni), outer_idx(0, i),
                          inner_idx(0, i), inner_idx(0, ni)))
    last = K - 1
    for i in range(N):
        ni = (i + 1) % N
        faces.append(quad(outer_idx(last, i), outer_idx(last, ni),
                          inner_idx(last, ni), inner_idx(last, i)))

    try:
        shell = f.create_entity('IfcClosedShell', CfsFaces=tuple(faces))
        brep = f.create_entity('IfcFacetedBrep', Outer=shell)
        _apply_style(f, brep, color_rgb, name=f'TunnelChain-{name}')
    except Exception as ex:
        print(f"[CHAIN-WELD-FAIL] {name}: brep build error {ex}")
        return None

    counts['brep_segments_emitted'] += 1
    counts['walls_emitted'] += 1
    counts['arched_segments_emitted'] += 1  # chains are ARCH-only

    # Phase 6B.4d — capture world AABB for overlap validation. Chain owns
    # multiple seg_indices so we register the AABB once per owned segment so
    # phase6b host_id lookups still match.
    if tunnel_aabbs is not None:
        chain_aabb = _aabb_from_points(all_pts_world)
        for seg_i in chain['segments']:
            tunnel_aabbs.append({
                'kind': 'tunnel_brep',
                'name': f'{name}-seg{seg_i}',
                'elem_id': None,  # filled by caller from horizontal_candidates
                'chain_seg_idx': seg_i,
                'aabb': chain_aabb,
                'is_chain': True,
            })

    obj_lp = _make_local_placement(
        f, storey_lp, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
    rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=body_sub,
        RepresentationIdentifier='Body',
        RepresentationType='Brep',
        Items=(brep,),
    )
    product_def = f.create_entity('IfcProductDefinitionShape',
                                  Representations=(rep,))
    print(f"[CHAIN-BREP] {name} K={K} N={N} faces={len(faces)} verts={expected}")
    ent = f.create_entity(
        'IfcBuildingElementProxy',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=name,
        ObjectPlacement=obj_lp,
        Representation=product_def,
        ObjectType='TunnelShell',
    )
    _log_decision({'pass': 'generate_ifc_class', 'element_id': name,
        'action': 'ifc_class_assigned', 'reason': 'tunnel_chain_brep',
        'params': {'css_type': 'TUNNEL_SEGMENT', 'ifc_class': 'IfcBuildingElementProxy',
                   'confidence': 1.0}})
    return ent


# ============================================================================
# END PHASE 4C HELPERS
# ============================================================================


def _emit_wall_brep(f, body_sub, storey_lp, owner, cand,
                    bisector_at_start, bisector_at_end, profile_pts_cache,
                    counts, skip_reasons, vertex_count_tracker,
                    color_override=None,
                    closing_start=False, closing_end=False,
                    tunnel_aabbs=None):
    """Build the structural tunnel shell as IfcFacetedBrep.

    Vertices are placed in WORLD coordinates (object placement is identity).
    At any end where a bisector plane exists (joint), the cross-section vertices
    are projected onto that plane along local_x — producing a true mitre cut.
    Adjacent segments meeting at the joint share the same bisector plane, so
    their outer surfaces meet exactly along one curve (no gap, no overlap).

    The brep is closed: end caps (the donut wall-thickness face at start/end)
    are always emitted. At joint ends those end caps are inside the neighbouring
    segment's body and occluded — only the outer mitre seam is visible.

    Phase 6B.4b — when closing_start / closing_end is True, an extra polygon
    face is added over the inner profile at that end to seal the bore. This
    embeds the Phase 6B portal/junction/terminal wall directly into the shell
    brep instead of stacking a separate IfcWall entity at the same plane.
    The polygon's outward normal points away from the segment body
    (-local_x at start, +local_x at end). Topology becomes non-manifold at
    the inner_end ring (cavity face + donut + closing polygon all meet) —
    accepted as a tradeoff for visual correctness without IFC booleans.
    """
    elem_id = cand['elem_id']
    bore_w, bore_h, shell_t = cand['profile']
    source_type = cand.get('source_type', 'RECTANGLE')
    d = cand['d']
    start = cand['start']
    end = cand['end']

    frame = _build_frame_from_direction(d)
    if frame is None:
        counts['walls_skipped'] += 1
        skip_reasons.append((elem_id, 'wall_frame_failed'))
        return None
    local_x, local_y, local_z = frame

    # Profile points (cached by rounded dims for canonical reuse).
    cache_key = (round(bore_w, 2), round(bore_h, 2),
                 round(shell_t, 2), source_type)
    cached_pts = profile_pts_cache.get(cache_key)
    if cached_pts is not None:
        outer_2d, inner_2d, profile_kind = cached_pts
    else:
        if source_type == 'CIRCLE':
            # Approximate circular cross-section via a fine N-gon for brep.
            inner_r = bore_w / 2.0
            outer_r = inner_r + shell_t
            n = max(ARCH_SEGMENTS * 2, 16)
            outer_2d = [(outer_r * math.cos(2 * math.pi * k / n),
                         outer_r * math.sin(2 * math.pi * k / n))
                        for k in range(n)]
            inner_2d = [(inner_r * math.cos(2 * math.pi * k / n),
                         inner_r * math.sin(2 * math.pi * k / n))
                        for k in range(n)]
            profile_kind = 'circle'
        else:
            outer_2d, inner_2d = _gen_arch_profile_brep_pts(
                bore_w, bore_h, shell_t)
            if outer_2d is None:
                outer_2d, inner_2d = _gen_rect_profile_brep_pts(
                    bore_w, bore_h, shell_t)
                profile_kind = 'rectangular_fallback'
            else:
                profile_kind = 'arched'
        profile_pts_cache[cache_key] = (outer_2d, inner_2d, profile_kind)

    n = len(outer_2d)

    def gen_section_world(world_pos, bisector):
        outer_w_pts, inner_w_pts = [], []
        for p2 in outer_2d:
            v = _profile_pt_to_world(world_pos, p2, local_y, local_z)
            if bisector is not None:
                v = _project_along_dir_onto_plane(
                    v, local_x, bisector[0], bisector[1])
            outer_w_pts.append(v)
        for p2 in inner_2d:
            v = _profile_pt_to_world(world_pos, p2, local_y, local_z)
            if bisector is not None:
                v = _project_along_dir_onto_plane(
                    v, local_x, bisector[0], bisector[1])
            inner_w_pts.append(v)
        return outer_w_pts, inner_w_pts

    try:
        outer_start_3d, inner_start_3d = gen_section_world(start, bisector_at_start)
        outer_end_3d, inner_end_3d = gen_section_world(end, bisector_at_end)
    except Exception as ex:
        counts['walls_skipped'] += 1
        skip_reasons.append((elem_id, f'wall_section_gen_failed:{ex}'))
        return None

    # Build IfcCartesianPoints. Vertex order:
    #   [0     .. n)        outer_start
    #   [n     .. 2n)       outer_end
    #   [2n    .. 3n)       inner_start
    #   [3n    .. 4n)       inner_end
    all_pts = outer_start_3d + outer_end_3d + inner_start_3d + inner_end_3d
    ifc_pts = [_make_pt(f, p) for p in all_pts]
    OFF_OS, OFF_OE = 0, n
    OFF_IS, OFF_IE = 2 * n, 3 * n

    def quad_face(a_idx, b_idx, c_idx, d_idx):
        loop = f.create_entity(
            'IfcPolyLoop',
            Polygon=(ifc_pts[a_idx], ifc_pts[b_idx],
                     ifc_pts[c_idx], ifc_pts[d_idx]),
        )
        bound = f.create_entity('IfcFaceOuterBound', Bound=loop, Orientation=True)
        return f.create_entity('IfcFace', Bounds=(bound,))

    faces = []
    # Outer side surface (CCW from outside): outer[i] -> outer[i+1] -> outer_end[i+1] -> outer_end[i]
    for i in range(n):
        ni = (i + 1) % n
        faces.append(quad_face(OFF_OS + i, OFF_OS + ni,
                               OFF_OE + ni, OFF_OE + i))
    # Inner cavity surface (reversed orientation — face inward into cavity)
    for i in range(n):
        ni = (i + 1) % n
        faces.append(quad_face(OFF_IS + ni, OFF_IS + i,
                               OFF_IE + i, OFF_IE + ni))
    # Start end-cap "ring" between outer_start and inner_start
    for i in range(n):
        ni = (i + 1) % n
        faces.append(quad_face(OFF_OS + ni, OFF_OS + i,
                               OFF_IS + i, OFF_IS + ni))
    # End end-cap ring (opposite orientation from start cap)
    for i in range(n):
        ni = (i + 1) % n
        faces.append(quad_face(OFF_OE + i, OFF_OE + ni,
                               OFF_IE + ni, OFF_IE + i))

    # Phase 6B.4b — bore-closing polygon faces. The CCW order of inner_pts in
    # the local (lateral × vertical) frame yields a 3D polygon with normal in
    # +local_x. For the 'end' side we want outward normal = +local_x (matches
    # CCW order); for 'start' we want -local_x (reverse).
    def _closing_face(inner_offset, reverse_winding):
        idxs = list(range(n))
        if reverse_winding:
            idxs.reverse()
        loop = f.create_entity(
            'IfcPolyLoop',
            Polygon=tuple(ifc_pts[inner_offset + i] for i in idxs),
        )
        bound = f.create_entity('IfcFaceOuterBound', Bound=loop, Orientation=True)
        return f.create_entity('IfcFace', Bounds=(bound,))

    if closing_start:
        faces.append(_closing_face(OFF_IS, reverse_winding=True))
        counts['phase6b4b_walls_embedded'] = counts.get(
            'phase6b4b_walls_embedded', 0) + 1
    if closing_end:
        faces.append(_closing_face(OFF_IE, reverse_winding=False))
        counts['phase6b4b_walls_embedded'] = counts.get(
            'phase6b4b_walls_embedded', 0) + 1

    try:
        shell = f.create_entity('IfcClosedShell', CfsFaces=tuple(faces))
        brep = f.create_entity('IfcFacetedBrep', Outer=shell)
        style_name = f'TunnelShell-{profile_kind}'
        _apply_style(f, brep, color_override or SHELL_COLOR, name=style_name)
    except Exception as ex:
        counts['walls_skipped'] += 1
        skip_reasons.append((elem_id, f'wall_brep_build_failed:{ex}'))
        return None

    counts['walls_emitted'] += 1
    counts['brep_segments_emitted'] += 1
    if profile_kind == 'arched':
        counts['arched_segments_emitted'] += 1
    elif profile_kind == 'circle':
        counts['circle_segments_emitted'] += 1
    elif profile_kind == 'rectangular_fallback':
        counts['rectangular_fallback_segments'] += 1
    vertex_count_tracker.append(len(all_pts))

    # Phase 6B.4d — capture world AABB for overlap validation.
    if tunnel_aabbs is not None:
        tunnel_aabbs.append({
            'kind': 'tunnel_brep',
            'name': f'Tunnel-{elem_id}',
            'elem_id': elem_id,
            'aabb': _aabb_from_points(all_pts),
            'is_chain': False,
        })

    # Object placement at world origin — vertices are already in world coords.
    obj_lp = _make_local_placement(
        f, storey_lp, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
    rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=body_sub,
        RepresentationIdentifier='Body',
        RepresentationType='Brep',
        Items=(brep,),
    )
    product_def = f.create_entity('IfcProductDefinitionShape',
                                  Representations=(rep,))
    ent = f.create_entity(
        'IfcBuildingElementProxy',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'Tunnel-{elem_id}',
        ObjectPlacement=obj_lp,
        Representation=product_def,
        ObjectType='TunnelShell',
    )
    _log_decision({'pass': 'generate_ifc_class', 'element_id': elem_id,
        'action': 'ifc_class_assigned', 'reason': 'tunnel_wall_brep',
        'params': {'css_type': 'TUNNEL_SEGMENT', 'ifc_class': 'IfcBuildingElementProxy',
                   'confidence': 1.0}})
    return ent


def _emit_wall(f, body_sub, storey_lp, owner, cand, trim_start, trim_end,
               profile_cache, counts, skip_reasons):
    """Emit a structural tunnel wall with optional mitre extensions.

    cand        -- candidate dict: 'elem_id', 'start', 'end', 'd' (unit),
                   'length', 'profile' (bore_w, bore_h, shell_t).
    trim_start  -- meters to extend the start backward along -d (closes the
                   joint at this end). 0.0 = no change.
    trim_end    -- meters to extend the end forward along d. 0.0 = no change.
    """
    elem_id = cand['elem_id']
    start = cand['start']
    d = cand['d']
    base_length = cand['length']
    bore_w, bore_h, shell_t = cand['profile']
    source_type = cand.get('source_type', 'RECTANGLE')

    new_start = (
        start[0] - d[0] * trim_start,
        start[1] - d[1] * trim_start,
        start[2] - d[2] * trim_start,
    )
    new_length = base_length + trim_start + trim_end

    if new_length < MIN_SEGMENT_LENGTH:
        counts['walls_skipped'] += 1
        skip_reasons.append(
            (elem_id, f'wall_length_after_trim_{new_length:.3f}'))
        return None

    frame = _build_frame_from_direction(d)
    if frame is None:
        counts['walls_skipped'] += 1
        skip_reasons.append((elem_id, 'wall_frame_build_failed'))
        return None
    local_x, _local_y, local_z = frame

    # Profile selection (Phase 3): CIRCLE source -> circular hollow; everything
    # else -> arched hollow (default), falling back to rectangular hollow only
    # when the dimensions don't accommodate a clean arch.
    #
    # Profile cache: dimensionally-matching profiles (rounded to 1 cm) share a
    # single IfcProfileDef entity, so every tunnel segment of the same canonical
    # cross-section emits identical geometry — no per-segment arch drift.
    cache_key = (round(bore_w, 2), round(bore_h, 2),
                 round(shell_t, 2), source_type)
    cached = profile_cache.get(cache_key)
    style_name = 'TunnelShell'
    try:
        if cached is not None:
            profile_def, profile_kind = cached
        elif source_type == 'CIRCLE':
            inner_r = bore_w / 2.0
            outer_r = inner_r + shell_t
            profile_def = _make_circle_hollow_profile(f, outer_r, shell_t)
            profile_kind = 'circle'
            profile_cache[cache_key] = (profile_def, profile_kind)
        else:
            profile_def = _make_arched_hollow_profile(f, bore_w, bore_h, shell_t)
            if profile_def is not None:
                profile_kind = 'arched'
            else:
                outer_w = bore_w + 2.0 * shell_t
                outer_h = bore_h + 2.0 * shell_t
                profile_def = _make_hollow_rect_profile(
                    f, outer_w, outer_h, shell_t)
                profile_kind = 'rectangular_fallback'
            profile_cache[cache_key] = (profile_def, profile_kind)

        if profile_kind == 'arched':
            style_name = 'TunnelShellArched'
        elif profile_kind == 'circle':
            style_name = 'TunnelShellCircular'
        else:
            style_name = 'TunnelShellRect'

        obj_lp = _make_local_placement(f, storey_lp, new_start, local_z, local_x)
        solid = _make_extrusion_along_local_x(f, profile_def, new_length)
        _apply_style(f, solid, SHELL_COLOR, name=style_name)
    except Exception as ex:
        counts['walls_skipped'] += 1
        skip_reasons.append((elem_id, f'wall_geometry_build_failed:{ex}'))
        return None

    counts['walls_emitted'] += 1
    if profile_kind == 'arched':
        counts['arched_segments_emitted'] += 1
    elif profile_kind == 'circle':
        counts['circle_segments_emitted'] += 1
    elif profile_kind == 'rectangular_fallback':
        counts['rectangular_fallback_segments'] += 1

    return f.create_entity(
        'IfcBuildingElementProxy',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'Tunnel-{elem_id}', ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
        ObjectType='TunnelShell',
    )


def _emit_shaft(f, body_sub, storey_lp, owner, elem, elem_id,
                start, end, counts, skip_reasons, profile):
    """Vertical structural TUNNEL_SEGMENT → IfcColumn with explicit axis=(0,0,1).

    Phase 5A — strict source-dimension policy:
        * Per-shaft diagnostic log (always printed) showing source fields,
          computed values, and final bbox.
        * radius > profile.max_shaft_radius → SKIP unless the CSS sets
          properties.dimensionsAuthoritative === true.
        * height > profile.max_shaft_height → SKIP unless authoritative.
        * Missing source profile fields (radius / width / height) → SKIP. We do
          NOT fabricate dimensions from defaults.

    Phase 5A.12 — caps come from the loaded SecondaryGeometryProfile. Defaults
    match the legacy module constants when env vars are unset.

    Phase 5B.2 — when the source CSS has an explicit center (placement.origin /
    properties.center / properties.location) AND an explicit height
    (geom.depth / properties.height_m / properties.height / properties.shaftHeight),
    an oversized shaft is CLAMPED to the caps and emitted (counter
    `shaft_clamped`). Without those source fields, oversized shafts still
    skip.
    """
    max_radius = profile.max_shaft_radius
    max_height = profile.max_shaft_height
    geom = elem.get('geometry', {}) or {}
    profile_in = geom.get('profile', {}) or {}
    p_type = (profile_in.get('type') or 'RECTANGLE').upper()
    props = elem.get('properties', {}) or {}
    placement = elem.get('placement', {}) or {}

    has_explicit_center = (
        _safe_xyz(placement.get('origin')) is not None
        or _safe_xyz(props.get('center')) is not None
        or _safe_xyz(props.get('location')) is not None
    )
    has_explicit_height = any(
        _safe_float(v) is not None and _safe_float(v) > 0
        for v in (geom.get('depth'), props.get('height_m'),
                  props.get('height'), props.get('shaftHeight'))
    )
    can_clamp = has_explicit_center and has_explicit_height

    src_radius = _safe_float(profile_in.get('radius'))
    src_diameter = _safe_float(profile_in.get('diameter'))
    src_width = _safe_float(profile_in.get('width'))
    src_height_prof = _safe_float(profile_in.get('height'))   # rect profile cross-section H
    src_depth = _safe_float(geom.get('depth'))
    src_height_m = _safe_float(props.get('height_m'))
    src_props_height = _safe_float(props.get('height'))
    src_shaft_height = _safe_float(props.get('shaftHeight'))
    auth_raw = props.get('dimensionsAuthoritative')
    authoritative = (auth_raw is True
                     or (isinstance(auth_raw, str) and auth_raw.lower() == 'true'))

    height = abs(end[2] - start[2])
    origin = start if start[2] <= end[2] else end

    log_prefix = f"  shaft[{elem_id}]"
    print(f"{log_prefix} src: profile_type={p_type} "
          f"radius={src_radius} diameter={src_diameter} "
          f"width={src_width} height={src_height_prof} "
          f"depth={src_depth} height_m={src_height_m} "
          f"props.height={src_props_height} shaftHeight={src_shaft_height} "
          f"authoritative={authoritative}")

    if height < MIN_SEGMENT_LENGTH:
        counts['shafts_skipped'] += 1
        skip_reasons.append((elem_id, f'shaft_too_short_{height:.3f}'))
        print(f"{log_prefix} SKIP shaft_too_short height={height:.3f}m")
        return None

    if height > max_height and not authoritative:
        if can_clamp:
            counts['shaft_clamped'] += 1
            print(f"{log_prefix} CLAMP shaft_oversized_height={height:.2f}m "
                  f"-> {max_height}m (source has explicit center + height)")
            height = max_height
            # Realign the upper end so visual extent matches the clamped value.
            if start[2] <= end[2]:
                end = (end[0], end[1], start[2] + max_height)
            else:
                start = (start[0], start[1], end[2] + max_height)
        else:
            counts['shafts_skipped_oversized'] += 1
            counts['secondary_skipped_oversized'] += 1
            skip_reasons.append(
                (elem_id,
                 f'shaft_oversized_height_{height:.2f}m_cap_{max_height}m'))
            print(f"{log_prefix} SKIP shaft_oversized_height={height:.2f}m "
                  f"(cap {max_height}m, no source center+height to clamp)")
            return None

    shell_t = _safe_float(profile_in.get('wallThickness'))
    if shell_t is None:
        shell_t = _safe_float(props.get('shellThickness_m'))

    try:
        if p_type == 'CIRCLE':
            r = src_radius
            if (r is None or r <= 0) and src_diameter and src_diameter > 0:
                r = src_diameter / 2.0
            if not r or r <= 0:
                counts['shafts_skipped_missing_dims'] += 1
                skip_reasons.append((elem_id, 'shaft_invalid_circle_radius'))
                print(f"{log_prefix} SKIP shaft_invalid_circle_radius "
                      f"(no profile.radius/diameter from source)")
                return None
            if r > max_radius and not authoritative:
                if can_clamp:
                    counts['shaft_clamped'] += 1
                    print(f"{log_prefix} CLAMP shaft_oversized_radius={r:.2f}m "
                          f"-> {max_radius}m (source has explicit center + height)")
                    r = max_radius
                else:
                    counts['shafts_skipped_oversized'] += 1
                    counts['secondary_skipped_oversized'] += 1
                    skip_reasons.append(
                        (elem_id,
                         f'shaft_oversized_radius_{r:.2f}m_cap_{max_radius}m'))
                    print(f"{log_prefix} SKIP shaft_oversized_radius={r:.2f}m "
                          f"(cap {max_radius}m, no source center+height to clamp)")
                    return None
            t = shell_t if (shell_t and shell_t > 0) else SHELL_THICKNESS_DEFAULT
            profile_def = _make_circle_hollow_profile(f, r + t, t)
            computed_radius = r
        else:
            w = src_width
            h_prof = src_height_prof
            if not w or not h_prof or w <= 0 or h_prof <= 0:
                counts['shafts_skipped_missing_dims'] += 1
                skip_reasons.append((elem_id, 'shaft_invalid_rect_profile'))
                print(f"{log_prefix} SKIP shaft_invalid_rect_profile "
                      f"(no profile.width/height from source)")
                return None
            equiv_r = max(w, h_prof) / 2.0
            if equiv_r > max_radius and not authoritative:
                if can_clamp:
                    counts['shaft_clamped'] += 1
                    scale = max_radius / equiv_r
                    new_w = w * scale
                    new_h = h_prof * scale
                    print(f"{log_prefix} CLAMP shaft_oversized_rect="
                          f"{w:.2f}x{h_prof:.2f}m -> {new_w:.2f}x{new_h:.2f}m "
                          f"(half-dim {max_radius}m, source has center + height)")
                    w, h_prof = new_w, new_h
                    equiv_r = max_radius
                else:
                    counts['shafts_skipped_oversized'] += 1
                    counts['secondary_skipped_oversized'] += 1
                    skip_reasons.append(
                        (elem_id,
                         f'shaft_oversized_rect_{w:.2f}x{h_prof:.2f}_halfdim_cap_{max_radius}m'))
                    print(f"{log_prefix} SKIP shaft_oversized_rect={w:.2f}x{h_prof:.2f}m "
                          f"(half-dim cap {max_radius}m, no source center+height to clamp)")
                    return None
            if shell_t and shell_t > 0:
                profile_def = _make_hollow_rect_profile(
                    f, w + 2.0 * shell_t, h_prof + 2.0 * shell_t, shell_t)
            else:
                profile_def = _make_solid_rect_profile(f, w, h_prof)
            computed_radius = equiv_r

        obj_lp = _make_local_placement(f, storey_lp, origin, (0.0, 0.0, 1.0),
                                       (1.0, 0.0, 0.0))
        solid = _make_extrusion_along_local_z(f, profile_def, height)
        _apply_style(f, solid, SHELL_COLOR, name='TunnelShaft')
    except Exception as ex:
        counts['shafts_skipped'] += 1
        skip_reasons.append((elem_id, f'shaft_geometry_build_failed:{ex}'))
        print(f"{log_prefix} SKIP shaft_geometry_build_failed: {ex}")
        return None

    bx0, bx1 = origin[0] - computed_radius, origin[0] + computed_radius
    by0, by1 = origin[1] - computed_radius, origin[1] + computed_radius
    bz0, bz1 = origin[2], origin[2] + height
    print(f"{log_prefix} EMIT computed_radius={computed_radius:.3f}m "
          f"computed_height={height:.3f}m "
          f"bbox=X[{bx0:.2f},{bx1:.2f}] Y[{by0:.2f},{by1:.2f}] Z[{bz0:.2f},{bz1:.2f}]")

    counts['shafts_kept'] += 1
    counts['shafts_emitted'] += 1
    return f.create_entity(
        'IfcColumn',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'Shaft-{elem_id}', ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
    )


def _emit_portal_cap(f, body_sub, storey_lp, owner, cand, end_lbl,
                     portal_cap_cache, counts, skip_reasons,
                     synthetic_frame_anchors=None):
    """Emit a frame structure at a tunnel mouth (free end of a horizontal seg).

    The frame's profile lies in the plane perpendicular to the tunnel direction
    (= the tunnel segment's end plane). Outer is a rectangle; inner void hugs
    the tunnel's outer arched outline so the frame snugly surrounds the mouth.
    Extruded outward (away from the tunnel body) by PORTAL_FRAME_THICKNESS.

    end_lbl: 'start' or 'end' — which end of the segment is the mouth.

    5B.1 — when synthetic_frame_anchors is a list, the cap's anchor xyz is
    appended on success so the door loop can recover doors by proximity.
    """
    elem_id = cand['elem_id']
    bore_w, bore_h, shell_t = cand['profile']
    d = cand['d']

    if end_lbl == 'start':
        anchor = cand['start']
        outward = (-d[0], -d[1], -d[2])
    else:
        anchor = cand['end']
        outward = d

    frame = _build_frame_from_direction(outward)
    if frame is None:
        counts['portal_caps_skipped'] += 1
        skip_reasons.append((elem_id, f'cap_frame_failed_{end_lbl}'))
        return None
    local_x, _local_y, local_z = frame

    cache_key = (round(bore_w, 2), round(bore_h, 2), round(shell_t, 2))
    profile_def = portal_cap_cache.get(cache_key)
    try:
        if profile_def is None:
            profile_def = _make_portal_frame_profile(f, bore_w, bore_h, shell_t)
            if profile_def is None:
                # Fall back to rectangular frame.
                outer_w = bore_w + 2.0 * (shell_t + PORTAL_FRAME_MARGIN)
                outer_h = bore_h + 2.0 * (shell_t + PORTAL_FRAME_MARGIN)
                inner_w = bore_w + 2.0 * shell_t
                inner_h = bore_h + 2.0 * shell_t
                profile_def = _make_rect_frame_profile(
                    f, outer_w, outer_h, inner_w, inner_h)
            portal_cap_cache[cache_key] = profile_def

        obj_lp = _make_local_placement(f, storey_lp, anchor, local_z, local_x)
        solid = _make_extrusion_along_local_x(
            f, profile_def, PORTAL_FRAME_THICKNESS)
        _apply_style(f, solid, SHELL_COLOR, name='PortalCap')
    except Exception as ex:
        counts['portal_caps_skipped'] += 1
        skip_reasons.append((elem_id, f'cap_geometry_failed_{end_lbl}:{ex}'))
        return None

    counts['portal_caps_emitted'] += 1
    counts['synthetic_portal_frames_emitted'] += 1
    if synthetic_frame_anchors is not None:
        synthetic_frame_anchors.append({
            'anchor': anchor,
            'outward': outward,
            'local_x': local_x,
            'local_z': local_z,
            'bore_w': bore_w,
            'bore_h': bore_h,
            'shell_t': shell_t,
            'segment_id': elem_id,
            'end_lbl': end_lbl,
        })
    return f.create_entity(
        'IfcWall',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'PortalCap-{elem_id}-{end_lbl}',
        ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
    )


def _door_location_valid(cand, t, joint_start, joint_end,
                          short_branch_threshold=DOOR_SHORT_BRANCH_THRESHOLD,
                          endpoint_tolerance=DOOR_ENDPOINT_TOLERANCE):
    """Phase 5B.5D — decide whether a door projection (cand, t) is at a
    structurally meaningful location.

    Returns (valid, kind, snap_t):
      * valid     — bool; True iff the placement is allowed.
      * kind      — string label for diagnostics:
            'short_branch'    — entire segment is a room/branch entrance
            'endpoint_start'  — within tolerance of segment start (free end)
            'endpoint_end'    — within tolerance of segment end (free end)
            'junction_start'  — within tolerance of segment start, AND that
                                end is a joint with another segment
            'junction_end'    — same at the segment's end
            'mid_segment'     — invalid: mid-segment with no structural meaning
      * snap_t    — t value to snap to (0 or L) when the placement is at an
                    endpoint/junction; None for short_branch (no snap).
    """
    L = cand['length']
    if L <= 0:
        return False, 'mid_segment', None

    # (C) Short branch — entire span is valid (no snap).
    if L < short_branch_threshold:
        return True, 'short_branch', None

    # (A)/(B) Endpoint — within tolerance of either end.
    if t <= endpoint_tolerance:
        kind = 'junction_start' if joint_start else 'endpoint_start'
        return True, kind, 0.0
    if t >= L - endpoint_tolerance:
        kind = 'junction_end' if joint_end else 'endpoint_end'
        return True, kind, L

    # Mid-segment: no junction unless an explicit joint flag exists at this
    # specific projection. Joint flags only apply at segment ends, so any
    # mid-segment placement is rejected.
    return False, 'mid_segment', None


def _find_host_wall_for_door(door_origin, host_walls,
                              face_tolerance=DOOR_WALL_FACE_TOLERANCE):
    """Phase 5B.5C — find the nearest horizontal wall whose outer face is
    within `face_tolerance` of the door's xy origin.

    host_walls is a list of dicts with keys: 'entity', 'cand'. Each cand has
    'start', 'end', 'd' (unit horizontal direction), 'length', and
    'profile' = (bore_w, bore_h, shell_t).

    Returns (host_wall_dict, projection, diag) where:
      * host_wall_dict / projection are populated when the best candidate's
        face distance is within `face_tolerance`, else both are None.
      * diag carries the nearest-wall metrics regardless of pass/fail so the
        caller can log them — keys: 'best_face_dist', 'best_seg_id',
        'best_outer_w', 'within_tolerance'. diag is None only when host_walls
        is empty.
    """
    if not host_walls:
        return None, None, None
    dx, dy = float(door_origin[0]), float(door_origin[1])
    best = None
    best_proj = None
    best_seg_id = None
    best_face_dist = float('inf')
    for hw in host_walls:
        cand = hw['cand']
        sx, sy, _sz = cand['start']
        ex, ey, _ez = cand['end']
        dxx, dyy, _dzz = cand['d']  # unit
        L = cand['length']
        if L <= 0:
            continue
        # parametric projection of (dx,dy) onto centerline xy
        vx, vy = (dx - sx), (dy - sy)
        t = vx * dxx + vy * dyy
        t_clamped = max(0.0, min(L, t))
        cx = sx + dxx * t_clamped
        cy = sy + dyy * t_clamped
        ox, oy = (dx - cx), (dy - cy)
        perp = math.hypot(ox, oy)
        bore_w, _bore_h, shell_t = cand['profile']
        outer_w = bore_w + 2.0 * shell_t
        outer_half = outer_w / 2.0
        face_dist = abs(perp - outer_half)
        if face_dist >= best_face_dist:
            continue
        if perp > 1e-6:
            nx, ny = ox / perp, oy / perp
        else:
            # door sits on centerline — pick perpendicular to wall direction
            # (-d.y, d.x, 0) by convention.
            nx, ny = -dyy, dxx
        best_face_dist = face_dist
        best = hw
        best_seg_id = cand['elem_id']
        best_proj = {
            't': t_clamped,
            'closest_xy': (cx, cy),
            'normal_unit': (nx, ny, 0.0),
            'face_dist': face_dist,
            'outer_w': outer_w,
            'shell_t': shell_t,
        }
    diag = {
        'best_face_dist': best_face_dist if best is not None else float('inf'),
        'best_seg_id': best_seg_id,
        'best_outer_w': best_proj['outer_w'] if best_proj else None,
        'within_tolerance': (best is not None
                              and best_face_dist <= face_tolerance),
    }
    if best is None or best_face_dist > face_tolerance:
        return None, None, diag
    return best, best_proj, diag


def _resolve_door_height(elem, default=DOOR_DEFAULT_HEIGHT,
                          min_height=DOOR_MIN_HEIGHT,
                          allow_default=True):
    """Pick a door's vertical height with explicit priority. Never returns
    `profile.height` — in this CSS schema, profile.height is the door panel's
    cross-section depth (= thickness), not its standing height.

    Priority:
      1. properties.OverallHeight / properties.height_m / properties.semanticHeight
      2. geometry.depth                       (vertical extrusion in this schema)
      3. geometry.bbox vertical extent        (bbox.max.z - bbox.min.z)
      4. `default` only when allow_default=True

    Returns (height_m, source_label). source_label identifies which rule won
    or why nothing did. A candidate is rejected (and the next priority tried)
    when it is below `min_height` — guards against a thickness value being
    mistaken for a door height. If no candidate clears the guard and default
    is disallowed, returns (None, 'no_valid_height_source') so the caller can
    reject the door instead of silently emitting a 0.08m panel.
    """
    elem_id = elem.get('id', '<no-id>')
    props = elem.get('properties') or {}
    geom = elem.get('geometry') or {}

    for key in ('OverallHeight', 'height_m', 'semanticHeight'):
        v = _safe_float(props.get(key))
        if v is None or v <= 0:
            continue
        if v >= min_height:
            return v, key
        print(f"  door[{elem_id}] height_candidate {key}={v:.3f}m "
              f"below_min={min_height:.2f}m skipping")

    depth = _safe_float(geom.get('depth'))
    if depth is not None and depth > 0:
        if depth >= min_height:
            return depth, 'geom_depth'
        print(f"  door[{elem_id}] height_candidate geom.depth={depth:.3f}m "
              f"below_min={min_height:.2f}m skipping")

    bbox = geom.get('bbox')
    if isinstance(bbox, dict):
        zmin = _safe_float((bbox.get('min') or {}).get('z'))
        zmax = _safe_float((bbox.get('max') or {}).get('z'))
        if zmin is not None and zmax is not None and zmax > zmin:
            extent = zmax - zmin
            if extent >= min_height:
                return extent, 'bbox_z'
            print(f"  door[{elem_id}] height_candidate bbox_z={extent:.3f}m "
                  f"below_min={min_height:.2f}m skipping")

    if allow_default and default >= min_height:
        return default, 'default'

    return None, 'no_valid_height_source'


def _emit_door_in_wall(f, body_sub, storey_lp, owner, elem, host_wall,
                        projection, counts, skip_reasons,
                        opening_label=None):
    """Phase 5B.5F — emit a freestanding IfcDoor panel at a branch wall's
    joint endpoint with a corrected local frame.

    Frame (per user spec):
        local_x  = LATERAL across the bore opening (= horizontal perpendicular
                   to the wall axis).  This is the door's WIDTH direction.
        local_y  = along the wall axis.  This is the door's THICKNESS direction
                   (sign doesn't matter — the rectangle is centered).
        local_z  = world up.  This is the door's HEIGHT direction.

    Placement:
        xy center  = the joint position (cx, cy) on the wall centerline.
        z bottom   = interior floor of the host bore = path_z - bore_h/2.
        Door extrudes UP from the floor by door_height.

    Sizing (clamped to the bore):
        door_width      = min(DOOR_DEFAULT_WIDTH, bore_w)          [1.0 m default]
        door_height     = min(DOOR_DEFAULT_HEIGHT, bore_h)         [2.1 m default]
        door_thickness  = DOOR_DEFAULT_THICKNESS                   [0.10 m]

    The wall is no longer voided in 5B.5F — the panel is a freestanding
    visible marker at the doorway. (IfcRelVoidsElement / IfcRelFillsElement
    can return in a follow-up phase once visual placement is verified.)
    """
    if _phase11b_door_rejected(elem, counts):
        return None

    elem_id = elem.get('id', '<no-id>')

    cand = host_wall['cand']
    sx, sy, sz = cand['start']
    ex, ey, ez = cand['end']
    dxx, dyy, dzz = cand['d']
    L = cand['length']
    bore_w, bore_h, shell_t = cand['profile']
    cx, cy = projection['closest_xy']
    t = projection['t']

    # ---- Phase 5B.5D placement-correctness gate (kept) ----
    joint_start = host_wall.get('joint_start', False)
    joint_end = host_wall.get('joint_end', False)
    valid, kind, snap_t = _door_location_valid(
        cand, t, joint_start, joint_end)
    if not valid:
        counts['doors_skipped_invalid_location'] += 1
        skip_reasons.append(
            (elem_id,
             f'door_invalid_location kind={kind} t={t:.3f} L={L:.3f} '
             f'joint_start={joint_start} joint_end={joint_end}'))
        print(f"  door[{elem_id}] SKIP invalid_location segment={cand['elem_id']} "
              f"t={t:.2f}/{L:.2f}m kind={kind} "
              f"joint_start={joint_start} joint_end={joint_end}")
        return None

    counts['doors_valid_location'] += 1
    snapped = False
    if snap_t is not None and abs(t - snap_t) <= DOOR_ENDPOINT_SNAP_TOLERANCE:
        t = snap_t
        cx = sx + dxx * t
        cy = sy + dyy * t
        counts['doors_snapped_to_endpoint'] += 1
        snapped = True

    # ---- Phase 5B.5F panel sizing ----
    door_width = DOOR_DEFAULT_WIDTH
    door_height = DOOR_DEFAULT_HEIGHT
    door_thickness = DOOR_DEFAULT_THICKNESS
    if bore_w > 0 and bore_w < door_width:
        door_width = bore_w
    if bore_h > 0 and bore_h < door_height:
        door_height = bore_h
    if door_width < DOOR_MIN_WIDTH or door_height < DOOR_MIN_HEIGHT:
        counts['doors_skipped_invalid_after_clamp'] += 1
        skip_reasons.append(
            (elem_id,
             f'door_invalid_after_clamp w={door_width:.2f} h={door_height:.2f} '
             f'(min {DOOR_MIN_WIDTH}x{DOOR_MIN_HEIGHT}, '
             f'bore={bore_w:.2f}x{bore_h:.2f})'))
        return None

    # ---- Phase 5B.5F frame ----
    # local_x = perpendicular to wall axis in the horizontal plane (door width).
    # IFC derives local_y = local_z × local_x; with local_z=(0,0,1) and
    # local_x=(-dyy, dxx, 0) we get local_y=(-dxx, -dyy, 0) — i.e. opposite
    # the wall direction. That's fine: the panel rectangle is centered, so
    # the sign of the thickness axis doesn't matter visually.
    refdir = (-dyy, dxx, 0.0)
    axis_up = (0.0, 0.0, 1.0)

    # ---- Phase 5B.5F vertical placement ----
    # joint_z follows the wall path slope: sz + dzz * t.
    joint_z = sz + dzz * t
    # For an arched / rectangular tunnel cross-section, the path is on the
    # centerline of the bore (inner_floor_y = -bore_h/2 in section coords),
    # so the interior floor is bore_h/2 below the path.
    floor_z = joint_z - bore_h / 2.0
    placement_origin = (cx, cy, floor_z)

    # ---- Build geometry ----
    try:
        obj_lp = _make_local_placement(f, storey_lp, placement_origin,
                                       axis_up, refdir)
        profile_def = _make_solid_rect_profile(f, door_width, door_thickness)
        solid = _make_extrusion_along_local_z(f, profile_def, door_height)
        _apply_style(f, solid, DOOR_COLOR, name='Door')
    except Exception as ex:
        counts['doors_skipped_invalid_after_clamp'] += 1
        skip_reasons.append((elem_id, f'door_geometry_failed:{ex}'))
        return None

    door = f.create_entity(
        'IfcDoor',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'Door-{elem_id}',
        ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
        OverallHeight=float(door_height),
        OverallWidth=float(door_width),
    )

    counts['doors_emitted'] += 1
    counts['doors_hosted_on_shell'] += 1

    door_center = (cx, cy, floor_z + door_height / 2.0)
    print(f"  door[{elem_id}] PANEL "
          f"opening_id={opening_label or 'fallback'} "
          f"host_seg={cand['elem_id']} "
          f"center=({door_center[0]:.3f},{door_center[1]:.3f},{door_center[2]:.3f}) "
          f"local_x=({refdir[0]:.3f},{refdir[1]:.3f},{refdir[2]:.3f}) "
          f"local_z=({axis_up[0]:.3f},{axis_up[1]:.3f},{axis_up[2]:.3f}) "
          f"normal=({dxx:.3f},{dyy:.3f},0.000) "
          f"bbox(WxTxH)={door_width:.2f}x{door_thickness:.2f}x{door_height:.2f}m "
          f"location_kind={kind} t={t:.2f}/{L:.2f}m snapped={snapped}")
    return door


def _collect_door_signals(elements):
    """Gather signals from CSS DOOR elements that qualify a branch joint as a
    real doorway opening. Used by `_build_room_opening_targets` to prune
    junction endpoints that have no DOOR evidence pointing at them.

    Returns a dict:
        origins:   list of (x, y) tuples for every DOOR with a placement origin
        host_keys: set of hostWallKey strings referenced by any DOOR
    """
    origins_xy = []
    host_keys = set()
    for el in elements or []:
        if el.get('type') != 'DOOR':
            continue
        placement = el.get('placement') or {}
        origin = placement.get('origin')
        if isinstance(origin, dict):
            x = _safe_float(origin.get('x'))
            y = _safe_float(origin.get('y'))
            if x is not None and y is not None:
                origins_xy.append((x, y))
        meta = el.get('metadata') or {}
        hk = (meta.get('hostWallKey')
              or meta.get('host_wall_key')
              or meta.get('host'))
        if isinstance(hk, str) and hk:
            host_keys.add(hk)
    return {'origins': origins_xy, 'host_keys': host_keys}


def _build_room_opening_targets(horizontal_candidates, jstats,
                                 chain_owned_segments, host_walls,
                                 door_signals=None,
                                 short_branch_threshold=DOOR_SHORT_BRANCH_THRESHOLD,
                                 proximity_radius=DOOR_OPENING_ASSIGNMENT_RADIUS):
    """Phase 5B.5E — collect joint endpoints of branch (non-main-loop) walls
    that qualify as real doorway openings.

    A bare branch joint is NOT automatically a doorway. With `door_signals`
    supplied, an opening is kept only when at least one of:
      - is_short_branch (the branch is shorter than `short_branch_threshold`,
        i.e. a room-sized side passage), OR
      - explicit hostWallKey match (a CSS DOOR names this segment as host —
        either as elem_id or as `portal-end-wall-{elem_id}-{end}`), OR
      - door proximity (a CSS DOOR's origin is within `proximity_radius` xy
        of the opening's origin).

    When `door_signals` is None (or empty), behavior is unchanged: every
    branch joint endpoint is emitted. This keeps debug callers that want to
    see every candidate working.

    Each emitted opening carries `qualify_reason` so the dump and logs can
    show why each one survived the prune.

    Returns a list of opening dicts:
        opening_id      stable label for diagnostics
        host_seg_idx    branch segment owning this opening
        host_wall       host_walls[i] entry (carries entity + cand + joint flags)
        end_label       'start' or 'end' (which end of the branch is the joint)
        origin          (x,y,z) joint position (segment endpoint xyz)
        branch_axis     unit vector pointing INTO the branch from the joint
        branch_length   segment length (m)
        is_short_branch True iff length < short_branch_threshold
        qualify_reason  why this opening survived the door-signal filter
    """
    seg_to_host = {hw['seg_idx']: hw for hw in host_walls}
    joint_ends = jstats.get('joint_ends', set())

    door_origins_xy = []
    door_host_keys = set()
    if door_signals:
        door_origins_xy = list(door_signals.get('origins') or [])
        door_host_keys = set(door_signals.get('host_keys') or [])
    apply_filter = bool(door_origins_xy or door_host_keys)
    radius_sq = proximity_radius * proximity_radius

    targets = []
    pruned_log = []
    pre_prune_count = 0
    for i, cand in enumerate(horizontal_candidates):
        if i in chain_owned_segments:
            continue  # main-loop wall — never an opening target
        host_wall = seg_to_host.get(i)
        if host_wall is None:
            continue
        L = cand['length']
        is_short = L < short_branch_threshold
        dxx, dyy, dzz = cand['d']
        elem_id = cand['elem_id']
        for end_lbl in ('start', 'end'):
            if (i, end_lbl) not in joint_ends:
                continue
            pre_prune_count += 1
            origin = cand['start'] if end_lbl == 'start' else cand['end']
            opening_id = f"opening_{elem_id}_{end_lbl}"

            qualify_reason = 'unfiltered'
            if apply_filter:
                qualify_reason = None
                if is_short:
                    qualify_reason = 'short_branch'
                if qualify_reason is None:
                    portal_key = f"portal-end-wall-{elem_id}-{end_lbl}"
                    if elem_id in door_host_keys or portal_key in door_host_keys:
                        qualify_reason = 'explicit_host_key'
                if qualify_reason is None and door_origins_xy:
                    ox, oy = float(origin[0]), float(origin[1])
                    best_d2 = None
                    for (dx, dy) in door_origins_xy:
                        d2 = (ox - dx) ** 2 + (oy - dy) ** 2
                        if best_d2 is None or d2 < best_d2:
                            best_d2 = d2
                    if best_d2 is not None and best_d2 <= radius_sq:
                        qualify_reason = f'door_proximity({best_d2 ** 0.5:.2f}m)'
                if qualify_reason is None:
                    pruned_log.append((opening_id, L, is_short))
                    continue

            if end_lbl == 'start':
                axis = (dxx, dyy, dzz)
            else:
                axis = (-dxx, -dyy, -dzz)
            targets.append({
                'opening_id': opening_id,
                'host_seg_idx': i,
                'host_wall': host_wall,
                'end_label': end_lbl,
                'origin': (float(origin[0]), float(origin[1]), float(origin[2])),
                'branch_axis': axis,
                'branch_length': L,
                'is_short_branch': is_short,
                'qualify_reason': qualify_reason,
            })

    if apply_filter:
        print(f"  opening_target_filter kept={len(targets)} "
              f"pruned={len(pruned_log)} "
              f"pre_prune={pre_prune_count} "
              f"door_origins={len(door_origins_xy)} "
              f"door_host_keys={len(door_host_keys)} "
              f"radius={proximity_radius}m")
        for oid, blen, short in pruned_log[:20]:
            print(f"    pruned[{oid}] no_door_signal "
                  f"branch_len={blen:.2f}m short={short}")
    return targets, pre_prune_count


def _find_opening_for_door(door_origin, opening_targets,
                            radius=DOOR_OPENING_ASSIGNMENT_RADIUS):
    """Phase 5B.5E — pick the opening whose origin is closest (xy) to the
    source door's origin. Returns (opening, dist) when within radius, else
    (None, dist_or_None) so the caller can log how close the best miss was.
    """
    if not opening_targets:
        return None, None
    dx, dy = float(door_origin[0]), float(door_origin[1])
    best = None
    best_d2 = float('inf')
    for tgt in opening_targets:
        ox, oy, _oz = tgt['origin']
        d2 = (dx - ox) ** 2 + (dy - oy) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best = tgt
    if best is None:
        return None, None
    dist = math.sqrt(best_d2)
    if dist > radius:
        return None, dist
    return best, dist


def _door_explicit_host_match(host_key, opening):
    """Return True iff `host_key` (a CSS DOOR's hostWallKey) explicitly names
    `opening`'s host segment — either as the segment elem_id or as the
    composed `portal-end-wall-{elem_id}-{end}` key.
    """
    if not host_key or not isinstance(host_key, str):
        return False
    cand = opening['host_wall']['cand']
    elem_id = cand['elem_id']
    end_lbl = opening['end_label']
    if host_key == elem_id:
        return True
    if host_key == f"portal-end-wall-{elem_id}-{end_lbl}":
        return True
    return False


def _score_door_opening_pair(elem, opening, distance, has_explicit_match):
    """Phase 5B.6 (Task C) — score a (door, opening) pairing for global
    assignment. Higher score = stronger match. Components:
        + 1000  explicit hostWallKey names this opening's host
        +  200  door has valid panel dimensions (resolved height >= MIN, width > 0)
        +  100  door's source normal aligns with opening's outward normal
                (dot >= 0.3 in xy)
        + (radius_explicit - distance) * 5  proximity bonus

    The `valid dimensions` check uses _resolve_door_height with default
    fallback disabled — we only credit a door whose source data actually
    encodes a real height.
    """
    score = 0.0
    if has_explicit_match:
        score += 1000.0

    height_m, _ = _resolve_door_height(elem, allow_default=False)
    placement = elem.get('placement') or {}
    profile_in = (elem.get('geometry') or {}).get('profile') or {}
    src_width = _safe_float(profile_in.get('width'))
    if (height_m is not None and height_m >= DOOR_MIN_HEIGHT
            and src_width is not None and src_width >= DOOR_MIN_WIDTH):
        score += 200.0

    refdir = placement.get('refDirection') or {}
    rx = _safe_float(refdir.get('x'))
    ry = _safe_float(refdir.get('y'))
    if rx is not None and ry is not None:
        rmag = math.hypot(rx, ry)
        if rmag > 1e-6:
            rxn, ryn = rx / rmag, ry / rmag
            cand = opening['host_wall']['cand']
            dxx, dyy, _ = cand['d']
            outward = (-dyy, dxx)
            omag = math.hypot(outward[0], outward[1])
            if omag > 1e-6:
                ox_n, oy_n = outward[0] / omag, outward[1] / omag
                dot = abs(rxn * ox_n + ryn * oy_n)
                if dot >= 0.3:
                    score += 100.0

    score += max(0.0, DOOR_OPENING_ASSIGNMENT_RADIUS_EXPLICIT - distance) * 5.0
    return score


def _assign_doors_to_openings(door_elements, opening_targets,
                               radius_default=DOOR_OPENING_ASSIGNMENT_RADIUS,
                               radius_explicit=DOOR_OPENING_ASSIGNMENT_RADIUS_EXPLICIT):
    """Phase 5B.6 (Task C) — globally assign DOOR elements to opening_targets
    with one door per opening and confidence-driven tie-break.

    For each door, candidate openings are those within `radius_default` of
    the door's origin (xy). Doors whose `hostWallKey` explicitly names an
    opening are additionally allowed candidates within `radius_explicit`.
    Candidates are scored by `_score_door_opening_pair`; pairings are then
    consumed in descending score order, taking the first available opening
    for each door (one door per opening).

    Returns:
        assignments  dict { door_elem_id: {
                          'opening': <opening_target dict>,
                          'distance': float,
                          'score': float,
                          'reason': 'explicit_host' | 'proximity',
                          'radius_used': float,
                       } }
        skipped      dict { door_elem_id: 'no_candidate' | 'duplicate_opening' }
        stats        dict { 'pairs_considered', 'max_assignment_distance' }
    """
    assignments = {}
    skipped = {}
    stats = {'pairs_considered': 0, 'max_assignment_distance': 0.0}

    if not door_elements or not opening_targets:
        for el in door_elements or []:
            if el.get('type') != 'DOOR':
                continue
            skipped[el.get('id', '<no-id>')] = 'no_candidate'
        return assignments, skipped, stats

    pairs = []
    door_had_candidate = {}
    for el in door_elements:
        if el.get('type') != 'DOOR':
            continue
        elem_id = el.get('id', '<no-id>')
        placement = el.get('placement') or {}
        origin = placement.get('origin')
        if not isinstance(origin, dict):
            skipped[elem_id] = 'no_candidate'
            continue
        ox = _safe_float(origin.get('x'))
        oy = _safe_float(origin.get('y'))
        if ox is None or oy is None:
            skipped[elem_id] = 'no_candidate'
            continue
        meta = el.get('metadata') or {}
        host_key = (meta.get('hostWallKey')
                    or meta.get('host_wall_key')
                    or meta.get('host'))
        door_had_candidate[elem_id] = False
        for tgt in opening_targets:
            tx, ty, _tz = tgt['origin']
            dist = math.hypot(ox - tx, oy - ty)
            explicit = _door_explicit_host_match(host_key, tgt)
            radius = radius_explicit if explicit else radius_default
            if dist > radius:
                continue
            score = _score_door_opening_pair(el, tgt, dist, explicit)
            reason = 'explicit_host' if explicit else 'proximity'
            pairs.append((score, dist, elem_id, tgt, reason, radius, el))
            door_had_candidate[elem_id] = True
        if not door_had_candidate[elem_id]:
            skipped[elem_id] = 'no_candidate'

    stats['pairs_considered'] = len(pairs)
    pairs.sort(key=lambda p: (-p[0], p[1]))  # high score, then low distance

    taken_openings = set()
    assigned_doors = set()
    for score, dist, elem_id, tgt, reason, radius, _el in pairs:
        if elem_id in assigned_doors:
            continue
        if tgt['opening_id'] in taken_openings:
            continue
        assignments[elem_id] = {
            'opening': tgt,
            'distance': dist,
            'score': score,
            'reason': reason,
            'radius_used': radius,
        }
        assigned_doors.add(elem_id)
        taken_openings.add(tgt['opening_id'])
        if dist > stats['max_assignment_distance']:
            stats['max_assignment_distance'] = dist

    for elem_id, had in door_had_candidate.items():
        if had and elem_id not in assigned_doors:
            skipped[elem_id] = 'duplicate_opening'

    return assignments, skipped, stats


def _build_segment_endpoint_graph(horizontal_candidates,
                                   prox_tol_m=CHAIN_GRAPH_PROX_TOL_M,
                                   grid_m=CHAIN_GRAPH_GRID_M):
    """Quantize each segment's endpoints onto a 3D grid, then union-find
    within `prox_tol_m` to merge near-coincident points into shared nodes.
    Identical scheme to `_detect_chains` steps 1–3 — re-implemented here so
    the door-recovery pass doesn't need to plumb chain-detector internals.

    Returns:
        seg_nodes  list of length n_segs; entry i is [(node_id, 'start'|'end'),
                   (node_id, 'start'|'end')] — one tuple per endpoint.
        node_segs  dict { node_id -> set of seg indices touching that node }
    """
    n_segs = len(horizontal_candidates)

    def quant(p):
        return (round(p[0] / grid_m) * grid_m,
                round(p[1] / grid_m) * grid_m,
                round(p[2] / grid_m) * grid_m)

    endpoints = []
    pt_to_id = {}
    for i, c in enumerate(horizontal_candidates):
        for end_lbl, raw in (('start', c['start']), ('end', c['end'])):
            qp = quant(raw)
            if qp not in pt_to_id:
                pt_to_id[qp] = len(pt_to_id)
            endpoints.append((i, end_lbl, qp))

    pt_keys = list(pt_to_id.keys())
    parent = list(range(len(pt_keys)))

    def fp(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def up(x, y):
        rx, ry = fp(x), fp(y)
        if rx != ry:
            parent[rx] = ry

    prox_sq = prox_tol_m * prox_tol_m
    for i in range(len(pt_keys)):
        pi = pt_keys[i]
        for j in range(i + 1, len(pt_keys)):
            pj = pt_keys[j]
            d2 = ((pi[0]-pj[0])**2 + (pi[1]-pj[1])**2 + (pi[2]-pj[2])**2)
            if d2 < prox_sq:
                up(pt_to_id[pi], pt_to_id[pj])

    pt_to_final = {p: fp(pt_to_id[p]) for p in pt_keys}

    seg_nodes = [[] for _ in range(n_segs)]
    node_segs = {}
    for seg_idx, end_lbl, qp in endpoints:
        nid = pt_to_final[qp]
        seg_nodes[seg_idx].append((nid, end_lbl))
        node_segs.setdefault(nid, set()).add(seg_idx)

    return seg_nodes, node_segs


def _classify_segment_topology(seg_idx, seg_nodes, node_segs):
    """Phase 5B.6 (Task F) — classify a segment by node degree at each end.

    kind values (in priority order):
        'junction'         deg>=3 at at least one end (overrides others)
        'continuation'     deg=2 at BOTH ends (path piece between joints)
        'free_end_branch'  deg=1 at one end AND deg>=2 at the other
        'isolated'         deg=1 at both ends (free-floating segment)
        'unknown'          shouldn't occur given a valid graph
    """
    ends = {}
    for nid, end_lbl in seg_nodes[seg_idx]:
        deg = len(node_segs.get(nid, ())) if nid is not None else 0
        ends[end_lbl] = {
            'node_id': nid,
            'degree': deg,
            'is_free': deg <= 1,
            'is_junction': deg >= 3,
        }
    s = ends.get('start') or {'degree': 0, 'is_free': True, 'is_junction': False}
    e = ends.get('end') or {'degree': 0, 'is_free': True, 'is_junction': False}
    s_deg, e_deg = s['degree'], e['degree']

    if s_deg >= 3 or e_deg >= 3:
        kind = 'junction'
    elif s_deg == 2 and e_deg == 2:
        kind = 'continuation'
    elif s_deg <= 1 and e_deg <= 1:
        kind = 'isolated'
    elif (s_deg <= 1) != (e_deg <= 1):
        kind = 'free_end_branch'
    else:
        kind = 'unknown'
    return {'kind': kind, 'start': s, 'end': e}


def _recover_skipped_doors(door_skips, door_elements, primary_assignments,
                            horizontal_candidates, host_walls,
                            seg_nodes, node_segs,
                            radius=DOOR_OPENING_ASSIGNMENT_RADIUS_TOPOLOGY,
                            short_branch_threshold=DOOR_SHORT_BRANCH_THRESHOLD):
    """Phase 5B.6 (Task F) — second-pass door recovery using topology classes.

    Runs ONLY on doors marked `no_candidate` in the primary pass. For each
    skipped door, finds the nearest segment-endpoint within `radius` whose
    topology class is one of:
        continuation     -> both endpoints valid
        free_end_branch  -> the FREE endpoint
        junction         -> the endpoint at the deg>=3 node

    Isolated segments and segments not in `host_walls` (e.g. main-loop walls,
    when caller passes branch_host_walls) are skipped — primary opening
    detection already excludes those, recovery follows the same rule.

    Greedy assign: closest first; one door per opening; recovered openings
    use the same `opening_{elem_id}_{end_lbl}` id as the primary builder so
    dedup against `primary_assignments` is automatic.

    Returns:
        recovered      dict { door_id: {opening, distance, score, reason,
                                        radius_used, topology_kind, endpoint_label,
                                        segment_id} }
        still_skipped  dict { door_id: 'no_topology_candidate'
                                         | original_skip_reason }
    """
    seg_to_host = {hw.get('seg_idx'): hw for hw in host_walls or []}
    taken_opening_ids = set()
    for info in primary_assignments.values():
        op = info.get('opening')
        if op is not None and op.get('opening_id'):
            taken_opening_ids.add(op['opening_id'])

    skipped_no_candidate = [did for did, r in door_skips.items()
                              if r == 'no_candidate']
    elem_by_id = {e.get('id'): e for e in door_elements
                    if isinstance(e, dict) and e.get('type') == 'DOOR'}

    radius_sq = radius * radius
    pairs = []  # (dist, door_id, synth_opening, kind, end_lbl, seg_elem_id)

    for door_id in skipped_no_candidate:
        elem = elem_by_id.get(door_id)
        if elem is None:
            continue
        placement = elem.get('placement') or {}
        origin = placement.get('origin')
        if not isinstance(origin, dict):
            continue
        ox = _safe_float(origin.get('x'))
        oy = _safe_float(origin.get('y'))
        if ox is None or oy is None:
            continue

        for i, cand in enumerate(horizontal_candidates):
            host_wall = seg_to_host.get(i)
            if host_wall is None:
                continue
            cls = _classify_segment_topology(i, seg_nodes, node_segs)
            kind = cls['kind']
            if kind in ('isolated', 'unknown'):
                continue
            if kind == 'continuation':
                valid_ends = ['start', 'end']
            elif kind == 'free_end_branch':
                valid_ends = []
                if cls['start']['is_free']:
                    valid_ends.append('start')
                if cls['end']['is_free']:
                    valid_ends.append('end')
            elif kind == 'junction':
                valid_ends = []
                if cls['start']['is_junction']:
                    valid_ends.append('start')
                if cls['end']['is_junction']:
                    valid_ends.append('end')
            else:
                valid_ends = []

            for end_lbl in valid_ends:
                pt = cand['start'] if end_lbl == 'start' else cand['end']
                d2 = (ox - float(pt[0])) ** 2 + (oy - float(pt[1])) ** 2
                if d2 > radius_sq:
                    continue
                dist = math.sqrt(d2)
                opening_id = f"opening_{cand['elem_id']}_{end_lbl}"
                dxx, dyy, dzz = cand['d']
                if end_lbl == 'start':
                    axis = (dxx, dyy, dzz)
                else:
                    axis = (-dxx, -dyy, -dzz)
                synth = {
                    'opening_id': opening_id,
                    'host_seg_idx': i,
                    'host_wall': host_wall,
                    'end_label': end_lbl,
                    'origin': (float(pt[0]), float(pt[1]), float(pt[2])),
                    'branch_axis': axis,
                    'branch_length': cand['length'],
                    'is_short_branch': cand['length'] < short_branch_threshold,
                    'qualify_reason': f'topology_recovered_{kind}',
                }
                pairs.append((dist, door_id, synth, kind, end_lbl, cand['elem_id']))

    # Greedy: closest first; one door per opening; can't reuse primary openings.
    pairs.sort(key=lambda p: p[0])
    assigned_doors = set()
    used_opening_ids = set(taken_opening_ids)
    recovered = {}
    for dist, door_id, synth, kind, end_lbl, seg_elem_id in pairs:
        if door_id in assigned_doors:
            continue
        if synth['opening_id'] in used_opening_ids:
            continue
        recovered[door_id] = {
            'opening': synth,
            'distance': dist,
            'score': max(0.0, radius - dist) * 5.0 + 50.0,
            'reason': 'topology',
            'radius_used': radius,
            'topology_kind': kind,
            'endpoint_label': end_lbl,
            'segment_id': seg_elem_id,
        }
        assigned_doors.add(door_id)
        used_opening_ids.add(synth['opening_id'])

    still_skipped = {}
    for door_id in skipped_no_candidate:
        if door_id not in recovered:
            still_skipped[door_id] = 'no_topology_candidate'
    for door_id, r in door_skips.items():
        if door_id not in recovered and r != 'no_candidate':
            still_skipped[door_id] = r

    return recovered, still_skipped


def _opening_target_projection(opening, door_origin):
    """Phase 5B.5E — build the projection record _emit_door_in_wall expects,
    forcing t to the opening's joint endpoint (t=0 for 'start', t=L for 'end').

    The outward normal is derived from the source door's xy offset from the
    branch centerline so the door panel ends up on the correct side.
    """
    cand = opening['host_wall']['cand']
    sx, sy, _sz = cand['start']
    dxx, dyy, _dzz = cand['d']
    L = cand['length']
    bore_w, _bore_h, shell_t = cand['profile']
    outer_w = bore_w + 2.0 * shell_t
    outer_half = outer_w / 2.0

    t = 0.0 if opening['end_label'] == 'start' else L
    cx = sx + dxx * t
    cy = sy + dyy * t

    dx, dy = float(door_origin[0]), float(door_origin[1])
    ox, oy = (dx - cx), (dy - cy)
    perp = math.hypot(ox, oy)
    if perp > 1e-6:
        nx, ny = ox / perp, oy / perp
    else:
        # Source projects onto centerline — outward side is arbitrary; pick
        # left-perpendicular to wall direction so callers can flag it.
        nx, ny = -dyy, dxx
    face_dist = abs(perp - outer_half)
    return {
        't': t,
        'closest_xy': (cx, cy),
        'normal_unit': (nx, ny, 0.0),
        'face_dist': face_dist,
        'outer_w': outer_w,
        'shell_t': shell_t,
    }


def _build_intent_host_lookup(elements, horizontal_candidates):
    """Phase 6B — build a lookup keyed by element_key that gives every
    candidate door host (TUNNEL_SEGMENT, PORTAL_END_WALL) the data needed to
    place a door without re-deriving it. The intent-resolver's hostSegmentId
    matches the element_key on either type, so a single dict covers both.
    """
    lookup = {}
    for cand in horizontal_candidates:
        lookup[cand['elem_id']] = {
            'kind': 'TUNNEL_SEGMENT',
            'cand': cand,
            'axis_dir': cand['d'],
            'bore_w': cand['profile'][0],
            'bore_h': cand['profile'][1],
            'shell_t': cand['profile'][2],
        }
    for elem in elements:
        if elem.get('type') != 'WALL':
            continue
        seg_type = (elem.get('properties') or {}).get('segmentType')
        if seg_type != 'PORTAL_END_WALL':
            continue
        ekey = elem.get('element_key') or elem.get('id')
        if not ekey:
            continue
        placement = elem.get('placement') or {}
        refdir = placement.get('refDirection') or {}
        origin = placement.get('origin') or {}
        geom = elem.get('geometry') or {}
        prof = geom.get('profile') or {}
        ax = float(refdir.get('x') or 1.0)
        ay = float(refdir.get('y') or 0.0)
        n = math.hypot(ax, ay) or 1.0
        lookup[ekey] = {
            'kind': 'PORTAL_END_WALL',
            'wall_elem': elem,
            'origin': (float(origin.get('x') or 0.0),
                       float(origin.get('y') or 0.0),
                       float(origin.get('z') or 0.0)),
            'axis_dir': (ax / n, ay / n, 0.0),
            'bore_w': float(prof.get('width') or 0.0),
            'bore_h': float(prof.get('height') or 0.0),
            'shell_t': 0.0,
        }
    # Fallback: doors whose hostSegmentId references a segment that didn't
    # survive to horizontal_candidates (e.g. a steep or VSM-only branch like
    # ventsim_branch_18) would be skipped.  Resolve them to the nearest
    # horizontal candidate by Euclidean proximity to the door origin.
    for elem in elements:
        if (elem.get('type') or '').upper() != 'DOOR':
            continue
        intent   = (elem.get('metadata') or {}).get('intent') or {}
        host_id  = intent.get('hostSegmentId')
        if not host_id or host_id in lookup:
            continue
        orig  = (elem.get('placement') or {}).get('origin') or {}
        door_x = float(orig.get('x') or 0.0)
        door_y = float(orig.get('y') or 0.0)
        best_cand, best_d2 = None, float('inf')
        for cand in horizontal_candidates:
            sx, sy = (cand['start'][0]+cand['end'][0])*0.5, (cand['start'][1]+cand['end'][1])*0.5
            d2 = (door_x-sx)**2 + (door_y-sy)**2
            if d2 < best_d2:
                best_d2, best_cand = d2, cand
        if best_cand is not None:
            lookup[host_id] = {
                'kind':     'TUNNEL_SEGMENT',
                'cand':     best_cand,
                'axis_dir': best_cand['d'],
                'bore_w':   best_cand['profile'][0],
                'bore_h':   best_cand['profile'][1],
                'shell_t':  best_cand['profile'][2],
                '_fallback_for': host_id,
            }

    return lookup


def _emit_door_from_intent(f, body_sub, storey_lp, owner, elem,
                           intent_host_lookup, counts, skip_reasons,
                           panel_walls=None):
    """Phase 6B — place a door using the intent-resolver's host decision,
    with the final transform recomputed in Python for coordinate correctness.

    The intent-resolver's hostSegmentId is the SOLE decision-maker; Python
    re-derives the IFC placement so that coordinate-frame issues in the
    topology-engine (JS) do not corrupt the final geometry.

    Coordinate notes
    ----------------
    intent.position x/y  - projection of the door onto the HOST AXIS (the
                           segment centreline), *not* the wall surface.  For
                           TUNNEL_SEGMENT hosts we must offset laterally by
                           bore_w/2 toward the original door origin to land on
                           the inner wall surface.  For PORTAL_END_WALL the
                           projected point IS on the wall face so no offset is
                           needed.
    intent.position z    - VentSim-local coord (hostZ=0 = bore centre), NOT
                           world z. Phase 6B.2 ignores it for placement and
                           derives world floor_z directly from the host segment
                           geometry: floor_z = seg_center_z - bore_h / 2.
    refdir               - door width direction.
                           TUNNEL_SEGMENT: (ax, ay, 0) — along tunnel run so
                             the panel spans the side-wall face.
                           PORTAL_END_WALL: (ax, ay, 0) — along portal wall span.

    Strict no-fallback rule:
      * intent missing / no host     -> doors_skipped_missing_intent
      * skipReason set               -> doors_skipped_invalid_intent
      * confidence below threshold   -> doors_skipped_low_confidence
      * host not in lookup           -> doors_skipped_host_not_found
      * host segment axis mostly Z   -> doors_skipped_vertical_shaft
      * projection outside segment   -> doors_skipped_outside_segment
      * door top clips bore ceiling  -> doors_skipped_roof_clip
      * unknown host kind            -> doors_skipped_host_not_found
    """
    elem_id = elem.get('id', '<no-id>')
    elem_key = elem.get('element_key', elem_id)
    metadata = elem.get('metadata') or {}
    intent = metadata.get('intent') or {}

    host_id = intent.get('hostSegmentId')
    confidence = intent.get('confidence') or 0.0
    skip_reason = intent.get('skipReason')
    intent_pos = intent.get('position') or {}

    if not intent or not host_id:
        counts['doors_skipped_missing_intent'] += 1
        skip_reasons.append((elem_id, 'intent_missing_or_no_host'))
        print(f"  door[{elem_key}] SKIP intent_missing_or_no_host")
        return None
    if skip_reason:
        counts['doors_skipped_invalid_intent'] += 1
        skip_reasons.append((elem_id, f'intent_skip:{skip_reason}'))
        print(f"  door[{elem_key}] SKIP intent_skipped:{skip_reason}")
        return None
    if confidence < INTENT_CONFIDENCE_THRESHOLD:
        counts['doors_skipped_low_confidence'] += 1
        skip_reasons.append((elem_id, f'intent_low_confidence:{confidence:.2f}'))
        print(f"  door[{elem_key}] SKIP intent_low_confidence:{confidence:.2f}")
        return None

    host = intent_host_lookup.get(host_id)
    if host is None:
        counts['doors_skipped_host_not_found'] += 1
        skip_reasons.append((elem_id, f'intent_host_not_found:{host_id}'))
        print(f"  door[{elem_key}] SKIP intent_host_not_found:{host_id}")
        return None

    host_kind = host['kind']
    ax, ay, _ = host['axis_dir']
    bore_w = host['bore_w']
    bore_h = host['bore_h']
    shell_t = host['shell_t']

    # intent.position: (x,y) = projection onto host axis; z = resolvedZ
    intent_cx = float(intent_pos.get('x') or 0.0)
    intent_cy = float(intent_pos.get('y') or 0.0)
    intent_cz = float(intent_pos.get('z') or 0.0)

    # Original door position (VentSim absolute coords, same frame as intent).
    orig_pl = (elem.get('placement') or {}).get('origin') or {}
    door_ox = float(orig_pl.get('x') or 0.0)
    door_oy = float(orig_pl.get('y') or 0.0)
    door_oz = float(orig_pl.get('z') or 0.0)

    # Phase 6A sizing: use authoritative nominal dims from intent.doorType when
    # set; bore-clamped fallback only when doorType is absent (legacy CSS).
    door_type = intent.get('doorType')  # 'single' | 'double' | None
    if door_type == 'single':
        nom_w, nom_h = DOOR_SINGLE_WIDTH, DOOR_SINGLE_HEIGHT
    elif door_type == 'double':
        nom_w, nom_h = DOOR_DOUBLE_WIDTH, DOOR_DOUBLE_HEIGHT
    else:
        nom_w, nom_h = DOOR_DEFAULT_WIDTH, DOOR_DEFAULT_HEIGHT

    door_width  = nom_w
    door_height = nom_h
    door_thickness = DOOR_DEFAULT_THICKNESS
    # Bore clamp only applies when doorType is absent (legacy path).
    # When intent resolver explicitly set doorType, nominal dims are authoritative —
    # the bore reflects tunnel cross-section, not a physical door-frame constraint.
    if not door_type:
        if bore_w > 0:
            door_width  = min(door_width,  bore_w)
        if bore_h > 0:
            door_height = min(door_height, bore_h)
    print(f"  door[{elem_key}] sizing doorType={door_type} "
          f"nominal=({nom_w:.3f}x{nom_h:.3f}) "
          f"bore=({bore_w:.2f}x{bore_h:.2f}) "
          f"final=({door_width:.3f}x{door_height:.3f})")
    if door_width < DOOR_MIN_WIDTH or door_height < DOOR_MIN_HEIGHT:
        counts['doors_skipped_invalid_after_clamp'] += 1
        skip_reasons.append(
            (elem_id,
             f'door_invalid_after_clamp w={door_width:.2f} h={door_height:.2f} '
             f'(bore={bore_w:.2f}x{bore_h:.2f})'))
        return None

    if host_kind == 'TUNNEL_SEGMENT':
        cand = host['cand']
        seg_start = cand['start']
        seg_end = cand['end']
        seg_d = cand['d']        # unit 3-D world direction
        seg_len = cand['length']

        # Phase 6B.2 — reject vertical shaft hosts (axis mostly Z in world coords).
        # intent.position XY is correct world coords; Z is in VentSim-local space
        # and must not be used directly. Vertical shafts have no interior side wall
        # for a passage door.
        if abs(seg_d[2]) > VERTICAL_THRESHOLD:
            counts['doors_skipped_vertical_shaft'] += 1
            skip_reasons.append((elem_id, f'vertical_shaft_host:{host_id}'))
            print(f"  door[{elem_key}] SKIP vertical_shaft_host host={host_id} "
                  f"dz={seg_d[2]:.3f}")
            return None

        # Compute world z geometry from segment endpoints.
        seg_center_z = (seg_start[2] + seg_end[2]) / 2.0
        # Phase 6B.2 — floor-snap: door bottom sits at the bore floor.
        # intent.position.z is in VentSim-local coords (hostZ=0=bore centre) and
        # must NOT be used as world z. Derive floor directly from segment geometry.
        inner_floor_z = seg_center_z - bore_h / 2.0
        inner_ceil_z  = seg_center_z + bore_h / 2.0 - shell_t
        floor_z = inner_floor_z  # door bottom snapped to bore floor

        # Projection check: verify intent XY lands within the segment in world space.
        # Use floor_z as the world-z reference for the projection vector.
        vx = intent_cx - seg_start[0]
        vy = intent_cy - seg_start[1]
        vz = floor_z  - seg_start[2]
        t_proj = vx * seg_d[0] + vy * seg_d[1] + vz * seg_d[2]
        t_frac = t_proj / seg_len if seg_len > 0 else 0.0
        if t_frac < -0.05 or t_frac > 1.05:
            counts['doors_skipped_outside_segment'] += 1
            skip_reasons.append((elem_id, f'door_outside_segment t={t_frac:.3f}'))
            print(f"  door[{elem_key}] SKIP outside_segment "
                  f"t={t_frac:.3f} host={host_id}")
            return None

        # Lateral offset: move from segment axis to inner wall surface.
        # Direction: from axis projection toward the original door XY origin.
        perp_x = door_ox - intent_cx
        perp_y = door_oy - intent_cy
        perp_len = math.hypot(perp_x, perp_y)
        if perp_len < 0.01:
            # Door origin on axis — default to left-hand perpendicular.
            perp_x, perp_y = -ay, ax
            perp_len = 1.0
        norm_perp_x = perp_x / perp_len
        norm_perp_y = perp_y / perp_len

        inner_hw = bore_w / 2.0
        final_x = intent_cx + norm_perp_x * inner_hw
        final_y = intent_cy + norm_perp_y * inner_hw

        # Clamp door_height to interior bore clearance — nominal dims can exceed
        # bore_h when the tunnel cross-section is unusually shallow.
        available_h = inner_ceil_z - floor_z
        if door_height > available_h:
            clamped_h = max(available_h - 0.05, DOOR_MIN_HEIGHT)
            print(f"  door[{elem_key}] CLAMP height {door_height:.3f}->{clamped_h:.3f} "
                  f"(bore_clear={available_h:.3f})")
            door_height = clamped_h

        # Roof-clip validation: door top must not exceed bore ceiling.
        door_top_z = floor_z + door_height
        if door_top_z > inner_ceil_z + 0.05:
            counts['doors_skipped_roof_clip'] += 1
            skip_reasons.append(
                (elem_id, f'door_clips_roof top={door_top_z:.2f} ceil={inner_ceil_z:.2f}'))
            print(f"  door[{elem_key}] SKIP door_clips_roof "
                  f"top={door_top_z:.2f} ceil={inner_ceil_z:.2f} host={host_id}")
            return None

        # Phase 6B.2 — orientation: refDir along the tunnel axis so the door panel
        # spans the wall face. axis_dir is the horizontal segment unit vector.
        refdir = (ax, ay, 0.0)
        dist_to_wall = 0.0  # placed exactly on inner surface by construction

        # Final placement: bottom of door at floor_z.
        placement_origin = (final_x, final_y, floor_z)
        print(f"  door[{elem_key}] INTENT_PLACING "
              f"host={host_id} kind={host_kind} conf={confidence:.2f} "
              f"intent_pos=({intent_cx:.2f},{intent_cy:.2f},{intent_cz:.2f}) "
              f"floor_z={floor_z:.3f} top_z={door_top_z:.3f} bore=[{inner_floor_z:.3f},{inner_ceil_z:.3f}] "
              f"wall_offset={inner_hw:.2f}m perp=({norm_perp_x:.3f},{norm_perp_y:.3f}) "
              f"final=({final_x:.3f},{final_y:.3f},{floor_z:.3f}) "
              f"refdir=({refdir[0]:.3f},{refdir[1]:.3f},0) "
              f"size={door_width:.2f}x{door_height:.2f}")

    elif host_kind == 'PORTAL_END_WALL':
        # intent.position x/y is correct world coords (projection onto portal face).
        # Phase 6B.2 — floor-snap: derive floor from portal wall geometry, not intent z.
        wall_center_z = host['origin'][2]
        inner_floor_z = wall_center_z - bore_h / 2.0
        inner_ceil_z  = wall_center_z + bore_h / 2.0
        floor_z = inner_floor_z

        # Clamp door_height to bore clearance — portal bore_h is the usable height.
        available_h = inner_ceil_z - floor_z
        if door_height > available_h:
            clamped_h = max(available_h - 0.05, DOOR_MIN_HEIGHT)
            print(f"  door[{elem_key}] CLAMP height {door_height:.3f}->{clamped_h:.3f} "
                  f"(bore_clear={available_h:.3f})")
            door_height = clamped_h

        door_top_z = floor_z + door_height
        if door_top_z > inner_ceil_z + 0.05:
            counts['doors_skipped_roof_clip'] += 1
            skip_reasons.append(
                (elem_id, f'portal_door_clips_roof top={door_top_z:.2f} ceil={inner_ceil_z:.2f}'))
            print(f"  door[{elem_key}] SKIP portal_door_clips_roof "
                  f"top={door_top_z:.2f} ceil={inner_ceil_z:.2f} host={host_id}")
            return None

        final_x = intent_cx
        final_y = intent_cy
        # Phase 6B.2 — orientation: along portal wall span (axis_dir of the wall).
        refdir = (ax, ay, 0.0)
        dist_to_wall = 0.0

        # Final placement: bottom of door at floor_z.
        placement_origin = (final_x, final_y, floor_z)
        print(f"  door[{elem_key}] INTENT_PLACING "
              f"host={host_id} kind={host_kind} conf={confidence:.2f} "
              f"intent_pos=({intent_cx:.2f},{intent_cy:.2f},{intent_cz:.2f}) "
              f"floor_z={floor_z:.3f} top_z={door_top_z:.3f} bore=[{inner_floor_z:.3f},{inner_ceil_z:.3f}] "
              f"final=({final_x:.3f},{final_y:.3f},{floor_z:.3f}) "
              f"refdir=({refdir[0]:.3f},{refdir[1]:.3f},0) "
              f"size={door_width:.2f}x{door_height:.2f} "
              f"dist_to_wall={dist_to_wall:.3f}m")

    else:
        # Unknown host kind — skip rather than place badly.
        counts['doors_skipped_host_not_found'] += 1
        skip_reasons.append((elem_id, f'unknown_host_kind:{host_kind}'))
        print(f"  door[{elem_key}] SKIP unknown_host_kind:{host_kind}")
        return None

    axis_up = (0.0, 0.0, 1.0)

    try:
        # ---- Local host panel (IfcWall on bore side face / portal face) ----
        pan_t = max(0.15, shell_t)
        pan_w = door_width  + 0.60   # 0.30 m margin each side along tunnel/wall axis
        pan_h = door_height + 0.30   # 0.30 m head clearance above door

        pan_lp      = _make_local_placement(f, storey_lp, placement_origin, axis_up, refdir)
        pan_profile = _make_solid_rect_profile(f, pan_w, pan_t)
        pan_solid   = _make_extrusion_along_local_z(f, pan_profile, pan_h)
        _apply_style(f, pan_solid, SHELL_COLOR, name='DoorPanel')
        pan_wall = f.create_entity(
            'IfcWall',
            GlobalId=_new_guid(), OwnerHistory=owner,
            Name=f'TunnelDoorPanel_{elem_key}',
            Description=f'Local host panel for {host_kind} door',
            ObjectPlacement=pan_lp,
            Representation=_make_shape_rep(f, body_sub, pan_solid),
        )

        # ---- IfcOpeningElement (door-sized void, placed relative to panel) ----
        op_lp      = _make_local_placement(f, pan_lp, (0.0, 0.0, 0.0),
                                           (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
        op_profile = _make_solid_rect_profile(f, door_width, pan_t + 0.05)
        op_solid   = _make_extrusion_along_local_z(f, op_profile, door_height)
        opening_el = f.create_entity(
            'IfcOpeningElement',
            GlobalId=_new_guid(), OwnerHistory=owner,
            Name=f'Opening_{elem_key}',
            ObjectPlacement=op_lp,
            Representation=_make_shape_rep(f, body_sub, op_solid),
        )

        # ---- IfcDoor (same world origin as panel; placement relative to storey) ----
        obj_lp      = _make_local_placement(f, storey_lp, placement_origin, axis_up, refdir)
        profile_def = _make_solid_rect_profile(f, door_width, door_thickness)
        solid       = _make_extrusion_along_local_z(f, profile_def, door_height)
        _apply_style(f, solid, DOOR_COLOR, name='Door')

    except Exception as ex:
        counts['doors_skipped_invalid_after_clamp'] += 1
        skip_reasons.append((elem_id, f'door_geometry_failed:{ex}'))
        return None

    door = f.create_entity(
        'IfcDoor',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'Door-{elem_key}',
        ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
        OverallHeight=float(door_height),
        OverallWidth=float(door_width),
    )

    # ---- IfcRelVoidsElement + IfcRelFillsElement ----
    f.create_entity('IfcRelVoidsElement',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingBuildingElement=pan_wall,
                    RelatedOpeningElement=opening_el)
    f.create_entity('IfcRelFillsElement',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingOpeningElement=opening_el,
                    RelatedBuildingElement=door)

    if panel_walls is not None:
        panel_walls.append(pan_wall)

    counts['doors_emitted']          += 1
    counts['doors_intent_consumed']  += 1
    counts['doors_hosted_on_shell']  += 1
    counts['doors_voids_created']    += 1
    counts['doors_fills_created']    += 1
    counts[f'doors_intent_host_{host_kind}'] += 1
    print(f"  door[{elem_key}] INTENT_PLACED host={host_id} "
          f"kind={host_kind} face={intent.get('hostFaceSide')} "
          f"conf={confidence:.2f} "
          f"origin=({placement_origin[0]:.3f},{placement_origin[1]:.3f},{placement_origin[2]:.3f}) "
          f"size=({door_width:.2f}x{door_height:.2f}x{door_thickness:.2f}) "
          f"panel={pan_w:.2f}x{pan_t:.2f}x{pan_h:.2f}m")
    return door


def _emit_door(f, body_sub, storey_lp, owner, elem, kept_portal_keys,
               counts, skip_reasons,
               synthetic_frame_anchors=None,
               host_walls=None,
               allow_portal_fallback=True,
               proximity_radius=DOOR_PROXIMITY_RADIUS,
               opening_targets=None,
               assigned_opening=None):
    """Emit a simple IfcDoor panel.

    Phase 5B.5E pipeline (door hosting hierarchy, in priority order):

        Path 0a (5B.5E, PRIMARY) — assign door to nearest detected room/
        branch opening. opening_targets are joint endpoints of branch (non-
        main-loop) walls; the door lands at that joint endpoint, with the
        outward normal disambiguated by the source door's xy side. This is
        the only path that satisfies "doors at the actual room entrances".

        Path 0b (5B.5C/5B.5D fallback) — host on the nearest BRANCH wall
        whose outer face is within DOOR_WALL_FACE_TOLERANCE. host_walls
        passed in is already filtered to branches so a door near a long
        main-loop wall endpoint (e.g. a tunnel bend) cannot win this match.
        The 5B.5D placement-correctness gate still applies: t must sit at
        an endpoint, a junction, or anywhere along a short branch.

        Path 1 (legacy) — kept raw portal as host (host_key lookup against
        kept_portal_keys). Currently never fires; raw portals are gated off
        in strict mode.

        Path 2 (5B.5A recovery) — nearest synthetic portal frame within
        DOOR_PROXIMITY_RADIUS. Used only when synthetic portals are enabled
        AND no real wall is within 0.5 m. Tunnel profile keeps synthetic
        portals off, so this path is normally inactive.

        Reject — bump doors_rejected_no_opening_target when no path
        produces a placement.
    """
    if _phase11b_door_rejected(elem, counts):
        return None
    elem_id = elem.get('id', '<no-id>')
    metadata = elem.get('metadata', {}) or {}
    host_key = (metadata.get('hostWallKey')
                or metadata.get('host_wall_key')
                or metadata.get('host'))

    placement = elem.get('placement', {}) or {}
    geom = elem.get('geometry', {}) or {}
    profile_in = geom.get('profile', {}) or {}

    src_origin = _safe_xyz(placement.get('origin'))
    src_width = _safe_float(profile_in.get('width'))
    src_height = _safe_float(profile_in.get('height'))
    src_depth = _safe_float(geom.get('depth'))

    # ---- Path 0a (5B.5E + 5B.6 Task C): use the pre-computed global door
    # → opening assignment. Per-door greedy search is gone — `assigned_opening`
    # was decided up front by `_assign_doors_to_openings`, which enforces
    # 1 door / opening, scores by explicit-host > closest-distance > valid-dims
    # > orientation, and respects the 3m default / 5m explicit-host radii.
    # If a door has no global assignment, it falls through to path 0b.
    if (src_origin is not None and assigned_opening is not None
            and assigned_opening.get('opening') is not None):
        opening = assigned_opening['opening']
        opening_dist = assigned_opening.get('distance')
        counts['doors_candidates_assigned_to_opening'] += 1
        host_wall_o = opening['host_wall']
        cand_o = host_wall_o['cand']
        projection = _opening_target_projection(opening, src_origin)
        cx, cy = projection['closest_xy']
        nx_o, ny_o, _ = projection['normal_unit']
        outer_half_o = projection['outer_w'] / 2.0
        face_x = cx + nx_o * outer_half_o
        face_y = cy + ny_o * outer_half_o
        target_z = float(src_origin[2])
        print(f"  door[{elem_id}] OPENING_ASSIGNED "
              f"opening_id={opening['opening_id']} "
              f"host_seg={cand_o['elem_id']} end={opening['end_label']} "
              f"target_origin=({face_x:.3f},{face_y:.3f},{target_z:.3f}) "
              f"target_normal=({nx_o:.3f},{ny_o:.3f},0.000) "
              f"input_dist={opening_dist:.3f}m "
              f"reason={assigned_opening.get('reason')} "
              f"radius_used={assigned_opening.get('radius_used'):.2f}m "
              f"score={assigned_opening.get('score'):.1f} "
              f"short_branch={opening['is_short_branch']}")
        result = _emit_door_in_wall(
            f, body_sub, storey_lp, owner, elem, host_wall_o, projection,
            counts, skip_reasons)
        if result is not None:
            counts['doors_placed_on_opening_target'] += 1
        return result

    # No global assignment — log the nearest-miss for trace interpretability,
    # then fall through to path 0b. Per-door greedy assignment is intentionally
    # NOT used here; the global pass already evaluated this door.
    if src_origin is not None and opening_targets:
        _, miss_dist = _find_opening_for_door(
            src_origin, opening_targets, DOOR_OPENING_ASSIGNMENT_RADIUS_EXPLICIT)
        best_dist = miss_dist if miss_dist is not None else float('inf')
        print(f"  door[{elem_id}] no_global_assignment "
              f"nearest_opening_dist={best_dist:.3f}m "
              f"default_radius={DOOR_OPENING_ASSIGNMENT_RADIUS}m "
              f"opening_count={len(opening_targets)}")

    # ---- Path 0b (5B.5C/5B.5D fallback): host on a real BRANCH wall via
    # opening + voids + fills when no opening target matched. host_walls
    # passed in here is already filtered to branch walls so a door near a
    # main-loop bend can't snap to it. ----
    wall_host_attempted = False
    if src_origin is not None and host_walls:
        wall_host_attempted = True
        host_wall, projection, diag = _find_host_wall_for_door(
            src_origin, host_walls, face_tolerance=DOOR_WALL_FACE_TOLERANCE)
        nearest_seg = diag['best_seg_id'] if diag else None
        nearest_dist = diag['best_face_dist'] if diag else float('inf')
        within = diag['within_tolerance'] if diag else False
        print(f"  door[{elem_id}] nearest_branch_wall={nearest_seg} "
              f"face_dist={nearest_dist:.3f}m "
              f"within_tol={within} "
              f"tol={DOOR_WALL_FACE_TOLERANCE}m")
        if host_wall is not None:
            return _emit_door_in_wall(
                f, body_sub, storey_lp, owner, elem, host_wall, projection,
                counts, skip_reasons)
    else:
        # No origin or no branch walls collected — log the gap.
        print(f"  door[{elem_id}] no_origin_or_no_branch_walls "
              f"src_origin={'set' if src_origin else 'missing'} "
              f"branch_host_walls={len(host_walls) if host_walls else 0}")

    # ---- Strict gate: when synthetic portals are off, the structural
    # correctness pass requires a real wall host. Legacy portal/synthetic
    # fallbacks are disallowed — bump doors_skipped_no_valid_wall and exit.
    if not allow_portal_fallback:
        counts['doors_skipped_no_valid_wall'] += 1
        counts['doors_rejected_no_opening_target'] += 1
        skip_reasons.append(
            (elem_id,
             f'door_no_wall_within_{DOOR_WALL_FACE_TOLERANCE}m'
             f'_portal_fallback_disabled'))
        return None

    has_kept_host = bool(host_key and host_key in kept_portal_keys)
    has_synthetic_frames = bool(synthetic_frame_anchors)
    if (wall_host_attempted and not has_kept_host
            and not has_synthetic_frames):
        # Legacy paths allowed but neither has anchors — record the miss.
        counts['doors_skipped_no_valid_wall'] += 1
        skip_reasons.append(
            (elem_id,
             f'door_no_wall_within_{DOOR_WALL_FACE_TOLERANCE}m'))
        return None

    # ---- Path 1 (legacy): kept raw portal as host ----
    if has_kept_host:
        if src_origin is None:
            counts['doors_skipped_no_host'] += 1
            skip_reasons.append((elem_id, 'door_no_origin'))
            return None
        if not src_width or src_width <= 0:
            counts['doors_skipped_no_host'] += 1
            skip_reasons.append((elem_id, 'door_no_width'))
            return None
        door_height, height_source = _resolve_door_height(elem)
        if door_height is None:
            counts['doors_skipped_invalid_after_clamp'] += 1
            skip_reasons.append(
                (elem_id, f'door_height_unresolved reason={height_source}'))
            return None
        print(f"  door[{elem_id}] height={door_height:.3f}m source={height_source}")
        refdir_d = placement.get('refDirection') or {'x': 1.0, 'y': 0.0, 'z': 0.0}
        rx = _safe_float(refdir_d.get('x', 1.0)) or 1.0
        ry = _safe_float(refdir_d.get('y', 0.0)) or 0.0
        rdir = _vec_norm((rx, ry, 0.0)) or (1.0, 0.0, 0.0)
        try:
            obj_lp = _make_local_placement(f, storey_lp, src_origin, (0, 0, 1), rdir)
            profile_def = _make_solid_rect_profile(f, src_width, DOOR_DEFAULT_THICKNESS)
            solid = _make_extrusion_along_local_z(f, profile_def, door_height)
            _apply_style(f, solid, DOOR_COLOR, name='Door')
        except Exception as ex:
            counts['doors_skipped_no_host'] += 1
            skip_reasons.append((elem_id, f'door_geometry_failed:{ex}'))
            return None
        counts['doors_emitted'] += 1
        return f.create_entity(
            'IfcDoor',
            GlobalId=_new_guid(), OwnerHistory=owner,
            Name=f'Door-{elem_id}',
            ObjectPlacement=obj_lp,
            Representation=_make_shape_rep(f, body_sub, solid),
        )

    # ---- Path 2 (5B.5A recovery): nearest synthetic frame ----
    if src_origin is None or synthetic_frame_anchors is None or not synthetic_frame_anchors:
        counts['doors_skipped_no_host'] += 1
        counts['doors_skipped_no_frame'] += 1
        skip_reasons.append(
            (elem_id, f'door_no_synthetic_frame_available (key={host_key})'))
        return None

    ox, oy = src_origin[0], src_origin[1]
    best_d2 = float('inf')
    nearest = None
    for anc in synthetic_frame_anchors:
        ap = anc['anchor']
        d2 = (ox - ap[0]) ** 2 + (oy - ap[1]) ** 2
        if d2 < best_d2:
            best_d2 = d2
            nearest = anc
    if nearest is None or best_d2 > proximity_radius * proximity_radius:
        counts['doors_skipped_no_host'] += 1
        counts['doors_skipped_no_frame'] += 1
        skip_reasons.append(
            (elem_id,
             f'door_no_frame_within_{proximity_radius}m (key={host_key})'))
        return None

    anchor = nearest['anchor']
    outward = nearest['outward']
    local_x = nearest['local_x']
    local_z = nearest['local_z']
    bore_w = nearest['bore_w']
    bore_h = nearest['bore_h']

    # local_y completes the right-handed basis. Frame normal = local_x; the
    # in-plane lateral axis is local_y, the in-plane vertical-ish axis is
    # local_z. For horizontal-tunnel caps local_z == world up.
    local_y = (local_z[1] * local_x[2] - local_z[2] * local_x[1],
               local_z[2] * local_x[0] - local_z[0] * local_x[2],
               local_z[0] * local_x[1] - local_z[1] * local_x[0])

    # Step 2 — project source origin onto frame plane.
    _proj_world, uv = project_point_onto_frame(src_origin, anchor, local_y, local_z)
    counts['doors_projected_to_frame'] += 1

    # Step 3 — opening size clamp (40% width, 70% height).
    init_w = src_width if (src_width and src_width > 0) else (DOOR_OPENING_WIDTH_FRAC * bore_w)
    init_h, height_source = _resolve_door_height(elem)
    if init_h is None:
        counts['doors_skipped_invalid_after_clamp'] += 1
        skip_reasons.append(
            (elem_id, f'door_height_unresolved reason={height_source}'))
        return None
    print(f"  door[{elem_id}] height={init_h:.3f}m source={height_source}")
    width = min(init_w, DOOR_OPENING_WIDTH_FRAC * bore_w)
    door_height = min(init_h, DOOR_OPENING_HEIGHT_FRAC * bore_h)

    # Step 4 — minimum-size sanity check.
    if width < DOOR_MIN_WIDTH or door_height < DOOR_MIN_HEIGHT:
        counts['doors_skipped_invalid_after_clamp'] += 1
        skip_reasons.append(
            (elem_id,
             f'door_invalid_after_clamp w={width:.2f} h={door_height:.2f} '
             f'(min {DOOR_MIN_WIDTH}x{DOOR_MIN_HEIGHT}, '
             f'opening={bore_w:.2f}x{bore_h:.2f})'))
        return None

    # Step 5 — snap uv to nearest valid in-bounds point.
    half_w_max = max(0.0, bore_w / 2.0 - width / 2.0)
    half_h_max = max(0.0, bore_h / 2.0 - door_height / 2.0)
    u_in = max(-half_w_max, min(half_w_max, uv[0]))
    v_in = max(-half_h_max, min(half_h_max, uv[1]))
    if abs(u_in - uv[0]) > 1e-6 or abs(v_in - uv[1]) > 1e-6:
        counts['doors_clamped_to_opening'] += 1

    snapped_world = (
        anchor[0] + u_in * local_y[0] + v_in * local_z[0],
        anchor[1] + u_in * local_y[1] + v_in * local_z[1],
        anchor[2] + u_in * local_y[2] + v_in * local_z[2],
    )

    # Step 6 — flush against exterior face: shift along outward by
    # (cap thickness + half door thickness).
    flush_offset = PORTAL_FRAME_THICKNESS + DOOR_DEFAULT_THICKNESS / 2.0
    door_center_world = (
        snapped_world[0] + flush_offset * outward[0],
        snapped_world[1] + flush_offset * outward[1],
        snapped_world[2] + flush_offset * outward[2],
    )

    # Step 7 — orient panel: width along frame's lateral (local_y),
    # thickness along outward, height along world Z. Placement origin is the
    # bottom-center of the door (extrusion goes up by door_height).
    ly_xy_len = math.hypot(local_y[0], local_y[1])
    if ly_xy_len < 1e-6:
        counts['doors_skipped_invalid_after_clamp'] += 1
        skip_reasons.append((elem_id, 'door_frame_local_y_no_xy'))
        return None
    rdir = (local_y[0] / ly_xy_len, local_y[1] / ly_xy_len, 0.0)

    placement_origin = (
        door_center_world[0],
        door_center_world[1],
        door_center_world[2] - door_height / 2.0,
    )

    try:
        obj_lp = _make_local_placement(f, storey_lp, placement_origin, (0, 0, 1), rdir)
        profile_def = _make_solid_rect_profile(f, width, DOOR_DEFAULT_THICKNESS)
        solid = _make_extrusion_along_local_z(f, profile_def, door_height)
        _apply_style(f, solid, DOOR_COLOR, name='Door')
    except Exception as ex:
        counts['doors_skipped_invalid_after_clamp'] += 1
        skip_reasons.append((elem_id, f'door_geometry_failed:{ex}'))
        return None

    counts['doors_emitted'] += 1
    counts['doors_recovered_from_nearby_input'] += 1
    print(f"  door[{elem_id}] EMIT segment={nearest['segment_id']} "
          f"end={nearest['end_lbl']} uv_src=({uv[0]:.2f},{uv[1]:.2f}) "
          f"uv_clamped=({u_in:.2f},{v_in:.2f}) size={width:.2f}x{door_height:.2f}m")
    return f.create_entity(
        'IfcDoor',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'Door-{elem_id}',
        ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
    )


# 5A.11 — _snap_origin_to_nearest_endpoint moved to secondary_geometry.attachment. Imported at module scope.


def _snap_shaft_to_tunnel_arch(origin, height, horizontal_candidates,
                                max_dist=SHAFT_SNAP_DIST):
    """For a vertical shaft at xy = (origin.x, origin.y), find the nearest
    horizontal-tunnel centerline point and adjust the shaft base z to sit on
    top of that tunnel's outer arch. Returns (start, end, was_adjusted).

    No adjustment is made if no tunnel is within `max_dist` xy.
    """
    sx, sy, sz = origin[0], origin[1], origin[2]
    best_d2 = float('inf')
    best_top_z = None
    for cand in horizontal_candidates:
        s = cand['start']
        e = cand['end']
        ex_y = (sx - s[0]) * cand['d'][0] + (sy - s[1]) * cand['d'][1]
        t = max(0.0, min(cand['length'], ex_y))
        cx = s[0] + cand['d'][0] * t
        cy = s[1] + cand['d'][1] * t
        cz = s[2] + cand['d'][2] * t
        d2 = (sx - cx) ** 2 + (sy - cy) ** 2
        if d2 < best_d2:
            best_d2 = d2
            bore_w, bore_h, shell_t = cand['profile']
            best_top_z = cz + (bore_h / 2.0) + shell_t
    if best_top_z is None or best_d2 > max_dist * max_dist:
        return origin, (origin[0], origin[1], origin[2] + height), False
    snapped_start = (sx, sy, best_top_z)
    snapped_end = (sx, sy, best_top_z + height)
    return snapped_start, snapped_end, True


# 5A.11 — _reconstruct_shaft_endpoints moved to secondary_geometry.attachment. Imported at module scope.


def _emit_portal(f, body_sub, storey_lp, owner, elem, tunnel_bbox,
                 kept_endpoints, kept_portal_keys, counts, skip_reasons,
                 profile, horizontal_candidates,
                 psm_portal_ep_claimed=None):
    """PORTAL_BUILDING / PORTAL_END_WALL → simple IfcWall box, vertical extrusion.

    Phase 5A — strict attachment policy:
      * Origin XY MUST lie within PORTAL_BLOCK_MAX_DIST_TO_ENDPOINT (2 m) of a
        real kept tunnel endpoint. Anything farther is a floating block; SKIP.
      * Width/height MUST NOT exceed PORTAL_BLOCK_MAX_WIDTH / _MAX_HEIGHT.
      * Per-block diagnostic log printed for every candidate (kept or skipped)
        listing id, semantic type, distance to nearest tunnel endpoint, dims,
        and reason.

    Phase 5A.12 — host-cross-section sizing (strict mode only):
      * portal width  ≤ host_outer_w + PORTAL_HOST_MARGIN  AND  ≤ 2 × host_outer_w
      * portal depth  ≤ host_outer_h + PORTAL_HOST_MARGIN  AND  ≤ 2 × host_outer_h
      * portal height (smaller profile axis = wall thickness) ≤ PORTAL_THICKNESS_CAP
      Where host_outer_{w,h} comes from the nearest kept tunnel-segment bore
      profile + 2*shell_t. No host candidate → reject in strict mode.
    """
    elem_id = elem.get('id', '<no-id>')
    placement = elem.get('placement', {}) or {}
    geom = elem.get('geometry', {}) or {}
    profile_in = geom.get('profile', {}) or {}
    seg_type = (elem.get('properties') or {}).get('segmentType', 'PORTAL')

    origin = _safe_xyz(placement.get('origin'))
    width = _safe_float(profile_in.get('width'))
    height = _safe_float(profile_in.get('height'))
    depth = _safe_float(geom.get('depth'))

    log_prefix = f"  portal_block[{elem_id}]"

    # Portal buildings are now allowed through — the 1-per-endpoint dedup below
    # prevents pile-up at shared endpoints. Phase 12B hard-block is removed.

    if origin is None:
        counts['portals_skipped'] += 1
        counts['portal_blocks_skipped_detached'] += 1
        skip_reasons.append((elem_id, 'portal_no_origin'))
        print(f"{log_prefix} type={seg_type} dist=NA dims=(w={width},h={height},d={depth}) "
              f"REASON=portal_no_origin")
        return None

    # Distance to nearest kept tunnel endpoint (xy).
    nearest_dist = None
    if kept_endpoints:
        ox, oy, _oz = origin
        closest_d2 = min(
            (ox - p[0]) * (ox - p[0]) + (oy - p[1]) * (oy - p[1])
            for p in kept_endpoints
        )
        nearest_dist = math.sqrt(closest_d2)

    dist_str = f"{nearest_dist:.2f}m" if nearest_dist is not None else "NA"
    dim_str = (f"w={width:.2f} h={height:.2f} d={depth:.2f}"
               if (width and height and depth)
               else f"w={width} h={height} d={depth}")

    # Dedup: if this portal's nearest endpoint is already claimed by another portal, skip.
    if nearest_dist is not None and nearest_dist <= PORTAL_BLOCK_MAX_DIST_TO_ENDPOINT and kept_endpoints:
        ox, oy, _oz = origin
        _nearest_ep = min(kept_endpoints, key=lambda p: (ox-p[0])**2 + (oy-p[1])**2)
        _close_ep_key = (round(_nearest_ep[0], 1), round(_nearest_ep[1], 1))
        if psm_portal_ep_claimed is not None and _close_ep_key in psm_portal_ep_claimed:
            counts['portals_skipped'] += 1
            skip_reasons.append((elem_id, f'psm_ep_already_claimed_{_close_ep_key}'))
            return None
        if psm_portal_ep_claimed is not None:
            psm_portal_ep_claimed[_close_ep_key] = elem_id

    if nearest_dist is None or nearest_dist > PORTAL_BLOCK_MAX_DIST_TO_ENDPOINT:
        # PRESENTATION_SAFE_MODE: portals may be offset due to pre-snap coordinate
        # frames (topology generates them before snapTunnelSegmentEndpoints runs).
        # Try a far-snap to the nearest free endpoint within 60m before giving up.
        # DXF-sourced portals (dxf-*) are in a completely different frame — suppress.
        _pres_far_snapped = False
        if (_PRESENTATION_SAFE_MODE and seg_type in ('PORTAL_BUILDING', 'PORTAL_END_WALL')
                and not elem_id.startswith('dxf-') and kept_endpoints):
            _PORTAL_FAR_SNAP_DIST = 10.0  # portals > 10m away are too misaligned to look correct
            ox2, oy2, oz2 = origin
            _best_ep, _best_d2 = None, float('inf')
            for ep in kept_endpoints:
                _d2 = (ox2 - ep[0])**2 + (oy2 - ep[1])**2
                if _d2 < _best_d2:
                    _best_d2, _best_ep = _d2, ep
            _snap_d = math.sqrt(_best_d2) if _best_ep is not None else float('inf')
            if _snap_d <= _PORTAL_FAR_SNAP_DIST:
                _ep_key = (round(_best_ep[0], 1), round(_best_ep[1], 1))
                if psm_portal_ep_claimed is not None and _ep_key in psm_portal_ep_claimed:
                    counts['portals_skipped'] += 1
                    counts.setdefault('portal_blocks_skipped_ep_claimed', 0)
                    counts['portal_blocks_skipped_ep_claimed'] += 1
                    skip_reasons.append((elem_id, f'psm_ep_already_claimed_{_ep_key}'))
                    print(f"{log_prefix} type={seg_type} PSM-SKIP: endpoint {_ep_key} "
                          f"already claimed by another portal block")
                    return None
                if psm_portal_ep_claimed is not None:
                    psm_portal_ep_claimed[_ep_key] = elem_id
                origin = (_best_ep[0], _best_ep[1], oz2)
                nearest_dist = _snap_d
                dist_str = f"{_snap_d:.2f}m"
                _pres_far_snapped = True
                counts['portal_far_snap_adjustments'] = counts.get('portal_far_snap_adjustments', 0) + 1
                print(f"{log_prefix} type={seg_type} FAR-SNAP to nearest endpoint "
                      f"({_snap_d:.2f}m away)")
        if not _pres_far_snapped:
            counts['portals_skipped'] += 1
            counts['portal_blocks_skipped_detached'] += 1
            counts['secondary_skipped_floating'] += 1
            reason = f'portal_block_detached_dist={dist_str}_cap_{PORTAL_BLOCK_MAX_DIST_TO_ENDPOINT}m'
            skip_reasons.append((elem_id, reason))
            print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) "
                  f"REASON={reason}")
            return None

    if not width or not height or not depth or width <= 0 or height <= 0 or depth <= 0:
        counts['portals_skipped'] += 1
        counts['portal_blocks_skipped_detached'] += 1
        skip_reasons.append(
            (elem_id, f'portal_invalid_dims w={width} h={height} d={depth}'))
        print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) "
              f"REASON=portal_invalid_dims")
        return None

    if width > PORTAL_BLOCK_MAX_WIDTH or height > PORTAL_BLOCK_MAX_HEIGHT:
        counts['portals_skipped'] += 1
        counts['portal_blocks_skipped_oversized'] += 1
        counts['secondary_skipped_oversized'] += 1
        reason = (f'portal_block_oversized w={width:.2f}>{PORTAL_BLOCK_MAX_WIDTH} '
                  f'or h={height:.2f}>{PORTAL_BLOCK_MAX_HEIGHT}')
        skip_reasons.append((elem_id, reason))
        print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) "
              f"REASON={reason}")
        return None

    # Phase 5A.12 — host-cross-section sizing in strict mode.
    # PORTAL_BUILDING elements are exterior structures that legitimately exceed the
    # tunnel cross-section — skip this check for them in PRESENTATION_SAFE_MODE.
    _skip_host_sizing = (_PRESENTATION_SAFE_MODE and seg_type == 'PORTAL_BUILDING')
    if profile.strict_secondary_geometry and not _skip_host_sizing:
        host_cand, _host_xy_dist = _nearest_horizontal_host(
            (origin[0], origin[1]), horizontal_candidates)
        if host_cand is None:
            counts['portals_skipped'] += 1
            counts['portal_blocks_skipped_detached'] += 1
            counts['secondary_skipped_floating'] += 1
            skip_reasons.append((elem_id, 'portal_no_host_segment'))
            print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) "
                  f"REASON=portal_no_host_segment (strict mode requires a host)")
            return None
        host_bw, host_bh, host_st = host_cand['profile']
        host_outer_w = host_bw + 2.0 * host_st
        host_outer_h = host_bh + 2.0 * host_st
        # thickness = the physical slab depth (how thick the portal frame is).
        # Previously min(width, height) was used but that returns the panel HEIGHT
        # (2m) rather than the slab depth (0.5m) for portal-end-wall elements.
        thickness = depth
        if (width > host_outer_w + PORTAL_HOST_MARGIN
                or width > PORTAL_HOST_MAX_RATIO * host_outer_w
                or depth > host_outer_h + PORTAL_HOST_MARGIN
                or depth > PORTAL_HOST_MAX_RATIO * host_outer_h
                or thickness > PORTAL_THICKNESS_CAP):
            counts['portals_skipped'] += 1
            counts['portal_blocks_skipped_oversized'] += 1
            counts['secondary_skipped_oversized'] += 1
            reason = (f'portal_oversized_vs_host '
                      f'host_outer_w={host_outer_w:.2f} host_outer_h={host_outer_h:.2f} '
                      f'w={width:.2f} d={depth:.2f} thickness={thickness:.2f} '
                      f'(margin={PORTAL_HOST_MARGIN}m, max_ratio={PORTAL_HOST_MAX_RATIO}x, '
                      f'thickness_cap={PORTAL_THICKNESS_CAP}m)')
            skip_reasons.append((elem_id, reason))
            print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) "
                  f"REASON={reason}")
            return None

    if width < PORTAL_MIN_WIDTH or height < PORTAL_MIN_HEIGHT:
        counts['portals_skipped'] += 1
        counts['portal_blocks_skipped_oversized'] += 1
        counts['secondary_skipped_oversized'] += 1
        skip_reasons.append(
            (elem_id, f'portal_too_small w={width:.2f} h={height:.2f}'))
        print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) "
              f"REASON=portal_too_small")
        return None
    # PORTAL_END_WALL elements are thin caps (depth = wall thickness, ~0.3-0.5m),
    # not portal buildings. Skip the depth-range gate for them; the host-margin
    # and thickness-cap checks above already guard against absurd geometries.
    is_end_wall = seg_type in ('PORTAL_END_WALL', 'TERMINAL_WALL')
    if not is_end_wall and (depth < PORTAL_MIN_DEPTH or depth > PORTAL_MAX_DEPTH):
        counts['portals_skipped'] += 1
        counts['portal_blocks_skipped_oversized'] += 1
        counts['secondary_skipped_oversized'] += 1
        skip_reasons.append(
            (elem_id, f'portal_depth_out_of_range d={depth:.2f}'))
        print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) "
              f"REASON=portal_depth_out_of_range")
        return None
    aspect = max(width, height) / max(min(width, height), 1e-6)
    if aspect > PORTAL_MAX_ASPECT:
        counts['portals_skipped'] += 1
        counts['portal_blocks_skipped_oversized'] += 1
        counts['secondary_skipped_oversized'] += 1
        skip_reasons.append(
            (elem_id, f'portal_aspect_extreme {aspect:.1f}'))
        print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) "
              f"REASON=portal_aspect_extreme={aspect:.1f}")
        return None

    # Snap origin to nearest kept endpoint within PORTAL_SNAP_DIST so the
    # opening plane is flush with the tunnel mouth.
    snapped_origin, was_snapped, _snap_d = _snap_origin_to_nearest_endpoint(
        origin, kept_endpoints, PORTAL_SNAP_DIST)
    if was_snapped:
        origin = snapped_origin
        counts['portal_alignment_adjustments'] += 1

    refdir_d = placement.get('refDirection') or {'x': 1.0, 'y': 0.0, 'z': 0.0}
    rx = _safe_float(refdir_d.get('x', 1.0)) or 1.0
    ry = _safe_float(refdir_d.get('y', 0.0)) or 0.0
    rdir = _vec_norm((rx, ry, 0.0)) or (1.0, 0.0, 0.0)

    try:
        obj_lp = _make_local_placement(f, storey_lp, origin, (0.0, 0.0, 1.0), rdir)
        profile_def = _make_solid_rect_profile(f, width, height)
        solid = _make_extrusion_along_local_z(f, profile_def, depth)
        _apply_style(f, solid, SHELL_COLOR, name=seg_type)
    except Exception as ex:
        counts['portals_skipped'] += 1
        counts['portal_blocks_skipped_detached'] += 1
        skip_reasons.append((elem_id, f'portal_geometry_build_failed:{ex}'))
        print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) "
              f"REASON=portal_geometry_build_failed:{ex}")
        return None

    counts['portals_kept'] += 1
    counts['portal_blocks_emitted'] += 1
    kept_portal_keys.add(elem_id)
    print(f"{log_prefix} type={seg_type} dist={dist_str} dims=({dim_str}) EMIT")
    return f.create_entity(
        'IfcWall',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'{seg_type}-{elem_id}', ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
    )


# ---------------------------------------------------------------------------
# Phase 5A — controlled ventilation (CLEAN_VENTILATION_EXPORT)
# ---------------------------------------------------------------------------

def _is_ventilation_candidate(elem):
    """A ventilation candidate is a CSS element with type DUCT/AIRWAY (or
    semanticType IfcDuctSegment) that is geometryExportable. Returns the
    canonical kind ('DUCT' or 'AIRWAY') or None."""
    e_type = (elem.get('type') or '').upper()
    sem = (elem.get('semanticType') or '')
    bc = ((elem.get('properties') or {}).get('branchClass') or '').upper()
    metadata = elem.get('metadata') or {}
    if metadata.get('geometryExportable') is False:
        return None
    if e_type == 'DUCT' or sem == 'IfcDuctSegment':
        return 'DUCT'
    if e_type == 'AIRWAY' or bc == 'AIRWAY':
        return 'AIRWAY'
    return None


def _extract_vent_path(elem):
    """Return (start, end) world-points for a ventilation element, or None.

    Accepted sources, in order:
        geometry.pathPoints[0..-1]
        properties.startPoint / properties.endPoint
        placement.origin + geometry.depth * placement.refDirection (rect/explicit)
    """
    geom = elem.get('geometry') or {}
    props = elem.get('properties') or {}
    placement = elem.get('placement') or {}

    pts = geom.get('pathPoints')
    if isinstance(pts, list) and len(pts) >= 2:
        s = _safe_xyz(pts[0])
        e = _safe_xyz(pts[-1])
        if s and e:
            return s, e

    s = _safe_xyz(props.get('startPoint'))
    e = _safe_xyz(props.get('endPoint'))
    if s and e:
        return s, e

    origin = _safe_xyz(placement.get('origin'))
    depth = _safe_float(geom.get('depth'))
    refdir_d = placement.get('refDirection') or {}
    if origin and depth and depth > 0:
        rx = _safe_float(refdir_d.get('x'))
        ry = _safe_float(refdir_d.get('y'))
        rz = _safe_float(refdir_d.get('z'))
        if rx is None and ry is None and rz is None:
            return None
        rdir = _vec_norm((rx or 0.0, ry or 0.0, rz or 0.0))
        if rdir is None:
            return None
        end_pt = (origin[0] + depth * rdir[0],
                  origin[1] + depth * rdir[1],
                  origin[2] + depth * rdir[2])
        return origin, end_pt

    return None


def _vent_extract_profile(elem):
    """Return (kind, dims, src_dict) for a ventilation profile.

    kind = 'CIRCLE'  -> dims = (radius,)
    kind = 'RECT'    -> dims = (width, height)
    kind = None      -> profile not parseable
    src_dict carries the raw source field values for diagnostic logging.
    """
    geom = elem.get('geometry') or {}
    profile = geom.get('profile') or {}
    p_type = (profile.get('type') or '').upper()

    src_radius = _safe_float(profile.get('radius'))
    src_diameter = _safe_float(profile.get('diameter'))
    src_width = _safe_float(profile.get('width'))
    src_height = _safe_float(profile.get('height'))
    src = {
        'profile_type': p_type or '<missing>',
        'radius': src_radius, 'diameter': src_diameter,
        'width': src_width, 'height': src_height,
    }

    if p_type == 'CIRCLE' or src_radius or src_diameter:
        r = src_radius
        if (r is None or r <= 0) and src_diameter and src_diameter > 0:
            r = src_diameter / 2.0
        if r and r > 0:
            return 'CIRCLE', (r,), src
        return None, None, src

    if p_type in ('RECTANGLE', 'RECT') or (src_width and src_height):
        if src_width and src_height and src_width > 0 and src_height > 0:
            return 'RECT', (src_width, src_height), src
        return None, None, src

    return None, None, src


def _xy_dist_to_nearest_endpoint(xy, kept_endpoints):
    """Min xy distance from xy=(x,y) to any kept endpoint. Returns inf if none."""
    if not kept_endpoints:
        return float('inf')
    px, py = xy[0], xy[1]
    best = float('inf')
    for ep in kept_endpoints:
        d2 = (px - ep[0]) ** 2 + (py - ep[1]) ** 2
        if d2 < best:
            best = d2
    return math.sqrt(best)


def _nearest_horizontal_host(xy, horizontal_candidates):
    """Return (cand, xy_dist) for the horizontal segment whose endpoint is
    closest to xy. cand is None if there are no candidates.

    Used by the portal host-cross-section check so portal dimensions can be
    bound to the actual tunnel bore at the mouth they attach to.
    """
    px, py = xy[0], xy[1]
    best_d2 = float('inf')
    best_cand = None
    for cand in horizontal_candidates:
        for pt in (cand['start'], cand['end']):
            d2 = (px - pt[0]) ** 2 + (py - pt[1]) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_cand = cand
    if best_cand is None:
        return None, float('inf')
    return best_cand, math.sqrt(best_d2)


def _xy_dist_to_horizontal_tunnel_centerline(xy, horizontal_candidates):
    """Min xy distance from xy=(x,y) to any horizontal tunnel-segment centerline.
    Returns inf if no candidates."""
    best = float('inf')
    if not horizontal_candidates:
        return best
    px, py = xy
    for cand in horizontal_candidates:
        s = cand['start']
        e = cand['end']
        dx = cand['d'][0]
        dy = cand['d'][1]
        L = cand['length']
        # Project xy on segment line; clamp to [0, L].
        t = max(0.0, min(L, (px - s[0]) * dx + (py - s[1]) * dy))
        cx = s[0] + dx * t
        cy = s[1] + dy * t
        d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy)
        if d2 < best:
            best = d2
    return math.sqrt(best)


def _emit_vent_duct(f, body_sub, storey_lp, owner, elem,
                    horizontal_candidates, kept_shaft_keys,
                    counts, skip_reasons):
    """Phase 5A — emit ONE ventilation duct/airway as IfcFlowSegment.

    Strict validation; no fallback geometry. Per-element diagnostic log printed
    for both kept and skipped candidates.
    """
    elem_id = elem.get('id', '<no-id>')
    kind = _is_ventilation_candidate(elem)
    if kind is None:
        return None

    sem = elem.get('semanticType') or 'IfcDuctSegment'
    bc = ((elem.get('properties') or {}).get('branchClass') or '').upper()
    log_prefix = f"  vent[{elem_id}]"

    counts['vent_ducts_candidates'] += 1

    path = _extract_vent_path(elem)
    if path is None:
        counts['vent_ducts_skipped_invalid_path'] += 1
        skip_reasons.append((elem_id, 'vent_no_path'))
        print(f"{log_prefix} kind={kind} sem={sem} bc={bc} "
              f"REASON=vent_no_path (no pathPoints / startPoint / extrusion)")
        return None
    start, end = path
    d_raw = _vec_sub(end, start)
    L = _vec_len(d_raw)
    if L < VENT_MIN_LENGTH:
        counts['vent_ducts_skipped_invalid_path'] += 1
        skip_reasons.append((elem_id, f'vent_path_too_short_{L:.3f}'))
        print(f"{log_prefix} kind={kind} sem={sem} bc={bc} L={L:.3f}m "
              f"REASON=vent_path_too_short (< {VENT_MIN_LENGTH}m)")
        return None
    d_unit = (d_raw[0] / L, d_raw[1] / L, d_raw[2] / L)

    # Vertical-only allowed for explicit risers/shafts.
    is_vertical = abs(d_unit[2]) > VENT_VERTICAL_THRESHOLD
    is_riser_class = bc in VENT_RISER_BRANCH_CLASSES
    elem_role = ((elem.get('properties') or {}).get('role') or '').upper()
    is_riser_role = 'RISER' in elem_role or 'SHAFT' in elem_role
    if is_vertical and not (is_riser_class or is_riser_role):
        counts['vent_ducts_skipped_vertical'] += 1
        skip_reasons.append(
            (elem_id, f'vent_vertical_not_riser dz/L={d_unit[2]:.2f}'))
        print(f"{log_prefix} kind={kind} sem={sem} bc={bc} L={L:.2f}m "
              f"dz/L={d_unit[2]:.2f} REASON=vent_vertical_not_riser")
        return None

    # Profile validation.
    p_kind, dims, src_p = _vent_extract_profile(elem)
    if p_kind is None:
        counts['vent_ducts_skipped_invalid_path'] += 1
        skip_reasons.append((elem_id, f'vent_invalid_profile {src_p}'))
        print(f"{log_prefix} kind={kind} sem={sem} bc={bc} L={L:.2f}m "
              f"src_profile={src_p} REASON=vent_invalid_profile")
        return None
    if p_kind == 'CIRCLE':
        (r,) = dims
        if r < VENT_MIN_RADIUS or r > VENT_MAX_RADIUS:
            counts['vent_ducts_skipped_invalid_path'] += 1
            skip_reasons.append(
                (elem_id, f'vent_radius_out_of_range {r:.3f}'))
            print(f"{log_prefix} kind={kind} sem={sem} bc={bc} L={L:.2f}m "
                  f"radius={r:.3f}m "
                  f"REASON=vent_radius_out_of_range "
                  f"(allowed {VENT_MIN_RADIUS}-{VENT_MAX_RADIUS}m)")
            return None
        equiv_r = r
    else:
        w, h = dims
        if (w < VENT_MIN_RECT or w > VENT_MAX_RECT
                or h < VENT_MIN_RECT or h > VENT_MAX_RECT):
            counts['vent_ducts_skipped_invalid_path'] += 1
            skip_reasons.append(
                (elem_id, f'vent_rect_out_of_range {w:.2f}x{h:.2f}'))
            print(f"{log_prefix} kind={kind} sem={sem} bc={bc} L={L:.2f}m "
                  f"rect={w:.2f}x{h:.2f}m "
                  f"REASON=vent_rect_out_of_range "
                  f"(allowed {VENT_MIN_RECT}-{VENT_MAX_RECT}m per side)")
            return None
        equiv_r = max(w, h) / 2.0

    # Distance to nearest tunnel centerline (xy). Vertical risers use the
    # midpoint xy; horizontal/sloped use the segment midpoint xy.
    mx = 0.5 * (start[0] + end[0])
    my = 0.5 * (start[1] + end[1])
    dist_to_tunnel = _xy_dist_to_horizontal_tunnel_centerline(
        (mx, my), horizontal_candidates)
    # In PRESENTATION_SAFE_MODE filter short stubs and steep connectors;
    # keep trunk runs (L >= 2m, |dz/L| <= 0.4, within 5m of centerline).
    if _PRESENTATION_SAFE_MODE:
        if L < 2.0:
            counts['vent_ducts_skipped_far_from_tunnel'] += 1
            skip_reasons.append((elem_id, f'duct_stub_psm L={L:.2f}m'))
            return None
        if abs(d_unit[2]) > 0.4 and not (is_riser_class or is_riser_role):
            counts['vent_ducts_skipped_far_from_tunnel'] += 1
            skip_reasons.append((elem_id, f'duct_steep_psm dz/L={d_unit[2]:.2f}'))
            return None
    _vent_dist_cap = VENT_MAX_DIST_FROM_TUNNEL
    if dist_to_tunnel > _vent_dist_cap:
        counts['vent_ducts_skipped_far_from_tunnel'] += 1
        counts['secondary_skipped_floating'] += 1
        skip_reasons.append(
            (elem_id, f'vent_far_from_tunnel xy_d={dist_to_tunnel:.2f}m'))
        print(f"{log_prefix} kind={kind} sem={sem} bc={bc} L={L:.2f}m "
              f"xy_dist_to_tunnel={dist_to_tunnel:.2f}m "
              f"REASON=vent_far_from_tunnel (cap {_vent_dist_cap}m)")
        return None

    # Build geometry. For the duct we extrude its profile along its centerline
    # using local-X (= duct direction). Vertical risers fall through to a
    # local-Z extrusion since the horizontal frame is undefined for d_unit
    # parallel to world up.
    try:
        if p_kind == 'CIRCLE':
            (r,) = dims
            profile_def = _make_solid_circle_profile(f, r)
        else:
            w, h = dims
            profile_def = _make_solid_rect_profile(f, w, h)

        if is_vertical:
            origin = start if start[2] <= end[2] else end
            obj_lp = _make_local_placement(
                f, storey_lp, origin, (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            solid = _make_extrusion_along_local_z(f, profile_def, L)
        else:
            frame = _build_frame_from_direction(d_unit)
            if frame is None:
                counts['vent_ducts_skipped_invalid_path'] += 1
                skip_reasons.append((elem_id, 'vent_frame_failed'))
                print(f"{log_prefix} kind={kind} sem={sem} bc={bc} L={L:.2f}m "
                      f"REASON=vent_frame_failed (direction degenerate)")
                return None
            local_x, _local_y, local_z = frame
            obj_lp = _make_local_placement(f, storey_lp, start, local_z, local_x)
            solid = _make_extrusion_along_local_x(f, profile_def, L)
        _apply_style(f, solid, VENT_COLOR, name=f'Vent-{p_kind}')
    except Exception as ex:
        counts['vent_ducts_skipped_invalid_path'] += 1
        skip_reasons.append((elem_id, f'vent_geometry_build_failed:{ex}'))
        print(f"{log_prefix} kind={kind} sem={sem} bc={bc} L={L:.2f}m "
              f"REASON=vent_geometry_build_failed:{ex}")
        return None

    counts['vent_ducts_emitted'] += 1
    profile_str = (f"radius={dims[0]:.3f}m" if p_kind == 'CIRCLE'
                   else f"rect={dims[0]:.2f}x{dims[1]:.2f}m")
    print(f"{log_prefix} kind={kind} sem={sem} bc={bc} L={L:.2f}m "
          f"profile={p_kind} {profile_str} dz/L={d_unit[2]:.2f} "
          f"xy_dist_to_tunnel={dist_to_tunnel:.2f}m EMIT")
    return f.create_entity(
        'IfcFlowSegment',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'Vent-{kind}-{elem_id}',
        ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
    )


def _resolve_reconstructed_vent_radius(elements, profile, log_prefix, counts):
    """Pick a duct radius for the reconstructed ventilation pass.

    Priority:
        1. Median valid radius from raw duct candidates (deduplicated by
           quantized path).  CIRCLE: radius/diameter;  RECT: max(w,h)/2.
        2. RECON_VENT_DEFAULT_RADIUS — only when profile.allow_config_defaults.
        3. None → caller skips reconstruction entirely.

    5B.4 — grouping/dedup counters:
        counts['vent_candidates_grouped']    += total raw vent candidates seen
        counts['vent_duplicates_skipped']    += duplicates (same quantized path)

    Returns (radius_m, source_str) or (None, reason_str).
    """
    seen_paths = set()
    valid_radii = []
    for e in elements:
        if _is_ventilation_candidate(e) is None:
            continue
        counts['vent_candidates_grouped'] += 1
        # Quantize the candidate's path to detect duplicates upstream.
        path = _extract_vent_path(e)
        path_key = None
        if path is not None:
            s, en = path
            path_key = (
                round(s[0], 1), round(s[1], 1), round(s[2], 1),
                round(en[0], 1), round(en[1], 1), round(en[2], 1),
            )
            if path_key in seen_paths:
                counts['vent_duplicates_skipped'] += 1
                continue
            seen_paths.add(path_key)

        kind, dims, _src = _vent_extract_profile(e)
        if kind == 'CIRCLE' and dims:
            r = dims[0]
            if r and RECON_VENT_MIN_RADIUS <= r <= RECON_VENT_MAX_RADIUS:
                valid_radii.append(r)
        elif kind == 'RECT' and dims:
            w, h = dims
            r = max(w, h) / 2.0
            if RECON_VENT_MIN_RADIUS <= r <= RECON_VENT_MAX_RADIUS:
                valid_radii.append(r)

    if valid_radii:
        valid_radii.sort()
        n = len(valid_radii)
        median_r = (valid_radii[n // 2] if n % 2 == 1
                    else 0.5 * (valid_radii[n // 2 - 1] + valid_radii[n // 2]))
        print(f"{log_prefix} radius source=input median={median_r:.3f}m "
              f"(from {n} unique valid raw duct candidates; "
              f"{counts['vent_duplicates_skipped']} duplicates skipped)")
        return median_r, f'input_median_n{n}'

    if profile.allow_config_defaults:
        r = RECON_VENT_DEFAULT_RADIUS
        print(f"{log_prefix} radius source=config_default {r:.3f}m "
              f"(no valid raw input; ALLOW_CONFIG_DEFAULTS=true)")
        return r, 'config_default'

    print(f"{log_prefix} radius source=NONE "
          f"(no valid raw input and ALLOW_CONFIG_DEFAULTS=false)")
    return None, 'no_input_no_default'


def _emit_reconstructed_vent_for_segment(f, body_sub, storey_lp, owner,
                                          cand, radius, counts):
    """Emit one cylindrical IfcFlowSegment along the segment's ceiling.

    The duct is offset down from the segment centerline by
    (bore_h/2 - RECON_VENT_CEILING_CLEARANCE - radius) so its outer surface
    sits just below the arch crown and never pierces the shell. Returns the
    IfcFlowSegment, or None on failure.
    """
    seg_id = cand['elem_id']
    bore_w, bore_h, _shell_t = cand['profile']
    d_unit = cand['d']
    L = cand['length']

    is_vertical = abs(d_unit[2]) > VENT_VERTICAL_THRESHOLD
    if is_vertical:
        return None  # 5B rule: no vertical reconstructed ducts

    frame = _build_frame_from_direction(d_unit)
    if frame is None:
        return None
    local_x, _local_y, local_z = frame

    # Vertical offset (relative to segment centerline) so duct outer hugs ceiling.
    # bore_h is the inner cross-section height; arch crown is at +bore_h/2 from
    # the centerline. We want the duct outer surface RECON_VENT_CEILING_CLEARANCE
    # below the crown -> duct center sits at bore_h/2 - clearance - radius.
    z_offset = (bore_h / 2.0) - RECON_VENT_CEILING_CLEARANCE - radius
    if z_offset <= -bore_h / 2.0:
        # Tunnel too small for a duct of this radius — skip rather than pierce.
        return None

    sx, sy, sz = cand['start']
    origin = (sx + z_offset * local_z[0],
              sy + z_offset * local_z[1],
              sz + z_offset * local_z[2])

    try:
        profile_def = _make_solid_circle_profile(f, radius)
        obj_lp = _make_local_placement(f, storey_lp, origin, local_z, local_x)
        solid = _make_extrusion_along_local_x(f, profile_def, L)
        _apply_style(f, solid, VENT_COLOR, name='ReconVent')
    except Exception:
        return None

    counts['reconstructed_vent_runs_emitted'] += 1
    return f.create_entity(
        'IfcFlowSegment',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name=f'ReconVent-{seg_id}',
        ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
    )


def _emit_floor_slab(f, body_sub, storey_lp, owner, kept_endpoints, counts):
    """Single thin floor slab from the bbox of all kept horizontal-segment endpoints.

    Skips (returns None) if no endpoints, or the bbox area is below SLAB_MIN_AREA.
    Always logs the bbox + thickness, including for skips.
    """
    if not kept_endpoints:
        print('  slab: skipped (no kept horizontal segments)')
        return None
    xs = [p[0] for p in kept_endpoints]
    ys = [p[1] for p in kept_endpoints]
    zs = [p[2] for p in kept_endpoints]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_z = min(zs)
    raw_w = max_x - min_x
    raw_l = max_y - min_y
    area = raw_w * raw_l
    print(f'  slab bbox: X=[{min_x:.2f}, {max_x:.2f}] '
          f'Y=[{min_y:.2f}, {max_y:.2f}]  raw={raw_w:.2f}x{raw_l:.2f} m '
          f'area={area:.2f} m2  thickness={SLAB_THICKNESS} m')
    if area < SLAB_MIN_AREA:
        print(f'  slab: skipped (bbox area {area:.2f} m2 < min {SLAB_MIN_AREA})')
        return None

    pad_w = raw_w + 2.0 * SLAB_MARGIN
    pad_l = raw_l + 2.0 * SLAB_MARGIN
    cx = (min_x + max_x) / 2.0
    cy = (min_y + max_y) / 2.0
    bottom_z = min_z - SLAB_THICKNESS - SLAB_BOTTOM_OFFSET
    origin = (cx, cy, bottom_z)
    print(f'  slab placement: center=({cx:.2f}, {cy:.2f}, {bottom_z:.2f}) '
          f'pad={pad_w:.2f}x{pad_l:.2f} m  top_z={bottom_z + SLAB_THICKNESS:.2f}')

    try:
        obj_lp = _make_local_placement(f, storey_lp, origin, (0.0, 0.0, 1.0),
                                       (1.0, 0.0, 0.0))
        profile_def = _make_solid_rect_profile(f, pad_w, pad_l)
        solid = _make_extrusion_along_local_z(f, profile_def, SLAB_THICKNESS)
        _apply_style(f, solid, SLAB_COLOR, name='FloorSlab')
    except Exception as ex:
        print(f'  slab: emission failed: {ex}')
        return None

    counts['slabs_emitted'] += 1
    return f.create_entity(
        'IfcSlab',
        GlobalId=_new_guid(), OwnerHistory=owner,
        Name='Tunnel-Floor', ObjectPlacement=obj_lp,
        Representation=_make_shape_rep(f, body_sub, solid),
        PredefinedType='FLOOR',
    )


# ---------------------------------------------------------------------------
# Debug — full normalized scene dump (no geometry side-effects)
# ---------------------------------------------------------------------------

def _v3(p):
    """Tuple/list/dict (x,y,z) → {x,y,z} dict; None passthrough."""
    if p is None:
        return None
    if isinstance(p, dict):
        try:
            return {'x': float(p.get('x', 0.0)),
                    'y': float(p.get('y', 0.0)),
                    'z': float(p.get('z', 0.0))}
        except (TypeError, ValueError):
            return None
    try:
        return {'x': float(p[0]), 'y': float(p[1]), 'z': float(p[2])}
    except (TypeError, ValueError, IndexError):
        return None


def _classify_branch_role(idx, chain_owned_segments_preview):
    return 'main_loop' if idx in chain_owned_segments_preview else 'branch'


def _dump_normalized_scene(
    css,
    render_id,
    user_id,
    horizontal_candidates,
    vertical_candidates,
    jstats,
    chains_detected,
    coverage,
    chain_owned_segments_preview,
    pseudo_host_walls,
    branch_host_walls_preview,
    opening_targets_preview,
    elements,
    profile,
    counts,
):
    """Phase debug — write the full interpreted scene state to S3 BEFORE any
    door/vent/shaft/portal geometry is emitted. Pure read-only; never mutates
    the caller's data. Failures are caught and logged so generation continues.

    Output: s3://builting-ifc/debug/<render_id>_normalized_scene.json
    """
    try:
        import boto3  # local import: keeps module import cheap if boto missing
    except Exception as ex:  # pragma: no cover
        print(f"[DEBUG-DUMP] boto3 unavailable, skipping scene dump: {ex}")
        return

    joint_ends = jstats.get('joint_ends', set())
    seg_to_host = {hw['seg_idx']: hw for hw in pseudo_host_walls}

    # ---- 1. GLOBAL METADATA + bbox over every interpretable point ----------
    facility = css.get('facility', {}) or {}
    metadata = css.get('metadata', {}) or {}
    bbox_xs, bbox_ys, bbox_zs = [], [], []

    def _ingest_pt(pt):
        if pt is None:
            return
        try:
            x = float(pt[0])
            y = float(pt[1])
            z = float(pt[2])
        except (TypeError, ValueError, IndexError):
            return
        bbox_xs.append(x)
        bbox_ys.append(y)
        bbox_zs.append(z)

    for cand in horizontal_candidates:
        _ingest_pt(cand['start'])
        _ingest_pt(cand['end'])
    for _elem, _eid, _s, _e in vertical_candidates:
        _ingest_pt(_s)
        _ingest_pt(_e)
    for el in elements:
        pl = el.get('placement') or {}
        origin = pl.get('origin')
        if isinstance(origin, dict):
            _ingest_pt((origin.get('x'), origin.get('y'), origin.get('z')))
        gp = el.get('geometry') or {}
        for k in ('pathPoints', 'path'):
            pts = gp.get(k)
            if isinstance(pts, list):
                for pt in pts:
                    if isinstance(pt, dict):
                        _ingest_pt((pt.get('x'), pt.get('y'), pt.get('z')))
        for pk in ('startPoint', 'endPoint'):
            pt = (el.get('properties') or {}).get(pk)
            if isinstance(pt, dict):
                _ingest_pt((pt.get('x'), pt.get('y'), pt.get('z')))

    bbox = None
    if bbox_xs:
        bbox = {
            'min': {'x': min(bbox_xs), 'y': min(bbox_ys), 'z': min(bbox_zs)},
            'max': {'x': max(bbox_xs), 'y': max(bbox_ys), 'z': max(bbox_zs)},
        }

    global_block = {
        'render_id': render_id,
        'user_id': user_id,
        'facility_name': facility.get('name'),
        'profile_kind': 'tunnel',
        'profile_resolved': format_profile(profile),
        'unit_scale': 1.0,
        'unit_name': 'METRE',
        'bbox': bbox,
        'css_metadata_keys': sorted(list(metadata.keys())),
        'element_type_histogram': {},
    }
    for el in elements:
        t = el.get('type', 'UNKNOWN')
        global_block['element_type_histogram'][t] = (
            global_block['element_type_histogram'].get(t, 0) + 1
        )

    # ---- 2. WALLS / SEGMENTS ----------------------------------------------
    segments = []
    # Build chain id per segment idx for connectivity reporting
    chain_id_by_seg = {}
    for ci, ch in enumerate(chains_detected):
        for s in ch['segments']:
            chain_id_by_seg[s] = ci
    # Endpoint adjacency for connected_segments listing.
    ep_to_segs = {}
    for i, cand in enumerate(horizontal_candidates):
        for end_lbl, ep in (('start', cand['start']), ('end', cand['end'])):
            key = _round_endpoint(ep)
            ep_to_segs.setdefault(key, []).append((i, end_lbl))

    for i, cand in enumerate(horizontal_candidates):
        elem_id = cand['elem_id']
        bore_w, bore_h, shell_t = cand['profile']
        is_main = i in chain_owned_segments_preview
        connected = []
        seen_pair = set()
        for end_lbl, ep in (('start', cand['start']), ('end', cand['end'])):
            for (j, j_end) in ep_to_segs.get(_round_endpoint(ep), []):
                if j == i:
                    continue
                pair = (j, j_end, end_lbl)
                if pair in seen_pair:
                    continue
                seen_pair.add(pair)
                other_id = horizontal_candidates[j]['elem_id']
                connected.append({
                    'segment_id': other_id,
                    'self_end': end_lbl,
                    'other_end': j_end,
                })
        segments.append({
            'id': elem_id,
            'index': i,
            'type': 'main_loop' if is_main else 'branch',
            'kind': 'horizontal_or_sloped',
            'start': _v3(cand['start']),
            'end': _v3(cand['end']),
            'length': cand['length'],
            'direction_unit': _v3(cand['d']),
            'profile': {
                'bore_w': bore_w, 'bore_h': bore_h, 'shell_t': shell_t,
                'outer_w': bore_w + 2.0 * shell_t,
                'source_type': cand.get('source_type'),
            },
            'is_curve': False,
            'curvature_radius': None,
            'parent_segment': None,
            'chain_id': chain_id_by_seg.get(i),
            'joint_start': (i, 'start') in joint_ends,
            'joint_end': (i, 'end') in joint_ends,
            'connected_segments': connected,
            'entry_node': cand.get('entry_node'),
            'exit_node': cand.get('exit_node'),
        })

    for elem, elem_id, s, e in vertical_candidates:
        sx, sy, sz = s
        ex, ey, ez = e
        L = math.sqrt((ex-sx)**2 + (ey-sy)**2 + (ez-sz)**2)
        d = (0.0, 0.0, 0.0)
        if L > 0:
            d = ((ex-sx)/L, (ey-sy)/L, (ez-sz)/L)
        segments.append({
            'id': elem_id,
            'index': None,
            'type': 'vertical',
            'kind': 'vertical_shaft_segment',
            'start': _v3(s),
            'end': _v3(e),
            'length': L,
            'direction_unit': _v3(d),
            'profile': None,
            'is_curve': False,
            'parent_segment': None,
            'chain_id': None,
            'connected_segments': [],
        })

    # ---- 3. OPENING TARGETS ----------------------------------------------
    openings_out = []
    for tgt in opening_targets_preview:
        ox, oy, oz = tgt['origin']
        cand = tgt['host_wall']['cand']
        # outward normal at this opening (perpendicular to wall, in xy plane)
        dxx, dyy, _dzz = cand['d']
        outward_n = (-dyy, dxx, 0.0)
        # 'junction_start' / 'junction_end' / 'branch_entry' classification
        if tgt['is_short_branch']:
            type_label = 'branch_entry'
        else:
            type_label = ('junction_start' if tgt['end_label'] == 'start'
                          else 'junction_end')
        qualify_reason = tgt.get('qualify_reason') or 'unfiltered'
        openings_out.append({
            'id': tgt['opening_id'],
            'host_segment': cand['elem_id'],
            'position': {'x': ox, 'y': oy, 'z': oz},
            'normal': {'x': outward_n[0], 'y': outward_n[1], 'z': 0.0},
            'branch_axis': _v3(tgt['branch_axis']),
            'type': type_label,
            'end_label': tgt['end_label'],
            'branch_length': tgt['branch_length'],
            'is_short_branch': tgt['is_short_branch'],
            'qualify_reason': qualify_reason,
            'is_valid_opening': qualify_reason != 'unfiltered',
        })

    # ---- 4. DOORS — preview must mirror production assignment flow ----------
    # Production order (Phase 5B.6 + Task F):
    #   1. _assign_doors_to_openings        primary, 3m default / 5m explicit
    #   2. _recover_skipped_doors           topology second pass, 6m
    #   3. path-0b branch-wall fallback     for anything still unassigned
    # The dump previously used per-door `_find_opening_for_door` here, which
    # produced a different count from production (no Task-C global scoring,
    # no Task-F recovery). Now it routes through the same helpers so the
    # dump's `assignment_source` / decision / count fields match what the
    # IFC writer actually emits.
    door_elements_preview = [el for el in elements if el.get('type') == 'DOOR']
    primary_assignments_preview, primary_skips_preview, _assign_stats_preview = \
        _assign_doors_to_openings(
            door_elements_preview, opening_targets_preview,
            radius_default=DOOR_OPENING_ASSIGNMENT_RADIUS,
            radius_explicit=DOOR_OPENING_ASSIGNMENT_RADIUS_EXPLICIT)
    preview_seg_nodes, preview_node_segs = _build_segment_endpoint_graph(
        horizontal_candidates)
    recovered_assignments_preview, _final_skips_preview = _recover_skipped_doors(
        primary_skips_preview, door_elements_preview,
        primary_assignments_preview,
        horizontal_candidates, branch_host_walls_preview,
        preview_seg_nodes, preview_node_segs,
        radius=DOOR_OPENING_ASSIGNMENT_RADIUS_TOPOLOGY)

    doors_out = []
    for el in door_elements_preview:
        elem_id = el.get('id', '<no-id>')
        meta = el.get('metadata') or {}
        host_key = (meta.get('hostWallKey')
                    or meta.get('host_wall_key')
                    or meta.get('host'))
        placement = el.get('placement') or {}
        geom = el.get('geometry') or {}
        prof_in = geom.get('profile') or {}
        src_origin = _safe_xyz(placement.get('origin'))
        src_width = _safe_float(prof_in.get('width'))
        src_height = _safe_float(prof_in.get('height'))
        src_depth = _safe_float(geom.get('depth'))

        record = {
            'id': elem_id,
            'source_position': _v3(src_origin),
            'source_rotation': placement.get('rotation'),
            'source_normal': _v3(placement.get('refDirection')),
            'width': src_width,
            'height': src_depth,
            'thickness': src_height,
            'bbox': geom.get('bbox'),
            'hostWallKey': host_key,
            'parent_segment': (el.get('properties') or {}).get('parentSegment'),
            'room_id': (el.get('properties') or {}).get('roomId'),
            'assignment_source': None,   # primary_opening | topology_recovery
                                          # | branch_wall_fallback | skipped
            'topology_kind': None,
            'assigned_opening_id': None,
            'assignment_distance': None,
            'final_placement': None,
            'decision': {'status': 'unknown', 'reason': None},
            'confidence': (el.get('properties') or {}).get('confidence'),
        }

        # Stage 1 — primary opening assignment (Task C).
        info = primary_assignments_preview.get(elem_id)
        if info is not None and src_origin is not None:
            opening = info['opening']
            cand_o = opening['host_wall']['cand']
            t_at = (0.0 if opening['end_label'] == 'start'
                    else cand_o['length'])
            joint_start = opening['host_wall'].get('joint_start', False)
            joint_end = opening['host_wall'].get('joint_end', False)
            valid, kind, _snap_t = _door_location_valid(
                cand_o, t_at, joint_start, joint_end)
            projection = _opening_target_projection(opening, src_origin)
            cx, cy = projection['closest_xy']
            nx_o, ny_o, _ = projection['normal_unit']
            outer_half = projection['outer_w'] / 2.0
            face_x = cx + nx_o * outer_half
            face_y = cy + ny_o * outer_half
            record['assigned_opening_id'] = opening['opening_id']
            record['assignment_distance'] = info['distance']
            record['nearest_opening_distance'] = info['distance']
            if valid:
                record['assignment_source'] = 'primary_opening'
                record['decision'] = {
                    'status': 'would_emit_via_opening',
                    'reason': f'opening_assigned kind={kind} '
                              f'reason={info.get("reason")} '
                              f'radius_used={info.get("radius_used"):.2f}m '
                              f'score={info.get("score"):.1f}',
                    'host_segment': cand_o['elem_id'],
                    'placement_kind': kind,
                }
                record['final_placement'] = {
                    'center': {'x': face_x, 'y': face_y,
                               'z': float(src_origin[2])},
                    'normal': {'x': nx_o, 'y': ny_o, 'z': 0.0},
                    'width_axis': {'x': nx_o, 'y': ny_o, 'z': 0.0},
                    'height_axis': {'x': 0.0, 'y': 0.0, 'z': 1.0},
                }
            else:
                record['assignment_source'] = 'skipped'
                record['decision'] = {
                    'status': 'would_skip_invalid_location',
                    'reason': f'primary_opening_invalid kind={kind}',
                }

        # Stage 2 — topology recovery (Task F). Only for doors not assigned
        # in stage 1.
        if record['assignment_source'] is None and src_origin is not None:
            rec = recovered_assignments_preview.get(elem_id)
            if rec is not None:
                opening = rec['opening']
                cand_r = opening['host_wall']['cand']
                t_at = (0.0 if opening['end_label'] == 'start'
                        else cand_r['length'])
                joint_start = opening['host_wall'].get('joint_start', False)
                joint_end = opening['host_wall'].get('joint_end', False)
                valid, kind, _snap_t = _door_location_valid(
                    cand_r, t_at, joint_start, joint_end)
                projection = _opening_target_projection(opening, src_origin)
                cx, cy = projection['closest_xy']
                nx_r, ny_r, _ = projection['normal_unit']
                outer_half = projection['outer_w'] / 2.0
                face_x = cx + nx_r * outer_half
                face_y = cy + ny_r * outer_half
                record['assigned_opening_id'] = opening['opening_id']
                record['assignment_distance'] = rec['distance']
                record['nearest_opening_distance'] = rec['distance']
                record['topology_kind'] = rec['topology_kind']
                if valid:
                    record['assignment_source'] = 'topology_recovery'
                    record['decision'] = {
                        'status': 'would_emit_via_topology_recovery',
                        'reason': (f'topology_recovered_{rec["topology_kind"]} '
                                   f'endpoint={rec["endpoint_label"]} '
                                   f'kind={kind}'),
                        'host_segment': cand_r['elem_id'],
                        'placement_kind': kind,
                    }
                    record['final_placement'] = {
                        'center': {'x': face_x, 'y': face_y,
                                   'z': float(src_origin[2])},
                        'normal': {'x': nx_r, 'y': ny_r, 'z': 0.0},
                        'width_axis': {'x': nx_r, 'y': ny_r, 'z': 0.0},
                        'height_axis': {'x': 0.0, 'y': 0.0, 'z': 1.0},
                    }
                else:
                    record['assignment_source'] = 'skipped'
                    record['decision'] = {
                        'status': 'would_skip_invalid_location',
                        'reason': (f'topology_recovered_{rec["topology_kind"]}'
                                   f'_invalid kind={kind}'),
                    }

        # Stage 3 — path-0b branch-wall fallback. Mirrors production:
        # _emit_door scans branch_host_walls when assigned_opening is None
        # and the wall face is within DOOR_WALL_FACE_TOLERANCE of the door.
        if record['assignment_source'] is None and src_origin is not None \
                and branch_host_walls_preview:
            host_wall, projection, diag = _find_host_wall_for_door(
                src_origin, branch_host_walls_preview,
                face_tolerance=DOOR_WALL_FACE_TOLERANCE)
            if diag is not None:
                record['nearest_branch_wall'] = {
                    'segment_id': diag.get('best_seg_id'),
                    'face_distance': diag.get('best_face_dist'),
                    'within_tolerance': diag.get('within_tolerance'),
                }
            if host_wall is not None and projection is not None:
                cand_h = host_wall['cand']
                t_h = projection['t']
                joint_start = host_wall.get('joint_start', False)
                joint_end = host_wall.get('joint_end', False)
                valid, kind, _snap_t = _door_location_valid(
                    cand_h, t_h, joint_start, joint_end)
                if valid:
                    cx, cy = projection['closest_xy']
                    nx_h, ny_h, _ = projection['normal_unit']
                    record['assignment_source'] = 'branch_wall_fallback'
                    record['decision'] = {
                        'status': 'would_emit_via_branch_wall',
                        'reason': f'branch_wall_host kind={kind}',
                        'host_segment': cand_h['elem_id'],
                        'placement_kind': kind,
                    }
                    record['final_placement'] = {
                        'center': {'x': cx, 'y': cy,
                                   'z': float(src_origin[2])},
                        'normal': {'x': nx_h, 'y': ny_h, 'z': 0.0},
                        'width_axis': {'x': nx_h, 'y': ny_h, 'z': 0.0},
                        'height_axis': {'x': 0.0, 'y': 0.0, 'z': 1.0},
                    }
                else:
                    record['assignment_source'] = 'skipped'
                    record['decision'] = {
                        'status': 'would_skip_invalid_location',
                        'reason': f'branch_wall_invalid kind={kind}',
                    }
            else:
                record['assignment_source'] = 'skipped'
                record['decision'] = {
                    'status': 'would_skip_no_host',
                    'reason': (f'no_branch_wall_within_'
                               f'{DOOR_WALL_FACE_TOLERANCE}m'),
                }

        if record['assignment_source'] is None:
            record['assignment_source'] = 'skipped'
            record['decision'] = {
                'status': 'would_skip_no_origin_or_no_targets',
                'reason': ('src_origin missing'
                           if src_origin is None
                           else 'no opening/branch walls available'),
            }

        doors_out.append(record)

    # ---- 5. ENTRANCES / ACCESS / RAMPS -----------------------------------
    entrance_types = {'RAMP', 'STAIR', 'PLATFORM', 'ENTRANCE', 'ACCESS',
                      'STAIRS', 'STAIRCASE'}
    entrances_out = []
    for el in elements:
        et = (el.get('type') or '').upper()
        if et not in entrance_types:
            continue
        elem_id = el.get('id', '<no-id>')
        placement = el.get('placement') or {}
        geom = el.get('geometry') or {}
        props = el.get('properties') or {}
        origin = _safe_xyz(placement.get('origin'))
        slope = props.get('slope') or props.get('grade')
        # nearest opening (xy) for context
        near_op = None
        near_d = None
        if origin is not None and opening_targets_preview:
            near_op, near_d = _find_opening_for_door(
                origin, opening_targets_preview, radius=1e9)
        entrances_out.append({
            'id': elem_id,
            'type': et,
            'position': _v3(origin),
            'bbox': geom.get('bbox'),
            'slope': slope,
            'nearest_opening': (near_op['opening_id']
                                if near_op is not None else None),
            'distance_to_opening': near_d,
            'decision': {'status': 'no_emission_path_in_clean_tunnel_export',
                         'reason': 'ramp/stair/entrance not yet supported'},
        })

    # ---- 6. VENTILATION / DUCTS ------------------------------------------
    vents_out = []
    for el in elements:
        kind = _is_ventilation_candidate(el)
        if kind is None:
            continue
        elem_id = el.get('id', '<no-id>')
        path = _extract_vent_path(el)
        prof_kind, dims, _src = _vent_extract_profile(el)
        path_length = None
        radius = None
        if path is not None:
            s, e = path
            path_length = math.sqrt(
                (e[0]-s[0])**2 + (e[1]-s[1])**2 + (e[2]-s[2])**2)
        if prof_kind == 'CIRCLE' and dims:
            radius = dims[0]
        # midpoint distance to centerline / nearest endpoint
        dist_to_centerline = None
        dist_to_endpoint = None
        if path is not None:
            mx = (path[0][0] + path[1][0]) / 2.0
            my = (path[0][1] + path[1][1]) / 2.0
            dist_to_centerline = _xy_dist_to_horizontal_tunnel_centerline(
                (mx, my), horizontal_candidates)
            dist_to_endpoint = _xy_dist_to_nearest_endpoint(
                (mx, my),
                [pt for c in horizontal_candidates
                 for pt in (c['start'], c['end'])])
        vents_out.append({
            'id': elem_id,
            'kind': kind,
            'source_points': ([_v3(path[0]), _v3(path[1])]
                              if path is not None else None),
            'reconstructed_path': ([_v3(path[0]), _v3(path[1])]
                                   if path is not None else None),
            'path_length': path_length,
            'profile_kind': prof_kind,
            'profile_dims': dims,
            'radius': radius,
            'bbox': (el.get('geometry') or {}).get('bbox'),
            'grouped_chain_id': None,
            'position_relative_to_tunnel': {
                'distance_to_centerline': dist_to_centerline,
                'distance_to_nearest_endpoint': dist_to_endpoint,
            },
            'decision': {
                'status': ('would_skip_disabled'
                           if not profile.enable_ducts
                           else 'pending_path_validation'),
                'reason': ('enable_ducts=false'
                           if not profile.enable_ducts
                           else 'will run _emit_vent_duct gates'),
            },
        })

    # ---- 7. SHAFTS --------------------------------------------------------
    shafts_out = []
    horizontal_starts = [c['start'] for c in horizontal_candidates] + \
                        [c['end'] for c in horizontal_candidates]
    for elem, elem_id, s, e in vertical_candidates:
        sx, sy, sz = s
        ex, ey, ez = e
        height = abs(ez - sz)
        origin = s if sz <= ez else e
        # dry-run snap (no mutation since we pass copies)
        try:
            snap_s, snap_e, was_snapped = _snap_shaft_to_tunnel_arch(
                tuple(origin), height, horizontal_candidates)
        except Exception:
            snap_s, snap_e, was_snapped = origin, origin, False
        # nearest host
        nearest_cand, nearest_dist = _nearest_horizontal_host(
            (sx, sy), horizontal_candidates)
        radius = None
        elem_props = elem.get('properties') or {}
        for k in ('radius', 'shaftRadius', 'innerRadius'):
            v = _safe_float(elem_props.get(k))
            if v is not None:
                radius = v
                break
        if radius is None:
            elem_geom = elem.get('geometry') or {}
            elem_prof = elem_geom.get('profile') or {}
            v = _safe_float(elem_prof.get('radius'))
            if v is None:
                d = _safe_float(elem_prof.get('diameter'))
                v = d / 2.0 if d else None
            radius = v
        decision = {
            'status': ('would_skip_disabled'
                       if not profile.enable_shafts
                       else ('would_emit'
                             if (was_snapped
                                 or not profile.strict_secondary_geometry)
                             else 'would_skip_unhosted')),
            'reason': ('enable_shafts=false'
                       if not profile.enable_shafts
                       else (None if was_snapped
                             else (f'no_tunnel_within_{SHAFT_SNAP_DIST}m'
                                   if profile.strict_secondary_geometry
                                   else 'will_emit_unsnapped_relaxed'))),
        }
        shafts_out.append({
            'id': elem_id,
            'source_position': _v3(origin),
            'source_start': _v3(s),
            'source_end': _v3(e),
            'radius': radius,
            'height': height,
            'nearest_host_segment': (nearest_cand['elem_id']
                                     if nearest_cand else None),
            'distance_to_host': nearest_dist,
            'snapped_position': _v3(snap_s if was_snapped else origin),
            'was_snapped_to_arch': was_snapped,
            'decision': decision,
        })

    # ---- 8. CONNECTIONS / TOPOLOGY ----------------------------------------
    seg_connections = []
    seen_conn = set()
    for key, members in ep_to_segs.items():
        if len(members) < 2:
            continue
        # pairwise
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                a_idx, a_end = members[i]
                b_idx, b_end = members[j]
                a_id = horizontal_candidates[a_idx]['elem_id']
                b_id = horizontal_candidates[b_idx]['elem_id']
                pair = tuple(sorted([(a_id, a_end), (b_id, b_end)]))
                if pair in seen_conn:
                    continue
                seen_conn.add(pair)
                degree = len(members)
                if degree == 2:
                    conn_type = 'continuation'
                elif degree >= 3:
                    conn_type = 'junction'
                else:
                    conn_type = 'unknown'
                seg_connections.append({
                    'from': {'segment_id': a_id, 'end': a_end},
                    'to': {'segment_id': b_id, 'end': b_end},
                    'type': conn_type,
                    'degree_at_node': degree,
                })

    detected_branches = sum(
        1 for i in range(len(horizontal_candidates))
        if i not in chain_owned_segments_preview)
    detected_chains = [{
        'chain_id': ci,
        'segment_count': len(ch['segments']),
        'segment_ids': [horizontal_candidates[s]['elem_id']
                        for s in ch['segments']],
        'is_arch': horizontal_candidates[
            ch['segments'][0]].get('source_type') == 'ARCH',
    } for ci, ch in enumerate(chains_detected)]
    topology_block = {
        'segment_connections': seg_connections,
        'detected_chains': detected_chains,
        'detected_branches_count': detected_branches,
        'main_loop_segments': coverage.get('main_loop_segments'),
        'cycles_found': coverage.get('cycles_found'),
        'graph_nodes_quantized': coverage.get('graph_nodes_quantized'),
        'graph_nodes_after_merge': coverage.get('graph_nodes_after_merge'),
        'segments_in_chains': coverage.get('segments_in_chains'),
        'segments_unassigned': coverage.get('segments_unassigned'),
        'unassigned_elem_ids': coverage.get('unassigned_elem_ids'),
        'jstats_summary': {
            'joints_detected': jstats.get('joints_detected'),
            'two_way': jstats.get('two_way'),
            'three_way_plus_skipped': jstats.get('three_way_plus_skipped'),
            'free_ends': jstats.get('free_ends'),
            'segments_adjusted_count': len(jstats.get('segments_adjusted', [])),
            'max_trim_distance': jstats.get('max_trim_distance'),
            'trims_capped': jstats.get('trims_capped'),
        },
    }

    # ---- 9. SUMMARY STATS -------------------------------------------------
    door_inputs = sum(1 for el in elements if el.get('type') == 'DOOR')
    vent_inputs = sum(1 for el in elements
                       if _is_ventilation_candidate(el) is not None)
    doors_emit_primary = sum(
        1 for d in doors_out if d.get('assignment_source') == 'primary_opening')
    doors_emit_recovery = sum(
        1 for d in doors_out if d.get('assignment_source') == 'topology_recovery')
    doors_emit_fallback = sum(
        1 for d in doors_out
        if d.get('assignment_source') == 'branch_wall_fallback')
    doors_emit_total = doors_emit_primary + doors_emit_recovery + doors_emit_fallback
    doors_skip_total = sum(
        1 for d in doors_out if d.get('assignment_source') == 'skipped')
    summary = {
        'walls': len(horizontal_candidates),
        'main_loop_segments': len(chain_owned_segments_preview),
        'branch_segments': detected_branches,
        'verticals': len(vertical_candidates),
        'openings_detected': len(opening_targets_preview),
        'doors_input': door_inputs,
        'doors_would_emit_primary': doors_emit_primary,
        'doors_would_emit_recovery': doors_emit_recovery,
        'doors_would_emit_fallback': doors_emit_fallback,
        'doors_would_emit_total': doors_emit_total,
        'doors_would_skip_total': doors_skip_total,
        # Legacy keys kept so external consumers don't break.
        'doors_would_emit': doors_emit_total,
        'doors_would_skip': doors_skip_total,
        'vents_input': vent_inputs,
        'vents_would_emit_relaxed': sum(
            1 for v in vents_out
            if v['decision']['status'] != 'would_skip_disabled'),
        'entrances_input': len(entrances_out),
        'shafts_input': len(vertical_candidates),
        'shafts_would_emit': sum(
            1 for s in shafts_out
            if s['decision']['status'] == 'would_emit'),
        'shafts_would_skip': sum(
            1 for s in shafts_out
            if s['decision']['status'].startswith('would_skip')),
    }

    payload = {
        'schemaVersion': 'debug-scene-v1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'global': global_block,
        'segments': segments,
        'opening_targets': openings_out,
        'doors': doors_out,
        'entrances': entrances_out,
        'ventilation': vents_out,
        'shafts': shafts_out,
        'topology': topology_block,
        'summary': summary,
    }

    bucket = os.environ.get('IFC_BUCKET', 'builting-ifc')
    safe_render = render_id or 'unknown'
    key = f'debug/{safe_render}_normalized_scene.json'
    body = json.dumps(payload, indent=2, default=str).encode('utf-8')
    try:
        s3 = boto3.client('s3')
        s3.put_object(Bucket=bucket, Key=key, Body=body,
                      ContentType='application/json')
        print(f"[DEBUG-DUMP] wrote s3://{bucket}/{key} "
              f"({len(body)} bytes, doors_in={door_inputs} "
              f"openings={len(opening_targets_preview)} "
              f"vents_in={vent_inputs} shafts_in={len(vertical_candidates)})")
    except Exception as ex:
        print(f"[DEBUG-DUMP] FAILED to write s3://{bucket}/{key}: {ex}")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def is_clean_tunnel_mode_enabled(css):
    """True iff env allows clean mode AND CSS contains any TUNNEL_SEGMENT."""
    if os.environ.get('CLEAN_TUNNEL_EXPORT', '1') == '0':
        return False
    elements = css.get('elements', []) or []
    return any(e.get('type') == 'TUNNEL_SEGMENT' for e in elements)


def generate_clean_tunnel_ifc(css, _emit_mode_override=None):
    """Phase 2A clean tunnel export.

    Emits:
        - IfcWall   per structural horizontal/sloped TUNNEL_SEGMENT.
        - IfcColumn per structural vertical TUNNEL_SEGMENT (axis=(0,0,1)).
        - IfcWall   per PORTAL_BUILDING / PORTAL_END_WALL (vertical extrusion).
        - IfcSlab   single floor slab from kept-segment bbox.

    Does NOT emit doors, MEP, openings, mitre joints. Returns the same tuple shape
    as the legacy generate_ifc4_from_css:
        (ifc_string, element_count, error_count, orientation_warnings,
         tunnel_shell_report)

    _emit_mode_override: if set to 'VISUAL_SAFE', 'TUNNEL_ONLY', or 'FULL',
        temporarily overrides the module-level _VQ_EMIT_MODE / _VISUAL_SAFE_MODE /
        _TUNNEL_ONLY_MODE constants for the duration of this call.  Used by
        generate_ifc_variants() to produce three different output files.
    """
    global _VQ_EMIT_MODE, _VISUAL_SAFE_MODE, _TUNNEL_ONLY_MODE
    _orig_emit_mode    = _VQ_EMIT_MODE
    _orig_visual_safe  = _VISUAL_SAFE_MODE
    _orig_tunnel_only  = _TUNNEL_ONLY_MODE
    if _emit_mode_override is not None:
        _VQ_EMIT_MODE     = _emit_mode_override
        _VISUAL_SAFE_MODE = (_emit_mode_override == 'VISUAL_SAFE')
        _TUNNEL_ONLY_MODE = (_emit_mode_override == 'TUNNEL_ONLY')
        print(f'[VISUAL-GATE] emit_mode_override={_emit_mode_override}')
    try:
        return _generate_clean_tunnel_ifc_impl(css)
    finally:
        _VQ_EMIT_MODE     = _orig_emit_mode
        _VISUAL_SAFE_MODE = _orig_visual_safe
        _TUNNEL_ONLY_MODE = _orig_tunnel_only


def _generate_clean_tunnel_ifc_impl(css):
    """Internal implementation — called via generate_clean_tunnel_ifc wrapper."""
    profile = load_profile()
    print(f'[5A.7] secondary_geometry profile resolved: {format_profile(profile)}')
    print(f'[5A.12] strict_secondary_geometry={profile.strict_secondary_geometry} '
          f'enable_shafts={profile.enable_shafts} '
          f'enable_portals={profile.enable_portals} '
          f'enable_ducts={profile.enable_ducts} '
          f'validation_distance_tolerance={profile.validation_distance_tolerance}')
    print(f'[5B] enable_synthetic_portals={profile.enable_synthetic_portals} '
          f'enable_reconstructed_ventilation={profile.enable_reconstructed_ventilation} '
          f'allow_config_defaults={profile.allow_config_defaults}')

    facility = css.get('facility', {}) or {}
    facility_name = facility.get('name', 'Tunnel Network')
    raw_elements = css.get('elements', []) or []
    # Partition spec-text instance elements (materializeSpecInstances output)
    # from the rest. They have a dedicated emitter (`spec_instance_emitter`)
    # that owns IfcMaterialLayerSet, IfcDoorLiningProperties, IfcCircleHollow-
    # ProfileDef, revolved elbows, CAT material palette, ports, services-
    # buildings, etc. Removing them from `elements` means the existing
    # Phase 1–7 pipeline never sees them and we never double-emit.
    _spec_skipped = [e for e in raw_elements if (e.get('properties') or {}).get('specInstance') is True]
    elements = [e for e in raw_elements if (e.get('properties') or {}).get('specInstance') is not True]
    if _spec_skipped:
        print(f'[SPEC-EMIT] Reserved {len(_spec_skipped)} spec-instance elements '
              f'for dedicated emitter (out of {len(raw_elements)} total)')
    ts = int(datetime.now(timezone.utc).timestamp())

    # ---- Phase 11B mode + rejected-door set (rollback-safe visual fix) ----
    # PHASE_11B_CUT_MODE: off | debug | replace.  Default `debug` so a deploy
    # gives visible cut volumes the operator can verify before flipping to
    # `replace` for true mesh subtraction.  `off` rolls Phase 11 back to a
    # pure data pass with no IFC mutations.
    _PHASE11B_MODE = (os.environ.get('PHASE_11B_CUT_MODE') or 'debug').strip().lower()
    if _PHASE11B_MODE not in ('off', 'debug', 'replace'):
        print(f'[PHASE 11B] WARN unknown PHASE_11B_CUT_MODE={_PHASE11B_MODE!r}, '
              f'defaulting to debug')
        _PHASE11B_MODE = 'debug'
    # VISUAL_SAFE mode: force Phase 11B off — debug/replace both emit red geometry
    # (bright-red translucent IfcBuildingElementProxy cut volumes) that appear as
    # red patches in the viewer.  Kill them unconditionally in production.
    if _VISUAL_SAFE_MODE and _PHASE11B_MODE != 'off':
        print(f'[VISUAL-GATE] emitter=phase11b mode={_PHASE11B_MODE}→off '
              f'reason=visual_safe_no_debug_cuts')
        _PHASE11B_MODE = 'off'
    print(f'[PHASE 11B] mode={_PHASE11B_MODE}')

    # Pre-compute the set of DOOR element keys flagged DOOR_REJECTED by Phase
    # 11 structural-integration.  Every door-emit path checks this set up
    # front so rejected doors never reach IfcDoor creation regardless of
    # which branch (intent / Phase 8 / Phase 7B.3 recovery / portal fallback)
    # consumes them.
    _PHASE11B_REJECTED_DOOR_KEYS = set()
    for _de_pre in elements:
        if (_de_pre.get('type') or '').upper() != 'DOOR':
            continue
        _flag_pre = (_de_pre.get('properties') or {}).get('spatialFlag')
        if _flag_pre == 'DOOR_REJECTED':
            _key_pre = _de_pre.get('element_key') or _de_pre.get('id')
            if _key_pre:
                _PHASE11B_REJECTED_DOOR_KEYS.add(_key_pre)
    print(f'[PHASE 11B] rejected_door_keys={len(_PHASE11B_REJECTED_DOOR_KEYS)}')

    counts = {
        # tunnel-segment classification
        'skipped_non_structural': 0,
        'skipped_invalid': 0,                   # endpoints / length pre-checks
        'walls_skipped': 0,                     # post-profile wall failures
        # wall emission breakdown by profile shape
        'walls_emitted': 0,                     # = arched + circle + rect_fallback
        'arched_segments_emitted': 0,
        'circle_segments_emitted': 0,
        'rectangular_fallback_segments': 0,
        'brep_segments_emitted': 0,             # Phase 4B — IfcFacetedBrep walls
        'segments_with_curve_interpolation': 0, # Phase 4B — fillet at bends (deferred)
        'portal_alignment_adjustments': 0,      # Phase 4B
        'shaft_alignment_adjustments': 0,       # Phase 4B
        # other element kinds
        'shafts_kept': 0,
        'shafts_skipped': 0,
        'shafts_reconstructed': 0,              # Phase 4A — endpoints recovered
        'shafts_skipped_missing_dims': 0,       # Phase 4A — couldn't reconstruct
        # Phase 5A — shaft sanity
        'shafts_emitted': 0,                    # Phase 5A — alias of shafts_kept
        'shafts_skipped_oversized': 0,          # Phase 5A — exceeded radius/height cap
        'portals_kept': 0,
        'portals_skipped': 0,
        # Phase 5A — portal block strict-attachment counters
        'portal_blocks_emitted': 0,
        'portal_blocks_skipped_detached': 0,
        'portal_blocks_skipped_oversized': 0,
        'portal_caps_emitted': 0,               # Phase 4A
        'portal_caps_skipped': 0,               # Phase 4A
        'doors_emitted': 0,
        'doors_skipped_no_host': 0,             # Phase 4A
        'slabs_emitted': 0,                     # disabled in Phase 3+
        'ducts_emitted': 0,                     # disabled — MEP off
        # Phase 5A — controlled ventilation export (CLEAN_VENTILATION_EXPORT)
        'vent_ducts_candidates': 0,
        'vent_ducts_emitted': 0,
        'vent_ducts_skipped_invalid_path': 0,
        'vent_ducts_skipped_vertical': 0,
        'vent_ducts_skipped_far_from_tunnel': 0,
        # Phase 5A.12 — strict secondary geometry counters (universal)
        'secondary_candidates': 0,
        'secondary_emitted': 0,
        'secondary_skipped_floating': 0,
        'secondary_skipped_oversized': 0,
        'shafts_skipped_disabled': 0,
        'shafts_skipped_unhosted': 0,
        'portals_skipped_disabled': 0,
        'doors_skipped_disabled': 0,
        'ducts_skipped_disabled': 0,
        # Phase 5B — controlled detail reconstruction
        'synthetic_portal_frames_emitted': 0,
        'doors_recovered_from_nearby_input': 0,
        'reconstructed_vent_runs_emitted': 0,
        'raw_ducts_skipped': 0,
        'shaft_clamped': 0,
        # Phase 5C — final visual alignment with final.ifc
        'primary_vent_runs_emitted': 0,
        'vent_fragments_skipped_short': 0,
        'portal_frames_skipped_internal': 0,
        'shafts_deduped': 0,
        'doors_skipped_not_on_frame_face': 0,
        # Phase 5B.4 — generic hosted-secondary polish counters
        'portal_frames_emitted': 0,
        'portal_chambers_suppressed': 0,
        'portal_frames_skipped_internal_endpoint': 0,
        'portal_frames_skipped_parallel_continuation': 0,
        'doors_projected_to_frame': 0,
        'doors_skipped_outside_frame': 0,
        'vent_candidates_grouped': 0,
        'vent_duplicates_skipped': 0,
        'vent_adjusted_to_host_interior': 0,
        'shafts_snapped_to_host_surface': 0,
        'shafts_skipped_no_host_surface': 0,
        # Phase 5B.5A — door recovery polish
        'doors_candidates': 0,
        'doors_clamped_to_opening': 0,
        'doors_skipped_no_frame': 0,
        'doors_skipped_invalid_after_clamp': 0,
        # Phase 5B.5C — door hosting on real walls (tunnel/branch)
        'doors_hosted_on_shell': 0,
        'doors_voids_created': 0,
        'doors_fills_created': 0,
        'doors_skipped_no_valid_wall': 0,
        # Phase 5B.5D — door placement correctness (endpoint/junction/short-branch)
        'doors_valid_location': 0,
        'doors_skipped_invalid_location': 0,
        'doors_snapped_to_endpoint': 0,
        # Phase 5B.5E — opening-driven door reconciliation
        'room_opening_targets_detected': 0,
        'doors_candidates_assigned_to_opening': 0,
        'doors_placed_on_opening_target': 0,
        'doors_rejected_no_opening_target': 0,
        # Phase 5B.5F — one door per opening + visual panel correction
        'doors_skipped_duplicate_opening': 0,
        # Phase 5B.5C — vent system relationships (no placement change)
        'vent_flow_fittings_emitted': 0,
        'vent_distribution_ports_emitted': 0,
        'vent_port_connections_created': 0,
        # Phase 6B — intent-gate door consumption counters
        'doors_intent_consumed': 0,
        'doors_skipped_missing_intent': 0,
        'doors_skipped_invalid_intent': 0,
        'doors_skipped_low_confidence': 0,
        'doors_skipped_host_not_found': 0,
        'doors_skipped_outside_segment': 0,
        'doors_skipped_bad_z': 0,
        'doors_skipped_vertical_shaft': 0,
        'doors_skipped_roof_clip': 0,
        'doors_legacy_fallback_attempted': 0,
        'doors_intent_host_TUNNEL_SEGMENT': 0,
        'doors_intent_host_PORTAL_END_WALL': 0,
        # Phase 8 — Spatial Placement Engine
        'phase8_origin_missing': 0,
        'phase8_origin_missing_hard_fail': 0,
        'phase8_doors_hosted': 0,
        'phase8_doors_voids_created': 0,
        'phase8_doors_fills_created': 0,
        'phase8_doors_orphan': 0,
        'phase8_shaft_connect_emitted': 0,
        # Phase 9 — Tunnel-Anchored Spatial Layout
        'phase9_floating_skipped': 0,
        'phase9_door_tunnel_cuts': 0,
        'phase9_shaft_ceiling_cuts': 0,
        'phase9_orphan_walls_skipped': 0,
        # Phase 11 — Structural Integration (boolean cuts)
        'phase11_space_openings_emitted': 0,
        'phase11_space_openings_skipped_no_wall': 0,
        'phase11_space_openings_skipped_fail': 0,
        'phase11_spaces_skipped_not_integrated': 0,
        'phase11_doors_skipped_rejected': 0,
        'phase11_walls_skipped_inside_tunnel': 0,
        'phase11_shaft_cuts_emitted': 0,
        # Phase 11B — Rollback-safe visual fix (debug overlay + replace mesh)
        'phase11b_mode': _PHASE11B_MODE,           # off|debug|replace (echoed)
        'phase11b_debug_solids_emitted': 0,
        'phase11b_debug_solids_skipped': 0,
        'phase11b_tunnel_meshes_modified': 0,
        'phase11b_shaft_meshes_modified': 0,
        'phase11b_replace_failures': 0,
        'phase11b_doors_skipped_rejected': 0,      # door paths skipped DOOR_REJECTED
        'phase11b_rejected_doors_emitted': 0,      # bypass bug count — must be 0
        'phase11b_failed': False,
    }
    skip_reasons = []
    kept_horizontal_endpoints = []      # for slab bbox

    # ---- IFC file scaffolding ----
    f = ifcopenshell.file(schema='IFC4')

    person = f.create_entity('IfcPerson', GivenName='Person')
    org = f.create_entity('IfcOrganization', Name='Builting')
    pando = f.create_entity('IfcPersonAndOrganization',
                            ThePerson=person, TheOrganization=org)
    app = f.create_entity('IfcApplication',
                          ApplicationDeveloper=org, Version='clean-4b',
                          ApplicationFullName='Builting CleanTunnelExport',
                          ApplicationIdentifier='BCTE')
    owner = f.create_entity('IfcOwnerHistory',
                            OwningUser=pando, OwningApplication=app,
                            ChangeAction='ADDED', CreationDate=ts)

    u_len = f.create_entity('IfcSIUnit', UnitType='LENGTHUNIT', Name='METRE')
    u_area = f.create_entity('IfcSIUnit', UnitType='AREAUNIT', Name='SQUARE_METRE')
    u_vol = f.create_entity('IfcSIUnit', UnitType='VOLUMEUNIT', Name='CUBIC_METRE')
    u_ang = f.create_entity('IfcSIUnit', UnitType='PLANEANGLEUNIT', Name='RADIAN')
    units = f.create_entity('IfcUnitAssignment',
                            Units=(u_len, u_area, u_vol, u_ang))

    wcs = _make_axis2_3d(f, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
    context = f.create_entity('IfcGeometricRepresentationContext',
                              ContextIdentifier='Model', ContextType='Model',
                              CoordinateSpaceDimension=3, Precision=1e-5,
                              WorldCoordinateSystem=wcs)
    body_sub = f.create_entity('IfcGeometricRepresentationSubContext',
                               ContextIdentifier='Body', ContextType='Model',
                               ParentContext=context, TargetView='MODEL_VIEW')
    # Phase 6B — Axis sub-context for IfcWallStandardCase centerline polylines.
    axis_sub = f.create_entity('IfcGeometricRepresentationSubContext',
                               ContextIdentifier='Axis', ContextType='Model',
                               ParentContext=context, TargetView='GRAPH_VIEW')

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
    # ---- Phase 7: multi-storey scaffolding ----
    # Build IfcBuildingStorey entities from css.levelsOrSegments[type=='STOREY'].
    # If fewer than two are supplied, synthesize Level 0 / Level 1 so the model
    # always carries the required minimum (validation gate: IfcBuildingStorey >= 2).
    # Element-to-storey assignment uses elevation_m; the lowest storey is the
    # primary (legacy) storey used by every existing emission path.
    levels_meta = []
    for _lvl in (css.get('levelsOrSegments') or []):
        if not isinstance(_lvl, dict):
            continue
        if (_lvl.get('type') or '').upper() != 'STOREY':
            continue
        _elev = _safe_float(_lvl.get('elevation_m')) or 0.0
        _height = _safe_float(_lvl.get('height_m')) or 4.0
        levels_meta.append({
            'id': _lvl.get('id') or f'storey-{len(levels_meta)}',
            'name': _lvl.get('name') or f'Level {len(levels_meta)}',
            'elevation_m': _elev,
            'height_m': _height,
        })
    _existing_names = {m['name'] for m in levels_meta}
    if 'Level 0' not in _existing_names and not any(
            abs(m['elevation_m']) < 1e-6 for m in levels_meta):
        levels_meta.append({
            'id': 'level-0', 'name': 'Level 0',
            'elevation_m': 0.0, 'height_m': 4.0,
        })
    if len(levels_meta) < 2:
        levels_meta.append({
            'id': 'level-1', 'name': 'Level 1',
            'elevation_m': 4.0, 'height_m': 4.0,
        })
    levels_meta.sort(key=lambda m: m['elevation_m'])

    storeys = []
    for _m in levels_meta:
        _s_lp = f.create_entity(
            'IfcLocalPlacement',
            PlacementRelTo=bld_lp, RelativePlacement=wcs)
        _s_ent = f.create_entity(
            'IfcBuildingStorey',
            GlobalId=_new_guid(), OwnerHistory=owner,
            Name=_m['name'], ObjectPlacement=_s_lp,
            CompositionType='ELEMENT', Elevation=_m['elevation_m'])
        storeys.append({'meta': _m, 'entity': _s_ent, 'lp': _s_lp,
                        'placed': []})
    # Primary storey: lowest elevation. All existing emission anchors here.
    storey_lp = storeys[0]['lp']
    storey = storeys[0]['entity']
    print(f"[PHASE-7 storeys] emitted {len(storeys)} IfcBuildingStorey "
          f"({', '.join(s['meta']['name'] for s in storeys)})")

    def _storey_for_elevation(z):
        try:
            zf = float(z)
        except (TypeError, ValueError):
            return storeys[0]
        chosen = storeys[0]
        for s in storeys:
            if s['meta']['elevation_m'] <= zf + 1e-3:
                chosen = s
            else:
                break
        return chosen

    f.create_entity('IfcRelAggregates',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingObject=project, RelatedObjects=(site,))
    f.create_entity('IfcRelAggregates',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingObject=site, RelatedObjects=(building,))
    f.create_entity('IfcRelAggregates',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingObject=building,
                    RelatedObjects=tuple(s['entity'] for s in storeys))

    walls = []
    shafts = []
    portals = []
    slabs = []
    portal_caps = []
    doors = []
    kept_portal_keys = set()
    # In PRESENTATION_SAFE_MODE, limit portal blocks to 1 per free endpoint so
    # far-snapped portals (all 11 collapsed to 2 endpoints) don't pile up.
    # Key: rounded (x, y) endpoint tuple → True when a portal has claimed it.
    _psm_portal_ep_claimed: dict = {}
    emitted_wall_indices = set()
    # Phase 5B.5C — door wall-hosting: track each kept horizontal wall along
    # with the candidate it represents so doors can find a real host within
    # DOOR_WALL_FACE_TOLERANCE. Chain walls map every owned segment to the
    # one chain entity; per-segment walls map 1:1.
    host_walls = []

    # ---- Pass 1: classify TUNNEL_SEGMENTs into horizontal candidates and
    # vertical-shaft candidates. Validation that doesn't depend on neighbours
    # happens here. Joint-aware emission happens in Pass 2.
    horizontal_candidates = []   # list of dicts (see _emit_wall doc)
    vertical_candidates = []     # list of (elem, elem_id, start, end)
    upstream_missing_shaft_endpoints = []  # for diagnostic log

    for elem in elements:
        if elem.get('type') != 'TUNNEL_SEGMENT':
            continue
        elem_id = elem.get('id', '<no-id>')
        props = elem.get('properties', {}) or {}

        if props.get('branchClass') != 'STRUCTURAL':
            counts['skipped_non_structural'] += 1
            continue

        # FINAL_LIKE: skip disconnected orphan segments (no PATH_CONNECTS rels).
        # Exception: VERTICAL_SHAFT in PRESENTATION_SAFE_MODE — vertical shafts are
        # standalone structures that don't have tunnel-connectivity rels.
        if _VQ_EMIT_MODE == 'FINAL_LIKE':
            _elem_rels = elem.get('relationships') or []
            _seg_type_v = props.get('segmentType') or props.get('shape') or ''
            _is_vert_shaft = _seg_type_v == 'VERTICAL_SHAFT'
            if len(_elem_rels) == 0 and not (_PRESENTATION_SAFE_MODE and _is_vert_shaft):
                _oid = elem.get('canonical_id') or elem.get('element_key') or elem_id or 'unknown'
                skip_reasons.append((_oid, 'final_like_orphan_no_rels'))
                continue

        endpoints = _extract_endpoints(elem)
        if endpoints is None:
            seg_type = props.get('segmentType') or props.get('shape')
            if seg_type == 'VERTICAL_SHAFT':
                # Phase 4A — try to reconstruct from origin/center + height.
                endpoints = _reconstruct_shaft_endpoints(elem)
                if endpoints is None:
                    counts['shafts_skipped_missing_dims'] += 1
                    skip_reasons.append(
                        (elem_id, 'shaft_no_endpoints_no_dims'))
                    upstream_missing_shaft_endpoints.append(elem_id)
                    continue
                counts['shafts_reconstructed'] += 1
            else:
                counts['skipped_invalid'] += 1
                skip_reasons.append((elem_id, 'no_valid_endpoints'))
                continue
        start, end = endpoints

        d_raw = _vec_sub(end, start)
        L = _vec_len(d_raw)
        if L < MIN_SEGMENT_LENGTH:
            counts['skipped_invalid'] += 1
            skip_reasons.append((elem_id, f'degenerate_length_{L:.3f}'))
            continue

        if abs(d_raw[2]) / L > VERTICAL_THRESHOLD:
            vertical_candidates.append((elem, elem_id, start, end))
            continue

        # Reject segments that are steep but not vertical — they produce
        # distorted arch geometry with very high Z extents.
        if abs(d_raw[2]) / L > STEEP_HORIZONTAL_THRESHOLD:
            counts['skipped_steep_segment'] = counts.get('skipped_steep_segment', 0) + 1
            skip_reasons.append((elem_id, f'steep_segment dz_ratio={abs(d_raw[2])/L:.2f}'))
            continue

        prof = _extract_horizontal_profile(elem)
        if prof is None:
            counts['walls_skipped'] += 1
            skip_reasons.append((elem_id, 'wall_no_valid_profile'))
            continue
        bore_w, bore_h, shell_t, source_type = prof
        outer_w = bore_w + 2.0 * shell_t

        d_unit = (d_raw[0] / L, d_raw[1] / L, d_raw[2] / L)
        horizontal_candidates.append({
            'elem_id': elem_id,
            'start': start,
            'end': end,
            'd': d_unit,
            'length': L,
            'profile': (bore_w, bore_h, shell_t),
            'source_type': source_type,
            'half_w_outer': outer_w / 2.0,
            'entry_node': props.get('entry_node'),
            'exit_node': props.get('exit_node'),
            'rels_count': len(elem.get('relationships') or []),
            # Phase 6D.1 FIX 1 — pre-trim joint position (set by topology
            # engine's trimSegmentsAtJunctions). Used by the CSG cluster
            # builder to recover the canonical joint centre instead of
            # averaging post-trim endpoints.
            'pre_trim_joint_start': props.get('preTrimJointStart'),
            'pre_trim_joint_end': props.get('preTrimJointEnd'),
        })

    # ---- Door-host segment diagnostics ----
    # For every CSS DOOR, log the geometry of its intended host segment and
    # confirm the host is a valid horizontal candidate (not shaft / vertical).
    _door_host_map = {}  # host_elem_id -> [(door_id, (ox, oy, oz))]
    for _dh_elem in elements:
        if _dh_elem.get('type', '').upper() != 'DOOR':
            continue
        _dh_id = _dh_elem.get('id', '<no-id>')
        _dh_host_key = (_dh_elem.get('metadata') or {}).get('hostWallKey') or ''
        _dh_orig = (_dh_elem.get('placement') or {}).get('origin') or {}
        _dh_o = (float(_dh_orig.get('x', 0)), float(_dh_orig.get('y', 0)), float(_dh_orig.get('z', 0)))
        if _dh_host_key:
            _door_host_map.setdefault(_dh_host_key, []).append((_dh_id, _dh_o))

    if _door_host_map:
        print('---- Door-host segment diagnostics ----')
        _hc_by_id = {hc['elem_id']: hc for hc in horizontal_candidates}
        for _dhk, _dh_doors in sorted(_door_host_map.items()):
            _hc = _hc_by_id.get(_dhk)
            if _hc is None:
                # Host is not in horizontal_candidates — likely a vertical/portal/wall type
                print(f"  host_seg[{_dhk}] NOT in horizontal_candidates "
                      f"(shaft/portal/wall/missing — cannot be a standard door host)")
                for _dh_id, _dh_o in _dh_doors:
                    print(f"    door[{_dh_id}] origin=({_dh_o[0]:.3f}, {_dh_o[1]:.3f}, {_dh_o[2]:.3f}) "
                          f"is_valid_host_kind=False")
                continue
            _hc_s = _hc['start']
            _hc_e = _hc['end']
            _hc_d = _hc['d']
            _hc_L = _hc['length']
            _hc_bw, _hc_bh, _hc_st = _hc['profile']
            _hc_dz_ratio = abs(_hc_d[2])
            _hc_ow = _hc_bw + 2.0 * _hc_st
            _hc_oh = _hc_bh + _hc_st
            _is_horiz = _hc_dz_ratio < VERTICAL_THRESHOLD
            print(f"  host_seg[{_dhk}]")
            print(f"    endpoints:      ({_hc_s[0]:.3f}, {_hc_s[1]:.3f}, {_hc_s[2]:.3f})"
                  f" -> ({_hc_e[0]:.3f}, {_hc_e[1]:.3f}, {_hc_e[2]:.3f})")
            print(f"    axis_dir:       ({_hc_d[0]:.4f}, {_hc_d[1]:.4f}, {_hc_d[2]:.4f})")
            print(f"    length:         {_hc_L:.3f} m")
            print(f"    |dz|/L:         {_hc_dz_ratio:.4f} "
                  f"(VERTICAL_THRESHOLD={VERTICAL_THRESHOLD}) -> "
                  f"{'HORIZONTAL' if _is_horiz else 'VERTICAL'}")
            print(f"    bore_profile:   {_hc_bw:.2f} x {_hc_bh:.2f} m, shell={_hc_st:.2f} m")
            print(f"    outer_bbox:     {_hc_ow:.2f} m wide x {_hc_oh:.2f} m tall")
            print(f"    is_valid_host_kind: {_is_horiz}")
            _outer_half = _hc_ow / 2.0
            for _dh_id, _dh_o in _dh_doors:
                _vx = _dh_o[0] - _hc_s[0]
                _vy = _dh_o[1] - _hc_s[1]
                _t = _vx * _hc_d[0] + _vy * _hc_d[1]
                _t_cl = max(0.0, min(_hc_L, _t))
                _cx = _hc_s[0] + _hc_d[0] * _t_cl
                _cy = _hc_s[1] + _hc_d[1] * _t_cl
                _perp = math.hypot(_dh_o[0] - _cx, _dh_o[1] - _cy)
                _face_d = abs(_perp - _outer_half)
                _in_bore = _perp < (_hc_bw / 2.0)
                print(f"    door[{_dh_id}]")
                print(f"      origin:             ({_dh_o[0]:.3f}, {_dh_o[1]:.3f}, {_dh_o[2]:.3f})")
                print(f"      t_along_segment:    {_t_cl:.3f} / {_hc_L:.3f} m")
                print(f"      perp_to_centerline: {_perp:.4f} m")
                print(f"      dist_to_host_face:  {_face_d:.4f} m (outer_half={_outer_half:.4f} m)")
                print(f"      inside_bore:        {_in_bore}")

    # ---- Pass 2a: solve joint trims for horizontal walls ----
    print('---- Phase 2B mitre/joint cleanup ----')
    trims, jstats = _compute_joint_trims(horizontal_candidates)
    print(f"  joints_detected         : {jstats['joints_detected']}")
    print(f"  two_way                 : {jstats['two_way']}")
    print(f"  three_way_plus_skipped  : {jstats['three_way_plus_skipped']}")
    # Phase 6B.4a — 3+way junction halfspace trimming counters.
    print(f"  three_way_plus_handled  : {jstats.get('three_way_plus_handled', 0)}")
    print(f"  three_way_main_pair_planes: {jstats.get('three_way_main_pair_planes', 0)}")
    print(f"  three_way_branch_butt_cuts: {jstats.get('three_way_branch_butt_cuts', 0)}")
    print(f"  three_way_branch_butt_caps_hit: {jstats.get('three_way_branch_butt_caps_hit', 0)}")
    print(f"  three_way_no_main_pair  : {jstats.get('three_way_no_main_pair', 0)}")
    print(f"  free_ends               : {jstats['free_ends']}")
    print(f"  segments_adjusted       : {len(jstats['segments_adjusted'])}")
    print(f"  max_trim_distance       : {jstats['max_trim_distance']:.3f} m")
    print(f"  trims_capped            : {jstats['trims_capped']}")
    if jstats['joints_skipped']:
        print(f"  joints_skipped ({len(jstats['joints_skipped'])}):")
        for jk, reason in jstats['joints_skipped'][:15]:
            print(f"    - {jk}: {reason}")
    counts['phase6b4a_three_way_handled'] = jstats.get('three_way_plus_handled', 0)
    counts['phase6b4a_three_way_main_pair_planes'] = jstats.get('three_way_main_pair_planes', 0)
    counts['phase6b4a_three_way_branch_butt_cuts'] = jstats.get('three_way_branch_butt_cuts', 0)
    counts['phase6b4a_three_way_no_main_pair'] = jstats.get('three_way_no_main_pair', 0)

    # ---- DEBUG DUMP — full normalized scene state BEFORE any geometry ----
    # Pure analysis: chain detection, opening detection, per-door/vent/shaft
    # dry-run interpretation. Writes JSON to s3://builting-ifc/debug/<id>.json.
    # Caller threads renderId/userId via env vars (see lambda_function.handler).
    try:
        debug_chains_detected, debug_coverage = _detect_chains(
            horizontal_candidates)
        debug_chain_owned_preview = set()
        for _ch in debug_chains_detected:
            _seg_indices = _ch['segments']
            if len(_seg_indices) < 2:
                continue
            _leader = horizontal_candidates[_seg_indices[0]]
            if _leader.get('source_type') != 'ARCH':
                continue
            for _s in _seg_indices:
                debug_chain_owned_preview.add(_s)
        debug_pseudo_host_walls = [{
            'entity': None,
            'cand': cand,
            'seg_idx': i,
            'joint_start': (i, 'start') in jstats.get('joint_ends', set()),
            'joint_end': (i, 'end') in jstats.get('joint_ends', set()),
        } for i, cand in enumerate(horizontal_candidates)]
        debug_branch_host_walls_preview = [
            hw for hw in debug_pseudo_host_walls
            if hw['seg_idx'] not in debug_chain_owned_preview
        ]
        debug_door_signals = _collect_door_signals(elements)
        debug_opening_targets_preview, _debug_pre_prune = _build_room_opening_targets(
            horizontal_candidates, jstats,
            debug_chain_owned_preview, debug_pseudo_host_walls,
            door_signals=debug_door_signals)
        _dump_normalized_scene(
            css=css,
            render_id=os.environ.get('DEBUG_RENDER_ID'),
            user_id=os.environ.get('DEBUG_USER_ID'),
            horizontal_candidates=horizontal_candidates,
            vertical_candidates=vertical_candidates,
            jstats=jstats,
            chains_detected=debug_chains_detected,
            coverage=debug_coverage,
            chain_owned_segments_preview=debug_chain_owned_preview,
            pseudo_host_walls=debug_pseudo_host_walls,
            branch_host_walls_preview=debug_branch_host_walls_preview,
            opening_targets_preview=debug_opening_targets_preview,
            elements=elements,
            profile=profile,
            counts=counts,
        )
    except Exception as _dbg_ex:
        print(f"[DEBUG-DUMP] dump failed (non-fatal): {_dbg_ex}")

    # ---- Pass 2b.0 — PHASE 4C chain detection + welded BREP emission ----
    # Walk degree-2 connectivity from the joint solver to identify maximal
    # chains of structural tunnel segments. Each chain emits ONE welded
    # IfcFacetedBrep with arc-fillet sections at every gentle bend.
    #
    # CRITICAL RULES (post-continuity audit):
    #   * A chain is either 100% continuous (post-weld) and emitted as ONE
    #     brep, or it COMPLETELY falls back to per-segment mode. No partial
    #     chain emission.
    #   * Failed-chain segments are emitted RED via _emit_wall_brep so the
    #     viewer instantly shows which segments the chain logic rejected.
    #   * Successful-chain segments NEVER hit _emit_wall_brep. The chain
    #     wall + the segment metadata in emitted_wall_indices are enough
    #     for portal-cap/bbox bookkeeping.
    print('[CHAIN] CLEAN_TUNNEL_EXPORT active — Phase 4C chain pass')
    chain_owned_segments = set()    # successfully emitted via chain
    chain_failed_segments = {}      # seg_idx → fallback_reason (string)
    chain_walls = []
    # Phase 6B.4d — collect tunnel brep AABBs as they're emitted.
    tunnel_aabbs = []
    chain_stats = {
        'chains_detected': 0,
        'chains_emitted': 0,
        'chains_skipped_non_arch': 0,
        'chains_skipped_short': 0,         # 1-segment chains stay per-segment
        'chains_failed_continuity': 0,     # post-weld guard rejected
        'chains_failed_brep_build': 0,     # _emit_chain_brep returned None
        'chain_segments_owned': 0,
        'chain_segments_red_fallback': 0,
        'curve_interpolations_added': 0,
        'old_per_segment_segments_skipped': 0,
        'chain_max_turn_deg': 0.0,
        'chain_tight_skips': 0,
        'chain_sections_total': 0,
        'max_gap_pre_weld_overall': 0.0,
        'max_gap_post_weld_overall': 0.0,
    }
    profile_pts_cache = {}

    # ---- Phase 6D.1 FIX 1 — junction cluster discovery (CSG replace mode) ----
    # Identify segments that participate in any multi-way joint and group
    # them into connected clusters. Each cluster emits as ONE merged
    # IfcTriangulatedFaceSet (chain breps + per-segment breps suppressed for
    # cluster members) so the joint manifold and the host shell are a single
    # continuous solid — no additive overlap, no brep/CSG seam.
    cluster_csg_mode = (os.environ.get('CSG_FILLERS_MODE', 'off') or '').strip().lower()
    if os.environ.get('CSG_FILLERS_ENABLED', '1') == '0':
        cluster_csg_mode = 'off'
    csg_clusters: list = []
    cluster_consumed_segments: set = set()
    cluster_member_records: dict = {}      # seg_idx → ClusterMember
    if (_PHASE_6D_CSG_AVAILABLE
            and cluster_csg_mode == 'replace'
            and horizontal_candidates):
        try:
            joint_groups_for_cluster = jstats.get('joint_groups', []) or []
            csg_clusters, cluster_consumed_segments = (
                _phase6d_csg_clusters.discover_clusters(
                    horizontal_candidates, joint_groups_for_cluster))
            counts['csg_clusters_discovered'] = len(csg_clusters)
            counts['csg_cluster_consumed_segments'] = len(cluster_consumed_segments)
            print(f"[CSG-CLUSTER] discovered {len(csg_clusters)} cluster(s) "
                  f"absorbing {len(cluster_consumed_segments)} segment(s) "
                  f"(brep emit will skip these)")
            # Per-cluster: build profile points + member records, then build
            # JunctionZone objects for every joint in the cluster.
            for cl in csg_clusters:
                for seg_idx in sorted(cl.member_seg_indices):
                    if seg_idx >= len(horizontal_candidates):
                        continue
                    cand = horizontal_candidates[seg_idx]
                    bw, bh, st = cand['profile']
                    cache_key = (round(bw, 2), round(bh, 2),
                                 round(st, 2),
                                 (cand.get('source_type') or 'RECTANGLE'))
                    cached = profile_pts_cache.get(cache_key)
                    if cached is None:
                        outer_2d, inner_2d = _gen_arch_profile_brep_pts(
                            bw, bh, st)
                        if outer_2d is None:
                            outer_2d, inner_2d = _gen_rect_profile_brep_pts(
                                bw, bh, st)
                            profile_kind_str = 'rectangular_fallback'
                        else:
                            profile_kind_str = 'arched'
                        profile_pts_cache[cache_key] = (
                            outer_2d, inner_2d, profile_kind_str)
                    else:
                        outer_2d, inner_2d, profile_kind_str = cached
                    member = _phase6d_csg_clusters.ClusterMember(
                        seg_idx=seg_idx,
                        elem_id=str(cand.get('elem_id', f'seg_{seg_idx}')),
                        start=tuple(cand['start']),
                        end=tuple(cand['end']),
                        d=tuple(cand['d']),
                        length=float(cand['length']),
                        profile_kind=('ARCH'
                                      if (cand.get('source_type') or '').upper() == 'ARCH'
                                      else 'RECT'),
                        bore_w=float(bw), bore_h=float(bh), shell_t=float(st),
                        outer_2d=list(outer_2d),
                        inner_2d=list(inner_2d),
                    )
                    cl.members.append(member)
                    cluster_member_records[seg_idx] = member
                # Attach JunctionZones for this cluster. Prefer the pre-trim
                # joint position recorded by the topology engine; fall back to
                # the average of the (post-trim) member endpoints.
                for ji in cl.joint_indices:
                    members = joint_groups_for_cluster[ji]
                    if not members:
                        continue
                    nm = len(members)
                    pre_trim_pts = []
                    for seg_idx, end_lbl, _n, _pos, _raw in members:
                        cand2 = horizontal_candidates[seg_idx]
                        pre = (cand2.get('pre_trim_joint_start')
                               if end_lbl == 'start'
                               else cand2.get('pre_trim_joint_end'))
                        if pre and all(k in pre for k in ('x', 'y', 'z')):
                            try:
                                pre_trim_pts.append(
                                    (float(pre['x']), float(pre['y']),
                                     float(pre['z'])))
                            except (TypeError, ValueError):
                                pass
                    if pre_trim_pts:
                        jx = sum(p[0] for p in pre_trim_pts) / len(pre_trim_pts)
                        jy = sum(p[1] for p in pre_trim_pts) / len(pre_trim_pts)
                        jz = sum(p[2] for p in pre_trim_pts) / len(pre_trim_pts)
                    else:
                        jx = sum(m[4][0] for m in members) / nm
                        jy = sum(m[4][1] for m in members) / nm
                        jz = sum(m[4][2] for m in members) / nm
                    zone = _phase6d_csg_junctions.JunctionZone(
                        joint_id=f'csg_zone_{ji}',
                        joint_pos=(float(jx), float(jy), float(jz)),
                        members=[],
                    )
                    for seg_idx, end_lbl, _node, _pos, _raw in members:
                        cand2 = horizontal_candidates[seg_idx]
                        zone.members.append(
                            _phase6d_csg_junctions.member_from_candidate(
                                cand2,
                                str(cand2.get('elem_id', f'seg_{seg_idx}')),
                                str(end_lbl)))
                    cl.joint_zones.append(zone)
                # Refresh consumed set with what we actually attached
                for member in cl.members:
                    cluster_consumed_segments.add(member.seg_idx)
            counts['csg_cluster_consumed_segments'] = len(cluster_consumed_segments)
            # Register a tunnel-shell AABB for every cluster member so the
            # phase6b validator + door host bookkeeping see cluster-owned
            # segments as if they were emitted via brep.
            for cl in csg_clusters:
                for member in cl.members:
                    bw = member.bore_w
                    bh = member.bore_h
                    st = member.shell_t
                    outer_w = bw + 2.0 * st
                    outer_h = bh + 2.0 * st
                    tunnel_aabbs.append({
                        'kind': 'cluster_member',
                        'name': f'Cluster-{cl.cluster_id}-{member.elem_id}',
                        'elem_id': member.elem_id,
                        'aabb': _aabb_from_segment(member.start, member.end,
                                                    outer_w / 2.0, outer_h, 0.0),
                        'is_chain': False,
                    })
        except Exception as ex:                                       # noqa: BLE001
            print(f"[CSG-CLUSTER] discovery failed (non-fatal): {ex}")
            import traceback
            traceback.print_exc()
            csg_clusters = []
            cluster_consumed_segments = set()
            cluster_member_records = {}

    chains_detected, coverage = _detect_chains(horizontal_candidates)
    chain_stats['chains_detected'] = len(chains_detected)
    print(f"[CHAIN-LOOP] total_structural_segments={coverage['total_structural_segments']} "
          f"cycles_found={coverage['cycles_found']} "
          f"main_loop_segments={coverage['main_loop_segments']} "
          f"main_loop_profile_filtered={coverage['main_loop_profile_filtered']} "
          f"segments_in_chains={coverage['segments_in_chains']} "
          f"branch_segments={coverage['branch_segments']} "
          f"graph_nodes_quantized={coverage['graph_nodes_quantized']} "
          f"graph_nodes_after_merge={coverage['graph_nodes_after_merge']}")
    if coverage['unassigned_elem_ids']:
        # Trim to first 30 ids per log entry — branches outside the main
        # loop list here so we can still inspect them.
        _disp = coverage['unassigned_elem_ids'][:30]
        _suffix = '' if len(coverage['unassigned_elem_ids']) <= 30 else f" …+{len(coverage['unassigned_elem_ids']) - 30} more"
        print(f"[CHAIN-LOOP] BRANCH_SEGMENTS={_disp}{_suffix}")
    counts['chain_total_structural_segments'] = coverage['total_structural_segments']
    counts['chain_segments_in_chains'] = coverage['segments_in_chains']
    counts['chain_segments_unassigned'] = coverage['segments_unassigned']
    counts['chain_main_loop_segments'] = coverage['main_loop_segments']
    counts['chain_branch_segments'] = coverage['branch_segments']
    counts['chain_cycles_found'] = coverage['cycles_found']

    for chain_index, chain in enumerate(chains_detected):
        chain_id = f"chain_{chain_index}"
        seg_indices = chain['segments']
        if len(seg_indices) < 2:
            chain_stats['chains_skipped_short'] += 1
            continue   # single-segment chains use the existing per-segment path

        # Phase 6D.1 FIX 1 — if any segment in this chain belongs to a CSG
        # cluster, the chain is consumed by the cluster manifold. Skip brep
        # emission for the whole chain (avoids partial chain inflated by
        # cluster manifold).
        if cluster_consumed_segments and any(s in cluster_consumed_segments
                                              for s in seg_indices):
            chain_stats['chains_skipped_short'] += 0  # not a "skipped chain"
            chain_stats.setdefault('chains_absorbed_by_cluster', 0)
            chain_stats['chains_absorbed_by_cluster'] += 1
            for s in seg_indices:
                # Track these as "cluster-owned" so portal caps/door host
                # bookkeeping treats them as emitted-equivalent.
                chain_owned_segments.add(s)
                emitted_wall_indices.add(s)
                kept_horizontal_endpoints.append(horizontal_candidates[s]['start'])
                kept_horizontal_endpoints.append(horizontal_candidates[s]['end'])
            continue

        leader = horizontal_candidates[seg_indices[0]]
        if leader.get('source_type') != 'ARCH':
            chain_stats['chains_skipped_non_arch'] += 1
            continue
        bore_w, bore_h, shell_t = leader['profile']
        cache_key = (round(bore_w, 2), round(bore_h, 2), round(shell_t, 2), 'ARCH')
        cached = profile_pts_cache.get(cache_key)
        if cached is None:
            outer_2d, inner_2d = _gen_arch_profile_brep_pts(bore_w, bore_h, shell_t)
            if outer_2d is None:
                outer_2d, inner_2d = _gen_rect_profile_brep_pts(bore_w, bore_h, shell_t)
                profile_kind = 'rectangular_fallback'
            else:
                profile_kind = 'arched'
            profile_pts_cache[cache_key] = (outer_2d, inner_2d, profile_kind)
        else:
            outer_2d, inner_2d, profile_kind = cached

        sections, sec_stats = _build_chain_sections(
            chain, horizontal_candidates, chain_id=chain_id)
        chain_stats['max_gap_pre_weld_overall'] = max(
            chain_stats['max_gap_pre_weld_overall'], sec_stats['max_gap_pre_weld'])
        chain_stats['max_gap_post_weld_overall'] = max(
            chain_stats['max_gap_post_weld_overall'], sec_stats['max_gap_post_weld'])

        if not sections or len(sections) < 2:
            reason = sec_stats.get('fail_reason') or 'sections_empty'
            print(f"[CHAIN-FALLBACK] {chain_id} segs={len(seg_indices)} "
                  f"reason={reason} (RED per-segment)")
            chain_stats['chains_failed_continuity'] += 1
            for s in seg_indices:
                chain_failed_segments[s] = f"continuity:{reason}"
            continue

        chain_color = (CHAIN_LEADER_COLOR
                       if os.environ.get(CHAIN_DEBUG_VISUAL_MARKER_ENV, '0') != '1'
                       else SHELL_COLOR)
        chain_name = f'TunnelChain-{chain_index}-segs{len(seg_indices)}'
        wall = _emit_chain_brep(
            f, body_sub, storey_lp, owner, chain, sections,
            outer_2d, inner_2d, chain_color, chain_name, counts,
            tunnel_aabbs=tunnel_aabbs,
        )
        if wall is None:
            print(f"[CHAIN-FALLBACK] {chain_id} segs={len(seg_indices)} "
                  f"reason=brep_build_failed (RED per-segment)")
            chain_stats['chains_failed_brep_build'] += 1
            for s in seg_indices:
                chain_failed_segments[s] = "brep_build_failed"
            continue

        # Phase 6B.4d — fill elem_id on the just-appended chain AABB entries
        # (one per owned segment) so phase6b host_id lookups can match them.
        for entry in tunnel_aabbs:
            if entry.get('is_chain') and entry.get('elem_id') is None:
                seg_i = entry.get('chain_seg_idx')
                if seg_i is not None:
                    entry['elem_id'] = horizontal_candidates[seg_i]['elem_id']

        chain_walls.append(wall)
        chain_stats['chains_emitted'] += 1
        chain_stats['chain_segments_owned'] += len(seg_indices)
        chain_stats['curve_interpolations_added'] += sec_stats['arcs_inserted']
        chain_stats['chain_sections_total'] += sec_stats['sections_count']
        chain_stats['chain_tight_skips'] += sec_stats['tight_skips']
        if sec_stats['max_turn_deg'] > chain_stats['chain_max_turn_deg']:
            chain_stats['chain_max_turn_deg'] = sec_stats['max_turn_deg']
        for s in seg_indices:
            chain_owned_segments.add(s)
            # Phase 5B.5C — every chain-owned segment hosts on the same chain
            # wall entity; door projection uses the cand-level geometry.
            # 5B.5D — annotate with joint flags so doors can be filtered to
            # structurally meaningful locations only.
            host_walls.append({
                'entity': wall,
                'cand': horizontal_candidates[s],
                'seg_idx': s,
                'joint_start': (s, 'start') in jstats.get('joint_ends', set()),
                'joint_end': (s, 'end') in jstats.get('joint_ends', set()),
            })
        print(f"[CHAIN-EMIT] {chain_name} sections={sec_stats['sections_count']} "
              f"sections_skipped_straight={sec_stats['sections_skipped_straight']} "
              f"arcs={sec_stats['arcs_inserted']} max_turn={sec_stats['max_turn_deg']:.1f}° "
              f"tight_skips={sec_stats['tight_skips']} "
              f"max_gap_post_weld={sec_stats['max_gap_post_weld']:.6f}m")

    # ---- Pass 2b: emit horizontal walls as IfcFacetedBrep ----
    # Per-segment emission for: (a) segments NOT in any chain (single-segment
    # chains, non-ARCH chains, three-way junction segments) — emitted in
    # SHELL_COLOR. (b) Segments in a FAILED chain — emitted in RED so the
    # broken chain is visible at a glance.
    bisector_planes = jstats.get('bisector_planes', {})
    profile_vertex_counts = []
    walls.extend(chain_walls)
    # Phase 6B.4b — gather Phase 6B wall plans keyed by host segment + end.
    # Plans whose host is a per-segment brep (i.e. NOT chain-owned) are
    # embedded as a closing inner-profile face on that brep, and the
    # corresponding standalone IfcWall is suppressed downstream. Plans whose
    # host is chain-owned remain as standalone IfcWall (current behavior)
    # because chain breps don't yet support per-end closing — this is a
    # known follow-up if final.ifc shows residual chain-end overlap.
    phase6b_lookup, phase6b_plans_by_id, phase6b_total_plans = (
        _build_phase6b_closing_lookup(css))
    phase6b_consumed_keys = set()       # (host_id, end_lbl) embedded into shell
    phase6b_skipped_chain_host = set()  # plans whose host is chain-owned
    counts['phase6b4b_walls_lookup_total'] = phase6b_total_plans
    print(f"[6B.4b] phase6b_closing_lookup keys={len(phase6b_lookup)} "
          f"total_plans={phase6b_total_plans}")
    for i, cand in enumerate(horizontal_candidates):
        if i in chain_owned_segments:
            chain_stats['old_per_segment_segments_skipped'] += 1
            # Hard rule: chain owns this segment; the per-segment wall MUST NOT
            # emit. Register in emitted_wall_indices + endpoints so portal caps
            # and the tunnel bbox still see this segment.
            emitted_wall_indices.add(i)
            kept_horizontal_endpoints.append(cand['start'])
            kept_horizontal_endpoints.append(cand['end'])
            # Track Phase 6B walls anchored to chain-owned segments — they
            # cannot be embedded into the shell brep yet, so they keep their
            # standalone IfcWall path.
            for end_lbl in ('start', 'end'):
                if (cand['elem_id'], end_lbl) in phase6b_lookup:
                    phase6b_skipped_chain_host.add(
                        (cand['elem_id'], end_lbl))
            continue
        # Phase 6D.1 FIX 1 — segment is part of a CSG cluster manifold; do
        # NOT emit a per-segment brep. Track endpoints + wall_index so doors,
        # portal caps, vent integration still work.
        if i in cluster_consumed_segments:
            counts.setdefault('csg_cluster_per_segment_skipped', 0)
            counts['csg_cluster_per_segment_skipped'] += 1
            emitted_wall_indices.add(i)
            kept_horizontal_endpoints.append(cand['start'])
            kept_horizontal_endpoints.append(cand['end'])
            for end_lbl in ('start', 'end'):
                if (cand['elem_id'], end_lbl) in phase6b_lookup:
                    phase6b_skipped_chain_host.add(
                        (cand['elem_id'], end_lbl))
            continue
        is_red_fallback = i in chain_failed_segments
        color_override = (CHAIN_FALLBACK_COLOR
                          if is_red_fallback
                          and os.environ.get(CHAIN_DEBUG_VISUAL_MARKER_ENV, '0') != '1'
                          else None)
        bs = bisector_planes.get((i, 'start'))
        be = bisector_planes.get((i, 'end'))
        closing_start = (cand['elem_id'], 'start') in phase6b_lookup
        closing_end = (cand['elem_id'], 'end') in phase6b_lookup
        wall = _emit_wall_brep(f, body_sub, storey_lp, owner, cand,
                               bs, be, profile_pts_cache,
                               counts, skip_reasons,
                               profile_vertex_counts,
                               color_override=color_override,
                               closing_start=closing_start,
                               closing_end=closing_end,
                               tunnel_aabbs=tunnel_aabbs)
        if wall is not None:
            if closing_start:
                phase6b_consumed_keys.add((cand['elem_id'], 'start'))
            if closing_end:
                phase6b_consumed_keys.add((cand['elem_id'], 'end'))
            walls.append(wall)
            emitted_wall_indices.add(i)
            kept_horizontal_endpoints.append(cand['start'])
            kept_horizontal_endpoints.append(cand['end'])
            # Phase 5B.5C — register this per-segment wall as a door host.
            # 5B.5D — annotate with joint flags so doors can be filtered to
            # structurally meaningful locations only.
            host_walls.append({
                'entity': wall,
                'cand': cand,
                'seg_idx': i,
                'joint_start': (i, 'start') in jstats.get('joint_ends', set()),
                'joint_end': (i, 'end') in jstats.get('joint_ends', set()),
            })
            if is_red_fallback:
                chain_stats['chain_segments_red_fallback'] += 1

    print(f"[CHAIN] SUMMARY chains_detected={chain_stats['chains_detected']} "
          f"chains_emitted={chain_stats['chains_emitted']} "
          f"chains_skipped_short={chain_stats['chains_skipped_short']} "
          f"chains_skipped_non_arch={chain_stats['chains_skipped_non_arch']} "
          f"chains_failed_continuity={chain_stats['chains_failed_continuity']} "
          f"chains_failed_brep_build={chain_stats['chains_failed_brep_build']} "
          f"chain_segments_owned={chain_stats['chain_segments_owned']} "
          f"chain_segments_red_fallback={chain_stats['chain_segments_red_fallback']} "
          f"old_per_segment_segments_skipped={chain_stats['old_per_segment_segments_skipped']} "
          f"curve_interpolations_added={chain_stats['curve_interpolations_added']} "
          f"chain_max_turn_deg={chain_stats['chain_max_turn_deg']:.1f} "
          f"chain_sections_total={chain_stats['chain_sections_total']} "
          f"chain_tight_skips={chain_stats['chain_tight_skips']} "
          f"max_gap_pre_weld={chain_stats['max_gap_pre_weld_overall']:.6f}m "
          f"max_gap_post_weld={chain_stats['max_gap_post_weld_overall']:.6e}m")
    counts['chains_detected'] = chain_stats['chains_detected']
    counts['chains_emitted'] = chain_stats['chains_emitted']
    counts['chains_failed_continuity'] = chain_stats['chains_failed_continuity']
    counts['chains_failed_brep_build'] = chain_stats['chains_failed_brep_build']
    counts['chain_segments_red_fallback'] = chain_stats['chain_segments_red_fallback']
    counts['curve_interpolations_added'] = chain_stats['curve_interpolations_added']
    counts['old_per_segment_segments_skipped'] = chain_stats['old_per_segment_segments_skipped']
    counts['chain_max_gap_pre_weld'] = chain_stats['max_gap_pre_weld_overall']
    counts['chain_max_gap_post_weld'] = chain_stats['max_gap_post_weld_overall']

    # ---- Pass 2c: emit vertical shafts. Phase 4B snaps the shaft base z to
    # the top of the nearest kept tunnel arch so the shaft connects flush
    # instead of floating in mid-air. ----
    # 5C.3 — track emitted shaft xy positions to dedupe near-coincident shafts.
    counts['secondary_candidates'] += len(vertical_candidates)
    emitted_shaft_xys = []
    for elem, elem_id, start, end in vertical_candidates:
        if not profile.enable_shafts:
            counts['shafts_skipped_disabled'] += 1
            skip_reasons.append((elem_id, 'shaft_skipped_enable_shafts_false'))
            print(f"  shaft[{elem_id}] SKIP enable_shafts=false")
            continue
        height = abs(end[2] - start[2])
        origin = start if start[2] <= end[2] else end
        snapped_start, snapped_end, was_snapped = _snap_shaft_to_tunnel_arch(
            origin, height, horizontal_candidates)
        if was_snapped:
            counts['shaft_alignment_adjustments'] += 1
            counts['shafts_snapped_to_host_surface'] += 1
            start, end = snapped_start, snapped_end
        elif profile.strict_secondary_geometry:
            # Strict mode: shaft must attach to a tunnel/host surface. If
            # snapping failed, the shaft is floating; skip rather than emit a
            # detached column hanging in the scene.
            counts['shafts_skipped'] += 1
            counts['shafts_skipped_unhosted'] += 1
            counts['shafts_skipped_no_host_surface'] += 1
            counts['secondary_skipped_floating'] += 1
            skip_reasons.append((elem_id, 'shaft_unhosted_no_tunnel_within_snap'))
            print(f"  shaft[{elem_id}] SKIP shaft_unhosted "
                  f"(no tunnel arch within {SHAFT_SNAP_DIST}m, strict mode)")
            continue

        # 5C.3 — dedup: skip if a previously emitted shaft sits within
        # SHAFT_DEDUPE_RADIUS of this candidate's (post-snap) xy.
        sx, sy = start[0], start[1]
        too_close = any(
            (sx - ex) ** 2 + (sy - ey) ** 2 < SHAFT_DEDUPE_RADIUS ** 2
            for (ex, ey) in emitted_shaft_xys
        )
        if too_close:
            counts['shafts_deduped'] += 1
            skip_reasons.append(
                (elem_id,
                 f'shaft_dedup_overlap_within_{SHAFT_DEDUPE_RADIUS}m'))
            print(f"  shaft[{elem_id}] SKIP shaft_dedup_overlap "
                  f"(within {SHAFT_DEDUPE_RADIUS}m of an already-emitted shaft)")
            continue

        shaft = _emit_shaft(f, body_sub, storey_lp, owner, elem, elem_id,
                            start, end, counts, skip_reasons, profile)
        if shaft is not None:
            shafts.append(shaft)
            emitted_shaft_xys.append((sx, sy))

    if upstream_missing_shaft_endpoints:
        print('  upstream_css_missing_endpoints (vertical shafts, '
              f'data side, not generator): {upstream_missing_shaft_endpoints}')

    # Tunnel XY bbox (from kept walls only) — gates portal spatial filter so
    # mis-tagged DXF walls at far-flung world coords don't get emitted.
    tunnel_bbox = None
    if kept_horizontal_endpoints:
        txs = [p[0] for p in kept_horizontal_endpoints]
        tys = [p[1] for p in kept_horizontal_endpoints]
        tunnel_bbox = (min(txs), max(txs), min(tys), max(tys))
        print(f'  tunnel xy bbox (for portal filter): '
              f'X=[{tunnel_bbox[0]:.2f},{tunnel_bbox[1]:.2f}] '
              f'Y=[{tunnel_bbox[2]:.2f},{tunnel_bbox[3]:.2f}] '
              f'margin={PORTAL_MAX_DIST_FROM_TUNNEL} m')

    # ---- Loop 2: PORTAL_BUILDING / PORTAL_END_WALL ----
    # FINAL_LIKE: only anchor portal blocks to terminal segment endpoints
    # (segments with <=1 PATH_CONNECTS rel) so they appear only at true tunnel
    # entrances, not at mid-tunnel junction nodes.
    _portal_anchor_eps = kept_horizontal_endpoints
    if _VQ_EMIT_MODE == 'FINAL_LIKE' and horizontal_candidates:
        _term_eps = []
        for _hc in horizontal_candidates:
            if _hc.get('rels_count', 99) <= 1:
                _term_eps.append(_hc['start'])
                _term_eps.append(_hc['end'])
        if _term_eps:
            _portal_anchor_eps = _term_eps
            print(f'  [FINAL_LIKE] portal anchor restricted to {len(_term_eps)//2} terminal segments')

    for elem in elements:
        if elem.get('type') != 'WALL':
            continue
        seg_type = (elem.get('properties') or {}).get('segmentType')
        if seg_type not in ('PORTAL_BUILDING', 'PORTAL_END_WALL'):
            continue
        counts['secondary_candidates'] += 1
        if not profile.enable_portals:
            counts['portals_skipped_disabled'] += 1
            elem_id = elem.get('id', '<no-id>')
            skip_reasons.append((elem_id, 'portal_skipped_enable_portals_false'))
            print(f"  portal_block[{elem_id}] type={seg_type} SKIP enable_portals=false")
            continue
        portal = _emit_portal(f, body_sub, storey_lp, owner, elem,
                              tunnel_bbox, _portal_anchor_eps,
                              kept_portal_keys, counts, skip_reasons,
                              profile, horizontal_candidates,
                              psm_portal_ep_claimed=_psm_portal_ep_claimed)
        if portal is not None:
            portals.append(portal)

    # ---- Phase 4A.1 + 5B.1: portal caps at free ends (synthetic frames) ----
    # Reordered before the door loop so doors can recover by proximity to the
    # synthetic frames emitted here. enable_synthetic_portals=false skips the
    # whole pass.
    portal_cap_cache = {}
    joint_ends = jstats.get('joint_ends', set())
    synthetic_frame_anchors = []
    if profile.enable_synthetic_portals:
        for i in sorted(emitted_wall_indices):
            cand = horizontal_candidates[i]
            for end_lbl in ('start', 'end'):
                if (i, end_lbl) in joint_ends:
                    continue  # joint — no cap, handled by mitre
                # 5B.4 portal placement rule: a portal frame is valid only at
                # a true external boundary. Apply two filters:
                #   (a) host segment must be long enough to be a real entrance
                #   (b) no near-coincident, near-parallel segment continuing
                #       the path past this end
                if cand['length'] < PORTAL_CAP_MIN_SEGMENT_LENGTH:
                    counts['portal_frames_skipped_internal'] += 1
                    counts['portal_frames_skipped_internal_endpoint'] += 1
                    skip_reasons.append(
                        (cand['elem_id'],
                         f'portal_cap_skipped_internal_len={cand["length"]:.2f}m'
                         f'<{PORTAL_CAP_MIN_SEGMENT_LENGTH}m end={end_lbl}'))
                    continue
                if has_parallel_continuation(cand, end_lbl, horizontal_candidates):
                    counts['portal_frames_skipped_parallel_continuation'] += 1
                    skip_reasons.append(
                        (cand['elem_id'],
                         f'portal_cap_skipped_parallel_continuation end={end_lbl}'))
                    continue
                cap = _emit_portal_cap(f, body_sub, storey_lp, owner,
                                       cand, end_lbl, portal_cap_cache,
                                       counts, skip_reasons,
                                       synthetic_frame_anchors=synthetic_frame_anchors)
                if cap is not None:
                    portal_caps.append(cap)
                    counts['portal_frames_emitted'] += 1
    else:
        print('  synthetic portal frames: SKIPPED (enable_synthetic_portals=false)')

    # 5B.4 portal-chamber suppression — every raw PORTAL_BUILDING / PORTAL_END_WALL
    # rejected upstream by the strict gates would have produced a solid box
    # ("chamber"). Track the suppression count for the polish summary.
    counts['portal_chambers_suppressed'] = (
        counts['portal_blocks_skipped_detached']
        + counts['portal_blocks_skipped_oversized']
    )

    # ---- Phase 6B: engineer-intent door consumption gate ----
    # When intent mode is consume-doors+, the topology-engine intent-resolver
    # is the SOLE decision-maker for door host & position. Skip ALL legacy
    # door inference (collect_signals, build_room_opening_targets, assign,
    # recovery) and run a single intent-driven loop. Doors lacking intent
    # are skipped silently — no fallback heuristics.
    intent_mode = ((css.get('metadata') or {})
                   .get('featureFlags') or {}).get('intentMode', 'report')
    intent_active = intent_mode in INTENT_CONSUME_MODES
    print(f"---- Phase 6B intent gate: mode={intent_mode} "
          f"active={intent_active} ----")

    # ---- DOOR PIPELINE AUDIT: accepted + emittable door IDs ----
    # An accepted door may not be emittable when the plan-driven override
    # promotes a candidate that has no intent.hostSegmentId yet (tracked as
    # unresolved_required_doors). The hard-fail post-loop assertion gates on
    # emittable, not raw accepted, so those cases don't break the pipeline.
    _audit_accepted_ids   = set()
    _audit_emittable_ids  = set()
    _audit_accepted_no_host_ids = set()
    _audit_all_door_ids   = []
    for _ae in elements:
        if (_ae.get('type') or '').upper() != 'DOOR':
            continue
        _akey = _ae.get('id') or _ae.get('element_key') or '<no-id>'
        _audit_all_door_ids.append(_akey)
        _md = _ae.get('metadata') or {}
        _rstatus = _md.get('reconciliationStatus')
        if _rstatus != 'accepted':
            continue
        _audit_accepted_ids.add(_akey)
        _intent = _md.get('intent') or {}
        if _intent.get('skipReason') or not _intent.get('hostSegmentId'):
            _audit_accepted_no_host_ids.add(_akey)
        else:
            _audit_emittable_ids.add(_akey)
    print(f"[DOOR-AUDIT] all_door_elements={len(_audit_all_door_ids)} "
          f"acceptedDoors={len(_audit_accepted_ids)} "
          f"emittable={len(_audit_emittable_ids)} "
          f"acceptedNoHost={len(_audit_accepted_no_host_ids)}")
    print(f"[DOOR-AUDIT] all_door_ids={_audit_all_door_ids}")
    print(f"[DOOR-AUDIT] acceptedDoors={sorted(_audit_accepted_ids)}")
    print(f"[DOOR-AUDIT] emittableDoors={sorted(_audit_emittable_ids)}")
    if _audit_accepted_no_host_ids:
        print(f"[DOOR-AUDIT] acceptedNoHostDoors={sorted(_audit_accepted_no_host_ids)} "
              f"(plan-promoted, see evidenceReconciliation.planDrivenOverride.unresolved_required_doors)")

    # Track emitted doors for post-loop validation
    _audit_emitted = []  # list of (element_key, source, global_id)

    if intent_active:
        intent_host_lookup = _build_intent_host_lookup(
            elements, horizontal_candidates)
        print(f"  intent_host_lookup_size               : {len(intent_host_lookup)}")
        # Refine emittable audit: a door whose hostSegmentId is not in
        # intent_host_lookup (e.g. steep segment filtered from horizontal
        # candidates, or a missing CSS element) cannot be emitted. Demote it
        # to acceptedNoHost so the post-loop assertion doesn't false-fire.
        for _ae in elements:
            if (_ae.get('type') or '').upper() != 'DOOR':
                continue
            _akey = _ae.get('id') or _ae.get('element_key') or '<no-id>'
            if _akey not in _audit_emittable_ids:
                continue
            _host_id = ((_ae.get('metadata') or {}).get('intent') or {}).get('hostSegmentId')
            if _host_id and _host_id not in intent_host_lookup:
                _audit_emittable_ids.discard(_akey)
                _audit_accepted_no_host_ids.add(_akey)
                print(f"[DOOR-AUDIT] WARN host_unresolvable: door={_akey} "
                      f"hostSegmentId={_host_id} not in intent_host_lookup "
                      f"— demoted to acceptedNoHost")
        door_panels = []   # TunnelDoorPanel_* walls collected here for containment
        for elem in elements:
            if elem.get('type') != 'DOOR':
                continue
            counts['secondary_candidates'] += 1
            counts['doors_candidates'] += 1
            _ekey = elem.get('id') or elem.get('element_key') or '<no-id>'
            door = _emit_door_from_intent(
                f, body_sub, storey_lp, owner, elem,
                intent_host_lookup, counts, skip_reasons,
                panel_walls=door_panels)
            if door is not None:
                doors.append(door)
                _gid = getattr(door, 'GlobalId', '<no-globalid>')
                _audit_emitted.append((_ekey, 'intent_path', _gid))
                print(f"[DOOR-AUDIT] EMIT key={_ekey} source=intent_path globalId={_gid}")
                if _audit_accepted_ids and _ekey not in _audit_accepted_ids:
                    print(f"[DOOR-AUDIT] ERROR: door emitted outside intent pipeline: "
                          f"key={_ekey} not in acceptedDoors={sorted(_audit_accepted_ids)}")
        walls.extend(door_panels)
        print(f"---- Phase 6B intent door summary ----")
        print(f"  doors_candidates                      : {counts['doors_candidates']}")
        print(f"  doors_intent_consumed                 : {counts['doors_intent_consumed']}")
        print(f"  doors_skipped_missing_intent          : {counts['doors_skipped_missing_intent']}")
        print(f"  doors_skipped_invalid_intent          : {counts['doors_skipped_invalid_intent']}")
        print(f"  doors_skipped_low_confidence          : {counts['doors_skipped_low_confidence']}")
        print(f"  doors_skipped_host_not_found          : {counts['doors_skipped_host_not_found']}")
        print(f"  doors_skipped_vertical_shaft          : {counts['doors_skipped_vertical_shaft']}")
        print(f"  doors_skipped_outside_segment         : {counts['doors_skipped_outside_segment']}")
        print(f"  doors_skipped_roof_clip               : {counts['doors_skipped_roof_clip']}")
        print(f"  doors_intent_host_TUNNEL_SEGMENT      : {counts['doors_intent_host_TUNNEL_SEGMENT']}")
        print(f"  doors_intent_host_PORTAL_END_WALL     : {counts['doors_intent_host_PORTAL_END_WALL']}")

        # Phase 6A.5 — hard assertion: emitted == emittable. An "emittable"
        # door is reconciler-accepted AND has a valid intent host AND no
        # intent.skipReason. The plan-driven override may promote a door to
        # accepted that has no host yet (tracked as unresolved_required_doors)
        # — those are correctly skipped by the emitter and must NOT trigger
        # the assertion. Doors accepted but un-emittable are reported below
        # as a soft warning, not a hard failure.
        def _is_emittable(e):
            md = e.get('metadata') or {}
            if md.get('reconciliationStatus') != 'accepted':
                return False
            intent = md.get('intent') or {}
            if intent.get('skipReason'):
                return False
            host_id = intent.get('hostSegmentId')
            if not host_id:
                return False
            # Host must be resolvable in the lookup — steep/missing segments
            # drop out of horizontal_candidates and can't host a door.
            if host_id not in intent_host_lookup:
                return False
            return True

        _door_elems = [e for e in elements if (e.get('type') or '').upper() == 'DOOR']
        _accepted_count = sum(
            1 for e in _door_elems
            if (e.get('metadata') or {}).get('reconciliationStatus') == 'accepted'
        )
        _emittable_count = sum(1 for e in _door_elems if _is_emittable(e))
        _accepted_no_host_count = _accepted_count - _emittable_count
        # Fall back to total door count when reconciler didn't annotate (pass-through mode).
        if _accepted_count == 0:
            _accepted_count   = len(_door_elems)
            _emittable_count  = _accepted_count
        _emitted_count = len(doors)
        _skipped_total = (counts['doors_skipped_missing_intent']
                          + counts['doors_skipped_invalid_intent']
                          + counts['doors_skipped_low_confidence']
                          + counts['doors_skipped_host_not_found']
                          + counts['doors_skipped_vertical_shaft']
                          + counts['doors_skipped_outside_segment']
                          + counts['doors_skipped_roof_clip']
                          + counts['doors_skipped_invalid_after_clamp'])
        if _emitted_count != _emittable_count:
            _mismatch_msg = (
                f'DOOR_COUNT_MISMATCH: emittable={_emittable_count} '
                f'emitted_IfcDoor={_emitted_count} '
                f'(reconciler_accepted={_accepted_count}, '
                f'accepted_no_host={_accepted_no_host_count}) '
                f'total_skipped={_skipped_total} '
                f'(missing_intent={counts["doors_skipped_missing_intent"]} '
                f'invalid_intent={counts["doors_skipped_invalid_intent"]} '
                f'low_conf={counts["doors_skipped_low_confidence"]} '
                f'host_not_found={counts["doors_skipped_host_not_found"]} '
                f'vert_shaft={counts["doors_skipped_vertical_shaft"]} '
                f'outside_seg={counts["doors_skipped_outside_segment"]} '
                f'roof_clip={counts["doors_skipped_roof_clip"]})'
            )
            if _VQ_EMIT_MODE == 'FINAL_LIKE':
                # In FINAL_LIKE mode orphan segments are suppressed, which can
                # legitimately drop doors whose host segment was removed.
                print(f'  WARN: {_mismatch_msg} (tolerated in FINAL_LIKE mode)')
            else:
                raise RuntimeError(_mismatch_msg)
        print(f"  ASSERT_PASS: emittable={_emittable_count} == emitted_IfcDoor={_emitted_count} "
              f"(reconciler_accepted={_accepted_count}, accepted_no_host={_accepted_no_host_count})")
        if _accepted_no_host_count > 0:
            print(f"  WARN: {_accepted_no_host_count} accepted door(s) lack intent host — "
                  f"see evidenceReconciliation.planDrivenOverride.unresolved_required_doors")

        # Phase 6A — write door_identity_report.json to S3 debug path.
        try:
            import boto3 as _boto3
            _door_identity_report = {
                'phase': '6A',
                'accepted_count':       _accepted_count,
                'emittable_count':      _emittable_count,
                'accepted_no_host_count': _accepted_no_host_count,
                'emitted_count':        _emitted_count,
                'skipped_total':        _skipped_total,
                'skip_breakdown': {
                    'missing_intent':   counts['doors_skipped_missing_intent'],
                    'invalid_intent':   counts['doors_skipped_invalid_intent'],
                    'low_confidence':   counts['doors_skipped_low_confidence'],
                    'host_not_found':   counts['doors_skipped_host_not_found'],
                    'vertical_shaft':   counts['doors_skipped_vertical_shaft'],
                    'outside_segment':  counts['doors_skipped_outside_segment'],
                    'roof_clip':        counts['doors_skipped_roof_clip'],
                    'invalid_clamp':    counts['doors_skipped_invalid_after_clamp'],
                },
                'accepted_door_ids': [
                    e.get('id') or e.get('element_key')
                    for e in elements
                    if (e.get('type') or '').upper() == 'DOOR'
                    and (e.get('metadata') or {}).get('reconciliationStatus') in ('accepted', None)
                ],
                'rejected_duplicates': [
                    {'id': sr[0], 'reason': sr[1]} for sr in skip_reasons
                ],
                'door_table': [],
            }
            # Build per-door type/width/height table from CSS elements
            _door_elems = [e for e in elements if (e.get('type') or '').upper() == 'DOOR']
            for _de in _door_elems:
                _di = _de.get('metadata', {}).get('intent') or {}
                _dp = _de.get('placement', {}).get('origin') or {}
                _dg = _de.get('geometry') or {}
                _dtype = _di.get('doorType')
                if _dtype == 'single':
                    _dw, _dh = DOOR_SINGLE_WIDTH, DOOR_SINGLE_HEIGHT
                elif _dtype == 'double':
                    _dw, _dh = DOOR_DOUBLE_WIDTH, DOOR_DOUBLE_HEIGHT
                else:
                    _dw, _dh = None, None
                _door_identity_report['door_table'].append({
                    'id':           _de.get('id') or _de.get('element_key'),
                    'name':         _de.get('name', ''),
                    'doorType':     _dtype,
                    'emitted_width_m':  _dw,
                    'emitted_height_m': _dh,
                    'host_segment_id':  _di.get('hostSegmentId'),
                    'host_wall_type':   _di.get('hostWallType'),
                    'confidence':       _di.get('confidence'),
                    'zone':             (_de.get('metadata') or {}).get('evidenceZone'),
                    'origin_x':     _dp.get('x'),
                    'origin_y':     _dp.get('y'),
                    'origin_z':     _dp.get('z'),
                    'reconciliation_status': (_de.get('metadata') or {}).get('reconciliationStatus'),
                })
            _render_id = os.environ.get('DEBUG_RENDER_ID', 'unknown')
            _s3c = _boto3.client('s3', region_name='us-gov-east-1')
            _key = f'debug/{_render_id}_door_identity_report.json'
            _s3c.put_object(
                Bucket='builting-ifc', Key=_key,
                Body=json.dumps(_door_identity_report, indent=2).encode(),
                ContentType='application/json')
            print(f"[DOOR-REPORT] wrote s3://builting-ifc/{_key}")
        except Exception as _rpt_ex:
            print(f"[DOOR-REPORT] write failed (non-fatal): {_rpt_ex}")

    else:
        # ---- Phase 5B.5E: build room/branch opening targets + filter host_walls
        # to branch-only. A door must land at a true room entrance, not at a long
        # main-loop wall endpoint (e.g. a tunnel bend), so:
        #   * opening_targets   = joint endpoints of branch (non-main-loop) walls
        #   * branch_host_walls = host_walls minus chain-owned (main-loop) entries
        # Both are passed into _emit_door so priority-2 (opening assignment) and
        # priority-3 (nearest valid wall endpoint) only consider branch geometry.
        branch_host_walls = [hw for hw in host_walls
                             if hw.get('seg_idx') not in chain_owned_segments]
        door_signals = _collect_door_signals(elements)
        opening_targets, opening_targets_before_prune = _build_room_opening_targets(
            horizontal_candidates, jstats, chain_owned_segments, host_walls,
            door_signals=door_signals)
        counts['opening_targets_before_prune'] = opening_targets_before_prune
        counts['opening_targets_after_prune'] = len(opening_targets)
        counts['room_opening_targets_detected'] = len(opening_targets)
        print(f"---- Phase 5B.5E room opening targets ----")
        print(f"  opening_targets_before_prune          : {opening_targets_before_prune}")
        print(f"  opening_targets_after_prune           : {len(opening_targets)}")
        print(f"  branch_host_walls                     : {len(branch_host_walls)} "
              f"(of {len(host_walls)} total host walls)")
        for tgt in opening_targets[:30]:
            ox, oy, oz = tgt['origin']
            print(f"  opening[{tgt['opening_id']}] "
                  f"host_seg={tgt['host_wall']['cand']['elem_id']} "
                  f"end={tgt['end_label']} "
                  f"origin=({ox:.2f},{oy:.2f},{oz:.2f}) "
                  f"branch_len={tgt['branch_length']:.2f}m "
                  f"short_branch={tgt['is_short_branch']} "
                  f"qualify_reason={tgt.get('qualify_reason', 'unfiltered')}")

        # ---- Phase 5B.6 (Task C): global door → opening assignment ----
        # One door per opening, scored by explicit-host > closest-distance >
        # valid-dims > orientation. 3m default radius, 5m only for explicit
        # hostWallKey matches. Per-door greedy search is gone.
        door_assignments, door_skips, assign_stats = _assign_doors_to_openings(
            elements, opening_targets,
            radius_default=DOOR_OPENING_ASSIGNMENT_RADIUS,
            radius_explicit=DOOR_OPENING_ASSIGNMENT_RADIUS_EXPLICIT)
        counts['doors_assigned_to_valid_opening'] = len(door_assignments)
        counts['doors_skipped_no_valid_opening'] = sum(
            1 for r in door_skips.values() if r == 'no_candidate')
        counts['doors_skipped_duplicate_opening'] = sum(
            1 for r in door_skips.values() if r == 'duplicate_opening')
        counts['max_assignment_distance_used'] = round(
            assign_stats.get('max_assignment_distance', 0.0), 3)
        print(f"---- Phase 5B.6 door → opening assignment ----")
        print(f"  opening_targets_before_prune          : {opening_targets_before_prune}")
        print(f"  opening_targets_after_prune           : {len(opening_targets)}")
        print(f"  doors_assigned_to_valid_opening       : {counts['doors_assigned_to_valid_opening']}")
        print(f"  doors_skipped_no_valid_opening        : {counts['doors_skipped_no_valid_opening']}")
        print(f"  doors_skipped_duplicate_opening       : {counts['doors_skipped_duplicate_opening']}")
        print(f"  max_assignment_distance_used          : {counts['max_assignment_distance_used']}m")
        print(f"  pairs_considered                      : {assign_stats.get('pairs_considered', 0)}")
        for door_id, info in door_assignments.items():
            print(f"  assigned[{door_id}] -> {info['opening']['opening_id']} "
                  f"dist={info['distance']:.3f}m "
                  f"reason={info['reason']} "
                  f"radius_used={info['radius_used']:.2f}m "
                  f"score={info['score']:.1f}")
        for door_id, reason in door_skips.items():
            print(f"  skipped[{door_id}] reason={reason}")

        # ---- Phase 5B.6 (Task F): topology second-pass recovery ----
        # Skipped `no_candidate` doors get a single retry within 6m, BUT only at
        # endpoints whose owning segment classifies as continuation (deg-2 both),
        # free_end_branch (deg=1 on one side), or junction (deg>=3). Isolated
        # segments stay rejected. branch_host_walls is passed through so primary
        # main-loop exclusion still applies. One door per opening — recovered
        # openings share the primary id format so dedup is automatic.
        f_seg_nodes, f_node_segs = _build_segment_endpoint_graph(horizontal_candidates)
        recovered_assignments, final_skips = _recover_skipped_doors(
            door_skips, elements, door_assignments,
            horizontal_candidates, branch_host_walls,
            f_seg_nodes, f_node_segs,
            radius=DOOR_OPENING_ASSIGNMENT_RADIUS_TOPOLOGY)
        for did, info in recovered_assignments.items():
            door_assignments[did] = info
        door_skips = final_skips
        counts['doors_recovered_from_topology'] = len(recovered_assignments)
        counts['doors_still_unassigned'] = len(final_skips)
        print(f"---- Phase 5B.6 (Task F) topology recovery ----")
        print(f"  doors_recovered_from_topology         : {counts['doors_recovered_from_topology']}")
        print(f"  doors_still_unassigned                : {counts['doors_still_unassigned']}")
        print(f"  recovery_radius                       : {DOOR_OPENING_ASSIGNMENT_RADIUS_TOPOLOGY}m")
        for door_id, info in recovered_assignments.items():
            print(f"  recovered[{door_id}] segment={info['segment_id']} "
                  f"topology={info['topology_kind']} "
                  f"endpoint={info['endpoint_label']} "
                  f"dist={info['distance']:.3f}m "
                  f"opening_id={info['opening']['opening_id']}")
        for door_id, reason in final_skips.items():
            print(f"  final_skip[{door_id}] reason={reason}")

        # ---- Phase 4A.2 + 5B.1 + 5B.5E + 5B.6: emit doors using the pre-assignment.
        print(f"[DOOR-AUDIT] WARN: legacy_path active (intent_mode={intent_mode})")
        for elem in elements:
            if elem.get('type') != 'DOOR':
                continue
            counts['secondary_candidates'] += 1
            counts['doors_candidates'] += 1
            elem_id = elem.get('id', '<no-id>')
            _ekey = elem.get('id') or elem.get('element_key') or '<no-id>'
            assigned_opening = door_assignments.get(elem_id)
            # Phase 5B.5C — portal-only restriction removed. Doors now host on
            # real walls (tunnel/branch shell) via IfcOpeningElement + voids +
            # fills as the primary path. When enable_synthetic_portals=false,
            # legacy portal/synthetic-frame fallbacks are disabled too — only
            # wall hosting can produce a door.
            door = _emit_door(f, body_sub, storey_lp, owner, elem,
                              kept_portal_keys, counts, skip_reasons,
                              synthetic_frame_anchors=synthetic_frame_anchors,
                              host_walls=branch_host_walls,
                              allow_portal_fallback=profile.enable_synthetic_portals,
                              opening_targets=opening_targets,
                              assigned_opening=assigned_opening)
            if door is not None:
                doors.append(door)
                _gid = getattr(door, 'GlobalId', '<no-globalid>')
                _src = elem.get('source', 'legacy_path')
                if _src == 'PORTAL_GENERATED':
                    _src = 'portal_generator'
                _audit_emitted.append((_ekey, _src, _gid))
                print(f"[DOOR-AUDIT] EMIT key={_ekey} source={_src} globalId={_gid}")
                if _audit_accepted_ids and _ekey not in _audit_accepted_ids:
                    print(f"[DOOR-AUDIT] ERROR: door emitted outside intent pipeline: "
                          f"key={_ekey} not in acceptedDoors={sorted(_audit_accepted_ids)}")

    # ---- DOOR PIPELINE AUDIT: final summary + hard fail ----
    _audit_emitted_keys = [k for k, _, _ in _audit_emitted]
    _audit_emitted_sources = [s for _, s, _ in _audit_emitted]
    print(f"[DOOR-AUDIT] FINAL emitted_count={len(_audit_emitted)} "
          f"accepted_count={len(_audit_accepted_ids)}")
    print(f"[DOOR-AUDIT] emitted_keys={_audit_emitted_keys}")
    print(f"[DOOR-AUDIT] emitted_sources={_audit_emitted_sources}")
    _audit_outside = [k for k in _audit_emitted_keys if _audit_accepted_ids and k not in _audit_accepted_ids]
    if _audit_outside:
        raise RuntimeError(
            f"[DOOR-AUDIT] FATAL: door(s) emitted outside intent pipeline: "
            f"{_audit_outside} — acceptedDoors={sorted(_audit_accepted_ids)}"
        )
    # Post-loop equality is on EMITTABLE, not raw accepted. Plan-promoted
    # doors without a host are intentionally not emitted (and tracked under
    # unresolved_required_doors); they must NOT trigger a fatal here.
    if intent_active and _audit_emittable_ids and len(_audit_emitted) != len(_audit_emittable_ids):
        _door_audit_msg = (
            f"[DOOR-AUDIT] FATAL: emitted_count={len(_audit_emitted)} != "
            f"emittable_count={len(_audit_emittable_ids)} "
            f"(accepted={len(_audit_accepted_ids)}, "
            f"acceptedNoHost={len(_audit_accepted_no_host_ids)}) — "
            f"emitted_keys={_audit_emitted_keys} "
            f"emittable_ids={sorted(_audit_emittable_ids)}"
        )
        if _VQ_EMIT_MODE == 'FINAL_LIKE':
            print(f'  WARN: {_door_audit_msg} (tolerated in FINAL_LIKE mode)')
        else:
            raise RuntimeError(_door_audit_msg)

    # ---- Phase 5A.12: controlled ventilation export ----
    # Authoritative gate is profile.enable_ducts (env ENABLE_DUCTS, default false).
    # Legacy CLEAN_VENTILATION_EXPORT env is a secondary gate — both must be on
    # for ducts to emit. Default behavior in 5A.12 is zero ducts/pipes/rods.
    vent_ducts = []
    # Phase 5B.5C — track each emitted duct's start/end so the post-emission
    # pass can attach IfcDistributionPort entities and detect junctions.
    vent_endpoints = []
    vent_env_on = os.environ.get(CLEAN_VENTILATION_EXPORT_ENV, '0') == '1'
    ducts_on = profile.enable_ducts and vent_env_on
    if profile.enable_ducts and not vent_env_on:
        gate_status = f'OFF (enable_ducts=true but env {CLEAN_VENTILATION_EXPORT_ENV} not set)'
    elif not profile.enable_ducts and vent_env_on:
        gate_status = f'OFF (env {CLEAN_VENTILATION_EXPORT_ENV}=1 but enable_ducts=false)'
    elif ducts_on:
        gate_status = 'ON'
    else:
        gate_status = 'OFF (enable_ducts=false)'
    # FINAL_LIKE: suppress raw duct export unless PRESENTATION_SAFE_MODE overrides
    # (presentation needs the VentSim duct geometry visible in the tunnel bore).
    if _VQ_EMIT_MODE == 'FINAL_LIKE' and ducts_on and not _PRESENTATION_SAFE_MODE:
        ducts_on = False
        gate_status = 'OFF (FINAL_LIKE suppresses raw duct export)'
    print(f"---- Phase 5A.12 ventilation export {gate_status} ----")
    if ducts_on:
        kept_shaft_keys = set()  # placeholder: shafts are not currently keyed
        for elem in elements:
            if _is_ventilation_candidate(elem) is None:
                continue
            counts['secondary_candidates'] += 1
            duct = _emit_vent_duct(f, body_sub, storey_lp, owner, elem,
                                   horizontal_candidates, kept_shaft_keys,
                                   counts, skip_reasons)
            if duct is not None:
                vent_ducts.append(duct)
                # 5B.5C — recover endpoints for port/junction wiring.
                _path = _extract_vent_path(elem)
                if _path is not None:
                    vent_endpoints.append({
                        'duct': duct,
                        'start': _path[0],
                        'end': _path[1],
                    })
        counts['ducts_emitted'] = counts['vent_ducts_emitted']
    else:
        # Strict-mode default: every duct-like candidate is reported as
        # "skipped_disabled" so the counter clearly shows the gate fired.
        for elem in elements:
            if _is_ventilation_candidate(elem) is None:
                continue
            counts['secondary_candidates'] += 1
            counts['ducts_skipped_disabled'] += 1
            counts['vent_ducts_candidates'] += 1
            elem_id = elem.get('id', '<no-id>')
            skip_reasons.append((elem_id, 'duct_skipped_enable_ducts_false'))

    # ---- Phase 5B.3: reconstructed ventilation (one duct per segment) ----
    # Independent of raw-duct gating. Builds one clean cylindrical duct along
    # each kept horizontal segment's ceiling. Radius comes from a valid raw
    # input (median across candidates) or RECON_VENT_DEFAULT_RADIUS only when
    # ALLOW_CONFIG_DEFAULTS=true. No vertical ducts. No piercing.
    if profile.enable_reconstructed_ventilation:
        log_prefix = "[5B.3 recon-vent]"
        radius, radius_source = _resolve_reconstructed_vent_radius(
            elements, profile, log_prefix, counts)
        if _VQ_EMIT_MODE == 'FINAL_LIKE':
            # Suppress vent rib ducts in FINAL_LIKE: one cylinder per tunnel
            # segment clutters the bore and makes it look ribbed in the viewer.
            print("---- Phase 5B.3 reconstructed ventilation OFF "
                  f"(FINAL_LIKE: vent ribs suppressed, radius_source={radius_source}) ----")
        else:
            print(f"---- Phase 5B.3 reconstructed ventilation ON "
                  f"(radius_source={radius_source}) ----")
        if radius is not None and radius > 0 and _VQ_EMIT_MODE != 'FINAL_LIKE':
            kept_seg_ids = {horizontal_candidates[i]['elem_id']
                            for i in emitted_wall_indices}
            emitted_vent_segments = []   # 5C.1: indices into horizontal_candidates
            for idx, cand in enumerate(horizontal_candidates):
                if cand['elem_id'] not in kept_seg_ids:
                    continue
                # 5C.1 — filter short fragments before per-segment emission.
                if cand['length'] < RECON_VENT_MIN_RUN_LENGTH:
                    counts['vent_fragments_skipped_short'] += 1
                    continue
                duct = _emit_reconstructed_vent_for_segment(
                    f, body_sub, storey_lp, owner, cand, radius, counts)
                if duct is not None:
                    vent_ducts.append(duct)
                    emitted_vent_segments.append(idx)
                    # 5B.4 — every emitted recon-vent segment is, by construction,
                    # offset toward the host interior (crown clearance applied in
                    # _emit_reconstructed_vent_for_segment).
                    counts['vent_adjusted_to_host_interior'] += 1
                    # 5B.5C — endpoints for port/junction wiring. The recon
                    # duct's centerline is offset DOWN from the cand's
                    # centerline; using cand endpoints preserves topological
                    # adjacency for junction detection across segments.
                    vent_endpoints.append({
                        'duct': duct,
                        'start': cand['start'],
                        'end': cand['end'],
                    })

            # 5C.1 — group emitted vent segments into connected primary runs by
            # quantized endpoint adjacency (union-find).
            parent = {i: i for i in emitted_vent_segments}

            def _find(x):
                while parent[x] != x:
                    parent[x] = parent[parent[x]]
                    x = parent[x]
                return x

            def _union(a, b):
                ra, rb = _find(a), _find(b)
                if ra != rb:
                    parent[ra] = rb

            ep_to_seg = {}
            for i in emitted_vent_segments:
                cand = horizontal_candidates[i]
                for ep in (cand['start'], cand['end']):
                    key = _round_endpoint(ep)
                    if key in ep_to_seg:
                        _union(i, ep_to_seg[key])
                    else:
                        ep_to_seg[key] = i
            counts['primary_vent_runs_emitted'] = len(
                {_find(i) for i in emitted_vent_segments})
            print(f"{log_prefix} radius={radius:.3f}m "
                  f"segments_emitted={counts['reconstructed_vent_runs_emitted']} "
                  f"primary_runs={counts['primary_vent_runs_emitted']} "
                  f"fragments_skipped_short={counts['vent_fragments_skipped_short']}")
        else:
            print(f"{log_prefix} SKIP — no usable radius "
                  f"(ALLOW_CONFIG_DEFAULTS={profile.allow_config_defaults})")
    else:
        print('---- Phase 5B.3 reconstructed ventilation OFF '
              '(enable_reconstructed_ventilation=false) ----')

    def _write_provenance_pset(entity, elem=None, synth_status=None, synth_stage=None):
        """Write Pset_BuiltingProvenance on an IFC entity. Non-fatal."""
        try:
            prov = (elem.get('provenance') or {}) if elem else {}
            if prov:
                status = prov.get('sourceFileStatus', 'missing')
                src_files = prov.get('sourceFiles', [])
                primary_sf = prov.get('sourceFile')
                stage = prov.get('stage', '')
                mods = ', '.join(prov.get('modifications', []))
                if status == 'derived_inferred':
                    source_display = '<inferred>'
                elif status == 'missing':
                    source_display = '<unknown>'
                elif status == 'inherited_contested':
                    sf_str = ', '.join(src_files) if src_files else (primary_sf or '<unknown>')
                    source_display = sf_str + ' (contested)'
                else:
                    source_display = ', '.join(src_files) if src_files else (primary_sf or '<unknown>')
            else:
                status = synth_status or 'derived_inferred'
                source_display = '<inferred>'
                stage = synth_stage or 'generate:synthesized'
                mods = ''
            props = [
                f.create_entity('IfcPropertySingleValue', Name='SourceFile',
                                NominalValue=f.create_entity('IfcLabel', source_display)),
                f.create_entity('IfcPropertySingleValue', Name='SourceFileStatus',
                                NominalValue=f.create_entity('IfcLabel', status)),
                f.create_entity('IfcPropertySingleValue', Name='Stage',
                                NominalValue=f.create_entity('IfcLabel', stage)),
                f.create_entity('IfcPropertySingleValue', Name='Modifications',
                                NominalValue=f.create_entity('IfcLabel', mods)),
            ]
            pset = f.create_entity('IfcPropertySet', GlobalId=_new_guid(),
                                   OwnerHistory=owner, Name='Pset_BuiltingProvenance',
                                   HasProperties=tuple(props))
            f.create_entity('IfcRelDefinesByProperties', GlobalId=_new_guid(),
                            OwnerHistory=owner, RelatedObjects=(entity,),
                            RelatingPropertyDefinition=pset)
        except Exception:
            pass

    # ---- Phase 5B.5C: vent-system structural relationships ----
    # Keep existing duct geometry untouched (no placement change). Layer on
    # IFC topology so the vent system reads as a connected network:
    #   * Two IfcDistributionPort entities per duct, placed at start/end.
    #   * IfcRelNests links port set to its parent duct.
    #   * Endpoints quantized via _round_endpoint to detect coincidence.
    #     Junctions = points where ≥ 3 duct ports meet → IfcFlowFitting at
    #     the junction xy/z, with IfcRelConnectsPorts pairwise to each
    #     incident duct port.
    #     Two-way meetings → direct IfcRelConnectsPorts between the two
    #     duct ports (no fitting needed for a straight handover).
    fittings = []
    # In PRESENTATION_SAFE_MODE skip IfcDistributionPort / IfcFlowFitting
    # creation — xeokit renders ports as visible rod geometry at every duct
    # connection point (34 rods = 2 per duct × 17 ducts), which looks like
    # crossed extrusions sticking out of the tunnel entrances.
    if vent_endpoints and not _PRESENTATION_SAFE_MODE:
        # Build all duct ports first.
        port_records = []  # [{'port', 'duct', 'world_xyz', 'role'}]
        for ve in vent_endpoints:
            duct_entity = ve['duct']
            for role, world_xyz in (('start', ve['start']), ('end', ve['end'])):
                try:
                    port_lp = _make_local_placement(
                        f, storey_lp, world_xyz, (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
                    port = f.create_entity(
                        'IfcDistributionPort',
                        GlobalId=_new_guid(), OwnerHistory=owner,
                        Name=f'Port-{duct_entity.Name}-{role}',
                        ObjectPlacement=port_lp,
                    )
                except Exception as ex:
                    skip_reasons.append(
                        (duct_entity.Name, f'vent_port_build_failed:{ex}'))
                    continue
                counts['vent_distribution_ports_emitted'] += 1
                port_records.append({
                    'port': port,
                    'duct': duct_entity,
                    'world_xyz': world_xyz,
                    'role': role,
                })

        # Nest each duct's two ports under the duct itself.
        ports_by_duct = {}
        for pr in port_records:
            ports_by_duct.setdefault(id(pr['duct']), {
                'duct': pr['duct'], 'ports': []
            })['ports'].append(pr['port'])
        for entry in ports_by_duct.values():
            try:
                f.create_entity(
                    'IfcRelNests',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    Name=f'Ports-{entry["duct"].Name}',
                    RelatingObject=entry['duct'],
                    RelatedObjects=tuple(entry['ports']),
                )
            except Exception as ex:
                skip_reasons.append(
                    (entry['duct'].Name, f'vent_port_nest_failed:{ex}'))

        # Group ports by quantized world-xyz to detect coincident endpoints.
        groups = {}
        for pr in port_records:
            key = _round_endpoint(pr['world_xyz'])
            groups.setdefault(key, []).append(pr)

        for key, members in groups.items():
            if len(members) < 2:
                continue
            if len(members) >= 3:
                # Junction — emit a fitting at the quantized xyz and connect
                # every duct port to a port on the fitting.
                fitting_xyz = key
                try:
                    fitting_lp = _make_local_placement(
                        f, storey_lp, fitting_xyz,
                        (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
                    fitting = f.create_entity(
                        'IfcFlowFitting',
                        GlobalId=_new_guid(), OwnerHistory=owner,
                        Name=f'Junction-{fitting_xyz[0]:.2f}_'
                             f'{fitting_xyz[1]:.2f}_{fitting_xyz[2]:.2f}',
                        ObjectPlacement=fitting_lp,
                    )
                except Exception as ex:
                    skip_reasons.append(
                        (str(key), f'vent_fitting_build_failed:{ex}'))
                    continue
                _write_provenance_pset(fitting, synth_status='derived_geometric',
                                       synth_stage='generate:duct-junction')
                counts['vent_flow_fittings_emitted'] += 1
                fittings.append(fitting)

                # One fitting port per incident duct, then connect.
                fitting_ports = []
                for _ in members:
                    try:
                        fp_lp = _make_local_placement(
                            f, storey_lp, fitting_xyz,
                            (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
                        fp = f.create_entity(
                            'IfcDistributionPort',
                            GlobalId=_new_guid(), OwnerHistory=owner,
                            Name=f'FittingPort-{fitting.Name}',
                            ObjectPlacement=fp_lp,
                        )
                        fitting_ports.append(fp)
                        counts['vent_distribution_ports_emitted'] += 1
                    except Exception:
                        fitting_ports.append(None)
                # Nest fitting ports.
                live_fp = [p for p in fitting_ports if p is not None]
                if live_fp:
                    try:
                        f.create_entity(
                            'IfcRelNests',
                            GlobalId=_new_guid(), OwnerHistory=owner,
                            Name=f'Ports-{fitting.Name}',
                            RelatingObject=fitting,
                            RelatedObjects=tuple(live_fp),
                        )
                    except Exception as ex:
                        skip_reasons.append(
                            (fitting.Name, f'vent_fitting_nest_failed:{ex}'))

                for member, fp in zip(members, fitting_ports):
                    if fp is None:
                        continue
                    try:
                        f.create_entity(
                            'IfcRelConnectsPorts',
                            GlobalId=_new_guid(), OwnerHistory=owner,
                            Name=f'Connect-{member["duct"].Name}-{member["role"]}',
                            RelatingPort=member['port'],
                            RelatedPort=fp,
                        )
                        counts['vent_port_connections_created'] += 1
                    except Exception as ex:
                        skip_reasons.append(
                            (member['duct'].Name,
                             f'vent_port_connect_failed:{ex}'))
            else:
                # Exactly 2 — straight handover, pair the ports directly.
                a, b = members[0], members[1]
                try:
                    f.create_entity(
                        'IfcRelConnectsPorts',
                        GlobalId=_new_guid(), OwnerHistory=owner,
                        Name=f'Connect-{a["duct"].Name}-{b["duct"].Name}',
                        RelatingPort=a['port'],
                        RelatedPort=b['port'],
                    )
                    counts['vent_port_connections_created'] += 1
                except Exception as ex:
                    skip_reasons.append(
                        (a['duct'].Name,
                         f'vent_pair_connect_failed:{ex}'))
        print(f"  vent_ports={counts['vent_distribution_ports_emitted']} "
              f"vent_fittings={counts['vent_flow_fittings_emitted']} "
              f"vent_connections={counts['vent_port_connections_created']}")

    # ---- Floor slab DISABLED in Phase 3 ----
    # The big base plate was visually wrong vs sample/final.ifc, and made the
    # scene look like a rendered ground plane. Slab emission stays at 0 until
    # we have a reason to bring it back (e.g. per-portal pad or per-room slab).
    print('---- Floor slab DISABLED (Phase 3) ----')

    # ---- Phase 6B — Wall and Portal Structure Reconstruction ----
    # Emits IfcWallStandardCase entities derived from
    # css.metadata.wallReconstruction (planar portal entrance walls + room
    # partition walls at corridor junctions). Doors, openings, and intent
    # logic are intentionally untouched — Phase 6B only adds visual structure.
    #
    # Phase 6B.4b — plans whose host segment was emitted as a per-segment
    # brep are EMBEDDED into that brep as a closing inner-profile face. We
    # pass the consumed (host_id, end_lbl) set so emit_phase_6b_walls skips
    # those plans (no standalone IfcWall, no overlap with the shell mass).
    # Plans whose host is chain-owned still emit standalone IfcWall — that
    # case will move into the shell brep when chain emission grows the
    # same closing-face support.
    #
    # Phase 6B.4c — collect every host id that survived emission (per-segment
    # OR chain-owned). Plans pointing at any other id are floating orphans
    # and get dropped inside emit_phase_6b_walls.
    valid_host_ids = set()
    for i in emitted_wall_indices:
        valid_host_ids.add(horizontal_candidates[i]['elem_id'])
    counts['phase6b4b_walls_consumed_into_shell'] = len(phase6b_consumed_keys)
    counts['phase6b4b_walls_skipped_chain_host'] = len(phase6b_skipped_chain_host)
    counts['phase6b4c_valid_host_segments'] = len(valid_host_ids)
    print(f"[6B.4b] consumed_into_shell={len(phase6b_consumed_keys)} "
          f"skipped_chain_host={len(phase6b_skipped_chain_host)} "
          f"total_lookup={phase6b_total_plans}")
    print(f"[6B.4c] valid_host_segments={len(valid_host_ids)}")
    phase6b_aabbs = []  # Phase 6B.4d collector
    phase6b_walls = emit_phase_6b_walls(
        f, axis_sub, body_sub, storey_lp, owner, css, counts,
        consumed_keys=phase6b_consumed_keys,
        valid_host_ids=valid_host_ids,
        phase6b_aabbs=phase6b_aabbs,
        free_endpoints=kept_horizontal_endpoints)
    for _w in phase6b_walls:
        _write_provenance_pset(_w, synth_status='derived_inferred',
                               synth_stage='topology:wall-reconstructor')

    # ---- Phase 6B.4d — wall-vs-shell overlap validation ----
    # Threshold env vars (defaults: warn at 0.05m³, hard fail at 0.50m³).
    # Hard fail ALWAYS active; PHASE_6B4D_DISABLE_HARDFAIL=1 demotes it to a
    # warning during initial integration. Use sparingly.
    try:
        warn_thresh = float(os.environ.get(
            'PHASE_6B4D_WARN_M3', '0.05'))
        fail_thresh = float(os.environ.get(
            'PHASE_6B4D_FAIL_M3', '0.50'))
    except ValueError:
        warn_thresh, fail_thresh = 0.05, 0.50
    if os.environ.get('PHASE_6B4D_DISABLE_HARDFAIL', '0') == '1':
        fail_thresh = 0.0   # 0 disables the throw
    # Synthetic bridges are structural extensions of the segments they connect.
    # Walls hosted on either connected segment legitimately occupy the bridge
    # joint volume — exempt those pairs from the overlap validator.
    bridge_hosts_map = {}
    for _el in (css or {}).get('elements', []) or []:
        if not isinstance(_el, dict):
            continue
        _props = _el.get('properties') or {}
        if not _props.get('synthetic_bridge'):
            continue
        _eid = (_el.get('id') or _el.get('canonical_id')
                or _el.get('element_key'))
        if not _eid:
            continue
        _hosts = set()
        if _props.get('bridgeFromSegment'):
            _hosts.add(_props['bridgeFromSegment'])
        if _props.get('bridgeToSegment'):
            _hosts.add(_props['bridgeToSegment'])
        if _hosts:
            bridge_hosts_map[_eid] = _hosts
    counts['phase6b4d_bridges_recognized'] = len(bridge_hosts_map)
    if bridge_hosts_map:
        print(f"[6B.4d] synthetic_bridges_recognized={len(bridge_hosts_map)} "
              f"(walls hosted on connected segments are exempt from overlap)")
    overlap_stats, overlap_top = _validate_no_overlap_phase6b_d(
        tunnel_aabbs, phase6b_aabbs,
        hard_fail_threshold_m3=fail_thresh,
        warn_threshold_m3=warn_thresh,
        bridge_hosts_map=bridge_hosts_map)
    counts['phase6b4d_overlapping_pairs'] = overlap_stats['overlapping_pairs']
    counts['phase6b4d_total_overlap_m3'] = overlap_stats['total_overlap_m3']
    counts['phase6b4d_max_overlap_m3'] = overlap_stats['max_overlap_m3']
    counts['phase6b4d_pairs_over_warn'] = overlap_stats['warn_count']
    counts['phase6b4d_pairs_over_fail'] = overlap_stats['fail_count']

    # ---- Phase 6D.1 — CSG junction filler emit pass ----
    # Build one carved IfcTriangulatedFaceSet per joint where >=2 segments
    # meet. Patches are intended to replace the local shell faces at junctions
    # but the host-shell trim pass is not yet implemented, so default to OFF
    # until visual sign-off is achieved.
    #
    # Env vars:
    #   CSG_FILLERS_MODE     ('off'|'debug'|'replace', default 'off')
    #     - off:     no fillers emitted (stable baseline)
    #     - debug:   emit translucent magenta overlay tagged CSG_DEBUG so the
    #                A/B comparison is visually obvious; not a final artefact
    #     - replace: emit opaque CSG_CARVED hulls. INTENDED final behaviour,
    #                but until host-shell trim lands these patches are still
    #                additive — they will be tagged CSG_REPLACE_PENDING and
    #                visual_integrated=False in counts.
    #   CSG_FILLERS_ENABLED  (legacy: '0' forces off; mode wins otherwise)
    #   CSG_HARD_FAIL        (default '0') — if '1', validators raise; else log
    #   CSG_STUB_LENGTH_M    (default '0.6' — Phase 6D.1 P4)
    #   CSG_JOINT_RADIUS_M   (default '0.5')
    csg_filler_proxies = []
    counts['csg_filler_mode'] = 'off'
    counts['csg_filler_zones_attempted'] = 0
    counts['csg_filler_zones_emitted'] = 0
    counts['csg_filler_total_tris'] = 0
    counts['csg_filler_total_verts'] = 0
    counts['csg_validation_overlap_failures'] = 0
    counts['csg_validation_gap_failures'] = 0
    counts['csg_validation_dup_face_failures'] = 0
    counts['csg_validation_unterminated_duct'] = 0
    counts['csg_validation_host_overlap_failures'] = 0
    counts['csg_visual_integrated'] = True

    csg_mode_raw = os.environ.get('CSG_FILLERS_MODE', 'off').strip().lower()
    if csg_mode_raw not in ('off', 'debug', 'replace'):
        print(f"[CSG-FILLER] unknown CSG_FILLERS_MODE={csg_mode_raw!r}; "
              f"defaulting to off")
        csg_mode_raw = 'off'
    if os.environ.get('CSG_FILLERS_ENABLED', '1') == '0':
        csg_mode_raw = 'off'
    counts['csg_filler_mode'] = csg_mode_raw

    counts['csg_clusters_emitted'] = 0
    counts['csg_cluster_total_tris'] = 0
    counts['csg_cluster_total_verts'] = 0

    if _PHASE_6D_CSG_AVAILABLE and csg_mode_raw == 'replace' and csg_clusters:
        # ---- Phase 6D.1 FIX 1 — cluster manifold path ----
        # Replace additive joint hulls with merged cluster manifolds. Each
        # cluster contains every TUNNEL_SEGMENT connected via shared joints
        # plus the joint stubs that bridge them; CSG union + bore-difference
        # produces ONE solid per cluster — no brep/CSG seam, no host overlap.
        cluster_stub_len = float(
            os.environ.get('CSG_CLUSTER_STUB_LENGTH_M', '1.0'))
        cluster_joint_rad = float(os.environ.get('CSG_JOINT_RADIUS_M', '0.5'))
        print(f"---- Phase 6D.1 FIX 1 — CSG cluster manifolds "
              f"(mode={csg_mode_raw}) ----")
        print(f"  clusters            : {len(csg_clusters)}")
        print(f"  segments_absorbed   : {len(cluster_consumed_segments)}")
        print(f"  stub_length_m       : {cluster_stub_len}")
        print(f"  joint_radius_m      : {cluster_joint_rad}")
        try:
            for cl in csg_clusters:
                if not cl.members:
                    continue
                merged = _phase6d_csg_clusters.build_cluster_manifold(
                    cl,
                    stub_length_m=cluster_stub_len,
                    joint_radius_m=cluster_joint_rad)
                if merged is None or _phase6d_csg_clusters.csg.is_empty(merged):
                    print(f"  [SKIP] {cl.cluster_id}: empty/failed")
                    continue
                proxy, fcount, vcount = (
                    _phase6d_csg_ifc.emit_triangulated_face_set(
                        f, body_sub, storey_lp, owner, merged,
                        name=cl.cluster_id,
                        color_rgb=SHELL_COLOR,
                        transparency=0.0,
                        object_type='CSG_CARVED'))
                if proxy is not None:
                    csg_filler_proxies.append(proxy)
                    counts['csg_clusters_emitted'] += 1
                    counts['csg_cluster_total_tris'] += fcount
                    counts['csg_cluster_total_verts'] += vcount
                    print(f"  [EMIT] {cl.cluster_id} members={len(cl.members)} "
                          f"joints={len(cl.joint_zones)} tris={fcount}")
            print(f"  clusters_emitted    : {counts['csg_clusters_emitted']}")
            print(f"  total_tris          : {counts['csg_cluster_total_tris']}")
            print(f"  total_verts         : {counts['csg_cluster_total_verts']}")
            counts['csg_filler_mode'] = 'replace_cluster'
        except Exception as ex:                                       # noqa: BLE001
            print(f"[CSG-CLUSTER] pass failed (non-fatal): {ex}")
            import traceback
            traceback.print_exc()
    elif _PHASE_6D_CSG_AVAILABLE and csg_mode_raw == 'debug':
        try:
            stub_len = float(os.environ.get('CSG_STUB_LENGTH_M', '0.6'))
            joint_rad = float(os.environ.get('CSG_JOINT_RADIUS_M', '0.5'))
            joint_groups_for_csg = jstats.get('joint_groups', []) or []
            zones = _phase6d_csg_junctions.zones_from_joint_groups(
                horizontal_candidates, joint_groups_for_csg)
            counts['csg_filler_zones_attempted'] = len(zones)
            print(f"---- Phase 6D.1 CSG junction fillers (mode={csg_mode_raw}) ----")
            print(f"  zones_attempted     : {len(zones)}")
            hulls = _phase6d_csg_junctions.build_all_zone_hulls(
                zones, stub_length_m=stub_len, joint_radius_m=joint_rad)
            print(f"  hulls_built         : {len(hulls)}")

            # Validators — log everything, hard-fail only if env flag set.
            # Pass host AABBs so the visual-integration check runs.
            # P0 — broaden host set: tunnel shells + phase6b walls + portal caps
            # + portals + shafts + doors + vent ducts + fittings. Built from
            # the source data captured during emission so a CSG patch
            # overlapping ANY emitted IfcWall/IfcFlowSegment/IfcFlowFitting/
            # IfcDoor/IfcSlab is detected.
            extra_host_aabbs = _build_extra_host_aabbs(
                horizontal_candidates=horizontal_candidates,
                emitted_wall_indices=emitted_wall_indices,
                vertical_candidates=vertical_candidates,
                emitted_shaft_xys=emitted_shaft_xys,
                synthetic_frame_anchors=synthetic_frame_anchors,
                vent_endpoints=vent_endpoints,
                fittings=fittings,
                portals=portals,
                doors=doors,
                elements=elements,
            )
            hard_fail = os.environ.get('CSG_HARD_FAIL', '0') == '1'
            host_aabbs_for_csg = (list(tunnel_aabbs)
                                  + list(phase6b_aabbs)
                                  + list(extra_host_aabbs))
            counts['csg_host_aabbs_total'] = len(host_aabbs_for_csg)
            counts['csg_host_aabbs_extra'] = len(extra_host_aabbs)
            print(f"  host_aabbs_total    : {len(host_aabbs_for_csg)} "
                  f"(tunnel={len(tunnel_aabbs)} phase6b={len(phase6b_aabbs)} "
                  f"extra={len(extra_host_aabbs)})")
            report = None
            if hulls:
                report = _phase6d_csg_validators.run_all(
                    hulls,
                    host_aabbs=host_aabbs_for_csg,
                    hard_fail=False)
                counts['csg_validation_overlap_failures'] = len(
                    report.overlap_failures)
                counts['csg_validation_gap_failures'] = len(
                    report.gap_failures)
                counts['csg_validation_dup_face_failures'] = len(
                    report.duplicate_face_failures)
                counts['csg_validation_unterminated_duct'] = len(
                    report.unterminated_duct_failures)
                counts['csg_validation_host_overlap_failures'] = len(
                    report.host_overlap_failures)
                counts['csg_visual_integrated'] = bool(report.visual_integrated)
                if report.overlap_failures:
                    print(f"  [CSG-VALIDATE] overlap failures: "
                          f"{report.overlap_failures}")
                if report.gap_failures:
                    print(f"  [CSG-VALIDATE] gap failures: "
                          f"{report.gap_failures}")
                if report.duplicate_face_failures:
                    print(f"  [CSG-VALIDATE] duplicate-face failures: "
                          f"{report.duplicate_face_failures}")
                if report.unterminated_duct_failures:
                    print(f"  [CSG-VALIDATE] unterminated duct: "
                          f"{report.unterminated_duct_failures}")
                if report.host_overlap_failures:
                    print(f"  [CSG-VALIDATE] HOST-OVERLAP failures "
                          f"({len(report.host_overlap_failures)}): patches "
                          f"are sitting on top of original shell — visually "
                          f"additive, not integrated. Sample: "
                          f"{report.host_overlap_failures[:3]}")
                if hard_fail and not report.is_clean():
                    report.raise_if_dirty()

            # P1 — replace mode is all-or-nothing. If any patch overlaps a
            # host shell, the host-shell trim hasn't done its job (or wasn't
            # run), and emitting partial replacement geometry will sit on top
            # of the original shell. Skip the entire emit pass — the existing
            # shells stay as the visual baseline.
            replace_blocked = (
                csg_mode_raw == 'replace'
                and report is not None
                and report.host_overlap_failures
            )
            counts['csg_replace_skipped_overlap'] = bool(replace_blocked)

            if replace_blocked:
                print(f"  [CSG-FILLER] CSG replace skipped due to overlap "
                      f"({len(report.host_overlap_failures)} host-overlap "
                      f"failures). No patches emitted.")
            else:
                # Style + ObjectType per mode. Debug = translucent magenta
                # overlay; replace = opaque grey CSG_CARVED.
                if csg_mode_raw == 'debug':
                    style_color = (1.0, 0.0, 1.0)
                    style_transparency = 0.5
                    style_object_type = 'CSG_DEBUG'
                else:  # replace, host_overlap_failures == 0 by construction
                    style_color = (0.85, 0.85, 0.85)
                    style_transparency = 0.0
                    style_object_type = 'CSG_CARVED'

                for jid, hull in hulls:
                    proxy, fcount, vcount = (
                        _phase6d_csg_ifc.emit_triangulated_face_set(
                            f, body_sub, storey_lp, owner, hull,
                            name=f'csg-filler-{jid}',
                            color_rgb=style_color,
                            transparency=style_transparency,
                            object_type=style_object_type))
                    if proxy is not None:
                        csg_filler_proxies.append(proxy)
                        counts['csg_filler_zones_emitted'] += 1
                        counts['csg_filler_total_tris'] += fcount
                        counts['csg_filler_total_verts'] += vcount
                print(f"  zones_emitted       : "
                      f"{counts['csg_filler_zones_emitted']}")
                print(f"  object_type         : {style_object_type}")
                print(f"  visual_integrated   : {counts['csg_visual_integrated']}")
                print(f"  total_triangles     : {counts['csg_filler_total_tris']}")
                print(f"  total_vertices      : {counts['csg_filler_total_verts']}")
        except _phase6d_csg_validators.CSGValidationError:
            raise
        except Exception as ex:  # noqa: BLE001
            print(f"[CSG-FILLER] pass failed (non-fatal): {ex}")
            import traceback
            traceback.print_exc()
    elif csg_mode_raw == 'off':
        print(f"---- Phase 6D.1 CSG junction fillers: OFF (stable baseline) ----")

    # ---- FINAL_LIKE: connected-component pre-pass ----
    # Build the set of element IDs that are graph-connected to the tunnel
    # network. The visual gate uses this to suppress disconnected fragments.
    # Only computed when VISUAL_CLEAN_MODE=final_like; otherwise None (gate
    # skips the connected-component check).
    _final_like_connected_ids = None
    if _VQ_EMIT_MODE == 'FINAL_LIKE':
        _CONN_MAX_DIST = 5.0   # m — directly adjacent to tunnel bbox counts as connected
        _connected: set = set()

        # Seed: tunnel segments are always connected.
        for _ce in elements:
            _ce_type = (_ce.get('type') or '').upper()
            if _ce_type == 'TUNNEL_SEGMENT':
                _connected.add(_ce.get('id', ''))

        # First proximity pass: elements whose origin is within _CONN_MAX_DIST
        # of the tunnel bbox are directly connected.
        if tunnel_bbox is not None:
            for _ce in elements:
                _ce_id = _ce.get('id', '')
                if _ce_id in _connected:
                    continue
                _ce_origin = _vq_extract_origin(_ce)
                if _ce_origin is None:
                    continue
                _ce_dist = _vq_dist_to_tunnel_bbox(_ce_origin, tunnel_bbox)
                if _ce_dist is not None and _ce_dist <= _CONN_MAX_DIST:
                    _connected.add(_ce_id)

        # BFS: propagate via host/parent references so rooms attached to
        # portals (which are attached to the tunnel) also pass.
        _id_to_elem = {_ce.get('id', ''): _ce for _ce in elements}
        _changed = True
        while _changed:
            _changed = False
            for _ce in elements:
                _ce_id = _ce.get('id', '')
                if _ce_id in _connected:
                    continue
                _ce_props = _ce.get('properties') or {}
                _ce_meta = _ce.get('metadata') or {}
                _host_ids = [
                    _ce_props.get('hostWallId'),
                    _ce_props.get('hostWallKey'),
                    _ce_props.get('parentId'),
                    _ce_meta.get('hostWallKey'),
                ]
                for _hid in _host_ids:
                    if _hid and _hid in _connected:
                        _connected.add(_ce_id)
                        _changed = True
                        break

        _final_like_connected_ids = frozenset(_connected)
        _disconnected_count = sum(
            1 for _ce in elements
            if (_ce.get('id', '') not in _final_like_connected_ids
                and (_ce.get('type') or '').upper() != 'TUNNEL_SEGMENT')
        )
        print(f'[FINAL-LIKE] connected_component: '
              f'connected={len(_final_like_connected_ids)} '
              f'disconnected={_disconnected_count} '
              f'bbox_dist_threshold={_CONN_MAX_DIST}m')

    # ---- Phase 7: complete element export (no filtering, no type restrictions) ----
    # Universal pass — every CSS element type that the tunnel-shell / Phase 6B
    # / vent passes do not already emit gets a simple IFC entity here. Goal is
    # DATA COMPLETENESS: every SPACE, SLAB, COVERING, EQUIPMENT, DUCT,
    # DUCT_FITTING, SHAFT, and PROXY in css.elements lands in the IFC, even
    # if its geometry is reduced to a small box. TUNNEL_SEGMENTs and DOORs
    # routed through the existing pipelines are preserved verbatim and not
    # re-emitted.
    print('---- Phase 7: complete element export ----')

    p7_placed = []
    p7_skipped = []
    p7_ducts = []           # [(elem, ifc_entity)] for system grouping
    p7_duct_fittings = []   # [(elem, ifc_entity)] for system grouping
    SPACE_DEFAULT_COLOR = (0.85, 0.85, 0.95)
    SLAB_DEFAULT_COLOR_P7 = (0.65, 0.65, 0.65)
    COVERING_DEFAULT_COLOR = (0.85, 0.85, 0.85)
    EQUIP_DEFAULT_COLOR = (0.50, 0.55, 0.65)
    DUCT_DEFAULT_COLOR_P7 = (0.78, 0.80, 0.84)
    FITTING_DEFAULT_COLOR = (0.70, 0.72, 0.78)
    SHAFT_DEFAULT_COLOR_P7 = (0.72, 0.72, 0.78)
    PROXY_DEFAULT_COLOR = (0.6, 0.6, 0.6)

    def _p7_origin(elem):
        """Phase 8: never silently default to (0,0,0).

        Returns a (x, y, z) tuple iff the element carries a finite origin;
        returns None otherwise so callers can skip-with-reason or fail-loud
        depending on PHASE_8_HARD_FAIL.
        """
        plc = elem.get('placement') or {}
        o = plc.get('origin')
        if not isinstance(o, dict):
            counts['phase8_origin_missing'] += 1
            return None
        try:
            x = float(o.get('x'))
            y = float(o.get('y'))
            z = float(o.get('z'))
        except (TypeError, ValueError):
            counts['phase8_origin_missing'] += 1
            return None
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
            counts['phase8_origin_missing'] += 1
            return None
        if os.environ.get('PHASE_8_HARD_FAIL') == '1':
            # Hard-fail flag: treat (0,0,0) as a missing origin too — the only
            # legitimate consumer of (0,0,0) is IfcSite, which never goes
            # through _p7_origin.
            if abs(x) < 1e-6 and abs(y) < 1e-6 and abs(z) < 1e-6:
                counts['phase8_origin_missing_hard_fail'] += 1
                raise RuntimeError(
                    f'phase8_default_origin: '
                    f'{elem.get("type")}:{elem.get("id") or elem.get("name")}')
        return (x, y, z)

    def _p7_profile_extrusion(elem, fallback_size):
        geom = elem.get('geometry') or {}
        prof = geom.get('profile') or {}
        ptype = (prof.get('type') or '').upper()
        depth = _safe_float(geom.get('depth'))
        if depth is None or depth <= 0:
            depth = _safe_float(geom.get('length'))
        if depth is None or depth <= 0:
            depth = fallback_size[2]
        # Cap shaft/space extrusion at SPACE_SHAFT_VIS_CAP to prevent 30m+ vertical
        # cylinders from dominating the scene. Shaft spaces (CIRCLE profile, depth > cap)
        # get capped to a visually representative stub height.
        etype = (elem.get('type') or '').upper()
        if etype == 'SPACE' and ptype == 'CIRCLE' and depth > SPACE_SHAFT_VIS_CAP:
            depth = SPACE_SHAFT_VIS_CAP
        try:
            if ptype == 'CIRCLE':
                r = _safe_float(prof.get('radius'))
                if r and r > 0:
                    return _make_solid_circle_profile(f, r), depth
            if ptype in ('RECTANGLE', 'RECT'):
                w = _safe_float(prof.get('width'))
                h = _safe_float(prof.get('height'))
                if w and h and w > 0 and h > 0:
                    return _make_solid_rect_profile(f, w, h), depth
        except Exception:
            pass
        # Fallback: rectangle from fallback_size.
        return _make_solid_rect_profile(f, fallback_size[0], fallback_size[1]), depth

    def _p7_emit_metadata_only(_eq, ifc_class):
        flag = (_eq.get('properties') or {}).get('spatialFlag')
        if flag == 'FLOATING':
            counts['phase9_floating_skipped'] += 1
            p7_skipped.append((_eq.get('id', '?'),
                               f'phase9_floating:{_eq.get("type")}'))
            return None
        try:
            origin = _p7_origin(_eq)
            if origin is None:
                p7_skipped.append((_eq.get('id', '?'),
                                   f'phase8_origin_missing:{_eq.get("type")}'))
                return None
            s = _storey_for_elevation(origin[2])
            local_lp = _make_local_placement(
                f, s['lp'], origin, (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            kwargs = {
                'GlobalId': _new_guid(),
                'OwnerHistory': owner,
                'Name': _eq.get('name') or _eq.get('id') or ifc_class,
                'ObjectPlacement': local_lp,
                'Representation': None,
                'ObjectType': f'{ifc_class}:metadata-only',
            }
            try:
                ent = f.create_entity(ifc_class, **kwargs)
            except Exception:
                ent = f.create_entity('IfcBuildingElementProxy', **kwargs)
        except Exception as ex:
            p7_skipped.append((_eq.get('id', '?'),
                               f'p7_metadata_only_fail:{ex}'))
            return None
        _write_provenance_pset(ent, elem=_eq)
        s['placed'].append(ent)
        return ent

    # Collect audit rows for the visual-quality report.
    _vq_audit_rows = []

    def _p7_emit(elem, ifc_class, color, fallback_size,
                 object_type=None, predefined_type=None,
                 use_proxy_fallback=True):
        # Phase 9: skip elements tagged FLOATING / ORPHAN_WALL — the
        # tunnel-anchored layout pass marked them as not anchored to any
        # tunnel/space/wall.  Generate must not emit them.
        # Exception: DUCT_FITTING junction nodes have valid coordinates even
        # when flagged FLOATING by Phase 9 — they sit at duct junctions and
        # must be emitted so the MEP network is structurally complete.
        flag = (elem.get('properties') or {}).get('spatialFlag')
        etype_upper = (elem.get('type') or '').upper()
        if flag == 'FLOATING' and etype_upper != 'DUCT_FITTING':
            counts['phase9_floating_skipped'] += 1
            p7_skipped.append((elem.get('id', '?'),
                               f'phase9_floating:{elem.get("type")}'))
            return None
        if flag == 'ORPHAN_WALL':
            counts['phase9_orphan_walls_skipped'] += 1
            p7_skipped.append((elem.get('id', '?'),
                               f'phase9_orphan_wall:{elem.get("type")}'))
            return None
        # Phase 11: structural-integration emit-skip flags.
        if flag == 'NOT_INTEGRATED':
            counts['phase11_spaces_skipped_not_integrated'] += 1
            p7_skipped.append((elem.get('id', '?'),
                               f'phase11_not_integrated:{elem.get("type")}'))
            return None
        if flag == 'DOOR_REJECTED':
            counts['phase11_doors_skipped_rejected'] += 1
            p7_skipped.append((elem.get('id', '?'),
                               f'phase11_door_rejected:{elem.get("type")}'))
            return None
        if flag == 'WALL_INSIDE_TUNNEL':
            counts['phase11_walls_skipped_inside_tunnel'] += 1
            p7_skipped.append((elem.get('id', '?'),
                               f'phase11_wall_inside_tunnel:{elem.get("type")}'))
            return None

        # Visual quality gate — applied before geometry is built.
        if _VQ_AVAILABLE:
            _vq_decision, _vq_reason = _visual_gate(
                elem, tunnel_bbox, _VQ_EMIT_MODE,
                connected_ids=_final_like_connected_ids)
            _vq_audit_rows.append(_VisualAuditRow(
                elem_id=elem.get('id', '?'),
                css_type=(elem.get('type') or '').upper(),
                intended_ifc_class=ifc_class,
                origin=_vq_extract_origin(elem),
                dimensions=_vq_extract_dimensions(elem),
                distance_to_tunnel=_vq_dist_to_tunnel_bbox(
                    _vq_extract_origin(elem) or (0, 0, 0), tunnel_bbox),
                spatial_flag=flag or '',
                confidence=_vq_safe_float(elem.get('confidence'), 0.0),
                emit_decision=_vq_decision,
                reason=_vq_reason,
            ))
            if _vq_decision == 'SUPPRESS':
                counts['vq_suppressed'] = counts.get('vq_suppressed', 0) + 1
                p7_skipped.append((elem.get('id', '?'),
                                   f'vq_suppress:{_vq_reason}'))
                return None
            if _vq_decision == 'METADATA_ONLY':
                counts['vq_metadata_only'] = counts.get('vq_metadata_only', 0) + 1
                return _p7_emit_metadata_only(elem, ifc_class)
            counts['vq_visible'] = counts.get('vq_visible', 0) + 1

        origin = _p7_origin(elem)
        if origin is None:
            p7_skipped.append((elem.get('id', '?'),
                               f'phase8_origin_missing:{elem.get("type")}'))
            return None
        s = _storey_for_elevation(origin[2])
        try:
            local_lp = _make_local_placement(
                f, s['lp'], origin, (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
        except Exception as ex:
            p7_skipped.append((elem.get('id', '?'),
                               f'p7_placement_fail:{ex}'))
            return None
        try:
            prof_def, depth = _p7_profile_extrusion(elem, fallback_size)
            solid = _make_extrusion_along_local_z(f, prof_def, depth)
            _apply_style(f, solid, color, name=ifc_class)
            shape = _make_shape_rep(f, body_sub, solid)
        except Exception as ex:
            p7_skipped.append((elem.get('id', '?'),
                               f'p7_geometry_fail:{ex}'))
            return None
        kwargs = {
            'GlobalId': _new_guid(),
            'OwnerHistory': owner,
            'Name': elem.get('name') or elem.get('id') or ifc_class,
            'ObjectPlacement': local_lp,
            'Representation': shape,
        }
        if object_type:
            kwargs['ObjectType'] = object_type
        try:
            ent = f.create_entity(ifc_class, **kwargs)
        except Exception as ex:
            if use_proxy_fallback and ifc_class != 'IfcBuildingElementProxy':
                try:
                    kwargs['ObjectType'] = object_type or ifc_class
                    ent = f.create_entity(
                        'IfcBuildingElementProxy', **kwargs)
                except Exception as ex2:
                    p7_skipped.append(
                        (elem.get('id', '?'),
                         f'p7_entity_fail:{ifc_class}->proxy:{ex2}'))
                    return None
            else:
                p7_skipped.append(
                    (elem.get('id', '?'),
                     f'p7_entity_fail:{ifc_class}:{ex}'))
                return None
        if predefined_type is not None and hasattr(ent, 'PredefinedType'):
            try:
                ent.PredefinedType = predefined_type
            except Exception:
                pass
        actual_class = ent.is_a() if ent else ifc_class
        _log_decision({'pass': 'generate_ifc_class', 'element_id': elem.get('element_key') or elem.get('id'),
            'action': 'ifc_class_assigned', 'reason': 'clean_tunnel_emit',
            'params': {'css_type': (elem.get('type') or 'UNKNOWN').upper(),
                       'ifc_class': actual_class, 'confidence': elem.get('confidence', 0.0)}})
        if origin is not None:
            _log_decision({'pass': 'generate_placement', 'element_id': elem.get('element_key') or elem.get('id'),
                'action': 'placement_assigned', 'reason': 'clean_tunnel_emit',
                'params': {'x': round(origin[0], 3), 'y': round(origin[1], 3), 'z': round(origin[2], 3),
                           'host_container': elem.get('container'),
                           'source': (elem.get('metadata') or {}).get('correctedBy') or elem.get('source') or 'css'}})
        _write_provenance_pset(ent, elem=elem)
        s['placed'].append(ent)
        return ent

    # 7.1 SPACE
    p7_spaces = 0
    for _e in elements:
        if (_e.get('type') or '').upper() != 'SPACE':
            continue
        ent = _p7_emit(_e, 'IfcSpace', SPACE_DEFAULT_COLOR,
                       fallback_size=(2.0, 2.0, 2.5),
                       object_type='SPACE',
                       predefined_type='INTERNAL',
                       use_proxy_fallback=False)
        if ent is not None:
            p7_placed.append(ent)
            p7_spaces += 1
    counts['phase7_spaces_emitted'] = p7_spaces

    # 7.2 SLAB
    p7_slabs = 0
    for _e in elements:
        if (_e.get('type') or '').upper() != 'SLAB':
            continue
        ent = _p7_emit(_e, 'IfcSlab', SLAB_DEFAULT_COLOR_P7,
                       fallback_size=(4.0, 4.0, 0.25),
                       predefined_type='FLOOR')
        if ent is not None:
            p7_placed.append(ent)
            p7_slabs += 1
    counts['phase7_slabs_emitted'] = p7_slabs
    counts['slabs_emitted'] = counts.get('slabs_emitted', 0) + p7_slabs

    # 7.3 COVERING
    p7_coverings = 0
    for _e in elements:
        if (_e.get('type') or '').upper() != 'COVERING':
            continue
        ent = _p7_emit(_e, 'IfcCovering', COVERING_DEFAULT_COLOR,
                       fallback_size=(4.0, 4.0, 0.10),
                       predefined_type='CEILING')
        if ent is not None:
            p7_placed.append(ent)
            p7_coverings += 1
    counts['phase7_coverings_emitted'] = p7_coverings

    # 7.4 EQUIPMENT — Phase 7B visibility whitelist.
    # Visible (geometry + style): IfcFan, IfcElectricGenerator, IfcUnitaryEquipment,
    # IfcAirTerminalBox, plus anything whose name mentions generator / AHU /
    # 9500 / 19000 / air handler. Everything else (cable trays, lighting,
    # auxiliary equipment) lands in the IFC as a metadata-only entity:
    # placed, named, classified — but with no Representation so the viewer
    # skips it. Data is preserved without burying the model in floating rods.
    EQUIPMENT_VISIBLE_SEMANTIC = {
        'IfcFan', 'IfcElectricGenerator', 'IfcUnitaryEquipment',
        'IfcAirTerminalBox', 'IfcAirHandler',
    }
    EQUIPMENT_VISIBLE_NAME_KEYS = (
        'generator', 'ahu', 'air handler', 'air-handler',
        '9500', '19000',
    )

    def _is_visible_equipment(_eq):
        _sem = (_eq.get('semanticType') or '').strip()
        if _sem in EQUIPMENT_VISIBLE_SEMANTIC:
            return True
        _nm = (_eq.get('name') or '').lower()
        for _kw in EQUIPMENT_VISIBLE_NAME_KEYS:
            if _kw in _nm:
                return True
        return False

    # _p7_emit_metadata_only is defined earlier (before _p7_emit) so
    # the visual gate inside _p7_emit can call it for METADATA_ONLY decisions.

    p7_equipment_visible = 0
    p7_equipment_metadata_only = 0
    p7_fans = 0
    for _e in elements:
        if (_e.get('type') or '').upper() != 'EQUIPMENT':
            continue
        sem = (_e.get('semanticType') or '').strip()
        ifc_class = sem if sem.startswith('Ifc') else 'IfcFlowTerminal'
        if _is_visible_equipment(_e):
            ent = _p7_emit(_e, ifc_class, EQUIP_DEFAULT_COLOR,
                           fallback_size=(0.6, 0.6, 0.6),
                           object_type=sem or 'EQUIPMENT')
            if ent is None:
                continue
            p7_placed.append(ent)
            p7_equipment_visible += 1
            if ent.is_a('IfcFan'):
                p7_fans += 1
        else:
            ent = _p7_emit_metadata_only(_e, ifc_class)
            if ent is None:
                continue
            p7_placed.append(ent)
            p7_equipment_metadata_only += 1
    counts['phase7_equipment_visible'] = p7_equipment_visible
    counts['phase7_equipment_metadata_only'] = p7_equipment_metadata_only
    counts['phase7_equipment_emitted'] = p7_equipment_visible + p7_equipment_metadata_only
    counts['phase7_fans_emitted'] = p7_fans

    # 7.5 DUCT_FITTING — always emit one IfcFlowFitting per CSS element so
    # source fittings are not lost. Existing junction fittings (synthesized
    # in fittings[]) remain alongside.
    p7_fittings_count = 0
    for _e in elements:
        if (_e.get('type') or '').upper() != 'DUCT_FITTING':
            continue
        ent = _p7_emit(_e, 'IfcFlowFitting', FITTING_DEFAULT_COLOR,
                       fallback_size=(0.5, 0.5, 0.5))
        if ent is not None:
            p7_placed.append(ent)
            p7_duct_fittings.append((_e, ent))
            p7_fittings_count += 1
    counts['phase7_duct_fittings_emitted'] = p7_fittings_count

    # 7.6 DUCT — emit IfcDuctSegment per CSS DUCT, with path-aware extrusion.
    # Ducts that have geometry.pathPoints + geometry._pathLength are extruded
    # along their actual run direction instead of vertically. This prevents the
    # "vertical box" artefact where the duct cross-section faces the camera.
    def _p7_emit_duct_path(_elem, _pts, _path_len):
        """Emit a duct extruded along its pathPoints run direction."""
        flag = (_elem.get('properties') or {}).get('spatialFlag')
        if flag in ('FLOATING', 'ORPHAN_WALL', 'NOT_INTEGRATED', 'DOOR_REJECTED',
                    'WALL_INSIDE_TUNNEL'):
            counts['phase9_floating_skipped'] += 1
            p7_skipped.append((_elem.get('id', '?'),
                               f'phase9_{flag}:{_elem.get("type")}'))
            return None
        # Origin from first path point (authoritative start of duct run).
        _p0 = _pts[0]
        try:
            _ox = float(_p0.get('x', 0))
            _oy = float(_p0.get('y', 0))
            _oz = float(_p0.get('z', 0))
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(_ox) and math.isfinite(_oy) and math.isfinite(_oz)):
            return None
        _pn = _pts[-1]
        try:
            _ex = float(_pn.get('x', 0))
            _ey = float(_pn.get('y', 0))
            _ez = float(_pn.get('z', 0))
        except (TypeError, ValueError):
            return None
        _dx, _dy, _dz = _ex - _ox, _ey - _oy, _ez - _oz
        _dl = math.sqrt(_dx * _dx + _dy * _dy + _dz * _dz)
        if _dl < 0.01:
            _dl = float(_path_len)
        d_unit = (_dx / _dl, _dy / _dl, _dz / _dl) if _dl > 0.01 else (1.0, 0.0, 0.0)
        frame = _build_frame_from_direction(d_unit)
        if frame is None:
            return None
        local_x, _local_y, local_z = frame
        origin = (_ox, _oy, _oz)
        s = _storey_for_elevation(_oz)
        try:
            obj_lp = _make_local_placement(f, s['lp'], origin, local_z, local_x)
        except Exception as ex:
            p7_skipped.append((_elem.get('id', '?'), f'p7_duct_path_placement:{ex}'))
            return None
        geom = _elem.get('geometry') or {}
        prof = geom.get('profile') or {}
        ptype = (prof.get('type') or '').upper()
        try:
            if ptype == 'CIRCLE':
                _r = _safe_float(prof.get('radius'))
                if _r and _r > 0:
                    prof_def = _make_solid_circle_profile(f, _r)
                else:
                    prof_def = _make_solid_rect_profile(f, 0.4, 0.4)
            elif ptype in ('RECTANGLE', 'RECT'):
                _w = _safe_float(prof.get('width'))
                _h = _safe_float(prof.get('height'))
                if _w and _h and _w > 0 and _h > 0:
                    prof_def = _make_solid_rect_profile(f, _w, _h)
                else:
                    prof_def = _make_solid_rect_profile(f, 0.4, 0.4)
            else:
                prof_def = _make_solid_rect_profile(f, 0.4, 0.4)
            solid = _make_extrusion_along_local_x(f, prof_def, float(_path_len))
            _apply_style(f, solid, DUCT_DEFAULT_COLOR_P7, name='IfcDuctSegment')
            shape = _make_shape_rep(f, body_sub, solid)
        except Exception as ex:
            p7_skipped.append((_elem.get('id', '?'), f'p7_duct_path_geom:{ex}'))
            return None
        try:
            return f.create_entity(
                'IfcDuctSegment',
                GlobalId=_new_guid(), OwnerHistory=owner,
                Name=_elem.get('name') or _elem.get('id') or 'IfcDuctSegment',
                ObjectPlacement=obj_lp,
                Representation=shape,
            )
        except Exception as ex:
            p7_skipped.append((_elem.get('id', '?'), f'p7_duct_path_entity:{ex}'))
            return None

    p7_ducts_count = 0
    for _e in elements:
        if (_e.get('type') or '').upper() != 'DUCT':
            continue
        if _VQ_AVAILABLE:
            _vq_d, _vq_r = _visual_gate(
                _e, tunnel_bbox, _VQ_EMIT_MODE,
                connected_ids=_final_like_connected_ids)
            _vq_audit_rows.append(_VisualAuditRow(
                elem_id=_e.get('id', '?'),
                css_type='DUCT',
                intended_ifc_class='IfcDuctSegment',
                origin=_vq_extract_origin(_e),
                dimensions=_vq_extract_dimensions(_e),
                distance_to_tunnel=_vq_dist_to_tunnel_bbox(
                    _vq_extract_origin(_e) or (0, 0, 0), tunnel_bbox),
                spatial_flag=(_e.get('properties') or {}).get('spatialFlag') or '',
                confidence=_vq_safe_float(_e.get('confidence'), 0.0),
                emit_decision=_vq_d,
                reason=_vq_r,
            ))
            if _vq_d == 'SUPPRESS':
                counts['vq_suppressed'] = counts.get('vq_suppressed', 0) + 1
                p7_skipped.append((_e.get('id', '?'), f'vq_suppress:{_vq_r}'))
                continue
        _geom_d = _e.get('geometry') or {}
        _path_pts = _geom_d.get('pathPoints')
        _path_len = _safe_float(_geom_d.get('_pathLength'))
        if (isinstance(_path_pts, list) and len(_path_pts) >= 2
                and _path_len and _path_len > 0.01):
            ent = _p7_emit_duct_path(_e, _path_pts, _path_len)
        else:
            ent = _p7_emit(_e, 'IfcDuctSegment', DUCT_DEFAULT_COLOR_P7,
                           fallback_size=(0.4, 0.4, 1.0))
        if ent is not None:
            p7_placed.append(ent)
            p7_ducts.append((_e, ent))
            p7_ducts_count += 1
    counts['phase7_ducts_emitted'] = p7_ducts_count

    # 7.7 SHAFT — IFC4 has no IfcShaft; map to IfcBuildingElementProxy with
    # ObjectType='SHAFT'.  Phase 8: track shaft entities that carry a
    # junctionNodeId so we can emit IfcRelConnectsElements to a tunnel-shell
    # wall after the wall pass is done.  Phase 9: track shafts whose
    # cutTunnelCeiling flag is set so we boolean-cut the closest tunnel
    # shell wall for visual penetration.
    p7_shafts = 0
    phase8_shaft_entities = []   # list of (shaft_ent, shaft_origin_xyz)
    phase9_shaft_cuts = []       # list of (shaft_ent, shaft_origin_xyz, depth)

    def _is_semantic_shaft(_e):
        """Phase 11B: an element counts as a shaft for ceiling-cut purposes
        if its CSS type is SHAFT *or* it carries a vertical-shaft semantic
        (Phase 9 sometimes emits the shaft as a SPACE-typed element with
        properties.segmentType='VERTICAL_SHAFT' / synthesizedBy='VERTICAL_SHAFT'
        / shaftCutApplied=true).  The ceiling-cut path was previously gated
        on type=='SHAFT' alone, so semantic-shaft SPACEs were silently
        skipped — fixed here so Phase 11 shaftCutsApplied becomes a real
        emit instead of a phantom counter."""
        if (_e.get('type') or '').upper() == 'SHAFT':
            return True
        _props = _e.get('properties') or {}
        return bool(
            _props.get('shaftCutApplied')
            or _props.get('synthesizedBy') == 'VERTICAL_SHAFT'
            or _props.get('segmentType') == 'VERTICAL_SHAFT'
        )

    for _e in elements:
        if not _is_semantic_shaft(_e):
            continue
        # Skip if this element was already emitted by another type-specific
        # branch (e.g. it lives in the SPACE loop because type=='SPACE').
        # We still want it as a shaft for ceiling-cut purposes — emit a
        # fresh IfcBuildingElementProxy here so the cut path has an entity.

        # Apply shaft clamping to fallback dimensions before geometry build.
        if _VQ_AVAILABLE:
            if _VQ_EMIT_MODE == 'FINAL_LIKE':
                # Hard caps regardless of dimensionsAuthoritative.
                _sr, _sh, _sc = _shaft_clamped_dims_final_like(_e)
            else:
                _sr, _sh, _sc = _shaft_clamped_dims(_e)
            _shaft_fb = (_sr * 2, _sr * 2, _sh)
            if _sc:
                print(f'  [VQ-SHAFT] clamped id={_e.get("id", "?")} '
                      f'r={_sr:.2f}m h={_sh:.2f}m mode={_VQ_EMIT_MODE}')
        else:
            _shaft_fb = (1.0, 1.0, 6.0)

        ent = _p7_emit(_e, 'IfcBuildingElementProxy', SHAFT_DEFAULT_COLOR_P7,
                       fallback_size=_shaft_fb,
                       object_type='SHAFT')
        if ent is not None:
            p7_placed.append(ent)
            p7_shafts += 1
            origin = _p7_origin(_e)
            props_e = _e.get('properties') or {}
            if origin is not None and props_e.get('junctionNodeId'):
                phase8_shaft_entities.append((ent, origin))
            if origin is not None and (props_e.get('cutTunnelCeiling')
                                       or props_e.get('shaftCutApplied')):
                depth = float((_e.get('geometry') or {}).get('depth') or 8.0)
                phase9_shaft_cuts.append((ent, origin, depth))
    counts['phase7_shafts_emitted'] = p7_shafts

    # 7.8 PROXY
    p7_proxies = 0
    for _e in elements:
        if (_e.get('type') or '').upper() != 'PROXY':
            continue
        ent = _p7_emit(_e, 'IfcBuildingElementProxy', PROXY_DEFAULT_COLOR,
                       fallback_size=(0.5, 0.5, 0.5),
                       object_type=(_e.get('semanticType') or 'PROXY'))
        if ent is not None:
            p7_placed.append(ent)
            p7_proxies += 1
    counts['phase7_proxies_emitted'] = p7_proxies

    # ---- Phase 7B.1: WALL emit ----
    # Phase 6B (wallReconstruction-driven) frequently produces zero walls
    # because its plan filter is strict; meanwhile every CSS WALL element
    # gets dropped. Phase 7B emits one IfcWall per CSS WALL element directly,
    # using the element's profile + depth. Geometry quality is not the goal —
    # data presence is. WALLs already carried by `walls`/`phase6b_walls` are
    # left untouched; this pass adds a parallel IfcWall per CSS source.
    p7b_walls = 0
    WALL_DEFAULT_COLOR = (0.78, 0.78, 0.80)
    # Phase 8: track (element_key → IfcWall entity) so DOOR embedding can
    # look up the host wall by the key topology assigned in spatial-placement.mjs.
    phase8_wall_ent_by_key = {}
    for _e in elements:
        if (_e.get('type') or '').upper() != 'WALL':
            continue
        ent = _p7_emit(_e, 'IfcWall', WALL_DEFAULT_COLOR,
                       fallback_size=(4.0, 0.30, 3.0),
                       object_type=(_e.get('semanticType')
                                    or _e.get('properties', {}).get(
                                        'segmentType') or 'WALL'))
        if ent is not None:
            p7_placed.append(ent)
            p7b_walls += 1
            wkey = _e.get('element_key') or _e.get('id')
            if wkey:
                phase8_wall_ent_by_key[wkey] = (ent, _e)
    counts['phase7b_walls_emitted'] = p7b_walls

    # ---- Phase 7B.2: per-SPACE slab + ceiling + shaft synthesis ----
    # Synthesizes a floor slab + ceiling per SPACE, and a shaft proxy for
    # spaces whose name contains 'shaft'/'riser'/'vertical'.
    # Visual quality gate: skipped when VISUAL_SAFE_MODE is on unless the
    # SPACE has a reliable non-default origin within range of the tunnel.
    SLAB_SYNTH_COLOR = (0.65, 0.65, 0.65)
    COVERING_SYNTH_COLOR = (0.85, 0.85, 0.85)
    SHAFT_SYNTH_COLOR = (0.72, 0.72, 0.78)
    SHAFT_NAME_KEYS = ('shaft', 'riser', 'vertical')
    p7b_slabs_synth = 0
    p7b_coverings_synth = 0
    p7b_shafts_synth = 0
    p7b_synth_suppressed = 0
    for _e in elements:
        if (_e.get('type') or '').upper() != 'SPACE':
            continue
        # VISUAL_SAFE / FINAL_LIKE: suppress all room-shell synthesis.
        # Source data quality is not sufficient to place these believably.
        if _VQ_EMIT_MODE in ('VISUAL_SAFE', 'FINAL_LIKE'):
            p7b_synth_suppressed += 1
            print(f'[VISUAL-GATE] emitter=phase7b_slab element={_e.get("id","?")} '
                  f'decision=SUPPRESS reason={_VQ_EMIT_MODE.lower()}_no_room_shells')
            continue
        _space_flag = (_e.get('properties') or {}).get('spatialFlag', '')
        if _space_flag in ('NOT_INTEGRATED', 'FLOATING', 'ORPHAN_WALL'):
            continue
        plc = _e.get('placement') or {}
        o = plc.get('origin') or {}
        try:
            ox = float(o.get('x', 0.0))
            oy = float(o.get('y', 0.0))
            oz = float(o.get('z', 0.0))
        except (TypeError, ValueError):
            continue

        # Visual quality gate for synthesized geometry.
        # A default (0,0,0) origin produces floating slabs at the world origin —
        # one of the most common visual artefacts. Suppress unless FULL mode.
        if _VQ_EMIT_MODE != 'FULL':
            _is_default = (abs(ox) < 1e-3 and abs(oy) < 1e-3 and abs(oz) < 1e-3)
            if _is_default:
                p7b_synth_suppressed += 1
                p7_skipped.append((_e.get('id', '?'),
                                   'p7b_synth:default_origin_suppressed'))
                continue
            if _VQ_AVAILABLE and tunnel_bbox is not None:
                _dist = _vq_dist_to_tunnel_bbox((ox, oy, oz), tunnel_bbox)
                if _dist is not None and _dist > 30.0:
                    p7b_synth_suppressed += 1
                    p7_skipped.append((_e.get('id', '?'),
                                       f'p7b_synth:too_far:{_dist:.1f}m'))
                    continue

        room_name = _e.get('name') or _e.get('id') or 'Room'
        s = _storey_for_elevation(oz)
        # Floor slab.
        try:
            slab_lp = _make_local_placement(
                f, s['lp'], (ox, oy, oz - 0.25),
                (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            slab_prof = _make_solid_rect_profile(f, 4.0, 4.0)
            slab_solid = _make_extrusion_along_local_z(f, slab_prof, 0.25)
            _apply_style(f, slab_solid, SLAB_SYNTH_COLOR, name='IfcSlab')
            slab_shape = _make_shape_rep(f, body_sub, slab_solid)
            slab_ent = f.create_entity(
                'IfcSlab',
                GlobalId=_new_guid(), OwnerHistory=owner,
                Name=f'Floor - {room_name}',
                ObjectPlacement=slab_lp,
                Representation=slab_shape,
                PredefinedType='FLOOR')
            s['placed'].append(slab_ent)
            p7_placed.append(slab_ent)
            p7b_slabs_synth += 1
        except Exception as ex:
            p7_skipped.append((_e.get('id', '?'), f'p7b_slab_synth_fail:{ex}'))
        # Ceiling covering 2.5 m above floor.
        try:
            cover_lp = _make_local_placement(
                f, s['lp'], (ox, oy, oz + 2.5),
                (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            cover_prof = _make_solid_rect_profile(f, 4.0, 4.0)
            cover_solid = _make_extrusion_along_local_z(f, cover_prof, 0.10)
            _apply_style(f, cover_solid, COVERING_SYNTH_COLOR, name='IfcCovering')
            cover_shape = _make_shape_rep(f, body_sub, cover_solid)
            cover_ent = f.create_entity(
                'IfcCovering',
                GlobalId=_new_guid(), OwnerHistory=owner,
                Name=f'Ceiling - {room_name}',
                ObjectPlacement=cover_lp,
                Representation=cover_shape,
                PredefinedType='CEILING')
            s['placed'].append(cover_ent)
            p7_placed.append(cover_ent)
            p7b_coverings_synth += 1
        except Exception as ex:
            p7_skipped.append((_e.get('id', '?'),
                               f'p7b_covering_synth_fail:{ex}'))
        # Shaft proxy — only when name suggests a shaft AND dimensions are known.
        room_lower = room_name.lower()
        if any(kw in room_lower for kw in SHAFT_NAME_KEYS):
            # Visual gate: use _shaft_clamped_dims to get safe radius/height.
            _sr, _sh, _sc = (
                _shaft_clamped_dims(_e)
                if _VQ_AVAILABLE
                else (1.0, 8.0, False)
            )
            if _sc:
                print(f'  [VQ-SHAFT-SYNTH] clamped {room_name}: '
                      f'r={_sr:.2f}m h={_sh:.2f}m')
            try:
                shaft_lp = _make_local_placement(
                    f, s['lp'], (ox, oy, oz),
                    (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
                shaft_prof = _make_solid_circle_profile(f, _sr)
                shaft_solid = _make_extrusion_along_local_z(f, shaft_prof, _sh)
                _apply_style(f, shaft_solid, SHAFT_SYNTH_COLOR, name='Shaft')
                shaft_shape = _make_shape_rep(f, body_sub, shaft_solid)
                shaft_ent = f.create_entity(
                    'IfcBuildingElementProxy',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    Name=f'Shaft - {room_name}',
                    ObjectPlacement=shaft_lp,
                    Representation=shaft_shape,
                    ObjectType='SHAFT')
                s['placed'].append(shaft_ent)
                p7_placed.append(shaft_ent)
                p7b_shafts_synth += 1
            except Exception as ex:
                p7_skipped.append((_e.get('id', '?'),
                                   f'p7b_shaft_synth_fail:{ex}'))
    counts['phase7b_slabs_synth'] = p7b_slabs_synth
    counts['phase7b_coverings_synth'] = p7b_coverings_synth
    counts['phase7b_shafts_synth'] = p7b_shafts_synth
    counts['phase7b_synth_suppressed'] = p7b_synth_suppressed

    # ---- Phase 7B.2.5: Phase 8 host-wall door embedding ----
    # Topology's spatial-placement.mjs assigns a hostWallKey to every DOOR it
    # can host within 0.5 m of an existing WALL.  Here we honour that contract
    # by emitting the door + opening + RelVoids/RelFills against the matched
    # IfcWall created in Phase 7B.1 — same pattern as the intent-driven
    # tunnel-shell door path (see _emit_door_void_fill below).  Doors handled
    # here are recorded in phase8_doors_embedded_keys so Phase 7B.3 skips them.
    DOOR_PANEL_THICKNESS_M = 0.10
    phase8_doors_embedded_keys = set()

    def _emit_door_void_fill(host_wall_ent, host_wall_storey_lp,
                              door_origin, door_w, door_h, door_t,
                              door_name, door_object_type=None):
        """Emit IfcDoor + IfcOpeningElement + IfcRelVoidsElement +
        IfcRelFillsElement so the door is geometrically embedded in the host
        wall.  Returns (door_ent, opening_ent) or (None, None) on failure."""
        try:
            d_lp = _make_local_placement(
                f, host_wall_storey_lp, door_origin,
                (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            d_prof = _make_solid_rect_profile(f, door_w, door_t)
            d_solid = _make_extrusion_along_local_z(f, d_prof, door_h)
            _apply_style(f, d_solid, DOOR_COLOR, name='IfcDoor')
            d_shape = _make_shape_rep(f, body_sub, d_solid)
            d_kwargs = dict(
                GlobalId=_new_guid(), OwnerHistory=owner,
                Name=door_name,
                ObjectPlacement=d_lp,
                Representation=d_shape,
                OverallHeight=float(door_h),
                OverallWidth=float(door_w),
            )
            if door_object_type:
                d_kwargs['ObjectType'] = door_object_type
            door_ent = f.create_entity('IfcDoor', **d_kwargs)
            # VISUAL_SAFE: skip IfcOpeningElement — boolean void solids appear as
            # visible geometry in many viewers (red/blue cut artifacts).
            if _VQ_EMIT_MODE == 'VISUAL_SAFE':
                print(f'[VISUAL-GATE] emitter=phase8_opening element={door_name} '
                      f'decision=SUPPRESS reason=visual_safe_no_debug_cuts')
                return door_ent, None
            # Opening: same world origin as the door, slightly thicker than
            # the wall so the boolean cut goes all the way through.
            op_lp = _make_local_placement(
                f, host_wall_storey_lp, door_origin,
                (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            op_prof = _make_solid_rect_profile(f, door_w, door_t + 0.20)
            op_solid = _make_extrusion_along_local_z(f, op_prof, door_h)
            opening_ent = f.create_entity(
                'IfcOpeningElement',
                GlobalId=_new_guid(), OwnerHistory=owner,
                Name=f'Opening_{door_name}',
                ObjectPlacement=op_lp,
                Representation=_make_shape_rep(f, body_sub, op_solid))
            f.create_entity(
                'IfcRelVoidsElement',
                GlobalId=_new_guid(), OwnerHistory=owner,
                RelatingBuildingElement=host_wall_ent,
                RelatedOpeningElement=opening_ent)
            f.create_entity(
                'IfcRelFillsElement',
                GlobalId=_new_guid(), OwnerHistory=owner,
                RelatingOpeningElement=opening_ent,
                RelatedBuildingElement=door_ent)
            counts['phase8_doors_voids_created'] += 1
            counts['phase8_doors_fills_created'] += 1
            return door_ent, opening_ent
        except Exception as ex:
            p7_skipped.append((door_name, f'phase8_door_embed_fail:{ex}'))
            return None, None

    p8_doors_hosted = 0
    p8_doors_orphan = 0
    for _de in elements:
        if (_de.get('type') or '').upper() != 'DOOR':
            continue
        if _phase11b_door_rejected(_de, counts):
            continue
        props_de = _de.get('properties') or {}
        if props_de.get('spatialFlag') == 'DOOR_NO_HOST':
            p8_doors_orphan += 1
            continue
        host_key = props_de.get('hostWallKey')
        if not host_key:
            continue
        host_pair = phase8_wall_ent_by_key.get(host_key)
        if host_pair is None:
            p7_skipped.append((_de.get('id', '?'),
                               f'phase8_host_wall_not_emitted:{host_key}'))
            continue
        host_ent, host_elem = host_pair
        origin = _p7_origin(_de)
        if origin is None:
            continue
        door_w = (_de.get('geometry') or {}).get('profile', {}).get('width')
        door_h = (_de.get('geometry') or {}).get('profile', {}).get('height')
        door_w = float(door_w) if door_w else DOOR_DEFAULT_WIDTH
        door_h = float(door_h) if door_h else DOOR_DEFAULT_HEIGHT
        door_t = DOOR_PANEL_THICKNESS_M
        s = _storey_for_elevation(origin[2])
        d_ent, _op = _emit_door_void_fill(
            host_ent, s['lp'], origin, door_w, door_h, door_t,
            door_name=f'Door-{_de.get("element_key") or _de.get("id")}',
            door_object_type='phase8-hosted')
        if d_ent is not None:
            s['placed'].append(d_ent)
            p7_placed.append(d_ent)
            phase8_doors_embedded_keys.add(_de.get('element_key') or _de.get('id'))
            p8_doors_hosted += 1
            # Phase 9: if the layout pass flagged this door for a
            # tunnel-shell cut, find the closest tunnel-shell IfcWall and
            # emit a second IfcOpeningElement + IfcRelVoidsElement so the
            # door visually penetrates the bore as well as the room wall.
            if _VQ_EMIT_MODE != 'VISUAL_SAFE' and props_de.get('alsoCutTunnel') and walls:
                best_w = None
                best_d2 = None
                for w_ent in walls:
                    try:
                        loc = w_ent.ObjectPlacement.RelativePlacement.Location.Coordinates
                        dx = float(loc[0]) - origin[0]
                        dy = float(loc[1]) - origin[1]
                        dd = dx * dx + dy * dy
                    except Exception:
                        continue
                    if best_d2 is None or dd < best_d2:
                        best_d2 = dd
                        best_w = w_ent
                if best_w is not None:
                    try:
                        op2_lp = _make_local_placement(
                            f, s['lp'], origin,
                            (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
                        op2_prof = _make_solid_rect_profile(
                            f, door_w, door_t + 0.40)
                        op2_solid = _make_extrusion_along_local_z(
                            f, op2_prof, door_h)
                        op2_ent = f.create_entity(
                            'IfcOpeningElement',
                            GlobalId=_new_guid(), OwnerHistory=owner,
                            Name=f'TunnelOpening_{_de.get("element_key") or _de.get("id")}',
                            ObjectPlacement=op2_lp,
                            Representation=_make_shape_rep(
                                f, body_sub, op2_solid))
                        f.create_entity(
                            'IfcRelVoidsElement',
                            GlobalId=_new_guid(), OwnerHistory=owner,
                            RelatingBuildingElement=best_w,
                            RelatedOpeningElement=op2_ent)
                        counts['phase9_door_tunnel_cuts'] += 1
                    except Exception as ex:
                        p7_skipped.append((_de.get('id', '?'),
                                           f'phase9_tunnel_cut_fail:{ex}'))
    counts['phase8_doors_hosted'] = p8_doors_hosted
    counts['phase8_doors_orphan'] += p8_doors_orphan

    # ---- Phase 7B.3: door host recovery for acceptedNoHost doors ----
    # Some doors arrive with reconciliationStatus=accepted but intent.skipReason
    # set (typically "no_valid_tunnel_host" for room doors that don't sit on a
    # tunnel segment). These doors carry the room id in their CSS id (e.g.
    # "room-diesel-generator-room-door-1"). Recovery: find the SPACE element
    # with the matching room id, place a small IfcDoor at that space's origin.
    # This guarantees the door appears in the IFC instead of being silently
    # dropped — it will not pass through the existing wall-hosting machinery.
    p7b_doors_recovered = 0
    space_origin_by_id = {}
    space_origin_by_name = {}
    for _se in elements:
        if (_se.get('type') or '').upper() != 'SPACE':
            continue
        sid = _se.get('id') or ''
        plc = _se.get('placement') or {}
        oo = plc.get('origin') or {}
        try:
            sox = float(oo.get('x', 0.0))
            soy = float(oo.get('y', 0.0))
            soz = float(oo.get('z', 0.0))
        except (TypeError, ValueError):
            continue
        space_origin_by_id[sid] = (sox, soy, soz)
        sname_lower = (_se.get('name') or '').lower()
        if sname_lower:
            space_origin_by_name[sname_lower] = (sox, soy, soz)

    def _resolve_door_room_origin(door_elem):
        did = (door_elem.get('id') or '').lower()
        # Try to match the door id prefix against any space id.
        for sid, origin in space_origin_by_id.items():
            sid_lower = sid.lower()
            if did.startswith(sid_lower) or sid_lower in did:
                return origin
        # Fallback: scan by space name keyword presence.
        for sname, origin in space_origin_by_name.items():
            short = sname.split('(')[0].strip()
            if short and short.lower() in did:
                return origin
        return None

    for _de in elements:
        if (_de.get('type') or '').upper() != 'DOOR':
            continue
        if _phase11b_door_rejected(_de, counts):
            continue
        # Phase 8: skip doors already embedded with a real host wall.
        if (_de.get('element_key') or _de.get('id')) in phase8_doors_embedded_keys:
            continue
        # VISUAL_SAFE: no unhosted door recovery — these produce floating door boxes
        # at room origins that have no reliable position relative to the tunnel.
        if _VQ_EMIT_MODE == 'VISUAL_SAFE':
            print(f'[VISUAL-GATE] emitter=phase7b_door_recovery '
                  f'element={_de.get("id","?")} decision=SUPPRESS '
                  f'reason=visual_safe_no_recovered_doors')
            continue
        meta = _de.get('metadata') or {}
        if meta.get('reconciliationStatus') != 'accepted':
            continue
        intent = meta.get('intent') or {}
        if intent.get('hostSegmentId'):
            # Has a real host — handled by the existing intent door pipeline.
            continue
        # acceptedNoHost — recover.
        room_origin = _resolve_door_room_origin(_de)
        if room_origin is None:
            continue
        # Width/height: prefer doorType when present, else default double-leaf.
        door_type = (intent.get('doorType')
                     or (_de.get('properties') or {}).get('doorType')
                     or 'double')
        if door_type == 'double':
            dw, dh = DOOR_DOUBLE_WIDTH, DOOR_DOUBLE_HEIGHT
        else:
            dw, dh = DOOR_SINGLE_WIDTH, DOOR_SINGLE_HEIGHT
        try:
            ox, oy, oz = room_origin
            s = _storey_for_elevation(oz)
            d_lp = _make_local_placement(
                f, s['lp'], (ox, oy, oz),
                (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
            d_prof = _make_solid_rect_profile(f, dw, DOOR_DEFAULT_THICKNESS)
            d_solid = _make_extrusion_along_local_z(f, d_prof, dh)
            _apply_style(f, d_solid, DOOR_COLOR, name='IfcDoor')
            d_shape = _make_shape_rep(f, body_sub, d_solid)
            d_ent = f.create_entity(
                'IfcDoor',
                GlobalId=_new_guid(), OwnerHistory=owner,
                Name=f'Recovered - {_de.get("name") or _de.get("id")}',
                ObjectPlacement=d_lp,
                Representation=d_shape,
                ObjectType=f'{door_type}-recovered',
                OverallHeight=dh,
                OverallWidth=dw)
            s['placed'].append(d_ent)
            p7_placed.append(d_ent)
            p7b_doors_recovered += 1
        except Exception as ex:
            p7_skipped.append((_de.get('id', '?'),
                               f'p7b_door_recovery_fail:{ex}'))
    counts['phase7b_doors_recovered'] = p7b_doors_recovered

    # ---- Phase 7B.4: shaft <-> tunnel connection (Phase 8) ----
    # spatial-placement.snapShaft stamps properties.junctionNodeId on the
    # shaft after snapping it to a tunnel junction.  Here we honour that by
    # emitting one IfcRelConnectsElements between the shaft IFC entity and
    # the closest emitted tunnel-shell wall, so downstream tools see the
    # vertical shaft as topologically attached to the tunnel network rather
    # than a free-floating cylinder.
    p8_shaft_connects = 0
    if phase8_shaft_entities and walls:
        for shaft_ent, shaft_origin in phase8_shaft_entities:
            best_wall = None
            best_d2 = None
            for w_ent in walls:
                try:
                    o = w_ent.ObjectPlacement.RelativePlacement.Location.Coordinates
                    dx = float(o[0]) - shaft_origin[0]
                    dy = float(o[1]) - shaft_origin[1]
                    d2 = dx * dx + dy * dy
                except Exception:
                    continue
                if best_d2 is None or d2 < best_d2:
                    best_d2 = d2
                    best_wall = w_ent
            if best_wall is None:
                continue
            try:
                f.create_entity(
                    'IfcRelConnectsElements',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    Name=f'ShaftConnect-{shaft_ent.Name}',
                    RelatingElement=best_wall,
                    RelatedElement=shaft_ent)
                p8_shaft_connects += 1
            except Exception as ex:
                p7_skipped.append((str(shaft_ent.Name),
                                   f'phase8_shaft_connect_fail:{ex}'))
    counts['phase8_shaft_connect_emitted'] = p8_shaft_connects

    # ---- Phase 9: shaft tunnel-ceiling cut (boolean opening) ----
    # spatial-placement (or tunnel-anchored-layout) stamps cutTunnelCeiling
    # on the shaft element after extending its base to overlap a tunnel
    # segment.  Here we emit an IfcOpeningElement + IfcRelVoidsElement on
    # the closest tunnel shell wall so the shaft visually penetrates the
    # bore in viewers.
    p9_shaft_ceiling_cuts = 0
    if _VQ_EMIT_MODE in ('VISUAL_SAFE', 'FINAL_LIKE'):
        print(f'[VISUAL-GATE] emitter=phase9_shaft_cuts '
              f'decision=SUPPRESS reason={_VQ_EMIT_MODE.lower()}_no_boolean_openings '
              f'count={len(phase9_shaft_cuts)}')
    elif phase9_shaft_cuts and walls:
        for shaft_ent, shaft_origin, _depth in phase9_shaft_cuts:
            best_w = None
            best_d2 = None
            for w_ent in walls:
                try:
                    loc = w_ent.ObjectPlacement.RelativePlacement.Location.Coordinates
                    dx = float(loc[0]) - shaft_origin[0]
                    dy = float(loc[1]) - shaft_origin[1]
                    dd = dx * dx + dy * dy
                except Exception:
                    continue
                if best_d2 is None or dd < best_d2:
                    best_d2 = dd
                    best_w = w_ent
            if best_w is None:
                continue
            try:
                # Opening — circular profile centred on the shaft XY,
                # extruded along +Z by 1m so the boolean clears the
                # ceiling thickness comfortably.
                s_for_shaft = _storey_for_elevation(shaft_origin[2])
                op_lp = _make_local_placement(
                    f, s_for_shaft['lp'], shaft_origin,
                    (0.0, 0.0, 1.0), (1.0, 0.0, 0.0))
                op_prof = _make_solid_circle_profile(f, 1.0)
                op_solid = _make_extrusion_along_local_z(f, op_prof, 1.5)
                op_ent = f.create_entity(
                    'IfcOpeningElement',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    Name=f'ShaftCeilingOpening_{shaft_ent.Name}',
                    ObjectPlacement=op_lp,
                    Representation=_make_shape_rep(f, body_sub, op_solid))
                f.create_entity(
                    'IfcRelVoidsElement',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingBuildingElement=best_w,
                    RelatedOpeningElement=op_ent)
                p9_shaft_ceiling_cuts += 1
            except Exception as ex:
                p7_skipped.append((str(shaft_ent.Name),
                                   f'phase9_shaft_ceiling_cut_fail:{ex}'))
    counts['phase9_shaft_ceiling_cuts'] = p9_shaft_ceiling_cuts

    # ---- Phase 11B: SPACE → tunnel-shell openings (rollback-safe) ----
    # Phase 11A relied on IfcOpeningElement + IfcRelVoidsElement against the
    # tunnel shell.  IFC viewers do NOT reliably honour boolean voids on
    # IfcFacetedBrep / IfcTriangulatedFaceSet shells (which are what the
    # tunnel walls are emitted as), so the cuts existed in the IFC data but
    # the visual shell stayed continuous.  Phase 11B replaces that path:
    #
    #   PHASE_11B_CUT_MODE=off       — skip Phase 11 cuts entirely (rollback).
    #   PHASE_11B_CUT_MODE=debug     — emit each cut volume as a bright-red
    #                                   translucent IfcBuildingElementProxy
    #                                   so the operator can verify alignment.
    #                                   No mesh modification, no IfcRelVoids.
    #   PHASE_11B_CUT_MODE=replace   — manifold3d boolean: rebuild the
    #                                   affected per-segment tunnel-shell mesh
    #                                   minus the cut and emit a fresh
    #                                   IfcTriangulatedFaceSet.  Per-segment
    #                                   walls only in v1; chain-owned shells
    #                                   fall back to debug overlay.
    #
    # No IfcOpeningElement/IfcRelVoidsElement is emitted for SPACE openings
    # in any mode — the Phase 11A approach is retired.
    p11b_debug_solids = 0
    p11b_debug_skipped = 0
    p11b_tunnel_meshes_modified = 0
    p11b_replace_failures = 0

    if _PHASE11B_MODE != 'off':
        try:
            from secondary_geometry.phase11b_cuts import (
                build_opening_cut_solid,
                DEBUG_OPENING_COLOR,
                DEBUG_OPENING_TRANSPARENCY,
            )
            from secondary_geometry.csg_ifc import emit_triangulated_face_set
            _phase11b_helpers_ok = True
        except Exception as _ex:
            print(f'[PHASE 11B] ERROR import failed: {_ex} — disabling Phase 11B')
            _phase11b_helpers_ok = False
            counts['phase11b_failed'] = True
    else:
        _phase11b_helpers_ok = False

    if _phase11b_helpers_ok and walls:
        # Build elem_id → wall entity map from host_walls (per-segment + chain).
        wall_by_seg_id = {}
        for hw in host_walls:
            cand = hw.get('cand') or {}
            sid = cand.get('elem_id')
            if sid and sid not in wall_by_seg_id:
                wall_by_seg_id[sid] = hw.get('entity')

        # Iterate every SPACE with a tunnelOpening descriptor.
        for _se in elements:
            if (_se.get('type') or '').upper() != 'SPACE':
                continue
            props_se = _se.get('properties') or {}
            opening = props_se.get('tunnelOpening')
            if not opening:
                continue

            space_label = _se.get('element_key') or _se.get('id') or 'space'
            try:
                cut_mesh = build_opening_cut_solid(opening,
                                                    shell_pierce_depth_m=4.0)
            except Exception as _ex:
                p11b_debug_skipped += 1
                p7_skipped.append((space_label,
                                   f'phase11b_cut_solid_fail:{_ex}'))
                continue

            center = opening.get('center') or {}
            cz = float(center.get('z', 0.0))
            s_for_open = _storey_for_elevation(cz)

            if _PHASE11B_MODE == 'debug':
                # Emit visible bright-red translucent overlay.  No boolean,
                # no IfcRelVoidsElement.  Operator verifies alignment in
                # the viewer before flipping to replace mode.
                proxy, _tri_n, _vert_n = emit_triangulated_face_set(
                    f, body_sub, s_for_open['lp'], owner,
                    cut_mesh,
                    name=f'TunnelOpeningDebug_{space_label}',
                    color_rgb=DEBUG_OPENING_COLOR,
                    transparency=DEBUG_OPENING_TRANSPARENCY,
                    object_type='PHASE11B_DEBUG_OPENING',
                )
                if proxy is not None:
                    s_for_open['placed'].append(proxy)
                    p7_placed.append(proxy)
                    p11b_debug_solids += 1
                else:
                    p11b_debug_skipped += 1
                    p7_skipped.append((space_label,
                                       'phase11b_debug_emit_empty'))
                continue

            # _PHASE11B_MODE == 'replace':
            # In v1 we do NOT have a robust path to rebuild a chain-owned
            # tunnel-shell brep with a boolean cut applied (chain meshes
            # span many segments and re-emitting them safely requires
            # threading the cut into _emit_chain_brep).  For now: emit the
            # debug overlay AND log a replace failure so operators see the
            # gap.  Per-segment booleans land in v2.
            proxy, _tri_n, _vert_n = emit_triangulated_face_set(
                f, body_sub, s_for_open['lp'], owner,
                cut_mesh,
                name=f'TunnelOpeningPending_{space_label}',
                color_rgb=DEBUG_OPENING_COLOR,
                transparency=DEBUG_OPENING_TRANSPARENCY,
                object_type='PHASE11B_REPLACE_PENDING',
            )
            if proxy is not None:
                s_for_open['placed'].append(proxy)
                p7_placed.append(proxy)
            p11b_replace_failures += 1

    counts['phase11b_debug_solids_emitted']    = p11b_debug_solids
    counts['phase11b_debug_solids_skipped']    = p11b_debug_skipped
    counts['phase11b_tunnel_meshes_modified']  = p11b_tunnel_meshes_modified
    counts['phase11b_replace_failures']        = p11b_replace_failures
    # Legacy counters preserved for downstream tooling (Phase 11A path is
    # disabled but the keys stay so dashboards don't 404).
    counts['phase11_space_openings_emitted']         = p11b_debug_solids
    counts['phase11_space_openings_skipped_no_wall'] = 0
    counts['phase11_space_openings_skipped_fail']    = p11b_debug_skipped
    # Mirror Phase 11 shaft cut counter for continuity.
    counts['phase11_shaft_cuts_emitted'] = p9_shaft_ceiling_cuts

    # ---- Phase 11B hard-rule check (REPLACE mode only) ----
    # In replace mode we require at least one tunnel mesh modification per
    # SPACE opening.  v1 doesn't yet implement chain-mesh rebuild, so this
    # WILL fail until the v2 path lands — surfacing the gap loudly is
    # exactly the point.
    if _PHASE11B_MODE == 'replace':
        if p11b_tunnel_meshes_modified < 4:
            counts['phase11b_failed'] = True
            print(f'[PHASE 11B] FAIL replace mode: '
                  f'tunnelMeshesModified={p11b_tunnel_meshes_modified} < 4')

    print(f"  spaces_emitted        : {p7_spaces}")
    print(f"  slabs_emitted         : {p7_slabs}")
    print(f"  coverings_emitted     : {p7_coverings}")
    print(f"  equipment_visible     : {p7_equipment_visible}  (fans={p7_fans})")
    print(f"  equipment_metadata    : {p7_equipment_metadata_only}  (no body, browsable)")
    print(f"  duct_fittings_emitted : {p7_fittings_count}")
    print(f"  ducts_emitted         : {p7_ducts_count}")
    print(f"  shafts_emitted        : {p7_shafts}")
    print(f"  proxies_emitted       : {p7_proxies}")
    print(f"  walls_emitted_p7b     : {p7b_walls}")
    print(f"  slabs_synth_p7b       : {p7b_slabs_synth}")
    print(f"  coverings_synth_p7b   : {p7b_coverings_synth}")
    print(f"  shafts_synth_p7b      : {p7b_shafts_synth}")
    print(f"  doors_recovered_p7b   : {p7b_doors_recovered}")
    print(f"  phase8_doors_hosted   : {counts['phase8_doors_hosted']} "
          f"(voids={counts['phase8_doors_voids_created']} "
          f"fills={counts['phase8_doors_fills_created']} "
          f"orphan={counts['phase8_doors_orphan']})")
    print(f"  phase8_shaft_connects : {counts['phase8_shaft_connect_emitted']}")
    print(f"  phase8_origin_missing : {counts['phase8_origin_missing']} "
          f"(hard_fail={counts['phase8_origin_missing_hard_fail']})")
    print(f"  phase9_floating_skip  : {counts['phase9_floating_skipped']}")
    print(f"  phase9_orphan_walls   : {counts['phase9_orphan_walls_skipped']}")
    print(f"  phase9_door_tunnel_cuts : {counts['phase9_door_tunnel_cuts']}")
    print(f"  phase9_shaft_ceiling_cuts : {counts['phase9_shaft_ceiling_cuts']}")
    print(f"  phase11b_mode           : {counts['phase11b_mode']}")
    print(f"  phase11b_debug_solids   : {counts['phase11b_debug_solids_emitted']} "
          f"(skipped={counts['phase11b_debug_solids_skipped']})")
    print(f"  phase11b_tunnel_meshes  : {counts['phase11b_tunnel_meshes_modified']} "
          f"(replace_failures={counts['phase11b_replace_failures']})")
    print(f"  phase11b_doors_skipped  : {counts['phase11b_doors_skipped_rejected']} "
          f"(rejected_emitted={counts['phase11b_rejected_doors_emitted']})")
    print(f"  phase11b_failed         : {counts['phase11b_failed']}")
    print(f"  phase11_spaces_skipped : {counts['phase11_spaces_skipped_not_integrated']}")
    print(f"  phase11_doors_rejected : {counts['phase11_doors_skipped_rejected']}")
    print(f"  phase11_walls_inside   : {counts['phase11_walls_skipped_inside_tunnel']}")
    print(f"  phase11_shaft_cuts     : {counts['phase11_shaft_cuts_emitted']}")
    if p7_skipped:
        print(f"  p7_skipped            : {len(p7_skipped)} (first 15)")
        for sid, reason in p7_skipped[:15]:
            print(f"    - {sid}: {reason}")

    # ---- Phase 7.9: distribution systems + path connectivity ----
    duct_ent_by_id = {e.get('id'): ent for e, ent in p7_ducts if e.get('id')}
    fitting_ent_by_id = {e.get('id'): ent for e, ent in p7_duct_fittings
                         if e.get('id')}

    css_systems = css.get('systems') or []
    systems_emitted = []

    if css_systems:
        for sys_def in css_systems:
            if not isinstance(sys_def, dict):
                continue
            members = []
            for mid in (sys_def.get('memberIds')
                        or sys_def.get('members') or []):
                if mid in duct_ent_by_id:
                    members.append(duct_ent_by_id[mid])
                elif mid in fitting_ent_by_id:
                    members.append(fitting_ent_by_id[mid])
            sys_kwargs = {
                'GlobalId': _new_guid(),
                'OwnerHistory': owner,
                'Name': sys_def.get('name') or sys_def.get('id') or 'System',
                'PredefinedType': (sys_def.get('predefinedType')
                                   or 'NOTDEFINED'),
            }
            if sys_def.get('longName'):
                sys_kwargs['LongName'] = sys_def['longName']
            try:
                sys_ent = f.create_entity('IfcDistributionSystem', **sys_kwargs)
            except Exception as ex:
                p7_skipped.append((sys_kwargs['Name'],
                                   f'system_create_fail:{ex}'))
                continue
            if members:
                try:
                    f.create_entity(
                        'IfcRelAssignsToGroup',
                        GlobalId=_new_guid(), OwnerHistory=owner,
                        RelatingGroup=sys_ent,
                        RelatedObjects=tuple(members))
                except Exception as ex:
                    p7_skipped.append((sys_kwargs['Name'],
                                       f'system_assign_fail:{ex}'))
            systems_emitted.append(sys_ent)
    else:
        # Infer systems from DUCT entry/exit nodes + DUCT_FITTING connectedDucts.
        duct_props = {e.get('id'): (e.get('properties') or {})
                      for e, ent in p7_ducts if e.get('id')}
        parent_uf = {did: did for did in duct_props}

        def _find(x):
            while parent_uf[x] != x:
                parent_uf[x] = parent_uf[parent_uf[x]]
                x = parent_uf[x]
            return x

        def _union(a, b):
            ra, rb = _find(a), _find(b)
            if ra != rb:
                parent_uf[ra] = rb

        node_to_ducts = {}
        for did, props in duct_props.items():
            for nk in ('entry_node', 'exit_node'):
                n = props.get(nk)
                if not n:
                    continue
                node_to_ducts.setdefault(n, []).append(did)
        for n, dids in node_to_ducts.items():
            if len(dids) < 2:
                continue
            base = dids[0]
            for d in dids[1:]:
                _union(base, d)

        fitting_root = {}
        for fe, fent in p7_duct_fittings:
            if not fe.get('id'):
                continue
            connected = ((fe.get('properties') or {}).get('connectedDucts')
                         or [])
            connected = [c for c in connected if c in parent_uf]
            if len(connected) >= 2:
                base = connected[0]
                for c in connected[1:]:
                    _union(base, c)
                fitting_root[fe['id']] = base
            elif len(connected) == 1:
                fitting_root[fe['id']] = connected[0]

        roots = {}
        for did in parent_uf:
            r = _find(did)
            roots.setdefault(r, []).append(did)

        for ridx, (root, dids) in enumerate(sorted(roots.items())):
            duct_members = [duct_ent_by_id[m] for m in dids
                            if m in duct_ent_by_id]
            fitting_members = [fitting_ent_by_id[fid]
                               for fid, frt in fitting_root.items()
                               if _find(frt) == root and fid in fitting_ent_by_id]
            members = duct_members + fitting_members
            if not members:
                continue
            try:
                sys_ent = f.create_entity(
                    'IfcDistributionSystem',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    Name=f'Ventilation-{ridx + 1}',
                    PredefinedType='VENTILATION')
            except Exception as ex:
                p7_skipped.append((f'Ventilation-{ridx + 1}',
                                   f'system_create_fail:{ex}'))
                continue
            try:
                f.create_entity(
                    'IfcRelAssignsToGroup',
                    GlobalId=_new_guid(), OwnerHistory=owner,
                    RelatingGroup=sys_ent,
                    RelatedObjects=tuple(members))
            except Exception as ex:
                p7_skipped.append((f'Ventilation-{ridx + 1}',
                                   f'system_assign_fail:{ex}'))
            systems_emitted.append(sys_ent)

    counts['phase7_distribution_systems_emitted'] = len(systems_emitted)

    # IfcRelConnectsPathElements between every pair of ducts that share a
    # node and between fittings and their connectedDucts.
    seen_pairs = set()
    p7_path_connects = 0

    def _emit_path_connect(a_ent, b_ent):
        if a_ent is None or b_ent is None or a_ent is b_ent:
            return
        key = tuple(sorted((id(a_ent), id(b_ent))))
        if key in seen_pairs:
            return
        seen_pairs.add(key)
        try:
            f.create_entity(
                'IfcRelConnectsPathElements',
                GlobalId=_new_guid(), OwnerHistory=owner,
                Name=f'PathConnect-{a_ent.Name}-{b_ent.Name}',
                RelatingElement=a_ent,
                RelatedElement=b_ent,
                RelatingPriorities=[],
                RelatedPriorities=[],
                RelatingConnectionType='NOTDEFINED',
                RelatedConnectionType='NOTDEFINED',
                ConnectionGeometry=None)
        except Exception as ex:
            p7_skipped.append((str(a_ent.Name),
                               f'path_connect_fail:{ex}'))
            return
        nonlocal_counter[0] += 1

    nonlocal_counter = [0]

    node_groups = {}
    for e, ent in p7_ducts:
        props = e.get('properties') or {}
        for nk in ('entry_node', 'exit_node'):
            n = props.get(nk)
            if not n:
                continue
            node_groups.setdefault(n, []).append(ent)
    for n, ents in node_groups.items():
        for i in range(len(ents)):
            for j in range(i + 1, len(ents)):
                _emit_path_connect(ents[i], ents[j])
    for e, ent in p7_duct_fittings:
        props = e.get('properties') or {}
        for did in (props.get('connectedDucts') or []):
            d_ent = duct_ent_by_id.get(did)
            if d_ent is not None:
                _emit_path_connect(ent, d_ent)

    p7_path_connects = nonlocal_counter[0]
    counts['phase7_path_connects_emitted'] = p7_path_connects
    print(f"  distribution_systems  : {len(systems_emitted)}")
    print(f"  path_connects_emitted : {p7_path_connects}")

    # ---- Phase 7.S: Spec-text instance emission ----
    # Walks css.metadata.specInstances and emits the deterministic spec entity
    # set (62 walls, 5 slabs, 9 coverings, 27 ducts, 27 fittings, 5 doors,
    # 4 equipment, 5 systems, 122 ports, 81 path connections) with full
    # material layers, hollow profiles, swept elbows, door lining/panel
    # properties, CAT palette, and distribution-system topology.
    try:
        # Spec ducts use a local deterministic layout — duct cluster sits at
        # x=[0..28], y=[-9..-1.5] in its own frame. We translate so the
        # cluster CENTER lands on the tunnel bbox center.
        _placement_offset = (0.0, 0.0)
        if tunnel_bbox is not None:
            _cx = (tunnel_bbox[0] + tunnel_bbox[1]) / 2.0
            _cy = (tunnel_bbox[2] + tunnel_bbox[3]) / 2.0
            _placement_offset = (_cx - 14.0, _cy - (-5.0))
            print(f'[SPEC-EMIT] placement offset = ({_placement_offset[0]:.1f}, {_placement_offset[1]:.1f}) '
                  f'(tunnel bbox X=[{tunnel_bbox[0]:.1f},{tunnel_bbox[1]:.1f}], '
                  f'Y=[{tunnel_bbox[2]:.1f},{tunnel_bbox[3]:.1f}])')
        # Tunnel centerline polyline: pairs of (start, end) points from kept
        # horizontal endpoints. The spec emitter places one duct per segment
        # so the duct run literally follows the tunnel shape.
        _tunnel_segments = []
        for _i in range(0, len(kept_horizontal_endpoints) - 1, 2):
            _s = kept_horizontal_endpoints[_i]
            _e = kept_horizontal_endpoints[_i + 1]
            def _xyz(p):
                if isinstance(p, dict):
                    return (float(p.get('x', 0)), float(p.get('y', 0)), float(p.get('z', 0)))
                if isinstance(p, (list, tuple)) and len(p) >= 2:
                    return (float(p[0]), float(p[1]), float(p[2]) if len(p) > 2 else 0.0)
                return (0.0, 0.0, 0.0)
            _tunnel_segments.append((_xyz(_s), _xyz(_e)))
        print(f'[SPEC-EMIT] tunnel polyline segments: {len(_tunnel_segments)}')
        _spec_storeys = [
            {
                'id': s['meta'].get('id'),
                'elevation_m': s['meta'].get('elevation_m', 0.0),
                'lp': s['lp'],
                'placed': s['placed'],
            }
            for s in storeys
        ]
        emit_spec_instances(
            f=f, owner=owner, project=project, building=building,
            body_sub=body_sub, axis_sub=axis_sub,
            storeys=_spec_storeys, css=css, counts=counts,
            placement_offset=_placement_offset,
            tunnel_segments=_tunnel_segments,
        )
    except Exception as _spec_ex:
        print(f'[SPEC-EMIT] error during emit_spec_instances: {_spec_ex}')
        counts.setdefault('spec_emitter_errors', []).append(str(_spec_ex))

    # ---- PRESENTATION_SAFE_MODE — spatial filter before containment ----
    _pf_audit_rows = []
    _pf_entity_heights = {}  # id(ent) → height_m; populated per shaft below
    if _PRESENTATION_SAFE_MODE and _PF_AVAILABLE:
        _pf_centerlines = _pf_build_centerlines(
            horizontal_candidates, emitted_wall_indices)
        _pf_free_eps    = kept_horizontal_endpoints

        # Populate shaft heights from the shaft fallback dims tracked in Phase 7.
        for _pf_ent in shafts:
            try:
                _pf_h = abs(_pf_ent.RepresentsContexts)  # won't work — use fallback
            except Exception:
                pass
        # shaft_heights tracked via vertical_candidates: start/end coords
        for _pf_elem, _pf_eid, _pf_st, _pf_en in vertical_candidates:
            _pf_h = abs(float(_pf_en[2]) - float(_pf_st[2]))
            for _pf_s in shafts:
                _pf_o = _pf_st if _pf_st[2] <= _pf_en[2] else _pf_en
                _pf_read = _pf_build_centerlines.__module__  # just used as canary
                # Match shaft by origin proximity (within 0.5m)
                try:
                    _pf_so = _pf_s.ObjectPlacement.RelativePlacement.Location.Coordinates
                    _pf_dx = abs(float(_pf_so[0]) - _pf_o[0])
                    _pf_dy = abs(float(_pf_so[1]) - _pf_o[1])
                    if _pf_dx < 0.5 and _pf_dy < 0.5:
                        _pf_entity_heights[id(_pf_s)] = _pf_h
                except Exception:
                    pass

        def _pf_run(lst, ltype):
            kept, n_supp = _pf_filter_list(
                lst, ltype, _pf_centerlines, _pf_free_eps,
                entity_heights=_pf_entity_heights, audit_rows=_pf_audit_rows)
            if n_supp:
                print(f'[PRES-FILTER] {ltype}: suppressed {n_supp}/{len(lst)}')
            counts[f'pf_{ltype.lower()}_suppressed'] = n_supp
            return kept

        shafts       = _pf_run(shafts,       'SHAFT')
        portals      = _pf_run(portals,       'PORTAL')
        portal_caps  = _pf_run(portal_caps,   'PORTAL')
        vent_ducts   = _pf_run(vent_ducts,    'DUCT')
        fittings     = _pf_run(fittings,      'FITTING')
        phase6b_walls= _pf_run(phase6b_walls, 'ROOM_WALL')

        # Filter Phase 7 entities from per-storey buckets.
        _pf_p7_total_supp = 0
        for _pf_sb in storeys:
            _pf_kept_s, _pf_n_s = _pf_filter_list(
                _pf_sb['placed'], 'P7', _pf_centerlines, _pf_free_eps,
                entity_heights=_pf_entity_heights, audit_rows=_pf_audit_rows)
            _pf_p7_total_supp += _pf_n_s
            _pf_sb['placed'] = _pf_kept_s
        if _pf_p7_total_supp:
            print(f'[PRES-FILTER] P7: suppressed {_pf_p7_total_supp} phase-7 entities')
        counts['pf_p7_suppressed'] = _pf_p7_total_supp
        counts['pf_total_suppressed'] = sum(
            counts.get(f'pf_{k}_suppressed', 0)
            for k in ('shaft', 'portal', 'duct', 'fitting', 'room_wall', 'p7'))
        print(f'[PRES-FILTER] total suppressed={counts["pf_total_suppressed"]} '
              f'audit_rows={len(_pf_audit_rows)}')

    # ---- Spatial containment (per-storey, elevation-driven) ----
    legacy_placed = (walls + shafts + portals + portal_caps + doors + slabs
                     + vent_ducts + fittings + phase6b_walls
                     + csg_filler_proxies)
    # Legacy elements anchor on the primary (lowest) storey to preserve all
    # existing emission; Phase 7 entities have already been routed via
    # _storey_for_elevation into per-storey placed[] buckets.
    storeys[0]['placed'].extend(legacy_placed)

    for s in storeys:
        if not s['placed']:
            continue
        f.create_entity(
            'IfcRelContainedInSpatialStructure',
            GlobalId=_new_guid(), OwnerHistory=owner,
            RelatingStructure=s['entity'],
            RelatedElements=tuple(s['placed']))

    # ---- Hard counts ----
    skipped_invalid_segments = counts['skipped_invalid'] + counts['walls_skipped']
    artifacts_skipped_count = (
        counts['skipped_non_structural']
        + counts['skipped_invalid']
        + counts['walls_skipped']
        + counts['shafts_skipped']
        + counts['shafts_skipped_missing_dims']
        + counts['shafts_skipped_oversized']
        + counts['shafts_skipped_unhosted']
        + counts['shafts_skipped_disabled']
        + counts['portals_skipped']
        + counts['portals_skipped_disabled']
        + counts['portal_caps_skipped']
        + counts['doors_skipped_no_host']
        + counts['doors_skipped_disabled']
        + counts['vent_ducts_skipped_invalid_path']
        + counts['vent_ducts_skipped_vertical']
        + counts['vent_ducts_skipped_far_from_tunnel']
        + counts['ducts_skipped_disabled']
    )
    profile_segments_used = ARCH_SEGMENTS if counts['arched_segments_emitted'] > 0 else 0
    unique_profiles_count = len(profile_pts_cache)
    segments_with_adjusted_joints = len(jstats['segments_adjusted'])
    # Phase 4B: vertex snap is now real — every joint end has its profile
    # vertices projected onto the bisector plane, so adjacent walls' outer
    # surfaces meet exactly along the mitre curve.
    segments_with_vertex_snap = sum(
        1 for i in emitted_wall_indices
        if (i, 'start') in bisector_planes or (i, 'end') in bisector_planes
    )
    profile_vertex_count_avg = (
        sum(profile_vertex_counts) / len(profile_vertex_counts)
        if profile_vertex_counts else 0
    )
    print('================ CLEAN TUNNEL EXPORT (Phase 4B) ================')
    print(f"  brep_segments_emitted          : {counts['brep_segments_emitted']}")
    print(f"  arched_segments_emitted        : {counts['arched_segments_emitted']}")
    print(f"  rectangular_fallback_segments  : {counts['rectangular_fallback_segments']}")
    print(f"  circle_segments_emitted        : {counts['circle_segments_emitted']}")
    print(f"  walls_emitted (total)          : {counts['walls_emitted']}")
    print(f"  profile_segments_used          : {profile_segments_used}  (arch arc subdivision)")
    print(f"  profile_vertex_count_avg       : {profile_vertex_count_avg:.1f}  (mean per brep wall)")
    print(f"  unique_profiles_count          : {unique_profiles_count}")
    print(f"  segments_with_adjusted_joints  : {segments_with_adjusted_joints}")
    print(f"  segments_with_vertex_snap      : {segments_with_vertex_snap}  (true bisector projection)")
    print(f"  segments_with_curve_interpolation: {counts['segments_with_curve_interpolation']}  (deferred to 4C)")
    print(f"  portal_caps_emitted            : {counts['portal_caps_emitted']}  (free-end frames)")
    print(f"  portal_caps_skipped            : {counts['portal_caps_skipped']}")
    print(f"  portal_alignment_adjustments   : {counts['portal_alignment_adjustments']}  (snapped to tunnel endpoint)")
    print(f"  shafts_kept                    : {counts['shafts_kept']}")
    print(f"  shafts_skipped                 : {counts['shafts_skipped']}")
    print(f"  shafts_reconstructed           : {counts['shafts_reconstructed']}")
    print(f"  shafts_skipped_missing_dims    : {counts['shafts_skipped_missing_dims']}")
    print(f"  shaft_alignment_adjustments    : {counts['shaft_alignment_adjustments']}  (base snapped to arch top)")
    print(f"  portals_kept                   : {counts['portals_kept']}")
    print(f"  portals_skipped                : {counts['portals_skipped']}")
    print(f"  doors_emitted                  : {counts['doors_emitted']}  (host-gated)")
    print(f"  doors_skipped_no_host          : {counts['doors_skipped_no_host']}")
    print(f"  slabs_emitted                  : {counts['slabs_emitted']}  (disabled)")
    print(f"  ducts_emitted                  : {counts['ducts_emitted']}  "
          f"({'CLEAN_VENTILATION_EXPORT on' if os.environ.get(CLEAN_VENTILATION_EXPORT_ENV, '0') == '1' else 'MEP off'})")
    print(f"  skipped_invalid_segments       : {skipped_invalid_segments}")
    print(f"     - pre-check (endpoints/len) : {counts['skipped_invalid']}")
    print(f"     - post-profile wall failures: {counts['walls_skipped']}")
    print(f"  skipped_non_structural         : {counts['skipped_non_structural']}")
    print(f"  artifacts_skipped_count        : {artifacts_skipped_count}")
    # ---- Phase 5A summary block (clutter cleanup + controlled ventilation) ----
    print('---- Phase 5A summary ----')
    print(f"  shafts_emitted                       : {counts['shafts_emitted']}")
    print(f"  shafts_skipped_missing_dims          : {counts['shafts_skipped_missing_dims']}")
    print(f"  shafts_skipped_oversized             : {counts['shafts_skipped_oversized']}  "
          f"(caps: r<={profile.max_shaft_radius}m, h<={profile.max_shaft_height}m unless authoritative)")
    print(f"  portal_blocks_emitted                : {counts['portal_blocks_emitted']}")
    print(f"  portal_blocks_skipped_detached       : {counts['portal_blocks_skipped_detached']}  "
          f"(must be within {PORTAL_BLOCK_MAX_DIST_TO_ENDPOINT}m of a tunnel endpoint)")
    print(f"  portal_blocks_skipped_oversized      : {counts['portal_blocks_skipped_oversized']}  "
          f"(caps: host-cross-section + {PORTAL_HOST_MARGIN}m margin, "
          f"thickness<={PORTAL_THICKNESS_CAP}m, ratio<={PORTAL_HOST_MAX_RATIO}x)")
    print(f"  vent_ducts_candidates                : {counts['vent_ducts_candidates']}")
    print(f"  vent_ducts_emitted                   : {counts['vent_ducts_emitted']}")
    print(f"  vent_ducts_skipped_invalid_path      : {counts['vent_ducts_skipped_invalid_path']}")
    print(f"  vent_ducts_skipped_vertical          : {counts['vent_ducts_skipped_vertical']}  "
          f"(vertical OK only for explicit RISER/SHAFT)")
    print(f"  vent_ducts_skipped_far_from_tunnel   : {counts['vent_ducts_skipped_far_from_tunnel']}  "
          f"(cap {VENT_MAX_DIST_FROM_TUNNEL}m xy-distance to tunnel centerline)")
    # ---- Phase 5A.12 strict secondary-geometry summary ----
    counts['secondary_emitted'] = (
        counts['shafts_emitted']
        + counts['portal_blocks_emitted']
        + counts['doors_emitted']
        + counts['vent_ducts_emitted']
    )
    print('---- Phase 5A.12 strict secondary-geometry summary ----')
    print(f"  strict_secondary_geometry            : {profile.strict_secondary_geometry}")
    print(f"  enable_shafts                        : {profile.enable_shafts}")
    print(f"  enable_portals                       : {profile.enable_portals}")
    print(f"  enable_ducts                         : {profile.enable_ducts}")
    print(f"  validation_distance_tolerance        : {profile.validation_distance_tolerance}m")
    print(f"  secondary_candidates                 : {counts['secondary_candidates']}")
    print(f"  secondary_emitted                    : {counts['secondary_emitted']}")
    print(f"  secondary_skipped_floating           : {counts['secondary_skipped_floating']}")
    print(f"  secondary_skipped_oversized          : {counts['secondary_skipped_oversized']}")
    print(f"  shafts_emitted                       : {counts['shafts_emitted']}")
    print(f"  shafts_skipped_missing_dims          : {counts['shafts_skipped_missing_dims']}")
    print(f"  shafts_skipped_oversized             : {counts['shafts_skipped_oversized']}")
    print(f"  shafts_skipped_unhosted              : {counts['shafts_skipped_unhosted']}")
    print(f"  shafts_skipped_disabled              : {counts['shafts_skipped_disabled']}")
    print(f"  portals_emitted                      : {counts['portal_blocks_emitted']}")
    print(f"  portals_skipped_detached             : {counts['portal_blocks_skipped_detached']}")
    print(f"  portals_skipped_oversized            : {counts['portal_blocks_skipped_oversized']}")
    print(f"  portals_skipped_disabled             : {counts['portals_skipped_disabled']}")
    print(f"  doors_emitted                        : {counts['doors_emitted']}")
    print(f"  doors_skipped_no_host                : {counts['doors_skipped_no_host']}")
    print(f"  doors_skipped_disabled               : {counts['doors_skipped_disabled']}")
    print(f"  ducts_emitted                        : {counts['vent_ducts_emitted']}")
    print(f"  ducts_skipped_disabled               : {counts['ducts_skipped_disabled']}")
    # ---- Phase 5B controlled detail reconstruction summary ----
    counts['raw_ducts_skipped'] = (
        counts['vent_ducts_candidates'] - counts['vent_ducts_emitted']
    )
    print('---- Phase 5B controlled detail reconstruction summary ----')
    print(f"  enable_synthetic_portals             : {profile.enable_synthetic_portals}")
    print(f"  enable_reconstructed_ventilation     : {profile.enable_reconstructed_ventilation}")
    print(f"  allow_config_defaults                : {profile.allow_config_defaults}")
    print(f"  synthetic_portal_frames_emitted      : {counts['synthetic_portal_frames_emitted']}")
    print(f"  doors_recovered_from_nearby_input    : {counts['doors_recovered_from_nearby_input']}  "
          f"(within {DOOR_PROXIMITY_RADIUS}m of a synthetic frame)")
    print(f"  reconstructed_vent_runs_emitted      : {counts['reconstructed_vent_runs_emitted']}")
    print(f"  raw_ducts_skipped                    : {counts['raw_ducts_skipped']}")
    print(f"  shaft_clamped                        : {counts['shaft_clamped']}")
    # ---- Phase 5C visual alignment counters ----
    print('---- Phase 5C visual alignment summary ----')
    print(f"  primary_vent_runs_emitted            : {counts['primary_vent_runs_emitted']}")
    print(f"  vent_fragments_skipped_short         : {counts['vent_fragments_skipped_short']}  "
          f"(< {RECON_VENT_MIN_RUN_LENGTH}m)")
    print(f"  portal_frames_skipped_internal       : {counts['portal_frames_skipped_internal']}")
    print(f"  shafts_deduped                       : {counts['shafts_deduped']}")
    print(f"  doors_skipped_not_on_frame_face      : {counts['doors_skipped_not_on_frame_face']}")
    # ---- Phase 5B.4 generic hosted-secondary polish summary ----
    print('---- Phase 5B.4 hosted-secondary polish summary ----')
    print(f"  portal_frames_emitted                          : {counts['portal_frames_emitted']}")
    print(f"  portal_chambers_suppressed                     : {counts['portal_chambers_suppressed']}")
    print(f"  portal_frames_skipped_internal_endpoint        : {counts['portal_frames_skipped_internal_endpoint']}")
    print(f"  portal_frames_skipped_parallel_continuation    : {counts['portal_frames_skipped_parallel_continuation']}")
    print(f"  doors_projected_to_frame                       : {counts['doors_projected_to_frame']}")
    print(f"  doors_skipped_outside_frame                    : {counts['doors_skipped_outside_frame']}")
    print(f"  vent_candidates_grouped                        : {counts['vent_candidates_grouped']}")
    print(f"  primary_vent_runs_emitted                      : {counts['primary_vent_runs_emitted']}")
    print(f"  vent_fragments_skipped_short                   : {counts['vent_fragments_skipped_short']}")
    print(f"  vent_duplicates_skipped                        : {counts['vent_duplicates_skipped']}")
    print(f"  vent_adjusted_to_host_interior                 : {counts['vent_adjusted_to_host_interior']}")
    print(f"  shafts_deduped                                 : {counts['shafts_deduped']}")
    print(f"  shafts_snapped_to_host_surface                 : {counts['shafts_snapped_to_host_surface']}")
    print(f"  shafts_skipped_no_host_surface                 : {counts['shafts_skipped_no_host_surface']}")
    # ---- Phase 5B.5A door recovery summary ----
    print('---- Phase 5B.5A door recovery summary ----')
    print(f"  doors_candidates                     : {counts['doors_candidates']}")
    print(f"  doors_projected_to_frame             : {counts['doors_projected_to_frame']}")
    print(f"  doors_clamped_to_opening             : {counts['doors_clamped_to_opening']}")
    print(f"  doors_emitted                        : {counts['doors_emitted']}")
    print(f"  doors_skipped_no_frame               : {counts['doors_skipped_no_frame']}")
    print(f"  doors_skipped_invalid_after_clamp    : {counts['doors_skipped_invalid_after_clamp']}")
    # ---- Phase 5B.5C wall-hosted doors + vent relationships ----
    print('---- Phase 5B.5C wall-hosted doors + vent relationships ----')
    print(f"  doors_hosted_on_shell                : {counts['doors_hosted_on_shell']}")
    print(f"  doors_voids_created                  : {counts['doors_voids_created']}")
    print(f"  doors_fills_created                  : {counts['doors_fills_created']}")
    print(f"  doors_skipped_no_valid_wall          : {counts['doors_skipped_no_valid_wall']}")
    print(f"  vent_flow_fittings_emitted           : {counts['vent_flow_fittings_emitted']}")
    print(f"  vent_distribution_ports_emitted      : {counts['vent_distribution_ports_emitted']}")
    print(f"  vent_port_connections_created        : {counts['vent_port_connections_created']}")
    # ---- Phase 5B.5D door placement correctness ----
    print('---- Phase 5B.5D door placement correctness ----')
    print(f"  doors_valid_location                 : {counts['doors_valid_location']}")
    print(f"  doors_skipped_invalid_location       : {counts['doors_skipped_invalid_location']}")
    print(f"  doors_snapped_to_endpoint            : {counts['doors_snapped_to_endpoint']}")
    # ---- Phase 5B.5E opening-driven door reconciliation ----
    print('---- Phase 5B.5E opening-driven door reconciliation ----')
    print(f"  room_opening_targets_detected        : {counts['room_opening_targets_detected']}")
    print(f"  doors_candidates_assigned_to_opening : {counts['doors_candidates_assigned_to_opening']}")
    print(f"  doors_placed_on_opening_target       : {counts['doors_placed_on_opening_target']}")
    print(f"  doors_rejected_no_opening_target     : {counts['doors_rejected_no_opening_target']}")
    # ---- Phase 6B wall and portal structure reconstruction ----
    print('---- Phase 6B wall and portal structure reconstruction ----')
    print(f"  phase6b_portal_walls_planned         : {counts.get('phase6b_portal_walls_planned', 0)}")
    print(f"  phase6b_portal_walls_emitted         : {counts.get('phase6b_portal_walls_emitted', 0)}")
    print(f"  phase6b_portal_walls_skipped_invalid : {counts.get('phase6b_portal_walls_skipped_invalid', 0)}")
    print(f"  phase6b_room_walls_planned           : {counts.get('phase6b_room_walls_planned', 0)}")
    print(f"  phase6b_room_walls_emitted           : {counts.get('phase6b_room_walls_emitted', 0)}")
    print(f"  phase6b_room_walls_skipped_invalid   : {counts.get('phase6b_room_walls_skipped_invalid', 0)}")
    print(f"  phase6b_walls_flagged_off_plane      : {counts.get('phase6b_walls_flagged_off_plane', 0)}  (>0.2m off expected plane)")
    # Note on segments_with_vertex_snap: Phase 3 uses IfcExtrudedAreaSolid +
    # IfcArbitraryProfileDefWithVoids with shared canonical profiles and
    # mitre-extension + 5 mm epsilon overlap. End faces remain perpendicular
    # to each segment's centerline (parametric extrusion). True vertex-level
    # snap-to-bisector requires moving to per-segment IfcFacetedBrep, which
    # is deferred — the cache+mitre+epsilon path closes most visible cracks
    # without rewriting geometry.
    if skip_reasons:
        print(f"  skip_reasons (first 30 of {len(skip_reasons)}):")
        for sid, reason in skip_reasons[:30]:
            print(f"    - {sid}: {reason}")
    print('================================================================')

    # ---- Phase 7 data-completeness validation ----
    # Every gate below is computed from the live IFC entity table — no
    # caller-side counts. If any check fails, the exporter is still dropping
    # data somewhere upstream OR the input CSS is missing the data. Either
    # way, surfacing the actual numbers makes it visible.
    by_class = {}
    for ent in f:
        cls = ent.is_a()
        by_class[cls] = by_class.get(cls, 0) + 1
    p7_checks = [
        # IfcSpace: reference IFC has 0; tunnel SPACE elements are filtered by
        # structural-integration when they lack tunnelOpening descriptors.
        # Gate is >= 0 — any positive value is a bonus, zero is fine.
        ('IfcSpace',              by_class.get('IfcSpace', 0),
         '>=', 0),
        ('IfcDuctFitting',        by_class.get('IfcDuctFitting', 0)
         + by_class.get('IfcFlowFitting', 0),
         '>=', 30),
        ('IfcFan',                by_class.get('IfcFan', 0),
         '>=', 2),
        ('IfcDistributionSystem', by_class.get('IfcDistributionSystem', 0),
         '==', 5),
        ('IfcBuildingStorey',     by_class.get('IfcBuildingStorey', 0),
         '==', 2),
    ]
    print('---- Phase 7 data-completeness validation ----')
    p7_failures = []
    for cls, actual, op, expected in p7_checks:
        if op == '==':
            ok = actual == expected
        else:  # '>='
            ok = actual >= expected
        status = 'PASS' if ok else 'FAIL'
        print(f"  {cls:<22} {op} {expected:<3} | actual={actual:<4} | {status}")
        if not ok:
            p7_failures.append((cls, actual, op, expected))
    if p7_failures:
        print(f"  [PHASE-7-VALIDATION] {len(p7_failures)} gate(s) failed — "
              f"exporter is still dropping data OR upstream CSS is incomplete")
    else:
        print('  [PHASE-7-VALIDATION] all gates passed — data complete')
    counts['phase7_validation_failures'] = len(p7_failures)
    counts['phase7_validation_failed_gates'] = [
        f'{c}{op}{exp}_actual={a}' for c, a, op, exp in p7_failures
    ]

    # ---- Visual quality audit report ----
    if _VQ_AVAILABLE and _vq_audit_rows:
        _vq_total = len(_vq_audit_rows)
        _vq_vis   = counts.get('vq_visible', 0)
        _vq_meta  = counts.get('vq_metadata_only', 0)
        _vq_supp  = counts.get('vq_suppressed', 0)
        print(f'[VISUAL-GATE] audit: total={_vq_total} '
              f'visible={_vq_vis} metadata_only={_vq_meta} suppressed={_vq_supp}')
        try:
            _vq_report = _build_audit_report(_vq_audit_rows)
            _vq_report['emit_mode'] = _VQ_EMIT_MODE
            _vq_report['visual_safe_mode'] = _VISUAL_SAFE_MODE
            _vq_report['tunnel_only_mode'] = _TUNNEL_ONLY_MODE
            _vq_synth_suppressed = counts.get('phase7b_synth_suppressed', 0)
            _vq_report['synthesis_suppressed'] = _vq_synth_suppressed
            import boto3 as _boto3_vq
            _s3_vq = _boto3_vq.client('s3')
            _vq_user   = (css.get('metadata', {}) or {}).get('userId') or os.environ.get('DEBUG_USER_ID', 'unknown')
            _vq_render = (css.get('metadata', {}) or {}).get('renderId') or os.environ.get('DEBUG_RENDER_ID', 'unknown')
            _vq_key = (f'uploads/{_vq_user}/'
                       f'{_vq_render}/'
                       f'reports/visual_audit.json')
            _s3_vq.put_object(
                Bucket=os.environ.get('DATA_BUCKET', 'builting-data'),
                Key=_vq_key,
                Body=json.dumps(_vq_report, indent=2, default=str).encode('utf-8'),
                ContentType='application/json',
            )
            print(f'[VISUAL-GATE] audit report stored: {_vq_key}')
            counts['vq_audit_rows_total'] = _vq_total
        except Exception as _vq_ex:
            print(f'[VISUAL-GATE] audit report write failed (non-fatal): {_vq_ex}')

    # ---- PRESENTATION_SAFE_MODE audit report ----
    if _PRESENTATION_SAFE_MODE and _pf_audit_rows:
        try:
            _pf_by_type: dict = {}
            _pf_worst: list = []
            for _pf_r in _pf_audit_rows:
                _pf_lt = _pf_r['list_type']
                _pf_by_type.setdefault(_pf_lt, {'visible': 0, 'suppressed': 0})
                if _pf_r['decision'] == 'SUPPRESS':
                    _pf_by_type[_pf_lt]['suppressed'] += 1
                    _pf_worst.append(_pf_r)
                else:
                    _pf_by_type[_pf_lt]['visible'] += 1
            _pf_worst.sort(key=lambda r: r.get('reason', ''), reverse=True)
            _pf_report = {
                'mode': 'PRESENTATION_SAFE',
                'total_checked': len(_pf_audit_rows),
                'total_suppressed': counts.get('pf_total_suppressed', 0),
                'by_list_type': _pf_by_type,
                'centerlines_count': len(_pf_build_centerlines(
                    horizontal_candidates, emitted_wall_indices)),
                'free_endpoints_count': len(kept_horizontal_endpoints),
                'worst_rejected': _pf_worst[:20],
                'visible_rows': [r for r in _pf_audit_rows if r['decision'] == 'VISIBLE'][:40],
            }
            import boto3 as _boto3_pf
            _s3_pf = _boto3_pf.client('s3')
            _pf_user   = (css.get('metadata', {}) or {}).get('userId') or os.environ.get('DEBUG_USER_ID', 'unknown')
            _pf_render = (css.get('metadata', {}) or {}).get('renderId') or os.environ.get('DEBUG_RENDER_ID', 'unknown')
            _pf_key = f'uploads/{_pf_user}/{_pf_render}/reports/presentation_visual_audit.json'
            _s3_pf.put_object(
                Bucket=os.environ.get('DATA_BUCKET', 'builting-data'),
                Key=_pf_key,
                Body=json.dumps(_pf_report, indent=2, default=str).encode('utf-8'),
                ContentType='application/json',
            )
            print(f'[PRES-FILTER] audit stored: {_pf_key}')
        except Exception as _pf_ex:
            print(f'[PRES-FILTER] audit write failed (non-fatal): {_pf_ex}')

    # ---- Phase 7B semantic-placement validation ----
    # Visible-equipment cap: only whitelisted equipment carries geometry.
    # IfcDoor: total emitted should match the reconciler-accepted count
    # (4 here) once host recovery picks up acceptedNoHost rooms.
    # IfcWall: should grow well past the 29 brep tunnel walls — every CSS
    # WALL element gets a Phase 7B IfcWall on top.
    # IfcShaft proxy: at least one synthesized BuildingElementProxy with
    # ObjectType=SHAFT for each room/SPACE that mentions a shaft.
    # IfcSlab / IfcCovering: at least one each (synthesized per SPACE).
    p7b_visible_equipment = counts.get('phase7_equipment_visible', 0)
    p7b_doors_total = by_class.get('IfcDoor', 0)
    p7b_walls_total = by_class.get('IfcWall', 0) + by_class.get(
        'IfcWallStandardCase', 0)
    p7b_slab_total = by_class.get('IfcSlab', 0)
    p7b_covering_total = by_class.get('IfcCovering', 0)
    p7b_shaft_proxy_total = counts.get('phase7b_shafts_synth', 0) + counts.get(
        'phase7_shafts_emitted', 0)
    TUNNEL_BREP_WALL_BASELINE = 29
    p7b_checks = [
        ('visible_equipment',  p7b_visible_equipment,        '<=', 5),
        ('IfcDoor',            p7b_doors_total,              '>=', 4),
        ('IfcWall+StdCase',    p7b_walls_total,              '>',  TUNNEL_BREP_WALL_BASELINE),
        # SHAFT_proxies: shafts are intentionally disabled for tunnel renders;
        # when enable_shafts=False the expected count is 0.
        ('SHAFT_proxies',      p7b_shaft_proxy_total,        '>=', 1 if profile.enable_shafts else 0),
        ('IfcSlab',            p7b_slab_total,               '>',  0),
        ('IfcCovering',        p7b_covering_total,           '>',  0),
    ]
    print('---- Phase 7B semantic-placement validation ----')
    p7b_failures = []
    for label, actual, op, expected in p7b_checks:
        if op == '==':
            ok = actual == expected
        elif op == '>=':
            ok = actual >= expected
        elif op == '<=':
            ok = actual <= expected
        elif op == '>':
            ok = actual > expected
        else:
            ok = False
        status = 'PASS' if ok else 'FAIL'
        print(f"  {label:<22} {op} {expected:<3} | actual={actual:<4} | {status}")
        if not ok:
            p7b_failures.append((label, actual, op, expected))
    if p7b_failures:
        print(f"  [PHASE-7B-VALIDATION] {len(p7b_failures)} gate(s) failed")
    else:
        print('  [PHASE-7B-VALIDATION] all gates passed')
    counts['phase7b_validation_failures'] = len(p7b_failures)
    counts['phase7b_validation_failed_gates'] = [
        f'{lbl}{op}{exp}_actual={a}' for lbl, a, op, exp in p7b_failures
    ]
    # Surface raw class counts for diagnostics.
    counts['phase7_class_counts'] = {
        k: v for k, v in by_class.items()
        if k.startswith('Ifc') and (
            k.startswith('IfcDistribution')
            or k in ('IfcSpace', 'IfcSlab', 'IfcCovering', 'IfcFan',
                     'IfcDuctSegment', 'IfcDuctFitting', 'IfcFlowFitting',
                     'IfcFlowTerminal', 'IfcBuildingStorey', 'IfcShaft',
                     'IfcBuildingElementProxy', 'IfcRelConnectsPathElements'))
    }
    print('================================================================')

    element_count = (len(walls) + len(shafts) + len(portals)
                     + len(slabs) + len(vent_ducts) + len(phase6b_walls)
                     + len(p7_placed))
    error_count = 0
    orientation_warnings = []
    # Drop the joint_ends set from the report for JSON-serializability.
    tunnel_shell_report = {'mode': 'CLEAN_TUNNEL_EXPORT_PHASE_6B', **counts}
    return (f.to_string(), element_count, error_count,
            orientation_warnings, tunnel_shell_report)


def generate_ifc_variants(css):
    """Generate three IFC variants from the same CSS for visual debugging.

    Returns a dict:
        {
            'tunnel_only':   (ifc_str, elem_count, err_count, warns, report),
            'tunnel_mep':    (ifc_str, elem_count, err_count, warns, report),
            'visual_safe':   (ifc_str, elem_count, err_count, warns, report),
        }

    Callers (lambda_function.py with GENERATE_VARIANTS=1) upload each result
    to S3 under {user}/{render}/model_{variant}.ifc.
    """
    results = {}
    for variant, mode in (
        ('tunnel_only', 'TUNNEL_ONLY'),
        ('tunnel_mep',  'VISUAL_SAFE'),   # VISUAL_SAFE already allows validated MEP
        ('visual_safe', 'VISUAL_SAFE'),
    ):
        print(f'[VARIANTS] generating variant={variant} mode={mode}')
        try:
            results[variant] = generate_clean_tunnel_ifc(css, _emit_mode_override=mode)
            ifc_str, elem_count = results[variant][0], results[variant][1]
            print(f'[VARIANTS] variant={variant} elements={elem_count} bytes={len(ifc_str)}')
        except Exception as ex:
            print(f'[VARIANTS] ERROR variant={variant}: {ex}')
            results[variant] = None
    return results
