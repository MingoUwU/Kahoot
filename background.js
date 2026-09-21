// background.js - Minimalist Background Service Worker
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['kqh_provider', 'kqh_model'], (stored) => {
        if (!stored.kqh_provider) {
            chrome.storage.local.set({
                kqh_provider: 'gemini',
                kqh_model: 'gemini-2.5-flash',
                kqh_macro_enabled: false,
                kqh_macro_delay: 1.2
            });
        }
    });
});