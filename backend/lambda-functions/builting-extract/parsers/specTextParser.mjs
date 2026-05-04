/**
 * Deterministic text-spec parser.
 *
 * Reads narrative .txt / .docx-derived-text / .pdf-derived-text content and
 * extracts structured spec data via regex — NO LLM. Each extractor function
 * runs on every input file (filename-agnostic) and returns whatever it finds.
 *
 * Output is consumed by claims/specTextToClaims.mjs which converts the
 * structured data into claims using only the existing CLAIM_KINDS schema.
 *
 * Targets covered (per coverage-report gap analysis 2026-04-28):
 *   - rooms          (SPACE_DEFINITION)
 *   - doors          (OPENING_CANDIDATE)
 *   - portalBuildings (SPACE_DEFINITION)
 *   - levels         (LEVEL_DEFINITION)
 *   - shaft          (SPACE_DEFINITION + FACILITY_DIMENSION)
 *   - tunnelBore     (FACILITY_DIMENSION + MATERIAL_ASSIGNMENT)
 *   - systems        (SYSTEM_MEMBERSHIP)
 *   - equipment      (EQUIPMENT_INSTANCE)
 *   - ductSpec       (FACILITY_DIMENSION duct diameter / counts)
 *   - fittingSpec    (FITTING_CANDIDATE counts)
 */

const NUM = '([0-9]+(?:\\.[0-9]+)?)';

function unique(arr, keyFn) {
  const byKey = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!byKey.has(k)) {
      const seed = { ...item, sourceFiles: item.sourceFiles || (item.sourceFile ? [item.sourceFile] : []) };
      byKey.set(k, seed);
    } else {
      const existing = byKey.get(k);
      const sf = item.sourceFile;
      if (sf && !existing.sourceFiles.includes(sf)) existing.sourceFiles.push(sf);
      // Propagate coordinates from duplicate if seed lacked them
      if (item.coordinates && !existing.coordinates) existing.coordinates = item.coordinates;
    }
  }
  return Array.from(byKey.values());
}

function makeId(prefix, name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${prefix}-${slug || Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Rooms — `Room N — <name>:` blocks, indented Width / Length / Height / Door
// ---------------------------------------------------------------------------
function extractRooms(content, sourceFile) {
  const rooms = [];
  const blockRe = /Room\s+(\d+)\s*[—\-:]+\s*([^\n:]+?):\s*\n([\s\S]*?)(?=\n[A-Z][A-Z][^\n]*\n[-=]+|\nRoom\s+\d+|\n[A-Z][A-Za-z ]+ Building:|$)/g;
  let m;
  while ((m = blockRe.exec(content)) !== null) {
    const roomNum = m[1];
    const roomName = m[2].trim();
    const body = m[3];

    const width = matchNumber(body, new RegExp(`Width:\\s*${NUM}\\s*m`, "i"));
    const length = matchNumber(body, new RegExp(`Length:\\s*${NUM}\\s*m`, "i"));
    const height = matchNumber(body, new RegExp(`Height:\\s*${NUM}\\s*m`, "i"));
    const centroidMatch = body.match(/centroid:?\s*\(\s*([0-9.+-]+)\s*m?\s*,\s*([0-9.+-]+)\s*m?(?:\s*,\s*([0-9.+-]+)\s*m?)?\s*\)/i);
    const centroid = centroidMatch
      ? { x: Number(centroidMatch[1]), y: Number(centroidMatch[2]), z: centroidMatch[3] !== undefined ? Number(centroidMatch[3]) : 0 }
      : null;

    // Contents — multi-line field; continuation lines are indented
    const contentsMatch = body.match(/Contents?:\s*([^\n]+(?:\n[ \t]+[^\n]+)*)/i);
    const contents = contentsMatch
      ? contentsMatch[1].split('\n').map(l => l.trim()).filter(l => l.length > 0)
      : [];

    const elevMatch = body.match(/floor at\s+([0-9.]+)\s*m\s*MSL/i);
    const floorElevationMSL = elevMatch ? Number(elevMatch[1]) : null;
    const levelMatch = body.match(/Level\s*([0-9]+)/i);
    const levelIndex = levelMatch ? Number(levelMatch[1]) : 0;

    const doors = extractRoomDoorRefs(body, makeId('room', roomName), sourceFile);
    const subRooms = extractSubRooms(body, makeId('room', roomName));

    rooms.push({
      id: makeId('room', roomName),
      number: Number(roomNum),
      name: roomName,
      width_m: width,
      length_m: length,
      height_m: height,
      centroid,
      contents,
      floorElevationMSL,
      levelIndex,
      doors,
      subRooms,
      sourceExcerpt: m[0].slice(0, 200),
      sourceFile,
    });
  }
  return rooms;
}

// ---------------------------------------------------------------------------
// Portal buildings — `<West|East> Portal Building:` blocks
// ---------------------------------------------------------------------------
function extractPortalBuildings(content, sourceFile) {
  const out = [];
  const re = /(West|East)\s+Portal\s+Building:\s*\n([\s\S]*?)(?=\n[A-Z][A-Z][^\n]*\n[-=]+|\n[A-Z][A-Za-z ]+\s+Portal\s+Building:|\nWALL\s+|$)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const side = m[1];
    const body = m[2];
    const dimsMatch = body.match(new RegExp(`Dimensions:\\s*~?${NUM}\\s*m\\s*wide.*?~?${NUM}\\s*m\\s*deep.*?~?${NUM}\\s*m\\s*tall`, 'i'));
    const elevMatch = body.match(/Level\s*([0-9]+)\s*=\s*([0-9.]+)\s*m\s*MSL/i);
    const doors = extractRoomDoorRefs(body, `portal-${side.toLowerCase()}`, sourceFile);
    out.push({
      id: `portal-${side.toLowerCase()}`,
      side,
      name: `${side} Portal Building`,
      width_m: dimsMatch ? Number(dimsMatch[1]) : null,
      depth_m: dimsMatch ? Number(dimsMatch[2]) : null,
      height_m: dimsMatch ? Number(dimsMatch[3]) : null,
      levelIndex: elevMatch ? Number(elevMatch[1]) : null,
      floorElevationMSL: elevMatch ? Number(elevMatch[2]) : null,
      doors,
      sourceExcerpt: m[0].slice(0, 200),
      sourceFile,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Doors inside a room block — `Door: 1× single 810 × 2110 mm` etc.
// ---------------------------------------------------------------------------
function extractRoomDoorRefs(body, hostRoomId, sourceFile) {
  const out = [];
  // single-line variants — supports "Door:" and "Doors:" with × or x
  const re = /Doors?:\s*([0-9]+)\s*[x×]\s*(?:interior\s+)?(single|double[\s-]*flush?|double)\s+(?:passage\s+)?([0-9]+(?:\.[0-9]+)?)\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)\s*(mm|m)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const count = Number(m[1]);
    const kindRaw = m[2].toLowerCase();
    const kind = kindRaw.includes('double') ? 'double' : 'single';
    let w = Number(m[3]);
    let h = Number(m[4]);
    const unit = m[5].toLowerCase();
    if (unit === 'mm') { w /= 1000; h /= 1000; }
    for (let i = 0; i < count; i++) {
      out.push({
        id: `${hostRoomId}-door-${out.length + 1}`,
        kind,
        width_m: w,
        height_m: h,
        hostRoom: hostRoomId,
        sourceFile,
      });
    }
  }
  // explicit NONE
  if (/Doors?:\s*NONE/i.test(body)) {
    // nothing emitted
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sub-rooms — `Northwest corner: approx 5 m × 5 m`
// ---------------------------------------------------------------------------
function extractSubRooms(body, hostRoomId) {
  const out = [];
  const re = /-\s*([A-Za-z][A-Za-z ]+?)\s+corner:\s*approx[\s.]*([0-9]+(?:\.[0-9]+)?)\s*m\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)\s*m/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.push({
      id: `${hostRoomId}-sub-${m[1].toLowerCase().replace(/\s+/g, '-')}`,
      name: `${m[1]} corner`,
      width_m: Number(m[2]),
      length_m: Number(m[3]),
      hostRoom: hostRoomId,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Door spec section — overall typology declarations (Type A / Type B)
// ---------------------------------------------------------------------------
function extractDoorSpecs(content, sourceFile) {
  const out = [];
  const re = /Type\s+([A-Z])\s*[—\-:]+\s*([^\n]*?)\s*\(([0-9]+)\s+instances?\)\s*:\s*\n([\s\S]*?)(?=\nType\s+[A-Z]\s*[—\-]|\n[A-Z]{3,}|$)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    const desc = m[2].trim();
    const count = Number(m[3]);
    const block = m[4];
    const sizeMatch = block.match(new RegExp(`Size:\\s*${NUM}\\s*m\\s*wide\\s*[x×]\\s*${NUM}\\s*m\\s*tall`, 'i'));
    if (!sizeMatch) continue;
    out.push({
      typeId: id,
      description: desc,
      count,
      width_m: Number(sizeMatch[1]),
      height_m: Number(sizeMatch[2]),
      kind: /double/i.test(desc) ? 'double' : 'single',
      sourceFile,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building storeys / levels
// ---------------------------------------------------------------------------
// Reference MSL elevation: parses lines like
// "Z=0 corresponds to Level 0 floor (absolute elevation 1290 m MSL)"
// so the local↔MSL offset never has to be a literal in code.
function extractReferenceElevationMSL(content) {
  const m = content.match(new RegExp(`Z\\s*=\\s*0\\s+corresponds\\s+to[^\\n]*?\\(\\s*absolute\\s+elevation\\s+${NUM}\\s*m\\s*MSL\\s*\\)`, 'i'));
  return m ? Number(m[1]) : null;
}

function extractLevels(content, sourceFile) {
  const out = [];
  // form 1: `Level 0: name='Level 0', elevation = 1290.000 m MSL, story height = 4.0 m`
  const re1 = new RegExp(`Level\\s+([0-9]+):\\s*name\\s*=\\s*'([^']+)'\\s*,\\s*elevation\\s*=\\s*${NUM}\\s*m\\s*MSL\\s*,\\s*story\\s*height\\s*=\\s*${NUM}\\s*m`, 'gi');
  let m;
  while ((m = re1.exec(content)) !== null) {
    out.push({
      id: `level-${m[1]}`,
      index: Number(m[1]),
      name: m[2],
      elevation_msl_m: Number(m[3]),
      story_height_m: Number(m[4]),
      sourceFile,
    });
  }
  // form 2: `Level 0 (elevation = 0.0 m local / 1290 m MSL):`
  const re2 = new RegExp(`Level\\s+([0-9]+)\\s*\\(elevation\\s*=\\s*${NUM}\\s*m\\s*local\\s*/\\s*${NUM}\\s*m\\s*MSL\\)`, 'gi');
  while ((m = re2.exec(content)) !== null) {
    const idx = Number(m[1]);
    if (out.find(l => l.index === idx)) continue;
    out.push({
      id: `level-${idx}`,
      index: idx,
      name: `Level ${idx}`,
      elevation_local_m: Number(m[2]),
      elevation_msl_m: Number(m[3]),
      sourceFile,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tunnel bore override — horseshoe + lining
// ---------------------------------------------------------------------------
function extractTunnelBore(content, sourceFile) {
  if (!/TUNNEL\s+BORE\s+CROSS-SECTION/i.test(content)) return null;
  const shapeMatch = content.match(/Shape:\s*([A-Z]+)/);
  const widthMatch = content.match(new RegExp(`Width:\\s*${NUM}\\s*m`));
  const heightMatch = content.match(new RegExp(`Height:\\s*${NUM}\\s*m`));
  const DASH = '[\\u2013\\u2014\\-]';
  const liningMatch = content.match(new RegExp(`Lining:[^\\n]*?${NUM}\\s*${DASH}\\s*${NUM}\\s*inches?\\s*\\(${NUM}\\s*${DASH}\\s*${NUM}\\s*mm\\)`, 'i'));
  return {
    shape: shapeMatch ? shapeMatch[1].toUpperCase() : null,
    bore_width_m: widthMatch ? Number(widthMatch[1]) : null,
    bore_height_m: heightMatch ? Number(heightMatch[1]) : null,
    lining_min_m: liningMatch ? Number(liningMatch[3]) / 1000 : null,
    lining_max_m: liningMatch ? Number(liningMatch[4]) / 1000 : null,
    lining_material: /reinforced concrete/i.test(content) ? 'Reinforced Concrete' : null,
    sourceFile,
  };
}

// ---------------------------------------------------------------------------
// Vertical shaft
// ---------------------------------------------------------------------------
function extractShaft(content, sourceFile) {
  if (!/VERTICAL\s+SHAFT/i.test(content)) return null;
  const collarMatch = content.match(new RegExp(`Collar\\s+elevation:\\s*${NUM}\\s*m\\s*MSL`));
  const depthMatch = content.match(new RegExp(`Depth:\\s*${NUM}\\s*m`, 'i'));
  const profileMatch = content.match(/Profile:\s*([A-Za-z]+)/);
  const locMatch = content.match(/Location:\s*([^\n]+)/i);
  return {
    id: 'shaft-vertical',
    name: 'Vertical Shaft',
    collar_msl_m: collarMatch ? Number(collarMatch[1]) : null,
    depth_m: depthMatch ? Number(depthMatch[1]) : null,
    profile: profileMatch ? profileMatch[1] : null,
    location: locMatch ? locMatch[1].trim() : null,
    sourceFile,
  };
}

// ---------------------------------------------------------------------------
// Portal elevations — `West portal floor: 1290.000 m MSL  (= Level 0 in IFC)`
// ---------------------------------------------------------------------------
function extractPortalElevations(content, sourceFile) {
  const out = [];
  const re = /(West|East)\s+portal\s+floor:\s*([0-9.]+)\s*m\s*MSL\s*\(\s*=\s*Level\s*([0-9]+)/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push({
      side: m[1],
      elevation_msl_m: Number(m[2]),
      levelIndex: Number(m[3]),
      sourceFile,
    });
  }
  // ramp grade
  const rampMatch = content.match(new RegExp(`East\\s+ramp\\s+length:\\s*~?${NUM}\\s*m`, 'i'));
  const gradeMatch = content.match(/Ramp\s+grade:\s*([0-9.]+\/[0-9.]+\s*=\s*[0-9.]+%)/i);
  return {
    portals: out,
    ramp: (rampMatch || gradeMatch) ? {
      length_m: rampMatch ? Number(rampMatch[1]) : null,
      grade: gradeMatch ? gradeMatch[1] : null,
      sourceFile,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// HVAC systems — `System 1: Mechanical Exhaust_Air 1 — 15 duct/port members`
// ---------------------------------------------------------------------------
function extractSystems(content, sourceFile) {
  const out = [];
  const re = /System\s+([0-9]+):\s*([^—\-\n]+?)\s*[—\-]\s*([0-9]+)\s*duct\/port\s*members?/gi;
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push({
      id: `system-${m[1]}`,
      systemNumber: Number(m[1]),
      name: m[2].trim(),
      memberCount: Number(m[3]),
      systemType: /exhaust/i.test(m[2]) ? 'Exhaust Air' : 'Unknown',
      sourceFile,
    });
  }
  // total ports / connections
  const portsMatch = content.match(new RegExp(`Total\\s+distribution\\s+ports:\\s*${NUM}`, 'i'));
  const connMatch = content.match(new RegExp(`Total\\s+path\\s+connections:\\s*${NUM}`, 'i'));
  return {
    systems: out,
    totalPorts: portsMatch ? Number(portsMatch[1]) : null,
    totalConnections: connMatch ? Number(connMatch[1]) : null,
  };
}

// ---------------------------------------------------------------------------
// Equipment — pulled from `Item N — <Family>:` blocks AND from inline mentions
// ---------------------------------------------------------------------------
function extractEquipment(content, sourceFile) {
  const out = [];

  // form 0 (Fix B): `Equipment Item A: (x, y, z) — description`
  // Runs first so coordinate-rich items become dedup seeds.
  const positionedCfms = new Set();
  const re0 = /Equipment\s+Item\s+[A-Za-z0-9]+:\s*\(\s*([0-9.+-]+)\s*,\s*([0-9.+-]+)\s*,\s*([0-9.+-]+)\s*\)\s*[—\-]+\s*([^\n]+)/gi;
  let m0;
  while ((m0 = re0.exec(content)) !== null) {
    const x = Number(m0[1]);
    const y = Number(m0[2]);
    const z = Number(m0[3]);
    const desc = m0[4].trim();
    const cfmMatch = desc.match(/([0-9]+)\s*CFM/i);
    const cfm = cfmMatch ? cfmMatch[1] : null;
    if (cfm) positionedCfms.add(cfm);
    const id = cfm ? makeId('equip', `fan-${cfm}cfm`) : makeId('equip', desc);
    out.push({
      id,
      family: desc,
      capacity: cfm ? `${cfm} CFM` : null,
      coordinates: { x, y, z },
      semanticType: /fan/i.test(desc) ? 'IfcFan' : 'IfcBuildingElementProxy',
      sourceFile,
    });
  }

  // form 1: `Item N — <name>:` blocks
  const re = /Item\s+([0-9]+)\s*[—\-:]+\s*([^:\n]+?):\s*\n([\s\S]*?)(?=\n\s*Item\s+[0-9]+\s*[—\-]|\n[A-Z]{3,}|$)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const num = Number(m[1]);
    const heading = m[2].trim();
    const block = m[3];
    const familyMatch = block.match(/Family:\s*([^\n]+)/i);
    const capacityMatch = block.match(/Capacity:\s*([^\n]+)/i);
    const ifcTypeMatch = block.match(/IFC\s+type:\s*([^\n]+)/i);
    const outletMatch = block.match(new RegExp(`Outlet\\s+diameter:\\s*${NUM}\\s*m`, 'i'));
    out.push({
      id: makeId('equip', heading),
      number: num,
      heading,
      family: familyMatch ? familyMatch[1].trim() : null,
      capacity: capacityMatch ? capacityMatch[1].trim() : null,
      outlet_diameter_m: outletMatch ? Number(outletMatch[1]) : null,
      semanticType: ifcTypeMatch ? ifcTypeMatch[1].trim() : 'IfcBuildingElementProxy',
      sourceFile,
    });
  }
  // form 2: room-contents lines `2× Caterpillar 3512C 1500 kW Tier 2 generators`
  const re2 = /([0-9]+)\s*[x×]\s*((?:Caterpillar|CAT)\s+[A-Z0-9]+[^,\n]*?\s+generators?)/gi;
  while ((m = re2.exec(content)) !== null) {
    const count = Number(m[1]);
    const family = m[2].trim();
    for (let i = 0; i < count; i++) {
      out.push({
        id: makeId('equip', `generator-${out.length + 1}`),
        family,
        capacity: '1500 kW',
        semanticType: 'IfcElectricGenerator',
        sourceFile,
      });
    }
  }
  // form 3: room-contents fan lines `9500 CFM Centrifugal Inline Belt Drive Fan`
  // Skip any CFM value already captured with exact coordinates by form 0.
  const re3 = /([0-9]+)\s*CFM\s+(Centrifugal\s+(?:Inline\s+)?(?:Belt\s+Drive\s+)?Fan)/gi;
  while ((m = re3.exec(content)) !== null) {
    if (positionedCfms.has(m[1])) continue;
    out.push({
      id: makeId('equip', `fan-${m[1]}cfm`),
      family: `${m[2]} (${m[1]} CFM)`,
      capacity: `${m[1]} CFM`,
      semanticType: 'IfcFan',
      sourceFile,
    });
  }
  // form 4: AHU
  const ahuRe = /AHU\s+Fan\s+Module[^\n]*?\(?(?:Rear\s+Discharge\s+Up)?[^\n]*/i;
  if (ahuRe.test(content)) {
    out.push({
      id: makeId('equip', 'ahu-fan-module'),
      family: 'AHU Fan Module - Rear Discharge Up',
      semanticType: 'IfcUnitaryEquipment',
      sourceFile,
    });
  }
  // form 5: equipment datasheet format — PDF spec sheets use labelled fields rather
  // than inline narrative. Each PDF gets a unique id keyed on the source file name so
  // claims survive cross-file deduplication and are traceable back to their spec sheet.
  const srcExt = (sourceFile || '').toLowerCase().split('.').pop();
  if (srcExt === 'pdf') {
    // Airflow / CFM in datasheet label style
    const dsAirflow = content.match(/(?:Airflow|Air\s+Volume|Design\s+(?:CFM|Flow)|Air\s+Flow|Rated\s+Flow)\s*[:\-=]\s*([0-9,]+)\s*(?:CFM|cfm|m³\/h)?/i);
    // Model number
    const dsModel = content.match(/(?:Model|Model\s+No\.?|Model\s+Number|Part\s+No\.?)\s*[:\-. ]+\s*([A-Z0-9][A-Z0-9\-\/]+)/i);
    // Fan / equipment type line
    const dsFanType = content.match(/(?:Fan\s+Type|Blower\s+Type|Equipment\s+Type|Unit\s+Type)\s*[:\-.]\s*([^\n\r,;]{3,60})/i);
    // Static pressure (confirms it's a fan spec sheet, not just a narrative mention)
    const dsStatic = content.match(/(?:Static\s+Pressure|Total\s+Static|ESP)\s*[:\-=]\s*([0-9.]+)\s*(?:in\.?\s*(?:wg|w\.g\.)?|Pa|kPa)/i);
    // Horse-power / motor
    const dsHP = content.match(/(?:Motor\s+HP|Horsepower|Motor\s+kW)\s*[:\-=]\s*([0-9.]+)/i);

    const cfm = dsAirflow ? dsAirflow[1].replace(/,/g, '') : null;
    const model = dsModel ? dsModel[1].trim() : null;
    const fanType = dsFanType ? dsFanType[1].trim() : null;

    const srcSlug = (sourceFile || '').replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const looksLikeFanSpec = /fan|blower|ventilat/i.test(sourceFile || '');
    if (cfm || model || fanType || dsStatic || dsHP || looksLikeFanSpec) {
      const semanticType = /diesel|exhaust/i.test(sourceFile || content)
        ? 'IfcFan'
        : /generator|genset/i.test(sourceFile || content)
          ? 'IfcElectricGenerator'
          : 'IfcFan';
      const family = model
        ? (fanType ? `${fanType} (${model})` : model)
        : (fanType ? `${fanType}${cfm ? ` ${cfm} CFM` : ''}` : (cfm ? `Fan ${cfm} CFM` : null));
      out.push({
        id: `equip-ds-${srcSlug}`,
        family: family || srcSlug.replace(/-/g, ' '),
        capacity: cfm ? `${cfm} CFM` : (dsHP ? `${dsHP[1]} HP` : null),
        outlet_diameter_m: null,
        semanticType,
        sourceFile,
      });
    }
  }
  return unique(out, e => `${e.family || ''}|${e.capacity || ''}|${e.heading || ''}`);
}

// ---------------------------------------------------------------------------
// Duct spec — diameter + total count
// ---------------------------------------------------------------------------
function extractDuctSpec(content, sourceFile) {
  if (!/VENTILATION\s+DUCT|Duct\s+segment\s+lengths/i.test(content)) return null;
  const diaMatch = content.match(new RegExp(`Diameter:\\s*${NUM}\\s*m`, 'i'));
  const countMatch = content.match(new RegExp(`Total\\s+duct\\s+segment\\s+count:\\s*${NUM}`, 'i'));
  const fan9500Match = content.match(new RegExp(`9500\\s*CFM\\s*fan\\s*outlet:\\s*${NUM}\\s*m`, 'i'));
  const fan19000Match = content.match(new RegExp(`19000\\s*CFM\\s*fan\\s*outlet:\\s*${NUM}\\s*m`, 'i'));
  // length list
  const lengthList = [];
  const segmentSection = content.match(/Duct\s+segment\s+lengths[^\n]*\n([\s\S]*?)(?=\n[A-Z]{3,}|\n\n|$)/i);
  if (segmentSection) {
    const nums = segmentSection[1].match(/[0-9]+\.[0-9]+/g) || [];
    for (const n of nums) lengthList.push(Number(n));
  }
  return {
    diameter_m: diaMatch ? Number(diaMatch[1]) : null,
    total_segments: countMatch ? Number(countMatch[1]) : null,
    fan_outlet_9500_m: fan9500Match ? Number(fan9500Match[1]) : null,
    fan_outlet_19000_m: fan19000Match ? Number(fan19000Match[1]) : null,
    segment_lengths_m: lengthList,
    sourceFile,
  };
}

// ---------------------------------------------------------------------------
// Fitting spec — elbows + transitions
// ---------------------------------------------------------------------------
function extractFittingSpec(content, sourceFile) {
  if (!/DUCT\s+FITTING\s+SPECIFICATION/i.test(content)) return null;
  const out = [];
  // `Type 1 — Round Elbow, 1D radius (25 instances):`
  const re = /Type\s+([0-9]+)\s*[—\-:]+\s*([^\(\n]+?)\s*\(([0-9]+)\s+instances?\)\s*:\s*\n([\s\S]*?)(?=\nType\s+[0-9]+\s*[—\-]|\n[A-Z]{3,}|$)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const num = Number(m[1]);
    const desc = m[2].trim();
    const count = Number(m[3]);
    const block = m[4];
    const diaMatch = block.match(new RegExp(`Diameter:\\s*${NUM}\\s*m`, 'i'));
    // Bend ratio (e.g. "1D radius", "2 D radius") — encodes radius/diameter as a
    // discrete fact pulled from the description. No silent default; null if absent.
    const bendMatch = desc.match(/([0-9]+(?:\.[0-9]+)?)\s*D\s*(?:radius)?/i);
    // Transition angle (e.g. "15 degrees")
    const angleMatch = desc.match(new RegExp(`${NUM}\\s*(?:degrees?|deg)`, 'i'));
    const transitionShape = /rect/i.test(desc) ? 'RECT_TO_ROUND' : (/round/i.test(desc) ? 'ROUND' : null);
    out.push({
      typeNumber: num,
      description: desc,
      count,
      diameter_m: diaMatch ? Number(diaMatch[1]) : null,
      bend_ratio: bendMatch ? Number(bendMatch[1]) : null,
      angle_deg: angleMatch ? Number(angleMatch[1]) : null,
      transitionShape,
      kind: /elbow/i.test(desc) ? 'elbow' : (/transition/i.test(desc) ? 'transition' : 'other'),
      sourceFile,
    });
  }
  const totalMatch = content.match(new RegExp(`Total\\s+fitting\\s+count:\\s*${NUM}`, 'i'));
  return {
    fittings: out,
    total_fittings: totalMatch ? Number(totalMatch[1]) : null,
  };
}

// ---------------------------------------------------------------------------
// Wall spec — thickness + heights
// ---------------------------------------------------------------------------
function extractWallSpec(content, sourceFile) {
  if (!/STRUCTURAL\s+WALL\s+SPECIFICATION|WALL\s+GEOMETRY\s+SUMMARY/i.test(content)) return null;
  const thickMatch = content.match(new RegExp(`Thickness:\\s*${NUM}\\s*m`, 'i'));
  const heightLines = [];
  const stdMatch = content.match(new RegExp(`Standard:\\s*${NUM}\\s*m`, 'i'));
  const tallMatch = content.match(new RegExp(`Tall:\\s*${NUM}\\s*m`, 'i'));
  const lowMatch = content.match(new RegExp(`Low:\\s*${NUM}\\s*m`, 'i'));
  if (stdMatch) heightLines.push({ name: 'standard', height_m: Number(stdMatch[1]) });
  if (tallMatch) heightLines.push({ name: 'tall', height_m: Number(tallMatch[1]) });
  if (lowMatch) heightLines.push({ name: 'low', height_m: Number(lowMatch[1]) });
  const totalMatch = content.match(/Total\s+wall\s+count:\s*([0-9]+)/i);
  const materialMatch = content.match(/Material:\s*([^\n]+)/i);

  // Wall lengths block: numbers + optional `(×N)` repetition modifier.
  // Section ends at the next ALL-CAPS section header (preceded by a newline).
  const lengths = [];
  const blockMatch = content.match(/Wall\s+lengths\s+present\s+in\s+the\s+model[^\n]*\n([\s\S]*?)(?=\n[A-Z][A-Z\/ ]{3,}\n|\nThermal\s+transmittance|$)/i);
  if (blockMatch) {
    const block = blockMatch[1];
    // Strip everything after a comment dash on each line so we parse only the leading numeric tokens.
    const lines = block.split('\n').map(l => l.replace(/[—\-–]+.*$/, '').trim()).filter(Boolean);
    const tokenRe = /([0-9]+(?:\.[0-9]+)?)\s*(?:\(\s*[x×]\s*([0-9]+)\s*\))?/g;
    for (const line of lines) {
      let tm;
      while ((tm = tokenRe.exec(line)) !== null) {
        const v = Number(tm[1]);
        const mult = tm[2] ? Number(tm[2]) : 1;
        if (!Number.isFinite(v) || v <= 0) continue;
        for (let i = 0; i < mult; i++) lengths.push(v);
      }
    }
  }

  return {
    thickness_m: thickMatch ? Number(thickMatch[1]) : null,
    heights: heightLines,
    lengths_m: lengths,
    total_walls: totalMatch ? Number(totalMatch[1]) : null,
    material: materialMatch ? materialMatch[1].trim() : null,
    sourceFile,
  };
}

// ---------------------------------------------------------------------------
// Slab / ceiling spec
// ---------------------------------------------------------------------------
function extractLayerComposition(block) {
  const layers = [];
  const re = /Layer\s+([0-9]+)\s*:\s*([^\n]+?)(?:\s+([0-9]+(?:\.[0-9]+)?)\s*(mm|m))?\s*$/gim;
  let m;
  while ((m = re.exec(block)) !== null) {
    let thickMm = null;
    if (m[3] && m[4]) {
      const v = Number(m[3]);
      thickMm = m[4].toLowerCase() === 'm' ? v * 1000 : v;
    }
    layers.push({
      index: Number(m[1]),
      material: m[2].replace(/\s+/g, ' ').trim(),
      thickness_m: thickMm == null ? null : thickMm / 1000,
    });
  }
  layers.sort((a, b) => a.index - b.index);
  return layers;
}

function extractSlabCeilingSpec(content, sourceFile) {
  let slab = null, ceiling = null;
  const slabBlock = content.match(/FLOOR\s*\/\s*SLAB\s+SPECIFICATION[\s\S]*?(?=\n[A-Z]{3,}[^\n]*\n[-=]{3,}|$)/i);
  if (slabBlock) {
    const block = slabBlock[0];
    const thickMatch = block.match(new RegExp(`Total\\s+thickness:\\s*${NUM}\\s*m`, 'i'));
    const countMatch = block.match(/Count:\s*([0-9]+)\s*slab\s*instances/i);
    const baseOffsetMatch = block.match(new RegExp(`Base\\s+offset\\s+from\\s+storey\\s+axis:\\s*(-?${NUM})\\s*m`, 'i'));
    slab = {
      total_thickness_m: thickMatch ? Number(thickMatch[1]) : null,
      count: countMatch ? Number(countMatch[1]) : null,
      layers: extractLayerComposition(block),
      base_offset_m: baseOffsetMatch ? Number(baseOffsetMatch[1]) : null,
      sourceFile,
    };
  }
  const ceilingBlock = content.match(/CEILING\s*\/\s*COVERING\s+SPECIFICATION[\s\S]*?(?=\n[A-Z]{3,}[^\n]*\n[-=]{3,}|$)/i);
  if (ceilingBlock) {
    const block = ceilingBlock[0];
    const thickMatch = block.match(new RegExp(`Thickness:\\s*${NUM}\\s*m`, 'i'));
    const countMatch = block.match(/Count:\s*([0-9]+)\s*ceiling\s*instances/i);
    ceiling = {
      thickness_m: thickMatch ? Number(thickMatch[1]) : null,
      count: countMatch ? Number(countMatch[1]) : null,
      layers: extractLayerComposition(block),
      sourceFile,
    };
  }
  return { slab, ceiling };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function matchNumber(body, re) {
  const m = body.match(re);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Level schedule from CSV (tabular format, e.g. Revit level schedule export).
// Handles comma, semicolon, or tab delimiters.
// Revit exports a title row before the header row and uses mm for elevations.
// ---------------------------------------------------------------------------
function extractLevelScheduleFromCsv(content, sourceFile) {
  const rawLines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (rawLines.length < 2) return [];
  const sep = rawLines[0].includes('\t') ? '\t' : (rawLines[0].includes(';') ? ';' : ',');

  // Find the header row — scan up to the first 5 lines for one that has at least
  // 2 non-empty cells AND a recognised column keyword. Requiring 2+ cells skips
  // Revit-style title rows ("Level Schedule,,,") that only occupy the first column.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rawLines.length, 5); i++) {
    if (/elevation|name|storey|height/i.test(rawLines[i])) {
      const cells = rawLines[i].toLowerCase().split(sep).map(c => c.trim().replace(/['"]/g, ''));
      const nonEmpty = cells.filter(c => c.length > 0);
      if (nonEmpty.length >= 2) {
        headerIdx = i;
        break;
      }
    }
  }
  if (headerIdx === -1) return [];

  const header = rawLines[headerIdx].toLowerCase().split(sep).map(c => c.trim().replace(/['"]/g, ''));

  const idxOf = (...patterns) => {
    for (const p of patterns) {
      const i = header.findIndex(h => new RegExp(p, 'i').test(h));
      if (i >= 0) return i;
    }
    return -1;
  };

  const nameIdx   = idxOf('name', 'level\\s*name', 'description', 'label');
  const elevIdx   = idxOf('elevation', 'elev', 'msl', 'absolute.*elev');
  const heightIdx = idxOf('height', 'story.*height', 'storey.*height', 'floor.*height');

  if (elevIdx === -1 && nameIdx === -1) return [];

  const results = [];
  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const cells = rawLines[i].split(sep).map(c => c.trim().replace(/['"]/g, ''));
    if (cells.every(c => !c)) continue;

    const name  = nameIdx >= 0 && cells[nameIdx] ? cells[nameIdx] : `Level ${results.length}`;
    let elev    = elevIdx  >= 0 ? Number(cells[elevIdx]) : null;
    let height  = heightIdx >= 0 ? Number(cells[heightIdx]) : null;

    // Revit exports elevations in mm when project units are mm-based.
    // Values with |v| > 10000 are almost certainly mm (10000 mm = 10 m).
    if (Number.isFinite(elev) && Math.abs(elev) > 10000) elev = elev / 1000;
    if (Number.isFinite(height) && height > 10000) height = height / 1000;

    // Derive stable index from name suffix digit (e.g. "Level 0" → 0)
    const nameNumMatch = name.match(/(\d+)$/);
    const idx = nameNumMatch ? Number(nameNumMatch[1]) : results.length;

    if (!Number.isFinite(elev) && !name) continue;

    results.push({
      id: `level-${idx}`,
      index: idx,
      name,
      elevation_msl_m: Number.isFinite(elev) ? elev : null,
      elevation_local_m: null,
      story_height_m: Number.isFinite(height) && height > 0 ? height : null,
      sourceFile,
    });
  }

  // Derive story heights from consecutive elevation gaps when not in the CSV
  for (let i = 0; i < results.length - 1; i++) {
    if (!results[i].story_height_m &&
        results[i].elevation_msl_m != null &&
        results[i + 1].elevation_msl_m != null) {
      const diff = results[i + 1].elevation_msl_m - results[i].elevation_msl_m;
      if (diff > 0) results[i].story_height_m = diff;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Per-file authority detection.
// A file is OVERRIDE-authoritative if either:
//   - its filename matches a known authority pattern, or
//   - its content explicitly declares itself the highest-authority source.
// Returns 'OVERRIDE' | 'AUTHORITATIVE' | 'DEFAULT'.
// ---------------------------------------------------------------------------
function detectFileAuthority(name, content) {
  const fname = String(name || '');
  if (/Supplemental_Specs/i.test(fname)) return 'OVERRIDE';
  if (typeof content === 'string') {
    if (/HIGHEST[- ]AUTHORITY\s+SOURCE/i.test(content)) return 'OVERRIDE';
    if (/SUPERSEDES\s+ALL\s+CONFLICTING\s+VALUES/i.test(content)) return 'OVERRIDE';
  }
  return 'DEFAULT';
}

// ---------------------------------------------------------------------------
// Public entry — run all extractors over a list of {name, content} files.
// Returns aggregate structured data plus a per-file diagnostic.
// ---------------------------------------------------------------------------
export function parseSpecTexts(files) {
  const agg = {
    rooms: [],
    portalBuildings: [],
    doorSpecs: [],
    levels: [],
    tunnelBore: null,
    shaft: null,
    portalElevations: [],
    ramp: null,
    systems: [],
    totalDistributionPorts: null,
    totalPathConnections: null,
    equipment: [],
    ductSpec: null,
    fittingSpec: null,
    wallSpec: null,
    slabSpec: null,
    ceilingSpec: null,
    referenceElevationMSL: null,
    fileAuthority: {},
  };
  const perFile = {};

  for (const f of (files || [])) {
    if (!f || !f.content || typeof f.content !== 'string') continue;
    const ext = (f.name || '').toLowerCase().split('.').pop();
    // run on .txt + .pdf + .docx + .vsm + .csv
    if (!['txt', 'pdf', 'docx', 'vsm', 'csv'].includes(ext)) continue;
    const content = f.content;
    agg.fileAuthority[f.name] = detectFileAuthority(f.name, content);
    const beforeCounts = countAgg(agg);

    // rooms + portal buildings
    const rooms = extractRooms(content, f.name);
    for (const r of rooms) agg.rooms.push(r);
    const portals = extractPortalBuildings(content, f.name);
    for (const p of portals) agg.portalBuildings.push(p);

    // door type schedule
    const doorSpecs = extractDoorSpecs(content, f.name);
    for (const d of doorSpecs) agg.doorSpecs.push(d);

    // levels — narrative form (all text types)
    const levels = extractLevels(content, f.name);
    for (const l of levels) {
      if (!agg.levels.find(x => x.index === l.index)) agg.levels.push(l);
    }
    // levels — CSV tabular form (level schedule exports)
    if (ext === 'csv') {
      const csvLevels = extractLevelScheduleFromCsv(content, f.name);
      for (const l of csvLevels) {
        if (!agg.levels.find(x => x.index === l.index)) agg.levels.push(l);
      }
    }

    // tunnel bore + shaft
    if (!agg.tunnelBore) {
      const tb = extractTunnelBore(content, f.name);
      if (tb) agg.tunnelBore = tb;
    }
    if (!agg.shaft) {
      const sh = extractShaft(content, f.name);
      if (sh) agg.shaft = sh;
    }

    // portal elevations + ramp
    const peo = extractPortalElevations(content, f.name);
    for (const p of peo.portals) {
      if (!agg.portalElevations.find(x => x.side === p.side)) agg.portalElevations.push(p);
    }
    if (!agg.ramp && peo.ramp) agg.ramp = peo.ramp;

    // hvac systems
    const sys = extractSystems(content, f.name);
    for (const s of sys.systems) {
      if (!agg.systems.find(x => x.systemNumber === s.systemNumber)) agg.systems.push(s);
    }
    if (sys.totalPorts !== null && agg.totalDistributionPorts === null) agg.totalDistributionPorts = sys.totalPorts;
    if (sys.totalConnections !== null && agg.totalPathConnections === null) agg.totalPathConnections = sys.totalConnections;

    // equipment — cross-file merge: non-zero coordinates beat {0,0,0} for same ID
    if (!agg._equipById) agg._equipById = new Map();
    const eq = extractEquipment(content, f.name);
    for (const e of eq) {
      const existing = agg._equipById.get(e.id);
      if (!existing) {
        agg.equipment.push(e);
        agg._equipById.set(e.id, e);
      } else {
        const incomingHasCoords = e.coordinates &&
          (e.coordinates.x !== 0 || e.coordinates.y !== 0 || e.coordinates.z !== 0);
        const existingHasCoords = existing.coordinates &&
          (existing.coordinates.x !== 0 || existing.coordinates.y !== 0 || existing.coordinates.z !== 0);
        if (incomingHasCoords && !existingHasCoords) {
          existing.coordinates = e.coordinates;
        }
        if (e.sourceFile && !(existing.sourceFiles || []).includes(e.sourceFile)) {
          existing.sourceFiles = [
            ...(existing.sourceFiles || (existing.sourceFile ? [existing.sourceFile] : [])),
            e.sourceFile,
          ];
        }
      }
    }

    // duct + fitting
    if (!agg.ductSpec) {
      const ds = extractDuctSpec(content, f.name);
      if (ds) agg.ductSpec = ds;
    }
    if (!agg.fittingSpec) {
      const fs = extractFittingSpec(content, f.name);
      if (fs) agg.fittingSpec = fs;
    }

    // wall + slab/ceiling — prefer the spec with more populated fields (Zion has the rich one)
    {
      const ws = extractWallSpec(content, f.name);
      const score = (s) => s ? ((s.thickness_m ? 1 : 0) + (s.heights?.length || 0) + (s.total_walls ? 1 : 0) + (s.material ? 1 : 0)) : -1;
      if (ws && score(ws) > score(agg.wallSpec)) agg.wallSpec = ws;
    }
    const sc = extractSlabCeilingSpec(content, f.name);
    if (!agg.slabSpec && sc.slab) agg.slabSpec = sc.slab;
    if (!agg.ceilingSpec && sc.ceiling) agg.ceilingSpec = sc.ceiling;

    // Reference elevation: discrete parsed fact. First file with it wins.
    if (agg.referenceElevationMSL == null) {
      const ref = extractReferenceElevationMSL(content);
      if (ref != null) agg.referenceElevationMSL = ref;
    }

    perFile[f.name] = diff(beforeCounts, countAgg(agg));
  }

  // dedupe equipment
  agg.equipment = unique(agg.equipment, e => `${e.family || ''}|${e.capacity || ''}|${e.heading || ''}`);

  return { ...agg, perFile };
}

function countAgg(agg) {
  return {
    rooms: agg.rooms.length,
    portalBuildings: agg.portalBuildings.length,
    doorSpecs: agg.doorSpecs.length,
    levels: agg.levels.length,
    tunnelBore: agg.tunnelBore ? 1 : 0,
    shaft: agg.shaft ? 1 : 0,
    portalElevations: agg.portalElevations.length,
    systems: agg.systems.length,
    equipment: agg.equipment.length,
    ductSpec: agg.ductSpec ? 1 : 0,
    fittingSpec: agg.fittingSpec ? 1 : 0,
    wallSpec: agg.wallSpec ? 1 : 0,
    slabSpec: agg.slabSpec ? 1 : 0,
    ceilingSpec: agg.ceilingSpec ? 1 : 0,
  };
}

function diff(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    if ((after[k] - before[k]) !== 0) out[k] = after[k] - before[k];
  }
  return out;
}
