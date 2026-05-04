/**
 * ValidateModel Configuration
 *
 * Central config for all tolerances, mapping tables, domain minimums,
 * gate definitions, and severity defaults. Keeps tuning out of code.
 */

// ── Tolerances ──────────────────────────────────────────────────────────────

export const TOLERANCES = {
  MAX_COORD: 100_000,           // ±100 km max coordinate value
  MAX_DIMENSION: 10_000,        // 10 km max single dimension (width/height/depth)
  COLLINEARITY_TOLERANCE: 0.001,// cross-product magnitude threshold for axis/refDir
  PROXIMITY_TOLERANCE: 0.1,     // 0.1 m — positions closer than this are "coincident"
  MAX_EXTENT: 50_000,           // 50 km — model bounding box diagonal limit
  MIN_VECTOR_LENGTH: 1e-6       // minimum length for axis/refDirection vectors
};

// ── Confidence Buckets ──────────────────────────────────────────────────────

export const CONFIDENCE = {
  HIGH: 0.7,    // >= 0.7
  MEDIUM: 0.4,  // 0.4 – 0.7
  // LOW: < 0.4
};

// ── Allowed Semantic Type Mappings ──────────────────────────────────────────

export const ALLOWED_SEMANTIC_TYPES = {
  WALL:           ['IfcWall', 'IfcWallStandardCase', 'IfcBuildingElementProxy'],
  SLAB:           ['IfcSlab', 'IfcBuildingElementProxy'],
  COLUMN:         ['IfcColumn', 'IfcBuildingElementProxy'],
  BEAM:           ['IfcBeam', 'IfcBuildingElementProxy'],
  OPENING:        ['IfcDoor', 'IfcWindow', 'IfcOpeningElement', 'IfcBuildingElementProxy'],
  DOOR:           ['IfcDoor', 'IfcBuildingElementProxy'],
  WINDOW:         ['IfcWindow', 'IfcBuildingElementProxy'],
  EQUIPMENT:      ['IfcFan', 'IfcPump', 'IfcValve', 'IfcUnitaryEquipment', 'IfcFlowTerminal', 'IfcDistributionFlowElement', 'IfcHeatExchanger', 'IfcAirTerminal', 'IfcFlowMeter', 'IfcFilter', 'IfcDamper', 'IfcCoil', 'IfcTransportElement', 'IfcBuildingElementProxy'],
  SPACE:          ['IfcSpace', 'IfcBuildingElementProxy'],
  TUNNEL_SEGMENT: ['IfcTunnelPart', 'IfcBuildingElementProxy'],
  DUCT:           ['IfcDuctSegment', 'IfcFlowSegment', 'IfcBuildingElementProxy'],
  PIPE:           ['IfcPipeSegment', 'IfcFlowSegment', 'IfcBuildingElementProxy'],
  RAILING:        ['IfcRailing', 'IfcBuildingElementProxy'],
  STAIR:          ['IfcStair', 'IfcBuildingElementProxy'],
  RAMP:           ['IfcRamp', 'IfcBuildingElementProxy'],
  ROOF:           ['IfcRoof', 'IfcBuildingElementProxy'],
  CURTAIN_WALL:   ['IfcCurtainWall', 'IfcBuildingElementProxy'],
  COVERING:       ['IfcCovering', 'IfcBuildingElementProxy'],
  FOOTING:        ['IfcFooting', 'IfcBuildingElementProxy'],
  PROXY:          ['IfcBuildingElementProxy']
};

// ── Domain Minimums (first-pass viability checks) ──────────────────────────

export const DOMAIN_MINIMUMS = {
  // TUNNEL uses TUNNEL_SEGMENT elements for structural shells; cast-in-place
  // floors are modeled as shell faces on those segments, NOT as IfcSlab.
  // Requiring SLAB causes spurious domain_minimum_not_met errors on every
  // tunnel render. WALL minimum retained for portal end-walls.
  TUNNEL:     { WALL: 1 },
  BUILDING:   { WALL: 4, SLAB: 2 },
  CIVIL:      { WALL: 1 },
  INDUSTRIAL: { WALL: 1 }
};

// ── Generic Name Patterns ──────────────────────────────────────────────────

export const GENERIC_NAME_PATTERNS = [
  '', 'Unnamed', 'Element', 'Proxy', 'Unknown', 'undefined', 'null'
];

// ── Type-Dependent Unresolved Container Severity ───────────────────────────

export const UNRESOLVED_CONTAINER_SEVERITY = {
  WALL: 'error',
  SLAB: 'error',
  COLUMN: 'error',
  BEAM: 'error',
  DOOR: 'error',
  WINDOW: 'error',
  OPENING: 'error',
  EQUIPMENT: 'warning',
  SPACE: 'warning',
  PROXY: 'warning',
  DUCT: 'warning',
  TUNNEL_SEGMENT: 'warning'
};

// ── Cross-Domain Suspicious Combinations ───────────────────────────────────

export const CROSS_DOMAIN_SUSPICIOUS = {
  BUILDING: ['TUNNEL_SEGMENT'],
  TUNNEL: [],
  CIVIL: [],
  INDUSTRIAL: []
};

// ── Wall-Like Types (valid VOIDS host targets) ─────────────────────────────

export const WALL_LIKE_TYPES = ['WALL', 'SLAB'];
export const WALL_LIKE_SEMANTIC_TYPES = ['IfcWall', 'IfcWallStandardCase', 'IfcSlab'];

// ── Tunnel Shell Roles ─────────────────────────────────────────────────────

export const TUNNEL_SHELL_ROLES = ['LEFT_WALL', 'RIGHT_WALL', 'FLOOR', 'ROOF'];

// ── Gate Definitions ───────────────────────────────────────────────────────

export const GATES = {
  noNaNCoordinates:        { hard: true,  check: 'invalid_origin' },
  noInvalidPlacements:     { hard: true,  checks: ['invalid_axis', 'invalid_refDirection', 'collinear_axis_refDirection', 'placement_not_numeric'] },
  noUnresolvedContainers:  { hard: false, check: 'null_container_no_flag' },
  noDanglingRelationships: { hard: true,  check: 'dangling_relationship_target' },
  noInvalidProfiles:       { hard: true,  check: 'invalid_profile' },
  noInvalidExtrusionDepths:{ hard: true,  check: 'invalid_depth' },
  noBrokenOpeningHosts:    { hard: false, check: 'orphaned_opening' },
  domainMinimumsMet:       { hard: true,  check: 'domain_minimum_not_met' },
  extentWithinSafePrecision:{ hard: true, check: 'out_of_bounds' },
  meshGeometrySane:        { hard: true,  checks: ['mesh_missing_vertices', 'mesh_missing_faces', 'mesh_face_index_out_of_bounds'] }
};

// ── Scoring Weights ────────────────────────────────────────────────────────

export const SCORING = {
  validGeometry:       25,
  highConfidence:      20,
  containerValidity:   10,
  relationshipIntegrity: 10,
  domainViability:     10,
  proxyPenalty:        -10,
  criticalIssuePenalty:-15,
  warningPenalty:      -10,
  authoringRiskPenalty:-10
};

// ── Authoring Suitability Thresholds ───────────────────────────────────────

export const AUTHORING = {
  FULL_AUTHORING_MIN_SCORE: 80,
  FULL_AUTHORING_MAX_PROXY_RATIO: 0.1,
  COORDINATION_MIN_SCORE: 50,
  COORDINATION_MAX_PROXY_RATIO: 0.3,
  PROXY_ONLY_MAX_SCORE: 50,
  PROXY_ONLY_MIN_RATIO: 0.3
};

// ── Default Severity by Check Name ─────────────────────────────────────────

export const CHECK_SEVERITY = {
  // semantic
  type_semantic_mismatch: 'warning',
  low_confidence: 'info',
  generic_name: 'info',
  cross_domain_entity: 'warning',
  unresolved_semantic_class: 'warning',
  // geometric
  invalid_origin: 'error',
  invalid_axis: 'error',
  invalid_refDirection: 'error',
  collinear_axis_refDirection: 'error',
  placement_not_numeric: 'error',
  out_of_bounds: 'warning',
  invalid_profile: 'error',
  invalid_depth: 'error',
  oversized_dimension: 'warning',
  mesh_missing_vertices: 'error',
  mesh_missing_faces: 'error',
  mesh_face_index_out_of_bounds: 'error',
  degenerate_mesh_face: 'warning',
  mesh_invalid_bbox: 'warning',
  suspicious_coincident_placement: 'warning',
  curve_approximated_as_polygon: 'info',
  sweep_missing_path: 'error',
  sweep_invalid_radius: 'error',
  revolution_missing_axis: 'error',
  revolution_invalid_angle: 'error',
  revolution_missing_profile: 'error',
  // topological
  null_container_no_flag: 'error',
  null_container_unresolved: 'warning',
  invalid_container_ref: 'error',
  dangling_relationship_target: 'error',
  self_referential_relationship: 'error',
  invalid_opening_host_type: 'warning',
  orphaned_opening: 'error',
  path_connects_missing: 'warning',
  contradictory_relationships: 'warning',
  equipment_no_host: 'info',
  // structural
  domain_minimum_not_met: 'error',
  no_containers: 'error',
  missing_shell_pieces: 'warning',
  shell_naming_inconsistent: 'warning',
  orphaned_opening_no_plausible_host: 'warning',
  disconnected_envelope: 'info',
  merged_run_no_topology: 'warning',
  proxy_fallback_no_flag: 'warning'
};

// ── Engineer-Intent Resolver Profiles ──────────────────────────────────────
// Per-domain tunables consumed by intent-resolver.mjs. The resolver is
// generic; profile entries gate the heuristics it applies. Add a new entry
// (e.g. RESIDENTIAL, WAREHOUSE) to support additional building types.

export const INTENT_PROFILES = {
  TUNNEL: {
    door: {
      perpDistMax:         15.0,    // max perpendicular distance from door to host (m)
      portalPriorityFactor: 0.5,    // PORTAL_END_WALL effective-distance multiplier
      validHostTypes:      ['TUNNEL_SEGMENT', 'PORTAL_END_WALL', 'PORTAL_BUILDING'],
      faceSideRequired:    true     // resolve INTERIOR/EXTERIOR face for tunnel hosts
    },
    duct:   { runMaxGap: 0.5, requireFlowDirection: false },
    access: { sources: ['portal_elevation', 'entrance_door'] }
  },
  BUILDING: {
    door: {
      perpDistMax:      1.0,
      salvagePerpMax:   3.0,
      widthRatioMax:    0.8,
      ambiguityRatio:   0.92,
      orientationTol:   0.2,
      validHostTypes:   ['WALL'],
      faceSideRequired: false
    },
    duct:   { runMaxGap: 0.2, requireFlowDirection: true },
    access: { sources: ['storey_floor', 'entrance_door'] }
  },
  CIVIL: {
    door:   { perpDistMax: 5.0, validHostTypes: ['WALL', 'TUNNEL_SEGMENT'], faceSideRequired: false },
    duct:   { runMaxGap: 0.5, requireFlowDirection: false },
    access: { sources: ['portal_elevation'] }
  },
  INDUSTRIAL: {
    door:   { perpDistMax: 2.0, validHostTypes: ['WALL'], faceSideRequired: false },
    duct:   { runMaxGap: 0.3, requireFlowDirection: false },
    access: { sources: ['storey_floor', 'entrance_door'] }
  }
};

// Resolver mode read once from env in index.mjs and mirrored into CSS metadata
// so generate sees the same value without an env share.
//   off          — resolver not invoked
//   report       — resolver runs, writes engineer_intent_report.json, no element annotation
//   consume-doors— intent.* fields drive door placement (no per-element fallback)
//   consume-mep  — intent.* fields drive door + duct placement
//   consume-all  — intent.* fields drive doors + ducts + inferred access surfaces
export const INTENT_RESOLVER_MODES = ['off', 'report', 'consume-doors', 'consume-mep', 'consume-all'];

// ── Blocks-Export Checks ───────────────────────────────────────────────────

export const BLOCKS_EXPORT_CHECKS = new Set([
  'invalid_origin',
  'invalid_profile',
  'invalid_depth',
  'mesh_missing_vertices',
  'mesh_missing_faces',
  'mesh_face_index_out_of_bounds',
  'sweep_missing_path',
  'sweep_invalid_radius',
  'revolution_missing_axis',
  'revolution_invalid_angle',
  'revolution_missing_profile'
]);
