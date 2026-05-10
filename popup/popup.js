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
      els.synthesis.textContent = msg.synthesis;
      els.rawChatgpt.textContent = msg.raw.chatgpt || '(no answer)';
      els.rawGemini.textContent = msg.raw.gemini || '(no answer)';
      els.rawClaude.textContent = msg.raw.claude || '(no answer)';
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
