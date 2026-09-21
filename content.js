// content.js - Ultra-Fast Universal Real-Time AI Kahoot Solver & Macro Engine
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
        macroDelay: 0.3,
        isMinimized: false,
        scale: 1,
        activeQuestion: '',
        activeType: 'quiz', // 'quiz' | 'open_ended' | 'jumble' | 'scoreboard'
        activeChoices: [],
        activeImage: '',
        currentAnswer: 'Waiting for game question...',
        lastMatchedIndex: -1,
        isFromDB: false,
        macroTimer: null
    };

    // Load initial local config
    try {
        state.provider = localStorage.getItem('kqh_provider') || 'gemini';
        state.model = localStorage.getItem('kqh_model') || (state.provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini');
        state.apiKey = localStorage.getItem('kqh_api_key') || '';
        state.macroEnabled = localStorage.getItem('kqh_macro_enabled') === 'true';
        state.macroDelay = parseFloat(localStorage.getItem('kqh_macro_delay')) || 0.3;
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
        if (p.kqh_macro_delay !== undefined) state.macroDelay = parseFloat(p.kqh_macro_delay) || 0.3;

        renderHUD();
    });

    // Request fresh config from bridge
    try {
        window.postMessage({ type: 'KQH_TO_BRIDGE', action: 'fetchStorage' }, '*');
    } catch (e) {}

    // In-memory Quiz Question Bank (Intercepted from Kahoot REST APIs for 0ms answers)
    const quizQuestionBank = new Map();
    // Answer Memory Cache for AI responses
    const answerCache = new Map();

    function normalizeQuestionText(txt) {
        return String(txt || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    }

    // Helper: Deduplicate repeated text from Kahoot's multi-span DOM
    function deduplicateText(str) {
        if (!str) return '';
        // Remove leading geometry symbols (▲, ◆, ●, ■) and numbering
        str = str.replace(/^[▲◆●■\s\d\.\-\)]+/, '').trim();

        const len = str.length;
        if (len <= 1) return str;

        // Check if string is formed by repeating exact unit (e.g. malaysiamalaysiamalaysia)
        for (let unitLen = 1; unitLen <= Math.floor(len / 2); unitLen++) {
            if (len % unitLen === 0) {
                const unit = str.slice(0, unitLen);
                const times = len / unitLen;
                if (times >= 2 && unit.repeat(times) === str) {
                    return unit.trim();
                }
            }
        }

        // Case-insensitive repetition check (e.g. Sri LankaSri Lanka)
        for (let unitLen = 1; unitLen <= Math.floor(len / 2); unitLen++) {
            const unit = str.slice(0, unitLen);
            const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`^(${escaped}){2,}$`, 'i');
            if (regex.test(str)) {
                return unit.trim();
            }
        }

        return str;
    }

    // Helper: Convert Image URL to base64 for Vision AI
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

    // ==========================================
    // NETWORK INTERCEPTOR (0ms REST & WebSocket)
    // ==========================================
    function extractQuizDataFromJSON(obj) {
        if (!obj || typeof obj !== 'object') return;
        try {
            const qList = obj.questions || (obj.kahoot && obj.kahoot.questions) || (obj.data && obj.data.questions) || (Array.isArray(obj) ? obj : null);
            if (Array.isArray(qList)) {
                for (const item of qList) {
                    const qTitle = item.question || item.title;
                    if (!qTitle) continue;
                    const norm = normalizeQuestionText(qTitle);

                    if (item.type === 'open_ended' || item.type === 'word_cloud') {
                        const answers = (item.choices || []).map(c => deduplicateText(c.answer || c.title || '')).filter(Boolean);
                        quizQuestionBank.set(norm, {
                            type: 'open_ended',
                            correctAnswers: answers.length > 0 ? answers : [item.answer].filter(Boolean),
                            rawQuestion: qTitle
                        });
                    } else if (item.type === 'jumble') {
                        const orderedChoices = (item.choices || []).map(c => deduplicateText(c.answer || c.title || ''));
                        quizQuestionBank.set(norm, {
                            type: 'jumble',
                            correctAnswers: orderedChoices, // exact correct sequence
                            rawQuestion: qTitle
                        });
                    } else if (item.choices && item.choices.length > 0) {
                        const correctAnswers = item.choices.filter(c => c.correct).map(c => deduplicateText(c.answer || c.title || ''));
                        quizQuestionBank.set(norm, {
                            type: 'quiz',
                            correctAnswers: correctAnswers.length > 0 ? correctAnswers : [deduplicateText(item.choices[0].answer || '')],
                            choices: item.choices.map(c => deduplicateText(c.answer || c.title || '')),
                            rawQuestion: qTitle
                        });
                    }
                }
                console.log(`⚡ [KQH Engine] Cached ${quizQuestionBank.size} questions from quiz bank (0ms ready).`);
            }
        } catch (e) {}
    }

    // Auto-load quiz if quizId is in URL
    function checkUrlForQuizId() {
        try {
            const url = new URL(window.location.href);
            const quizId = url.searchParams.get('quizId') || url.searchParams.get('quizid');
            if (quizId) {
                const endpoints = [
                    `https://play.kahoot.it/rest/kahoots/${quizId}`,
                    `https://create.kahoot.it/rest/kahoots/${quizId}`
                ];
                endpoints.forEach(ep => {
                    fetch(ep).then(r => r.json()).then(data => {
                        extractQuizDataFromJSON(data);
                    }).catch(() => {});
                });
            }
        } catch (e) {}
    }

    // Hook Fetch for REST endpoints
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const res = await originalFetch.apply(this, args);
        try {
            const clone = res.clone();
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (url.includes('kahoot') || url.includes('/rest/') || url.includes('/api/')) {
                clone.json().then(data => extractQuizDataFromJSON(data)).catch(() => {});
            }
        } catch (e) {}
        return res;
    };

    // Hook XHR
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._url = url;
        return originalXhrOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            try {
                if (this.responseText && (this._url || '').includes('kahoot')) {
                    const data = JSON.parse(this.responseText);
                    extractQuizDataFromJSON(data);
                }
            } catch (e) {}
        });
        return originalXhrSend.apply(this, args);
    };

    // WebSocket Hook (Live Multiplayer)
    const originalWebSocket = window.WebSocket;
    const CustomWebSocket = function(url, protocols) {
        const ws = protocols !== undefined ? new originalWebSocket(url, protocols) : new originalWebSocket(url);

        ws.addEventListener('message', async function(event) {
            try {
                const messageArray = JSON.parse(event.data);
                for (let message of messageArray) {
                    if (message.data && message.data.type === 'message' && message.channel === '/service/player') {
                        const content = JSON.parse(message.data.content);
                        if (content.type === 'quiz' || content.type === 'open_ended' || content.type === 'jumble') {
                            const parsed = {
                                type: content.type,
                                question: deduplicateText(content.title || content.question || ''),
                                choices: (content.choices || []).map(c => deduplicateText(c.answer || c.title || '')),
                                imageUrl: content.image || '',
                                answersAllowed: content.numberOfAnswersAllowed || 1,
                                questionIndex: content.questionIndex || 0,
                                totalQuestions: content.totalGameBlockCount || 0
                            };
                            if (parsed.question) {
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

    // ==========================================
    // DIRECT AI ENGINES WITH AUTO-FALLBACK
    // ==========================================

    // Gemini API with multi-model auto-fallback (2.5 -> 2.0 -> 1.5)
    async function callGemini(question, choices, qType = 'quiz', imageUrl) {
        const primaryModel = state.model || 'gemini-2.5-flash';
        const candidateModels = [
            primaryModel,
            'gemini-2.0-flash',
            'gemini-1.5-flash'
        ];
        const modelList = [...new Set(candidateModels)];

        let prompt = '';
        if (qType === 'open_ended') {
            prompt = `Question: ${question}\nReturn ONLY the exact short 1-2 word answer with no punctuation or explanation:`;
        } else if (qType === 'jumble') {
            prompt = `Question: ${question}\nTiles: ${choices.join(', ')}\nArrange the tiles in the correct sequence. Return ONLY the ordered sequence or the final word:`;
        } else {
            prompt = `Question: ${question}\nChoices:\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nReturn ONLY the exact text of the single correct choice:`;
        }

        let lastErr = null;
        for (const currentModel of modelList) {
            try {
                const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${state.apiKey}`;
                
                const generationConfig = {
                    temperature: 0.0,
                    maxOutputTokens: 35
                };
                if (currentModel.includes('2.5') || currentModel.includes('2.0')) {
                    generationConfig.thinkingConfig = { thinkingBudget: 0 };
                }

                const bodyPayload = {
                    contents: [{ parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: "You are an instant Kahoot solver. Output strictly the direct answer only." }] },
                    generationConfig
                };

                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bodyPayload)
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error?.message || `HTTP ${res.status}`);
                }

                const data = await res.json();
                let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                rawText = rawText.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').replace(/^["'`]|["'`]$/g, '').trim();

                if (rawText.startsWith('{') && rawText.endsWith('}')) {
                    try {
                        const parsed = JSON.parse(rawText);
                        if (parsed.answer) rawText = parsed.answer;
                    } catch {}
                }

                return {
                    answer: rawText || 'No answer found',
                    confidence: 0.98,
                    modelUsed: currentModel
                };
            } catch (err) {
                lastErr = err;
                console.warn(`[KQH AI] Model ${currentModel} failed (${err.message}). Retrying fallback model...`);
            }
        }

        throw lastErr || new Error('All AI model attempts failed');
    }

    // OpenAI API
    async function callOpenAI(question, choices, qType = 'quiz', imageUrl) {
        let prompt = '';
        if (qType === 'open_ended') {
            prompt = `Question: ${question}\nReturn ONLY the exact short 1-2 word answer:`;
        } else if (qType === 'jumble') {
            prompt = `Question: ${question}\nTiles: ${choices.join(', ')}\nReturn the ordered sequence or correct word:`;
        } else {
            prompt = `Question: ${question}\nChoices:\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nReturn ONLY the exact matching choice:`;
        }

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
                    { role: 'system', content: 'You are an instant Kahoot solver. Output strictly the direct answer only.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.0,
                max_tokens: 35
            })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status}`);
        }

        const data = await res.json();
        let contentStr = data.choices?.[0]?.message?.content || '';
        contentStr = contentStr.replace(/^["'`]|["'`]$/g, '').trim();

        return {
            answer: contentStr || 'No answer found',
            confidence: 0.98
        };
    }

    // Solve Question (DB First -> AI Fallback)
    async function solveQuestion(question, choices, qType = 'quiz', imageUrl) {
        // 1. Instant Match from Network Database (0ms & 0 Tokens)
        const normQ = normalizeQuestionText(question);
        if (quizQuestionBank.has(normQ)) {
            const cached = quizQuestionBank.get(normQ);
            if (cached && cached.correctAnswers && cached.correctAnswers.length > 0) {
                let ansDisplay = '';
                if (cached.type === 'jumble') {
                    ansDisplay = cached.correctAnswers.map((item, idx) => `${idx + 1}. ${item}`).join(' → ');
                } else {
                    ansDisplay = cached.correctAnswers.join(' / ');
                }
                console.log('⚡ [KQH 0ms DB Hit]:', ansDisplay);
                return {
                    answer: ansDisplay,
                    rawAnswers: cached.correctAnswers,
                    confidence: 1.0,
                    isFromDB: true
                };
            }
        }

        // 2. Check API Key
        if (!state.apiKey) {
            return {
                isError: true,
                answer: 'API Key missing. Click extension icon in toolbar.',
                confidence: 0
            };
        }

        // 3. Check AI Cache
        const cacheKey = `${question}:::${choices.join('|')}:::${qType}`;
        if (answerCache.has(cacheKey)) {
            return answerCache.get(cacheKey);
        }

        // 4. Ultra-Fast AI Execution
        try {
            let res = null;
            if (state.provider === 'openai') {
                res = await callOpenAI(question, choices, qType, imageUrl);
            } else {
                res = await callGemini(question, choices, qType, imageUrl);
            }

            if (answerCache.size >= 100) {
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

        // 1. Exact match
        for (let i = 0; i < choices.length; i++) {
            const cText = String(choices[i] || '').trim().toLowerCase();
            if (cText && (cText === cleanAnswer || cleanAnswer === cText)) {
                return i;
            }
        }

        // 2. Substring match (longest first)
        const sorted = choices.map((c, i) => ({ text: String(c || '').trim().toLowerCase(), index: i }))
                              .sort((a, b) => b.text.length - a.text.length);

        for (const item of sorted) {
            if (!item.text) continue;
            if (cleanAnswer.includes(item.text) || item.text.includes(cleanAnswer)) {
                return item.index;
            }
        }

        return -1;
    }

    // Visual answer highlighting with glowing laser effect
    function resetVisuals() {
        try {
            const buttons = document.querySelectorAll('button[data-functional-selector^="answer-"]');
            buttons.forEach(btn => {
                btn.style.transition = 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
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

                btn.style.transition = 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                if (isMatch) {
                    btn.style.opacity = '1';
                    btn.style.filter = 'none';
                    btn.style.transform = 'scale(1.025)';
                    btn.style.boxShadow = '0 0 0 4px #10b981, 0 0 30px rgba(16, 185, 129, 0.85)';
                    btn.style.zIndex = '50';
                } else {
                    btn.style.opacity = '0.7'; // Keep all 4 choices clearly visible, never hide
                    btn.style.filter = 'none';
                    btn.style.transform = 'scale(0.98)';
                    btn.style.zIndex = '1';
                }
            });
        } catch (e) {}
    }

    // Macro Auto-Click Execution for Multiple Choice
    function triggerMacroAutoClick(targetIndex) {
        if (targetIndex < 0 || !state.macroEnabled) return;
        if (state.macroTimer) clearTimeout(state.macroTimer);

        const delayMs = Math.max(50, (state.macroDelay * 1000) + (Math.random() * 40 - 20));

        state.macroTimer = setTimeout(() => {
            try {
                const targetBtn = document.querySelector(`button[data-functional-selector="answer-${targetIndex}"]`) ||
                                  document.querySelectorAll('button[data-functional-selector^="answer-"]')[targetIndex];

                if (targetBtn && !targetBtn.disabled) {
                    targetBtn.focus();
                    const opts = { bubbles: true, cancelable: true, view: window };
                    targetBtn.dispatchEvent(new PointerEvent('pointerdown', opts));
                    targetBtn.dispatchEvent(new MouseEvent('mousedown', opts));
                    targetBtn.dispatchEvent(new PointerEvent('pointerup', opts));
                    targetBtn.dispatchEvent(new MouseEvent('mouseup', opts));
                    targetBtn.click();
                    console.log('⚡ [KQH Macro] Clicked choice index:', targetIndex);
                }
            } catch (err) {
                console.warn('Macro click error:', err);
            }
        }, delayMs);
    }

    // Macro Auto-Type for Open-Ended Questions
    function triggerOpenEndedMacro(answer) {
        if (!state.macroEnabled || !answer) return;
        if (state.macroTimer) clearTimeout(state.macroTimer);

        const delayMs = Math.max(100, (state.macroDelay * 1000));
        state.macroTimer = setTimeout(() => {
            try {
                const inputEl = document.querySelector('input[data-functional-selector="open-ended-answer-input"], input[data-functional-selector="text-input-field"], input[type="text"], textarea');
                if (inputEl) {
                    inputEl.focus();
                    inputEl.value = answer;
                    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                    inputEl.dispatchEvent(new Event('change', { bubbles: true }));

                    setTimeout(() => {
                        const submitBtn = document.querySelector('button[data-functional-selector="submit-button"], button[type="submit"]') ||
                                          Array.from(document.querySelectorAll('button')).find(b => b.textContent?.toLowerCase().includes('submit'));
                        if (submitBtn && !submitBtn.disabled) {
                            submitBtn.click();
                            console.log('⚡ [KQH Macro] Auto-submitted open-ended answer:', answer);
                        }
                    }, 120);
                }
            } catch (e) {}
        }, delayMs);
    }

    // Process Incoming Quiz Question
    async function processQuestion(qData, source = 'WS') {
        if (!qData || !qData.question) return;

        // If scoreboard
        if (qData.type === 'scoreboard') {
            if (state.activeType !== 'scoreboard') {
                state.activeType = 'scoreboard';
                state.activeQuestion = '';
                state.activeChoices = [];
                state.lastMatchedIndex = -1;
                state.currentAnswer = 'Scoreboard / Intermission - Waiting for next question...';
                resetVisuals();
                renderHUD(source);
            }
            return;
        }

        const isNew = qData.question !== state.activeQuestion ||
            qData.type !== state.activeType ||
            JSON.stringify(qData.choices) !== JSON.stringify(state.activeChoices);

        if (!isNew) return;

        if (state.macroTimer) clearTimeout(state.macroTimer);
        resetVisuals();

        state.activeQuestion = qData.question;
        state.activeType = qData.type || 'quiz';
        state.activeChoices = (qData.choices || []).slice();
        state.activeImage = qData.imageUrl || '';
        state.lastMatchedIndex = -1;
        state.isFromDB = false;
        state.currentAnswer = '⚡ Solving...';

        renderHUD(source);

        const res = await solveQuestion(
            state.activeQuestion,
            state.activeChoices,
            state.activeType,
            state.activeImage
        );

        state.currentAnswer = res.answer;
        state.isFromDB = Boolean(res.isFromDB);

        if (!res.isError) {
            if (state.activeType === 'quiz') {
                const targetText = res.rawAnswers ? res.rawAnswers[0] : res.answer;
                const matchedIdx = findMatchingChoiceIndex(targetText, state.activeChoices);
                state.lastMatchedIndex = matchedIdx;

                if (matchedIdx >= 0) {
                    applyLaserHighlight(matchedIdx);
                    triggerMacroAutoClick(matchedIdx);
                }
            } else if (state.activeType === 'open_ended') {
                const targetAnswer = res.rawAnswers ? res.rawAnswers[0] : res.answer;
                triggerOpenEndedMacro(targetAnswer);
            }
        }

        renderHUD(source);
    }

    // ==========================================
    // INSTANT DOM SCRAPER & MUTATION OBSERVER
    // ==========================================
    function extractChoiceFromButton(btn, index) {
        if (!btn) return `Option ${index + 1}`;

        const specific = btn.querySelector('[data-functional-selector="question-choice-text"], [data-functional-selector="choice-title"], [class*="choice-text"], [class*="AnswerText"], [class*="TextContainer"]');
        if (specific && specific.textContent?.trim()) {
            return deduplicateText(specific.textContent.trim());
        }

        const spans = Array.from(btn.querySelectorAll('span')).filter(s => {
            return !s.getAttribute('aria-hidden') && !s.className?.includes('sr-') && !s.className?.includes('screen-reader');
        });
        if (spans.length > 0 && spans[0].textContent?.trim()) {
            return deduplicateText(spans[0].textContent.trim());
        }

        return deduplicateText(btn.textContent?.trim() || `Option ${index + 1}`);
    }

    function scrapeDOM() {
        try {
            // 1. Check Scoreboard / Podium screen
            const isScoreboard = document.querySelector('[data-functional-selector="scoreboard"], [data-functional-selector="podium"], [data-functional-selector="game-over"]');
            if (isScoreboard) {
                return { type: 'scoreboard', question: 'Scoreboard' };
            }

            // 2. Question Title
            const titleEl = document.querySelector('[data-functional-selector="question-title"], [data-functional-selector="block-title"], [class*="QuestionTitle"], [class*="question-title"], h1, h2');
            const rawTitle = titleEl?.textContent?.trim() || '';
            const questionText = deduplicateText(rawTitle);

            if (!questionText) return null;

            // 3. Open-Ended / Typing Input Question
            const inputEl = document.querySelector('input[data-functional-selector="open-ended-answer-input"], input[data-functional-selector="text-input-field"], input[type="text"], textarea');
            if (inputEl) {
                return {
                    type: 'open_ended',
                    question: questionText,
                    choices: [],
                    imageUrl: ''
                };
            }

            // 4. Jumble / Puzzle Ordering Tiles
            const jumbleCards = document.querySelectorAll('[data-functional-selector^="drag-card-"], [data-functional-selector*="jumble-item"], [data-functional-selector*="sortable-item"], [class*="jumble"] [role="button"]');
            if (jumbleCards.length >= 2) {
                const tiles = Array.from(jumbleCards).map((card, i) => deduplicateText(card.textContent?.trim() || `Tile ${i + 1}`));
                return {
                    type: 'jumble',
                    question: questionText,
                    choices: tiles,
                    imageUrl: ''
                };
            }

            // 5. Standard Multiple Choice
            const choiceButtons = document.querySelectorAll('button[data-functional-selector^="answer-"]');
            if (choiceButtons.length >= 2) {
                const choices = [];
                choiceButtons.forEach((btn, i) => {
                    choices.push(extractChoiceFromButton(btn, i));
                });
                return {
                    type: 'quiz',
                    question: questionText,
                    choices,
                    imageUrl: ''
                };
            }
        } catch (e) {}
        return null;
    }

    function checkDOM() {
        if (document.hidden) return;
        const domQ = scrapeDOM();
        if (domQ) {
            processQuestion(domQ, 'DOM');
        }
    }

    let domObserver = null;
    let debounceTimer = null;

    function initDOMWatcher() {
        if (domObserver) domObserver.disconnect();

        domObserver = new MutationObserver(() => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(checkDOM, 25);
        });

        const target = document.body || document.documentElement;
        if (target) {
            domObserver.observe(target, { childList: true, subtree: true });
        }

        setInterval(checkDOM, 100);
    }

    // ==========================================
    // MINIMALIST IN-GAME HUD COMPONENT
    // ==========================================
    let hudContainer = null;

    function createHUDElement() {
        if (hudContainer && document.body.contains(hudContainer)) return;

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

        const hasKey = Boolean(state.apiKey) || state.isFromDB;
        const macroBadge = state.macroEnabled 
            ? `<span style="font-size: 9px; background: rgba(16, 185, 129, 0.25); color: #34d399; padding: 2px 6px; border-radius: 9999px; font-weight: 700; border: 1px solid rgba(16, 185, 129, 0.4);">⚡ MACRO</span>`
            : '';

        let modelTag = state.model ? state.model.replace('-flash', '').toUpperCase() : 'AI';
        if (state.isFromDB) {
            modelTag = '0ms DB';
        }

        const typeBadge = state.activeType === 'open_ended' ? 'TYPE ANSWER' : (state.activeType === 'jumble' ? 'ORDER PUZZLE' : 'QUIZ');

        // MINIMIZED MODE
        if (state.isMinimized) {
            const shortAns = state.currentAnswer ? state.currentAnswer.slice(0, 22) : 'Ready';
            hudContainer.innerHTML = `
                <div id="kqh-expand-btn" style="
                    background: rgba(9, 10, 15, 0.9);
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    box-shadow: 0 4px 25px rgba(0, 0, 0, 0.5);
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
                    <span style="opacity: 0.85; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortAns}</span>
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

        // EXPANDED MODE
        let choicesHtml = '';
        if (state.activeChoices.length > 0) {
            choicesHtml = state.activeChoices.map((c, i) => {
                const isCorrect = i === state.lastMatchedIndex;
                return `
                    <div style="
                        padding: 6px 9px;
                        border-radius: 6px;
                        font-size: 11px;
                        font-weight: 500;
                        background: ${isCorrect ? 'rgba(16, 185, 129, 0.25)' : 'rgba(255, 255, 255, 0.04)'};
                        border: 1px solid ${isCorrect ? 'rgba(16, 185, 129, 0.6)' : 'rgba(255, 255, 255, 0.08)'};
                        color: ${isCorrect ? '#6ee7b7' : '#e2e8f0'};
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    ">
                        <span style="font-weight: 700; opacity: 0.7; font-size: 10px;">${i + 1}.</span>
                        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c}</span>
                        ${isCorrect ? '<span style="color: #34d399; font-weight: 800;">✓</span>' : ''}
                    </div>
                `;
            }).join('');
        }

        hudContainer.innerHTML = `
            <div style="
                width: 280px;
                background: rgba(9, 10, 15, 0.9);
                backdrop-filter: blur(24px);
                -webkit-backdrop-filter: blur(24px);
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 12px;
                padding: 12px;
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1);
                color: #ffffff;
                transform: scale(${state.scale});
                transform-origin: top left;
            ">
                <!-- Header -->
                <div id="kqh-drag-handle" style="display: flex; align-items: center; justify-content: space-between; cursor: grab; padding-bottom: 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); margin-bottom: 10px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: ${hasKey ? '#10b981' : '#ef4444'}; box-shadow: 0 0 6px ${hasKey ? '#10b981' : '#ef4444'};"></span>
                        <strong style="font-size: 12px; font-weight: 800; letter-spacing: -0.2px;">KQH AI</strong>
                        <span style="font-size: 9px; color: ${state.isFromDB ? '#34d399' : '#818cf8'}; background: ${state.isFromDB ? 'rgba(16, 185, 129, 0.2)' : 'rgba(99, 102, 241, 0.15)'}; padding: 1px 5px; border-radius: 4px; font-weight: 700;">${modelTag}</span>
                        ${macroBadge}
                    </div>
                    <div style="display: flex; align-items: center; gap: 4px;">
                        <button id="kqh-macro-btn" title="Click to toggle Auto-Click Macro" style="background: ${state.macroEnabled ? 'rgba(16, 185, 129, 0.3)' : 'rgba(255, 255, 255, 0.08)'}; border: 1px solid ${state.macroEnabled ? '#10b981' : 'rgba(255, 255, 255, 0.15)'}; color: ${state.macroEnabled ? '#34d399' : '#94a3b8'}; border-radius: 5px; padding: 2px 6px; cursor: pointer; font-size: 10px; font-weight: 700; display: flex; align-items: center; gap: 3px;">
                            <span>⚡</span>
                            <span>${state.macroEnabled ? 'AUTO ON' : 'AUTO OFF'}</span>
                        </button>
                        <button id="kqh-min-btn" title="Minimize" style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.1); color: #ffffff; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 10px; font-weight: 700;">−</button>
                    </div>
                </div>

                <!-- Active Question -->
                <div style="margin-bottom: 8px;">
                    <div style="font-size: 10px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; display: flex; justify-content: space-between;">
                        <span>${state.activeQuestion ? 'Question' : 'Status'}</span>
                        <span style="font-size: 9px; color: #a5b4fc;">${typeBadge}</span>
                    </div>
                    <div style="font-size: 12px; font-weight: 600; line-height: 1.4; color: #f1f5f9; background: rgba(255, 255, 255, 0.04); padding: 7px 9px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.06); max-height: 52px; overflow-y: auto; user-select: text; -webkit-user-select: text;">
                        ${state.activeQuestion || (hasKey ? 'Waiting for next question...' : 'API Key missing. Click extension icon.')}
                    </div>
                </div>

                <!-- Choices -->
                ${choicesHtml ? `<div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; user-select: text; -webkit-user-select: text;">${choicesHtml}</div>` : ''}

                <!-- Recommended Answer Card -->
                <div id="kqh-answer-card" title="Click anywhere on this box to copy answer" style="
                    background: linear-gradient(135deg, rgba(16, 185, 129, 0.18), rgba(99, 102, 241, 0.14));
                    border: 1px solid rgba(16, 185, 129, 0.4);
                    border-radius: 8px;
                    padding: 8px 10px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                ">
                    <div style="font-size: 9px; font-weight: 700; color: #34d399; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; display: flex; align-items: center; justify-content: space-between;">
                        <span>Recommended Answer</span>
                        <div style="display: flex; align-items: center; gap: 4px;">
                            ${state.macroEnabled ? '<span style="font-size: 8px; color: #a7f3d0; background: rgba(16, 185, 129, 0.2); padding: 1px 4px; border-radius: 3px;">Auto-Action</span>' : ''}
                            <span id="kqh-copy-btn" style="font-size: 9px; color: #34d399; background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(16, 185, 129, 0.35); padding: 1px 6px; border-radius: 4px; font-weight: 700; transition: all 0.2s;">📋 Copy</span>
                        </div>
                    </div>
                    <div id="kqh-answer-text" style="font-size: 13px; font-weight: 700; color: #ffffff; line-height: 1.35; word-break: break-word; user-select: text; -webkit-user-select: text;">
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

                if (state.macroEnabled) {
                    if (state.activeType === 'quiz' && state.lastMatchedIndex >= 0) {
                        triggerMacroAutoClick(state.lastMatchedIndex);
                    } else if (state.activeType === 'open_ended' && state.currentAnswer) {
                        triggerOpenEndedMacro(state.currentAnswer);
                    }
                }
            });
        }

        const answerCard = document.getElementById('kqh-answer-card');
        const copyBtn = document.getElementById('kqh-copy-btn');
        if (answerCard) {
            answerCard.addEventListener('click', async () => {
                const textToCopy = (state.rawAnswers && state.rawAnswers.length > 0) ? state.rawAnswers[0] : (state.currentAnswer || '');
                if (!textToCopy || textToCopy.startsWith('Waiting') || textToCopy.startsWith('⚡ Solving') || textToCopy.startsWith('Scoreboard')) {
                    return;
                }

                try {
                    await navigator.clipboard.writeText(textToCopy);
                } catch (err) {
                    const temp = document.createElement('textarea');
                    temp.value = textToCopy;
                    document.body.appendChild(temp);
                    temp.select();
                    document.execCommand('copy');
                    document.body.removeChild(temp);
                }

                if (copyBtn) {
                    copyBtn.textContent = '✓ Copied!';
                    copyBtn.style.background = '#10b981';
                    copyBtn.style.color = '#ffffff';
                    setTimeout(() => {
                        if (copyBtn) {
                            copyBtn.textContent = '📋 Copy';
                            copyBtn.style.background = 'rgba(16, 185, 129, 0.2)';
                            copyBtn.style.color = '#34d399';
                        }
                    }, 1500);
                }
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
        checkUrlForQuizId();
        renderHUD();
        initDOMWatcher();
        console.log('⚡ KQH Universal AI Engine Loaded (0ms Intercept & Multi-Model)');
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }
})();
