// Single source of truth for provider DOM selectors.
// When a provider rewrites its UI, update only this file — no other change needed.
// Each provider exposes the same shape so providers/base.js can use them generically.
const Selectors = Object.freeze({
  chatgpt: {
    // Prompt input is a contenteditable, not a real <textarea>.
    promptInput: '#prompt-textarea',
    // Send button (when present); we also support pressing Enter as a fallback.
    sendButton: '[data-testid="send-button"], button[data-testid="composer-send-button"]',
    // While streaming, a "Stop generating" button is shown. Its disappearance is our "done" signal.
    stopButton: '[data-testid="stop-button"], button[aria-label="Stop streaming"]',
    // Latest assistant turn — we read the last match after streaming completes.
    assistantTurn: '[data-message-author-role="assistant"]',
    // Cloudflare interstitial check — title or visible text.
    cloudflareMarker: 'title:contains("Just a moment"), #challenge-running',
  },
  gemini: {
    promptInput: 'rich-textarea div[contenteditable="true"]',
    sendButton: 'button[aria-label*="Send" i], button.send-button',
    stopButton: 'button[aria-label*="Stop" i]',
    // Each model response is wrapped in a model-response message-content.
    assistantTurn: 'model-response message-content, .model-response-text',
    cloudflareMarker: '#challenge-running',
  },
  claude: {
    promptInput: 'div[contenteditable="true"].ProseMirror',
    sendButton: 'button[aria-label="Send Message"], button[aria-label="Send message"]',
    stopButton: 'button[aria-label="Stop response"], button[aria-label="Stop generating"]',
    // claude.ai uses data-test-render-count; latest streamed message is the last one.
    assistantTurn: 'div[data-is-streaming], .font-claude-message',
    cloudflareMarker: '#challenge-running',
  },
});

if (typeof self !== 'undefined') {
  self.Selectors = Selectors;
}
