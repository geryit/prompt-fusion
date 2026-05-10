// Gemini (gemini.google.com) content script. Mirrors providers/chatgpt.js
// structure with provider-specific differences:
// - Send button often has aria-label "Send" or class .send-button.
// - Stop button uses aria-label "Stop response".
// - Response container is <model-response> custom element.

(function () {
  const PROVIDER = 'gemini';
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

      // Gemini's send button is sometimes disabled until the input registers.
      // Retry a couple of times before falling back to Enter.
      let sent = false;
      for (let i = 0; i < 3 && !sent; i++) {
        const sendBtn = document.querySelector(sel.sendButton);
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          sent = true;
        } else {
          await new Promise(r => setTimeout(r, 300));
        }
      }
      if (!sent) {
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
