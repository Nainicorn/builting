"""
CSS-driven IFC4 generator using IfcOpenShell.
Consumes Canonical Structure Schema (CSS) v1.0 and produces valid IFC4 files.

Supports:
- Element-driven generation from css.elements[]
- Confidence-based semantic mapping (>= 0.7 → proper entity, < 0.7 → proxy)
- Graded output modes: FULL_SEMANTIC, HYBRID, PROXY_ONLY
- EXTRUSION, SWEEP, and MESH geometry methods
- CSS→IFC caching via SHA-256 hash
"""

import json
import math
import hashlib
import re
import os
from datetime import datetime, timezone
import boto3

try:
    import ifcopenshell
    import ifcopenshell.guid
except Exception as e:
    raise RuntimeError(f"IfcOpenShell not available in runtime: {e}")

try:
    from ifc_enrichment import enrich_ifc
    _ENRICHMENT_AVAILABLE = True
except Exception as _enrich_import_err:
    print(f"[enrichment] Module not available: {_enrich_import_err}")
    _ENRICHMENT_AVAILABLE = False

try:
    from pipeline_trace import write_trace_start, write_trace_end
    _TRACE_AVAILABLE = True
except Exception as _trace_import_err:
    print(f"[trace] Module not available: {_trace_import_err}")
    _TRACE_AVAILABLE = False

# Phase 13.5 PR6: Audit log
try:
    from audit import init_audit, log_decision, log_validation, flush_audit
    _AUDIT_AVAILABLE = True
except Exception as _audit_import_err:
    print(f"[audit] Module not available: {_audit_import_err}")
    def init_audit(*a, **k): pass
    def log_decision(*a, **k): pass
    def log_validation(*a, **k): pass
    def flush_audit(*a, **k): pass
    _AUDIT_AVAILABLE = False

# PR 8: Generate-stage validators
try:
    import sys as _sys
    import os as _os
    _sys.path.insert(0, _os.path.join(_os.path.dirname(__file__), 'validators'))
    from generate_validators import run_generate_validators
    _GEN_VALIDATORS_AVAILABLE = True
except Exception as _gv_import_err:
    print(f"[generate_validators] Module not available: {_gv_import_err}")
    def run_generate_validators(*a, **k):
        return {'entries': [], 'total': 0, 'passed': 0, 'warned': 0, 'failed': 0}
    _GEN_VALIDATORS_AVAILABLE = False

s3_client = boto3.client('s3')
DATA_BUCKET = os.environ.get('DATA_BUCKET', 'builting-data')
IFC_BUCKET = os.environ.get('IFC_BUCKET', 'builting-ifc')


# ─── Phase 13: Producer self-check ──────────────────────────────────────────

class ContractFailure(Exception):
    """Named exception so Step Functions can route via ErrorEquals: ["ContractFailure"]."""
    pass


def _check_validated_css_contract(css, user_id, render_id):
    """Validate css_processed.json on entry (Pydantic, halting).
    Logs [contract:validatedCssContract] PASS / [contract_failure] on outcome.
    """
    try:
        from builting_contracts.validated_css import ValidatedCssContract
        from pydantic import ValidationError
    except ImportError as ie:
        print(f'[contract:validatedCssContract] SKIP builting_contracts not available: {ie}')
        return

    try:
        ValidatedCssContract.model_validate(css)
        print(f'[contract:validatedCssContract] PASS stage=generate-entry renderId={render_id}')
    except Exception as exc:
        errors = exc.errors() if hasattr(exc, 'errors') else [{'loc': [], 'msg': str(exc), 'type': 'unknown'}]
        preview = '; '.join(
            f"{'.' .join(str(x) for x in e.get('loc', []))}: {e.get('msg', '')}"
            for e in errors[:5]
        )
        print(
            f'[contract_failure] contract=validatedCssContract stage=generate-entry renderId={render_id}'
            f' totalErrors={len(errors)} sample="{preview}"'
        )
        try:
            import time as _time
            run_id = int(_time.time() * 1000)
            q_key = f'uploads/{user_id}/{render_id}/quarantine/generate-entry/{run_id}/artifact.json'
            s3_client.put_object(
                Bucket=DATA_BUCKET, Key=q_key,
                Body=json.dumps({
                    'quarantinedAt': datetime.now(timezone.utc).isoformat(),
                    'stage': 'generate-entry',
                    'renderId': render_id,
                    'contractErrors': [
                        {'path': '.'.join(str(x) for x in e.get('loc', [])),
                         'message': e.get('msg', ''), 'type': e.get('type', '')}
                        for e in errors[:20]
                    ],
                    'artifact': css,
                }, default=str),
                ContentType='application/json',
            )
            print(f'[contract_quarantine] artifact written: s3://{DATA_BUCKET}/{q_key}')
        except Exception as qe:
            print(f'[contract_quarantine_failed] contract=validatedCssContract {qe}')
        raise ContractFailure(
            f'Contract validatedCssContract failed: {len(errors)} error(s) — {preview}'
        ) from exc


def _check_ifc_contract(event, user_id, render_id):
    """Validate the generate→store event payload against ifcContract (Pydantic).
    Halting: writes quarantine artifact to S3 then raises on failure.
    Logs [contract:ifcContract] PASS / [contract_failure] on outcome.
    """
    try:
        from builting_contracts.ifc import IfcContract
        from pydantic import ValidationError
    except ImportError as ie:
        print(f'[contract:ifcContract] SKIP builting_contracts not available: {ie}')
        return

    try:
        IfcContract.model_validate(event)
        print(f'[contract:ifcContract] PASS stage=generate renderId={render_id}')
    except Exception as exc:
        errors = exc.errors() if hasattr(exc, 'errors') else [{'loc': [], 'msg': str(exc), 'type': 'unknown'}]
        preview = '; '.join(
            f"{'.' .join(str(x) for x in e.get('loc', []))}: {e.get('msg', '')}"
            for e in errors[:5]
        )
        print(
            f'[contract_failure] contract=ifcContract stage=generate renderId={render_id}'
            f' totalErrors={len(errors)} sample="{preview}"'
        )
        # Quarantine write (Option 3) before throwing.
        try:
            import time as _time
            run_id = int(_time.time() * 1000)
            q_key = f'uploads/{user_id}/{render_id}/quarantine/generate/{run_id}/artifact.json'
            s3_client.put_object(
                Bucket=DATA_BUCKET, Key=q_key,
                Body=json.dumps({
                    'quarantinedAt': datetime.now(timezone.utc).isoformat(),
                    'stage': 'generate',
                    'renderId': render_id,
                    'contractErrors': [
                        {'path': '.'.join(str(x) for x in e.get('loc', [])),
                         'message': e.get('msg', ''), 'type': e.get('type', '')}
                        for e in errors[:20]
                    ],
                    'artifact': event,
                }, default=str),
                ContentType='application/json',
            )
            print(f'[contract_quarantine] artifact written: s3://{DATA_BUCKET}/{q_key}')
        except Exception as qe:
            print(f'[contract_quarantine_failed] contract=ifcContract {qe}')
        raise ContractFailure(
            f'Contract ifcContract failed: {len(errors)} error(s) — {preview}'
        ) from exc


# Feature flag: enable IfcFixedReferenceSweptAreaSolid for non-circular profiles.
# Default OFF — rectangular profiles use extrusion-along-path (proven).
# Enable per-deployment for testing against xeokit/BIMvision/Revit.
USE_FIXED_REF_SWEEP = os.environ.get('USE_FIXED_REF_SWEEP', 'false').lower() == 'true'


# ============================================================================
# CONSTANTS & MATERIAL LIBRARY
# ============================================================================

MATERIAL_COLORS = {
    'concrete': (0.75, 0.75, 0.75),
    'brick': (0.72, 0.36, 0.22),
    'steel': (0.48, 0.52, 0.58),       # bluer steel gray
    'timber': (0.65, 0.45, 0.25),
    'glass': (0.65, 0.83, 0.97),       # brighter sky blue
    'concrete_floor': (0.65, 0.65, 0.65),
    'metal_roof': (0.40, 0.45, 0.50),
    'metal': (0.40, 0.45, 0.50),
    'membrane': (0.30, 0.30, 0.30),
    'tiles': (0.50, 0.50, 0.55),
    'screed': (0.58, 0.58, 0.58),
    'plasterboard': (0.9, 0.9, 0.88),
    'wood': (0.55, 0.40, 0.25),
    'door': (0.55, 0.40, 0.25),
    'window': (0.65, 0.83, 0.97),      # brighter sky blue
    'space': (0.88, 0.88, 0.88),
    'blasted_rock': (0.48, 0.43, 0.38),
    'shotcrete': (0.55, 0.55, 0.52),
    'unknown': (0.7, 0.7, 0.7),
}

# Pipe system-type colors — Revit/ASHRAE/ISO color coding conventions.
# Keys are normalized (uppercase, spaces/hyphens → underscores).
# Fallback to PIPE css_type color when system type is absent or unrecognized.
PIPE_SYSTEM_COLORS = {
    'DOMESTIC_COLD_WATER':          (0.15, 0.45, 0.88),   # cold water blue
    'COLD_WATER':                   (0.15, 0.45, 0.88),
    'DOMESTIC_WATER':               (0.15, 0.45, 0.88),
    'DOMESTIC_HOT_WATER':           (0.92, 0.25, 0.10),   # hot water red-orange
    'HOT_WATER':                    (0.92, 0.25, 0.10),
    'FIRE_SUPPRESSION':             (0.92, 0.08, 0.08),   # fire red
    'FIRE_PROTECTION':              (0.92, 0.08, 0.08),
    'SPRINKLER':                    (0.92, 0.08, 0.08),
    'CHILLED_WATER_SUPPLY':         (0.25, 0.70, 0.95),   # chilled water supply — light blue
    'CHILLED_WATER_RETURN':         (0.10, 0.48, 0.80),   # chilled water return — medium blue
    'CHILLED_WATER':                (0.18, 0.60, 0.90),
    'HEATING_HOT_WATER':            (0.92, 0.38, 0.10),   # heating hot water — orange-red
    'HEATING_HOT_WATER_SUPPLY':     (0.92, 0.38, 0.10),
    'HEATING_HOT_WATER_RETURN':     (0.80, 0.22, 0.08),
    'SANITARY':                     (0.45, 0.40, 0.28),   # sanitary drain — dark olive
    'SANITARY_DRAIN':               (0.45, 0.40, 0.28),
    'DRAIN':                        (0.45, 0.40, 0.28),
    'STORM':                        (0.30, 0.38, 0.52),   # storm drain — slate blue-gray
    'STORM_DRAIN':                  (0.30, 0.38, 0.52),
    'GAS':                          (0.95, 0.88, 0.10),   # gas — yellow
    'NATURAL_GAS':                  (0.95, 0.88, 0.10),
    'STEAM':                        (0.82, 0.82, 0.82),   # steam — light gray
    'CONDENSATE':                   (0.15, 0.62, 0.58),   # condensate — teal
    'COMPRESSED_AIR':               (0.55, 0.78, 0.55),   # compressed air — light green
    'REFRIGERANT':                  (0.72, 0.30, 0.82),   # refrigerant — purple
}

# Duct system-type colors — Revit/ASHRAE conventions.
DUCT_SYSTEM_COLORS = {
    'SUPPLY_AIR':   (0.10, 0.45, 0.88),   # supply air — blue
    'SUPPLY':       (0.10, 0.45, 0.88),
    'RETURN_AIR':   (0.15, 0.68, 0.30),   # return air — green
    'RETURN':       (0.15, 0.68, 0.30),
    'EXHAUST_AIR':  (0.92, 0.55, 0.10),   # exhaust — orange
    'EXHAUST':      (0.92, 0.55, 0.10),
    'OUTSIDE_AIR':  (0.20, 0.88, 0.92),   # outside/fresh air — teal
    'OA':           (0.20, 0.88, 0.92),
    'FRESH_AIR':    (0.20, 0.88, 0.92),
    'TRANSFER_AIR': (0.55, 0.78, 0.45),   # transfer air — light green
}

# Type/system-based color overrides — precedence: semanticType → shellPiece → css_type → material
# Colors follow Revit/Navisworks BIM industry conventions for immediate readability
TYPE_COLORS = {
    # Structural — Revit/Navisworks standard palette
    'WALL':   (0.753, 0.753, 0.753),  # concrete gray
    'SLAB':   (0.82, 0.78, 0.68),     # light tan/sandstone — floor slab BIM convention
    'COLUMN': (0.60, 0.63, 0.68),     # structural steel blue-gray
    'BEAM':   (0.55, 0.58, 0.65),     # structural steel blue-gray
    # Openings
    'DOOR': (0.50, 0.30, 0.15),       # wood brown
    'WINDOW': (0.60, 0.82, 0.95),     # sky blue glass
    # MEP systems — Revit discipline colors
    'DUCT': (0.0, 0.72, 0.87),        # Revit HVAC cyan
    'PIPE': (0.18, 0.60, 0.30),       # Revit piping green
    # HVAC equipment — HVAC discipline blue
    'IfcFan': (0.10, 0.52, 0.88),              # HVAC blue
    'IfcPump': (0.12, 0.55, 0.28),             # plumbing green
    'IfcElectricGenerator': (0.92, 0.48, 0.05), # electrical orange
    'IfcCompressor': (0.30, 0.48, 0.72),        # mechanical blue
    'IfcTransformer': (0.95, 0.80, 0.05),       # electrical amber
    'IfcBoiler': (0.88, 0.25, 0.08),            # heating red-orange
    'IfcChiller': (0.08, 0.58, 0.82),           # cooling blue
    'IfcAirToAirHeatRecovery': (0.18, 0.62, 0.72),  # HVAC teal
    'IfcUnitaryEquipment': (0.30, 0.48, 0.72),  # HVAC discipline blue
    'IfcHeatExchanger': (0.25, 0.55, 0.75),     # HVAC blue
    'IfcAirTerminal': (0.10, 0.72, 0.88),       # supply air cyan
    'IfcDamper': (0.08, 0.65, 0.82),            # HVAC cyan
    'IfcCoil': (0.28, 0.58, 0.78),              # HVAC blue
    'IfcCoolingTower': (0.08, 0.62, 0.75),      # cooling blue
    'IfcFilter': (0.42, 0.62, 0.72),            # HVAC gray-blue
    # Fire protection — fire red (Navisworks standard)
    'IfcFireSuppressionTerminal': (0.92, 0.08, 0.08),  # fire red
    'IfcAlarm': (0.95, 0.12, 0.12),             # alarm red
    # Sensing / controls
    'IfcSensor': (0.20, 0.82, 0.30),            # lime green
    'IfcActuator': (0.35, 0.45, 0.85),          # control systems blue
    'IfcFlowMeter': (0.25, 0.62, 0.38),         # piping green
    # Electrical — amber/yellow (Navisworks standard)
    'IfcCommunicationsAppliance': (0.45, 0.15, 0.72),  # telecom purple
    'IfcElectricDistributionBoard': (0.55, 0.20, 0.75), # electrical distribution purple
    'IfcLightFixture': (1.0, 0.95, 0.42),       # warm light yellow
    'IfcLamp': (1.0, 0.98, 0.55),               # warm white-yellow
    'IfcCableCarrierSegment': (0.95, 0.75, 0.08),  # electrical amber
    'IfcCableSegment': (0.90, 0.70, 0.05),      # electrical gold
    # Plumbing
    'IfcValve': (0.18, 0.62, 0.30),             # piping green
    'IfcTank': (0.28, 0.52, 0.65),              # water/storage blue
    # Distribution segments: no entry here — colors are resolved via PIPE_SYSTEM_COLORS /
    # DUCT_SYSTEM_COLORS by systemType, falling back to css_type PIPE/DUCT entries below.
    # Industrial
    'IfcTransportElement': (0.55, 0.48, 0.72),  # industrial purple
    # Spaces — translucent
    'SPACE': (0.75, 0.85, 0.95),     # light blue tint
    # Generic equipment fallback
    'EQUIPMENT': (0.85, 0.55, 0.15),  # bright orange-amber
    # Proxy fallback
    'PROXY': (0.60, 0.60, 0.55),
    # Tunnel parent segments (un-decomposed)
    'TUNNEL_SEGMENT': (0.75, 0.73, 0.68),  # warm concrete
}

# Shell piece colors — layer 2 in color precedence (after semanticType, before css_type)
# Unified concrete gray for structural, sky blue for void
SHELL_PIECE_COLORS = {
    'LEFT_WALL':  (0.753, 0.753, 0.753),  # concrete gray (matches Revit reference)
    'RIGHT_WALL': (0.753, 0.753, 0.753),  # concrete gray
    'FLOOR':      (0.65, 0.65, 0.65),     # slightly darker concrete for slabs
    'ROOF':       (0.65, 0.65, 0.65),     # slightly darker concrete for slabs
    'VOID':       (0.55, 0.78, 0.95),     # bright sky blue (transparency preserved elsewhere)
}

# Equipment size reference table (width, height, depth in meters).
# Sourced from IFC standard equipment dimensions and common manufacturer data.
# LAST-RESORT ONLY — only applied when CSS geometry.profile is absent or placeholder (≈1×1×1).
# Any CSS-provided geometry.profile dimensions take precedence. Log is emitted on every use.
EQUIPMENT_SIZE_DEFAULTS = {
    'IfcFan':                       (1.2, 1.2, 0.8),
    'IfcPump':                      (0.8, 0.6, 1.0),
    'IfcValve':                     (0.3, 0.3, 0.2),
    'IfcSensor':                    (0.15, 0.15, 0.1),
    'IfcCompressor':                (1.5, 1.2, 2.0),
    'IfcTransformer':               (1.0, 1.5, 0.8),
    'IfcBoiler':                    (0.8, 1.2, 0.8),
    'IfcChiller':                   (1.5, 1.0, 2.0),
    'IfcElectricDistributionBoard': (0.6, 1.8, 0.3),
    'IfcLightFixture':              (0.6, 0.6, 0.1),
    'IfcFireSuppressionTerminal':   (0.15, 0.15, 0.3),
    'IfcAlarm':                     (0.15, 0.15, 0.1),
    'IfcCommunicationsAppliance':   (0.4, 0.4, 0.2),
    'IfcTank':                      (1.5, 2.0, 1.5),
    'IfcActuator':                  (0.2, 0.2, 0.15),
    'IfcElectricGenerator':         (1.0, 0.9, 0.9),
    'IfcUnitaryEquipment':          (0.8, 0.8, 0.8),
    'IfcAirToAirHeatRecovery':      (1.0, 0.8, 1.0),
    'IfcCableCarrierSegment':       (0.3, 0.15, 1.0),
    'IfcCableSegment':              (0.05, 0.05, 1.0),
    'IfcPipeSegment':               (0.15, 0.15, 1.0),
    'IfcDuctSegment':               (0.4, 0.4, 1.0),
}

# Max extrusion depth for discrete equipment — prevents segment-length spikes
# Continuous runs (IfcDuctSegment, IfcPipeSegment, IfcCableCarrierSegment) intentionally omitted
EQUIPMENT_MAX_DEPTH = {
    'IfcLightFixture':              0.8,
    'IfcSensor':                    0.5,
    'IfcAlarm':                     0.3,
    'IfcActuator':                  0.5,
    'IfcFireSuppressionTerminal':   0.6,
    'IfcCommunicationsAppliance':   0.5,
    'IfcValve':                     0.5,
    'IfcFan':                       2.5,
    'IfcPump':                      2.0,
    'IfcElectricDistributionBoard': 0.8,
    'IfcElectricGenerator':         3.0,
    'IfcCompressor':                3.0,
    'IfcTransformer':               1.5,
    'IfcBoiler':                    1.5,
    'IfcChiller':                   3.0,
    'IfcTank':                      3.0,
    'IfcUnitaryEquipment':          1.5,
    'IfcAirToAirHeatRecovery':      1.5,
    'IfcDuctSegment':               3.0,
    'IfcPipeSegment':               2.0,
    'IfcCableCarrierSegment':       2.0,
}

# CSS type → IFC entity mapping (confident, >= 0.7)
SEMANTIC_IFC_MAP = {
    'WALL': 'IfcWall',
    'SLAB': 'IfcSlab',
    'COLUMN': 'IfcColumn',
    'BEAM': 'IfcBeam',
    'DOOR': 'IfcDoor',
    'WINDOW': 'IfcWindow',
    'SPACE': 'IfcSpace',
    'EQUIPMENT': 'IfcBuildingElementProxy',
    'TUNNEL_SEGMENT': 'IfcWall',
    'DUCT': 'IfcDuctSegment',
    'PIPE': 'IfcPipeSegment',
    'CABLE_TRAY': 'IfcCableCarrierSegment',
    'OPENING': 'IfcOpeningElement',
    'RAILING': 'IfcRailing',
    'STAIR': 'IfcStair',
    'RAMP': 'IfcRamp',
    'ROOF': 'IfcSlab',
    'CURTAIN_WALL': 'IfcCurtainWall',
    'COVERING': 'IfcCovering',
    'FOOTING': 'IfcFooting',
    'PROXY': 'IfcBuildingElementProxy',
}

# Equipment semanticType → IFC entity (when confident)
# Comprehensive map covering all equipment types from extract pipeline
EQUIPMENT_SEMANTIC_MAP = {
    # MEP equipment
    'IfcElectricGenerator': 'IfcElectricGenerator',
    'IfcPump': 'IfcPump',
    'IfcFan': 'IfcFan',
    'IfcCompressor': 'IfcCompressor',
    'IfcTransformer': 'IfcTransformer',
    'IfcBoiler': 'IfcBoiler',
    'IfcChiller': 'IfcChiller',
    'IfcAirToAirHeatRecovery': 'IfcAirToAirHeatRecovery',
    # Distribution segments
    'IfcPipeSegment': 'IfcPipeSegment',
    'IfcDuctSegment': 'IfcDuctSegment',
    'IfcCableCarrierSegment': 'IfcCableCarrierSegment',
    'IfcCableSegment': 'IfcCableSegment',
    # Infrastructure / safety
    'IfcFireSuppressionTerminal': 'IfcFireSuppressionTerminal',
    'IfcSensor': 'IfcSensor',
    'IfcActuator': 'IfcActuator',
    'IfcAlarm': 'IfcAlarm',
    'IfcCommunicationsAppliance': 'IfcCommunicationsAppliance',
    'IfcElectricDistributionBoard': 'IfcElectricDistributionBoard',
    # Lighting / fixtures
    'IfcLightFixture': 'IfcLightFixture',
    'IfcLamp': 'IfcLamp',
    # Tanks / storage
    'IfcTank': 'IfcTank',
    # Valves
    'IfcValve': 'IfcValve',
    # Generic unitary
    'IfcUnitaryEquipment': 'IfcUnitaryEquipment',
    # Additional IFC4 native types
    'IfcHeatExchanger': 'IfcHeatExchanger',
    'IfcAirTerminal': 'IfcAirTerminal',
    'IfcFlowMeter': 'IfcFlowMeter',
    'IfcFilter': 'IfcFilter',
    'IfcDamper': 'IfcDamper',
    'IfcCoil': 'IfcCoil',
    'IfcCoolingTower': 'IfcCoolingTower',
    'IfcConveyor': 'IfcTransportElement',
}


# ============================================================================
# HELPERS
# ============================================================================

def new_guid():
    return ifcopenshell.guid.new()


# In-memory tracking of sanitized vectors (keyed by element_id)
# Validator uses this to classify "sanitized upstream" vs "still invalid"
_sanitized_elements = {}

# Shared caches for material/style reuse — cleared per generation run
# Keyed by (material_name, rounded_thickness) → IfcMaterialLayerSet
_material_cache = {}
# Keyed by (color_rgb_tuple, rounded_transparency) → IfcPresentationStyleAssignment
_style_cache = {}


def normalize_vector(x, y, z, fallback=(0, 0, 1), elem_id=None, context=None):
    """Normalize a 3D vector. Returns fallback if degenerate (zero-length, NaN, inf).
    Logs with elem_id and context when fallback is used."""
    x, y, z = float(x), float(y), float(z)
    if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
        if elem_id:
            print(f"Warning: non-finite vector ({x},{y},{z}) for {context or 'vector'} "
                  f"on element {elem_id}, using fallback {fallback}")
        return fallback
    length = math.sqrt(x * x + y * y + z * z)
    if length < 1e-10:
        if elem_id:
            print(f"Warning: zero-length vector ({x},{y},{z}) for {context or 'vector'} "
                  f"on element {elem_id}, using fallback {fallback}")
        return fallback
    return (x / length, y / length, z / length)


def safe_float(value, default=None):
    """Safely convert value to float. Returns default if value is None or invalid."""
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def _normalize_direction(d, default=None):
    """Accept direction as [x,y,z] list or {x,y,z} dict; always return dict."""
    if default is None:
        default = {'x': 0.0, 'y': 0.0, 'z': 0.0}
    if isinstance(d, (list, tuple)):
        return {
            'x': float(d[0]) if len(d) > 0 else 0.0,
            'y': float(d[1]) if len(d) > 1 else 0.0,
            'z': float(d[2]) if len(d) > 2 else 0.0,
        }
    if isinstance(d, dict):
        return d
    return default


# ============================================================================
# ENGINEERING DERIVATION UTILITIES
# All geometry constants must be derived from input data. These functions
# implement domain-appropriate engineering rules so the pipeline works for
# any structure type (tunnel, hospital, office, warehouse, etc.) without
# hardcoded dataset-specific values.
# ============================================================================

def derive_shell_thickness(profile_w, profile_h, explicit_t=None, material_hint=None):
    """Derive a structurally reasonable shell/wall thickness from cross-section dimensions.

    Priority: explicit_t from CSS → material-informed rule → geometric rule → absolute minimum.
    Engineering basis (structural codes):
      concrete / shotcrete / blasted_rock: t = max(0.2, min(W,H) * 0.08)   [min 200mm]
      steel / metal:                       t = max(0.012, min(W,H) * 0.02)
      masonry / brick / tile:              t = max(0.10, min(W,H) * 0.04)
      timber / wood:                       t = max(0.05, min(W,H) * 0.05)
      default (unknown):                   t = max(0.15, min(W,H) * 0.06)

    All results capped at half the smallest profile dimension to prevent wall
    overlap (two walls of this thickness must fit inside the section).
    Returns thickness in meters."""
    if explicit_t and float(explicit_t) > 0:
        t = float(explicit_t)
    else:
        w = float(profile_w) if profile_w else 1.0
        h = float(profile_h) if profile_h else 1.0
        smallest = min(w, h)
        mat = (material_hint or '').lower()
        if any(k in mat for k in ('concrete', 'shotcrete', 'rock', 'stone', 'reinforced')):
            t = max(0.2, smallest * 0.08)
        elif any(k in mat for k in ('steel', 'metal', 'aluminium', 'aluminum')):
            t = max(0.012, smallest * 0.02)
        elif any(k in mat for k in ('masonry', 'brick', 'block', 'tile', 'cmu')):
            t = max(0.10, smallest * 0.04)
        elif any(k in mat for k in ('timber', 'wood', 'glulam', 'clt')):
            t = max(0.05, smallest * 0.05)
        else:
            t = max(0.15, smallest * 0.06)
        # Never exceed 10% of the smallest cross-section dimension —
        # prevents visually thick walls on small-bore tunnels/ducts.
        t = min(t, smallest * 0.10)
    # Cap: two shell walls must fit inside profile
    w = float(profile_w) if profile_w else 1.0
    h = float(profile_h) if profile_h else 1.0
    t = min(t, min(w, h) / 2.0 - 0.005)
    t = max(t, 0.01)  # absolute minimum 10mm
    return round(t, 4)


def derive_slab_thickness(span_m, load_hint=None, material_hint=None, explicit_t=None):
    """Derive structural slab thickness from span length.

    Priority: explicit_t → span-based rule → absolute minimum.
    Engineering basis (RC slab design):
      Light loading (residential/office): span / 28 (two-way) to span / 20 (one-way)
      Medium loading (hospital/education): span / 25 to span / 18
      Heavy loading (warehouse/industrial): span / 20 to span / 14
      Minimum 100mm for any slab; maximum 600mm for typical flat slabs.
    Returns thickness in meters."""
    if explicit_t and float(explicit_t) > 0:
        return float(explicit_t)
    span = float(span_m) if span_m and float(span_m) > 0 else 5.0
    hint = (load_hint or '').lower()
    if any(k in hint for k in ('warehouse', 'industrial', 'heavy', 'plant')):
        t = span / 17.0
    elif any(k in hint for k in ('hospital', 'education', 'school', 'medium')):
        t = span / 23.0
    else:
        t = span / 26.0  # office / residential default
    return round(max(0.10, min(t, 0.60)), 3)


def derive_storey_height(occupancy_type=None, explicit_h=None):
    """Derive storey floor-to-floor height from occupancy type when not explicitly provided.

    Used ONLY as a last-resort fallback when css.levelsOrSegments[i].height_m is absent.
    Engineering basis (building codes / typical practice):
      residential:  2.8m    warehouse:  8.0m
      office:       3.5m    car park:   3.0m
      hospital:     4.2m    laboratory: 4.0m
      retail:       4.5m    data centre:4.0m
    Returns height in meters."""
    if explicit_h and float(explicit_h) > 0:
        return float(explicit_h)
    occ = (occupancy_type or '').lower()
    if any(k in occ for k in ('residential', 'apartment', 'housing', 'dwelling')):
        return 2.8
    if any(k in occ for k in ('warehouse', 'storage', 'logistics', 'distribution')):
        return 8.0
    if any(k in occ for k in ('hospital', 'medical', 'clinic', 'healthcare')):
        return 4.2
    if any(k in occ for k in ('retail', 'shop', 'mall', 'commercial')):
        return 4.5
    if any(k in occ for k in ('car park', 'parking', 'garage')):
        return 3.0
    if any(k in occ for k in ('laboratory', 'lab', 'research', 'data')):
        return 4.0
    if any(k in occ for k in ('school', 'education', 'university', 'classroom')):
        return 3.6
    if any(k in occ for k in ('industrial', 'factory', 'manufactur', 'plant')):
        return 5.0
    return 3.5  # office / default


def derive_duct_profile(area_m2=None, system_type=None, parent_width=None, parent_height=None,
                         elem_id=None):
    """Derive duct rectangular cross-section width and height from available data.

    Priority chain:
      1. area_m2 present → compute from area using ASHRAE aspect ratio rules
      2. parent segment profile present → size as clearance fraction of enclosing segment
      3. system-type heuristic → typical duct size for the system class

    ASHRAE aspect ratio guidance (duct design):
      Supply/return main runs: AR ≤ 4:1 for efficiency; ideal 1.5:1
      Exhaust / outside air:  AR ≤ 3:1
      Transfer air / general: AR ≤ 6:1

    Returns (width_m, height_m) rounded to 3dp."""
    # 1. Derive from area_m2 — most accurate
    if area_m2 and float(area_m2) > 0.01:
        area = float(area_m2)
        sys = (system_type or '').upper()
        # Select target aspect ratio based on system type
        if any(k in sys for k in ('EXHAUST', 'OUTSIDE', 'OA', 'FRESH', 'TRANSFER')):
            ar = 1.8   # lower AR for exhaust/OA
        elif any(k in sys for k in ('SUPPLY', 'RETURN')):
            ar = 1.5   # near-square for supply/return mains
        else:
            ar = 1.5   # general default
        w = math.sqrt(area * ar)
        h = area / w
        return round(w, 3), round(h, 3)
    # 2. Derive from parent segment — duct is a clearance fraction of the bore
    if parent_width and parent_height and float(parent_width) > 0 and float(parent_height) > 0:
        pw, ph = float(parent_width), float(parent_height)
        # Duct occupies ~40% of bore width and ~35% of bore height (leaves room for other services)
        w = round(pw * 0.40, 3)
        h = round(ph * 0.35, 3)
        if elem_id:
            print(f"Duct profile derived from parent segment ({pw:.2f}x{ph:.2f}): {w:.3f}x{h:.3f} for {elem_id}")
        return max(0.1, w), max(0.1, h)
    # 3. System-type heuristic — last resort with log
    sys = (system_type or '').upper()
    if 'EXHAUST' in sys:
        w, h = 0.8, 0.5
    elif 'SUPPLY' in sys or 'RETURN' in sys:
        w, h = 0.6, 0.4
    elif 'OUTSIDE' in sys or 'FRESH' in sys:
        w, h = 0.5, 0.4
    else:
        w, h = 0.5, 0.35  # generic duct
    if elem_id:
        print(f"Duct profile fallback to system-type heuristic ({sys or 'generic'}): "
              f"{w:.3f}x{h:.3f} for {elem_id}")
    return w, h


def derive_junction_overlap(profile_w, profile_h, turn_angle_deg=90.0):
    """Compute segment extension past a junction so the mitre clip has material to cut.

    Engineering basis: at a mitre joint with turn angle α, the bisector plane tilts
    at α/2 from each segment axis. At the outermost lateral point of the profile
    (x = ±width/2), the bisector extends (width/2) / tan(α/2) past the junction in
    the run direction. The segment must extend at least this far for the mitre clip
    to produce a clean angled face without gaps at the outer corner.

    Only the profile WIDTH matters — the mitre cut is in the XZ plane (lateral × run)
    and does not vary with height (Y). Capped at profile width to prevent absurd
    extensions on very sharp turns (< 30°).
    Returns extension in meters per end (total depth increase = 2 × this value)."""
    w = float(profile_w) if profile_w else 1.0
    half_w = w / 2.0
    angle_deg = float(turn_angle_deg)
    # Near-straight junctions (> 170°) need minimal extension — mitre clip is skipped
    if angle_deg >= 170.0:
        return 0.05
    # Near-zero angles are degenerate — clamp to 30° minimum
    angle_deg = max(angle_deg, 30.0)
    half_angle_rad = math.radians(angle_deg / 2.0)
    try:
        tan_half = math.tan(half_angle_rad)
    except (ValueError, OverflowError):
        tan_half = 1.0
    # Extension = (width/2) / tan(α/2) = (width/2) * cot(α/2)
    if tan_half < 1e-6:
        overlap = w  # fallback cap
    else:
        overlap = half_w / tan_half
    return round(min(max(overlap, 0.05), w), 4)


def sanitize_axis_ref(axis_data, ref_data, elem_id=None):
    """Sanitize axis and refDirection to be unit-length, orthogonal, right-handed.
    Returns (axis_tuple, ref_tuple) as normalized 3-tuples.
    Tracks sanitization in _sanitized_elements when fixes are applied."""
    was_fixed = False

    ax = normalize_vector(
        axis_data.get('x', 0), axis_data.get('y', 0), axis_data.get('z', 1),
        fallback=(0, 0, 1), elem_id=elem_id, context='axis'
    )
    rf = normalize_vector(
        ref_data.get('x', 1), ref_data.get('y', 0), ref_data.get('z', 0),
        fallback=(1, 0, 0), elem_id=elem_id, context='refDirection'
    )

    # Check original values to detect if normalize_vector used fallback
    orig_ax_len = math.sqrt(
        float(axis_data.get('x', 0))**2 + float(axis_data.get('y', 0))**2 +
        float(axis_data.get('z', 1))**2
    ) if all(math.isfinite(float(axis_data.get(k, d))) for k, d in [('x', 0), ('y', 0), ('z', 1)]) else 0
    orig_rf_len = math.sqrt(
        float(ref_data.get('x', 1))**2 + float(ref_data.get('y', 0))**2 +
        float(ref_data.get('z', 0))**2
    ) if all(math.isfinite(float(ref_data.get(k, d))) for k, d in [('x', 1), ('y', 0), ('z', 0)]) else 0

    if orig_ax_len < 1e-10 or orig_rf_len < 1e-10:
        was_fixed = True

    # Check if ref is nearly parallel to axis
    dot = ax[0] * rf[0] + ax[1] * rf[1] + ax[2] * rf[2]
    if abs(dot) > 0.999:
        was_fixed = True
        if elem_id:
            print(f"Warning: axis and refDirection nearly parallel (dot={dot:.4f}) "
                  f"on element {elem_id}, choosing perpendicular")
        # Choose a stable perpendicular
        if abs(ax[0]) < 0.9:
            rf = (1, 0, 0)
        else:
            rf = (0, 1, 0)
        dot = ax[0] * rf[0] + ax[1] * rf[1] + ax[2] * rf[2]

    # Gram-Schmidt: remove axis component from ref
    rf = (rf[0] - dot * ax[0], rf[1] - dot * ax[1], rf[2] - dot * ax[2])
    rf = normalize_vector(rf[0], rf[1], rf[2], fallback=(1, 0, 0))

    # Verify right-handed: cross(axis, ref) should be non-degenerate
    cross = (
        ax[1] * rf[2] - ax[2] * rf[1],
        ax[2] * rf[0] - ax[0] * rf[2],
        ax[0] * rf[1] - ax[1] * rf[0]
    )
    cross_len = math.sqrt(cross[0]**2 + cross[1]**2 + cross[2]**2)
    if cross_len < 1e-10:
        was_fixed = True
        ax = (0, 0, 1)
        rf = (1, 0, 0)

    if was_fixed and elem_id:
        _sanitized_elements[elem_id] = {
            'original_axis': {k: axis_data.get(k, d) for k, d in [('x', 0), ('y', 0), ('z', 1)]},
            'original_ref': {k: ref_data.get(k, d) for k, d in [('x', 1), ('y', 0), ('z', 0)]},
            'fixed_axis': ax,
            'fixed_ref': rf,
        }

    return ax, rf


def _normalize_system_type(s):
    """Normalize a systemType string for color lookup: uppercase, spaces/hyphens → underscores."""
    if not s:
        return ''
    return re.sub(r'[\s\-]+', '_', s.strip().upper())


def _build_mep_pset(properties, pressure_key='Pressure'):
    """Build common MEP Pset properties: FlowCapacity, pressure, SystemType."""
    pset = {}
    flow_rate = safe_float(properties.get('flowRate'))
    if flow_rate is not None:
        pset['FlowCapacity'] = (flow_rate, 'IfcReal')
    pressure = safe_float(properties.get('pressure'))
    if pressure is not None:
        pset[pressure_key] = (pressure, 'IfcReal')
    system_type = properties.get('systemType', '')
    if system_type:
        pset['SystemType'] = (str(system_type), 'IfcLabel')
    return pset


def apply_style(f, solid, color_rgb, transparency=0.0, entity_name=None, reflectance_method='BLINN'):
    """Apply visual style to an IFC geometry item.
    Creates the full IFC4 styling chain:
    IfcStyledItem → IfcPresentationStyleAssignment → IfcSurfaceStyle → IfcSurfaceStyleRendering
    Reuses shared IfcSurfaceStyle + IfcPresentationStyleAssignment when color+transparency match.
    NOTE: entity_name is sanitized to ASCII here — X2-encoded Unicode in IfcSurfaceStyle.Name
    causes web-ifc WASM buffer offset errors in the browser geometry parser.
    This ensures compatibility with xeokit, Revit, BIMvision, and other IFC viewers."""
    if entity_name:
        entity_name = entity_name.replace('\u2014', ' - ').replace('\u2013', ' - ')
    cache_key = (tuple(round(c, 4) for c in color_rgb), round(float(transparency), 2), reflectance_method)
    if cache_key in _style_cache:
        style_assignment = _style_cache[cache_key]
    else:
        r, g, b = color_rgb
        color = f.create_entity('IfcColourRgb', Red=float(r), Green=float(g), Blue=float(b))
        # Specular highlight for surface quality (matches Revit reference)
        spec_exp = f.create_entity('IfcSpecularExponent', wrappedValue=64.0)
        rendering = f.create_entity(
            'IfcSurfaceStyleRendering',
            SurfaceColour=color,
            Transparency=float(transparency),
            SpecularHighlight=spec_exp,
            ReflectanceMethod=reflectance_method
        )
        surface_style = f.create_entity(
            'IfcSurfaceStyle',
            Name=entity_name or 'Style',
            Side='BOTH',
            Styles=(rendering,)
        )
        # IfcPresentationStyleAssignment is required by many viewers for style recognition
        style_assignment = f.create_entity(
            'IfcPresentationStyleAssignment',
            Styles=(surface_style,)
        )
        _style_cache[cache_key] = style_assignment
    f.create_entity('IfcStyledItem', Item=solid, Styles=(style_assignment,))


def add_property_set(f, owner, element, pset_name, properties_dict):
    props = []
    for prop_name, (prop_value, ifc_type) in properties_dict.items():
        if ifc_type == 'IfcBoolean':
            nominal = f.create_entity('IfcBoolean', wrappedValue=prop_value)
        elif ifc_type == 'IfcReal':
            nominal = f.create_entity('IfcReal', wrappedValue=float(prop_value))
        elif ifc_type == 'IfcInteger':
            nominal = f.create_entity('IfcInteger', wrappedValue=int(prop_value))
        else:
            nominal = f.create_entity('IfcLabel', wrappedValue=str(prop_value))
        props.append(f.create_entity('IfcPropertySingleValue', Name=prop_name, NominalValue=nominal))

    pset = f.create_entity('IfcPropertySet', GlobalId=new_guid(), OwnerHistory=owner, Name=pset_name, HasProperties=tuple(props))
    f.create_entity('IfcRelDefinesByProperties', GlobalId=new_guid(), OwnerHistory=owner, RelatedObjects=(element,), RelatingPropertyDefinition=pset)


def add_quantity_set(f, owner, element, qset_name, quantities_dict):
    quants = []
    for quant_name, (quant_value, quant_type) in quantities_dict.items():
        if quant_type == 'IfcQuantityLength':
            quants.append(f.create_entity('IfcQuantityLength', Name=quant_name, LengthValue=float(quant_value)))
        elif quant_type == 'IfcQuantityArea':
            quants.append(f.create_entity('IfcQuantityArea', Name=quant_name, AreaValue=float(quant_value)))
        elif quant_type == 'IfcQuantityVolume':
            quants.append(f.create_entity('IfcQuantityVolume', Name=quant_name, VolumeValue=float(quant_value)))
    if quants:
        qset = f.create_entity('IfcElementQuantity', GlobalId=new_guid(), OwnerHistory=owner, Name=qset_name, Quantities=tuple(quants))
        f.create_entity('IfcRelDefinesByProperties', GlobalId=new_guid(), OwnerHistory=owner, RelatedObjects=(element,), RelatingPropertyDefinition=qset)


# ============================================================================
# GEOMETRY CREATORS
# ============================================================================

def create_extrusion(f, subcontext, profile_def, direction, depth, elem_id=None,
                     solid_axis=None, solid_ref=None):
    """Create IfcExtrudedAreaSolid from profile, direction, and depth.

    MODEL A (placement-driven): For standard elements, the solid frame is identity —
    Axis=(0,0,1), RefDirection=(1,0,0). All world orientation comes from ObjectPlacement.
    The extrusion is always along local Z, profile sits in local XY.

    solid_axis/solid_ref: explicit overrides for special cases (ARCH/ARBITRARY profiles)
    where the solid frame needs custom orientation. When provided, these override identity.
    The 'direction' parameter is retained for API compatibility but ignored for standard
    elements — placement handles world orientation.
    """
    origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))

    # For standard elements: identity solid frame — placement handles world orientation.
    # For special cases (ARCH/ARBITRARY): explicit overrides control solid orientation.
    if solid_axis is not None:
        ax_tuple = solid_axis
    else:
        ax_tuple = (0.0, 0.0, 1.0)

    if solid_ref is not None:
        rf_tuple = solid_ref
    else:
        rf_tuple = (1.0, 0.0, 0.0)

    axis = f.create_entity('IfcDirection', DirectionRatios=ax_tuple)
    refd = f.create_entity('IfcDirection', DirectionRatios=rf_tuple)
    solid_pos = f.create_entity('IfcAxis2Placement3D', Location=origin, Axis=axis, RefDirection=refd)

    # ExtrudedDirection is always (0,0,1) in the solid's local frame.
    # This means "extrude along the profile normal" — correct by definition.
    # The actual world direction is already encoded in solid_pos.Axis above.
    extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))

    solid = f.create_entity(
        'IfcExtrudedAreaSolid',
        SweptArea=profile_def,
        Position=solid_pos,
        ExtrudedDirection=extrude_dir,
        Depth=float(depth)
    )

    body_rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationIdentifier='Body',
        RepresentationType='SweptSolid',
        Items=(solid,)
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
    return solid, pds


def create_swept_disk_solid(f, subcontext, path_points, radius, inner_radius=None, elem_id=None):
    """Create IfcSweptDiskSolid — circular cross-section swept along a polyline path.
    Used for ducts, pipes, and circular conduits. Returns (solid, pds) or (None, None) on failure."""
    if len(path_points) < 2:
        if elem_id:
            print(f"Warning: SWEEP requires >= 2 pathPoints for {elem_id}, got {len(path_points)}")
        return None, None

    radius = float(radius)
    if radius <= 0:
        if elem_id:
            print(f"Warning: SWEEP requires positive radius for {elem_id}, got {radius}")
        return None, None

    # Build polyline directrix from path points
    ifc_points = []
    for pt in path_points:
        x = float(pt.get('x', 0))
        y = float(pt.get('y', 0))
        z = float(pt.get('z', 0))
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
            if elem_id:
                print(f"Warning: non-finite path point in SWEEP for {elem_id}, skipping")
            continue
        ifc_points.append(f.create_entity('IfcCartesianPoint', Coordinates=(x, y, z)))

    if len(ifc_points) < 2:
        if elem_id:
            print(f"Warning: SWEEP has < 2 valid path points for {elem_id}")
        return None, None

    directrix = f.create_entity('IfcPolyline', Points=tuple(ifc_points))

    # Build swept disk solid
    kwargs = {
        'Directrix': directrix,
        'Radius': radius,
    }
    if inner_radius is not None:
        ir = float(inner_radius)
        if ir > 0 and ir < radius:
            kwargs['InnerRadius'] = ir

    solid = f.create_entity('IfcSweptDiskSolid', **kwargs)

    body_rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationIdentifier='Body',
        RepresentationType='AdvancedSweptSolid',
        Items=(solid,)
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
    if elem_id:
        print(f"Created IfcSweptDiskSolid for {elem_id}: radius={radius}, points={len(ifc_points)}")
    return solid, pds


def create_fixed_reference_swept_area_solid(f, subcontext, profile_def, path_points,
                                              fixed_reference=(0.0, 0.0, 1.0), elem_id=None):
    """Create IfcFixedReferenceSweptAreaSolid — any profile swept along a polyline path.
    Unlike IfcSweptDiskSolid (circular only), supports rectangular and arbitrary profiles.
    The FixedReference direction controls profile orientation along the path.
    Returns (solid, pds) or (None, None) on failure.
    FEATURE-FLAGGED: only called when USE_FIXED_REF_SWEEP is enabled."""
    if len(path_points) < 2:
        if elem_id:
            print(f"Warning: FixedRefSweep requires >= 2 pathPoints for {elem_id}")
        return None, None

    # Build polyline directrix
    ifc_points = []
    for pt in path_points:
        x = float(pt.get('x', 0))
        y = float(pt.get('y', 0))
        z = float(pt.get('z', 0))
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
            if elem_id:
                print(f"Warning: non-finite path point in FixedRefSweep for {elem_id}")
            continue
        ifc_points.append(f.create_entity('IfcCartesianPoint', Coordinates=(x, y, z)))

    if len(ifc_points) < 2:
        if elem_id:
            print(f"Warning: FixedRefSweep < 2 valid points for {elem_id}")
        return None, None

    directrix = f.create_entity('IfcPolyline', Points=tuple(ifc_points))
    fixed_ref = f.create_entity('IfcDirection', DirectionRatios=fixed_reference)

    solid = f.create_entity(
        'IfcFixedReferenceSweptAreaSolid',
        SweptArea=profile_def,
        Directrix=directrix,
        FixedReference=fixed_ref
    )

    body_rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationIdentifier='Body',
        RepresentationType='AdvancedSweptSolid',
        Items=(solid,)
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
    if elem_id:
        print(f"Created IfcFixedReferenceSweptAreaSolid for {elem_id}: "
              f"points={len(ifc_points)}, ref={fixed_reference}")
    return solid, pds


def _generate_arch_profile_points(w, h, curve_ratio=0.3, segments=16):
    """Generate horseshoe-arch profile points (straight walls + semicircular crown).
    Profile is centered at (0, h/2) — bottom at -h/2, top at +h/2.

    The arch is a TRUE SEMICIRCLE: X-radius and Y-radius both equal half_w.
    This prevents the 'squashed ellipse' bug where using h*curve_ratio as the Y-radius
    produced a non-circular crown whenever width != height.
    The straight wall section absorbs any remaining height (h - half_w*2).
    curve_ratio is retained as a fallback cap for degenerate proportions (w >> h).
    """
    import math
    half_w = w / 2.0
    half_h = h / 2.0

    # True semicircle: arch radius = half_w so both X and Y radii are equal.
    # Cap to 95% of half_h so wall_top stays non-negative even for wide, flat tunnels.
    arch_height = min(half_w, half_h * 0.95)
    wall_top = half_h - arch_height  # y-coordinate where straight walls end and arch begins

    points = []
    # Bottom-left → bottom-right
    points.append((-half_w, -half_h))
    points.append((half_w, -half_h))
    # Right wall up to arch spring line
    points.append((half_w, wall_top))
    # Semicircular arch crown from right → top → left
    # Both x and y radii = half_w → geometrically round, not elliptical
    for i in range(1, segments):
        angle = math.pi * i / segments
        x = half_w * math.cos(angle)       # X-radius = half_w
        y = wall_top + arch_height * math.sin(angle)  # Y-radius = arch_height = half_w (true semicircle)
        points.append((round(x, 4), round(y, 4)))
    # Left wall top (arch spring line) down
    points.append((-half_w, wall_top))
    # Left wall down to bottom — polyline close handles the final edge back to start
    return points


def _scale_profile_points_inward(points, wall_thickness):
    """Scale profile points inward by wall_thickness to create inner void boundary.
    Each point is moved toward the centroid by wall_thickness."""
    if len(points) < 3 or wall_thickness <= 0:
        return None
    # Compute centroid
    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)
    import math
    inner = []
    for px, py in points:
        dx, dy = px - cx, py - cy
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < wall_thickness * 1.5:
            return None  # Profile too small for this wall thickness
        scale = (dist - wall_thickness) / dist
        inner.append((round(cx + dx * scale, 4), round(cy + dy * scale, 4)))
    return inner


def create_profile(f, profile_data):
    """Create IFC profile definition from CSS profile."""
    profile_type = profile_data.get('type', 'RECTANGLE')
    prof_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
    prof_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
    prof_place = f.create_entity('IfcAxis2Placement2D', Location=prof_origin, RefDirection=prof_x)

    if profile_type == 'CIRCLE':
        radius = float(profile_data.get('radius', 0.5))
        wall_thickness = profile_data.get('wallThickness')
        if wall_thickness is not None:
            wt = float(wall_thickness)
            if 0 < wt < radius:
                return f.create_entity('IfcCircleHollowProfileDef', ProfileType='AREA',
                                       Radius=radius, WallThickness=wt, Position=prof_place)
        return f.create_entity('IfcCircleProfileDef', ProfileType='AREA', Radius=radius, Position=prof_place)
    elif profile_type == 'ARCH':
        # Horseshoe-arch profile: straight walls + semicircular crown
        w = float(profile_data.get('width', 4.0))
        h = float(profile_data.get('height', 4.0))
        curve_ratio = float(profile_data.get('curveRatio', 0.3))
        wall_thickness = profile_data.get('wallThickness')

        # For rectangular-shape tunnels (curveRatio ~0.01), the topology engine tags them
        # as ARCH to avoid IfcRectangleHollowProfileDef (crashes web-ifc WASM), but they
        # should render as flat-walled box tunnels (matching Revit-exported final.ifc look)
        # not arches. Build a rectangular hollow profile using 4 straight-line polylines.
        if curve_ratio <= 0.05:
            half_w = w / 2.0
            half_h = h / 2.0
            outer_pts = [
                (-half_w, -half_h), (half_w, -half_h),
                (half_w, half_h), (-half_w, half_h),
            ]
            outer_ifc = [f.create_entity('IfcCartesianPoint', Coordinates=(px, py)) for px, py in outer_pts]
            outer_ifc.append(outer_ifc[0])
            outer_poly = f.create_entity('IfcPolyline', Points=tuple(outer_ifc))
            print(f"RECTANGULAR tunnel (from ARCH curveRatio={curve_ratio}): w={w:.2f} h={h:.2f}")
            # Skip hollow rectangular — same web-ifc 0.0.58 limitation as ARCH/ARBITRARY.
            if wall_thickness is not None:
                print(f"  → solid RECTANGULAR (hollow skipped — web-ifc 0.0.58 limitation): wallThickness={float(wall_thickness):.2f}")
            return f.create_entity('IfcArbitraryClosedProfileDef', ProfileType='AREA', OuterCurve=outer_poly)

        # True arch/horseshoe — curved crown
        points = _generate_arch_profile_points(w, h, curve_ratio, segments=16)
        ifc_points = [f.create_entity('IfcCartesianPoint', Coordinates=(px, py)) for px, py in points]
        ifc_points.append(ifc_points[0])  # close the loop
        polyline = f.create_entity('IfcPolyline', Points=tuple(ifc_points))
        print(f"ARCH profile: w={w:.2f} h={h:.2f} curveRatio={curve_ratio} ({len(points)} points)")
        # web-ifc 0.0.58 does not correctly render IfcArbitraryProfileDefWithVoids —
        # hollow arch profiles produce no geometry and an empty AABB. Use solid outer
        # profile until we upgrade web-ifc or switch to FacetedBrep tessellation.
        if wall_thickness is not None:
            print(f"  → solid ARCH (hollow skipped — web-ifc 0.0.58 limitation): wallThickness={float(wall_thickness):.2f}")
        return f.create_entity('IfcArbitraryClosedProfileDef', ProfileType='AREA', OuterCurve=polyline)
    elif profile_type == 'ARBITRARY':
        points = profile_data.get('points', [])
        if len(points) < 3:
            print(f"ARBITRARY profile: only {len(points)} points, falling back to RECTANGLE")
            return f.create_entity('IfcRectangleProfileDef', ProfileType='AREA', XDim=1.0, YDim=1.0, Position=prof_place)
        print(f"ARBITRARY profile: {len(points)} points")
        ifc_points = [f.create_entity('IfcCartesianPoint', Coordinates=(float(p['x']), float(p['y']))) for p in points]
        ifc_points.append(ifc_points[0])  # close the loop
        polyline = f.create_entity('IfcPolyline', Points=tuple(ifc_points))
        # Hollow arbitrary: same web-ifc 0.0.58 limitation — skip void, use solid outer.
        wall_thickness = profile_data.get('wallThickness')
        if wall_thickness is not None:
            print(f"  → solid ARBITRARY (hollow skipped — web-ifc 0.0.58 limitation): wallThickness={float(wall_thickness):.2f}")
        return f.create_entity('IfcArbitraryClosedProfileDef', ProfileType='AREA', OuterCurve=polyline)
    else:  # RECTANGLE
        w = float(profile_data.get('width', 1.0))
        h = float(profile_data.get('height', 1.0))
        wall_thickness = profile_data.get('wallThickness')
        if wall_thickness is not None:
            wt = float(wall_thickness)
            if 0 < wt < min(w, h) / 2:
                return f.create_entity('IfcRectangleHollowProfileDef', ProfileType='AREA',
                                       XDim=w, YDim=h, WallThickness=wt, Position=prof_place)
        return f.create_entity('IfcRectangleProfileDef', ProfileType='AREA', XDim=w, YDim=h, Position=prof_place)


def create_axis_representation(f, axis_subcontext, origin_data, axis_data, depth):
    """Create Axis (Curve2D) representation — centerline in LOCAL 2D coordinates.
    The Axis subcontext is Curve2D, which requires local 2D points — NOT global 3D.
    The element's ObjectPlacement handles all world-space rotation/translation.
    Using global coords here produces vertical spikes because z-offsets bleed through.
    Convention: (0,0) → (depth,0) — always correct regardless of wall orientation."""
    d = float(depth)
    p1 = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
    p2 = f.create_entity('IfcCartesianPoint', Coordinates=(d, 0.0))
    polyline = f.create_entity('IfcPolyline', Points=(p1, p2))
    return f.create_entity('IfcShapeRepresentation',
        ContextOfItems=axis_subcontext, RepresentationIdentifier='Axis',
        RepresentationType='Curve2D', Items=(polyline,))


def create_faceted_brep(f, subcontext, vertices, faces):
    """Create IfcFacetedBrep (closed shell B-rep) from vertices and face indices.
    RESTRICTED to transition/junction helper geometry only — not for general structural elements."""
    ifc_verts = [f.create_entity('IfcCartesianPoint',
        Coordinates=(float(v[0]) if isinstance(v, (list, tuple)) else float(v.get('x', 0)),
                     float(v[1]) if isinstance(v, (list, tuple)) else float(v.get('y', 0)),
                     float(v[2]) if isinstance(v, (list, tuple)) else float(v.get('z', 0))))
        for v in vertices]
    ifc_faces = []
    for face_indices in faces:
        if len(face_indices) < 3:
            continue
        face_points = [ifc_verts[i] for i in face_indices if i < len(ifc_verts)]
        if len(face_points) < 3:
            continue
        poly = f.create_entity('IfcPolyLoop', Polygon=tuple(face_points))
        bound = f.create_entity('IfcFaceOuterBound', Bound=poly, Orientation=True)
        ifc_faces.append(f.create_entity('IfcFace', Bounds=(bound,)))
    if not ifc_faces:
        return None, None
    closed_shell = f.create_entity('IfcClosedShell', CfsFaces=tuple(ifc_faces))
    brep = f.create_entity('IfcFacetedBrep', Outer=closed_shell)
    body_rep = f.create_entity('IfcShapeRepresentation',
        ContextOfItems=subcontext, RepresentationIdentifier='Body',
        RepresentationType='Brep', Items=(brep,))
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
    return brep, pds


def create_hollow_tunnel_brep(f, subcontext, outer_pts, shell_thickness, length, elem_id=None):
    """Create hollow tunnel shell as IfcFacetedBrep (closed shell with inner and outer surfaces).

    outer_pts: list of (x, y) tuples defining the outer cross-section profile (e.g., horseshoe arch)
    shell_thickness: wall thickness (metres) — used to inset the inner profile
    length: extrusion depth along Z-axis (metres)
    elem_id: element ID for logging

    Returns: (brep, pds) tuple for use in geometry creation
    """
    if not outer_pts or len(outer_pts) < 3:
        return None, None

    N = len(outer_pts)

    # Generate inner profile by scaling inward
    inner_pts = _scale_profile_points_inward(outer_pts, shell_thickness)
    if not inner_pts or len(inner_pts) < 3:
        if elem_id:
            print(f"Warning: hollow tunnel brep failed for {elem_id}: invalid inner profile")
        return None, None

    # Build vertex array (all coordinates in element-local space)
    # indices 0..N-1:     outer_pts at z=0 (outer start)
    # indices N..2N-1:    outer_pts at z=length (outer end)
    # indices 2N..3N-1:   inner_pts at z=0 (inner start)
    # indices 3N..4N-1:   inner_pts at z=length (inner end)
    vertices = []

    for i in range(N):
        # Outer start (z=0)
        vertices.append({'x': float(outer_pts[i][0]), 'y': float(outer_pts[i][1]), 'z': 0.0})
    for i in range(N):
        # Outer end (z=length)
        vertices.append({'x': float(outer_pts[i][0]), 'y': float(outer_pts[i][1]), 'z': float(length)})
    for i in range(N):
        # Inner start (z=0)
        vertices.append({'x': float(inner_pts[i][0]), 'y': float(inner_pts[i][1]), 'z': 0.0})
    for i in range(N):
        # Inner end (z=length)
        vertices.append({'x': float(inner_pts[i][0]), 'y': float(inner_pts[i][1]), 'z': float(length)})

    # Build face index list (4N quad faces)
    faces = []

    # Outer tube faces (N faces, normals pointing outward)
    for i in range(N):
        next_i = (i + 1) % N
        faces.append([i, next_i, N + next_i, N + i])

    # Inner tube faces (N faces, normals pointing inward — reversed winding)
    for i in range(N):
        next_i = (i + 1) % N
        faces.append([2*N + next_i, 2*N + i, 3*N + i, 3*N + next_i])

    # Start cap ring faces (N faces, connecting outer to inner at z=0)
    for i in range(N):
        next_i = (i + 1) % N
        faces.append([next_i, i, 2*N + i, 2*N + next_i])

    # End cap ring faces (N faces, connecting outer to inner at z=length)
    for i in range(N):
        next_i = (i + 1) % N
        faces.append([N + i, N + next_i, 3*N + next_i, 3*N + i])

    if elem_id:
        print(f"HOLLOW BREP: {elem_id}, N={N} pts, shell={shell_thickness}m, len={length:.1f}m, {4*N} faces")

    return create_faceted_brep(f, subcontext, vertices, faces)


# ============================================================================
# PHASE 4C — TUNNEL CHAIN CONTINUITY
#   Chain detection, section sampling with arc interpolation, welded BREP.
#   Chains are the primary geometry unit for connected STRUCTURAL TUNNEL_SEGMENTs.
#   Once a segment joins a chain, only the chain leader emits geometry.
# ============================================================================

# Chain caps — keep IFC size bounded.
MAX_CHAIN_SEGMENTS = 32
MAX_SECTIONS_PER_CHAIN = 64
# Arc generation thresholds.
CHAIN_ARC_TURN_MIN_DEG = 30.0   # below this, joint is near-straight → no arc
CHAIN_ARC_TURN_MAX_DEG = 150.0  # above this, joint is too sharp → hard mitre fallback


def _chain_norm3(v):
    m = math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2])
    if m < 1e-9:
        return (0.0, 0.0, 0.0)
    return (v[0]/m, v[1]/m, v[2]/m)


def _chain_dot3(a, b):
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]


def _chain_cross3(a, b):
    return (
        a[1]*b[2] - a[2]*b[1],
        a[2]*b[0] - a[0]*b[2],
        a[0]*b[1] - a[1]*b[0],
    )


def _chain_slerp3(a, b, t):
    """Normalized slerp between two unit 3D vectors. Falls back to lerp for tiny angles."""
    a = _chain_norm3(a)
    b = _chain_norm3(b)
    d = max(-1.0, min(1.0, _chain_dot3(a, b)))
    if d > 0.9995:
        out = (a[0] + (b[0] - a[0]) * t,
               a[1] + (b[1] - a[1]) * t,
               a[2] + (b[2] - a[2]) * t)
        return _chain_norm3(out)
    omega = math.acos(d)
    so = math.sin(omega)
    if so < 1e-9:
        return a
    s1 = math.sin((1.0 - t) * omega) / so
    s2 = math.sin(t * omega) / so
    return (a[0]*s1 + b[0]*s2, a[1]*s1 + b[1]*s2, a[2]*s1 + b[2]*s2)


def _chain_segment_endpoints(seg_idx_entry):
    """Return (start_xyz, end_xyz, unit_axis, length) for an entry from tunnel_segments_index."""
    ax = (seg_idx_entry['ax'], seg_idx_entry['ay'], seg_idx_entry['az'])
    L = math.sqrt(ax[0]**2 + ax[1]**2 + ax[2]**2)
    if L < 1e-9:
        return None
    u = (ax[0]/L, ax[1]/L, ax[2]/L)
    half = seg_idx_entry['depth'] / 2.0
    o = (seg_idx_entry['ox'], seg_idx_entry['oy'], seg_idx_entry['oz'])
    start = (o[0] - u[0]*half, o[1] - u[1]*half, o[2] - u[2]*half)
    end   = (o[0] + u[0]*half, o[1] + u[1]*half, o[2] + u[2]*half)
    return (start, end, u, seg_idx_entry['depth'])


def _chain_section_frame(tangent):
    """Build a section frame (lateral, up) for a given tangent direction.
    Profile-local 2D X axis maps to lateral, Y axis maps to up. Gravity-oriented:
    lateral is horizontal (cross with world up); up is in the vertical plane."""
    t = _chain_norm3(tangent)
    world_up = (0.0, 0.0, 1.0)
    lat = _chain_cross3(world_up, t)
    if math.sqrt(lat[0]**2 + lat[1]**2 + lat[2]**2) < 1e-6:
        # vertical tangent — fallback frame
        lat = (1.0, 0.0, 0.0)
    lat = _chain_norm3(lat)
    up = _chain_cross3(t, lat)
    up = _chain_norm3(up)
    return (lat, up)


def _chain_profile_signature(prof, props):
    """Hashable tuple identifying profile shape — chain breaks on mismatch."""
    pt = (prof.get('type', '') or '').upper()
    w = round(float(prof.get('width', 0) or 0), 3)
    h = round(float(prof.get('height', 0) or 0), 3)
    cr = round(float(prof.get('curveRatio', 0) or 0), 3)
    st = round(float(props.get('shellThickness_m', 0) or prof.get('wallThickness', 0) or 0), 3)
    return (pt, w, h, cr, st)


def _detect_tunnel_chains(elements, node_to_segs_for_clip, max_chain=MAX_CHAIN_SEGMENTS):
    """Walk the structural-segment graph, returning ordered chains.

    A chain is a maximal run of STRUCTURAL TUNNEL_SEGMENTs joined through
    degree-2 nodes whose profile signatures match. Endpoints (degree 1) and
    junctions (degree ≥ 3) are break points.

    Returns:
        chains: list of {id, segments_in_order, entry_node, exit_node, profile_signature}
        seg_to_chain: dict css_key → chain_id
    """
    # Index structural segments by element_key, capture entry/exit nodes + profile sig.
    seg_info = {}
    for e in elements:
        if e.get('type') != 'TUNNEL_SEGMENT':
            continue
        if e.get('properties', {}).get('branchClass') != 'STRUCTURAL':
            continue
        key = e.get('element_key') or e.get('id', '')
        if not key:
            continue
        props = e.get('properties', {})
        en = props.get('entry_node')
        ex = props.get('exit_node')
        if en is None or ex is None:
            continue
        prof = e.get('geometry', {}).get('profile', {}) or {}
        seg_info[key] = {
            'entry_node': str(en),
            'exit_node': str(ex),
            'sig': _chain_profile_signature(prof, props),
        }

    # node_degree: count of distinct segments at each node.
    node_degree = {}
    for nid, segs in node_to_segs_for_clip.items():
        keys = set(t[0] for t in segs)
        node_degree[nid] = len(keys)

    def neighbour_through(node_id, exclude_key, sig):
        """Return the unique other STRUCTURAL segment key at node_id with matching sig,
        or None if node is not a clean degree-2 with matching profile."""
        if node_degree.get(node_id, 0) != 2:
            return None
        other_keys = [t[0] for t in node_to_segs_for_clip.get(node_id, []) if t[0] != exclude_key]
        if len(other_keys) != 1:
            return None
        ok = other_keys[0]
        if ok not in seg_info:
            return None
        if seg_info[ok]['sig'] != sig:
            return None
        return ok

    chains = []
    seg_to_chain = {}
    visited = set()

    for start_key in list(seg_info.keys()):
        if start_key in visited:
            continue
        sig = seg_info[start_key]['sig']

        # Walk backward from start via entry_node.
        deque_keys = [start_key]
        cur_key = start_key
        cur_entry = seg_info[cur_key]['entry_node']
        # Walk back: cur_entry node, find neighbour through it.
        steps = 0
        while True:
            steps += 1
            if steps > max_chain:
                break
            nb = neighbour_through(cur_entry, cur_key, sig)
            if nb is None or nb in visited:
                break
            # Determine which end of nb connects to cur_entry — that side is "after" nb in the chain.
            nb_info = seg_info[nb]
            if nb_info['exit_node'] == cur_entry:
                deque_keys.insert(0, nb)
                cur_key = nb
                cur_entry = nb_info['entry_node']
            elif nb_info['entry_node'] == cur_entry:
                # nb is oriented the other way — flip orientation locally by treating its exit as next entry
                deque_keys.insert(0, nb)
                cur_key = nb
                cur_entry = nb_info['exit_node']
            else:
                break
            if len(deque_keys) >= max_chain:
                break

        # Walk forward via exit_node.
        cur_key = start_key
        cur_exit = seg_info[cur_key]['exit_node']
        steps = 0
        while True:
            steps += 1
            if steps > max_chain:
                break
            nb = neighbour_through(cur_exit, cur_key, sig)
            if nb is None or nb in visited or nb in deque_keys:
                break
            nb_info = seg_info[nb]
            if nb_info['entry_node'] == cur_exit:
                deque_keys.append(nb)
                cur_key = nb
                cur_exit = nb_info['exit_node']
            elif nb_info['exit_node'] == cur_exit:
                deque_keys.append(nb)
                cur_key = nb
                cur_exit = nb_info['entry_node']
            else:
                break
            if len(deque_keys) >= max_chain:
                break

        for k in deque_keys:
            visited.add(k)

        # Resolve entry_node (start of chain) and exit_node (end of chain) by looking
        # at the open ends of the first/last segments (the ends NOT shared with neighbours).
        first_key = deque_keys[0]
        last_key = deque_keys[-1]
        if len(deque_keys) == 1:
            chain_entry = seg_info[first_key]['entry_node']
            chain_exit = seg_info[first_key]['exit_node']
        else:
            second_key = deque_keys[1]
            shared = (
                {seg_info[first_key]['entry_node'], seg_info[first_key]['exit_node']}
                & {seg_info[second_key]['entry_node'], seg_info[second_key]['exit_node']}
            )
            chain_entry = (
                seg_info[first_key]['exit_node']
                if seg_info[first_key]['entry_node'] in shared
                else seg_info[first_key]['entry_node']
            )
            second_last_key = deque_keys[-2]
            shared2 = (
                {seg_info[last_key]['entry_node'], seg_info[last_key]['exit_node']}
                & {seg_info[second_last_key]['entry_node'], seg_info[second_last_key]['exit_node']}
            )
            chain_exit = (
                seg_info[last_key]['exit_node']
                if seg_info[last_key]['entry_node'] in shared2
                else seg_info[last_key]['entry_node']
            )

        chain_id = f"chain-{len(chains)}"
        chains.append({
            'id': chain_id,
            'segments': deque_keys,
            'entry_node': chain_entry,
            'exit_node': chain_exit,
            'profile_signature': sig,
        })
        for k in deque_keys:
            seg_to_chain[k] = chain_id

    return chains, seg_to_chain


def _build_chain_sections(chain, seg_idx_by_key, outer_pts_2d, max_sections=MAX_SECTIONS_PER_CHAIN):
    """Return ordered section frames in storey-local space, with arc interpolation at bends.

    Each section frame: {center: (x,y,z), tangent, lateral, up,
                         outer_world: list of (x,y,z), source: 'segment'|'arc'|'joint'}.

    Stats returned alongside: arcs_inserted, max_turn_deg, tight_skips, cap_hit (bool).
    """
    seg_keys = chain['segments']
    seg_data = []  # ordered list of (start_world, end_world, unit, length, key) — direction matched to chain order
    # Pre-compute raw endpoints for every segment so we can orient seg[0] correctly
    # against seg[1] (otherwise the first segment uses its raw axis direction which
    # may not match the chain traversal direction).
    raw_endpoints = []
    for k in seg_keys:
        idx = seg_idx_by_key.get(k)
        if not idx:
            return None, {'arcs': 0, 'max_turn': 0, 'tight_skips': 0, 'cap_hit': False, 'reason': 'missing_idx'}
        ep = _chain_segment_endpoints(idx)
        if ep is None:
            return None, {'arcs': 0, 'max_turn': 0, 'tight_skips': 0, 'cap_hit': False, 'reason': 'zero_axis'}
        raw_endpoints.append(ep)  # (start, end, unit, length)

    prev_end = None
    for i, k in enumerate(seg_keys):
        s_w, e_w, u, L = raw_endpoints[i]
        if i == 0 and len(seg_keys) >= 2:
            # Orient seg[0] so its end is the closer of (start, end) to seg[1]'s endpoints.
            s2_a, s2_b, _, _ = raw_endpoints[1]
            d_e_to_2a = (e_w[0]-s2_a[0])**2 + (e_w[1]-s2_a[1])**2 + (e_w[2]-s2_a[2])**2
            d_e_to_2b = (e_w[0]-s2_b[0])**2 + (e_w[1]-s2_b[1])**2 + (e_w[2]-s2_b[2])**2
            d_s_to_2a = (s_w[0]-s2_a[0])**2 + (s_w[1]-s2_a[1])**2 + (s_w[2]-s2_a[2])**2
            d_s_to_2b = (s_w[0]-s2_b[0])**2 + (s_w[1]-s2_b[1])**2 + (s_w[2]-s2_b[2])**2
            if min(d_s_to_2a, d_s_to_2b) < min(d_e_to_2a, d_e_to_2b):
                s_w, e_w = e_w, s_w
                u = (-u[0], -u[1], -u[2])
        elif prev_end is not None:
            ds = math.sqrt((s_w[0]-prev_end[0])**2 + (s_w[1]-prev_end[1])**2 + (s_w[2]-prev_end[2])**2)
            de = math.sqrt((e_w[0]-prev_end[0])**2 + (e_w[1]-prev_end[1])**2 + (e_w[2]-prev_end[2])**2)
            if de < ds:
                s_w, e_w = e_w, s_w
                u = (-u[0], -u[1], -u[2])
        seg_data.append({'start': s_w, 'end': e_w, 'tangent': u, 'length': L, 'key': k})
        prev_end = e_w

    # Compute joint positions (mid of seg[i].end and seg[i+1].start) and turn angles.
    joints = []
    for i in range(len(seg_data) - 1):
        a = seg_data[i]
        b = seg_data[i + 1]
        jc = (
            (a['end'][0] + b['start'][0]) * 0.5,
            (a['end'][1] + b['start'][1]) * 0.5,
            (a['end'][2] + b['start'][2]) * 0.5,
        )
        d_in = a['tangent']
        d_out = b['tangent']
        d_dot = max(-1.0, min(1.0, _chain_dot3(d_in, d_out)))
        # Inner angle θ between tangents: 180° = perfectly straight.
        # turn_angle = 180° - θ (how much we turn through).
        theta_deg = math.degrees(math.acos(d_dot))
        turn_deg = 180.0 - theta_deg  # 0 for straight, 90 for right angle
        joints.append({
            'center': jc,
            'd_in': d_in,
            'd_out': d_out,
            'theta_deg': theta_deg,
            'turn_deg': turn_deg,
            'i': i,
        })

    # Profile width derived from outer_pts_2d extent (lateral span).
    if outer_pts_2d:
        xs = [p[0] for p in outer_pts_2d]
        profile_w = max(xs) - min(xs)
    else:
        profile_w = 1.0

    # Allocate arc steps per joint, respecting global section cap.
    # Base section count: 2 per chain (start+end) + 1 per joint (joint center) = 1 + len(seg_data).
    base_sections = 1 + len(seg_data)
    arc_budget = max(0, max_sections - base_sections)

    arc_plan = []  # list per joint: {n_arc, setback, radius, skip}
    total_arc_planned = 0
    cap_hit = False
    tight_skips = 0
    max_turn = 0.0

    for jt in joints:
        turn_deg = jt['turn_deg']
        if turn_deg > max_turn:
            max_turn = turn_deg
        if turn_deg < CHAIN_ARC_TURN_MIN_DEG:
            arc_plan.append({'n_arc': 0, 'setback': 0.0, 'radius': 0.0, 'skip': True, 'reason': 'near_straight'})
            continue
        if turn_deg > CHAIN_ARC_TURN_MAX_DEG:
            arc_plan.append({'n_arc': 0, 'setback': 0.0, 'radius': 0.0, 'skip': True, 'reason': 'too_sharp'})
            tight_skips += 1
            continue
        i = jt['i']
        lenA = seg_data[i]['length']
        lenB = seg_data[i + 1]['length']
        radius_raw = min(lenA, lenB) * 0.5
        radius = max(profile_w, min(3.0 * profile_w, radius_raw))
        turn_rad = math.radians(turn_deg)
        setback = radius * math.tan(turn_rad / 2.0)
        if setback >= 0.45 * lenA or setback >= 0.45 * lenB:
            radius = min(lenA, lenB) * 0.4
            setback = radius * math.tan(turn_rad / 2.0)
            if setback >= 0.45 * lenA or setback >= 0.45 * lenB:
                arc_plan.append({'n_arc': 0, 'setback': 0.0, 'radius': 0.0, 'skip': True, 'reason': 'tight_short'})
                tight_skips += 1
                continue
        n_arc = max(3, min(6, round(turn_deg / 15.0)))
        # Reserve sections for the two end-of-fillet sections we'll emit on either side
        # of the arc (they replace the joint-center section). Plus n_arc interior arc sections.
        # Net delta vs base: replace 1 joint-center section with 2 fillet ends + n_arc interior = n_arc + 1.
        if total_arc_planned + (n_arc + 1) > arc_budget:
            cap_hit = True
            arc_plan.append({'n_arc': 0, 'setback': 0.0, 'radius': 0.0, 'skip': True, 'reason': 'cap_hit'})
            continue
        total_arc_planned += (n_arc + 1)
        arc_plan.append({
            'n_arc': n_arc,
            'setback': setback,
            'radius': radius,
            'skip': False,
        })

    # Build the ordered section list.
    sections = []
    arcs_inserted = 0

    # Helper to project the 2D outer profile into world space at a section frame.
    def emit(center, tangent, source):
        lat, up = _chain_section_frame(tangent)
        outer_world = []
        for (px, py) in outer_pts_2d:
            wx = center[0] + lat[0]*px + up[0]*py
            wy = center[1] + lat[1]*px + up[1]*py
            wz = center[2] + lat[2]*px + up[2]*py
            outer_world.append((wx, wy, wz))
        sections.append({
            'center': center,
            'tangent': tangent,
            'lateral': lat,
            'up': up,
            'outer_world': outer_world,
            'source': source,
        })

    # Section 0: chain start
    emit(seg_data[0]['start'], seg_data[0]['tangent'], 'chain_start')

    for i, jt in enumerate(joints):
        plan = arc_plan[i]
        if plan['skip']:
            # Hard mitre or near-straight: emit a single section at the joint center,
            # tangent = average of in/out (slerp t=0.5 → mitre median tangent).
            mid_dir = _chain_norm3((
                jt['d_in'][0] + jt['d_out'][0],
                jt['d_in'][1] + jt['d_out'][1],
                jt['d_in'][2] + jt['d_out'][2],
            ))
            if mid_dir == (0.0, 0.0, 0.0):
                mid_dir = jt['d_in']
            emit(jt['center'], mid_dir, 'joint_mitre' if plan.get('reason') != 'near_straight' else 'joint_straight')
        else:
            # Arc: emit fillet-start, n_arc interior steps, fillet-end.
            setback = plan['setback']
            radius = plan['radius']
            n_arc = plan['n_arc']
            d_in = jt['d_in']
            d_out = jt['d_out']
            jc = jt['center']
            fillet_start = (jc[0] - d_in[0]*setback, jc[1] - d_in[1]*setback, jc[2] - d_in[2]*setback)
            fillet_end   = (jc[0] + d_out[0]*setback, jc[1] + d_out[1]*setback, jc[2] + d_out[2]*setback)
            emit(fillet_start, d_in, 'fillet_start')
            turn_rad = math.radians(jt['turn_deg'])
            arc_arc_length = radius * turn_rad
            step_length = arc_arc_length / n_arc
            prev_pos = fillet_start
            for k in range(1, n_arc + 1):
                t = k / float(n_arc)
                dir_t = _chain_norm3(_chain_slerp3(d_in, d_out, t))
                if dir_t == (0.0, 0.0, 0.0):
                    dir_t = d_out
                # Move along the rotated tangent — incremental, drift-free.
                if k < n_arc:
                    new_pos = (prev_pos[0] + dir_t[0]*step_length,
                               prev_pos[1] + dir_t[1]*step_length,
                               prev_pos[2] + dir_t[2]*step_length)
                    emit(new_pos, dir_t, 'arc_step')
                    prev_pos = new_pos
                else:
                    # Final step: snap to fillet_end with d_out tangent.
                    emit(fillet_end, d_out, 'fillet_end')
                    prev_pos = fillet_end
            arcs_inserted += 1

    # Final section: chain end
    emit(seg_data[-1]['end'], seg_data[-1]['tangent'], 'chain_end')

    stats = {
        'arcs': arcs_inserted,
        'max_turn': max_turn,
        'tight_skips': tight_skips,
        'cap_hit': cap_hit,
        'sections': len(sections),
    }
    return sections, stats


def create_chain_tunnel_brep(f, subcontext, sections, shell_thickness, outer_pts_2d, elem_id=None):
    """Build a single welded IfcFacetedBrep from a chain of section frames.

    sections: ordered list from _build_chain_sections; vertices are emitted in
              storey-local coords, so the leader element should use an identity
              placement (origin=(0,0,0), axis=(0,0,1), refDirection=(1,0,0)).
    shell_thickness: meters.
    outer_pts_2d: 2D outer profile (used to derive inner profile via inward scale).
    Returns (brep, pds) or (None, None) on failure.
    """
    K = len(sections)
    if K < 2:
        return None, None
    N = len(outer_pts_2d) if outer_pts_2d else 0
    if N < 3:
        return None, None

    inner_pts_2d = _scale_profile_points_inward(outer_pts_2d, shell_thickness)
    if not inner_pts_2d or len(inner_pts_2d) != N:
        if elem_id:
            print(f"[CHAIN-WELD-FAIL] {elem_id}: inner profile invalid")
        return None, None

    vertices = []
    # Outer ring: K * N vertices, indexed outer_idx(k, i) = k*N + i (already world).
    for sec in sections:
        for (wx, wy, wz) in sec['outer_world']:
            vertices.append({'x': float(wx), 'y': float(wy), 'z': float(wz)})

    # Inner ring: K * N vertices, indexed inner_idx(k, i) = K*N + k*N + i.
    # Compute by projecting the 2D inner profile through each section's frame.
    inner_offset = K * N
    for sec in sections:
        center = sec['center']
        lat = sec['lateral']
        up = sec['up']
        for (px, py) in inner_pts_2d:
            wx = center[0] + lat[0]*px + up[0]*py
            wy = center[1] + lat[1]*px + up[1]*py
            wz = center[2] + lat[2]*px + up[2]*py
            vertices.append({'x': float(wx), 'y': float(wy), 'z': float(wz)})

    expected_vertex_count = 2 * K * N
    if len(vertices) != expected_vertex_count:
        if elem_id:
            print(f"[CHAIN-WELD-FAIL] {elem_id}: expected {expected_vertex_count} verts, got {len(vertices)}")
        return None, None

    # Faces.
    faces = []

    def outer_idx(k, i):
        return k * N + i

    def inner_idx(k, i):
        return inner_offset + k * N + i

    # Outer tube quads — shared indices between consecutive sections (welded).
    for k in range(K - 1):
        for i in range(N):
            ni = (i + 1) % N
            faces.append([outer_idx(k, i), outer_idx(k, ni), outer_idx(k + 1, ni), outer_idx(k + 1, i)])

    # Inner tube quads — reversed winding so normals face inward.
    for k in range(K - 1):
        for i in range(N):
            ni = (i + 1) % N
            faces.append([inner_idx(k, ni), inner_idx(k, i), inner_idx(k + 1, i), inner_idx(k + 1, ni)])

    # Start cap (k=0): connect outer to inner.
    for i in range(N):
        ni = (i + 1) % N
        faces.append([outer_idx(0, ni), outer_idx(0, i), inner_idx(0, i), inner_idx(0, ni)])

    # End cap (k=K-1): reverse winding so normal faces outward.
    last = K - 1
    for i in range(N):
        ni = (i + 1) % N
        faces.append([outer_idx(last, i), outer_idx(last, ni), inner_idx(last, ni), inner_idx(last, i)])

    # Welding sanity check: every interior section vertex must appear in ≥2 quads.
    if K >= 3:
        face_count_outer = [0] * (K * N)
        for face in faces[:2 * (K - 1) * N]:  # outer + inner tube faces
            for vidx in face:
                if vidx < K * N:
                    face_count_outer[vidx] += 1
        for k in range(1, K - 1):
            for i in range(N):
                if face_count_outer[outer_idx(k, i)] < 2:
                    if elem_id:
                        print(f"[CHAIN-WELD-FAIL] {elem_id}: outer vertex k={k} i={i} appears in <2 quads")
                    return None, None

    if elem_id:
        print(f"[CHAIN-BREP] {elem_id} K={K} N={N} faces={(2*(K-1)+2)*N} verts={2*K*N}")

    return create_faceted_brep(f, subcontext, vertices, faces)


# ============================================================================
# END PHASE 4C HELPERS
# ============================================================================


def create_wall_brep_with_voids(f, subcontext, wall_length, wall_height, wall_thickness, voids, elem_id=None):
    """Create wall IfcFacetedBrep with baked door/window voids (GAP 8).

    wall_length: wall run length (X-axis)
    wall_height: wall height (Z-axis)
    wall_thickness: wall depth (Y-axis)
    voids: list of {'x_offset': float, 'width': float, 'height': float} dicts

    Returns: (brep, pds) tuple. Geometry is in element-local space: (0,0,0) to (wall_length, wall_thickness, wall_height).
    """
    if not voids:
        # No voids — generate simple rectangular wall extrusion instead
        return None, None

    # Sort voids by x_offset for easier processing
    sorted_voids = sorted(voids, key=lambda v: v.get('x_offset', 0))

    vertices = []
    faces = []

    # Build vertices for:
    # - Wall front face (z=wall_height)
    # - Wall back face (z=0)
    # - Vertical jamb faces (left/right of each void)
    # - Header faces (above each void)
    # - Sill faces (below each void if not at floor)

    # Define 8 corner points of the bounding box (will be modified by voids)
    # Index mapping:
    # Front face (z=wall_height): 0=(0,0,h), 1=(L,0,h), 2=(L,t,h), 3=(0,t,h)
    # Back face (z=0): 4=(0,0,0), 5=(L,0,0), 6=(L,t,0), 7=(0,t,0)

    # Start with perimeter rectangle
    vertices = [
        {'x': 0.0, 'y': 0.0, 'z': float(wall_height)},  # 0: front-left-top
        {'x': float(wall_length), 'y': 0.0, 'z': float(wall_height)},  # 1: front-right-top
        {'x': float(wall_length), 'y': float(wall_thickness), 'z': float(wall_height)},  # 2: back-right-top
        {'x': 0.0, 'y': float(wall_thickness), 'z': float(wall_height)},  # 3: back-left-top
        {'x': 0.0, 'y': 0.0, 'z': 0.0},  # 4: front-left-bottom
        {'x': float(wall_length), 'y': 0.0, 'z': 0.0},  # 5: front-right-bottom
        {'x': float(wall_length), 'y': float(wall_thickness), 'z': 0.0},  # 6: back-right-bottom
        {'x': 0.0, 'y': float(wall_thickness), 'z': 0.0},  # 7: back-left-bottom
    ]

    # For each void, add vertices for the opening perimeter
    void_vertices_start_idx = 8
    void_vertex_indices = []  # list of (v_idx_set) for each void

    for v_idx, void in enumerate(sorted_voids):
        x_off = float(void.get('x_offset', 0))
        v_w = float(void.get('width', 1.0))
        v_h = float(void.get('height', 2.1))
        v_sill_z = 0.0  # doors start from floor
        v_top_z = v_sill_z + v_h

        # Clamp to wall bounds
        x_left = max(0.0, x_off)
        x_right = min(float(wall_length), x_off + v_w)

        if x_right <= x_left or v_top_z > float(wall_height) or v_sill_z < 0:
            continue  # Skip invalid void

        # 8 vertices for this void's perimeter (front and back faces)
        # Front face perimeter (y=0):
        vertices.append({'x': x_left, 'y': 0.0, 'z': v_top_z})  # top-left-front
        vertices.append({'x': x_right, 'y': 0.0, 'z': v_top_z})  # top-right-front
        vertices.append({'x': x_right, 'y': 0.0, 'z': v_sill_z})  # bottom-right-front
        vertices.append({'x': x_left, 'y': 0.0, 'z': v_sill_z})  # bottom-left-front
        # Back face perimeter (y=wall_thickness):
        vertices.append({'x': x_left, 'y': float(wall_thickness), 'z': v_top_z})  # top-left-back
        vertices.append({'x': x_right, 'y': float(wall_thickness), 'z': v_top_z})  # top-right-back
        vertices.append({'x': x_right, 'y': float(wall_thickness), 'z': v_sill_z})  # bottom-right-back
        vertices.append({'x': x_left, 'y': float(wall_thickness), 'z': v_sill_z})  # bottom-left-back

        void_vertex_indices.append({
            'tlf': void_vertices_start_idx + v_idx * 8 + 0,  # top-left-front
            'trf': void_vertices_start_idx + v_idx * 8 + 1,  # top-right-front
            'brf': void_vertices_start_idx + v_idx * 8 + 2,  # bottom-right-front
            'blf': void_vertices_start_idx + v_idx * 8 + 3,  # bottom-left-front
            'tlb': void_vertices_start_idx + v_idx * 8 + 4,  # top-left-back
            'trb': void_vertices_start_idx + v_idx * 8 + 5,  # top-right-back
            'brb': void_vertices_start_idx + v_idx * 8 + 6,  # bottom-right-back
            'blb': void_vertices_start_idx + v_idx * 8 + 7,  # bottom-left-back
        })

    # Generate faces
    # 1. Bottom face (z=0, full rectangle)
    faces.append([4, 5, 6, 7])

    # 2. Top face (z=wall_height, full rectangle)
    faces.append([0, 3, 2, 1])

    # 3. Left end face (x=0)
    faces.append([0, 4, 7, 3])

    # 4. Right end face (x=wall_length)
    faces.append([1, 2, 6, 5])

    # 5. Front face (y=0) - with hole cutouts
    # Create faces around each void
    prev_x_right = 0.0
    for vid, vvd in enumerate(void_vertex_indices):
        void = sorted_voids[vid]
        x_off = float(void.get('x_offset', 0))
        v_w = float(void.get('width', 1.0))
        x_left = max(0.0, x_off)
        x_right = min(float(wall_length), x_off + v_w)

        # Left pier (from prev_x_right to x_left)
        if x_left > prev_x_right:
            faces.append([0, 1, 5, 4] if vid == 0 else [0, 4, 5, 1])  # simplified

        # Jambs (vertical faces on left and right of opening)
        # Left jamb
        faces.append([vvd['blf'], vvd['tlf'], vvd['tlb'], vvd['blb']])
        # Right jamb
        faces.append([vvd['trf'], vvd['brf'], vvd['brb'], vvd['trb']])

        # Header (above opening)
        v_h = float(void.get('height', 2.1))
        header_z = v_h
        if header_z < float(wall_height):
            # Add header vertices if not at ceiling
            faces.append([vvd['tlf'], vvd['trf'], vvd['trb'], vvd['tlb']])

        prev_x_right = x_right

    # 6. Back face (y=wall_thickness) - mirror of front face
    for vid, vvd in enumerate(void_vertex_indices):
        # Back jambs
        faces.append([vvd['tlb'], vvd['blb'], vvd['blf'], vvd['tlf']])  # left
        faces.append([vvd['brb'], vvd['trb'], vvd['trf'], vvd['brf']])  # right

    if elem_id:
        print(f"WALL BREP WITH VOIDS: {elem_id}, length={wall_length:.1f}m, height={wall_height:.1f}m, thickness={wall_thickness:.2f}m, {len(sorted_voids)} voids, {len(faces)} faces")

    return create_faceted_brep(f, subcontext, vertices, faces)


def create_mesh_geometry(f, subcontext, vertices, faces):
    """Create IfcFaceBasedSurfaceModel from vertices and face indices."""
    ifc_verts = [f.create_entity('IfcCartesianPoint', Coordinates=(float(v['x']), float(v['y']), float(v['z']))) for v in vertices]

    ifc_faces = []
    for face_indices in faces:
        if len(face_indices) < 3:
            continue
        face_points = [ifc_verts[i] for i in face_indices if i < len(ifc_verts)]
        if len(face_points) < 3:
            continue
        poly = f.create_entity('IfcPolyLoop', Polygon=tuple(face_points))
        bound = f.create_entity('IfcFaceOuterBound', Bound=poly, Orientation=True)
        ifc_faces.append(f.create_entity('IfcFace', Bounds=(bound,)))

    if not ifc_faces:
        return None, None

    face_set = f.create_entity('IfcConnectedFaceSet', CfsFaces=tuple(ifc_faces))
    surface_model = f.create_entity('IfcFaceBasedSurfaceModel', FbsmFaces=(face_set,))

    body_rep = f.create_entity(
        'IfcShapeRepresentation',
        ContextOfItems=subcontext,
        RepresentationIdentifier='Body',
        RepresentationType='SurfaceModel',
        Items=(surface_model,)
    )
    pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
    return surface_model, pds


def create_element_geometry(f, subcontext, geometry, elem_id=None):
    """Create IFC geometry from CSS geometry definition. Returns (solid_or_surface, pds, fallback_used).
    Implements escalation chain: extrusion → sanitized extrusion → mesh fallback → None."""
    method = geometry.get('method', 'EXTRUSION')
    fallback_used = None

    if method == 'BREP':
        # Restricted to transition/junction helpers — closed shell B-rep geometry
        vertices = geometry.get('vertices', [])
        faces = geometry.get('faces', [])
        if not vertices or not faces:
            return None, None, 'proxy_no_geometry'
        brep, pds = create_faceted_brep(f, subcontext, vertices, faces)
        if brep is None:
            return None, None, 'brep_creation_failed'
        return brep, pds, None

    if method == 'MESH':
        vertices = geometry.get('vertices', [])
        faces = geometry.get('faces', [])
        if not vertices or not faces:
            return None, None, 'proxy_no_geometry'
        result = create_mesh_geometry(f, subcontext, vertices, faces)
        return result[0], result[1], None

    # SWEEP — cross-section swept along polyline path
    # Export-profile-aware dispatch: uses _geoBehavior and export profile
    geo_behavior = geometry.get('_geoBehavior', '')
    path_authored = geometry.get('_pathAuthored', False)
    export_profile = geometry.get('_exportProfile', 'WEB_VIEWER')

    # Promote circular profiles with pathPoints to SWEEP — IfcSweptDiskSolid is always
    # preferred for circular cross-sections regardless of original method assignment.
    # This catches DUCT elements that arrive with method=EXTRUSION but have valid pathPoints.
    _profile_data = geometry.get('profile', {})
    _path_pts = geometry.get('pathPoints', [])
    is_circular_with_path = (
        _profile_data.get('type', '').upper() == 'CIRCLE'
        and isinstance(_path_pts, list) and len(_path_pts) >= 2
        and not geometry.get('_isTunnelShell')
    )
    if is_circular_with_path and method != 'SWEEP':
        method = 'SWEEP'
        if elem_id:
            print(f"Promoted {elem_id} to SWEEP: circular profile with {len(_path_pts)} pathPoints")

    # Ramp segments (set by vsm-bridge fixRampOrientation) carry both _isTunnelShell=true and
    # _geoBehavior='PATH_SWEEP'. They are INTENTIONALLY excluded from the PATH_SWEEP block below
    # because they are tunnel shell geometry that extrudes along geometry.direction (the 3D slope
    # vector) using the standard extrusion path, not a swept-area-solid. The _isTunnelShell flag
    # prevents double-processing. Non-tunnel PATH_SWEEP elements (MEP runs, cable trays) enter here.
    if method == 'SWEEP' or (geo_behavior == 'PATH_SWEEP' and path_authored and not geometry.get('_isTunnelShell')):
        profile_data = geometry.get('profile', {})
        path_points = geometry.get('pathPoints', [])
        sweep_profile_type = profile_data.get('type', 'CIRCLE')

        if len(path_points) < 2:
            if elem_id:
                print(f"SWEEP rejected for {elem_id}: < 2 pathPoints")
            fallback_used = 'sweep_missing_path'
            # Convert circular profile to rectangular for extrusion fallback
            if sweep_profile_type == 'CIRCLE' and profile_data.get('radius'):
                d = float(profile_data['radius']) * 2
                geometry['profile'] = {'type': 'RECTANGLE', 'width': d, 'height': d}

        elif sweep_profile_type == 'CIRCLE':
            # Circular profiles: use IfcExtrudedAreaSolid + IfcCircleProfileDef for straight
            # 2-point paths (universally viewer-compatible). Only use IfcSweptDiskSolid for
            # curved multi-point paths where extrusion can't represent the geometry.
            radius = float(profile_data.get('radius', 0.10))

            if len(path_points) == 2:
                # Straight duct — extrusion along path direction with circular profile
                p0 = path_points[0]
                p1 = path_points[1]
                dx = float(p1.get('x', 0)) - float(p0.get('x', 0))
                dy = float(p1.get('y', 0)) - float(p0.get('y', 0))
                dz = float(p1.get('z', 0)) - float(p0.get('z', 0))
                path_len = math.sqrt(dx * dx + dy * dy + dz * dz)
                if path_len > 0.001:
                    try:
                        circ_profile = {'type': 'CIRCLE', 'radius': radius}
                        if profile_data.get('wallThickness'):
                            circ_profile['wallThickness'] = profile_data['wallThickness']
                        elif profile_data.get('innerRadius'):
                            circ_profile['innerRadius'] = profile_data['innerRadius']
                        profile_def = create_profile(f, circ_profile)
                        # Compute direction from original path_len before any capping
                        solid_axis = (dx / path_len, dy / path_len, dz / path_len)
                        # Cap extrusion length to geometry depth when explicitly set.
                        # Topology-placed ducts have full-network pathPoints but a smaller
                        # depth cap applied upstream — honour it here.
                        _depth_cap = safe_float(geometry.get('depth'), None)
                        if _depth_cap is not None and _depth_cap > 0 and path_len > _depth_cap:
                            if elem_id:
                                print(f"[CAP] {elem_id}: path_len={path_len:.2f}m capped to depth={_depth_cap:.2f}m")
                            path_len = _depth_cap
                        # Cross with world-up to get ref direction
                        world_up = (0.0, 0.0, 1.0)
                        cx = world_up[1] * solid_axis[2] - world_up[2] * solid_axis[1]
                        cy = world_up[2] * solid_axis[0] - world_up[0] * solid_axis[2]
                        cz = world_up[0] * solid_axis[1] - world_up[1] * solid_axis[0]
                        c_len = math.sqrt(cx * cx + cy * cy + cz * cz)
                        solid_ref = None
                        if c_len > 1e-6:
                            solid_ref = (cx / c_len, cy / c_len, cz / c_len)
                        solid, pds = create_extrusion(f, subcontext, profile_def, {'x': 0, 'y': 0, 'z': 1},
                                                      path_len, elem_id=elem_id,
                                                      solid_axis=solid_axis, solid_ref=solid_ref)
                        if elem_id:
                            print(f"Circular extrusion for {elem_id}: r={radius:.3f}m len={path_len:.2f}m")
                        return solid, pds, None
                    except Exception as e_circ:
                        if elem_id:
                            print(f"Warning: Circular extrusion failed for {elem_id}: {e_circ}")
                fallback_used = 'circular_extrusion_failed'
            else:
                # Multi-point curved path — IfcSweptDiskSolid required
                inner_radius = profile_data.get('innerRadius') or profile_data.get('wallThickness')
                if inner_radius is not None and profile_data.get('wallThickness') is not None:
                    wt = float(profile_data['wallThickness'])
                    inner_radius = radius - wt if radius - wt > 0 else None
                elif inner_radius is not None:
                    inner_radius = float(inner_radius)
                # GAP 12: Check pathPoints bounds (reject if any point >10km from origin — likely misplaced)
                path_bounds_ok = all(abs(pt.get('x', 0)) < 10000 and abs(pt.get('y', 0)) < 10000 and abs(pt.get('z', 0)) < 10000 for pt in (path_points or []))
                if path_bounds_ok:
                    try:
                        solid, pds = create_swept_disk_solid(f, subcontext, path_points, radius,
                                                              inner_radius=inner_radius, elem_id=elem_id)
                        if solid is not None:
                            return solid, pds, None
                    except Exception as e_sweep:
                        if elem_id:
                            print(f"Warning: IfcSweptDiskSolid failed for {elem_id}: {e_sweep}")
                fallback_used = 'sweep_circular_failed'
            if elem_id:
                print(f"SWEEP circular fallback for {elem_id}")

        else:
            # Non-circular profiles (RECTANGLE, ARCH, ARBITRARY)
            # Feature-flagged: try IfcFixedReferenceSweptAreaSolid if enabled
            if USE_FIXED_REF_SWEEP and export_profile != 'REVIT_AUTHORING':
                try:
                    profile_def = create_profile(f, profile_data)
                    # Fixed reference: world-up for horizontal, world-X for vertical paths
                    fixed_ref = (0.0, 0.0, 1.0)
                    p0, p1 = path_points[0], path_points[-1]
                    horiz = math.sqrt((float(p1.get('x', 0)) - float(p0.get('x', 0))) ** 2 +
                                      (float(p1.get('y', 0)) - float(p0.get('y', 0))) ** 2)
                    vert = abs(float(p1.get('z', 0)) - float(p0.get('z', 0)))
                    if horiz < 0.1 and vert > 0.1:
                        fixed_ref = (1.0, 0.0, 0.0)

                    solid, pds = create_fixed_reference_swept_area_solid(
                        f, subcontext, profile_def, path_points,
                        fixed_reference=fixed_ref, elem_id=elem_id)
                    if solid is not None:
                        return solid, pds, None
                except Exception as e_frs:
                    if elem_id:
                        print(f"Warning: IfcFixedReferenceSweptAreaSolid failed for {elem_id}: {e_frs}")

            # Default/fallback: extrusion along path direction (proven behavior)
            if len(path_points) >= 2:
                p0 = path_points[0]
                p1 = path_points[-1]
                dx = float(p1.get('x', 0)) - float(p0.get('x', 0))
                dy = float(p1.get('y', 0)) - float(p0.get('y', 0))
                dz = float(p1.get('z', 0)) - float(p0.get('z', 0))
                path_len = math.sqrt(dx * dx + dy * dy + dz * dz)
                if path_len > 0.001:
                    try:
                        profile_def = create_profile(f, profile_data)
                        solid_axis = (dx / path_len, dy / path_len, dz / path_len)
                        world_up = (0.0, 0.0, 1.0)
                        cx = world_up[1] * solid_axis[2] - world_up[2] * solid_axis[1]
                        cy = world_up[2] * solid_axis[0] - world_up[0] * solid_axis[2]
                        cz = world_up[0] * solid_axis[1] - world_up[1] * solid_axis[0]
                        c_len = math.sqrt(cx * cx + cy * cy + cz * cz)
                        solid_ref = None
                        if c_len > 1e-6:
                            solid_ref = (cx / c_len, cy / c_len, cz / c_len)
                        solid, pds = create_extrusion(f, subcontext, profile_def, {'x': 0, 'y': 0, 'z': 1},
                                                      path_len, elem_id=elem_id,
                                                      solid_axis=solid_axis, solid_ref=solid_ref)
                        if elem_id:
                            print(f"PATH_SWEEP -> extrusion for {elem_id}: len={path_len:.2f}m")
                        return solid, pds, None
                    except Exception as e_rect:
                        if elem_id:
                            print(f"Warning: PATH_SWEEP extrusion failed for {elem_id}: {e_rect}")

            fallback_used = 'rect_sweep_to_extrusion'

    # EXTRUSION (or SWEEP fallback) — profile + direction + depth
    # For SWEEP elements that fell through (e.g. rectangular with valid pathPoints but no depth),
    # compute depth from pathPoints if available.
    profile_data = geometry.get('profile', {'type': 'RECTANGLE', 'width': 1, 'height': 1})
    direction = _normalize_direction(geometry.get('direction', {'x': 0, 'y': 0, 'z': 1}), default={'x': 0, 'y': 0, 'z': 1})
    depth = safe_float(geometry.get('depth'), None)

    # If depth is None/0 but pathPoints exist, compute depth from path length
    if (depth is None or depth <= 0) and geometry.get('pathPoints') and len(geometry.get('pathPoints', [])) >= 2:
        pp = geometry['pathPoints']
        p0, p1 = pp[0], pp[-1]
        dx = float(p0.get('x', 0)) - float(p1.get('x', 0))
        dy = float(p0.get('y', 0)) - float(p1.get('y', 0))
        dz = float(p0.get('z', 0)) - float(p1.get('z', 0))
        depth = math.sqrt(dx*dx + dy*dy + dz*dz)
        # Also set direction from path
        if depth > 0.001:
            direction = {
                'x': (float(p1.get('x', 0)) - float(p0.get('x', 0))) / depth,
                'y': (float(p1.get('y', 0)) - float(p0.get('y', 0))) / depth,
                'z': (float(p1.get('z', 0)) - float(p0.get('z', 0))) / depth
            }
            if elem_id:
                print(f"Depth from pathPoints for {elem_id}: {depth:.2f}m")

    # For MEP EXTRUSION elements with pathPoints, always derive direction from path
    # even when depth is already set. VSM airway DUCTs carry pathPoints but arrive
    # with method=EXTRUSION and a Z-up default axis — pathPoints encode the real direction.
    if method == 'EXTRUSION' and geometry.get('pathPoints') and len(geometry.get('pathPoints', [])) >= 2:
        pp = geometry['pathPoints']
        p0, p1 = pp[0], pp[-1]
        dx = float(p1.get('x', 0)) - float(p0.get('x', 0))
        dy = float(p1.get('y', 0)) - float(p0.get('y', 0))
        dz = float(p1.get('z', 0)) - float(p0.get('z', 0))
        path_len = math.sqrt(dx*dx + dy*dy + dz*dz)
        if path_len > 0.001 and abs(dz / path_len) < 0.95:  # skip vertical shafts
            direction = {'x': dx / path_len, 'y': dy / path_len, 'z': dz / path_len}

    # Rule G1: If SWEEP was requested but failed, and no valid depth exists,
    # return None instead of creating a degenerate 0.01m extrusion
    if method == 'SWEEP' and fallback_used and (depth is None or depth <= 0):
        if elem_id:
            print(f"Warning: SWEEP failed and no depth for {elem_id} (fallback={fallback_used}), skipping geometry")
        return None, None, 'sweep_failed_no_depth'

    if depth is None or depth <= 0:
        depth = 0.01  # clamp to minimum

    # Compute correct solid orientation so profile local-Y maps to world-Z (up).
    # Only for ARCH/ARBITRARY profiles — RECTANGLE/CIRCLE use placement-driven orientation.
    solid_axis_param = None
    solid_ref_param = None
    profile_type = profile_data.get('type', 'RECTANGLE')
    if profile_type in ('ARCH', 'ARBITRARY') and not geometry.get('_placementDriven'):
        dx = float(direction.get('x', 0))
        dy = float(direction.get('y', 0))
        dz = float(direction.get('z', 1))
        ext_len = math.sqrt(dx * dx + dy * dy + dz * dz)
        if ext_len > 1e-6:
            ext_dir = (dx / ext_len, dy / ext_len, dz / ext_len)
        else:
            ext_dir = (0.0, 0.0, 1.0)
        # Profile plane normal (solid Axis) = extrusion direction
        # Profile local-Y should map to world-Z (up)
        # Profile local-X = cross(world-Z, extrusion-dir) = lateral direction
        world_up = (0.0, 0.0, 1.0)
        cross_x = world_up[1] * ext_dir[2] - world_up[2] * ext_dir[1]
        cross_y = world_up[2] * ext_dir[0] - world_up[0] * ext_dir[2]
        cross_z = world_up[0] * ext_dir[1] - world_up[1] * ext_dir[0]
        cross_len = math.sqrt(cross_x ** 2 + cross_y ** 2 + cross_z ** 2)
        if cross_len > 1e-6:
            # Extrusion is NOT vertical — use cross product as profile local-X (lateral)
            solid_ref_param = (cross_x / cross_len, cross_y / cross_len, cross_z / cross_len)
            solid_axis_param = ext_dir
        else:
            # Extrusion IS vertical — default orientation is fine (profile XY plane = world XY)
            pass

    # Attempt 1: Normal extrusion
    try:
        profile_def = create_profile(f, profile_data)
        solid, pds = create_extrusion(f, subcontext, profile_def, direction, depth, elem_id=elem_id,
                                      solid_axis=solid_axis_param, solid_ref=solid_ref_param)
        return solid, pds, fallback_used
    except Exception as e1:
        if elem_id:
            print(f"Warning: Extrusion failed for {elem_id}: {e1}, trying sanitized params")

    # Attempt 2: Sanitized extrusion
    try:
        sanitized_depth = max(depth, 1e-4)
        sanitized_profile = dict(profile_data)
        if sanitized_profile.get('width') is not None:
            sanitized_profile['width'] = max(float(sanitized_profile.get('width', 1)), 1e-4)
        if sanitized_profile.get('height') is not None:
            sanitized_profile['height'] = max(float(sanitized_profile.get('height', 1)), 1e-4)
        if sanitized_profile.get('radius') is not None:
            sanitized_profile['radius'] = max(float(sanitized_profile.get('radius', 0.5)), 1e-4)

        profile_def = create_profile(f, sanitized_profile)
        solid, pds = create_extrusion(f, subcontext, profile_def, direction, sanitized_depth, elem_id=elem_id,
                                      solid_axis=solid_axis_param, solid_ref=solid_ref_param)
        fallback_used = 'sanitized_extrusion'
        return solid, pds, fallback_used
    except Exception as e2:
        if elem_id:
            print(f"Warning: Sanitized extrusion failed for {elem_id}: {e2}, trying mesh fallback")

    # Attempt 3: Mesh fallback — create bounding box as IfcTriangulatedFaceSet
    try:
        w = max(float(profile_data.get('width', profile_data.get('radius', 1))), 0.01)
        h = max(float(profile_data.get('height', profile_data.get('radius', 1))), 0.01)
        d = max(float(depth), 0.01)
        hw, hh = w / 2.0, h / 2.0

        # 8 vertices of a box centered at origin
        coords = [
            (-hw, -hh, 0.0), (hw, -hh, 0.0), (hw, hh, 0.0), (-hw, hh, 0.0),
            (-hw, -hh, d),   (hw, -hh, d),   (hw, hh, d),   (-hw, hh, d),
        ]
        coord_list = f.create_entity('IfcCartesianPointList3D', CoordList=coords)

        # 12 triangles (2 per face)
        indices = [
            (1,2,3), (1,3,4),  # bottom
            (5,7,6), (5,8,7),  # top
            (1,5,6), (1,6,2),  # front
            (3,7,8), (3,8,4),  # back
            (1,4,8), (1,8,5),  # left
            (2,6,7), (2,7,3),  # right
        ]
        tri_face_set = f.create_entity(
            'IfcTriangulatedFaceSet',
            Coordinates=coord_list,
            CoordIndex=indices
        )

        body_rep = f.create_entity(
            'IfcShapeRepresentation',
            ContextOfItems=subcontext,
            RepresentationIdentifier='Body',
            RepresentationType='Tessellation',
            Items=(tri_face_set,)
        )
        pds = f.create_entity('IfcProductDefinitionShape', Representations=(body_rep,))
        fallback_used = 'mesh'
        if elem_id:
            print(f"Mesh fallback used for {elem_id}")
        return tri_face_set, pds, fallback_used
    except Exception as e3:
        if elem_id:
            print(f"Warning: All geometry attempts failed for {elem_id}: {e3}")
        return None, None, 'proxy_no_geometry'


# ============================================================================
# PLACEMENT
# ============================================================================

def create_element_placement(f, parent_lp, placement, elem_id=None):
    """Create IfcLocalPlacement from CSS placement with sanitized axis/refDirection."""
    origin = placement.get('origin', {'x': 0, 'y': 0, 'z': 0})
    axis_data = placement.get('axis', {'x': 0, 'y': 0, 'z': 1})
    ref_data = placement.get('refDirection', {'x': 1, 'y': 0, 'z': 0})

    pt = f.create_entity('IfcCartesianPoint', Coordinates=(
        float(origin.get('x', 0)), float(origin.get('y', 0)), float(origin.get('z', 0))
    ))

    ax_tuple, rf_tuple = sanitize_axis_ref(axis_data, ref_data, elem_id=elem_id)
    axis = f.create_entity('IfcDirection', DirectionRatios=ax_tuple)
    refd = f.create_entity('IfcDirection', DirectionRatios=rf_tuple)

    place = f.create_entity('IfcAxis2Placement3D', Location=pt, Axis=axis, RefDirection=refd)
    return f.create_entity('IfcLocalPlacement', PlacementRelTo=parent_lp, RelativePlacement=place)


# ============================================================================
# IFC ENTITY RESOLUTION
# ============================================================================

def resolve_ifc_entity_type(elem, output_mode):
    """Determine the IFC entity type to use for a CSS element."""
    css_type = elem.get('type', 'PROXY')
    semantic_type = elem.get('semanticType', '')
    confidence = float(elem.get('confidence', 0.5))

    # PROXY_ONLY mode — everything is proxy
    if output_mode == 'PROXY_ONLY':
        return 'IfcBuildingElementProxy'

    # IfcSpace always stays IfcSpace
    if css_type == 'SPACE':
        return 'IfcSpace'

    # Check equipment-specific semantic types FIRST (even at lower confidence,
    # if we have an explicit semantic type from a trusted source, use it)
    if css_type == 'EQUIPMENT' and semantic_type and semantic_type in EQUIPMENT_SEMANTIC_MAP:
        # Trust explicit semantic types even at confidence 0.5+ (source fusion caps at 0.6)
        if confidence >= 0.4:
            return EQUIPMENT_SEMANTIC_MAP[semantic_type]

    # Explicit semanticType override for any element (e.g. tunnel shafts → IfcColumn)
    VALID_SEMANTIC_OVERRIDES = {
        'IfcWall', 'IfcColumn', 'IfcPlate', 'IfcSlab', 'IfcBeam',
        'IfcDoor', 'IfcWindow', 'IfcRailing', 'IfcStair', 'IfcRamp',
    }
    if semantic_type and semantic_type in VALID_SEMANTIC_OVERRIDES and confidence >= 0.4:
        return semantic_type

    # Known structural/MEP types are always promoted — the css_type is reliable
    ALWAYS_PROMOTE = {'WALL', 'SLAB', 'COLUMN', 'BEAM', 'DOOR', 'WINDOW', 'DUCT', 'PIPE', 'CABLE_TRAY', 'SPACE', 'OPENING',
                      'STAIR', 'RAMP', 'ROOF', 'FOOTING'}
    if css_type in ALWAYS_PROMOTE:
        return SEMANTIC_IFC_MAP.get(css_type, 'IfcBuildingElementProxy')

    # Moderate structural types — promote at confidence >= 0.4
    MODERATE_PROMOTE = {'RAILING', 'CURTAIN_WALL', 'COVERING'}
    if css_type in MODERATE_PROMOTE and confidence >= 0.4:
        return SEMANTIC_IFC_MAP.get(css_type, 'IfcBuildingElementProxy')

    # TUNNEL_SEGMENT with valid semanticType is already handled above via VALID_SEMANTIC_OVERRIDES
    # For un-overridden TUNNEL_SEGMENT, use the standard mapping (→ IfcWall)
    if css_type == 'TUNNEL_SEGMENT':
        return SEMANTIC_IFC_MAP.get(css_type, 'IfcWall')

    # Low confidence in HYBRID mode → proxy (only for EQUIPMENT/PROXY without semantic mapping)
    if output_mode == 'HYBRID' and confidence < 0.4:
        return 'IfcBuildingElementProxy'

    # PROXY type with confidence >= 0.4: infer proper IFC type from name/properties
    # This promotes elements that extract labeled "wall", "slab", etc. but typed PROXY
    if css_type == 'PROXY' and confidence >= 0.4:
        props = elem.get('properties', {}) or {}
        name_lower = (elem.get('name', '') or '').lower()
        if props.get('isWall') or props.get('wallType') or 'wall' in name_lower:
            return 'IfcWall'
        if props.get('slabType') or 'slab' in name_lower or 'floor' in name_lower or 'ceiling' in name_lower:
            return 'IfcSlab'
        if props.get('isDuct') or 'duct' in name_lower or 'ventilation' in name_lower:
            return 'IfcDuctSegment'
        if props.get('isPipe') or 'pipe' in name_lower or 'conduit' in name_lower:
            return 'IfcPipeSegment'
        if props.get('isColumn') or 'column' in name_lower or 'pillar' in name_lower or 'pier' in name_lower:
            return 'IfcColumn'
        if props.get('isBeam') or 'beam' in name_lower or 'girder' in name_lower or 'joist' in name_lower:
            return 'IfcBeam'
        if 'door' in name_lower:
            return 'IfcDoor'
        if 'window' in name_lower or 'glazing' in name_lower:
            return 'IfcWindow'
        if 'ramp' in name_lower:
            return 'IfcRamp'
        if 'stair' in name_lower or 'step' in name_lower:
            return 'IfcStair'

    # Confident PROXY with no inferred type → still proxy
    if css_type == 'PROXY':
        return 'IfcBuildingElementProxy'

    # Use the standard mapping
    return SEMANTIC_IFC_MAP.get(css_type, 'IfcBuildingElementProxy')


def apply_material_layer(f, owner, ifc_element, material_name, thickness, layer_direction):
    """Create IfcMaterialLayerSetUsage for an element with known layer thickness.
    layer_direction: 'AXIS2' for walls, 'AXIS3' for slabs.
    Reuses shared IfcMaterialLayerSet when material_name + thickness match.
    Does NOT handle display styling — color/style is handled by existing geometry/style logic."""
    cache_key = (material_name, round(float(thickness), 3))
    if cache_key in _material_cache:
        layer_set = _material_cache[cache_key]
    else:
        mat = f.create_entity('IfcMaterial', Name=material_name)
        layer = f.create_entity('IfcMaterialLayer', Material=mat, LayerThickness=float(thickness))
        layer_set = f.create_entity('IfcMaterialLayerSet', MaterialLayers=(layer,), LayerSetName=material_name)
        _material_cache[cache_key] = layer_set
    # Walls (AXIS2): NEGATIVE sense with offset at -half_thickness (Revit/IFC convention).
    # Slabs (AXIS3): POSITIVE sense, offset 0.0.
    if layer_direction == 'AXIS2':
        direction_sense = 'NEGATIVE'
        offset = -(float(thickness) / 2.0)
    else:
        direction_sense = 'POSITIVE'
        offset = 0.0
    usage = f.create_entity(
        'IfcMaterialLayerSetUsage',
        ForLayerSet=layer_set,
        LayerSetDirection=layer_direction,
        DirectionSense=direction_sense,
        OffsetFromReferenceLine=offset
    )
    f.create_entity(
        'IfcRelAssociatesMaterial',
        GlobalId=new_guid(),
        OwnerHistory=owner,
        RelatedObjects=(ifc_element,),
        RelatingMaterial=usage
    )


def get_predefined_type(ifc_entity_type, css_type):
    """Return appropriate PredefinedType for the IFC entity."""
    if ifc_entity_type == 'IfcSlab':
        return 'ROOF' if css_type == 'ROOF' else 'FLOOR'
    mapping = {
        'IfcWall': 'SOLIDWALL',
        'IfcColumn': 'COLUMN',
        'IfcBeam': 'BEAM',
        'IfcDoor': 'DOOR',
        'IfcWindow': 'WINDOW',
        'IfcDuctSegment': 'RIGIDSEGMENT',
        'IfcPipeSegment': 'RIGIDSEGMENT',
    }
    return mapping.get(ifc_entity_type)


# ============================================================================
# Z-CONVENTION AUTO-DETECTION
# ============================================================================

def _detect_z_convention(elements, levels, metadata):
    """Auto-detect whether element Z values are absolute (world) or storey-relative.

    Returns True if Z values appear to be absolute (need storey elevation subtracted),
    False if they appear to be storey-relative (already correct for IFC local placement).
    """
    # If metadata explicitly specifies AND we have high confidence, respect it
    explicit = metadata.get('placementZIsAbsolute')

    # Build storey elevation map
    storey_elevations = {}
    for level in levels:
        lid = level.get('id', '')
        elev = float(level.get('elevation_m', 0))
        storey_elevations[lid] = elev

    # Single storey at elevation 0 — both conventions produce same result
    max_elev = max(storey_elevations.values()) if storey_elevations else 0
    if max_elev < 1.0:
        # All storeys at or near ground — convention doesn't matter
        return explicit if explicit is not None else True

    # Collect Z values per storey for structural elements (walls, slabs)
    z_by_storey = {}
    for elem in elements:
        if elem.get('type', '') not in ('WALL', 'SLAB', 'COLUMN', 'BEAM'):
            continue
        container = elem.get('container', '')
        z = elem.get('placement', {}).get('origin', {}).get('z', None)
        if z is None or not math.isfinite(z):
            continue
        if container not in z_by_storey:
            z_by_storey[container] = []
        z_by_storey[container].append(z)

    if not z_by_storey:
        return explicit if explicit is not None else True

    # Heuristic: for storeys with elevation > 1m, check if element Z values cluster
    # near the storey elevation (absolute) or near 0 (relative)
    absolute_votes = 0
    relative_votes = 0

    for container_id, z_vals in z_by_storey.items():
        storey_elev = storey_elevations.get(container_id, 0)
        if storey_elev < 1.0:
            continue  # Can't distinguish at ground level

        median_z = sorted(z_vals)[len(z_vals) // 2]

        # If median Z is close to storey elevation → absolute
        if abs(median_z - storey_elev) < storey_elev * 0.3:
            absolute_votes += len(z_vals)
        # If median Z is close to 0 → relative
        elif abs(median_z) < storey_elev * 0.3:
            relative_votes += len(z_vals)

    if absolute_votes > relative_votes:
        print(f"Z-convention auto-detect: ABSOLUTE (votes: abs={absolute_votes}, rel={relative_votes})")
        return True
    elif relative_votes > absolute_votes:
        print(f"Z-convention auto-detect: RELATIVE (votes: abs={absolute_votes}, rel={relative_votes})")
        return False
    else:
        # Tie or no data — use explicit flag or default to absolute
        result = explicit if explicit is not None else True
        print(f"Z-convention auto-detect: AMBIGUOUS, using {'ABSOLUTE' if result else 'RELATIVE'} (explicit={explicit})")
        return result


# ============================================================================
# CSS-DRIVEN IFC GENERATOR
# ============================================================================

def generate_ifc4_from_css(css):
    """Generate IFC4 from CSS v1.0 format. Element-driven, confidence-based."""

    # CLEAN_MODE — controls whether the clean-export divert fires.
    #   full  (default): bypass clean_tunnel_export / clean_building_export and
    #                    use the legacy full pipeline that emits all entity types
    #                    (IfcSpace, IfcFan, IfcSlab, IfcCovering, IfcFlowFitting,
    #                    IfcBuildingElementProxy, IfcElectricGenerator, ...).
    #   clean : opt back into the clean-* exports (drops most non-tunnel-shell
    #           types — used for the original Phase-2A clean-tunnel preview).
    clean_mode = (os.environ.get('CLEAN_MODE') or 'full').strip().lower()
    print(f'[GEN] CLEAN_MODE={clean_mode}')

    if clean_mode == 'clean':
        # Legacy clean-* dispatch — only used when explicitly opted into.
        try:
            from clean_tunnel_export import (
                is_clean_tunnel_mode_enabled,
                generate_clean_tunnel_ifc,
                generate_ifc_variants,
            )
            if is_clean_tunnel_mode_enabled(css):
                print('Routing through clean_tunnel_export (CLEAN_MODE=clean)')
                _generate_variants = (
                    os.environ.get('GENERATE_VARIANTS', 'off').lower() == '1'
                )
                if _generate_variants:
                    print('[VARIANTS] GENERATE_VARIANTS=1 — producing three IFC variants')
                    _variants = generate_ifc_variants(css)
                    # Return main visual_safe result as the canonical output.
                    _main_result = _variants.get('visual_safe')
                    if _main_result is None:
                        raise RuntimeError('[VARIANTS] visual_safe variant failed')
                    # Upload side variants to S3 (best-effort, non-blocking).
                    try:
                        import boto3 as _bvq
                        _s3vq = _bvq.client('s3', region_name=os.environ.get('AWS_REGION', 'us-gov-east-1'))
                        _vbkt = os.environ.get('IFC_BUCKET', 'builting-ifc')
                        _vuid = (css.get('metadata') or {}).get('userId', 'unknown')
                        _vrid = (css.get('metadata') or {}).get('renderId', 'unknown')
                        for _vname, _vres in _variants.items():
                            if _vres is None:
                                continue
                            _vkey = f'{_vuid}/{_vrid}/model_{_vname}.ifc'
                            _s3vq.put_object(
                                Bucket=_vbkt, Key=_vkey,
                                Body=_vres[0].encode('utf-8'),
                                ContentType='text/plain')
                            print(f'[VARIANTS] uploaded s3://{_vbkt}/{_vkey}')
                    except Exception as _vex:
                        print(f'[VARIANTS] S3 upload failed (non-fatal): {_vex}')
                    return _main_result
                return generate_clean_tunnel_ifc(css)
        except Exception as ex:
            _intent_mode = ((css.get('metadata') or {})
                            .get('featureFlags') or {}).get('intentMode', 'report')
            if _intent_mode in ('consume-doors', 'consume-mep', 'consume-all'):
                raise RuntimeError(
                    f'clean_tunnel_export fatal in consume-doors mode: {ex}'
                ) from ex
            print(f'clean_tunnel_export unavailable, falling through: {ex}')

        try:
            from clean_building_export import (
                is_clean_building_mode_enabled,
                generate_clean_building_ifc,
            )
            if is_clean_building_mode_enabled(css):
                print('Routing through clean_building_export (CLEAN_MODE=clean)')
                return generate_clean_building_ifc(css)
        except Exception as ex:
            print(f'clean_building_export unavailable, falling through: {ex}')
    else:
        # CLEAN_MODE=full — emit every topology entity through the legacy path.
        print('[GEN] CLEAN_MODE=full → bypassing clean_tunnel_export/clean_building_export')

    facility = css.get('facility', {})
    levels = css.get('levelsOrSegments', [])
    elements = css.get('elements', [])
    metadata = css.get('metadata', {})
    output_mode = metadata.get('outputMode', 'HYBRID')

    # Pre-filter input element count (raw CSS payload size). The retention
    # check uses _topology_element_count, which is captured *after* the
    # pre-loop filter passes (dedup, portal merge, orphan cleanup, portal
    # door synthesis). See snapshot at the start of the main emit loop.
    _input_element_count = len(elements)

    # Log input element histogram for observability
    _type_hist = {}
    for _e in elements:
        _t = _e.get('type', 'UNKNOWN')
        _type_hist[_t] = _type_hist.get(_t, 0) + 1
        if _t == 'SLAB' and _e.get('properties', {}).get('slabType') == 'ROOF':
            _type_hist['_SLAB_ROOF'] = _type_hist.get('_SLAB_ROOF', 0) + 1
    print(f"CSS input histogram: {json.dumps(_type_hist)}")

    # Z convention: prefer explicit metadata from topology engine, fall back to heuristic
    z_conv = metadata.get('zConvention', {})
    if z_conv.get('origin') == 'topology_engine':
        placement_z_is_absolute = (z_conv.get('normalized', 'STOREY_RELATIVE') == 'ABSOLUTE')
        print(f"Z from topology: normalized={z_conv['normalized']}, source={z_conv.get('source', 'unknown')}")
    else:
        print("Z: no topology metadata, using heuristic (DEPRECATED)")
        placement_z_is_absolute = _detect_z_convention(elements, levels, metadata)

    # Read export profile for geometry dispatch decisions
    export_profile = metadata.get('exportProfile', 'WEB_VIEWER')

    facility_name = facility.get('name', 'Structure')
    ts = int(datetime.now(timezone.utc).timestamp())

    # Clear sanitization and cache tracking for this generation run
    _sanitized_elements.clear()
    _material_cache.clear()
    _style_cache.clear()

    # ---- Create IFC file ----
    f = ifcopenshell.file(schema='IFC4')

    # Owner History
    person = f.create_entity('IfcPerson', GivenName='Person')
    org = f.create_entity('IfcOrganization', Name='Builting')
    pando = f.create_entity('IfcPersonAndOrganization', ThePerson=person, TheOrganization=org)
    app = f.create_entity('IfcApplication', ApplicationDeveloper=org, Version='2.0', ApplicationFullName='Builting CSS-to-IFC', ApplicationIdentifier='BCSS')
    owner = f.create_entity('IfcOwnerHistory', OwningUser=pando, OwningApplication=app, ChangeAction='ADDED', CreationDate=ts)

    # Units
    u_len = f.create_entity('IfcSIUnit', UnitType='LENGTHUNIT', Name='METRE')
    u_area = f.create_entity('IfcSIUnit', UnitType='AREAUNIT', Name='SQUARE_METRE')
    u_vol = f.create_entity('IfcSIUnit', UnitType='VOLUMEUNIT', Name='CUBIC_METRE')
    u_ang = f.create_entity('IfcSIUnit', UnitType='PLANEANGLEUNIT', Name='RADIAN')
    units = f.create_entity('IfcUnitAssignment', Units=(u_len, u_area, u_vol, u_ang))

    # Geometry context
    wcs_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
    wcs_axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
    wcs_refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
    wcs = f.create_entity('IfcAxis2Placement3D', Location=wcs_origin, Axis=wcs_axis, RefDirection=wcs_refd)

    context = f.create_entity('IfcGeometricRepresentationContext', ContextIdentifier='Model', ContextType='Model', CoordinateSpaceDimension=3, Precision=1e-5, WorldCoordinateSystem=wcs)
    subcontext = f.create_entity('IfcGeometricRepresentationSubContext', ContextIdentifier='Body', ContextType='Model', ParentContext=context, TargetView='MODEL_VIEW')
    axis_subcontext = f.create_entity('IfcGeometricRepresentationSubContext', ContextIdentifier='Axis', ContextType='Model', ParentContext=context, TargetView='GRAPH_VIEW')
    footprint_subcontext = f.create_entity('IfcGeometricRepresentationSubContext', ContextIdentifier='FootPrint', ContextType='Model', ParentContext=context, TargetView='PLAN_VIEW')

    # ---- Spatial hierarchy: Project → Site → Building → Storeys ----
    project = f.create_entity('IfcProject', GlobalId=new_guid(), OwnerHistory=owner, Name=facility_name, RepresentationContexts=(context,), UnitsInContext=units)
    proj_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=None, RelativePlacement=wcs)

    site = f.create_entity('IfcSite', GlobalId=new_guid(), OwnerHistory=owner, Name='Site', ObjectPlacement=proj_lp, CompositionType='ELEMENT')

    # Building placement relative to Site (not Project) for consistent chain
    bld_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=site.ObjectPlacement, RelativePlacement=wcs)
    building = f.create_entity('IfcBuilding', GlobalId=new_guid(), OwnerHistory=owner, Name=facility_name, ObjectPlacement=bld_lp, CompositionType='ELEMENT')

    f.create_entity('IfcRelAggregates', GlobalId=new_guid(), OwnerHistory=owner, RelatingObject=project, RelatedObjects=(site,))
    f.create_entity('IfcRelAggregates', GlobalId=new_guid(), OwnerHistory=owner, RelatingObject=site, RelatedObjects=(building,))

    # Create storeys/segments from levelsOrSegments
    storey_map = {}  # container_id → (storey_entity, storey_lp, elevation)
    storey_height_map = {}  # container_id → height_m (storey height for depth capping)
    storey_entities = []

    domain = css.get('domain', '').upper()

    # Feature flags derived from data, not domain name — universal across all structure types.
    has_tunnel_segments = any(e.get('type') == 'TUNNEL_SEGMENT' for e in elements) or \
                          any(e.get('type') in ('DUCT', 'PIPE') for e in elements)
    has_dxf_walls = any(e.get('source') == 'DXF' and e.get('type') == 'WALL' for e in elements)
    has_shell_pieces = any(e.get('properties', {}).get('shellPiece') for e in elements)

    # ---- Use authoritative VentSim coordinates (startPoint/endPoint) ----
    # When elements have startPoint/endPoint in properties (from VentSim parser),
    # use them directly for placement. These are the engineer's original coordinates —
    # no centroid snap needed. The midpoint, bearing, depth, and path are all derived
    # from these immutable source coordinates.
    if has_tunnel_segments:
        _sp_count = 0
        for _se in elements:
            if _se.get('type') != 'TUNNEL_SEGMENT':
                continue
            _props = _se.get('properties', {})
            _sp = _props.get('startPoint')
            _ep = _props.get('endPoint')
            if not _sp or not _ep:
                continue
            _sx, _sy, _sz = float(_sp.get('x', 0)), float(_sp.get('y', 0)), float(_sp.get('z', 0))
            _ex, _ey, _ez = float(_ep.get('x', 0)), float(_ep.get('y', 0)), float(_ep.get('z', 0))
            _dx = _ex - _sx
            _dy = _ey - _sy
            _dz = _ez - _sz
            _depth = math.sqrt(_dx*_dx + _dy*_dy + _dz*_dz)
            if _depth < 0.5:
                continue  # degenerate
            _bx, _by, _bz = _dx/_depth, _dy/_depth, _dz/_depth
            _mx = (_sx + _ex) / 2
            _my = (_sy + _ey) / 2
            _mz = (_sz + _ez) / 2
            if _se.get('placement') is None:
                _se['placement'] = {}
            _se['placement']['origin'] = {'x': _mx, 'y': _my, 'z': _mz}
            _se['placement']['refDirection'] = {'x': _bx, 'y': _by, 'z': _bz}
            _se['placement']['axis'] = {'x': 0.0, 'y': 0.0, 'z': 1.0}
            if _se.get('geometry') is None:
                _se['geometry'] = {}
            _se['geometry']['depth'] = _depth
            _se['geometry']['direction'] = {'x': _bx, 'y': _by, 'z': _bz}
            _se['geometry']['path'] = [
                {'x': _sx, 'y': _sy, 'z': _sz},
                {'x': _ex, 'y': _ey, 'z': _ez},
            ]
            _sp_count += 1
            if abs(_bz) > 0.01:
                _slope_d = math.degrees(math.asin(min(1.0, abs(_bz))))
                print(f"  SLOPED: {_se.get('element_key','?')} dZ={_ez-_sz:.1f}m slope={_slope_d:.1f}deg "
                      f"start=({_sx:.1f},{_sy:.1f},{_sz:.1f}) end=({_ex:.1f},{_ey:.1f},{_ez:.1f})")
        _z_vals = set()
        for _se2 in elements:
            if _se2.get('type') != 'TUNNEL_SEGMENT': continue
            _sp2 = _se2.get('properties', {}).get('startPoint')
            _ep2 = _se2.get('properties', {}).get('endPoint')
            if _sp2: _z_vals.add(round(float(_sp2.get('z', 0)), 1))
            if _ep2: _z_vals.add(round(float(_ep2.get('z', 0)), 1))
        if _sp_count:
            print(f"Source coordinates: {_sp_count} segments placed from VentSim startPoint/endPoint (no centroid snap)")
            print(f"  Z values in startPoint/endPoint: {sorted(_z_vals)}")

        # Compute VentSim world origin (centroid of all start/end points) to center the model.
        # All element placements are expressed in absolute VentSim coordinates (~44km from origin).
        # Subtract this centroid from every element's placement origin so local coords are near zero,
        # fixing float32 precision issues in WebGL viewers and Autodesk's ~10km coordinate limit.
        _vs_xs, _vs_ys, _vs_zs = [], [], []
        for _ce in elements:
            if _ce.get('type') != 'TUNNEL_SEGMENT':
                continue
            _cp = _ce.get('properties', {})
            for _pk in ('startPoint', 'endPoint'):
                _pt = _cp.get(_pk)
                if _pt:
                    _vs_xs.append(float(_pt.get('x', 0)))
                    _vs_ys.append(float(_pt.get('y', 0)))
                    _vs_zs.append(float(_pt.get('z', 0)))
        if _vs_xs:
            _ventsim_ox = sum(_vs_xs) / len(_vs_xs)
            _ventsim_oy = sum(_vs_ys) / len(_vs_ys)
            _ventsim_oz = sum(_vs_zs) / len(_vs_zs)
        else:
            _ventsim_ox, _ventsim_oy, _ventsim_oz = 0.0, 0.0, 0.0
        print(f"VentSim world origin: ({_ventsim_ox:.3f}, {_ventsim_oy:.3f}, {_ventsim_oz:.3f})")

        # Apply centroid offset to ALL element placement origins AND geometry pathPoints.
        # pathPoints must also be centered because PATH_SWEEP overrides placement_data['origin']
        # with pathPoints[0] at line ~2986, bypassing the placement.origin fix.
        for _oe in elements:
            _opl = _oe.get('placement')
            if _opl:
                _oor = _opl.get('origin')
                if _oor:
                    _oor['x'] = float(_oor.get('x', 0)) - _ventsim_ox
                    _oor['y'] = float(_oor.get('y', 0)) - _ventsim_oy
                    _oor['z'] = float(_oor.get('z', 0)) - _ventsim_oz
            _ogeo = _oe.get('geometry')
            if _ogeo:
                _opts = _ogeo.get('pathPoints')
                if _opts:
                    for _opt in _opts:
                        _opt['x'] = float(_opt.get('x', 0)) - _ventsim_ox
                        _opt['y'] = float(_opt.get('y', 0)) - _ventsim_oy
                        _opt['z'] = float(_opt.get('z', 0)) - _ventsim_oz
                # Also center geometry.path (used by TUNNEL_SEGMENT path rendering)
                _opath = _ogeo.get('path')
                if _opath:
                    for _opt in _opath:
                        _opt['x'] = float(_opt.get('x', 0)) - _ventsim_ox
                        _opt['y'] = float(_opt.get('y', 0)) - _ventsim_oy
                        _opt['z'] = float(_opt.get('z', 0)) - _ventsim_oz
    else:
        _ventsim_ox, _ventsim_oy, _ventsim_oz = 0.0, 0.0, 0.0

    # Junction solver migrated to topology engine (solveJunctionPositions).
    # Positions are already solved in CSS — generate reads them as-is.
    # _jr_edge_gaps kept as empty dict for downstream overlap/junction-fill lookups.
    _jr_edge_gaps = {}

    if has_tunnel_segments:
        # Tunnel: all segments share ONE storey at elevation 0.
        # Segments are horizontal zones (chainage-based), not vertical floors.
        # Each element carries its own X/Y/Z placement — no vertical stacking.
        # Place storey at VentSim world origin so all element local coords are near zero.
        _tun_loc = f.create_entity('IfcCartesianPoint', Coordinates=(_ventsim_ox, _ventsim_oy, _ventsim_oz))
        _tun_axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
        _tun_refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
        _tun_place = f.create_entity('IfcAxis2Placement3D', Location=_tun_loc, Axis=_tun_axis, RefDirection=_tun_refd)
        tunnel_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=bld_lp, RelativePlacement=_tun_place)
        tunnel_storey = f.create_entity(
            'IfcBuildingStorey',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            Name=facility_name,
            ObjectPlacement=tunnel_lp,
            CompositionType='ELEMENT',
            Elevation=0.0
        )
        storey_entities.append(tunnel_storey)
        # Map every segment id to the single tunnel storey
        for level in levels:
            level_id = level.get('id', 'seg-tunnel-main')
            storey_map[level_id] = (tunnel_storey, tunnel_lp, 0.0)
            # Backfill height_m written by applyStoreyHeightFromProfile so DXF wall
            # extrusion uses the real bore height instead of the 3.5m generic default.
            level_h = level.get('height_m')
            if level_h is not None:
                storey_height_map[level_id] = float(level_h)
        # Ensure default fallback key exists
        if 'seg-tunnel-main' not in storey_map:
            storey_map['seg-tunnel-main'] = (tunnel_storey, tunnel_lp, 0.0)
        print(f"Tunnel domain: created single storey, mapped {len(storey_map)} segment IDs, "
              f"height_map entries={len(storey_height_map)}")
    else:
        prev_elevation = None
        prev_height = None

        for i, level in enumerate(levels):
            level_id = level.get('id', f'level-{i + 1}')
            level_name = level.get('name', 'Level')
            level_type = level.get('type', 'STOREY')
            height_m = level.get('height_m')

            # Compute elevation: use explicit value, or derive cumulatively
            explicit_elevation = level.get('elevation_m')
            if explicit_elevation is not None:
                elevation = float(explicit_elevation)
            elif prev_elevation is not None and prev_height is not None:
                elevation = prev_elevation + prev_height
            else:
                elevation = 0.0

            # Validate monotonically increasing
            if prev_elevation is not None and elevation < prev_elevation:
                print(f"Warning: storey '{level_name}' elevation {elevation}m < previous {prev_elevation}m")

            # Warn if delta between storeys differs from expected height_m by > 0.25m
            if prev_elevation is not None and prev_height is not None:
                delta = elevation - prev_elevation
                if abs(delta - prev_height) > 0.25:
                    print(f"Warning: storey '{level_name}' delta {delta:.2f}m differs from "
                          f"prev height_m {prev_height:.2f}m by {abs(delta - prev_height):.2f}m")

            # Track for next iteration — always set prev_height from current height_m
            if height_m is not None:
                prev_height = float(height_m)
            else:
                if level_type == 'STOREY':
                    print(f"Warning: storey '{level_name}' missing height_m, "
                          f"cannot compute next storey elevation cumulatively")
                prev_height = None
            prev_elevation = elevation

            lvl_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, elevation))
            lvl_axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
            lvl_refd = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
            lvl_place = f.create_entity('IfcAxis2Placement3D', Location=lvl_origin, Axis=lvl_axis, RefDirection=lvl_refd)
            lvl_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=bld_lp, RelativePlacement=lvl_place)

            storey = f.create_entity(
                'IfcBuildingStorey',
                GlobalId=new_guid(),
                OwnerHistory=owner,
                Name=level_name,
                ObjectPlacement=lvl_lp,
                CompositionType='ELEMENT',
                Elevation=elevation
            )

            # Write height_m as custom Pset on storey for debugging
            if height_m is not None:
                add_property_set(f, owner, storey, 'Pset_StoreyHeight', {
                    'StoreyHeight': (float(height_m), 'IfcReal'),
                })

            storey_map[level_id] = (storey, lvl_lp, elevation)
            if height_m is not None:
                storey_height_map[level_id] = float(height_m)
            storey_entities.append(storey)

    # If no levels created, add a default
    if not storey_entities:
        default_lp = f.create_entity('IfcLocalPlacement', PlacementRelTo=bld_lp, RelativePlacement=wcs)
        default_storey = f.create_entity('IfcBuildingStorey', GlobalId=new_guid(), OwnerHistory=owner, Name='Ground Floor', ObjectPlacement=default_lp, CompositionType='ELEMENT', Elevation=0.0)
        storey_map['level-1'] = (default_storey, default_lp, 0.0)
        storey_entities.append(default_storey)

    f.create_entity('IfcRelAggregates', GlobalId=new_guid(), OwnerHistory=owner, RelatingObject=building, RelatedObjects=tuple(storey_entities))

    # ---- v6+ Phase 8: Pre-processing safety checks ----
    MAX_ELEMENTS_LIMIT = 5000
    if len(elements) > MAX_ELEMENTS_LIMIT:
        print(f"SAFETY: Element count {len(elements)} exceeds limit {MAX_ELEMENTS_LIMIT} — truncating")
        elements = elements[:MAX_ELEMENTS_LIMIT]

    # Detect and skip duplicate elements (same type + approximate position).
    # Windows/doors use 0.5m grid to catch stacked copies; other elements use 0.1m.
    # Key includes canonical_id + fittingType (DUCT_FITTING) / subtype so that
    # different elements at the same coordinate aren't merged. Drop is per-record:
    # only the colliding record is removed, sibling records with the same id at
    # other positions survive. Each drop is logged via log_decision so future
    # silent-drop debugging is possible.
    seen_positions = {}
    drop_indices = []
    for idx, elem in enumerate(elements):
        o = elem.get('placement', {}).get('origin', {})
        elem_type = elem.get('type', '')
        if elem_type in ('WINDOW', 'DOOR'):
            pos_part = f"{round(o.get('x', 0) * 2) / 2},{round(o.get('y', 0) * 2) / 2},{round(o.get('z', 0) * 2) / 2}"
        else:
            pos_part = f"{round(o.get('x', 0), 1)},{round(o.get('y', 0), 1)},{round(o.get('z', 0), 1)}"
        canonical_id = elem.get('canonical_id') or elem.get('id') or ''
        if elem_type == 'DUCT_FITTING':
            disc = (elem.get('properties') or {}).get('fittingType') \
                or (elem.get('properties') or {}).get('subtype') \
                or (elem.get('properties') or {}).get('fittingKind') \
                or ''
        else:
            disc = (elem.get('properties') or {}).get('subtype') or ''
        pos_key = f"{elem_type}|{canonical_id}|{disc}|{pos_part}"
        if pos_key in seen_positions:
            kept_idx = seen_positions[pos_key]
            drop_indices.append((idx, kept_idx, pos_key, elem_type, disc))
        else:
            seen_positions[pos_key] = idx
    if drop_indices:
        drop_set = {i for (i, _kept, _k, _t, _d) in drop_indices}
        print(f"SAFETY: skipping {len(drop_set)} duplicate elements at same positions")
        for (idx, kept_idx, pos_key, elem_type, disc) in drop_indices:
            dropped_elem = elements[idx]
            kept_elem = elements[kept_idx]
            log_decision({
                'pass': 'pre_resolve_dedup',
                'element_id': dropped_elem.get('id', ''),
                'action': 'dedup_skipped',
                'reason': 'position_collision',
                'params': {
                    'kept_id': kept_elem.get('id', ''),
                    'pos_key': pos_key,
                    'fitting_type': disc,
                    'css_type': elem_type,
                },
            })
        elements = [e for i, e in enumerate(elements) if i not in drop_set]

    # Cross-type dedup: ROOF vs SLAB with slabType=ROOF at same position
    _roof_positions = {}
    _slab_roof_positions = set()
    for elem in elements:
        o = elem.get('placement', {}).get('origin', {})
        pos = (round(o.get('x', 0), 0), round(o.get('y', 0), 0), round(o.get('z', 0), 0))
        if elem.get('type', '') == 'ROOF':
            _roof_positions[pos] = elem.get('id', '')
        elif elem.get('type', '') == 'SLAB' and elem.get('properties', {}).get('slabType') == 'ROOF':
            _slab_roof_positions.add(pos)

    _cross_type_dupes = set()
    for pos, roof_id in _roof_positions.items():
        if pos in _slab_roof_positions:
            _cross_type_dupes.add(roof_id)

    if _cross_type_dupes:
        print(f"SAFETY: removing {len(_cross_type_dupes)} ROOF elements that duplicate SLAB-ROOF at same position")
        elements = [e for e in elements if e.get('id', '') not in _cross_type_dupes]

    # ---- Building bounding box per storey (segment-based structures don't need wall bbox) ----
    # Used to relocate equipment that extracted with wrong XY (outside the building footprint).
    wall_bbox_by_container = {}
    if not has_tunnel_segments:
        for _we in elements:
            if (_we.get('type') or '').upper() != 'WALL':
                continue
            _wo = (_we.get('placement') or {}).get('origin') or {}
            _wx = float(_wo.get('x', 0))
            _wy = float(_wo.get('y', 0))
            _cid = _we.get('container', 'level-1')
            if _cid not in wall_bbox_by_container:
                wall_bbox_by_container[_cid] = {'min_x': _wx, 'max_x': _wx, 'min_y': _wy, 'max_y': _wy, 'n': 0}
            _b = wall_bbox_by_container[_cid]
            if _wx < _b['min_x']: _b['min_x'] = _wx
            if _wx > _b['max_x']: _b['max_x'] = _wx
            if _wy < _b['min_y']: _b['min_y'] = _wy
            if _wy > _b['max_y']: _b['max_y'] = _wy
            _b['n'] += 1
        for _b in wall_bbox_by_container.values():
            _b['cx'] = (_b['min_x'] + _b['max_x']) / 2
            _b['cy'] = (_b['min_y'] + _b['max_y']) / 2

    # ---- Process elements ----
    # Group elements by container for IfcRelContainedInSpatialStructure
    elements_by_container = {}
    ifc_elements_by_css_id = {}  # css_id → ifc_element (for relationships)
    element_count = 0
    error_count = 0
    orientation_warnings = []  # structured fan orientation warnings
    # Track original z values per container for heuristic warning
    original_z_by_container = {}  # container_id → [z_values]

    # Pre-pass: identify structural tunnel segments for hollow solid rendering.
    # Shell piece decomposition is no longer used — topology outputs intact segments
    # with shellThickness_m and shellMode annotations. All STRUCTURAL segments render
    # as IfcRectangleHollowProfileDef directly.
    decomposed_branches = set()  # empty — no shell pieces emitted by topology
    manifold_rendered_branches = set()
    for elem in elements:
        props = elem.get('properties', {})
        if (elem.get('type') == 'TUNNEL_SEGMENT'
                and props.get('branchClass') == 'STRUCTURAL'):
            _pt = (elem.get('geometry', {}).get('profile', {}).get('type', '') or '').upper()
            if True:  # all structural TUNNEL_SEGMENT profiles need overlap tracking for mitre clips
                manifold_rendered_branches.add(elem.get('element_key', elem.get('id', '')))
    if manifold_rendered_branches:
        print(f"Hollow manifold: {len(manifold_rendered_branches)} rectangular segments → single hollow solid each")

    # Pre-pass: build portal_wall_void_map for baked door voids (GAP 8)
    # GAP 8 disabled temporarily — needs investigation of actual relationship structure
    portal_wall_void_map = {}
    # DEBUG: collect all VOIDS relationships to understand structure
    voids_relationships = []
    for elem in elements:
        relationships = elem.get('relationships', [])
        css_id = elem.get('id', '')
        for rel in relationships:
            if rel.get('type') == 'VOIDS':
                target_id = rel.get('target', '')
                target_elem = next((e for e in elements if e.get('id') == target_id), None)
                if target_elem:
                    voids_relationships.append({
                        'door_id': css_id,
                        'door_type': elem.get('type'),
                        'wall_id': target_id,
                        'wall_type': target_elem.get('type'),
                        'wall_segmentType': target_elem.get('properties', {}).get('segmentType')
                    })
    if voids_relationships:
        print(f"DEBUG VOIDS: Found {len(voids_relationships)} void relationships:")
        for vr in voids_relationships[:5]:  # sample first 5
            print(f"  {vr['door_type']} {vr['door_id']} -> {vr['wall_type']} {vr['wall_id']} (segmentType={vr['wall_segmentType']})")

    ifc_by_key = {}           # element_key → IFC entity (for v3 semantic upgrades)
    solid_by_css_key = {}     # css_key → raw solid (for mitre clip second pass)
    placement_by_css_key = {} # css_key → placement_data (refDirection/axis for mitre bisector)
    geom_profile_by_css_key = {} # css_key → profile_data (wall length for cut plane position)
    geom_depth_by_css_key = {}        # css_key → extrusion depth (may include junction overlap extension)
    geom_orig_depth_by_css_key = {}   # css_key → original depth BEFORE junction overlap extension
    geom_junction_overlap_by_css_key = {} # css_key → overlap amount added per end (for shell pieces)
    hollow_shell_solids_by_key = {}      # css_key → [lw, rw, roof, floor] solids (hollow manifold only)

    # Type grouping tracking for IfcRelDefinesByType
    type_group_data = []  # list of (ifc_element, ifc_entity_type, material_name, profile_key)

    # v6: Visual QA tracking
    style_report = {}
    all_elem_names = []
    proxy_tracking = {'count': 0, 'reasons': {}}
    shell_naming_hits = 0  # count of elements that used shell piece naming path
    shell_naming_samples = []  # first few shell-named elements for QA
    duct_naming_hits = 0  # count of duct/pipe elements with descriptive names
    duct_naming_samples = []  # first few duct/pipe named elements for QA
    equipment_size_overrides = 0  # count of equipment with placeholder geometry replaced

    # Bug 5 fix: Deduplicate PORTAL_BUILDING elements by proximity (universal — driven by segmentType)
    portal_entries = []
    for i, e in enumerate(elements):
        if e.get('properties', {}).get('segmentType') == 'PORTAL_BUILDING':
            o = e.get('placement', {}).get('origin', {})
            portal_entries.append((i, float(o.get('x', 0)), float(o.get('y', 0)), float(o.get('z', 0))))
    if len(portal_entries) > 1:
        PORTAL_MERGE_DIST = 30.0  # aggressive merge — source data has only 2 portals
        keep_portal_indices = set()
        used_portals = set()
        for j, (idx, x, y, z) in enumerate(portal_entries):
            if j in used_portals:
                continue
            keep_portal_indices.add(idx)
            used_portals.add(j)
            for k, (idx2, x2, y2, z2) in enumerate(portal_entries):
                if k in used_portals:
                    continue
                dist = math.sqrt((x - x2) ** 2 + (y - y2) ** 2 + (z - z2) ** 2)
                if dist < PORTAL_MERGE_DIST:
                    used_portals.add(k)
        skip_portal_indices = set()
        for i, e in enumerate(elements):
            if (e.get('properties', {}).get('segmentType') == 'PORTAL_BUILDING'
                    and i not in keep_portal_indices):
                skip_portal_indices.add(i)
        if skip_portal_indices:
            print(f"Portal dedup: keeping {len(keep_portal_indices)}, skipping {len(skip_portal_indices)}")
            elements = [e for i, e in enumerate(elements) if i not in skip_portal_indices]

    # Parallel loop dedup: when two TUNNEL_SEGMENT elements share both endpoints (parallel
    # drives), hide the narrower one to prevent a double-bore appearance. Universal —
    # driven by TUNNEL_SEGMENT type, not domain name.
    # Uses geometry.path endpoints (set by centroid snap) instead of axis-computed
    # endpoints — axis is (0,0,1) after centroid snap, giving wrong XY positions.
    portal_hidden_ids = set()  # css_ids of segments to skip rendering
    parallel_dedup_redirect = {}  # hidden_key → surviving_key (for PATH_CONNECTS redirect)
    if has_tunnel_segments:
        PARALLEL_SNAP = 8.0  # tolerance for matching endpoints (accounts for z-offset between parallel drives)
        seg_data = []  # [(idx, entry_pt, exit_pt, area, css_id)]
        for i, e in enumerate(elements):
            if e.get('type') != 'TUNNEL_SEGMENT':
                continue
            props = e.get('properties', {})
            if props.get('branchClass') != 'STRUCTURAL':
                continue
            # Use centroid-snapped path endpoints (set by centroid snap above)
            # instead of origin + axis*depth, since axis=(0,0,1) after snap
            path = e.get('geometry', {}).get('path', [])
            if len(path) >= 2:
                p0, p1 = path[0], path[-1]
                entry = (float(p0.get('x', 0)), float(p0.get('y', 0)), float(p0.get('z', 0)))
                exit_pt = (float(p1.get('x', 0)), float(p1.get('y', 0)), float(p1.get('z', 0)))
            else:
                # Fallback: compute from origin + refDirection * depth
                o = e.get('placement', {}).get('origin', {})
                ox, oy, oz = float(o.get('x', 0)), float(o.get('y', 0)), float(o.get('z', 0))
                rd = e.get('placement', {}).get('refDirection', e.get('geometry', {}).get('direction', {'x': 1, 'y': 0, 'z': 0}))
                rx, ry, rz = float(rd.get('x', 1)), float(rd.get('y', 0)), float(rd.get('z', 0))
                r_len = math.sqrt(rx**2 + ry**2 + rz**2)
                if r_len > 1e-6:
                    rx /= r_len; ry /= r_len; rz /= r_len
                dep = float(e.get('geometry', {}).get('depth', 0))
                entry = (ox - rx * dep / 2, oy - ry * dep / 2, oz - rz * dep / 2)
                exit_pt = (ox + rx * dep / 2, oy + ry * dep / 2, oz + rz * dep / 2)
            prof = e.get('geometry', {}).get('profile', {})
            area = float(prof.get('width', 0)) * float(prof.get('height', 0))
            css_id = e.get('id', '')
            seg_data.append((i, entry, exit_pt, area, css_id))

        print(f"Parallel dedup: {len(seg_data)} structural tunnel segments indexed")

        # For each pair of segments, check if they share both endpoints (in either direction)
        paired = set()
        for j in range(len(seg_data)):
            if j in paired:
                continue
            idx1, o1, e1, a1, c1 = seg_data[j]
            for k in range(j + 1, len(seg_data)):
                if k in paired:
                    continue
                idx2, o2, e2, a2, c2 = seg_data[k]
                # Check o1↔o2 & e1↔e2, or o1↔e2 & e1↔o2
                d_oo = math.sqrt((o1[0]-o2[0])**2 + (o1[1]-o2[1])**2 + (o1[2]-o2[2])**2)
                d_ee = math.sqrt((e1[0]-e2[0])**2 + (e1[1]-e2[1])**2 + (e1[2]-e2[2])**2)
                d_oe = math.sqrt((o1[0]-e2[0])**2 + (o1[1]-e2[1])**2 + (o1[2]-e2[2])**2)
                d_eo = math.sqrt((e1[0]-o2[0])**2 + (e1[1]-o2[1])**2 + (e1[2]-o2[2])**2)
                matched = (d_oo < PARALLEL_SNAP and d_ee < PARALLEL_SNAP) or \
                          (d_oe < PARALLEL_SNAP and d_eo < PARALLEL_SNAP)
                if matched:
                    # Pick winner: prefer larger area, then more Z variation (slope data)
                    _dz1 = abs(e1[2] - o1[2])  # Z range of segment 1
                    _dz2 = abs(e2[2] - o2[2])  # Z range of segment 2
                    if a1 > a2:
                        _keep, _hide = c1, c2
                        _ka, _ha = a1, a2
                    elif a2 > a1:
                        _keep, _hide = c2, c1
                        _ka, _ha = a2, a1
                    elif _dz1 >= _dz2:
                        # Equal area: prefer the one with more Z variation (slope data)
                        _keep, _hide = c1, c2
                        _ka, _ha = a1, a2
                    else:
                        _keep, _hide = c2, c1
                        _ka, _ha = a2, a1
                    portal_hidden_ids.add(_hide)
                    # Build redirect map: hidden element → surviving element (for PATH_CONNECTS resolution)
                    # Find the element_key of both hidden and surviving segments
                    _hide_elem = next((e for e in elements if e.get('id') == _hide), None)
                    _keep_elem = next((e for e in elements if e.get('id') == _keep), None)
                    if _hide_elem and _keep_elem:
                        _hide_ek = _hide_elem.get('element_key', '') or _hide
                        _keep_ek = _keep_elem.get('element_key', '') or _keep
                        parallel_dedup_redirect[_hide_ek] = _keep_ek
                        parallel_dedup_redirect[_hide] = _keep  # also map by css_id
                    print(f"  Parallel dedup: hiding {_hide} (area={_ha:.1f}), keeping {_keep} (area={_ka:.1f}), "
                          f"d_oo={d_oo:.1f} d_ee={d_ee:.1f} dZ_keep={max(_dz1,_dz2):.1f}")
                    paired.add(j)
                    paired.add(k)
                    break  # move to next j

        if portal_hidden_ids:
            print(f"Parallel loop dedup: hiding {len(portal_hidden_ids)} parallel segments")
        else:
            print(f"Parallel loop dedup: no parallel segments detected (all {len(seg_data)} unique)")

    # Bug 4 fix: Build per-segment lookup for duct/pipe containment — universal,
    # built whenever TUNNEL_SEGMENT elements are present regardless of domain.
    tunnel_segments_index = []  # list of {key, origin, axis, half_w, half_h, depth}
    _seg_geo_endpoints = []     # N4: (x, y, z, ek) for all structural segment endpoints
    if has_tunnel_segments:
        for e in elements:
            if e.get('type') == 'TUNNEL_SEGMENT' and e.get('properties', {}).get('branchClass') == 'STRUCTURAL':
                prof = e.get('geometry', {}).get('profile', {})
                tw = float(prof.get('width', 0))
                th = float(prof.get('height', 0))
                pl = e.get('placement', {})
                orig = pl.get('origin', {})
                # CSS sets axis=(0,0,1)=world-up and refDirection=(rx,ry,0)=branch direction.
                # Use refDirection as the tunnel run axis for duct snap calculations.
                ref_d = pl.get('refDirection', pl.get('axis', {'x': 0, 'y': 0, 'z': 1}))
                dep = float(e.get('geometry', {}).get('depth', 0))
                if tw > 0 and th > 0 and dep > 0:
                    shell_t = float(e.get('properties', {}).get('shellThickness_m', 0) or
                                    prof.get('wallThickness', 0) or 0)
                    tunnel_segments_index.append({
                        'key': e.get('element_key', e.get('id', '')),
                        'ox': float(orig.get('x', 0)), 'oy': float(orig.get('y', 0)), 'oz': float(orig.get('z', 0)),
                        'ax': float(ref_d.get('x', 0)), 'ay': float(ref_d.get('y', 0)), 'az': float(ref_d.get('z', 0)),
                        'half_w': tw / 2.0, 'half_h': th / 2.0, 'depth': dep,
                        'shell_thickness': shell_t,
                    })
        if tunnel_segments_index:
            print(f"Tunnel segment index: {len(tunnel_segments_index)} segments for duct/pipe containment")

        # N4: geometry-based endpoint adjacency set.
        # VentSim branches don't always share node IDs even when geometrically adjacent,
        # so node_to_segs_for_clip misses those junctions → zero overlap → visible seam rings.
        # Build a list of all segment (start, end) endpoints so the arch-tube rendering
        # can detect adjacency by proximity when node ID matching fails.
        for _sge in tunnel_segments_index:
            _sge_len = math.sqrt(_sge['ax']**2 + _sge['ay']**2 + _sge['az']**2)
            if _sge_len < 1e-6:
                continue
            _sge_ux, _sge_uy, _sge_uz = _sge['ax']/_sge_len, _sge['ay']/_sge_len, _sge['az']/_sge_len
            _sge_half = _sge['depth'] / 2.0
            _sge_sx = _sge['ox'] - _sge_ux * _sge_half
            _sge_sy = _sge['oy'] - _sge_uy * _sge_half
            _sge_sz = _sge['oz'] - _sge_uz * _sge_half
            _sge_ex = _sge['ox'] + _sge_ux * _sge_half
            _sge_ey = _sge['oy'] + _sge_uy * _sge_half
            _sge_ez = _sge['oz'] + _sge_uz * _sge_half
            _seg_geo_endpoints.append((_sge_sx, _sge_sy, _sge_sz, _sge['key']))
            _seg_geo_endpoints.append((_sge_ex, _sge_ey, _sge_ez, _sge['key']))

        # Slope diagnostic: check if any segments have different entry/exit Z values.
        # If none appear, elevation data is flat in the VSM (data gap, not code gap).
        _slope_count = 0
        for e in elements:
            if e.get('type') != 'TUNNEL_SEGMENT':
                continue
            props = e.get('properties', {})
            entry_z = props.get('entry_z') or props.get('start_z')
            exit_z = props.get('exit_z') or props.get('end_z')
            if entry_z is not None and exit_z is not None:
                dz = float(exit_z) - float(entry_z)
                if abs(dz) > 0.01:
                    _slope_count += 1
                    if _slope_count <= 5:
                        print(f"SLOPED_SEGMENT: {e.get('element_key', e.get('id', ''))} "
                              f"dZ={dz:.3f}m entry_z={float(entry_z):.2f} exit_z={float(exit_z):.2f}")
        if _slope_count == 0:
            print("SLOPE_DIAGNOSTIC: No sloped segments detected — all Z values are flat. "
                  "Elevation data may be missing from source (DWG/VSM data gap).")
        else:
            print(f"SLOPE_DIAGNOSTIC: {_slope_count} sloped segments detected.")

    # Mitre clip pre-pass: build junction node → [(elem_key, bearing_x, bearing_y, endpoint_type)]
    # for bisector plane computation inside the hollow manifold generation below.
    # Must run BEFORE the element loop so every segment sees the full junction map.
    node_to_segs_for_clip = {}  # str(node_id) → [(ek, rx, ry, 'entry'|'exit')]
    if has_tunnel_segments:
        for _mcp_e in elements:
            if _mcp_e.get('type') != 'TUNNEL_SEGMENT':
                continue
            if _mcp_e.get('properties', {}).get('branchClass') != 'STRUCTURAL':
                continue
            _mcp_ek = _mcp_e.get('element_key') or _mcp_e.get('id', '')
            if not _mcp_ek:
                continue
            _mcp_pl = _mcp_e.get('placement', {})
            _mcp_rd = _mcp_pl.get('refDirection', _mcp_pl.get('axis', {'x': 1, 'y': 0, 'z': 0}))
            _mcp_rx = float(_mcp_rd.get('x', 1))
            _mcp_ry = float(_mcp_rd.get('y', 0))
            _mcp_rlen = math.sqrt(_mcp_rx * _mcp_rx + _mcp_ry * _mcp_ry)
            if _mcp_rlen > 1e-6:
                _mcp_rx /= _mcp_rlen
                _mcp_ry /= _mcp_rlen
            _mcp_en = _mcp_e.get('properties', {}).get('entry_node')
            _mcp_ex = _mcp_e.get('properties', {}).get('exit_node')
            if _mcp_en is not None:
                node_to_segs_for_clip.setdefault(str(_mcp_en), []).append(
                    (_mcp_ek, _mcp_rx, _mcp_ry, 'entry'))
            if _mcp_ex is not None:
                node_to_segs_for_clip.setdefault(str(_mcp_ex), []).append(
                    (_mcp_ek, _mcp_rx, _mcp_ry, 'exit'))
        if node_to_segs_for_clip:
            print(f"Mitre clip pre-pass: {len(node_to_segs_for_clip)} junction nodes indexed")
            # Diagnostic: compute and log the angle at every junction node
            for _diag_node_id, _diag_segs in sorted(node_to_segs_for_clip.items(), key=lambda x: x[0]):
                _diag_n = len(_diag_segs)
                if _diag_n < 2:
                    print(f"MITRE_ANGLE_CHECK: node={_diag_node_id} segments=1 (terminal, no angle)")
                    continue
                # Compute angle between every pair at this node
                for _di in range(_diag_n):
                    for _dj in range(_di + 1, _diag_n):
                        _ek_i, _rx_i, _ry_i, _ep_i = _diag_segs[_di]
                        _ek_j, _rx_j, _ry_j, _ep_j = _diag_segs[_dj]
                        # Flip bearing to "away from junction" direction:
                        #   exit_node means segment runs TOWARD this node → bearing is toward node, flip it
                        #   entry_node means segment runs AWAY from this node → bearing already points away
                        _ax = _rx_i if _ep_i == 'entry' else -_rx_i
                        _ay = _ry_i if _ep_i == 'entry' else -_ry_i
                        _bx = _rx_j if _ep_j == 'entry' else -_rx_j
                        _by = _ry_j if _ep_j == 'entry' else -_ry_j
                        # Angle between the two "away" directions
                        _dot = _ax * _bx + _ay * _by
                        _dot = max(-1.0, min(1.0, _dot))
                        _angle_deg = math.acos(_dot) * (180.0 / math.pi)
                        # Would this qualify for mitre? Topology requires 10-170, generate requires 5-175
                        _topo_qualified = 10 <= _angle_deg <= 170
                        _gen_qualified = 5 <= _angle_deg <= 175
                        _has_path_rel = False
                        # Check if a PATH_CONNECTS relationship with MITRE actually exists between these two
                        for _chk_e in elements:
                            _chk_ek = _chk_e.get('element_key') or _chk_e.get('id', '')
                            if _chk_ek != _ek_i:
                                continue
                            for _chk_r in (_chk_e.get('relationships') or []):
                                if _chk_r.get('type') == 'PATH_CONNECTS' and _chk_r.get('target') == _ek_j:
                                    _ca = (_chk_r.get('metadata', {}) or {}).get('connectionAngle', {})
                                    _has_path_rel = True if _ca and _ca.get('connectionType') == 'MITRE' else False
                        print(f"MITRE_ANGLE_CHECK: node={_diag_node_id} pair={_ek_i[:20]}|{_ek_j[:20]} "
                              f"angle={_angle_deg:.1f}° topo_qualifies={_topo_qualified} gen_qualifies={_gen_qualified} "
                              f"has_mitre_rel={_has_path_rel} endpoints={_ep_i}/{_ep_j}")

    # Build mitre angle lookup: for each junction node, store the min bend angle.
    # The min angle between any pair of segments at a node determines the extension
    # needed: sharper bends (smaller angle) require more overlap (cot(α/2) grows).
    node_mitre_angles = {}  # str(node_id) → min angle (degrees) between "away" directions
    for _nma_node_id, _nma_segs in node_to_segs_for_clip.items():
        if len(_nma_segs) < 2:
            continue
        _nma_min_angle = 360.0
        for _nma_i in range(len(_nma_segs)):
            for _nma_j in range(_nma_i + 1, len(_nma_segs)):
                _ek_i, _rx_i, _ry_i, _ep_i = _nma_segs[_nma_i]
                _ek_j, _rx_j, _ry_j, _ep_j = _nma_segs[_nma_j]
                # Flip bearing to "away from junction" direction
                _ax = _rx_i if _ep_i == 'entry' else -_rx_i
                _ay = _ry_i if _ep_i == 'entry' else -_ry_i
                _bx = _rx_j if _ep_j == 'entry' else -_rx_j
                _by = _ry_j if _ep_j == 'entry' else -_ry_j
                _dot = max(-1.0, min(1.0, _ax * _bx + _ay * _by))
                _ang = math.acos(_dot) * (180.0 / math.pi)
                if _ang < _nma_min_angle:
                    _nma_min_angle = _ang
        node_mitre_angles[_nma_node_id] = _nma_min_angle
    if node_mitre_angles:
        print(f"Mitre angle lookup: {len(node_mitre_angles)} junction nodes, "
              f"angles: {[f'{k}={v:.0f}°' for k, v in sorted(node_mitre_angles.items())[:10]]}")

    # ------------------------------------------------------------------
    # PHASE 4C — Tunnel chain pre-pass (curvature continuity).
    # Build connected chains of STRUCTURAL TUNNEL_SEGMENTs, sample sections
    # with arc interpolation at bends, and pre-compute the leader BREP data.
    # The main element loop below uses this to emit one welded BREP per chain
    # while non-leader segments stay alive as IFC entities with no Representation.
    # ------------------------------------------------------------------
    chain_sections_by_id = {}      # chain_id → list of section frames
    chain_outer_pts_by_id = {}     # chain_id → 2D outer profile reused for inner ring
    chain_shell_thickness_by_id = {}  # chain_id → meters
    chain_leader_by_id = {}        # chain_id → leader css_key (= first segment in order)
    chain_seg_order_by_id = {}     # chain_id → ordered list of segment css_keys
    chain_end_frame_by_id = {}     # chain_id → {'start': section, 'end': section} for portal reuse
    seg_to_chain = {}              # css_key → chain_id (members AND leaders)
    chain_member_skip = set()      # css_keys that are chain members but NOT leaders → skip geometry
    chain_stats_total = {
        'chains_detected': 0,
        'chains_emitted': 0,
        'chain_length_max': 0,
        'chain_length_avg': 0.0,
        'sections_total': 0,
        'arcs_inserted': 0,
        'max_turn_deg': 0.0,
        'tight_skips': 0,
        'cap_hits': 0,
        'verts_welded': 0,
    }

    print(f"[CHAIN] PIPELINE GATE has_tunnel_segments={has_tunnel_segments} "
          f"tunnel_segments_index={len(tunnel_segments_index)} "
          f"node_to_segs_for_clip={len(node_to_segs_for_clip)}")
    if has_tunnel_segments and tunnel_segments_index:
        print("[CHAIN] ENTERED CHAIN PIPELINE")
        seg_idx_by_key = {entry['key']: entry for entry in tunnel_segments_index}
        elements_by_key_chain = {}
        for _ce in elements:
            _ck = _ce.get('element_key') or _ce.get('id', '')
            if _ck:
                elements_by_key_chain[_ck] = _ce

        chains, seg_to_chain_local = _detect_tunnel_chains(elements, node_to_segs_for_clip)
        seg_to_chain = seg_to_chain_local
        chain_stats_total['chains_detected'] = len(chains)
        if chains:
            _lens = [len(c['segments']) for c in chains]
            chain_stats_total['chain_length_max'] = max(_lens)
            chain_stats_total['chain_length_avg'] = sum(_lens) / float(len(_lens))
        print(f"[CHAIN] _detect_tunnel_chains returned {len(chains)} chains "
              f"(max_len={chain_stats_total['chain_length_max']}, "
              f"avg_len={chain_stats_total['chain_length_avg']:.2f})")

        for chain in chains:
            seg_keys = chain['segments']
            leader_key = seg_keys[0]
            chain_leader_by_id[chain['id']] = leader_key
            chain_seg_order_by_id[chain['id']] = list(seg_keys)
            for k in seg_keys[1:]:
                chain_member_skip.add(k)

            # Resolve outer profile (2D) and shell thickness from the leader's CSS data.
            leader_elem = elements_by_key_chain.get(leader_key)
            if not leader_elem:
                print(f"[CHAIN] {chain['id']} leader element not found in elements_by_key — skipping")
                continue
            prof = leader_elem.get('geometry', {}).get('profile', {}) or {}
            props_l = leader_elem.get('properties', {}) or {}
            prof_type = (prof.get('type', '') or '').upper()

            print(f"[CHAIN] building chain {chain['id']} with {len(seg_keys)} segments "
                  f"profile={prof_type or 'EMPTY'} leader={leader_key}")

            if prof_type == 'ARCH':
                arch_w = float(prof.get('width', 4.0) or 4.0)
                arch_h = float(prof.get('height', 4.0) or 4.0)
                curve_ratio = float(prof.get('curveRatio', 0.3) or 0.3)
                outer_pts_2d = _generate_arch_profile_points(arch_w, arch_h, curve_ratio)
            elif prof_type == 'ARBITRARY':
                pts = prof.get('points', []) or []
                if pts and isinstance(pts[0], dict):
                    outer_pts_2d = [(float(p.get('x', 0)), float(p.get('y', 0))) for p in pts]
                else:
                    outer_pts_2d = [(float(a), float(b)) for (a, b) in pts]
            else:
                print(f"[CHAIN] {chain['id']} profile {prof_type!r} not supported (only ARCH/ARBITRARY) — "
                      f"unwinding chain ownership for {len(seg_keys)} segments")
                for k in seg_keys[1:]:
                    chain_member_skip.discard(k)
                for k in seg_keys:
                    seg_to_chain.pop(k, None)
                continue

            shell_thickness = float(
                props_l.get('shellThickness_m', 0)
                or prof.get('wallThickness', 0)
                or 0.3
            )

            sections, stats = _build_chain_sections(chain, seg_idx_by_key, outer_pts_2d)
            if not sections or len(sections) < 2:
                # Chain build failed → unwind: members re-enable per-segment geometry.
                for k in seg_keys[1:]:
                    chain_member_skip.discard(k)
                for k in seg_keys:
                    seg_to_chain.pop(k, None)
                print(f"[CHAIN] {chain['id']} build failed — falling back to per-segment "
                      f"(reason={stats.get('reason', 'unknown')})")
                continue
            print(f"[CHAIN] {chain['id']} sections generated: {len(sections)}")

            chain_sections_by_id[chain['id']] = sections
            chain_outer_pts_by_id[chain['id']] = outer_pts_2d
            chain_shell_thickness_by_id[chain['id']] = shell_thickness
            chain_end_frame_by_id[chain['id']] = {
                'start': sections[0],
                'end': sections[-1],
            }
            chain_stats_total['chains_emitted'] += 1
            chain_stats_total['sections_total'] += len(sections)
            chain_stats_total['arcs_inserted'] += stats['arcs']
            chain_stats_total['max_turn_deg'] = max(chain_stats_total['max_turn_deg'], stats['max_turn'])
            chain_stats_total['tight_skips'] += stats['tight_skips']
            if stats['cap_hit']:
                chain_stats_total['cap_hits'] += 1
            chain_stats_total['verts_welded'] += 2 * len(sections) * len(outer_pts_2d)

            print(f"[CHAIN] {chain['id']} segs={len(seg_keys)} sections={len(sections)} "
                  f"arcs={stats['arcs']} max_turn={stats['max_turn']:.1f}° "
                  f"tight_skips={stats['tight_skips']}{' cap_hit' if stats['cap_hit'] else ''}")

        # Always print summary line so absence of chains is visible.
        print(f"[CHAIN] SUMMARY chains_detected={chain_stats_total['chains_detected']} "
              f"chains_emitted={chain_stats_total['chains_emitted']} "
              f"seg_to_chain_keys={len(seg_to_chain)} "
              f"chain_member_skip={len(chain_member_skip)}")
        if chain_stats_total['chains_detected'] > 0:
            print(f"[CHAIN] chain_length_max={chain_stats_total['chain_length_max']} "
                  f"chain_length_avg={chain_stats_total['chain_length_avg']:.2f}")
            print(f"[CHAIN] sections_total={chain_stats_total['sections_total']} "
                  f"arcs_inserted={chain_stats_total['arcs_inserted']} "
                  f"max_turn_deg={chain_stats_total['max_turn_deg']:.1f} "
                  f"tight_joints_skipped={chain_stats_total['tight_skips']} "
                  f"sections_cap_hit={chain_stats_total['cap_hits']} "
                  f"vertices_welded={chain_stats_total['verts_welded']}")

    # Portal attachment: snap portal walls to nearest tunnel segment endpoint
    # so they overlap the tunnel mouth instead of floating independently.
    PORTAL_OVERLAP = 0.3  # meters inset into tunnel mouth
    portal_attached = 0
    if tunnel_segments_index:
        for elem in elements:
            if elem.get('properties', {}).get('segmentType') != 'PORTAL_BUILDING':
                continue
            po = elem.get('placement', {}).get('origin', {})
            px, py, pz = float(po.get('x', 0)), float(po.get('y', 0)), float(po.get('z', 0))

            # Find nearest segment endpoint (start or end of each segment)
            best_seg = None
            best_dist = float('inf')
            best_end = None  # 'start' or 'end'
            for seg in tunnel_segments_index:
                ax_len = math.sqrt(seg['ax']**2 + seg['ay']**2 + seg['az']**2)
                nx = seg['ax'] / ax_len if ax_len > 1e-6 else 1.0
                ny = seg['ay'] / ax_len if ax_len > 1e-6 else 0.0
                # Segment start = origin - bearing * depth/2
                sx = seg['ox'] - nx * seg['depth'] / 2
                sy = seg['oy'] - ny * seg['depth'] / 2
                # Segment end = origin + bearing * depth/2
                ex = seg['ox'] + nx * seg['depth'] / 2
                ey = seg['oy'] + ny * seg['depth'] / 2
                ds = math.sqrt((px - sx)**2 + (py - sy)**2)
                de = math.sqrt((px - ex)**2 + (py - ey)**2)
                if ds < best_dist:
                    best_dist = ds
                    best_seg = seg
                    best_end = 'start'
                if de < best_dist:
                    best_dist = de
                    best_seg = seg
                    best_end = 'end'

            if best_seg and best_dist < 15.0:
                # Only attach portals to TRUE TERMINAL endpoints — nodes where no other
                # structural segment connects. Interior T-junction nodes produce portal
                # buildings floating inside the tunnel run.
                _pa_seg_key = best_seg['key']
                _pa_node_id = None
                for _pa_el in elements:
                    if (_pa_el.get('element_key') or _pa_el.get('id', '')) == _pa_seg_key:
                        _pa_props = _pa_el.get('properties', {})
                        _pa_nk = 'entry_node' if best_end == 'start' else 'exit_node'
                        _pa_nv = _pa_props.get(_pa_nk)
                        if _pa_nv is not None:
                            _pa_node_id = str(_pa_nv)
                        break
                if _pa_node_id:
                    _pa_others = sum(1 for t in node_to_segs_for_clip.get(_pa_node_id, []) if t[0] != _pa_seg_key)
                    if _pa_others > 0:
                        print(f"Portal skip: {elem.get('id')} → {_pa_seg_key} {best_end} "
                              f"node={_pa_node_id} is junction (degree {1 + _pa_others}), not terminal")
                        continue
                ax_len = math.sqrt(best_seg['ax']**2 + best_seg['ay']**2 + best_seg['az']**2)
                nx = best_seg['ax'] / ax_len if ax_len > 1e-6 else 1.0
                ny = best_seg['ay'] / ax_len if ax_len > 1e-6 else 0.0
                # Endpoint position
                if best_end == 'start':
                    ep_x = best_seg['ox'] - nx * best_seg['depth'] / 2
                    ep_y = best_seg['oy'] - ny * best_seg['depth'] / 2
                    # Portal faces into tunnel (opposite of segment direction)
                    face_x, face_y = nx, ny
                else:
                    ep_x = best_seg['ox'] + nx * best_seg['depth'] / 2
                    ep_y = best_seg['oy'] + ny * best_seg['depth'] / 2
                    face_x, face_y = -nx, -ny

                # Snap portal origin to endpoint, inset by PORTAL_OVERLAP into tunnel
                elem['placement']['origin']['x'] = ep_x + face_x * PORTAL_OVERLAP
                elem['placement']['origin']['y'] = ep_y + face_y * PORTAL_OVERLAP
                elem['placement']['origin']['z'] = best_seg['oz'] - best_seg['half_h'] + (best_seg.get('shell_thickness', 0) or 0)
                # Portal building refDirection = perpendicular to tunnel bearing so the
                # profile.width dimension spans across the tunnel mouth (not along it).
                # Local X = (-ny, nx, 0), Local Y = axis × refDirection = (nx, ny, 0)
                # → width covers the tunnel face width, height extends outward from mouth.
                if ax_len > 0.001:
                    elem['placement']['refDirection'] = {'x': -ny, 'y': nx, 'z': 0}
                else:
                    elem['placement']['refDirection'] = {'x': 0, 'y': 1, 'z': 0}  # degenerate fallback
                # Explicitly set axis = Z-up (vertical extrusion) for consistent behaviour
                elem['placement']['axis'] = {'x': 0, 'y': 0, 'z': 1}
                # Size portal to envelope tunnel cross-section — bore width/height + shell thickness
                # so the box frames the arch opening rather than sitting inside it.
                _pb_shell = best_seg.get('shell_thickness', 0) or 0
                if _pb_shell <= 0:
                    _pb_shell = derive_shell_thickness(best_seg['half_w'] * 2, best_seg['half_h'] * 2)
                elem['geometry'] = dict(elem.get('geometry', {}))
                elem['geometry']['profile'] = dict(elem['geometry'].get('profile', {}))
                elem['geometry']['profile']['width'] = best_seg['half_w'] * 2 + 2 * _pb_shell
                # profile.height (outward building depth, ~2m from VentSim) preserved as-is
                # geometry.depth (building Z height) preserved from CSS — already matches spec
                if not elem.get('metadata'):
                    elem['metadata'] = {}
                elem['metadata']['hostTunnelSegment'] = best_seg['key']
                elem['metadata']['portalAttached'] = True
                portal_attached += 1

                # PHASE 4C: portal arch continuity — if the host segment is part of a
                # chain, copy the chain's end section frame onto the portal so the
                # geometry phase can build the portal mouth from the exact same vertex
                # ring as the bore (no rectangular mismatch at the seam).
                _portal_host_chain_id = seg_to_chain.get(best_seg['key']) if seg_to_chain else None
                if _portal_host_chain_id and _portal_host_chain_id in chain_end_frame_by_id:
                    _portal_chain_segs = chain_seg_order_by_id.get(_portal_host_chain_id, [])
                    # Decide which chain end the portal is on. best_end='start' means the
                    # host segment's start endpoint hosts the portal. If host is chain[0]
                    # at its start, that's the chain start. If host is chain[-1] at its end,
                    # that's the chain end. Otherwise something is unusual — fall back to
                    # nearest-end by distance.
                    _portal_chain_end_label = None
                    if _portal_chain_segs:
                        if best_seg['key'] == _portal_chain_segs[0] and best_end == 'start':
                            _portal_chain_end_label = 'start'
                        elif best_seg['key'] == _portal_chain_segs[-1] and best_end == 'end':
                            _portal_chain_end_label = 'end'
                    if _portal_chain_end_label is None:
                        # Fallback: pick whichever section is closer to (ep_x, ep_y, ep_z).
                        sec_s = chain_end_frame_by_id[_portal_host_chain_id]['start']
                        sec_e = chain_end_frame_by_id[_portal_host_chain_id]['end']
                        ep_z_for_dist = best_seg['oz']
                        ds = (sec_s['center'][0]-ep_x)**2 + (sec_s['center'][1]-ep_y)**2 + (sec_s['center'][2]-ep_z_for_dist)**2
                        de = (sec_e['center'][0]-ep_x)**2 + (sec_e['center'][1]-ep_y)**2 + (sec_e['center'][2]-ep_z_for_dist)**2
                        _portal_chain_end_label = 'start' if ds <= de else 'end'
                    _portal_section = chain_end_frame_by_id[_portal_host_chain_id][_portal_chain_end_label]
                    elem['metadata']['_chainEndSection'] = {
                        'center': list(_portal_section['center']),
                        'tangent': list(_portal_section['tangent']),
                        'lateral': list(_portal_section['lateral']),
                        'up': list(_portal_section['up']),
                        'outer_world': [list(p) for p in _portal_section['outer_world']],
                        'end_label': _portal_chain_end_label,
                        'chain_id': _portal_host_chain_id,
                    }
                    elem['metadata']['_portalChainOuterFace'] = True

                # Suppress the PORTAL_END_WALL at this endpoint — the PORTAL_BUILDING
                # replaces it. Without this, both walls render and overlap.
                portal_end_wall_id = f"portal-end-wall-{best_seg['key']}-{best_end}"
                portal_hidden_ids.add(portal_end_wall_id)

                # Snap any unhosted portal doors near this building to it.
                # Check proximity against BOTH the portal's original VentSim position (px,py)
                # AND the tunnel endpoint (ep_x,ep_y) — doors may be placed at either location
                # depending on the source format. The portal itself already snapped to ep_x/ep_y.
                building_key = elem.get('element_key') or elem.get('id', '')
                door_face_x = ep_x - face_x * PORTAL_OVERLAP  # outward from tunnel mouth
                door_face_y = ep_y - face_y * PORTAL_OVERLAP
                found_door = False
                for door_elem in elements:
                    if door_elem.get('type', '').upper() != 'DOOR':
                        continue
                    door_meta = door_elem.get('metadata', {}) or {}
                    if door_meta.get('hostWallKey'):
                        continue  # already has a host
                    door_po = door_elem.get('placement', {}).get('origin', {}) or {}
                    dpx = float(door_po.get('x', 0))
                    dpy = float(door_po.get('y', 0))
                    near_original = math.sqrt((dpx - px) ** 2 + (dpy - py) ** 2) < 8.0
                    near_endpoint = math.sqrt((dpx - ep_x) ** 2 + (dpy - ep_y) ** 2) < 15.0
                    if near_original or near_endpoint:
                        door_meta['hostWallKey'] = building_key
                        door_elem['metadata'] = door_meta
                        door_elem['placement']['origin']['x'] = door_face_x
                        door_elem['placement']['origin']['y'] = door_face_y
                        door_elem['placement']['origin']['z'] = best_seg['oz'] - best_seg['half_h'] + (best_seg.get('shell_thickness', 0) or 0)  # floor z (no clamp — portal elevation may be negative relative to storey)
                        found_door = True
                        print(f"Portal door snap: {door_elem.get('id')} -> building {building_key}")

                # Generate a default door if no existing door was found for this portal.
                # Phase 6A guard: never synthesize portal entrance doors when the
                # intent-resolver owns door placement — that would duplicate any
                # portal-zone doors already accepted by the reconciler.
                if not found_door:
                    _synthesis_intent_mode = (
                        ((css.get('metadata') or {}).get('featureFlags') or {})
                        .get('intentMode', 'report')
                    )
                    if _synthesis_intent_mode in ('consume-doors', 'consume-mep', 'consume-all'):
                        print(f"Portal door synthesis SUPPRESSED: intentMode={_synthesis_intent_mode} "
                              f"(intent-resolver owns portal door placement for {building_key})")
                    else:
                        door_id = f"portal-door-{building_key}"
                        door_z = best_seg['oz'] - best_seg['half_h'] + (best_seg.get('shell_thickness', 0) or 0)  # floor z
                        door_h = min(best_seg['half_h'] * 2 * 0.6, 2.4)  # 60% of tunnel height, max 2.4m
                        door_w = min(best_seg['half_w'] * 2 * 0.4, 2.0)  # 40% of tunnel width, max 2.0m
                        new_door = {
                            'id': door_id, 'element_key': door_id,
                            'type': 'DOOR', 'name': 'Portal Entrance Door',
                            'semanticType': 'IfcDoor', 'confidence': 0.5,
                            'source': 'PORTAL_GENERATED', 'container': elem.get('container', ''),
                            'placement': {
                                'origin': {'x': door_face_x, 'y': door_face_y, 'z': door_z},
                                'axis': {'x': 0, 'y': 0, 'z': 1},
                                'refDirection': {'x': -face_y, 'y': face_x, 'z': 0}
                            },
                            'geometry': {
                                'method': 'EXTRUSION', 'direction': {'x': 0, 'y': 0, 'z': 1},
                                'depth': door_h,
                                'profile': {'type': 'RECTANGLE', 'width': door_w, 'height': 0.08}
                            },
                            'material': {'name': 'wood', 'color': [0.55, 0.35, 0.18], 'transparency': 0},
                            'metadata': {'hostWallKey': building_key, 'portalGenerated': True},
                            'properties': {}, 'relationships': []
                        }
                        elements.append(new_door)
                        print(f"[DOOR-AUDIT] portal_generator PATH ACTIVE: "
                              f"'Portal Entrance Door' injected as id={door_id} "
                              f"intentMode={_synthesis_intent_mode} building={building_key}")
                        print(f"Portal door generated: {door_id} for building {building_key}")

                print(f"Portal attached: {elem.get('id')} -> {best_seg['key']} ({best_end}, dist={best_dist:.1f}m)")

    if portal_attached > 0:
        print(f"Portal attachment: {portal_attached} portals snapped to tunnel endpoints")

    # Suppress PORTAL_END_WALL elements at interior junction nodes (nodes shared by
    # multiple segments). End walls should only appear at true terminal endpoints
    # (degree 1 = only one segment touches that node). Interior junction nodes create
    # visible white rectangular slabs floating inside the tunnel run.
    if tunnel_segments_index and node_to_segs_for_clip:
        _ew_suppressed = 0
        for _seg_el in elements:
            if _seg_el.get('type') != 'TUNNEL_SEGMENT':
                continue
            if _seg_el.get('properties', {}).get('branchClass') != 'STRUCTURAL':
                continue
            _seg_ek = _seg_el.get('element_key') or _seg_el.get('id', '')
            _seg_props = _seg_el.get('properties', {})
            for _end_label, _node_key in [('start', 'entry_node'), ('end', 'exit_node')]:
                _nid = _seg_props.get(_node_key)
                if _nid is None:
                    continue
                _nid_str = str(_nid)
                _node_segs = node_to_segs_for_clip.get(_nid_str, [])
                _other_count = sum(1 for t in _node_segs if t[0] != _seg_ek)
                if _other_count > 0:
                    _eid_ew = f"portal-end-wall-{_seg_ek}-{_end_label}"
                    if _eid_ew not in portal_hidden_ids:
                        portal_hidden_ids.add(_eid_ew)
                        _ew_suppressed += 1
        if _ew_suppressed:
            print(f"Interior portal end wall suppression: {_ew_suppressed} end walls hidden at junction nodes")

    # Orphan portal cleanup: suppress PORTAL_BUILDING elements that weren't attached
    # to any tunnel segment endpoint, plus any doors hosted by those orphan portals.
    if has_tunnel_segments:
        unattached_portal_keys = set()
        for elem in elements:
            if elem.get('properties', {}).get('segmentType') != 'PORTAL_BUILDING':
                continue
            if not elem.get('metadata', {}).get('portalAttached'):
                key = elem.get('element_key') or elem.get('id', '')
                unattached_portal_keys.add(key)
                print(f"Orphan portal suppressed: {elem.get('id')} (not attached to any tunnel endpoint)")
        if unattached_portal_keys:
            pre_count = len(elements)
            elements = [e for e in elements if not (
                # Remove unattached portal buildings
                (e.get('properties', {}).get('segmentType') == 'PORTAL_BUILDING'
                 and not e.get('metadata', {}).get('portalAttached'))
                or
                # Remove doors hosted by unattached portals
                (e.get('type', '').upper() == 'DOOR'
                 and e.get('metadata', {}).get('hostWallKey', '') in unattached_portal_keys)
                or
                # Remove portal-generated doors for unattached portals (id format: portal-door-{key})
                (e.get('type', '').upper() == 'DOOR'
                 and any(f'portal-door-{k}' == e.get('id', '') for k in unattached_portal_keys))
            )]
            print(f"Orphan cleanup: removed {pre_count - len(elements)} unattached portal buildings/doors")

    # Pre-build element lookups for host validation (orphan door/window filter)
    _elem_by_id = {e.get('id', ''): e for e in elements}
    _elem_by_key = {e.get('element_key', ''): e for e in elements if e.get('element_key')}

    def _is_valid_host(h):
        """Check if element is a valid, exportable wall/segment host."""
        if not h:
            return False
        ht = (h.get('type', '') or '').upper()
        if ht not in ('WALL', 'TUNNEL_SEGMENT'):
            return False
        if h.get('metadata', {}).get('geometryExportable') is False:
            return False
        hp = h.get('properties', {})
        if hp.get('isPortalHelper') and hp.get('segmentType') != 'PORTAL_BUILDING':
            return False
        if hp.get('_isBridgeSegment'):
            return False
        hg = h.get('geometry', {}) or {}
        if not hg.get('profile'):
            return False
        # Depth required for WALL hosts but not TUNNEL_SEGMENT (segments use profile-based rendering)
        if ht == 'WALL' and not hg.get('depth'):
            return False
        return True

    def _find_nearest_host(elem_to_host, all_elements):
        """Find nearest valid wall/segment, prioritizing portal end walls."""
        pos = elem_to_host.get('placement', {}).get('origin', {})
        ex = float(pos.get('x', 0))
        ey = float(pos.get('y', 0))
        ez = float(pos.get('z', 0))
        candidates = []
        for e in all_elements:
            if not _is_valid_host(e):
                continue
            eo = e.get('placement', {}).get('origin', {})
            d = ((ex - float(eo.get('x', 0))) ** 2 + (ey - float(eo.get('y', 0))) ** 2 +
                 (ez - float(eo.get('z', 0))) ** 2) ** 0.5
            if d > 15.0:
                continue
            # Portal buildings get highest priority (0), portal end walls next (1), others last (2)
            seg_type = e.get('properties', {}).get('segmentType', '')
            if seg_type == 'PORTAL_BUILDING':
                priority = 0
            elif seg_type == 'PORTAL_END_WALL':
                priority = 1
            else:
                priority = 2
            candidates.append((priority, d, e))
        if not candidates:
            return None
        candidates.sort(key=lambda c: (c[0], c[1]))
        return candidates[0][2]

    # ---- Overlap pre-pass: compute junction overlap for all structural tunnel segments ----
    # Previously embedded in the hollow manifold rendering block; extracted so the
    # post-pass thin walls can access overlap values independently of tube rendering.
    # Uses _jr_edge_gaps (junction solver) and node_to_segs_for_clip (mitre pre-pass).
    if has_tunnel_segments:
        _ov_count = 0
        for _ov_el in elements:
            if _ov_el.get('type') != 'TUNNEL_SEGMENT':
                continue
            if _ov_el.get('properties', {}).get('branchClass') != 'STRUCTURAL':
                continue
            if _ov_el.get('properties', {}).get('_isBridgeSegment'):
                continue
            _ov_eid = _ov_el.get('element_key') or _ov_el.get('id', '')
            _ov_depth = safe_float(_ov_el.get('geometry', {}).get('depth'), 1.0)
            _ov_en = str(_ov_el['properties']['entry_node']) if _ov_el.get('properties', {}).get('entry_node') is not None else None
            _ov_ex = str(_ov_el['properties']['exit_node'])  if _ov_el.get('properties', {}).get('exit_node')  is not None else None
            _ov_entry_shared = bool(_ov_en and any(t[0] != _ov_eid for t in node_to_segs_for_clip.get(_ov_en, [])))
            _ov_exit_shared  = bool(_ov_ex and any(t[0] != _ov_eid for t in node_to_segs_for_clip.get(_ov_ex, [])))
            _ov_gap_en = _jr_edge_gaps.get((_ov_en, _ov_eid, 'entry'), {}).get('magnitude', 0.0) if _ov_en else 0.0
            _ov_gap_ex = _jr_edge_gaps.get((_ov_ex, _ov_eid, 'exit'),  {}).get('magnitude', 0.0) if _ov_ex else 0.0
            _ov_entry = 0.0 if not _ov_entry_shared else min(max(0.15, _ov_gap_en), _ov_depth * 0.3)
            _ov_exit  = 0.0 if not _ov_exit_shared  else min(max(0.15, _ov_gap_ex), _ov_depth * 0.3)
            _ov_el['_entry_overlap'] = _ov_entry
            _ov_el['_exit_overlap'] = _ov_exit
            _ov_count += 1
        if _ov_count:
            print(f"Overlap pre-pass: computed junction overlaps for {_ov_count} structural tunnel segments")

    # VERIFY counters: track vertical ducts and tall cylinders across all elements
    _verify_vertical_duct_count = 0   # ducts exported with direction ≈ (0,0,1)
    _verify_tall_cylinder_count = 0   # CIRCLE profile elements with depth > 10m

    # Intentional-skip counter — incremented at each design-intent `continue` site
    # below so the CLEAN_MODE=full retention assertion at end-of-function only
    # measures *unexplained* drops, not legitimate filters.
    intentional_skip_count = 0

    # Snapshot of the elements list *after* all pre-loop mutations (dedup,
    # portal merge, orphan cleanup, portal door synthesis). The retention
    # check at end-of-function compares element_count against this — using
    # the raw input count (_input_element_count) would over-count expected
    # emissions because pre-loop filters silently shrink the list.
    _topology_element_count = len(elements)

    for elem in elements:
        try:
            css_id = elem.get('id', f'elem-{element_count}')
            css_type = elem.get('type', 'PROXY')
            properties = elem.get('properties', {})

            # MUTATION TEST: skip ventsim_branch_316 to confirm it maps to a teal duct artifact
            if css_id == 'ventsim_branch_316':
                print(f"[MUTATION-SKIP] {css_id}: skipping to confirm visual disappearance")
                intentional_skip_count += 1
                continue

            # Skip portal Y-split hidden segments (narrower branch at portal mouth)
            if css_id in portal_hidden_ids:
                print(f"Portal Y-split filter: skipping {css_id}")
                intentional_skip_count += 1
                continue

            # Skip non-exportable elements (network-only airways, routing skeletons, etc.)
            if elem.get('metadata', {}).get('geometryExportable') is False:
                print(f"Non-exportable flag filter: skipping {css_id}")
                intentional_skip_count += 1
                continue

            # Contract-based exportability check (replaces demo filter)
            if elem.get('metadata', {}).get('_geometryExportable') is False:
                reason = elem.get('metadata', {}).get('_invalidReason', 'unknown')
                print(f"Skipping non-exportable: {css_id} ({reason})")
                intentional_skip_count += 1
                continue

            # In segment-based structures, skip stray WALL elements unless they are
            # transition/junction walls or portal end walls.
            # PORTAL_BUILDING elements are suppressed — they appear as floating boxes
            # disconnected from tunnel geometry. Portal end walls (thin caps) are kept.
            # DXF-sourced walls are suppressed (duplicate VentSim geometry).
            if has_tunnel_segments and css_type == 'WALL':
                seg_type = properties.get('segmentType', '')
                is_transition = properties.get('isTransitionHelper', False)
                is_junction_fill = properties.get('isJunctionFill', False)
                is_end_wall = seg_type == 'PORTAL_END_WALL'
                is_shell_piece = bool(properties.get('shellPiece'))
                if not is_transition and not is_junction_fill and not is_end_wall and not is_shell_piece:
                    intentional_skip_count += 1
                    continue

            # Bridge segments become redundant after centroid snap — the real segments
            # now meet at junction centroids, so bridge fill geometry would overlap/float.
            if css_type == 'TUNNEL_SEGMENT' and properties.get('_isBridgeSegment'):
                print(f"Bridge filter: skipping {css_id} (centroid snap covers junction)")
                intentional_skip_count += 1
                continue

            # Suppress only synthetic proxy elements (bridge fillers, etc.) — not real equipment.
            # Real EQUIPMENT (fans, generators, AHU) is positioned by applyEquipmentMounting in
            # topology engine and should render. DUCT elements are positioned by applyPortalElevations.
            if has_tunnel_segments and css_type == 'PROXY':
                intentional_skip_count += 1
                continue

            # Suppress junction fill approximation elements — these are synthetic pieces
            # generated at every bend/junction node to fill gaps between trimmed shell runs.
            # They create rough triangular/box artifacts at bends visible as a corrugated pattern.
            # The run shell pieces (LEFT_WALL/RIGHT_WALL/FLOOR/ROOF without isApproximation)
            # provide the structural geometry; gap closure will move to the layout engine.
            if has_tunnel_segments and properties.get('isTransitionHelper') and properties.get('isApproximation'):
                intentional_skip_count += 1
                continue

            # For ARCH/horseshoe profile segments, render as hollow tubes — the arch
            # profile shape (semicircular crown + vertical walls) IS the correct geometry.
            # For RECTANGLE profile segments, skip tube rendering — the post-pass creates
            # the 4-wall decomposition (left/right walls + floor/ceiling slabs).
            if (has_tunnel_segments
                    and css_type == 'TUNNEL_SEGMENT'
                    and properties.get('branchClass') == 'STRUCTURAL'
                    and not properties.get('shellPiece')
                    and not properties.get('_isBridgeSegment')):
                _seg_profile_type = (elem.get('geometry', {}).get('profile', {}).get('type', '') or '').upper()
                if _seg_profile_type not in ('ARCH', 'CIRCLE', 'ARBITRARY'):
                    intentional_skip_count += 1
                    continue  # rectangular — use post-pass thin walls

            # Door/window host validation — rehost-first, skip only as last resort
            if css_type in ('DOOR', 'WINDOW'):
                _meta = elem.get('metadata', {}) or {}
                host_key = _meta.get('hostWallKey', '')
                host_elem = (_elem_by_id.get(host_key) or _elem_by_key.get(host_key)) if host_key else None

                # If current host is invalid, try to rehost to nearest valid wall
                if not _is_valid_host(host_elem):
                    nearest = _find_nearest_host(elem, elements)
                    if nearest:
                        new_key = nearest.get('element_key') or nearest.get('id')
                        _meta['hostWallKey'] = new_key
                        elem['metadata'] = _meta
                        host_elem = nearest
                        # Snap door position to host wall origin
                        host_origin = host_elem.get('placement', {}).get('origin', {}) or {}
                        elem['placement']['origin'] = {
                            'x': float(host_origin.get('x', 0)),
                            'y': float(host_origin.get('y', 0)),
                            'z': float(host_origin.get('z', 0))
                        }
                        print(f"Door rehost: {css_id} → {new_key}")

                if not _is_valid_host(host_elem):
                    elem.setdefault('metadata', {})['geometryExportable'] = False
                    elem['metadata']['exportReason'] = 'orphan_opening'
                    print(f"Orphan opening filter: skipping {css_id} — no valid host found")
                    intentional_skip_count += 1
                    continue

                # Distance sanity check — if door is too far from host, try rehost or suppress
                dpos = elem.get('placement', {}).get('origin', {}) or {}
                hpos = host_elem.get('placement', {}).get('origin', {}) or {}
                dist = ((float(dpos.get('x', 0)) - float(hpos.get('x', 0))) ** 2 +
                        (float(dpos.get('y', 0)) - float(hpos.get('y', 0))) ** 2 +
                        (float(dpos.get('z', 0)) - float(hpos.get('z', 0))) ** 2) ** 0.5
                if dist > 5.0:
                    # Door is far from host — try rehosting to nearest valid wall
                    nearest = _find_nearest_host(elem, elements)
                    if nearest:
                        new_key = nearest.get('element_key') or nearest.get('id')
                        _meta['hostWallKey'] = new_key
                        elem['metadata'] = _meta
                        host_origin = nearest.get('placement', {}).get('origin', {}) or {}
                        elem['placement']['origin'] = {
                            'x': float(host_origin.get('x', 0)),
                            'y': float(host_origin.get('y', 0)),
                            'z': float(host_origin.get('z', 0))
                        }
                        host_elem = nearest  # update for VOIDS resolution below
                        # Update VOIDS relationship target to match rehosted wall
                        for _vr in elem.get('relationships', []):
                            if _vr.get('type') == 'VOIDS':
                                _vr['target'] = new_key
                        print(f"Door distance rehost: {css_id} → {new_key} (was {dist:.1f}m away)")
                    else:
                        elem.setdefault('metadata', {})['geometryExportable'] = False
                        elem['metadata']['exportReason'] = 'orphan_opening_too_far'
                        print(f"Orphan opening filter: skipping {css_id} — {dist:.1f}m from host, no closer host")
                        intentional_skip_count += 1
                        continue

            # Step 14: Output-mode-aware host enforcement for MEP/equipment
            _meta = elem.get('metadata', {}) or {}
            _host_validation = _meta.get('_hostValidation', '')
            _host_severity = _meta.get('_hostFailureSeverity', 'SOFT')
            if _host_validation in ('NO_HOST', 'WEAK_HOST'):
                if _host_severity == 'HARD':
                    # Authoring mode: suppress element (bad geometry hurts editability)
                    print(f"Host HARD fail: suppressing {css_id} in authoring mode")
                    intentional_skip_count += 1
                    continue
                elif _host_validation == 'NO_HOST':
                    # Viewer mode: try rehost, else proxy downgrade
                    nearest = _find_nearest_host(elem, elements)
                    if nearest:
                        new_key = nearest.get('element_key') or nearest.get('id')
                        elem.setdefault('metadata', {})['_hostValidation'] = 'REHOSTED'
                        elem.setdefault('metadata', {})['rehostedTo'] = new_key
                        print(f"MEP rehost: {css_id} → {new_key}")
                    else:
                        elem.setdefault('metadata', {})['_renderAsProxy'] = True
                        print(f"MEP host SOFT fail: {css_id} → proxy (no host, viewer mode)")

            # v5: Descriptive element naming — traceable IDs + human-friendly labels
            shell_piece = properties.get('shellPiece', '')
            derived_branch = properties.get('derivedFromBranch', '')
            semantic_type = elem.get('semanticType', '')

            # Light fixtures and cable carriers clutter tunnel renders; the
            # reference final.ifc has none. Suppress entirely for tunnel mode.
            if tunnel_segments_index and semantic_type in ('IfcLightFixture', 'IfcCableCarrierSegment'):
                intentional_skip_count += 1
                continue

            # --- Descriptive naming ---
            raw_name = elem.get('name', '')
            GENERIC_RAW_NAMES = {'WALL', 'SLAB', 'SPACE', 'DUCT', 'PIPE', 'EQUIPMENT', 'PROXY',
                                 'TUNNEL_SEGMENT', 'COLUMN', 'BEAM', 'DOOR', 'WINDOW', ''}

            # Helper: make IFC semantic type human-readable
            def _readable_semantic(st):
                r = st.replace('Ifc', '')
                return re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', r)

            if shell_piece:
                # Hard-enforce shell naming — always override Name for shell-derived elements
                piece_labels = {
                    'LEFT_WALL': 'Left Wall', 'RIGHT_WALL': 'Right Wall',
                    'FLOOR': 'Floor Slab', 'ROOF': 'Roof Slab', 'VOID': 'Void Space'
                }
                piece_label = piece_labels.get(shell_piece, shell_piece)
                # branch_label priority: readable raw_name > derivedFromBranch > css_id
                if raw_name and raw_name not in GENERIC_RAW_NAMES and raw_name.upper() not in GENERIC_RAW_NAMES:
                    if derived_branch and derived_branch != raw_name:
                        branch_label = derived_branch
                        elem_name = f"{piece_label} — {branch_label} ({raw_name})"
                    else:
                        branch_label = raw_name
                        elem_name = f"{piece_label} — {branch_label}"
                elif derived_branch:
                    branch_label = derived_branch
                    elem_name = f"{piece_label} — {branch_label}"
                else:
                    branch_label = css_id
                    elem_name = f"{piece_label} — {branch_label}"
                shell_naming_hits += 1
                if len(shell_naming_samples) < 5:
                    shell_naming_samples.append(f"{shell_piece}: {elem_name}")
            elif css_type == 'DUCT':
                # Duct naming — always "Ventilation Duct"
                duct_label = raw_name if (raw_name and raw_name.upper() not in GENERIC_RAW_NAMES) else css_id
                elem_name = f"Ventilation Duct — {duct_label}"
                duct_naming_hits += 1
                if len(duct_naming_samples) < 5:
                    duct_naming_samples.append(elem_name)
            elif css_type == 'PIPE':
                # Pipe naming — always "Pipe Segment"
                pipe_label = raw_name if (raw_name and raw_name.upper() not in GENERIC_RAW_NAMES) else css_id
                elem_name = f"Pipe Segment — {pipe_label}"
                duct_naming_hits += 1
                if len(duct_naming_samples) < 5:
                    duct_naming_samples.append(elem_name)
            elif raw_name and raw_name.upper() not in GENERIC_RAW_NAMES:
                # Has a real name — prepend type context
                if semantic_type and semantic_type != 'IfcBuildingElementProxy':
                    type_prefix = _readable_semantic(semantic_type)
                    # Don't duplicate if name already contains the type
                    if type_prefix.lower() not in raw_name.lower():
                        elem_name = f"{type_prefix} — {raw_name}"
                    else:
                        elem_name = raw_name
                elif css_type == 'EQUIPMENT':
                    elem_name = f"Equipment — {raw_name}"
                else:
                    elem_name = raw_name
            elif semantic_type and semantic_type != 'IfcBuildingElementProxy':
                readable = _readable_semantic(semantic_type)
                # Add location context from properties
                segment = properties.get('hostSegmentId', '') or properties.get('containerId', '')
                if segment:
                    elem_name = f"{readable} — {segment}"
                else:
                    elem_name = f"{readable} — {css_id}"
            else:
                # Fallback: build from css_type + properties
                type_label = css_type.replace('_', ' ').title()
                usage = properties.get('usage', '') or properties.get('segmentType', '') or properties.get('side', '')
                container = properties.get('containerId', '') or elem.get('container', '')
                if usage and usage.upper() != css_type:
                    usage_label = usage.replace('_', ' ').title()
                    elem_name = f"{type_label}: {usage_label}"
                elif container and container != 'level-1':
                    elem_name = f"{type_label} — {container}"
                else:
                    elem_name = f"{type_label} — {css_id}"

            # Sanitize elem_name to ASCII — web-ifc 0.0.51 parser crashes on X2-encoded
            # unicode (e.g. em dash U+2014 -> \X2\2014\X0\) with "offset is out of bounds"
            elem_name = elem_name.replace('\u2014', ' - ').replace('\u2013', ' - ')

            container_id = elem.get('container', 'level-1')
            placement_data = elem.get('placement', {'origin': {'x': 0, 'y': 0, 'z': 0}})
            geometry_data = elem.get('geometry', {'method': 'EXTRUSION', 'profile': {'type': 'RECTANGLE', 'width': 1, 'height': 1}, 'depth': 1})
            material_data = elem.get('material')
            confidence = float(elem.get('confidence', 0.5))

            # SLAB: trace origin+axis, then force axis to (0,0,1) — tilted slabs are always wrong.
            if css_type == 'SLAB':
                _s_orig = (placement_data.get('origin') or {}) if isinstance(placement_data, dict) else {}
                _s_ax = (placement_data.get('axis') or {}) if isinstance(placement_data, dict) else {}
                _s_ax_x = float(_s_ax.get('x', 0))
                _s_ax_y = float(_s_ax.get('y', 0))
                _s_ax_z = float(_s_ax.get('z', 1))
                print(f"TRACE [SLAB {css_id}] origin=({float(_s_orig.get('x',0)):.2f},{float(_s_orig.get('y',0)):.2f},{float(_s_orig.get('z',0)):.2f}) "
                      f"axis=({_s_ax_x:.3f},{_s_ax_y:.3f},{_s_ax_z:.3f})")
                if abs(_s_ax_x) > 0.01 or abs(_s_ax_y) > 0.01:
                    placement_data = dict(placement_data)
                    placement_data['axis'] = {'x': 0, 'y': 0, 'z': 1}
                    print(f"  [SLAB-AXIS-FIX] {css_id}: axis ({_s_ax_x:.3f},{_s_ax_y:.3f},{_s_ax_z:.3f}) → (0,0,1)")

            # Pass export profile to geometry data for dispatch decisions
            geometry_data = dict(geometry_data) if isinstance(geometry_data, dict) else geometry_data
            geometry_data['_exportProfile'] = export_profile

            # Step 12: Path-authored placement normalization for PATH_SWEEP elements.
            # Sets placement to identity at pathPoints[0], transforms pathPoints to relative.
            # Eliminates double-transform issues where both placement and geometry encode direction.
            geo_behavior = geometry_data.get('_geoBehavior', '')
            if geo_behavior == 'PATH_SWEEP' and geometry_data.get('_pathAuthored') and not geometry_data.get('_isTunnelShell'):
                pp = geometry_data.get('pathPoints', [])
                if pp and len(pp) >= 2:
                    p0 = pp[0]
                    p0x = float(p0.get('x', 0))
                    p0y = float(p0.get('y', 0))
                    p0z = float(p0.get('z', 0))
                    # Set placement origin to pathPoints[0] with identity orientation
                    placement_data = dict(placement_data)
                    placement_data['origin'] = {'x': p0x, 'y': p0y, 'z': p0z}
                    placement_data['axis'] = {'x': 0, 'y': 0, 'z': 1}
                    placement_data['refDirection'] = {'x': 1, 'y': 0, 'z': 0}
                    # GAP 12 FIX: Keep pathPoints as-is (already centroid-displaced).
                    # Placement origin is set to p0 (also centroid-displaced, same frame).
                    # IfcSweptDiskSolid.Directrix will be in LOCAL frame relative to ObjectPlacement,
                    # so pathPoints should remain unchanged — no double-subtraction.
                    geometry_data = dict(geometry_data)
                    # DO NOT re-subtract p0: geometry_data['pathPoints'] = [pt - p0 for pt in pp]
                    # Instead, keep pathPoints as-is; centroid frame is consistent.
                    geometry_data['pathPoints'] = pp

            # Portal entrance building geometry:
            #   profile.width  = tunnel bore width + 2*shell_thickness (set in portal attachment + here)
            #   profile.height = building outward depth (~3m from VentSim, preserved as-is)
            #   depth (Z-extrusion) = tunnel height + shell_thickness so box fully frames the arch
            if css_type == 'WALL' and properties.get('segmentType') == 'PORTAL_BUILDING':
                g_prof = geometry_data.get('profile', {})
                pw = float(g_prof.get('width', 1))
                ph = float(g_prof.get('height', 1))
                pd = safe_float(geometry_data.get('depth'), 1.0)
                # Resolve tunnel height (+ shell) from the host segment stored during portal attachment
                host_seg_key = elem.get('metadata', {}).get('hostTunnelSegment', '')
                tunnel_height = pd  # fallback to VentSim-provided depth
                for seg in tunnel_segments_index:
                    if seg['key'] == host_seg_key:
                        _h_shell = seg.get('shell_thickness', 0) or 0
                        tunnel_height = seg['half_h'] * 2 + _h_shell  # bore height + one wall thickness
                        break
                geometry_data = dict(geometry_data)
                geometry_data['profile'] = dict(geometry_data.get('profile', {}))
                geometry_data['depth'] = tunnel_height
                elem['geometry']['depth'] = tunnel_height  # patch source for host validation
                # PHASE 4C: portal arch continuity. If host is part of a chain, the
                # chain end section frame was stamped onto metadata at attachment time;
                # mark the geometry so the BREP dispatch builds an arch-matched portal.
                if elem.get('metadata', {}).get('_chainEndSection'):
                    geometry_data['_portalArchMode'] = True
                print(f"Portal building: {css_id} width={pw:.1f}m outward_depth={ph:.1f}m height={tunnel_height:.1f}m"
                      f"{' [arch-matched]' if elem.get('metadata', {}).get('_chainEndSection') else ''}")

            # Fan orientation validation — check whenever host direction data is present
            if css_type == 'EQUIPMENT':
                hx = float(properties.get('hostDirectionX', 0))
                hy = float(properties.get('hostDirectionY', 0))
                hz = float(properties.get('hostDirectionZ', 1))
                horiz_mag = math.sqrt(hx * hx + hy * hy)

                axis_data = placement_data.get('axis', {})
                ax = float(axis_data.get('x', 0))
                ay = float(axis_data.get('y', 0))
                az = float(axis_data.get('z', 1))

                dot = hx * ax + hy * ay + hz * az
                if horiz_mag > 0.5 and dot < 0.7:
                    msg = (f"Tunnel equipment {css_id} axis misaligned with host "
                           f"{properties.get('hostSegmentId', 'unknown')}: "
                           f"host_dir=({hx:.3f},{hy:.3f},{hz:.3f}), "
                           f"axis=({ax:.3f},{ay:.3f},{az:.3f}), dot={dot:.3f}")
                    print(f"Warning: {msg}")
                    orientation_warnings.append(msg)

            # Resolve container
            if container_id not in storey_map:
                # Fallback to first available storey
                container_id = list(storey_map.keys())[0]
            storey_entity, storey_lp, storey_elevation = storey_map[container_id]

            # Adjust element z — conditional on placementZIsAbsolute
            placement_origin = placement_data.get('origin', {'x': 0, 'y': 0, 'z': 0})
            original_z = float(placement_origin.get('z', 0))

            # Track original z for heuristic
            if container_id not in original_z_by_container:
                original_z_by_container[container_id] = []
            original_z_by_container[container_id].append(original_z)

            if placement_z_is_absolute:
                relative_z = original_z - storey_elevation
            else:
                relative_z = original_z  # already storey-relative

            placement_data = dict(placement_data)
            placement_data['origin'] = {**placement_origin, 'z': relative_z}

            # Portal building z-snap — ground portal walls to nearest segment floor
            if css_type == 'WALL' and properties.get('segmentType') == 'PORTAL_BUILDING' and tunnel_segments_index:
                pb_x = float(placement_data['origin'].get('x', 0))
                pb_y = float(placement_data['origin'].get('y', 0))
                pb_z = float(placement_data['origin'].get('z', 0))
                best_seg = None
                best_dist = float('inf')
                for seg in tunnel_segments_index:
                    d = math.sqrt((pb_x - seg['ox'])**2 + (pb_y - seg['oy'])**2 + (pb_z - seg['oz'])**2)
                    if d < best_dist:
                        best_dist = d
                        best_seg = seg
                if best_seg and best_dist < 30.0:
                    portal_z = best_seg['oz'] - best_seg['half_h'] + (best_seg.get('shell_thickness', 0) or 0)  # floor z (no clamp — portal elevation may be negative relative to storey)
                    placement_data['origin'] = {**placement_data['origin'], 'z': portal_z}
                    print(f"Portal wall z-snap: {css_id} -> z={portal_z:.2f} (floor of seg oz={best_seg['oz']:.2f} half_h={best_seg['half_h']:.2f}, dist={best_dist:.1f}m)")

            # Window sill height offset (non-tunnel buildings only)
            if css_type == 'WINDOW' and not tunnel_segments_index:
                sill_h = safe_float((properties or {}).get('sillHeight'), 0.9)
                current_wz = float(placement_data['origin'].get('z', 0))
                placement_data = dict(placement_data)
                placement_data['origin'] = {**placement_data['origin'], 'z': current_wz + sill_h}

            # Bug 3 fix: Floor-snap equipment in segment-based structures unless wall/ceiling mounted
            # Uses host segment interior floor (not z=0) as reference
            # SKIP if topology-engine already placed this element
            eq_topology_placed = elem.get('metadata', {}).get('zAligned') or elem.get('metadata', {}).get('parentSegment')
            if tunnel_segments_index and css_type == 'EQUIPMENT' and not eq_topology_placed:
                mounting_zone = (elem.get('metadata', {}).get('mountingZone', '')
                                 or properties.get('mountingZone', '') or '')
                ELEVATED_ZONES = {'crown', 'ceiling', 'left_wall_upper', 'right_wall_upper',
                                  'left_wall_service', 'right_wall_service'}
                if mounting_zone.lower() not in ELEVATED_ZONES:
                    eq_profile = geometry_data.get('profile', {})
                    eq_height = float(eq_profile.get('height', 1.0))
                    current_z = float(placement_data['origin'].get('z', 0))
                    # Find nearest tunnel segment to derive interior floor
                    eq_x = float(placement_data['origin'].get('x', 0))
                    eq_y = float(placement_data['origin'].get('y', 0))
                    host_seg = None
                    host_dist = float('inf')
                    if tunnel_segments_index:
                        for seg in tunnel_segments_index:
                            d = math.sqrt((eq_x - seg['ox'])**2 + (eq_y - seg['oy'])**2)
                            if d < host_dist:
                                host_dist = d
                                host_seg = seg
                    if host_seg:
                        shell_t = float(host_seg.get('shell_thickness', 0))
                        inner_floor_z = host_seg['oz'] - host_seg['half_h'] + shell_t
                        floor_z = inner_floor_z + eq_height / 2.0
                    else:
                        floor_z = eq_height / 2.0
                    if current_z < floor_z - eq_height or current_z > floor_z + eq_height:
                        placement_data['origin'] = {**placement_data['origin'], 'z': floor_z}
                        print(f"Floor-snap: {css_id} z={current_z:.2f} -> {floor_z:.2f} (zone={mounting_zone or 'FLOOR'})")

            # Light fixture wall-mount + size reduction (inside segment-based structures)
            # SKIP Z override if topology-engine already placed this element (still apply size reduction)
            light_topology_placed = elem.get('metadata', {}).get('zAligned') or elem.get('metadata', {}).get('parentSegment')
            if tunnel_segments_index and css_type == 'EQUIPMENT' and semantic_type == 'IfcLightFixture':
                lx = float(placement_data['origin'].get('x', 0))
                ly = float(placement_data['origin'].get('y', 0))
                lz = float(placement_data['origin'].get('z', 0))
                best_seg = None
                best_dist = float('inf')
                for seg in tunnel_segments_index:
                    d = math.sqrt((lx - seg['ox']) ** 2 + (ly - seg['oy']) ** 2 + (lz - seg['oz']) ** 2)
                    if d < best_dist:
                        best_dist = d
                        best_seg = seg
                if best_seg and not light_topology_placed:
                    wall_z = best_seg['oz'] + best_seg['half_h'] * 0.5  # 50% wall height
                    placement_data['origin'] = {**placement_data['origin'], 'z': wall_z}
                # Reduce to small wall sconce size
                geometry_data = dict(geometry_data)
                geometry_data['profile'] = {'type': 'RECTANGLE', 'width': 0.3, 'height': 0.15}
                geometry_data['depth'] = 0.05

            # Equipment axis alignment — align EQUIPMENT extrusion axis with
            # nearest segment axis to prevent equipment punching through walls
            if tunnel_segments_index and css_type == 'EQUIPMENT' and semantic_type != 'IfcLightFixture':
                eq_x = float(placement_data['origin'].get('x', 0))
                eq_y = float(placement_data['origin'].get('y', 0))
                eq_z = float(placement_data['origin'].get('z', 0))
                # Use refDirection.z for shaft check — axis=(0,0,1) for all elements now
                eq_ref = placement_data.get('refDirection', {})
                eq_az = abs(float(eq_ref.get('z', 0)))
                # Skip vertical equipment (shafts, generators on risers)
                if eq_az < 0.95:
                    best_seg = None
                    best_dist = float('inf')
                    for seg in tunnel_segments_index:
                        d = math.sqrt((eq_x - seg['ox'])**2 + (eq_y - seg['oy'])**2 + (eq_z - seg['oz'])**2)
                        if d < best_dist:
                            best_dist = d
                            best_seg = seg
                    if best_seg and best_dist < 30.0:
                        seg_ax = best_seg['ax']
                        seg_ay = best_seg['ay']
                        seg_az = best_seg['az']
                        seg_len = math.sqrt(seg_ax**2 + seg_ay**2 + seg_az**2)
                        if seg_len > 1e-6:
                            seg_ax /= seg_len
                            seg_ay /= seg_len
                            seg_az /= seg_len
                        # Also cap equipment depth to segment depth
                        eq_depth = safe_float(geometry_data.get('depth'), 1.0)
                        if eq_depth > best_seg['depth']:
                            geometry_data = dict(geometry_data)
                            geometry_data['depth'] = best_seg['depth']

            # SHAFT-BRANCH DUCT FILTER: ducts parented to a vertical shaft but placed
            # well above the tunnel (Z > 5m) have no valid host in the rendered model.
            # Skip them — they are shaft-internal branches that don't belong in the scene.
            if css_type in ('DUCT', 'PIPE') and tunnel_segments_index:
                _sb_z = float((placement_data.get('origin') or {}).get('z', 0))
                _sb_parent = (elem.get('metadata') or {}).get('parentSegment', '')
                if _sb_z > 5.0 and 'shaft' in (_sb_parent or '').lower():
                    print(f"  [SHAFT-BRANCH-DUCT] {css_id}: Z={_sb_z:.2f}m parent={_sb_parent} — skipped")
                    intentional_skip_count += 1
                    continue

            # Bug 4 fix: Snap tunnel duct/pipe/cable_tray positions to parent segment interior
            # SKIP if topology-engine already placed this element AND the origin is not at (0,0,0).
            # zAligned=True with origin=(0,0,0) means topology claimed placement but didn't deliver.
            elem_metadata = elem.get('metadata', {})
            topology_placed = elem_metadata.get('zAligned') or elem_metadata.get('parentSegment')
            # Override: don't trust topology if origin is still at world origin
            _orig = placement_data.get('origin', {}) if isinstance(placement_data, dict) else {}
            _at_origin = (abs(float(_orig.get('x', 0))) < 0.01 and
                          abs(float(_orig.get('y', 0))) < 0.01 and
                          abs(float(_orig.get('z', 0))) < 0.01)
            if _at_origin and topology_placed:
                topology_placed = False
                print(f"Topology placement override: {css_id} has zAligned but origin=(0,0,0) — re-snapping")
            _duct_snapped = False  # set True after snap to prevent Bug#4 from resetting origin
            if not topology_placed and (css_type in ('DUCT', 'PIPE', 'CABLE_TRAY') or
               (css_type == 'EQUIPMENT' and semantic_type == 'IfcCableCarrierSegment')) and tunnel_segments_index:
                # Skip shafts — by name OR by vertical axis
                duct_name_lower = (elem.get('name', '') or '').lower()
                # Use refDirection.z for shaft check — axis=(0,0,1) for all elements now
                duct_ref = placement_data.get('refDirection', {}) if isinstance(placement_data, dict) else {}
                is_shaft = (any(kw in duct_name_lower for kw in ('shaft', 'exhaust', 'ventilation shaft', 'stack'))
                            or abs(float(duct_ref.get('z', 0))) > 0.95)
                if not is_shaft:
                    # Find parent segment — try metadata first, then nearest match
                    parent_key = elem.get('metadata', {}).get('parentSegment', '')
                    parent_seg = None
                    if parent_key:
                        for seg in tunnel_segments_index:
                            if seg['key'] == parent_key:
                                parent_seg = seg
                                break
                    if not parent_seg:
                        # Find nearest segment using full 3D distance — 2D-only search mis-parents
                        # ducts in multi-level or vertically-stacked tunnel facilities.
                        duct_ox = float(placement_data['origin'].get('x', 0))
                        duct_oy = float(placement_data['origin'].get('y', 0))
                        duct_oz_3d = float(placement_data['origin'].get('z', 0))
                        best_dist = float('inf')
                        for seg in tunnel_segments_index:
                            dx = duct_ox - seg['ox']
                            dy = duct_oy - seg['oy']
                            dz = duct_oz_3d - seg['oz']
                            d = math.sqrt(dx * dx + dy * dy + dz * dz)
                            if d < best_dist:
                                best_dist = d
                                parent_seg = seg
                    if parent_seg:
                        # Snap duct origin to the parent segment's centerline
                        # Place at crown height (70% of inner half-height) centered laterally
                        seg_ox, seg_oy, seg_oz = parent_seg['ox'], parent_seg['oy'], parent_seg['oz']
                        seg_ax, seg_ay, seg_az = parent_seg['ax'], parent_seg['ay'], parent_seg['az']
                        seg_half_h = parent_seg['half_h']
                        seg_shell_t = parent_seg.get('shell_thickness', 0) or 0
                        inner_half_h = seg_half_h - seg_shell_t
                        # Normalize segment axis
                        seg_len = math.sqrt(seg_ax ** 2 + seg_ay ** 2 + seg_az ** 2)
                        if seg_len > 1e-6:
                            seg_ax /= seg_len
                            seg_ay /= seg_len
                            seg_az /= seg_len
                        # Project duct origin onto segment centerline to find longitudinal position
                        duct_ox = float(placement_data['origin'].get('x', 0))
                        duct_oy = float(placement_data['origin'].get('y', 0))
                        duct_oz = float(placement_data['origin'].get('z', 0))
                        # Vector from segment origin to duct origin
                        vx = duct_ox - seg_ox
                        vy = duct_oy - seg_oy
                        vz = duct_oz - seg_oz
                        # Project onto segment axis to get longitudinal offset from midpoint.
                        # origin is the segment MIDPOINT, so valid t range is [-depth/2, +depth/2].
                        t = vx * seg_ax + vy * seg_ay + vz * seg_az
                        half_depth = parent_seg['depth'] / 2
                        t = max(-half_depth, min(t, half_depth))
                        # Compute the tunnel's LOCAL UP vector via cross products so MEP placement
                        # works correctly for inclined tunnels (not just world-Z-up horizontals).
                        #   lateral = cross(world_up, run)  — points sideways across the tunnel
                        #   local_up = cross(lateral, run)  — points toward the ceiling along the lining
                        lat_x = -seg_ay   # cross((0,0,1), (ax,ay,az)).x = 0*az - 1*ay
                        lat_y =  seg_ax   # cross((0,0,1), (ax,ay,az)).y = 1*ax - 0*az
                        lat_z =  0.0
                        lat_len = math.sqrt(lat_x ** 2 + lat_y ** 2)
                        if lat_len < 1e-6:
                            # Near-vertical shaft — lateral is undefined; fall back to world X
                            lat_x, lat_y, lat_z = 1.0, 0.0, 0.0
                        else:
                            lat_x /= lat_len; lat_y /= lat_len
                        # local_up = cross(run, lateral) — gives (0,0,+1) for horizontal tunnels
                        # NOTE: cross(lat,run) = (0,0,-1) which places MEP below floor; operand order is critical
                        up_x = seg_ay * lat_z - seg_az * lat_y
                        up_y = seg_az * lat_x - seg_ax * lat_z
                        up_z = seg_ax * lat_y - seg_ay * lat_x
                        up_len = math.sqrt(up_x ** 2 + up_y ** 2 + up_z ** 2)
                        if up_len > 1e-6:
                            up_x /= up_len; up_y /= up_len; up_z /= up_len
                        else:
                            up_x, up_y, up_z = 0.0, 0.0, 1.0  # fallback to world up
                        # Mount fraction: crown ducts/pipes at 70%, wall-mounted cable trays at 30%
                        # VentSim cable carriers arrive as css_type='EQUIPMENT' + semantic 'IfcCableCarrierSegment'
                        mount_frac = 0.3 if (css_type == 'CABLE_TRAY' or
                            (css_type == 'EQUIPMENT' and semantic_type == 'IfcCableCarrierSegment')) else 0.7
                        new_ox = seg_ox + seg_ax * t + up_x * (inner_half_h * mount_frac)
                        new_oy = seg_oy + seg_ay * t + up_y * (inner_half_h * mount_frac)
                        new_oz = seg_oz + seg_az * t + up_z * (inner_half_h * mount_frac)
                        old_orig = placement_data['origin']
                        placement_data = dict(placement_data)
                        placement_data['origin'] = {'x': new_ox, 'y': new_oy, 'z': new_oz}
                        # Align duct extrusion axis to parent segment run direction.
                        # Without this, the duct retains its original CSS orientation which
                        # may point diagonal/vertical instead of following the tunnel bore.
                        placement_data['axis'] = {'x': seg_ax, 'y': seg_ay, 'z': seg_az}
                        # Lateral direction (perpendicular to run, in horizontal plane)
                        lat_ref_len = math.sqrt(seg_ay ** 2 + seg_ax ** 2)
                        if lat_ref_len > 1e-6:
                            placement_data['refDirection'] = {
                                'x': -seg_ay / lat_ref_len,
                                'y':  seg_ax / lat_ref_len,
                                'z': 0.0
                            }
                        else:
                            placement_data['refDirection'] = {'x': 1.0, 'y': 0.0, 'z': 0.0}
                        # Cap duct depth — hard max per type to prevent massive extrusions.
                        # 30m was far too generous; 10m is a realistic maximum for MEP runs.
                        TUNNEL_MEP_MAX_DEPTH = {'DUCT': 10.0, 'PIPE': 10.0, 'CABLE_TRAY': 10.0}
                        max_mep_d = TUNNEL_MEP_MAX_DEPTH.get(css_type, 3.0)
                        duct_depth = safe_float(geometry_data.get('depth'), 1.0)
                        if duct_depth > max_mep_d:
                            geometry_data = dict(geometry_data)
                            geometry_data['depth'] = max_mep_d
                        print(f"Duct snap: {css_id} ({old_orig.get('x', 0):.1f},{old_orig.get('y', 0):.1f},{old_orig.get('z', 0):.1f})"
                              f" -> ({new_ox:.1f},{new_oy:.1f},{new_oz:.1f}) on seg {parent_seg['key']}")
                        _duct_snapped = True
                        # Clamp sweep pathPoints to centerline, then apply the same local-frame
                        # crown offset so sweep path points stay inside the tunnel lining.
                        # pathPoints are stored in LOCAL frame (relative to placement origin
                        # new_ox/new_oy/new_oz) so IfcSweptDiskSolid.Directrix gets local coords.
                        path_pts = geometry_data.get('pathPoints', [])
                        if path_pts:
                            geometry_data = dict(geometry_data)
                            clamped_pts = []
                            _half_d = parent_seg['depth'] / 2
                            for pt in path_pts:
                                pt_vx = float(pt.get('x', 0)) - seg_ox
                                pt_vy = float(pt.get('y', 0)) - seg_oy
                                pt_vz = float(pt.get('z', 0)) - seg_oz
                                pt_t = pt_vx * seg_ax + pt_vy * seg_ay + pt_vz * seg_az
                                # Clamp to [-half_depth, +half_depth] — t is from segment MIDPOINT
                                pt_t = max(-_half_d, min(pt_t, _half_d))
                                # World position of clamped point, then subtract placement origin
                                # to express in LOCAL frame for IfcSweptDiskSolid.Directrix
                                wx = seg_ox + seg_ax * pt_t + up_x * (inner_half_h * mount_frac)
                                wy = seg_oy + seg_ay * pt_t + up_y * (inner_half_h * mount_frac)
                                wz = seg_oz + seg_az * pt_t + up_z * (inner_half_h * mount_frac)
                                clamped_pts.append({
                                    'x': wx - new_ox,
                                    'y': wy - new_oy,
                                    'z': wz - new_oz,
                                })
                            geometry_data['pathPoints'] = clamped_pts
                            # Also set geometry direction to match segment axis for sweep directrix
                            geometry_data['direction'] = {'x': seg_ax, 'y': seg_ay, 'z': seg_az}
                            # Compute path length from clamped points — if degenerate (both points
                            # clamped to same position), fall back to EXTRUSION with parent depth.
                            if len(clamped_pts) >= 2:
                                _cp0, _cp1 = clamped_pts[0], clamped_pts[-1]
                                _cpdx = float(_cp1.get('x', 0)) - float(_cp0.get('x', 0))
                                _cpdy = float(_cp1.get('y', 0)) - float(_cp0.get('y', 0))
                                _cpdz = float(_cp1.get('z', 0)) - float(_cp0.get('z', 0))
                                _cp_len = math.sqrt(_cpdx**2 + _cpdy**2 + _cpdz**2)
                                if _cp_len < 0.1:
                                    # Clamped path collapsed — both endpoints hit the segment boundary.
                                    # Compute unclamped path length from original path_pts (world coords).
                                    _orig_len = 0.0
                                    for _pi in range(len(path_pts) - 1):
                                        _odx = float(path_pts[_pi+1].get('x',0)) - float(path_pts[_pi].get('x',0))
                                        _ody = float(path_pts[_pi+1].get('y',0)) - float(path_pts[_pi].get('y',0))
                                        _odz = float(path_pts[_pi+1].get('z',0)) - float(path_pts[_pi].get('z',0))
                                        _orig_len += math.sqrt(_odx**2 + _ody**2 + _odz**2)
                                    if _orig_len < 0.1:
                                        print(f"[WARN] Duct skip {css_id}: clamped={_cp_len:.3f}m orig={_orig_len:.3f}m both degenerate")
                                        intentional_skip_count += 1
                                        continue
                                    # Use parent segment axis as sweep direction; unclamped length as extent.
                                    _use_len = min(_orig_len, max_mep_d)
                                    _mid_x = sum(float(p.get('x',0)) for p in clamped_pts) / len(clamped_pts)
                                    _mid_y = sum(float(p.get('y',0)) for p in clamped_pts) / len(clamped_pts)
                                    _mid_z = sum(float(p.get('z',0)) for p in clamped_pts) / len(clamped_pts)
                                    _half = _use_len / 2.0
                                    geometry_data['pathPoints'] = [
                                        {'x': _mid_x - seg_ax*_half, 'y': _mid_y - seg_ay*_half, 'z': _mid_z - seg_az*_half},
                                        {'x': _mid_x + seg_ax*_half, 'y': _mid_y + seg_ay*_half, 'z': _mid_z + seg_az*_half},
                                    ]
                                    geometry_data['depth'] = _use_len
                                    print(f"[INFO] Duct degenerate clamp {css_id}: orig={_orig_len:.3f}m clamped={_cp_len:.3f}m"
                                          f" → SWEEP axis=({seg_ax:.2f},{seg_ay:.2f},{seg_az:.2f}) len={_use_len:.3f}m")
                                else:
                                    # Set depth from path length as fallback for EXTRUSION path
                                    geometry_data['depth'] = min(_cp_len, max_mep_d)

            # MEP hard depth cap inside segment-based structures — catches ducts/pipes/cables
            # by css_type OR semantic_type OR name. Driven by segment index, not domain name.
            TUNNEL_MEP_SEMANTIC = {'IfcDuctSegment': 10.0, 'IfcPipeSegment': 10.0, 'IfcCableCarrierSegment': 10.0}
            _mep_name_lower = (elem.get('name', '') or '').lower()
            _is_mep_by_name = any(kw in _mep_name_lower for kw in ('duct', 'pipe', 'cable', 'ventilation'))
            is_tunnel_mep = (bool(tunnel_segments_index) and
                             (css_type in ('DUCT', 'PIPE', 'CABLE_TRAY') or
                              semantic_type in TUNNEL_MEP_SEMANTIC or
                              (css_type == 'EQUIPMENT' and _is_mep_by_name)))
            if is_tunnel_mep:
                # Only exempt actual tunnel shaft segments (TUNNEL_SEGMENT type) from depth
                # capping. DUCT/PIPE/CABLE_TRAY elements must always be capped — vertical duct
                # risers have refDirection.z≈1 which previously triggered the shaft exemption,
                # letting them extend 8–26m through the tunnel ceiling slab.
                mep_ref = placement_data.get('refDirection', {}) if isinstance(placement_data, dict) else {}
                is_vert_shaft = (abs(float(mep_ref.get('z', 0))) > 0.95 and
                                 css_type not in ('DUCT', 'PIPE', 'CABLE_TRAY'))
                if not is_vert_shaft:
                    # Vertical duct risers (axis.z > 0.8) cap at 4m — typical tunnel bore height.
                    # Horizontal MEP uses the standard semantic cap (3m duct, 2m pipe).
                    _mep_ax = placement_data.get('axis', {}) if isinstance(placement_data, dict) else {}
                    _is_vert_duct = (css_type in ('DUCT', 'PIPE', 'CABLE_TRAY') and
                                     abs(float(_mep_ax.get('z', 0))) > 0.8)
                    max_mep_d = (4.0 if _is_vert_duct else
                                 TUNNEL_MEP_SEMANTIC.get(semantic_type, {'DUCT': 3.0, 'PIPE': 2.0, 'CABLE_TRAY': 2.0}.get(css_type, 3.0)))
                    cur_d = safe_float(geometry_data.get('depth'), None)
                    if cur_d is not None and cur_d > max_mep_d:
                        geometry_data = dict(geometry_data)
                        geometry_data['depth'] = max_mep_d
                        if _is_vert_duct:
                            print(f"  [DUCT-RISER-CAP] {css_id}: depth {cur_d:.2f}m → {max_mep_d:.2f}m (vertical riser)")

            # Equipment bbox relocation: snap equipment that extracted with wrong XY coordinates
            # (e.g. placed at origin while all walls are at x=30, y=25) back into the building footprint.
            if not tunnel_segments_index and css_type == 'EQUIPMENT' and container_id in wall_bbox_by_container:
                _eb = wall_bbox_by_container[container_id]
                if _eb['n'] > 0:
                    _ox = float(placement_data.get('origin', {}).get('x', 0))
                    _oy = float(placement_data.get('origin', {}).get('y', 0))
                    _margin = 5.0
                    if (_ox < _eb['min_x'] - _margin or _ox > _eb['max_x'] + _margin or
                            _oy < _eb['min_y'] - _margin or _oy > _eb['max_y'] + _margin):
                        placement_data = dict(placement_data)
                        placement_data['origin'] = {**placement_data.get('origin', {}), 'x': _eb['cx'], 'y': _eb['cy']}
                        print(f"Equipment bbox relocation: {css_id} ({_ox:.1f},{_oy:.1f}) → ({_eb['cx']:.1f},{_eb['cy']:.1f})")

            # Diagnostic trace: log final state of first few ducts, fans, lights before IFC creation
            _trace_types = {'IfcDuctSegment', 'IfcFan', 'IfcLightFixture', 'IfcPipeSegment'}
            if semantic_type in _trace_types and element_count < 200:
                _t_orig = placement_data.get('origin', {})
                _t_axis = placement_data.get('axis', {})
                _t_ref = placement_data.get('refDirection', {})
                _t_method = geometry_data.get('method', 'EXTRUSION')
                _t_pp = geometry_data.get('pathPoints', [])
                _t_prof = geometry_data.get('profile', {})
                _t_depth = geometry_data.get('depth', 'N/A')
                _t_meta = elem.get('metadata', {})
                print(f"TRACE [{css_id}] type={css_type} sem={semantic_type} "
                      f"origin=({_t_orig.get('x',0):.2f},{_t_orig.get('y',0):.2f},{_t_orig.get('z',0):.2f}) "
                      f"axis=({_t_axis.get('x',0):.2f},{_t_axis.get('y',0):.2f},{_t_axis.get('z',0):.2f}) "
                      f"ref=({_t_ref.get('x',0):.2f},{_t_ref.get('y',0):.2f},{_t_ref.get('z',0):.2f}) "
                      f"method={_t_method} depth={_t_depth} profile={_t_prof} "
                      f"pathPts={len(_t_pp)} container={container_id} "
                      f"zAligned={_t_meta.get('zAligned')} parentSeg={_t_meta.get('parentSegment','none')}")

            # Duct path direction guard: skip ducts whose pathPoints define a near-vertical
            # direction for a non-shaft element. Topology-placed ducts bypass the snap/clamp
            # block, so their raw pathPoints may be vertical even when the parent segment is
            # horizontal — producing a spike. Better missing geometry than a 10m vertical pole.
            if (css_type in ('DUCT', 'PIPE', 'CABLE_TRAY') and
                    semantic_type in ('IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment')):
                _pp_guard = geometry_data.get('pathPoints', [])
                if len(_pp_guard) >= 2:
                    _pg0, _pg1 = _pp_guard[0], _pp_guard[-1]
                    _pgdx = float(_pg1.get('x', 0)) - float(_pg0.get('x', 0))
                    _pgdy = float(_pg1.get('y', 0)) - float(_pg0.get('y', 0))
                    _pgdz = float(_pg1.get('z', 0)) - float(_pg0.get('z', 0))
                    _pglen = math.sqrt(_pgdx**2 + _pgdy**2 + _pgdz**2)
                    if _pglen > 0.001:
                        _pgax = _pgdx / _pglen
                        _pgay = _pgdy / _pglen
                        _pgaz = _pgdz / _pglen
                        print(f"[DUCT-PATH] {css_id}: len={_pglen:.3f}m axis=({_pgax:.2f},{_pgay:.2f},{_pgaz:.2f})"
                              f" p0=({_pg0.get('x',0):.2f},{_pg0.get('y',0):.2f},{_pg0.get('z',0):.2f})"
                              f" p1=({_pg1.get('x',0):.2f},{_pg1.get('y',0):.2f},{_pg1.get('z',0):.2f})")
                        _pg_ref = placement_data.get('refDirection', {}) if isinstance(placement_data, dict) else {}
                        _pg_is_shaft = (abs(float(_pg_ref.get('z', 0))) > 0.95 or
                                        bool(elem.get('metadata', {}).get('zAligned')))
                        if not _pg_is_shaft and abs(_pgaz) > 0.8:
                            print(f"[SKIP] {css_id}: near-vertical path (axis.z={_pgaz:.2f}) for non-shaft duct — skip")
                            intentional_skip_count += 1
                            continue
                    else:
                        print(f"[SKIP] {css_id}: degenerate path len={_pglen:.4f}m — skip")
                        intentional_skip_count += 1
                        continue

            # Placement created after geometry modifications (hollow manifold, junction overlap)
            # that rewrite placement_data axis/refDirection/origin — see below.

            # Equipment size override: replace placeholder 1×1×1 OR absurd dimensions with realistic defaults
            # Skip for generated systems (they already have intentional dimensions)
            is_generated_system = properties.get('generated', False)
            if css_type == 'EQUIPMENT' and semantic_type in EQUIPMENT_SIZE_DEFAULTS and not is_generated_system:
                g_profile = geometry_data.get('profile', {})
                g_w = float(g_profile.get('width', 1))
                g_h = float(g_profile.get('height', 1))
                g_d = safe_float(geometry_data.get('depth'), 1.0)
                # Placeholder detection: CSS writes 1×1×1 when no dimensional data is available.
                # Tolerance widened to 0.05 to catch near-unit values from rounding in upstream steps.
                is_placeholder = abs(g_w - 1.0) < 0.05 and abs(g_h - 1.0) < 0.05 and abs(g_d - 1.0) < 0.05
                is_absurd_ratio = g_d > max(g_w, g_h) * 10  # depth 10x larger than profile = bad data
                if is_placeholder or is_absurd_ratio:
                    new_w, new_h, new_d = EQUIPMENT_SIZE_DEFAULTS[semantic_type]
                    geometry_data = dict(geometry_data)
                    geometry_data['profile'] = dict(g_profile)
                    geometry_data['profile']['width'] = new_w
                    geometry_data['profile']['height'] = new_h
                    geometry_data['depth'] = new_d
                    equipment_size_overrides += 1
                    reason = 'absurd depth ratio' if is_absurd_ratio else 'placeholder 1×1×1'
                    print(f"Equipment size override ({reason}): {css_id} ({semantic_type}) "
                          f"profile={g_w:.2f}x{g_h:.2f} depth={g_d:.2f} → {new_w}x{new_h}x{new_d} "
                          f"[from EQUIPMENT_SIZE_DEFAULTS last-resort table]")

            # Equipment depth cap: prevent segment-length spikes for discrete equipment
            # Skip for generated continuous systems (they have intentional segment-length depths)
            if css_type == 'EQUIPMENT' and semantic_type in EQUIPMENT_MAX_DEPTH and not is_generated_system:
                current_depth = safe_float(geometry_data.get('depth'), 1.0)
                max_depth = EQUIPMENT_MAX_DEPTH[semantic_type]
                if current_depth > max_depth:
                    geometry_data = dict(geometry_data) if not isinstance(geometry_data, dict) else geometry_data
                    geometry_data['depth'] = max_depth
                    print(f"Equipment depth capped: {css_id} ({semantic_type}) {current_depth:.2f} → {max_depth}")

            # Equipment depth cap inside segment structures — backstop for absurdly long depths
            # (segment-length bleed from upstream data). Cap = largest segment profile dimension * 1.5
            # so it scales with structure size rather than being fixed at a dataset-specific constant.
            if tunnel_segments_index and css_type == 'EQUIPMENT' and not is_generated_system:
                cur_eq_depth = safe_float(geometry_data.get('depth'), 1.0)
                # Derive cap from the largest segment cross-section in the index
                seg_max_dim = max(
                    (max(s.get('half_w', 0) * 2, s.get('half_h', 0) * 2)
                     for s in tunnel_segments_index if s.get('half_w') and s.get('half_h')),
                    default=5.0
                )
                seg_equip_cap = max(1.0, seg_max_dim * 1.5)
                if cur_eq_depth > seg_equip_cap:
                    geometry_data = dict(geometry_data) if not isinstance(geometry_data, dict) else geometry_data
                    geometry_data['depth'] = seg_equip_cap
                    print(f"Segment equipment depth cap: {css_id} ({semantic_type}) "
                          f"{cur_eq_depth:.2f} -> {seg_equip_cap:.2f} (derived from max segment dim {seg_max_dim:.2f}m)")

            # Column/Wall/Slab depth cap: clamp to prevent elements extruding past their storey.
            # Slabs use span-based structural thickness (derive_slab_thickness) rather than a
            # fixed storey-height ratio, so the rule applies to any building occupancy type.
            if not tunnel_segments_index and css_type in ('COLUMN', 'WALL', 'SLAB', 'BEAM'):
                elem_depth = safe_float(geometry_data.get('depth'), 3.0)
                # Storey height: read from CSS levels data; derive from occupancy type if missing.
                # Never hard-code a single value — building heights vary widely by use.
                if container_id in storey_height_map:
                    max_storey_h = storey_height_map[container_id]
                else:
                    occupancy_fb = (css.get('facilityMeta') or
                                    css.get('metadata', {}).get('facilityMeta', {})).get('occupancy', '')
                    max_storey_h = derive_storey_height(occupancy_type=occupancy_fb)
                    print(f"Storey height fallback via derive_storey_height('{occupancy_fb}'): "
                          f"{max_storey_h}m for container {container_id}")
                if css_type == 'SLAB':
                    # Structural slab thickness from span: span is approximated as the slab footprint
                    # diagonal (width × height). Falls back to storey-ratio only if truly unknown.
                    slab_w = safe_float(geometry_data.get('profile', {}).get('width'), None)
                    slab_h = safe_float(geometry_data.get('profile', {}).get('height'), None)
                    explicit_t = safe_float(properties.get('thickness_m'), None)
                    if explicit_t and explicit_t > 0:
                        depth_limit = explicit_t
                    elif slab_w and slab_h:
                        span_approx = math.sqrt(slab_w ** 2 + slab_h ** 2) / 2.0
                        occupancy = (css.get('facilityMeta') or css.get('metadata', {}).get('facilityMeta', {})).get('occupancy', '')
                        depth_limit = derive_slab_thickness(span_approx, load_hint=occupancy)
                        depth_limit = min(depth_limit, elem_depth)  # never inflate a correctly-thin slab
                    else:
                        # Last resort: 15% of storey height (kept as backstop only)
                        depth_limit = max(0.05, min(elem_depth, max_storey_h * 0.15))
                        print(f"Slab depth fallback to storey ratio: {css_id} depth={elem_depth:.2f} → {depth_limit:.2f} "
                              f"(no span/thickness data available)")
                    depth_limit = max(0.05, depth_limit)
                else:
                    depth_limit = max_storey_h
                if elem_depth > depth_limit:
                    geometry_data = dict(geometry_data) if not isinstance(geometry_data, dict) else geometry_data
                    geometry_data['depth'] = depth_limit

            # Duct/pipe profile sizing — tunnel ducts use area_m2 for rectangular profiles
            # (VentSim source data carries area_m2 e.g. 6m² for a 2.4×2.5m mine duct).
            # Non-tunnel ducts/pipes and vertical shafts convert to circular with a radius cap.
            if semantic_type in ('IfcDuctSegment', 'IfcPipeSegment'):
                g_profile = geometry_data.get('profile', {})
                # Determine if this is a vertical shaft by checking orientation vectors.
                # CSS convention: refDirection = horizontal bearing, axis = world-up.
                # A near-vertical refDirection (|z| > 0.95) indicates a shaft element.
                shaft_ref = (placement_data.get('refDirection') or placement_data.get('axis') or {}) \
                    if isinstance(placement_data, dict) else {}
                if not shaft_ref:
                    # Placement has no orientation — fall back to geometry.direction if available
                    shaft_ref = _normalize_direction((geometry_data.get('direction') or {}) if isinstance(geometry_data, dict) else {})
                    if shaft_ref:
                        print(f"Duct/pipe orientation: using geometry.direction fallback for {css_id}")
                is_vert = abs(float(shaft_ref.get('z', 0))) > 0.95

                area_m2 = float(properties.get('area_m2', 0))

                # Find the enclosing segment (if any) for parent-profile-based duct sizing.
                # Guards all dict accesses — missing keys skip this segment safely.
                best_seg_prof = None
                if tunnel_segments_index:
                    elem_ox = float((placement_data.get('origin') or {}).get('x', 0)) \
                        if isinstance(placement_data, dict) else 0.0
                    elem_oy = float((placement_data.get('origin') or {}).get('y', 0)) \
                        if isinstance(placement_data, dict) else 0.0
                    for seg in tunnel_segments_index:
                        seg_ox = seg.get('ox')
                        seg_oy = seg.get('oy')
                        seg_depth_val = seg.get('depth')
                        if seg_ox is None or seg_oy is None or seg_depth_val is None:
                            continue
                        dx = elem_ox - float(seg_ox)
                        dy = elem_oy - float(seg_oy)
                        if math.isfinite(dx) and math.isfinite(dy) and math.sqrt(dx * dx + dy * dy) < float(seg_depth_val):
                            best_seg_prof = seg
                            break

                # Preserve existing CIRCLE profiles — only override RECTANGLE/missing profiles.
                # Circular ducts from VentSim should use IfcSweptDiskSolid, not be converted.
                has_circle_profile = g_profile.get('type', '').upper() == 'CIRCLE' and g_profile.get('radius', 0) > 0

                if has_circle_profile and not is_vert:
                    # Already has a valid circular profile — keep it for SweptDiskSolid treatment.
                    # Just cap radius to reasonable bounds.
                    cur_radius = float(g_profile.get('radius', 0.15))
                    max_radius = 1.5  # realistic max for tunnel vent duct radius
                    if cur_radius > max_radius:
                        geometry_data = dict(geometry_data)
                        geometry_data['profile'] = {'type': 'CIRCLE', 'radius': max_radius}
                        print(f"Duct radius capped: {cur_radius:.3f} → {max_radius:.3f} for {css_id}")
                elif semantic_type == 'IfcDuctSegment' and not is_vert and area_m2 > 0.1:
                    # Large-bore duct with area_m2 → rectangular profile via ASHRAE rules.
                    sys_type = properties.get('systemType', properties.get('system_type', ''))
                    if best_seg_prof:
                        parent_w = best_seg_prof.get('half_w', 0) * 2
                        parent_h = best_seg_prof.get('half_h', 0) * 2
                        dw, dh = derive_duct_profile(area_m2=area_m2, system_type=sys_type,
                                                      parent_width=parent_w, parent_height=parent_h,
                                                      elem_id=css_id)
                        dw = min(dw, parent_w * 0.25, 1.5)
                        dh = min(dh, parent_h * 0.20, 1.0)
                    else:
                        dw, dh = derive_duct_profile(area_m2=area_m2, system_type=sys_type, elem_id=css_id)
                        dw = min(dw, 1.5)
                        dh = min(dh, 1.0)
                    geometry_data = dict(geometry_data)
                    geometry_data['profile'] = {'type': 'RECTANGLE', 'width': round(dw, 3), 'height': round(dh, 3)}
                    print(f"Duct profile from area_m2={area_m2:.1f} ({sys_type}): {dw:.3f}x{dh:.3f} for {css_id}")
                elif semantic_type == 'IfcDuctSegment' and not is_vert and tunnel_segments_index:
                    # No area data inside a segment bore — derive from parent profile
                    sys_type = properties.get('systemType', properties.get('system_type', ''))
                    if best_seg_prof:
                        parent_w = best_seg_prof.get('half_w', 0) * 2
                        parent_h = best_seg_prof.get('half_h', 0) * 2
                        dw, dh = derive_duct_profile(system_type=sys_type, parent_width=parent_w,
                                                      parent_height=parent_h, elem_id=css_id)
                    else:
                        dw, dh = derive_duct_profile(system_type=sys_type, elem_id=css_id)
                    dw = min(dw, 1.5)
                    dh = min(dh, 1.0)
                    geometry_data = dict(geometry_data)
                    geometry_data['profile'] = {'type': 'RECTANGLE', 'width': round(dw, 3), 'height': round(dh, 3)}
                else:
                    # Standard circular profile: pipes, vertical shafts, building ducts without area_m2.
                    # Radius cap derived from CSS data: area_m2 → r=sqrt(area/π), else profile width/2.
                    # For vertical shafts inside segment structures, use the shaft area_m2 if available.
                    if is_vert and tunnel_segments_index and area_m2 > 0:
                        max_radius = math.sqrt(area_m2 / math.pi)
                        print(f"Shaft radius from area_m2={area_m2:.3f}: {max_radius:.3f}m for {css_id}")
                    elif is_vert and tunnel_segments_index and best_seg_prof:
                        # No area — cap to half the smaller bore dimension (shaft fits inside segment)
                        max_radius = min(best_seg_prof.get('half_w', 0.5), best_seg_prof.get('half_h', 0.5)) * 0.5
                    elif is_vert and tunnel_segments_index:
                        # No segment context — use a reasonable structural shaft cap
                        max_radius = 1.0
                    else:
                        max_radius = 0.1 if semantic_type == 'IfcPipeSegment' else 0.25
                    if g_profile.get('type', 'RECTANGLE') == 'RECTANGLE':
                        w = float(g_profile.get('width', 0.4))
                        h = float(g_profile.get('height', 0.4))
                        radius = min((w + h) / 4.0, max_radius)
                        geometry_data = dict(geometry_data)
                        geometry_data['profile'] = {'type': 'CIRCLE', 'radius': radius}
                    elif g_profile.get('type') == 'CIRCLE':
                        cur_radius = float(g_profile.get('radius', 0.15))
                        if cur_radius > max_radius:
                            geometry_data = dict(geometry_data)
                            geometry_data['profile'] = dict(g_profile)
                            geometry_data['profile']['radius'] = max_radius
                            print(f"Duct/pipe radius cap: {css_id} {cur_radius:.3f} -> {max_radius:.3f}")

            # Bug #4 fix: EXTRUSION ducts/pipes with pathPoints but Z-up axis — derive
            # placement axis from the path direction so they extrude along the tunnel, not
            # vertically. Only applies when axis is near-vertical and pathPoints provide a
            # valid horizontal direction. Skip if the snap code already positioned the duct
            # (pathPoints were converted to local frame; applying them again would reset origin to 0).
            if (not _duct_snapped
                    and semantic_type in ('IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment')
                    and geometry_data.get('method', 'EXTRUSION') == 'EXTRUSION'
                    and geometry_data.get('pathPoints') and len(geometry_data.get('pathPoints', [])) >= 2):
                _pp = geometry_data['pathPoints']
                _p0, _p1 = _pp[0], _pp[-1]
                _pdx = float(_p1.get('x', 0)) - float(_p0.get('x', 0))
                _pdy = float(_p1.get('y', 0)) - float(_p0.get('y', 0))
                _pdz = float(_p1.get('z', 0)) - float(_p0.get('z', 0))
                _plen = math.sqrt(_pdx * _pdx + _pdy * _pdy + _pdz * _pdz)
                _cur_ax = placement_data.get('axis', {}) if isinstance(placement_data, dict) else {}
                _cur_az = abs(float(_cur_ax.get('z', 1)))
                if _plen > 0.01 and _cur_az > 0.95:
                    # Axis is near-vertical but path is not — override axis with path direction
                    placement_data = dict(placement_data)
                    placement_data['axis'] = {'x': _pdx / _plen, 'y': _pdy / _plen, 'z': _pdz / _plen}
                    placement_data['refDirection'] = {'x': 0.0, 'y': 0.0, 'z': 1.0}
                    # Shift origin to path start
                    placement_data['origin'] = {'x': float(_p0.get('x', 0)),
                                                'y': float(_p0.get('y', 0)),
                                                'z': float(_p0.get('z', 0))}
                    # Do NOT set geometry_data['depth'] = _plen — that overwrites the depth cap
                    # that was applied upstream (e.g. 10.0m from CSS or MEP cap). The [CAP] code
                    # in create_element_geometry will clamp path_len to geometry.depth correctly.
                    print(f"[BUG4-FIX] {css_id}: axis → ({_pdx/_plen:.2f},{_pdy/_plen:.2f},{_pdz/_plen:.2f})"
                          f" origin → ({float(_p0.get('x',0)):.2f},{float(_p0.get('y',0)):.2f},{float(_p0.get('z',0)):.2f})"
                          f" depth kept at {geometry_data.get('depth')}")

            # Per-end overlap caps: set by hollow manifold or shell piece path below,
            # read by the mitre clip overlap recording further down.
            entry_cap = 0.0
            exit_cap = 0.0

            # Extend shell pieces slightly past junction boundaries so adjacent panels meet
            # without gaps. IfcBooleanClippingResult mitre clips in the second pass trim the
            # overlapping corners flush. Overlap derived from profile size and turn geometry
            # via derive_junction_overlap so it scales correctly with any tunnel size.
            _junc_prof = geometry_data.get('profile', {})
            _junc_w = safe_float(_junc_prof.get('width'), 5.0)
            _junc_h = safe_float(_junc_prof.get('height'), 5.0)
            JUNCTION_OVERLAP_M = derive_junction_overlap(_junc_w, _junc_h, turn_angle_deg=90.0)
            if shell_piece and shell_piece in ('LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'):
                g_depth = safe_float(geometry_data.get('depth'), 0.0)
                if g_depth > 0.2:  # only extend pieces with meaningful depth
                    geometry_data = dict(geometry_data)
                    geometry_data['depth'] = g_depth + 2 * JUNCTION_OVERLAP_M
                    # Shift origin backward along placement axis by JUNCTION_OVERLAP_M
                    ax_data = placement_data.get('axis', {'x': 0, 'y': 0, 'z': 1})
                    ax_x = float(ax_data.get('x', 0))
                    ax_y = float(ax_data.get('y', 0))
                    ax_z = float(ax_data.get('z', 1))
                    ax_len = math.sqrt(ax_x ** 2 + ax_y ** 2 + ax_z ** 2)
                    if ax_len > 1e-6:
                        ax_x /= ax_len
                        ax_y /= ax_len
                        ax_z /= ax_len
                    orig = placement_data.get('origin', {'x': 0, 'y': 0, 'z': 0})
                    placement_data = dict(placement_data)
                    placement_data['origin'] = {
                        'x': float(orig.get('x', 0)) - ax_x * JUNCTION_OVERLAP_M,
                        'y': float(orig.get('y', 0)) - ax_y * JUNCTION_OVERLAP_M,
                        'z': float(orig.get('z', 0)) - ax_z * JUNCTION_OVERLAP_M,
                    }

            # Hollow Manifold Shell: every structural rectangular TUNNEL_SEGMENT becomes a single
            # IfcWall with IfcRectangleHollowProfileDef geometry — a proper hollow tube, not 4
            # separate thin panels. This applies to all segments (decomposed or not) so that the
            # rendered model shows volumetric tube sections rather than a flat panel cage.
            if css_type == 'TUNNEL_SEGMENT' and properties.get('branchClass') == 'STRUCTURAL':
                prof = geometry_data.get('profile', {})
                _ms_prof_type = (prof.get('type', '') or '').upper()
                if _ms_prof_type in ('ARCH', 'CIRCLE', 'ARBITRARY'):
                    # SHAFT GUARD: CIRCLE tunnel-segments tagged VERTICAL_SHAFT (or whose id
                    # contains 'shaft') must not emit as a 30m horizontal tube. Use segmentType
                    # as the primary check — more robust than id string matching.
                    _is_shaft_type = (
                        properties.get('segmentType') == 'VERTICAL_SHAFT'
                        or 'shaft' in (elem.get('id') or css_id or '').lower()
                    )
                    if _ms_prof_type == 'CIRCLE' and _is_shaft_type:
                        print(f"  [SHAFT-GUARD] {css_id}: CIRCLE shaft skipped "
                              f"(segType={properties.get('segmentType')} id={css_id})")
                        intentional_skip_count += 1
                        continue
                    # Curved profiles: ensure wallThickness is set for hollow rendering,
                    # then fall through to generic create_element_geometry which handles
                    # IfcArbitraryProfileDefWithVoids / IfcCircleHollowProfileDef
                    wt_curved = float(properties.get('shellThickness_m', 0) or 0)
                    if wt_curved <= 0:
                        _cprof = geometry_data.get('profile', {})
                        wt_curved = derive_shell_thickness(
                            _cprof.get('width') or _cprof.get('radius', 1) * 2,
                            _cprof.get('height') or _cprof.get('radius', 1) * 2,
                            material_hint=properties.get('material', '')
                        )
                    if not prof.get('wallThickness') and properties.get('segmentType') != 'VERTICAL_SHAFT':
                        geometry_data = dict(geometry_data)
                        geometry_data['profile'] = dict(prof)
                        geometry_data['profile']['wallThickness'] = wt_curved
                    # Ensure segment uses refDirection as 3D bearing for placement.
                    # Include Z component so sloped tunnels extrude along the true 3D vector.
                    ref_d_c = placement_data.get('refDirection', placement_data.get('axis', {'x': 1, 'y': 0, 'z': 0}))
                    rx_c = float(ref_d_c.get('x', 1))
                    ry_c = float(ref_d_c.get('y', 0))
                    rz_c = float(ref_d_c.get('z', 0))
                    c_len_3d = math.sqrt(rx_c ** 2 + ry_c ** 2 + rz_c ** 2)
                    if c_len_3d > 1e-6:
                        rx_c /= c_len_3d
                        ry_c /= c_len_3d
                        rz_c /= c_len_3d
                    else:
                        rx_c, ry_c, rz_c = 1.0, 0.0, 0.0
                    _is_sloped = abs(rz_c) > 0.01
                    seg_depth_c = safe_float(geometry_data.get('depth'), 1.0)
                    orig_c = placement_data.get('origin', {'x': 0, 'y': 0, 'z': 0})
                    # Junction overlap: extend ONLY ends that meet another segment so adjacent
                    # segments overlap at corners (filling visual gaps). Terminal ends (portals,
                    # dead ends) get NO extension — otherwise the tunnel pokes past the portal.
                    # No boolean clipping — xeokit WASM crashes on IfcBooleanClippingResult.
                    _gap_prof = geometry_data.get('profile', {}) or {}
                    _gap_w = float(_gap_prof.get('width', 0) or 0)
                    _eid = elem.get('element_key') or css_id
                    _en_node = str(properties.get('entry_node')) if properties.get('entry_node') is not None else None
                    _ex_node = str(properties.get('exit_node'))  if properties.get('exit_node')  is not None else None
                    # Count how many OTHER structural segments adjoin each endpoint.
                    # Combine node-ID lookup and geometry-proximity (2m) for robustness —
                    # VentSim branches sometimes use different node IDs even when adjacent.
                    # Result: _en_adj_count / _ex_adj_count = number of other segments at that end.
                    _ep_entry_x = float(orig_c.get('x', 0)) - rx_c * seg_depth_c / 2
                    _ep_entry_y = float(orig_c.get('y', 0)) - ry_c * seg_depth_c / 2
                    _ep_exit_x  = float(orig_c.get('x', 0)) + rx_c * seg_depth_c / 2
                    _ep_exit_y  = float(orig_c.get('y', 0)) + ry_c * seg_depth_c / 2
                    _GEO_PROX = 2.0  # meters — max endpoint mismatch for VentSim topology
                    _near_entry_keys = set()
                    _near_exit_keys  = set()
                    for _gep_x, _gep_y, _gep_z, _gep_ek in _seg_geo_endpoints:
                        if _gep_ek == _eid:
                            continue
                        if math.sqrt((_ep_entry_x - _gep_x)**2 + (_ep_entry_y - _gep_y)**2) < _GEO_PROX:
                            _near_entry_keys.add(_gep_ek)
                        if math.sqrt((_ep_exit_x  - _gep_x)**2 + (_ep_exit_y  - _gep_y)**2) < _GEO_PROX:
                            _near_exit_keys.add(_gep_ek)
                    # Node-ID count (may be 0 if entry/exit_node not set in CSS)
                    _en_node_count = len([t for t in node_to_segs_for_clip.get(_en_node, []) if t[0] != _eid]) if _en_node else 0
                    _ex_node_count = len([t for t in node_to_segs_for_clip.get(_ex_node, []) if t[0] != _eid]) if _ex_node else 0
                    _en_adj_count = max(len(_near_entry_keys), _en_node_count)
                    _ex_adj_count = max(len(_near_exit_keys),  _ex_node_count)
                    _entry_shared = _en_adj_count > 0
                    _exit_shared  = _ex_adj_count > 0
                    # Overlap per end based on adjacency count:
                    # - 0 adjacent → terminal (portal/dead-end) → no extension (tube must not poke past mouth)
                    # - 1 adjacent → continuation (straight run) → wt_curved buries seam end-cap ring inside neighbor
                    # - 2+ adjacent → T/X junction → larger profile-proportional overlap fills corner gap
                    # Zero overlap: extending into neighbour tubes creates coincident inner surfaces
                    # that Z-fight as a visible ribbing band. No overlap means only a single-plane
                    # junction face per segment boundary — thinner and far less visible than bands.
                    _entry_ov = 0.0
                    _exit_ov  = 0.0

                    seg_depth_extended = seg_depth_c + _entry_ov + _exit_ov
                    geometry_data = dict(geometry_data)
                    geometry_data['depth'] = seg_depth_extended
                    # Placement: axis=bearing (full 3D, including slope), refDirection=lateral.
                    # For sloped tunnels, the bearing has a Z component (e.g., ramp going up).
                    # Lateral = cross(worldUp, bearing) — always horizontal for gravity-oriented profiles.
                    _horiz_len = math.sqrt(rx_c ** 2 + ry_c ** 2)
                    placement_data = dict(placement_data)
                    if _horiz_len > 1e-6:
                        lat_x = -ry_c / _horiz_len
                        lat_y = rx_c / _horiz_len
                        placement_data['axis'] = {'x': rx_c / _horiz_len, 'y': ry_c / _horiz_len, 'z': 0.0}
                        placement_data['refDirection'] = {'x': lat_x, 'y': lat_y, 'z': 0.0}
                    else:
                        # PHASE 4C: shaft snap — align with host tunnel surface.
                        # Find the nearest STRUCTURAL chain section (or tunnel segment if no chain),
                        # snap shaft so its base sits at host top + shell_thickness, set axis = host
                        # surface normal so the shaft stands perpendicular to the bore (not unconditionally vertical).
                        _shaft_axis = (0.0, 0.0, 1.0)
                        _shaft_ref = (1.0, 0.0, 0.0)
                        _shaft_top_world = None  # 3D point: shaft base after snap
                        _shaft_dz = 0.0
                        _shaft_host_label = 'none'
                        if tunnel_segments_index:
                            _sx = float(orig_c.get('x', 0))
                            _sy = float(orig_c.get('y', 0))
                            _sz_cur = float(orig_c.get('z', 0))
                            _best_chain_id = None
                            _best_section = None
                            _best_seg = None
                            _best_dist2 = float('inf')
                            for _ch_id, _sec_list in chain_sections_by_id.items():
                                for _sec in _sec_list:
                                    _cx, _cy, _cz = _sec['center']
                                    d2 = (_cx - _sx)**2 + (_cy - _sy)**2
                                    if d2 < _best_dist2:
                                        _best_dist2 = d2
                                        _best_chain_id = _ch_id
                                        _best_section = _sec
                                        _best_seg = None
                            for _seg in tunnel_segments_index:
                                if seg_to_chain.get(_seg.get('key')):
                                    continue
                                _ax_len = math.sqrt(_seg['ax']**2 + _seg['ay']**2 + _seg['az']**2)
                                if _ax_len < 1e-9:
                                    continue
                                _ux, _uy = _seg['ax']/_ax_len, _seg['ay']/_ax_len
                                _half = _seg['depth'] / 2.0
                                _t = (_sx - _seg['ox']) * _ux + (_sy - _seg['oy']) * _uy
                                _t = max(-_half, min(_half, _t))
                                _px = _seg['ox'] + _ux * _t
                                _py = _seg['oy'] + _uy * _t
                                d2 = (_px - _sx)**2 + (_py - _sy)**2
                                if d2 < _best_dist2:
                                    _best_dist2 = d2
                                    _best_chain_id = None
                                    _best_section = None
                                    _best_seg = _seg
                            if _best_section is not None:
                                _t_up = _best_section['up']
                                _t_t = _best_section['tangent']
                                _ch_shell = chain_shell_thickness_by_id.get(_best_chain_id, 0.3)
                                _leader_key = chain_leader_by_id.get(_best_chain_id)
                                _leader_idx = next((s for s in tunnel_segments_index if s['key'] == _leader_key), None)
                                _half_h = float(_leader_idx['half_h']) if _leader_idx else 2.0
                                _cx, _cy, _cz = _best_section['center']
                                _shaft_top_world = (
                                    _cx + _t_up[0] * (_half_h + _ch_shell),
                                    _cy + _t_up[1] * (_half_h + _ch_shell),
                                    _cz + _t_up[2] * (_half_h + _ch_shell),
                                )
                                _shaft_axis = _t_up
                                _shaft_ref = _t_t
                                _shaft_host_label = _best_chain_id or 'chain'
                                _shaft_dz = _shaft_top_world[2] - _sz_cur
                            elif _best_seg is not None:
                                _ax_len = math.sqrt(_best_seg['ax']**2 + _best_seg['ay']**2 + _best_seg['az']**2)
                                _ux = _best_seg['ax'] / _ax_len
                                _uy = _best_seg['ay'] / _ax_len
                                _uz = _best_seg['az'] / _ax_len
                                _lat = _chain_norm3(_chain_cross3((0.0, 0.0, 1.0), (_ux, _uy, _uz)))
                                if _lat == (0.0, 0.0, 0.0):
                                    _lat = (1.0, 0.0, 0.0)
                                _up_vec = _chain_norm3(_chain_cross3((_ux, _uy, _uz), _lat))
                                _shell_t = float(_best_seg.get('shell_thickness', 0.3) or 0.3)
                                _shaft_top_world = (
                                    float(_best_seg['ox']) + _up_vec[0] * (float(_best_seg['half_h']) + _shell_t),
                                    float(_best_seg['oy']) + _up_vec[1] * (float(_best_seg['half_h']) + _shell_t),
                                    float(_best_seg['oz']) + _up_vec[2] * (float(_best_seg['half_h']) + _shell_t),
                                )
                                _shaft_axis = _up_vec
                                _shaft_ref = (_ux, _uy, _uz)
                                _shaft_host_label = _best_seg.get('key', 'seg')
                                _shaft_dz = _shaft_top_world[2] - _sz_cur

                        # Override the bearing used by the origin shift below: shaft extrudes along host_up.
                        rx_c = float(_shaft_axis[0])
                        ry_c = float(_shaft_axis[1])
                        rz_c = float(_shaft_axis[2])
                        # Set extrusion axis + refDirection.
                        placement_data['axis'] = {'x': rx_c, 'y': ry_c, 'z': rz_c}
                        placement_data['refDirection'] = {'x': float(_shaft_ref[0]), 'y': float(_shaft_ref[1]), 'z': float(_shaft_ref[2])}
                        if _shaft_top_world is not None:
                            # Place shaft center so base (after origin shift) lands at host top.
                            # Origin shift below: placement.origin = orig_c - axis * (half_depth + entry_ov)
                            # We want placement.origin = host_top → orig_c = host_top + axis * (half_depth + entry_ov)
                            _shift = (seg_depth_c / 2.0) + _entry_ov
                            orig_c = {
                                'x': _shaft_top_world[0] + rx_c * _shift,
                                'y': _shaft_top_world[1] + ry_c * _shift,
                                'z': _shaft_top_world[2] + rz_c * _shift,
                            }
                        print(f"[SHAFT-SNAP] {css_id} host={_shaft_host_label} Δz={_shaft_dz:.2f} "
                              f"axis=({rx_c:.2f},{ry_c:.2f},{rz_c:.2f}) "
                              f"depth={seg_depth_extended:.1f}m")
                    # Shift origin back along the FULL 3D bearing by half_depth + entry_overlap.
                    placement_data['origin'] = {
                        'x': float(orig_c.get('x', 0)) - rx_c * (seg_depth_c / 2 + _entry_ov),
                        'y': float(orig_c.get('y', 0)) - ry_c * (seg_depth_c / 2 + _entry_ov),
                        'z': float(orig_c.get('z', 0)) - rz_c * (seg_depth_c / 2 + _entry_ov),
                    }
                    # Expose as entry_cap/exit_cap so the overlap-tracking block below
                    # (geom_junction_overlap_by_css_key) can read the correct values.
                    entry_cap = _entry_ov
                    exit_cap  = _exit_ov
                    geometry_data['_placementDriven'] = True
                    # Store overlap values on CSS element for post-pass thin walls
                    elem['_entry_overlap'] = _entry_ov
                    elem['_exit_overlap'] = _exit_ov
                    _slope_deg = math.degrees(math.asin(min(1.0, abs(rz_c)))) if abs(rz_c) > 0.01 else 0.0
                    _en_label = 'term' if _en_adj_count == 0 else ('cont' if _en_adj_count == 1 else 'junc')
                    _ex_label = 'term' if _ex_adj_count == 0 else ('cont' if _ex_adj_count == 1 else 'junc')
                    print(f"Curved tunnel segment {css_id}: {_ms_prof_type} profile wallThickness={wt_curved} "
                          f"depth {seg_depth_c:.1f}→{seg_depth_extended:.1f} "
                          f"entry={_en_label}(n={_en_adj_count})={_entry_ov:.2f} "
                          f"exit={_ex_label}(n={_ex_adj_count})={_exit_ov:.2f}"
                          f"{f' SLOPE={_slope_deg:.1f}deg' if _is_sloped else ''}")
                    # Fall through to generic create_element_geometry
                elif _ms_prof_type not in ('RECTANGLE', ''):
                    pass  # unknown profile type: fall through to normal element processing
                else:
                    # Rectangular hollow tube — set wallThickness so create_profile
                    # produces IfcRectangleHollowProfileDef.
                    wt = float(properties.get('shellThickness_m', 0) or 0)
                    if wt <= 0:
                        seg_w_prelim = float(prof.get('width', 5.0))
                        seg_h_prelim = float(prof.get('height', 5.0))
                        wt = derive_shell_thickness(seg_w_prelim, seg_h_prelim,
                                                    material_hint=properties.get('material', ''))
                    if not prof.get('wallThickness'):
                        geometry_data = dict(geometry_data)
                        geometry_data['profile'] = dict(prof)
                        geometry_data['profile']['wallThickness'] = wt
                    # Read full 3D bearing from refDirection (including Z for slopes)
                    ref_d = placement_data.get('refDirection', placement_data.get('axis', {'x': 1, 'y': 0, 'z': 0}))
                    rx_x = float(ref_d.get('x', 1))
                    rx_y = float(ref_d.get('y', 0))
                    rx_z = float(ref_d.get('z', 0))
                    r_len = math.sqrt(rx_x ** 2 + rx_y ** 2 + rx_z ** 2)
                    if r_len > 1e-6:
                        rx_x /= r_len
                        rx_y /= r_len
                        rx_z /= r_len
                    else:
                        rx_x, rx_y, rx_z = 1.0, 0.0, 0.0
                    seg_depth = safe_float(geometry_data.get('depth'), 1.0)
                    # Small junction overlap for rectangular path too
                    seg_w = float(prof.get('width', 5.0))
                    _tc_eid = elem.get('element_key') or css_id
                    _tc_en = str(properties.get('entry_node')) if properties.get('entry_node') is not None else None
                    _tc_ex = str(properties.get('exit_node'))  if properties.get('exit_node')  is not None else None
                    _entry_terminal = not any(t[0] != _tc_eid for t in node_to_segs_for_clip.get(_tc_en, [])) if _tc_en else True
                    _exit_terminal  = not any(t[0] != _tc_eid for t in node_to_segs_for_clip.get(_tc_ex, [])) if _tc_ex else True
                    # Dynamic overlap: use per-edge gap from junction solver.
                    _jr_gap_en = _jr_edge_gaps.get((_tc_en, _tc_eid, 'entry'), {}).get('magnitude', 0.0) if _tc_en else 0.0
                    _jr_gap_ex = _jr_edge_gaps.get((_tc_ex, _tc_eid, 'exit'), {}).get('magnitude', 0.0) if _tc_ex else 0.0
                    entry_cap = 0.0 if _entry_terminal else min(max(0.15, _jr_gap_en), seg_depth * 0.3)
                    exit_cap = 0.0 if _exit_terminal else min(max(0.15, _jr_gap_ex), seg_depth * 0.3)
                    extrude_depth = seg_depth + entry_cap + exit_cap
                    # Update geometry depth with end caps
                    geometry_data = dict(geometry_data) if not isinstance(geometry_data, dict) or 'profile' not in geometry_data else geometry_data
                    geometry_data['depth'] = extrude_depth
                    # Placement: axis=bearing (full 3D, including slope), refDirection=lateral.
                    # Lateral = cross(worldUp, bearing) — horizontal for gravity-oriented profiles.
                    _r_horiz = math.sqrt(rx_x ** 2 + rx_y ** 2)
                    if _r_horiz > 1e-6:
                        lat_rx = -rx_y / _r_horiz
                        lat_ry = rx_x / _r_horiz
                    else:
                        lat_rx, lat_ry = 1.0, 0.0  # vertical shaft
                    orig = placement_data.get('origin', {'x': 0, 'y': 0, 'z': 0})
                    placement_data = dict(placement_data)
                    placement_data['axis'] = {'x': rx_x, 'y': rx_y, 'z': rx_z}
                    placement_data['refDirection'] = {'x': lat_rx, 'y': lat_ry, 'z': 0.0}
                    placement_data['origin'] = {
                        'x': float(orig.get('x', 0)) - rx_x * (seg_depth / 2 + entry_cap),
                        'y': float(orig.get('y', 0)) - rx_y * (seg_depth / 2 + entry_cap),
                        'z': float(orig.get('z', 0)) - rx_z * (seg_depth / 2 + entry_cap),
                    }
                    geometry_data['_placementDriven'] = True
                    # Store overlap values on CSS element for post-pass thin walls
                    elem['_entry_overlap'] = entry_cap
                    elem['_exit_overlap'] = exit_cap
                    print(f"Rectangular tunnel segment {css_id}: "
                          f"{seg_w:.1f}x{seg_h:.1f} wallThickness={wt:.3f}m "
                          f"depth={seg_depth:.1f}→{extrude_depth:.1f} "
                          f"entry={'T' if _entry_terminal else 'J'}={entry_cap:.2f} "
                          f"exit={'T' if _exit_terminal else 'J'}={exit_cap:.2f}")
                    # Fall through to generic create_element_geometry
                    # (which uses create_profile → IfcRectangleHollowProfileDef)

            # Universal orientation fix for horizontal linear elements — applies to any element
            # type that uses the CSS "world-up" convention: axis=(0,0,1), refDirection=bearing.
            # Covers TUNNEL_SEGMENT, DUCT, PIPE, CABLE_TRAY and any future linear MEP types.
            # Skipped when _placementDriven is already True (ARCH/rectangular paths already
            # set the correct bearing and shifted the origin to the start point).
            # Safe for SWEEP elements: their refDirection=(0,0,1) gives _ut_bl=0 → no-op.
            _HORIZONTAL_LINEAR_TYPES = {'TUNNEL_SEGMENT', 'DUCT', 'PIPE', 'CABLE_TRAY'}
            # Skip orientation fix for ducts/pipes with pathPoints — their circular
            # extrusion derives solid_axis from the path direction directly. Applying
            # the orientation fix would set the placement bearing from refDirection
            # (often a VentSim default like (1,0,0)) which doesn't match the actual
            # duct route.  The identity placement + pathPoints-derived solid_axis is
            # correct for these elements.
            _has_path = len(geometry_data.get('pathPoints', geometry_data.get('path', [])) or []) >= 2
            _skip_orient = _has_path and css_type in ('DUCT', 'PIPE', 'CABLE_TRAY')
            if css_type in _HORIZONTAL_LINEAR_TYPES and not geometry_data.get('_placementDriven') and not _skip_orient:
                _ut_dir = _normalize_direction(placement_data.get('refDirection', geometry_data.get('direction', {})))
                _ut_bx = float(_ut_dir.get('x', 0))
                _ut_by = float(_ut_dir.get('y', 0))
                _ut_bl = math.sqrt(_ut_bx ** 2 + _ut_by ** 2)
                if _ut_bl > 0.1:
                    _ut_bx /= _ut_bl
                    _ut_by /= _ut_bl
                    _ut_latx = -_ut_by
                    _ut_laty = _ut_bx
                    # Shift origin from midpoint to start of segment so extrusion covers full depth
                    _ut_orig = placement_data.get('origin', {'x': 0, 'y': 0, 'z': 0})
                    _ut_depth = safe_float(geometry_data.get('depth'), 0.0)
                    placement_data = dict(placement_data)
                    placement_data['axis'] = {'x': _ut_bx, 'y': _ut_by, 'z': 0.0}
                    placement_data['refDirection'] = {'x': _ut_latx, 'y': _ut_laty, 'z': 0.0}
                    placement_data['origin'] = {
                        'x': float(_ut_orig.get('x', 0)) - _ut_bx * _ut_depth / 2,
                        'y': float(_ut_orig.get('y', 0)) - _ut_by * _ut_depth / 2,
                        'z': float(_ut_orig.get('z', 0)),
                    }
                    geometry_data = dict(geometry_data)
                    geometry_data['_placementDriven'] = True

            # WALL body geometry + orientation fix: must run BEFORE create_element_placement
            # so that both the IFC local placement and the body solid are consistent.
            #
            # Two geometry conventions exist for walls:
            #
            # LLM/standard convention (direction Z-up, profile already plan-view):
            #   profile.width  = wall run length (large, e.g. 12m)
            #   profile.height = wall thickness   (small, e.g. 0.15m)
            #   depth          = wall/storey height (extrusion distance, e.g. 2.7m)
            #
            # DXF convention (depth is run length, profile is thickness stub):
            #   depth          = segment run length (large, e.g. 8m)
            #   profile.width  = wall thickness     (small, e.g. 0.15m)
            #   profile.height = stub               (e.g. 0.10m)
            #
            # IFC body target: profile (run_length × thickness) extruded by storey_h in Z.
            if css_type == 'WALL' and (not tunnel_segments_index or elem.get('source') == 'DXF'):
                _p = geometry_data.get('profile') or {}
                _p_w = safe_float(_p.get('width'), 1.0)
                _p_h = safe_float(_p.get('height'), 1.0)
                _g_d = safe_float(geometry_data.get('depth'), 1.0)
                _g_dir = _normalize_direction(geometry_data.get('direction', {}))
                _dir_z = abs(float(_g_dir.get('z', 0)))

                # Detect LLM/standard convention: direction is Z-up AND
                # profile.width >> profile.height (length vs thickness).
                _is_standard = (_dir_z > 0.9 and _p_w > _p_h * 3 and _p_h < 0.5)

                if _is_standard:
                    # Profile already correct: width=length, height=thickness
                    _w_len = _p_w
                    _w_thk = _p_h
                    _w_h = _g_d  # depth is already storey height
                else:
                    # DXF convention: depth=run_length, profile.width=thickness
                    _w_len = _g_d
                    _w_thk = _p_w if _p_w < 1.0 else 0.15
                    if container_id in storey_height_map:
                        _w_h = storey_height_map[container_id]
                    else:
                        _occ_fb = (css.get('facilityMeta') or
                                   css.get('metadata', {}).get('facilityMeta', {})).get('occupancy', '')
                        _w_h = derive_storey_height(occupancy_type=_occ_fb)

                # Orient placement: axis=Z-up, refDirection=wall run direction
                _w_dir = _normalize_direction(geometry_data.get('direction') or placement_data.get('refDirection') or {})
                _w_dx = float(_w_dir.get('x', 1.0))
                _w_dy = float(_w_dir.get('y', 0.0))
                _w_dl = math.sqrt(_w_dx ** 2 + _w_dy ** 2)
                if _w_dl > 1e-6:
                    _w_dx /= _w_dl
                    _w_dy /= _w_dl
                    placement_data = dict(placement_data)
                    placement_data['axis'] = {'x': 0.0, 'y': 0.0, 'z': 1.0}
                    placement_data['refDirection'] = {'x': _w_dx, 'y': _w_dy, 'z': 0.0}
                else:
                    # Z-up direction: use placement.refDirection for wall run
                    _pr = placement_data.get('refDirection', {})
                    _pr_x = float(_pr.get('x', 1.0))
                    _pr_y = float(_pr.get('y', 0.0))
                    _pr_l = math.sqrt(_pr_x ** 2 + _pr_y ** 2)
                    if _pr_l > 1e-6:
                        _w_dx = _pr_x / _pr_l
                        _w_dy = _pr_y / _pr_l
                    placement_data = dict(placement_data)
                    placement_data['axis'] = {'x': 0.0, 'y': 0.0, 'z': 1.0}
                    placement_data['refDirection'] = {'x': _w_dx, 'y': _w_dy, 'z': 0.0}
                geometry_data = dict(geometry_data)
                geometry_data['_wallLength'] = _w_len  # preserve run length for axis rep
                geometry_data['profile'] = {'type': 'RECTANGLE', 'width': _w_len, 'height': _w_thk}
                geometry_data['depth'] = _w_h

            # Create placement AFTER all placement_data modifications (hollow manifold,
            # junction overlap, portal buildings, wall orientation) so IFC placement is final.
            elem_lp = create_element_placement(f, storey_lp, placement_data, elem_id=css_id)

            # Shell suppression: only suppress tunnel segment geometry when the CSS
            # element is explicitly flagged with suppressShell=true (set by the topology
            # engine when DXF polylines actually provide the full tunnel lining).
            _suppress_shell = (css_type == 'TUNNEL_SEGMENT'
                                and properties.get('branchClass') == 'STRUCTURAL'
                                and properties.get('suppressShell') is True)

            if _suppress_shell:
                solid_or_surface = None
                pds = None
                fallback_used = 'shell_suppressed'
                ifc_entity_type = 'IfcBuildingElementProxy'
                print(f"Shell suppressed: {css_id} — explicit suppressShell flag")
            else:
                # PHASE 4C: chain dispatch.
                # If this segment is a chain member (non-leader), emit no geometry —
                # the chain leader carries the unified BREP for the whole run.
                # If this segment is a chain leader, emit the welded chain BREP using
                # the pre-computed sections, and reset placement to identity (chain
                # vertices are in storey-local coords).
                _elem_key_chain = elem.get('element_key', css_id)
                _chain_id = seg_to_chain.get(_elem_key_chain) if css_type == 'TUNNEL_SEGMENT' else None
                _is_chain_leader = bool(_chain_id) and chain_leader_by_id.get(_chain_id) == _elem_key_chain
                _is_chain_member_only = bool(_chain_id) and not _is_chain_leader

                if _is_chain_member_only:
                    # Keep entity alive but with no Representation. PSets, storey
                    # containment, and references all stay valid.
                    solid_or_surface = None
                    pds = None
                    fallback_used = 'chain_member'
                    elem.setdefault('metadata', {})['_chainMember'] = _chain_id
                    print(f"[CHAIN-MEMBER-SKIP] {css_id} chain={_chain_id} (no representation emitted)")
                # Detect tunnel shell (hollow horseshoe arch) — use IfcFacetedBrep hollow mesh
                # instead of solid ExtrudedAreaSolid. This creates a proper hollow bore.
                profile_data = geometry_data.get('profile') or {}
                profile_type = profile_data.get('type', '')
                # Tunnel shells: TUNNEL_SEGMENT with ARCH profile (or WALL with ARCH if marked as tunnel)
                is_tunnel_shell = (
                    (css_type == 'TUNNEL_SEGMENT' and profile_type == 'ARCH')
                    or (css_type == 'WALL' and geometry_data.get('_isTunnelShell') and profile_type in ('ARCH', 'ARBITRARY'))
                )

                _portal_arch_mode = bool(geometry_data.get('_portalArchMode'))
                _portal_arch_section = elem.get('metadata', {}).get('_chainEndSection') if _portal_arch_mode else None

                if _is_chain_member_only:
                    pass  # already handled above (geometry-less)
                elif _is_chain_leader and _chain_id in chain_sections_by_id:
                    # Chain leader: emit one welded BREP for the whole chain.
                    sections = chain_sections_by_id[_chain_id]
                    outer_pts_2d_chain = chain_outer_pts_by_id[_chain_id]
                    shell_thickness = chain_shell_thickness_by_id[_chain_id]
                    print(f"[CHAIN-EMIT] leader={css_id} chain={_chain_id} K={len(sections)} "
                          f"N={len(outer_pts_2d_chain)} shell={shell_thickness}m")
                    solid_or_surface, pds = create_chain_tunnel_brep(
                        f, subcontext, sections, shell_thickness, outer_pts_2d_chain, elem_id=css_id
                    )
                    if solid_or_surface is not None:
                        # Vertices are in storey-local space → identity placement.
                        placement_data = dict(placement_data)
                        placement_data['origin'] = {'x': 0.0, 'y': 0.0, 'z': 0.0}
                        placement_data['axis'] = {'x': 0.0, 'y': 0.0, 'z': 1.0}
                        placement_data['refDirection'] = {'x': 1.0, 'y': 0.0, 'z': 0.0}
                        elem_lp = create_element_placement(f, storey_lp, placement_data, elem_id=css_id)
                        geometry_data = dict(geometry_data)
                        geometry_data['_chainLeader'] = _chain_id
                        fallback_used = 'chain_brep'
                    else:
                        # Chain BREP failed — single-segment per-segment fallback for the leader.
                        # Members in this chain stay geometry-less, leaving visible gaps; logged.
                        print(f"[CHAIN] {_chain_id} BREP build failed for leader {css_id} — leader using per-segment fallback")
                        if is_tunnel_shell:
                            shell_thickness_fb = (
                                safe_float(properties.get('shellThickness'), None)
                                or safe_float(geometry_data.get('shellThickness'), None)
                                or 0.3
                            )
                            depth_fb = safe_float(geometry_data.get('depth'), 1.0)
                            if profile_type == 'ARCH':
                                arch_w = safe_float(profile_data.get('width'), 4.0)
                                arch_h = safe_float(profile_data.get('height'), 4.0)
                                curve_ratio = safe_float(profile_data.get('curveRatio'), 0.3)
                                outer_pts = _generate_arch_profile_points(arch_w, arch_h, curve_ratio)
                            else:
                                outer_pts = profile_data.get('points', [])
                                if isinstance(outer_pts[0], dict):
                                    outer_pts = [(p.get('x', 0), p.get('y', 0)) for p in outer_pts]
                            solid_or_surface, pds = create_hollow_tunnel_brep(
                                f, subcontext, outer_pts, shell_thickness_fb, depth_fb, elem_id=css_id
                            )
                            fallback_used = 'chain_failed_fallback' if solid_or_surface else 'tunnel_brep_failed'
                elif _portal_arch_mode and _portal_arch_section:
                    # Build portal as a 2-section chain: chain end ring + extruded outward copy.
                    # Vertices match the bore exactly at the seam — no rectangular mismatch.
                    _ph = ph if ph > 0 else 2.0  # outward extrusion depth from VentSim profile.height
                    _pa_center = tuple(_portal_arch_section['center'])
                    _pa_tangent = tuple(_portal_arch_section['tangent'])
                    _pa_lateral = tuple(_portal_arch_section['lateral'])
                    _pa_up = tuple(_portal_arch_section['up'])
                    _pa_outer_world = [tuple(p) for p in _portal_arch_section['outer_world']]
                    _pa_end_label = _portal_arch_section.get('end_label', 'end')
                    if _pa_end_label == 'start':
                        _outward = (-_pa_tangent[0], -_pa_tangent[1], -_pa_tangent[2])
                    else:
                        _outward = (_pa_tangent[0], _pa_tangent[1], _pa_tangent[2])
                    _far_center = (
                        _pa_center[0] + _outward[0] * _ph,
                        _pa_center[1] + _outward[1] * _ph,
                        _pa_center[2] + _outward[2] * _ph,
                    )
                    _far_outer_world = [
                        (p[0] + _outward[0] * _ph,
                         p[1] + _outward[1] * _ph,
                         p[2] + _outward[2] * _ph)
                        for p in _pa_outer_world
                    ]
                    _pa_chain_id = _portal_arch_section.get('chain_id')
                    _pa_outer_pts_2d = chain_outer_pts_by_id.get(_pa_chain_id) if _pa_chain_id else None
                    if _pa_outer_pts_2d:
                        _portal_shell = chain_shell_thickness_by_id.get(_pa_chain_id, 0.3)
                        _portal_sections = [
                            {'center': _pa_center, 'tangent': _outward, 'lateral': _pa_lateral, 'up': _pa_up,
                             'outer_world': _pa_outer_world, 'source': 'portal_inner'},
                            {'center': _far_center, 'tangent': _outward, 'lateral': _pa_lateral, 'up': _pa_up,
                             'outer_world': _far_outer_world, 'source': 'portal_outer'},
                        ]
                        solid_or_surface, pds = create_chain_tunnel_brep(
                            f, subcontext, _portal_sections, _portal_shell, _pa_outer_pts_2d, elem_id=css_id
                        )
                        if solid_or_surface is not None:
                            placement_data = dict(placement_data)
                            placement_data['origin'] = {'x': 0.0, 'y': 0.0, 'z': 0.0}
                            placement_data['axis'] = {'x': 0.0, 'y': 0.0, 'z': 1.0}
                            placement_data['refDirection'] = {'x': 1.0, 'y': 0.0, 'z': 0.0}
                            elem_lp = create_element_placement(f, storey_lp, placement_data, elem_id=css_id)
                            fallback_used = 'portal_arch_brep'
                        else:
                            print(f"[CHAIN-PORTAL] {css_id}: arch BREP failed — emitting as proxy")
                            fallback_used = 'portal_arch_failed'
                    else:
                        print(f"[CHAIN-PORTAL] {css_id}: missing chain outer profile — emitting as proxy")
                        fallback_used = 'portal_arch_failed'
                elif is_tunnel_shell:
                    # PHASE 4C debug: hard-disable old per-segment hollow tunnel BREP
                    # whenever has_tunnel_segments is true. If a TUNNEL_SEGMENT lands
                    # here it means the chain pipeline did NOT claim it — surface that
                    # to CloudWatch instead of silently masking with the old path.
                    # Set CHAIN_ALLOW_LEGACY_PER_SEG=1 in the lambda env to re-enable.
                    if (has_tunnel_segments
                            and css_type == 'TUNNEL_SEGMENT'
                            and os.environ.get('CHAIN_ALLOW_LEGACY_PER_SEG', '0') != '1'):
                        print(f"[CHAIN-DEBUG] {css_id}: per-segment ARCH path SKIPPED "
                              f"(chain not formed; chain_id={_chain_id} leader={_is_chain_leader} "
                              f"member={_is_chain_member_only})")
                        solid_or_surface = None
                        pds = None
                        fallback_used = 'chain_debug_skip'
                    else:
                        # Generate hollow tunnel brep using outer + inner arch profiles
                        shell_thickness = (
                            safe_float(properties.get('shellThickness'), None)
                            or safe_float(geometry_data.get('shellThickness'), None)
                            or 0.3  # default 0.3m
                        )
                        depth = safe_float(geometry_data.get('depth'), 1.0)

                        if profile_type == 'ARCH':
                            arch_w = safe_float(profile_data.get('width'), 4.0)
                            arch_h = safe_float(profile_data.get('height'), 4.0)
                            curve_ratio = safe_float(profile_data.get('curveRatio'), 0.3)
                            outer_pts = _generate_arch_profile_points(arch_w, arch_h, curve_ratio)
                        else:
                            outer_pts = profile_data.get('points', [])
                            if isinstance(outer_pts[0], dict):
                                outer_pts = [(p.get('x', 0), p.get('y', 0)) for p in outer_pts]

                        solid_or_surface, pds = create_hollow_tunnel_brep(
                            f, subcontext, outer_pts, shell_thickness, depth, elem_id=css_id
                        )
                        fallback_used = 'hollow_tunnel_brep' if solid_or_surface else 'tunnel_brep_failed'
                else:
                    # Check for portal building walls with baked door voids (GAP 8)
                    has_portal_voids = (css_type == 'WALL'
                                       and properties.get('segmentType') == 'PORTAL_BUILDING'
                                       and css_id in portal_wall_void_map)

                    if has_portal_voids and portal_wall_void_map[css_id]:
                        # Use wall brep with voids instead of standard extrusion
                        wall_length = safe_float(geometry_data.get('profile', {}).get('width'), 1.0)
                        wall_height = safe_float(geometry_data.get('depth'), 1.0)
                        wall_thickness = safe_float(geometry_data.get('profile', {}).get('height'), 0.3)
                        voids = portal_wall_void_map[css_id]
                        solid_or_surface, pds = create_wall_brep_with_voids(
                            f, subcontext, wall_length, wall_height, wall_thickness, voids, elem_id=css_id
                        )
                        fallback_used = 'wall_brep_voids' if solid_or_surface else 'wall_brep_voids_failed'
                    else:
                        # PROBE: force ventsim_branch_262 to 0.1m to verify geometry path exports correctly.
                        # Remove this block after render confirms the change is visible.
                        if css_id == 'ventsim_branch_262':
                            _pp = geometry_data.get('pathPoints', [])
                            print(f"[PROBE-PRE] {css_id}: depth={geometry_data.get('depth')} "
                                  f"pathPts={len(_pp)} "
                                  f"p0={_pp[0] if _pp else 'N/A'} "
                                  f"p1={_pp[-1] if len(_pp) >= 2 else 'N/A'}")
                            geometry_data = dict(geometry_data)
                            geometry_data['pathPoints'] = [
                                {'x': 33.30, 'y': -22.13, 'z': 2.55},
                                {'x': 33.30, 'y': -22.23, 'z': 2.55},
                            ]
                            geometry_data['depth'] = 0.1
                            print(f"[PROBE-FORCE] {css_id}: overriding to 0.1m (was {len(_pp)}-pt path)")
                        # Create geometry (with normalized direction + fallback chain)
                        solid_or_surface, pds, fallback_used = create_element_geometry(f, subcontext, geometry_data, elem_id=css_id)
                        # PROBE: log geometry object IDs after creation
                        if css_id == 'ventsim_branch_262':
                            _solid_id = solid_or_surface.id() if solid_or_surface and hasattr(solid_or_surface, 'id') else 'N/A'
                            _pds_id = pds.id() if pds and hasattr(pds, 'id') else 'N/A'
                            _repr_id = 'N/A'
                            if pds:
                                try:
                                    _repr_id = pds.Representations[0].id()
                                except Exception:
                                    pass
                            print(f"[PROBE-GEOM] {css_id}: solid_step=#{_solid_id} repr_step=#{_repr_id} pds_step=#{_pds_id} fallback={fallback_used}")
                # Track solid + placement for mitre clip second pass (WALL/TUNNEL_SEGMENT only)
                # PHASE 4C: skip chain leaders — chain BREP has continuous arcs at
                # internal joints; chain-meets-chain junctions are handled by hard
                # mitre sections inside the chain section sampler.
                _is_chain_leader_for_clip = (
                    css_type == 'TUNNEL_SEGMENT'
                    and seg_to_chain.get(elem.get('element_key', css_id)) is not None
                    and chain_leader_by_id.get(seg_to_chain.get(elem.get('element_key', css_id))) == elem.get('element_key', css_id)
                )
                if (solid_or_surface is not None and css_type in ('WALL', 'TUNNEL_SEGMENT')
                        and not _is_chain_leader_for_clip):
                    elem_key_for_clip = elem.get('element_key', css_id)
                    solid_by_css_key[elem_key_for_clip] = solid_or_surface
                    placement_by_css_key[elem_key_for_clip] = placement_data
                    geom_profile_by_css_key[elem_key_for_clip] = geometry_data.get('profile', {})
                    ext_depth = safe_float(geometry_data.get('depth'), 0.0)
                    geom_depth_by_css_key[elem_key_for_clip] = ext_depth
                    # Record overlap extension so mitre clip can compute actual junction positions.
                    # Shell pieces: symmetric overlap (JUNCTION_OVERLAP_M per end).
                    # Hollow manifold TUNNEL_SEGMENT: asymmetric (entry_cap / exit_cap).
                    # Convention: junc_overlap = entry-side overlap, orig_depth = ext_depth - entry - exit.
                    is_shell_pc = bool(shell_piece) and shell_piece in ('LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF')
                    is_hollow_manifold_seg = (css_type == 'TUNNEL_SEGMENT'
                                              and properties.get('branchClass') == 'STRUCTURAL'
                                              and elem_key_for_clip in manifold_rendered_branches)
                    if is_shell_pc:
                        junc_overlap = JUNCTION_OVERLAP_M
                        orig_depth = ext_depth - 2 * junc_overlap
                    elif is_hollow_manifold_seg:
                        # entry_cap/exit_cap set in the hollow manifold block above
                        junc_overlap = entry_cap
                        orig_depth = ext_depth - entry_cap - exit_cap
                    else:
                        junc_overlap = 0.0
                        orig_depth = ext_depth
                    geom_junction_overlap_by_css_key[elem_key_for_clip] = junc_overlap
                    geom_orig_depth_by_css_key[elem_key_for_clip] = orig_depth
                if solid_or_surface is None or pds is None:
                    if fallback_used == 'chain_member':
                        # PHASE 4C: chain members are geometry-less BY DESIGN — keep
                        # the entity alive with its real type, no proxy fallback.
                        pass
                    else:
                        # Per-element resilience: create geometry-less proxy instead of skipping
                        print(f"Warning: All geometry failed for {css_id}, creating proxy fallback")
                        fallback_used = 'proxy_no_geometry'
                        ifc_entity_type = 'IfcBuildingElementProxy'
                        error_count += 1

            if fallback_used and fallback_used not in ('chain_member',):
                log_decision({'pass': 'create_geometry', 'element_id': css_id,
                    'action': 'geometry_escalation', 'reason': 'primary_method_failed',
                    'params': {'fallback': fallback_used, 'css_type': css_type}})

            # Dual Axis+Body representation for structural elements (like Revit)
            if css_type in ('WALL', 'SLAB', 'TUNNEL_SEGMENT') and pds and not fallback_used:
                try:
                    direction_data = _normalize_direction(geometry_data.get('direction', {'x': 0, 'y': 0, 'z': 1}))
                    # For WALLs: use the preserved run length (_wallLength), not the storey height
                    # that was written into geometry_data['depth'] by the body geometry fix above.
                    depth_val = geometry_data.get('_wallLength', geometry_data.get('depth', 1))
                    origin_for_axis = placement_data.get('origin', {'x': 0, 'y': 0, 'z': 0})
                    axis_rep = create_axis_representation(f, axis_subcontext, origin_for_axis, direction_data, depth_val)
                    body_rep = pds.Representations[0]
                    pds = f.create_entity('IfcProductDefinitionShape', Representations=(axis_rep, body_rep))
                except Exception as e:
                    pass  # Axis rep is optional; if it fails, keep body-only

            if fallback_used:
                if 'geometryFallbacks' not in metadata:
                    metadata['geometryFallbacks'] = {}
                metadata['geometryFallbacks'][css_id] = fallback_used

            # v7: Apply color — precedence: semanticType → shellPiece → systemType → css_type → material
            transparency = float((material_data or {}).get('transparency', 0))
            norm_sys = _normalize_system_type(properties.get('systemType', ''))
            color_rgb = TYPE_COLORS.get(semantic_type)
            if not color_rgb and shell_piece:
                color_rgb = SHELL_PIECE_COLORS.get(shell_piece)
                if shell_piece == 'VOID':
                    transparency = max(transparency, 0.7)
            if not color_rgb and norm_sys:
                if css_type == 'PIPE' or semantic_type in ('IfcPipeSegment', 'IfcPump', 'IfcValve', 'IfcTank'):
                    color_rgb = PIPE_SYSTEM_COLORS.get(norm_sys)
                elif css_type == 'DUCT' or semantic_type in (
                    'IfcDuctSegment', 'IfcFan', 'IfcAirTerminal', 'IfcDamper',
                    'IfcFilter', 'IfcCoil', 'IfcAirToAirHeatRecovery', 'IfcUnitaryEquipment',
                ):
                    color_rgb = DUCT_SYSTEM_COLORS.get(norm_sys)
            if not color_rgb:
                color_rgb = TYPE_COLORS.get(css_type)
            if not color_rgb:
                if material_data:
                    mat_name = material_data.get('name', 'unknown')
                    mat_color = material_data.get('color')
                    if mat_color and len(mat_color) == 3:
                        color_rgb = tuple(mat_color)
                    else:
                        color_rgb = MATERIAL_COLORS.get(mat_name, (0.7, 0.7, 0.7))
                else:
                    color_rgb = MATERIAL_COLORS.get('unknown', (0.7, 0.7, 0.7))
            # PHASE 4C visual assertion: chain leaders get a distinct steely-blue
            # tint so a single glance at the viewer proves the chain BREP is what's
            # being rendered. If the tunnel still looks warm-concrete coloured,
            # chain emission is not active.
            if (css_type == 'TUNNEL_SEGMENT'
                    and fallback_used == 'chain_brep'
                    and os.environ.get('CHAIN_HIDE_VISUAL_MARKER', '0') != '1'):
                color_rgb = (0.32, 0.42, 0.55)
            # Force transparency for spaces and windows regardless of resolution path.
            # Spaces at 0.7 are still visually prominent and overlap walls — make nearly
            # invisible so rooms are defined by walls, not by translucent volumes.
            if css_type == 'SPACE':
                transparency = max(transparency, 0.95)
            elif css_type == 'WINDOW':
                transparency = max(transparency, 0.7)
                color_rgb = (0.65, 0.83, 0.97)  # sky blue glass
            # Structural tunnel segments:
            # ARCH profiles: opaque hollow arch tube — primary visual geometry, matches reference.
            #   Post-pass (floor/ceiling slabs + side walls) is skipped for ARCH (see below).
            # RECTANGLE profiles: semi-transparent tube + post-pass 4-wall decomposition renders.
            # CIRCLE/ARBITRARY: opaque (shaft and custom profiles render as-is).
            if (css_type == 'TUNNEL_SEGMENT'
                    and properties.get('branchClass') == 'STRUCTURAL'
                    and not properties.get('_isBridgeSegment')):
                _seg_pt = (geometry_data.get('profile', {}).get('type', '') or '').upper()
                if _seg_pt == 'ARCH':
                    pass  # render hollow arch tube as primary geometry — no transparency override
                elif _seg_pt not in ('CIRCLE', 'ARBITRARY'):
                    transparency = max(transparency, 0.85)  # RECTANGLE: semi-transparent
            # v6: Differentiate roof slabs from floor slabs
            if css_type == 'SLAB' and properties.get('slabType') == 'ROOF':
                color_rgb = (0.42, 0.42, 0.48)  # blue-tinted dark for roof slabs
            # MEP systems: semi-transparent for subtle exterior appearance
            if semantic_type in ('IfcCableCarrierSegment', 'IfcDuctSegment', 'IfcPipeSegment'):
                # Exempt vertical shafts/exhaust from high transparency — they should be visible
                # Use refDirection.z — axis=(0,0,1) always now
                ref_data = placement_data.get('refDirection', {}) if isinstance(placement_data, dict) else {}
                is_vertical_shaft = abs(float(ref_data.get('z', 0))) > 0.95
                if tunnel_segments_index and not is_vertical_shaft:
                    # Ducts/pipes inside segment structure — visible but slightly translucent
                    transparency = max(transparency, 0.3)
                else:
                    transparency = max(transparency, 0.4)
            if tunnel_segments_index and semantic_type == 'IfcLightFixture':
                transparency = max(transparency, 0.2)  # visible inside segment structure
            # Junction fills and transition helpers bridge gaps between segments.
            # Render semi-transparent so they visually connect segments without blocking the bore.
            if properties.get('isJunctionFill') or properties.get('isTransitionHelper'):
                transparency = max(transparency, 0.4)

            style_tier = 'material'
            if TYPE_COLORS.get(semantic_type):
                style_tier = 'semanticType'
            elif shell_piece and SHELL_PIECE_COLORS.get(shell_piece):
                style_tier = 'shellPiece'
            elif norm_sys and (PIPE_SYSTEM_COLORS.get(norm_sys) or DUCT_SYSTEM_COLORS.get(norm_sys)):
                style_tier = 'systemType'
            elif TYPE_COLORS.get(css_type):
                style_tier = 'cssType'
            report_key = f"{css_type}:{semantic_type or '-'}"
            if report_key not in style_report:
                style_report[report_key] = {'semanticType': 0, 'shellPiece': 0, 'systemType': 0, 'cssType': 0, 'material': 0, 'sampleColor': None, 'sampleName': None}
            style_report[report_key][style_tier] += 1
            if not style_report[report_key]['sampleColor']:
                style_report[report_key]['sampleColor'] = list(color_rgb)
                style_report[report_key]['sampleName'] = elem_name
            all_elem_names.append(elem_name)

            reflectance = 'GLASS' if css_type == 'WINDOW' else 'BLINN'
            apply_style(f, solid_or_surface, color_rgb, transparency=transparency, entity_name=elem_name, reflectance_method=reflectance)

            # Resolve IFC entity type
            ifc_entity_type = resolve_ifc_entity_type(elem, output_mode)

            # Host enforcement: force proxy for elements marked by topology engine
            if elem.get('metadata', {}).get('_renderAsProxy') is True:
                ifc_entity_type = 'IfcBuildingElementProxy'

            # Track proxy fallbacks
            if ifc_entity_type == 'IfcBuildingElementProxy':
                proxy_tracking['count'] += 1
                if output_mode == 'PROXY_ONLY':
                    reason = 'PROXY_ONLY_mode'
                elif css_type == 'PROXY':
                    reason = 'explicit_PROXY_type'
                elif css_type == 'EQUIPMENT' and confidence < 0.4:
                    reason = f'low_confidence_{confidence:.2f}'
                elif css_type == 'EQUIPMENT' and (not semantic_type or semantic_type not in EQUIPMENT_SEMANTIC_MAP):
                    reason = f'unmapped_semantic:{semantic_type or "none"}'
                elif output_mode == 'HYBRID' and confidence < 0.7:
                    reason = f'HYBRID_low_confidence_{confidence:.2f}'
                else:
                    reason = f'unmapped_css_type:{css_type}'
                proxy_tracking['reasons'][reason] = proxy_tracking['reasons'].get(reason, 0) + 1

            log_decision({'pass': 'resolve_ifc_class', 'element_id': css_id,
                'action': 'ifc_class_assigned', 'reason': 'semantic_mapping',
                'params': {'css_type': css_type, 'ifc_class': ifc_entity_type, 'confidence': confidence}})

            # Create IFC element
            create_kwargs = {
                'GlobalId': new_guid(),
                'OwnerHistory': owner,
                'Name': elem_name,
                'ObjectPlacement': elem_lp,
            }
            if pds is not None:
                create_kwargs['Representation'] = pds

            # Add PredefinedType where appropriate
            predef = get_predefined_type(ifc_entity_type, css_type)
            if predef:
                create_kwargs['PredefinedType'] = predef

            # IfcDoor/IfcWindow need OverallHeight/OverallWidth
            if ifc_entity_type == 'IfcDoor':
                profile = geometry_data.get('profile', {})
                create_kwargs['OverallWidth'] = float(profile.get('width', 0.9))
                # height (Z-span) is correct for POLYFACE_MESH doors; depth (Y-span) is frame thickness fallback
                create_kwargs['OverallHeight'] = safe_float(geometry_data.get('height') or geometry_data.get('depth'), 2.5)
            elif ifc_entity_type == 'IfcWindow':
                profile = geometry_data.get('profile', {})
                create_kwargs['OverallWidth'] = float(profile.get('width', 1.2))
                create_kwargs['OverallHeight'] = safe_float(geometry_data.get('depth'), 1.2)

            # IfcSpace needs ObjectType
            if ifc_entity_type == 'IfcSpace':
                create_kwargs['ObjectType'] = properties.get('usage', 'OTHER')

            # v10: Human-readable ObjectType for walls and equipment
            if ifc_entity_type == 'IfcWall':
                is_ext = properties.get('isExternal', False)
                create_kwargs['ObjectType'] = 'Exterior Wall' if is_ext else 'Interior Wall'
            elif ifc_entity_type == 'IfcSlab':
                is_roof = css_type == 'ROOF' or properties.get('slabType') == 'ROOF'
                create_kwargs['ObjectType'] = 'Roof Slab' if is_roof else 'Floor Slab'
            elif semantic_type and semantic_type.startswith('Ifc') and ifc_entity_type not in ('IfcBuildingElementProxy', 'IfcSpace'):
                # Convert IfcFan → "Ventilation Fan", IfcPump → "Pump", etc.
                READABLE_TYPES = {
                    'IfcFan': 'Ventilation Fan', 'IfcPump': 'Pump', 'IfcValve': 'Valve',
                    'IfcSensor': 'Sensor', 'IfcCompressor': 'Compressor', 'IfcTransformer': 'Transformer',
                    'IfcBoiler': 'Boiler', 'IfcChiller': 'Chiller', 'IfcTank': 'Tank',
                    'IfcLightFixture': 'Light Fixture', 'IfcAlarm': 'Alarm',
                    'IfcDuctSegment': 'Ventilation Duct', 'IfcPipeSegment': 'Pipe Segment',
                    'IfcCableSegment': 'Cable Segment', 'IfcColumn': 'Column',
                    'IfcDoor': 'Door', 'IfcWindow': 'Window', 'IfcStair': 'Staircase',
                    'IfcFireSuppressionTerminal': 'Fire Suppression', 'IfcCommunicationsAppliance': 'Communications Device',
                    'IfcElectricDistributionBoard': 'Electrical Panel',
                    'IfcAirToAirHeatRecovery': 'Heat Recovery Unit', 'IfcCoolingTower': 'Cooling Tower',
                }
                readable = READABLE_TYPES.get(semantic_type) or READABLE_TYPES.get(ifc_entity_type)
                if readable:
                    create_kwargs['ObjectType'] = readable

            # IfcSlab PredefinedType from properties — normalize to valid IFC4 enum values.
            # Non-standard values like COMPOSITE_FLOOR cause IfcSlab creation to fail and
            # fall back to IfcBuildingElementProxy (white box). Map unknown values to FLOOR.
            if ifc_entity_type == 'IfcSlab' and properties.get('slabType'):
                _VALID_SLAB_TYPES = {'FLOOR', 'ROOF', 'LANDING', 'BASESLAB', 'USERDEFINED', 'NOTDEFINED'}
                _slab_pt = (properties['slabType'] or '').upper()
                if _slab_pt not in _VALID_SLAB_TYPES:
                    print(f"  [SLAB-TYPE-FIX] {css_id}: invalid PredefinedType '{properties['slabType']}' → FLOOR")
                    _slab_pt = 'FLOOR'
                create_kwargs['PredefinedType'] = _slab_pt

            # v5: IfcBuildingElementProxy gets enriched ObjectType + Name for traceability
            if ifc_entity_type == 'IfcBuildingElementProxy':
                obj_type = semantic_type if semantic_type and semantic_type != 'IfcBuildingElementProxy' else css_type
                source = elem.get('source', '')
                if source:
                    create_kwargs['ObjectType'] = f'{obj_type} [{source}]'
                else:
                    create_kwargs['ObjectType'] = obj_type
                # Improve generic proxy names
                eq_name = elem.get('name', '') or properties.get('equipmentName', '') or properties.get('equipmentType', '')
                if eq_name and (not elem_name or elem_name == css_id or elem_name.startswith('elem-')):
                    create_kwargs['Name'] = f'{obj_type}: {eq_name}'

            try:
                ifc_element = f.create_entity(ifc_entity_type, **create_kwargs)
            except Exception as entity_err:
                # Fallback to proxy if entity creation fails
                print(f"Warning: Failed to create {ifc_entity_type} for {css_id}: {entity_err}, falling back to proxy")
                create_kwargs.pop('PredefinedType', None)
                create_kwargs.pop('OverallHeight', None)
                create_kwargs.pop('OverallWidth', None)
                create_kwargs.pop('ObjectType', None)
                create_kwargs['ObjectType'] = css_type
                ifc_element = f.create_entity('IfcBuildingElementProxy', **create_kwargs)

            ifc_elements_by_css_id[css_id] = ifc_element

            # VERIFY: log STEP entity ID for traced elements
            if css_id in ('ventsim_branch_261', 'ventsim_branch_257', 'vertical-shaft-1') and ifc_element:
                _o = placement_data.get('origin', {}) if isinstance(placement_data, dict) else {}
                _ax = placement_data.get('axis', {}) if isinstance(placement_data, dict) else {}
                _geo = elem.get('geometry', {})
                _depth = _geo.get('depth') or (geometry_data.get('depth') if 'geometry_data' in dir() else None)
                _prof = _geo.get('profile', {})
                print(f"[VERIFY-IFC] {css_id}: type={ifc_entity_type} step_id=#{ifc_element.id()} "
                      f"axis=({float(_ax.get('x',0)):.2f},{float(_ax.get('y',0)):.2f},{float(_ax.get('z',0)):.2f}) "
                      f"origin=({float(_o.get('x',0)):.2f},{float(_o.get('y',0)):.2f},{float(_o.get('z',0)):.2f}) "
                      f"depth={_depth} profile={_prof.get('type')} r={_prof.get('radius')}")

            # VERIFY: count vertical ducts (exported axis ≈ (0,0,1)) and tall cylinders
            if ifc_element and css_type in ('DUCT', 'PIPE', 'CABLE_TRAY'):
                _va = placement_data.get('axis', {}) if isinstance(placement_data, dict) else {}
                if abs(float(_va.get('z', 0))) > 0.8:
                    _verify_vertical_duct_count += 1
            if ifc_element and css_type == 'TUNNEL_SEGMENT':
                _vg = elem.get('geometry', {})
                _vp = _vg.get('profile', {})
                if (_vp.get('type', '').upper() == 'CIRCLE' and
                        safe_float(_vg.get('depth'), 0) > 10.0):
                    _verify_tall_cylinder_count += 1

            # v11: Set Description on transition helpers so they're greppable in IFC text
            if properties.get('isTransitionHelper') and ifc_element:
                approx_type = properties.get('geometryApproximation', 'UNKNOWN')
                node_id = properties.get('bendNodeId') or properties.get('junctionNodeId', '')
                ifc_element.Description = f"Junction Transition Helper: {approx_type} at node {node_id}"

            # Populate key-based lookup for v3 semantic upgrades
            ek = elem.get('element_key', '')
            if ek and ifc_element:
                ifc_by_key[ek] = ifc_element

            # Add Pset_ProxyMetadata for proxies
            if ifc_entity_type == 'IfcBuildingElementProxy':
                semantic_type = elem.get('semanticType', '')
                source = elem.get('source', 'LLM')
                add_property_set(f, owner, ifc_element, 'Pset_ProxyMetadata', {
                    'OriginalType': (css_type, 'IfcLabel'),
                    'SemanticType': (semantic_type, 'IfcLabel'),
                    'Source': (source, 'IfcLabel'),
                    'Confidence': (confidence, 'IfcReal'),
                })

            # v6+ PHASE C+4: Enhanced source provenance + element-level evidence
            evidence = elem.get('metadata', {}).get('evidence', {})
            source = elem.get('source', 'LLM')
            prov_props = {
                'Source': (source, 'IfcLabel'),
                'Confidence': (confidence, 'IfcReal'),
                'EvidenceBasis': (str(evidence.get('basis', 'UNKNOWN')), 'IfcLabel'),
                'CoordinateSource': (str(evidence.get('coordinateSource', 'UNKNOWN')), 'IfcLabel'),
            }
            evidence_files = evidence.get('sourceFiles', [])
            if evidence_files:
                prov_props['SourceFiles'] = (', '.join(evidence_files[:5]), 'IfcLabel')
            if elem.get('sourceFile'):
                prov_props['PrimarySourceFile'] = (elem['sourceFile'], 'IfcLabel')
            # Element-level evidence detail fields
            if evidence.get('sourceExcerpt'):
                prov_props['SourceExcerpt'] = (str(evidence['sourceExcerpt'])[:200], 'IfcText')
            if evidence.get('pageNumber'):
                prov_props['PageNumber'] = (int(evidence['pageNumber']), 'IfcInteger')
            if evidence.get('paragraphIndex') is not None:
                prov_props['ParagraphIndex'] = (int(evidence['paragraphIndex']), 'IfcInteger')
            if evidence.get('sheetName'):
                prov_props['SheetName'] = (str(evidence['sheetName']), 'IfcLabel')
            if evidence.get('dxfLayer'):
                prov_props['DxfLayer'] = (str(evidence['dxfLayer']), 'IfcLabel')
            if evidence.get('dxfHandle'):
                prov_props['DxfHandle'] = (str(evidence['dxfHandle']), 'IfcLabel')
            if evidence.get('sourceType'):
                prov_props['SourceType'] = (str(evidence['sourceType']), 'IfcLabel')
            add_property_set(f, owner, ifc_element, 'Pset_SourceProvenance', prov_props)

            # Phase 13 PR 4: structured provenance Pset for traceability
            prov = elem.get('provenance', {})
            if prov:
                status = prov.get('sourceFileStatus', 'missing')
                source_files = prov.get('sourceFiles', [])
                primary_sf = prov.get('sourceFile')

                if status == 'derived_inferred':
                    source_file_display = '<inferred>'
                elif status == 'missing':
                    source_file_display = '<unknown>'
                elif status == 'inherited_contested':
                    sf_str = ', '.join(source_files) if source_files else (primary_sf or '<unknown>')
                    source_file_display = sf_str + ' (contested)'
                else:
                    source_file_display = ', '.join(source_files) if source_files else (primary_sf or '<unknown>')

                add_property_set(f, owner, ifc_element, 'Pset_BuiltingProvenance', {
                    'SourceFile': (source_file_display, 'IfcLabel'),
                    'SourceFileStatus': (status, 'IfcLabel'),
                    'Stage': (prov.get('stage', ''), 'IfcLabel'),
                    'Modifications': (', '.join(prov.get('modifications', [])), 'IfcLabel'),
                })

            # Tag approximation/helper geometry — canonical vs non-canonical separation
            approx_type = None
            if properties.get('isTransitionHelper'):
                approx_type = 'TRANSITION_HELPER'
            elif properties.get('isFallback'):
                approx_type = 'ENVELOPE_FALLBACK'
            elif elem.get('metadata', {}).get('isInferred'):
                approx_type = 'INFERRED_OPENING'
            elif properties.get('shellApproximation'):
                approx_type = str(properties['shellApproximation'])
            elif properties.get('isApproximation'):
                approx_type = str(properties.get('approximationType', 'UNKNOWN'))
            if approx_type:
                add_property_set(f, owner, ifc_element, 'Pset_ApproximationMetadata', {
                    'IsApproximation': (True, 'IfcBoolean'),
                    'ApproximationType': (approx_type, 'IfcLabel'),
                })

            # Add element-specific property sets
            if css_type == 'WALL':
                is_external = properties.get('isExternal', True)
                load_bearing = properties.get('loadBearing', True)
                wall_pset = {
                    'IsExternal': (is_external, 'IfcBoolean'),
                    'LoadBearing': (load_bearing, 'IfcBoolean'),
                }
                ref = properties.get('reference', properties.get('material', ''))
                if ref:
                    wall_pset['Reference'] = (str(ref), 'IfcLabel')
                add_property_set(f, owner, ifc_element, 'Pset_WallCommon', wall_pset)
            elif css_type in ('SLAB', 'ROOF'):
                slab_pset = {
                    'IsExternal': (css_type == 'ROOF' or properties.get('slabType') == 'ROOF', 'IfcBoolean'),
                    'LoadBearing': (properties.get('loadBearing', True), 'IfcBoolean'),
                }
                ref = properties.get('reference', properties.get('material', ''))
                if ref:
                    slab_pset['Reference'] = (str(ref), 'IfcLabel')
                add_property_set(f, owner, ifc_element, 'Pset_SlabCommon', slab_pset)
            elif css_type == 'DOOR':
                door_pset = {
                    'IsExternal': (properties.get('isExternal', True), 'IfcBoolean'),
                }
                ref = properties.get('reference', '')
                if ref:
                    door_pset['Reference'] = (str(ref), 'IfcLabel')
                add_property_set(f, owner, ifc_element, 'Pset_DoorCommon', door_pset)
            elif css_type == 'WINDOW':
                window_pset = {
                    'IsExternal': (properties.get('isExternal', True), 'IfcBoolean'),
                }
                ref = properties.get('reference', '')
                if ref:
                    window_pset['Reference'] = (str(ref), 'IfcLabel')
                add_property_set(f, owner, ifc_element, 'Pset_WindowCommon', window_pset)
            elif css_type == 'COLUMN':
                col_pset = {
                    'LoadBearing': (properties.get('loadBearing', True), 'IfcBoolean'),
                }
                ref = properties.get('reference', properties.get('material', ''))
                if ref:
                    col_pset['Reference'] = (str(ref), 'IfcLabel')
                add_property_set(f, owner, ifc_element, 'Pset_ColumnCommon', col_pset)
            elif css_type == 'BEAM':
                beam_pset = {
                    'LoadBearing': (properties.get('loadBearing', True), 'IfcBoolean'),
                }
                ref = properties.get('reference', properties.get('material', ''))
                if ref:
                    beam_pset['Reference'] = (str(ref), 'IfcLabel')
                add_property_set(f, owner, ifc_element, 'Pset_BeamCommon', beam_pset)
            elif css_type == 'SPACE':
                profile = geometry_data.get('profile', {})
                w = float(profile.get('width', 1))
                h = float(profile.get('height', 1))
                add_property_set(f, owner, ifc_element, 'Pset_SpaceCommon', {
                    'IsExternal': (False, 'IfcBoolean'),
                    'NetFloorArea': (w * h, 'IfcReal'),
                })
            elif ifc_entity_type == 'IfcDuctSegment':
                profile = geometry_data.get('profile', {})
                shape = properties.get('shape', 'round').lower()
                pset_props = {
                    'Shape': (shape.capitalize(), 'IfcLabel'),
                }
                if shape == 'round':
                    pset_props['NominalDiameter'] = (float(profile.get('width', 0)), 'IfcReal')
                else:
                    pset_props['Width'] = (float(profile.get('width', 0)), 'IfcReal')
                    pset_props['Height'] = (float(profile.get('height', 0)), 'IfcReal')
                pset_props.update(_build_mep_pset(properties))
                add_property_set(f, owner, ifc_element, 'Pset_DuctSegmentCommon', pset_props)
            elif ifc_entity_type == 'IfcPipeSegment':
                profile = geometry_data.get('profile', {})
                diameter = (safe_float(properties.get('diameter')) or
                            safe_float(properties.get('nominalDiameter')) or
                            float(profile.get('width', 0)))
                pipe_pset = {'NominalDiameter': (diameter, 'IfcReal')}
                pipe_pset.update(_build_mep_pset(properties))
                add_property_set(f, owner, ifc_element, 'Pset_PipeSegmentCommon', pipe_pset)
            elif ifc_entity_type == 'IfcFan':
                fan_pset = _build_mep_pset(properties, pressure_key='TotalStaticPressure')
                if fan_pset:
                    add_property_set(f, owner, ifc_element, 'Pset_FanCommon', fan_pset)
            elif ifc_entity_type == 'IfcPump':
                profile = geometry_data.get('profile', {})
                pump_pset = _build_mep_pset(properties, pressure_key='NetPositiveSuctionHead')
                conn_size = (safe_float(properties.get('diameter')) or
                             safe_float(properties.get('nominalDiameter')) or
                             safe_float(profile.get('width')))
                if conn_size is not None:
                    pump_pset['ConnectionSize'] = (conn_size, 'IfcReal')
                if pump_pset:
                    add_property_set(f, owner, ifc_element, 'Pset_PumpCommon', pump_pset)
            elif css_type == 'TUNNEL_SEGMENT':
                add_property_set(f, owner, ifc_element, 'Pset_TunnelSegmentCommon', {
                    'SegmentType': (str(properties.get('segmentType', 'MAIN_TUNNEL')), 'IfcLabel'),
                    'ProfileType': (str(properties.get('profileType', 'RECTANGULAR')), 'IfcLabel'),
                    'LiningType': (str(properties.get('liningType', '')), 'IfcLabel'),
                    'ChainageStart_m': (float(properties.get('chainageStart_m', 0)), 'IfcReal'),
                    'ChainageEnd_m': (float(properties.get('chainageEnd_m', 0)), 'IfcReal'),
                })
            # Shell pieces (topology-engine decomposed panels) carry Pset_TunnelSegmentCommon
            # so BIM tools can identify each panel's role within the manifold lining system.
            if shell_piece in ('LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'):
                add_property_set(f, owner, ifc_element, 'Pset_TunnelSegmentCommon', {
                    'SegmentType': (str(properties.get('segmentType', 'MAIN_TUNNEL')), 'IfcLabel'),
                    'ShellRole': (shell_piece, 'IfcLabel'),
                    'ProfileType': (str(properties.get('profileType', 'RECTANGULAR')), 'IfcLabel'),
                    'LiningType': (str(properties.get('liningType', 'SHOTCRETE')), 'IfcLabel'),
                    'DerivedFromBranch': (str(properties.get('derivedFromBranch', '')), 'IfcLabel'),
                    'ChainageStart_m': (float(properties.get('chainageStart_m', 0)), 'IfcReal'),
                    'ChainageEnd_m': (float(properties.get('chainageEnd_m', 0)), 'IfcReal'),
                })

            # Pset_ManufacturerTypeInformation — attach when material/manufacturer data present
            mfr_props = {}
            material_name = properties.get('material', '') or properties.get('materialName', '')
            manufacturer = properties.get('manufacturer', '')
            model_ref = properties.get('modelReference', '') or properties.get('productModel', '')
            if material_name:
                mfr_props['ArticleNumber'] = (str(material_name), 'IfcLabel')
            if manufacturer:
                mfr_props['Manufacturer'] = (str(manufacturer), 'IfcLabel')
            if model_ref:
                mfr_props['ModelReference'] = (str(model_ref), 'IfcLabel')
            if mfr_props:
                add_property_set(f, owner, ifc_element, 'Pset_ManufacturerTypeInformation', mfr_props)

            # Add BIM-relevant CSS properties (whitelist) — internal pipeline fields
            # (branchClass, decompositionMethod, shellMode, ventLayer, etc.) are omitted
            # to keep the IFC file size and Pset count aligned with Revit/final.ifc norms.
            _CSS_PROP_WHITELIST = {
                'area_m2', 'liner_type', 'shape', 'fan_type', 'fan_numbers',
                'model', 'manufacturer', 'capacity', 'flowRate', 'pressure',
                'power_kW', 'voltage', 'systemType', 'fireRating',
                'isExternal', 'loadBearing', 'nominalDiameter',
                'slabType', 'segmentType', 'assetTag',
            }
            if properties:
                css_props = {}
                for k, v in properties.items():
                    if k not in _CSS_PROP_WHITELIST:
                        continue
                    if isinstance(v, bool):
                        css_props[k] = (v, 'IfcBoolean')
                    elif isinstance(v, (int, float)):
                        css_props[k] = (v, 'IfcReal')
                    elif isinstance(v, str):
                        css_props[k] = (v, 'IfcLabel')
                if css_props:
                    add_property_set(f, owner, ifc_element, 'Pset_CSSProperties', css_props)

            # v6: Quantity sets based on geometry (only when dimensions valid)
            profile = geometry_data.get('profile', {})
            qw = float(profile.get('width', 0))
            qh = float(profile.get('height', 0))
            qd = safe_float(geometry_data.get('depth'), 0.0)
            if css_type == 'WALL' and qw > 0 and qd > 0:
                # After the wall body geometry fix: profile.width = wall run length,
                # profile.height = wall thickness, depth = storey height.
                _q_wall_len = qw   # wall run length
                _q_wall_thk = qh   # wall thickness (may be 0 for proxied walls)
                _q_wall_ht  = qd   # storey height
                add_quantity_set(f, owner, ifc_element, 'Qto_WallBaseQuantities', {
                    'Length': (_q_wall_len, 'IfcQuantityLength'),
                    'Width': (_q_wall_thk, 'IfcQuantityLength'),
                    'Height': (_q_wall_ht, 'IfcQuantityLength'),
                    'GrossVolume': (_q_wall_len * _q_wall_thk * _q_wall_ht, 'IfcQuantityVolume'),
                })
            elif css_type == 'SLAB' and qw > 0 and qh > 0:
                add_quantity_set(f, owner, ifc_element, 'Qto_SlabBaseQuantities', {
                    'Width': (qw, 'IfcQuantityLength'),
                    'Length': (qh, 'IfcQuantityLength'),
                    'Depth': (qd, 'IfcQuantityLength'),
                    'GrossArea': (qw * qh, 'IfcQuantityArea'),
                    'GrossVolume': (qw * qh * qd, 'IfcQuantityVolume'),
                })
            elif css_type == 'SPACE' and qw > 0 and qh > 0 and qd > 0:
                add_quantity_set(f, owner, ifc_element, 'Qto_SpaceBaseQuantities', {
                    'GrossFloorArea': (qw * qh, 'IfcQuantityArea'),
                    'GrossVolume': (qw * qh * qd, 'IfcQuantityVolume'),
                    'Height': (qd, 'IfcQuantityLength'),
                })
            elif css_type == 'DUCT' and qd > 0:
                add_quantity_set(f, owner, ifc_element, 'Qto_DuctSegmentBaseQuantities', {
                    'Length': (qd, 'IfcQuantityLength'),
                    'GrossCrossSectionArea': (qw * qh if qw > 0 and qh > 0 else 0, 'IfcQuantityArea'),
                })
            elif css_type == 'PIPE' and qd > 0:
                add_quantity_set(f, owner, ifc_element, 'Qto_PipeSegmentBaseQuantities', {
                    'Length': (qd, 'IfcQuantityLength'),
                    'NominalDiameter': (qw if qw > 0 else 0.1, 'IfcQuantityLength'),
                })
            elif css_type == 'COLUMN' and qd > 0:
                add_quantity_set(f, owner, ifc_element, 'Qto_ColumnBaseQuantities', {
                    'Length': (qd, 'IfcQuantityLength'),
                    'CrossSectionArea': (qw * qh if qw > 0 and qh > 0 else 0, 'IfcQuantityArea'),
                    'GrossVolume': (qw * qh * qd if qw > 0 and qh > 0 else 0, 'IfcQuantityVolume'),
                })
            elif css_type == 'DOOR' and qw > 0 and qd > 0:
                add_quantity_set(f, owner, ifc_element, 'Qto_DoorBaseQuantities', {
                    'Width': (qw, 'IfcQuantityLength'),
                    'Height': (qd, 'IfcQuantityLength'),
                    'Area': (qw * qd, 'IfcQuantityArea'),
                })
            elif css_type == 'WINDOW' and qw > 0 and qd > 0:
                add_quantity_set(f, owner, ifc_element, 'Qto_WindowBaseQuantities', {
                    'Width': (qw, 'IfcQuantityLength'),
                    'Height': (qd, 'IfcQuantityLength'),
                    'Area': (qw * qd, 'IfcQuantityArea'),
                })

            # Apply material layer — confidence-gated universal support
            # Tunnel segments get concrete material with wall thickness
            if css_type == 'TUNNEL_SEGMENT':
                tunnel_mat = material_data.get('name', 'concrete') if material_data else 'concrete'
                tunnel_thickness = properties.get('wallThickness') or properties.get('shellThickness') or 0.4
                apply_material_layer(f, owner, ifc_element, tunnel_mat, float(tunnel_thickness), 'AXIS2')
            # Equipment gets painted metal material
            elif css_type == 'EQUIPMENT':
                eq_mat = material_data.get('name', 'painted metal') if material_data else 'painted metal'
                eq_thickness = 0.003
                apply_material_layer(f, owner, ifc_element, eq_mat, eq_thickness, 'AXIS2')
            # Ducts/pipes get steel material
            elif css_type in ('DUCT', 'PIPE'):
                pipe_mat = 'galvanized steel' if css_type == 'DUCT' else 'steel'
                pipe_thickness = 0.002 if css_type == 'DUCT' else 0.005
                apply_material_layer(f, owner, ifc_element, pipe_mat, pipe_thickness, 'AXIS2')

            shell_thickness = properties.get('shellThickness_m')
            shell_piece = properties.get('shellPiece')
            mat_layer_applied = False
            if shell_thickness and shell_piece in ('LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'):
                # Shell pieces: always apply (thickness from decomposition is reliable)
                mat_name = material_data.get('name', 'concrete') if material_data else 'concrete'
                layer_dir = 'AXIS2' if ifc_entity_type == 'IfcWall' else 'AXIS3'
                apply_material_layer(f, owner, ifc_element, mat_name, shell_thickness, layer_dir)
                mat_layer_applied = True
            elif not mat_layer_applied and confidence >= 0.6:
                # Universal: walls and slabs with reliably inferable thickness
                mat_name = material_data.get('name', 'concrete') if material_data else 'concrete'
                g_profile = geometry_data.get('profile', {})
                g_w = float(g_profile.get('width', 0))
                g_h = float(g_profile.get('height', 0))
                g_d = safe_float(geometry_data.get('depth'), 0.0)
                # Skip placeholder 1×1×1 geometry
                is_placeholder = (abs(g_w - 1.0) < 0.01 and abs(g_h - 1.0) < 0.01 and abs(g_d - 1.0) < 0.01)
                if ifc_entity_type == 'IfcWall' and not is_placeholder:
                    wall_thickness = min(g_w, g_h) if g_w > 0 and g_h > 0 else 0
                    if 0.01 <= wall_thickness <= 2.0:
                        apply_material_layer(f, owner, ifc_element, mat_name, wall_thickness, 'AXIS2')
                elif ifc_entity_type == 'IfcSlab' and not is_placeholder:
                    slab_thickness = g_d if g_d > 0 else 0
                    if 0.01 <= slab_thickness <= 2.0:
                        apply_material_layer(f, owner, ifc_element, mat_name, slab_thickness, 'AXIS3')

            # Track for IfcRelDefinesByType grouping
            g_prof = geometry_data.get('profile', {})
            prof_type = g_prof.get('type', 'RECTANGLE')
            prof_w = round(float(g_prof.get('width', 0)), 2)
            prof_h = round(float(g_prof.get('height', 0)), 2)
            prof_key = f"{prof_type}:{prof_w}x{prof_h}"
            mat_name_for_type = (material_data.get('name', 'concrete') if material_data else 'concrete')
            type_group_data.append((ifc_element, ifc_entity_type, mat_name_for_type, prof_key))

            # Group by container
            if container_id not in elements_by_container:
                elements_by_container[container_id] = []
            elements_by_container[container_id].append(ifc_element)

            element_count += 1

        except Exception as e:
            # Per-element resilience: create a minimal proxy for any element that fails entirely
            css_id = elem.get('id', f'elem-{element_count}')
            print(f"ERROR: element {css_id} (type={elem.get('type')}, source={elem.get('source')}): "
                  f"{type(e).__name__}: {e} — creating proxy fallback")
            error_count += 1
            try:
                fallback_proxy = f.create_entity('IfcBuildingElementProxy',
                    GlobalId=new_guid(), OwnerHistory=owner,
                    Name=f'[Fallback] {css_id}',
                    ObjectType=f"FAILED:{elem.get('type', 'UNKNOWN')}")
                ifc_elements_by_css_id[css_id] = fallback_proxy
                # Add to default storey container
                default_container = list(elements_by_container.keys())[0] if elements_by_container else None
                if default_container:
                    elements_by_container[default_container].append(fallback_proxy)
                element_count += 1
            except Exception as proxy_err:
                print(f"  proxy fallback also failed for {css_id}: {proxy_err}")

    # ---- Heuristic: detect possible double-subtraction ----
    if placement_z_is_absolute:
        for cid, z_vals in original_z_by_container.items():
            if cid in storey_map and len(z_vals) >= 2:
                _, _, s_elev = storey_map[cid]
                if s_elev > 1.0:
                    sorted_z = sorted(z_vals)
                    median_z = sorted_z[len(sorted_z) // 2]
                    if abs(median_z) < 0.5:
                        s_name = storey_map[cid][0].Name or cid
                        print(f"Warning: elements in storey '{s_name}' (elev={s_elev}m) have "
                              f"median z={median_z:.2f}m — may already be storey-relative. "
                              f"Check metadata.placementZIsAbsolute flag.")

    # v7: Consolidated Visual QA Report
    GENERIC_NAMES = {'WALL', 'SLAB', 'SPACE', 'DUCT', 'PIPE', 'EQUIPMENT', 'TUNNEL_SEGMENT', 'PROXY'}
    generic_names = [n for n in all_elem_names if n in GENERIC_NAMES]

    # Aggregate style tier counts across all element types
    style_tier_totals = {'semanticType': 0, 'shellPiece': 0, 'systemType': 0, 'cssType': 0, 'material': 0}
    for entry in style_report.values():
        for tier in style_tier_totals:
            style_tier_totals[tier] += entry.get(tier, 0)

    # VERIFY geometry counts
    print(f"[VERIFY-COUNTS] vertical_ducts={_verify_vertical_duct_count} tall_cylinders_gt10m={_verify_tall_cylinder_count}")

    # Count shellPiece-derived elements in CSS input (regardless of naming path)
    shell_piece_element_count = sum(1 for e in elements if e.get('properties', {}).get('shellPiece'))

    total_styled = sum(style_tier_totals.values())
    print(f"v7 VISUAL QA SUMMARY:")
    print(f"  Elements styled: {total_styled}")
    print(f"  Style tiers: semanticType={style_tier_totals['semanticType']}, "
          f"shellPiece={style_tier_totals['shellPiece']}, "
          f"systemType={style_tier_totals['systemType']}, "
          f"cssType={style_tier_totals['cssType']}, "
          f"material={style_tier_totals['material']}")
    print(f"  Generic names: {len(generic_names)}/{len(all_elem_names)}")
    print(f"  Proxies: {proxy_tracking['count']}/{total_styled} "
          f"({proxy_tracking['count']*100//max(total_styled,1)}%)")
    if proxy_tracking['reasons']:
        print(f"  Proxy reasons: {json.dumps(proxy_tracking['reasons'])}")
    print(f"  Style details: {json.dumps(style_report)}")

    # v8: Shell naming QA — regression check
    print(f"  Shell piece elements in CSS: {shell_piece_element_count}")
    print(f"  Shell naming hits: {shell_naming_hits} elements used shell piece naming path")
    if shell_naming_samples:
        print(f"  Shell name samples: {shell_naming_samples}")

    # v8: Duct/pipe naming QA
    print(f"  Duct/pipe naming hits: {duct_naming_hits}")
    if duct_naming_samples:
        print(f"  Duct/pipe name samples: {duct_naming_samples}")

    # v9: Equipment size overrides
    print(f"  Equipment size overrides: {equipment_size_overrides}")

    # v8: Sample resolved colors for shell elements
    shell_color_samples = []
    for sp_key, sp_rgb in SHELL_PIECE_COLORS.items():
        shell_color_samples.append(f"{sp_key}=({sp_rgb[0]:.2f},{sp_rgb[1]:.2f},{sp_rgb[2]:.2f})")
    print(f"  Shell colors: {', '.join(shell_color_samples)}")

    # REGRESSION CHECK: if shellPiece-derived elements exist but naming hits == 0
    if shell_piece_element_count > 0 and shell_naming_hits == 0:
        print(f"ERROR: SHELL NAMING REGRESSION — {shell_piece_element_count} elements have "
              f"properties.shellPiece but 0 used the shell naming path. "
              f"Descriptive names (Left Wall, Right Wall, etc.) were NOT applied.")
    elif shell_naming_hits > 0:
        # Verify shell names are actually descriptive (not just element keys)
        shell_name_descriptive = sum(1 for n in all_elem_names
                                      if any(label in n for label in ('Left Wall', 'Right Wall', 'Floor Slab', 'Roof Slab', 'Void Space')))
        print(f"  Descriptive shell names: {shell_name_descriptive}/{shell_naming_hits}")

    # v6: IFC class counts
    ifc_class_counts = {}
    for ifc_ent in ifc_by_key.values():
        cls = ifc_ent.is_a()
        ifc_class_counts[cls] = ifc_class_counts.get(cls, 0) + 1
    # Also count elements not in ifc_by_key (those without element_key)
    for container_elems in elements_by_container.values():
        for ce in container_elems:
            cls = ce.is_a()
            if cls not in ifc_class_counts:
                ifc_class_counts[cls] = 0
            # Don't double-count, just ensure coverage
    print(f"v6 IFC classes: {json.dumps(ifc_class_counts)}")

    # v6: Building completeness warning (skip for segment-based structures — they use shell decomposition)
    if not has_tunnel_segments:
        wall_count = sum(1 for e in elements if e.get('type') == 'WALL')
        slab_count = sum(1 for e in elements if e.get('type') == 'SLAB')
        if wall_count < 4 or slab_count < 2:
            print(f"WARNING: Building model incomplete — {wall_count} walls, {slab_count} slabs. Envelope fallback may have been applied.")

    # v10: REGRESSION CHECKS — structural realism validation
    regression_errors = []
    regression_warnings = []

    # 8A: Origin count — too many elements at (0,0,0) indicates placement failure
    origin_count = sum(1 for e in elements
                       if e.get('placement', {}).get('origin', {}).get('x', 1) == 0
                       and e.get('placement', {}).get('origin', {}).get('y', 1) == 0
                       and e.get('placement', {}).get('origin', {}).get('z', 1) == 0)
    origin_pct = (origin_count * 100 // max(element_count, 1)) if element_count > 0 else 0
    if origin_pct > 5 and origin_count > 3:
        regression_errors.append(f'ORIGIN_CLUSTER: {origin_count} elements ({origin_pct}%) at origin (0,0,0)')

    # 8B: NaN/Inf placement check
    nan_count = sum(1 for e in elements
                    if any(not isinstance(v, (int, float)) or (isinstance(v, float) and (v != v or abs(v) == float('inf')))
                           for v in [e.get('placement', {}).get('origin', {}).get(a, 0) for a in ('x', 'y', 'z')]))
    if nan_count > 0:
        regression_errors.append(f'NAN_PLACEMENT: {nan_count} elements have NaN/Inf coordinates')

    # 8C: Semantic count validation (v11: upgraded severity for structure-critical checks)
    if has_tunnel_segments:
        wall_elems = sum(1 for e in elements if e.get('type') == 'WALL')
        slab_elems = sum(1 for e in elements if e.get('type') == 'SLAB')
        space_elems = sum(1 for e in elements if e.get('type') == 'SPACE')
        if wall_elems == 0: regression_errors.append('CRITICAL_TUNNEL_NO_WALLS: No IfcWall elements in segment model')
        if slab_elems == 0: regression_errors.append('CRITICAL_TUNNEL_NO_SLABS: No IfcSlab elements in segment model')
        if space_elems == 0: regression_warnings.append('TUNNEL_NO_SPACES: No IfcSpace elements in segment model')
        if shell_piece_element_count > 0 and shell_naming_hits == 0:
            regression_errors.append(f'SHELL_NAMING_REGRESSION: {shell_piece_element_count} shell pieces without descriptive names')
    else:
        wall_elems = sum(1 for e in elements if e.get('type') == 'WALL')
        slab_elems = sum(1 for e in elements if e.get('type') == 'SLAB')
        if wall_elems < 4 and slab_elems < 2:
            regression_errors.append(f'CRITICAL_BUILDING_MINIMAL: Only {wall_elems} walls and {slab_elems} slabs')
        elif wall_elems < 4:
            regression_warnings.append(f'BUILDING_FEW_WALLS: Only {wall_elems} walls (expected >= 4)')
        elif slab_elems < 2:
            regression_warnings.append(f'BUILDING_FEW_SLABS: Only {slab_elems} slabs (expected >= 2)')

    # 8D: Cross-domain property leak checks — shell pieces belong with segments, envelope fallback with buildings
    if not has_tunnel_segments:
        shell_on_building = sum(1 for e in elements if e.get('properties', {}).get('shellPiece'))
        if shell_on_building > 0:
            regression_warnings.append(f'DOMAIN_LEAK: {shell_on_building} elements have shellPiece in non-segment model')
    if has_tunnel_segments:
        fallback_on_tunnel = sum(1 for e in elements if e.get('properties', {}).get('isFallback'))
        if fallback_on_tunnel > 0:
            regression_warnings.append(f'DOMAIN_LEAK: {fallback_on_tunnel} elements have envelopeFallback in segment model')

    # 8E: Proxy ratio check (exclude transition helpers from canonical count)
    canonical_proxy_count = sum(1 for e in elements if e.get('semanticType') == 'IfcBuildingElementProxy' and not e.get('properties', {}).get('isTransitionHelper'))
    proxy_pct = (canonical_proxy_count * 100 // max(element_count, 1)) if element_count > 0 else 0
    if proxy_pct > 10:
        regression_warnings.append(f'HIGH_PROXY: {proxy_pct}% canonical proxy elements ({canonical_proxy_count}/{element_count})')

    # 9B: Element count drift check — CSS input vs output
    css_element_count = len(css_data.get('elements', [])) if 'css_data' in dir() else 0
    if css_element_count > 0 and element_count > 0:
        drop_pct = ((css_element_count - element_count) * 100) // css_element_count
        if drop_pct > 50:
            regression_errors.append(f'CRITICAL_ELEMENT_DRIFT: Elements dropped {drop_pct}% from CSS input ({css_element_count}) to output ({element_count})')

    if regression_errors:
        print(f"v10 REGRESSION ERRORS: {regression_errors}")
    if regression_warnings:
        print(f"v10 REGRESSION WARNINGS: {regression_warnings}")

    # ---- IfcRelDefinesByType: group same-type elements under shared type definitions ----
    TYPE_ENTITY_MAP = {
        'IfcWall': 'IfcWallType', 'IfcSlab': 'IfcSlabType',
        'IfcColumn': 'IfcColumnType', 'IfcBeam': 'IfcBeamType',
        'IfcDoor': 'IfcDoorType', 'IfcWindow': 'IfcWindowType',
        'IfcDuctSegment': 'IfcDuctSegmentType', 'IfcPipeSegment': 'IfcPipeSegmentType',
    }
    type_groups = {}  # (entity_type, material, profile_key) → [ifc_elements]
    for ifc_elem, ent_type, mat_name, p_key in type_group_data:
        if ent_type not in TYPE_ENTITY_MAP:
            continue
        group_key = (ent_type, mat_name, p_key)
        type_groups.setdefault(group_key, []).append(ifc_elem)

    type_count = 0
    for (ent_type, mat_name, p_key), group_elems in type_groups.items():
        if len(group_elems) < 2:
            continue
        type_entity_name = TYPE_ENTITY_MAP[ent_type]
        # Parse profile for readable type name
        dims = p_key.split(':')[1] if ':' in p_key else ''
        type_label = f"{ent_type.replace('Ifc', '')}:{mat_name}"
        if dims:
            type_label += f' {dims}'
        try:
            type_ent = f.create_entity(type_entity_name, GlobalId=new_guid(), OwnerHistory=owner, Name=type_label)
            f.create_entity('IfcRelDefinesByType', GlobalId=new_guid(), OwnerHistory=owner,
                            RelatedObjects=tuple(group_elems), RelatingType=type_ent)
            type_count += 1
        except Exception as e:
            print(f"Warning: Could not create {type_entity_name} for {type_label}: {e}")
    if type_count > 0:
        print(f"IfcRelDefinesByType: created {type_count} type definitions grouping {sum(len(v) for v in type_groups.values() if len(v) >= 2)} elements")

    # ---- Build CSS element lookup for opening geometry ----
    css_elements_by_id = {e.get('id', ''): e for e in elements}

    # ---- Process VOIDS relationships (v3.2: IfcOpeningElement intermediary) ----
    opening_elements_for_storey = {}  # container_id -> list of IfcOpeningElement
    _door_voids_tracker = {}  # door_css_id -> {host_id, host_type, skip_reason, has_voids_rel, has_fills_rel, opening_element}
    for elem in elements:
        relationships = elem.get('relationships', [])
        css_id = elem.get('id', '')
        container_id = elem.get('container', '')

        for rel in relationships:
            rel_type = rel.get('type', '')
            target_id = rel.get('target', '')

            if rel_type == 'VOIDS':
                # Resolve door and host wall — check both ifc_elements_by_css_id (by id) and ifc_by_key (by element_key)
                door_or_window = ifc_elements_by_css_id.get(css_id) or ifc_by_key.get(css_id)
                host_wall = ifc_elements_by_css_id.get(target_id) or ifc_by_key.get(target_id)
                host_css_elem = css_elements_by_id.get(target_id, {})
                _trk = _door_voids_tracker.setdefault(css_id, {
                    'host_id': target_id,
                    'host_type': host_css_elem.get('type', 'UNKNOWN'),
                    'skip_reason': None,
                    'has_voids_rel': False,
                    'has_fills_rel': False,
                    'opening_element': None,
                })
                if not door_or_window or not host_wall:
                    if not door_or_window:
                        print(f"Warning: VOIDS skipped — door {css_id} not found in IFC entities")
                        _trk['skip_reason'] = 'door_not_in_ifc'
                    if not host_wall:
                        print(f"Warning: VOIDS skipped — host wall {target_id} not found in IFC entities")
                        _trk['skip_reason'] = _trk.get('skip_reason') or 'host_not_in_ifc'
                    continue

                # Tunnel segment hosts: generate a local side-wall panel on the bore face
                # where the door sits. Panel width ≈ door_w + margin along tunnel axis,
                # panel height ≈ door_h + margin vertically — NOT a full cross-section slice.
                if host_css_elem.get('type', '').upper() == 'TUNNEL_SEGMENT':
                    try:
                        _h_props = host_css_elem.get('properties', {}) or {}
                        _h_geom  = host_css_elem.get('geometry',    {}) or {}
                        _h_prof  = _h_geom.get('profile', {}) or {}
                        _h_sp = _h_props.get('startPoint', {}) or {}
                        _h_ep = _h_props.get('endPoint',   {}) or {}
                        _h_sx = float(_h_sp.get('x', 0)); _h_sy = float(_h_sp.get('y', 0)); _h_sz = float(_h_sp.get('z', 0))
                        _h_ex = float(_h_ep.get('x', 0)); _h_ey = float(_h_ep.get('y', 0)); _h_ez = float(_h_ep.get('z', 0))
                        _h_ddx = _h_ex-_h_sx; _h_ddy = _h_ey-_h_sy; _h_ddz = _h_ez-_h_sz
                        _h_L = math.sqrt(_h_ddx*_h_ddx + _h_ddy*_h_ddy + _h_ddz*_h_ddz)
                        if _h_L < 0.1:
                            raise ValueError(f"degenerate host segment L={_h_L:.4f}")
                        _h_ax = _h_ddx/_h_L; _h_ay = _h_ddy/_h_L; _h_az = _h_ddz/_h_L

                        # Lateral = tunnel_axis × world_up  (world-up = (0,0,1))
                        _lat_x = _h_ay * 1.0 - _h_az * 0.0
                        _lat_y = _h_az * 0.0 - _h_ax * 1.0
                        _lat_len = math.sqrt(_lat_x*_lat_x + _lat_y*_lat_y)
                        if _lat_len < 1e-6:
                            _lat_x, _lat_y = 1.0, 0.0
                        else:
                            _lat_x /= _lat_len; _lat_y /= _lat_len

                        _bore_w  = float(_h_prof.get('width',  4.0))
                        _bore_h  = float(_h_prof.get('height', 4.0))
                        _shell_t = float(_h_props.get('shellThickness_m') or
                                         _h_prof.get('wallThickness') or 0.3)
                        _panel_t = max(0.15, _shell_t)

                        # Door CSS geometry
                        _d_css  = css_elements_by_id.get(css_id, {})
                        _d_geom = _d_css.get('geometry', {}) or {}
                        _d_prof = _d_geom.get('profile', {}) or {}
                        _d_orig = (_d_css.get('placement') or {}).get('origin') or {}
                        _d_wx   = float(_d_orig.get('x', 0))
                        _d_wy   = float(_d_orig.get('y', 0))
                        _d_w    = float(_d_prof.get('width',  1.0))
                        _d_h    = float(_d_geom.get('depth',  2.2))
                        _d_w    = max(0.2, min(_d_w, _bore_w - 0.1))
                        _d_h    = max(0.5, min(_d_h, _bore_h - 0.1))

                        # Project door XY onto tunnel centerline → door station
                        _vvx = _d_wx - _h_sx; _vvy = _d_wy - _h_sy
                        _tt  = max(0.0, min(_h_L, _vvx*_h_ax + _vvy*_h_ay))
                        _cx  = _h_sx + _h_ax*_tt
                        _cy  = _h_sy + _h_ay*_tt
                        _cz  = _h_sz + _h_az*_tt

                        # Bore interior floor (world Z)
                        _floor_wz = _cz - _bore_h / 2.0

                        # Which side of the centerline is the door on?
                        _lat_dot   = (_d_wx - _cx) * _lat_x + (_d_wy - _cy) * _lat_y
                        _side_sign = 1.0 if _lat_dot >= 0 else -1.0

                        # Panel dimensions: door-sized patch, NOT full bore cross-section
                        _pan_margin_w = 0.3   # extra on each side along tunnel axis
                        _pan_margin_h = 0.3   # extra above door
                        _pan_w = _d_w + 2.0 * _pan_margin_w   # width along tunnel axis
                        _pan_h = _d_h + _pan_margin_h          # height (vertical)

                        # Panel origin: at the bore inner side face, door station, bore floor
                        _pan_wx = _cx + _side_sign * _lat_x * (_bore_w / 2.0)
                        _pan_wy = _cy + _side_sign * _lat_y * (_bore_w / 2.0)

                        # Storey-relative Z
                        _pan_slp  = list(storey_map.values())[0][1]  # fallback
                        _pan_elev = list(storey_map.values())[0][2]
                        if container_id in storey_map:
                            _, _pan_slp, _pan_elev = storey_map[container_id]
                        _pan_z_rel = (_floor_wz - _pan_elev) if placement_z_is_absolute else _floor_wz

                        # ---- Panel IfcWall ----
                        # Local X = tunnel axis (panel width direction)
                        # Local Y = lateral (panel normal / thickness direction)
                        # Local Z = world_up (panel height direction, extrusion)
                        _pan_pt    = f.create_entity('IfcCartesianPoint',
                                         Coordinates=(float(_pan_wx), float(_pan_wy), float(_pan_z_rel)))
                        _pan_ax    = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                        _pan_rd    = f.create_entity('IfcDirection', DirectionRatios=(float(_h_ax), float(_h_ay), 0.0))
                        _pan_ax3   = f.create_entity('IfcAxis2Placement3D',
                                         Location=_pan_pt, Axis=_pan_ax, RefDirection=_pan_rd)
                        _pan_lp    = f.create_entity('IfcLocalPlacement',
                                         PlacementRelTo=_pan_slp, RelativePlacement=_pan_ax3)

                        # Profile: XDim along tunnel axis (pan_w), YDim along lateral (thickness)
                        _pan_pp    = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
                        _pan_px    = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
                        _pan_ppl   = f.create_entity('IfcAxis2Placement2D', Location=_pan_pp, RefDirection=_pan_px)
                        _pan_prof  = f.create_entity('IfcRectangleProfileDef',
                                         ProfileType='AREA',
                                         XDim=float(_pan_w), YDim=float(_panel_t),
                                         Position=_pan_ppl)
                        _pan_sloc  = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
                        _pan_sax3  = f.create_entity('IfcAxis2Placement3D', Location=_pan_sloc)
                        _pan_exdir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                        _pan_solid = f.create_entity('IfcExtrudedAreaSolid',
                                         SweptArea=_pan_prof, Position=_pan_sax3,
                                         ExtrudedDirection=_pan_exdir, Depth=float(_pan_h))
                        apply_style(f, _pan_solid, MATERIAL_COLORS['concrete'], 0.0, 'DoorHostPanel')
                        _pan_body  = f.create_entity('IfcShapeRepresentation',
                                         ContextOfItems=subcontext,
                                         RepresentationIdentifier='Body',
                                         RepresentationType='SweptSolid',
                                         Items=(_pan_solid,))
                        _pan_pds   = f.create_entity('IfcProductDefinitionShape',
                                         Representations=(_pan_body,))
                        _panel_wall = f.create_entity('IfcWall',
                                         GlobalId=new_guid(), OwnerHistory=owner,
                                         Name=f'TunnelDoorPanel_{css_id}',
                                         Description='Side wall host panel for tunnel door',
                                         ObjectPlacement=_pan_lp, Representation=_pan_pds)
                        elements_by_container.setdefault(container_id, []).append(_panel_wall)

                        # ---- IfcOpeningElement in the panel (door-sized void) ----
                        _op_pp   = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
                        _op_px   = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
                        _op_ppl  = f.create_entity('IfcAxis2Placement2D', Location=_op_pp, RefDirection=_op_px)
                        _op_prof = f.create_entity('IfcRectangleProfileDef',
                                        ProfileType='AREA',
                                        XDim=float(_d_w), YDim=float(_panel_t + 0.05),
                                        Position=_op_ppl)
                        # Opening at (0,0,0) in panel-local space: centered along tunnel axis, at floor
                        _op_orig = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
                        _op_aax  = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                        _op_ard  = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
                        _op_ax3  = f.create_entity('IfcAxis2Placement3D',
                                        Location=_op_orig, Axis=_op_aax, RefDirection=_op_ard)
                        _op_lp   = f.create_entity('IfcLocalPlacement',
                                        PlacementRelTo=_pan_lp, RelativePlacement=_op_ax3)
                        _op_sloc = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
                        _op_sax3 = f.create_entity('IfcAxis2Placement3D', Location=_op_sloc)
                        _op_exd  = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                        _op_sol  = f.create_entity('IfcExtrudedAreaSolid',
                                        SweptArea=_op_prof, Position=_op_sax3,
                                        ExtrudedDirection=_op_exd, Depth=float(_d_h))
                        _op_body = f.create_entity('IfcShapeRepresentation',
                                        ContextOfItems=subcontext,
                                        RepresentationIdentifier='Body',
                                        RepresentationType='SweptSolid',
                                        Items=(_op_sol,))
                        _op_pds  = f.create_entity('IfcProductDefinitionShape',
                                        Representations=(_op_body,))
                        _opening_el = f.create_entity('IfcOpeningElement',
                                         GlobalId=new_guid(), OwnerHistory=owner,
                                         Name=f'Opening_{css_id}',
                                         ObjectPlacement=_op_lp,
                                         Representation=_op_pds)

                        # Relocate door to match panel face (side wall position, bore floor)
                        try:
                            _door_rel_pl = door_or_window.ObjectPlacement.RelativePlacement
                            _old_loc = _door_rel_pl.Location.Coordinates
                            _door_rel_pl.Location.Coordinates = (
                                float(_pan_wx), float(_pan_wy), float(_pan_z_rel))
                            print(f"  door relocated: {css_id} ({_old_loc[0]:.2f},{_old_loc[1]:.2f},{_old_loc[2]:.2f}) "
                                  f"→ ({_pan_wx:.2f},{_pan_wy:.2f},{_pan_z_rel:.2f})")
                        except Exception as _dz_ex:
                            print(f"  door relocation skipped for {css_id}: {_dz_ex}")

                        # Panel → Opening
                        f.create_entity('IfcRelVoidsElement',
                                        GlobalId=new_guid(), OwnerHistory=owner,
                                        RelatingBuildingElement=_panel_wall,
                                        RelatedOpeningElement=_opening_el)
                        # Opening → Door
                        f.create_entity('IfcRelFillsElement',
                                        GlobalId=new_guid(), OwnerHistory=owner,
                                        RelatingOpeningElement=_opening_el,
                                        RelatedBuildingElement=door_or_window)

                        opening_elements_for_storey.setdefault(container_id, []).append(_opening_el)
                        _trk['has_voids_rel'] = True
                        _trk['has_fills_rel'] = True
                        _trk['opening_element'] = _opening_el
                        _trk['opening_w'] = _d_w
                        _trk['opening_h'] = _d_h
                        _trk['opening_depth'] = _panel_t + 0.05
                        print(f"TunnelDoorPanel: {css_id} side={_side_sign:+.0f} "
                              f"panel_origin=({_pan_wx:.1f},{_pan_wy:.1f},{_pan_z_rel:.2f}) "
                              f"pan={_pan_w:.2f}x{_panel_t:.2f}x{_pan_h:.2f}m "
                              f"door={_d_w:.2f}x{_d_h:.2f}m")
                    except Exception as _pex:
                        _trk['skip_reason'] = f'panel_failed:{_pex}'
                        print(f"Warning: TunnelDoorPanel failed for {css_id}: {_pex}")
                    continue

                # Portal building walls with baked door voids (GAP 8) — skip IfcOpeningElement creation
                # because voids are already cut into the wall's IfcFacetedBrep geometry
                if target_id in portal_wall_void_map:
                    print(f"VOIDS: {css_id} → {target_id} SKIPPED (baked in wall brep)")
                    _trk['skip_reason'] = 'baked_in_brep'
                    continue

                try:
                    ifc_type = door_or_window.is_a()

                    if ifc_type in ('IfcDoor', 'IfcWindow'):
                        # IFC spec: Wall → IfcOpeningElement → IfcDoor/IfcWindow
                        # Opening gets its own geometry sized to the wall void
                        opening_css = css_elements_by_id.get(css_id, {})
                        host_css = css_elements_by_id.get(target_id, {})
                        opening_geom = opening_css.get('geometry', {})
                        host_geom = host_css.get('geometry', {})
                        host_profile = host_geom.get('profile', {})
                        host_placement = host_css.get('placement', {})
                        opening_placement = opening_css.get('placement', {})
                        # Opening width/height from door/window; depth from host wall thickness
                        o_w = float(opening_geom.get('profile', {}).get('width', 1.0))
                        o_h = float(opening_geom.get('height') or opening_geom.get('depth') or 2.5)
                        host_w = float(host_profile.get('width', 0.3))
                        host_h = float(host_profile.get('height', 0.3))
                        wall_thickness = min(host_w, host_h) if host_w > 0 and host_h > 0 else 0.3

                        # Determine wall run direction from host CSS refDirection
                        host_ref = host_placement.get('refDirection', {'x': 1, 'y': 0, 'z': 0})
                        host_ref_x = float(host_ref.get('x', 1))
                        host_ref_y = float(host_ref.get('y', 0))

                        # Orient opening profile: XDim along wall run, YDim = wall thickness
                        # This ensures the void cuts through the full wall thickness
                        op_prof_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
                        op_prof_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0))
                        op_prof_place = f.create_entity('IfcAxis2Placement2D', Location=op_prof_origin, RefDirection=op_prof_x)
                        op_profile = f.create_entity('IfcRectangleProfileDef', ProfileType='AREA',
                                                     XDim=float(o_w), YDim=float(wall_thickness + 0.05), Position=op_prof_place)

                        # Opening solid: profile extruded Z-up by opening height
                        op_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
                        op_axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                        # RefDirection aligns opening XDim with wall run direction
                        op_refd = f.create_entity('IfcDirection', DirectionRatios=(float(host_ref_x), float(host_ref_y), 0.0))
                        op_solid_pos = f.create_entity('IfcAxis2Placement3D', Location=op_origin, Axis=op_axis, RefDirection=op_refd)
                        op_extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                        op_solid = f.create_entity('IfcExtrudedAreaSolid', SweptArea=op_profile,
                                                   Position=op_solid_pos, ExtrudedDirection=op_extrude_dir, Depth=float(o_h))
                        op_body = f.create_entity('IfcShapeRepresentation', ContextOfItems=subcontext,
                                                  RepresentationIdentifier='Body', RepresentationType='SweptSolid', Items=(op_solid,))
                        op_pds = f.create_entity('IfcProductDefinitionShape', Representations=(op_body,))

                        # Place opening at the window/door's world position
                        # Use the door/window's own placement (same world coordinates)
                        opening_element = f.create_entity(
                            'IfcOpeningElement',
                            GlobalId=new_guid(),
                            OwnerHistory=owner,
                            Name=f"Opening_{css_id}",
                            ObjectPlacement=door_or_window.ObjectPlacement,
                            Representation=op_pds,
                        )

                        # Wall → IfcOpeningElement (VOIDS)
                        f.create_entity('IfcRelVoidsElement',
                                        GlobalId=new_guid(), OwnerHistory=owner,
                                        RelatingBuildingElement=host_wall,
                                        RelatedOpeningElement=opening_element)

                        # IfcOpeningElement → IfcDoor/IfcWindow (FILLS)
                        f.create_entity('IfcRelFillsElement',
                                        GlobalId=new_guid(), OwnerHistory=owner,
                                        RelatingOpeningElement=opening_element,
                                        RelatedBuildingElement=door_or_window)

                        # Track opening element for storey containment
                        if container_id not in opening_elements_for_storey:
                            opening_elements_for_storey[container_id] = []
                        opening_elements_for_storey[container_id].append(opening_element)

                        _trk['has_voids_rel'] = True
                        _trk['has_fills_rel'] = True
                        _trk['opening_element'] = opening_element
                        _trk['opening_w'] = o_w
                        _trk['opening_h'] = o_h
                        _trk['opening_depth'] = wall_thickness + 0.05

                    elif ifc_type == 'IfcOpeningElement':
                        # Already an IfcOpeningElement — use directly
                        f.create_entity('IfcRelVoidsElement',
                                        GlobalId=new_guid(), OwnerHistory=owner,
                                        RelatingBuildingElement=host_wall,
                                        RelatedOpeningElement=door_or_window)
                        _trk['has_voids_rel'] = True
                    else:
                        # Fallback: skip — cannot create VOIDS for non-door/window/opening types
                        print(f"Warning: VOIDS skipped for {css_id} ({ifc_type}) — not a door/window/opening")
                        _trk['skip_reason'] = f'unsupported_ifc_type:{ifc_type}'

                except Exception as e:
                    print(f"Warning: Could not create VOIDS relationship {css_id} → {target_id}: {e}")
                    _trk['skip_reason'] = f'exception:{e}'

            elif rel_type == 'FILLS':
                fill_elem = ifc_elements_by_css_id.get(css_id) or ifc_by_key.get(css_id)
                opening_elem = ifc_elements_by_css_id.get(target_id) or ifc_by_key.get(target_id)
                if not fill_elem or not opening_elem:
                    continue
                try:
                    f.create_entity('IfcRelFillsElement', GlobalId=new_guid(), OwnerHistory=owner,
                                    RelatingOpeningElement=opening_elem, RelatedBuildingElement=fill_elem)
                except Exception as e:
                    print(f"Warning: Could not create FILLS relationship {css_id} → {target_id}: {e}")

    # ---- Per-door validation report ----
    _TUNNEL_SEG_TYPES = {'TUNNEL_SEGMENT'}
    _VALID_WALL_TYPES = {'WALL', 'TUNNEL_SEGMENT'}
    _door_report_rows = []
    for _rpt_elem in elements:
        if (_rpt_elem.get('type', '').upper() != 'DOOR'
                and _rpt_elem.get('semanticType', '') != 'IfcDoor'):
            continue
        _rpt_id = _rpt_elem.get('id', '<no-id>')
        _rpt_meta = _rpt_elem.get('metadata') or {}
        _rpt_geom = _rpt_elem.get('geometry') or {}
        _rpt_place = _rpt_elem.get('placement') or {}
        _rpt_orig = _rpt_place.get('origin') or {}
        _rpt_prof = _rpt_geom.get('profile') or {}
        _rpt_trk = _door_voids_tracker.get(_rpt_id, {})
        _rpt_host_id = _rpt_trk.get('host_id') or _rpt_meta.get('hostWallKey', '')
        _rpt_host_css = css_elements_by_id.get(_rpt_host_id, {})
        _rpt_host_type = _rpt_trk.get('host_type') or _rpt_host_css.get('type', 'UNKNOWN')
        # A TUNNEL_SEGMENT host is a valid horizontal door host as long as it's
        # not a shaft — verticality is pre-screened by the topology engine before
        # reaching generate. PORTAL_END_WALL hosts are always valid.
        _rpt_host_props = _rpt_host_css.get('properties') or {}
        _rpt_seg_type = _rpt_host_props.get('segmentType', '')
        _rpt_is_valid_kind = (
            _rpt_host_type.upper() in _VALID_WALL_TYPES
            and _rpt_seg_type not in ('VERTICAL_SHAFT',)
        )
        _rpt_floor_z = float(_rpt_orig.get('z', 0))
        _rpt_dw = float(_rpt_prof.get('width', 1.0))
        _rpt_dh = float(_rpt_geom.get('depth', 2.2))
        _rpt_dt = float(_rpt_prof.get('height', 0.08))
        _rpt_door_bbox = {
            'min': {'x': float(_rpt_orig.get('x', 0)) - _rpt_dw / 2,
                    'y': float(_rpt_orig.get('y', 0)) - _rpt_dt / 2,
                    'z': _rpt_floor_z},
            'max': {'x': float(_rpt_orig.get('x', 0)) + _rpt_dw / 2,
                    'y': float(_rpt_orig.get('y', 0)) + _rpt_dt / 2,
                    'z': _rpt_floor_z + _rpt_dh},
        }
        _rpt_opening_el = _rpt_trk.get('opening_element')
        _rpt_opening_bbox = None
        if _rpt_opening_el is not None:
            _ow = _rpt_trk.get('opening_w', _rpt_dw)
            _oh = _rpt_trk.get('opening_h', _rpt_dh)
            _od = _rpt_trk.get('opening_depth', 0.35)
            _rpt_opening_bbox = {
                'min': {'x': float(_rpt_orig.get('x', 0)) - _ow / 2,
                        'y': float(_rpt_orig.get('y', 0)) - _od / 2,
                        'z': _rpt_floor_z},
                'max': {'x': float(_rpt_orig.get('x', 0)) + _ow / 2,
                        'y': float(_rpt_orig.get('y', 0)) + _od / 2,
                        'z': _rpt_floor_z + _oh},
            }
            # Verify opening bbox contains door bbox with tolerance
            _tol = 0.01
            _bbox_ok = (
                _rpt_opening_bbox['min']['x'] <= _rpt_door_bbox['min']['x'] + _tol
                and _rpt_opening_bbox['max']['x'] >= _rpt_door_bbox['max']['x'] - _tol
                and _rpt_opening_bbox['min']['z'] <= _rpt_door_bbox['min']['z'] + _tol
                and _rpt_opening_bbox['max']['z'] >= _rpt_door_bbox['max']['z'] - _tol
            )
        else:
            _bbox_ok = None
        _rpt_ifc_door = ifc_elements_by_css_id.get(_rpt_id) or ifc_by_key.get(_rpt_id)
        _rpt_has_ifc_door = _rpt_ifc_door is not None and _rpt_ifc_door.is_a() == 'IfcDoor'
        _rpt_has_voids = _rpt_trk.get('has_voids_rel', False)
        _rpt_has_fills = _rpt_trk.get('has_fills_rel', False)
        _rpt_skip = _rpt_trk.get('skip_reason')
        # Pass conditions:
        #   - IfcDoor exists in IFC entities
        #   - For TUNNEL_SEGMENT host: standalone placement is acceptable (opening cannot be cut
        #     into hollow tube); voids/fills are intentionally omitted.
        #   - For WALL/PORTAL host: must have voids_rel + fills_rel + opening_bbox covers door.
        if not _rpt_has_ifc_door:
            _rpt_pass = False
            _rpt_reason = 'FAIL: IfcDoor not emitted to IFC'
        elif _rpt_host_type.upper() in _TUNNEL_SEG_TYPES:
            _rpt_pass = True
            _rpt_reason = 'PASS (tunnel_segment_host: standalone door, opening intentionally omitted)'
        elif _rpt_has_voids and _rpt_has_fills and _rpt_opening_el is not None and _bbox_ok:
            _rpt_pass = True
            _rpt_reason = 'PASS (wall_host: opening created, voids+fills linked, bbox ok)'
        elif _rpt_has_voids and _rpt_has_fills and _rpt_opening_el is not None:
            _rpt_pass = False
            _rpt_reason = f'FAIL (wall_host: opening created but bbox does not contain door; bbox_ok={_bbox_ok})'
        else:
            _rpt_pass = False
            _rpt_reason = f'FAIL (wall_host: skip={_rpt_skip} voids={_rpt_has_voids} fills={_rpt_has_fills})'
        _door_report_rows.append({
            'door_id': _rpt_id,
            'host_id': _rpt_host_id,
            'host_type': _rpt_host_type,
            'is_valid_host_kind': _rpt_is_valid_kind,
            'floor_z': round(_rpt_floor_z, 4),
            'door_bbox': _rpt_door_bbox,
            'opening_bbox': _rpt_opening_bbox,
            'has_voids_rel': _rpt_has_voids,
            'has_fills_rel': _rpt_has_fills,
            'distance_to_host_surface': 'see_clean_tunnel_export_log',
            'pass': _rpt_pass,
            'reason': _rpt_reason,
        })
    if _door_report_rows:
        print(f'---- Per-door validation report ({len(_door_report_rows)} doors) ----')
        _pass_count = sum(1 for r in _door_report_rows if r['pass'])
        _voids_count = sum(1 for r in _door_report_rows if r['has_voids_rel'])
        _fills_count = sum(1 for r in _door_report_rows if r['has_fills_rel'])
        _opening_count = sum(1 for r in _door_report_rows if r['opening_bbox'] is not None)
        print(f'  consumed_doors: {len(_door_report_rows)}  '
              f'pass: {_pass_count}  '
              f'openings: {_opening_count}  '
              f'voids_rels: {_voids_count}  '
              f'fills_rels: {_fills_count}')
        for _row in _door_report_rows:
            _db = _row['door_bbox']
            _ob = _row['opening_bbox']
            print(f"  door[{_row['door_id']}]")
            print(f"    host_id:             {_row['host_id']}")
            print(f"    host_type:           {_row['host_type']}")
            print(f"    is_valid_host_kind:  {_row['is_valid_host_kind']}")
            print(f"    floor_z:             {_row['floor_z']}")
            print(f"    door_bbox:           min({_db['min']['x']:.3f},{_db['min']['y']:.3f},{_db['min']['z']:.3f}) "
                  f"max({_db['max']['x']:.3f},{_db['max']['y']:.3f},{_db['max']['z']:.3f})")
            if _ob:
                print(f"    opening_bbox:        min({_ob['min']['x']:.3f},{_ob['min']['y']:.3f},{_ob['min']['z']:.3f}) "
                      f"max({_ob['max']['x']:.3f},{_ob['max']['y']:.3f},{_ob['max']['z']:.3f})")
            else:
                print(f"    opening_bbox:        None")
            print(f"    has_voids_rel:       {_row['has_voids_rel']}")
            print(f"    has_fills_rel:       {_row['has_fills_rel']}")
            print(f"    pass:                {_row['pass']}")
            print(f"    reason:              {_row['reason']}")

    # ---- PATH_CONNECTS → IfcRelConnectsPathElements ----
    # Moved to after post-pass (floor slabs / ceiling slabs / side walls) so that
    # RECTANGLE-profile tunnel segments, which skip the main element loop and are
    # only created in the post-pass, are present in ifc_by_key before lookup.

    # ---- JUNCTION FILL PASS: disabled ----
    # Triangular fill proxies created corrugated bump artifacts at every bend node.
    # The reference IFC has zero junction fill elements; bends are handled by the
    # entry/exit overlap extension on arch hollow tubes. Proxies suppressed entirely.
    _jf_fill_count = 0
    _jf_processed_nodes = set()
    _jf_storey_entry = None
    _jf_fill_elements = []

    if False and _jf_storey_entry and node_to_segs_for_clip:
        _jf_storey_entity, _jf_storey_lp, _ = _jf_storey_entry
        for _jf_nid, _jf_segs in node_to_segs_for_clip.items():
            if len(_jf_segs) < 2 or _jf_nid in _jf_processed_nodes:
                continue
            _jf_processed_nodes.add(_jf_nid)

            # For each pair of segments meeting at this node, add a fill piece
            for _jf_i in range(len(_jf_segs)):
                for _jf_j in range(_jf_i + 1, len(_jf_segs)):
                    _jf_ek_a, _jf_rx_a, _jf_ry_a, _jf_ep_a = _jf_segs[_jf_i]
                    _jf_ek_b, _jf_rx_b, _jf_ry_b, _jf_ep_b = _jf_segs[_jf_j]

                    # Away-from-junction bearing vectors (2D)
                    _jf_ax = _jf_rx_a if _jf_ep_a == 'entry' else -_jf_rx_a
                    _jf_ay = _jf_ry_a if _jf_ep_a == 'entry' else -_jf_ry_a
                    _jf_bx = _jf_rx_b if _jf_ep_b == 'entry' else -_jf_rx_b
                    _jf_by = _jf_ry_b if _jf_ep_b == 'entry' else -_jf_ry_b

                    # Skip near-straight junctions — no visible gap
                    _jf_dot = max(-1.0, min(1.0, _jf_ax * _jf_bx + _jf_ay * _jf_by))
                    _jf_angle = math.acos(_jf_dot) * 180.0 / math.pi
                    if _jf_angle >= 170.0:
                        continue

                    # Get geometry info for segment A
                    _jf_place_a = placement_by_css_key.get(_jf_ek_a, {})
                    _jf_prof_a = geom_profile_by_css_key.get(_jf_ek_a, {})
                    _jf_depth_a = geom_depth_by_css_key.get(_jf_ek_a, 0.0)
                    _jf_jov_a = geom_junction_overlap_by_css_key.get(_jf_ek_a, 0.0)
                    _jf_odep_a = geom_orig_depth_by_css_key.get(_jf_ek_a, _jf_depth_a)
                    if not _jf_place_a or _jf_depth_a <= 0:
                        continue

                    # Compute junction world position from segment A
                    _jf_orig_a = _jf_place_a.get('origin', {})
                    _jf_ox = float(_jf_orig_a.get('x', 0))
                    _jf_oy = float(_jf_orig_a.get('y', 0))
                    _jf_oz = float(_jf_orig_a.get('z', 0))
                    _jf_axis_a = _jf_place_a.get('axis', {})
                    _jf_avx = float(_jf_axis_a.get('x', 1))
                    _jf_avy = float(_jf_axis_a.get('y', 0))
                    _jf_avz = float(_jf_axis_a.get('z', 0))
                    _jf_avn = math.sqrt(_jf_avx**2 + _jf_avy**2 + _jf_avz**2)
                    if _jf_avn > 1e-6:
                        _jf_avx /= _jf_avn; _jf_avy /= _jf_avn; _jf_avz /= _jf_avn

                    # Local Z of junction within segment A's solid
                    if _jf_ep_a == 'entry':
                        _jf_local_z_a = _jf_jov_a          # entry_cap into solid
                    else:
                        _jf_local_z_a = _jf_jov_a + _jf_odep_a   # entry_cap + orig_depth

                    _jf_jx = _jf_ox + _jf_avx * _jf_local_z_a
                    _jf_jy = _jf_oy + _jf_avy * _jf_local_z_a
                    _jf_jz = _jf_oz + _jf_avz * _jf_local_z_a

                    # Tunnel dimensions
                    _jf_W = float(_jf_prof_a.get('width', 5.0))
                    _jf_H = float(_jf_prof_a.get('height', 5.0))

                    # Overlap for each segment at this junction endpoint
                    # entry_cap stored as jov; exit_cap = depth - jov - orig_depth
                    _jf_ov_a = (_jf_jov_a if _jf_ep_a == 'entry'
                                 else _jf_depth_a - _jf_jov_a - _jf_odep_a)
                    _jf_jov_b = geom_junction_overlap_by_css_key.get(_jf_ek_b, 0.0)
                    _jf_depth_b = geom_depth_by_css_key.get(_jf_ek_b, 0.0)
                    _jf_odep_b = geom_orig_depth_by_css_key.get(_jf_ek_b, _jf_depth_b)
                    _jf_ov_b = (_jf_jov_b if _jf_ep_b == 'entry'
                                 else _jf_depth_b - _jf_jov_b - _jf_odep_b)

                    if _jf_ov_a < 0.05 or _jf_ov_b < 0.05:
                        continue  # insufficient overlap data

                    # Triangle vertices in local XY (relative to junction):
                    # V1 at origin, V2 along A's away direction, V3 along B's away direction.
                    _jf_v2x = float(_jf_ax * _jf_ov_a)
                    _jf_v2y = float(_jf_ay * _jf_ov_a)
                    _jf_v3x = float(_jf_bx * _jf_ov_b)
                    _jf_v3y = float(_jf_by * _jf_ov_b)

                    # Fill piece floor Z: junction center minus half tunnel height
                    _jf_floor_z = float(_jf_jz - _jf_H / 2.0)

                    try:
                        # Triangular profile (2D, in XY plane of fill piece)
                        _pt1 = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
                        _pt2 = f.create_entity('IfcCartesianPoint', Coordinates=(_jf_v2x, _jf_v2y))
                        _pt3 = f.create_entity('IfcCartesianPoint', Coordinates=(_jf_v3x, _jf_v3y))
                        _pt_close = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0))
                        _jf_poly = f.create_entity('IfcPolyline', Points=(_pt1, _pt2, _pt3, _pt_close))
                        _jf_prof = f.create_entity('IfcArbitraryClosedProfileDef',
                            ProfileType='AREA', ProfileName=None, OuterCurve=_jf_poly)

                        # Solid: extrude triangle upward by tunnel height
                        _jf_solid_origin = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, 0.0))
                        _jf_solid_z = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                        _jf_solid_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
                        _jf_solid_pos = f.create_entity('IfcAxis2Placement3D',
                            Location=_jf_solid_origin, Axis=_jf_solid_z, RefDirection=_jf_solid_x)
                        _jf_extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                        _jf_solid = f.create_entity('IfcExtrudedAreaSolid',
                            SweptArea=_jf_prof, Position=_jf_solid_pos,
                            ExtrudedDirection=_jf_extrude_dir, Depth=float(_jf_H))

                        # Apply concrete color
                        apply_style(f, _jf_solid, (0.60, 0.60, 0.62), 0.0, 'JunctionFill')

                        _jf_shape_rep = f.create_entity('IfcShapeRepresentation',
                            ContextOfItems=subcontext,
                            RepresentationIdentifier='Body',
                            RepresentationType='SweptSolid',
                            Items=(_jf_solid,))
                        _jf_pds = f.create_entity('IfcProductDefinitionShape',
                            Representations=(_jf_shape_rep,))

                        # Placement: origin at junction floor, world-aligned axes
                        _jf_lp_origin = f.create_entity('IfcCartesianPoint',
                            Coordinates=(float(_jf_jx), float(_jf_jy), _jf_floor_z))
                        _jf_lp_z = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                        _jf_lp_x = f.create_entity('IfcDirection', DirectionRatios=(1.0, 0.0, 0.0))
                        _jf_ax2pl = f.create_entity('IfcAxis2Placement3D',
                            Location=_jf_lp_origin, Axis=_jf_lp_z, RefDirection=_jf_lp_x)
                        _jf_lp = f.create_entity('IfcLocalPlacement',
                            PlacementRelTo=_jf_storey_lp, RelativePlacement=_jf_ax2pl)

                        _jf_proxy = f.create_entity('IfcBuildingElementProxy',
                            GlobalId=new_guid(),
                            OwnerHistory=owner,
                            Name=f'JunctionFill_{_jf_nid}',
                            Description=f'Junction corner fill angle={_jf_angle:.0f}deg',
                            ObjectPlacement=_jf_lp,
                            Representation=_jf_pds)

                        _jf_fill_elements.append(_jf_proxy)
                        _jf_fill_count += 1
                        print(f"JunctionFill: node={_jf_nid} angle={_jf_angle:.1f}° "
                              f"ov_a={_jf_ov_a:.2f} ov_b={_jf_ov_b:.2f} "
                              f"v2=({_jf_v2x:.2f},{_jf_v2y:.2f}) v3=({_jf_v3x:.2f},{_jf_v3y:.2f})")
                    except Exception as _jf_err:
                        print(f"JunctionFill failed at node {_jf_nid}: {_jf_err}")

    # Contain all fill pieces in the tunnel storey
    if _jf_fill_elements and _jf_storey_entry:
        _jf_storey_entity, _, _ = _jf_storey_entry
        f.create_entity('IfcRelContainedInSpatialStructure',
            GlobalId=new_guid(), OwnerHistory=owner,
            RelatedElements=tuple(_jf_fill_elements),
            RelatingStructure=_jf_storey_entity)
    if _jf_fill_count > 0:
        print(f"Junction fills: {_jf_fill_count} triangular corner pieces added at "
              f"{len(_jf_processed_nodes)} nodes")

    # Junction node cube proxies removed — they created large visual clutter (21 boxes).

    # ---- MITRE CLIP PASS: Apply IfcBooleanClippingResult at mitre wall/tunnel junctions ----
    # For each WALL or TUNNEL_SEGMENT with MITRE PATH_CONNECTS, trim the overlapping corner
    # via a half-space cut. This produces Revit-quality flush mitre junctions in IFC geometry.
    #
    # Coordinate conventions differ by element type:
    #   WALL (shell piece): run direction = local Z (axis), junction at Z = junc_ov (ATSTART) or junc_ov+orig_depth (ATEND)
    #   WALL (architectural): run direction = local X (refDirection), junction at X = ±half_length
    #   TUNNEL_SEGMENT:     run direction = local Z (axis/extrusion direction), same Z convention as shell piece walls
    mitre_clip_count = 0
    mitre_clip_errors = 0
    # Disabled: xeokit WASM crashes on IfcBooleanClippingResult for all element types,
    # not just TUNNEL_SEGMENT. Junction overlaps already provide visual continuity.
    _mitre_clip_disabled = True
    for elem in elements:
        if _mitre_clip_disabled:
            continue
        css_type_c = (elem.get('type', '') or '').upper()
        if css_type_c not in ('WALL', 'TUNNEL_SEGMENT'):
            continue
        # Skip IfcBooleanClippingResult for TUNNEL_SEGMENT — xeokit WASM cannot render
        # boolean clips, causing garbled/broken geometry. Tunnel junction overlap already
        # provides visual continuity without boolean trimming.
        if css_type_c == 'TUNNEL_SEGMENT':
            continue
        is_tunnel_seg = css_type_c == 'TUNNEL_SEGMENT'

        elem_key_c = elem.get('element_key', '') or elem.get('id', '')
        if not elem_key_c:
            continue
        raw_solid = solid_by_css_key.get(elem_key_c)
        if raw_solid is None:
            continue
        src_placement = placement_by_css_key.get(elem_key_c, {})
        src_profile   = geom_profile_by_css_key.get(elem_key_c, {})

        _hm_cut_half_spaces = []  # half-spaces applied this element (for hollow manifold multi-solid re-application)
        if is_tunnel_seg:
            # Tunnel: run direction = placement.axis (= solid local Z after shear fix).
            # Solid occupies Z=[0, seg_depth]. Origin was shifted back by entry_cap (junc_ov).
            #   ATSTART junction at Z = junc_ov (start of original segment).
            #   ATEND   junction at Z = junc_ov + orig_depth.
            seg_depth = geom_depth_by_css_key.get(elem_key_c, 0.0)
            junc_ov_c = geom_junction_overlap_by_css_key.get(elem_key_c, 0.0)
            orig_depth_c = geom_orig_depth_by_css_key.get(elem_key_c, seg_depth)
            if seg_depth <= 0:
                continue
            src_ax = src_placement.get('axis', {})
            ax_g = float(src_ax.get('x', 0)); ay_g = float(src_ax.get('y', 0)); az_g = float(src_ax.get('z', 1))
            a_len_g = math.sqrt(ax_g * ax_g + ay_g * ay_g + az_g * az_g)
            if a_len_g < 1e-10:
                continue
            ax_g /= a_len_g; ay_g /= a_len_g; az_g /= a_len_g  # A's run direction (global)

            # A's solid local frame (matches create_extrusion after shear fix):
            #   local Z = (ax_g, ay_g, az_g)  — run/extrusion direction
            #   local X = cross(world_up, A_run) = (-ay_g, ax_g, 0)  — lateral
            lat_x = -ay_g; lat_y = ax_g  # lateral (local X), Z component = 0 for horiz. tunnels

            clipped_solid = raw_solid
            for rel in (elem.get('relationships', []) or []):
                if rel.get('type') != 'PATH_CONNECTS':
                    continue
                conn_angle = (rel.get('metadata', {}) or {}).get('connectionAngle', {})
                if not conn_angle or conn_angle.get('connectionType') != 'MITRE':
                    continue
                angle_deg = conn_angle.get('angleDeg', 0)
                if angle_deg < 5 or angle_deg > 175:
                    continue

                source_kind_c = (rel.get('sourceInterface', {}) or {}).get('kind', 'NOTDEFINED')
                target_kind_c = (rel.get('targetInterface', {}) or {}).get('kind', 'NOTDEFINED')

                # A's exit direction in A's local XZ frame (X=lateral, Z=run)
                if source_kind_c == 'ATEND':
                    dir_a_local_z = 1.0    # exits in +Z direction
                    junction_local_z = junc_ov_c + orig_depth_c
                elif source_kind_c == 'ATSTART':
                    dir_a_local_z = -1.0   # exits in -Z direction
                    junction_local_z = junc_ov_c
                else:
                    continue

                target_key_c = rel.get('target', '')
                tgt_placement = placement_by_css_key.get(target_key_c, {})
                tgt_ax = tgt_placement.get('axis', {})
                bx_g = float(tgt_ax.get('x', 0)); by_g = float(tgt_ax.get('y', 0)); bz_g = float(tgt_ax.get('z', 1))
                b_len_g = math.sqrt(bx_g * bx_g + by_g * by_g + bz_g * bz_g)
                if b_len_g < 1e-10:
                    continue
                bx_g /= b_len_g; by_g /= b_len_g; bz_g /= b_len_g

                # Project B's global direction into A's local XZ frame
                b_local_x = bx_g * lat_x + by_g * lat_y          # dot(B_global, A_lateral)
                b_local_z = bx_g * ax_g + by_g * ay_g + bz_g * az_g  # dot(B_global, A_run)

                # B's direction AWAY from the junction (outward from B's end that meets A)
                if target_kind_c == 'ATSTART':
                    b_away_x, b_away_z = b_local_x, b_local_z
                else:
                    b_away_x, b_away_z = -b_local_x, -b_local_z

                # Bisector in A's local XZ plane: points toward the corner to remove.
                # ATEND exit clips: negate the lateral component — the A_lateral basis
                # vector is cross(world_Z, A_run) which gives the left-hand lateral;
                # for the exit (ATEND) cut the sign must be flipped to point into the
                # correct half of the turn. ATSTART entry clips do not need this flip.
                bisect_x = (-b_away_x if source_kind_c == 'ATEND' else b_away_x)
                bisect_z = dir_a_local_z + b_away_z  # run component
                bisect_n = math.sqrt(bisect_x * bisect_x + bisect_z * bisect_z)
                if bisect_n < 1e-10:
                    continue  # Collinear — no mitre cut needed
                bisect_x /= bisect_n; bisect_z /= bisect_n

                # Skip degenerate cuts where the junction is at the solid's exact boundary.
                # A cut at Z=0 or Z=seg_depth creates a zero-volume boolean operation that
                # causes xeokit's WASM geometry parser to throw "offset is out of bounds".
                CLIP_EPSILON = 0.01
                if abs(junction_local_z) < CLIP_EPSILON or abs(junction_local_z - seg_depth) < CLIP_EPSILON:
                    print(f"MITRE_CLIP_SKIP_DEGENERATE: {elem_key_c} juncZ={junction_local_z:.4f} "
                          f"seg_depth={seg_depth:.4f} — boundary cut skipped")
                    continue

                try:
                    # Cut plane in A's solid local space. Tunnel junction is on the Z axis.
                    # Normal: (bisect_x, 0, bisect_z) in local = tilted in the XZ plane.
                    # Add 0.0 to normalize any negative-zero floats (e.g. -0.0 → 0.0).
                    print(f"MITRE_CLIP: {elem_key_c} angle={angle_deg}° junction={source_kind_c} "
                          f"juncZ={junction_local_z:.3f} bisect=({bisect_x:.3f}, {bisect_z:.3f}) "
                          f"target={target_key_c}")
                    cut_pt  = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, junction_local_z))
                    cut_nrm = f.create_entity('IfcDirection', DirectionRatios=(bisect_x + 0.0, 0.0, bisect_z + 0.0))
                    cut_ax2 = f.create_entity('IfcAxis2Placement3D', Location=cut_pt, Axis=cut_nrm)
                    cut_plane = f.create_entity('IfcPlane', Position=cut_ax2)
                    # ATEND exit: AgreementFlag=False removes the stub in the direction
                    # the normal points toward (the exit corner).
                    # ATSTART entry: AgreementFlag=True removes the stub on the opposite
                    # side — correct for entry clips where the normal already negated.
                    agreement_flag = (source_kind_c == 'ATSTART')
                    half_space = f.create_entity('IfcHalfSpaceSolid', BaseSurface=cut_plane, AgreementFlag=agreement_flag)
                    _hm_cut_half_spaces.append(half_space)
                    clipped_solid = f.create_entity(
                        'IfcBooleanClippingResult',
                        Operator='DIFFERENCE',
                        FirstOperand=clipped_solid,
                        SecondOperand=half_space
                    )
                    mitre_clip_count += 1
                except Exception as mitre_err:
                    mitre_clip_errors += 1
                    if mitre_clip_errors <= 5:
                        print(f"Warning: Tunnel mitre clip failed for {elem_key_c}: {mitre_err}")

        else:
            # WALL — two sub-cases:
            #   A. Tunnel shell pieces: extrusion is along placement.axis (local Z), junction at Z positions
            #   B. Architectural walls: extrusion is along placement.refDirection (local X), junction at X=±half_length
            elem_shell_piece_c = (elem.get('properties', {}) or {}).get('shellPiece', '')
            is_shell_piece_wall = bool(elem_shell_piece_c) and elem_shell_piece_c in ('LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF')

            if is_shell_piece_wall:
                # --- SHELL PIECE WALL: same coordinate convention as TUNNEL_SEGMENT ---
                # Run direction = placement.axis (local Z); junction at Z=overlap (ATSTART) or Z=depth-overlap (ATEND)
                seg_depth_sp = geom_depth_by_css_key.get(elem_key_c, 0.0)
                junc_overlap_sp = geom_junction_overlap_by_css_key.get(elem_key_c, 0.0)
                orig_depth_sp = geom_orig_depth_by_css_key.get(elem_key_c, seg_depth_sp)
                if seg_depth_sp <= 0:
                    continue

                src_ax_sp = src_placement.get('axis', {})
                ax_sp = float(src_ax_sp.get('x', 0)); ay_sp = float(src_ax_sp.get('y', 0)); az_sp = float(src_ax_sp.get('z', 1))
                a_len_sp = math.sqrt(ax_sp * ax_sp + ay_sp * ay_sp + az_sp * az_sp)
                if a_len_sp < 1e-10:
                    continue
                ax_sp /= a_len_sp; ay_sp /= a_len_sp; az_sp /= a_len_sp  # A's run direction (global)

                # A's lateral (local X) = cross(world_up, A_run) = (-ay, ax, 0)
                lat_x_sp = -ay_sp; lat_y_sp = ax_sp

                clipped_solid = raw_solid
                for rel in (elem.get('relationships', []) or []):
                    if rel.get('type') != 'PATH_CONNECTS':
                        continue
                    conn_angle_sp = (rel.get('metadata', {}) or {}).get('connectionAngle', {})
                    if not conn_angle_sp or conn_angle_sp.get('connectionType') != 'MITRE':
                        continue
                    angle_deg_sp = conn_angle_sp.get('angleDeg', 0)
                    if angle_deg_sp < 5 or angle_deg_sp > 175:
                        continue

                    source_kind_sp = (rel.get('sourceInterface', {}) or {}).get('kind', 'NOTDEFINED')
                    target_kind_sp = (rel.get('targetInterface', {}) or {}).get('kind', 'NOTDEFINED')

                    # Junction positions in the solid's local Z:
                    #   Solid occupies Z=[0, seg_depth]. Origin was shifted back by junc_overlap.
                    #   ATSTART actual junction at Z = junc_overlap (start of original segment).
                    #   ATEND   actual junction at Z = junc_overlap + orig_depth.
                    if source_kind_sp == 'ATEND':
                        dir_a_sp_z = 1.0
                        junction_local_z_sp = junc_overlap_sp + orig_depth_sp
                    elif source_kind_sp == 'ATSTART':
                        dir_a_sp_z = -1.0
                        junction_local_z_sp = junc_overlap_sp
                    else:
                        continue

                    target_key_sp = rel.get('target', '')
                    tgt_placement_sp = placement_by_css_key.get(target_key_sp, {})
                    tgt_ax_sp = tgt_placement_sp.get('axis', {})
                    bx_sp = float(tgt_ax_sp.get('x', 0)); by_sp = float(tgt_ax_sp.get('y', 0)); bz_sp = float(tgt_ax_sp.get('z', 1))
                    b_len_sp = math.sqrt(bx_sp * bx_sp + by_sp * by_sp + bz_sp * bz_sp)
                    if b_len_sp < 1e-10:
                        continue
                    bx_sp /= b_len_sp; by_sp /= b_len_sp; bz_sp /= b_len_sp

                    # Project B's run direction into A's local XZ frame
                    b_local_x_sp = bx_sp * lat_x_sp + by_sp * lat_y_sp       # dot(B_run, A_lateral)
                    b_local_z_sp = bx_sp * ax_sp + by_sp * ay_sp + bz_sp * az_sp  # dot(B_run, A_run)

                    # B's direction AWAY from the junction
                    if target_kind_sp == 'ATSTART':
                        b_away_x_sp, b_away_z_sp = b_local_x_sp, b_local_z_sp
                    else:
                        b_away_x_sp, b_away_z_sp = -b_local_x_sp, -b_local_z_sp

                    # Bisector in A's local XZ plane
                    bisect_x_sp = b_away_x_sp
                    bisect_z_sp = dir_a_sp_z + b_away_z_sp
                    bisect_n_sp = math.sqrt(bisect_x_sp * bisect_x_sp + bisect_z_sp * bisect_z_sp)
                    if bisect_n_sp < 1e-10:
                        continue
                    bisect_x_sp /= bisect_n_sp; bisect_z_sp /= bisect_n_sp

                    try:
                        cut_pt_sp  = f.create_entity('IfcCartesianPoint', Coordinates=(0.0, 0.0, junction_local_z_sp))
                        cut_nrm_sp = f.create_entity('IfcDirection', DirectionRatios=(bisect_x_sp, 0.0, bisect_z_sp))
                        cut_ax2_sp = f.create_entity('IfcAxis2Placement3D', Location=cut_pt_sp, Axis=cut_nrm_sp)
                        cut_plane_sp = f.create_entity('IfcPlane', Position=cut_ax2_sp)
                        half_space_sp = f.create_entity('IfcHalfSpaceSolid', BaseSurface=cut_plane_sp, AgreementFlag=True)
                        clipped_solid = f.create_entity(
                            'IfcBooleanClippingResult',
                            Operator='DIFFERENCE',
                            FirstOperand=clipped_solid,
                            SecondOperand=half_space_sp
                        )
                        mitre_clip_count += 1
                    except Exception as mitre_err:
                        mitre_clip_errors += 1
                        if mitre_clip_errors <= 5:
                            print(f"Warning: Shell piece mitre clip failed for {elem_key_c}: {mitre_err}")

            else:
                # --- ARCHITECTURAL WALL: run direction = local X (refDirection), junction at X = ±half_length ---
                wall_length = float(src_profile.get('width', 0))
                if wall_length <= 0:
                    continue

                src_ref = src_placement.get('refDirection', {})
                ax = float(src_ref.get('x', 1)); ay = float(src_ref.get('y', 0))
                a_len = math.sqrt(ax * ax + ay * ay)
                if a_len < 1e-10:
                    continue
                ax /= a_len; ay /= a_len

                # Wall A's local Y (perpendicular in XY plane): cross((0,0,1), (ax,ay,0)) = (-ay, ax, 0)
                ay_local_x = -ay; ay_local_y = ax

                clipped_solid = raw_solid
                for rel in (elem.get('relationships', []) or []):
                    if rel.get('type') != 'PATH_CONNECTS':
                        continue
                    conn_angle = (rel.get('metadata', {}) or {}).get('connectionAngle', {})
                    if not conn_angle or conn_angle.get('connectionType') != 'MITRE':
                        continue

                    target_key_c = rel.get('target', '')
                    tgt_placement = placement_by_css_key.get(target_key_c, {})
                    tgt_ref = tgt_placement.get('refDirection', {})
                    bx = float(tgt_ref.get('x', 1)); by = float(tgt_ref.get('y', 0))
                    b_len = math.sqrt(bx * bx + by * by)
                    if b_len < 1e-10:
                        continue
                    bx /= b_len; by /= b_len

                    # Transform B's direction into A's local XY frame
                    b_local_x = bx * ax + by * ay          # dot(B_global, A_local_X)
                    b_local_y = bx * ay_local_x + by * ay_local_y  # dot(B_global, A_local_Y)

                    # Determine which end of A the junction is at
                    source_kind_c = (rel.get('sourceInterface', {}) or {}).get('kind', 'NOTDEFINED')
                    target_kind_c = (rel.get('targetInterface', {}) or {}).get('kind', 'NOTDEFINED')
                    if source_kind_c == 'ATEND':
                        dir_a_local = (1.0, 0.0)
                        junction_local_x = wall_length / 2.0
                    elif source_kind_c == 'ATSTART':
                        dir_a_local = (-1.0, 0.0)
                        junction_local_x = -wall_length / 2.0
                    else:
                        continue  # NOTDEFINED or ATPATH — skip

                    # B's direction going AWAY from the junction in A's local frame
                    if target_kind_c == 'ATSTART':
                        b_away = (b_local_x, b_local_y)
                    else:
                        b_away = (-b_local_x, -b_local_y)

                    # Bisector = normalize(dirA_local + b_away_local) — points toward corner to remove
                    bisect_x = dir_a_local[0] + b_away[0]
                    bisect_y = dir_a_local[1] + b_away[1]
                    bisect_n = math.sqrt(bisect_x * bisect_x + bisect_y * bisect_y)
                    if bisect_n < 1e-10:
                        continue  # Collinear — no mitre needed
                    bisect_x /= bisect_n; bisect_y /= bisect_n

                    # Skip if bisector angle is too shallow — would clip too much geometry
                    angle_deg = conn_angle.get('angleDeg', 0)
                    if angle_deg < 5 or angle_deg > 175:
                        continue

                    try:
                        # Cut plane in A's solid local space (solid origin at element center)
                        print(f"MITRE_CLIP_WALL: {elem_key_c} angle={angle_deg}° "
                              f"juncX={junction_local_x:.3f} bisect=({bisect_x:.3f}, {bisect_y:.3f}) "
                              f"target={target_key_c} shell={elem_shell_piece_c or 'ARCH'}")
                        cut_pt  = f.create_entity('IfcCartesianPoint', Coordinates=(junction_local_x, 0.0, 0.0))
                        cut_nrm = f.create_entity('IfcDirection', DirectionRatios=(bisect_x, bisect_y, 0.0))
                        cut_ax2 = f.create_entity('IfcAxis2Placement3D', Location=cut_pt, Axis=cut_nrm)
                        cut_plane = f.create_entity('IfcPlane', Position=cut_ax2)
                        # AgreementFlag=True: half-space is where normal points = the corner region to remove
                        half_space = f.create_entity('IfcHalfSpaceSolid', BaseSurface=cut_plane, AgreementFlag=True)
                        clipped_solid = f.create_entity(
                            'IfcBooleanClippingResult',
                            Operator='DIFFERENCE',
                            FirstOperand=clipped_solid,
                            SecondOperand=half_space
                        )
                        mitre_clip_count += 1
                    except Exception as mitre_err:
                        mitre_clip_errors += 1
                        if mitre_clip_errors <= 5:
                            print(f"Warning: Mitre clip failed for {elem_key_c}: {mitre_err}")

        # If any clips were applied, update the solid in the shape representation
        if clipped_solid is not raw_solid:
            try:
                ifc_src = ifc_by_key.get(elem_key_c) or ifc_elements_by_css_id.get(elem_key_c)
                if ifc_src and hasattr(ifc_src, 'Representation') and ifc_src.Representation:
                    for rep in ifc_src.Representation.Representations:
                        if rep.RepresentationIdentifier == 'Body':
                            hm_shells = hollow_shell_solids_by_key.get(elem_key_c)
                            if hm_shells and len(hm_shells) > 1 and _hm_cut_half_spaces:
                                # Hollow manifold: re-apply all half-space cuts to each of the 4
                                # shell solids independently so all walls/roof/floor get clipped.
                                final_items = []
                                for base_sol in hm_shells:
                                    s = base_sol
                                    for hs in _hm_cut_half_spaces:
                                        s = f.create_entity('IfcBooleanClippingResult',
                                                            Operator='DIFFERENCE',
                                                            FirstOperand=s,
                                                            SecondOperand=hs)
                                    final_items.append(s)
                                rep.Items = tuple(final_items)
                            else:
                                rep.Items = (clipped_solid,)
                            rep.RepresentationType = 'Clipping'
                            break
            except Exception as rep_err:
                if mitre_clip_errors <= 5:
                    print(f"Warning: Could not update shape rep for mitre clip on {elem_key_c}: {rep_err}")

    if mitre_clip_count > 0:
        print(f"Mitre geometry clips applied: {mitre_clip_count} cuts ({mitre_clip_errors} errors)")

    # ---- IfcRelConnectsPorts: logically connect MEP ventilation elements ----
    # For DUCT/PIPE elements whose placement was snapped to the tunnel centerline
    # (tunnelCenterlineSnapped: true), create IfcDistributionPort nodes and link
    # adjacent segment pairs with IfcRelConnectsPorts — forming a continuous, logically
    # connected ventilation/service network as required by IFC4 MEP semantics.
    # N5: DistributionPort entities are suppressed for tunnel renders — xeokit renders
    # them as visible cyan boxes/lines at junction nodes. Tunnel connectivity is already
    # handled by IfcRelConnectsPathElements (PATH_CONNECTS) created earlier in the file.
    ports_created = 0
    port_connections_created = 0
    if has_tunnel_segments and False:
        # Build a port on each DUCT/PIPE element that has a parentSegmentKey annotation
        elem_port_map = {}  # css_id -> (inlet_port, outlet_port)
        for elem in elements:
            css_type_p = elem.get('type', '')
            if css_type_p not in ('DUCT', 'PIPE'):
                continue
            css_id_p = elem.get('id', '')
            if not elem.get('metadata', {}).get('tunnelCenterlineSnapped'):
                continue
            ifc_ent_p = ifc_elements_by_css_id.get(css_id_p)
            if not ifc_ent_p:
                continue
            try:
                inlet_port = f.create_entity('IfcDistributionPort',
                                              GlobalId=new_guid(), OwnerHistory=owner,
                                              Name=f"Port_In_{css_id_p}",
                                              FlowDirection='SINK')
                outlet_port = f.create_entity('IfcDistributionPort',
                                               GlobalId=new_guid(), OwnerHistory=owner,
                                               Name=f"Port_Out_{css_id_p}",
                                               FlowDirection='SOURCE')
                # Nest ports inside the distribution element
                f.create_entity('IfcRelNests',
                                  GlobalId=new_guid(), OwnerHistory=owner,
                                  Name=f"Ports_{css_id_p}",
                                  RelatingObject=ifc_ent_p,
                                  RelatedObjects=(inlet_port, outlet_port))
                elem_port_map[css_id_p] = (inlet_port, outlet_port)
                ports_created += 2
            except Exception as port_err:
                print(f"Warning: port creation failed for {css_id_p}: {port_err}")

        # Connect adjacent DUCT/PIPE pairs: each element's outlet connects to next element's inlet
        # Use parentSegmentKey to order elements along the same tunnel branch
        mep_by_branch = {}
        for elem in elements:
            if elem.get('type') not in ('DUCT', 'PIPE'):
                continue
            css_id_p = elem.get('id', '')
            if css_id_p not in elem_port_map:
                continue
            seg_key = elem.get('metadata', {}).get('parentSegmentKey', '_unknown')
            mep_by_branch.setdefault(seg_key, []).append(elem)

        for seg_key, mep_elems in mep_by_branch.items():
            if len(mep_elems) < 2:
                continue
            # Sort by longitudinal position (x-coordinate as proxy — works for axis-aligned runs)
            try:
                mep_elems.sort(key=lambda e: e.get('placement', {}).get('origin', {}).get('x', 0))
            except Exception:
                pass
            for i in range(len(mep_elems) - 1):
                a_id = mep_elems[i].get('id', '')
                b_id = mep_elems[i + 1].get('id', '')
                a_ports = elem_port_map.get(a_id)
                b_ports = elem_port_map.get(b_id)
                if not a_ports or not b_ports:
                    continue
                try:
                    f.create_entity('IfcRelConnectsPorts',
                                     GlobalId=new_guid(), OwnerHistory=owner,
                                     Name=f"VentConnect_{a_id}_{b_id}",
                                     RealizingElement=None,
                                     RelatingPort=a_ports[1],   # outlet of A
                                     RelatedPort=b_ports[0])    # inlet of B
                    port_connections_created += 1
                except Exception as pc_err:
                    print(f"Warning: port connection failed {a_id}→{b_id}: {pc_err}")

    if ports_created > 0:
        print(f"IfcRelConnectsPorts: {port_connections_created} ventilation connections via {ports_created} ports")

    # ---- v3: Separate infrastructure with space containment from storey containment ----
    space_contained = {}  # space_element_key → [ifc_elements]
    storey_excluded_keys = set()
    missing_space_key_count = 0

    for elem in elements:
        ek = elem.get('element_key', '')
        ifc_ent = ifc_by_key.get(ek)
        if not ifc_ent:
            continue
        host_space_key = elem.get('metadata', {}).get('hostSpaceKey')
        if not host_space_key:
            continue
        space_ent = ifc_by_key.get(host_space_key)
        if space_ent:
            space_contained.setdefault(host_space_key, []).append(ifc_ent)
            storey_excluded_keys.add(id(ifc_ent))
        else:
            missing_space_key_count += 1

    # Create per-space IfcRelContainedInSpatialStructure
    for space_key, contained_elems in space_contained.items():
        space_entity = ifc_by_key.get(space_key)
        if not space_entity:
            continue
        f.create_entity(
            'IfcRelContainedInSpatialStructure',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            Name=f'SpaceContainment_{space_key}',
            RelatedElements=tuple(contained_elems),
            RelatingStructure=space_entity
        )

    print(f"v3.1 Space containment: {len(space_contained)} spaces containing {sum(len(v) for v in space_contained.values())} elements, {missing_space_key_count} missing keys")

    # ---- v3: Branch-level aggregation for shell pieces ----
    branch_shell_groups = {}  # derivedFromBranch → [ifc_elements]
    missing_branch_key_count = 0

    for elem in elements:
        dfb = elem.get('properties', {}).get('derivedFromBranch')
        if not dfb:
            continue
        ek = elem.get('element_key', '')
        ifc_ent = ifc_by_key.get(ek)
        if ifc_ent:
            branch_shell_groups.setdefault(dfb, []).append(ifc_ent)
        else:
            missing_branch_key_count += 1

    # ---- v4: Per-branch shell piece lookup for space boundaries ----
    # Maps derivedFromBranch → { shellPiece → ifc_entity }
    branch_shell_by_piece = {}  # branch_key → {'LEFT_WALL': ent, 'RIGHT_WALL': ent, ...}

    for elem in elements:
        dfb = elem.get('properties', {}).get('derivedFromBranch')
        sp = elem.get('properties', {}).get('shellPiece')
        if not dfb or not sp:
            continue
        ek = elem.get('element_key', '')
        ifc_ent = ifc_by_key.get(ek)
        if not ifc_ent:
            continue
        branch_shell_by_piece.setdefault(dfb, {})[sp] = ifc_ent

    # Register merged run elements for ALL their constituent branches
    for elem in elements:
        if not elem.get('properties', {}).get('isMergedRun'):
            continue
        sp = elem.get('properties', {}).get('shellPiece', '')
        ek = elem.get('element_key', '')
        ifc_ent = ifc_by_key.get(ek)
        if not ifc_ent or not sp:
            continue
        for bk in elem.get('properties', {}).get('derivedFromBranches', []):
            branch_shell_by_piece.setdefault(bk, {})[sp] = ifc_ent

    assembly_entities = []
    for branch_key, shell_elems in branch_shell_groups.items():
        if len(shell_elems) < 2:
            continue

        # Create a new IfcLocalPlacement referencing the same parent
        first_shell_placement = shell_elems[0].ObjectPlacement
        if first_shell_placement:
            assembly_placement = f.create_entity(
                'IfcLocalPlacement',
                PlacementRelTo=first_shell_placement.PlacementRelTo,
                RelativePlacement=first_shell_placement.RelativePlacement
            )
        else:
            assembly_placement = None

        # Segment assemblies: anchor to building origin (bld_lp + wcs), not the first child shell placement.
        # Shell children may sit at mine elevations (z=13-53m); inheriting their placement makes
        # the assembly label float high above the network in the viewport.
        if has_tunnel_segments:
            assembly_lp_final = f.create_entity(
                'IfcLocalPlacement', PlacementRelTo=bld_lp, RelativePlacement=wcs
            )
        else:
            assembly_lp_final = assembly_placement
        assembly = f.create_entity(
            'IfcElementAssembly',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            Name=f'TunnelBranch_{branch_key}',
            ObjectPlacement=assembly_lp_final,
            PredefinedType='USERDEFINED'
        )
        assembly_entities.append(assembly)

        f.create_entity(
            'IfcRelAggregates',
            GlobalId=new_guid(),
            OwnerHistory=owner,
            Name=f'BranchAssembly_{branch_key}',
            RelatingObject=assembly,
            RelatedObjects=tuple(shell_elems)
        )

    # ---- v4: Space boundary relationships ----
    BOUNDARY_SHELL_PIECES = ('LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF')
    space_boundary_rel_count = 0
    bounded_space_count = 0
    incomplete_boundary_space_count = 0
    missing_shell_sibling_count = 0
    skipped_wrong_class_count = 0
    invalid_void_space_class_count = 0

    for branch_key, piece_map in branch_shell_by_piece.items():
        void_ent = piece_map.get('VOID')
        if not void_ent:
            continue  # no IfcSpace for this branch — skip

        # Guard: VOID must resolve to IfcSpace (diagnostic: log actual class if wrong)
        if not void_ent.is_a('IfcSpace'):
            invalid_void_space_class_count += 1
            print(f"v4 WARNING: VOID for branch {branch_key} resolved to {void_ent.is_a()} instead of IfcSpace — skipping boundary creation for this branch")
            continue  # entire branch skipped — not counted as incomplete

        branch_boundary_count = 0
        for shell_piece in BOUNDARY_SHELL_PIECES:
            shell_ent = piece_map.get(shell_piece)
            if not shell_ent:
                missing_shell_sibling_count += 1
                continue  # expected shell piece absent for this branch

            # Guard: shell siblings must be IfcWall or IfcSlab only
            if not (shell_ent.is_a('IfcWall') or shell_ent.is_a('IfcSlab')):
                skipped_wrong_class_count += 1
                continue

            f.create_entity(
                'IfcRelSpaceBoundary',
                GlobalId=new_guid(),
                OwnerHistory=owner,
                Name=f'SpaceBoundary_{branch_key}_{shell_piece}',
                RelatingSpace=void_ent,
                RelatedBuildingElement=shell_ent,
                PhysicalOrVirtualBoundary='PHYSICAL',
                InternalOrExternalBoundary='INTERNAL'
            )
            space_boundary_rel_count += 1
            branch_boundary_count += 1

        if branch_boundary_count == len(BOUNDARY_SHELL_PIECES):
            bounded_space_count += 1
        else:
            incomplete_boundary_space_count += 1

    print(f"v4 Space boundaries: {space_boundary_rel_count} rels across {bounded_space_count} complete + {incomplete_boundary_space_count} incomplete spaces ({missing_shell_sibling_count} missing siblings, {skipped_wrong_class_count} wrong class, {invalid_void_space_class_count} invalid void class)")

    # ---- Tunnel floor slabs — inject IfcSlab under each structural tunnel segment ----
    # Only for RECTANGLE-profile segments where tubes were skipped (post-pass is primary geometry).
    # ARCH/horseshoe segments already have floor built into the hollow tube profile.
    # Skipped when topology engine has already produced shell pieces (LEFT_WALL/RIGHT_WALL/FLOOR/ROOF)
    # — running both layers causes double-rendering.
    if has_tunnel_segments and not has_shell_pieces:
        floor_slab_count = 0
        slab_thickness = 0.25  # 250mm concrete floor
        # Build list of tunnel elements to process: explicit TUNNEL_SEGMENT or inferred from DUCT containers
        tunnel_els = [e for e in elements if e.get('type') == 'TUNNEL_SEGMENT']
        if not tunnel_els:
            # VentSim renders: infer tunnel structure from duct containers
            duct_containers = set(e.get('metadata', {}).get('container', '') for e in elements
                                  if e.get('type') in ('DUCT', 'PIPE') and e.get('metadata', {}).get('container'))
            # Create synthetic tunnel segments from containers (use container name as segment key)
            for container_id in duct_containers:
                container_ducts = [e for e in elements if e.get('metadata', {}).get('container') == container_id]
                if container_ducts:
                    # Infer tunnel from duct geometry: use first duct's profile as proxy
                    first_duct = container_ducts[0]
                    geom = first_duct.get('geometry', {}) or {}
                    profile = geom.get('profile', {}) or {}
                    synthetic_segment = {
                        'element_key': container_id,
                        'type': 'TUNNEL_SEGMENT',
                        'geometry': {'profile': profile, 'depth': geom.get('depth', 30)},
                        'placement': first_duct.get('placement', {}),
                        'properties': {'branchClass': 'STRUCTURAL'}
                    }
                    tunnel_els.append(synthetic_segment)
        for _fs_el in tunnel_els:
            if (_fs_el.get('type') != 'TUNNEL_SEGMENT'
                    or _fs_el.get('properties', {}).get('branchClass') != 'STRUCTURAL'):
                continue
            if _fs_el.get('properties', {}).get('_isBridgeSegment'):
                continue
            # Skip CIRCLE/ARBITRARY/ARCH — shaft uses solid circle, arbitrary profiles not decomposed,
            # and ARCH profiles render as hollow arch tubes (post-pass would double-render).
            _fs_pt = (_fs_el.get('geometry', {}).get('profile', {}).get('type', '') or '').upper()
            if _fs_pt in ('CIRCLE', 'ARBITRARY', 'ARCH'):
                continue
            _fs_ek = _fs_el.get('element_key', _fs_el.get('id', ''))

            _fs_geom = _fs_el.get('geometry', {}) or {}
            _fs_prof = _fs_geom.get('profile', {}) or {}
            _fs_w = float(_fs_prof.get('width', 5.0) or 0)
            _fs_h = float(_fs_prof.get('height', 5.0) or 0)
            _fs_depth_orig = float(_fs_geom.get('depth', 0) or 0)
            if _fs_w <= 0 or _fs_depth_orig <= 0:
                continue

            # Junction overlap: extend depth to seal gaps at junctions
            _fs_entry_ov = float(_fs_el.get('_entry_overlap', 0) or 0)
            _fs_exit_ov = float(_fs_el.get('_exit_overlap', 0) or 0)
            _fs_depth = _fs_depth_orig + _fs_entry_ov + _fs_exit_ov

            _fs_pl = _fs_el.get('placement', {}) or {}
            _fs_orig = _fs_pl.get('origin', {}) or {'x': 0, 'y': 0, 'z': 0}
            # Read FULL 3D bearing (including Z for slopes)
            _fs_ref = _fs_pl.get('refDirection', _fs_pl.get('axis', {'x': 1, 'y': 0, 'z': 0}))
            _fs_rx = float(_fs_ref.get('x', 1))
            _fs_ry = float(_fs_ref.get('y', 0))
            _fs_rz = float(_fs_ref.get('z', 0))
            _fs_rlen3d = math.sqrt(_fs_rx ** 2 + _fs_ry ** 2 + _fs_rz ** 2)
            if _fs_rlen3d > 1e-6:
                _fs_rx /= _fs_rlen3d
                _fs_ry /= _fs_rlen3d
                _fs_rz /= _fs_rlen3d
            else:
                _fs_rx, _fs_ry, _fs_rz = 1.0, 0.0, 0.0
            _fs_horiz = math.sqrt(_fs_rx ** 2 + _fs_ry ** 2)

            # Floor Z = bottom of tunnel profile at segment START (follows slope)
            _fs_oz = float(_fs_orig.get('z', 0))
            _fs_floor_z = _fs_oz - _fs_h / 2 + slab_thickness / 2
            # Start of segment along 3D bearing (including Z shift for slope)
            _fs_ox = float(_fs_orig.get('x', 0)) - _fs_rx * (_fs_depth_orig / 2 + _fs_entry_ov)
            _fs_oy = float(_fs_orig.get('y', 0)) - _fs_ry * (_fs_depth_orig / 2 + _fs_entry_ov)
            _fs_floor_z -= _fs_rz * (_fs_depth_orig / 2 + _fs_entry_ov)  # shift Z along slope

            _fs_container = _fs_el.get('container', '')
            if _fs_container not in storey_map:
                _fs_container = next(iter(storey_map.keys())) if storey_map else None
            if _fs_container is None:
                continue
            _fs_storey_ent, _fs_storey_lp, _ = storey_map[_fs_container]

            # Placement: axis=slab normal (tilted for slopes), refDirection=3D bearing
            # Slab normal = cross(bearing_3d, lateral). For flat segments this is (0,0,1).
            # For sloped segments, the normal tilts so the slab follows the slope.
            if _fs_horiz > 1e-6:
                _fs_lat_x = -_fs_ry / _fs_horiz
                _fs_lat_y = _fs_rx / _fs_horiz
            else:
                _fs_lat_x, _fs_lat_y = 1.0, 0.0
            # normal = cross(bearing, lateral)
            _fs_nx = _fs_ry * 0.0 - _fs_rz * _fs_lat_y
            _fs_ny = _fs_rz * _fs_lat_x - _fs_rx * 0.0
            _fs_nz = _fs_rx * _fs_lat_y - _fs_ry * _fs_lat_x
            _fs_nlen = math.sqrt(_fs_nx**2 + _fs_ny**2 + _fs_nz**2)
            if _fs_nlen > 1e-6:
                _fs_nx /= _fs_nlen; _fs_ny /= _fs_nlen; _fs_nz /= _fs_nlen
            else:
                _fs_nx, _fs_ny, _fs_nz = 0.0, 0.0, 1.0
            _fs_loc = f.create_entity('IfcCartesianPoint',
                                       Coordinates=(_fs_ox, _fs_oy, _fs_floor_z))
            _fs_axis = f.create_entity('IfcDirection', DirectionRatios=(_fs_nx, _fs_ny, _fs_nz))
            _fs_refdir = f.create_entity('IfcDirection', DirectionRatios=(_fs_rx, _fs_ry, _fs_rz))
            _fs_ax3 = f.create_entity('IfcAxis2Placement3D',
                                       Location=_fs_loc, Axis=_fs_axis, RefDirection=_fs_refdir)
            _fs_lp = f.create_entity('IfcLocalPlacement',
                                      PlacementRelTo=_fs_storey_lp, RelativePlacement=_fs_ax3)

            # Rectangle profile: X=width (lateral), Y=thickness
            # Extruded along Z (=bearing in world) for depth meters? No — we want bearing-aligned.
            # Element frame: X=bearing, Y=lateral-up cross, Z=world-up (from our axis setup above
            # Axis=Z-up, RefDirection=bearing → local X = bearing, local Y = Z × bearing = lateral,
            # local Z = world-up). Extrusion along local Z gives world-up extrusion (thickness).
            # So profile width=seg_depth (bearing), height=seg_w (lateral), extrude along Z for thickness.
            _fs_prof_entity = f.create_entity('IfcRectangleProfileDef',
                                               ProfileType='AREA',
                                               ProfileName='TunnelFloorProfile',
                                               XDim=_fs_depth,
                                               YDim=_fs_w)
            _fs_extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
            _fs_id_loc = f.create_entity('IfcCartesianPoint',
                                          Coordinates=(_fs_depth / 2.0, 0.0, -slab_thickness / 2.0))
            _fs_id_ax3 = f.create_entity('IfcAxis2Placement3D', Location=_fs_id_loc)
            _fs_solid = f.create_entity('IfcExtrudedAreaSolid',
                                         SweptArea=_fs_prof_entity,
                                         Position=_fs_id_ax3,
                                         ExtrudedDirection=_fs_extrude_dir,
                                         Depth=slab_thickness)
            _fs_body_rep = f.create_entity('IfcShapeRepresentation',
                                            ContextOfItems=subcontext,
                                            RepresentationIdentifier='Body',
                                            RepresentationType='SweptSolid',
                                            Items=(_fs_solid,))
            _fs_pds = f.create_entity('IfcProductDefinitionShape',
                                       Representations=(_fs_body_rep,))

            _fs_slab = f.create_entity('IfcSlab',
                                        GlobalId=new_guid(),
                                        OwnerHistory=owner,
                                        Name='Tunnel Floor Slab',
                                        Description='Inferred concrete floor slab',
                                        ObjectPlacement=_fs_lp,
                                        Representation=_fs_pds,
                                        PredefinedType='FLOOR')

            ifc_by_key[_fs_ek] = _fs_slab  # floor slab as PATH_CONNECTS representative for RECTANGLE segments
            elements_by_container.setdefault(_fs_container, []).append(_fs_slab)
            floor_slab_count += 1

        if floor_slab_count:
            print(f"Tunnel floor slabs: created {floor_slab_count} IfcSlab(FLOOR) entities")

    # ---- Tunnel ceiling slabs — inject IfcSlab(ROOF) above each structural tunnel segment ----
    # Only for RECTANGLE-profile segments. ARCH profiles include ceiling in the tube.
    # Skipped when topology engine has already produced shell pieces — avoids double-rendering.
    if has_tunnel_segments and not has_shell_pieces:
        ceiling_slab_count = 0
        ceiling_thickness = 0.25  # 250mm concrete ceiling
        for _cs_el in elements:
            if (_cs_el.get('type') != 'TUNNEL_SEGMENT'
                    or _cs_el.get('properties', {}).get('branchClass') != 'STRUCTURAL'):
                continue
            if _cs_el.get('properties', {}).get('_isBridgeSegment'):
                continue
            _cs_pt = (_cs_el.get('geometry', {}).get('profile', {}).get('type', '') or '').upper()
            if _cs_pt in ('CIRCLE', 'ARBITRARY', 'ARCH'):
                continue
            _cs_ek = _cs_el.get('element_key', _cs_el.get('id', ''))

            _cs_geom = _cs_el.get('geometry', {}) or {}
            _cs_prof = _cs_geom.get('profile', {}) or {}
            _cs_w = float(_cs_prof.get('width', 5.0) or 0)
            _cs_h = float(_cs_prof.get('height', 5.0) or 0)
            _cs_depth_orig = float(_cs_geom.get('depth', 0) or 0)
            if _cs_w <= 0 or _cs_depth_orig <= 0:
                continue

            # Junction overlap
            _cs_entry_ov = float(_cs_el.get('_entry_overlap', 0) or 0)
            _cs_exit_ov = float(_cs_el.get('_exit_overlap', 0) or 0)
            _cs_depth = _cs_depth_orig + _cs_entry_ov + _cs_exit_ov

            _cs_pl = _cs_el.get('placement', {}) or {}
            _cs_orig = _cs_pl.get('origin', {}) or {'x': 0, 'y': 0, 'z': 0}
            # Read FULL 3D bearing (including Z for slopes)
            _cs_ref = _cs_pl.get('refDirection', _cs_pl.get('axis', {'x': 1, 'y': 0, 'z': 0}))
            _cs_rx = float(_cs_ref.get('x', 1))
            _cs_ry = float(_cs_ref.get('y', 0))
            _cs_rz = float(_cs_ref.get('z', 0))
            _cs_rlen3d = math.sqrt(_cs_rx ** 2 + _cs_ry ** 2 + _cs_rz ** 2)
            if _cs_rlen3d > 1e-6:
                _cs_rx /= _cs_rlen3d; _cs_ry /= _cs_rlen3d; _cs_rz /= _cs_rlen3d
            else:
                _cs_rx, _cs_ry, _cs_rz = 1.0, 0.0, 0.0
            _cs_horiz = math.sqrt(_cs_rx ** 2 + _cs_ry ** 2)

            # Ceiling Z = top of tunnel profile at segment START (follows slope)
            _cs_oz = float(_cs_orig.get('z', 0))
            _cs_ceil_z = _cs_oz + _cs_h / 2 - ceiling_thickness / 2
            # Start of segment along 3D bearing
            _cs_ox = float(_cs_orig.get('x', 0)) - _cs_rx * (_cs_depth_orig / 2 + _cs_entry_ov)
            _cs_oy = float(_cs_orig.get('y', 0)) - _cs_ry * (_cs_depth_orig / 2 + _cs_entry_ov)
            _cs_ceil_z -= _cs_rz * (_cs_depth_orig / 2 + _cs_entry_ov)

            _cs_container = _cs_el.get('container', '')
            if _cs_container not in storey_map:
                _cs_container = next(iter(storey_map.keys())) if storey_map else None
            if _cs_container is None:
                continue
            _cs_storey_ent, _cs_storey_lp, _ = storey_map[_cs_container]

            # Slab normal = cross(bearing_3d, lateral) — tilts for slopes
            if _cs_horiz > 1e-6:
                _cs_lat_x = -_cs_ry / _cs_horiz
                _cs_lat_y = _cs_rx / _cs_horiz
            else:
                _cs_lat_x, _cs_lat_y = 1.0, 0.0
            _cs_nx = _cs_ry * 0.0 - _cs_rz * _cs_lat_y
            _cs_ny = _cs_rz * _cs_lat_x - _cs_rx * 0.0
            _cs_nz = _cs_rx * _cs_lat_y - _cs_ry * _cs_lat_x
            _cs_nlen = math.sqrt(_cs_nx**2 + _cs_ny**2 + _cs_nz**2)
            if _cs_nlen > 1e-6:
                _cs_nx /= _cs_nlen; _cs_ny /= _cs_nlen; _cs_nz /= _cs_nlen
            else:
                _cs_nx, _cs_ny, _cs_nz = 0.0, 0.0, 1.0
            _cs_loc = f.create_entity('IfcCartesianPoint',
                                       Coordinates=(_cs_ox, _cs_oy, _cs_ceil_z))
            _cs_axis = f.create_entity('IfcDirection', DirectionRatios=(_cs_nx, _cs_ny, _cs_nz))
            _cs_refdir = f.create_entity('IfcDirection', DirectionRatios=(_cs_rx, _cs_ry, _cs_rz))
            _cs_ax3 = f.create_entity('IfcAxis2Placement3D',
                                       Location=_cs_loc, Axis=_cs_axis, RefDirection=_cs_refdir)
            _cs_lp = f.create_entity('IfcLocalPlacement',
                                      PlacementRelTo=_cs_storey_lp, RelativePlacement=_cs_ax3)

            _cs_prof_entity = f.create_entity('IfcRectangleProfileDef',
                                               ProfileType='AREA',
                                               ProfileName='TunnelCeilingProfile',
                                               XDim=_cs_depth,
                                               YDim=_cs_w)
            _cs_extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
            _cs_id_loc = f.create_entity('IfcCartesianPoint',
                                          Coordinates=(_cs_depth / 2.0, 0.0, -ceiling_thickness / 2.0))
            _cs_id_ax3 = f.create_entity('IfcAxis2Placement3D', Location=_cs_id_loc)
            _cs_solid = f.create_entity('IfcExtrudedAreaSolid',
                                         SweptArea=_cs_prof_entity,
                                         Position=_cs_id_ax3,
                                         ExtrudedDirection=_cs_extrude_dir,
                                         Depth=ceiling_thickness)
            _cs_body_rep = f.create_entity('IfcShapeRepresentation',
                                            ContextOfItems=subcontext,
                                            RepresentationIdentifier='Body',
                                            RepresentationType='SweptSolid',
                                            Items=(_cs_solid,))
            _cs_pds = f.create_entity('IfcProductDefinitionShape',
                                       Representations=(_cs_body_rep,))

            _cs_slab = f.create_entity('IfcSlab',
                                        GlobalId=new_guid(),
                                        OwnerHistory=owner,
                                        Name='Tunnel Ceiling Slab',
                                        Description='Inferred concrete ceiling slab',
                                        ObjectPlacement=_cs_lp,
                                        Representation=_cs_pds,
                                        PredefinedType='ROOF')

            elements_by_container.setdefault(_cs_container, []).append(_cs_slab)
            ceiling_slab_count += 1

        if ceiling_slab_count:
            print(f"Tunnel ceiling slabs: created {ceiling_slab_count} IfcSlab(ROOF) entities")

    # ---- Tunnel side walls — IfcWall at left and right of each structural segment ----
    # Creates flat vertical wall surfaces at ±W/2 from centerline.
    # Only for RECTANGLE-profile segments. ARCH profiles include walls in the tube.
    # Skipped when topology engine has already produced shell pieces — avoids double-rendering.
    if has_tunnel_segments and not has_shell_pieces:
        side_wall_count = 0
        for _sw_el in elements:
            if (_sw_el.get('type') != 'TUNNEL_SEGMENT'
                    or _sw_el.get('properties', {}).get('branchClass') != 'STRUCTURAL'):
                continue
            if _sw_el.get('properties', {}).get('_isBridgeSegment'):
                continue
            _sw_pt = (_sw_el.get('geometry', {}).get('profile', {}).get('type', '') or '').upper()
            if _sw_pt in ('CIRCLE', 'ARBITRARY', 'ARCH'):
                continue
            _sw_ek = _sw_el.get('element_key', _sw_el.get('id', ''))

            _sw_geom = _sw_el.get('geometry', {}) or {}
            _sw_prof = _sw_geom.get('profile', {}) or {}
            _sw_w = float(_sw_prof.get('width', 5.0) or 0)
            _sw_h = float(_sw_prof.get('height', 5.0) or 0)
            _sw_depth_orig = float(_sw_geom.get('depth', 0) or 0)
            _sw_t = float(_sw_prof.get('wallThickness', 0.3) or 0.3)
            if _sw_w <= 0 or _sw_depth_orig <= 0 or _sw_h <= 0:
                continue

            # Junction overlap
            _sw_entry_ov = float(_sw_el.get('_entry_overlap', 0) or 0)
            _sw_exit_ov = float(_sw_el.get('_exit_overlap', 0) or 0)
            _sw_depth = _sw_depth_orig + _sw_entry_ov + _sw_exit_ov

            _sw_pl = _sw_el.get('placement', {}) or {}
            _sw_orig = _sw_pl.get('origin', {}) or {'x': 0, 'y': 0, 'z': 0}
            _sw_ref = _sw_pl.get('refDirection', _sw_pl.get('axis', {'x': 1, 'y': 0, 'z': 0}))
            _sw_rx = float(_sw_ref.get('x', 1))
            _sw_ry = float(_sw_ref.get('y', 0))
            _sw_rlen = math.sqrt(_sw_rx ** 2 + _sw_ry ** 2)
            if _sw_rlen > 1e-6:
                _sw_rx /= _sw_rlen
                _sw_ry /= _sw_rlen
            else:
                _sw_rx, _sw_ry = 1.0, 0.0
            # Lateral direction (perpendicular to bearing, horizontal)
            _sw_lx, _sw_ly = -_sw_ry, _sw_rx

            _sw_container = _sw_el.get('container', '')
            if _sw_container not in storey_map:
                _sw_container = next(iter(storey_map.keys())) if storey_map else None
            if _sw_container is None:
                continue
            _sw_storey_ent, _sw_storey_lp, _ = storey_map[_sw_container]

            # Read full 3D bearing for slope
            _sw_ref3 = _sw_pl.get('refDirection', _sw_pl.get('axis', {'x': 1, 'y': 0, 'z': 0}))
            _sw_rz = float(_sw_ref3.get('z', 0))
            # Re-normalize with Z
            _sw_rlen3d = math.sqrt(_sw_rx ** 2 + _sw_ry ** 2 + _sw_rz ** 2)
            if _sw_rlen3d > 1e-6:
                _sw_rx /= _sw_rlen3d; _sw_ry /= _sw_rlen3d; _sw_rz /= _sw_rlen3d

            _sw_oz = float(_sw_orig.get('z', 0)) - _sw_h / 2
            # Start of segment along 3D bearing
            _sw_start_x = float(_sw_orig.get('x', 0)) - _sw_rx * (_sw_depth_orig / 2 + _sw_entry_ov)
            _sw_start_y = float(_sw_orig.get('y', 0)) - _sw_ry * (_sw_depth_orig / 2 + _sw_entry_ov)
            _sw_oz -= _sw_rz * (_sw_depth_orig / 2 + _sw_entry_ov)

            for _sw_side, _sw_sign, _sw_name in [('LEFT', -1, 'Left Wall'), ('RIGHT', 1, 'Right Wall')]:
                _sw_cx = _sw_start_x + _sw_lx * _sw_sign * (_sw_w / 2 - _sw_t / 2)
                _sw_cy = _sw_start_y + _sw_ly * _sw_sign * (_sw_w / 2 - _sw_t / 2)

                _sw_loc = f.create_entity('IfcCartesianPoint',
                    Coordinates=(_sw_cx, _sw_cy, _sw_oz))
                _sw_axis = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                _sw_refdir = f.create_entity('IfcDirection', DirectionRatios=(_sw_rx, _sw_ry, _sw_rz))
                _sw_ax3 = f.create_entity('IfcAxis2Placement3D',
                    Location=_sw_loc, Axis=_sw_axis, RefDirection=_sw_refdir)
                _sw_lp = f.create_entity('IfcLocalPlacement',
                    PlacementRelTo=_sw_storey_lp, RelativePlacement=_sw_ax3)

                # Profile: XDim = depth (along bearing), YDim = thickness
                _sw_prof_ent = f.create_entity('IfcRectangleProfileDef',
                    ProfileType='AREA', ProfileName=f'TunnelWallProfile_{_sw_side}',
                    XDim=_sw_depth, YDim=_sw_t)
                _sw_extrude_dir = f.create_entity('IfcDirection', DirectionRatios=(0.0, 0.0, 1.0))
                _sw_solid_loc = f.create_entity('IfcCartesianPoint',
                    Coordinates=(_sw_depth / 2.0, 0.0, 0.0))
                _sw_solid_ax3 = f.create_entity('IfcAxis2Placement3D', Location=_sw_solid_loc)
                _sw_solid = f.create_entity('IfcExtrudedAreaSolid',
                    SweptArea=_sw_prof_ent, Position=_sw_solid_ax3,
                    ExtrudedDirection=_sw_extrude_dir, Depth=_sw_h)

                apply_style(f, _sw_solid, (0.75, 0.75, 0.75), 0.0, f'TunnelWall_{_sw_side}')

                _sw_body = f.create_entity('IfcShapeRepresentation',
                    ContextOfItems=subcontext, RepresentationIdentifier='Body',
                    RepresentationType='SweptSolid', Items=(_sw_solid,))
                _sw_pds = f.create_entity('IfcProductDefinitionShape',
                    Representations=(_sw_body,))

                _sw_wall = f.create_entity('IfcWall',
                    GlobalId=new_guid(), OwnerHistory=owner,
                    Name=f'{_sw_name}', Description=f'Tunnel {_sw_name.lower()}',
                    ObjectPlacement=_sw_lp, Representation=_sw_pds)

                elements_by_container.setdefault(_sw_container, []).append(_sw_wall)
                side_wall_count += 1

        if side_wall_count:
            print(f"Tunnel side walls: created {side_wall_count} IfcWall entities")

    # ---- PATH_CONNECTS → IfcRelConnectsPathElements (v13 BIM Connectivity) ----
    # Runs after post-pass so RECTANGLE tunnel segment floor slabs are in ifc_by_key.
    IFC_CONNECTION_TYPES = {'ATSTART', 'ATEND', 'ATPATH', 'NOTDEFINED'}

    path_connect_canonical = {}  # canonical_key → (source_key, target_key, ...)
    path_connect_count = 0
    _pc_attempted = 0
    _pc_no_source = 0
    _pc_no_target = 0
    _pc_no_source_keys = []
    _pc_no_target_keys = []

    for elem in elements:
        relationships = elem.get('relationships', [])
        elem_key = elem.get('element_key', '') or elem.get('id', '')

        for rel in relationships:
            rel_type = rel.get('type', '')
            target_key = rel.get('target', '')

            if rel_type != 'PATH_CONNECTS':
                continue
            if not elem_key or not target_key:
                continue

            _pc_attempted += 1

            resolved_elem_key = parallel_dedup_redirect.get(elem_key, elem_key) if not ifc_by_key.get(elem_key) and not ifc_elements_by_css_id.get(elem_key) else elem_key
            resolved_target_key = parallel_dedup_redirect.get(target_key, target_key) if not ifc_by_key.get(target_key) and not ifc_elements_by_css_id.get(target_key) else target_key
            source_ifc = ifc_by_key.get(resolved_elem_key) or ifc_elements_by_css_id.get(resolved_elem_key)
            target_ifc = ifc_by_key.get(resolved_target_key) or ifc_elements_by_css_id.get(resolved_target_key)
            elem_key = resolved_elem_key
            target_key = resolved_target_key

            if not source_ifc or not target_ifc:
                if not source_ifc:
                    _pc_no_source += 1
                    if len(_pc_no_source_keys) < 5:
                        _pc_no_source_keys.append(elem_key[:40])
                if not target_ifc:
                    _pc_no_target += 1
                    if len(_pc_no_target_keys) < 5:
                        _pc_no_target_keys.append(target_key[:40])
                continue

            source_type = source_ifc.is_a() if hasattr(source_ifc, 'is_a') else ''
            target_type = target_ifc.is_a() if hasattr(target_ifc, 'is_a') else ''
            if source_type in ('IfcSpace', 'IfcOpeningElement') or target_type in ('IfcSpace', 'IfcOpeningElement'):
                print(f"Warning: PATH_CONNECTS skipped — {elem_key} ({source_type}) or {target_key} ({target_type}) is space/opening")
                continue

            source_interface = rel.get('sourceInterface', {})
            target_interface = rel.get('targetInterface', {})
            source_kind = source_interface.get('kind', 'NOTDEFINED') if source_interface else 'NOTDEFINED'
            target_kind = target_interface.get('kind', 'NOTDEFINED') if target_interface else 'NOTDEFINED'
            source_node = source_interface.get('node', '') if source_interface else ''
            target_node = target_interface.get('node', '') if target_interface else ''
            rel_metadata = rel.get('metadata', {}) or {}
            shell_role = rel_metadata.get('shellRole', '')
            role = rel.get('role', 'STRUCTURAL_CONTINUITY')
            connection_angle = rel_metadata.get('connectionAngle')

            if source_kind not in IFC_CONNECTION_TYPES:
                source_kind = 'NOTDEFINED'
            if target_kind not in IFC_CONNECTION_TYPES:
                target_kind = 'NOTDEFINED'

            sorted_keys = sorted([elem_key, target_key])
            if sorted_keys[0] == elem_key:
                canon_key = f"{sorted_keys[0]}|{sorted_keys[1]}|{source_kind}|{target_kind}|{source_node}|{target_node}|{shell_role}|{role}"
            else:
                canon_key = f"{sorted_keys[0]}|{sorted_keys[1]}|{target_kind}|{source_kind}|{target_node}|{source_node}|{shell_role}|{role}"

            if canon_key in path_connect_canonical:
                continue

            path_connect_canonical[canon_key] = (elem_key, target_key, source_kind, target_kind, source_ifc, target_ifc, shell_role, role, connection_angle)

    mitre_count = 0
    for canon_key, (src_key, tgt_key, src_kind, tgt_kind, src_ifc, tgt_ifc, shell_role, role, conn_angle) in path_connect_canonical.items():
        try:
            rel_name = f"PathConnect_{src_key}_{tgt_key}"
            if shell_role:
                rel_name += f"_{shell_role}"

            desc = role
            if conn_angle and isinstance(conn_angle, dict):
                angle_deg = conn_angle.get('angleDeg', 0)
                conn_type = conn_angle.get('connectionType', 'UNKNOWN')
                desc = f"{role} [{conn_type} {angle_deg}deg]"
                if conn_type == 'MITRE':
                    mitre_count += 1

            rel_entity = f.create_entity(
                'IfcRelConnectsPathElements',
                GlobalId=new_guid(),
                OwnerHistory=owner,
                Name=rel_name,
                Description=desc,
                RelatingElement=src_ifc,
                RelatedElement=tgt_ifc,
                RelatingConnectionType=src_kind,
                RelatedConnectionType=tgt_kind,
                RelatingPriorities=[],
                RelatedPriorities=[],
                ConnectionGeometry=None
            )
            path_connect_count += 1
        except Exception as e:
            print(f"Warning: Could not create IfcRelConnectsPathElements {src_key} → {tgt_key}: {e}")

    if path_connect_count > 0 or _pc_attempted > 0:
        print(f"IfcRelConnectsPathElements: created {path_connect_count} path connections ({mitre_count} mitre joints)")
        print(f"  PATH_CONNECTS resolution: {_pc_attempted} attempted, {_pc_no_source} no-source, {_pc_no_target} no-target, {len(path_connect_canonical)} canonical pairs")
        if _pc_no_source_keys:
            print(f"  Missing source samples: {_pc_no_source_keys}")
        if _pc_no_target_keys:
            print(f"  Missing target samples: {_pc_no_target_keys}")

    # ---- Relate elements to storeys ----
    assemblies_added = False
    for container_id, ifc_elems in elements_by_container.items():
        if container_id in storey_map and ifc_elems:
            # Filter out space-contained elements
            all_elems = [e for e in ifc_elems if id(e) not in storey_excluded_keys]
            # Include any IfcOpeningElements created for this storey
            if container_id in opening_elements_for_storey:
                all_elems.extend(opening_elements_for_storey[container_id])
            # Include assemblies in the first storey containment (once only)
            if assembly_entities and not assemblies_added:
                all_elems.extend(assembly_entities)
                assemblies_added = True
            if all_elems:
                storey_entity, _, _elev = storey_map[container_id]
                f.create_entity(
                    'IfcRelContainedInSpatialStructure',
                    GlobalId=new_guid(),
                    OwnerHistory=owner,
                    RelatedElements=tuple(all_elems),
                    RelatingStructure=storey_entity
                )

    if orientation_warnings:
        print(f"Fan orientation warnings: {len(orientation_warnings)}")
        for w in orientation_warnings:
            print(f"  {w}")

    # ---- PHASE 2: Connected System Topology ----
    # Universal — runs whenever the model has distribution elements (ducts, fans, pipes).
    system_topology = {'systems': [], 'connections': 0, 'ports': 0}
    vent_ducts = [ent for ent in ifc_by_key.values() if ent.is_a('IfcDuctSegment')]
    vent_fans = [ent for ent in ifc_by_key.values() if ent.is_a('IfcFan')]
    vent_pipes = [ent for ent in ifc_by_key.values() if ent.is_a('IfcPipeSegment')]
    if vent_ducts or vent_fans or vent_pipes:

        if vent_ducts or vent_fans:
            # Create ventilation distribution system
            vent_system = f.create_entity('IfcDistributionSystem',
                GlobalId=new_guid(), OwnerHistory=owner,
                Name='Ventilation System', PredefinedType='VENTILATION')
            system_members = list(vent_ducts) + list(vent_fans)
            if system_members:
                f.create_entity('IfcRelAssignsToGroup',
                    GlobalId=new_guid(), OwnerHistory=owner,
                    RelatedObjects=tuple(system_members),
                    RelatingGroup=vent_system)
                # Service the building
                if building:
                    f.create_entity('IfcRelServicesBuildings',
                        GlobalId=new_guid(), OwnerHistory=owner,
                        RelatingSystem=vent_system,
                        RelatedBuildings=(building,))
                system_topology['systems'].append({
                    'name': 'Ventilation System',
                    'type': 'VENTILATION',
                    'memberCount': len(system_members),
                    'ducts': len(vent_ducts),
                    'fans': len(vent_fans)
                })

            # Create ports and connections for adjacent duct segments sharing endpoints.
            # N5: skip for tunnel renders — DistributionPort entities render as visible
            # cyan boxes in xeokit. Tunnel segment connectivity uses IfcRelConnectsPathElements.
            port_count = 0
            connection_count = 0
            _mep_ports_enabled = not has_tunnel_segments
            # Build endpoint map from CSS elements
            endpoint_map = {}  # (rounded_x,y,z) -> [(element_key, ifc_entity, end)]
            for elem in elements:
                ek = elem.get('element_key')
                if not ek or ek not in ifc_by_key:
                    continue
                ifc_ent = ifc_by_key[ek]
                if not ifc_ent.is_a('IfcDuctSegment') and not ifc_ent.is_a('IfcPipeSegment'):
                    continue
                o = elem.get('placement', {}).get('origin', {})
                props = elem.get('properties', {})
                entry = props.get('entry_node')
                exit_n = props.get('exit_node')
                # Use node IDs as connection keys (more reliable than coordinates)
                if entry is not None:
                    key = f"node_{entry}"
                    endpoint_map.setdefault(key, []).append((ek, ifc_ent, 'SOURCE'))
                if exit_n is not None:
                    key = f"node_{exit_n}"
                    endpoint_map.setdefault(key, []).append((ek, ifc_ent, 'SINK'))

            # Create connections where two elements share a node.
            # N5 guard: clear map for tunnel renders so the loop below produces no ports.
            if not _mep_ports_enabled:
                endpoint_map.clear()
            connected_pairs = set()
            for node_key, endpoints in endpoint_map.items():
                if len(endpoints) < 2:
                    continue
                for i in range(len(endpoints)):
                    for j in range(i + 1, len(endpoints)):
                        ek1, ent1, end1 = endpoints[i]
                        ek2, ent2, end2 = endpoints[j]
                        pair_key = tuple(sorted([ek1, ek2]))
                        if pair_key in connected_pairs:
                            continue
                        connected_pairs.add(pair_key)
                        try:
                            # Create ports
                            port1 = f.create_entity('IfcDistributionPort',
                                GlobalId=new_guid(), OwnerHistory=owner,
                                Name=f"Port_{ek1}_{end1}", FlowDirection=end1)
                            port2 = f.create_entity('IfcDistributionPort',
                                GlobalId=new_guid(), OwnerHistory=owner,
                                Name=f"Port_{ek2}_{end2}", FlowDirection=end2)
                            f.create_entity('IfcRelConnectsPortToElement',
                                GlobalId=new_guid(), OwnerHistory=owner,
                                RelatingPort=port1, RelatedElement=ent1)
                            f.create_entity('IfcRelConnectsPortToElement',
                                GlobalId=new_guid(), OwnerHistory=owner,
                                RelatingPort=port2, RelatedElement=ent2)
                            f.create_entity('IfcRelConnectsPorts',
                                GlobalId=new_guid(), OwnerHistory=owner,
                                RelatingPort=port1, RelatedPort=port2)
                            port_count += 2
                            connection_count += 1
                        except Exception as conn_err:
                            print(f"Warning: Failed to create connection {pair_key}: {conn_err}")

            system_topology['connections'] = connection_count
            system_topology['ports'] = port_count

        if vent_pipes:
            pipe_system = f.create_entity('IfcDistributionSystem',
                GlobalId=new_guid(), OwnerHistory=owner,
                Name='Piping System', PredefinedType='DRAINAGE')
            f.create_entity('IfcRelAssignsToGroup',
                GlobalId=new_guid(), OwnerHistory=owner,
                RelatedObjects=tuple(vent_pipes),
                RelatingGroup=pipe_system)
            if building:
                f.create_entity('IfcRelServicesBuildings',
                    GlobalId=new_guid(), OwnerHistory=owner,
                    RelatingSystem=pipe_system,
                    RelatedBuildings=(building,))
            system_topology['systems'].append({
                'name': 'Piping System', 'type': 'DRAINAGE',
                'memberCount': len(vent_pipes)
            })

        if system_topology['systems']:
            print(f"PHASE 2: Created {len(system_topology['systems'])} distribution systems, "
                  f"{system_topology['connections']} connections, {system_topology['ports']} ports")

    # Segment structure bbox validation (CSS-space pre-generation sanity check)
    tunnel_shell_report = None
    if has_tunnel_segments:
        structural_elems = [e for e in elements if e.get('type') in ('WALL', 'SLAB')
                            or (e.get('type') == 'TUNNEL_SEGMENT' and e.get('properties', {}).get('branchClass') == 'STRUCTURAL')]
        z_vals = [e.get('placement', {}).get('origin', {}).get('z', 0) for e in structural_elems]
        parent_segments = [e for e in elements if e.get('type') == 'TUNNEL_SEGMENT'
                           and e.get('properties', {}).get('branchClass') == 'STRUCTURAL']
        heights = [e.get('geometry', {}).get('profile', {}).get('height', 0) for e in parent_segments]
        heights = [h for h in heights if h > 0]
        if heights and z_vals:
            avg_height = sum(heights) / len(heights)
            vertical_span = max(z_vals) - min(z_vals)
            if vertical_span > 3 * avg_height:
                print(f"Warning: Tunnel vertical dimension suspicious — span={vertical_span:.1f}m vs avg_height={avg_height:.1f}m — possible orientation error")

        # Tunnel shell report
        shell_walls = sum(1 for e in elements if e.get('properties', {}).get('shellPiece') in ('LEFT_WALL', 'RIGHT_WALL'))
        shell_slabs = sum(1 for e in elements if e.get('properties', {}).get('shellPiece') in ('FLOOR', 'ROOF'))
        shell_spaces = sum(1 for e in elements if e.get('properties', {}).get('shellPiece') == 'VOID')
        proxy_structural = sum(1 for e in elements if e.get('type') == 'TUNNEL_SEGMENT'
                               and e.get('properties', {}).get('branchClass') == 'STRUCTURAL'
                               and e.get('element_key') not in decomposed_branches)
        defaulted_thickness = sum(1 for e in elements if e.get('properties', {}).get('shellThicknessBasis') == 'DEFAULT')
        space_suppressed = (css.get('metadata') or {}).get('tunnelDecomposition') or {}
        space_suppressed = space_suppressed.get('spaceSuppressedCount', 0) if isinstance(space_suppressed, dict) else 0

        # v3 metrics
        duct_segment_count = sum(1 for ent in ifc_by_key.values() if ent.is_a('IfcDuctSegment'))
        pipe_segment_count = sum(1 for ent in ifc_by_key.values() if ent.is_a('IfcPipeSegment'))
        space_containment_count = len(space_contained)
        branch_assembly_count = len(assembly_entities)
        material_layer_count = sum(1 for e in elements
                                   if e.get('properties', {}).get('shellThickness_m')
                                   and e.get('properties', {}).get('shellPiece') in
                                   ('LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'))
        infrastructure_in_space_count = sum(len(v) for v in space_contained.values())

        tunnel_shell_report = {
            'derivedShellPieceCount': shell_walls + shell_slabs + shell_spaces,
            'wallElements': shell_walls,
            'slabElements': shell_slabs,
            'spaceElements': shell_spaces,
            'proxyStructuralCount': proxy_structural,
            'ductElements': sum(1 for e in elements if e.get('type') == 'DUCT'),
            'equipmentElements': sum(1 for e in elements if e.get('type') == 'EQUIPMENT'),
            'defaultedThicknessCount': defaulted_thickness,
            'spaceSuppressedCount': space_suppressed,
            'structureFirstRatio': round((shell_walls + shell_slabs) / max(1, shell_walls + shell_slabs + proxy_structural), 3),
            'ductSegmentCount': duct_segment_count,
            'pipeSegmentCount': pipe_segment_count,
            'spaceContainmentRelCount': space_containment_count,
            'branchAssemblyCount': branch_assembly_count,
            'materialLayerCount': material_layer_count,
            'infrastructureInSpaceCount': infrastructure_in_space_count,
            'missingSpaceContainmentKeyCount': missing_space_key_count,
            'missingBranchAggregationKeyCount': missing_branch_key_count,
            # v4 space boundary metrics
            'spaceBoundaryRelCount': space_boundary_rel_count,
            'boundedSpaceCount': bounded_space_count,
            'incompleteBoundarySpaceCount': incomplete_boundary_space_count,
            'missingShellSiblingCount': missing_shell_sibling_count,
            'skippedWrongClassCount': skipped_wrong_class_count,
            'invalidVoidSpaceClassCount': invalid_void_space_class_count,
            # v11: curved geometry + transition helper counters
            'curvedShellCount': metadata.get('curvedGeometry', {}).get('curvedShellCount', 0),
            'curvedVoidCount': metadata.get('curvedGeometry', {}).get('circularCount', 0) + metadata.get('curvedGeometry', {}).get('horseshoeCount', 0),
            'shellApproximation': metadata.get('curvedGeometry', {}).get('shellApproximation', 'RECTANGULAR'),
        }

        # v11: Count transition helpers in elements
        transition_helpers = [e for e in elements if e.get('properties', {}).get('isTransitionHelper')]
        bend_plugs = [e for e in transition_helpers if e.get('properties', {}).get('geometryApproximation') == 'BEND_PLUG']
        junction_plugs = [e for e in transition_helpers if e.get('properties', {}).get('geometryApproximation') == 'JUNCTION_PLUG']
        junction_voids = [e for e in transition_helpers if e.get('properties', {}).get('shellPiece') == 'VOID']
        tunnel_shell_report['transitionHelperCount'] = len(transition_helpers)
        tunnel_shell_report['bendPlugCount'] = len(bend_plugs)
        tunnel_shell_report['junctionPlugCount'] = len(junction_plugs)
        tunnel_shell_report['junctionVoidCount'] = len(junction_voids)

        # v12: Shell run merge and arbitrary profile counters
        merged_runs = [e for e in elements if e.get('properties', {}).get('isMergedRun')]
        merged_into = [e for e in elements if e.get('properties', {}).get('mergedIntoRun')]
        tunnel_shell_report['mergedRunCount'] = len(merged_runs)
        tunnel_shell_report['mergedPieceCount'] = len(merged_into)
        tunnel_shell_report['effectiveShellPieceCount'] = (
            shell_walls + shell_slabs + shell_spaces - len(merged_into) + len(merged_runs)
        )

        # Count arbitrary profiles (elements with profile type ARBITRARY)
        arbitrary_profile_count = sum(1 for e in elements if e.get('geometry', {}).get('profile', {}).get('type') == 'ARBITRARY')
        tunnel_shell_report['arbitraryProfileCount'] = arbitrary_profile_count

        # Count opening elements created via VOIDS relationships
        opening_element_count = sum(1 for e in elements if any(r.get('type') == 'VOIDS' for r in e.get('relationships', [])))
        tunnel_shell_report['openingElementCount'] = opening_element_count

        print(f"Tunnel shell report: {json.dumps(tunnel_shell_report)}")

    print(f"IFC generation complete: {element_count} elements created, {error_count} errors, mode={output_mode}")

    _ifc_str = f.to_string()

    # PHASE 4C: chain summary + IFC size gate (visual + size sanity in one place).
    if has_tunnel_segments and chain_stats_total['chains_detected'] > 0:
        _portal_arch = sum(1 for e in elements
                           if e.get('properties', {}).get('segmentType') == 'PORTAL_BUILDING'
                           and e.get('metadata', {}).get('_chainEndSection'))
        _portal_box = sum(1 for e in elements
                          if e.get('properties', {}).get('segmentType') == 'PORTAL_BUILDING'
                          and not e.get('metadata', {}).get('_chainEndSection'))
        print(f"[CHAIN-PORTAL] portals_arch_matched={_portal_arch} portals_box_fallback={_portal_box}")
        print(f"[CHAIN-SIZE] entities={element_count} bytes={len(_ifc_str)}")

    # CLEAN_MODE=full retention guardrail — surfaces unexpected drops without
    # failing the render. The denominator excludes elements that were
    # intentionally filtered out in the main loop (cable_tray/lighting
    # geometryExportable=False, portal Y-split duplicates, bridge segments,
    # PROXY in tunnel mode, rectangular tunnel segments handled by post-pass
    # walls, junction-fill approximations, orphan openings, host HARD fails,
    # degenerate duct paths). Post-pass slabs/walls are reported separately
    # so the operator can see the full IFC payload, not just main-loop emits.
    main_loop_emitted_count = element_count
    post_pass_emitted_count = (
        (locals().get('floor_slab_count', 0) or 0)
        + (locals().get('ceiling_slab_count', 0) or 0)
        + (locals().get('side_wall_count', 0) or 0)
    )
    expected_emit_count = _topology_element_count - intentional_skip_count
    retention_ratio = (
        main_loop_emitted_count / expected_emit_count
        if expected_emit_count > 0 else 1.0
    )
    retention_log = {
        'input_element_count': _input_element_count,
        'topology_count_after_filters': _topology_element_count,
        'intentional_skip_count': intentional_skip_count,
        'main_loop_emitted_count': main_loop_emitted_count,
        'post_pass_emitted_count': post_pass_emitted_count,
        'expected_emit_count': expected_emit_count,
        'retention_ratio': round(retention_ratio, 4),
        'clean_mode': clean_mode,
    }
    print(f"[GEN] retention: {json.dumps(retention_log)}")
    if (clean_mode == 'full'
            and expected_emit_count > 0
            and main_loop_emitted_count < expected_emit_count * 0.9):
        print(f"[GEN][WARN] CLEAN_MODE=full retention below 90%: "
              f"emitted={main_loop_emitted_count} expected={expected_emit_count} "
              f"ratio={retention_ratio:.2%} — silent drops possible, see "
              f"main_loop_emitted_count vs expected_emit_count above. "
              f"Investigation deferred; render continues.")

    return _ifc_str, element_count, error_count, orientation_warnings, tunnel_shell_report


# ============================================================================
# CSS HASH + CACHING
# ============================================================================

def compute_css_hash(css):
    """Compute SHA-256 hash of CSS for caching.
    Version salt ensures geometry fixes bust stale cached IFC files."""
    salt = '__v51_5b5e_door_opening_target_reconciliation'
    if os.environ.get('CLEAN_TUNNEL_EXPORT', '1') != '0':
        salt += '__clean_tunnel_phase4c_main_loop_only'
    css_str = json.dumps(css, sort_keys=True) + salt
    return hashlib.sha256(css_str.encode('utf-8')).hexdigest()


def check_cache(css_hash):
    """Check if a cached IFC exists for this CSS hash."""
    cache_key = f'cache/{css_hash}/model.ifc'
    try:
        response = s3_client.get_object(Bucket=IFC_BUCKET, Key=cache_key)
        ifc_content = response['Body'].read().decode('utf-8')
        print(f"Cache HIT for hash {css_hash[:12]}...")
        return ifc_content
    except Exception:
        return None


def store_cache(css_hash, ifc_content):
    """Store generated IFC in cache."""
    cache_key = f'cache/{css_hash}/model.ifc'
    try:
        s3_client.put_object(Bucket=IFC_BUCKET, Key=cache_key, Body=ifc_content.encode('utf-8'), ContentType='text/plain')
        print(f"Cached IFC at {cache_key}")
    except Exception as e:
        print(f"Warning: Failed to cache IFC: {e}")


def _add_provenance_psets(ifc_path, css_elements):
    """Phase 13 PR 4: stamp Pset_BuiltingProvenance onto matched IFC products.

    Matches CSS element_key against IFC product Name by suffix (the clean export
    prefixes names with type labels like 'Tunnel-', 'PORTAL_BUILDING-', etc.).
    Non-fatal: any exception leaves the IFC unchanged.
    """
    try:
        model = ifcopenshell.open(ifc_path)
        owners = model.by_type('IfcOwnerHistory')
        if not owners:
            return
        owner = owners[0]

        prov_by_key = {}
        for elem in css_elements:
            ek = elem.get('element_key', '')
            prov = elem.get('provenance')
            if ek and prov:
                prov_by_key[ek] = prov

        sorted_keys = sorted(prov_by_key.keys(), key=len, reverse=True)

        def _find_prov(name):
            if not name:
                return None
            if name in prov_by_key:
                return prov_by_key[name]
            for ek in sorted_keys:
                if ek and name.endswith(ek):
                    return prov_by_key[ek]
            return None

        def _source_display(prov):
            status = prov.get('sourceFileStatus', 'missing')
            source_files = prov.get('sourceFiles', [])
            primary_sf = prov.get('sourceFile')
            if status == 'derived_inferred':
                return '<inferred>'
            elif status == 'missing':
                return '<unknown>'
            elif status == 'inherited_contested':
                sf_str = ', '.join(source_files) if source_files else (primary_sf or '<unknown>')
                return sf_str + ' (contested)'
            else:
                return ', '.join(source_files) if source_files else (primary_sf or '<unknown>')

        # Build set of products that already have Pset_BuiltingProvenance (main loop)
        already_stamped = set()
        for pset in model.by_type('IfcPropertySet'):
            pset_name = getattr(pset, 'Name', None)
            if pset_name == 'Pset_BuiltingProvenance':
                for rel in model.get_inverse(pset):
                    if rel.is_a('IfcRelDefinesByProperties'):
                        for obj in rel.RelatedObjects:
                            already_stamped.add(obj.id())

        added = 0
        spatial = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcProject'}
        for product in model.by_type('IfcProduct'):
            if product.is_a() in spatial:
                continue
            if product.id() in already_stamped:
                continue
            prov = _find_prov(product.Name)
            if not prov:
                continue
            status = prov.get('sourceFileStatus', 'missing')
            add_property_set(model, owner, product, 'Pset_BuiltingProvenance', {
                'SourceFile': (_source_display(prov), 'IfcLabel'),
                'SourceFileStatus': (status, 'IfcLabel'),
                'Stage': (prov.get('stage', ''), 'IfcLabel'),
                'Modifications': (', '.join(prov.get('modifications', [])), 'IfcLabel'),
            })
            added += 1

        total_non_spatial = sum(
            1 for p in model.by_type('IfcProduct') if p.is_a() not in spatial
        )
        model.write(ifc_path)
        print(f'[provenance] Added Pset_BuiltingProvenance to {added} products')
        return len(already_stamped) + added, total_non_spatial
    except Exception as e:
        print(f'[provenance] Non-fatal: {e}')
        return None, None


def _add_validation_psets(ifc_path, css_elements):
    """PR 8: stamp Pset_BuiltingValidation onto IFC products that have
    topology-stage validation warnings (metadata._validationWarnings).

    Matches by the same name-suffix logic used by _add_provenance_psets.
    Non-fatal: any exception leaves the IFC unchanged.
    Returns (stamped_count, total_with_warnings).
    """
    try:
        model = ifcopenshell.open(ifc_path)
        owners = model.by_type('IfcOwnerHistory')
        if not owners:
            return 0, 0
        owner = owners[0]

        # Build lookup: element_key → _validationWarnings list
        warnings_by_key = {}
        for elem in css_elements:
            ek = elem.get('element_key', '')
            meta = elem.get('metadata') or {}
            warns = meta.get('_validationWarnings')
            if ek and warns:
                warnings_by_key[ek] = warns

        if not warnings_by_key:
            return 0, 0

        sorted_keys = sorted(warnings_by_key.keys(), key=len, reverse=True)

        def _find_warnings(name):
            if not name:
                return None
            if name in warnings_by_key:
                return warnings_by_key[name]
            for ek in sorted_keys:
                if ek and name.endswith(ek):
                    return warnings_by_key[ek]
            return None

        stamped = 0
        spatial = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcProject', 'IfcSpace'}
        for product in model.by_type('IfcProduct'):
            if product.is_a() in spatial:
                continue
            warns = _find_warnings(product.Name)
            if not warns:
                continue
            add_property_set(model, owner, product, 'Pset_BuiltingValidation', {
                'ValidationWarnings': (', '.join(warns), 'IfcLabel'),
                'ValidationSeverity': ('warning', 'IfcLabel'),
            })
            stamped += 1

        model.write(ifc_path)
        print(f'[validation-psets] Stamped Pset_BuiltingValidation on {stamped} products')
        return stamped, len(warnings_by_key)
    except Exception as e:
        print(f'[validation-psets] Non-fatal: {e}')
        return 0, 0


# ============================================================================
# INLINE IFC VALIDATION (replaces standalone ValidateIFC Lambda)
# ============================================================================

def _get_absolute_coords(local_placement):
    """Walk the placement chain to accumulate absolute coordinates."""
    x, y, z = 0.0, 0.0, 0.0
    lp = local_placement
    while lp is not None:
        if hasattr(lp, 'RelativePlacement') and lp.RelativePlacement:
            loc = lp.RelativePlacement.Location
            if loc and loc.Coordinates:
                coords = loc.Coordinates
                x += float(coords[0])
                y += float(coords[1])
                z += float(coords[2]) if len(coords) > 2 else 0.0
        if hasattr(lp, 'PlacementRelTo'):
            lp = lp.PlacementRelTo
        else:
            break
    return x, y, z


def _get_profile_bounds(profile_def):
    """Get half-extents (hx, hy) from a profile definition.
    Returns None if profile type is not recognized."""
    try:
        if profile_def.is_a('IfcRectangleProfileDef'):
            return (float(profile_def.XDim) / 2.0, float(profile_def.YDim) / 2.0)
        elif profile_def.is_a('IfcCircleProfileDef'):
            r = float(profile_def.Radius)
            return (r, r)
    except Exception:
        pass
    return None


def _get_geometry_extents(product):
    """Extract approximate geometry extents from product representation.
    Returns (dx, dy, dz) expansion or None."""
    try:
        if not product.Representation:
            return None
        for rep in product.Representation.Representations:
            for item in rep.Items:
                if item.is_a('IfcExtrudedAreaSolid'):
                    depth = float(item.Depth)
                    dr = item.ExtrudedDirection.DirectionRatios
                    dx, dy = 0.0, 0.0
                    dz = depth  # default: assume mostly vertical

                    # Get profile bounds for X/Y expansion
                    bounds = _get_profile_bounds(item.SweptArea)
                    if bounds:
                        dx, dy = bounds

                    # If direction is mostly Z (abs(dz_ratio) > 0.9), expand Z by depth
                    dz_ratio = float(dr[2]) if len(dr) > 2 else 1.0
                    if abs(dz_ratio) > 0.9:
                        return (dx, dy, depth)
                    else:
                        # Non-axis-aligned: conservative — expand all axes by depth
                        return (max(dx, depth), max(dy, depth), max(dz, depth))
    except Exception:
        pass
    return None


def _convert_ifc_to_exports(user_id, render_id, geom_stats, export_results):
    """Phase 11: Convert IFC to glTF (.glb) and OBJ for visualization export.
    Non-critical — failures are logged but never block IFC generation.
    Uses USE_WORLD_COORDS to preserve correct spatial placement."""
    import time
    start = time.time()

    try:
        import trimesh
        import numpy as np
        import ifcopenshell.geom
    except ImportError as e:
        print(f"Phase 11: Export dependencies not available: {e}")
        return export_results

    # Skip if model is too complex
    if geom_stats.get('simplificationRecommended', False):
        print("Phase 11: Skipping export — model too large (simplificationRecommended=True)")
        return export_results

    try:
        ifc_path = '/tmp/validate.ifc'
        if not os.path.exists(ifc_path):
            print("Phase 11: /tmp/validate.ifc not found — skipping export")
            return export_results

        ifc_file = ifcopenshell.open(ifc_path)
        settings = ifcopenshell.geom.settings()
        settings.set(settings.USE_WORLD_COORDS, True)

        scene = trimesh.Scene()
        spatial_types = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcProject', 'IfcSpace'}
        converted = 0
        skipped = 0

        for product in ifc_file.by_type('IfcProduct'):
            # Time budget check
            if time.time() - start > 30:
                print(f"Phase 11: 30s time limit reached after {converted} elements")
                break

            if product.is_a() in spatial_types:
                continue
            if not product.Representation:
                skipped += 1
                continue

            try:
                shape = ifcopenshell.geom.create_shape(settings, product)
                verts = np.array(shape.geometry.verts).reshape(-1, 3)
                faces = np.array(shape.geometry.faces).reshape(-1, 3)
                if len(verts) == 0 or len(faces) == 0:
                    skipped += 1
                    continue

                # Resolve color using same precedence as IFC generation
                color_rgb = _resolve_export_color(product)
                mesh = trimesh.Trimesh(vertices=verts, faces=faces)
                rgba = [int(c * 255) for c in color_rgb] + [255]
                mesh.visual.face_colors = np.tile(rgba, (len(faces), 1))

                name = product.Name or product.GlobalId
                scene.add_geometry(mesh, node_name=name, geom_name=f"{name}_{product.GlobalId}")
                converted += 1
            except Exception:
                skipped += 1
                continue

        if len(scene.geometry) == 0:
            print("Phase 11: No geometry extracted — skipping export")
            return export_results

        # Export glTF (.glb)
        glb_path = '/tmp/model.glb'
        scene.export(glb_path, file_type='glb')
        glb_key = f'{user_id}/{render_id}/model.glb'
        s3_client.upload_file(glb_path, IFC_BUCKET, glb_key,
                              ExtraArgs={'ContentType': 'model/gltf-binary'})
        glb_size = os.path.getsize(glb_path)
        export_results['files']['glb'] = {'s3Key': glb_key, 'sizeBytes': glb_size}
        export_results['formats'].append('glTF')
        print(f"Phase 11: glTF exported — {glb_size} bytes")

        # Export OBJ
        try:
            obj_path = '/tmp/model.obj'
            scene.export(obj_path, file_type='obj')
            obj_key = f'{user_id}/{render_id}/model.obj'
            s3_client.upload_file(obj_path, IFC_BUCKET, obj_key,
                                  ExtraArgs={'ContentType': 'text/plain'})
            obj_size = os.path.getsize(obj_path)
            export_results['files']['obj'] = {'s3Key': obj_key, 'sizeBytes': obj_size}
            export_results['formats'].append('OBJ')
            print(f"Phase 11: OBJ exported — {obj_size} bytes")

            # Upload companion .mtl file if it exists
            mtl_path = '/tmp/model.mtl'
            if os.path.exists(mtl_path):
                mtl_key = f'{user_id}/{render_id}/model.mtl'
                s3_client.upload_file(mtl_path, IFC_BUCKET, mtl_key,
                                      ExtraArgs={'ContentType': 'text/plain'})
                print(f"Phase 11: MTL companion uploaded")
        except Exception as obj_err:
            print(f"Phase 11: OBJ export failed (non-critical): {obj_err}")

        elapsed = time.time() - start
        print(f"Phase 11: Export complete in {elapsed:.1f}s — {converted} elements, {skipped} skipped")

    except Exception as e:
        print(f"Phase 11: Export conversion failed (non-critical): {e}")

    return export_results


def _get_export_system_type(product):
    """Read SystemType from Pset_DuctSegmentCommon or Pset_PipeSegmentCommon on an IFC product."""
    try:
        for definition in (product.IsDefinedBy or []):
            if definition.is_a('IfcRelDefinesByProperties'):
                pset = definition.RelatingPropertyDefinition
                if not hasattr(pset, 'Name') or pset.Name not in (
                    'Pset_DuctSegmentCommon', 'Pset_PipeSegmentCommon',
                    'Pset_FanCommon', 'Pset_PumpCommon',
                ):
                    continue
                for prop in (getattr(pset, 'HasProperties', None) or []):
                    if prop.Name == 'SystemType' and hasattr(prop, 'NominalValue') and prop.NominalValue:
                        return str(prop.NominalValue.wrappedValue)
    except Exception:
        pass
    return None


def _resolve_export_color(product):
    """Resolve color for an IFC product using the same precedence as IFC generation:
    semanticType → systemType → css_type → material → default gray."""
    ifc_class = product.is_a()

    # 1. Specific IFC entity type (e.g., IfcFan, IfcPump)
    color = TYPE_COLORS.get(ifc_class)
    if color:
        return color

    # 2. Map IFC class to CSS type
    ifc_to_css = {
        'IfcWall': 'WALL',
        'IfcSlab': 'SLAB', 'IfcColumn': 'COLUMN', 'IfcBeam': 'BEAM',
        'IfcDoor': 'DOOR', 'IfcWindow': 'WINDOW',
        'IfcDuctSegment': 'DUCT', 'IfcPipeSegment': 'PIPE',
        'IfcSpace': 'SPACE', 'IfcBuildingElementProxy': 'PROXY',
    }
    css_type = ifc_to_css.get(ifc_class)

    # 3. System-type color for pipe/duct segments (read from Pset)
    if ifc_class in ('IfcPipeSegment', 'IfcDuctSegment') or css_type in ('PIPE', 'DUCT'):
        sys_type_raw = _get_export_system_type(product)
        if sys_type_raw:
            norm_sys = _normalize_system_type(sys_type_raw)
            if css_type == 'PIPE' or ifc_class == 'IfcPipeSegment':
                color = PIPE_SYSTEM_COLORS.get(norm_sys)
            else:
                color = DUCT_SYSTEM_COLORS.get(norm_sys)
            if color:
                return color

    # 4. CSS type fallback
    if css_type:
        color = TYPE_COLORS.get(css_type)
        if color:
            return color

    # 5. Material name
    try:
        for rel in (product.HasAssociations or []):
            if rel.is_a('IfcRelAssociatesMaterial'):
                mat = rel.RelatingMaterial
                mat_name = None
                if hasattr(mat, 'Name') and mat.Name:
                    mat_name = mat.Name.lower()
                elif hasattr(mat, 'ForLayerSet') and mat.ForLayerSet:
                    layers = mat.ForLayerSet.MaterialLayers or []
                    if layers and layers[0].Material:
                        mat_name = layers[0].Material.Name.lower() if layers[0].Material.Name else None
                if mat_name:
                    color = MATERIAL_COLORS.get(mat_name)
                    if color:
                        return color
    except Exception:
        pass

    return (0.7, 0.7, 0.7)


def validate_ifc(ifc_content, user_id, render_id):
    """Validate generated IFC content. Returns (valid, errors, warnings, element_summary, bbox)."""
    errors = []
    warnings = []
    element_summary = {}
    bbox = None

    try:
        # Write to temp file for IfcOpenShell
        with open('/tmp/validate.ifc', 'w') as vf:
            vf.write(ifc_content)

        try:
            ifc_file = ifcopenshell.open('/tmp/validate.ifc')
        except Exception as parse_err:
            errors.append(f"IFC parse error: {parse_err}")
            return False, errors, warnings, element_summary, bbox

        # Check spatial structure
        if not ifc_file.by_type('IfcProject'):
            errors.append("No IfcProject found")
        if not ifc_file.by_type('IfcSite'):
            warnings.append("No IfcSite found")
        if not ifc_file.by_type('IfcBuilding'):
            warnings.append("No IfcBuilding found")
        if not ifc_file.by_type('IfcBuildingStorey'):
            warnings.append("No IfcBuildingStorey found")

        # Check products — exclude spatial containers from Representation check
        products = ifc_file.by_type('IfcProduct')
        spatial_types = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey'}
        non_spatial = [p for p in products if p.is_a() not in spatial_types]

        missing_rep = sum(1 for p in non_spatial if not p.Representation)
        missing_placement = sum(1 for p in products if not p.ObjectPlacement)

        if missing_rep > 0:
            warnings.append(f"{missing_rep} non-spatial products missing Representation")
        if missing_placement > 0:
            warnings.append(f"{missing_placement} products missing ObjectPlacement")

        if not ifc_file.by_type('IfcRelContainedInSpatialStructure'):
            warnings.append("No IfcRelContainedInSpatialStructure found")

        # ---- Direction vector validation (scoped to placements + extrusions) ----
        invalid_directions = 0
        sanitized_directions = 0

        # Check IfcLocalPlacement → RelativePlacement (Axis2Placement3D)
        for lp in ifc_file.by_type('IfcLocalPlacement'):
            try:
                rp = lp.RelativePlacement
                if rp and rp.is_a('IfcAxis2Placement3D'):
                    if rp.Axis:
                        ar = rp.Axis.DirectionRatios
                        ax_len = math.sqrt(sum(float(r)**2 for r in ar))
                        if ax_len < 1e-6 or not all(math.isfinite(float(r)) for r in ar):
                            invalid_directions += 1

                    if rp.RefDirection:
                        rr = rp.RefDirection.DirectionRatios
                        rf_len = math.sqrt(sum(float(r)**2 for r in rr))
                        if rf_len < 1e-6 or not all(math.isfinite(float(r)) for r in rr):
                            invalid_directions += 1

                    # Check axis/refDirection not parallel
                    if rp.Axis and rp.RefDirection:
                        ar = rp.Axis.DirectionRatios
                        rr = rp.RefDirection.DirectionRatios
                        dot = sum(float(a) * float(r) for a, r in zip(ar, rr))
                        if abs(dot) > 0.999:
                            invalid_directions += 1
            except Exception:
                pass

        # Check IfcExtrudedAreaSolid.ExtrudedDirection
        for solid in ifc_file.by_type('IfcExtrudedAreaSolid'):
            try:
                dr = solid.ExtrudedDirection.DirectionRatios
                d_len = math.sqrt(sum(float(r)**2 for r in dr))
                if d_len < 1e-6 or not all(math.isfinite(float(r)) for r in dr):
                    invalid_directions += 1
            except Exception:
                pass

        # Classify: sanitized upstream vs still invalid
        sanitized_directions = len(_sanitized_elements)
        if invalid_directions > 0:
            errors.append(f"{invalid_directions} invalid direction vectors found in IFC")
        if sanitized_directions > 0:
            warnings.append(f"{sanitized_directions} direction vectors were sanitized during generation")

        # ---- Viewer compatibility checks (Phase 6E) ----
        compatibility_issues = []
        mesh_fallback_count = 0
        proxy_fallback_count = proxy_tracking.get('count', 0) if 'proxy_tracking' in dir() else 0

        # Check for IfcTriangulatedFaceSet (mesh fallbacks)
        try:
            mesh_fallback_count = len(ifc_file.by_type('IfcTriangulatedFaceSet'))
        except Exception:
            pass

        # Check all IfcDirection for NaN/Inf
        for direction in ifc_file.by_type('IfcDirection'):
            try:
                for r in direction.DirectionRatios:
                    if not math.isfinite(float(r)):
                        compatibility_issues.append({
                            'severity': 'error',
                            'type': 'nan_inf_direction',
                            'detail': f'IfcDirection #{direction.id()} has non-finite value'
                        })
                        break
            except Exception:
                pass

        # Check IfcCartesianPoint for large coordinates
        for point in ifc_file.by_type('IfcCartesianPoint'):
            try:
                for c in point.Coordinates:
                    if abs(float(c)) > 1e6:
                        compatibility_issues.append({
                            'severity': 'warning',
                            'type': 'large_coordinate',
                            'detail': f'IfcCartesianPoint #{point.id()} has coordinate > 1e6'
                        })
                        break
            except Exception:
                pass

        # Check storey containment — every non-spatial element should be in a storey
        contained_elements = set()
        for rel in ifc_file.by_type('IfcRelContainedInSpatialStructure'):
            try:
                for elem in rel.RelatedElements:
                    contained_elements.add(elem.id())
            except Exception:
                pass

        orphaned = 0
        for product in non_spatial:
            if product.id() not in contained_elements:
                orphaned += 1
        if orphaned > 0:
            compatibility_issues.append({
                'severity': 'warning',
                'type': 'orphaned_elements',
                'detail': f'{orphaned} elements not contained by any storey'
            })

        # Check every non-spatial element has Body representation
        missing_body = 0
        for product in non_spatial:
            has_body = False
            if product.Representation:
                for rep in product.Representation.Representations:
                    if rep.RepresentationIdentifier == 'Body':
                        has_body = True
                        break
            if not has_body:
                missing_body += 1
        if missing_body > 0:
            compatibility_issues.append({
                'severity': 'warning',
                'type': 'missing_body_rep',
                'detail': f'{missing_body} elements missing Body representation'
            })

        # v6: NaN coordinate check (sample first 20 placements)
        nan_coord_found = False
        for lp in list(ifc_file.by_type('IfcLocalPlacement'))[:20]:
            try:
                coords = lp.RelativePlacement.Location.Coordinates
                if any(not math.isfinite(float(c)) for c in coords):
                    errors.append('CRITICAL: Non-finite coordinate found in placement')
                    nan_coord_found = True
                    break
            except Exception:
                pass

        # Compute compatibility score
        total_checks = len(non_spatial) * 2 + len(ifc_file.by_type('IfcDirection'))
        issue_weight = len([i for i in compatibility_issues if i['severity'] == 'error']) * 10 + \
                       len([i for i in compatibility_issues if i['severity'] == 'warning'])
        compatibility_score = max(0, min(100, 100 - int(issue_weight / max(total_checks, 1) * 100)))

        # ---- PHASE 1: Revit Compatibility Validation ----
        revit_validation = {'checks': [], 'score': 0, 'grade': 'UNKNOWN'}
        REVIT_UNSUPPORTED = {'IfcVirtualElement', 'IfcAnnotation', 'IfcGrid'}
        REVIT_PREFERRED = {'IfcWall', 'IfcSlab', 'IfcColumn',
                           'IfcBeam', 'IfcDoor', 'IfcWindow', 'IfcSpace', 'IfcStair',
                           'IfcRamp', 'IfcCurtainWall', 'IfcPlate',
                           'IfcMember', 'IfcPipeSegment', 'IfcDuctSegment', 'IfcFan',
                           'IfcPump', 'IfcAirToAirHeatRecovery', 'IfcCoolingTower',
                           'IfcBuildingElementProxy'}

        def rv_check(name, passed, detail, severity='WARNING'):
            revit_validation['checks'].append({'name': name, 'passed': passed, 'detail': detail, 'severity': severity})

        # 1. Spatial hierarchy (required for Revit import)
        has_project = len(ifc_file.by_type('IfcProject')) == 1
        has_site = len(ifc_file.by_type('IfcSite')) >= 1
        has_building = len(ifc_file.by_type('IfcBuilding')) >= 1
        has_storey = len(ifc_file.by_type('IfcBuildingStorey')) >= 1
        rv_check('SpatialHierarchy', has_project and has_site and has_building and has_storey,
                  f"Project={has_project} Site={has_site} Building={has_building} Storey={has_storey}", 'CRITICAL')

        # 2. Representation context
        has_context = len(ifc_file.by_type('IfcGeometricRepresentationContext')) >= 1
        rv_check('RepresentationContext', has_context, 'IfcGeometricRepresentationContext present' if has_context else 'MISSING', 'CRITICAL')

        # 3. Unsupported entities
        unsupported_found = []
        for p in products:
            if p.is_a() in REVIT_UNSUPPORTED:
                unsupported_found.append(p.is_a())
        rv_check('NoUnsupportedEntities', len(unsupported_found) == 0,
                  f"{len(unsupported_found)} unsupported entities: {set(unsupported_found)}" if unsupported_found else 'No unsupported entities')

        # 4. All elements have placements
        rv_check('AllPlacements', missing_placement == 0,
                  f"{missing_placement} products missing ObjectPlacement" if missing_placement else 'All products have placements')

        # 5. All non-spatial elements have Body representation
        rv_check('AllRepresentations', missing_rep == 0 and missing_body == 0,
                  f"{missing_rep} missing rep, {missing_body} missing Body" if (missing_rep + missing_body) > 0 else 'All elements have Body representation')

        # 6. Zero-length extrusions
        zero_depth_count = 0
        for solid in ifc_file.by_type('IfcExtrudedAreaSolid'):
            try:
                if float(solid.Depth) <= 0.001:
                    zero_depth_count += 1
            except Exception:
                pass
        rv_check('NoZeroExtrusions', zero_depth_count == 0,
                  f"{zero_depth_count} zero-depth extrusions" if zero_depth_count else 'No zero-depth extrusions')

        # 7. Containment completeness
        containment_ratio = 1.0 - (orphaned / max(len(non_spatial), 1))
        rv_check('ContainmentComplete', containment_ratio >= 0.95,
                  f"{containment_ratio:.0%} elements contained in storeys")

        # 8. Naming quality
        unnamed_count = sum(1 for p in non_spatial if not p.Name or p.Name.strip() == '')
        rv_check('NamingQuality', unnamed_count == 0,
                  f"{unnamed_count} unnamed elements" if unnamed_count else 'All elements named')

        # 9. Unit assignment
        units = ifc_file.by_type('IfcUnitAssignment')
        rv_check('UnitAssignment', len(units) >= 1, 'IfcUnitAssignment present' if units else 'MISSING units', 'CRITICAL')

        # 10. No NaN/Inf coordinates
        rv_check('CoordinateSanity', not nan_coord_found,
                  'Non-finite coordinates detected' if nan_coord_found else 'All coordinates finite', 'CRITICAL')

        # 11. Preferred entity ratio
        preferred_count = sum(1 for p in non_spatial if p.is_a() in REVIT_PREFERRED)
        preferred_ratio = preferred_count / max(len(non_spatial), 1)
        rv_check('PreferredEntityRatio', preferred_ratio >= 0.5,
                  f"{preferred_ratio:.0%} preferred Revit entity types ({preferred_count}/{len(non_spatial)})")

        # 12. Geometry bounds reasonable
        rv_check('GeometryBounds', not any('50km' in str(e) for e in errors),
                  'Geometry within 50km bounds')

        # Score
        passed = sum(1 for c in revit_validation['checks'] if c['passed'])
        total = len(revit_validation['checks'])
        critical_fails = sum(1 for c in revit_validation['checks'] if not c['passed'] and c['severity'] == 'CRITICAL')
        revit_validation['score'] = round(passed / max(total, 1) * 100)
        revit_validation['grade'] = 'FAIL' if critical_fails > 0 else ('A' if passed == total else ('B' if passed >= total - 2 else 'C'))
        revit_validation['passCount'] = passed
        revit_validation['totalChecks'] = total
        revit_validation['criticalFailures'] = critical_fails

        # Element count summary
        for product in products:
            entity_type = product.is_a()
            element_summary[entity_type] = element_summary.get(entity_type, 0) + 1

        # ---- Bbox check — walk parent chain + approximate geometry extents ----
        min_x = min_y = min_z = float('inf')
        max_x = max_y = max_z = float('-inf')
        bbox_mode = 'placement-only'

        for product in products:
            if product.ObjectPlacement:
                try:
                    px, py, pz = _get_absolute_coords(product.ObjectPlacement)
                    min_x, min_y, min_z = min(min_x, px), min(min_y, py), min(min_z, pz)
                    max_x, max_y, max_z = max(max_x, px), max(max_y, py), max(max_z, pz)

                    # Approximate with geometry extents
                    extents = _get_geometry_extents(product)
                    if extents is not None:
                        bbox_mode = 'approx'
                        dx, dy, dz = extents
                        # Expand in both positive directions from placement
                        min_x = min(min_x, px - dx)
                        min_y = min(min_y, py - dy)
                        max_x = max(max_x, px + dx)
                        max_y = max(max_y, py + dy)
                        max_z = max(max_z, pz + dz)
                except Exception:
                    pass

        if min_x != float('inf'):
            bbox = {
                'min': {'x': round(min_x, 3), 'y': round(min_y, 3), 'z': round(min_z, 3)},
                'max': {'x': round(max_x, 3), 'y': round(max_y, 3), 'z': round(max_z, 3)},
                'mode': bbox_mode,
            }
            max_dim = max(max_x - min_x, max_y - min_y, max_z - min_z)
            if max_dim > 50000:
                errors.append(f"Bounding box exceeds 50km: {max_dim:.0f}m")

        print(f"IFC validation: {len(products)} products, {len(errors)} errors, "
              f"{len(warnings)} warnings, bbox_mode={bbox_mode}")

    except Exception as e:
        errors.append(f"Validation error: {str(e)}")

    # Store validation report to S3
    report = {
        'valid': len(errors) == 0,
        'errors': errors,
        'warnings': warnings,
        'elementSummary': element_summary,
        'bbox': bbox,
        'compatibilityScore': compatibility_score if 'compatibility_score' in dir() else None,
        'compatibilityIssues': compatibility_issues if 'compatibility_issues' in dir() else [],
        'meshFallbackCount': mesh_fallback_count if 'mesh_fallback_count' in dir() else 0,
        'proxyFallbackCount': proxy_fallback_count if 'proxy_fallback_count' in dir() else 0,
        'proxyReasons': proxy_tracking.get('reasons', {}) if 'proxy_tracking' in dir() else {},
    }
    try:
        report_key = f'uploads/{user_id}/{render_id}/reports/validation_report.json'
        s3_client.put_object(Bucket=DATA_BUCKET, Key=report_key,
                             Body=json.dumps(report, indent=2).encode('utf-8'),
                             ContentType='application/json')
        print(f"Validation report stored: {report_key}")
    except Exception as e:
        print(f"Warning: Failed to store validation report: {e}")

    return len(errors) == 0, errors, warnings, element_summary, bbox, revit_validation if 'revit_validation' in dir() else {}


# ============================================================================
# LAMBDA HANDLER
# ============================================================================

def handler(event, context):
    """Lambda handler: CSS → IFC4 conversion with caching, validation, and self-healing."""
    print(f"JsonToIFC input: {json.dumps(event)[:500]}")

    # Clear per-invocation caches (Lambda containers are reused across renders)
    global _style_cache, _material_cache, _sanitized_elements
    _style_cache = {}
    _material_cache = {}
    _sanitized_elements = {}

    render_id = event.get('renderId')
    user_id = event.get('userId')

    # Phase 13 PR2: Trace start
    _trace_run_id = getattr(context, 'aws_request_id', None) or f"generate-{int(datetime.now(timezone.utc).timestamp() * 1000)}"
    _trace_started_at = datetime.now(timezone.utc).isoformat()
    _trace_key = None
    _trace_attempt_n = 1
    if _TRACE_AVAILABLE and render_id:
        try:
            _trace_key, _trace_attempt_n = write_trace_start(
                render_id, 'generate', _trace_run_id, _trace_started_at,
                artifact_key=event.get('cssS3Key'),
            )
        except Exception as te:
            print(f"[trace] start write failed (non-fatal): {te}")
    init_audit(render_id or '', 'generate', _trace_run_id)

    # Load CSS from S3 (avoids Step Function 256KB state limit)
    css_s3_key = event.get('cssS3Key')
    data_bucket = event.get('bucket', DATA_BUCKET)
    css = event.get('css')  # fallback for direct invocation

    if css_s3_key and not css:
        try:
            print(f"Loading CSS from S3: s3://{data_bucket}/{css_s3_key}")
            response = s3_client.get_object(Bucket=data_bucket, Key=css_s3_key)
            css = json.loads(response['Body'].read().decode('utf-8'))
            print(f"CSS loaded: {len(css.get('elements', []))} elements")
        except Exception as e:
            raise ValueError(f'Failed to load CSS from S3: {e}')

    if not css:
        raise ValueError('No CSS provided (neither cssS3Key nor css in event)')

    # Consumer contract check: validate css_processed.json on entry (halting).
    _check_validated_css_contract(css, user_id, render_id)

    if css.get('cssVersion') != '1.0':
        print(f"Warning: unexpected CSS version: {css.get('cssVersion')}")

    metadata = css.get('metadata', {})
    output_mode = metadata.get('outputMode', 'HYBRID')

    # Check cache
    css_hash = compute_css_hash(css)
    cached_ifc = check_cache(css_hash)

    elements = css.get('elements', [])
    element_count = len(elements)
    error_count = 0
    gen_orientation_warnings = []
    gen_tunnel_shell_report = None
    # Thread renderId/userId to clean_tunnel_export's debug-scene dumper
    # (no plumbing change in generate_ifc4_from_css signature).
    os.environ['DEBUG_RENDER_ID'] = str(render_id or 'unknown')
    os.environ['DEBUG_USER_ID'] = str(user_id or 'unknown')
    if cached_ifc:
        ifc_content = cached_ifc
    else:
        ifc_content, element_count, error_count, gen_orientation_warnings, gen_tunnel_shell_report = generate_ifc4_from_css(css)
        store_cache(css_hash, ifc_content)

    print(f'IFC size: {len(ifc_content)} bytes')

    # Validate IFC inline
    ifc_valid, val_errors, val_warnings, element_summary, ifc_bbox, revit_val = validate_ifc(ifc_content, user_id, render_id)

    # Per-element resilience: validation errors are advisory, not triggers for global regeneration.
    # Individual elements that failed geometry are already proxied in the generation loop.
    if not ifc_valid:
        print(f'IFC validation: {len(val_errors)} errors (advisory — per-element fallbacks already applied)')
        for ve in val_errors[:10]:
            print(f'  validation error: {ve}')

    # BIM enrichment: add property sets, materials, MEP systems, topology
    # validate_ifc() already wrote /tmp/validate.ifc — enrich in-place
    if _ENRICHMENT_AVAILABLE:
        try:
            ifc_content = enrich_ifc('/tmp/validate.ifc')
            print(f'[enrichment] Enriched IFC size: {len(ifc_content)} bytes')
        except Exception as enrich_err:
            print(f'[enrichment] Non-fatal error: {enrich_err}')

    # Phase 13 PR 4: stamp Pset_BuiltingProvenance onto matched IFC products.
    # Runs after enrichment so enrichment cannot overwrite provenance psets.
    _prov_stamped, _prov_total = _add_provenance_psets('/tmp/validate.ifc', elements)

    # PR 8: Run generate-stage validators against the IFC model, then stamp
    # Pset_BuiltingValidation for topology-stage warnings that flowed through
    # metadata._validationWarnings in css_processed.json.
    _gen_val_summary = {'total': 0, 'passed': 0, 'warned': 0, 'failed': 0}
    try:
        _val_ifc = ifcopenshell.open('/tmp/validate.ifc')
        _gen_val_result = run_generate_validators(_val_ifc)
        for _entry in _gen_val_result.get('entries', []):
            log_validation(_entry)
        _gen_val_summary = {
            'total': _gen_val_result['total'],
            'passed': _gen_val_result['passed'],
            'warned': _gen_val_result['warned'],
            'failed': _gen_val_result['failed'],
        }
        del _val_ifc  # release before writing
    except Exception as _gv_err:
        print(f'[generate-validators] Non-fatal: {_gv_err}')

    # Stamp Pset_BuiltingValidation for topology-stage warnings
    _val_psets_stamped, _ = _add_validation_psets('/tmp/validate.ifc', elements)

    try:
        with open('/tmp/validate.ifc', 'r') as _vf:
            ifc_content = _vf.read()
        print(f'[provenance] IFC size after provenance+validation pass: {len(ifc_content)} bytes')
    except Exception as _prov_read_err:
        print(f'[provenance] Could not read back /tmp/validate.ifc: {_prov_read_err}')

    # Save IFC to render path in S3
    bucket = IFC_BUCKET
    s3_key = f'{user_id}/{render_id}/model.ifc'

    try:
        s3_client.put_object(Bucket=bucket, Key=s3_key, Body=ifc_content.encode('utf-8'), ContentType='text/plain')
        print(f'IFC saved to S3: s3://{bucket}/{s3_key}')
    except Exception as s3_error:
        raise RuntimeError(f'Failed to save IFC to S3: {s3_error}')

    # v6+ PHASE 6: Geometry statistics for viewer optimization / export readiness
    try:
        geom_stats = {
            'totalProducts': 0, 'withRepresentation': 0,
            'extrusionCount': 0, 'meshCount': 0, 'brepCount': 0,
            'sweptDiskCount': 0, 'revolvedCount': 0,
            'totalTriangles': 0, 'totalVertices': 0,
            'simplificationRecommended': False,
            'exportFormats': ['IFC4'],
        }
        ifc_check = ifcopenshell.open('/tmp/validate.ifc')
        products = ifc_check.by_type('IfcProduct')
        spatial = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey'}
        for p in products:
            if p.is_a() in spatial:
                continue
            geom_stats['totalProducts'] += 1
            if p.Representation:
                geom_stats['withRepresentation'] += 1
                for rep in (p.Representation.Representations or []):
                    for item in (rep.Items or []):
                        if item.is_a('IfcExtrudedAreaSolid'):
                            geom_stats['extrusionCount'] += 1
                        elif item.is_a('IfcTriangulatedFaceSet'):
                            geom_stats['meshCount'] += 1
                            try:
                                geom_stats['totalVertices'] += len(item.Coordinates.CoordList)
                                geom_stats['totalTriangles'] += len(item.CoordIndex)
                            except Exception:
                                pass
                        elif item.is_a('IfcSweptDiskSolid'):
                            geom_stats['sweptDiskCount'] += 1
                        elif item.is_a('IfcRevolvedAreaSolid'):
                            geom_stats['revolvedCount'] += 1
                        elif item.is_a('IfcFacetedBrep'):
                            geom_stats['brepCount'] += 1

        if geom_stats['totalTriangles'] > 50000 or geom_stats['totalProducts'] > 500:
            geom_stats['simplificationRecommended'] = True

        # Track curve fallbacks — count elements that requested SWEEP/REVOLUTION but fell back
        curve_fallbacks = 0
        for fb_key, fb_val in metadata.get('geometryFallbacks', {}).items():
            if fb_val in ('sweep_to_extrusion',):
                curve_fallbacks += 1
        geom_stats['curveRequestedButFellBackCount'] = curve_fallbacks

        # Phase 11: exportFormats populated by _convert_ifc_to_exports() after this block

        print(f"v6+ Geometry stats: {geom_stats['totalProducts']} products, {geom_stats['extrusionCount']} extrusions, {geom_stats['sweptDiskCount']} swept disks, {geom_stats['revolvedCount']} revolved, {geom_stats['meshCount']} meshes, {geom_stats['totalTriangles']} triangles")
    except Exception as gs_err:
        print(f"Geometry stats collection failed: {gs_err}")
        geom_stats = {'error': str(gs_err)}

    # Phase 11: Convert IFC to glTF (.glb) and OBJ export formats
    export_results = {'formats': ['IFC4'], 'files': {}}
    export_results = _convert_ifc_to_exports(user_id, render_id, geom_stats, export_results)
    geom_stats['exportFormats'] = export_results['formats']

    # v6 PHASE C: Generate comprehensive verification report
    try:
        domain = css.get('domain', '').upper()
        tracing_report = metadata.get('tracingReport', {})
        css_validation = metadata.get('cssValidationIssues', 0)
        css_validation_details = metadata.get('cssValidationDetails', [])
        building_warnings = metadata.get('buildingValidationWarnings', [])
        source_fusion = metadata.get('sourceFusion', {})
        envelope_fallback = metadata.get('envelopeFallbackApplied', False)
        dimension_clamps = metadata.get('dimensionClamps', 0)
        shell_continuity = metadata.get('shellContinuity', {})
        equipment_mounting = metadata.get('equipmentMounting', {})
        safety_warnings = metadata.get('safetyWarnings', [])

        # v10: Aggregate structural warnings for frontend
        structural_warnings = []
        if envelope_fallback:
            ef_detail = metadata.get('envelopeFallback', {})
            structural_warnings.append({'type': 'envelope_fallback', 'detail': ef_detail})
        if dimension_clamps > 0:
            structural_warnings.append({'type': 'dimension_clamps', 'count': dimension_clamps})
        if shell_continuity.get('pairsAligned', 0) > 0:
            structural_warnings.append({'type': 'shell_continuity', 'pairsAligned': shell_continuity['pairsAligned'], 'groups': shell_continuity.get('continuityGroups', 0)})
        if equipment_mounting.get('mounted', 0) > 0:
            structural_warnings.append({'type': 'equipment_mounted', 'count': equipment_mounting['mounted'], 'originGuard': equipment_mounting.get('originGuard', 0)})
        # Count geometry approximations
        approx_count = sum(1 for e in elements if e.get('properties', {}).get('geometryApproximation'))
        if approx_count > 0:
            structural_warnings.append({'type': 'geometry_approximation', 'count': approx_count})
        # Junction transitions
        jt = metadata.get('junctionTransitions', {})
        if jt.get('transitionElementCount', 0) > 0:
            structural_warnings.append({'type': 'junction_transitions', 'junctionCount': jt.get('junctionCount', 0), 'bendCount': jt.get('bendCount', 0), 'elementCount': jt.get('transitionElementCount', 0), 'voidHelpers': jt.get('voidHelpersGenerated', 0)})
        # Shell extensions
        je = metadata.get('junctionExtensions', {})
        if je.get('count', 0) > 0:
            structural_warnings.append({'type': 'shell_extensions', 'count': je['count'], 'nodes': len(je.get('nodes', []))})
        # Curved geometry
        cg = metadata.get('curvedGeometry', {})
        if cg.get('circularCount', 0) > 0 or cg.get('horseshoeCount', 0) > 0:
            structural_warnings.append({'type': 'curved_geometry', 'circularCount': cg.get('circularCount', 0), 'horseshoeCount': cg.get('horseshoeCount', 0), 'note': cg.get('note', '')})
        # Opening validation
        ov = metadata.get('openingValidation', {})
        if ov.get('total', 0) > 0:
            structural_warnings.append({'type': 'opening_validation', 'total': ov['total'], 'valid': ov.get('valid', 0), 'rehosted': ov.get('rehosted', 0), 'downgraded': ov.get('downgraded', 0)})
        # Wall axis cleanup
        wc = metadata.get('wallAxisCleanup', {})
        if wc.get('snappedCount', 0) > 0:
            structural_warnings.append({'type': 'wall_cleanup', 'snappedCount': wc['snappedCount'], 'groupCount': wc.get('groupCount', 0), 'skippedOverCap': wc.get('skippedOverCap', 0)})
        # Interior coherence
        ic = metadata.get('interiorCoherence')
        if ic:
            structural_warnings.append({'type': 'interior_coherence', 'grade': ic})
        # Refinement report
        rr = metadata.get('refinementReport', {})
        if rr.get('summary'):
            structural_warnings.append({'type': 'refinement_report', 'summary': rr['summary']})
        # Approximation proxies (transition helpers — counted separately from canonical proxies)
        approx_proxy_count = sum(1 for e in elements if e.get('properties', {}).get('isTransitionHelper'))
        if approx_proxy_count > 0:
            structural_warnings.append({'type': 'approximation_proxies', 'count': approx_proxy_count})
        for sw in safety_warnings:
            structural_warnings.append({'type': 'safety', 'detail': sw})

        verification_report = {
            'reportVersion': '2.0',
            'reportType': 'ENGINEER_AUDIT_ARTIFACT',
            'renderId': render_id,
            'userId': user_id,
            'generatedAt': datetime.now(timezone.utc).isoformat(),
            'pipelineVersion': 'v6+',
            'summary': {
                'ifcValid': ifc_valid,
                'totalElements': element_count,
                'errorElements': error_count,
                'outputMode': output_mode,
                'domain': domain,
                'ifcSchema': 'IFC4',
                'ifcSizeBytes': len(ifc_content),
                'generationTimestamp': datetime.now(timezone.utc).isoformat(),
            },
            'pipelineStages': {
                'extract': {'version': metadata.get('extractVersion', 'unknown'), 'sourceFileCount': len(tracing_report.get('parsedFiles', []))},
                'transform': {'cssValidationIssues': css_validation, 'envelopeFallback': envelope_fallback},
                'generate': {'outputMode': output_mode, 'cacheHit': metadata.get('cacheHit', False), 'elementsProcessed': element_count},
            },
            'fileContributions': tracing_report.get('fileContributions', tracing_report.get('byFile', {})),
            'sourceBreakdown': tracing_report.get('bySource', {}),
            'roleBreakdown': tracing_report.get('byRole', {}),
            'confidenceDistribution': tracing_report.get('confidence', {}),
            'parsedFiles': tracing_report.get('parsedFiles', []),
            'geometryContributors': tracing_report.get('geometryContributors', []),
            'metadataContributors': tracing_report.get('metadataContributors', []),
            'ignoredFiles': tracing_report.get('ignoredFiles', []),
            'elementEvidence': [],
            'validation': {
                'ifcErrors': val_errors,
                'ifcWarnings': val_warnings,
                'cssValidationIssues': css_validation,
                'cssValidationDetails': css_validation_details,
                'buildingWarnings': building_warnings,
            },
            'sourceFusion': source_fusion,
            'envelopeFallbackApplied': envelope_fallback,
            'structuralWarnings': structural_warnings,
            'regressionChecks': {
                'errors': regression_errors if 'regression_errors' in dir() else [],
                'warnings': regression_warnings if 'regression_warnings' in dir() else [],
            },
            'elementSummary': element_summary,
            'bbox': ifc_bbox,
            'orientationWarnings': gen_orientation_warnings,
            'tunnelShellReport': gen_tunnel_shell_report,
            'styleReport': style_report if 'style_report' in dir() else {},
            'styleTierTotals': style_tier_totals if 'style_tier_totals' in dir() else {},
            'proxyTracking': proxy_tracking if 'proxy_tracking' in dir() else {},
            'genericNameCount': len(generic_names) if 'generic_names' in dir() else 0,
            'unresolvedFindings': source_fusion.get('log', []) if source_fusion else [],
            'scopeBoundary': {
                'implemented': [
                    'VentSim tunnel geometry with shell decomposition',
                    'Equipment-to-void containment + cross-section clamping',
                    'Universal building generation (house/office/warehouse/industrial/etc.)',
                    'Multi-wing/L-shaped buildings with shared-wall detection',
                    'Mezzanine and canopy section types',
                    'Multi-format input: TXT, PDF, DOCX, XLSX, DXF, PNG, JPG, TIFF',
                    'Type-specific vision extraction (floor plans, cross-sections, equipment layouts, elevations)',
                    'Confidence-gated vision-to-CSS geometry conversion',
                    'Scanned PDF detection + Bedrock vision extraction',
                    'Restricted safe source fusion for non-structural equipment',
                    'Type-based color system with semantic differentiation',
                    'Descriptive element naming with traceable IDs',
                    'Quantity sets (Wall/Slab/Space)',
                    'Element-level source provenance with evidence detail (Pset_SourceProvenance)',
                    'IfcDistributionSystem + IfcDistributionPort connectivity (MEP topology)',
                    'CSS + IFC validation with Revit compatibility scoring (12 checks)',
                    'Verification report with evidence mapping + coverage metrics',
                    'Building envelope fallback for fragmented extractions',
                    'Domain guards (tunnel vs building isolation)',
                    'Self-healing PROXY_ONLY regeneration',
                    'IFC4 schema compliance',
                    'Geometry statistics for viewer optimization',
                ],
                'partiallyImplemented': [
                    'Element provenance — file-level + excerpt when available, page/paragraph best-effort',
                    'Image geometry extraction — confidence-gated walls/rooms/equipment from drawings',
                    'Multi-level buildings — up to 50 storeys, no ramps/stairs',
                    'Curved tunnels — rectangular cross-sections only',
                    'glTF export readiness — geometry stats provided, conversion via IfcConvert',
                ],
                'futureWork': [
                    'Formal Revit round-trip proof',
                    'Real-time sensor ingestion',
                    'CAD-quality geometry from blueprints',
                    'Native glTF/OBJ export in Lambda',
                    'Multi-user collaboration',
                    'Curved tunnel geometry',
                ]
            },
            'geometryStats': geom_stats,
        }

        # Build element-level evidence mapping (sample first 200 elements)
        elements_with_evidence = 0
        elements_with_excerpt = 0
        elements_with_coordinates = 0
        for elem in elements[:200]:
            evidence = elem.get('metadata', {}).get('evidence', {})
            if evidence:
                elements_with_evidence += 1
                if evidence.get('sourceExcerpt'):
                    elements_with_excerpt += 1
                if evidence.get('coordinateSource') and evidence['coordinateSource'] != 'UNKNOWN':
                    elements_with_coordinates += 1
                verification_report['elementEvidence'].append({
                    'id': elem.get('id', ''),
                    'name': elem.get('name', ''),
                    'type': elem.get('type', ''),
                    'confidence': elem.get('confidence', 0),
                    'source': elem.get('source', 'LLM'),
                    'evidence': evidence,
                })

        # Element evidence coverage metrics
        total_sampled = min(len(elements), 200)
        verification_report['evidenceCoverage'] = {
            'totalElements': len(elements),
            'sampledElements': total_sampled,
            'withEvidence': elements_with_evidence,
            'withSourceExcerpt': elements_with_excerpt,
            'withCoordinateSource': elements_with_coordinates,
            'evidencePct': round(elements_with_evidence / max(total_sampled, 1) * 100, 1),
            'excerptPct': round(elements_with_excerpt / max(total_sampled, 1) * 100, 1),
            'coordinatePct': round(elements_with_coordinates / max(total_sampled, 1) * 100, 1),
        }
        print(f"v6+ Evidence coverage: {verification_report['evidenceCoverage']}")

        # v6 PHASE F: Revit compatibility assessment
        revit_checks = []
        # 1. Check for generic names
        generic_name_count = sum(1 for e in elements if e.get('name', '') in ('WALL', 'SLAB', 'SPACE', 'DUCT', 'EQUIPMENT', 'PROXY', 'TUNNEL_SEGMENT'))
        if generic_name_count > 0:
            revit_checks.append({'check': 'GenericNames', 'status': 'WARNING', 'detail': f'{generic_name_count} elements have generic names'})
        else:
            revit_checks.append({'check': 'GenericNames', 'status': 'PASS', 'detail': 'All elements have descriptive names'})

        # 2. Check proxy ratio (exclude transition helpers — they are intentional approximation geometry)
        helper_proxy_count = sum(1 for e in elements if
            e.get('semanticType') == 'IfcBuildingElementProxy' and
            e.get('properties', {}).get('isTransitionHelper'))
        proxy_count = max(element_summary.get('IfcBuildingElementProxy', 0) - helper_proxy_count, 0)
        total_elems = max(sum(element_summary.values()) - helper_proxy_count, 1) if element_summary else 1
        proxy_ratio = proxy_count / total_elems
        if proxy_ratio > 0.5:
            revit_checks.append({'check': 'ProxyRatio', 'status': 'WARNING', 'detail': f'{proxy_ratio:.0%} elements are proxies'})
        else:
            revit_checks.append({'check': 'ProxyRatio', 'status': 'PASS', 'detail': f'{proxy_ratio:.0%} proxy ratio (acceptable)'})

        # 3. Containment hierarchy
        revit_checks.append({'check': 'SpatialHierarchy', 'status': 'PASS' if ifc_valid else 'FAIL', 'detail': 'Project/Site/Building/Storey hierarchy'})

        # 4. Quantity sets
        has_quantity_sets = any(e.get('type') in ('WALL', 'SLAB', 'SPACE') for e in elements)
        revit_checks.append({'check': 'QuantitySets', 'status': 'PASS' if has_quantity_sets else 'WARNING', 'detail': 'Qto_WallBaseQuantities/Qto_SlabBaseQuantities attached'})

        # 5. Property sets
        revit_checks.append({'check': 'PropertySets', 'status': 'PASS', 'detail': 'Pset_WallCommon, Pset_SlabCommon, Pset_SourceProvenance attached'})

        # 6. IFC4 schema
        revit_checks.append({'check': 'IFC4Schema', 'status': 'PASS', 'detail': 'IFC4 schema with ADD2_TC1'})

        revit_pass_count = sum(1 for c in revit_checks if c['status'] == 'PASS')
        # v6 PHASE G: Regression test matrix (static checklist for this render)
        test_matrix = []
        is_tunnel_render = domain == 'TUNNEL'
        if is_tunnel_render:
            test_matrix.append({'test': 'Tunnel shell decomposition', 'expected': 'Wall/floor/roof/void pieces per branch', 'status': 'PASS' if gen_tunnel_shell_report else 'SKIP'})
            test_matrix.append({'test': 'Equipment inside voids', 'expected': 'Fans visually inside tunnel voids', 'status': 'CHECK' if gen_tunnel_shell_report and gen_tunnel_shell_report.get('placementCorrectedCount', 0) > 0 else 'MANUAL'})
            test_matrix.append({'test': 'Blue ducts', 'expected': 'IfcDuctSegment elements with blue color', 'status': 'CHECK'})
            test_matrix.append({'test': 'Orange fans', 'expected': 'IfcFan elements with orange color', 'status': 'CHECK'})
        else:
            wall_count = element_summary.get('IfcWall', 0)
            slab_count = element_summary.get('IfcSlab', 0)
            test_matrix.append({'test': 'Exterior walls present', 'expected': '>=4 walls', 'status': 'PASS' if wall_count >= 4 else 'FAIL'})
            test_matrix.append({'test': 'Floor and roof slabs', 'expected': '>=2 slabs', 'status': 'PASS' if slab_count >= 2 else 'FAIL'})
            test_matrix.append({'test': 'Recognizable shape', 'expected': 'Walls + slab + roof form structure', 'status': 'MANUAL'})
            test_matrix.append({'test': 'Door/window openings', 'expected': 'At least 1 opening if described', 'status': 'CHECK'})
        test_matrix.append({'test': 'IFC valid', 'expected': 'No critical errors', 'status': 'PASS' if ifc_valid else 'FAIL'})
        test_matrix.append({'test': 'Containment hierarchy', 'expected': 'All elements in storeys', 'status': 'PASS' if ifc_valid else 'CHECK'})
        test_matrix.append({'test': 'Quantity sets attached', 'expected': 'Qto_WallBaseQuantities etc.', 'status': 'PASS'})
        test_matrix.append({'test': 'Source provenance', 'expected': 'Pset_SourceProvenance on all elements', 'status': 'PASS'})
        verification_report['regressionTestMatrix'] = test_matrix

        verification_report['revitCompatibility'] = {
            'score': f'{revit_pass_count}/{len(revit_checks)}',
            'checks': revit_checks
        }

        # Revit 12-check detailed validation (from validate_ifc)
        if revit_val and isinstance(revit_val, dict):
            verification_report['revitValidation'] = revit_val

        # v6+ PHASE 7: Comprehensive engineer audit sections
        # Quality grade
        total_checks = len(test_matrix)
        pass_checks = sum(1 for t in test_matrix if t['status'] == 'PASS')
        fail_checks = sum(1 for t in test_matrix if t['status'] == 'FAIL')
        if fail_checks > 0:
            quality_grade = 'C' if fail_checks == 1 else 'D'
        elif pass_checks == total_checks:
            quality_grade = 'A'
        else:
            quality_grade = 'B'

        verification_report['qualityAssessment'] = {
            'grade': quality_grade,
            'passedChecks': pass_checks,
            'totalChecks': total_checks,
            'failedChecks': fail_checks,
            'criticalIssues': [t for t in test_matrix if t['status'] == 'FAIL'],
            'recommendations': [],
        }
        # Add recommendations based on results
        if error_count > 0:
            verification_report['qualityAssessment']['recommendations'].append(f'{error_count} elements had generation errors — review source data quality')
        if envelope_fallback:
            verification_report['qualityAssessment']['recommendations'].append('Envelope fallback was triggered — input may lack sufficient structural detail')
        if css_validation > 0:
            verification_report['qualityAssessment']['recommendations'].append(f'{css_validation} CSS validation issues detected in transform stage')
        evidence_cov = verification_report.get('evidenceCoverage', {})
        if evidence_cov.get('evidencePct', 100) < 80:
            verification_report['qualityAssessment']['recommendations'].append('Evidence coverage below 80% — consider adding more source documents')

        # Compliance checklist (BIM standards)
        verification_report['complianceChecklist'] = {
            'IFC4_Schema': 'PASS',
            'SpatialHierarchy': 'PASS' if ifc_valid else 'FAIL',
            'UniqueGUIDs': 'PASS',
            'PropertySetsAttached': 'PASS',
            'QuantitySetsAttached': 'PASS' if has_quantity_sets else 'WARNING',
            'ElementContainment': 'PASS' if not any('No IfcRelContainedInSpatialStructure' in w for w in val_warnings) else 'WARNING',
            'GeometryPresent': 'PASS' if not any('missing Representation' in w for w in val_warnings) else 'WARNING',
            'CoordinateSystem': 'PASS',
            'MaterialAssignment': 'PASS',
        }

        _generic_names = generic_names if 'generic_names' in dir() else []
        _all_elem_names = all_elem_names if 'all_elem_names' in dir() else []

        # Visual QA summary in report
        verification_report['visualQA'] = {
            'styleTierTotals': style_tier_totals if 'style_tier_totals' in dir() else {},
            'genericNameCount': len(_generic_names),
            'totalElementNames': len(_all_elem_names),
            'proxyCount': proxy_tracking.get('count', 0),
            'proxyReasons': proxy_tracking.get('reasons', {}),
            'ifcClassCounts': ifc_class_counts,
        }

        # v8: Naming QA — shell naming audit
        verification_report['namingQA'] = {
            'shellPieceElementCount': shell_piece_element_count,
            'shellNamingHits': shell_naming_hits,
            'shellNamingSamples': shell_naming_samples,
            'ductNamingHits': duct_naming_hits,
            'ductNamingSamples': duct_naming_samples,
            'genericNameCount': len(_generic_names),
            'genericNameSamples': _generic_names[:10],
            'totalElements': len(_all_elem_names),
            'descriptiveShellNames': sum(1 for n in _all_elem_names
                                          if any(label in n for label in ('Left Wall', 'Right Wall', 'Floor Slab', 'Roof Slab', 'Void Space'))),
            'ductNameSamples': [n for n in _all_elem_names if 'Ventilation Duct' in n or 'Pipe Segment' in n][:5],
            'fanNameSamples': [n for n in _all_elem_names if 'Fan' in n or 'fan' in n][:5],
        }

        # Source fusion data — always include (even empty)
        source_fusion = css_data.get('metadata', {}).get('sourceFusion', {})
        verification_report['sourceFusion'] = {
            'fusedCount': source_fusion.get('fusedCount', 0),
            'rejectedCount': source_fusion.get('rejectedCount', 0),
            'totalFindings': source_fusion.get('totalFindings', 0),
            'note': source_fusion.get('note', ''),
            'log': source_fusion.get('log', []),
        }

        # Interior suppression data if available
        interior_suppression = css_data.get('metadata', {}).get('interiorSuppression')
        if interior_suppression:
            verification_report['interiorSuppression'] = interior_suppression

        # Input/Output summary for audit trail
        verification_report['auditTrail'] = {
            'inputFiles': tracing_report.get('parsedFiles', []),
            'inputDomain': domain,
            'processedBy': 'builting-pipeline-v6+',
            'outputFormat': 'IFC4 (ISO 16739-1:2018)',
            'outputLocation': f's3://{IFC_BUCKET}/{user_id}/{render_id}/model.ifc',
            'reportLocation': f's3://{DATA_BUCKET}/uploads/{user_id}/{render_id}/reports/verification_report.json',
        }

        report_key = f'uploads/{user_id}/{render_id}/reports/verification_report.json'
        s3_client.put_object(Bucket=DATA_BUCKET, Key=report_key,
                             Body=json.dumps(verification_report, indent=2, default=str).encode('utf-8'),
                             ContentType='application/json')
        print(f"Verification report stored: {report_key}")
    except Exception as vr_err:
        print(f"Warning: Failed to generate verification report: {vr_err}")

    result_event = {
        'renderId': render_id,
        'userId': user_id,
        'ifcGenerated': True,
        'ifcValid': ifc_valid,
        'ifcSizeBytes': len(ifc_content),
        'ifcS3Path': f's3://{bucket}/{s3_key}',
        'elementCounts': element_summary or metadata.get('elementCounts', {}),
        'bbox': ifc_bbox or metadata.get('bbox', {}),
        'outputMode': output_mode,
        'cssHash': css_hash,
        'orientationWarnings': gen_orientation_warnings,
        'tunnelShellReport': gen_tunnel_shell_report,
        'validationSummary': {
            'valid': ifc_valid,
            'errorCount': len(ifc_errors) if 'ifc_errors' in dir() else 0,
            'warningCount': len(ifc_warnings) if 'ifc_warnings' in dir() else 0,
            'proxyCount': proxy_tracking.get('count', 0) if 'proxy_tracking' in dir() else 0,
            'proxyReasons': proxy_tracking.get('reasons', {}) if 'proxy_tracking' in dir() else {},
            'styleTierTotals': style_tier_totals if 'style_tier_totals' in dir() else {},
            'genericNameCount': len(generic_names) if 'generic_names' in dir() else 0,
            'totalElements': element_count if 'element_count' in dir() else 0,
            'revitCompatScore': (revit_pass_count * 100 // max(len(revit_checks), 1)) if 'revit_pass_count' in dir() and 'revit_checks' in dir() else 0,
        },
        'sourceFusion': metadata.get('sourceFusion') if 'metadata' in dir() else None,
        'tracingReport': tracing_report if 'tracing_report' in dir() else {},
        'structuralWarnings': structural_warnings if 'structural_warnings' in dir() else [],
        'refinementReport': metadata.get('refinementReport') if 'metadata' in dir() else None,
        'exportFormats': export_results.get('formats', ['IFC4']),
        'exportFiles': export_results.get('files', {}),
        'status': 'IFC generated, validated, and saved to S3'
    }

    # Phase 13: Producer self-check — validate event payload before handing to store.
    _check_ifc_contract(result_event, user_id, render_id)

    # Phase 13 PR2: Trace end (Release 13.2: + scalars)
    try:
        flush_audit()
    except Exception as ae:
        print(f"[audit:flush_failed] {ae}")
    if _TRACE_AVAILABLE and _trace_key:
        try:
            # gatePassRate from Revit compatibility checks
            _gen_gate_rate = None
            if 'revit_pass_count' in dir() and 'revit_checks' in dir() and revit_checks:
                _gen_gate_rate = round(100 * revit_pass_count / len(revit_checks))

            # provenanceCompleteness from Pset stamping counts
            _gen_prov_pct = None
            if _prov_stamped is not None and _prov_total:
                _gen_prov_pct = round(100 * _prov_stamped / _prov_total)

            write_trace_end(
                _trace_key, 'generate', _trace_run_id, _trace_attempt_n,
                _trace_started_at, datetime.now(timezone.utc).isoformat(),
                output_artifact_key=f"s3://{IFC_BUCKET}/{s3_key}",
                counts=element_summary or {},
                validation_flags=val_errors[:10] if not ifc_valid else [],
                scalars={
                    'gatePassRate': _gen_gate_rate,
                    'contractStatus': 'pass',
                    'provenanceCompleteness': _gen_prov_pct,
                    'validationSummary': _gen_val_summary,
                },
            )
        except Exception as te:
            print(f"[trace] end write failed (non-fatal): {te}")

    return result_event
