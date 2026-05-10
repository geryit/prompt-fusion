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
  // Inject prompt text into a textarea/input or contenteditable.
  //
  // We used to type character-by-character with random delays for Cloudflare
  // evasion. But that approach split multi-line prompts (the synthesis meta-
  // prompt) into one message per line, because chat editors interpret each
  // '\n' from insertText as Enter→submit. Switching to ATOMIC injection (one
  // event with the full text) preserves embedded newlines as soft breaks.
  //
  // Logged-in browser-profile sessions don't trigger Cloudflare on a normal
  // paste, so we don't need the typing simulation. If Cloudflare ever flags
  // this, add a real `navigator.clipboard.writeText` + `Cmd/Ctrl+V` keystroke
  // approach in a follow-up.
  async function humanType(element, text) {
    element.focus();
    await new Promise(r => setTimeout(r, 50));

    // Editor-native clear: innerText='' bypasses Lexical/ProseMirror's
    // pipeline and can leave the caret in a broken state. selectAll+delete
    // routes through the editor's own event handlers.
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      element.value = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    }
    await new Promise(r => setTimeout(r, 50));

    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      element.value = text;
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true, data: text, inputType: 'insertFromPaste',
      }));
      return;
    }

    // For contenteditable: dispatch a synthetic paste event with the full
    // text in clipboardData. Lexical, ProseMirror, and rich-textarea all
    // have explicit paste handlers that preserve multi-line text correctly.
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
    await new Promise(r => setTimeout(r, 200));

    // Verify the paste landed; some editors ignore synthetic ClipboardEvents.
    // Fall back to atomic insertText which fires a single beforeinput — still
    // multi-line-safe because there's only one event total.
    if (!element.innerText || element.innerText.length < Math.min(text.length / 2, 20)) {
      document.execCommand('insertText', false, text);
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // Resolves once the provider's stop button has been gone continuously for
  // `postStreamMs` (default 600ms). The stop button is the strongest "stream
  // finished" signal — it's only rendered while tokens are streaming.
  //
  // We do NOT also wait for DOM stability the way an earlier version did:
  // after the stream ends, providers keep injecting UI chrome (copy button,
  // citation chips, related searches, model picker re-render) for several
  // seconds. That kept resetting a `lastChange` timer and caused a 10+ second
  // wait between visible completion and our resolve. Stop-button gone is
  // sufficient; the postStreamMs buffer absorbs brief flashes that happen
  // between markdown render passes.
  function waitForResponseStable({ stopSelector, assistantSelector, timeoutMs = 60000, postStreamMs = 600 }) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let streamEndedAt = null;

      const tick = setInterval(() => {
        if (Date.now() - start > timeoutMs) {
          clearInterval(tick);
          return reject(new Error('Response timeout (60s)'));
        }
        const stopBtn = document.querySelector(stopSelector);
        const turns = document.querySelectorAll(assistantSelector);
        const lastTurn = turns[turns.length - 1];

        if (!stopBtn && lastTurn) {
          if (streamEndedAt === null) {
            streamEndedAt = Date.now();
          } else if (Date.now() - streamEndedAt >= postStreamMs) {
            clearInterval(tick);
            resolve(lastTurn);
          }
        } else {
          // Either still streaming, or the stop button reappeared briefly
          // between render passes. Reset the timer.
          streamEndedAt = null;
        }
      }, 150);
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
