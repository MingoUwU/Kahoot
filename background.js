// background.js - Minimalist Background Service Worker
chrome.runtime.onInstalled.addListener(async () => {
    chrome.storage.local.get(['kqh_provider', 'kqh_model'], (stored) => {
        if (!stored.kqh_provider) {
            chrome.storage.local.set({
                kqh_provider: 'gemini',
                kqh_model: 'gemini-2.5-flash',
                kqh_macro_enabled: false,
                kqh_macro_delay: 0.3
            });
        }
    });

    // Auto-inject into existing open Kahoot tabs without requiring manual F5
    try {
        const tabs = await chrome.tabs.query({
            url: [
                '*://kahoot.it/*',
                '*://*.kahoot.it/*',
                '*://kahoot.com/*',
                '*://*.kahoot.com/*'
            ]
        });

        for (const tab of tabs) {
            if (!tab.id) continue;
            try {
                // Inject bridge in ISOLATED world
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content-bridge.js'],
                    world: 'ISOLATED'
                });
                // Inject solver in MAIN world
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js'],
                    world: 'MAIN'
                });
                console.log('⚡ [KQH] Auto-injected into tab:', tab.id, tab.url);
            } catch (err) {
                // Tab might be in restricted state or loading
            }
        }
    } catch (e) {}
});