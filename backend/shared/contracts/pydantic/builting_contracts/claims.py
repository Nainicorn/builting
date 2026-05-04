"""claimsContract — extract → resolve.

Validates claims.json. Documents the schema as currently produced; no cleanup.

PR 1 captures the schema warts-included. Each TODO names a follow-up
PR that will tighten the constraint. Do not "fix" anything in this file
outside its named PR.

Audit trail (where each constant came from):
  claim_id format          — claimsSchema.mjs:120
  claim kinds              — claimsSchema.mjs:7-25 (CLAIM_KINDS)
  claim status             — claimsSchema.mjs:45-50 (CLAIM_STATUS)
  discipline               — claimsSchema.mjs:256-281 (inferDiscipline switch)
  evidence enums           — claimsSchema.mjs:53-99
  parseStatus              — extract/index.mjs:5095-5189 (grep for parseStatus)
  confidence range         — full [0,1]; resolve filters <0.2 (resolve.mjs:19+88),
                             but extract may emit any confidence
  evidence[0] semantics    — resolve.mjs:371,394,405 — see comment on `evidence`
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ─── Closed enums (Literal types) ───────────────────────────────────────

ClaimKind = Literal[
    "segment_geometry", "wall_candidate", "slab_candidate", "equipment_instance",
    "opening_candidate", "level_definition", "space_definition", "material_assignment",
    "spatial_relationship", "junction_definition", "portal_definition", "facility_dimension",
    "vision_finding", "system_membership", "column_candidate", "covering_candidate",
    "fitting_candidate",
]

ClaimStatus = Literal["asserted", "ambiguous", "rejected", "unresolved"]

SourceRole = Literal["NARRATIVE", "SCHEDULE", "SIMULATION", "DRAWING", "VISION"]

ExtractionMethod = Literal[
    "VSM_PARSER", "DXF_PARSER", "LLM_EXTRACTION", "VISION_MODEL",
    "LLM_REFINEMENT", "HEURISTIC",
]

CoordinateSource = Literal[
    "DIRECT_3D", "DIRECT_2D", "ASSEMBLED_2D", "ESTIMATED", "LLM_GENERATED", "NONE",
]

CoordinateDerivation = Literal["direct", "assembled", "estimated"]

SheetRole = Literal[
    "FLOOR_PLAN", "ELEVATION", "SECTION", "TITLE_SHEET", "SCHEDULE",
    "DETAIL", "EQUIPMENT_LAYOUT", "SITE_PLAN", "UNKNOWN",
]

AuthorityLevel = Literal["DEFAULT", "AUTHORITATIVE", "OVERRIDE"]

# NOTE: claims/canonical default to 'UNKNOWN'; validatedCss defaults to 'BUILDING'.
# Not a silent bug today (no consumer branches on === 'BUILDING'), but a footgun.
# Documented in tunnel-shell.mjs cleanup (deferred to PR 2 or later).
# VARIANT: production legitimately uses 'ARCH' for architectural renders
# (hospital). Domain reflects actual project type — will not be tightened.
Domain = Literal["UNKNOWN", "TUNNEL", "BUILDING", "CIVIL", "MIXED", "ARCH"]

Discipline = Literal[
    "structural", "architectural", "mechanical", "civil",
    "electrical", "plumbing", "unknown",
]

ParseStatus = Literal["success", "failed", "low_confidence", "unsupported"]

# DEBT: extract conflates `role` and `sourceRole` field names + mixes
# casing. Right cleanup is standardizing in extract; once done, tighten
# back to a closed enum.
# TODO(phase13-cleanup): standardize in extract, then re-tighten.
SourceManifestRole = str


# Phase 13 PR 3 provenance status values — mirrors claimsSchema.mjs PROVENANCE_STATUS.
ProvenanceStatus = Literal[
    "direct", "inherited_consensus", "inherited_contested",
    "derived_geometric", "derived_inferred", "missing", "legacy",
]

# ─── Sub-schemas ────────────────────────────────────────────────────────


class Origin(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    x: float
    y: float
    z: float


class FacilityMeta(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: Optional[str]
    type: Optional[str]
    description: Optional[str]
    # TODO(phase13-cleanup): extract hardcodes 'M' regardless of source units
    # (claimsSchema.mjs:228). normalize.mjs's unit-conversion branch is
    # unreachable from extract output. Real fix is to plumb source units
    # through; for now contract documents what's emitted.
    units: Literal["M"]
    origin: Origin
    # TODO(phase13-cleanup): same story as units — hardcoded.
    axes: Literal["RIGHT_HANDED_Z_UP"]


class Evidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source: Optional[str]
    sourceRole: Optional[SourceRole]
    extractionMethod: Optional[ExtractionMethod]
    coordinateSource: CoordinateSource
    authority: AuthorityLevel
    excerpt: Optional[str]
    page: Optional[float]
    # TODO(phase13-cleanup): `region`, `drawingMetadata` are free-form. Tighten
    # when actual shapes are catalogued from observed renders.
    region: Optional[Any] = None
    sheetName: Optional[str]
    dxfLayer: Optional[str]
    dxfHandle: Optional[str]
    sheetRole: Optional[SheetRole]
    coordinateDerivation: Optional[CoordinateDerivation]
    scaleConfidence: Optional[float]
    drawingMetadata: Optional[Any] = None


class ClaimProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sourceFile: Optional[str]
    sourceFileStatus: ProvenanceStatus
    sourceFiles: List[str]
    stage: str
    modifications: List[str]


class Claim(BaseModel):
    # strict=True disables string-to-number coercion so we match Zod's default
    # behavior. Without this, Pydantic silently accepts {"confidence": "0.85"}
    # while Zod rejects it — a class of silent drift that is exactly what the
    # round-trip CI is designed to catch.
    model_config = ConfigDict(extra="forbid", strict=True)
    claim_id: str = Field(pattern=r"^c-\d{4}$", description="expected c-NNNN format")
    kind: ClaimKind
    subject_local_id: str
    # TODO(phase13-cleanup): per-kind sub-schemas — 17 kinds, varied shapes.
    # For now `attributes` is free-form. Resolve indexes into specific keys
    # (e.g. attributes.placement.origin in resolve.mjs:218) without checking
    # shape; that's a soft contract not enforced here.
    attributes: Dict[str, Any]
    status: ClaimStatus
    # TODO(phase13-cleanup): `alternatives` item shape unspecified — empty in
    # observed output. Tighten when populated cases surface.
    alternatives: List[Any]
    requires_review: bool
    # SEMANTIC: order matters in `evidence`.
    #   evidence[0]   — primary; resolve uses it for extractionMethod priority,
    #                   coordinateSource priority, and observation construction
    #                   (resolve.mjs:371, 394, 405).
    #   evidence[1..] — unordered set of additional evidence; no priority
    #                   implied. Do not treat evidence[1] as "second-most
    #                   authoritative."
    # Schema can't express ordering; do not reorder evidence in extract
    # without coordinating a resolve change.
    evidence: List[Evidence]
    # confidence is full [0, 1]. Resolve filters <0.2 (resolve.mjs:19+88) into
    # resolution_report.droppedClaims with reason: 'below_confidence_threshold'.
    # Phase 14 will replace the merge rule with disagreement-penalty; do not
    # tighten the lower bound here.
    confidence: float = Field(ge=0.0, le=1.0)
    # TODO(phase13-cleanup): fieldConfidence is free-form. Phase 14 will
    # structure it (per-field score + factors blob).
    fieldConfidence: Dict[str, Any]
    aliases: List[str]
    # TODO(phase13-cleanup): source_revision_hint shape unspecified.
    source_revision_hint: Optional[Any] = None
    discipline: Discipline
    parserVersion: str
    # Phase 13 PR 5 — required. Every claim must carry provenance from extract.
    provenance: "ClaimProvenance"


class SourceManifestEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str
    parseStatus: ParseStatus
    sourceRole: SourceManifestRole
    claimCount: int = Field(ge=0)
    geometryContributor: bool


class ConfidenceDistribution(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    high: int = Field(ge=0)
    medium: int = Field(ge=0)
    low: int = Field(ge=0)


class ExtractionReport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    totalClaims: int = Field(ge=0)
    byKind: Dict[str, int]
    bySource: Dict[str, int]
    confidenceDistribution: ConfidenceDistribution
    # TODO(phase13-cleanup): parseErrors always empty in observed output;
    # either the populating site is missing or aspirational. Find and document.
    parseErrors: List[Any]
    ambiguousClaims: int = Field(ge=0)
    unresolvedClaims: int = Field(ge=0)


# ─── Top-level envelope + cross-field check ─────────────────────────────


class ClaimsContract(BaseModel):
    """Cross-field invariant: extractionReport.totalClaims must equal
    len(claims). Enforced in extract code (claimsSchema.mjs:235:
    `totalClaims: claims.length`). If they disagree, the artifact is
    malformed even though no individual field is wrong.

    FUTURE cross-field constraints land here in PR 3:
      - provenance.sourceFileStatus == 'inherited_consensus'
        ⇒ len(provenance.sourceFiles) >= 2
      - provenance.sourceFileStatus == 'direct'
        ⇒ provenance.sourceFile is not None
    """
    model_config = ConfigDict(extra="forbid", strict=True)
    claimsVersion: Literal["1.0"]
    domain: Domain
    facilityMeta: FacilityMeta
    claims: List[Claim]
    sourceManifest: List[SourceManifestEntry]
    extractionReport: ExtractionReport

    @model_validator(mode="after")
    def _total_claims_matches(self) -> "ClaimsContract":
        if self.extractionReport.totalClaims != len(self.claims):
            raise ValueError(
                "extractionReport.totalClaims must equal len(claims)"
            )
        return self


CLAIMS_CONTRACT_META = {
    "name": "claimsContract",
    "producer": "extract",
    "consumer": "resolve",
    "artifact": "claims.json",
    "version": "0.1.0",
}
