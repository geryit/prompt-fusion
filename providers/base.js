// Shared helpers for content scripts. Loaded BEFORE the per-provider script
// (see manifest.json content_scripts order).
//
// Why these helpers exist here, not inline in each provider:
// - waitForElement: providers load progressively; the textarea may not be in the DOM
//   for a few hundred ms after navigation.
// - humanType: pasting via .value = '...' often fails to trigger the React state
//   update that enables the send button. Dispatching real input events with small
//   delays mimics a human typist and reliably enables the send path.
// - waitForResponseStable: streaming answers append text; we need a stable
//   "done" signal — the provider-specific stop button disappearing — plus a
//   2-second buffer so trailing markdown/code-fence formatting fully renders
//   before we read it.

(function () {
  const TIMEOUT_DEFAULT = 30000;

  function waitForElement(selector, timeoutMs = TIMEOUT_DEFAULT) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for selector: ${selector}`));
      }, timeoutMs);
    });
  }

  // Type characters one-by-one with random 30-100ms delays, dispatching the
  // input events React needs to register state. Works for both <textarea> and
  // contenteditable. We DO NOT use clipboard APIs (cross-origin risk).
  async function humanType(element, text) {
    element.focus();

    // Clear any existing content first — providers sometimes pre-fill placeholders
    // that aren't placeholders but real text nodes.
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      element.value = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Clear contenteditable AND fire input so framework state (ProseMirror,
      // Lexical) registers the empty value before we start typing characters.
      element.innerText = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
        element.value += ch;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      } else if (ch === '\n') {
        // Critical: do NOT insert '\n' via insertText into chat-editor
        // contenteditables (ChatGPT/Lexical, Gemini/rich-textarea). Their
        // beforeinput handlers treat '\n' as Enter→submit, which sliced the
        // multi-line synthesis meta-prompt into one-line submissions. <br>
        // via insertHTML is treated as a soft break (Shift+Enter equivalent).
        document.execCommand('insertHTML', false, '<br>');
      } else {
        // contenteditable path: use execCommand fallback for the React editors that
        // ChatGPT and Claude use (ProseMirror, Lexical). execCommand is deprecated
        // but still the most reliable cross-editor way to insert text that triggers
        // the framework's onChange handlers.
        document.execCommand('insertText', false, ch);
        if (i === 0) {
          // Gemini's rich-textarea (and some other rich editors) swallow the
          // first synthetic insertText while dismissing their placeholder,
          // dropping the first letter of the prompt. Verify after a short
          // settle and retype once if nothing landed.
          await new Promise(r => setTimeout(r, 30));
          if (!element.innerText) {
            document.execCommand('insertText', false, ch);
          }
        }
      }
      // 30-100ms randomized delay → ~5-8 chars/sec, reads as human typing.
      await new Promise(r => setTimeout(r, 30 + Math.random() * 70));
    }
  }

  // Resolves when (a) the provider's stop button has disappeared and (b) the
  // assistant turn DOM has been stable for `stableForMs` (default 2000ms).
  // This double-check matters because some providers briefly hide the stop
  // button between markdown render passes.
  function waitForResponseStable({ stopSelector, assistantSelector, timeoutMs = 60000, stableForMs = 2000 }) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastChange = Date.now();
      let lastHtml = '';

      const tick = setInterval(() => {
        if (Date.now() - start > timeoutMs) {
          clearInterval(tick);
          return reject(new Error('Response timeout (60s)'));
        }
        const stopBtn = document.querySelector(stopSelector);
        const turns = document.querySelectorAll(assistantSelector);
        const lastTurn = turns[turns.length - 1];
        const currentHtml = lastTurn ? lastTurn.innerHTML : '';

        if (currentHtml !== lastHtml) {
          lastHtml = currentHtml;
          lastChange = Date.now();
        }
        // Done when stop button is gone AND content has been stable.
        if (!stopBtn && lastTurn && Date.now() - lastChange > stableForMs) {
          clearInterval(tick);
          resolve(lastTurn);
        }
      }, 250);
    });
  }

  // Cheap Cloudflare check — both providers gate on a "Just a moment" interstitial.
  function looksLikeCloudflareChallenge() {
    const t = document.title || '';
    return t.includes('Just a moment') || !!document.getElementById('challenge-running');
  }

  // Extract markdown-ish text from an assistant turn. We prefer innerText (preserves
  // line breaks and code blocks reasonably) over textContent (collapses whitespace).
  function extractAnswerText(turnElement) {
    if (!turnElement) return '';
    return turnElement.innerText.trim();
  }

  self.PromptFusionBase = {
    waitForElement,
    humanType,
    waitForResponseStable,
    looksLikeCloudflareChallenge,
    extractAnswerText,
  };
})();
