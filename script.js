/* ========= CONFIG ========= */
const DIRECT_ENDPOINT = "https://api.s5.com/player/api/v1/otp/request";
const USE_CORS_PROXY = true; // set false to try direct
const CORS_PROXY = "https://corsproxy.io/?url="; // using ?url= pattern
const API_KEY = "d6a6d988-e73e-4402-8e52-6df554cbfb35"; // visible in browser (testing only)
const MAX_ALLOWED = 2;            // safety cap (1–2)
const FETCH_TIMEOUT_MS = 15000;   // 15s

/* ========= DOM ========= */
const toggleButton = document.getElementById("toggleButton");
const responseConsole = document.getElementById("response-console");
const phoneNumberInput = document.getElementById("phoneNumberInput");
const amountInput = document.getElementById("amountInput");
const delayInput = document.getElementById("delayInput");

/* ========= STATE ========= */
let isRunning = false;
let aborter = null;

/* ========= PERF: batched logger ========= */
let logQueue = [];
let rafId = null;
function flushLogs() {
  if (!logQueue.length) { rafId = null; return; }
  const chunk = logQueue.join("\n");
  responseConsole.textContent += (responseConsole.textContent ? "\n" : "") + chunk;
  responseConsole.scrollTop = responseConsole.scrollHeight;
  logQueue.length = 0; rafId = null;
}
function logToConsole(message, clearPrevious = false) {
  if (clearPrevious) {
    responseConsole.textContent = message;
    responseConsole.scrollTop = responseConsole.scrollHeight;
    logQueue.length = 0; if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    return;
  }
  logQueue.push(message);
  if (!rafId) rafId = requestAnimationFrame(flushLogs);
}

/* ========= HELPERS ========= */
function normalizePH(local) {
  let n = String(local || "").replace(/\D/g, "");
  if (n.startsWith("0")) n = n.slice(1);
  return `+63${n}`;
}
function delay(ms, signal){
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => {
      clearTimeout(id); reject(new DOMException("Aborted","AbortError"));
    }, { once:true });
  });
}
const buildUrl = () => USE_CORS_PROXY
  ? `${CORS_PROXY}${encodeURIComponent(DIRECT_ENDPOINT)}`
  : DIRECT_ENDPOINT;

// Single POST with timeout + abort (through proxy if enabled)
async function sendOnce({ phone, signal }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once:true });

  try {
    const res = await fetch(buildUrl(), {
      method: "POST",
      mode: "cors",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "X-Timezone-Offset": "480",
        "x-public-api-key": API_KEY,  // visible in client; testing only
        "x-api-type": "external",
        "Accept-Language": "en",
        "x-locale": "en"
      },
      body: JSON.stringify({ phone_number: phone }),
      signal: controller.signal
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timeout);
  }
}

// Retry transient fetch failures with backoff
async function safeSendWithRetry({ phone, signal, maxAttempts = 3 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await sendOnce({ phone, signal });
      return { ...r, attempt };
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt === maxAttempts) throw e;
      const base = 500 * Math.pow(2, attempt - 1); // 500, 1000
      const jitter = Math.floor(Math.random() * 250);
      await delay(base + jitter, signal);
    }
  }
}

function setRunningUI(running) {
  toggleButton.textContent = running ? "STOP" : "START";
  toggleButton.classList.toggle("stop-mode", running);
  toggleButton.classList.toggle("start-mode", !running);
  [phoneNumberInput, amountInput, delayInput].forEach(el => el && (el.disabled = running));
}

/* ========= MAIN ========= */
toggleButton.addEventListener("click", async (e) => {
  e.preventDefault();

  if (isRunning) {
    aborter?.abort();
    isRunning = false;
    setRunningUI(false);
    logToConsole("STATUS: Cancelled by user.");
    return;
  }

  const rawPhone = phoneNumberInput.value.trim();
  const digits = rawPhone.replace(/\D/g, "");
  if (digits.length < 7) {
    logToConsole("ERROR: Phone number invalid.", true);
    return;
  }
  let count = parseInt(amountInput.value || "1", 10);
  if (Number.isNaN(count) || count < 1) {
    logToConsole("ERROR: Amount invalid.", true);
    return;
  }
  let delaySec = parseInt(delayInput.value || "3", 10);
  if (Number.isNaN(delaySec) || delaySec < 1) {
    logToConsole("ERROR: Delay invalid.", true);
    return;
  }

  const toSend = Math.min(Math.max(1, count), MAX_ALLOWED);
  const phone = normalizePH(rawPhone);

  isRunning = true;
  aborter = new AbortController();
  setRunningUI(true);

  logToConsole("SEQUENCE INITIATED.", true);
  if (toSend !== count) logToConsole(`NOTE: amount clipped to safe maximum of ${MAX_ALLOWED}.`);
  logToConsole(`TARGET: ${phone}`);
  logToConsole(`A: ${toSend} | D: ${delaySec}s`);
  logToConsole(`ROUTE: ${USE_CORS_PROXY ? "corsproxy.io" : "direct"}`);
  logToConsole("STATUS: RUNNING...");

  try {
    for (let i = 1; i <= toSend; i++) {
      if (aborter.signal.aborted) throw new Error("Cancelled");

      logToConsole(`\n[${i}/${toSend}] Sending (up to 3 attempts)...`);
      try {
        const res = await safeSendWithRetry({ phone, signal: aborter.signal, maxAttempts: 3 });
        logToConsole(`[${i}/${toSend}] ${res.ok ? "Success" : "Failed"} (${res.status}) on attempt ${res.attempt}`);
        logToConsole(`Response: ${String(res.text).slice(0, 200)}...`);
      } catch (err) {
        logToConsole(`[${i}/${toSend}] ERROR: ${err?.message || err}`);
      }

      if (i !== toSend) {
        await delay(delaySec * 1000, aborter.signal);
      }
    }
  } catch (err) {
    logToConsole(`Run stopped: ${err?.message || err}`);
  } finally {
    isRunning = false;
    setRunningUI(false);
    logToConsole("STATUS: Ready.");
  }
});

// Init
window.addEventListener("DOMContentLoaded", () => {
  toggleButton.classList.add("start-mode");
  logToConsole("SYSTEM: Ready.", true);
});
