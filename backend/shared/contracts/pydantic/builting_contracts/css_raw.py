"""cssRawContract — extract → topology (geometry-path direct, NOT via resolve).

Validates css_raw.json. Documents the schema as currently produced; no
cleanup.

Important: extract emits cssRaw from MULTIPLE code paths (VSM parser at
extract/index.mjs:1283, BuildingSpec converter at :1722, general building
at :2947), and each path adds its own metadata fields. The contract therefore
uses extra='allow' on `metadata` and `element.metadata` so path-specific
fields don't trigger spurious rejections. Top-level envelope is still strict.

PR 1 captures the schema warts-included. Each TODO names a follow-up
PR that will tighten the constraint. Do not "fix" anything in this file
outside its named PR.

Audit trail (where each constant came from):
  write site            — extract/index.mjs:511 (saveCSSToS3)
  VSM-parser css        — extract/index.mjs:1283
  BuildingSpec css      — extract/index.mjs:1722
  general-building css  — extract/index.mjs:2947
  element shape         — extract/index.mjs:938 (representative push)
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, conlist, model_validator


# ─── Closed enums (Literal types) ───────────────────────────────────────

# NOTE: claims/canonical default to 'UNKNOWN'; validatedCss defaults to
# 'BUILDING'. cssRaw can be either, depending on extraction path. See
# claims.py for the full footgun comment.
# VARIANT: 'ARCH' is legitimate (hospital render).
Domain = Literal["UNKNOWN", "TUNNEL", "BUILDING", "CIVIL", "MIXED", "ARCH"]

# Observed only PENDING in extract output (validation runs in topology);
# other values reserved for future expansion.
ValidationStatus = Literal["PENDING", "VALID", "INVALID"]

# TODO(phase13-cleanup): only HYBRID observed in extract output. Remaining
# modes are set in topology/generate. cssRaw probably only ever has HYBRID;
# if a future extract path emits a different value, tighten the enum.
OutputMode = Literal["HYBRID", "METADATA_ONLY", "GEOMETRY_ONLY"]

ParseStatus = Literal["success", "failed", "low_confidence", "unsupported"]


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


class Facility(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str
    type: str
    description: str
    # TODO(phase13-cleanup): hardcoded 'M' here (and in claims). normalize
    # upstream is unreachable.
    units: Literal["M"]
    # crs is null in every observed extract path (e.g. extract/index.mjs:1291).
    # Documented as nullable in case a future path populates it.
    crs: Optional[str]
    origin: Vec3
    axes: Literal["RIGHT_HANDED_Z_UP"]


# DEBT: every element should carry a complete material. Some extract paths
# emit `material: { name }` without color/transparency. Right cleanup is
# defaults at extract; tighten here once done.
# TODO(phase13-cleanup): fill material defaults in extract; tighten here.
class Material(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str
    color: Optional[conlist(float, min_length=3, max_length=3)] = None
    transparency: Optional[float] = Field(default=None, ge=0.0, le=1.0)


# VARIANT (axis/refDirection): some element types legitimately have only
# an origin point. Optional permanently.
# DEBT (direction extra): spec-instance emitter adds non-canonical
# `direction` field. Right cleanup is migrating emitter to canonical
# {axis, refDirection}; tighten to extra='forbid' once done.
class Placement(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    origin: Vec3
    axis: Optional[Vec3] = None
    refDirection: Optional[Vec3] = None


# Geometry is path-shaped: extracted geometry for tunnel segments has
# {profile, depth, direction, ...}; building elements may have
# {profile, depth, vertices, faces}; etc. Many optional keys.
# extra='allow' is correct here.
class Geometry(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    # method is sometimes set by extract (e.g. 'EXTRUSION'), sometimes not
    # (filled by topology). Keep optional.
    method: Optional[str] = None
    profile: Optional[Any] = None
    depth: Optional[float] = None
# TODO(phase13-cleanup): catalog observed geometry shapes per element type
# (TUNNEL_SEGMENT, DUCT, WALL, etc.) and tighten with discriminated unions.


class Relationship(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: str
    target: str
# TODO(phase13-cleanup): relationship types observed in resolve.mjs:454
# ('HOSTED_BY', 'FILLS', 'ADJACENT_TO', 'MEMBER_OF') but extract may emit
# others. Tighten when actual usage is catalogued.


# DEBT: element extras 'description', 'psets', 'materials' should be using
# the canonical metadata/material/properties fields. Right cleanup is to
# migrate each path; tighten to extra='forbid' once migrated.
# TODO(phase13-cleanup): migrate each extras source path.
class Element(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    id: str
    element_key: Optional[str] = None
    type: str
    semanticType: Optional[str] = None
    name: str
    placement: Optional[Placement]
    geometry: Optional[Geometry]
    container: Optional[str] = None
    # `relationships` missing on 79/252 tunnel cssRaw elements — extract
    # emits only when the parser found them. Topology fills empty array
    # downstream.
    relationships: Optional[List[Relationship]] = None
    properties: Dict[str, Any]
    # `material` is genuinely optional on cssRaw — calibration found 84/252
    # tunnel elements without it (DOOR elements, in particular). Topology
    # fills a default for downstream stages (v2-adapter.mjs:308); cssRaw
    # documents the upstream gap. PR 3 should standardize material upstream.
    material: Optional[Material] = None
    confidence: float = Field(ge=0.0, le=1.0)
    # `source` is a free string in extract: 'VSM', 'LLM', 'DXF', 'VISION', etc.
    # No closed enum because extract paths add their own values; tighten in
    # PR 3 along with the provenance migration.
    source: str
    sourceFile: Optional[str] = None
    # metadata.evidence and topology-engine annotations land here; allow extras.
    metadata: Optional[Dict[str, Any]] = None


class SourceFileEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str
    parseStatus: ParseStatus
    # TODO(phase13-cleanup): `role` is not the same field as claims.json's
    # `sourceRole`. Two stages, two field names for similar concepts. PR 3
    # will reconcile during the provenance migration; for now the contract
    # documents the divergence.
    role: str
    reason: Optional[str] = None
    sourceRole: Optional[str] = None
    imageType: Optional[str] = None
    page: Optional[float] = None


# LevelsOrSegments items vary: the segment shape (from VSM tunnel parser)
# vs the level shape (from BuildingSpec) have different fields entirely.
# extra='allow'. TODO(phase13-cleanup): split into a discriminated union.
class LevelOrSegment(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    id: str
    type: str
    name: str


# ─── Metadata: extra='allow' by design ──────────────────────────────────

# metadata is genuinely extensible per extract code path. Required core
# fields are the intersection across all observed paths; allow path-specific
# additions:
#   - VSM path adds: tunnelExtractionAudit, extractBuild
#   - BuildingSpec path adds: structureClass, topologyConfidence
#   - general-building path adds: envelopeFallbackApplied, interiorSuppression,
#                                 skippedRooms, skippedOpenings
# TODO(phase13-cleanup): catalog all observed metadata fields and tighten
# to a discriminated union by extract-path tag.
class Metadata(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)
    sourceFiles: List[SourceFileEntry]
    outputMode: OutputMode
    validationStatus: ValidationStatus
    unitNormalizationApplied: bool
    cssHash: Optional[str]
    elementCounts: Dict[str, int]
    bbox: Bbox
    # repairLog observed in 2/3 paths but not always — keep optional.
    repairLog: Optional[List[Any]] = None


# ─── Top-level envelope (strict) ────────────────────────────────────────


class CssRawContract(BaseModel):
    """CALIBRATION FINDING — KNOWN PIPELINE BUG (filed 2026-05-02)

    Same bug class as validatedCss elementCount drift. Extract emits
    metadata.elementCounts at one point in its run, then later passes
    add MORE elements without updating elementCounts. Tunnel cssRaw
    observed: elementCounts sums to 160; elements.length=252; missing
    types entirely (SPACE, DUCT_FITTING, SLAB). Hospital cssRaw is
    consistent — bug is path-specific.

    CONSUMERS (who reads metadata.elementCounts and gets wrong data):
      - topology-engine/validation.mjs:207 OVERWRITES it from elements,
        so stale value is masked within the pipeline (self-healing).
      - Direct readers of cssRaw.json (debug tools, future PR 7
        diagnostics ZIP, manual S3 inspection).
      - extract/index.mjs:1321 reads it for tunnelExtractionAudit
        (audit logs the wrong total).
    Pipeline correctness unaffected; diagnostic/audit output is wrong.

    Cross-field check disabled until extract is fixed.
    TODO(phase13-followup): see zod/cssRaw.mjs for the followup plan.
    """
    model_config = ConfigDict(extra="forbid", strict=True)
    cssVersion: Literal["1.0"]
    domain: Domain
    facility: Facility
    levelsOrSegments: List[LevelOrSegment]
    elements: List[Element]
    metadata: Metadata

    # @model_validator(mode="after")
    # def _element_counts_match(self) -> "CssRawContract":
    #     total = sum(self.metadata.elementCounts.values())
    #     if total != len(self.elements):
    #         raise ValueError(
    #             "sum(metadata.elementCounts) must equal len(elements)"
    #         )
    #     return self


CSS_RAW_CONTRACT_META = {
    "name": "cssRawContract",
    "producer": "extract",
    "consumer": "topology-engine",
    "artifact": "css_raw.json",
    "version": "0.1.0",
}
