# KQH AI - Minimalist Kahoot Quiz Helper

> Ultra-fast, real-time Kahoot quiz solver powered directly by Google Gemini & OpenAI APIs with auto-answer macro.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-6366f1)
![Chrome](https://img.shields.io/badge/Chrome-Supported-10b981)
![Edge](https://img.shields.io/badge/Edge-Supported-06b6d4)
![Gemini 2.5](https://img.shields.io/badge/Google%20Gemini-2.5%20Flash-blue)

---

## ✨ Features

- **⚡ Zero Latency Network Capture**: Hooks directly into `window.WebSocket` at `document_start` to intercept quiz questions instantly before DOM render.
- **🧠 Direct AI Integration**: Connects directly from the browser to Google Gemini (2.5 Flash, 2.0 Flash) or OpenAI (GPT-4o, GPT-4o Mini).
- **📸 Vision AI Support**: Automatically analyzes image-based quiz questions.
- **🕹️ Auto-Click Macro**: Customizable humanized response delay with randomized jitter.
- **🎨 Minimalist Dark Glass UI**: Modern compact floating HUD with mini-capsule dock mode when minimized.
- **🔒 100% Client-Side & Private**: Your API Key is stored only in your local browser storage.

---

## 🚀 Installation

### Google Chrome & Microsoft Edge

1. Clone or download this repository.
2. Open extension manager:
   - **Chrome**: `chrome://extensions/`
   - **Edge**: `edge://extensions/`
3. Enable **Developer mode** (Chế độ dành cho nhà phát triển).
4. Click **Load unpacked** (Tải phần mở rộng đã giải nén) and select the project folder.
5. Click on the extension icon in the toolbar, select **Google Gemini** or **OpenAI**, enter your API Key, and click **Save & Connect**.
6. Open [kahoot.it](https://kahoot.it/) and enjoy!

---

## 🔑 Getting an API Key

- **Google Gemini (Recommended · Free & Fast)**: [Google AI Studio](https://aistudio.google.com/app/apikey)
- **OpenAI**: [OpenAI Platform](https://platform.openai.com/api-keys)

---

## 🛠️ Project Structure

```
├── manifest.json         # Extension configuration (Manifest V3)
├── background.js         # Background service worker
├── content-bridge.js     # ISOLATED world bridge for Chrome APIs
├── content.js            # MAIN world: WebSocket hook, Direct AI, HUD & Macro
├── popup.html            # Minimalist popup settings UI
├── popup.js              # Settings manager & API verifier
├── icons/                # Extension icons
└── README.md
```
