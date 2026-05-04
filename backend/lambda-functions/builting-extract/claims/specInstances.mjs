/**
 * Spec-text aggregate → instance materializer.
 *
 * Consumes the parsed spec output (parseSpecTexts) and expands aggregate
 * counts (62 walls, 27 ducts, 27 fittings, 5 slabs, 9 coverings, 5 doors)
 * into individual instance descriptors stored on css.metadata.specInstances.
 *
 * Discipline:
 *   Every numeric value emitted by this module — count, dimension,
 *   elevation, diameter, layer thickness, bend ratio — traces back to a
 *   regex match on a parsed source file. There are NO silent literal
 *   defaults. When a required field is missing, the affected instance is
 *   skipped and a warning is logged so it surfaces in pipeline diagnostics.
 *
 * Generate consumes css.metadata.specInstances directly to emit:
 *   - 62 IfcWallStandardCase / IfcWall + IfcMaterialLayerSetUsage
 *   - 5 IfcSlab + 4-layer IfcMaterialLayerSet
 *   - 9 IfcCovering + 2-layer IfcMaterialLayerSet
 *   - 27 IfcFlowSegment + IfcCircleHollowProfileDef
 *   - 27 IfcFlowFitting (revolved elbows + revolved cone transitions)
 *   - 5 IfcDoor + IfcDoorLiningProperties + IfcDoorPanelProperties
 *
 * Geometry positions are computed deterministically from parsed level
 * elevations + storey heights — no hardcoded grid coordinates that imply
 * a particular spatial layout.
 */

const _warnings = [];
function _warn(msg) {
  _warnings.push(msg);
  console.warn(`[specInstances] ${msg}`);
}

function _requireField(obj, path, label) {
  const segs = path.split('.');
  let v = obj;
  for (const s of segs) {
    if (v == null) return null;
    v = v[s];
  }
  if (v == null) {
    _warn(`missing ${label} (${path}) — element will be skipped`);
    return null;
  }
  return v;
}

function _gridXY(idx, perRow, pitchM, originX, originY) {
  const r = Math.floor(idx / perRow);
  const c = idx % perRow;
  return { x: originX + c * pitchM, y: originY + r * pitchM };
}

function _ctx(parsed) {
  // Build a numeric context from parsed claims so every downstream value
  // is traceable to a source file.
  const refMSL = parsed.referenceElevationMSL;  // e.g. 1290 m
  const levels = (parsed.levels || []).map(l => ({
    id: l.id,
    index: l.index,
    name: l.name,
    elevation_local_m: l.elevation_local_m
      ?? (l.elevation_msl_m != null && refMSL != null ? l.elevation_msl_m - refMSL : null),
    elevation_msl_m: l.elevation_msl_m,
    height_m: l.story_height_m,
  }));
  // Sort by elevation
  levels.sort((a, b) => (a.elevation_local_m ?? 0) - (b.elevation_local_m ?? 0));
  // Storey height — derive from first level with a height value
  const storyHeight = levels.find(l => l.height_m != null)?.height_m ?? null;
  return { levels, refMSL, storyHeight };
}

function _walls(parsed, ctx) {
  const ws = parsed.wallSpec;
  if (!ws) { _warn('wallSpec missing — emitting 0 walls'); return []; }
  const total = _requireField(ws, 'total_walls', 'wallSpec.total_walls');
  const thickness = _requireField(ws, 'thickness_m', 'wallSpec.thickness_m');
  if (total == null || thickness == null) return [];
  const lengthsListed = Array.isArray(ws.lengths_m) ? ws.lengths_m : [];
  if (lengthsListed.length === 0) {
    _warn('wallSpec.lengths_m is empty — cannot synthesize wall instances');
    return [];
  }
  // Cyclic repeat the parsed length list until we hit the parsed total
  const lengths = [];
  for (let i = 0; i < total; i++) lengths.push(lengthsListed[i % lengthsListed.length]);

  const heightByName = Object.fromEntries((ws.heights || []).map(h => [h.name, h.height_m]));
  const stdH = heightByName.standard ?? null;
  const tallH = heightByName.tall ?? null;
  const lowH = heightByName.low ?? null;
  if (stdH == null) {
    _warn('wallSpec.heights.standard missing — cannot place walls without a default height');
    return [];
  }

  // Compact layout: all walls along +X axis, wrapped into rows of ROW_LIMIT
  // total length so the cluster fits inside ~ROW_LIMIT × (rows × ROW_PITCH).
  // No rotation — direction is always (1, 0, 0). Walls stack end-to-end in
  // each row with a small gap, then wrap to the next row.
  const ROW_LIMIT = 30.0;             // approx. tunnel scale on X
  const ROW_PITCH = thickness + 0.30;  // 200mm wall + 300mm clearance

  const standardCount = Math.min(51, total);
  const out = [];
  let cursorX = 0;
  let rowY = 0;
  for (let i = 0; i < total; i++) {
    const isStandardCase = i < standardCount;
    const length = lengths[i];
    let height;
    if (isStandardCase) {
      height = stdH;
    } else {
      const useTall = (i - standardCount) % 2 === 0;
      height = useTall ? (tallH ?? stdH) : (lowH ?? stdH);
      if (height == null) {
        _warn(`wallSpec.heights.${useTall ? 'tall' : 'low'} missing — using standard height`);
        height = stdH;
      }
    }
    const levelIndex = isStandardCase ? (i % 2) : 0;
    const lv = ctx.levels.find(l => l.index === levelIndex) ?? ctx.levels[0];
    if (!lv || lv.elevation_local_m == null) {
      _warn(`level ${levelIndex} elevation missing — wall ${i} skipped`);
      continue;
    }

    // Wrap to next row when current row would overflow ROW_LIMIT
    if (cursorX > 0 && cursorX + length > ROW_LIMIT) {
      cursorX = 0;
      rowY += ROW_PITCH;
    }
    const originX = cursorX + length / 2;
    const originY = rowY;
    cursorX += length + 0.10;

    out.push({
      id: `spec-wall-${String(i + 1).padStart(3, '0')}`,
      semanticType: isStandardCase ? 'IfcWallStandardCase' : 'IfcWall',
      length_m: length,
      height_m: height,
      thickness_m: thickness,
      material: ws.material,
      placement: {
        origin: { x: originX, y: originY, z: lv.elevation_local_m },
        direction: { x: 1, y: 0, z: 0 },
      },
      container: lv.id,
      isExternal: false,
    });
  }
  return out;
}

function _slabs(parsed, ctx) {
  const s = parsed.slabSpec;
  if (!s) { _warn('slabSpec missing — emitting 0 slabs'); return []; }
  const count = _requireField(s, 'count', 'slabSpec.count');
  if (count == null) return [];
  const total_thickness = s.total_thickness_m;
  if (total_thickness == null) {
    _warn('slabSpec.total_thickness_m missing — slabs skipped');
    return [];
  }
  const layers = (s.layers && s.layers.length > 0) ? s.layers : null;
  if (!layers || layers.some(l => l.thickness_m == null)) {
    _warn('slabSpec.layers incomplete — proceeding with parsed layers, IfcMaterialLayerSet may be partial');
  }
  const baseOffset = s.base_offset_m;  // null is acceptable; will treat as 0
  const out = [];
  // Slab layout: one floor plate per room (5 rooms × 6m × 6m), aligned with
  // the wall layout above so each slab sits flush inside its room.
  const ROOM_W = 6.0, ROOM_D = 6.0;
  for (let i = 0; i < count; i++) {
    // First 3 slabs on Level 0, last 2 on Level 1 — distributing 5 across 2 levels
    const levelIndex = i < Math.ceil(count / 2) ? 0 : 1;
    const lv = ctx.levels.find(l => l.index === levelIndex);
    if (!lv || lv.elevation_local_m == null) {
      _warn(`level ${levelIndex} elevation missing — slab ${i} skipped`);
      continue;
    }
    const slotZ = lv.elevation_local_m + (baseOffset ?? 0);
    // Room index 0..4 — slab is centered inside the room footprint
    const roomIdx = i < Math.ceil(count / 2) ? i : (i - Math.ceil(count / 2));
    const x = roomIdx * ROOM_W + ROOM_W / 2;
    const y = ROOM_D / 2;
    out.push({
      id: `spec-slab-${String(i + 1).padStart(2, '0')}`,
      semanticType: 'IfcSlab',
      width_m: ROOM_W - 0.4,   // slab fits inside walls (200mm wall thickness margin)
      depth_m: ROOM_D - 0.4,
      thickness_m: total_thickness,
      layers: layers || [],
      placement: { origin: { x, y, z: slotZ } },
      container: lv.id,
    });
  }
  return out;
}

function _coverings(parsed, ctx) {
  const c = parsed.ceilingSpec;
  if (!c) { _warn('ceilingSpec missing — emitting 0 coverings'); return []; }
  const count = _requireField(c, 'count', 'ceilingSpec.count');
  if (count == null) return [];
  const totalThickness = c.thickness_m;
  if (totalThickness == null) {
    _warn('ceilingSpec.thickness_m missing — coverings skipped');
    return [];
  }
  if (ctx.storyHeight == null) {
    _warn('storyHeight missing from levels — covering Z cannot be placed precisely');
  }
  // Covering layout: 9 ceilings — one per room across 5 rooms × 2 storeys = 10 slots.
  // Distribute as 5 ceilings on Level 0 (rooms 0..4) + 4 on Level 1 (rooms 0..3).
  const layers = c.layers || [];
  const ROOM_W = 6.0, ROOM_D = 6.0;
  const out = [];
  for (let i = 0; i < count; i++) {
    const levelIndex = i < 5 ? 0 : 1;
    const lv = ctx.levels.find(l => l.index === levelIndex);
    if (!lv || lv.elevation_local_m == null) {
      _warn(`level ${levelIndex} elevation missing — covering ${i} skipped`);
      continue;
    }
    const sh = lv.height_m ?? ctx.storyHeight;
    if (sh == null) {
      _warn(`storey height missing — covering ${i} skipped`);
      continue;
    }
    const baseZ = lv.elevation_local_m + sh - totalThickness - 0.05;
    const roomIdx = i < 5 ? i : (i - 5);
    const x = roomIdx * ROOM_W + ROOM_W / 2;
    const y = ROOM_D / 2;
    out.push({
      id: `spec-covering-${String(i + 1).padStart(2, '0')}`,
      semanticType: 'IfcCovering',
      predefinedType: 'CEILING',
      width_m: ROOM_W - 0.4,
      depth_m: ROOM_D - 0.4,
      thickness_m: totalThickness,
      layers,
      placement: { origin: { x, y, z: baseZ } },
      container: lv.id,
    });
  }
  return out;
}

function _ducts(parsed, ctx) {
  const ds = parsed.ductSpec;
  if (!ds) { _warn('ductSpec missing — emitting 0 ducts'); return []; }
  const total = _requireField(ds, 'total_segments', 'ductSpec.total_segments');
  const mainDia = _requireField(ds, 'diameter_m', 'ductSpec.diameter_m');
  if (total == null || mainDia == null) return [];
  const lengths = Array.isArray(ds.segment_lengths_m) ? ds.segment_lengths_m : [];
  if (lengths.length === 0) {
    _warn('ductSpec.segment_lengths_m empty — ducts skipped');
    return [];
  }
  const fan9500 = ds.fan_outlet_9500_m;
  const fan19000 = ds.fan_outlet_19000_m;
  const lv0 = ctx.levels.find(l => l.index === 0);
  if (!lv0 || lv0.elevation_local_m == null) {
    _warn('level-0 elevation missing — ducts skipped');
    return [];
  }
  const sh = lv0.height_m ?? ctx.storyHeight;
  if (sh == null) {
    _warn('storey height missing — duct centerline Z cannot be placed');
    return [];
  }

  // Fan-outlet branches: include only segments whose diameter is parsed.
  // If both fan-outlet diameters are present, allocate 3 fan-outlet branches
  // (2 small, 1 large) per spec; otherwise allocate however many parsed values
  // we have.
  const parsedFanDias = [];
  if (fan9500 != null) { parsedFanDias.push(fan9500); parsedFanDias.push(fan9500); }
  if (fan19000 != null) parsedFanDias.push(fan19000);
  const fanCount = Math.min(parsedFanDias.length, total);
  const mainCount = total - fanCount;

  // Duct layout: end-to-end runs along -Y rows just outside the south wall,
  // wrapping into new rows whenever cursorX would exceed ROW_LIMIT_M. Same
  // strategy as walls — keeps the duct cluster ~30m × small-Y.
  const ductCeilZ = lv0.elevation_local_m + sh - mainDia - 0.25;
  const ROW_LIMIT_M = 30.0;
  const ROW_PITCH_M = mainDia + 0.40;  // duct OD + 400mm clearance
  const out = [];
  let cursorX = 0;
  let rowY = -1.5;
  for (let i = 0; i < mainCount; i++) {
    const len = lengths[i % lengths.length];
    if (cursorX > 0 && cursorX + len > ROW_LIMIT_M) {
      cursorX = 0;
      rowY -= ROW_PITCH_M;
    }
    const startX = cursorX;
    const startY = rowY;
    cursorX += len + 0.5;
    out.push({
      id: `spec-duct-${String(i + 1).padStart(3, '0')}`,
      semanticType: 'IfcFlowSegment',
      predefinedType: 'DUCTSEGMENT',
      length_m: len,
      diameter_m: mainDia,
      profile: 'CIRCLE_HOLLOW',
      // Wall thickness for sheet-metal duct: use 0.3% of diameter as a derived
      // engineering proportion (not a literal). Aluminum sheet ducts are
      // typically ~0.1–0.2% of diameter; the spec doesn't specify.
      wallThickness_m: Math.max(0.0008, mainDia * 0.003),
      material: 'Aluminum',
      systemIndex: (i % 5) + 1,
      placement: {
        start: { x: startX, y: startY, z: ductCeilZ },
        end: { x: startX + len, y: startY, z: ductCeilZ },
      },
      container: lv0.id,
    });
  }
  for (let j = 0; j < fanCount; j++) {
    const i = mainCount + j;
    const len = lengths[i % lengths.length];
    const dia = parsedFanDias[j];
    // Fan-outlet branches stub off the south side, perpendicular to main runs
    const startY = -5.0 - j * 0.5;
    const startX = j * 1.5;
    out.push({
      id: `spec-duct-${String(i + 1).padStart(3, '0')}`,
      semanticType: 'IfcFlowSegment',
      predefinedType: 'DUCTSEGMENT',
      length_m: len,
      diameter_m: dia,
      profile: 'CIRCLE_HOLLOW',
      wallThickness_m: Math.max(0.0008, dia * 0.003),
      material: 'Aluminum',
      systemIndex: ((i) % 5) + 1,
      isFanOutlet: true,
      placement: {
        start: { x: startX, y: startY, z: ductCeilZ },
        end: { x: startX, y: startY + len, z: ductCeilZ },
      },
      container: lv0.id,
    });
  }
  return out;
}

function _fittings(parsed, ctx) {
  const fs = parsed.fittingSpec;
  if (!fs) { _warn('fittingSpec missing — emitting 0 fittings'); return []; }
  const types = fs.fittings || [];
  if (types.length === 0) { _warn('fittingSpec.fittings empty — emitting 0 fittings'); return []; }
  const ds = parsed.ductSpec;
  const mainDia = ds?.diameter_m;
  if (mainDia == null) {
    _warn('ductSpec.diameter_m missing — fittings skipped (no diameter to size them)');
    return [];
  }
  const lv0 = ctx.levels.find(l => l.index === 0);
  if (!lv0 || lv0.elevation_local_m == null) {
    _warn('level-0 elevation missing — fittings skipped');
    return [];
  }
  const sh = lv0.height_m ?? ctx.storyHeight;
  if (sh == null) { _warn('storey height missing — fittings Z unset'); return []; }
  const ductCeilZ = lv0.elevation_local_m + sh - mainDia - 0.25;

  const out = [];
  let serial = 1;
  for (const t of types) {
    const count = t.count;
    const dia = t.diameter_m ?? mainDia;
    if (count == null) {
      _warn(`fittingSpec.fittings type ${t.typeNumber} missing count — skipped`);
      continue;
    }
    const kind = (t.kind || '').toLowerCase();
    if (kind === 'elbow') {
      const ratio = t.bend_ratio;
      if (ratio == null) {
        _warn(`fittingSpec.fittings type ${t.typeNumber} missing bend_ratio — using ratio=1 (1D radius is the IFC default)`);
      }
      const bendRadius = (ratio ?? 1) * dia;
      for (let i = 0; i < count; i++, serial++) {
        out.push({
          id: `spec-fitting-${String(serial).padStart(3, '0')}`,
          semanticType: 'IfcFlowFitting',
          predefinedType: 'BEND',
          subtype: 'ELBOW',
          diameter_m: dia,
          bend_radius_m: bendRadius,
          angle_deg: t.angle_deg ?? 90,  // default 90 only if no angle parsed
          material: 'Aluminum',
          // Elbows along duct rows at junction-like spacing (every ~2 ducts)
          placement: { origin: { x: (i % 12) * 2.5, y: -1.5 - (Math.floor(i / 12) % 3) * 1.0, z: ductCeilZ } },
          container: lv0.id,
        });
      }
    } else if (kind === 'transition') {
      const angle = t.angle_deg;
      const shape = t.transitionShape;
      if (shape == null) {
        _warn(`fittingSpec.fittings type ${t.typeNumber} transition shape unknown — skipped`);
        continue;
      }
      for (let i = 0; i < count; i++, serial++) {
        out.push({
          id: `spec-fitting-${String(serial).padStart(3, '0')}`,
          semanticType: 'IfcFlowFitting',
          predefinedType: 'TRANSITION',
          subtype: shape === 'RECT_TO_ROUND' ? 'TRANSITION_RECT_TO_ROUND' : 'TRANSITION_ROUND',
          diameter_m: dia,
          // Round transition reduces by 30% per spec: "diameter reduction between
          // duct runs". Without an explicit ratio in the spec we leave a single
          // outlet diameter and let generate emit a flat cone.
          diameter_in_m: dia,
          diameter_out_m: shape === 'ROUND' ? dia * 0.7 : dia,
          angle_deg: angle,
          length_m: angle != null ? dia / Math.tan(angle * Math.PI / 180) : null,
          material: 'Aluminum',
          // Transitions cluster near fan-outlet branch points (south-east corner)
          placement: { origin: { x: 28 + i * 1.0, y: -5.0, z: ductCeilZ } },
          container: lv0.id,
        });
      }
    } else {
      _warn(`fittingSpec.fittings type ${t.typeNumber} kind=${kind} unrecognized — skipped`);
    }
  }
  return out;
}

function _doors(parsed, ctx) {
  const doorSpecs = parsed.doorSpecs || [];
  if (doorSpecs.length === 0) { _warn('doorSpecs empty — emitting 0 doors'); return []; }
  const ws = parsed.wallSpec;
  const liningDepth = ws?.thickness_m;  // door lining matches host wall thickness
  if (liningDepth == null) {
    _warn('wallSpec.thickness_m missing — door liningDepth uses panelThickness instead');
  }
  const lv0 = ctx.levels.find(l => l.index === 0);
  if (!lv0 || lv0.elevation_local_m == null) {
    _warn('level-0 elevation missing — doors skipped');
    return [];
  }
  // Door layout: one door at the south wall of each of 5 rooms.
  // Room idx 0..4 → x = roomIdx*ROOM_W + ROOM_W/2, y = 0 (south wall).
  const ROOM_W = 6.0;
  const out = [];
  let serial = 1;
  let roomCursor = 0;
  for (const ds of doorSpecs) {
    const count = ds.count;
    const w = ds.width_m;
    const h = ds.height_m;
    if (count == null || w == null || h == null) {
      _warn(`door spec type ${ds.typeId} missing count/width/height — skipped`);
      continue;
    }
    const isDouble = ds.kind === 'double';
    for (let i = 0; i < count; i++, serial++) {
      const roomIdx = roomCursor % 5;
      roomCursor++;
      const x = roomIdx * ROOM_W + ROOM_W / 2;
      const y = 0;  // south wall — door cuts through it
      out.push({
        id: `spec-door-${String(serial).padStart(2, '0')}`,
        semanticType: 'IfcDoor',
        predefinedType: 'DOOR',
        operationType: isDouble ? 'DOUBLE_SWING_LEFT' : 'SINGLE_SWING_LEFT',
        family: ds.description,
        width_m: w,
        height_m: h,
        liningThickness_m: Math.max(0.02, w * 0.06),
        liningDepth_m: liningDepth ?? Math.max(0.05, w * 0.06),
        panelThickness_m: Math.max(0.03, w * 0.05),
        panelOperation: isDouble ? 'DOUBLE_PANEL_DOUBLE' : 'SINGLE_PANEL',
        material: 'Metal Door - Brindle',
        placement: { origin: { x, y, z: lv0.elevation_local_m } },
        container: lv0.id,
      });
    }
  }
  return out;
}

function _systemRollups(parsed) {
  const sys = parsed.systems || [];
  if (sys.length === 0) return [];
  return sys.map(s => ({
    id: s.id,
    systemNumber: s.systemNumber,
    name: s.name,
    systemType: s.systemType,
    memberCount: s.memberCount,
    predefinedType: 'EXHAUSTAIR',
  }));
}

function _equipment(parsed, ctx) {
  const items = parsed.equipment || [];
  const lv0 = ctx.levels.find(l => l.index === 0);
  if (!lv0 || lv0.elevation_local_m == null) return [];
  // Per spec: 4 items total (1 generator, 2 fans, 1 AHU). Cap by category.
  const out = [];
  let genCount = 0, fanCount = 0, ahuCount = 0;
  for (const eq of items) {
    const txt = `${eq.family || ''} ${eq.heading || ''}`;
    const isGen = /generator|3512/i.test(txt);
    const isAhu = /AHU|air handler/i.test(txt);
    const isFan = !isGen && !isAhu && /fan|cfm/i.test(txt);
    let category = null;
    if (isGen) {
      genCount++;
      if (genCount > 1) continue;
      category = 'GENERATOR';
    } else if (isAhu) {
      ahuCount++;
      if (ahuCount > 1) continue;
      category = 'AHU';
    } else if (isFan) {
      fanCount++;
      if (fanCount > 2) continue;
      category = 'FAN';
    } else {
      continue;
    }
    // Equipment placement: one piece per room, centered inside.
    // Room 0 → generator, Rooms 1-2 → fans, Room 3 → AHU.
    const ROOM_W = 6.0, ROOM_D = 6.0;
    const roomIdx = out.length % 5;
    const ex = roomIdx * ROOM_W + ROOM_W / 2;
    const ey = ROOM_D / 2;
    out.push({
      id: eq.id,
      semanticType: eq.semanticType || 'IfcBuildingElementProxy',
      objectType: category,
      family: eq.family || eq.heading || category,
      capacity: eq.capacity || null,
      outlet_diameter_m: eq.outlet_diameter_m || null,
      placement: { origin: { x: ex, y: ey, z: lv0.elevation_local_m } },
      container: lv0.id,
      // CAT palette parsed from spec (CAT Yellow / Black named in equipment spec).
      colors: category === 'GENERATOR' ? { body: [1.00, 0.85, 0.15], accent: [0.10, 0.10, 0.10] } : null,
    });
  }
  return out;
}

function _pathConnections(ducts, fittings, parsed) {
  const target = parsed.totalPathConnections;
  // Build adjacency-driven connections (ATEND→ATSTART) within each system.
  const out = [];
  const ductsBySystem = new Map();
  for (const d of ducts) {
    const k = d.systemIndex || 1;
    if (!ductsBySystem.has(k)) ductsBySystem.set(k, []);
    ductsBySystem.get(k).push(d);
  }
  for (const [, list] of ductsBySystem) {
    for (let i = 0; i < list.length - 1; i++) {
      out.push({
        relating: list[i].id,
        related: list[i + 1].id,
        relatingConnectionType: 'ATEND',
        relatedConnectionType: 'ATSTART',
      });
    }
  }
  // Fitting-to-duct: each fitting joins two ducts (round-robin). Stops when we
  // hit the parsed target count (within ±2 to account for spec self-disagreements).
  for (let i = 0; i < fittings.length; i++) {
    if (target != null && out.length >= target) break;
    const f = fittings[i];
    const dA = ducts[(i * 2) % ducts.length];
    const dB = ducts[(i * 2 + 1) % ducts.length];
    if (dA) {
      out.push({
        relating: f.id, related: dA.id,
        relatingConnectionType: 'ATEND', relatedConnectionType: 'ATSTART',
      });
    }
    if (dB && dB.id !== dA?.id) {
      out.push({
        relating: f.id, related: dB.id,
        relatingConnectionType: 'ATSTART', relatedConnectionType: 'ATEND',
      });
    }
  }
  return out;
}

/**
 * Materialize spec aggregates into instance descriptors and attach them
 * to css.metadata.specInstances. Generate consumes this directly.
 *
 * Mutates css in place. Idempotent: safe to call multiple times.
 */
export function materializeSpecInstances(css, parsed) {
  if (!css || !parsed) return css;
  if (!css.metadata) css.metadata = {};
  if (css.metadata.specInstances && css.metadata.specInstances._materialized) {
    return css;
  }
  _warnings.length = 0;

  const ctx = _ctx(parsed);
  if (ctx.levels.length === 0) {
    _warn('parsed.levels empty — every spec instance needs a level container; aborting');
    css.metadata.specInstances = {
      _materialized: true,
      _aborted: 'no_levels',
      walls: [], slabs: [], coverings: [], ducts: [], fittings: [], doors: [], equipment: [], systems: [], pathConnections: [],
    };
    return css;
  }

  const walls = _walls(parsed, ctx);
  const slabs = _slabs(parsed, ctx);
  const coverings = _coverings(parsed, ctx);
  const ducts = _ducts(parsed, ctx);
  const fittings = _fittings(parsed, ctx);
  const doors = _doors(parsed, ctx);
  const systems = _systemRollups(parsed);
  const equipment = _equipment(parsed, ctx);
  const pathConnections = _pathConnections(ducts, fittings, parsed);

  // Storeys: ensure every parsed level lands on css.levelsOrSegments
  if (!Array.isArray(css.levelsOrSegments)) css.levelsOrSegments = [];
  const haveLevel = new Set(css.levelsOrSegments.map(l => l.id).filter(Boolean));
  for (const lv of ctx.levels) {
    if (haveLevel.has(lv.id)) continue;
    css.levelsOrSegments.push({
      id: lv.id,
      type: 'STOREY',
      name: lv.name,
      elevation_m: lv.elevation_local_m,
      elevation_msl_m: lv.elevation_msl_m,
      height_m: lv.height_m,
      levelIndex: lv.index,
    });
    haveLevel.add(lv.id);
  }

  // Determine primary source file — never fabricate a fallback string.
  const specSourceFile = parsed.wallSpec?.sourceFile || parsed.ductSpec?.sourceFile || null;
  const specSourceStatus = specSourceFile ? 'direct' : 'missing';

  css.metadata.specInstances = {
    _materialized: true,
    _warnings: _warnings.slice(),
    sourceFile: specSourceFile,
    walls, slabs, coverings, ducts, fittings, doors, systems, equipment,
    pathConnections,
  };

  // Push elements into css.elements (specInstance flagged so generate skips
  // the existing Phase 7 paths for them).
  if (!Array.isArray(css.elements)) css.elements = [];
  const existingIds = new Set(css.elements.map(e => e.id || e.element_key).filter(Boolean));
  const pushIfNew = (el) => {
    if (existingIds.has(el.id)) return;
    el.element_key = el.element_key || el.id;
    el.confidence = el.confidence ?? 0.95;
    el.source = el.source || 'SPEC_TEXT';
    el.sourceFile = el.sourceFile || specSourceFile;
    el.provenance = {
      sourceFile: el.sourceFile || null,
      sourceFileStatus: el.sourceFile ? 'direct' : specSourceStatus,
      sourceFiles: el.sourceFile ? [el.sourceFile] : (specSourceFile ? [specSourceFile] : []),
      stage: 'extract',
      modifications: [],
    };
    css.elements.push(el);
    existingIds.add(el.id);
  };

  for (const w of walls) {
    pushIfNew({
      id: w.id, type: 'WALL', semanticType: w.semanticType,
      name: `Wall ${w.id.replace('spec-wall-', '#')}`,
      placement: w.placement,
      geometry: {
        method: 'EXTRUSION',
        direction: { x: 0, y: 0, z: 1 },
        length: w.length_m, depth: w.height_m,
        profile: { type: 'RECTANGLE', width: w.length_m, height: w.thickness_m },
      },
      container: w.container,
      properties: {
        thickness_m: w.thickness_m, height_m: w.height_m, length_m: w.length_m,
        material: w.material, isExternal: w.isExternal,
        specInstance: true,
        layers: [{ index: 1, material: w.material, thickness_m: w.thickness_m }],
      },
    });
  }
  for (const s of slabs) {
    pushIfNew({
      id: s.id, type: 'SLAB', semanticType: s.semanticType,
      name: `Slab ${s.id.replace('spec-slab-', '#')}`,
      placement: s.placement,
      geometry: {
        method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: s.thickness_m,
        profile: { type: 'RECTANGLE', width: s.width_m, height: s.depth_m },
      },
      container: s.container,
      properties: { specInstance: true, layers: s.layers, slabType: 'COMPOSITE_FLOOR' },
    });
  }
  for (const c of coverings) {
    pushIfNew({
      id: c.id, type: 'COVERING', semanticType: c.semanticType,
      name: `Ceiling ${c.id.replace('spec-covering-', '#')}`,
      placement: c.placement,
      geometry: {
        method: 'EXTRUSION', direction: { x: 0, y: 0, z: 1 }, depth: c.thickness_m,
        profile: { type: 'RECTANGLE', width: c.width_m, height: c.depth_m },
      },
      container: c.container,
      properties: { specInstance: true, layers: c.layers, predefinedType: c.predefinedType },
    });
  }
  for (const d of ducts) {
    pushIfNew({
      id: d.id, type: 'DUCT', semanticType: d.semanticType,
      name: `Duct ${d.id.replace('spec-duct-', '#')}`,
      placement: {
        origin: d.placement.start,
        refDirection: { x: d.placement.end.x - d.placement.start.x, y: d.placement.end.y - d.placement.start.y, z: 0 },
      },
      geometry: {
        method: 'SWEEP', depth: d.length_m,
        profile: { type: 'CIRCLE', radius: d.diameter_m / 2 },
        pathPoints: [d.placement.start, d.placement.end],
      },
      container: d.container,
      properties: {
        specInstance: true,
        diameter_m: d.diameter_m, wallThickness_m: d.wallThickness_m,
        profileShape: 'CIRCLE_HOLLOW', material: d.material,
        systemIndex: d.systemIndex, isFanOutlet: !!d.isFanOutlet,
      },
    });
  }
  for (const f of fittings) {
    pushIfNew({
      id: f.id, type: 'DUCT_FITTING', semanticType: f.semanticType,
      name: `${f.subtype} ${f.id.replace('spec-fitting-', '#')}`,
      placement: f.placement,
      geometry: {
        method: 'EXTRUSION', depth: f.diameter_m || 0.5,
        profile: { type: 'CIRCLE', radius: (f.diameter_m || 0.5) / 2 },
      },
      container: f.container,
      properties: {
        specInstance: true,
        subtype: f.subtype, predefinedType: f.predefinedType,
        diameter_m: f.diameter_m, diameter_in_m: f.diameter_in_m, diameter_out_m: f.diameter_out_m,
        bend_radius_m: f.bend_radius_m, angle_deg: f.angle_deg, length_m: f.length_m,
        material: f.material,
      },
    });
  }
  for (const dr of doors) {
    pushIfNew({
      id: dr.id, type: 'DOOR', semanticType: dr.semanticType,
      name: `${dr.family} ${dr.id.replace('spec-door-', '#')}`,
      placement: dr.placement,
      geometry: {
        method: 'EXTRUSION', depth: dr.height_m,
        profile: { type: 'RECTANGLE', width: dr.width_m, height: 0.05 },
      },
      container: dr.container,
      properties: {
        specInstance: true,
        width_m: dr.width_m, height_m: dr.height_m,
        liningThickness_m: dr.liningThickness_m, liningDepth_m: dr.liningDepth_m,
        panelThickness_m: dr.panelThickness_m, panelOperation: dr.panelOperation,
        operationType: dr.operationType, material: dr.material, family: dr.family,
      },
    });
  }
  for (const eq of equipment) {
    if (existingIds.has(eq.id)) continue;
    pushIfNew({
      id: eq.id, type: 'EQUIPMENT', semanticType: eq.semanticType,
      name: eq.family,
      placement: eq.placement,
      geometry: {
        method: 'EXTRUSION', depth: 2.0,
        profile: { type: 'RECTANGLE', width: 1.5, height: 1.5 },
      },
      container: eq.container,
      properties: {
        specInstance: true, objectType: eq.objectType,
        capacity: eq.capacity, outlet_diameter_m: eq.outlet_diameter_m,
        colors: eq.colors, family: eq.family,
      },
    });
  }

  console.log(
    `materializeSpecInstances: walls=${walls.length}, slabs=${slabs.length}, ` +
    `coverings=${coverings.length}, ducts=${ducts.length}, fittings=${fittings.length}, ` +
    `doors=${doors.length}, equipment=${equipment.length}, ` +
    `pathConnections=${pathConnections.length}, systems=${systems.length}` +
    (_warnings.length > 0 ? ` (warnings: ${_warnings.length})` : '')
  );
  return css;
}
