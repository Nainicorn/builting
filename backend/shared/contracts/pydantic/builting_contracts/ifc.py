"""ifcContract — generate → store.

Validates the event payload returned by generate's Lambda handler. Unlike
the other contracts, this does NOT correspond to a JSON artifact in S3 —
it's the Step Function event handed off between stages.

The IFC file itself lives at ifcS3Path (a separate, non-JSON artifact).
This contract validates the metadata that travels alongside.

Generate's Python handler uses defensive `if 'x' in dir() else default`
patterns extensively, so many fields are effectively optional with
sensible defaults. PR 1 documents the observed surface; cleanup is
deferred.

Audit trail:
  return statement     — generate/lambda_function.py:9632-9663
  ifcS3Path format     — lambda_function.py:9197 ('{userId}/{renderId}/model.ifc')
  bbox fallback        — lambda_function.py:9640 (ifc_bbox or metadata.get(...))
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


# ─── Sub-schemas ────────────────────────────────────────────────────────


class Vec3(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    x: float
    y: float
    z: float


class BboxFull(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    min: Vec3
    max: Vec3
    mode: Optional[str] = None  # DEBT: extra key from generator, tighten when cleaned up


class BboxEmpty(BaseModel):
    """Empty fallback — generate emits {} when neither validate_ifc nor
    metadata supplied a bbox (lambda_function.py:9640)."""
    model_config = ConfigDict(extra="forbid", strict=True)


# Bbox can be empty dict OR {min, max}. Use Union for the discriminated case.
Bbox = Union[BboxFull, BboxEmpty]


class ExportFileEntry(BaseModel):
    """VARIANT: generate emits {s3Key, sizeBytes} per export format."""
    model_config = ConfigDict(extra="forbid", strict=True)
    s3Key: str
    sizeBytes: int = Field(ge=0)


class ValidationSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    valid: bool
    errorCount: int = Field(ge=0)
    warningCount: int = Field(ge=0)
    proxyCount: int = Field(ge=0)
    # Free-form record: keys are proxy reason codes, values are counts.
    proxyReasons: Dict[str, int]
    # Free-form record: keys are style-tier names, values are counts.
    styleTierTotals: Dict[str, int]
    genericNameCount: int = Field(ge=0)
    totalElements: int = Field(ge=0)
    revitCompatScore: int = Field(ge=0, le=100)


# ─── Top-level envelope (strict) ────────────────────────────────────────


class IfcContract(BaseModel):
    """Cross-field invariant: ifcGenerated == True implies ifcSizeBytes > 0.
    A "successful" generation that produced 0 bytes is malformed even though
    each individual field is in-range.
    """
    model_config = ConfigDict(extra="allow", strict=True)
    renderId: str
    userId: str
    # ifcGenerated is always True on this code path (failures throw, never
    # return). Documenting as literal so a regression that returns False
    # without throwing fails the contract.
    ifcGenerated: Literal[True]
    ifcValid: bool
    ifcSizeBytes: int = Field(ge=0)
    # s3:// URI; pattern keeps it loose enough for any bucket/key while
    # catching the "forgot to add s3:// prefix" regression.
    ifcS3Path: str = Field(pattern=r"^s3://[^/]+/.+$")
    elementCounts: Dict[str, int]
    bbox: Bbox
    outputMode: Literal["HYBRID", "METADATA_ONLY", "GEOMETRY_ONLY"]
    cssHash: str
    orientationWarnings: List[Any]
    tunnelShellReport: Optional[Any]
    validationSummary: ValidationSummary
    sourceFusion: Optional[Any]
    # TODO(phase13-cleanup): tracingReport shape unspecified — defaults to {}
    # when generation didn't run a tracing pass.
    tracingReport: Dict[str, Any]
    structuralWarnings: List[Any]
    refinementReport: Optional[Any]
    exportFormats: List[str]
    # VARIANT: keys are format names ('GLB', 'OBJ'); values are {s3Key, sizeBytes} objects.
    # IFC file is at ifcS3Path, not here.
    exportFiles: Dict[str, ExportFileEntry]
    status: str

    @model_validator(mode="after")
    def _generated_implies_nonzero_size(self) -> "IfcContract":
        if self.ifcGenerated and self.ifcSizeBytes <= 0:
            raise ValueError(
                "ifcGenerated=True requires ifcSizeBytes > 0"
            )
        return self


IFC_CONTRACT_META = {
    "name": "ifcContract",
    "producer": "generate",
    "consumer": "store",
    "artifact": "event-payload",
    "version": "0.1.0",
}
