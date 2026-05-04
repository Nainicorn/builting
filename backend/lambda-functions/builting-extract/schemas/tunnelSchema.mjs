/**
 * Tunnel domain extraction schema.
 * Used by docxStructuredParser to tell Claude what to extract from DOCX narrative text.
 * Building schemas can live alongside this file using the same shape.
 */

export const TUNNEL_SCHEMA = {
  tunnelProfile: {
    shape: null,           // 'circular' | 'horseshoe' | 'rectangular' | null
    width_m: null,         // clear bore width
    height_m: null,        // clear bore height
    wallThickness_m: null, // structural wall/lining thickness
  },
  portals: [
    // { name: string, elevation_msl: number, orientation: string }
  ],
  shaft: {
    collar_elevation_msl: null,   // elevation of shaft top at surface
    vertical_length_m: null,      // shaft depth / height
    location_description: null,   // e.g. "at chainage 320m" or "adjacent to diesel gen room"
  },
  materialZones: [
    // { material: string, zone_description: string, start_description: string, end_description: string }
  ],
  rooms: [
    // { name: string, width_m: number, length_m: number, height_m: number, door_height_m: number }
  ],
  ducts: {
    diameter_m: null,   // duct OD
    shape: null,        // 'circular' | 'rectangular'
  },
};
