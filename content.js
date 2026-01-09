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
      expectedCheckout: "Not punched in",
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

  let expectedCheckout = "Not punched in";

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

  // Profile image container (this is stable in Keka)
  const img = document.querySelector(
    "employee-profile-picture img.profile-picture"
  );

  if (!img) return;

  const container = img.parentElement;
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

    // Clear cache and force refresh
    cachedAttendanceLogs = null;
    lastFetchTime = null;

    lastTickTs = null;
    runningEffectiveMs = 0;
    runningGrossMs = 0;

    await updateAllDisplays(true);

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

  // Initialize running timers
  runningGrossMs = metrics.grossMs;
  runningEffectiveMs = metrics.effectiveMs;
  lastTickTs = Date.now();

  // Update dropdown with fresh logs
  updateLogsDropdown(cachedAttendanceLogs);

  const isPunchedIn = await fetchClockInStatus();

  // Update navbar chip
  updateNavbarChip({ ...metrics, isPunchedIn });
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
    if (!lastTickTs || !cachedAttendanceLogs) {
      scheduleNextTick();
      return;
    }

    const now = Date.now();
    const delta = now - lastTickTs;
    lastTickTs = now;

    // Gross always increases
    runningGrossMs += delta;

    // Effective increases only when punched in
    const isPunchedIn = cachedAttendanceLogs.some(
      (l) => l.punchStatus === 0
    );

    if (isPunchedIn) {
      runningEffectiveMs += delta;
    }

    updateNavbarChip({
      grossMs: runningGrossMs,
      effectiveMs: runningEffectiveMs,
      breakMs: Math.max(0, runningGrossMs - runningEffectiveMs),
      expectedCheckout: cachedAttendanceLogs
        ? calculateMetricsFromApiLogs(cachedAttendanceLogs).expectedCheckout
        : "--",
      isPunchedIn
    });

    maybeNotifyIfDone({
      grossMs: runningGrossMs,
      effectiveMs: runningEffectiveMs
    }, isPunchedIn);
    scheduleNextTick();
  }

  function scheduleNextTick() {
    const delay = 1000 - (Date.now() % 1000);
    window.timeUpdateInterval = setTimeout(tick, delay);
  }

  lastTickTs = Date.now();
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

    setUpUrlChangeMonitor();
    ensureTimerIsRunning();
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
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "No settings provided" });
    }
    return true;
  }
});
