/**
 * Keka PIN Lock — Idle Auto-Lock Module v2.5
 * Unlock via: Fingerprint / Windows Hello / Face ID (WebAuthn)  OR  PIN numpad
 * Recovery:   Backup PIN
 * No camera indicators, no external services, no permissions beyond storage.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "keka_pin_lock";
  const LAST_ACTIVE_KEY = "keka_pin_last_active"; // epoch ms — when user was last authenticated/active
  const DEFAULT_IDLE_MIN = 1;
  const PIN_MIN_LENGTH = 4;
  const PIN_MAX_LENGTH = 8;
  const MAX_ATTEMPTS = 5;
  const COOLDOWN_MS = 30000;
  // WebAuthn RP id must match the page origin — we use keka.com
  const RP_ID = location.hostname;
  const RP_NAME = "Keka Assistant";

  let state = {
    pin: null,           // hashed main PIN
    backupPin: null,     // hashed backup PIN (recovery)
    credentialId: null,  // base64url stored WebAuthn credential id
    idleMinutes: DEFAULT_IDLE_MIN,
    enabled: false,
    locked: false,
    idleTimer: null,
    overlayEl: null,
    statusDotEl: null,
    attempts: 0,
    cooldownTimer: null,
    showingRecovery: false,
    biometricAvailable: false,
  };

  /* ─────────────────────────────────────────────
     UTILS
  ───────────────────────────────────────────── */
  async function hashPin(pin) {
    const data = new TextEncoder().encode("keka_salt_v1_" + pin);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function b64urlEncode(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }
  function b64urlDecode(str) {
    const s = str.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;
  }

  /* ─────────────────────────────────────────────
     EXTENSION CONTEXT GUARD
     When the extension is reloaded/updated while a Keka tab is still open,
     the old content script loses its chrome.* API access. Any timer or
     event listener that fires after that moment would throw
     "Extension context invalidated". isCtxValid() lets every chrome API
     call bail out silently instead of throwing an uncaught error.
  ───────────────────────────────────────────── */
  function isCtxValid() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  /* ─────────────────────────────────────────────
     STORAGE
  ───────────────────────────────────────────── */
  function saveConfig(cfg) {
    if (!isCtxValid()) return;
    chrome.storage.local.set({ [STORAGE_KEY]: cfg });
  }
  function loadConfig() {
    if (!isCtxValid()) return Promise.resolve(null);
    return new Promise(resolve =>
      chrome.storage.local.get([STORAGE_KEY], r => resolve(r[STORAGE_KEY] || null))
    );
  }

  /* ─────────────────────────────────────────────
     WEBAUTHN — BIOMETRIC
  ───────────────────────────────────────────── */
  async function checkBiometricAvailable() {
    try {
      if (!window.PublicKeyCredential) return false;
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch { return false; }
  }

  /** Register a new WebAuthn credential (called at PIN setup if biometrics available) */
  async function registerBiometric() {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { id: RP_ID, name: RP_NAME },
        user: { id: userId, name: "keka-user", displayName: "Keka User" },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },   // ES256
          { type: "public-key", alg: -257 },  // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",   // only built-in (fingerprint/face/PIN)
          userVerification: "required",           // must verify (biometric or device PIN)
          residentKey: "preferred",
        },
        timeout: 60000,
      }
    });

    return b64urlEncode(cred.rawId);
  }

  /** Verify identity using existing WebAuthn credential — shows native OS prompt */
  async function verifyBiometric(credentialId) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: RP_ID,
        allowCredentials: [{ type: "public-key", id: b64urlDecode(credentialId) }],
        userVerification: "required",
        timeout: 60000,
      }
    });
    // If no exception thrown, verification succeeded
    return true;
  }

  /* ─────────────────────────────────────────────
     IDLE TIMER
  ───────────────────────────────────────────── */
  let _lastActiveSave = 0; // throttle storage writes to once per 30 s

  function saveLastActive(ts) {
    if (!isCtxValid()) return;
    ts = ts || Date.now();
    _lastActiveSave = ts;
    chrome.storage.local.set({ [LAST_ACTIVE_KEY]: ts });
  }

  function loadLastActive() {
    if (!isCtxValid()) return Promise.resolve(0);
    return new Promise(resolve =>
      chrome.storage.local.get([LAST_ACTIVE_KEY], r => resolve(r[LAST_ACTIVE_KEY] || 0))
    );
  }

  // "Immediately" mode uses a 5-second inactivity grace period so the page
  // still auto-locks while the user is on the tab (not just on tab switch).
  const IMMEDIATELY_TIMEOUT_MS = 5000;

  function resetIdleTimer() {
    if (!state.enabled || state.locked) return;
    clearTimeout(state.idleTimer);

    const timeoutMs = state.idleMinutes === 0
      ? IMMEDIATELY_TIMEOUT_MS                  // "Immediately" → lock after 5 s of inactivity
      : state.idleMinutes * 60 * 1000;          // time-based idle → full window

    // Throttled save of last-active timestamp (only meaningful for time-based idle)
    if (state.idleMinutes > 0) {
      const now = Date.now();
      if (now - _lastActiveSave > 30000) saveLastActive(now);
    }

    state.idleTimer = setTimeout(() => { if (isCtxValid()) lockPage(); }, timeoutMs);
  }

  function setupActivityListeners() {
    ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "click"].forEach(ev =>
      document.addEventListener(ev, () => { if (isCtxValid()) resetIdleTimer(); }, { passive: true })
    );
    document.addEventListener("visibilitychange", () => {
      if (!isCtxValid()) return; // extension was reloaded — silently exit
      if (document.visibilityState === "hidden") {
        // Always stop any face scan immediately — never scan in background.
        if (window.__faceGuard) window.__faceGuard.stop();

        if (!state.enabled || state.locked) return;

        if (state.idleMinutes === 0) {
          // "Immediately" — lock the moment the user leaves.
          lockPage();
        } else {
          // Time-based idle — pause the timer and record when user left.
          // The lock fires when they return (if window expired) or after the
          // remaining time elapses (handled on visibilitychange visible below).
          clearTimeout(state.idleTimer);
          saveLastActive(); // mark "last active = right now (when leaving)"
        }

      } else if (document.visibilityState === "visible" && state.enabled) {
        if (state.locked) {
          // Tab just became visible while the lock overlay is already showing.
          // The hidden-handler called stop() to kill the camera. Now that the
          // user is actually looking at the screen, kick off a fresh face scan.
          if (window.__faceGuard) {
            window.__faceGuard.isEnabled().then(enabled => {
              if (enabled) window.__faceGuard.start(state.overlayEl);
            });
          }
        } else {
          // Not locked — check whether the idle window expired while away.
          loadLastActive().then(lastActive => {
            const elapsed = Date.now() - lastActive;
            const idleMs = state.idleMinutes * 60 * 1000;
            if (elapsed >= idleMs) {
              shouldScanFaceOnNextLock = true; // user is returning to the site
              lockPage(); // window expired while user was away
            } else {
              // Still within window — restart timer for the remaining time.
              clearTimeout(state.idleTimer);
              state.idleTimer = setTimeout(lockPage, idleMs - elapsed);
            }
          });
        }
      }
    });
  }

  /* ─────────────────────────────────────────────
     LOCK OVERLAY
  ───────────────────────────────────────────── */
  let inputBuffer = "";
  let recoveryBuffer = "";
  // Set to true immediately before calling lockPage() whenever the user is
  // actively navigating TO Keka (page load OR returning after idle expired).
  // Stays false for: idle-timer-fires-while-on-tab, manual Lock Now.
  let shouldScanFaceOnNextLock = false;

  function buildOverlay() {
    if (state.overlayEl) return;
    const overlay = document.createElement("div");
    overlay.id = "keka-pin-lock-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:white;";

    overlay.innerHTML = `
      <!-- Blur background -->
      <div style="position:absolute;inset:0;background:rgba(10,18,30,0.88);backdrop-filter:blur(28px) saturate(120%);-webkit-backdrop-filter:blur(28px) saturate(120%);"></div>

      <!-- ── MAIN CARD ── -->
      <div id="kl-card" style="position:relative;z-index:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:32px 32px 24px;width:300px;box-shadow:0 24px 64px rgba(0,0,0,0.5);display:flex;flex-direction:column;align-items:center;backdrop-filter:blur(12px);animation:kl-pop 0.25s cubic-bezier(0.34,1.56,0.64,1);">

        <!-- Face Guard camera preview (shown when face guard is enrolled) -->
        <div id="kl-face-preview-wrap" style="display:none;flex-direction:column;align-items:center;margin-bottom:14px;">
          <div id="kl-face-video-slot" style="width:90px;height:90px;border-radius:50%;overflow:hidden;border:2px solid rgba(100,195,209,0.5);box-shadow:0 0 18px rgba(100,195,209,0.25);background:#0a121e;"></div>
          <div id="kl-face-status" style="margin-top:6px;font-size:11px;color:#64c3d1;text-align:center;">Initializing…</div>
        </div>

        <!-- Lock icon -->
        <div style="width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,rgba(100,195,209,0.25),rgba(14,116,144,0.15));border:1.5px solid rgba(100,195,209,0.35);display:flex;align-items:center;justify-content:center;margin-bottom:16px;box-shadow:0 0 24px rgba(100,195,209,0.2);">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#64c3d1" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>

        <h2 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#f1f5f9;letter-spacing:-0.3px;">Tab Locked</h2>
        <p style="margin:0 0 20px;font-size:13px;color:#94a3b8;text-align:center;line-height:1.5;">Keka was locked due to inactivity.</p>

        <!-- Biometric button (shown if registered) -->
        <button id="kl-bio-btn" style="display:none;width:100%;padding:11px;margin-bottom:14px;background:linear-gradient(135deg,rgba(100,195,209,0.2),rgba(14,116,144,0.15));border:1.5px solid rgba(100,195,209,0.4);border-radius:12px;color:#e0f7fa;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;display:none;align-items:center;justify-content:center;gap:8px;transition:background 0.2s,transform 0.1s;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4"/>
          </svg>
          Use Fingerprint / Windows Hello
        </button>

        <!-- Divider shown only when biometric is available -->
        <div id="kl-divider" style="display:none;width:100%;display:none;align-items:center;gap:8px;margin-bottom:14px;">
          <div style="flex:1;height:1px;background:rgba(255,255,255,0.1);"></div>
          <span style="font-size:11px;color:#475569;">or enter PIN</span>
          <div style="flex:1;height:1px;background:rgba(255,255,255,0.1);"></div>
        </div>

        <!-- PIN dots -->
        <div id="kl-dots" style="display:flex;gap:10px;margin-top:20px;margin-bottom:18px;"></div>

        <!-- Numpad -->
        <div id="kl-numpad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;"></div>

        <!-- Message + forgot link -->
        <div id="kl-msg" style="margin-top:12px;font-size:12px;min-height:16px;color:#f87171;font-weight:500;text-align:center;"></div>
        <button id="kl-forgot-btn" style="margin-top:8px;background:none;border:none;cursor:pointer;font-size:11px;color:#64c3d1;font-family:inherit;padding:3px 8px;opacity:0.8;">Forgot PIN?</button>
      </div>

      <!-- ── RECOVERY CARD ── -->
      <div id="kl-recovery-card" style="display:none;position:relative;z-index:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:32px 32px 24px;width:300px;box-shadow:0 24px 64px rgba(0,0,0,0.5);flex-direction:column;align-items:center;backdrop-filter:blur(12px);animation:kl-pop 0.25s cubic-bezier(0.34,1.56,0.64,1);">
        <div style="width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,rgba(251,191,36,0.2),rgba(245,158,11,0.1));border:1.5px solid rgba(251,191,36,0.4);display:flex;align-items:center;justify-content:center;margin-bottom:16px;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
        </div>
        <h2 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#f1f5f9;">Forgot PIN?</h2>
        <p style="margin:0 0 20px;font-size:13px;color:#94a3b8;text-align:center;line-height:1.5;">Enter your Backup PIN to<br>disable the lock and reset.</p>
        <div id="kl-recovery-dots" style="display:flex;gap:10px;margin-bottom:18px;"></div>
        <div id="kl-recovery-numpad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;width:100%;"></div>
        <div id="kl-recovery-msg" style="margin-top:12px;font-size:12px;min-height:16px;color:#f87171;font-weight:500;text-align:center;"></div>
        <button id="kl-back-btn" style="margin-top:8px;background:none;border:none;cursor:pointer;font-size:11px;color:#64748b;font-family:inherit;padding:3px 8px;">Back to unlock screen</button>
      </div>

      <style>
        @keyframes kl-pop{from{opacity:0;transform:scale(0.88) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}
        @keyframes kl-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
        .kl-key{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#f1f5f9;font-size:18px;font-weight:600;font-family:inherit;cursor:pointer;padding:13px 0;transition:background 0.12s,transform 0.08s;user-select:none;-webkit-user-select:none;}
        .kl-key:hover{background:rgba(255,255,255,0.15);}
        .kl-key:active{background:rgba(100,195,209,0.3);transform:scale(0.93);}
        .kl-key.spec{font-size:12px;color:#94a3b8;}
        .kl-dot{width:12px;height:12px;border-radius:50%;border:2px solid rgba(100,195,209,0.5);background:transparent;transition:background 0.15s,border-color 0.15s;}
        .kl-dot.filled{background:#64c3d1;border-color:#64c3d1;box-shadow:0 0 8px rgba(100,195,209,0.6);}
        .kl-rdot{width:12px;height:12px;border-radius:50%;border:2px solid rgba(251,191,36,0.5);background:transparent;transition:background 0.15s;}
        .kl-rdot.filled{background:#fbbf24;border-color:#fbbf24;box-shadow:0 0 8px rgba(251,191,36,0.6);}
        #kl-bio-btn:hover{background:linear-gradient(135deg,rgba(100,195,209,0.32),rgba(14,116,144,0.25));transform:translateY(-1px);}
        #kl-bio-btn:active{transform:scale(0.97);}
      </style>`;

    document.body.appendChild(overlay);
    state.overlayEl = overlay;
    buildNumpad();
  }

  /* ── Build both numpads ── */
  function buildNumpad() {
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "CLR", "0", "DEL"];

    // Main numpad
    const numpad = state.overlayEl.querySelector("#kl-numpad");
    keys.forEach(k => {
      const btn = document.createElement("button");
      btn.className = "kl-key" + (k === "CLR" || k === "DEL" ? " spec" : "");
      btn.textContent = k;
      btn.addEventListener("click", () => handleKey(k));
      numpad.appendChild(btn);
    });

    // Recovery numpad
    const rnumpad = state.overlayEl.querySelector("#kl-recovery-numpad");
    keys.forEach(k => {
      const btn = document.createElement("button");
      btn.className = "kl-key" + (k === "CLR" || k === "DEL" ? " spec" : "");
      btn.textContent = k;
      btn.addEventListener("click", () => handleRecoveryKey(k));
      rnumpad.appendChild(btn);
    });

    // Biometric button
    const bioBtn = state.overlayEl.querySelector("#kl-bio-btn");
    bioBtn.addEventListener("click", triggerBiometric);

    // Navigation buttons
    state.overlayEl.querySelector("#kl-forgot-btn").addEventListener("click", showRecoveryCard);
    state.overlayEl.querySelector("#kl-back-btn").addEventListener("click", showMainCard);

    document.addEventListener("keydown", handleKeyboard);
  }

  /* ── Show/hide cards ── */
  function showRecoveryCard() {
    state.showingRecovery = true;
    recoveryBuffer = "";
    state.overlayEl.querySelector("#kl-card").style.display = "none";
    const rc = state.overlayEl.querySelector("#kl-recovery-card");
    rc.style.display = "flex";
    updateRecoveryDots();
    state.overlayEl.querySelector("#kl-recovery-msg").textContent = "";
  }

  function showMainCard() {
    state.showingRecovery = false;
    state.overlayEl.querySelector("#kl-recovery-card").style.display = "none";
    state.overlayEl.querySelector("#kl-card").style.display = "flex";
  }

  /* ── Biometric trigger ── */
  async function triggerBiometric() {
    const bioBtn = state.overlayEl.querySelector("#kl-bio-btn");
    const msg = state.overlayEl.querySelector("#kl-msg");

    if (!state.credentialId) {
      if (msg) msg.textContent = "No biometric registered. Use PIN.";
      return;
    }

    if (bioBtn) { bioBtn.disabled = true; bioBtn.style.opacity = "0.6"; }
    if (msg) msg.textContent = "";

    try {
      await verifyBiometric(state.credentialId);
      state.attempts = 0;
      unlockPage();
    } catch (e) {
      if (msg) msg.textContent = e.name === "NotAllowedError"
        ? "Biometric cancelled. Enter your PIN."
        : "Biometric failed. Enter your PIN.";
    } finally {
      if (bioBtn) { bioBtn.disabled = false; bioBtn.style.opacity = "1"; }
    }
  }

  /* ── Keyboard handler ── */
  function handleKeyboard(e) {
    if (!state.locked) return;
    if (state.showingRecovery) {
      if (e.key >= "0" && e.key <= "9") handleRecoveryKey(e.key);
      else if (e.key === "Backspace") handleRecoveryKey("DEL");
      else if (e.key === "Escape") { recoveryBuffer = ""; updateRecoveryDots(); showMainCard(); }
    } else {
      if (e.key >= "0" && e.key <= "9") handleKey(e.key);
      else if (e.key === "Backspace") handleKey("DEL");
      else if (e.key === "Escape") { inputBuffer = ""; updateDots(); }
    }
  }

  /* ── Main PIN input ── */
  function handleKey(k) {
    if (state.cooldownTimer) return;
    if (k === "CLR") { inputBuffer = ""; }
    else if (k === "DEL") { inputBuffer = inputBuffer.slice(0, -1); }
    else {
      if (inputBuffer.length >= PIN_MAX_LENGTH) return;
      inputBuffer += k;
      if (inputBuffer.length === PIN_MIN_LENGTH) setTimeout(submitPin, 80);
    }
    updateDots();
  }

  function updateDots() {
    const el = state.overlayEl && state.overlayEl.querySelector("#kl-dots");
    if (!el) return;
    el.innerHTML = "";
    const len = Math.max(PIN_MIN_LENGTH, inputBuffer.length);
    for (let i = 0; i < len; i++) {
      const d = document.createElement("div");
      d.className = "kl-dot" + (i < inputBuffer.length ? " filled" : "");
      el.appendChild(d);
    }
  }

  async function submitPin() {
    if (!inputBuffer) return;
    const entered = inputBuffer;
    inputBuffer = ""; updateDots();
    const hashed = await hashPin(entered);
    if (hashed === state.pin) {
      state.attempts = 0; unlockPage();
    } else {
      state.attempts++;
      const card = state.overlayEl && state.overlayEl.querySelector("#kl-card");
      const msg = state.overlayEl && state.overlayEl.querySelector("#kl-msg");
      if (card) { card.style.animation = "none"; void card.offsetWidth; card.style.animation = "kl-shake 0.35s ease"; }
      if (state.attempts >= MAX_ATTEMPTS) {
        startCooldown();
      } else {
        const left = MAX_ATTEMPTS - state.attempts;
        if (msg) msg.textContent = "Wrong PIN. " + left + " attempt" + (left === 1 ? "" : "s") + " left.";
      }
    }
  }

  function startCooldown() {
    const msg = state.overlayEl && state.overlayEl.querySelector("#kl-msg");
    const numpad = state.overlayEl && state.overlayEl.querySelector("#kl-numpad");
    if (numpad) { numpad.style.opacity = "0.3"; numpad.style.pointerEvents = "none"; }
    let secs = COOLDOWN_MS / 1000;
    if (msg) msg.textContent = "Too many attempts. Try again in " + secs + "s.";
    state.cooldownTimer = setInterval(() => {
      secs--;
      if (secs <= 0) {
        clearInterval(state.cooldownTimer); state.cooldownTimer = null; state.attempts = 0;
        if (numpad) { numpad.style.opacity = "1"; numpad.style.pointerEvents = "auto"; }
        if (msg) msg.textContent = "";
      } else {
        if (msg) msg.textContent = "Too many attempts. Try again in " + secs + "s.";
      }
    }, 1000);
  }

  /* ── Backup PIN (recovery) input ── */
  function handleRecoveryKey(k) {
    if (k === "CLR") { recoveryBuffer = ""; }
    else if (k === "DEL") { recoveryBuffer = recoveryBuffer.slice(0, -1); }
    else {
      if (recoveryBuffer.length >= PIN_MAX_LENGTH) return;
      recoveryBuffer += k;
      if (recoveryBuffer.length === PIN_MIN_LENGTH) setTimeout(submitBackupPin, 80);
    }
    updateRecoveryDots();
  }

  function updateRecoveryDots() {
    const el = state.overlayEl && state.overlayEl.querySelector("#kl-recovery-dots");
    if (!el) return;
    el.innerHTML = "";
    const len = Math.max(PIN_MIN_LENGTH, recoveryBuffer.length);
    for (let i = 0; i < len; i++) {
      const d = document.createElement("div");
      d.className = "kl-rdot" + (i < recoveryBuffer.length ? " filled" : "");
      el.appendChild(d);
    }
  }

  async function submitBackupPin() {
    if (!recoveryBuffer) return;
    const entered = recoveryBuffer;
    recoveryBuffer = ""; updateRecoveryDots();
    const msg = state.overlayEl && state.overlayEl.querySelector("#kl-recovery-msg");

    if (!state.backupPin) {
      if (msg) msg.textContent = "No backup PIN configured.";
      return;
    }
    const hashed = await hashPin(entered);
    if (hashed === state.backupPin) {
      if (msg) { msg.style.color = "#86efac"; msg.textContent = "Verified! Lock disabled. Set a new PIN from the extension."; }
      setTimeout(async () => { await clearPin(); if (state.overlayEl) state.overlayEl.style.display = "none"; }, 1800);
    } else {
      const rc = state.overlayEl && state.overlayEl.querySelector("#kl-recovery-card");
      if (rc) { rc.style.animation = "none"; void rc.offsetWidth; rc.style.animation = "kl-shake 0.35s ease"; }
      if (msg) msg.textContent = "Wrong backup PIN. Try again.";
    }
  }

  /* ─────────────────────────────────────────────
     LOCK / UNLOCK
  ───────────────────────────────────────────── */
  function lockPage() {
    if (state.locked || !state.enabled) return;
    state.locked = true;
    clearTimeout(state.idleTimer);
    inputBuffer = ""; recoveryBuffer = "";
    state.showingRecovery = false;
    buildOverlay();

    const bioBtn = state.overlayEl.querySelector("#kl-bio-btn");
    const divider = state.overlayEl.querySelector("#kl-divider");
    const forgotBtn = state.overlayEl.querySelector("#kl-forgot-btn");

    // Show biometric button only if credential registered
    if (state.credentialId) {
      bioBtn.style.display = "flex";
      divider.style.display = "flex";
      // Auto-trigger biometric prompt on lock
      setTimeout(triggerBiometric, 400);
    } else {
      bioBtn.style.display = "none";
      divider.style.display = "none";
    }

    forgotBtn.style.display = state.backupPin ? "block" : "none";

    state.overlayEl.querySelector("#kl-card").style.display = "flex";
    state.overlayEl.querySelector("#kl-recovery-card").style.display = "none";
    state.overlayEl.style.display = "flex";
    updateDots();
    updateStatusDot("locked");

    // Run face scan only when the caller explicitly requested it by setting
    // shouldScanFaceOnNextLock = true (page load, or tab-return after idle).
    // Idle-timer-fires-on-tab and manual Lock Now leave the flag false → PIN only.
    const doFaceScan = shouldScanFaceOnNextLock;
    shouldScanFaceOnNextLock = false; // always consume immediately

    if (doFaceScan && document.visibilityState === "visible" && window.__faceGuard) {
      window.__faceGuard.isEnabled().then(enabled => {
        if (enabled) window.__faceGuard.start(state.overlayEl);
      });
    }
  }

  function unlockPage() {
    if (!state.locked) return;
    state.locked = false;
    state.showingRecovery = false;
    // Stop face guard camera
    if (window.__faceGuard) window.__faceGuard.stop();
    if (state.overlayEl) state.overlayEl.style.display = "none";
    updateStatusDot("active");
    saveLastActive(); // stamp "user just authenticated right now"
    resetIdleTimer();
  }

  /* ─────────────────────────────────────────────
     STATUS DOT
  ───────────────────────────────────────────── */
  function injectStatusDot() {
    if (document.getElementById("kl-status-dot")) return;
    const dot = document.createElement("div");
    dot.id = "kl-status-dot";
    dot.style.cssText = "width:9px;height:9px;border-radius:50%;background:#6b7280;border:1.5px solid rgba(255,255,255,0.35);position:fixed;bottom:14px;right:14px;z-index:2147483646;transition:background 0.4s ease;cursor:default;box-shadow:0 0 6px rgba(0,0,0,0.4);";
    document.body.appendChild(dot);
    state.statusDotEl = dot;
  }

  function updateStatusDot(status) {
    if (!state.statusDotEl) return;
    const map = { active: ["#22c55e", "PIN Lock active"], locked: ["#ef4444", "PIN Lock: locked"], disabled: ["#6b7280", "PIN Lock: off"] };
    const [color, title] = map[status] || map.disabled;
    state.statusDotEl.style.background = color;
    state.statusDotEl.title = title;
  }

  /* ─────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────── */
  async function setupPin(pin, backupPin, idleMinutes, enrollBiometric) {
    const hashed = await hashPin(pin);
    const hashedBackup = backupPin ? await hashPin(backupPin) : null;

    state.pin = hashed;
    state.backupPin = hashedBackup;
    state.idleMinutes = (typeof idleMinutes === "number") ? idleMinutes : DEFAULT_IDLE_MIN;
    state.enabled = true;

    // Register biometric if requested and available
    if (enrollBiometric && state.biometricAvailable) {
      try {
        state.credentialId = await registerBiometric();
      } catch (e) {
        console.warn("[PINLock] Biometric registration skipped:", e.message);
        state.credentialId = null;
      }
    }

    saveConfig({
      pin: hashed,
      backupPin: hashedBackup,
      credentialId: state.credentialId,
      idleMinutes: state.idleMinutes,
      enabled: true,
    });

    setupActivityListeners();
    resetIdleTimer();
    updateStatusDot("active");
    return { success: true, biometricEnrolled: !!state.credentialId };
  }

  async function clearPin() {
    state.pin = null; state.backupPin = null; state.credentialId = null;
    state.enabled = false; state.locked = false; state.showingRecovery = false;
    clearTimeout(state.idleTimer);
    if (state.overlayEl) state.overlayEl.style.display = "none";
    chrome.storage.local.remove([STORAGE_KEY, LAST_ACTIVE_KEY]);
    updateStatusDot("disabled");
    return { success: true };
  }

  /* ─────────────────────────────────────────────
     MESSAGE BRIDGE
  ───────────────────────────────────────────── */
  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (req.action === "pl_setup") {
      setupPin(req.pin, req.backupPin, req.idleMinutes, req.enrollBiometric).then(sendResponse);
      return true;
    }
    if (req.action === "pl_clear") { clearPin().then(sendResponse); return true; }
    if (req.action === "pl_lock_now") { lockPage(); sendResponse({ success: true }); return true; }
    if (req.action === "pl_update_settings") {
      if (!state.enabled) { sendResponse({ success: false, error: "PIN Lock is not active." }); return true; }
      if (typeof req.idleMinutes === "number") state.idleMinutes = req.idleMinutes;
      saveConfig({
        pin: state.pin,
        backupPin: state.backupPin,
        credentialId: state.credentialId,
        idleMinutes: state.idleMinutes,
        enabled: true,
      });
      resetIdleTimer();
      sendResponse({ success: true, idleMinutes: state.idleMinutes });
      return true;
    }
    if (req.action === "pl_status") {
      sendResponse({
        enabled: state.enabled,
        locked: state.locked,
        idleMinutes: state.idleMinutes,
        biometricEnrolled: !!state.credentialId,
        biometricAvailable: state.biometricAvailable,
      });
      return true;
    }
  });

  /* ─────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────── */
  async function init() {
    injectStatusDot();
    state.biometricAvailable = await checkBiometricAvailable();

    const cfg = await loadConfig();
    if (cfg && cfg.enabled && cfg.pin) {
      state.pin = cfg.pin;
      state.backupPin = cfg.backupPin || null;
      state.credentialId = cfg.credentialId || null;
      state.idleMinutes = (typeof cfg.idleMinutes === "number") ? cfg.idleMinutes : DEFAULT_IDLE_MIN;
      state.enabled = true;
      setupActivityListeners();

      if (state.idleMinutes === 0) {
        // "Immediately" — always lock on every load/refresh, no exceptions.
        shouldScanFaceOnNextLock = true; // user is visiting the site fresh
        lockPage();
      } else {
        // Time-based idle — check if the window has expired since last activity.
        const lastActive = await loadLastActive();
        const elapsed = Date.now() - lastActive;
        const idleMs = state.idleMinutes * 60 * 1000;

        if (lastActive === 0 || elapsed >= idleMs) {
          // No previous session recorded, or idle window has expired → lock.
          shouldScanFaceOnNextLock = true; // user is visiting the site fresh
          lockPage();
        } else {
          // User reloaded/returned within the idle window → stay unlocked.
          // Set the timer for whatever time remains so it still locks eventually.
          updateStatusDot("active");
          const remaining = idleMs - elapsed;
          clearTimeout(state.idleTimer);
          state.idleTimer = setTimeout(lockPage, remaining);
        }
      }
    } else {
      updateStatusDot("disabled");
    }
  }

  /* ─────────────────────────────────────────────
     FACE GUARD EVENT LISTENERS
  ───────────────────────────────────────────── */
  document.addEventListener("faceGuard:unlock", () => {
    if (state.locked) {
      // Normal path — page is locked, unlock it.
      state.attempts = 0;
      unlockPage();
    } else if (state.overlayEl && state.overlayEl.style.display !== "none") {
      // Race-condition safety net: overlay is still visible but state.locked
      // was already cleared by something else (e.g. async timing). Hide it.
      state.overlayEl.style.display = "none";
      updateStatusDot("active");
      if (window.__faceGuard) window.__faceGuard.stop();
    }
  });

  document.addEventListener("faceGuard:intruder", () => {
    if (!state.overlayEl) return;
    const msg = state.overlayEl.querySelector("#kl-msg");
    if (msg) {
      msg.style.color = "#f87171";
      msg.textContent = "Unknown face captured. Enter your PIN.";
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

})();
