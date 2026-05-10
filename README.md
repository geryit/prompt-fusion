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

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| One provider chip stays ⏳ for 60s then ✗ | DOM selector outdated | Update `lib/selectors.js` for that provider |
| Provider chip ✗ within ~5s, raw says "Not logged in" | Profile is logged out | Click the link, sign in, retry |
| All chips ✗ | Network down, or all 3 selectors broke | Check `chrome://extensions` service-worker console |
| Synthesis text identical to one raw answer | Synthesis provider returned its own raw — meta-prompt may not have rendered fully | Increase `stableForMs` in `providers/base.js` |

## Before / After

| Subject | Before | After |
|---|---|---|
| Asking a hard question | Open 3 tabs, paste prompt 3 times, manually compare | One click, one popup, synthesized answer |
| Catching outliers | Read each tab's answer in full | Synthesis surfaces consensus + flags contradictions |
