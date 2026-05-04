"""validatedCssContract — topology-engine → generate.

Validates css_processed.json. Documents the schema as currently produced
by resolvedToLegacyCss(); no cleanup. See zod/validatedCss.mjs for the
full operational note.

PR 1 captures the schema warts-included.

Audit trail:
  write site            — topology-engine/index.mjs:1448-1452 (css_processed)
  adapter               — topology-engine/v2-adapter.mjs:259 (resolvedToLegacyCss)
  geometry annotations  — v2-adapter.mjs:299-302 (preserves _<flag> fields)
  element-level fields  — v2-adapter.mjs:278-321
  metadata fields       — v2-adapter.mjs:339-356
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, conlist, model_validator


# ─── Closed enums (Literal types) ───────────────────────────────────────

# Phase 13 PR 3 provenance status values (mirrors claimsSchema.mjs PROVENANCE_STATUS).
ProvenanceStatus = Literal[
    "direct", "inherited_consensus", "inherited_contested",
    "derived_geometric", "derived_inferred", "missing", "legacy",
]

# VARIANT: 'ARCH' is legitimate (hospital render).
Domain = Literal["UNKNOWN", "TUNNEL", "BUILDING", "CIVIL", "MIXED", "ARCH"]

# resolvedToLegacyCss INTENT_TO_METHOD + 'EXTRUSION' fallback.
GeometryMethod = Literal["EXTRUSION", "SWEEP", "MESH", "BREP"]

OutputMode = Literal["HYBRID", "METADATA_ONLY", "GEOMETRY_ONLY"]

# VARIANT: 'authoring_safe' is PRESENTATION_SAFE_MODE (Phase 12A).
# 'visualization' and 'analysis' are speculative; not observed yet.
# TODO(phase13-cleanup): catalog observed values; remove unused.
ExportProfile = Literal["coordination", "visualization", "analysis", "authoring_safe"]


# ─── Sub-schemas ────────────────────────────────────────────────────────


class Vec3(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    x: float
    y: float
    z: float


class Bbox(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    min: Vec3
    max: Vec3


# VARIANT: `crs` legitimately propagates from cssRaw.facility through
# the adapter. Always nullable in practice.
class Facility(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str
    type: str
    description: str
    units: Literal["M"]
    crs: Optional[str] = None
    origin: Vec3
    axes: Literal["RIGHT_HANDED_Z_UP"]


# DEBT: same as cssRaw — partial materials pass through the adapter
# unchanged. Adapter only fills a default when material is wholly absent.
class Material(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str
    color: Optional[conlist(float, min_length=3, max_length=3)] = None
    transparency: Optional[float] = Field(default=None, ge=0.0, le=1.0)


# VARIANT: same as cssRaw — origin-only placements are legitimate.
class Placement(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    origin: Vec3
    axis: Optional[Vec3] = None
    refDirection: Optional[Vec3] = None


# Geometry from resolvedToLegacyCss(): always has method, profile, depth;
# optionally direction/path/pathPoints/vertices/faces/mesh and any
# _<topology-annotation> fields preserved from upstream. extra='allow'.
#
# SEMANTIC: order matters in `path` and `pathPoints` arrays — they are
# polyline/curve definitions; reordering changes geometry. Schema cannot
# express this; do not rearrange in topology without a coordinated
# generate change.
class Geometry(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    method: GeometryMethod
    profile: Optional[Any] = None
    depth: Optional[float] = None
# TODO(phase13-cleanup): catalog observed _<flag> field set
# (_geoBehavior, _isTunnelShell, _pathAuthored — v2-adapter.mjs:299) and
# promote to typed optional fields.


class Relationship(BaseModel):
    # extra='allow' because resolvedToLegacyCss spreads `...r` preserving
    # any extra keys present on upstream relationships (v2-adapter.mjs:306).
    model_config = ConfigDict(extra="allow", strict=True)
    type: str
    target: str


class ElementProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sourceFile: Optional[str]
    sourceFileStatus: ProvenanceStatus
    sourceFiles: List[str]
    stage: str
    modifications: List[str]


# Element shape from resolvedToLegacyCss. Phase 13 PR 5 — provenance required.
class Element(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    element_key: str
    canonical_id: str
    type: str
    semanticType: Optional[str] = None
    name: str
    placement: Optional[Placement]
    geometry: Optional[Geometry]
    container: Optional[str]
    relationships: List[Relationship]
    properties: Dict[str, Any]
    material: Material
    # Pre-existing element-level confidence default (v2-adapter.mjs:309).
    # Phase 14 will replace with measurable per-source/per-pass confidence.
    confidence: float = Field(ge=0.0, le=1.0)
    # Free string: 'LLM' default + 'VSM', 'DXF', 'VISION', etc. PR 3 replaces.
    source: str
    sourceFile: Optional[str]
    # metadata carries topology placement metadata + optional .evidence
    # sub-object. Free-form for now.
    metadata: Dict[str, Any]
    # Phase 13 PR 5 — required. Every topology output element must carry provenance.
    provenance: ElementProvenance


class LevelOrSegment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    type: str
    name: str
    elevation_m: float
    height_m: float


# Topology block from resolvedToLegacyCss: 6 sub-arrays.
# TODO(phase13-cleanup): item shapes within each array are unspecified.
class Topology(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    nodes: List[Any]
    runs: List[Any]
    junctions: List[Any]
    interfaces: List[Any]
    hosts: List[Any]
    openings: List[Any]


# VARIANT: duplicatePositions and outOfBounds are legitimate quality
# counters from topology safety.mjs:95. Optional; not every render writes.
class ModelExtent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    x: float
    y: float
    z: float
    elementCount: int = Field(ge=0)
    duplicatePositions: Optional[int] = Field(default=None, ge=0)
    outOfBounds: Optional[int] = Field(default=None, ge=0)


# Metadata from resolvedToLegacyCss: large set of keys, several optional.
# extra='allow' because topology stages add their own keys.
class Metadata(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    modelExtent: ModelExtent
    safetyWarnings: List[Any]
    exportProfile: ExportProfile
    outputMode: OutputMode
    placementZIsAbsolute: bool
    sourceFusion: Optional[Any]
    interiorSuppression: Optional[Any]
    tunnelDecomposition: Optional[Any]
    repairLog: List[Any]
    cssValidationIssues: int = Field(ge=0)
    cssValidationDetails: Optional[Any] = None
    ambiguousWallProfiles: Optional[Any] = None
    facilityDimensions: List[Any]
    materialAssignments: List[Any]
    adapterSource: Literal["resolvedToLegacyCss"]
    resolvedSchemaVersion: str


# ─── Top-level envelope (strict) ────────────────────────────────────────


class ValidatedCssContract(BaseModel):
    """CALIBRATION FINDING — KNOWN PIPELINE BUG (filed 2026-05-02)

    The cross-field invariant `metadata.modelExtent.elementCount ==
    len(elements)` is correct in spirit but BROKEN in production.
    v2-adapter.mjs:340 explicitly sets `elementCount: elements.length`,
    so the adapter is honest. Something downstream of the adapter
    mutates either elements or elementCount but not both:
      - hospital render (174fdb79...): elementCount=514 vs elements=477 (+37)
      - tunnel render   (2b8e02f0...): elementCount=297 vs elements=304 (-7)
    Different signs imply drift from multiple post-adapter mutations.

    CONSUMERS: grep across backend + ui surfaces ZERO read sites today.
    Field is purely diagnostic. Pipeline correctness unaffected, BUT
    once the trace UI (PR 2) surfaces this field, wrong values will
    display. Fix before PR 2 ships if possible.

    The contract does NOT enforce this invariant in PR 1 because doing
    so would block every currently-shipping render. Once topology-engine
    is fixed, re-enable the @model_validator below.

    TODO(phase13-followup): find post-adapter mutation site that drifts
    the count, fix it, then re-enable the cross-field check.
    """
    model_config = ConfigDict(extra="forbid", strict=True)
    cssVersion: Literal["1.0"]
    domain: Domain
    facility: Facility
    levelsOrSegments: List[LevelOrSegment]
    elements: List[Element]
    topology: Topology
    metadata: Metadata

    # @model_validator(mode="after")
    # def _element_count_matches(self) -> "ValidatedCssContract":
    #     if self.metadata.modelExtent.elementCount != len(self.elements):
    #         raise ValueError(
    #             "metadata.modelExtent.elementCount must equal len(elements)"
    #         )
    #     return self


VALIDATED_CSS_CONTRACT_META = {
    "name": "validatedCssContract",
    "producer": "topology-engine",
    "consumer": "generate",
    "artifact": "css_processed.json",
    "version": "0.1.0",
}
