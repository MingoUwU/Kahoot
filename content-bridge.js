// content-bridge.js - Minimalist Isolated Bridge
(function() {
    'use strict';

    function sendToMain(payload) {
        if (!payload) return;
        try {
            if (payload.kqh_api_key !== undefined) localStorage.setItem('kqh_api_key', payload.kqh_api_key);
            if (payload.kqh_provider !== undefined) localStorage.setItem('kqh_provider', payload.kqh_provider);
            if (payload.kqh_model !== undefined) localStorage.setItem('kqh_model', payload.kqh_model);
            if (payload.kqh_macro_enabled !== undefined) localStorage.setItem('kqh_macro_enabled', String(payload.kqh_macro_enabled));
            if (payload.kqh_macro_delay !== undefined) localStorage.setItem('kqh_macro_delay', String(payload.kqh_macro_delay));
        } catch (e) {}

        window.postMessage({
            type: 'KQH_FROM_BRIDGE',
            payload
        }, '*');
    }

    // Listen from popup/runtime
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'syncConfig' && request.payload) {
            sendToMain(request.payload);
            sendResponse({ ok: true });
        }
    });

    // Listen for storage changes
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            const updated = {};
            for (const key of ['kqh_provider', 'kqh_model', 'kqh_api_key', 'kqh_macro_enabled', 'kqh_macro_delay']) {
                if (changes[key]) {
                    updated[key] = changes[key].newValue;
                }
            }
            if (Object.keys(updated).length > 0) {
                sendToMain(updated);
            }
        });
    } catch (e) {}

    // Listen from Main World
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'KQH_TO_BRIDGE') return;

        if (event.data.action === 'fetchStorage') {
            chrome.storage.local.get([
                'kqh_provider',
                'kqh_model',
                'kqh_api_key',
                'kqh_macro_enabled',
                'kqh_macro_delay'
            ], (stored) => {
                sendToMain(stored);
            });
        }
    });

    // Initial load
    try {
        chrome.storage.local.get([
            'kqh_provider',
            'kqh_model',
            'kqh_api_key',
            'kqh_macro_enabled',
            'kqh_macro_delay'
        ], (stored) => {
            sendToMain({
                kqh_provider: stored.kqh_provider || 'gemini',
                kqh_model: stored.kqh_model || 'gemini-2.5-flash',
                kqh_api_key: stored.kqh_api_key || '',
                kqh_macro_enabled: Boolean(stored.kqh_macro_enabled),
                kqh_macro_delay: stored.kqh_macro_delay !== undefined ? stored.kqh_macro_delay : 1.2
            });
        });
    } catch (e) {}
})();