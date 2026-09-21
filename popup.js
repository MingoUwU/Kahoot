// popup.js - Minimalist AI & Macro Configuration
(function() {
    'use strict';

    const MODEL_MAP = {
        gemini: [
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Fast & Stable)' },
            { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite (Ultra Fast)' },
            { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash (Standard)' },
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Preview)' }
        ],
        openai: [
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast & Compact)' },
            { id: 'gpt-4o', name: 'GPT-4o (High Accuracy & Vision)' }
        ]
    };

    const PROVIDER_INFO = {
        gemini: {
            link: 'https://aistudio.google.com/app/apikey',
            linkText: 'Get free key ↗',
            placeholder: 'AIzaSy...'
        },
        openai: {
            link: 'https://platform.openai.com/api-keys',
            linkText: 'Get OpenAI key ↗',
            placeholder: 'sk-...'
        }
    };

    const elements = {
        statusDot: document.getElementById('statusDot'),
        statusLabel: document.getElementById('statusLabel'),
        tabGemini: document.getElementById('tabGemini'),
        tabOpenAI: document.getElementById('tabOpenAI'),
        modelSelect: document.getElementById('modelSelect'),
        apiKeyLink: document.getElementById('apiKeyLink'),
        apiKeyInput: document.getElementById('apiKeyInput'),
        toggleKeyBtn: document.getElementById('toggleKeyBtn'),
        macroToggle: document.getElementById('macroToggle'),
        delaySlider: document.getElementById('delaySlider'),
        delayValue: document.getElementById('delayValue'),
        saveBtn: document.getElementById('saveBtn'),
        toast: document.getElementById('toast')
    };

    let activeProvider = 'gemini';

    function setProvider(provider, selectedModel = '') {
        activeProvider = provider;
        if (provider === 'gemini') {
            elements.tabGemini.classList.add('active');
            elements.tabOpenAI.classList.remove('active');
        } else {
            elements.tabOpenAI.classList.add('active');
            elements.tabGemini.classList.remove('active');
        }

        const info = PROVIDER_INFO[provider];
        elements.apiKeyLink.href = info.link;
        elements.apiKeyLink.textContent = info.linkText;
        elements.apiKeyInput.placeholder = info.placeholder;

        elements.modelSelect.innerHTML = '';
        (MODEL_MAP[provider] || []).forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            if (m.id === selectedModel) opt.selected = true;
            elements.modelSelect.appendChild(opt);
        });
    }

    function showToast(msg, type = 'success') {
        elements.toast.className = `toast ${type}`;
        elements.toast.textContent = msg;
        elements.toast.style.display = 'block';
    }

    function hideToast() {
        elements.toast.style.display = 'none';
    }

    async function testConnection(provider, model, apiKey) {
        if (!apiKey) throw new Error('API Key is required');

        if (provider === 'gemini') {
            const ver = model.startsWith('gemini-1.5') ? 'v1' : 'v1beta';
            const url = `https://generativelanguage.googleapis.com/${ver}/models/${model}:generateContent?key=${apiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: 'ping' }] }],
                    generationConfig: { maxOutputTokens: 5 }
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error?.message || `HTTP ${res.status}`);
            }
        } else if (provider === 'openai') {
            const url = 'https://api.openai.com/v1/chat/completions';
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 5
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error?.message || `HTTP ${res.status}`);
            }
        }
    }

    async function broadcastToTabs(payload) {
        try {
            const tabs = await chrome.tabs.query({
                url: [
                    '*://kahoot.it/*',
                    '*://*.kahoot.it/*',
                    '*://kahoot.com/*',
                    '*://*.kahoot.com/*'
                ]
            });
            tabs.forEach(tab => {
                if (tab?.id) {
                    chrome.tabs.sendMessage(tab.id, { action: 'syncConfig', payload }, () => {
                        if (chrome.runtime.lastError) {}
                    });
                }
            });
        } catch (e) {}
    }

    async function loadSettings() {
        try {
            const stored = await chrome.storage.local.get([
                'kqh_provider',
                'kqh_model',
                'kqh_api_key',
                'kqh_macro_enabled',
                'kqh_macro_delay'
            ]);

            const provider = stored.kqh_provider || 'gemini';
            const model = stored.kqh_model || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini');
            const apiKey = stored.kqh_api_key || '';
            const macroEnabled = Boolean(stored.kqh_macro_enabled);
            const macroDelay = stored.kqh_macro_delay !== undefined ? stored.kqh_macro_delay : 1.2;

            setProvider(provider, model);
            elements.apiKeyInput.value = apiKey;
            elements.macroToggle.checked = macroEnabled;
            elements.delaySlider.value = macroDelay;
            elements.delayValue.textContent = `${Number(macroDelay).toFixed(1)}s`;

            if (apiKey) {
                elements.statusDot.classList.add('active');
                elements.statusLabel.textContent = 'Active';
            } else {
                elements.statusDot.classList.remove('active');
                elements.statusLabel.textContent = 'Setup Key';
            }
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }

    async function saveSettings() {
        const provider = activeProvider;
        const model = elements.modelSelect.value;
        const apiKey = elements.apiKeyInput.value.trim();
        const macroEnabled = elements.macroToggle.checked;
        const macroDelay = parseFloat(elements.delaySlider.value) || 1.2;

        if (!apiKey) {
            showToast('Please enter a valid API Key', 'error');
            elements.statusDot.classList.remove('active');
            elements.statusLabel.textContent = 'Setup Key';
            return;
        }

        elements.saveBtn.disabled = true;
        elements.saveBtn.textContent = 'Connecting...';
        hideToast();

        try {
            await testConnection(provider, model, apiKey);

            const payload = {
                kqh_provider: provider,
                kqh_model: model,
                kqh_api_key: apiKey,
                kqh_macro_enabled: macroEnabled,
                kqh_macro_delay: macroDelay
            };

            await chrome.storage.local.set(payload);

            try {
                localStorage.setItem('kqh_provider', provider);
                localStorage.setItem('kqh_model', model);
                localStorage.setItem('kqh_api_key', apiKey);
                localStorage.setItem('kqh_macro_enabled', macroEnabled ? 'true' : 'false');
                localStorage.setItem('kqh_macro_delay', String(macroDelay));
            } catch {}

            await broadcastToTabs(payload);

            elements.statusDot.classList.add('active');
            elements.statusLabel.textContent = 'Connected';
            showToast('✓ Configuration saved & verified', 'success');
        } catch (err) {
            elements.statusDot.classList.remove('active');
            elements.statusLabel.textContent = 'Error';
            showToast(`✗ ${err.message}`, 'error');
        } finally {
            elements.saveBtn.disabled = false;
            elements.saveBtn.textContent = 'Save & Connect';
        }
    }

    // Event Bindings
    elements.tabGemini.addEventListener('click', () => setProvider('gemini', 'gemini-2.5-flash'));
    elements.tabOpenAI.addEventListener('click', () => setProvider('openai', 'gpt-4o-mini'));

    elements.toggleKeyBtn.addEventListener('click', () => {
        const isPw = elements.apiKeyInput.type === 'password';
        elements.apiKeyInput.type = isPw ? 'text' : 'password';
        elements.toggleKeyBtn.textContent = isPw ? '🔒' : '👁';
    });

    elements.delaySlider.addEventListener('input', (e) => {
        elements.delayValue.textContent = `${Number(e.target.value).toFixed(1)}s`;
    });

    elements.macroToggle.addEventListener('change', async () => {
        const enabled = elements.macroToggle.checked;
        await chrome.storage.local.set({ kqh_macro_enabled: enabled });
        broadcastToTabs({ kqh_macro_enabled: enabled });
    });

    elements.saveBtn.addEventListener('click', saveSettings);
    elements.apiKeyInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') saveSettings();
    });

    document.addEventListener('DOMContentLoaded', loadSettings);
})();