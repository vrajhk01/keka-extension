/* ================================================================
   face-lock.js  —  Keka Assistant Face Guard
   Runs as a content script on keka.com pages.
   lib/face-api.min.js is injected BEFORE this file (manifest order),
   so window.faceapi is available in the same isolated world.
   Exposes window.__faceGuard for pin-lock.js to call.
   ================================================================ */
(function () {
  "use strict";

  const STORAGE_KEY_FACE = "keka_face_guard";
  const STORAGE_KEY_LOG = "keka_intruder_log";
  const MATCH_THRESHOLD = 0.50;   // Euclidean distance — lower = stricter
  const MAX_INTRUDERS = 20;
  const CAMERA_WARMUP_MS = 1200;   // ms to let camera stabilise before scanning
  const STORAGE_LIMIT_BYTES = 4 * 1024 * 1024; // 4 MB safety limit

  // ── State ────────────────────────────────────────────────────────
  let modelsLoaded = false;
  let modelsLoading = false;  // guard: prevents concurrent model loads
  let isRunning = false;
  let isEnrolling = false;
  let warmupTimer = null;   // one-shot warm-up delay before the single scan
  let videoEl = null;
  let mediaStream = null;
  let storedDesc = null;
  let overlayRef = null;

  // ── Wait for face-api.js to be ready ────────────────────────────
  // face-api.min.js runs as a content script before this file.
  // Poll up to 8 s in case there is any init race on first use.
  async function waitForFaceApi() {
    const MAX_WAIT = 8000;
    const TICK = 100;
    let elapsed = 0;
    while (elapsed < MAX_WAIT) {
      if (window.faceapi && window.faceapi.nets) return window.faceapi;
      await sleep(TICK);
      elapsed += TICK;
    }
    throw new Error("face-api.js did not initialise. Please refresh the Keka tab and try again.");
  }

  // ── Load model weights (concurrent-safe) ────────────────────────
  async function ensureModels() {
    if (modelsLoaded) return;

    // If already loading, wait for it to finish instead of double-loading
    if (modelsLoading) {
      while (modelsLoading) await sleep(100);
      return;
    }

    modelsLoading = true;
    try {
      const fa = await waitForFaceApi();
      const base = chrome.runtime.getURL("models");
      await fa.nets.tinyFaceDetector.loadFromUri(base);
      await fa.nets.faceLandmark68TinyNet.loadFromUri(base);
      await fa.nets.faceRecognitionNet.loadFromUri(base);
      modelsLoaded = true;
    } finally {
      modelsLoading = false;
    }
  }

  // ── Tiny helpers ─────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function waitForVideoReady(video, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (video.readyState >= 1) { resolve(); return; }
      const t = setTimeout(() => reject(new Error("Camera stream timed out")), timeoutMs);
      video.onloadedmetadata = () => { clearTimeout(t); resolve(); };
      video.onerror = () => { clearTimeout(t); reject(new Error("Camera stream error")); };
    });
  }

  // ── Storage helpers ──────────────────────────────────────────────
  function loadFaceConfig() {
    return new Promise(r =>
      chrome.storage.local.get([STORAGE_KEY_FACE], d => r(d[STORAGE_KEY_FACE] || null))
    );
  }

  function saveFaceConfig(cfg) {
    return new Promise(r => chrome.storage.local.set({ [STORAGE_KEY_FACE]: cfg }, r));
  }

  function loadIntruderLog() {
    return new Promise(r =>
      chrome.storage.local.get([STORAGE_KEY_LOG], d => r(d[STORAGE_KEY_LOG] || []))
    );
  }

  async function appendIntruder(imageDataUrl) {
    const used = await new Promise(r => chrome.storage.local.getBytesInUse(null, r));
    if (used > STORAGE_LIMIT_BYTES) return;

    const log = await loadIntruderLog();
    log.unshift({ id: crypto.randomUUID(), timestamp: Date.now(), imageDataUrl });
    const trimmed = log.slice(0, MAX_INTRUDERS);
    await new Promise(r => chrome.storage.local.set({ [STORAGE_KEY_LOG]: trimmed }, r));
  }

  // ── Camera ───────────────────────────────────────────────────────
  async function startCamera() {
    if (mediaStream) return mediaStream;
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: "user" },
      audio: false,
    });
    return mediaStream;
  }

  // Also removes video element from DOM so it doesn't block
  // re-injection on the next lock cycle (Bug 1 fix).
  function stopCamera() {
    if (warmupTimer) { clearTimeout(warmupTimer); warmupTimer = null; }
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
      if (videoEl.parentNode) videoEl.parentNode.removeChild(videoEl); // ← removes from DOM
      videoEl = null;
    }
  }

  // ── Capture a JPEG frame from the live video ─────────────────────
  function captureFrame() {
    if (!videoEl) return null;
    const c = document.createElement("canvas");
    c.width = 200; c.height = 150;
    c.getContext("2d").drawImage(videoEl, 0, 0, 200, 150);
    return c.toDataURL("image/jpeg", 0.5);
  }

  // ── Overlay status helpers ────────────────────────────────────────
  function setFaceStatus(text, color) {
    if (!overlayRef) return;
    const el = overlayRef.querySelector("#kl-face-status");
    if (el) { el.textContent = text; el.style.color = color || "#64c3d1"; }
  }

  function showFacePreview(show) {
    if (!overlayRef) return;
    const wrap = overlayRef.querySelector("#kl-face-preview-wrap");
    if (wrap) wrap.style.display = show ? "flex" : "none";
  }

  // ── One-shot face scan ───────────────────────────────────────────
  // Runs ONCE per lock event (on page load / tab return / refresh).
  // No continuous loop — matches phone behavior where Face ID checks
  // once when you lift the phone, not every second.
  async function runOneShotScan() {
    if (!isRunning || !videoEl || !storedDesc) return;

    setFaceStatus("Scanning…", "#fbbf24");

    try {
      const fa = window.faceapi;
      const opts = new fa.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.4 });
      const det = await fa.detectSingleFace(videoEl, opts)
        .withFaceLandmarks(true)
        .withFaceDescriptor();

      if (!isRunning) return; // user may have entered PIN during detection

      if (!det) {
        // No face in frame — stop camera, show hint
        setFaceStatus("No face detected — use PIN", "#94a3b8");
        stopCamera();
        return;
      }

      const distance = fa.euclideanDistance(Array.from(det.descriptor), storedDesc);

      if (distance < MATCH_THRESHOLD) {
        // ✅ Owner recognised — auto-unlock
        setFaceStatus("Face matched!", "#22c55e");
        stopCamera();
        document.dispatchEvent(new CustomEvent("faceGuard:unlock"));
      } else {
        // ❌ Unknown face — capture image, stop camera, wait for PIN
        const img = captureFrame();
        if (img) {
          appendIntruder(img); // fire-and-forget
          document.dispatchEvent(new CustomEvent("faceGuard:intruder", { detail: { imageDataUrl: img } }));
        }
        setFaceStatus("Face not recognized — use PIN", "#f87171");
        stopCamera();
      }
    } catch {
      setFaceStatus("Face scan failed — use PIN", "#94a3b8");
      stopCamera();
    }
  }

  // ── start() — called by pin-lock.js when lock overlay appears ────
  async function start(overlay) {
    if (isRunning) return;
    overlayRef = overlay;

    const cfg = await loadFaceConfig();
    if (!cfg || !cfg.enabled || !cfg.descriptor) return; // not enrolled

    storedDesc = cfg.descriptor;
    isRunning = true;

    showFacePreview(true);
    setFaceStatus("Loading face recognition…", "#94a3b8");

    try {
      await ensureModels();
      if (!isRunning) return; // FIX (Bug 2): user may have unlocked via PIN while models loaded

      const stream = await startCamera();
      if (!isRunning) { stream.getTracks().forEach(t => t.stop()); mediaStream = null; return; } // FIX (Bug 2)

      // Inject <video> into the overlay's camera circle slot
      const slot = overlay.querySelector("#kl-face-video-slot");
      if (slot && !slot.querySelector("video")) {
        videoEl = document.createElement("video");
        videoEl.autoplay = true;
        videoEl.muted = true;
        videoEl.playsInline = true;
        videoEl.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:50%;";
        videoEl.srcObject = stream;
        slot.appendChild(videoEl);

        await waitForVideoReady(videoEl, 5000); // FIX (Bug 5): has a 5 s timeout
        if (!isRunning) return; // FIX (Bug 2)
        await videoEl.play().catch(() => { });
      }

      if (!isRunning) return;

      setFaceStatus("Camera ready — scanning…", "#64c3d1");
      // One-shot: fire once after warm-up, never repeats
      warmupTimer = setTimeout(runOneShotScan, CAMERA_WARMUP_MS);

    } catch (err) {
      const isPermission = err.name === "NotAllowedError" || err.name === "PermissionDeniedError";
      setFaceStatus(isPermission ? "Camera blocked — use PIN" : "Face scan unavailable — use PIN", "#94a3b8");
      showFacePreview(false);
      isRunning = false;
    }
  }

  // ── stop() — called by pin-lock.js on unlock or tab-hide ─────────
  function stop() {
    isRunning = false;
    storedDesc = null;
    stopCamera();

    // Clear stale UI so the next lock cycle never shows old "Face matched!"
    // text or a blank camera circle. Locate the overlay fresh from the DOM
    // because overlayRef is about to be nulled.
    const overlay = overlayRef || document.getElementById("keka-pin-lock-overlay");
    if (overlay) {
      const wrap = overlay.querySelector("#kl-face-preview-wrap");
      if (wrap) wrap.style.display = "none";
      const statusEl = overlay.querySelector("#kl-face-status");
      if (statusEl) { statusEl.textContent = ""; statusEl.style.color = "#64c3d1"; }
    }

    overlayRef = null;
  }

  // ── isEnabled() ──────────────────────────────────────────────────
  async function isEnabled() {
    const cfg = await loadFaceConfig();
    return !!(cfg && cfg.enabled && cfg.descriptor);
  }

  // ── Enrollment modal (shown on the Keka page) ────────────────────
  async function startEnrollmentFlow() {
    if (isEnrolling) throw new Error("Enrollment already in progress");
    isEnrolling = true;

    let enrollStream = null;
    let modal = null;

    try {
      await ensureModels();

      enrollStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: "user" },
        audio: false,
      });

      // Build modal
      modal = document.createElement("div");
      modal.id = "kl-enroll-modal";
      modal.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:white;";
      modal.innerHTML = `
        <div style="position:absolute;inset:0;background:rgba(10,18,30,0.85);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);"></div>
        <div style="position:relative;z-index:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.13);border-radius:20px;padding:32px;width:280px;display:flex;flex-direction:column;align-items:center;box-shadow:0 24px 64px rgba(0,0,0,0.5);animation:kl-pop 0.25s cubic-bezier(0.34,1.56,0.64,1);">
          <h2 style="margin:0 0 6px;font-size:18px;font-weight:700;color:#f1f5f9;">Register Your Face</h2>
          <p style="margin:0 0 18px;font-size:12px;color:#94a3b8;text-align:center;line-height:1.5;">Position your face in the circle,<br>then wait for the 3–2–1 countdown.</p>
          <div style="width:160px;height:160px;border-radius:50%;overflow:hidden;border:2.5px solid rgba(100,195,209,0.6);box-shadow:0 0 24px rgba(100,195,209,0.3);margin-bottom:16px;position:relative;">
            <video id="kl-enroll-video" autoplay muted playsinline style="width:100%;height:100%;object-fit:cover;"></video>
            <div id="kl-enroll-ring" style="position:absolute;inset:0;border-radius:50%;border:3px solid transparent;pointer-events:none;"></div>
          </div>
          <div id="kl-enroll-countdown" style="font-size:40px;font-weight:800;color:#64c3d1;min-height:48px;text-align:center;line-height:1;"></div>
          <div id="kl-enroll-status" style="margin-top:8px;font-size:12px;color:#94a3b8;text-align:center;min-height:18px;"></div>
        </div>
        <style>
          @keyframes kl-pop{from{opacity:0;transform:scale(0.88) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}
          @keyframes kl-scan{0%,100%{border-color:rgba(100,195,209,0.8);box-shadow:0 0 12px rgba(100,195,209,0.5);}50%{border-color:rgba(100,195,209,0.2);box-shadow:none;}}
        </style>`;
      document.body.appendChild(modal);

      const enrollVideo = modal.querySelector("#kl-enroll-video");
      const countdownEl = modal.querySelector("#kl-enroll-countdown");
      const statusEl = modal.querySelector("#kl-enroll-status");
      const ringEl = modal.querySelector("#kl-enroll-ring");

      enrollVideo.srcObject = enrollStream;
      await waitForVideoReady(enrollVideo, 6000); // FIX (Bug 5): timeout
      await enrollVideo.play().catch(() => { });

      // 3–2–1 countdown
      for (let i = 3; i >= 1; i--) {
        countdownEl.textContent = i;
        ringEl.style.animation = "kl-scan 1s ease-in-out";
        await sleep(1000);
        ringEl.style.animation = "";
      }

      countdownEl.textContent = "";
      statusEl.textContent = "Capturing…";

      // Capture 3 frames, average descriptors for a stable reference
      const fa = window.faceapi;
      const opts = new fa.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.3 });
      const descriptors = [];

      for (let i = 0; i < 3; i++) {
        statusEl.textContent = `Capturing frame ${i + 1} of 3…`;
        await sleep(500);
        const det = await fa.detectSingleFace(enrollVideo, opts)
          .withFaceLandmarks(true)
          .withFaceDescriptor();
        if (!det) throw new Error(`No face detected in frame ${i + 1}. Face the camera directly in good lighting.`);
        descriptors.push(Array.from(det.descriptor));
      }

      // Average
      const averaged = new Array(128).fill(0);
      for (const d of descriptors)
        for (let j = 0; j < 128; j++) averaged[j] += d[j] / 3;

      // Normalize to unit vector
      const norm = Math.sqrt(averaged.reduce((s, v) => s + v * v, 0));
      const normalized = averaged.map(v => v / norm);

      await saveFaceConfig({ enabled: true, descriptor: normalized, enrolledAt: Date.now() });

      statusEl.textContent = "✓ Face registered!";
      statusEl.style.color = "#22c55e";
      countdownEl.textContent = "✓";
      countdownEl.style.color = "#22c55e";

      await sleep(1800);
      return { success: true };

    } catch (err) {
      if (modal) {
        const s = modal.querySelector("#kl-enroll-status");
        if (s) { s.textContent = err.message || "Enrollment failed."; s.style.color = "#f87171"; }
        await sleep(2500);
      }
      throw err;
    } finally {
      isEnrolling = false;
      if (enrollStream) enrollStream.getTracks().forEach(t => t.stop());
      if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    }
  }

  // ── Message bridge (popup ↔ content script) ──────────────────────
  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (req.action === "fg_enroll_start") {
      startEnrollmentFlow()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (req.action === "fg_status") {
      chrome.storage.local.get([STORAGE_KEY_FACE], r => {
        const cfg = r[STORAGE_KEY_FACE] || {};
        sendResponse({ enabled: !!cfg.enabled, enrolled: !!cfg.descriptor, enrolledAt: cfg.enrolledAt || null });
      });
      return true;
    }
    if (req.action === "fg_clear") {
      chrome.storage.local.remove([STORAGE_KEY_FACE, STORAGE_KEY_LOG],
        () => sendResponse({ success: true })
      );
      return true;
    }
    if (req.action === "fg_clear_log") {
      chrome.storage.local.remove([STORAGE_KEY_LOG],
        () => sendResponse({ success: true })
      );
      return true;
    }
  });

  // ── Public API exposed to pin-lock.js ────────────────────────────
  window.__faceGuard = { start, stop, isEnabled };

})();
