// Claude (claude.ai) content script. Differences vs ChatGPT/Gemini:
// - Editor is ProseMirror-based; humanType's execCommand path handles it.
// - Send button aria-label is "Send Message" (capital M).
// - The data-is-streaming attribute on the message div flips off when done —
//   a stronger done signal than just the stop button. We rely on stopButton
//   too because data-is-streaming sometimes lingers briefly.

(function () {
  const PROVIDER = 'claude';
  const sel = self.Selectors[PROVIDER];
  const { waitForElement, humanType, waitForResponseStable, looksLikeCloudflareChallenge, extractAnswerText } = self.PromptFusionBase;

  function announceReady() {
    const reqId = (location.hash.match(/reqId=([^&]+)/) || [])[1];
    if (!reqId) return;
    chrome.runtime.sendMessage({ type: 'CONTENT_READY', provider: PROVIDER, reqId });
  }

  async function handleInject(prompt, reqId) {
    try {
      if (looksLikeCloudflareChallenge()) {
        return reply(reqId, { error: 'cloudflare_challenge' });
      }

      const input = await waitForElement(sel.promptInput, 15000);
      await humanType(input, prompt);

      const sendBtn = document.querySelector(sel.sendButton);
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        // Claude's ProseMirror responds to Enter when the input is focused.
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      }

      const turn = await waitForResponseStable({
        stopSelector: sel.stopButton,
        assistantSelector: sel.assistantTurn,
        timeoutMs: 60000,
      });
      reply(reqId, { answer: extractAnswerText(turn) });
    } catch (e) {
      reply(reqId, { error: e.message || String(e) });
    }
  }

  function reply(reqId, payload) {
    chrome.runtime.sendMessage({ type: 'RESPONSE_READY', provider: PROVIDER, reqId, ...payload });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'INJECT_PROMPT' && msg.provider === PROVIDER) {
      handleInject(msg.prompt, msg.reqId);
    }
  });

  announceReady();
})();
