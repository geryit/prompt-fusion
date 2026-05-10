// Popup glue: collects user input, opens a long-lived port to the background,
// streams status updates into chips, and renders the final synthesis.
//
// We use a Port (chrome.runtime.connect) instead of one-shot sendMessage so the
// background can push multiple STATUS_UPDATE messages back during the request
// without us having to poll.

const $ = (q) => document.querySelector(q);
const els = {
  prompt: $('#prompt'),
  submit: $('#submit'),
  status: $('#status'),
  result: $('#result'),
  synthesis: $('#synthesis'),
  copy: $('#copy'),
  error: $('#error'),
  rawChatgpt: $('#raw-chatgpt'),
  rawGemini: $('#raw-gemini'),
  rawClaude: $('#raw-claude'),
  segs: document.querySelectorAll('#synth-selector .seg'),
};

let synthesizer = 'chatgpt';

// Restore last-used synthesizer from storage so the user's choice sticks.
chrome.storage.local.get('synthesizer').then(({ synthesizer: s }) => {
  if (s) selectSynthesizer(s);
});

els.segs.forEach((b) => b.addEventListener('click', () => selectSynthesizer(b.dataset.value)));

function selectSynthesizer(value) {
  synthesizer = value;
  els.segs.forEach((b) => {
    const active = b.dataset.value === value;
    b.classList.toggle('active', active);
    b.setAttribute('aria-checked', String(active));
  });
  chrome.storage.local.set({ synthesizer: value });
}

els.submit.addEventListener('click', submit);
els.prompt.addEventListener('keydown', (e) => {
  // Cmd/Ctrl+Enter submits — matches user expectation from chat UIs.
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
});

els.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(els.synthesis.textContent);
  els.copy.textContent = 'Copied ✓';
  setTimeout(() => (els.copy.textContent = 'Copy synthesis'), 1200);
});

function submit() {
  const prompt = els.prompt.value.trim();
  if (!prompt) return;

  els.submit.disabled = true;
  els.error.hidden = true;
  els.result.hidden = true;
  els.status.hidden = false;
  // Reset chips
  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.remove('ok', 'fail');
    c.querySelector('.dot').textContent = '⏳';
  });

  const port = chrome.runtime.connect({ name: 'popup' });
  port.postMessage({ type: 'FUSION_REQUEST', prompt, synthesizer });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'STATUS_UPDATE') {
      const chip = document.querySelector(`.chip[data-provider="${msg.provider}"]`);
      if (chip) {
        chip.classList.toggle('ok', msg.status === 'ok');
        chip.classList.toggle('fail', msg.status === 'fail');
        chip.querySelector('.dot').textContent = msg.status === 'ok' ? '✓' : '✗';
      }
    } else if (msg.type === 'FUSION_DONE') {
      // marked.parse returns HTML. Provider answers are user-trusted (you ran
      // them from your own logged-in profile) so XSS risk is low, but we still
      // strip <script> and on* attributes via a tiny sanitizer below.
      els.synthesis.innerHTML = renderMarkdown(msg.synthesis);
      els.rawChatgpt.innerHTML = renderMarkdown(msg.raw.chatgpt || '_(no answer)_');
      els.rawGemini.innerHTML = renderMarkdown(msg.raw.gemini || '_(no answer)_');
      els.rawClaude.innerHTML = renderMarkdown(msg.raw.claude || '_(no answer)_');
      els.result.hidden = false;
      els.submit.disabled = false;
    } else if (msg.type === 'FUSION_ERROR') {
      els.error.textContent = msg.error || 'Something went wrong.';
      els.error.hidden = false;
      els.submit.disabled = false;
    }
  });
  port.onDisconnect.addListener(() => {
    els.submit.disabled = false;
  });
}

// Minimal sanitizer: drop <script> tags and on* event-handler attributes.
// Sufficient given the trust boundary (your own logged-in providers' output).
// If you ever expose this to untrusted input, swap in DOMPurify.
function renderMarkdown(md) {
  if (!md) return '';
  const html = marked.parse(md, { mangle: false, headerIds: false });
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  tmp.querySelectorAll('script').forEach((n) => n.remove());
  tmp.querySelectorAll('*').forEach((n) => {
    [...n.attributes].forEach((a) => {
      if (a.name.startsWith('on')) n.removeAttribute(a.name);
    });
  });
  return tmp.innerHTML;
}
