# Prompt Fusion

Chrome extension that sends a single prompt to ChatGPT, Gemini, and Claude in parallel using your browser-profile sessions, then synthesizes the three answers into one.

## Install (development)

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select this folder

## Usage

- Click the toolbar icon
- Type your prompt
- Pick a synthesizer (default: ChatGPT)
- Submit
- A minimized window opens with 3 provider tabs. Answers are collected, then synthesized in a 4th tab. Result appears in the popup.

## Requirements

- Logged in to chatgpt.com, gemini.google.com, claude.ai in this Chrome profile.

## Limitations

- DOM selectors break when providers change their UI. See `lib/selectors.js` for the central place to update.
- Cloudflare may flag automated input; the extension uses humanized typing delays to mitigate.
