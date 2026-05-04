import { Viewer, WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk';
import * as WebIFC from 'web-ifc';

const ifcViewer = {
    viewer: null,
    ifcLoader: null,
    currentModel: null,
    ifcAPI: null,

    // Property query model (kept open after load for element metadata lookups)
    _queryModelId: null,
    _ifcBuffer: null,

    /**
     * Initialize the xeokit viewer
     * @param {HTMLCanvasElement} canvas
     */
    async init(canvas) {
        try {
            this.viewer = new Viewer({
                canvasId: canvas.id,
                transparent: true,
                saoEnabled: true,
                backgroundColor: [0.164, 0.164, 0.164],
                preserveDrawingBuffer: true
            });

            await this._initIfcAPI();

            this.ifcLoader = new WebIFCLoaderPlugin(this.viewer, {
                WebIFC: WebIFC,
                IfcAPI: this.ifcAPI
            });

            this.viewer.camera.eye = [-80, -80, 80];
            this.viewer.camera.look = [0, 0, 0];
            this.viewer.camera.up = [0, 0, 1];

        } catch (error) {
            console.error('Failed to initialize xeokit Viewer:', error);
            throw error;
        }
    },

    async _initIfcAPI() {
        this.ifcAPI = new WebIFC.IfcAPI();
        this.ifcAPI.SetWasmPath('/');
        await this.ifcAPI.Init();
        if (!this.ifcAPI.wasmModule) {
            throw new Error('web-ifc WASM module failed to initialize');
        }
    },

    /**
     * Load an IFC file into the viewer
     * @param {string|ArrayBuffer} srcOrArrayBuffer
     */
    async loadIFC(srcOrArrayBuffer) {
        try {
            if (!this.viewer) {
                throw new Error('Viewer not initialized. Call init() first.');
            }

            if (!this.ifcAPI?.wasmModule) {
                await this._initIfcAPI();
                this.ifcLoader = new WebIFCLoaderPlugin(this.viewer, {
                    WebIFC: WebIFC,
                    IfcAPI: this.ifcAPI
                });
            }

            // Close previous query model
            if (this._queryModelId !== null) {
                try { this.ifcAPI.CloseModel(this._queryModelId); } catch (_) {}
                this._queryModelId = null;
                this._ifcBuffer = null;
            }

            if (this.currentModel) {
                this.currentModel.destroy();
                this.currentModel = null;
            }

            const loaderConfig = { edges: true };
            if (typeof srcOrArrayBuffer === 'string') {
                loaderConfig.src = srcOrArrayBuffer;
            } else if (srcOrArrayBuffer instanceof ArrayBuffer) {
                loaderConfig.ifc = srcOrArrayBuffer;
            } else {
                throw new Error('Invalid input: must be URL string or ArrayBuffer');
            }

            this.currentModel = await new Promise((resolve, reject) => {
                const model = this.ifcLoader.load(loaderConfig);
                model.on('loaded', () => resolve(model));
                model.on('error', (err) => reject(new Error(err || 'IFC load failed')));
                setTimeout(() => resolve(model), 30000);
            });

            // Open a separate query model for property lookups
            if (srcOrArrayBuffer instanceof ArrayBuffer) {
                this._ifcBuffer = srcOrArrayBuffer;
                try {
                    this._queryModelId = this.ifcAPI.OpenModel(new Uint8Array(this._ifcBuffer));
                } catch (e) {
                    console.warn('[IFC] Could not open query model for property lookup:', e);
                }
            }

            // Fit camera to model
            try {
                this.viewer.cameraFlight.jumpTo(this.currentModel);

                const aabb = this.currentModel.aabb;
                if (aabb) {
                    const dx = aabb[3] - aabb[0];
                    const dy = aabb[4] - aabb[1];
                    const dz = aabb[5] - aabb[2];
                    const longest = Math.max(dx, dy, dz);
                    const shortest = Math.min(
                        dx > 0.1 ? dx : Infinity,
                        dy > 0.1 ? dy : Infinity,
                        dz > 0.1 ? dz : Infinity
                    );
                    if (longest > 20 && longest / shortest > 15) {
                        const cx = (aabb[0] + aabb[3]) / 2;
                        const cy = (aabb[1] + aabb[4]) / 2;
                        const cz = (aabb[2] + aabb[5]) / 2;
                        const sideDist = longest * 0.65;
                        const height = longest * 0.2;
                        if (dx >= dy) {
                            this.viewer.camera.eye = [cx, cy - sideDist, cz + height];
                        } else {
                            this.viewer.camera.eye = [cx - sideDist, cy, cz + height];
                        }
                        this.viewer.camera.look = [cx, cy, cz];
                        this.viewer.camera.up = [0, 0, 1];
                    }
                }
            } catch (_) {}

        } catch (error) {
            console.error('Failed to load IFC file:', error);
            throw error;
        }
    },

    resize() {
        if (this.viewer) {
            try {
                this.viewer.scene.canvas.resizeCanvas();
            } catch (_) {}
        }
    },

    clear() {
        if (this._queryModelId !== null) {
            try { this.ifcAPI?.CloseModel(this._queryModelId); } catch (_) {}
            this._queryModelId = null;
            this._ifcBuffer = null;
        }
        if (this.currentModel) {
            this.currentModel.destroy();
            this.currentModel = null;
        }
    },

    /**
     * Fetch property sets for a picked element by expressID.
     */
    async getElementProperties(entityId) {
        if (!this.ifcAPI || this._queryModelId === null) return null;

        const expressId = typeof entityId === 'number' ? entityId : parseInt(entityId, 10);
        if (isNaN(expressId) || expressId <= 0) return null;

        try {
            const [rawProps, psets] = await Promise.all([
                this.ifcAPI.properties.getItemProperties(this._queryModelId, expressId, true),
                this.ifcAPI.properties.getPropertySets(this._queryModelId, expressId, true)
            ]);
            const groups = this._flattenProperties(rawProps, psets);
            const geometry = this._extractGeometry(entityId);
            const relationships = this._extractRelationships(rawProps);
            return { groups, geometry, relationships };
        } catch (e) {
            console.warn('[IFC] getElementProperties failed for', entityId, e);
            return null;
        }
    },

    _flattenProperties(rawProps, psets) {
        const groups = [];

        if (rawProps) {
            const SKIP = new Set([
                'expressID', 'type', 'GlobalId', 'OwnerHistory',
                'ObjectPlacement', 'Representation', 'ContainedInStructure',
                'HasAssignments', 'IsDefinedBy', 'HasOpenings', 'ConnectedTo',
                'IsDecomposedBy', 'Decomposes', 'HasAssociations'
            ]);
            const attrs = [];
            for (const [key, val] of Object.entries(rawProps)) {
                if (SKIP.has(key)) continue;
                const v = this._extractIfcVal(val);
                if (v === null || v === undefined || v === '' || typeof v === 'object') continue;
                attrs.push({ name: key, value: String(v) });
            }
            if (attrs.length > 0) groups.push({ name: 'Attributes', props: attrs });
        }

        if (Array.isArray(psets)) {
            for (const pset of psets) {
                if (!pset) continue;
                const items = pset.HasProperties || pset.Quantities || [];
                const props = [];
                for (const item of items) {
                    if (!item?.Name) continue;
                    const name = this._extractIfcVal(item.Name);
                    if (!name) continue;
                    const rawVal = item.NominalValue ?? item.LengthValue ?? item.AreaValue
                        ?? item.VolumeValue ?? item.CountValue ?? item.WeightValue ?? item.Value;
                    const v = this._extractIfcVal(rawVal);
                    if (v === null || v === undefined || v === '' || typeof v === 'object') continue;
                    props.push({ name: String(name), value: String(v) });
                }
                if (props.length === 0) continue;
                const psetName = this._extractIfcVal(pset.Name) || 'Properties';
                groups.push({ name: String(psetName), props });
            }
        }

        return groups;
    },

    _toArray(v) {
        return !v ? [] : Array.isArray(v) ? v : [v];
    },

    _extractIfcVal(v) {
        if (v === null || v === undefined) return null;
        if (typeof v !== 'object') return v;
        if ('value' in v) return v.value;
        return null;
    },

    _extractGeometry(entityId) {
        if (!this.viewer || !this.currentModel) return null;
        try {
            const entity = this.viewer.scene.objects[entityId];
            if (!entity) return null;
            const aabb = entity.aabb;
            if (!aabb) return null;
            const width  = parseFloat((aabb[3] - aabb[0]).toFixed(3));
            const depth  = parseFloat((aabb[4] - aabb[1]).toFixed(3));
            const height = parseFloat((aabb[5] - aabb[2]).toFixed(3));
            const cx = ((aabb[0] + aabb[3]) / 2).toFixed(2);
            const cy = ((aabb[1] + aabb[4]) / 2).toFixed(2);
            const cz = ((aabb[2] + aabb[5]) / 2).toFixed(2);
            return { width, depth, height, center: `(${cx}, ${cy}, ${cz})` };
        } catch (_) {
            return null;
        }
    },

    _extractRelationships(rawProps) {
        if (!rawProps) return null;
        const rels = [];

        for (const rel of this._toArray(rawProps.ContainedInStructure)) {
            if (!rel || typeof rel !== 'object') continue;
            const struct = rel.RelatingStructure;
            if (struct && typeof struct === 'object') {
                const name = this._extractIfcVal(struct.Name) || this._extractIfcVal(struct.LongName);
                if (name) { rels.push({ name: 'Contained In', value: String(name) }); break; }
            }
        }

        for (const rel of this._toArray(rawProps.Decomposes)) {
            if (!rel || typeof rel !== 'object') continue;
            const parent = rel.RelatingObject;
            if (parent && typeof parent === 'object') {
                const name = this._extractIfcVal(parent.Name);
                if (name) { rels.push({ name: 'Part Of', value: String(name) }); break; }
            }
        }

        let subCount = 0;
        for (const rel of this._toArray(rawProps.IsDecomposedBy)) {
            if (!rel || typeof rel !== 'object') continue;
            const objs = rel.RelatedObjects;
            subCount += Array.isArray(objs) ? objs.length : 1;
        }
        if (subCount > 0) rels.push({ name: 'Sub-elements', value: String(subCount) });

        const openings = this._toArray(rawProps.HasOpenings);
        if (openings.length > 0) rels.push({ name: 'Openings', value: String(openings.length) });

        const connections = this._toArray(rawProps.ConnectedTo);
        if (connections.length > 0) rels.push({ name: 'Connections', value: String(connections.length) });

        for (const rel of this._toArray(rawProps.HasAssignments)) {
            if (!rel || typeof rel !== 'object') continue;
            const group = rel.RelatingGroup;
            if (group && typeof group === 'object') {
                const name = this._extractIfcVal(group.Name);
                if (name) { rels.push({ name: 'System', value: String(name) }); break; }
            }
        }

        return rels.length > 0 ? rels : null;
    },

    /**
     * Snap camera to a clean isometric angle before taking the thumbnail.
     * Returns a promise that resolves after one rendered frame.
     */
    positionForThumbnail() {
        return new Promise((resolve) => {
            if (!this.viewer || !this.currentModel) { resolve(); return; }
            try {
                const aabb = this.currentModel.aabb;
                if (!aabb) { resolve(); return; }

                const cx = (aabb[0] + aabb[3]) / 2;
                const cy = (aabb[1] + aabb[4]) / 2;
                const cz = (aabb[2] + aabb[5]) / 2;
                const dx = aabb[3] - aabb[0];
                const dy = aabb[4] - aabb[1];
                const dz = aabb[5] - aabb[2];
                const radius = Math.max(dx, dy, dz) * 0.85;

                // Front-right-top isometric angle: consistent regardless of model orientation
                const angle = Math.PI / 4; // 45 degrees
                const eyeX = cx + radius * Math.cos(angle);
                const eyeY = cy - radius * Math.sin(angle);
                const eyeZ = cz + radius * 0.55;

                this.viewer.camera.eye = [eyeX, eyeY, eyeZ];
                this.viewer.camera.look = [cx, cy, cz];
                this.viewer.camera.up = [0, 0, 1];

                try { this.viewer.scene.render(true); } catch (_) {}
            } catch (_) {}

            requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
    },

    getSnapshot(size = 400) {
        try {
            let srcCanvas = this.viewer?.scene?.canvas?.canvas;
            if (!srcCanvas) srcCanvas = document.getElementById('ifc-viewer-canvas');
            if (!srcCanvas || srcCanvas.width === 0 || srcCanvas.height === 0) return null;

            const offscreen = document.createElement('canvas');
            offscreen.width = size;
            offscreen.height = size;
            const ctx = offscreen.getContext('2d');

            ctx.fillStyle = '#2a2a2a';
            ctx.fillRect(0, 0, size, size);

            const sq = Math.min(srcCanvas.width, srcCanvas.height);
            const sx = (srcCanvas.width - sq) / 2;
            const sy = (srcCanvas.height - sq) / 2;
            ctx.drawImage(srcCanvas, sx, sy, sq, sq, 0, 0, size, size);

            const sample = ctx.getImageData(0, 0, size, size).data;
            const bgR = 42, bgG = 42, bgB = 42;
            let nonBgPixels = 0;
            const step = 40;
            for (let i = 0; i < sample.length; i += step * 4) {
                const r = sample[i], g = sample[i + 1], b = sample[i + 2];
                if (Math.abs(r - bgR) > 12 || Math.abs(g - bgG) > 12 || Math.abs(b - bgB) > 12) {
                    nonBgPixels++;
                }
            }
            const totalSampled = Math.ceil(sample.length / (step * 4));
            if (nonBgPixels / totalSampled < 0.005) return null;

            return offscreen.toDataURL('image/jpeg', 0.90);
        } catch (_) {
            return null;
        }
    },

    setupPickEvents() {
        if (!this.viewer) return;
        if (this._pickSubId !== undefined) {
            this.viewer.scene.input.off(this._pickSubId);
        }
        this._pickSubId = this.viewer.scene.input.on('mouseclicked', (coords) => {
            const pickResult = this.viewer.scene.pick({ canvasPos: coords });
            if (pickResult && pickResult.entity) {
                const entity = pickResult.entity;
                const metaObject = this.viewer.metaScene.metaObjects[entity.id];
                document.dispatchEvent(new CustomEvent('elementPicked', {
                    detail: {
                        id: entity.id,
                        type: metaObject?.type || 'Unknown',
                        name: metaObject?.name || entity.id
                    }
                }));
            } else {
                document.dispatchEvent(new CustomEvent('elementPickCleared'));
            }
        });
    },

    destroy() {
        try {
            if (this._queryModelId !== null) {
                try { this.ifcAPI?.CloseModel(this._queryModelId); } catch (_) {}
                this._queryModelId = null;
                this._ifcBuffer = null;
            }
            if (this.currentModel) {
                this.currentModel.destroy();
                this.currentModel = null;
            }
            if (this.viewer) {
                this.viewer.destroy();
                this.viewer = null;
            }
            this.ifcLoader = null;
        } catch (error) {
            console.error('Error destroying viewer:', error);
        }
    }
};

export default ifcViewer;
