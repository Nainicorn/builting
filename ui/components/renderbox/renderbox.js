import template from './renderbox.hbs';
import './renderbox.css';
import ifcViewer from '../ifc-viewer/ifc-viewer.js';
import uploadService from '../../services/uploadService.js';
import usersService from '../../services/usersService.js';
import rendersService from '../../services/rendersService.js';
import modalService from '../../services/modalService.js';
const renderbox = {
    element: null,
    viewerCanvas: null,
    stagedFiles: [], // Files waiting to be uploaded
    MAX_FILES: 15, // Maximum number of files allowed
    pollingInterval: null,
    currentRenderId: null,
    pollingStartTime: null,
    currentBlobUrl: null, // Track blob URL to prevent premature garbage collection
    isRendering: false, // Flag to track if render is currently in progress
    currentRenderTitle: null, // AI-generated title of the active render (for download filename)
    _onElementPicked: null,   // Stored handler refs for deduplication
    _onElementPickCleared: null,

    // Initialize the renderbox component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__renderbox');
        let html = template({ main: true });
        this.element.innerHTML = html;
        // Set initial state
        this.element.dataset.state = 'new-render';
        // Apply is-empty so placeholder CSS shows on load
        const descInput = this.element.querySelector('.__renderbox-description');
        if (descInput) descInput.classList.add('is-empty');
    },

    // Load data and initialize viewer
    async _loadData() {
        try {
            this.user = await usersService.getCurrentUser();
            this._updateUserDisplay();
        } catch (error) {
            console.error('Failed to load user:', error);
        }
        await this._initViewer();
    },

    // Update user display in renderbox
    _updateUserDisplay() {
        if (this.user) {
            const $userName = this.element.querySelector('.__renderbox-user-name');
            if ($userName) {
                $userName.textContent = this.user.name || 'User';
            }
        }
    },

    // Bind event listeners
    _bindListeners() {
        this._bindEvents();
        this._preventPageZoom();
    },

    /**
     * Prevent page zoom when scrolling over the IFC viewer
     */
    _preventPageZoom() {
        const viewer = this.element.querySelector('.__renderbox-viewer');
        if (viewer) {
            viewer.addEventListener('wheel', (e) => {
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                }
            }, { passive: false });
        }
    },

    /**
     * Update the message text in the renderbox
     */
    _updateMessage(text) {
        const messageEl = this.element.querySelector('.__renderbox-message-text');
        if (messageEl) {
            messageEl.textContent = text;
        }
    },

    /**
     * Update the input label text above the input bar
     */
    _updateInputLabel(text) {
        const labelEl = this.element.querySelector('.__renderbox-input-label');
        if (labelEl) {
            labelEl.textContent = text;
        }
    },

    /**
     * Update the input placeholder text
     */
    _updateInputPlaceholder(text) {
        const inputEl = this.element.querySelector('.__renderbox-description');
        if (inputEl) {
            inputEl.setAttribute('placeholder', text);
        }
    },

    /**
     * Show error message to user
     */
    _showError(message) {
        console.error('UI Error:', message);
        modalService.alert('Error', message);
    },

    /**
     * Initialize the IFC viewer canvas and xeokit instance
     */
    async _initViewer() {
        try {
            const viewerContainer = this.element.querySelector('.__renderbox-viewer');

            // Create canvas element
            this.viewerCanvas = document.createElement('canvas');
            this.viewerCanvas.id = 'ifc-viewer-canvas';
            this.viewerCanvas.style.width = '100%';
            this.viewerCanvas.style.height = '100%';
            this.viewerCanvas.style.display = 'block';
            viewerContainer.appendChild(this.viewerCanvas);

            // Initialize xeokit viewer (async - waits for WASM to load)
            await ifcViewer.init(this.viewerCanvas);

        } catch (error) {
            console.error('Failed to initialize viewer:', error);
            this._showError('Failed to initialize viewer');
        }
    },

    /**
     * Load IFC file from a signed S3 URL
     * @param {string} url - Presigned S3 URL for the IFC file
     */
    async loadIFCFromUrl(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch IFC: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();

            // Load via ArrayBuffer (xeokit will handle it directly without HTTP fetch)
            await ifcViewer.loadIFC(arrayBuffer);

            // Resize viewer after layout change and focus canvas for interaction
            ifcViewer.resize();
            const canvas = this.element.querySelector('#ifc-viewer-canvas');
            if (canvas) canvas.focus();

            // Set up element pick events (element click → source info chip)
            ifcViewer.setupPickEvents();
            this._bindPickEvents();

            // Only capture thumbnail if one doesn't already exist for this render.
            // This keeps thumbnails static after initial capture — clicking an old render
            // in the sidebar won't overwrite its thumbnail with a different camera angle.
            const renderId = this.element.dataset.renderId;
            if (renderId) {
                const sidebar = (await import('../sidebar/sidebar.js')).default;
                const existingThumb = sidebar.thumbnailCache.get(renderId);
                if (!existingThumb) {
                    this._captureThumbnail(renderId);
                }
            }

        } catch (error) {
            console.error('Failed to load IFC file:', error);
            throw error;
        }
    },


    /**
     * Handle "New Render" button click
     */
    _handleNewRender() {
        this._stopPolling();
        this._hideLoadingState();
        this.element.dataset.state = 'new-render';
        delete this.element.dataset.renderId;
        this._updateMessage('Select a render from the sidebar or create a new one');
        this._updateInputPlaceholder('Describe the structure you want to generate...');
        this._updateInputLabel('Describe your structure');
        this._clearDescriptionInput();
        // Show welcome message again
        const messageEl = this.element.querySelector('.__renderbox-message');
        if (messageEl) {
            messageEl.style.display = 'block';
        }
        ifcViewer.clear();
    },

    // Clear the description input and restore placeholder
    _clearDescriptionInput() {
        const descriptionInput = this.element.querySelector('.__renderbox-description');
        if (descriptionInput) {
            descriptionInput.textContent = '';
            descriptionInput.classList.add('is-empty');
        }
    },

    /**
     * Handle render selection from sidebar
     */
    async _handleRenderSelected(renderId) {
        try {
            const render = await rendersService.getRender(renderId);

            if (!render || render.error) {
                this._showError(render?.error || 'Render not found');
                document.dispatchEvent(new CustomEvent('rendersUpdated'));
                return;
            }

            if (render.status === 'completed') {
                // Set state immediately so UI reflects selection
                this.element.dataset.renderId = renderId;
                this.element.dataset.state = 'viewing-render';
                this.currentRenderTitle = render.ai_generated_title || render.title || null;
                this._updateMessage('');
                this._updateInputPlaceholder('Describe refinements to apply...');
                this._updateInputLabel('Refinement');
                this._clearDescriptionInput();
                this.stagedFiles = [];
                this._updateFilePreview();

                // Open details panel immediately — don't wait for IFC to finish loading
                document.dispatchEvent(new CustomEvent('renderSelected', {
                    detail: { render }
                }));

                // Load IFC (may take time; errors here don't block the details panel)
                try {
                    const { downloadUrl } = await rendersService.getDownloadUrl(renderId);
                    await this.loadIFCFromUrl(downloadUrl);
                } catch (ifcError) {
                    console.error('IFC load error:', ifcError);
                    this._showError('Failed to load 3D model: ' + ifcError.message);
                }
            } else if (render.status === 'failed_contract') {
                const errorMsg = render.error_message || 'A pipeline contract check detected a schema violation in the generated data.';
                const action = await modalService.choice(
                    '⚠ Schema Validation Failed',
                    `This render was stopped because a data contract check failed — the pipeline output did not match the expected schema.\n\nThis usually means the input files produced unexpected data. Retrying the same files is unlikely to help.\n\nDetails: ${errorMsg}`,
                    [
                        { text: 'Keep', value: 'keep' },
                        { text: 'Delete', value: 'delete', primary: true }
                    ]
                );
                if (action === 'delete') {
                    await rendersService.deleteRender(renderId);
                    document.dispatchEvent(new CustomEvent('rendersUpdated'));
                    document.dispatchEvent(new CustomEvent('newRenderRequested'));
                }
            } else if (render.status === 'failed') {
                const errorMsg = render.error_message || 'Unknown error occurred during rendering';
                const action = await modalService.choice(
                    'Render Failed',
                    `This render failed to process.\n\nError: ${errorMsg}`,
                    [
                        { text: 'Keep', value: 'keep' },
                        { text: 'Delete', value: 'delete' },
                        { text: 'Retry', value: 'retry', primary: true }
                    ]
                );
                if (action === 'delete') {
                    await rendersService.deleteRender(renderId);
                    document.dispatchEvent(new CustomEvent('rendersUpdated'));
                    document.dispatchEvent(new CustomEvent('newRenderRequested'));
                } else if (action === 'retry') {
                    try {
                        await rendersService.retryRender(renderId);
                        this.currentRenderId = renderId;
                        this._showLoadingState();
                        this._startPolling();
                        document.dispatchEvent(new CustomEvent('rendersUpdated'));
                    } catch (err) {
                        console.error('Retry failed:', err);
                        await modalService.alert('Retry Failed', err.message || 'Could not retry this render.');
                    }
                }
            } else if (render.status === 'processing' || render.status === 'pending') {
                const ageMinutes = (Date.now() / 1000 - (render.created_at || 0)) / 60;
                if (ageMinutes > 3) {
                    const shouldDelete = await modalService.confirm(
                        'Render Stalled',
                        `This render has been ${render.status} for over ${Math.floor(ageMinutes)} minutes and may have failed.\n\nWould you like to delete it?`,
                        'Delete',
                        'Keep Waiting'
                    );
                    if (shouldDelete) {
                        await rendersService.deleteRender(renderId);
                        document.dispatchEvent(new CustomEvent('rendersUpdated'));
                        document.dispatchEvent(new CustomEvent('newRenderRequested'));
                    }
                } else {
                    await modalService.alert('Render In Progress', `This render is still ${render.status}. Please check back shortly.`);
                }
            }
        } catch (error) {
            console.error('Error loading render:', error);
            const errorMsg = error.message || 'Unknown error';

            // Check if this is a parsing/corruption error from web-ifc
            if (errorMsg.includes('unexpected token') || errorMsg.includes('GetSetArgument') || errorMsg.includes('Invalid IFC')) {
                const shouldDelete = await modalService.confirm(
                    'Corrupted Render',
                    'This render file is corrupted and cannot be loaded.\n\nWould you like to delete it?',
                    'Delete',
                    'Cancel'
                );

                if (shouldDelete) {
                    try {
                        await rendersService.deleteRender(renderId);
                        // Refresh sidebar to remove deleted entry
                        document.dispatchEvent(new CustomEvent('rendersUpdated'));
                        // Reset to welcome screen
                        document.dispatchEvent(new CustomEvent('newRenderRequested'));
                        await modalService.alert('Success', 'Corrupted render has been deleted.');
                    } catch (deleteError) {
                        console.error('Failed to delete corrupted render:', deleteError);
                        this._showError('Failed to delete render: ' + deleteError.message);
                    }
                }
            } else {
                this._showError('Failed to load render: ' + errorMsg);
            }
        }
    },

    /**
     * Handle file selection - stage files for upload (don't upload yet)
     */
    _handleFileSelected(files) {
        if (files.length === 0) {
            return;
        }

        const newFiles = Array.from(files);
        const availableSlots = this.MAX_FILES - this.stagedFiles.length;

        if (newFiles.length > availableSlots) {
            if (availableSlots === 0) {
                this._showError(`Maximum ${this.MAX_FILES} files allowed. Remove some files first.`);
                return;
            }
            this._showError(`Only ${availableSlots} file(s) can be added. Maximum is ${this.MAX_FILES} files.`);
            // Add only as many as we can fit
            this.stagedFiles.push(...newFiles.slice(0, availableSlots));
        } else {
            // Add new files to staged files
            this.stagedFiles.push(...newFiles);
        }

        // Show file preview
        this._updateFilePreview();
    },

    /**
     * Get file extension from filename
     */
    _getFileExtension(filename) {
        const ext = filename.split('.').pop().toUpperCase();
        return ext.length > 5 ? ext.substring(0, 5) : ext;
    },

    /**
     * Update the file preview display
     */
    _updateFilePreview() {
        const stagingSection = this.element.querySelector('.__renderbox-file-staging');
        const fileGrid = this.element.querySelector('.__renderbox-file-grid');
        const attachBtn = this.element.querySelector('.__renderbox-attach');

        if (this.stagedFiles.length === 0) {
            stagingSection.classList.add('hidden');
            if (attachBtn) attachBtn.classList.remove('is-disabled');
            return;
        }

        stagingSection.classList.remove('hidden');

        // Build file grid with box style
        fileGrid.innerHTML = this.stagedFiles.map((file, index) => {
            const fileExt = this._getFileExtension(file.name);
            return `
                <div class="__renderbox-file-item-box" title="${file.name}">
                    <span class="__renderbox-file-item-box-name">${file.name}</span>
                    <span class="__renderbox-file-item-box-badge">${fileExt}</span>
                    <button class="__renderbox-file-item-remove" data-index="${index}" title="Remove file">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');

        // Disable attach label if max files reached
        if (attachBtn) {
            if (this.stagedFiles.length >= this.MAX_FILES) {
                attachBtn.classList.add('is-disabled');
                attachBtn.title = `Maximum ${this.MAX_FILES} files reached`;
            } else {
                attachBtn.classList.remove('is-disabled');
                attachBtn.title = 'Attach files';
            }
        }

        // Bind remove buttons
        fileGrid.querySelectorAll('.__renderbox-file-item-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(e.currentTarget.dataset.index);
                this.stagedFiles.splice(index, 1);
                this._updateFilePreview();
            });
        });
    },

    /**
     * Handle "Start Render" button click - upload files to S3
     */
    async _handleStartRender() {
        // Capture description from input
        const descriptionInput = this.element.querySelector('.__renderbox-description');
        const description = descriptionInput?.textContent.trim() || '';

        if ((!this.stagedFiles || this.stagedFiles.length === 0) && !description) {
            this._showError('Please attach files or enter a description');
            return;
        }

        try {

            // Hide welcome message and file staging before showing loading
            const messageEl = this.element.querySelector('.__renderbox-message');
            if (messageEl) {
                messageEl.style.display = 'none';
            }
            const stagingSection = this.element.querySelector('.__renderbox-file-staging');
            if (stagingSection) {
                stagingSection.classList.add('hidden');
            }

            // Show loading state
            this._showLoadingState('Uploading files...');

            // Build file list — if text-only, create a .txt file from the description
            const filesToUpload = [...this.stagedFiles];
            if (filesToUpload.length === 0 && description) {
                const descBlob = new Blob([description], { type: 'text/plain' });
                const descFile = new File([descBlob], 'input.txt', { type: 'text/plain' });
                filesToUpload.push(descFile);
            }

            const fileNames = filesToUpload.map(f => f.name);
            const { uploadUrls, renderId, descriptionUrl } =
                await uploadService.getPresignedUrls(fileNames, description);

            // Upload files
            for (const file of filesToUpload) {
                await uploadService.uploadToS3(uploadUrls[file.name], file);
            }

            // Upload description.txt if provided (separate from input files)
            if (description && descriptionUrl) {
                await uploadService.uploadDescription(descriptionUrl, description);
            }

            // Finalize upload — triggers the pipeline
            this._showLoadingState('Starting render pipeline...');
            await uploadService.finalizeRender(renderId);

            // Clear UI
            this.stagedFiles = [];
            this._clearDescriptionInput();

            // Start polling for render status
            this._startPolling(renderId);

        } catch (error) {
            console.error('Upload failed:', error);
            this._hideLoadingState();
            // Show message again on error
            const messageEl = this.element.querySelector('.__renderbox-message');
            if (messageEl) {
                messageEl.style.display = 'block';
            }
            // Show file staging again on error
            const stagingSection = this.element.querySelector('.__renderbox-file-staging');
            if (stagingSection && this.stagedFiles.length > 0) {
                stagingSection.classList.remove('hidden');
            }
            this._showError(`Failed to upload: ${error.message}`);
        }
    },

    /**
     * Bind element pick events from IFC viewer — show/hide element metadata panel
     */
    _bindPickEvents() {
        // Remove any previously bound pick listeners to avoid duplicates
        if (this._onElementPicked) document.removeEventListener('elementPicked', this._onElementPicked);
        if (this._onElementPickCleared) document.removeEventListener('elementPickCleared', this._onElementPickCleared);

        const panel     = this.element.querySelector('.__renderbox-element-panel');
        const panelType = this.element.querySelector('.__renderbox-panel-type-badge');
        const panelName = this.element.querySelector('.__renderbox-panel-name');
        const closeBtn  = this.element.querySelector('.__renderbox-panel-close');

        // Bind close button exactly once — guard against re-binding on repeated IFC loads
        if (closeBtn && !closeBtn.dataset.closeBound) {
            closeBtn.dataset.closeBound = '1';
            closeBtn.addEventListener('click', () => {
                if (panel) panel.classList.add('hidden');
            });
        }

        // Provenance detection: pset names or property keys that signal source/confidence data
        const PROVENANCE_PSET_RE = /source|provenance|evidence|confidence|builting/i;
        const PROVENANCE_PROP_RE = /^(confidence|evidence_quote|source_file|source_page)$/i;

        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const buildRow = (key, val) =>
            `<div class="__renderbox-panel-row">` +
            `<span class="__renderbox-panel-row-key">${esc(key)}</span>` +
            `<span class="__renderbox-panel-row-val">${esc(val)}</span>` +
            `</div>`;

        this._onElementPicked = async (e) => {
            if (!panel || !panelType || !panelName) return;
            const { type, name, id } = e.detail;

            // Show panel immediately with header — body fills asynchronously
            const readableType = type.replace(/^Ifc/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
            panelType.textContent = readableType;
            const readableName = name && name.length < 80 && !name.startsWith('#') ? name : '';
            panelName.textContent = readableName || readableType;
            panel.classList.remove('hidden');

            // Clear all sections while fetch is in flight
            const geoEl  = panel.querySelector('.__renderbox-panel-geometry');
            const relEl  = panel.querySelector('.__renderbox-panel-relationships');
            const provEl = panel.querySelector('.__renderbox-panel-provenance');
            [geoEl, relEl, provEl].forEach(el => {
                if (el) { el.innerHTML = ''; el.classList.remove('has-separator'); }
            });

            try {
                const result = await ifcViewer.getElementProperties(id);
                if (!result) return;

                const { groups, geometry, relationships } = result;

                // ── Geometry ──────────────────────────────────────────────
                if (geoEl && geometry) {
                    geoEl.innerHTML =
                        `<div class="__renderbox-panel-section-label">Geometry</div>` +
                        buildRow('Width',  geometry.width  + ' m') +
                        buildRow('Depth',  geometry.depth  + ' m') +
                        buildRow('Height', geometry.height + ' m') +
                        buildRow('Center', geometry.center + ' m');
                }

                // ── Relationships ─────────────────────────────────────────
                if (relEl && relationships && relationships.length > 0) {
                    relEl.innerHTML =
                        `<div class="__renderbox-panel-section-label">Relationships</div>` +
                        relationships.map(r => buildRow(r.name, r.value)).join('');
                }

                // ── Partition psets: provenance vs regular ────────────────
                const provGroups = [], regularGroups = [];
                for (const group of (groups || [])) {
                    if (PROVENANCE_PSET_RE.test(group.name)) {
                        provGroups.push(group);
                    } else {
                        const prov = group.props.filter(p => PROVENANCE_PROP_RE.test(p.name));
                        const norm = group.props.filter(p => !PROVENANCE_PROP_RE.test(p.name));
                        if (prov.length > 0) provGroups.push({ name: group.name, props: prov });
                        if (norm.length > 0) regularGroups.push({ name: group.name, props: norm });
                    }
                }

                // ── Provenance (Pset_BuiltingProvenance + others) ─────────
                // Source file references are display labels only — do not add hyperlinks;
                // these are S3 key fragments with no public URL.
                if (provEl && provGroups.length > 0) {
                    let html = '';

                    const builtingPset = provGroups.find(g => g.name === 'Pset_BuiltingProvenance');
                    if (builtingPset) {
                        const getVal = (name) => builtingPset.props.find(p => p.name === name)?.value || '';
                        const status = getVal('SourceFileStatus');
                        const sourceFile = getVal('SourceFile');
                        const stage = getVal('Stage');
                        const mods = getVal('Modifications');

                        const KNOWN_STATUSES = new Set([
                            'direct', 'inherited_consensus', 'inherited_contested',
                            'derived_geometric', 'derived_inferred', 'missing', 'legacy',
                        ]);

                        let sourceDisplay;
                        if (!status) {
                            sourceDisplay = 'Source: not recorded (legacy render)';
                        } else if (status === 'missing') {
                            sourceDisplay = 'Source: unknown';
                        } else if (status === 'derived_inferred') {
                            sourceDisplay = 'Source: inferred (no upstream file)';
                        } else if (status === 'inherited_contested') {
                            sourceDisplay = `Source: ${sourceFile} (contested)`;
                        } else if (!KNOWN_STATUSES.has(status)) {
                            console.warn('[IFC] Unknown provenance status:', status);
                            sourceDisplay = 'Source: unknown';
                        } else {
                            sourceDisplay = `Source: ${sourceFile || '<unknown>'}`;
                        }

                        html += `<div class="__renderbox-panel-section-label">Provenance</div>`;
                        html += `<div class="__renderbox-panel-row"><span class="__renderbox-panel-row-val">${esc(sourceDisplay)}</span></div>`;
                        if (stage) html += buildRow('Stage', stage);
                        if (mods) html += buildRow('Modifications', mods);
                    }

                    const otherProvGroups = provGroups.filter(g => g.name !== 'Pset_BuiltingProvenance');
                    for (const g of otherProvGroups) {
                        if (!html) html += `<div class="__renderbox-panel-section-label">Source Provenance</div>`;
                        const rows = g.props.map(p => buildRow(p.name, p.value)).join('');
                        if (!rows) continue;
                        html += `<div class="__renderbox-panel-pset-group">` +
                            `<div class="__renderbox-panel-pset-name">${esc(g.name)}</div>` +
                            rows + `</div>`;
                    }

                    if (html) provEl.innerHTML = html;
                }

                // Add visual separators between populated sections
                let firstFilled = true;
                for (const el of [geoEl, relEl, provEl]) {
                    if (!el || !el.innerHTML) continue;
                    if (!firstFilled) el.classList.add('has-separator');
                    firstFilled = false;
                }

            } catch (_) {
                // Non-fatal — panel still shows type/name in header
            }
        };

        this._onElementPickCleared = () => {
            if (panel) panel.classList.add('hidden');
        };

        document.addEventListener('elementPicked', this._onElementPicked);
        document.addEventListener('elementPickCleared', this._onElementPickCleared);
    },

    /**
     * Handle refinement submission when a render is already loaded
     */
    async _handleRefineRender() {
        const descriptionInput = this.element.querySelector('.__renderbox-description');
        const refinement = descriptionInput?.textContent.trim() || '';
        if (!refinement) {
            this._showError('Please describe the correction to apply');
            return;
        }

        const renderId = this.element.dataset.renderId;
        if (!renderId) return;

        try {
            this._showLoadingState('Submitting refinement...');
            this._clearDescriptionInput();

            await rendersService.refineRender(renderId, refinement);

            // Clear stale thumbnail so sidebar shows placeholder until new capture
            const sidebar = (await import('../sidebar/sidebar.js')).default;
            sidebar.thumbnailCache.remove(renderId);

            // Poll on the same render ID (refinement updates in-place)
            this._startPolling(renderId);
        } catch (error) {
            console.error('Refinement failed:', error);
            this._hideLoadingState();
            this._showError(`Failed to submit refinement: ${error.message}`);
        }
    },

    /**
     * Bind all event listeners
     */
    _bindEvents() {
        // Listen for new render requests from sidebar
        document.addEventListener('newRenderRequested', () => {
            this._handleNewRender();
        });

        // Listen for render selection from sidebar (only process if id is provided)
        document.addEventListener('renderSelected', async (e) => {
            // Guard against renderbox's own renderSelected dispatch
            if (e.detail.id) {
                await this._handleRenderSelected(e.detail.id);
            }
        });

        // File input change — label[for] handles opening the picker natively
        const fileInput = this.element.querySelector('#__renderbox-file-input');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                this._handleFileSelected(e.target.files);
                // Reset so the same file can be selected again
                e.target.value = '';
            });
        }

        // Handle "Start Render" button click — routes based on current state
        const startBtn = this.element.querySelector('.__renderbox-start');
        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                if (this.element.dataset.state === 'viewing-render') {
                    await this._handleRefineRender();
                } else {
                    await this._handleStartRender();
                }
            });
        }

        // Handle description input - allow submitting with Enter
        const descriptionInput = this.element.querySelector('.__renderbox-description');
        if (descriptionInput) {
            // Stop all keyboard events from reaching the xeokit viewer canvas
            // (otherwise WASD/arrows move the camera while typing)
            descriptionInput.addEventListener('keydown', async (e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (this.element.dataset.state === 'viewing-render') {
                        await this._handleRefineRender();
                    } else {
                        await this._handleStartRender();
                    }
                }
            });
            descriptionInput.addEventListener('keyup', (e) => e.stopPropagation());
            descriptionInput.addEventListener('keypress', (e) => e.stopPropagation());

            // Monitor input content to show/hide placeholder
            const updateEmptyState = () => {
                const isEmpty = descriptionInput.textContent.trim() === '';
                if (isEmpty) {
                    descriptionInput.classList.add('is-empty');
                } else {
                    descriptionInput.classList.remove('is-empty');
                }
            };

            descriptionInput.addEventListener('input', updateEmptyState);
            descriptionInput.addEventListener('blur', updateEmptyState);
            descriptionInput.addEventListener('focus', updateEmptyState);

            // Set initial state
            updateEmptyState();
        }

        // Download button inside viewer (primary = IFC)
        const downloadBtn = this.element.querySelector('.__renderbox-viewer-download');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', async () => {
                await this._handleDownload('ifc');
            });
        }

    },


    /**
     * Show loading state with spinner (for uploads and polling)
     */
    _showLoadingState(message) {
        const uploadLoadingEl = this.element.querySelector('.__renderbox-upload-loading');
        if (uploadLoadingEl) {
            uploadLoadingEl.classList.remove('hidden');
            const textEl = uploadLoadingEl.querySelector('.__renderbox-loading-text');
            if (textEl) textEl.textContent = message;
        }
        // Hide the empty-state logo so loading overlay doesn't overlap it
        const emptyIcon = this.element.querySelector('.__renderbox-empty-icon');
        if (emptyIcon) emptyIcon.style.display = 'none';
        // Disable buttons during upload
        const startBtn = this.element.querySelector('.__renderbox-start');
        const attachBtn = this.element.querySelector('.__renderbox-attach');
        if (startBtn) startBtn.disabled = true;
        if (attachBtn) attachBtn.classList.add('is-disabled');
    },

    /**
     * Hide loading state
     */
    _hideLoadingState() {
        const uploadLoadingEl = this.element.querySelector('.__renderbox-upload-loading');
        if (uploadLoadingEl) uploadLoadingEl.classList.add('hidden');
        // Restore the empty-state logo
        const emptyIcon = this.element.querySelector('.__renderbox-empty-icon');
        if (emptyIcon) emptyIcon.style.display = '';
        // Re-enable buttons
        const startBtn = this.element.querySelector('.__renderbox-start');
        const attachBtn = this.element.querySelector('.__renderbox-attach');
        if (startBtn) startBtn.disabled = false;
        if (attachBtn) attachBtn.classList.remove('is-disabled');
    },

    /**
     * Update loading message
     */
    _updateLoadingMessage(message) {
        const uploadLoadingEl = this.element.querySelector('.__renderbox-upload-loading');
        if (uploadLoadingEl) {
            const textEl = uploadLoadingEl.querySelector('.__renderbox-loading-text');
            const elapsedEl = uploadLoadingEl.querySelector('.__renderbox-pipeline-elapsed');
            if (textEl) {
                // Show elapsed time in pipeline status
                if (message.includes('(')) {
                    const timeMatch = message.match(/\(([^)]+)\)/);
                    textEl.textContent = 'Processing';
                    if (timeMatch && elapsedEl) {
                        elapsedEl.textContent = timeMatch[1];
                    }
                } else {
                    textEl.textContent = message.includes('Processing') ? 'Processing' : message;
                    if (elapsedEl) elapsedEl.textContent = '';
                }
            }
        }
    },

    /**
     * Start polling for render status
     */
    _startPolling(renderId) {
        this.currentRenderId = renderId;
        this.pollingStartTime = Date.now();
        this.isRendering = true; // Set flag to indicate rendering in progress
        this._updateLoadingMessage('Processing your render...');
        this._pollRenderStatus();
    },

    /**
     * Poll render status with exponential backoff
     */
    async _pollRenderStatus() {
        if (!this.currentRenderId) return;

        try {
            const render = await rendersService.getRender(this.currentRenderId);
            const elapsed = Date.now() - this.pollingStartTime;
            const minutes = Math.floor(elapsed / 60000);

            if (render.status === 'completed') {
                this._handleRenderCompleted(render);
                return;
            } else if (render.status === 'failed_contract') {
                this._stopPolling();
                this._hideLoadingState();

                const errorMsg = render.error_message || 'A pipeline contract check detected a schema violation.';
                console.error('[contract_failure] render stopped at contract check:', errorMsg);

                const action = await modalService.choice(
                    '⚠ Schema Validation Failed',
                    `Your render was stopped because a data contract check failed.\n\nThis means the pipeline output did not match the expected schema. Retrying the same files is unlikely to help — the input may need to be revised.\n\nDetails: ${errorMsg}`,
                    [
                        { text: 'New Render', value: 'new', primary: true }
                    ]
                );

                this._handleNewRender();
                document.dispatchEvent(new CustomEvent('rendersUpdated'));
                return;
            } else if (render.status === 'failed') {
                this._stopPolling();
                this._hideLoadingState();

                const errorMsg = render.error_message || 'Unknown error occurred during rendering';
                console.error('Render failed with status:', errorMsg);

                const action = await modalService.choice(
                    'Render Failed',
                    `Your render failed to process.\n\nError: ${errorMsg}`,
                    [
                        { text: 'New Render', value: 'new' },
                        { text: 'Retry', value: 'retry', primary: true }
                    ]
                );

                if (action === 'retry') {
                    try {
                        await rendersService.retryRender(this.currentRenderId);
                        this._showLoadingState();
                        this._startPolling();
                        document.dispatchEvent(new CustomEvent('rendersUpdated'));
                    } catch (err) {
                        console.error('Retry failed:', err);
                        await modalService.alert('Retry Failed', err.message || 'Could not retry this render.');
                        this._handleNewRender();
                    }
                } else {
                    this._handleNewRender();
                }
                document.dispatchEvent(new CustomEvent('rendersUpdated'));
                return;
            } else if (render.status === 'pending' && elapsed > 180000) {
                // Status still 'pending' after 3 minutes — pipeline likely failed
                // without updating DynamoDB
                this._stopPolling();
                this._hideLoadingState();

                console.error('Render stalled in pending state after 3 minutes');

                const action = await modalService.choice(
                    'Render Stalled',
                    'Your render appears to have stalled. The pipeline did not respond within the expected time.',
                    [
                        { text: 'New Render', value: 'new' },
                        { text: 'Retry', value: 'retry', primary: true }
                    ]
                );

                if (action === 'retry') {
                    try {
                        await rendersService.retryRender(this.currentRenderId);
                        this._showLoadingState();
                        this._startPolling();
                        document.dispatchEvent(new CustomEvent('rendersUpdated'));
                    } catch (err) {
                        console.error('Retry failed:', err);
                        await modalService.alert('Retry Failed', err.message || 'Could not retry this render.');
                        this._handleNewRender();
                    }
                } else {
                    this._handleNewRender();
                }
                document.dispatchEvent(new CustomEvent('rendersUpdated'));
                return;
            }

            // Update loading message with pipeline stage estimate
            const stages = [
                { t: 0, label: 'Reading uploaded files...' },
                { t: 8000, label: 'Extracting building structure...' },
                { t: 25000, label: 'Transforming geometry...' },
                { t: 50000, label: 'Generating IFC model...' },
                { t: 90000, label: 'Running validation...' },
                { t: 150000, label: 'Finalizing render...' },
            ];
            const stage = [...stages].reverse().find(s => elapsed >= s.t) || stages[0];
            const timeStr = minutes > 0 ? ` (${minutes}m elapsed)` : '';
            this._updateLoadingMessage(`${stage.label}${timeStr}`);

            // Exponential backoff polling: 2s → 5s → 10s → 15s
            let delay;
            if (elapsed < 30000) {
                delay = 2000;  // 2s for first 30s
            } else if (elapsed < 120000) {
                delay = 5000;  // 5s for next 2 minutes
            } else if (elapsed < 600000) {
                delay = 10000; // 10s for up to 10 minutes
            } else {
                // Timeout after 10 minutes
                this._stopPolling();
                this._hideLoadingState();

                await modalService.alert(
                    'Render Timed Out',
                    'Your render is taking longer than expected and may have failed.\n\nPlease try again or check with a smaller file.'
                );

                this._handleNewRender();
                document.dispatchEvent(new CustomEvent('rendersUpdated'));
                return;
            }

            this.pollingInterval = setTimeout(() => this._pollRenderStatus(), delay);
        } catch (error) {
            console.error('Polling error:', error);
            this._stopPolling();
            this._hideLoadingState();
            this._showError(`Error checking render status: ${error.message}`);
        }
    },

    /**
     * Stop polling
     */
    _stopPolling() {
        if (this.pollingInterval) {
            clearTimeout(this.pollingInterval);
            this.pollingInterval = null;
        }
        this.currentRenderId = null;
        this.pollingStartTime = null;
        this.isRendering = false; // Clear rendering flag
    },

    /**
     * Handle download in requested format (ifc, glb, obj)
     */
    async _handleDownload(format = 'ifc') {
        if (!this.element.dataset.renderId) return;

        try {
            const renderId = this.element.dataset.renderId;
            const { downloadUrl } = await rendersService.getDownloadUrl(renderId, format);

            // Build a clean filename from the AI-generated title with correct extension
            const ext = format === 'gltf' ? 'glb' : format;
            const title = this.currentRenderTitle;
            const filename = title
                ? title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') + '.' + ext
                : `render_${renderId}.${ext}`;

            // Fetch from signed URL and trigger download
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`Download failed: ${response.status}`);
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(blobUrl);

        } catch (error) {
            console.error('Error downloading render:', error);
            this._showError('Failed to download render: ' + error.message);
        }
    },


    /**
     * Handle render completion
     */
    async _handleRenderCompleted(render) {
        this._stopPolling();
        this._hideLoadingState();

        try {
            // Check if this is a refinement before changing state
            const wasRefinement = this.element.dataset.state === 'viewing-render';

            // Update UI state FIRST so viewer is visible
            this.element.dataset.state = 'viewing-render';
            this.element.dataset.renderId = render.render_id;
            this.currentRenderTitle = render.ai_generated_title || render.title || null;
            this._updateInputPlaceholder('Describe refinements to apply...');
            this._updateInputLabel('Refinement');

            // Notify details sidebar with full render object
            document.dispatchEvent(new CustomEvent('renderSelected', {
                detail: { render }
            }));

            // Notify sidebar to refresh renders list
            document.dispatchEvent(new CustomEvent('rendersUpdated'));

            // Get IFC file data from backend
            const { downloadUrl } = await rendersService.getDownloadUrl(render.render_id);

            // Load IFC in viewer (async, but UI is already showing)
            try {
                await this.loadIFCFromUrl(downloadUrl);
                // Extra capture for refinements: schedule a second capture at 4s as insurance
                if (wasRefinement) {
                    setTimeout(() => {
                        this._captureThumbnail(render.render_id, 1);
                    }, 4000);
                }
            } catch (ifcError) {
                console.error('IFC loading error:', ifcError);
                this._showError('Failed to load 3D model: ' + ifcError.message);
            }
        } catch (error) {
            console.error('Error completing render:', error);
            this._showError('Failed to complete render: ' + error.message);
        }
    },

    /**
     * Capture thumbnail from viewer canvas with render-settled detection.
     * Polls scene object count until stable, then captures.
     * Falls back to progressive retry if settling fails.
     */
    _captureThumbnail(renderId, attempt = 0) {
        const maxAttempts = 4;
        const delays = [800, 1800, 3500, 6000];

        // First attempt: use render-settled detection
        if (attempt === 0) {
            this._captureWhenSettled(renderId);
            return;
        }

        // Fallback: progressive retry with isometric positioning
        setTimeout(() => {
            if (this.element.dataset.renderId !== renderId) return;
            ifcViewer.positionForThumbnail().then(() => {
                if (this.element.dataset.renderId !== renderId) return;
                const snap = ifcViewer.getSnapshot();
                if (snap) {
                    document.dispatchEvent(new CustomEvent('thumbnailCaptured', {
                        detail: { renderId, dataUrl: snap }
                    }));
                } else if (attempt < maxAttempts - 1) {
                    this._captureThumbnail(renderId, attempt + 1);
                }
            });
        }, delays[attempt]);
    },

    /**
     * Render-settled detection: poll scene object count every 500ms.
     * When count stabilizes for 2 consecutive checks, capture.
     * Falls back after 5 seconds.
     */
    _captureWhenSettled(renderId) {
        // Cancel any previous thumbnail capture
        if (this._thumbPollTimer) clearTimeout(this._thumbPollTimer);

        let lastCount = -1;
        let stableChecks = 0;
        let checkCount = 0;
        const maxChecks = 10; // 5 seconds max
        const pollInterval = 500;

        const poll = () => {
            // Abort if a different render is now active (prevents cross-contamination)
            if (this.element.dataset.renderId !== renderId) {
                return;
            }

            checkCount++;
            let currentCount = 0;
            try {
                const objects = ifcViewer.viewer?.scene?.objects;
                currentCount = objects ? Object.keys(objects).length : 0;
            } catch (_) {}

            if (currentCount > 0 && currentCount === lastCount) {
                stableChecks++;
            } else {
                stableChecks = 0;
            }
            lastCount = currentCount;

            if (stableChecks >= 2 && currentCount > 0) {
                // Settled — position camera to clean isometric angle, then capture
                ifcViewer.positionForThumbnail().then(() => {
                    if (this.element.dataset.renderId !== renderId) return;
                    const snap = ifcViewer.getSnapshot();
                    if (snap) {
                        document.dispatchEvent(new CustomEvent('thumbnailCaptured', {
                            detail: { renderId, dataUrl: snap }
                        }));
                    } else {
                        this._captureThumbnail(renderId, 1);
                    }
                });
                return;
            }

            if (checkCount >= maxChecks) {
                // Timeout — fall back to progressive retry
                this._captureThumbnail(renderId, 1);
                return;
            }

            this._thumbPollTimer = setTimeout(poll, pollInterval);
        };

        // Start polling after initial 500ms delay
        this._thumbPollTimer = setTimeout(poll, pollInterval);
    },

};

export default renderbox;
