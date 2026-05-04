"""Pipeline boundary contracts (Pydantic side).

Paired with @builting/contracts on the Zod side. CI round-trip ensures
verdict equivalence on every fixture.

NOTE: contracts are added one at a time during PR 1. Each contract is
written in Zod + Pydantic in parallel, then fixtures + local CI, then
the next. As each lands, add its export here and the matching entry
in ci/contracts.config.mjs.
"""

from .claims import ClaimsContract, CLAIMS_CONTRACT_META
from .css_raw import CssRawContract, CSS_RAW_CONTRACT_META
from .canonical import CanonicalContract, CANONICAL_CONTRACT_META
from .validated_css import ValidatedCssContract, VALIDATED_CSS_CONTRACT_META
from .ifc import IfcContract, IFC_CONTRACT_META

__all__ = [
    "ClaimsContract",
    "CLAIMS_CONTRACT_META",
    "CssRawContract",
    "CSS_RAW_CONTRACT_META",
    "CanonicalContract",
    "CANONICAL_CONTRACT_META",
    "ValidatedCssContract",
    "VALIDATED_CSS_CONTRACT_META",
    "IfcContract",
    "IFC_CONTRACT_META",
]
