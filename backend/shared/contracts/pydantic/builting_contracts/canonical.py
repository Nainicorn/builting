"""canonicalContract — resolve self-check (no downstream consumer).

Validates canonical_observed.json. See zod/canonical.mjs for the full
operational note. Summary: this contract has NO downstream consumer
(topology reads css_raw directly). Resolve runs it as a self-check and
logs `contract_self_check_failure` on failure without halting the pipeline.

PR 1 captures the schema warts-included.

Audit trail:
  envelope            — resolve/schemas.mjs:147 (buildCanonicalObservedEnvelope)
  observation shape   — resolve/resolve.mjs:487-510 (buildObservation)
  internal-field strip — resolve/identity.mjs:63 (validates POST-strip shape)
  merge confidence    — resolve/resolve.mjs:283-284 (replaced in Phase 14)
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ─── Closed enums (Literal types) ───────────────────────────────────────

# VARIANT: 'ARCH' is legitimate (hospital render).
Domain = Literal["UNKNOWN", "TUNNEL", "BUILDING", "CIVIL", "MIXED", "ARCH"]

ObservationType = Literal[
    "linear_feature", "polygon_feature", "point_feature", "text_fact",
    "asset_record", "level_marker", "space_label", "material_fact",
    "relationship_fact",
]

ObservationStatus = Literal["accepted", "ambiguous", "superseded"]

CandidateClass = Literal[
    "wall", "slab", "segment", "equipment", "opening", "level",
    "space", "column", "unknown",
]

CandidateClassSource = Literal[
    "direct_label", "parser_heuristic", "llm_guess", "geometry_pattern",
]

CoordinateSource = Literal[
    "DIRECT_3D", "DIRECT_2D", "ASSEMBLED_2D", "ESTIMATED", "LLM_GENERATED", "NONE",
]

ExtractionMethod = Literal[
    "VSM_PARSER", "DXF_PARSER", "LLM_EXTRACTION", "VISION_MODEL",
    "LLM_REFINEMENT", "HEURISTIC",
]


# ─── Sub-schemas ────────────────────────────────────────────────────────


class Vec3(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    x: float
    y: float
    z: float


class Facility(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: Optional[str]
    type: Optional[str]
    description: Optional[str]
    units: Literal["M"]
    origin: Vec3
    axes: Literal["RIGHT_HANDED_Z_UP"]


class GeometryEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    curves: List[Any]
    points: List[Vec3]
    profiles: List[Any]
    rawCoordinates: List[Any]
    # dimensions is a free-form record (depth/width/height + spread keys).
    dimensions: Dict[str, Any]


class SemanticEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    labels: List[str]
    tags: List[str]
    properties: Dict[str, Any]
    materials: List[Any]


class ContextEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    containerHints: List[Any]
    adjacencyHints: List[str]
    hostHints: List[str]
    systemHints: List[str]


# Phase 13 PR 3 provenance schema — replaces the old basis/coordinateSource shape.
ProvenanceStatus = Literal[
    "direct", "inherited_consensus", "inherited_contested",
    "derived_geometric", "derived_inferred", "missing", "legacy",
]


class Provenance(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sourceFile: Optional[str]
    sourceFileStatus: ProvenanceStatus
    sourceFiles: List[str]
    stage: str
    modifications: List[str]


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    observation_id: str = Field(pattern=r"^obs-\d{4}$")
    # Set by identity.mjs after resolve.mjs builds the observation.
    # ACTUAL FORMAT: `canon-<8hex>-<3hex>`. The implementation is
    # `'canon-' + randomUUID().slice(0, 12)` and randomUUID() returns
    # 'xxxxxxxx-xxxx-...' so the first 12 chars include an embedded hyphen
    # at position 8. Calibration caught this — the original 12-hex regex
    # rejected every real canonical_id.
    canonical_id: str = Field(pattern=r"^canon-[0-9a-f]{8}-[0-9a-f]{3}$")
    # instance_id is a UUID v4 from randomUUID(); we only enforce non-empty
    # string shape (regex would be over-tight if format ever changes).
    instance_id: str = Field(min_length=1)
    source_claim_ids: List[str]
    observation_type: ObservationType
    observation_status: ObservationStatus
    candidate_class: CandidateClass
    candidate_class_source: CandidateClassSource
    geometry_evidence: GeometryEvidence
    semantic_evidence: SemanticEvidence
    context_evidence: ContextEvidence
    # Same confidence rationale as claimsContract: full [0, 1].
    confidence: float = Field(ge=0.0, le=1.0)
    provenance: Provenance


# DEBT: validation_summary has a real shape (ran/timestamp/domain/
# storeys/containment/wallGeometry/totalWarnings/warnings) — Phase 13.5
# will formalize it with structured semantic validators. Free-form is
# the honest interim state for PR 1.
# TODO(phase13.5): replace with structured ValidationSummary contract.
ValidationSummary = Dict[str, Any]


class CanonicalMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    claimsConsumed: int = Field(ge=0)
    observationsProduced: int = Field(ge=0)
    rejectedClaims: int = Field(ge=0)


# ─── Top-level envelope (strict) ────────────────────────────────────────


class CanonicalContract(BaseModel):
    """Cross-field invariant: metadata.observationsProduced must equal
    len(observations). Resolve sets it from observations.length at write
    time (resolve/index.mjs:122-125). Identical pattern to claimsContract's
    totalClaims invariant.
    """
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: Literal["2.0"]
    layer: Literal["canonical_observed"]
    domain: Domain
    facility: Optional[Facility]
    observations: List[Observation]
    metadata: CanonicalMetadata
    validation_summary: Optional[ValidationSummary] = None

    @model_validator(mode="after")
    def _observations_count_matches(self) -> "CanonicalContract":
        if self.metadata.observationsProduced != len(self.observations):
            raise ValueError(
                "metadata.observationsProduced must equal len(observations)"
            )
        return self


CANONICAL_CONTRACT_META = {
    "name": "canonicalContract",
    "producer": "resolve",
    "consumer": None,  # diagnostic only; runs as resolve self-check
    "artifact": "canonical_observed.json",
    "version": "0.1.0",
    "selfCheck": True,
}
