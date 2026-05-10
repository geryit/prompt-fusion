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

  // Resolves when the assistant response has stopped changing. Uses THREE
  // independent signals — whichever fires first wins:
  //
  //   1) stopBased: stop button gone continuously for `postStreamMs` (400ms),
  //      AND visible text non-empty. Strongest signal — fastest resolve.
  //   2) textBasedFast: stop button gone AND visible text unchanged for
  //      `stableTextMs` (1500ms). Slightly slower than (1) but covers cases
  //      where the stop button blinks back briefly post-stream.
  //   3) textBasedSafetyNet: visible text unchanged for 5s, regardless of
  //      stop-button state. Covers the case where the streaming indicator
  //      never clears at all — observed in both providers in the wild
  //      (Gemini keeps the stop button mounted while citation/rating UI
  //      loads; Claude leaves [data-is-streaming] set while follow-up
  //      suggestions generate). Without (3) the chip would sit at ⏳ until
  //      the 60s per-provider timeout, even though the answer was on screen
  //      in seconds. The 5s window is long enough that Claude's mid-
  //      response tool-use pause (1-3s of trace text shown before the real
  //      answer streams) won't trigger it prematurely.
  //
  // We compare innerText (visible text) rather than innerHTML so UI chrome
  // that gets injected post-stream (copy buttons, citation chips, related
  // searches) doesn't keep resetting the stability timer.
  function waitForResponseStable({ stopSelector, assistantSelector, timeoutMs = 60000, postStreamMs = 400, stableTextMs = 1500, safetyNetMs = 5000 }) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let stopGoneAt = null;
      let lastText = '';
      let textChangedAt = Date.now();

      const tick = setInterval(() => {
        if (Date.now() - start > timeoutMs) {
          clearInterval(tick);
          return reject(new Error('Response timeout (60s)'));
        }
        const stopBtn = document.querySelector(stopSelector);
        const turns = document.querySelectorAll(assistantSelector);
        const lastTurn = turns[turns.length - 1];
        if (!lastTurn) return; // assistant turn not in DOM yet

        // Claude's extended-thinking phase fills the response container with
        // just "Thinking" (sometimes repeated). Treat that as not-yet-ready
        // so we don't resolve while only the thinking indicator is on screen
        // and capture "Thinking…" as the answer. The actual response always
        // contains more than this single status word.
        const rawText = lastTurn.innerText || '';
        const looksLikeThinkingOnly = /^\s*(Thinking[.…\s]*)+$/i.test(rawText);
        const currentText = looksLikeThinkingOnly ? '' : rawText;
        if (currentText !== lastText) {
          lastText = currentText;
          textChangedAt = Date.now();
        }

        if (!stopBtn) {
          if (stopGoneAt === null) stopGoneAt = Date.now();
        } else {
          stopGoneAt = null;
        }

        // All three signals require non-empty text — protects against
        // resolving on a transitional empty assistant turn (between
        // "thinking" and streamed response), which would silently drop the
        // real answer because buildSynthesisPrompt skips falsy entries.
        // The stopGone gate on (1) and (2) blocks Claude's "Thinking…" phase
        // from triggering them prematurely; (3) deliberately omits the gate
        // and instead relies on the longer 5s stability window — see the
        // function-level comment for the trade-off rationale.
        const hasText = lastText.length > 0;
        const stopGone = stopGoneAt !== null;
        const stopBased = hasText && stopGone && Date.now() - stopGoneAt >= postStreamMs;
        const textBasedFast = hasText && stopGone && Date.now() - textChangedAt >= stableTextMs;
        const textBasedSafetyNet = hasText && Date.now() - textChangedAt >= safetyNetMs;
        if (stopBased || textBasedFast || textBasedSafetyNet) {
          clearInterval(tick);
          resolve(lastTurn);
        }
      }, 150);
    });
  }

  // Cheap Cloudflare check — both providers gate on a "Just a moment" interstitial.
  function looksLikeCloudflareChallenge() {
    const t = document.title || '';
    return t.includes('Just a moment') || !!document.getElementById('challenge-running');
  }

  // Extract markdown-ish text from an assistant turn. innerText preserves line
  // breaks and code blocks reasonably, but returns '' when the element is
  // hidden mid-transition — fall back to textContent (collapses whitespace
  // but always returns text) in that case so we don't silently drop a real
  // answer for being briefly invisible at read time.
  function extractAnswerText(turnElement) {
    if (!turnElement) return '';
    const txt = turnElement.innerText || turnElement.textContent || '';
    return txt.trim();
  }

  self.PromptFusionBase = {
    waitForElement,
    humanType,
    waitForResponseStable,
    looksLikeCloudflareChallenge,
    extractAnswerText,
  };
})();
