import template from './details.hbs';
import './details.css';
import rendersService from '../../services/rendersService.js';
import modalService from '../../services/modalService.js';

const STAGE_ORDER = ['extract', 'resolve', 'topology', 'generate', 'store'];
const STAGE_LABELS = { extract: 'Extract', resolve: 'Resolve', topology: 'Topology', generate: 'Generate', store: 'Store' };

const IFC_HUMAN_NAMES = {
    'IfcWall': 'Wall', 'IfcWallStandardCase': 'Wall',
    'IfcSlab': 'Floor / Slab', 'IfcColumn': 'Column', 'IfcBeam': 'Beam',
    'IfcSpace': 'Room / Space', 'IfcDoor': 'Door', 'IfcWindow': 'Window',
    'IfcRoof': 'Roof', 'IfcStair': 'Stair', 'IfcRailing': 'Railing',
    'IfcCovering': 'Ceiling / Covering', 'IfcMember': 'Structural Member',
    'IfcDuctSegment': 'Duct', 'IfcPipeSegment': 'Pipe',
    'IfcDuctFitting': 'Duct Fitting', 'IfcPipeFitting': 'Pipe Fitting',
    'IfcFlowFitting': 'Duct / Pipe Fitting', 'IfcFlowSegment': 'Flow Segment',
    'IfcFan': 'Fan', 'IfcPump': 'Pump', 'IfcValve': 'Valve',
    'IfcBoiler': 'Boiler', 'IfcChiller': 'Chiller',
    'IfcCoolingTower': 'Cooling Tower', 'IfcHeatExchanger': 'Heat Exchanger',
    'IfcAirTerminal': 'Air Terminal', 'IfcAirTerminalBox': 'Air Terminal Box',
    'IfcElectricMotor': 'Electric Motor', 'IfcTransformer': 'Transformer',
    'IfcElectricDistributionBoard': 'Electrical Panel',
    'IfcLightFixture': 'Light Fixture', 'IfcCableCarrierSegment': 'Cable Tray',
    'IfcFurnishingElement': 'Furniture',
    'IfcBuildingElementProxy': 'Unclassified Element',
    'IfcOpeningElement': 'Opening',
    'IfcDistributionSystem': 'Distribution System',
    'IfcDistributionFlowElement': 'Distribution Flow Element',
    'IfcBuilding': 'Building', 'IfcBuildingStorey': 'Storey / Level', 'IfcSite': 'Site',
};

const details = {
    element: null,
    currentRender: null,
    _tracePoller: null,
    _traceEntries: {},   // keyed by `${runId}.${attemptN}` — additive, never re-rendered

    // Initialize the details component
    async init() {
        this._render();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__details');
        let html = template({ main: true });
        this.element.innerHTML = html;
    },

    // Bind event listeners
    _bindListeners() {
        // Listen for render selection from sidebar
        document.addEventListener('renderSelected', async (e) => {
            await this.show(e.detail.render);
        });

        // Listen for new render request
        document.addEventListener('newRenderRequested', () => {
            this.hide();
        });

        // Collapse toggle button
        const toggleBtn = this.element.querySelector('.__details-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const isCollapsed = document.body.getAttribute('data-details-collapsed') === 'true';
                document.body.setAttribute('data-details-collapsed', isCollapsed ? 'false' : 'true');
            });
        }

        // Backdrop click closes details
        const backdrop = document.querySelector('.__details-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', () => this.hide());
        }

        // ESC key closes panels
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const infoModal = this.element.querySelector('.__details-info-modal');
                if (infoModal && !infoModal.classList.contains('hidden')) {
                    this._closeInfoModal();
                } else if (this.element.classList.contains('__details-visible')) {
                    this.hide();
                }
            }
        });

        // Delete button
        const deleteBtn = this.element.querySelector('.__details-delete');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                await this._handleDelete();
            });
        }

        // View Details button
        const viewMoreBtn = this.element.querySelector('.__details-view-more');
        if (viewMoreBtn) {
            viewMoreBtn.addEventListener('click', () => this._openInfoModal());
        }

        // Info modal close
        const infoClose = this.element.querySelector('.__details-info-close');
        if (infoClose) {
            infoClose.addEventListener('click', () => this._closeInfoModal());
        }

        // Info modal backdrop
        const infoBackdrop = this.element.querySelector('.__details-info-backdrop');
        if (infoBackdrop) {
            infoBackdrop.addEventListener('click', () => this._closeInfoModal());
        }
    },

    _openInfoModal() {
        const modal = this.element.querySelector('.__details-info-modal');
        const backdrop = this.element.querySelector('.__details-info-backdrop');
        if (modal) modal.classList.remove('hidden');
        if (backdrop) backdrop.classList.remove('hidden');
    },

    _closeInfoModal() {
        const modal = this.element.querySelector('.__details-info-modal');
        const backdrop = this.element.querySelector('.__details-info-backdrop');
        if (modal) modal.classList.add('hidden');
        if (backdrop) backdrop.classList.add('hidden');
    },

    /**
     * Show render details
     */
    async show(render) {
        if (!render) return;

        this.currentRender = render;

        // Display title
        this._displayTitle(render);

        // Display description
        this._displayDescription(render);

        // Display files
        if (render.source_files && Array.isArray(render.source_files)) {
            this._displayFiles(render.source_files);
        }

        // Display refinement report (if this render was refined)
        this._displayRefinement(render);

        // Display pipeline trace (static for completed renders, kicks off polling for in-progress)
        this._traceEntries = {};
        this._stopTracePolling();
        this._displayPipelineTrace([]);
        await this._loadAndDisplayTrace(render);
        if (render.status === 'processing') {
            this._startTracePolling(render.render_id);
        }

        // Display traceability report
        this._displayTracingReport(render);

        // Display quality score
        this._displayQualityScore(render);

        // Display model statistics
        this._displayStats(render);

        // Display structural notes
        this._displayStructuralWarnings(render);

        // Display generation warnings
        this._displayWarnings(render);

        // Display unmodeled findings
        this._displayOmitted(render);

        // Hide delete button for permanent demo renders
        const deleteBtn = this.element.querySelector('.__details-delete');
        if (deleteBtn) {
            deleteBtn.classList.toggle('hidden', !!render.is_demo_render);
        }

        // Set modal title
        const modalTitle = this.element.querySelector('.__details-info-modal-title');
        if (modalTitle) {
            modalTitle.textContent = render.ai_generated_title || render.title || 'Untitled Render';
        }

        // Show the details panel (always expand on open)
        document.body.setAttribute('data-details-collapsed', 'false');
        this.element.classList.add('__details-visible');

        // Show backdrop on smaller screens
        const backdrop = document.querySelector('.__details-backdrop');
        if (backdrop && window.innerWidth <= 1100) {
            backdrop.style.display = 'block';
        }
    },

    /**
     * Hide render details
     */
    hide() {
        this._stopTracePolling();
        this._traceEntries = {};
        this._closeInfoModal();
        document.body.setAttribute('data-details-collapsed', 'false');
        this.element.classList.remove('__details-visible');
        this.currentRender = null;

        // Hide backdrop
        const backdrop = document.querySelector('.__details-backdrop');
        if (backdrop) {
            backdrop.style.display = 'none';
        }
        // Clear text fields
        const titleEl = this.element.querySelector('.__details-title');
        const descEl = this.element.querySelector('.__details-description');
        const filesContainer = this.element.querySelector('.__details-files');
        if (titleEl) titleEl.textContent = '';
        if (descEl) descEl.textContent = '';
        if (filesContainer) filesContainer.innerHTML = '';

        // Clear and hide all collapsible sections
        const sections = ['pipeline-trace', 'traceability', 'quality', 'stats', 'refinement', 'structural', 'warnings', 'omitted'];
        for (const name of sections) {
            const section = this.element.querySelector(`.__details-${name}`);
            const content = this.element.querySelector(`.__details-${name}-content`);
            if (content) content.innerHTML = '';
            if (section) section.classList.add('hidden');
        }
    },

    /**
     * Display render title
     */
    _displayTitle(render) {
        const titleEl = this.element.querySelector('.__details-title');
        if (titleEl) {
            const title = render.ai_generated_title || render.title || 'Untitled Render';
            titleEl.textContent = title;
            titleEl.title = title;
        }
    },

    /**
     * Display render description
     */
    _displayDescription(render) {
        const descEl = this.element.querySelector('.__details-description');
        if (descEl) {
            descEl.textContent = render.ai_generated_description || render.description || 'No description available';
        }
    },

    /**
     * Display refinement info (revision, change summary, warnings)
     */
    _displayRefinement(render) {
        const section = this.element.querySelector('.__details-refinement');
        const content = this.element.querySelector('.__details-refinement-content');
        if (!section || !content) return;

        const rr = render.refinementReport;
        const refCount = render.refine_count;
        if (!rr && !refCount) { section.classList.add('hidden'); return; }

        section.classList.remove('hidden');
        let html = '';

        if (refCount) {
            html += `<div class="__trace-row"><span class="__trace-label">Revision</span><span class="__trace-value">#${refCount}</span></div>`;
        }
        if (render.refinement) {
            const escaped = render.refinement.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html += `<div class="__trace-row"><span class="__trace-label">Last Edit</span><span class="__trace-value" style="font-style:italic">"${escaped}"</span></div>`;
        }

        if (rr && rr.summary) {
            const s = rr.summary;
            html += `<div class="__trace-row"><span class="__trace-label">Changes</span><span class="__trace-value">${s.addedCount || 0} added, ${s.removedCount || 0} removed, ${s.modifiedCount || 0} modified</span></div>`;

            if (s.driftRejected) {
                html += `<div class="__warn-item __warn-item--warn"><span class="__warn-icon">!</span><span class="__warn-text">Drift rejected: LLM output discarded, only targeted patches applied</span></div>`;
            } else if (s.driftDetected) {
                html += `<div class="__warn-item __warn-item--warn"><span class="__warn-icon">!</span><span class="__warn-text">Structural drift detected: structural elements changed despite equipment-only request</span></div>`;
            }
            if (s.disproportionate) {
                html += `<div class="__warn-item __warn-item--warn"><span class="__warn-icon">!</span><span class="__warn-text">Large-scale changes: over 50% of elements affected</span></div>`;
            }
            if (s.unresolvedTargets && s.unresolvedTargets.length > 0) {
                const ambiguousCount = s.unresolvedTargets.filter(t => t.reason === 'AMBIGUOUS').length;
                const otherCount = s.unresolvedTargets.length - ambiguousCount;
                if (ambiguousCount > 0) {
                    html += `<div class="__warn-item __warn-item--warn"><span class="__warn-icon">!</span><span class="__warn-text">${ambiguousCount} requested change(s) not applied — ambiguous element match</span></div>`;
                }
                if (otherCount > 0) {
                    html += `<div class="__warn-item __warn-item--info"><span class="__warn-icon">i</span><span class="__warn-text">${otherCount} target(s) could not be resolved</span></div>`;
                }
            }
        }

        // Phase 6: Readiness delta display
        const rd = render.readinessDelta;
        if (rd && rd.previousScore !== undefined && rd.currentScore !== undefined) {
            const deltaSign = rd.delta >= 0 ? '+' : '';
            const deltaClass = rd.delta > 0 ? 'positive' : rd.delta < 0 ? 'negative' : 'neutral';
            html += `<div class="__trace-row"><span class="__trace-label">Readiness</span><span class="__trace-value"><span class="__refinement-delta __refinement-delta--${deltaClass}">${rd.previousScore} → ${rd.currentScore} (${deltaSign}${rd.delta})</span></span></div>`;
        }

        // Phase 6: Authoring suitability transition
        if (rd && rd.previousAuthoringSuitability && rd.currentAuthoringSuitability && rd.previousAuthoringSuitability !== rd.currentAuthoringSuitability) {
            html += `<div class="__trace-row"><span class="__trace-label">Authoring</span><span class="__trace-value">${rd.previousAuthoringSuitability} → ${rd.currentAuthoringSuitability}</span></div>`;
        }

        // Phase 6: Scope confidence display
        const sc = rr?.scopeConfidence;
        if (sc !== undefined && sc !== null) {
            const band = sc >= 70 ? 'high' : sc >= 40 ? 'medium' : 'low';
            html += `<div class="__trace-row"><span class="__trace-label">Scope Confidence</span><span class="__trace-value"><span class="__refinement-confidence __refinement-confidence--${band}"><span class="__refinement-confidence-bar"><span class="__refinement-confidence-fill" style="width:${sc}%"></span></span> <span class="__refinement-confidence-label">${sc}/100</span></span></span></div>`;
        }

        // Phase 6: Refinement type
        if (rr?.refinementType && rr.refinementType !== 'MIXED') {
            const typeLabel = rr.refinementType.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
            html += `<div class="__trace-row"><span class="__trace-label">Type</span><span class="__trace-value">${typeLabel}</span></div>`;
        }

        content.innerHTML = html;
    },

    /**
     * Display source files as downloadable boxes
     */
    _displayFiles(fileNames) {
        const filesContainer = this.element.querySelector('.__details-files');
        if (!filesContainer) return;

        filesContainer.innerHTML = fileNames.map((fileName) => {
            const fileExt = this._getFileExtension(fileName);
            return `
                <div class="__details-file-item-box __details-file-downloadable" data-filename="${fileName}" title="Click to download ${fileName}">
                    <span class="__details-file-item-box-name">${fileName}</span>
                    <span class="__details-file-item-box-badge">${fileExt}</span>
                </div>
            `;
        }).join('');

        // Bind click handlers for download
        filesContainer.querySelectorAll('.__details-file-downloadable').forEach(el => {
            el.addEventListener('click', () => this._downloadSourceFile(el.dataset.filename));
        });
    },

    /**
     * Download a source file
     */
    async _downloadSourceFile(fileName) {
        if (!this.currentRender) return;

        try {
            const result = await rendersService.getSourceFile(this.currentRender.render_id, fileName);
            if (result.error) {
                console.error('Source file download error:', result.error);
                return;
            }

            // Decode base64 and trigger download
            const byteChars = atob(result.fileData);
            const byteArray = new Uint8Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) {
                byteArray[i] = byteChars.charCodeAt(i);
            }
            const blob = new Blob([byteArray]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Error downloading source file:', error);
        }
    },

    /**
     * Get file extension from filename
     */
    _getFileExtension(filename) {
        const ext = filename.split('.').pop().toUpperCase();
        return ext.length > 5 ? ext.substring(0, 5) : ext;
    },

    // ── Pipeline Trace ────────────────────────────────────────────────────────

    _startTracePolling(renderId) {
        this._tracePoller = setInterval(async () => {
            if (!this.currentRender || this.currentRender.render_id !== renderId) {
                this._stopTracePolling();
                return;
            }
            try {
                const result = await rendersService.getReport(renderId);
                if (result.pipelineTrace?.length) {
                    this._mergeTraceEntries(result.pipelineTrace);
                    this._displayPipelineTrace(Object.values(this._traceEntries));
                }
                // Stop polling once all 5 stages have an 'end' phase
                const endCount = Object.values(this._traceEntries).filter(e => e.phase === 'end').length;
                if (endCount >= 5) this._stopTracePolling();
            } catch (_) { /* poll is best-effort */ }
        }, 2000);
    },

    _stopTracePolling() {
        if (this._tracePoller) { clearInterval(this._tracePoller); this._tracePoller = null; }
    },

    _mergeTraceEntries(entries) {
        for (const entry of entries) {
            const key = `${entry.runId}.${entry.attemptN}`;
            // Additive: once keyed, never change (per plan). Phase 'end' overwrites 'start' for same key.
            const existing = this._traceEntries[key];
            if (!existing || (existing.phase === 'start' && entry.phase === 'end')) {
                this._traceEntries[key] = entry;
            }
        }
    },

    async _loadAndDisplayTrace(render) {
        try {
            const result = await rendersService.getReport(render.render_id);
            if (result.pipelineTrace?.length) {
                this._mergeTraceEntries(result.pipelineTrace);
                this._displayPipelineTrace(Object.values(this._traceEntries));
            }
        } catch (_) { /* trace is non-critical — silently skip */ }
    },

    _displayPipelineTrace(entries) {
        const section = this.element.querySelector('.__details-pipeline-trace');
        const content = this.element.querySelector('.__details-pipeline-trace-content');
        if (!section || !content) return;
        if (entries.length === 0) { section.classList.add('hidden'); return; }
        section.classList.remove('hidden');

        // Best entry per stage: prefer 'end' over 'start', highest attemptN
        const byStage = {};
        for (const e of entries) {
            const prev = byStage[e.stage];
            if (!prev) { byStage[e.stage] = e; continue; }
            if (prev.phase === 'start' && e.phase === 'end') { byStage[e.stage] = e; continue; }
            if (e.phase === prev.phase && (e.attemptN || 0) > (prev.attemptN || 0)) byStage[e.stage] = e;
        }
        const sorted = STAGE_ORDER.map(s => byStage[s]).filter(Boolean);
        if (sorted.length === 0) { section.classList.add('hidden'); return; }

        const fmtTime = iso => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; } };
        const fmtDur = (s, e) => { if (!s || !e) return ''; const ms = new Date(e) - new Date(s); return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; };

        const passCount = sorted.filter(e => e.phase === 'end').length;
        const firstStart = sorted[0]?.startedAt;
        const lastEnd = sorted[sorted.length - 1]?.finishedAt;
        const totalDur = fmtDur(firstStart, lastEnd);
        const timeRange = firstStart ? `${fmtTime(firstStart)}${lastEnd ? ' – ' + fmtTime(lastEnd) : ''}` : '';
        const runLabel = timeRange ? `Run · ${timeRange}${totalDur ? ' · ' + totalDur + ' total' : ''}` : '';

        const chevron = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><polyline points="18 15 12 9 6 15"></polyline></svg>`;

        let html = `
            <div class="__pt-summary">
                <span class="__pt-run-label">${runLabel}</span>
                <span class="__pt-pass-badge __pt-pass-badge--${passCount === sorted.length ? 'all' : 'partial'}">● ${passCount} of ${sorted.length} passed</span>
            </div>
            <div class="__pt-timeline">
        `;

        sorted.forEach((entry, i) => {
            const label = STAGE_LABELS[entry.stage] || entry.stage;
            const isRunning = entry.phase === 'start';
            const isLast = i === sorted.length - 1;
            const dur = fmtDur(entry.startedAt, entry.finishedAt);
            const time = fmtTime(entry.startedAt);
            const attemptBadge = entry.attemptN > 1 ? `<span class="__pt-attempt-badge">#${entry.attemptN}</span>` : '';
            const flags = entry.output?.validationFlags?.length;
            const flagBadge = flags ? `<span class="__pt-flag-badge">${flags} flag${flags > 1 ? 's' : ''}</span>` : '';

            // Detect IFC-type counts (chips) vs simple count string
            const rawCounts = entry.output?.counts || {};
            const isIfcCounts = Object.keys(rawCounts).some(k => k.startsWith('Ifc'));
            let countStr = '';
            let chipsData = [];
            if (isIfcCounts) {
                const total = Object.values(rawCounts).filter(v => typeof v === 'number').reduce((s, v) => s + v, 0);
                countStr = total > 0 ? `${total} elements` : '';
                chipsData = Object.entries(rawCounts).filter(([, v]) => typeof v === 'number' && v > 0);
            } else {
                const parts = Object.entries(rawCounts).filter(([, v]) => typeof v === 'number' && v > 0).map(([k, v]) => `${v} ${k}`);
                countStr = parts.join(' · ');
            }

            // Scalar tags
            const sc = entry.scalars || {};
            const tagItems = [];
            if (sc.gatePassRate != null) {
                const cls = sc.gatePassRate >= 100 ? '--pass' : sc.gatePassRate >= 50 ? '--warn' : '--fail';
                tagItems.push(`<span class="__pt-tag-pair"><span class="__pt-tag-key">GATES</span><span class="__pt-tag-val __pt-tag-val${cls}">${sc.gatePassRate}%</span></span>`);
            }
            if (sc.contractStatus) {
                const cls = sc.contractStatus === 'pass' ? '--pass' : '--fail';
                tagItems.push(`<span class="__pt-tag-pair"><span class="__pt-tag-key">CONTRACT</span><span class="__pt-tag-val __pt-tag-val${cls}">${sc.contractStatus}</span></span>`);
            }
            if (sc.provenanceCompleteness != null) {
                tagItems.push(`<span class="__pt-tag-pair"><span class="__pt-tag-key">PROVENANCE</span><span class="__pt-tag-val">${sc.provenanceCompleteness}%</span></span>`);
            }
            const tagsHtml = tagItems.length ? `<div class="__pt-tags">${tagItems.join('')}</div>` : '';

            const hasChips = chipsData.length > 0;
            const chipsHtml = hasChips
                ? `<div class="__pt-chips">${chipsData.map(([k, v]) => `<span class="__pt-chip"><span class="__pt-chip-count">${v}</span> × ${k.replace('Ifc', '')}</span>`).join('')}</div>`
                : '';

            html += `
                <div class="__pt-stage${isLast ? ' __pt-stage--last' : ''}" data-expanded="${hasChips ? 'false' : 'true'}">
                    <div class="__pt-stage-left">
                        <div class="__pt-dot __pt-dot--${isRunning ? 'running' : 'done'}"></div>
                        ${!isLast ? '<div class="__pt-line"></div>' : ''}
                    </div>
                    <div class="__pt-stage-right">
                        <div class="__pt-stage-header">
                            <div class="__pt-stage-name-row">
                                <span class="__pt-stage-name">${label}</span>
                                ${attemptBadge}${flagBadge}
                            </div>
                            <div class="__pt-meta-right">
                                ${time ? `<span class="__pt-meta-time">${time}</span>` : ''}
                                ${dur ? `<span class="__pt-meta-dur">${dur}</span>` : ''}
                                ${countStr ? `<span class="__pt-meta-count">${countStr}</span>` : ''}
                                ${hasChips ? `<button class="__pt-toggle-btn" aria-label="Toggle details">${chevron}</button>` : ''}
                            </div>
                        </div>
                        ${hasChips ? `<div class="__pt-collapsible">${chipsHtml}${tagsHtml}</div>` : tagsHtml}
                    </div>
                </div>
            `;
        });

        html += `</div>`;
        content.innerHTML = html;

        content.querySelectorAll('.__pt-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const stage = btn.closest('.__pt-stage');
                stage.dataset.expanded = stage.dataset.expanded === 'true' ? 'false' : 'true';
            });
        });
    },

    /**
     * Display traceability / generation report
     */
    _displayTracingReport(render) {
        const section = this.element.querySelector('.__details-traceability');
        const content = this.element.querySelector('.__details-traceability-content');
        if (!section || !content) return;

        const tr = render.tracingReport;
        const mode = render.outputMode;
        if (!tr && !mode) { section.classList.add('hidden'); return; }
        section.classList.remove('hidden');

        const modeColors = { FULL_SEMANTIC: '#4ade80', HYBRID: '#facc15', PROXY_ONLY: '#f87171' };
        const roleColors = { NARRATIVE: '#60a5fa', TECHNICAL_NARRATIVE: '#818cf8', SCHEDULE: '#fb923c', SIMULATION: '#34d399', DEFAULT: '#9ca3af', UNKNOWN: '#9ca3af' };
        const chevron = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="11" height="11"><polyline points="18 15 12 9 6 15"></polyline></svg>`;

        let html = '';

        // Output + confidence summary line
        const { high = 0, medium = 0, low = 0 } = tr?.confidence || {};
        const total = tr?.totalElements || 0;
        const modeCol = modeColors[mode] || '#9ca3af';
        html += `<div class="__src-output">`;
        if (mode) html += `<span class="__src-output-label">Output</span><span class="__src-output-mode" style="background:${modeCol}22;color:${modeCol}">${mode}</span>`;
        if (total > 0) {
            html += `<span class="__src-output-sep">·</span><span class="__src-output-total">${total} total</span>`;
            html += `<span class="__src-output-sep">·</span><span class="__src-output-high">${high} high</span>`;
            html += `<span class="__src-output-sep">·</span><span class="__src-output-med">${medium} med</span>`;
            html += `<span class="__src-output-sep">·</span><span class="__src-output-low${low > 0 ? '--nonzero' : ''}">${low} low</span>`;
        }
        html += `</div>`;

        // Per-file accordion cards
        const byFile = tr?.byFile || {};
        const fileNames = Object.keys(byFile);
        if (fileNames.length > 0) {
            html += `<div class="__src-files">`;
            for (const fname of fileNames) {
                const entry = byFile[fname];
                const role = entry.sourceRole || 'UNKNOWN';
                const col = roleColors[role] || '#9ca3af';
                const types = Object.entries(entry.types || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
                const maxCount = types.length > 0 ? types[0][1] : 1;
                const hasTypes = types.length > 0;

                const typesHtml = types.map(([typeName, count]) => {
                    const pct = Math.round(count * 100 / maxCount);
                    const readable = IFC_HUMAN_NAMES[typeName] || typeName.replace('Ifc', '').replace(/([a-z])([A-Z])/g, '$1 $2');
                    return `<div class="__src-type-row" title="${typeName}">
                        <span class="__src-type-name">${readable}</span>
                        <div class="__src-type-bar"><div class="__src-type-bar-fill" style="width:${pct}%;background:${col}"></div></div>
                        <span class="__src-type-count">${count}</span>
                    </div>`;
                }).join('');

                html += `<div class="__src-card" data-expanded="true">
                    <div class="__src-card-header">
                        <span class="__src-card-name" title="${fname}">${fname}</span>
                        <span class="__src-card-role" style="background:${col}22;color:${col};border:1px solid ${col}33">${role}</span>
                        <span class="__src-card-count">${entry.count} el</span>
                        ${hasTypes ? `<span class="__src-card-arrow">${chevron}</span>` : ''}
                    </div>
                    ${hasTypes ? `<div class="__src-card-body">${typesHtml}</div>` : ''}
                </div>`;
            }
            html += `</div>`;
        }

        // Unused files — uploaded but yielded no extracted elements
        const usedFileSet = new Set(Object.keys(byFile));
        const allUploadedFiles = render.source_files || [];
        const unusedFiles = allUploadedFiles.filter(f => !usedFileSet.has(f));
        if (unusedFiles.length > 0) {
            html += `<div class="__src-unused">
                <span class="__src-unused-label">Not used</span>
                <span class="__src-unused-hint">No elements were extracted from ${unusedFiles.length === 1 ? 'this file' : 'these files'}</span>
                <div class="__src-unused-files">${unusedFiles.map(f => `<span class="__src-unused-file" title="${f}">${f}</span>`).join('')}</div>
            </div>`;
        }

        // Source breakdown footer
        const src = tr?.bySource || {};
        const srcParts = Object.entries(src).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`);
        if (srcParts.length > 0) {
            html += `<div class="__src-sources">${srcParts.join(' · ')}</div>`;
        }

        content.innerHTML = html;

        // Bind accordion toggles
        content.querySelectorAll('.__src-card-header').forEach(header => {
            const card = header.closest('.__src-card');
            if (!card.querySelector('.__src-card-body')) return;
            header.addEventListener('click', () => {
                const expanded = card.dataset.expanded === 'true';
                card.dataset.expanded = expanded ? 'false' : 'true';
            });
        });
    },

    /**
     * Display model quality score
     */
    _displayQualityScore(render) {
        const section = this.element.querySelector('.__details-quality');
        const content = this.element.querySelector('.__details-quality-content');
        if (!section || !content) return;

        const score = render.qualityScore;
        if (score === undefined && !render.validationSummary) { section.classList.add('hidden'); return; }

        section.classList.remove('hidden');
        const displayScore = score || 0;
        const scoreColor = displayScore >= 80 ? '#4ade80' : displayScore >= 60 ? '#facc15' : '#f87171';
        const scoreLabel = displayScore >= 80 ? 'Excellent' : displayScore >= 60 ? 'Good' : 'Needs Review';

        content.innerHTML = `
            <div class="__quality-score-row">
                <div class="__quality-score-ring" style="--score-color: ${scoreColor}; --score-pct: ${displayScore}%">
                    <span class="__quality-score-value">${displayScore}</span>
                </div>
                <div class="__quality-score-meta">
                    <span class="__quality-score-label" style="color:${scoreColor}">${scoreLabel}</span>
                    <span class="__quality-score-desc">Based on semantic coverage, validation, and structure completeness</span>
                </div>
            </div>
        `;
    },

    /**
     * Display model statistics (IFC class counts)
     */
    _displayStats(render) {
        const section = this.element.querySelector('.__details-stats');
        const content = this.element.querySelector('.__details-stats-content');
        if (!section || !content) return;

        const counts = render.elementCounts;
        if (!counts || Object.keys(counts).length === 0) { section.classList.add('hidden'); return; }
        section.classList.remove('hidden');

        // Merge wall sub-types into IfcWall
        const MERGE_TO = { 'IfcWallStandardCase': 'IfcWall' };
        const merged = {};
        for (const [cls, v] of Object.entries(counts)) {
            if (v <= 0) continue;
            const target = MERGE_TO[cls] || cls;
            merged[target] = (merged[target] || 0) + v;
        }

        const classColors = {
            'IfcWall': '#6b7efa', 'IfcSlab': '#7c8bfb', 'IfcColumn': '#8090fb',
            'IfcBeam': '#8090fb', 'IfcMember': '#8090fb',
            'IfcRoof': '#7c8bfb', 'IfcCovering': '#7c8bfb', 'IfcStair': '#9ca3af',
            'IfcDuctSegment': '#3b82f6', 'IfcPipeSegment': '#34d399',
            'IfcDuctFitting': '#60a5fa', 'IfcPipeFitting': '#34d399',
            'IfcFlowFitting': '#60a5fa', 'IfcFlowSegment': '#60a5fa',
            'IfcFan': '#f59e0b', 'IfcPump': '#14b8a6', 'IfcValve': '#14b8a6',
            'IfcBoiler': '#f59e0b', 'IfcChiller': '#14b8a6', 'IfcHeatExchanger': '#14b8a6',
            'IfcAirTerminal': '#3b82f6', 'IfcAirTerminalBox': '#3b82f6',
            'IfcElectricMotor': '#818cf8', 'IfcTransformer': '#818cf8',
            'IfcElectricDistributionBoard': '#818cf8',
            'IfcLightFixture': '#818cf8', 'IfcCableCarrierSegment': '#6b7efa',
            'IfcFurnishingElement': '#9ca3af',
            'IfcSpace': '#60a5fa', 'IfcBuilding': '#94a3b8',
            'IfcBuildingStorey': '#94a3b8', 'IfcSite': '#94a3b8',
            'IfcDoor': '#7da8f7', 'IfcWindow': '#7ec8e3', 'IfcOpeningElement': '#94a3b8',
            'IfcBuildingElementProxy': '#ef4444',
        };

        const DISCIPLINE_GROUPS = [
            { label: 'Structural',    accent: '#6b7efa', types: ['IfcWall','IfcSlab','IfcColumn','IfcBeam','IfcMember','IfcRoof','IfcCovering','IfcStair','IfcRailing'] },
            { label: 'MEP',           accent: '#3b82f6', types: ['IfcDuctSegment','IfcPipeSegment','IfcDuctFitting','IfcPipeFitting','IfcFlowFitting','IfcFlowSegment','IfcFan','IfcPump','IfcValve','IfcBoiler','IfcChiller','IfcCoolingTower','IfcHeatExchanger','IfcAirTerminal','IfcAirTerminalBox','IfcElectricMotor','IfcTransformer','IfcElectricDistributionBoard','IfcLightFixture','IfcCableCarrierSegment'] },
            { label: 'Spatial',       accent: '#94a3b8', types: ['IfcSite','IfcBuilding','IfcBuildingStorey','IfcSpace'] },
            { label: 'Openings',      accent: '#7da8f7', types: ['IfcDoor','IfcWindow','IfcOpeningElement'] },
            { label: 'Unclassified',  accent: '#ef4444', types: ['IfcBuildingElementProxy'] },
        ];

        const total = Object.values(merged).reduce((s, v) => s + v, 0);
        const maxCount = Math.max(...Object.values(merged), 1);

        const assignedTypes = new Set(DISCIPLINE_GROUPS.flatMap(g => g.types));
        const overflow = Object.entries(merged).filter(([cls, v]) => v > 0 && !assignedTypes.has(cls));
        if (overflow.length > 0) {
            DISCIPLINE_GROUPS.push({ label: 'Other', accent: '#9ca3af', types: overflow.map(([cls]) => cls) });
        }

        const groupsHtml = DISCIPLINE_GROUPS.map(({ label, accent, types }) => {
            const rows = types.map(cls => [cls, merged[cls] || 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
            if (rows.length === 0) return '';
            const groupTotal = rows.reduce((s, [, v]) => s + v, 0);
            const isUnclassified = label === 'Unclassified';
            const rowsHtml = rows.map(([cls, count]) => {
                const readable = IFC_HUMAN_NAMES[cls] || cls.replace('Ifc', '').replace(/([a-z])([A-Z])/g, '$1 $2');
                const color = classColors[cls] || accent;
                const barPct = Math.round(count * 100 / maxCount);
                const ofTotal = Math.round(count * 100 / total);
                return `<div class="__stats-v2-row" title="${cls}">
                    <span class="__stats-v2-name" style="color:${isUnclassified ? color : 'var(--text-primary)'}">${readable}</span>
                    <div class="__stats-v2-bar"><div class="__stats-v2-bar-fill" style="width:${barPct}%;background:${color}"></div></div>
                    <span class="__stats-v2-pct">${ofTotal}%</span>
                    <span class="__stats-v2-count" style="color:${isUnclassified ? color : 'var(--text-secondary)'}">${count}</span>
                </div>`;
            }).join('');
            return `<div class="__stats-group">
                <div class="__stats-group-header">
                    <span class="__stats-group-dot" style="background:${accent}"></span>
                    <span class="__stats-group-label">${label}</span>
                    <span class="__stats-group-subtotal">${groupTotal}</span>
                </div>
                <div class="__stats-v2-rows">${rowsHtml}</div>
            </div>`;
        }).join('');

        content.innerHTML = `
            <div class="__stats-v2-header">
                <span class="__stats-v2-label">Model Statistics</span>
                <span class="__stats-v2-total">${total} elements</span>
            </div>
            ${groupsHtml}
        `;
    },

    /**
     * Display combined structural + generation notes
     */
    _displayStructuralWarnings(render) {
        const section = this.element.querySelector('.__details-structural');
        const content = this.element.querySelector('.__details-structural-content');
        if (!section || !content) return;

        const sw = render.structuralWarnings || [];

        const structuralText = w => {
            switch (w.type) {
                case 'envelope_fallback': return 'Simplified envelope generated — source had insufficient structural detail';
                case 'dimension_clamps': return `${w.count} element dimension${w.count > 1 ? 's' : ''} clamped to valid range`;
                case 'shell_continuity': return `${w.pairsAligned} shell pairs aligned across ${w.groups} continuity group${w.groups > 1 ? 's' : ''}`;
                case 'equipment_mounted': return `${w.count} equipment piece${w.count > 1 ? 's' : ''} repositioned for realistic mounting${w.originGuard > 0 ? ` (${w.originGuard} relocated from origin)` : ''}`;
                case 'geometry_approximation': return `${w.count} curved geometr${w.count > 1 ? 'ies' : 'y'} approximated to rectangular`;
                case 'junction_transitions': return `${w.elementCount} junction transition helpers generated${w.voidHelpers > 0 ? ` — ${w.voidHelpers} companion void${w.voidHelpers > 1 ? 's' : ''}` : ''}`;
                case 'shell_extensions': return `${w.count} shell pieces extended at ${w.nodes} junction${w.nodes > 1 ? 's' : ''} for continuity`;
                case 'curved_geometry': return `${(w.circularCount || 0) + (w.horseshoeCount || 0)} circular/horseshoe voids approximated as polygons`;
                case 'opening_validation': return `${w.total} openings validated, ${w.rehosted} rehosted, ${w.downgraded} downgraded`;
                case 'wall_cleanup': return `${w.snappedCount} wall axes cleaned${w.skippedOverCap > 0 ? ` (${w.skippedOverCap} skipped)` : ''}`;
                case 'interior_coherence': return `Interior coherence: ${w.grade}`;
                case 'refinement_report': { const s = w.summary || {}; return `Revision — ${s.addedCount || 0} added, ${s.removedCount || 0} removed, ${s.modifiedCount || 0} modified`; }
                case 'approximation_proxies': return `${w.count} approximation helper prox${w.count > 1 ? 'ies' : 'y'} excluded from canonical counts`;
                case 'safety': return w.detail;
                default: return w.type + (w.detail ? `: ${w.detail}` : '');
            }
        };

        // Collect generation warnings
        const counts = render.elementCounts || {};
        const total = Object.values(counts).reduce((s, n) => s + n, 0);
        const proxyCount = counts['IfcBuildingElementProxy'] || 0;
        const proxyPct = total > 0 ? Math.round(proxyCount * 100 / total) : 0;
        const vs = render.validationSummary || {};
        const mode = render.outputMode;
        const tr = render.tracingReport || {};
        const genTexts = [];
        if (proxyPct > 30) genTexts.push(`${proxyPct}% of elements are unclassified proxies`);
        if (!counts['IfcPipeSegment'] && !counts['IfcPump'] && total > 10) genTexts.push('No piping or pump systems detected');
        if (mode === 'PROXY_ONLY') genTexts.push('Model in PROXY_ONLY fallback mode');
        if (tr.envelopeFallbackApplied) genTexts.push('Simplified envelope — insufficient structural detail in source');
        if (tr.interiorSuppression?.suppressed > 0) genTexts.push(`${tr.interiorSuppression.suppressed} implausible rooms removed`);
        if (vs.warningCount > 3) genTexts.push(`${vs.warningCount} IFC validation warnings`);
        const confDist = tr.confidence || {};
        if (confDist.low > confDist.high && confDist.low > 0) genTexts.push(`More low-confidence (${confDist.low}) than high-confidence (${confDist.high}) elements`);

        const items = [
            ...sw.map(w => ({ category: 'structural', text: structuralText(w) })).filter(i => i.text),
            ...genTexts.map(text => ({ category: 'generation', text })),
        ];

        if (items.length === 0) { section.classList.add('hidden'); return; }
        section.classList.remove('hidden');

        content.innerHTML = items.map(item => `
            <div class="__notes-item">
                <span class="__notes-dot __notes-dot--${item.category}"></span>
                <span class="__notes-category __notes-category--${item.category}">${item.category}</span>
                <span class="__notes-text">${item.text}</span>
            </div>
        `).join('');
    },

    /**
     * Generation warnings merged into _displayStructuralWarnings above
     */
    _displayWarnings(render) {
        const section = this.element.querySelector('.__details-warnings');
        if (section) section.classList.add('hidden');
    },

    /**
     * Display unmodeled findings from source fusion
     */
    _displayOmitted(render) {
        const section = this.element.querySelector('.__details-omitted');
        const content = this.element.querySelector('.__details-omitted-content');
        if (!section || !content) return;

        const fusion = render.tracingReport?.sourceFusion || render.sourceFusion || {};
        const log = fusion.log || [];
        const unresolved = log.filter(l => l.reason === 'no_anchor' || l.reason === 'low_confidence' || l.reason === 'metadata_only_low_confidence');

        if (unresolved.length === 0) { section.classList.add('hidden'); return; }
        section.classList.remove('hidden');

        const reasonLabels = { no_anchor: 'No anchor', low_confidence: 'Low confidence', metadata_only_low_confidence: 'Low confidence' };

        content.innerHTML =
            `<p class="__omitted-desc">${unresolved.length} item${unresolved.length > 1 ? 's' : ''} found in documents but not modeled:</p>` +
            unresolved.slice(0, 10).map(u =>
                `<div class="__omitted-item">
                    <span class="__omitted-name">${u.name || 'Unknown'}</span>
                    <span class="__omitted-type">${u.type || ''}</span>
                    <span class="__omitted-reason">${reasonLabels[u.reason] || u.reason}</span>
                </div>`
            ).join('') +
            (unresolved.length > 10 ? `<p class="__omitted-more">+ ${unresolved.length - 10} more</p>` : '');
    },

    /**
     * Handle delete render
     */
    async _handleDelete() {
        if (!this.currentRender) return;

        const confirmed = await modalService.confirm(
            'Delete Render',
            'Are you sure you want to delete this render? This cannot be undone.',
            'Delete',
            'Cancel'
        );
        if (!confirmed) return;

        try {
            const renderId = this.currentRender.render_id;
            await rendersService.deleteRender(renderId);

            // Redirect to welcome screen (same as new render)
            document.dispatchEvent(new CustomEvent('newRenderRequested'));

            // Refresh renders list in sidebar
            document.dispatchEvent(new CustomEvent('rendersUpdated'));

        } catch (error) {
            console.error('Error deleting render:', error);
            await modalService.alert('Error', `Failed to delete render: ${error.message}`);
        }
    }
};

export default details;
