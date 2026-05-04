/**
 * Spec text → Claims converter.
 *
 * Consumes the structured output of parsers/specTextParser.mjs and emits
 * claims using ONLY the existing CLAIM_KINDS taxonomy. No new claim kinds.
 *
 * Mapping:
 *   - rooms / portalBuildings / shaft  → SPACE_DEFINITION
 *   - room.doors / portal.doors        → OPENING_CANDIDATE
 *   - levels                           → LEVEL_DEFINITION
 *   - tunnelBore                       → FACILITY_DIMENSION + MATERIAL_ASSIGNMENT
 *   - shaft (also)                     → FACILITY_DIMENSION
 *   - ramp                             → FACILITY_DIMENSION
 *   - systems                          → SYSTEM_MEMBERSHIP
 *   - equipment                        → EQUIPMENT_INSTANCE
 *   - ductSpec                         → FACILITY_DIMENSION (duct.diameter, duct.totalSegments)
 *   - fittingSpec.fittings             → FITTING_CANDIDATE (one claim per fitting type)
 *   - wallSpec                         → FACILITY_DIMENSION (wall.thickness, wall.heights)
 *   - slabSpec / ceilingSpec           → FACILITY_DIMENSION
 */

import {
  buildClaim, buildEvidence, buildProvenance,
  CLAIM_KINDS, EXTRACTION_METHODS, COORDINATE_SOURCES, SOURCE_ROLES, CLAIM_STATUS,
  PROVENANCE_STATUS
} from './claimsSchema.mjs';

const METHOD = EXTRACTION_METHODS.HEURISTIC; // deterministic regex parser

// fileAuthority is bound per call to specTextToClaims so every evidence
// object inherits the correct authority level for its source file.
let _fileAuthorityLookup = {};

function ev(sourceFile, excerpt, page = null, coordSource = COORDINATE_SOURCES.NONE) {
  const authority = _fileAuthorityLookup[sourceFile] || 'DEFAULT';
  return buildEvidence(sourceFile, SOURCE_ROLES.NARRATIVE, METHOD, coordSource, {
    excerpt, page, authority,
  });
}

function provFor(sourceFile) {
  const sf = sourceFile || null;
  return buildProvenance(sf, sf ? PROVENANCE_STATUS.DIRECT : PROVENANCE_STATUS.MISSING, 'extract');
}

/**
 * @param {object} parsed - output of parseSpecTexts(files)
 * @returns {{ claims: Array }}
 */
export function specTextToClaims(parsed) {
  const claims = [];
  if (!parsed) return { claims };
  _fileAuthorityLookup = parsed.fileAuthority || {};

  // ---------- LEVELS ----------
  for (const lvl of parsed.levels || []) {
    claims.push(buildClaim(
      CLAIM_KINDS.LEVEL_DEFINITION,
      lvl.id,
      {
        id: lvl.id,
        type: 'STOREY',
        name: lvl.name,
        elevation_m: lvl.elevation_local_m ?? (lvl.elevation_msl_m !== undefined && lvl.elevation_msl_m !== null
          ? (lvl.elevation_msl_m - 1290.0)
          : null),
        elevation_msl_m: lvl.elevation_msl_m,
        height_m: lvl.story_height_m,
        levelIndex: lvl.index,
      },
      {
        evidence: [ev(lvl.sourceFile, `Level ${lvl.index} elevation ${lvl.elevation_msl_m} m MSL`)],
        confidence: 0.92,
        fieldConfidence: { dimensions: 0.95, placement: 0.95 },
        discipline: 'architectural',
        provenance: provFor(lvl.sourceFile),
      }
    ));
  }

  // ---------- ROOMS (regular rooms) ----------
  for (const room of parsed.rooms || []) {
    const containerId = `level-${room.levelIndex ?? 0}`;
    const placement = room.centroid
      ? { origin: { x: room.centroid.x, y: room.centroid.y, z: room.centroid.z ?? 0 } }
      : { origin: { x: 0, y: 0, z: 0 } };
    claims.push(buildClaim(
      CLAIM_KINDS.SPACE_DEFINITION,
      room.id,
      {
        id: room.id,
        type: 'SPACE',
        semanticType: 'IfcSpace',
        name: room.name,
        geometry: {
          length_m: room.length_m ?? null,
          depth_m: room.width_m ?? null,
          height_m: room.height_m ?? null,
        },
        placement,
        container: containerId,
        relationships: [],
        properties: {
          spaceType: 'ROOM',
          floorElevationMSL: room.floorElevationMSL,
          subRoomCount: (room.subRooms || []).length,
        },
        metadata: { roomNumber: room.number, source: 'spec_text' },
      },
      {
        evidence: [ev(room.sourceFile, room.sourceExcerpt, null,
          room.centroid ? COORDINATE_SOURCES.DIRECT_2D : COORDINATE_SOURCES.NONE)],
        confidence: room.centroid ? 0.95 : 0.85,
        fieldConfidence: { dimensions: 0.90, placement: room.centroid ? 0.95 : 0.30 },
        discipline: 'architectural',
        aliases: [room.name],
        provenance: provFor(room.sourceFile),
      }
    ));

    // Sub-rooms (alcoves)
    for (const sub of room.subRooms || []) {
      claims.push(buildClaim(
        CLAIM_KINDS.SPACE_DEFINITION,
        sub.id,
        {
          id: sub.id,
          type: 'SPACE',
          semanticType: 'IfcSpace',
          name: sub.name,
          geometry: { length_m: sub.length_m, depth_m: sub.width_m, height_m: room.height_m ?? null },
          placement: { origin: { x: 0, y: 0, z: 0 } },
          container: containerId,
          relationships: [{ type: 'CONTAINED_IN', target: room.id }],
          properties: { spaceType: 'SUBROOM', parentRoom: room.id },
        },
        {
          evidence: [ev(room.sourceFile, sub.name)],
          confidence: 0.65,
          fieldConfidence: { dimensions: 0.65, placement: 0.20 },
          discipline: 'architectural',
          provenance: provFor(room.sourceFile),
        }
      ));
    }

    // Room-attached doors
    for (const door of room.doors || []) {
      claims.push(buildClaim(
        CLAIM_KINDS.OPENING_CANDIDATE,
        door.id,
        {
          id: door.id,
          type: 'DOOR',
          semanticType: 'IfcDoor',
          name: `${room.name} ${door.kind} door`,
          geometry: { width_m: door.width_m, height_m: door.height_m },
          placement: { origin: { x: 0, y: 0, z: 0 } },
          container: containerId,
          relationships: [{ type: 'HOSTED_BY', target: room.id }],
          properties: { doorType: door.kind, hostRoom: room.id },
        },
        {
          evidence: [ev(door.sourceFile, `${room.name}: ${door.kind} door ${door.width_m}x${door.height_m} m`)],
          confidence: 0.85,
          fieldConfidence: { dimensions: 0.95, placement: 0.30 },
          discipline: 'architectural',
          provenance: provFor(door.sourceFile),
        }
      ));
    }
  }

  // ---------- PORTAL BUILDINGS ----------
  for (const portal of parsed.portalBuildings || []) {
    const containerId = `level-${portal.levelIndex ?? 0}`;
    claims.push(buildClaim(
      CLAIM_KINDS.SPACE_DEFINITION,
      portal.id,
      {
        id: portal.id,
        type: 'SPACE',
        semanticType: 'IfcSpace',
        name: portal.name,
        geometry: {
          length_m: portal.depth_m ?? null,
          depth_m: portal.width_m ?? null,
          height_m: portal.height_m ?? null,
        },
        placement: { origin: { x: 0, y: 0, z: 0 } },
        container: containerId,
        properties: {
          spaceType: 'PORTAL_BUILDING',
          side: portal.side,
          floorElevationMSL: portal.floorElevationMSL,
        },
      },
      {
        evidence: [ev(portal.sourceFile, portal.sourceExcerpt)],
        confidence: 0.80,
        fieldConfidence: { dimensions: 0.85, placement: 0.30 },
        discipline: 'architectural',
        aliases: [portal.name],
        provenance: provFor(portal.sourceFile),
      }
    ));
    for (const door of portal.doors || []) {
      claims.push(buildClaim(
        CLAIM_KINDS.OPENING_CANDIDATE,
        door.id,
        {
          id: door.id,
          type: 'DOOR',
          semanticType: 'IfcDoor',
          name: `${portal.name} ${door.kind} door`,
          geometry: { width_m: door.width_m, height_m: door.height_m },
          placement: { origin: { x: 0, y: 0, z: 0 } },
          container: containerId,
          relationships: [{ type: 'HOSTED_BY', target: portal.id }],
          properties: { doorType: door.kind, hostRoom: portal.id },
        },
        {
          evidence: [ev(door.sourceFile, `${portal.name}: ${door.kind} door ${door.width_m}x${door.height_m} m`)],
          confidence: 0.85,
          fieldConfidence: { dimensions: 0.95, placement: 0.30 },
          discipline: 'architectural',
          provenance: provFor(door.sourceFile),
        }
      ));
    }
  }

  // ---------- TUNNEL BORE OVERRIDE ----------
  if (parsed.tunnelBore) {
    const tb = parsed.tunnelBore;
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'tunnel-bore-override',
      {
        id: 'tunnel-bore-override',
        category: 'TUNNEL_BORE',
        bore_shape: tb.shape,
        bore_width_m: tb.bore_width_m,
        bore_height_m: tb.bore_height_m,
        lining_min_m: tb.lining_min_m,
        lining_max_m: tb.lining_max_m,
        lining_material: tb.lining_material,
      },
      {
        evidence: [ev(tb.sourceFile, `Tunnel bore: ${tb.shape} ${tb.bore_width_m}x${tb.bore_height_m} m, lining ${tb.lining_min_m}-${tb.lining_max_m} m`)],
        confidence: 0.95,
        fieldConfidence: { dimensions: 0.95, material: 0.95 },
        discipline: 'civil',
        provenance: provFor(tb.sourceFile),
      }
    ));
    if (tb.lining_material) {
      claims.push(buildClaim(
        CLAIM_KINDS.MATERIAL_ASSIGNMENT,
        'tunnel-lining-material',
        {
          id: 'tunnel-lining-material',
          targetCategory: 'TUNNEL_LINING',
          material: { name: tb.lining_material, thickness_m_min: tb.lining_min_m, thickness_m_max: tb.lining_max_m },
        },
        {
          evidence: [ev(tb.sourceFile, `Lining material: ${tb.lining_material}`)],
          confidence: 0.90,
          discipline: 'civil',
          provenance: provFor(tb.sourceFile),
        }
      ));
    }
  }

  // ---------- VERTICAL SHAFT ----------
  if (parsed.shaft) {
    const sh = parsed.shaft;
    // Space claim — vertical extrusion as a SPACE with circular profile
    claims.push(buildClaim(
      CLAIM_KINDS.SPACE_DEFINITION,
      sh.id,
      {
        id: sh.id,
        type: 'SPACE',
        semanticType: 'IfcSpace',
        name: sh.name,
        geometry: {
          shape: 'CIRCULAR',
          // depth becomes vertical length when extruded along Z
          length_m: sh.depth_m,
          height_m: sh.depth_m,
          // diameter unknown at extraction time — left null; topology may infer or default
          diameter_m: null,
        },
        placement: {
          // Z-base = collar - depth (topology will translate MSL to local)
          origin: { x: 0, y: 0, z: 0 },
          axis: { x: 0, y: 0, z: 1 },
        },
        container: 'tunnel-shaft-container',
        properties: {
          spaceType: 'SHAFT',
          orientation: 'VERTICAL',
          collar_msl_m: sh.collar_msl_m,
          depth_m: sh.depth_m,
          profile: sh.profile,
          location: sh.location,
        },
      },
      {
        evidence: [ev(sh.sourceFile, `Vertical shaft: collar ${sh.collar_msl_m} m MSL, depth ${sh.depth_m} m, ${sh.profile} profile`)],
        confidence: 0.90,
        fieldConfidence: { dimensions: 0.90, placement: 0.30 },
        discipline: 'civil',
        aliases: [sh.name],
        provenance: provFor(sh.sourceFile),
      }
    ));
    // Facility-dimension claim — separate, for resolve/topology to read
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'shaft-dimensions',
      {
        id: 'shaft-dimensions',
        category: 'VERTICAL_SHAFT',
        collar_msl_m: sh.collar_msl_m,
        depth_m: sh.depth_m,
        profile: sh.profile,
      },
      {
        evidence: [ev(sh.sourceFile, `Shaft collar ${sh.collar_msl_m} MSL, depth ${sh.depth_m} m`)],
        confidence: 0.95,
        fieldConfidence: { dimensions: 0.95 },
        discipline: 'civil',
        provenance: provFor(sh.sourceFile),
      }
    ));
  }

  // ---------- RAMP ----------
  if (parsed.ramp) {
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'east-ramp',
      {
        id: 'east-ramp',
        category: 'RAMP',
        side: 'East',
        length_m: parsed.ramp.length_m,
        grade: parsed.ramp.grade,
      },
      {
        evidence: [ev(parsed.ramp.sourceFile, `East ramp ${parsed.ramp.length_m} m, ${parsed.ramp.grade}`)],
        confidence: 0.85,
        discipline: 'civil',
        provenance: provFor(parsed.ramp.sourceFile),
      }
    ));
  }

  // ---------- SYSTEMS ----------
  for (const sys of parsed.systems || []) {
    claims.push(buildClaim(
      CLAIM_KINDS.SYSTEM_MEMBERSHIP,
      sys.id,
      {
        id: sys.id,
        category: 'HVAC_SYSTEM',
        systemNumber: sys.systemNumber,
        name: sys.name,
        systemType: sys.systemType,
        memberCount: sys.memberCount,
      },
      {
        evidence: [ev(sys.sourceFile, `${sys.name}: ${sys.memberCount} members`)],
        confidence: 0.90,
        discipline: 'mechanical',
        aliases: [sys.name],
        provenance: provFor(sys.sourceFile),
      }
    ));
  }
  if (parsed.totalDistributionPorts !== null && parsed.totalDistributionPorts !== undefined) {
    // HVAC topology totals aggregate across all system files — use first known source or MISSING
    const hvacSourceFile = parsed.systems?.[0]?.sourceFile || null;
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'hvac-port-totals',
      {
        id: 'hvac-port-totals',
        category: 'HVAC_TOPOLOGY',
        totalDistributionPorts: parsed.totalDistributionPorts,
        totalPathConnections: parsed.totalPathConnections,
      },
      {
        evidence: [ev(hvacSourceFile, `HVAC topology totals`)],
        confidence: 0.85,
        discipline: 'mechanical',
        provenance: provFor(hvacSourceFile),
      }
    ));
  }

  // ---------- EQUIPMENT ----------
  // Fix C: build a CFM-number → roomId map from each room's Contents list
  const cfmToRoomId = new Map();
  const namePatternToRoomId = new Map();
  for (const room of parsed.rooms || []) {
    for (const item of room.contents || []) {
      const cfmM = item.match(/([0-9]+)\s*CFM/i);
      if (cfmM) cfmToRoomId.set(cfmM[1], room.id);
      if (/AHU\s+Fan\s+Module/i.test(item)) namePatternToRoomId.set('ahu', room.id);
      if (/generator/i.test(item)) namePatternToRoomId.set('generator', room.id);
    }
  }

  for (const eq of parsed.equipment || []) {
    // Contributing files — every source that mentioned this deduped equipment item
    const eqSourceFiles = (eq.sourceFiles && eq.sourceFiles.length > 0) ? eq.sourceFiles : (eq.sourceFile ? [eq.sourceFile] : []);
    const hasCoords = !!eq.coordinates;
    const coordSrc = hasCoords ? COORDINATE_SOURCES.DIRECT_3D : COORDINATE_SOURCES.NONE;
    const evidence = eqSourceFiles.length > 0
      ? eqSourceFiles.map(src => ev(src, eq.heading || eq.family || eq.capacity, null, coordSrc))
      : [ev(null, eq.heading || eq.family || eq.capacity, null, coordSrc)];
    const primaryEqSource = eqSourceFiles[0] || null;

    // Fix C: resolve host room
    let hostRoomId = null;
    const capCfm = eq.capacity ? (eq.capacity.match(/([0-9]+)\s*CFM/i) || [])[1] : null;
    if (capCfm) hostRoomId = cfmToRoomId.get(capCfm) || null;
    if (!hostRoomId && /ahu/i.test(eq.id)) hostRoomId = namePatternToRoomId.get('ahu') || null;
    if (!hostRoomId && /generator/i.test(eq.id)) hostRoomId = namePatternToRoomId.get('generator') || null;

    claims.push(buildClaim(
      CLAIM_KINDS.EQUIPMENT_INSTANCE,
      eq.id,
      {
        id: eq.id,
        type: 'EQUIPMENT',
        semanticType: eq.semanticType || 'IfcBuildingElementProxy',
        name: eq.heading || eq.family,
        geometry: {},
        // Fix B: use exact DXF coordinates when available
        placement: hasCoords
          ? { origin: { x: eq.coordinates.x, y: eq.coordinates.y, z: eq.coordinates.z } }
          : { origin: { x: 0, y: 0, z: 0 } },
        container: hostRoomId || 'level-0',
        relationships: hostRoomId ? [{ type: 'CONTAINED_IN', target: hostRoomId }] : [],
        properties: {
          family: eq.family,
          capacity: eq.capacity,
          outlet_diameter_m: eq.outlet_diameter_m ?? null,
          host: hostRoomId || null,
        },
      },
      {
        evidence,
        confidence: hasCoords ? 0.95 : 0.75,
        fieldConfidence: {
          dimensions: 0.40,
          placement: hasCoords ? 0.95 : (hostRoomId ? 0.60 : 0.10),
        },
        discipline: 'mechanical',
        aliases: [eq.heading || eq.family].filter(Boolean),
        provenance: provFor(primaryEqSource),
      }
    ));
  }

  // ---------- DUCT SPEC ----------
  if (parsed.ductSpec) {
    const ds = parsed.ductSpec;
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'duct-spec',
      {
        id: 'duct-spec',
        category: 'DUCT_SPEC',
        diameter_m: ds.diameter_m,
        total_segments: ds.total_segments,
        fan_outlet_9500_m: ds.fan_outlet_9500_m,
        fan_outlet_19000_m: ds.fan_outlet_19000_m,
        segment_lengths_m: ds.segment_lengths_m,
      },
      {
        evidence: [ev(ds.sourceFile, `Duct: ${ds.diameter_m} m diameter, ${ds.total_segments} segments`)],
        confidence: 0.95,
        discipline: 'mechanical',
        provenance: provFor(ds.sourceFile),
      }
    ));
  }

  // ---------- FITTING SPEC ----------
  // Stagger placeholder origins by index so multiple spec-text fittings don't
  // stack at the same point — collapsing in the generate-stage position dedup.
  if (parsed.fittingSpec) {
    const fittings = parsed.fittingSpec.fittings || [];
    fittings.forEach((f, i) => {
      claims.push(buildClaim(
        CLAIM_KINDS.FITTING_CANDIDATE,
        `fitting-type-${f.typeNumber}`,
        {
          id: `fitting-type-${f.typeNumber}`,
          type: 'DUCT_FITTING',
          semanticType: 'IfcDuctFitting',
          name: f.description,
          geometry: { diameter_m: f.diameter_m },
          placement: { origin: { x: i * 0.5, y: 0, z: 0 } },
          container: 'level-0',
          properties: {
            fittingKind: f.kind,
            instanceCount: f.count,
          },
        },
        {
          evidence: [ev(f.sourceFile, `${f.description} (${f.count} instances)`)],
          confidence: 0.90,
          discipline: 'mechanical',
          provenance: provFor(f.sourceFile),
        }
      ));
    });
  }

  // ---------- WALL SPEC ----------
  if (parsed.wallSpec) {
    const ws = parsed.wallSpec;
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'wall-spec',
      {
        id: 'wall-spec',
        category: 'WALL_SPEC',
        thickness_m: ws.thickness_m,
        heights: ws.heights,
        total_walls: ws.total_walls,
        material: ws.material,
      },
      {
        evidence: [ev(ws.sourceFile, `Wall spec: ${ws.thickness_m} m, ${ws.total_walls} walls`)],
        confidence: 0.90,
        discipline: 'structural',
        provenance: provFor(ws.sourceFile),
      }
    ));
  }

  // ---------- SLAB / CEILING SPEC ----------
  if (parsed.slabSpec) {
    const s = parsed.slabSpec;
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'slab-spec',
      {
        id: 'slab-spec',
        category: 'SLAB_SPEC',
        total_thickness_m: s.total_thickness_m,
        count: s.count,
      },
      {
        evidence: [ev(s.sourceFile, `Slab spec: ${s.total_thickness_m} m, ${s.count} instances`)],
        confidence: 0.90,
        discipline: 'structural',
        provenance: provFor(s.sourceFile),
      }
    ));
  }
  if (parsed.ceilingSpec) {
    const c = parsed.ceilingSpec;
    claims.push(buildClaim(
      CLAIM_KINDS.FACILITY_DIMENSION,
      'ceiling-spec',
      {
        id: 'ceiling-spec',
        category: 'CEILING_SPEC',
        thickness_m: c.thickness_m,
        count: c.count,
      },
      {
        evidence: [ev(c.sourceFile, `Ceiling spec: ${c.thickness_m} m, ${c.count} instances`)],
        confidence: 0.90,
        discipline: 'architectural',
        provenance: provFor(c.sourceFile),
      }
    ));
  }

  return { claims };
}
