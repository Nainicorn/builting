import template from './header.hbs';
import './header.css';
import authService from '../../services/authService.js';

const header = {
    element: null,

    async init() {
        this._render();
        this._bindListeners();
    },

    _render() {
        this.element = document.querySelector('.__header');
        this.element.innerHTML = template({ main: true });
    },

    _bindListeners() {
        // Logout button
        this.element.addEventListener('click', (e) => {
            if (e.target.closest('.__header-logout')) {
                authService.logout();
            }
        });

        // Hide logout when a render is selected
        document.addEventListener('renderSelected', () => {
            this._setLogoutVisible(false);
        });

        // Show logout again on new render
        document.addEventListener('newRenderRequested', () => {
            this._setLogoutVisible(true);
        });
    },

    _setLogoutVisible(visible) {
        const btn = this.element?.querySelector('.__header-logout');
        if (!btn) return;
        btn.style.display = visible ? '' : 'none';
    }
};

export default header;
