// Background service worker (Manifest V3).
// Orchestrates: open hidden window → spawn provider tabs → collect responses →
// run synthesis tab → return result to popup → tear down window.
//
// MV3 service workers can be evicted after ~30s idle. We keep alive via
// chrome.alarms (a 25s alarm forces wake) for the duration of an in-flight
// fusion request. Cleaned up when the request resolves.
//
// We use importScripts (classic service worker) instead of ES modules so the
// same lib/* files can be loaded by content scripts (which must be classic).
// Both contexts read the helpers from `self.MessageType`, `self.ProviderId`,
// `self.buildSynthesisPrompt`, etc.

importScripts('/lib/messaging.js', '/lib/synthesizer.js');

// In-memory state keyed by reqId. We do not persist this; if the worker dies
// mid-request, the popup will show a timeout error and the user retries.
const inflight = new Map(); // reqId → { windowId, tabIds, prompt, synthesizer, answers, popupPort }

const TIMEOUT_PER_PROVIDER_MS = 60_000;
const TIMEOUT_OVERALL_MS = 120_000;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  port.onMessage.addListener((msg) => {
    if (msg.type === MessageType.FUSION_REQUEST) {
      runFusion(msg, port).catch((err) => {
        port.postMessage({ type: MessageType.FUSION_ERROR, error: err.message });
      });
    }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MessageType.CONTENT_READY) {
    onContentReady(msg);
  } else if (msg.type === MessageType.RESPONSE_READY) {
    onResponseReady(msg);
  }
});

async function runFusion({ prompt, synthesizer }, port) {
  const reqId = crypto.randomUUID();
  startKeepAlive();

  // For Task 5 we only spawn ChatGPT. Tasks 7–9 add Gemini and Claude.
  const providers = [ProviderId.CHATGPT];

  const win = await chrome.windows.create({
    state: 'minimized',
    focused: false,
    url: 'about:blank',
  });

  const tabIds = {};
  for (const provider of providers) {
    const url = ProviderUrl[provider] + `#reqId=${reqId}`;
    const tab = await chrome.tabs.create({ windowId: win.id, url, active: false });
    tabIds[provider] = tab.id;
  }

  const state = {
    windowId: win.id,
    tabIds,
    prompt,
    synthesizer,
    answers: { chatgpt: null, gemini: null, claude: null },
    pending: new Set(providers),
    port,
    overallTimer: null,
  };
  inflight.set(reqId, state);

  state.overallTimer = setTimeout(() => finishWith(reqId, 'overall_timeout'), TIMEOUT_OVERALL_MS);
}

function onContentReady({ provider, reqId }) {
  const state = inflight.get(reqId);
  if (!state) return; // late or unknown
  const tabId = state.tabIds[provider];
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, {
    type: MessageType.INJECT_PROMPT,
    provider,
    prompt: state.prompt,
    reqId,
  });
  // Per-provider timeout.
  setTimeout(() => {
    if (state.pending.has(provider)) {
      state.answers[provider] = null;
      state.pending.delete(provider);
      pushStatus(state, provider, 'fail');
      maybeFinish(reqId);
    }
  }, TIMEOUT_PER_PROVIDER_MS);
}

function onResponseReady({ provider, reqId, answer, error }) {
  const state = inflight.get(reqId);
  if (!state) return;
  if (!state.pending.has(provider)) return; // already timed out
  state.answers[provider] = error ? null : answer;
  if (error) {
    // Stash the error code (e.g. 'cloudflare_challenge') so the popup can show
    // a tailored message rather than a generic "no answer".
    state.errors = state.errors || {};
    state.errors[provider] = error;
  }
  state.pending.delete(provider);
  pushStatus(state, provider, error ? 'fail' : 'ok');
  maybeFinish(reqId);
}

function pushStatus(state, provider, status) {
  try { state.port.postMessage({ type: MessageType.STATUS_UPDATE, provider, status }); } catch (_) {}
}

async function maybeFinish(reqId) {
  const state = inflight.get(reqId);
  if (!state || state.pending.size > 0) return;
  await finishWith(reqId, 'done');
}

async function finishWith(reqId, _reason) {
  const state = inflight.get(reqId);
  if (!state) return;
  clearTimeout(state.overallTimer);
  inflight.delete(reqId);

  // Task 5 short-circuit: no synthesis yet — return the single ChatGPT answer.
  // Task 10 replaces this block with a real synthesis tab.
  const synthesis = state.answers.chatgpt || '(no answer)';
  try {
    state.port.postMessage({
      type: MessageType.FUSION_DONE,
      synthesis,
      raw: state.answers,
    });
  } catch (_) {}

  await chrome.windows.remove(state.windowId).catch(() => {});
  if (inflight.size === 0) stopKeepAlive();
}

// chrome.alarms keep-alive: prevents the service worker from being evicted
// while a fusion is in flight. The handler is a no-op; just receiving an
// alarm event is enough to reset the eviction timer.
function startKeepAlive() {
  chrome.alarms.create('pf-keepalive', { periodInMinutes: 0.4 }); // 24s
}
function stopKeepAlive() {
  chrome.alarms.clear('pf-keepalive');
}
chrome.alarms.onAlarm.addListener(() => {});
