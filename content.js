// content.js - Ultra-Fast Universal Real-Time AI Quiz & Kahoot Solver & Macro Engine
(function() {
    if (window.__KQH_INJECTED__) return;
    window.__KQH_INJECTED__ = true;

    'use strict';

    const isKahoot = window.location.hostname.includes('kahoot');
    const isQuizCom = window.location.hostname.includes('quiz.com');
    const platformName = isKahoot ? 'Kahoot' : (isQuizCom ? 'Quiz.com' : 'Quiz');

    // State Configuration
    const state = {
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        apiKey: '',
        macroEnabled: false,
        macroDelay: 0.3,
        isMinimized: false,
        scale: 1,
        activeQuestion: '',
        activeType: 'quiz', // 'quiz' | 'open_ended' | 'jumble' | 'scoreboard'
        activeChoices: [],
        orderedSequence: [],
        activeImage: '',
        currentAnswer: 'Waiting for quiz question...',
        lastMatchedIndex: -1,
        isFromDB: false,
        macroTimer: null
    };

    // Store DOM elements of the current active choices for instant interaction
    let activeChoiceDOMElements = [];
    let currentHighlightedElements = [];
    let currentOverlayBadges = [];

    let isSolving = false;
    let lastFailedQuestion = '';
    let lastFailedTime = 0;

    // Load initial local config
    try {
        state.provider = localStorage.getItem('kqh_provider') || 'gemini';
        state.model = localStorage.getItem('kqh_model') || (state.provider === 'gemini' ? 'gemini-1.5-flash' : 'gpt-4o-mini');
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

    // In-memory Quiz Question Bank (Intercepted from REST / WebSocket / Next.js APIs for 0ms answers)
    const quizQuestionBank = new Map();
    // Answer Memory Cache for AI responses
    const answerCache = new Map();

    function normalizeQuestionText(txt) {
        return String(txt || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    }

    // Helper: Clean choice text, remove Kahoot geometry symbols, option prefixes & deduplicate repeated words
    function deduplicateText(str) {
        if (!str) return '';
        // 1. Remove Kahoot geometry symbols (▲, ◆, ●, ■)
        str = str.replace(/^[▲◆●■\s]+/, '').trim();
        // 2. Remove standard prefixes (e.g. "A. ", "B) ", "1. ", "[A] ") safely without trimming regular words
        str = str.replace(/^(?:\[?[A-Da-d\d]\]?[\.\)\:\-\/]\s*)+/, '').trim();

        const len = str.length;
        if (len <= 1) return str;

        // 3. Exact unit repetition (e.g. malaysiamalaysiamalaysia)
        for (let unitLen = 1; unitLen <= Math.floor(len / 2); unitLen++) {
            if (len % unitLen === 0) {
                const unit = str.slice(0, unitLen);
                const times = len / unitLen;
                if (times >= 2 && unit.repeat(times) === str) {
                    return unit.trim();
                }
            }
        }

        // 4. Case-insensitive repetition (e.g. Sri LankaSri Lanka)
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

    // Helper: Check if element is in header / navbar / PIN bar
    function isHeaderOrNavbar(el) {
        if (!el) return false;
        if (el.closest('header, nav, [class*="header" i], [class*="navbar" i], [class*="top-bar" i], [class*="pin" i], [class*="PIN" i], [class*="toolbar" i], #kqh-minimal-hud, [role="dialog"], [class*="modal" i]')) {
            return true;
        }
        return false;
    }

    // Helper: Filter out UI words, button actions, and PINs
    function isBlacklistedText(txt) {
        if (!txt) return true;
        const lower = txt.toLowerCase().trim();

        // Check if pure numbers (e.g. PIN 784729)
        if (/^\d{3,8}$/.test(lower.replace(/\s+/g, ''))) return true;

        const blacklist = [
            'copy',
            'hide',
            'show',
            'submit answer',
            'submit',
            'confirm answer',
            'confirm',
            'next question',
            'next',
            'previous',
            'back',
            'skip timer',
            'skip',
            'create a quiz',
            'join game',
            'enter pin',
            'pin',
            'recently published',
            'sign in',
            'log in',
            'cancel',
            'start',
            'are you sure you want to start',
            'play for free',
            'generate a quiz',
            'quiz editor',
            'quiz generator',
            'categories',
            'explore',
            'my account',
            'slide '
        ];

        return blacklist.some(b => lower === b || (lower.startsWith(b) && lower.length < 35));
    }

    // ==========================================
    // DEEP NETWORK INTERCEPTOR (0ms REST, WebSocket & Next.js)
    // ==========================================
    function extractQuizDataFromJSON(obj) {
        if (!obj || typeof obj !== 'object') return;
        try {
            // 1. Direct Kahoot standard format check
            const qList = obj.questions || (obj.kahoot && obj.kahoot.questions) || (obj.data && obj.data.questions) || (Array.isArray(obj) ? obj : null);
            if (Array.isArray(qList) && qList.length > 0 && qList[0] && (qList[0].question || qList[0].title)) {
                for (const item of qList) {
                    const qTitle = item.question || item.title;
                    if (!qTitle) continue;
                    const norm = normalizeQuestionText(qTitle);

                    if (item.type === 'open_ended' || item.type === 'word_cloud' || item.type === 'text') {
                        const answers = (item.choices || []).map(c => deduplicateText(c.answer || c.title || '')).filter(Boolean);
                        quizQuestionBank.set(norm, {
                            type: 'open_ended',
                            correctAnswers: answers.length > 0 ? answers : [item.answer].filter(Boolean),
                            rawQuestion: qTitle
                        });
                    } else if (item.type === 'jumble' || item.type === 'ordering') {
                        const orderedChoices = (item.choices || []).map(c => deduplicateText(c.answer || c.title || ''));
                        quizQuestionBank.set(norm, {
                            type: 'jumble',
                            correctAnswers: orderedChoices,
                            rawQuestion: qTitle
                        });
                    } else if (item.choices && item.choices.length > 0) {
                        const correctAnswers = item.choices.filter(c => c.correct || c.isCorrect).map(c => deduplicateText(c.answer || c.title || ''));
                        quizQuestionBank.set(norm, {
                            type: 'quiz',
                            correctAnswers: correctAnswers.length > 0 ? correctAnswers : [deduplicateText(item.choices[0].answer || '')],
                            choices: item.choices.map(c => deduplicateText(c.answer || c.title || '')),
                            rawQuestion: qTitle
                        });
                    }
                }
                console.log(`⚡ [KQH Engine] Cached ${quizQuestionBank.size} questions from quiz bank (0ms ready).`);
                return;
            }

            // 2. Universal deep search for Quiz.com / Next.js / GraphQL APIs
            function searchForQuestions(node, depth = 0) {
                if (!node || depth > 8) return;

                if (Array.isArray(node)) {
                    let hasQuestions = false;
                    for (const item of node) {
                        if (item && typeof item === 'object' && (item.question || item.title || item.prompt || item.questionText || item.text)) {
                            if (item.choices || item.options || item.answers || item.correctAnswer || item.answer || item.correct_answer) {
                                hasQuestions = true;
                                break;
                            }
                        }
                    }

                    if (hasQuestions) {
                        for (const item of node) {
                            if (!item || typeof item !== 'object') continue;
                            const qTitle = item.question || item.title || item.prompt || item.questionText || item.text;
                            if (!qTitle || typeof qTitle !== 'string') continue;
                            const norm = normalizeQuestionText(qTitle);

                            const rawChoices = item.choices || item.options || item.answers || item.answerChoices || [];
                            const choicesList = [];
                            const correctAnswers = [];

                            if (Array.isArray(rawChoices)) {
                                for (let idx = 0; idx < rawChoices.length; idx++) {
                                    const c = rawChoices[idx];
                                    let cText = '';
                                    let isCorrect = false;

                                    if (typeof c === 'string') {
                                        cText = deduplicateText(c);
                                        if (item.correctAnswer === c || item.answer === c || item.correct_answer === c || item.correctAnswer === idx || item.correctIndex === idx) {
                                            isCorrect = true;
                                        }
                                    } else if (c && typeof c === 'object') {
                                        cText = deduplicateText(c.answer || c.title || c.text || c.label || c.value || '');
                                        if (c.correct || c.isCorrect || c.is_correct || c.right || c.isAnswer) {
                                            isCorrect = true;
                                        }
                                    }
                                    if (cText) {
                                        choicesList.push(cText);
                                        if (isCorrect) correctAnswers.push(cText);
                                    }
                                }
                            }

                            if (correctAnswers.length === 0) {
                                if (typeof item.correctAnswer === 'string' && item.correctAnswer) {
                                    correctAnswers.push(deduplicateText(item.correctAnswer));
                                } else if (typeof item.answer === 'string' && item.answer) {
                                    correctAnswers.push(deduplicateText(item.answer));
                                } else if (typeof item.solution === 'string' && item.solution) {
                                    correctAnswers.push(deduplicateText(item.solution));
                                }
                            }

                            const qType = (item.type === 'open_ended' || item.type === 'text' || item.type === 'word_cloud')
                                ? 'open_ended'
                                : (item.type === 'jumble' || item.type === 'ordering') ? 'jumble' : 'quiz';

                            if (correctAnswers.length > 0 || choicesList.length > 0) {
                                quizQuestionBank.set(norm, {
                                    type: qType,
                                    correctAnswers: correctAnswers.length > 0 ? correctAnswers : (choicesList.length > 0 ? [choicesList[0]] : []),
                                    choices: choicesList,
                                    rawQuestion: qTitle
                                });
                            }
                        }
                        console.log(`⚡ [KQH Engine] Cached ${quizQuestionBank.size} questions from quiz bank (0ms ready).`);
                        return;
                    }

                    for (const item of node) {
                        if (item && typeof item === 'object') searchForQuestions(item, depth + 1);
                    }
                } else if (typeof node === 'object') {
                    for (const key of Object.keys(node)) {
                        if (node[key] && typeof node[key] === 'object') {
                            searchForQuestions(node[key], depth + 1);
                        }
                    }
                }
            }

            searchForQuestions(obj);
        } catch (e) {}
    }

    // Auto-load quiz if quizId is in URL, pathname, or pre-rendered Next.js data
    function checkInitialPageData() {
        try {
            // 1. Check Next.js state
            const nextDataEl = document.getElementById('__NEXT_DATA__');
            if (nextDataEl && nextDataEl.textContent) {
                const parsed = JSON.parse(nextDataEl.textContent);
                extractQuizDataFromJSON(parsed);
            }

            // 2. Check URL search parameters (Kahoot)
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

            // 3. Check URL pathname for Quiz.com UUID (e.g. /play/82e7f0d7-ec75-4e94-96cb-1c013f1a48b4/)
            const pathMatch = window.location.pathname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (pathMatch) {
                const quizUuid = pathMatch[1];
                const quizEndpoints = [
                    `https://quiz.com/api/quizzes/${quizUuid}`,
                    `https://quiz.com/api/quiz/${quizUuid}`,
                    `https://quiz.com/api/play/${quizUuid}`,
                    `https://quiz.com/api/games/${quizUuid}`,
                    `/api/quizzes/${quizUuid}`,
                    `/api/quiz/${quizUuid}`
                ];
                quizEndpoints.forEach(ep => {
                    fetch(ep).then(r => r.json()).then(data => {
                        extractQuizDataFromJSON(data);
                    }).catch(() => {});
                });
            }
        } catch (e) {}
    }

    // Hook Fetch for REST & Next.js endpoints
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const res = await originalFetch.apply(this, args);
        try {
            const clone = res.clone();
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (url.includes('kahoot') || url.includes('quiz.com') || url.includes('/rest/') || url.includes('/api/') || url.includes('/_next/') || url.includes('graphql') || url.endsWith('.json')) {
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
                if (this.responseText) {
                    const url = this._url || '';
                    if (url.includes('kahoot') || url.includes('quiz.com') || url.includes('/rest/') || url.includes('/api/') || url.includes('/_next/')) {
                        const data = JSON.parse(this.responseText);
                        extractQuizDataFromJSON(data);
                    }
                }
            } catch (e) {}
        });
        return originalXhrSend.apply(this, args);
    };

    // WebSocket Hook (Live Kahoot Multiplayer)
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

    // Gemini API with robust multi-model fallback (v1beta only)
    async function callGemini(question, choices, qType = 'quiz', imageUrl) {
        const primaryModel = state.model || 'gemini-1.5-flash';

        const targets = [
            { ver: 'v1beta', model: primaryModel },
            { ver: 'v1beta', model: 'gemini-1.5-flash' },
            { ver: 'v1beta', model: 'gemini-2.0-flash' },
            { ver: 'v1beta', model: 'gemini-1.5-pro' }
        ];

        const seen = new Set();
        const candidateTargets = targets.filter(t => {
            const k = `${t.ver}:${t.model}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        let prompt = '';
        if (qType === 'open_ended') {
            prompt = `You are an instant quiz solver. Answer this question with ONLY the exact single word or number: "${question}"`;
        } else if (qType === 'jumble') {
            prompt = `You are an expert quiz solver.\nQuestion: "${question}"\nItems to order:\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nTask: Return ALL the items above in the strict correct sequence from first (top) to last (bottom). Output strictly a numbered list (1 to ${choices.length}) with 1 item per line:`;
        } else {
            prompt = `You are an expert quiz solver.\nQuestion: ${question}\nChoices:\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nReturn ONLY the exact text of the single correct choice:`;
        }

        let lastErr = null;
        for (const target of candidateTargets) {
            try {
                const endpoint = `https://generativelanguage.googleapis.com/${target.ver}/models/${target.model}:generateContent?key=${state.apiKey}`;

                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{ text: prompt }]
                        }],
                        generationConfig: {
                            temperature: 0.1,
                            maxOutputTokens: 120
                        }
                    })
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
                    modelUsed: target.model
                };
            } catch (err) {
                lastErr = err;
                console.warn(`[KQH AI] Model ${target.ver}/${target.model} failed (${err.message}). Retrying next target...`);
            }
        }

        const errMsg = lastErr?.message || 'All Gemini API model attempts failed.';
        if (errMsg.includes('Quota exceeded') || errMsg.includes('quota') || errMsg.includes('429')) {
            throw new Error('Gemini Quota Exceeded (Free tier limit). Switch to Gemini 1.5 Flash in settings or wait a moment.');
        }
        throw lastErr || new Error('All Gemini API model attempts failed. Please verify API key.');
    }

    // OpenAI API
    async function callOpenAI(question, choices, qType = 'quiz', imageUrl) {
        let prompt = '';
        if (qType === 'open_ended') {
            prompt = `Question: ${question}\nReturn ONLY the exact short 1-2 word or number answer:`;
        } else if (qType === 'jumble') {
            prompt = `Question: "${question}"\nItems to order:\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\nReturn the items strictly in correct order from top to bottom (1 to ${choices.length}):`;
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
                    { role: 'system', content: 'You are an instant quiz solver. Output strictly the direct answer only.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.0,
                max_tokens: 120
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

    // Helper: Parse AI response for Jumble / Ordering questions into ordered choices array
    function parseOrderedChoices(aiAnswer, choices) {
        if (!aiAnswer || !choices || choices.length === 0) return choices;

        const lines = aiAnswer.split('\n').map(l => l.replace(/^\d+[\.\)\:\-\s]+\s*/, '').trim()).filter(Boolean);
        const ordered = [];
        const remainingChoices = [...choices];

        for (const line of lines) {
            const matchIdx = findMatchingChoiceIndex(line, remainingChoices);
            if (matchIdx >= 0) {
                ordered.push(remainingChoices[matchIdx]);
                remainingChoices.splice(matchIdx, 1);
            }
        }

        for (const rem of remainingChoices) {
            ordered.push(rem);
        }

        return ordered.length > 0 ? ordered : choices;
    }

    // Cooldown map for failed requests to avoid rapid API quota depletion
    const failureCooldownMap = new Map();

    // Solve Question (0ms DB First -> AI Fallback)
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
        const cacheKey = `${normQ}:::${choices.join('|')}:::${qType}`;
        if (answerCache.has(cacheKey)) {
            return answerCache.get(cacheKey);
        }

        // Check if recently failed (10-second cooldown)
        const lastFail = failureCooldownMap.get(cacheKey);
        if (lastFail && (Date.now() - lastFail.time < 10000)) {
            return {
                isError: true,
                answer: lastFail.msg,
                confidence: 0
            };
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
            failureCooldownMap.delete(cacheKey);
            return res;
        } catch (e) {
            failureCooldownMap.set(cacheKey, { time: Date.now(), msg: `AI: ${e.message}` });
            return {
                isError: true,
                answer: `AI: ${e.message}`,
                confidence: 0
            };
        }
    }

    // Match choice index (0 - 3 or n choices)
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

    // Overlay Badge Numbers Directly on Game Tiles for Jumble / Ordering Mode
    function clearJumbleOverlays() {
        currentOverlayBadges.forEach(b => {
            try {
                if (b && b.parentNode) b.parentNode.removeChild(b);
            } catch (e) {}
        });
        currentOverlayBadges = [];
    }

    function applyJumbleNumberOverlays(orderedItems, choiceElements) {
        clearJumbleOverlays();
        if (!orderedItems || !choiceElements || choiceElements.length === 0) return;

        choiceElements.forEach((el, idx) => {
            if (!el) return;
            const elText = extractChoiceFromButton(el, idx);
            let targetRank = -1;

            for (let r = 0; r < orderedItems.length; r++) {
                const itemText = orderedItems[r];
                if (itemText && (itemText.toLowerCase() === elText.toLowerCase() ||
                    itemText.toLowerCase().includes(elText.toLowerCase()) ||
                    elText.toLowerCase().includes(itemText.toLowerCase()))) {
                    targetRank = r + 1;
                    break;
                }
            }

            if (targetRank > 0 && el.isConnected && el.appendChild) {
                try {
                    const origPos = window.getComputedStyle(el).position;
                    if (origPos === 'static') {
                        el.style.position = 'relative';
                    }

                    const badge = document.createElement('div');
                    badge.className = 'kqh-jumble-badge';
                    badge.textContent = `#${targetRank}`;
                    badge.style.cssText = `
                        position: absolute;
                        top: 6px;
                        left: 8px;
                        background: linear-gradient(135deg, #10b981, #059669);
                        color: #ffffff;
                        font-weight: 800;
                        font-size: 13px;
                        padding: 2px 9px;
                        border-radius: 6px;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.5), 0 0 12px rgba(16, 185, 129, 0.8);
                        z-index: 999;
                        pointer-events: none;
                        letter-spacing: 0.5px;
                        border: 1px solid rgba(255, 255, 255, 0.6);
                        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                    `;
                    el.appendChild(badge);
                    currentOverlayBadges.push(badge);

                    el.style.transition = 'all 0.25s ease';
                    el.style.outline = '3px solid #10b981';
                    el.style.boxShadow = '0 0 15px rgba(16, 185, 129, 0.4)';
                } catch (e) {}
            }
        });
    }

    // Visual answer highlighting with glowing laser effect (Universal for Kahoot & Quiz.com)
    function resetVisuals() {
        try {
            clearJumbleOverlays();

            if (currentHighlightedElements && currentHighlightedElements.length > 0) {
                currentHighlightedElements.forEach(el => {
                    el.style.transition = 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
                    el.style.opacity = '1';
                    el.style.filter = 'none';
                    el.style.transform = 'none';
                    el.style.boxShadow = '';
                    el.style.outline = '';
                    el.style.zIndex = '';
                });
                currentHighlightedElements = [];
            }

            const kahootButtons = document.querySelectorAll('[data-functional-selector^="answer-"]');
            kahootButtons.forEach(btn => {
                btn.style.transition = 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
                btn.style.opacity = '1';
                btn.style.filter = 'none';
                btn.style.transform = 'none';
                btn.style.boxShadow = '';
                btn.style.outline = '';
                btn.style.zIndex = '';
            });
        } catch (e) {}
    }

    function applyLaserHighlight(targetIndex, choiceElements) {
        if (targetIndex < 0) return;
        try {
            // Priority 1: Direct Kahoot answer blocks (Host & Player)
            const kahootButtons = document.querySelectorAll('[data-functional-selector^="answer-"]');
            if (kahootButtons && kahootButtons.length >= 2) {
                kahootButtons.forEach((btn, idx) => {
                    const selector = btn.getAttribute('data-functional-selector') || '';
                    const isMatch = selector === `answer-${targetIndex}` || idx === targetIndex;

                    btn.style.transition = 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
                    if (isMatch) {
                        btn.style.opacity = '1';
                        btn.style.filter = 'none';
                        btn.style.transform = 'scale(1.025)';
                        btn.style.outline = '4px solid #10b981';
                        btn.style.boxShadow = '0 0 0 4px #10b981, 0 0 30px rgba(16, 185, 129, 0.85)';
                        btn.style.zIndex = '50';
                    } else {
                        btn.style.opacity = '0.7';
                        btn.style.filter = 'none';
                        btn.style.transform = 'scale(0.98)';
                        btn.style.outline = '';
                        btn.style.boxShadow = '';
                        btn.style.zIndex = '1';
                    }
                });
                return;
            }

            // Priority 2: Universal / Quiz.com DOM elements
            const els = (choiceElements && choiceElements.length > 0) ? choiceElements : activeChoiceDOMElements;
            if (!els || els.length === 0) return;

            currentHighlightedElements = els;

            els.forEach((el, idx) => {
                const isMatch = idx === targetIndex;
                el.style.transition = 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)';

                if (isMatch) {
                    el.style.opacity = '1';
                    el.style.filter = 'none';
                    el.style.transform = 'scale(1.025)';
                    el.style.outline = '3px solid #10b981';
                    el.style.boxShadow = '0 0 0 4px rgba(16, 185, 129, 0.5), 0 0 30px rgba(16, 185, 129, 0.85)';
                    el.style.zIndex = '50';
                } else {
                    el.style.opacity = '0.65';
                    el.style.filter = 'none';
                    el.style.transform = 'scale(0.98)';
                    el.style.outline = 'none';
                    el.style.boxShadow = '';
                    el.style.zIndex = '1';
                }
            });
        } catch (e) {}
    }

    // Macro Auto-Click Execution for Multiple Choice (Kahoot & Quiz.com)
    function triggerMacroAutoClick(targetIndex, choiceElements) {
        if (targetIndex < 0 || !state.macroEnabled) return;
        if (state.macroTimer) clearTimeout(state.macroTimer);

        const delayMs = Math.max(50, (state.macroDelay * 1000) + (Math.random() * 40 - 20));

        state.macroTimer = setTimeout(() => {
            try {
                let targetBtn = document.querySelector(`button[data-functional-selector="answer-${targetIndex}"]`) ||
                                document.querySelectorAll('[data-functional-selector^="answer-"]')[targetIndex];

                if (!targetBtn) {
                    const els = (choiceElements && choiceElements.length > 0) ? choiceElements : activeChoiceDOMElements;
                    targetBtn = els[targetIndex];
                }

                if (targetBtn && !targetBtn.disabled) {
                    targetBtn.focus();
                    const opts = { bubbles: true, cancelable: true, view: window };
                    targetBtn.dispatchEvent(new PointerEvent('pointerdown', opts));
                    targetBtn.dispatchEvent(new MouseEvent('mousedown', opts));
                    targetBtn.dispatchEvent(new PointerEvent('pointerup', opts));
                    targetBtn.dispatchEvent(new MouseEvent('mouseup', opts));
                    targetBtn.click();

                    const radio = targetBtn.querySelector('input[type="radio"]') ||
                                  (targetBtn.tagName === 'LABEL' ? document.getElementById(targetBtn.getAttribute('for')) : null);
                    if (radio && !radio.checked) {
                        radio.checked = true;
                        radio.dispatchEvent(new Event('input', { bubbles: true }));
                        radio.dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    console.log('⚡ [KQH Macro] Clicked choice index:', targetIndex);

                    setTimeout(() => {
                        const submitBtn = document.querySelector('button[data-functional-selector="submit-button"], button[type="submit"], [class*="submit-btn" i], [class*="confirm-btn" i]');
                        if (submitBtn && !submitBtn.disabled) {
                            submitBtn.click();
                        }
                    }, 120);
                }
            } catch (err) {
                console.warn('Macro click error:', err);
            }
        }, delayMs);
    }

    // Macro Auto-Type for Open-Ended Questions (Kahoot & Quiz.com)
    function triggerOpenEndedMacro(answer) {
        if (!state.macroEnabled || !answer) return;
        if (state.macroTimer) clearTimeout(state.macroTimer);

        const delayMs = Math.max(100, (state.macroDelay * 1000));
        state.macroTimer = setTimeout(() => {
            try {
                const inputEl = document.querySelector('input[data-functional-selector="open-ended-answer-input"], input[data-functional-selector="text-input-field"], input[type="text"]:not([id*="search"]):not([placeholder*="PIN"]), textarea');
                if (inputEl && !inputEl.closest('#kqh-minimal-hud')) {
                    inputEl.focus();

                    const proto = inputEl instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    if (nativeSetter) {
                        nativeSetter.call(inputEl, answer);
                    } else {
                        inputEl.value = answer;
                    }

                    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                    inputEl.dispatchEvent(new Event('change', { bubbles: true }));

                    setTimeout(() => {
                        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                        inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

                        const submitBtn = document.querySelector('button[data-functional-selector="submit-button"], button[type="submit"]') ||
                                          Array.from(document.querySelectorAll('button')).find(b => {
                                              const t = b.textContent?.trim().toLowerCase();
                                              return t === 'submit' || t === 'enter' || t === 'send' || t === 'confirm';
                                          });
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
                state.orderedSequence = [];
                state.lastMatchedIndex = -1;
                state.currentAnswer = 'Scoreboard / Intermission - Waiting for next question...';
                resetVisuals();
                renderHUD(source);
            }
            return;
        }

        if (isSolving && qData.question === state.activeQuestion) return;

        // Cooldown for failed question (10s)
        if (qData.question === lastFailedQuestion && (Date.now() - lastFailedTime < 10000)) {
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
        state.orderedSequence = [];
        state.activeImage = qData.imageUrl || '';
        state.lastMatchedIndex = -1;
        state.isFromDB = false;
        state.currentAnswer = '⚡ Solving...';

        renderHUD(source);

        isSolving = true;
        try {
            const res = await solveQuestion(
                state.activeQuestion,
                state.activeChoices,
                state.activeType,
                state.activeImage
            );

            state.isFromDB = Boolean(res.isFromDB);

            if (!res.isError) {
                lastFailedQuestion = '';
                if (state.activeType === 'quiz') {
                    state.currentAnswer = res.answer;
                    const targetText = res.rawAnswers ? res.rawAnswers[0] : res.answer;
                    const matchedIdx = findMatchingChoiceIndex(targetText, state.activeChoices);
                    state.lastMatchedIndex = matchedIdx;

                    if (matchedIdx >= 0) {
                        applyLaserHighlight(matchedIdx, activeChoiceDOMElements);
                        triggerMacroAutoClick(matchedIdx, activeChoiceDOMElements);
                    }
                } else if (state.activeType === 'jumble') {
                    const ordered = res.rawAnswers && res.rawAnswers.length > 0
                        ? res.rawAnswers
                        : parseOrderedChoices(res.answer, state.activeChoices);

                    state.orderedSequence = ordered;
                    state.currentAnswer = ordered.map((item, idx) => `${idx + 1}. ${item}`).join(' → ');
                    applyJumbleNumberOverlays(ordered, activeChoiceDOMElements);
                } else if (state.activeType === 'open_ended') {
                    state.currentAnswer = res.answer;
                    const targetAnswer = res.rawAnswers ? res.rawAnswers[0] : res.answer;
                    triggerOpenEndedMacro(targetAnswer);
                }
            } else {
                state.currentAnswer = res.answer;
                lastFailedQuestion = qData.question;
                lastFailedTime = Date.now();
            }
        } finally {
            isSolving = false;
        }

        renderHUD(source);
    }

    // ==========================================
    // INSTANT DOM SCRAPER & MUTATION OBSERVER
    // ==========================================
    function isValidChoiceElement(el) {
        if (!el || isHeaderOrNavbar(el)) return false;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

        const text = el.textContent?.trim() || '';
        if (!text || text.length < 1 || isBlacklistedText(text)) return false;

        const rect = el.getBoundingClientRect();
        if (rect.width < 25 || rect.height < 15) return false;

        return true;
    }

    function deduplicateChoiceElements(elements) {
        if (!elements || elements.length === 0) return [];

        const nonNested = elements.filter(el => {
            if (!el) return false;
            return !elements.some(other => other && other !== el && el.contains && el.contains(other));
        });

        const unique = [];
        const seenTexts = new Set();

        for (const el of nonNested) {
            if (!el) continue;
            const txt = normalizeQuestionText(el.textContent || '');
            if (!txt) continue;
            if (!seenTexts.has(txt)) {
                seenTexts.add(txt);
                unique.push(el);
            }
        }

        return unique.length >= 2 ? unique : nonNested;
    }

    function extractChoiceFromButton(btn, index) {
        if (!btn) return `Option ${index + 1}`;

        const specific = btn.querySelector('[data-functional-selector="question-choice-text"], [data-functional-selector="choice-title"], [class*="choice-text" i], [class*="choice_text" i], [class*="AnswerText" i], [class*="TextContainer" i], [class*="label" i], [class*="text" i]');
        if (specific && specific.textContent?.trim()) {
            return deduplicateText(specific.textContent.trim());
        }

        const spans = Array.from(btn.querySelectorAll('span, p, div')).filter(s => {
            return !s.getAttribute('aria-hidden') && !s.className?.includes('sr-') && !s.className?.includes('screen-reader');
        });
        if (spans.length > 0 && spans[0].textContent?.trim()) {
            return deduplicateText(spans[0].textContent.trim());
        }

        return deduplicateText(btn.textContent?.trim() || `Option ${index + 1}`);
    }

    function findChoiceDOMElements() {
        // 1. Kahoot answer blocks (Both Host & Player, <div> or <button>)
        const kahootBlocks = Array.from(document.querySelectorAll('[data-functional-selector^="answer-"]')).filter(el => {
            if (el.closest('#kqh-minimal-hud, [role="dialog"], [class*="modal" i]')) return false;
            const t = el.textContent?.trim();
            return t && !isBlacklistedText(t);
        });
        if (kahootBlocks.length >= 2) return kahootBlocks;

        // 2. Kahoot Drag cards
        const kahootDrag = Array.from(document.querySelectorAll('[data-functional-selector^="drag-card-"]'));
        if (kahootDrag.length >= 2) return kahootDrag;

        // 3. Quiz.com / Web Quizzes Option Card Selectors
        const choiceSelectors = [
            'button[data-testid*="choice"]',
            'button[data-testid*="option"]',
            'button[data-testid*="answer"]',
            '[data-testid*="answer-option"]',
            'button[class*="choice" i]',
            'button[class*="option" i]',
            'button[class*="answer" i]',
            'div[role="button"][class*="choice" i]',
            'div[role="button"][class*="option" i]',
            'div[role="button"][class*="answer" i]',
            'label[class*="choice" i]',
            'label[class*="option" i]',
            'label[class*="answer" i]',
            '[class*="choices" i] button',
            '[class*="options" i] button',
            '[class*="answers" i] button',
            '[class*="choices" i] [role="button"]',
            '[class*="options" i] [role="button"]',
            '[class*="answers" i] [role="button"]',
            '.quiz-option',
            '.answer-card'
        ];

        for (const sel of choiceSelectors) {
            const list = Array.from(document.querySelectorAll(sel)).filter(isValidChoiceElement);
            const deduped = deduplicateChoiceElements(list);
            if (deduped.length >= 2 && deduped.length <= 10) {
                return deduped;
            }
        }

        // 4. Universal Grouping Algorithm for Quiz.com (Excludes Header/Navbar)
        const allClickables = Array.from(document.querySelectorAll('button, div[role="button"], label, div[tabindex="0"], div[draggable="true"]')).filter(isValidChoiceElement);

        // Group by parent
        const parentMap = new Map();
        for (const el of allClickables) {
            const parent = el.parentElement;
            if (!parent || parent === document.body || isHeaderOrNavbar(parent)) continue;
            if (!parentMap.has(parent)) parentMap.set(parent, []);
            parentMap.get(parent).push(el);
        }

        for (const [parent, items] of parentMap.entries()) {
            const deduped = deduplicateChoiceElements(items);
            if (deduped.length >= 2 && deduped.length <= 8) {
                return deduped;
            }
        }

        // Group by grandparent
        const grandParentMap = new Map();
        for (const el of allClickables) {
            const grandParent = el.parentElement?.parentElement;
            if (!grandParent || grandParent === document.body || isHeaderOrNavbar(grandParent)) continue;
            if (!grandParentMap.has(grandParent)) grandParentMap.set(grandParent, []);
            grandParentMap.get(grandParent).push(el);
        }

        for (const [grandParent, items] of grandParentMap.entries()) {
            const deduped = deduplicateChoiceElements(items);
            if (deduped.length >= 2 && deduped.length <= 8) {
                return deduped;
            }
        }

        return [];
    }

    function findQuestionText(choiceElements) {
        // 1. Kahoot functional selectors (Host & Player)
        const kahootTitle = document.querySelector('[data-functional-selector="question-title"], [data-functional-selector="block-title"], [class*="question-title__" i], [class*="QuestionTitle" i]');
        if (kahootTitle && kahootTitle.textContent?.trim()) {
            const kt = deduplicateText(kahootTitle.textContent.trim());
            if (!isBlacklistedText(kt) && kt.length >= 4) {
                return kt;
            }
        }

        // 2. Specific question testids/classes
        const specificQuestionSelectors = [
            '[data-testid*="question"]',
            '[data-cy*="question"]',
            '[class*="question-text" i]',
            '[class*="question_text" i]',
            '[class*="questionTitle" i]',
            '[class*="question_title" i]',
            '[class*="QuestionCard" i] h1, [class*="QuestionCard" i] h2, [class*="QuestionCard" i] h3, [class*="QuestionCard" i] p',
            '[class*="prompt" i]',
            '.quiz-question',
            '.question-body',
            '.question-content'
        ];

        for (const sel of specificQuestionSelectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                if (isHeaderOrNavbar(el)) continue;
                const txt = deduplicateText(el.textContent?.trim() || '');
                if (txt && txt.length >= 4 && !isBlacklistedText(txt)) {
                    return txt;
                }
            }
        }

        // 3. Search near choices container (preceding siblings)
        if (choiceElements && choiceElements.length > 0) {
            const firstChoice = choiceElements[0];
            let parent = firstChoice.parentElement;
            for (let i = 0; i < 4 && parent && parent !== document.body; i++) {
                if (isHeaderOrNavbar(parent)) break;

                let prev = parent.previousElementSibling;
                while (prev) {
                    if (!isHeaderOrNavbar(prev)) {
                        const txt = deduplicateText(prev.textContent?.trim() || '');
                        if (txt && txt.length >= 4 && !isBlacklistedText(txt)) {
                            return txt;
                        }
                    }
                    prev = prev.previousElementSibling;
                }

                const headings = parent.querySelectorAll('h1, h2, h3, h4, [class*="title" i], [class*="text" i], [class*="question" i]');
                for (const h of headings) {
                    if (!h || isHeaderOrNavbar(h)) continue;
                    if (choiceElements && choiceElements.some(c => c && h && ((c.contains && c.contains(h)) || (h.contains && h.contains(c))))) continue;
                    const txt = deduplicateText(h.textContent?.trim() || '');
                    if (txt && txt.length >= 4 && !isBlacklistedText(txt)) {
                        return txt;
                    }
                }

                parent = parent.parentElement;
            }
        }

        // 4. Universal search for elements in main area containing '?'
        const allTextEls = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, div')).filter(el => {
            if (!el || isHeaderOrNavbar(el)) return false;
            if (choiceElements && choiceElements.some(c => c && el && ((c.contains && c.contains(el)) || (el.contains && el.contains(c))))) return false;
            return true;
        });

        for (const el of allTextEls) {
            const txt = deduplicateText(el.textContent?.trim() || '');
            if (txt && txt.includes('?') && !isBlacklistedText(txt) && txt.length >= 8 && txt.length <= 300) {
                return txt;
            }
        }

        for (const el of allTextEls) {
            const txt = deduplicateText(el.textContent?.trim() || '');
            if (txt && txt.length >= 8 && txt.length <= 250 && !isBlacklistedText(txt)) {
                return txt;
            }
        }

        return '';
    }

    function detectQuestionType(questionText, choiceElements) {
        const qLower = (questionText || '').toLowerCase();

        // 1. Keyword check in question text
        const orderingKeywords = [
            'order of',
            'in order',
            'starting event',
            'from first to last',
            'first to last',
            'chronological',
            'sequence',
            'arrange',
            'rank the',
            'sort the',
            'lowest to highest',
            'highest to lowest',
            'earliest to latest',
            'oldest to newest',
            'newest to oldest',
            'top to bottom'
        ];

        if (orderingKeywords.some(k => qLower.includes(k))) {
            return 'jumble';
        }

        // 2. Kahoot drag cards
        if (document.querySelectorAll('[data-functional-selector^="drag-card-"]').length >= 2) {
            return 'jumble';
        }

        // 3. Draggable elements on Quiz.com
        const hasDraggable = choiceElements.some(el => {
            return el.getAttribute('draggable') === 'true' ||
                   el.hasAttribute('data-rbd-draggable-id') ||
                   el.className?.toLowerCase().includes('drag') ||
                   el.className?.toLowerCase().includes('sort') ||
                   el.className?.toLowerCase().includes('jumble');
        });

        // 4. Presence of explicit Submit answer button under choices
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const hasSubmitButton = allButtons.some(b => {
            if (isHeaderOrNavbar(b)) return false;
            const t = b.textContent?.trim().toLowerCase();
            return t === 'submit answer' || t === 'submit';
        });

        if (hasDraggable || (hasSubmitButton && choiceElements.length >= 3)) {
            return 'jumble';
        }

        return 'quiz';
    }

    function findQuizImage() {
        const kahootImg = document.querySelector('[data-functional-selector="question-media-image"], [data-functional-selector="question-image"]');
        if (kahootImg && kahootImg.src) return kahootImg.src;

        const imgs = Array.from(document.querySelectorAll('img')).filter(img => {
            if (isHeaderOrNavbar(img)) return false;
            if (img.src && (img.src.includes('avatar') || img.src.includes('icon') || img.src.includes('logo') || img.src.includes('host'))) return false;
            const rect = img.getBoundingClientRect();
            return rect.width > 70 && rect.height > 70;
        });

        if (imgs.length > 0) {
            return imgs[0].src;
        }

        return '';
    }

    function scrapeDOM() {
        try {
            // 1. Check Scoreboard / Podium screen
            const isScoreboard = document.querySelector('[data-functional-selector="scoreboard"], [data-functional-selector="podium"], [data-functional-selector="game-over"], [class*="podium" i], [class*="scoreboard" i]');
            if (isScoreboard) {
                return { type: 'scoreboard', question: 'Scoreboard' };
            }

            // 2. Open-Ended / Typing Input Question
            const inputEl = document.querySelector('input[data-functional-selector="open-ended-answer-input"], input[data-functional-selector="text-input-field"], input[type="text"]:not([id*="search"]):not([placeholder*="PIN"]), textarea');
            if (inputEl && !isHeaderOrNavbar(inputEl) && inputEl.offsetParent !== null) {
                const questionText = findQuestionText([]);
                if (questionText) {
                    activeChoiceDOMElements = [];
                    return {
                        type: 'open_ended',
                        question: questionText,
                        choices: [],
                        imageUrl: findQuizImage()
                    };
                }
            }

            // 3. Choices & Ordering Tiles (Kahoot & Quiz.com)
            const choiceButtons = findChoiceDOMElements();
            if (choiceButtons.length >= 2) {
                activeChoiceDOMElements = choiceButtons;
                const choices = choiceButtons.map((btn, i) => extractChoiceFromButton(btn, i));
                const questionText = findQuestionText(choiceButtons);

                if (questionText) {
                    const qType = detectQuestionType(questionText, choiceButtons);
                    return {
                        type: qType,
                        question: questionText,
                        choices,
                        imageUrl: findQuizImage()
                    };
                }
            }

            // 4. Slider / Gauge / Number Estimation Question (No choice buttons)
            const questionText = findQuestionText([]);
            if (questionText && (questionText.includes('?') || questionText.length >= 10)) {
                const hasSliderOrGauge = document.querySelector('[role="slider"], input[type="range"], [class*="slider" i], [class*="gauge" i], [class*="scale" i]');
                const hasSubmitBtn = Array.from(document.querySelectorAll('button, [role="button"]')).some(b => {
                    if (isHeaderOrNavbar(b)) return false;
                    const t = b.textContent?.trim().toLowerCase();
                    return t === 'submit answer' || t === 'submit';
                });

                if (hasSliderOrGauge || hasSubmitBtn) {
                    activeChoiceDOMElements = [];
                    return {
                        type: 'open_ended',
                        question: questionText,
                        choices: [],
                        imageUrl: findQuizImage()
                    };
                }
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
            debounceTimer = setTimeout(checkDOM, 40);
        });

        const target = document.body || document.documentElement;
        if (target) {
            domObserver.observe(target, { childList: true, subtree: true });
        }

        setInterval(checkDOM, 150);
    }

    // ==========================================
    // MINIMALIST IN-GAME HUD COMPONENT
    // ==========================================
    let hudContainer = null;

    function createHUDElement() {
        const parent = document.body || document.documentElement;
        if (!parent) return;
        if (hudContainer && parent.contains && parent.contains(hudContainer)) return;

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

        try {
            parent.appendChild(hudContainer);
            setupDragging(hudContainer);
        } catch (e) {}
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

        const typeBadge = state.activeType === 'open_ended' ? 'TYPE / ESTIMATE' : (state.activeType === 'jumble' ? 'ORDER PUZZLE' : 'QUIZ');

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
                    <span style="font-size: 9px; color: #a5b4fc; background: rgba(99, 102, 241, 0.15); padding: 1px 4px; border-radius: 3px;">${platformName}</span>
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
        if (state.activeType === 'jumble' && state.orderedSequence.length > 0) {
            choicesHtml = `
                <div style="font-size: 9px; font-weight: 700; color: #a5b4fc; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px;">
                    Order Sequence (Top → Bottom)
                </div>
                ${state.orderedSequence.map((c, i) => `
                    <div style="
                        padding: 5px 8px;
                        border-radius: 6px;
                        font-size: 11px;
                        font-weight: 600;
                        background: rgba(99, 102, 241, 0.18);
                        border: 1px solid rgba(99, 102, 241, 0.4);
                        color: #e0e7ff;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    ">
                        <span style="background: #6366f1; color: #ffffff; font-weight: 800; font-size: 10px; padding: 1px 5px; border-radius: 4px;">${i + 1}</span>
                        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c}</span>
                    </div>
                `).join('')}
            `;
        } else if (state.activeChoices.length > 0) {
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
                width: 290px;
                background: rgba(9, 10, 15, 0.92);
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
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <span style="width: 6px; height: 6px; border-radius: 50%; background: ${hasKey ? '#10b981' : '#ef4444'}; box-shadow: 0 0 6px ${hasKey ? '#10b981' : '#ef4444'};"></span>
                        <strong style="font-size: 12px; font-weight: 800; letter-spacing: -0.2px;">KQH AI</strong>
                        <span style="font-size: 9px; color: #a5b4fc; background: rgba(99, 102, 241, 0.15); padding: 1px 4px; border-radius: 4px; font-weight: 700;">${platformName}</span>
                        <span style="font-size: 9px; color: ${state.isFromDB ? '#34d399' : '#818cf8'}; background: ${state.isFromDB ? 'rgba(16, 185, 129, 0.2)' : 'rgba(99, 102, 241, 0.15)'}; padding: 1px 4px; border-radius: 4px; font-weight: 700;">${modelTag}</span>
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
                        <span style="font-size: 9px; color: #a5b4fc; font-weight: 700;">${typeBadge}</span>
                    </div>
                    <div style="font-size: 12px; font-weight: 600; line-height: 1.4; color: #f1f5f9; background: rgba(255, 255, 255, 0.04); padding: 7px 9px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.06); max-height: 55px; overflow-y: auto; user-select: text; -webkit-user-select: text;">
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
                        <span>${state.activeType === 'jumble' ? 'Ordered Answer' : 'Recommended Answer'}</span>
                        <div style="display: flex; align-items: center; gap: 4px;">
                            ${state.macroEnabled ? '<span style="font-size: 8px; color: #a7f3d0; background: rgba(16, 185, 129, 0.2); padding: 1px 4px; border-radius: 3px;">Auto-Action</span>' : ''}
                            <span id="kqh-copy-btn" style="font-size: 9px; color: #34d399; background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(16, 185, 129, 0.35); padding: 1px 6px; border-radius: 4px; font-weight: 700; transition: all 0.2s;">📋 Copy</span>
                        </div>
                    </div>
                    <div id="kqh-answer-text" style="font-size: 12px; font-weight: 700; color: #ffffff; line-height: 1.35; word-break: break-word; user-select: text; -webkit-user-select: text;">
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
                        triggerMacroAutoClick(state.lastMatchedIndex, activeChoiceDOMElements);
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
                const textToCopy = (state.orderedSequence && state.orderedSequence.length > 0)
                    ? state.orderedSequence.map((item, idx) => `${idx + 1}. ${item}`).join('\n')
                    : ((state.rawAnswers && state.rawAnswers.length > 0) ? state.rawAnswers[0] : (state.currentAnswer || ''));

                if (!textToCopy || textToCopy.startsWith('Waiting') || textToCopy.startsWith('⚡ Solving') || textToCopy.startsWith('Scoreboard')) {
                    return;
                }

                try {
                    await navigator.clipboard.writeText(textToCopy);
                } catch (err) {
                    try {
                        const temp = document.createElement('textarea');
                        temp.value = textToCopy;
                        const targetParent = document.body || document.documentElement;
                        if (targetParent && targetParent.appendChild) {
                            targetParent.appendChild(temp);
                            temp.select();
                            document.execCommand('copy');
                            if (temp.parentNode) temp.parentNode.removeChild(temp);
                        }
                    } catch (e) {}
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
        checkInitialPageData();
        if (document.body || document.documentElement) {
            renderHUD();
            initDOMWatcher();
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                renderHUD();
                initDOMWatcher();
            }, { once: true });
        }
        console.log(`⚡ KQH AI Engine Active for ${platformName} (0ms Intercept & Multi-Model Solvers Ready)`);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }
})();
