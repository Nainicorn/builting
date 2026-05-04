import template from './sidebar.hbs';
import './sidebar.css';
import controls from '../controls/controls';
import rendersService from '../../services/rendersService.js';
import modalService from '../../services/modalService.js';
import renderbox from '../renderbox/renderbox.js';

/* ─── Thumbnail Cache ─── */
const THUMB_PREFIX = 'builting_thumb_';
const THUMB_MAX_ENTRIES = 50;
const thumbnailCache = {
    _mem: {},

    get(renderId) {
        // Memory first, then localStorage
        if (this._mem[renderId]) return this._mem[renderId];
        try {
            const val = localStorage.getItem(THUMB_PREFIX + renderId);
            if (val) { this._mem[renderId] = val; return val; }
        } catch (_) { /* storage unavailable */ }
        return null;
    },

    set(renderId, dataUrl) {
        if (!renderId || !dataUrl) return;
        this._mem[renderId] = dataUrl;
        try {
            // Evict oldest if over limit
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(THUMB_PREFIX)) keys.push(k);
            }
            if (keys.length >= THUMB_MAX_ENTRIES) {
                localStorage.removeItem(keys[0]);
            }
            localStorage.setItem(THUMB_PREFIX + renderId, dataUrl);
        } catch (_) { /* quota exceeded — memory cache still works */ }
    },

    remove(renderId) {
        delete this._mem[renderId];
        try { localStorage.removeItem(THUMB_PREFIX + renderId); } catch (_) {}
    }
};

const sidebar = {
    element: null,
    thumbnailCache, // Expose for renderbox to use
    _pollTimer: null,
    _trackedInProgress: new Set(), // render IDs that are processing/pending

    // Initialize the sidebar component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__sidebar');
        let html = template({ main: true });
        this.element.innerHTML = html;
    },

    // Load data and initialize child components
    async _loadData() {
        await controls.init();
        await this.loadRenders();
    },

    // Bind listeners if needed
    _bindListeners() {
        // Sidebar toggle button
        const toggleBtn = this.element?.querySelector('.__sidebar-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                const isCollapsed = document.body.getAttribute('data-collapsed') === 'true';
                document.body.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true');
                document.dispatchEvent(new CustomEvent('sidebarToggled'));
            });
        }

        // Listen for renders list updates
        document.addEventListener('rendersUpdated', () => {
            this.loadRenders(true);
        });

        // Listen for thumbnail captures from the viewer
        document.addEventListener('thumbnailCaptured', (e) => {
            const { renderId, dataUrl } = e.detail || {};
            if (renderId && dataUrl) {
                this.updateThumbnail(renderId, dataUrl);
            }
        });

        // Delegate click events for render items
        const rendersContainer = this.element.querySelector('.__sidebar-renders');
        if (rendersContainer) {
            rendersContainer.addEventListener('click', (e) => {
                // Handle delete button click
                if (e.target.closest('.__render-delete-btn')) {
                    e.stopPropagation();
                    const renderItem = e.target.closest('.__render-item');
                    const renderId = renderItem.dataset.renderId;
                    this._handleDeleteRender(renderId);
                    return;
                }

                const renderItem = e.target.closest('.__render-item');
                if (renderItem) {
                    const renderId = renderItem.dataset.renderId;
                    this._handleRenderClick(renderId);
                }
            });
        }
    },


    /**
     * Load all renders for current user
     * @param {boolean} silent - If true, don't show loading spinner (used for poll refreshes)
     */
    async loadRenders(silent = false) {
        try {
            const rendersContainer = this.element.querySelector('.__sidebar-renders');
            if (!rendersContainer) return;

            // Show loading state only on first load, not during poll refreshes
            if (!silent && rendersContainer.children.length === 0) {
                rendersContainer.innerHTML = '<div class="__renders-loading"><div class="__spinner"></div></div>';
            }

            const data = await rendersService.getRenders();
            const renders = data.renders || [];

            if (renders.length === 0) {
                rendersContainer.innerHTML = '<div class="__renders-empty">No renders yet</div>';
                return;
            }

            // Render the list
            this._renderRendersList(renders);
        } catch (error) {
            console.error('Error loading renders:', error);
            const rendersContainer = this.element.querySelector('.__sidebar-renders');
            if (rendersContainer) {
                rendersContainer.innerHTML = '<div class="__renders-error">Failed to load renders</div>';
            }
        }
    },

    /**
     * Render list of renders as compact list items
     */
    _renderRendersList(renders) {
        const rendersContainer = this.element.querySelector('.__sidebar-renders');
        if (!rendersContainer) return;

        // Filter out failed renders (including contract failures)
        const visibleRenders = renders.filter(r => r.status !== 'failed' && r.status !== 'failed_contract');
        const emptyEl = this.element.querySelector('.__sidebar-empty');

        if (visibleRenders.length === 0) {
            rendersContainer.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        // Sort renders by created_at (newest first)
        const sorted = visibleRenders.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        // Track in-progress renders for auto-polling
        const inProgress = new Set();
        sorted.forEach(r => {
            if (r.status === 'processing' || r.status === 'pending' || r.status === 'uploading') {
                inProgress.add(r.render_id);
            }
        });

        // Check if any previously in-progress renders just completed
        for (const rid of this._trackedInProgress) {
            if (!inProgress.has(rid)) {
                const render = sorted.find(r => r.render_id === rid);
                if (render && render.status === 'completed') {
                    this._notifyRenderCompleted(render);
                }
            }
        }
        this._trackedInProgress = inProgress;

        // Start or stop polling based on whether there are in-progress renders
        if (inProgress.size > 0) {
            this._startInProgressPolling();
        } else {
            this._stopInProgressPolling();
        }

        rendersContainer.innerHTML = sorted.map(render => {
            const fullTitle = render.ai_generated_title || render.title || 'Untitled Render';
            const status = render.status || 'unknown';
            const dotClass = `__render-item-status-dot--${status}`;
            const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

            // Build metadata line: status + date + refinement indicator
            const metaParts = [statusLabel];
            if (render.refined_from) metaParts.push('↩ Refinement');
            if (render.created_at) {
                metaParts.push(this._relativeTime(render.created_at));
            }
            const metaLine = metaParts.join(' \u00B7 ');

            // Thumbnail: cached image or placeholder
            const thumbData = thumbnailCache.get(render.render_id);
            const thumbContent = thumbData
                ? `<img class="__render-thumb-img" src="${thumbData}" alt="" draggable="false" />`
                : `<svg class="__render-thumb-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
                       <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/>
                   </svg>`;

            const deleteBtn = render.is_demo_render ? '' : `
                        <button class="__render-delete-btn" title="Delete render" aria-label="Delete render">
                            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                            </svg>
                        </button>`;

            return `
                <div class="__render-item" data-render-id="${render.render_id}" tabindex="0" role="button" aria-label="${fullTitle} — ${statusLabel}">
                    <div class="__render-thumb">
                        ${thumbContent}
                        <span class="__render-item-status-dot ${dotClass}" title="${statusLabel}"></span>
                    </div>
                    <div class="__render-item-info">
                        <div class="__render-item-content">
                            <span class="__render-item-title" title="${fullTitle}">${fullTitle}</span>
                            <span class="__render-item-meta">${metaLine}</span>
                        </div>
                        ${deleteBtn}
                    </div>
                </div>
            `;
        }).join('');
    },

    /**
     * Format a Unix timestamp as relative time
     */
    _relativeTime(timestamp) {
        const now = Date.now() / 1000;
        const diff = Math.max(0, now - timestamp);

        if (diff < 60) return 'Just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
        return new Date(timestamp * 1000).toLocaleDateString();
    },

    /**
     * Update thumbnail for a specific render in the sidebar (called externally)
     */
    updateThumbnail(renderId, dataUrl) {
        if (!renderId || !dataUrl) return;
        thumbnailCache.set(renderId, dataUrl);
        const thumb = this.element?.querySelector(`[data-render-id="${renderId}"] .__render-thumb`);
        if (!thumb) return;
        // Replace placeholder SVG with real image
        const existing = thumb.querySelector('.__render-thumb-img');
        if (existing) {
            existing.src = dataUrl;
        } else {
            const placeholder = thumb.querySelector('.__render-thumb-placeholder');
            if (placeholder) placeholder.remove();
            const img = document.createElement('img');
            img.className = '__render-thumb-img';
            img.src = dataUrl;
            img.alt = '';
            img.draggable = false;
            thumb.prepend(img);
        }
    },

    /**
     * Start polling sidebar for in-progress render updates
     */
    _startInProgressPolling() {
        if (this._pollTimer) return; // already polling
        this._pollTimer = setInterval(() => {
            this.loadRenders(true); // silent refresh — no spinner flash
        }, 8000); // poll every 8 seconds
    },

    /**
     * Stop polling for in-progress renders
     */
    _stopInProgressPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    },

    /**
     * Show notification when a render completes
     */
    async _notifyRenderCompleted(render) {
        const title = render.ai_generated_title || render.title || 'Untitled Render';
        const action = await modalService.choice(
            'Render Complete',
            `"${title}" has finished processing.`,
            [
                { text: 'Dismiss', value: 'dismiss' },
                { text: 'View', value: 'view', primary: true }
            ]
        );
        if (action === 'view') {
            document.dispatchEvent(new CustomEvent('renderSelected', {
                detail: { id: render.render_id }
            }));
        }
    },

    /**
     * Handle render item click
     */
    async _handleRenderClick(renderId) {
        // Check if a render is currently being generated
        if (renderbox.isRendering) {
            await modalService.alert(
                'Render In Progress',
                'A new render is currently being generated. Please wait for it to complete before viewing other renders.'
            );
            return;
        }

        // Dispatch event for renderbox and details to handle
        const event = new CustomEvent('renderSelected', {
            detail: { id: renderId }
        });
        document.dispatchEvent(event);
    },

    /**
     * Handle delete render
     */
    async _handleDeleteRender(renderId) {
        const confirmed = await modalService.confirm(
            'Delete Render',
            'Are you sure you want to delete this render? This cannot be undone.',
            'Delete',
            'Cancel'
        );

        if (!confirmed) {
            return;
        }

        try {
            await rendersService.deleteRender(renderId);
            thumbnailCache.remove(renderId);

            // Hide details panel and go back to welcome screen
            document.dispatchEvent(new CustomEvent('newRenderRequested'));

            // Trigger refresh of renders list
            const event = new CustomEvent('rendersUpdated');
            document.dispatchEvent(event);
        } catch (error) {
            console.error('Error deleting render:', error);
            await modalService.alert('Error', 'Failed to delete render. Please try again.');
        }
    }
};

export default sidebar;
