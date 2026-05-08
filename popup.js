/* ══════════════════════════════════════════════
   Keka Assistant — Popup Script
   Handles: Welcome screen, Tab navigation,
            Time Tracker settings, Face Guard UI
══════════════════════════════════════════════ */

const defaultSettings = {
  useCustomSettings: true,
  workHours: 8,
  workMinutes: 30,
  isBreakTimeIncludedInWorkingHours: false,
  isNotificationEnabled: true,
  showPolicyIcon: true
};

let currentSettings = { ...defaultSettings };
let isEditingDuration = false;

// Refreshers exposed by initPinLockUI / initFaceGuardUI so setupTabNav can call them
let refreshPinLockStatus = null;
let refreshFaceGuardStatus = null;

// Set to true after the user successfully enters their PIN once per popup session.
// Prevents asking for PIN again if they switch between protected tabs.
let pinVerifiedThisSession = false;

const githubRepoUrl = "https://github.com/vrajhk01/keka-extension";

/* ── DOMContentLoaded ── */
document.addEventListener("DOMContentLoaded", function () {
  // Keep background alive
  chrome.runtime.connect({ name: "popup" });

  handleWelcomeScreen();
  setupTabNav();
  loadSettings();
  setupSettingsUI();
  setupConnectionStatus();
  initPinLockUI();
  initFaceGuardUI();

  document.getElementById("githubLinkWelcome")
    ?.addEventListener("click", () => chrome.tabs.create({ url: githubRepoUrl }));
  document.getElementById("githubLinkSettings")
    ?.addEventListener("click", () => chrome.tabs.create({ url: githubRepoUrl }));
});

/* ── Welcome screen ── */
function handleWelcomeScreen() {
  const welcomeScreen = document.getElementById("welcomeScreen");
  const mainApp = document.getElementById("mainApp");
  const continueBtn = document.getElementById("continueBtn");

  chrome.storage.sync.get(["welcomeSeen"], ({ welcomeSeen }) => {
    if (welcomeSeen) {
      welcomeScreen.style.display = "none";
      mainApp.style.display = "block";
    } else {
      welcomeScreen.style.display = "block";
      mainApp.style.display = "none";
    }
  });

  continueBtn?.addEventListener("click", () => {
    chrome.storage.sync.set({ welcomeSeen: true }, () => {
      welcomeScreen.style.display = "none";
      mainApp.style.display = "block";
    });
  });
}

/* ── Tab navigation ── */
function setupTabNav() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.tab;

      // Activate the tab visually and refresh its live state
      function activateTab() {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(targetId)?.classList.add("active");

        // Re-fetch live status so the tab always reflects latest state
        if (targetId === "tab-security") {
          refreshPinLockStatus?.();
          refreshFaceGuardStatus?.();
        }
      }

      // Security tab is protected — require the main PIN if one is set
      if (targetId !== "tab-security") { activateTab(); return; }

      chrome.storage.local.get(["keka_pin_lock"], result => {
        const cfg = result.keka_pin_lock;
        const pinSet = !!(cfg?.enabled && cfg?.pin);

        // No PIN configured yet, or already verified this session → open directly
        if (!pinSet || pinVerifiedThisSession) { activateTab(); return; }

        // Show the PIN gate; activate tab only on success
        showPinGate("Security", activateTab);
      });
    });
  });
}

/* ── PIN Gate helpers ── */

/** SHA-256 of "keka_salt_v1_" + pin — matches pin-lock.js hashPin() */
async function hashPinForGate(pin) {
  const data = new TextEncoder().encode("keka_salt_v1_" + pin);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Show the PIN gate overlay.
 * @param {string}   sectionLabel  – shown in the gate title ("PIN Lock" / "Face Guard")
 * @param {Function} onSuccess     – called when the correct PIN is entered
 */
function showPinGate(sectionLabel, onSuccess) {
  const gate = document.getElementById("pin-gate");
  const card = document.getElementById("pg-card");
  const nameEl = document.getElementById("pg-section-name");
  const input = document.getElementById("pg-pin-input");
  const msg = document.getElementById("pg-msg");
  const submitBtn = document.getElementById("pg-submit");
  const cancelBtn = document.getElementById("pg-cancel");

  // Reset UI
  nameEl.textContent = sectionLabel + " — Verify PIN";
  input.value = "";
  msg.textContent = "";
  gate.style.display = "flex";
  setTimeout(() => input.focus(), 60);

  // ── Handlers (defined once, removed on close) ──
  async function tryVerify() {
    const pin = input.value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      msg.textContent = "Enter your 4–8 digit PIN.";
      return;
    }
    chrome.storage.local.get(["keka_pin_lock"], async result => {
      const storedHash = result.keka_pin_lock?.pin;
      if (!storedHash) { closeGate(); onSuccess(); return; } // no PIN stored

      const entered = await hashPinForGate(pin);
      if (entered === storedHash) {
        pinVerifiedThisSession = true;
        closeGate();
        onSuccess();
      } else {
        msg.textContent = "Incorrect PIN. Try again.";
        input.value = "";
        // Shake the card
        card.style.animation = "none";
        void card.offsetWidth;
        card.style.animation = "pg-shake 0.3s ease";
        setTimeout(() => input.focus(), 60);
      }
    });
  }

  function onKeyPress(e) { if (e.key === "Enter") tryVerify(); }
  function onInput() { input.value = input.value.replace(/\D/g, ""); }
  function onCancel() { closeGate(); }

  function closeGate() {
    gate.style.display = "none";
    submitBtn.removeEventListener("click", tryVerify);
    input.removeEventListener("keypress", onKeyPress);
    input.removeEventListener("input", onInput);
    cancelBtn.removeEventListener("click", onCancel);
  }

  submitBtn.addEventListener("click", tryVerify);
  input.addEventListener("keypress", onKeyPress);
  input.addEventListener("input", onInput);
  cancelBtn.addEventListener("click", onCancel);
}

/* ── Connection status bar ── */
function setupConnectionStatus() {
  const statusEl = document.getElementById("status");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab?.url?.includes("keka.com")) {
      statusEl.textContent = "Connected to Keka";
      statusEl.className = "status-bar connected";
    } else {
      statusEl.textContent = "Please navigate to Keka to use this extension";
      statusEl.className = "status-bar disconnected";
    }
  });
}

/* ── Load settings from storage ── */
function loadSettings() {
  chrome.storage.sync.get(defaultSettings, (settings) => {
    currentSettings = settings;
    document.getElementById("workHours").value = settings.workHours;
    document.getElementById("workMinutes").value = settings.workMinutes;
    document.getElementById("isBreakTimeIncludedInWorkingHours").checked =
      settings.isBreakTimeIncludedInWorkingHours !== false;
    document.getElementById("isNotificationEnabled").checked =
      settings.isNotificationEnabled !== false;
    document.getElementById("showPolicyIcon").checked =
      settings.showPolicyIcon !== false;
  });
}

/* ── Toggle edit mode for duration ── */
function toggleEditMode() {
  isEditingDuration = !isEditingDuration;

  const hoursInput = document.getElementById("workHours");
  const minutesInput = document.getElementById("workMinutes");
  const editIcon = document.getElementById("editDurationIcon");

  if (isEditingDuration) {
    hoursInput.disabled = false;
    minutesInput.disabled = false;
    editIcon.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="#22c55e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>`;
    hoursInput.focus();
  } else {
    hoursInput.disabled = true;
    minutesInput.disabled = true;
    editIcon.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="#64c3d1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>`;
  }
}

/* ── Save settings ── */
function saveSettings() {
  const workHoursInput = document.getElementById("workHours").value;
  const workMinutesInput = document.getElementById("workMinutes").value;
  const isBreakIncluded = document.getElementById("isBreakTimeIncludedInWorkingHours").checked;
  const isNotifEnabled = document.getElementById("isNotificationEnabled").checked;
  const showPolicyIcon = document.getElementById("showPolicyIcon").checked;

  let workHours = parseInt(workHoursInput);
  if (isNaN(workHours) || workHours < 0 || workHours > 12) workHours = defaultSettings.workHours;

  let workMinutes = parseInt(workMinutesInput);
  if (isNaN(workMinutes) || workMinutes < 0 || workMinutes > 59) workMinutes = defaultSettings.workMinutes;

  const settings = {
    useCustomSettings: true,
    workHours,
    workMinutes,
    isBreakTimeIncludedInWorkingHours: isBreakIncluded,
    isNotificationEnabled: isNotifEnabled,
    showPolicyIcon
  };

  const saveBtn = document.getElementById("saveSettings");
  const feedback = document.getElementById("save-feedback");

  saveBtn.disabled = true;
  saveBtn.style.opacity = "0.7";

  chrome.storage.sync.set(settings, () => {
    document.getElementById("workHours").value = settings.workHours;
    document.getElementById("workMinutes").value = settings.workMinutes;

    if (isEditingDuration) toggleEditMode();

    feedback.textContent = "Settings saved successfully";
    setTimeout(() => { feedback.textContent = ""; }, 2000);

    saveBtn.disabled = false;
    saveBtn.style.opacity = "1";

    // Notify content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.url?.includes("keka.com")) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          { action: "settingsUpdated", settings },
          () => { if (chrome.runtime.lastError) { } }
        );
      }
    });
  });
}

/* ── Settings UI event listeners ── */
function setupSettingsUI() {
  document.getElementById("saveSettings")
    .addEventListener("click", saveSettings);

  document.getElementById("editDurationIcon")
    .addEventListener("click", toggleEditMode);

  document.getElementById("workHours").addEventListener("input", function () {
    if (this.value > 12) this.value = 12;
    if (this.value < 0) this.value = 0;
  });
  document.getElementById("workMinutes").addEventListener("input", function () {
    if (this.value > 59) this.value = 59;
    if (this.value < 0) this.value = 0;
  });

  document.getElementById("workHours").addEventListener("keypress", (e) => {
    if (e.key === "Enter") saveSettings();
  });
  document.getElementById("workMinutes").addEventListener("keypress", (e) => {
    if (e.key === "Enter") saveSettings();
  });
}

/* ══════════════════════════════════════════════
   PIN LOCK UI
   Communicates with pin-lock.js via chrome.tabs.sendMessage.
   Supports biometric (WebAuthn) + PIN + Backup PIN recovery.
══════════════════════════════════════════════ */
function initPinLockUI() {
  const dot = document.getElementById("pl-dot");
  const badge = document.getElementById("pl-badge");
  const titleEl = document.getElementById("pl-status-title");
  const subEl = document.getElementById("pl-status-sub");
  const setupForm = document.getElementById("pl-setup-form");
  const activeCtrl = document.getElementById("pl-active-controls");
  const pinInput = document.getElementById("pl-pin-input");
  const backupInput = document.getElementById("pl-backup-input");
  const idleSelect = document.getElementById("pl-idle-select");
  const idleEdit = document.getElementById("pl-idle-edit");
  const bioRow = document.getElementById("pl-bio-row");
  const bioToggle = document.getElementById("pl-bio-toggle");
  const btnSet = document.getElementById("pl-btn-set");
  const btnSaveSettings = document.getElementById("pl-btn-save-settings");
  const btnLockNow = document.getElementById("pl-btn-lock-now");
  const btnClear = document.getElementById("pl-btn-clear");
  const msgEl = document.getElementById("pl-msg");

  function setMsg(text, type = "") {
    msgEl.textContent = text;
    msgEl.className = "pl-msg" + (type ? " " + type : "");
  }

  function setStatus(enabled, locked, idleMinutes, biometricEnrolled) {
    if (enabled && locked) {
      dot.className = "pl-dot locked";
      badge.textContent = "LOCKED"; badge.className = "pl-badge on";
      titleEl.textContent = "Tab is Locked";
      subEl.textContent = "Enter PIN on the Keka tab to unlock";
      setupForm.style.display = "none"; activeCtrl.style.display = "block";
    } else if (enabled) {
      dot.className = "pl-dot active";
      badge.textContent = "ON"; badge.className = "pl-badge on";
      titleEl.textContent = "Protection Active";
      const bioLabel = biometricEnrolled ? " + Biometric" : "";
      const lockLabel = (idleMinutes === 0) ? "Locks immediately on tab switch" : "Locks after " + (idleMinutes || 1) + " min idle";
      subEl.textContent = "PIN" + bioLabel + " · " + lockLabel;
      setupForm.style.display = "none"; activeCtrl.style.display = "block";
    } else {
      dot.className = "pl-dot";
      badge.textContent = "OFF"; badge.className = "pl-badge off";
      titleEl.textContent = "Not Configured";
      subEl.textContent = "Set a PIN to protect this tab";
      setupForm.style.display = "block"; activeCtrl.style.display = "none";
    }
    // Pre-fill the inline idle-time editor with the current value
    if (enabled && idleEdit) {
      idleEdit.value = String(typeof idleMinutes === "number" ? idleMinutes : 1);
    }
  }

  function getKekaTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.url?.includes("keka.com")) {
        setMsg("Please navigate to Keka first.", "error"); return;
      }
      cb(tabs[0]);
    });
  }

  function refreshStatus() {
    refreshPinLockStatus = refreshStatus; // expose to setupTabNav
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.url?.includes("keka.com")) {
        setMsg("Open a Keka tab to use PIN Lock.", "error");
        btnSet.disabled = true; return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action: "pl_status" }, (res) => {
        if (chrome.runtime.lastError || !res) {
          setMsg("PIN Lock loading... reload the Keka tab if needed.", "error"); return;
        }
        setStatus(res.enabled, res.locked, res.idleMinutes, res.biometricEnrolled);

        // Show biometric toggle in setup form if device supports it
        if (bioRow && res.biometricAvailable) bioRow.style.display = "flex";

        if (res.enabled && !res.locked) {
          const bioNote = res.biometricEnrolled ? "Biometric + PIN active." : "PIN active (no biometric).";
          setMsg(bioNote + " Tab auto-locks on idle.", "success");
        } else if (!res.enabled) {
          setMsg("");
        }
      });
    });
  }

  // ── Enable PIN Lock ──
  btnSet.addEventListener("click", () => {
    const pin = pinInput.value.trim();
    const backup = backupInput.value.trim();

    if (!/^\d{4,8}$/.test(pin)) {
      setMsg("Main PIN must be 4 to 8 digits.", "error"); pinInput.focus(); return;
    }
    if (!/^\d{4,8}$/.test(backup)) {
      setMsg("Backup PIN must be 4 to 8 digits.", "error"); backupInput.focus(); return;
    }
    if (pin === backup) {
      setMsg("Backup PIN must be different from your main PIN.", "error"); backupInput.focus(); return;
    }

    const idleMinutes = parseInt(idleSelect.value);
    const enrollBiometric = bioToggle ? bioToggle.checked : false;

    getKekaTab((tab) => {
      btnSet.disabled = true;
      setMsg(enrollBiometric ? "Setting up... biometric prompt will appear on the Keka tab." : "Setting up...");

      chrome.tabs.sendMessage(tab.id,
        { action: "pl_setup", pin, backupPin: backup, idleMinutes, enrollBiometric },
        (res) => {
          btnSet.disabled = false;
          if (chrome.runtime.lastError || !res?.success) {
            setMsg("Failed to set PIN — reload the Keka tab.", "error"); return;
          }
          pinInput.value = ""; backupInput.value = "";
          const lockNote = (idleMinutes === 0) ? "Locks immediately on tab switch." : "Locks after " + idleMinutes + " min idle.";
          const bioNote = res.biometricEnrolled
            ? "Biometric registered! " + lockNote
            : "PIN Lock enabled! Biometric not available — PIN only.";
          setStatus(true, false, idleMinutes, res.biometricEnrolled);
          setMsg(enrollBiometric ? bioNote : "PIN Lock enabled! " + lockNote, "success");
        }
      );
    });
  });

  // ── Save Settings (idle time) without removing PIN ──
  btnSaveSettings.addEventListener("click", () => {
    const idleMinutes = parseInt(idleEdit.value, 10);
    getKekaTab((tab) => {
      btnSaveSettings.disabled = true;
      chrome.tabs.sendMessage(tab.id, { action: "pl_update_settings", idleMinutes }, (res) => {
        btnSaveSettings.disabled = false;
        if (chrome.runtime.lastError || !res?.success) {
          setMsg("Could not save — reload the Keka tab.", "error"); return;
        }
        const lockLabel = (idleMinutes === 0) ? "Locks immediately on tab switch." : "Locks after " + idleMinutes + " min idle.";
        setMsg("Settings saved! " + lockLabel, "success");
        // Refresh status to update the subtitle
        refreshStatus();
      });
    });
  });

  // ── Lock Now ──
  btnLockNow.addEventListener("click", () => {
    getKekaTab((tab) => {
      chrome.tabs.sendMessage(tab.id, { action: "pl_lock_now" }, (res) => {
        if (chrome.runtime.lastError || !res?.success) {
          setMsg("Could not lock — reload the Keka tab.", "error"); return;
        }
        window.close();
      });
    });
  });

  // ── Remove PIN ──
  btnClear.addEventListener("click", () => {
    getKekaTab((tab) => {
      chrome.tabs.sendMessage(tab.id, { action: "pl_clear" }, (res) => {
        if (chrome.runtime.lastError || !res?.success) {
          setMsg("Failed to remove PIN — reload the Keka tab.", "error"); return;
        }
        setStatus(false, false, null, false);
        setMsg("PIN and biometric removed. Protection disabled.");
      });
    });
  });

  // Only allow digits in PIN fields
  [pinInput, backupInput].forEach(input => {
    input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, ""); });
  });
  pinInput.addEventListener("keypress", e => { if (e.key === "Enter") backupInput.focus(); });
  backupInput.addEventListener("keypress", e => { if (e.key === "Enter") btnSet.click(); });

  refreshStatus();
}

/* ══════════════════════════════════════════════
   Face Guard UI
══════════════════════════════════════════════ */
function initFaceGuardUI() {
  const dot = document.getElementById("fg-dot");
  const badge = document.getElementById("fg-badge");
  const titleEl = document.getElementById("fg-status-title");
  const subEl = document.getElementById("fg-status-sub");
  const msgEl = document.getElementById("fg-msg");
  const registerSec = document.getElementById("fg-register-section");
  const activeSec = document.getElementById("fg-active-section");
  const btnRegister = document.getElementById("fg-btn-register");
  const btnReregister = document.getElementById("fg-btn-reregister");
  const btnClearFace = document.getElementById("fg-btn-clear-face");
  const intruderEmpty = document.getElementById("fg-intruder-empty");
  const intruderGrid = document.getElementById("fg-intruder-grid");
  const btnClearLog = document.getElementById("fg-btn-clear-log");
  const lightbox = document.getElementById("fg-lightbox");
  const lightboxImg = document.getElementById("fg-lightbox-img");
  const lightboxTs = document.getElementById("fg-lightbox-ts");
  const lightboxClose = document.getElementById("fg-lightbox-close");

  function setFgMsg(text, type) {
    msgEl.textContent = text;
    msgEl.style.color = type === "error" ? "#ef4444" : type === "success" ? "#22c55e" : "#64748b";
  }

  function renderStatus(enrolled, enrolledAt, pinEnabled) {
    const pinNotice = document.getElementById("fg-pin-notice");

    if (enrolled && pinEnabled) {
      // ✅ Normal active state
      dot.style.background = "#22c55e";
      badge.textContent = "ON";
      badge.style.background = "#dcfce7";
      badge.style.color = "#16a34a";
      titleEl.textContent = "Face Guard Active";
      const d = enrolledAt ? new Date(enrolledAt).toLocaleDateString() : "—";
      subEl.textContent = "Registered " + d + " · Auto-unlocks on match";
      if (pinNotice) pinNotice.style.display = "none";
      registerSec.style.display = "none";
      activeSec.style.display = "block";

    } else if (enrolled && !pinEnabled) {
      // ⚠ Face registered but PIN was removed/not set — warn and let them clear
      dot.style.background = "#f59e0b";
      badge.textContent = "⚠";
      badge.style.background = "#fef3c7";
      badge.style.color = "#92400e";
      titleEl.textContent = "Face Guard — PIN Missing";
      subEl.textContent = "Set up PIN Lock to activate Face Guard";
      if (pinNotice) pinNotice.style.display = "flex";
      registerSec.style.display = "none";
      activeSec.style.display = "block"; // show so user can clear face data

    } else {
      // OFF — not enrolled
      dot.style.background = "#6b7280";
      badge.textContent = "OFF";
      badge.style.background = "#e2e8f0";
      badge.style.color = "#64748b";
      titleEl.textContent = "Face Guard";
      subEl.textContent = "No face registered";
      // Show prerequisite notice only when PIN is also missing
      if (pinNotice) pinNotice.style.display = pinEnabled ? "none" : "flex";
      registerSec.style.display = "block";
      activeSec.style.display = "none";
      // Disable register button if PIN not configured
      btnRegister.disabled = !pinEnabled;
      btnRegister.style.opacity = pinEnabled ? "1" : "0.45";
      btnRegister.style.cursor = pinEnabled ? "pointer" : "not-allowed";
    }
  }

  function renderIntruderLog(log) {
    if (!log || log.length === 0) {
      intruderEmpty.style.display = "block";
      intruderGrid.style.display = "none";
      btnClearLog.style.display = "none";
      return;
    }
    intruderEmpty.style.display = "none";
    intruderGrid.style.display = "grid";
    btnClearLog.style.display = "block";
    intruderGrid.innerHTML = "";

    log.forEach(entry => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:relative;border-radius:8px;overflow:hidden;cursor:pointer;aspect-ratio:4/3;background:#f1f5f9;";

      const img = document.createElement("img");
      img.src = entry.imageDataUrl;
      img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
      img.title = new Date(entry.timestamp).toLocaleString();

      const ts = document.createElement("div");
      ts.style.cssText = "position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.55);color:white;font-size:9px;padding:2px 4px;text-align:center;";
      ts.textContent = new Date(entry.timestamp).toLocaleTimeString();

      wrap.appendChild(img);
      wrap.appendChild(ts);
      wrap.addEventListener("click", () => {
        lightboxImg.src = entry.imageDataUrl;
        lightboxTs.textContent = new Date(entry.timestamp).toLocaleString();
        lightbox.style.display = "flex";
      });
      intruderGrid.appendChild(wrap);
    });
  }

  function getKekaTabFg(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]?.url?.includes("keka.com")) {
        setFgMsg("Open a Keka tab first.", "error"); return;
      }
      cb(tabs[0]);
    });
  }

  function refreshFgStatus() {
    refreshFaceGuardStatus = refreshFgStatus; // expose to setupTabNav
    // Read both face guard config AND pin lock config so we know if PIN is active
    chrome.storage.local.get(["keka_face_guard", "keka_intruder_log", "keka_pin_lock"], result => {
      const cfg = result.keka_face_guard || {};
      const pinCfg = result.keka_pin_lock || {};
      const pinEnabled = !!(pinCfg.enabled && pinCfg.pin);
      renderStatus(!!cfg.descriptor, cfg.enrolledAt || null, pinEnabled);
      renderIntruderLog(result.keka_intruder_log || []);
    });
  }

  function startEnrollment() {
    getKekaTabFg(tab => {
      // ── Gate: PIN Lock must be active before Face Guard can be registered ──
      chrome.tabs.sendMessage(tab.id, { action: "pl_status" }, plRes => {
        if (chrome.runtime.lastError || !plRes?.enabled) {
          setFgMsg("Set up PIN Lock first (PIN Lock tab) — Face Guard requires PIN Lock to work.", "error");
          return;
        }

        // PIN is active — proceed with face enrollment
        setFgMsg("Camera opening on Keka tab…", "");
        btnRegister.disabled = true;
        btnReregister.disabled = true;

        chrome.tabs.sendMessage(tab.id, { action: "fg_enroll_start" }, res => {
          btnRegister.disabled = false;
          btnReregister.disabled = false;
          if (chrome.runtime.lastError || !res?.success) {
            setFgMsg(res?.error || "Enrollment failed — ensure camera access is allowed for keka.com.", "error");
            return;
          }
          setFgMsg("Face registered successfully!", "success");
          refreshFgStatus();
        });
      });
    });
  }

  // ── Button handlers ──
  btnRegister.addEventListener("click", startEnrollment);
  btnReregister.addEventListener("click", startEnrollment);

  btnClearFace.addEventListener("click", () => {
    getKekaTabFg(tab => {
      chrome.tabs.sendMessage(tab.id, { action: "fg_clear" }, res => {
        if (chrome.runtime.lastError || !res?.success) {
          setFgMsg("Failed to clear — reload the Keka tab.", "error"); return;
        }
        setFgMsg("Face data cleared.", "");
        refreshFgStatus();
      });
    });
  });

  btnClearLog.addEventListener("click", () => {
    chrome.storage.local.remove(["keka_intruder_log"], () => {
      renderIntruderLog([]);
      setFgMsg("Intruder log cleared.", "");
    });
  });

  lightboxClose.addEventListener("click", () => { lightbox.style.display = "none"; });
  lightbox.addEventListener("click", e => { if (e.target === lightbox) lightbox.style.display = "none"; });

  refreshFgStatus();
}
