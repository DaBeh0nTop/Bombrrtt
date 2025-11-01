<script>
/* Combined / wired client script
   - Uses your existing DOM refs and logToConsole()
   - Safety cap MAX_ALLOWED = 2 (change if you want)
   - Sends requests sequentially to BACKEND_ENDPOINT (server must exist)
   - STOP cancels in-flight work
   - Retries on transient errors (up to 3 attempts) with exponential backoff
*/

const BACKEND_ENDPOINT = "/otp/send-once"; // server route (your server should proxy the real OTP call)
const MAX_ALLOWED = 2; // safe cap

// Reuse your existing elements & state
const toggleButton = document.getElementById('toggleButton');
const responseConsole = document.getElementById('response-console');
const phoneNumberInput = document.getElementById('phoneNumberInput');
const amountInput = document.getElementById('amountInput');
const delayInput = document.getElementById('delayInput');

let isRunning = false;
let aborter = null;

// keep your logToConsole as-is
function logToConsole(message, clearPrevious = false){
  if(clearPrevious){ responseConsole.textContent = message; }
  else{ responseConsole.textContent += '\n' + message; }
  responseConsole.scrollTop = responseConsole.scrollHeight;
}

// small sleep helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// normalize +63
function normalizePH(local) {
  let n = String(local || "").replace(/\D/g, "");
  if (n.startsWith("0")) n = n.slice(1);
  return `+63${n}`;
}

// single HTTP POST with timeout + abort
async function sendOnce({ phone, signal }) {
  const c = new AbortController();
  const timeout = setTimeout(() => c.abort(), 15000); // 15s timeout
  if (signal) signal.addEventListener("abort", () => c.abort(), { once: true });

  try {
    const res = await fetch(BACKEND_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: phone }),
      signal: c.signal
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timeout);
  }
}

// retry wrapper (exponential backoff + jitter) for transient errors
async function safeSendWithRetry({ phone, signal, maxAttempts = 3 }) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const r = await sendOnce({ phone, signal });
      return { ...r, attempt };
    } catch (err) {
      // if abort from user, bubble immediately
      if (signal?.aborted) throw err;
      if (attempt >= maxAttempts) throw err;
      const base = 500 * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(base + jitter);
    }
  }
}

// helper to enable/disable UI while running
function setRunningUI(running) {
  if (toggleButton) {
    toggleButton.textContent = running ? 'STOP' : 'START';
    toggleButton.classList.toggle('stop-mode', running);
    toggleButton.classList.toggle('start-mode', !running);
  }
  [phoneNumberInput, amountInput, delayInput].forEach(el => {
    if (el) el.disabled = running;
  });
}

// Main click handler (replaces previous listener)
toggleButton.addEventListener('click', async (e) => {
  e.preventDefault();

  // If currently running -> STOP pressed
  if (isRunning) {
    if (aborter) aborter.abort();
    isRunning = false;
    setRunningUI(false);
    logToConsole('STATUS: Cancelled by user.');
    return;
  }

  // Read & validate inputs (keeping some of your checks)
  const rawPhone = phoneNumberInput.value.trim();
  const phoneDigits = rawPhone.replace(/\D/g, '');
  let amount = amountInput.value || "1";
  const amountNum = parseInt(amount, 10);
  if (Number.isNaN(amountNum) || amountNum < 1) {
    logToConsole('ERROR: Amount invalid.', true);
    return;
  }
  if (amountNum > 5) {
    // keep original 1-5 check but we will clamp further to MAX_ALLOWED
    logToConsole('NOTE: Amount requested >5; clamping.',''); // not clearing previous to preserve console
  }
  if (phoneDigits.length < 7) {
    logToConsole('ERROR: Phone number invalid.', true);
    return;
  }
  const delay = delayInput.value || "5";
  const delayNum = parseInt(delay, 10);
  if (Number.isNaN(delayNum) || delayNum < 1) {
    logToConsole('ERROR: Delay invalid.', true);
    return;
  }

  // Clamp amount to safety cap
  let toSend = Math.min(Math.max(1, amountNum), MAX_ALLOWED);
  if (toSend !== amountNum) {
    logToConsole(`NOTE: amount clipped to safe maximum of ${MAX_ALLOWED}.`);
  }

  // Start run
  const phone = normalizePH(rawPhone);
  isRunning = true;
  aborter = new AbortController();
  setRunningUI(true);

  logToConsole('\nSEQUENCE INITIATED.', true);
  logToConsole('TARGET: ' + phone);
  logToConsole('A: ' + toSend + ' | D: ' + delayNum + 's');
  logToConsole('STATUS: RUNNING...');

  try {
    for (let i = 1; i <= toSend; i++) {
      if (aborter.signal.aborted) throw new Error('Cancelled');

      logToConsole(`\n[${i}/${toSend}] Sending (up to 3 attempts)...`);
      try {
        const res = await safeSendWithRetry({ phone, signal: aborter.signal, maxAttempts: 3 });
        if (res.ok) {
          logToConsole(`[${i}/${toSend}] Success (${res.status}) on attempt ${res.attempt}`);
        } else {
          logToConsole(`[${i}/${toSend}] Failed (${res.status}) on attempt ${res.attempt}`);
        }
        logToConsole(`Response: ${String(res.text).slice(0,200)}...`);
      } catch (err) {
        logToConsole(`[${i}/${toSend}] ERROR: ${err?.message || err}`);
      }

      // wait between requests unless last or aborted (allow cancellation while waiting)
      if (i !== toSend) {
        let waited = 0;
        const totalWait = delayNum * 1000;
        const step = 200;
        while (waited < totalWait) {
          if (aborter.signal.aborted) throw new Error('Cancelled');
          await sleep(step);
          waited += step;
        }
      }
    }
  } catch (err) {
    logToConsole(`Run stopped: ${err?.message || err}`);
  } finally {
    isRunning = false;
    setRunningUI(false);
    logToConsole('STATUS: Ready.');
  }
});

// init UI state on DOMContentLoaded (keeps your original init)
window.addEventListener('DOMContentLoaded', () => {
  toggleButton.classList.add('start-mode');
  logToConsole('SYSTEM: Ready.', true);
});
</script>
