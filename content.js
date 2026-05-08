/* ========= Settings & Globals ========= */
const defaultSettings = {
  useCustomSettings: true,
  workHours: 8,
  workMinutes: 30,
  isBreakTimeIncludedInWorkingHours: false,
  isNotificationEnabled: true,
};

let currentSettings = { ...defaultSettings };
let is24HourFormatEnabled = false;
let timeDisplayElement = null;
let navbarChipElement = null;
let notificationSentForSession = false;
let cachedAttendanceLogs = null;
let lastFetchTime = null;
let isFetchingLogs = false; // flag to prevent concurrent API calls
let isInitialized = false;
let checkInTime = "";

// Added to fix "Sometimes Effective and Gross time do not increment every second Instead, it stays frozen for 1 second and then jumps by 2 seconds"
let runningGrossMs = 0;
let runningEffectiveMs = 0;
let lastTickTs = null;
let isCurrentlyPunchedIn = false;

const themeColors = {
  dark: {
    background: "rgb(10, 29, 44)",
    border: "1px solid rgb(20, 55, 82)",
    text: "white",
    divider: "rgb(20, 55, 82)",
    progressBg: "rgba(100, 195, 209, 0.2)",
    progressFill: "#64c3d1",
    warningText: "#F5B153",
    chipBg: "rgba(100, 195, 209, 0.15)",
    chipText: "white",
    chipBorder: "rgba(100, 195, 209, 0.3)",
  },
  light: {
    background: "#f5f7f9",
    border: "1px solid #e0e4e8",
    text: "black",
    divider: "#e0e4e8",
    progressBg: "rgba(100, 195, 209, 0.15)",
    progressFill: "#64c3d1",
    warningText: "#e67e22",
    chipBg: "rgba(100, 195, 209, 0.12)",
    chipText: "black", // white suites better than black
    chipBorder: "rgba(100, 195, 209, 0.25)",
  },
};

const defaultKekaFontFamily =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

/* ========= Utility Helpers ========= */

function getKekaFontFamily() {
  try {
    const kekaElement = document.querySelector(".card-body") || document.body;
    if (kekaElement) {
      const fontFamily = window
        .getComputedStyle(kekaElement)
        .getPropertyValue("font-family");
      if (fontFamily) return fontFamily;
    }
  } catch (e) {
    // ignore and fallback
  }
  return defaultKekaFontFamily;
}

function getCurrentTheme() {
  try {
    return localStorage.getItem("ThemeMode") === "light" ? "light" : "dark";
  } catch (e) {
    return "dark";
  }
}

function pad(n) {
  return n.toString().padStart(2, "0");
}

function formatTime(hours, minutes, seconds) {
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatTimeWithAmPm(hours, minutes, seconds) {
  if (is24HourFormatEnabled) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  const ampm = hours >= 12 ? "PM" : "AM";
  const formattedHours = hours % 12 || 12;
  return `${formattedHours}:${pad(minutes)}:${pad(seconds)} ${ampm}`;
}

function toTimeWithAmPm(dateTime) {
  const timePart = dateTime.split("T")[1];
  if (!timePart) return;
  const [h, m, s] = timePart.split(":").map(Number);

  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;

  return `${hour12}:${m.toString().padStart(2, "0")}:${s
    .toString()
    .padStart(2, "0")} ${period}`;
}

function getCurrentTotalWorkMinutes() {
  return currentSettings.workHours * 60 + currentSettings.workMinutes;
}

/* ========= API Fetch Functions ========= */

async function fetchAttendanceLogsFromApi(forceRefresh = false) {
  // Prevent concurrent API calls
  if (isFetchingLogs && !forceRefresh) {
    return cachedAttendanceLogs;
  }

  // Check if cache is still valid (unless forcing refresh)
  if (!forceRefresh && cachedAttendanceLogs && lastFetchTime) {
    const cacheAge = Date.now() - lastFetchTime;
    if (cacheAge < 300000) {
      // 5 minutes
      return cachedAttendanceLogs;
    }
  }

  isFetchingLogs = true;

  try {
    const date = new Date().toISOString().split("T")[0];
    const res = await fetch(`/k/attendance/api/mytime/attendance/summary`, {
      credentials: "include",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("access_token")}`,
      },
    });
    const response = await res.json();
    const todaysInfo = response.data.find((d) =>
      d.attendanceDate.includes(date)
    );

    cachedAttendanceLogs = todaysInfo?.timeEntries || [];
    checkInTime = todaysInfo?.firstLogOfTheDay || "";
    lastFetchTime = Date.now();

    return cachedAttendanceLogs;
  } catch (e) {
    console.error("❌ Error fetching attendance logs:", e);
    return null;
  } finally {
    isFetchingLogs = false;
  }
}

function calculateMetricsFromApiLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return {
      effectiveMs: 0,
      grossMs: 0,
      breakMs: 0,
      expectedCheckout: "--:--:--",
    };
  }

  const sorted = logs
    .filter((l) => !l.isDeleted)
    .map((l) => ({
      time: new Date(l.timestamp),
      status: l.modifiedPunchStatus ?? l.punchStatus,
    }))
    .filter((l) => l.status === 0 || l.status === 1) // IN / OUT only
    .sort((a, b) => a.time - b.time);

  let effectiveMs = 0;
  let openIn = null;

  let firstPunchTime = null;
  let lastPunchTime = null;

  for (const log of sorted) {
    if (!firstPunchTime) firstPunchTime = log.time;
    lastPunchTime = log.time;

    if (log.status === 0) {
      // IN → open only if not already open
      if (!openIn) {
        openIn = log.time;
      }
    } else if (log.status === 1 && openIn) {
      // OUT → close only if IN exists
      effectiveMs += log.time - openIn;
      openIn = null;
    }
  }

  const now = new Date();

  // Add running session
  if (openIn) {
    effectiveMs += now - openIn;
  }

  const grossMs = firstPunchTime
    ? (openIn ? now : lastPunchTime) - firstPunchTime
    : 0;

  const breakMs = Math.max(0, grossMs - effectiveMs);

  // ⚠️ isPunchedIn should come from ClockInDetailsForToday
  const isPunchedIn = openIn !== null;

  let expectedCheckout = "--:--:--";

  if (firstPunchTime) {
    const totalWorkMs = getCurrentTotalWorkMinutes() * 60000;

    if (currentSettings.isBreakTimeIncludedInWorkingHours) {
      // ✅ Break INCLUDED
      // Checkout = Check-in + Configured Work Time
      const checkoutTime = new Date(firstPunchTime.getTime() + totalWorkMs);

      expectedCheckout =
        new Date() >= checkoutTime
          ? "Completed"
          : formatTimeWithAmPm(
            checkoutTime.getHours(),
            checkoutTime.getMinutes(),
            checkoutTime.getSeconds()
          );

    } else {
      // ❌ Break EXCLUDED
      // Checkout = Check-in + Work Time + Actual Break Taken
      const checkoutTime = new Date(
        firstPunchTime.getTime() + totalWorkMs + breakMs
      );

      expectedCheckout =
        new Date() >= checkoutTime
          ? "Completed"
          : formatTimeWithAmPm(
            checkoutTime.getHours(),
            checkoutTime.getMinutes(),
            checkoutTime.getSeconds()
          );
    }
  }

  return {
    effectiveMs,
    grossMs,
    breakMs,
    expectedCheckout,
  };
}

/* ========= Display PunchIn/Out Status Functions ========= */
async function fetchClockInStatus() {
  const res = await fetch("/k/default/api/me/clockInDetailsForToday", {
    credentials: "include",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("access_token")}`,
    },
  });

  const response = await res.json();
  return response.data.clockInStatus === 0;
}

function injectPunchBadgeStyles() {
  if (document.getElementById("punch-badge-style")) return;

  const style = document.createElement("style");
  style.id = "punch-badge-style";
  style.textContent = `
    .keka-punch-badge {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #22c55e;
      border: 2px solid #fff;
      z-index: 5;
    }

    .keka-punch-badge.out {
      background: #ef4444;
    }
  `;
  document.head.appendChild(style);
}

function updateProfilePunchBadge(isPunchedIn) {
  injectPunchBadgeStyles();

  // Try profile photo first, fall back to initials avatar
  const img = document.querySelector(
    "employee-profile-picture img.profile-picture"
  );
  const initials = document.querySelector(
    "employee-profile-picture .img-initials"
  );

  const target = img || initials;
  if (!target) return;

  const container = target.parentElement;
  if (!container) return;

  // Ensure relative positioning
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  let badge = container.querySelector(".keka-punch-badge");

  if (!badge) {
    badge = document.createElement("span");
    badge.className = "keka-punch-badge";
    badge.title = "Attendance status";
    container.appendChild(badge);
  }

  // Toggle state
  if (isPunchedIn) {
    badge.classList.remove("out");
    badge.title = "Punched In";
  } else {
    badge.classList.add("out");
    badge.title = "Punched Out";
  }
}

/* ========= Navbar Chip Display Functions ========= */
function createNavbarChip() {
  if (navbarChipElement) return navbarChipElement;

  const theme = getCurrentTheme();
  const colors = themeColors[theme];
  const fontFamily = getKekaFontFamily();

  navbarChipElement = document.createElement("div");
  navbarChipElement.id = "keka-time-chip";

  navbarChipElement.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    position: relative;

    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.28),
      rgba(255, 255, 255, 0.12)
    );

    backdrop-filter: blur(14px) saturate(180%);
    -webkit-backdrop-filter: blur(14px) saturate(180%);

    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 999px;

    box-shadow:
      0 6px 16px rgba(0, 0, 0, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.3);

    font-family: ${fontFamily};
    font-size: 12px;
    font-weight: 500;
    color: ${colors.chipText};

    margin: 8px 12px;
    white-space: nowrap;

    transition: box-shadow 0.3s ease, transform 0.2s ease;
  `;

  navbarChipElement.innerHTML = `
    <div style="display:flex;align-items:center;gap:4px;">
      <span style="font-size:10px;line-height:1;">⏰</span>
      <span style="font-size:12px;opacity:0.85;">Checkin:</span>
      <span id="chip-checkin" style="font-weight:600;">--:--:--</span>
    </div>

    <div class="chip-divider"></div>

    <div style="display:flex;align-items:center;gap:4px;">
      <span style="font-size:10px;line-height:1;">⏱️</span>
      <span style="font-size:12px;opacity:0.85;">Eff:</span>
      <span id="chip-effective" style="font-weight:600;">--:--:--</span>
    </div>

    <div class="chip-divider"></div>

    <div style="display:flex;align-items:center;gap:4px;">
      <span style="font-size:10px;line-height:1;">📊</span>
      <span style="font-size:12px;opacity:0.85;">Gross:</span>
      <span id="chip-gross" style="font-weight:600;">--:--:--</span>
    </div>

    <div class="chip-divider"></div>

    <div style="display:flex;align-items:center;gap:4px;">
      <span style="font-size:10px;line-height:1;">☕</span>
      <span style="font-size:12px;opacity:0.85;">Break:</span>
      <span id="chip-break" style="font-weight:600;">--</span>
    </div>

    <div class="chip-divider"></div>

    <div style="display:flex;align-items:center;gap:4px;">
      <span style="font-size:10px;line-height:1;">🚪</span>
      <span style="font-size:12px;opacity:0.85;">Checkout:</span>
      <span id="chip-checkout" style="font-weight:600;max-width:70px;overflow:hidden;text-overflow:ellipsis;">--:--:--</span>
    </div>

    <div class="chip-divider"></div>

    <!-- Refresh Button -->
    <div id="chip-refresh" title="Sync Logs" style="
      display:flex;
      align-items:center;
      justify-content:center;
      width:18px;
      height:18px;
      border-radius:50%;
      cursor:pointer;
      font-size:14px;

      background: rgba(255,255,255,0.18);
      border: 1px solid rgba(255,255,255,0.25);

      transition: background 0.2s ease, transform 0.15s ease;
    ">
      🔄
    </div>
  `;

  /* Divider styling */
  navbarChipElement.querySelectorAll(".chip-divider").forEach((divider) => {
    divider.style.cssText = `
      width:1px;
      height:14px;
      background: linear-gradient(
        180deg,
        rgba(255,255,255,0.5),
        rgba(255,255,255,0.15)
      );
      opacity:0.6;
    `;
  });

  /* Create dropdown on initialization */
  const dropdown = createLogsDropdown();
  navbarChipElement.appendChild(dropdown);

  /* Hover logic with delay */
  let hoverTimeout;
  let isHoveringChip = false;
  let isHoveringDropdown = false;

  function showDropdown() {
    if (cachedAttendanceLogs) {
      updateLogsDropdown(cachedAttendanceLogs);
    }
    dropdown.style.opacity = "1";
    dropdown.style.transform = "translateX(-50%) translateY(0)"; // UPDATED
    dropdown.style.pointerEvents = "auto";
  }

  function hideDropdown() {
    dropdown.style.opacity = "0";
    dropdown.style.transform = "translateX(-50%) translateY(-10px)"; // UPDATED
    dropdown.style.pointerEvents = "none";
  }

  // Event listeners on Chip Element
  navbarChipElement.addEventListener("mouseenter", (e) => {
    // Ignore hover when entering via refresh button
    if (e.target.closest("#chip-refresh")) return;

    isHoveringChip = true;
    clearTimeout(hoverTimeout);
    hoverTimeout = setTimeout(showDropdown, 200);

    // Chip hover effect
    navbarChipElement.style.boxShadow = `
      0 10px 24px rgba(0, 0, 0, 0.15),
      inset 0 1px 0 rgba(255, 255, 255, 0.4)
    `;
    navbarChipElement.style.transform = "translateY(-1px)";
  });

  navbarChipElement.addEventListener("mouseleave", (e) => {
    // Ignore hover when entering via refresh button
    if (e.target.closest("#chip-refresh")) return;

    isHoveringChip = false;
    clearTimeout(hoverTimeout);

    // Check if mouse moved to dropdown
    setTimeout(() => {
      if (!isHoveringChip && !isHoveringDropdown) {
        hideDropdown();
      }
    }, 100);

    // Reset chip hover effect
    navbarChipElement.style.boxShadow = `
      0 6px 16px rgba(0, 0, 0, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.3)
    `;
    navbarChipElement.style.transform = "translateY(0)";
  });

  dropdown.addEventListener("mouseenter", () => {
    isHoveringDropdown = true;
  });

  dropdown.addEventListener("mouseleave", () => {
    isHoveringDropdown = false;
    setTimeout(() => {
      if (!isHoveringChip && !isHoveringDropdown) {
        hideDropdown();
      }
    }, 100);
  });

  /* Refresh button hover */
  const refreshBtn = navbarChipElement.querySelector("#chip-refresh");

  refreshBtn.addEventListener("mouseenter", () => {
    refreshBtn.style.background = "rgba(255,255,255,0.28)";
    refreshBtn.style.transform = "scale(1.15)";
  });

  refreshBtn.addEventListener("mouseleave", () => {
    refreshBtn.style.background = "rgba(255,255,255,0.18)";
    refreshBtn.style.transform = "scale(1)";
  });

  /* Refresh click logic */
  refreshBtn.addEventListener("click", async (e) => {
    e.stopPropagation();

    // Disable button during refresh
    refreshBtn.style.pointerEvents = "none";
    refreshBtn.style.opacity = "0.5";

    // Spin animation
    refreshBtn.style.transition = "transform 0.5s ease";
    refreshBtn.style.transform = "rotate(360deg) scale(0.9)";

    if (window.timeUpdateInterval) {
      clearTimeout(window.timeUpdateInterval);
      window.timeUpdateInterval = null;
    }

    // Reset runtime + cache
    cachedAttendanceLogs = null;
    lastFetchTime = null;
    lastTickTs = null;
    runningEffectiveMs = 0;
    runningGrossMs = 0;

    await updateAllDisplays(true);

    // RESTART TIMER AFTER BASELINE IS READY
    ensureTimerIsRunning();

    // Update dropdown if visible
    if (dropdown.style.opacity === "1") {
      updateLogsDropdown(cachedAttendanceLogs);
    }

    // Reset button
    setTimeout(() => {
      refreshBtn.style.transform = "rotate(0deg) scale(1)";
      refreshBtn.style.pointerEvents = "auto";
      refreshBtn.style.opacity = "1";
      refreshBtn.style.transition = "background 0.2s ease, transform 0.15s ease";
    }, 500);
  });

  return navbarChipElement;
}

function insertNavbarChip() {
  // Target the specific div with class "d-flex align-items-center" that contains the time chip location
  const parent = document.querySelector("nav.navbar div");

  const chipElement = createNavbarChip(() => {
    fetchAttendanceLogsFromApi();
  });
  parent?.insertBefore(chipElement, parent.children[1]);
  applyThemeToNavbarChip();

  if (!parent) {
    setTimeout(insertNavbarChip, 1000);
    return;
  }
}

function updateNavbarChip(metrics) {
  if (!navbarChipElement) {
    insertNavbarChip();
    return;
  }

  const checkinSpan = navbarChipElement.querySelector("#chip-checkin");
  const effectiveSpan = navbarChipElement.querySelector("#chip-effective");
  const grossSpan = navbarChipElement.querySelector("#chip-gross");
  const breakSpan = navbarChipElement.querySelector("#chip-break");
  const checkoutSpan = navbarChipElement.querySelector("#chip-checkout");

  if (!effectiveSpan || !grossSpan || !breakSpan || !checkoutSpan) return;

  const formattedCheckinTime = toTimeWithAmPm(checkInTime) || "--:--:--";
  checkinSpan.textContent = formattedCheckinTime;

  // Decide what Effective should SHOW
  const displayEffectiveMs = currentSettings.isBreakTimeIncludedInWorkingHours
    ? metrics.grossMs                    // Effective = Gross
    : Math.max(0, metrics.grossMs - metrics.breakMs); // Effective = Gross - Break

  const effHms = msToHms(displayEffectiveMs);
  effectiveSpan.textContent = formatTime(effHms.h, effHms.m, effHms.s);

  // Format gross time
  const grossHms = msToHms(metrics.grossMs);
  grossSpan.textContent = formatTime(grossHms.h, grossHms.m, grossHms.s);

  // Format break time in minutes
  const breakMinutes = Math.floor(metrics.breakMs / 60000);
  breakSpan.textContent = `${breakMinutes} min`;

  // Format expected checkout
  checkoutSpan.textContent = metrics.expectedCheckout || "N/A";

  // Update tooltip with all details
  // It Blinks every 1 sec, so removed
  // const tooltipText = `
  //   Checkin time: ${formattedCheckinTime}
  //   Effective: ${formatTime(effHms.h, effHms.m, effHms.s)}
  //   Gross: ${formatTime(grossHms.h, grossHms.m, grossHms.s)}
  //   Break: ${breakMinutes} min
  //   Expected Checkout: ${metrics.expectedCheckout || "N/A"}
  //   Status: ${metrics.isPunchedIn ? "Punched In" : "Punched Out"}
  // `.trim();

  // navbarChipElement.title = tooltipText;

  // Visual indicator if work is completed
  const totalWorkMs = getCurrentTotalWorkMinutes() * 60000;
  if (metrics.effectiveMs >= totalWorkMs && metrics.isPunchedIn) {
    checkoutSpan.style.backgroundColor = "transparent";
    checkoutSpan.style.color = "#86efac";
    checkoutSpan.style.fontSize = "12px";
    checkoutSpan.style.fontWeight = "600";
    checkoutSpan.style.padding = "0";
    checkoutSpan.style.borderRadius = "0";
    checkoutSpan.style.lineHeight = "1";
  } else {
    checkoutSpan.style.color = "inherit";
    checkoutSpan.style.fontWeight = "500";
  }
}

function applyThemeToNavbarChip() {
  if (!navbarChipElement) return;

  const theme = 'dark'; // Keka is keeping always light theme in Nav 
  const colors = themeColors[theme];
  const fontFamily = getKekaFontFamily();

  navbarChipElement.style.backgroundColor = colors.chipBg;
  navbarChipElement.style.borderColor = colors.chipBorder;
  navbarChipElement.style.color = colors.chipText;
  navbarChipElement.style.fontFamily = fontFamily;

  // Update dividers
  const dividers = navbarChipElement.querySelectorAll(
    "div[style*='height: 16px']"
  );
  dividers.forEach((div) => {
    div.style.backgroundColor = colors.chipBorder;
  });
}

function applyThemeToPolicy() {
  if (!policyPanelElement) return;
  const isDark = getCurrentTheme() === "dark";

  policyPanelElement.style.background = isDark
    ? "rgba(10,29,44,0.97)"
    : "rgba(245,247,249,0.98)";
  policyPanelElement.style.borderColor = isDark
    ? "rgba(100,195,209,0.2)"
    : "rgba(0,0,0,0.1)";
  policyPanelElement.style.color = isDark ? "white" : "#1a1a1a";

  // Re-render inner HTML with new theme colours by re-using stored data
  chrome.storage.local.get(
    ["keka_attendance_policy", "keka_policy_diff", "keka_leave_name_map", "keka_attendance_scheme"],
    (stored) => {
      if (!stored.keka_attendance_policy) return;
      const leaveNameMap = stored.keka_leave_name_map || {};
      policyPanelElement.innerHTML = buildPolicyPanelHTML(
        stored.keka_attendance_policy,
        stored.keka_policy_diff || [],
        leaveNameMap,
        stored.keka_attendance_scheme || null
      );
    }
  );
}

/* ========= Logs Dropdown functions ========= */
function createProgressBar(metrics) {
  const totalWorkMs = getCurrentTotalWorkMinutes() * 60000;
  const completedMs = currentSettings.isBreakTimeIncludedInWorkingHours
    ? metrics.grossMs
    : metrics.effectiveMs;

  const percentage =
    totalWorkMs === 0
      ? 0
      : Math.min((completedMs / totalWorkMs) * 100, 100);

  const percentText = percentage.toFixed(2);
  const isCompleted = completedMs >= totalWorkMs;

  const theme = getCurrentTheme();
  const colors = themeColors[theme];

  return `
    <div style="
      margin-bottom: 12px;
    ">
      <div style="
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        font-weight: 600;
        color: ${colors.text};
        margin-bottom: 6px;
      ">
        <span>${isCompleted ? "Completed" : "Work Completion"}</span>
        <span>${percentText}%</span>
      </div>

      <div style="
        height: 6px;
        width: 100%;
        background: ${colors.progressBg};
        border-radius: 999px;
        overflow: hidden;
      ">
        <div style="
          height: 100%;
          width: ${percentage}%;
          background: ${colors.progressFill};
          border-radius: 999px;
          transition: width 0.4s ease;
        "></div>
      </div>
    </div>
  `;
}

function createLogsDropdown() {
  const theme = getCurrentTheme();
  const colors = themeColors[theme];
  const fontFamily = getKekaFontFamily();

  const dropdown = document.createElement("div");
  dropdown.id = "keka-logs-dropdown";
  dropdown.style.cssText = `
    position: absolute;
    top: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%) translateY(-10px);
    min-width: 350px;
    max-width: 450px;
    max-height: 450px;
    overflow-y: auto;

    background: ${colors.background};

    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);

    border: ${colors.border};
    border-radius: 12px;

    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.25);

    font-family: ${fontFamily};
    padding: 12px;
    z-index: 10000;

    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
`;


  // Custom scrollbar
  const style = document.createElement("style");
  style.textContent = `
    #keka-logs-dropdown::-webkit-scrollbar {
      width: 6px;
    }
    #keka-logs-dropdown::-webkit-scrollbar-track {
      background: ${colors.divider};
      border-radius: 3px;
    }
    #keka-logs-dropdown::-webkit-scrollbar-thumb {
      background: ${colors.progressFill};
      border-radius: 3px;
    }
    #keka-logs-dropdown::-webkit-scrollbar-thumb:hover {
      background: ${colors.progressFill};
    }
`;

  document.head.appendChild(style);

  return dropdown;
}

function updateLogsDropdown(logs) {
  const theme = getCurrentTheme();
  const colors = themeColors[theme];
  let dropdown = document.getElementById("keka-logs-dropdown");
  const metrics = cachedAttendanceLogs
    ? calculateMetricsFromApiLogs(cachedAttendanceLogs)
    : null;


  if (!dropdown) {
    dropdown = createLogsDropdown();
    if (navbarChipElement) {
      navbarChipElement.style.position = "relative";
      navbarChipElement.appendChild(dropdown);
    }
  }

  if (!logs || logs.length === 0) {
    dropdown.innerHTML = `
      <div style="
        text-align: center;
        padding: 20px;
        color: ${theme === "dark" ? "#e5e7eb" : "#1f2937"};
        font-size: 13px;
      ">
        No logs available
      </div>
    `;
    return;
  }

  // Filter out deleted logs and group by premiseName
  const validLogs = logs.filter(l => !l.isDeleted);
  const grouped = {};

  validLogs.forEach(log => {
    const premise = log.premiseName || "Unknown";
    if (!grouped[premise]) {
      grouped[premise] = [];
    }
    grouped[premise].push(log);
  });

  // Build HTML
  let html = '<div style="display: flex; flex-direction: column; gap: 16px;">';

  if (metrics) {
    html += createProgressBar(metrics);
  }


  Object.keys(grouped).forEach((premiseName) => {
    const premiseLogs = grouped[premiseName].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    html += `
      <div style="
        background: ${theme === "dark"
        ? "rgba(255,255,255,0.04)"
        : "rgba(255,255,255,0.5)"};
        border-radius: 8px;
        padding: 10px;
        border: 1px solid ${colors.chipBorder};
      ">
        <div style="
          font-weight: 600;
          font-size: 12px;
          color: ${theme === "dark" ? "#e5e7eb" : "#1f2937"};
          margin-bottom: 10px;
          padding-bottom: 6px;
          border-bottom: 1px solid ${colors.divider};
        ">
          ${premiseName}
        </div>
    `;

    // Group logs into pairs (IN/OUT or status pairs)
    const logPairs = [];
    for (let i = 0; i < premiseLogs.length; i += 2) {
      logPairs.push({
        first: premiseLogs[i],
        second: premiseLogs[i + 1] || null
      });
    }

    // Display logs in 2-column grid
    logPairs.forEach(pair => {
      html += `
        <div style="
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-bottom: 8px;
        ">
      `;

      // First log
      html += formatLogCell(pair.first);

      // Second log (or empty cell)
      if (pair.second) {
        html += formatLogCell(pair.second);
      } else {
        html += '<div></div>';
      }

      html += '</div>';
    });

    html += '</div>';
  });

  html += '</div>';
  dropdown.innerHTML = html;
}

function formatLogCell(log) {
  const theme = getCurrentTheme();
  const colors = themeColors[theme];
  const time = toTimeWithAmPm(log.timestamp) || "N/A";
  const status = log.punchStatus;

  let icon, statusText, statusColor, bgColor;

  if (status === 0) {
    // IN - Green
    icon = "→";
    statusText = "IN";
    statusColor = "#22c55e";
    bgColor = theme === "dark"
      ? "rgba(34, 197, 94, 0.12)"
      : "rgba(34, 197, 94, 0.18)";
  } else if (status === 1) {
    // OUT - Red
    icon = "→";
    statusText = "OUT";
    statusColor = "#ef4444";
    bgColor = theme === "dark"
      ? "rgba(239, 68, 68, 0.12)"
      : "rgba(239, 68, 68, 0.18)";
  } else if (status === 4) {
    // MISSING - Orange
    icon = "";
    statusText = "MISSING";
    statusColor = "#f59e0b";
    bgColor = theme === "dark"
      ? "rgba(245, 158, 11, 0.12)"
      : "rgba(245, 158, 11, 0.18)";
  } else {
    icon = "";
    statusText = "UNKNOWN";
    statusColor = "#6b7280";
    bgColor = "rgba(107, 114, 128, 0.08)";
  }

  return `
    <div style="
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 6px 8px;
      background: ${bgColor};
      border-radius: 4px;
      border: 1px solid ${statusColor}20;
    ">
      <span style="
        color: ${statusColor};
        font-weight: 700;
        font-size: 16px;
        line-height: 1;
        min-width: 16px;
        text-align: center;
      ">${icon || '•'}</span>
      <span style="
          font-weight: 600;
          color: ${theme === "dark" ? "#e5e7eb" : "#1f2937"};
          font-size: 12px;
        ">${statusText != "MISSING" ? time : ''}</span>
        <span style="
          font-size: 10px;
          font-weight: 600;
          color: ${statusColor};
          text-transform: uppercase;
          letter-spacing: 0.3px;
        ">${statusText}</span>
    </div>
  `;
}

function refreshLogsDropdownTheme() {
  const dropdown = document.getElementById("keka-logs-dropdown");
  if (!dropdown) return;

  const theme = getCurrentTheme();
  const colors = themeColors[theme];

  dropdown.style.background =
    theme === "dark"
      ? "linear-gradient(180deg, rgba(15, 23, 42, 0.95), rgba(15, 23, 42, 0.88))"
      : "linear-gradient(180deg, rgba(255,255,255,0.95), rgba(255,255,255,0.88))";

  dropdown.style.border = colors.border;

  // Re-render logs so cells re-pick colors
  updateLogsDropdown(cachedAttendanceLogs);
}


/* ========= Main Update Logic ========= */

async function updateAllDisplays(forceRefresh = false) {
  // Show loading state only if we need to fetch
  const needsFetch =
    forceRefresh ||
    !cachedAttendanceLogs ||
    !lastFetchTime ||
    Date.now() - lastFetchTime > 300000;

  if (needsFetch && navbarChipElement) {
    const checkinSpan = navbarChipElement.querySelector("#chip-checkin");
    const effectiveSpan = navbarChipElement.querySelector("#chip-effective");
    const grossSpan = navbarChipElement.querySelector("#chip-gross");
    const breakSpan = navbarChipElement.querySelector("#chip-break");
    const checkoutSpan = navbarChipElement.querySelector("#chip-checkout");

    if (checkinSpan) checkinSpan.textContent = "⏳";
    if (effectiveSpan) effectiveSpan.textContent = "⏳";
    if (grossSpan) grossSpan.textContent = "⏳";
    if (breakSpan) breakSpan.textContent = "⏳";
    if (checkoutSpan) checkoutSpan.textContent = "⏳";
  }

  // Fetch logs (this handles caching internally now)
  try {
    await fetchAttendanceLogsFromApi(forceRefresh);
  } catch (error) {
    console.error("❌ Failed to fetch attendance logs:", error);

    // Show error state
    if (navbarChipElement) {
      const checkinSpan = navbarChipElement.querySelector("#chip-checkin");
      const effectiveSpan = navbarChipElement.querySelector("#chip-effective");
      const grossSpan = navbarChipElement.querySelector("#chip-gross");
      const breakSpan = navbarChipElement.querySelector("#chip-break");
      const checkoutSpan = navbarChipElement.querySelector("#chip-checkout");

      if (checkinSpan) checkinSpan.textContent = "⚠️";
      if (effectiveSpan) effectiveSpan.textContent = "⚠️";
      if (grossSpan) grossSpan.textContent = "⚠️";
      if (breakSpan) breakSpan.textContent = "⚠️";
      if (checkoutSpan) checkoutSpan.textContent = "⚠️";

      navbarChipElement.title =
        "Failed to fetch attendance logs. Click refresh to retry.";
    }
    return;
  }

  if (!cachedAttendanceLogs) {
    return;
  }

  // Calculate metrics from cached data
  const metrics = calculateMetricsFromApiLogs(cachedAttendanceLogs);

  // Initialize ONLY if timer not started yet
  if (lastTickTs === null) {
    runningGrossMs = metrics.grossMs;
    runningEffectiveMs = metrics.effectiveMs;
    lastTickTs = Date.now();
  }

  // Update dropdown with fresh logs
  updateLogsDropdown(cachedAttendanceLogs);

  const isPunchedIn = await fetchClockInStatus();
  isCurrentlyPunchedIn = isPunchedIn;

  // Update navbar chip
  updateNavbarChip({
    grossMs: runningGrossMs,
    effectiveMs: runningEffectiveMs,
    breakMs: Math.max(0, runningGrossMs - runningEffectiveMs),
    expectedCheckout: metrics.expectedCheckout,
    isPunchedIn,
  });
  updateProfilePunchBadge(isPunchedIn);

  // Check for notification
  maybeNotifyIfDone(metrics, isPunchedIn);
}

/* ========= Core calculation helpers ========= */

function msToHms(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return { h, m, s };
}

function calculateProgressFromFulfilledMs(fulfilledMs) {
  const totalWorkMinutes = getCurrentTotalWorkMinutes();
  const { h, m, s } = msToHms(fulfilledMs);
  const completion =
    fulfilledMs >= totalWorkMinutes * 60000
      ? 100
      : Math.floor((fulfilledMs / (60000 * totalWorkMinutes)) * 100);

  const fulfilledMinutes = h * 60 + m;
  const remainingMinutes = Math.max(0, totalWorkMinutes - fulfilledMinutes);
  const remainingMs = Math.max(0, remainingMinutes * 60000 - s * 1000);
  const remaining = msToHms(remainingMs);
  return {
    timeRemaining: formatTime(remaining.h, remaining.m, remaining.s),
    hoursFulfilled: formatTime(h, m, s),
    completionPercentage: completion,
    fulfilledMinutes,
    remainingMinutes,
    remainingSeconds: s,
  };
}

/* ========= Notification helper ========= */

function requestNotificationPermissionIfNeeded() {
  if (typeof Notification === "undefined") return Promise.resolve(false);
  if (Notification.permission === "granted") return Promise.resolve(true);
  if (Notification.permission === "denied") return Promise.resolve(false);
  return Notification.requestPermission().then((p) => p === "granted");
}

function maybeNotifyIfDone(metrics, isPunchedIn) {
  if (!isPunchedIn) {
    notificationSentForSession = false;
    return;
  }

  if (!currentSettings.isNotificationEnabled) return;
  if (notificationSentForSession) return;

  const totalWorkMs = getCurrentTotalWorkMinutes() * 60000;

  const completed = currentSettings.isBreakTimeIncludedInWorkingHours
    ? metrics.grossMs >= totalWorkMs
    : metrics.effectiveMs >= totalWorkMs;

  if (!completed) return;

  requestNotificationPermissionIfNeeded().then((granted) => {
    if (!granted) return;

    chrome.runtime.sendMessage({
      action: "SHOW_NOTIFICATION",
      title: "Work hours completed 🎉",
      body: "You’ve completed your work time. It's time to leave 🏡.",
    });

    notificationSentForSession = true;
  });
}

/* ========= Theme & Format Listeners ========= */
let lastTheme = getCurrentTheme();

function startThemeWatcher() {
  setInterval(() => {
    const currentTheme = getCurrentTheme();
    if (currentTheme !== lastTheme) {
      lastTheme = currentTheme;

      // applyThemeToDisplay();
      applyThemeToNavbarChip();
      refreshLogsDropdownTheme();
      applyThemeToPolicy();
    }
  }, 500);
}

function setupThemeChangeListener() {
  const themeObserver = new MutationObserver(() => {
    // applyThemeToDisplay();
    applyThemeToNavbarChip();
    refreshLogsDropdownTheme();
  });

  const themeContainer = document.querySelector(".toggle-theme-container");
  if (themeContainer) {
    themeObserver.observe(themeContainer, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

function setupFormatToggleObserver() {
  const observer = new MutationObserver(() => {
    check24HourFormatToggle();
    updateAllDisplays();
  });

  function setupObserverAttempt() {
    const toggle = document.querySelector(
      '#isFeatureEnabled[name="isFeatureEnabled"]'
    );
    if (toggle) {
      observer.observe(toggle, {
        attributes: true,
        attributeFilter: ["checked"],
      });
      if (toggle.parentElement) {
        observer.observe(toggle.parentElement, {
          childList: true,
          subtree: true,
        });
      }
    }
  }

  setupObserverAttempt();
  const interval = setInterval(() => {
    const toggle = document.querySelector(
      '#isFeatureEnabled[name="isFeatureEnabled"]'
    );
    if (toggle) {
      setupObserverAttempt();
      clearInterval(interval);
    }
  }, 2000);
}

function check24HourFormatToggle() {
  try {
    const toggle = document.querySelector(
      '#isFeatureEnabled[name="isFeatureEnabled"]'
    );
    if (toggle) {
      is24HourFormatEnabled = toggle.checked;
      return toggle.checked;
    }
  } catch (e) { }
  return false;
}

/* ========= Utilities ========= */

function isAttendanceLogsPage() {
  return !!document.querySelector(".attendance-logs-row");
}

function ensureTimerIsRunning() {
  if (window.timeUpdateInterval) return;

  function tick() {
    if (!lastTickTs) {
      lastTickTs = Date.now();
      scheduleNextTick();
      return;
    }

    if (!cachedAttendanceLogs || cachedAttendanceLogs.length === 0) {
      scheduleNextTick();
      return;
    }

    const now = Date.now();
    const delta = now - lastTickTs;
    lastTickTs = now;

    if (isCurrentlyPunchedIn) {
      runningGrossMs += delta;
      runningEffectiveMs += delta;
    }

    updateNavbarChip({
      grossMs: runningGrossMs,
      effectiveMs: runningEffectiveMs,
      breakMs: Math.max(0, runningGrossMs - runningEffectiveMs),
      expectedCheckout: cachedAttendanceLogs
        ? calculateMetricsFromApiLogs(cachedAttendanceLogs).expectedCheckout
        : "--",
      isPunchedIn: isCurrentlyPunchedIn,
    });

    maybeNotifyIfDone(
      {
        grossMs: runningGrossMs,
        effectiveMs: runningEffectiveMs,
      },
      isCurrentlyPunchedIn
    );
    scheduleNextTick();
  }

  function scheduleNextTick() {
    const delay = 1000 - (Date.now() % 1000);
    window.timeUpdateInterval = setTimeout(tick, delay);
  }

  if (lastTickTs === null) {
    lastTickTs = Date.now();
  }
  tick();
}

/* ========= Storage & Settings ========= */

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(defaultSettings, function (settings) {
      currentSettings = settings;
      resolve({ settings, usingCustomSettings: settings.useCustomSettings });
    });
  });
}

chrome.storage.onChanged.addListener(function (changes, namespace) {
  if (namespace !== "sync") return;
  Object.keys(changes).forEach(
    (k) => (currentSettings[k] = changes[k].newValue)
  );

  // DON'T invalidate cache on settings change - just recalculate with existing data

  // Just update displays with existing cached data
  if (cachedAttendanceLogs) {
    const metrics = calculateMetricsFromApiLogs(cachedAttendanceLogs);
    updateNavbarChip(metrics);
  }
});

/* ========= URL Monitor & Initialization ========= */

function setUpUrlChangeMonitor() {
  if (window.urlChangeMonitorActive) {
    return;
  }

  window.urlChangeMonitorActive = true;
  let lastUrl = location.href;

  if (!window.urlObserver) {
    window.urlObserver = new MutationObserver(() => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;

        setTimeout(() => {
          if (!isInitialized) {
            initializeExtension();
          } else {
            ensureTimerIsRunning();
            insertNavbarChip();
            // Use cached data, don't refetch
            if (cachedAttendanceLogs) {
              const metrics = calculateMetricsFromApiLogs(cachedAttendanceLogs);
              updateNavbarChip(metrics);
            }
          }
        }, 1000);
      }
    });
    window.urlObserver.observe(document, { subtree: true, childList: true });
  }
}

/* ========= Attendance Policy Feature ========= */

// --- Globals ---
let policyIconElement = null;
let policyPanelElement = null;
let policyPanelVisible = false;

// --- API Fetchers ---
async function fetchAttendancePolicyFromApi() {
  try {
    const token = localStorage.getItem("access_token");
    const res = await fetch(
      "/k/attendance/api/mytime/attendance/trackingpolicy",
      {
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.succeeded ? json.data : null;
  } catch (e) {
    return null;
  }
}

async function fetchAttendanceCaptureSchemeFromApi() {
  try {
    const token = localStorage.getItem("access_token");
    const res = await fetch(
      "/k/attendance/api/mytime/attendance/attendancecapturescheme",
      {
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.succeeded ? json.data : null;
  } catch (e) {
    return null;
  }
}

async function fetchLeavePlanFromApi() {
  try {
    const token = localStorage.getItem("access_token");
    const res = await fetch(
      "/k/attendance/api/mytime/attendance/leaveplan",
      {
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json.succeeded ? json.data : null;
  } catch (e) {
    return null;
  }
}

// --- Leave Name Map ---
function buildLeaveNameMap(leaveplanData) {
  const map = {};
  if (!leaveplanData || !leaveplanData.configuration) return map;
  leaveplanData.configuration.forEach((c) => {
    if (c.leaveType) map[c.leaveType.id] = c.leaveType.name;
  });
  return map;
}

// --- Diff Computation ---
function extractTrackedFields(policy, leaveNameMap) {
  const p = policy.penaltyConfiguration;
  const leaveNames = (ids) =>
    (ids || []).map((id) => leaveNameMap[id] || `ID:${id}`).join(" → ");

  return {
    noAttendance: {
      daysDeducted: p.noAttendance.daysToBeDeducted,
      bufferDays: p.noAttendance.minGapDaysToDeduct,
      leaveOrder: leaveNames(p.noAttendance.leaveTypeIds),
    },
    lateArrival: {
      gracePeriodMin: p.lateArrival.lateToleranceInMinutes,
      allowedPerWeek: p.lateArrival.maxAllowedDays?.duration ?? 0,
      incidentsBeforePenalty: p.lateArrival.noofInstances,
      daysDeducted: p.lateArrival.daysToBeDeducted,
      bufferDays: p.lateArrival.minGapDaysToDeduct,
      leaveOrder: leaveNames(p.lateArrival.leaveTypeIds),
    },
    workHours: {
      deductionTiers: JSON.stringify(
        (p.workHours.attendanceDeductionRules || []).map((r) => ({
          pct: r.requiredPercentage,
          days: r.daysToBeDeducted,
        }))
      ),
      leaveOrder: leaveNames(p.workHours.leaveTypeIds),
    },
    missingSwipes: {
      allowedPerWeek: p.missingSwipes.maxAllowedDays?.duration ?? 0,
      daysDeducted: p.missingSwipes.daysToBeDeducted,
      effectiveHoursPct: p.missingSwipes.desiredHoursPercentageToIgnoreMissingSwipes,
      bufferDays: p.missingSwipes.minGapDaysToDeduct,
      leaveOrder: leaveNames(p.missingSwipes.leaveTypeIds),
    },
    effectiveFrom: policy.effectiveFrom,
  };
}

function extractTrackedFieldsTimeTracking(schemeData) {
  const ac = schemeData.configuration.attendanceCapture;
  const reg = schemeData.configuration.regularisation;
  return {
    tt: {
      maxAdjustments: ac.maxAllowedMissingSwipeAdjustments,
      adjustmentPastDays: ac.adjustmentPastDatedRestriction?.numberOfDays ?? 0,
      adjustmentRequiresApproval: ac.missingSwipeAdjustmentApprovalSettings?.requireApproval,
      partialDayAllowed: reg.allowPartialDay,
      partialDayLimit: reg.partialDayRequestsLimit,
      lateArrivalMax: reg.lateArrivalConfiguration?.maxMinutes ?? 0,
      earlyLeavingMax: reg.earlyLeavingConfiguration?.maxMinutes ?? 0,
      partialDayPastRestrictionDay: reg.partialDayPastDatedRestriction?.dayOfTheMonth ?? 0,
      partialDayRequiresApproval: reg.approvalSettings?.requireApproval,
    },
  };
}

// Duration unit code → label
function durationUnitLabel(unit) {
  const map = { 1: "Day", 2: "Week", 3: "Week", 4: "Month", 5: "Year" };
  return map[unit] || "Period";
}

const TRACKED_LABELS = {
  // Penalisation Policy
  "noAttendance.daysDeducted": ["No Attendance", "Days deducted per absence"],
  "noAttendance.bufferDays": ["No Attendance", "Buffer period (days)"],
  "noAttendance.leaveOrder": ["No Attendance", "Deduction order"],
  "lateArrival.gracePeriodMin": ["Late Arrival", "Grace period (minutes)"],
  "lateArrival.allowedPerWeek": ["Late Arrival", "Allowed late arrivals/week"],
  "lateArrival.incidentsBeforePenalty": ["Late Arrival", "Free incidents/week"],
  "lateArrival.daysDeducted": ["Late Arrival", "Days deducted per incident"],
  "lateArrival.bufferDays": ["Late Arrival", "Buffer period (days)"],
  "lateArrival.leaveOrder": ["Late Arrival", "Deduction order"],
  "workHours.deductionTiers": ["Work Hours", "Deduction tiers"],
  "workHours.leaveOrder": ["Work Hours", "Deduction order"],
  "missingSwipes.allowedPerWeek": ["Missing Swipes", "Allowed missing/week"],
  "missingSwipes.daysDeducted": ["Missing Swipes", "Days deducted"],
  "missingSwipes.effectiveHoursPct": ["Missing Swipes", "Effective hours % to ignore penalty"],
  "missingSwipes.bufferDays": ["Missing Swipes", "Buffer period (days)"],
  "missingSwipes.leaveOrder": ["Missing Swipes", "Deduction order"],
  "effectiveFrom": ["Policy", "Effective from"],
  // Time Tracking Policy
  "tt.maxAdjustments": ["Regularization", "Max adjustments allowed"],
  "tt.adjustmentPastDays": ["Regularization", "Past days allowed for adjustment"],
  "tt.adjustmentRequiresApproval": ["Regularization", "Approval required for adjustment"],
  "tt.partialDayAllowed": ["Partial Day", "Partial day requests allowed"],
  "tt.partialDayLimit": ["Partial Day", "Instances allowed per period"],
  "tt.lateArrivalMax": ["Partial Day", "Late arrival max (minutes)"],
  "tt.earlyLeavingMax": ["Partial Day", "Early leaving max (minutes)"],
  "tt.partialDayPastRestrictionDay": ["Partial Day", "Cannot request past dated after day"],
  "tt.partialDayRequiresApproval": ["Partial Day", "Approval required"],
};

function computePolicyDiff(oldFields, newFields) {
  const diff = [];
  function compare(oldObj, newObj, prefix) {
    for (const key of Object.keys(newObj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof newObj[key] === "object" && newObj[key] !== null) {
        compare(oldObj?.[key] || {}, newObj[key], fullKey);
      } else {
        const oldVal = oldObj?.[key];
        const newVal = newObj[key];
        if (String(oldVal) !== String(newVal) && TRACKED_LABELS[fullKey]) {
          const [section, label] = TRACKED_LABELS[fullKey];
          diff.push({ section, label, old: oldVal, new: newVal });
        }
      }
    }
  }
  compare(oldFields, newFields, "");
  return diff;
}

// --- Format helpers ---
function formatPolicyDate(dateStr) {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch (e) {
    return dateStr;
  }
}

function daysAgo(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (diff === 0) return "today";
    if (diff === 1) return "1 day ago";
    return `${diff} days ago`;
  } catch (e) {
    return "";
  }
}

// --- Blink animation injection ---
function injectPolicyStyles() {
  if (document.getElementById("keka-policy-styles")) return;
  const style = document.createElement("style");
  style.id = "keka-policy-styles";
  style.textContent = `
    @keyframes keka-policy-blink {
      0%, 100% { transform: scale(1); }
      50%       { transform: scale(1.25); }
    }
    #keka-policy-icon .policy-unread-dot {
      display: none;
      position: absolute;
      top: 0px;
      right: 0px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #fbbf24;
      border: 1.5px solid rgba(0,0,0,0.3);
    }
    #keka-policy-icon.policy-unread .policy-unread-dot {
      display: block;
      animation: keka-policy-blink 1.6s ease-in-out infinite;
    }
    nav.navbar form.ml-40 {
      margin-left: 20px !important;
    }
    #keka-policy-panel {
      scrollbar-width: thin;
      scrollbar-color: rgba(100,195,209,0.4) transparent;
    }
    #keka-policy-panel::-webkit-scrollbar { width: 4px; }
    #keka-policy-panel::-webkit-scrollbar-thumb {
      background: rgba(100,195,209,0.4);
      border-radius: 4px;
    }
    .keka-policy-card {
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .keka-policy-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      padding: 3px 0;
      font-size: 12px;
      line-height: 1.5;
    }
    .keka-policy-key {
      opacity: 0.65;
      flex-shrink: 0;
      max-width: 55%;
    }
    .keka-policy-val {
      font-weight: 600;
      text-align: right;
    }
    .keka-policy-section-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.5;
      margin-bottom: 6px;
    }
  `;
  document.head.appendChild(style);
}

// --- Policy Icon ---
function createPolicyIcon() {
  if (policyIconElement) return policyIconElement;
  injectPolicyStyles();

  // Outer wrapper — mirrors Keka's <a class="lh-sm position-relative d-inline-block">
  const wrapper = document.createElement("a");
  wrapper.id = "keka-policy-icon";
  wrapper.className = "lh-sm position-relative d-inline-block mr-16 mt-1";
  wrapper.style.cursor = "pointer";

  // Icon — mirrors <span class="ki ki-bell ki-lg text-white on-hover-bg-opacity border-radius-2">
  const iconSpan = document.createElement("span");
  iconSpan.className = "ki ki-note-with-lines ki-lg text-white on-hover-bg-opacity border-radius-2";

  // Tooltip — positioned below, matching Keka's native tooltip style
  const tooltip = document.createElement("span");
  tooltip.textContent = "Attendance Policy";
  tooltip.style.cssText = `
    position: absolute;
    top: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(15,35,55,0.95);
    color: white;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    padding: 4px 8px;
    border-radius: 5px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s ease;
    z-index: 100000;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  `;

  const dot = document.createElement("span");
  dot.className = "policy-unread-dot";

  wrapper.appendChild(iconSpan);
  wrapper.appendChild(dot);
  wrapper.appendChild(tooltip);

  wrapper.addEventListener("mouseenter", () => { tooltip.style.opacity = "1"; });
  wrapper.addEventListener("mouseleave", () => { tooltip.style.opacity = "0"; });
  wrapper.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePolicyPanel();
  });

  policyIconElement = wrapper;
  return wrapper;
}

// --- Policy Panel ---
function buildPenalisationTabHTML(policyData, diff, leaveNameMap, isDark) {
  const p = policyData.penaltyConfiguration;
  const cardBg = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
  const diffBg = isDark ? "rgba(251,191,36,0.12)" : "rgba(251,191,36,0.15)";
  const diffBorder = "rgba(251,191,36,0.5)";
  const textColor = isDark ? "white" : "#1a1a1a";
  const mutedColor = isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.5)";

  const leaveNames = (ids) =>
    (ids || []).map((id) => leaveNameMap[id] || `ID:${id}`).join(", ");

  const row = (label, value) => `
    <div class="keka-policy-row">
      <span class="keka-policy-key">${label}</span>
      <span class="keka-policy-val">${value ?? "—"}</span>
    </div>`;

  const card = (title, rows) => `
    <div class="keka-policy-card" style="background:${cardBg};">
      <div class="keka-policy-section-title" style="color:${textColor};">${title}</div>
      ${rows}
    </div>`;

  // Format a diff value — pretty-print JSON tier arrays, keep others as-is
  const fmtDiffVal = (val) => {
    if (val === null || val === undefined) return "—";
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) return "None";
        return parsed.map((t) => `< ${t.pct}% → ${t.days}d`).join(", ");
      }
    } catch (_) { }
    return String(val);
  };

  let diffHTML = "";
  if (diff && diff.length > 0) {
    const diffRows = diff.map((d) => `
      <div style="padding:5px 0;border-bottom:1px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)"};">
        <div style="font-size:11px;opacity:0.55;margin-bottom:3px;">
          <span style="text-transform:uppercase;letter-spacing:0.04em;">${d.section}</span> &middot; ${d.label}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;">
          <span style="text-decoration:line-through;opacity:0.45;color:${textColor};">${fmtDiffVal(d.old)}</span>
          <span style="opacity:0.4;font-size:10px;">→</span>
          <span style="color:#f59e0b;font-weight:600;">${fmtDiffVal(d.new)}</span>
        </div>
      </div>`).join("");
    diffHTML = `
      <div style="background:${diffBg};border-left:3px solid ${diffBorder};border-radius:6px;margin-bottom:10px;padding:10px 12px;">
        <div class="keka-policy-section-title" style="color:#f59e0b;margin-bottom:8px;opacity:1;">⚠️ What Changed</div>
        ${diffRows}
      </div>`;
  }

  const tiers = (p.workHours.attendanceDeductionRules || [])
    .map((r) => row(`< ${r.requiredPercentage}% of shift hours`, `${r.daysToBeDeducted} day(s) deducted`))
    .join("");

  return `
    ${diffHTML}
    ${card("🕐 Work Hours", [
    tiers || row("Deduction tiers", "None configured"),
    row("Deduction order", leaveNames(p.workHours.leaveTypeIds) || "—"),
    row("Buffer period", `${p.workHours.minGapDaysToDeduct} day(s)`),
  ].join(""))}
    ${card("⏰ Late Arrival", [
    row("Grace period", `${p.lateArrival.lateToleranceInMinutes} min`),
    row("Allowed late arrivals/week", `${p.lateArrival.maxAllowedDays?.duration ?? 0} time(s)`),
    row("Incidents before penalty", `${p.lateArrival.noofInstances}`),
    row("Days deducted per incident", `${p.lateArrival.daysToBeDeducted} day(s)`),
    row("Buffer period", `${p.lateArrival.minGapDaysToDeduct} day(s) to regularize`),
    row("Deduction order", leaveNames(p.lateArrival.leaveTypeIds) || "—"),
  ].join(""))}
    ${card("🚫 No Attendance", [
    row("Days deducted per absence", `${p.noAttendance.daysToBeDeducted} day(s)`),
    row("Buffer period", `${p.noAttendance.minGapDaysToDeduct} day(s) to regularize`),
    row("Deduction order", leaveNames(p.noAttendance.leaveTypeIds) || "—"),
    p.noAttendance.isMinimumHoursRequired
      ? (() => {
        const totalMins = Math.round(p.noAttendance.requiredHours * 60);
        const h = Math.floor(totalMins / 60);
        const m = totalMins % 60;
        const label = h && m ? `${h} hr ${m} min` : h ? `${h} hr` : `${m} min`;
        return row("Min. hours required", label);
      })()
      : "",
  ].join(""))}
    ${card("👆 Missing Swipes", [
    row("Allowed missing swipe days/week", `${p.missingSwipes.maxAllowedDays?.duration ?? 0} day(s)`),
    row("Days deducted per incident", `${p.missingSwipes.daysToBeDeducted} day(s)`),
    p.missingSwipes.ignoreMissingSwipes
      ? row("Ignore if effective hrs ≥", `${p.missingSwipes.desiredHoursPercentageToIgnoreMissingSwipes}%`)
      : "",
    row("Buffer period", `${p.missingSwipes.minGapDaysToDeduct} day(s) to regularize`),
    row("Deduction order", leaveNames(p.missingSwipes.leaveTypeIds) || "—"),
  ].join(""))}`;
}

function buildTimeTrackingTabHTML(schemeData, isDark) {
  if (!schemeData) return `<div style="opacity:0.5;font-size:12px;padding:12px 0;text-align:center;">No data available</div>`;

  const ac = schemeData.configuration.attendanceCapture;
  const reg = schemeData.configuration.regularisation;
  const cardBg = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
  const textColor = isDark ? "white" : "#1a1a1a";

  const row = (label, value) => `
    <div class="keka-policy-row">
      <span class="keka-policy-key">${label}</span>
      <span class="keka-policy-val">${value ?? "—"}</span>
    </div>`;

  const card = (title, rows) => `
    <div class="keka-policy-card" style="background:${cardBg};">
      <div class="keka-policy-section-title" style="color:${textColor};">${title}</div>
      ${rows}
    </div>`;

  const yesNo = (val) => val ? "Yes" : "No";

  // Partial day duration label
  const pdDuration = durationUnitLabel(reg.partialDayRequestsDuration);

  // Adjustment past-dated restriction
  const adjPast = ac.adjustmentPastDatedRestriction;
  const adjPastLabel = adjPast?.hasRestriction
    ? `${adjPast.numberOfDays} day(s)`
    : "No restriction";

  // Partial day past restriction
  const pdPast = reg.partialDayPastDatedRestriction;
  const pdPastLabel = pdPast?.hasRestriction && pdPast?.dayOfTheMonth > 0
    ? `Not after ${pdPast.dayOfTheMonth}${pdPast.dayOfTheMonth === 28 ? "th" : "th"} of month`
    : "Allowed anytime";

  return `
    ${card("📝 Regularization", [
    ac.allowMissingSwipeAdjustment
      ? row("Max adjustments allowed", `${ac.maxAllowedMissingSwipeAdjustments} time(s) per ${durationUnitLabel(ac.maxAllowedMissingSwipeAdjustmentDuration)}`)
      : row("Attendance adjustment", "Not allowed"),
    row("Past adjustment window", adjPastLabel),
    row("Approval required", yesNo(ac.missingSwipeAdjustmentApprovalSettings?.requireApproval)),
  ].join(""))}
    ${reg.allowPartialDay ? card("🕑 Partial Day", [
    row("Instances allowed", `${reg.partialDayRequestsLimit} per ${pdDuration}`),
    reg.lateArrivalConfiguration?.allowRequest
      ? row("Late arrival request", `Up to ${reg.lateArrivalConfiguration.maxMinutes} min/instance`)
      : "",
    reg.earlyLeavingConfiguration?.allowRequest
      ? row("Early leaving request", `Up to ${reg.earlyLeavingConfiguration.maxMinutes} min/instance`)
      : "",
    row("Past dated requests", reg.allowPastDatedPartialDayRequests ? pdPastLabel : "Not allowed"),
    row("Approval required", yesNo(reg.approvalSettings?.requireApproval)),
  ].join("")) : card("🕑 Partial Day", row("Partial day requests", "Not allowed"))}`;
}

function buildPolicyPanelHTML(policyData, diff, leaveNameMap, schemeData) {
  const theme = getCurrentTheme();
  const isDark = theme === "dark";
  const textColor = isDark ? "white" : "#1a1a1a";
  const borderColor = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)";
  const tabActiveBg = isDark ? "rgba(100,195,209,0.2)" : "rgba(100,195,209,0.15)";
  const tabInactiveBg = "transparent";
  const tabActiveColor = "#64c3d1";
  const tabInactiveColor = isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.4)";

  const penHTML = buildPenalisationTabHTML(policyData, diff, leaveNameMap, isDark);
  const ttHTML = buildTimeTrackingTabHTML(schemeData, isDark);

  return `
    <div style="color:${textColor};font-size:12px;">
      <!-- Header -->
      <div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid ${borderColor};">
        <div style="font-weight:700;font-size:13px;margin-bottom:3px;">📋 Attendance Policy</div>
        <div style="opacity:0.8;font-size:11px;">
          Effective: ${formatPolicyDate(policyData.effectiveFrom)}
          ${policyData.updatedOn ? ` · Updated ${daysAgo(policyData.updatedOn)}` : ""}
        </div>
      </div>

      <!-- Tabs -->
      <div style="display:flex;gap:4px;margin-bottom:10px;">
        <button id="keka-tab-pen" data-keka-tab="pen" style="
          flex:1;padding:5px 0;border:none;border-radius:6px;cursor:pointer;
          font-size:11px;font-weight:600;letter-spacing:0.03em;
          background:${tabActiveBg};color:${tabActiveColor};
          transition:background 0.2s,color 0.2s;
        ">Penalisation</button>
        <button id="keka-tab-tt" data-keka-tab="tt" style="
          flex:1;padding:5px 0;border:none;border-radius:6px;cursor:pointer;
          font-size:11px;font-weight:600;letter-spacing:0.03em;
          background:${tabInactiveBg};color:${tabInactiveColor};
          transition:background 0.2s,color 0.2s;
        ">Time Tracking</button>
      </div>

      <!-- Tab content -->
      <div id="keka-tabcontent-pen">${penHTML}</div>
      <div id="keka-tabcontent-tt" style="display:none;">${ttHTML}</div>
    </div>`;
}

// Tab switcher — called via event delegation (data-keka-tab), CSP-safe
function kekaShowTab(tab) {
  const pen = document.getElementById("keka-tabcontent-pen");
  const tt = document.getElementById("keka-tabcontent-tt");
  const btnPen = document.getElementById("keka-tab-pen");
  const btnTt = document.getElementById("keka-tab-tt");
  if (!pen || !tt) return;

  const isDark = getCurrentTheme() === "dark";
  const activeBg = isDark ? "rgba(100,195,209,0.2)" : "rgba(100,195,209,0.15)";
  const inactiveColor = isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.4)";

  if (tab === "pen") {
    pen.style.display = "";
    tt.style.display = "none";
    btnPen.style.background = activeBg;
    btnPen.style.color = "#64c3d1";
    btnTt.style.background = "transparent";
    btnTt.style.color = inactiveColor;
  } else {
    pen.style.display = "none";
    tt.style.display = "";
    btnTt.style.background = activeBg;
    btnTt.style.color = "#64c3d1";
    btnPen.style.background = "transparent";
    btnPen.style.color = inactiveColor;
  }
};

function createPolicyPanel(policyData, diff, leaveNameMap, schemeData) {
  if (policyPanelElement) {
    policyPanelElement.innerHTML = buildPolicyPanelHTML(policyData, diff, leaveNameMap, schemeData);
    return policyPanelElement;
  }

  const theme = getCurrentTheme();
  const isDark = theme === "dark";
  const fontFamily = getKekaFontFamily();

  const panel = document.createElement("div");
  panel.id = "keka-policy-panel";
  panel.style.cssText = `
    position: fixed;
    top: 60px;
    right: 16px;
    width: 340px;
    max-height: 480px;
    overflow-y: auto;
    background: ${isDark ? "rgba(10,29,44,0.97)" : "rgba(245,247,249,0.98)"};
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid ${isDark ? "rgba(100,195,209,0.2)" : "rgba(0,0,0,0.1)"};
    border-radius: 14px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.1);
    padding: 14px 16px;
    z-index: 99999;
    font-family: ${fontFamily};
    display: none;
  `;

  panel.innerHTML = buildPolicyPanelHTML(policyData, diff, leaveNameMap, schemeData);
  document.body.appendChild(panel);

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (
      policyPanelVisible &&
      !panel.contains(e.target) &&
      e.target !== policyIconElement &&
      !policyIconElement?.contains(e.target)
    ) {
      hidePolicyPanel();
    }
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && policyPanelVisible) hidePolicyPanel();
  });

  // Tab click via event delegation (CSP-safe — no inline onclick)
  panel.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-keka-tab]");
    if (btn) kekaShowTab(btn.dataset.kekaTab);
  });

  policyPanelElement = panel;
  return panel;
}

function showPolicyPanel() {
  if (!policyPanelElement) return;
  policyPanelElement.style.display = "block";
  policyPanelVisible = true;

  // Clear unread state
  policyIconElement?.classList.remove("policy-unread");
  chrome.storage.local.set({ keka_policy_unread: false });
}

function hidePolicyPanel() {
  if (!policyPanelElement) return;
  policyPanelElement.style.display = "none";
  policyPanelVisible = false;
}

function togglePolicyPanel() {
  if (policyPanelVisible) {
    hidePolicyPanel();
  } else {
    showPolicyPanel();
  }
}

// --- Icon insertion ---
function insertPolicyIcon(onInserted) {
  if (policyIconElement && document.getElementById("keka-policy-icon")) {
    onInserted?.();
    return;
  }

  // Target: the notification bell anchor — insert our icon just before its parent dropdown div
  const bellAnchor = document.querySelector('a[title="Notifications"]');
  if (!bellAnchor) {
    setTimeout(() => insertPolicyIcon(onInserted), 800);
    return;
  }

  const notifDropdown = bellAnchor.closest(".dropdown");
  if (!notifDropdown) {
    setTimeout(() => insertPolicyIcon(onInserted), 800);
    return;
  }

  const icon = createPolicyIcon();
  notifDropdown.parentElement.insertBefore(icon, notifDropdown);
  onInserted?.();
}

// --- Main init ---
async function initAttendancePolicy() {
  // Check if policy icon is enabled in settings (default: true)
  const syncSettings = await new Promise(resolve =>
    chrome.storage.sync.get({ showPolicyIcon: true }, resolve)
  );
  if (!syncSettings.showPolicyIcon) {
    // Remove icon if it was previously inserted
    const existingIcon = document.getElementById("keka-policy-icon");
    if (existingIcon) existingIcon.remove();
    policyIconElement = null;
    return;
  }

  try {
    const [policyData, leaveplanData, schemeData] = await Promise.all([
      fetchAttendancePolicyFromApi(),
      fetchLeavePlanFromApi(),
      fetchAttendanceCaptureSchemeFromApi(),
    ]);

    if (!policyData) return;

    const leaveNameMap = buildLeaveNameMap(leaveplanData);

    const newFields = {
      ...extractTrackedFields(policyData, leaveNameMap),
      ...(schemeData ? extractTrackedFieldsTimeTracking(schemeData) : {}),
    };

    // Load stored snapshot
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get(
        ["keka_attendance_policy", "keka_policy_diff", "keka_policy_unread"],
        resolve
      )
    );

    let diff = stored.keka_policy_diff || [];
    let isUnread = stored.keka_policy_unread || false;

    const storedPolicy = stored.keka_attendance_policy;
    const schemeChanged =
      schemeData && stored.keka_attendance_scheme?.identifier !== schemeData.identifier;
    const versionChanged =
      !storedPolicy ||
      storedPolicy.versionIdentifier !== policyData.versionIdentifier ||
      schemeChanged;

    if (versionChanged) {
      const hasPreviousPolicy = !!storedPolicy;
      const hasPreviousScheme = !!stored.keka_attendance_scheme;

      const oldPolicyFields = hasPreviousPolicy
        ? extractTrackedFields(storedPolicy, leaveNameMap)
        : null;
      // Only include scheme diff when we have a previous scheme snapshot to compare against
      const oldSchemeFields = hasPreviousScheme && schemeData
        ? extractTrackedFieldsTimeTracking(stored.keka_attendance_scheme)
        : null;

      const oldFields = oldPolicyFields
        ? { ...oldPolicyFields, ...(oldSchemeFields || {}) }
        : null;

      // Only include scheme fields in newFields when we have a baseline to diff against
      const newFieldsForDiff = {
        ...extractTrackedFields(policyData, leaveNameMap),
        ...(oldSchemeFields && schemeData
          ? extractTrackedFieldsTimeTracking(schemeData)
          : {}),
      };

      diff = oldFields ? computePolicyDiff(oldFields, newFieldsForDiff) : [];
      isUnread = hasPreviousPolicy && diff.length > 0;

      chrome.storage.local.set({
        keka_attendance_policy: policyData,
        keka_attendance_scheme: schemeData,
        keka_policy_diff: diff,
        keka_policy_unread: isUnread,
        keka_leave_name_map: leaveNameMap,
      });
    }

    // Always persist latest maps (names/scheme may update without version bump)
    chrome.storage.local.set({
      keka_leave_name_map: leaveNameMap,
      keka_attendance_scheme: schemeData,
    });

    // Insert icon, then apply blink if unread
    insertPolicyIcon(() => {
      if (isUnread && policyIconElement) {
        policyIconElement.classList.add("policy-unread");
      }
    });

    // Build / refresh panel
    createPolicyPanel(policyData, diff, leaveNameMap, schemeData);
  } catch (e) {
    // Silently fail — policy is a non-critical enhancement
  }
}

function initializeExtension() {
  // Use both flags to prevent re-initialization
  if (isInitialized || window.extensionInitialized) {
    return;
  }

  isInitialized = true;
  window.extensionInitialized = true;

  loadSettings().then(() => {
    // setupThemeChangeListener();  // not working
    startThemeWatcher();
    check24HourFormatToggle();
    setupFormatToggleObserver();
    insertNavbarChip();
    initAttendancePolicy();

    setUpUrlChangeMonitor();
    updateAllDisplays(true).then(() => {
      ensureTimerIsRunning();
    });
    setInterval(check24HourFormatToggle, 5000);
  });
}

/* ========= Event Listeners ========= */

document.addEventListener("DOMContentLoaded", () => {
  initializeExtension();
});

window.addEventListener("load", () => {
  initializeExtension();
});

// Initialize immediately if DOM is already loaded
if (
  document.readyState === "complete" ||
  document.readyState === "interactive"
) {
  setTimeout(() => {
    initializeExtension();
  }, 100);
}

/* ========= Chrome Message Handlers ========= */

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (!isInitialized) {
    initializeExtension();
  }

  ensureTimerIsRunning();

  if (request.action === "getTimeRemaining") {
    if (cachedAttendanceLogs) {
      const metrics = calculateMetricsFromApiLogs(cachedAttendanceLogs);
      const progress = calculateProgressFromFulfilledMs(metrics.effectiveMs);
      sendResponse(progress);
    } else {
      fetchAttendanceLogsFromApi(false).then((logs) => {
        const metrics = calculateMetricsFromApiLogs(logs || []);
        const progress = calculateProgressFromFulfilledMs(metrics.effectiveMs);
        sendResponse(progress);
      });
    }
    return true;
  } else if (request.action === "autoFetchData") {
    updateAllDisplays(true).then(() => {
      sendResponse({ success: true, dataRefreshed: true });
    });
    return true;
  } else if (request.action === "ensureTimerRunning") {
    ensureTimerIsRunning();
    if (cachedAttendanceLogs) {
      const metrics = calculateMetricsFromApiLogs(cachedAttendanceLogs);
      updateNavbarChip(metrics);
    }
    sendResponse({ success: true });
    return true;
  } else if (request.action === "settingsUpdated") {
    if (request.settings) {
      currentSettings = { ...currentSettings, ...request.settings };
      // Recalculate with existing cache
      if (cachedAttendanceLogs) {
        const metrics = calculateMetricsFromApiLogs(cachedAttendanceLogs);
        updateNavbarChip(metrics);
      }
      // Handle policy icon visibility toggle
      if (typeof request.settings.showPolicyIcon === "boolean") {
        if (request.settings.showPolicyIcon) {
          // Re-initialize if toggled on
          initAttendancePolicy();
        } else {
          // Remove icon and panel immediately
          const existingIcon = document.getElementById("keka-policy-icon");
          if (existingIcon) existingIcon.remove();
          policyIconElement = null;
          if (policyPanelElement) {
            policyPanelElement.remove();
            policyPanelElement = null;
            policyPanelVisible = false;
          }
        }
      }
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "No settings provided" });
    }
    return true;
  }
});
