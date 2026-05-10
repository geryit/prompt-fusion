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

// Heuristic: if the loaded URL no longer matches the provider's host or
// contains common login-path markers, the user is logged out. We treat
// that as a clean fail (chip ✗) rather than waiting for the 60s timeout.
const LOGGED_OUT_MARKERS = {
  [ProviderId.CHATGPT]: ['/auth/login', 'auth0.openai.com', '/login'],
  [ProviderId.GEMINI]: ['accounts.google.com', '/ServiceLogin'],
  [ProviderId.CLAUDE]: ['/login', '/auth/login'],
};

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

// Watch tabs we created. If they redirect to a login URL, mark that provider
// failed immediately so the user sees the chip flip ✗ in seconds, not 60s.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete' || !info.url) return;
  for (const [reqId, state] of inflight.entries()) {
    for (const [provider, id] of Object.entries(state.tabIds)) {
      if (id !== tabId) continue;
      const markers = LOGGED_OUT_MARKERS[provider] || [];
      if (markers.some((m) => info.url.includes(m))) {
        if (state.pending.has(provider)) {
          state.answers[provider] = null;
          state.pending.delete(provider);
          pushStatus(state, provider, 'fail');
          // Stash a per-provider error code so the popup can show "log in to X".
          state.errors = state.errors || {};
          state.errors[provider] = 'logged_out';
          maybeFinish(reqId);
        }
      }
    }
  }
});

async function runFusion({ prompt, synthesizer }, port) {
  const reqId = crypto.randomUUID();
  startKeepAlive();

  // All three providers fire in parallel. Each has its own per-tab content
  // script that announces CONTENT_READY when it loads, at which point we
  // dispatch INJECT_PROMPT to that tab specifically.
  const providers = [ProviderId.CHATGPT, ProviderId.GEMINI, ProviderId.CLAUDE];

  // Record the user's main browsing window so the synthesis tab can be opened
  // there visibly at the end. `windowTypes: ['normal']` filters out the
  // toolbar popup's own window, returning the actual Chrome browser window
  // the user is using.
  const userWin = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const userWindowId = userWin ? userWin.id : null;

  const win = await chrome.windows.create({
    state: 'minimized',
    focused: false,
    url: 'about:blank',
  });

  // Register state BEFORE creating tabs. A fast-loading tab can fire
  // CONTENT_READY mid-await; the message handler then needs to find this
  // request via inflight.get(reqId).
  const state = {
    windowId: win.id,
    userWindowId,
    tabIds: {},
    prompt,
    synthesizer,
    answers: { chatgpt: null, gemini: null, claude: null },
    pending: new Set(providers),
    port,
    overallTimer: null,
    providerTimers: {}, // per-provider setTimeout handles, cleared on response/finish
  };
  inflight.set(reqId, state);

  // NOTE: we deliberately do NOT teardown on port.onDisconnect. Chrome popups
  // auto-close the instant focus shifts — and chrome.windows.create steals
  // focus on macOS even with focused:false. Treating that as "user cancelled"
  // would kill every fusion within ~3s. Orphans are caught by the 120s
  // overall timeout instead. The downside: a fusion the user explicitly
  // cancels still runs to completion in the background, but the user can
  // just close the minimized window manually.

  for (const provider of providers) {
    const url = ProviderUrl[provider] + `#reqId=${reqId}`;
    const tab = await chrome.tabs.create({ windowId: win.id, url, active: false });
    state.tabIds[provider] = tab.id;
  }

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
  // Per-provider timeout. Stored on state so onResponseReady/finishWith can
  // cancel it once the answer arrives — otherwise the callback would still
  // fire and double-decrement the pending set (harmless but messy).
  state.providerTimers[provider] = setTimeout(() => {
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
  // Cancel the per-provider timeout — answer arrived in time.
  if (state.providerTimers[provider]) {
    clearTimeout(state.providerTimers[provider]);
    state.providerTimers[provider] = null;
  }
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
  // Cancel any still-pending per-provider timeouts.
  for (const t of Object.values(state.providerTimers || {})) {
    if (t) clearTimeout(t);
  }

  const haveAny = Object.values(state.answers).some(Boolean);

  if (!haveAny) {
    const errPayload = { type: MessageType.FUSION_ERROR, error: 'All providers failed.' };
    chrome.storage.local.set({ lastResult: { ...errPayload, prompt: state.prompt, timestamp: Date.now() } });
    try { state.port.postMessage(errPayload); } catch (_) {}
    inflight.delete(reqId);
    await chrome.windows.remove(state.windowId).catch(() => {});
    if (inflight.size === 0) stopKeepAlive();
    return;
  }

  // Open the synthesis tab visibly in the user's main browsing window. We
  // intentionally do NOT scrape the synthesis answer back into the popup —
  // the user reads it natively in the provider's own UI (better markdown
  // rendering, can follow up, etc.). We open before closing the minimized
  // window so the user always has something visible to land on.
  await openSynthesisTab(state);
  await chrome.windows.remove(state.windowId).catch(() => {});

  inflight.delete(reqId);
  if (inflight.size === 0) stopKeepAlive();
}

// Opens the synthesis tab in the user's main browsing window (or a new
// normal window if none exists), injects the meta-prompt on CONTENT_READY,
// and returns. We do NOT wait for or capture the response — the user sees
// the synthesis stream live in the tab.
async function openSynthesisTab(state) {
  const synthReqId = crypto.randomUUID() + '-synth';
  const provider = state.synthesizer;
  const url = ProviderUrl[provider] + `#reqId=${synthReqId}`;

  let tab;
  if (state.userWindowId != null) {
    tab = await chrome.tabs.create({ windowId: state.userWindowId, url, active: true });
    // Bring the user's window forward in case it was behind another app.
    chrome.windows.update(state.userWindowId, { focused: true }).catch(() => {});
  } else {
    // No existing normal window — create a new visible one for the synthesis.
    const newWin = await chrome.windows.create({ url, focused: true }).catch(() => null);
    tab = newWin && newWin.tabs && newWin.tabs[0];
    if (!tab) return; // best-effort; nothing else to do
  }

  const metaPrompt = buildSynthesisPrompt(state.prompt, state.answers);

  let injected = false;
  function listener(msg) {
    if (injected) return;
    if (msg.type === MessageType.CONTENT_READY && msg.reqId === synthReqId && msg.provider === provider) {
      injected = true;
      chrome.runtime.onMessage.removeListener(listener);
      chrome.tabs.sendMessage(tab.id, {
        type: MessageType.INJECT_PROMPT,
        provider,
        prompt: metaPrompt,
        reqId: synthReqId,
      });
    }
  }
  chrome.runtime.onMessage.addListener(listener);
  // Safety: drop the listener after 60s if the page never loads (logged-out
  // redirect, network failure). The user will see whatever the page shows.
  setTimeout(() => {
    if (!injected) chrome.runtime.onMessage.removeListener(listener);
  }, 60_000);

  // Best-effort notice to the popup so it doesn't hang on "loading" state
  // if it somehow stayed open. The popup is normally already closed by now
  // (Chrome closes it on focus-shift) — this message is silently dropped.
  try {
    state.port.postMessage({ type: MessageType.FUSION_DONE, synthesisInTab: true });
  } catch (_) {}
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
