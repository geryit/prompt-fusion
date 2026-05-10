// ChatGPT (chatgpt.com) content script.
// Loaded after lib/selectors.js and providers/base.js (manifest order).
//
// Lifecycle:
// 1. On load → notify background we're ready.
// 2. On INJECT_PROMPT message → type prompt, submit, wait for done, send back the answer.

(function () {
  const PROVIDER = 'chatgpt';
  const sel = self.Selectors[PROVIDER];
  const { waitForElement, humanType, waitForResponseStable, looksLikeCloudflareChallenge, extractAnswerText } = self.PromptFusionBase;

  // Tell background we're alive and listening, including the reqId (background
  // sets this in the URL hash before opening the tab so we can correlate).
  function announceReady() {
    const reqId = (location.hash.match(/reqId=([^&]+)/) || [])[1];
    if (!reqId) return; // not opened by us — just a normal user visit
    chrome.runtime.sendMessage({ type: 'CONTENT_READY', provider: PROVIDER, reqId });
  }

  async function handleInject(prompt, reqId) {
    try {
      if (looksLikeCloudflareChallenge()) {
        return reply(reqId, { error: 'cloudflare_challenge' });
      }

      const input = await waitForElement(sel.promptInput, 15000);
      await humanType(input, prompt);

      // Click the send button; if it's not present yet, fall back to Enter.
      const sendBtn = document.querySelector(sel.sendButton);
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      }

      const turn = await waitForResponseStable({
        stopSelector: sel.stopButton,
        assistantSelector: sel.assistantTurn,
        timeoutMs: 60000,
        stableForMs: 2000,
      });

      reply(reqId, { answer: extractAnswerText(turn) });
    } catch (e) {
      reply(reqId, { error: e.message || String(e) });
    }
  }

  function reply(reqId, payload) {
    chrome.runtime.sendMessage({ type: 'RESPONSE_READY', provider: PROVIDER, reqId, ...payload });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (msg.type === 'INJECT_PROMPT' && msg.provider === PROVIDER) {
      handleInject(msg.prompt, msg.reqId);
    }
    // We don't return true here — replies go via sendMessage, not sendResponse.
  });

  announceReady();
})();
