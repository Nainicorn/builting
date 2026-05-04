"""Domain-profile configuration for the secondary-geometry layer.

5A.7 — env-var resolution. Pure config: nothing here touches geometry,
validation, or topology. Subsequent steps (5A.8..5A.12) will read these
values to replace module-level constants.

Env vars:
    CLEAN_EXPORT_PROFILE              (default: 'tunnel')
    VALIDATION_DISTANCE_TOLERANCE     (default: 5.0   metres)
    NODE_SNAP_TOLERANCE               (default: 0.1   metres)
    MAX_SHAFT_RADIUS                  (default: 1.5   metres)
    MAX_SHAFT_HEIGHT                  (default: 12.0  metres)
    ENABLE_DUCTS                      (default: false)
    ENABLE_PORTALS                    (default: true)
    ENABLE_SHAFTS                     (default: false for tunnel, true otherwise)
    STRICT_SECONDARY_GEOMETRY         (default: true if profile in CLEAN_PROFILES,
                                       false otherwise)
    ENABLE_SYNTHETIC_PORTALS          (default: false for tunnel, true otherwise)
                                       — 5B.5C: tunnel entrances must look
                                       like the end of the wall network, not
                                       framed portals.
    ENABLE_RECONSTRUCTED_VENTILATION  (default: false)  — 5B.3: derive a clean
                                       interior duct from tunnel centerline
                                       (raw duct candidates remain off via
                                       ENABLE_DUCTS)
    ALLOW_CONFIG_DEFAULTS             (default: false)  — 5B.3: permit a
                                       configured default duct radius when
                                       no source provides one
"""

from dataclasses import dataclass
import os


# Profiles considered "clean" enough to default STRICT_SECONDARY_GEOMETRY=true.
# Tunnel and building exporters have been hardened. Add more profiles here as
# they are verified.
CLEAN_PROFILES = frozenset({'tunnel', 'building', 'residential'})


@dataclass(frozen=True)
class SecondaryGeometryProfile:
    profile: str
    validation_distance_tolerance: float
    node_snap_tolerance: float
    max_shaft_radius: float
    max_shaft_height: float
    enable_ducts: bool
    enable_portals: bool
    enable_shafts: bool
    strict_secondary_geometry: bool
    # 5B — controlled detail reconstruction
    enable_synthetic_portals: bool
    enable_reconstructed_ventilation: bool
    allow_config_defaults: bool


def _bool_env(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == '':
        return default
    return raw.strip().lower() in ('1', 'true', 'yes', 'on')


def _float_env(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == '':
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def load_profile():
    """Read env vars and return a frozen SecondaryGeometryProfile.

    Defaults vary by profile:

    * Tunnel profile (5B.5C structural correctness pass):
        - enable_shafts=False — tunnel mouths are wall endings, not shafts.
        - enable_synthetic_portals=False — no portal frames or portal walls;
          tunnel entrances are just the end of the wall network. Doors host
          on real tunnel/branch walls via IfcOpeningElement + voids + fills.
        - enable_portals=True kept so any rare valid PORTAL_BUILDING /
          PORTAL_END_WALL upstream candidate still has the option.
    * Other profiles (default to pre-5B.5C behavior): portals + shafts +
      synthetic portals enabled, ducts off, strict secondary geometry
      enabled only for CLEAN_PROFILES.

    Env vars override these per-profile defaults.
    """
    profile = (os.environ.get('CLEAN_EXPORT_PROFILE') or 'tunnel').strip().lower()
    strict_default = profile in CLEAN_PROFILES
    is_tunnel = profile == 'tunnel'
    # Any non-tunnel profile (residential, office, hospital, warehouse, etc.) is
    # treated as a building: ducts on, shafts/synthetic-portals off.
    # Tunnel: no shafts/synthetic portals — doors live on real wall endpoints.
    # Building profiles: no shafts, no synthetic portals — ducts enabled (HVAC systems).
    enable_shafts_default             = False if is_tunnel else True
    enable_synthetic_portals_default  = False if is_tunnel else False
    enable_ducts_default              = True
    return SecondaryGeometryProfile(
        profile=profile,
        validation_distance_tolerance=_float_env('VALIDATION_DISTANCE_TOLERANCE', 5.0),
        node_snap_tolerance=_float_env('NODE_SNAP_TOLERANCE', 0.1),
        max_shaft_radius=_float_env('MAX_SHAFT_RADIUS', 1.5),
        max_shaft_height=_float_env('MAX_SHAFT_HEIGHT', 12.0),
        enable_ducts=_bool_env('ENABLE_DUCTS', enable_ducts_default),
        enable_portals=_bool_env('ENABLE_PORTALS', True),
        enable_shafts=_bool_env('ENABLE_SHAFTS', enable_shafts_default),
        strict_secondary_geometry=_bool_env('STRICT_SECONDARY_GEOMETRY', strict_default),
        enable_synthetic_portals=_bool_env('ENABLE_SYNTHETIC_PORTALS',
                                            enable_synthetic_portals_default),
        enable_reconstructed_ventilation=_bool_env('ENABLE_RECONSTRUCTED_VENTILATION', False),
        allow_config_defaults=_bool_env('ALLOW_CONFIG_DEFAULTS', False),
    )


def format_profile(p):
    """One-line, log-friendly representation."""
    return (
        f"profile={p.profile} "
        f"strict_secondary_geometry={p.strict_secondary_geometry} "
        f"validation_distance_tolerance={p.validation_distance_tolerance} "
        f"node_snap_tolerance={p.node_snap_tolerance} "
        f"max_shaft_radius={p.max_shaft_radius} "
        f"max_shaft_height={p.max_shaft_height} "
        f"enable_ducts={p.enable_ducts} "
        f"enable_portals={p.enable_portals} "
        f"enable_shafts={p.enable_shafts} "
        f"enable_synthetic_portals={p.enable_synthetic_portals} "
        f"enable_reconstructed_ventilation={p.enable_reconstructed_ventilation} "
        f"allow_config_defaults={p.allow_config_defaults}"
    )
