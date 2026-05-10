// Message types exchanged between popup, background, and content scripts.
// Centralized so a typo in one place fails at the dispatcher, not silently.
const MessageType = Object.freeze({
  // popup → background: kick off a fusion request
  FUSION_REQUEST: 'FUSION_REQUEST',
  // content → background: content script is loaded and ready to receive INJECT_PROMPT
  CONTENT_READY: 'CONTENT_READY',
  // background → content: deliver the prompt and request id
  INJECT_PROMPT: 'INJECT_PROMPT',
  // content → background: provider answered (or errored)
  RESPONSE_READY: 'RESPONSE_READY',
  // background → popup: per-provider status updates (chip ⏳/✓/✗)
  STATUS_UPDATE: 'STATUS_UPDATE',
  // background → popup: final synthesized + raw payload
  FUSION_DONE: 'FUSION_DONE',
  // background → popup: terminal failure (all providers failed)
  FUSION_ERROR: 'FUSION_ERROR',
});

const ProviderId = Object.freeze({
  CHATGPT: 'chatgpt',
  GEMINI: 'gemini',
  CLAUDE: 'claude',
});

const ProviderUrl = Object.freeze({
  // /?temporary-chat=true forces a fresh, history-free conversation per request
  // so prior chats don't leak into the answer.
  [ProviderId.CHATGPT]: 'https://chatgpt.com/?temporary-chat=true',
  [ProviderId.GEMINI]: 'https://gemini.google.com/app',
  [ProviderId.CLAUDE]: 'https://claude.ai/new',
});

// Make available to both module (background) and classic-script (content) contexts.
if (typeof self !== 'undefined') {
  self.MessageType = MessageType;
  self.ProviderId = ProviderId;
  self.ProviderUrl = ProviderUrl;
}
