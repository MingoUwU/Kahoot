// content.js - Minimalist Real-Time AI Kahoot Solver & Macro Engine
(function() {
    if (window.__KQH_INJECTED__) return;
    window.__KQH_INJECTED__ = true;

    'use strict';

    // State Configuration
    const state = {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: '',
        macroEnabled: false,
        macroDelay: 1.2,
        isMinimized: false,
        scale: 1,
        activeQuestion: '',
        activeChoices: [],
        activeImage: '',
        currentAnswer: 'Waiting for game question...',
        lastMatchedIndex: -1,
        macroTimer: null
    };

    // Load initial local config
    try {
        state.provider = localStorage.getItem('kqh_provider') || 'gemini';
        state.model = localStorage.getItem('kqh_model') || (state.provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini');
        state.apiKey = localStorage.getItem('kqh_api_key') || '';
        state.macroEnabled = localStorage.getItem('kqh_macro_enabled') === 'true';
        state.macroDelay = parseFloat(localStorage.getItem('kqh_macro_delay')) || 1.2;
        state.isMinimized = localStorage.getItem('kqh_hud_minimized') === 'true';
        state.scale = parseFloat(localStorage.getItem('kqh_hud_scale')) || 1;
    } catch (e) {}

    // Synchronize updates from Bridge
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'KQH_FROM_BRIDGE') return;
        const p = event.data.payload;
        if (!p) return;

        if (p.kqh_provider !== undefined) state.provider = p.kqh_provider;
        if (p.kqh_model !== undefined) state.model = p.kqh_model;
        if (p.kqh_api_key !== undefined) state.apiKey = p.kqh_api_key;
        if (p.kqh_macro_enabled !== undefined) state.macroEnabled = Boolean(p.kqh_macro_enabled);
        if (p.kqh_macro_delay !== undefined) state.macroDelay = parseFloat(p.kqh_macro_delay) || 1.2;

        renderHUD();
    });

    // Request fresh config from bridge
    try {
        window.postMessage({ type: 'KQH_TO_BRIDGE', action: 'fetchStorage' }, '*');
    } catch (e) {}

    // Answer Memory Cache (Max 50 items)
    const answerCache = new Map();

    // Helper: Convert Image URL to base64
    async function fetchImageBase64(url) {
        if (!url || !url.startsWith('http')) return null;
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const blob = await res.blob();
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    const resStr = reader.result;
                    if (typeof resStr === 'string') {
                        resolve({ mimeType: blob.type || 'image/jpeg', base64: resStr.split(',')[1] });
                    } else {
                        resolve(null);
                    }
                };
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            return null;
        }
    }

    // Direct Gemini API
    async function callGemini(question, choices, answersAllowed, imageUrl) {
        const prompt = `You are an expert Kahoot quiz solver.
Question: ${question}
Choices:
${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}
Answers allowed: ${answersAllowed || 1}

TASK: Select the exact correct matching choice from the list.
Return ONLY valid JSON matching this schema:
{"answer": "Exact text of matching choice", "confidence": 0.98}`;

        const parts = [{ text: prompt }];
        let isVision = false;

        if (imageUrl) {
            const imgData = await fetchImageBase64(imageUrl);
            if (imgData?.base64) {
                isVision = true;
                parts.unshift({
                    inlineData: { mimeType: imgData.mimeType, data: imgData.base64 }
                });
            }
        }

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${state.model || 'gemini-2.5-flash'}:generateContent?key=${state.apiKey}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 150,
                    responseMimeType: 'application/json'
                }
            })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status}`);
        }

        const data = await res.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let parsed = null;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            const m = rawText.match(/\{[\s\S]*\}/);
            if (m) parsed = JSON.parse(m[0]);
        }

        return {
            answer: parsed?.answer || rawText.trim() || 'No answer',
            confidence: parsed?.confidence || 0.95,
            isVision
        };
    }

    // Direct OpenAI API
    async function callOpenAI(question, choices, answersAllowed, imageUrl) {
        const userContent = [];
        let isVision = false;

        if (imageUrl) {
            isVision = true;
            userContent.push({ type: 'image_url', image_url: { url: imageUrl } });
        }

        userContent.push({
            type: 'text',
            text: `Question: ${question}\nChoices:\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nAnswers allowed: ${answersAllowed || 1}\n\nSelect the exact matching choice from the list. Return JSON: {"answer": "Exact text", "confidence": 0.98}`
        });

        const endpoint = 'https://api.openai.com/v1/chat/completions';
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.apiKey}`
            },
            body: JSON.stringify({
                model: state.model || 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'You are an ultra-fast Kahoot solver. Output strictly valid JSON with {"answer": string, "confidence": number}.' },
                    { role: 'user', content: userContent }
                ],
                temperature: 0.1,
                max_tokens: 150,
                response_format: { type: 'json_object' }
            })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status}`);
        }

        const data = await res.json();
        const contentStr = data.choices?.[0]?.message?.content || '{}';
        const parsed = JSON.parse(contentStr);

        return {
            answer: parsed.answer || contentStr,
            confidence: parsed.confidence || 0.95,
            isVision
        };
    }

    // Solve Question
    async function solveQuestion(question, choices, answersAllowed, imageUrl) {
        if (!state.apiKey) {
            return {
                isError: true,
                answer: 'API Key not configured. Click extension icon in toolbar to add key.',
                confidence: 0
            };
        }

        const cacheKey = `${question}:::${choices.join('|')}:::${imageUrl || ''}`;
        if (answerCache.has(cacheKey)) {
            return answerCache.get(cacheKey);
        }

        try {
            let res = null;
            if (state.provider === 'openai') {
                res = await callOpenAI(question, choices, answersAllowed, imageUrl);
            } else {
                res = await callGemini(question, choices, answersAllowed, imageUrl);
            }

            if (answerCache.size >= 50) {
                const firstKey = answerCache.keys().next().value;
                answerCache.delete(firstKey);
            }
            answerCache.set(cacheKey, res);
            return res;
        } catch (e) {
            return {
                isError: true,
                answer: `AI Error: ${e.message}`,
                confidence: 0
            };
        }
    }

    // Match choice index (0 - 3)
    function findMatchingChoiceIndex(aiAnswer, choices) {
        if (!aiAnswer || !Array.isArray(choices) || choices.length === 0) return -1;
        const cleanAnswer = String(aiAnswer).trim().toLowerCase();

        // 1. Exact or substring match
        const sorted = choices.map((c, i) => ({ text: String(c || '').trim().toLowerCase(), index: i }))
                              .sort((a, b) => b.text.length - a.text.length);

        for (const item of sorted) {
            if (!item.text) continue;
            if (cleanAnswer === item.text || cleanAnswer.includes(item.text) || item.text.includes(cleanAnswer)) {
                return item.index;
            }
        }

        // 2. Number match 1-4
        const numMatch = cleanAnswer.match(/\b([1-4])\b/);
        if (numMatch) {
            const num = parseInt(numMatch[1], 10);
            if (num >= 1 && num <= choices.length) return num - 1;
        }

        return -1;
    }

    // Visual answer highlighting
    function resetVisuals() {
        try {
            const buttons = document.querySelectorAll('button[data-functional-selector^="answer-"]');
            buttons.forEach(btn => {
                btn.style.transition = 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                btn.style.opacity = '1';
                btn.style.filter = 'none';
                btn.style.transform = 'none';
                btn.style.boxShadow = '';
                btn.style.zIndex = '';
            });
        } catch (e) {}
    }

    function applyLaserHighlight(targetIndex) {
        if (targetIndex < 0) return;
        try {
            const buttons = document.querySelectorAll('button[data-functional-selector^="answer-"]');
            if (!buttons || buttons.length === 0) return;

            buttons.forEach((btn, idx) => {
                const selector = btn.getAttribute('data-functional-selector') || '';
                const isMatch = selector === `answer-${targetIndex}` || idx === targetIndex;

                btn.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
                if (isMatch) {
                    btn.style.opacity = '1';
                    btn.style.filter = 'none';
                    btn.style.transform = 'scale(1.025)';
                    btn.style.boxShadow = '0 0 0 2.5px #10b981, 0 0 30px rgba(16, 185, 129, 0.8)';
                    btn.style.zIndex = '50';
                } else {
                    btn.style.opacity = '0.2';
                    btn.style.filter = 'grayscale(80%)';
                    btn.style.transform = 'scale(0.97)';
                    btn.style.zIndex = '1';
                }
            });
        } catch (e) {}
    }

    // Macro Auto-Click Execution
    function triggerMacroAutoClick(targetIndex) {
        if (targetIndex < 0 || !state.macroEnabled) return;

        if (state.macroTimer) clearTimeout(state.macroTimer);

        // Add humanized random jitter (+- 80ms)
        const delayMs = Math.max(150, (state.macroDelay * 1000) + (Math.random() * 160 - 80));

        state.macroTimer = setTimeout(() => {
            try {
                const targetBtn = document.querySelector(`button[data-functional-selector="answer-${targetIndex}"]`) ||
                                  document.querySelectorAll('button[data-functional-selector^="answer-"]')[targetIndex];

                if (targetBtn && !targetBtn.disabled) {
                    targetBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    targetBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                    targetBtn.click();
                    console.log('⚡ [KQH Macro] Clicked choice index:', targetIndex);
                }
            } catch (err) {
                console.warn('Macro click error:', err);
            }
        }, delayMs);
    }

    // Process Incoming Quiz Question
    async function processQuestion(qData, source = 'WS') {
        if (!qData || !qData.question) return;

        const isNew = qData.question !== state.activeQuestion ||
            JSON.stringify(qData.choices) !== JSON.stringify(state.activeChoices) ||
            (qData.imageUrl || '') !== state.activeImage;

        if (!isNew) return;

        if (state.macroTimer) clearTimeout(state.macroTimer);
        resetVisuals();

        state.activeQuestion = qData.question;
        state.activeChoices = (qData.choices || []).slice();
        state.activeImage = qData.imageUrl || '';
        state.lastMatchedIndex = -1;
        state.currentAnswer = 'AI is solving...';

        renderHUD(source);

        const aiRes = await solveQuestion(
            state.activeQuestion,
            state.activeChoices,
            qData.answersAllowed || 1,
            state.activeImage
        );

        state.currentAnswer = aiRes.answer;

        if (!aiRes.isError) {
            const matchedIdx = findMatchingChoiceIndex(aiRes.answer, state.activeChoices);
            state.lastMatchedIndex = matchedIdx;

            if (matchedIdx >= 0) {
                applyLaserHighlight(matchedIdx);
                triggerMacroAutoClick(matchedIdx);
            }
        }

        renderHUD(source);
    }

    // WebSocket Hook (MAIN World)
    const originalWebSocket = window.WebSocket;
    const CustomWebSocket = function(url, protocols) {
        const ws = protocols !== undefined ? new originalWebSocket(url, protocols) : new originalWebSocket(url);

        ws.addEventListener('message', async function(event) {
            try {
                const messageArray = JSON.parse(event.data);
                for (let message of messageArray) {
                    if (message.data && message.data.type === 'message' && message.channel === '/service/player') {
                        const content = JSON.parse(message.data.content);
                        if (content.type === 'quiz') {
                            const parsed = {
                                question: content.title || '',
                                choices: (content.choices || []).map(c => c.answer),
                                imageUrl: content.image || '',
                                answersAllowed: content.numberOfAnswersAllowed || 1,
                                questionIndex: content.questionIndex || 0,
                                totalQuestions: content.totalGameBlockCount || 0
                            };
                            if (parsed.question && parsed.choices.length > 0) {
                                processQuestion(parsed, 'WS');
                            }
                        }
                    }
                }
            } catch (e) {}
        });

        return ws;
    };
    CustomWebSocket.prototype = originalWebSocket.prototype;
    CustomWebSocket.CONNECTING = originalWebSocket.CONNECTING;
    CustomWebSocket.OPEN = originalWebSocket.OPEN;
    CustomWebSocket.CLOSING = originalWebSocket.CLOSING;
    CustomWebSocket.CLOSED = originalWebSocket.CLOSED;
    window.WebSocket = CustomWebSocket;

    // DOM Scraper Engine
    function scrapeDOM() {
        try {
            const titleEl = document.querySelector('[data-functional-selector="question-title"], [data-functional-selector="block-title"], h1');
            const questionText = titleEl?.textContent?.trim() || '';

            const choiceButtons = document.querySelectorAll('button[data-functional-selector^="answer-"]');
            const choices = [];
            choiceButtons.forEach((btn, i) => {
                const txt = btn.textContent?.trim() || `Option ${i + 1}`;
                choices.push(txt);
            });

            const imgEl = document.querySelector('img[data-functional-selector="question-media-image"], [data-functional-selector="media-container"] img');
            const imageUrl = imgEl?.src || '';

            if (questionText && choices.length >= 2) {
                return { question: questionText, choices, imageUrl, answersAllowed: 1 };
            }
        } catch (e) {}
        return null;
    }

    function initDOMWatcher() {
        setInterval(() => {
            if (document.hidden) return;
            const domQ = scrapeDOM();
            if (domQ && domQ.question && domQ.question !== state.activeQuestion) {
                processQuestion(domQ, 'DOM');
            }
        }, 2000);
    }

    // ==========================================
    // MINIMALIST IN-GAME HUD COMPONENT
    // ==========================================
    let hudContainer = null;

    function createHUDElement() {
        if (hudContainer) return;

        hudContainer = document.createElement('div');
        hudContainer.id = 'kqh-minimal-hud';
        hudContainer.style.cssText = `
            position: fixed;
            top: 14px;
            left: 14px;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
            -webkit-font-smoothing: antialiased;
            user-select: none;
            transition: transform 0.15s ease, opacity 0.2s ease;
        `;

        document.body.appendChild(hudContainer);
        setupDragging(hudContainer);
    }

    function renderHUD(source = 'WS') {
        createHUDElement();
        if (!hudContainer) return;

        const hasKey = Boolean(state.apiKey);
        const macroBadge = state.macroEnabled 
            ? `<span style="font-size: 9px; background: rgba(16, 185, 129, 0.2); color: #34d399; padding: 2px 6px; border-radius: 9999px; font-weight: 700; border: 1px solid rgba(16, 185, 129, 0.35);">⚡ MACRO</span>`
            : '';

        const modelTag = state.model ? state.model.replace('-flash', '').toUpperCase() : 'AI';

        // MINIMIZED MODE: Sleek Capsule Dock
        if (state.isMinimized) {
            const shortAns = state.currentAnswer ? state.currentAnswer.slice(0, 20) : 'Ready';
            hudContainer.innerHTML = `
                <div id="kqh-expand-btn" style="
                    background: rgba(9, 10, 15, 0.85);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
                    padding: 6px 12px;
                    border-radius: 9999px;
                    color: #ffffff;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    font-size: 11px;
                    font-weight: 600;
                    letter-spacing: 0.2px;
                ">
                    <span style="width: 7px; height: 7px; border-radius: 50%; background: ${hasKey ? '#10b981' : '#ef4444'}; box-shadow: 0 0 8px ${hasKey ? '#10b981' : '#ef4444'};"></span>
                    <strong style="color: #6366f1;">KQH</strong>
                    <span style="opacity: 0.8; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortAns}</span>
                    <span style="opacity: 0.5; font-size: 10px;">+</span>
                </div>
            `;
            const expandBtn = document.getElementById('kqh-expand-btn');
            if (expandBtn) {
                expandBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    state.isMinimized = false;
                    localStorage.setItem('kqh_hud_minimized', 'false');
                    renderHUD(source);
                });
            }
            return;
        }

        // EXPANDED MODE: Minimalist Dark Glass Card
        let choicesHtml = '';
        if (state.activeChoices.length > 0) {
            choicesHtml = state.activeChoices.map((c, i) => {
                const isCorrect = i === state.lastMatchedIndex;
                return `
                    <div style="
                        padding: 5px 8px;
                        border-radius: 6px;
                        font-size: 11px;
                        font-weight: 500;
                        background: ${isCorrect ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.03)'};
                        border: 1px solid ${isCorrect ? 'rgba(16, 185, 129, 0.5)' : 'rgba(255, 255, 255, 0.06)'};
                        color: ${isCorrect ? '#6ee7b7' : '#cbd5e1'};
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    ">
                        <span style="font-weight: 700; opacity: 0.7; font-size: 10px;">${i + 1}.</span>
                        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c}</span>
                        ${isCorrect ? '<span>✓</span>' : ''}
                    </div>
                `;
            }).join('');
        }

        hudContainer.innerHTML = `
            <div style="
                width: 270px;
                background: rgba(9, 10, 15, 0.82);
                backdrop-filter: blur(24px);
                -webkit-backdrop-filter: blur(24px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 12px;
                padding: 12px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                color: #ffffff;
                transform: scale(${state.scale});
                transform-origin: top left;
            ">
                <!-- Header -->
                <div id="kqh-drag-handle" style="display: flex; align-items: center; justify-content: space-between; cursor: grab; padding-bottom: 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); margin-bottom: 10px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: ${hasKey ? '#10b981' : '#ef4444'}; box-shadow: 0 0 6px ${hasKey ? '#10b981' : '#ef4444'};"></span>
                        <strong style="font-size: 12px; font-weight: 800; letter-spacing: -0.2px;">KQH AI</strong>
                        <span style="font-size: 9px; color: #818cf8; background: rgba(99, 102, 241, 0.15); padding: 1px 5px; border-radius: 4px; font-weight: 700;">${modelTag}</span>
                        ${macroBadge}
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <button id="kqh-macro-btn" title="Toggle Auto-Click Macro" style="background: ${state.macroEnabled ? 'rgba(16, 185, 129, 0.25)' : 'rgba(255, 255, 255, 0.08)'}; border: 1px solid ${state.macroEnabled ? 'rgba(16, 185, 129, 0.4)' : 'rgba(255, 255, 255, 0.1)'}; color: ${state.macroEnabled ? '#34d399' : '#94a3b8'}; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 10px; font-weight: 700;">⚡</button>
                        <button id="kqh-min-btn" title="Minimize" style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.1); color: #ffffff; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 10px; font-weight: 700;">−</button>
                    </div>
                </div>

                <!-- Active Question -->
                <div style="margin-bottom: 8px;">
                    <div style="font-size: 10px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
                        ${state.activeQuestion ? 'Question' : 'Status'}
                    </div>
                    <div style="font-size: 12px; font-weight: 600; line-height: 1.4; color: #f1f5f9; background: rgba(255, 255, 255, 0.03); padding: 7px 9px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.05); max-height: 50px; overflow-y: auto;">
                        ${state.activeQuestion || (hasKey ? 'Waiting for question...' : 'API Key missing. Click extension icon.')}
                    </div>
                </div>

                <!-- Choices -->
                ${choicesHtml ? `<div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px;">${choicesHtml}</div>` : ''}

                <!-- Recommended Answer Card -->
                <div style="
                    background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(99, 102, 241, 0.12));
                    border: 1px solid rgba(16, 185, 129, 0.3);
                    border-radius: 8px;
                    padding: 8px 10px;
                ">
                    <div style="font-size: 9px; font-weight: 700; color: #34d399; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; display: flex; align-items: center; justify-content: space-between;">
                        <span>Recommended Answer</span>
                        ${state.macroEnabled ? '<span style="font-size: 8px; color: #a7f3d0;">Auto-Trigger</span>' : ''}
                    </div>
                    <div style="font-size: 12px; font-weight: 700; color: #ffffff; line-height: 1.3;">
                        ${state.currentAnswer}
                    </div>
                </div>
            </div>
        `;

        // Bind HUD events
        const minBtn = document.getElementById('kqh-min-btn');
        if (minBtn) {
            minBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                state.isMinimized = true;
                localStorage.setItem('kqh_hud_minimized', 'true');
                renderHUD(source);
            });
        }

        const macroBtn = document.getElementById('kqh-macro-btn');
        if (macroBtn) {
            macroBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                state.macroEnabled = !state.macroEnabled;
                localStorage.setItem('kqh_macro_enabled', state.macroEnabled ? 'true' : 'false');
                renderHUD(source);
            });
        }
    }

    // Dragging Implementation
    function setupDragging(el) {
        let isDragging = false;
        let startX = 0, startY = 0;
        let startLeft = 0, startTop = 0;

        el.addEventListener('mousedown', (e) => {
            const handle = e.target.closest('#kqh-drag-handle, #kqh-expand-btn');
            if (!handle) return;

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = el.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            const onMove = (me) => {
                if (!isDragging) return;
                const dx = me.clientX - startX;
                const dy = me.clientY - startY;
                const newX = Math.max(8, Math.min(window.innerWidth - 80, startLeft + dx));
                const newY = Math.max(8, Math.min(window.innerHeight - 40, startTop + dy));
                el.style.left = `${newX}px`;
                el.style.top = `${newY}px`;
            };

            const onUp = () => {
                isDragging = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // Initialize
    function init() {
        renderHUD();
        initDOMWatcher();
        console.log('⚡ KQH Minimalist AI Engine Loaded');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }
})();
