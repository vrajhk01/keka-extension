// Default settings
const defaultSettings = {
  useCustomSettings: true,
  workHours: 8,
  workMinutes: 30,
  isBreakTimeIncludedInWorkingHours: false,
  isNotificationEnabled: true
};

// Current settings (will be loaded from storage)
let currentSettings = { ...defaultSettings };
let isEditingDuration = false;

document.addEventListener("DOMContentLoaded", function () {
  // Establish a connection with the background script
  const port = chrome.runtime.connect({ name: "popup" });

  // Load settings
  loadSettings();

  // Set up event listeners for settings UI
  setupSettingsUI();

  handleWelcomeScreen();

  // Query the active tab to send a message to the content script
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const activeTab = tabs[0];
    const statusElement = document.getElementById("status");

    // Check if we're on a Keka domain
    if (activeTab && activeTab.url && activeTab.url.includes("keka.com")) {
      statusElement.textContent = "Connected to Keka";
      statusElement.style.backgroundColor = "#e3f6f7";
    } else {
      statusElement.textContent =
        "Please navigate to Keka to use this extension.";
      statusElement.style.backgroundColor = "#ffe8e6";
      statusElement.style.color = "#d9534f";
    }
  });

  const githubRepoUrl = "https://github.com/vrajhk01/keka-extension";

  document
    .getElementById("githubLinkWelcome")
    ?.addEventListener("click", () => {
      chrome.tabs.create({ url: githubRepoUrl });
    });

  document
    .getElementById("githubLinkSettings")
    ?.addEventListener("click", () => {
      chrome.tabs.create({ url: githubRepoUrl });
    });

});

// Load settings from storage
function loadSettings() {
  chrome.storage.sync.get(defaultSettings, function (settings) {
    currentSettings = settings;

    // Update UI with loaded settings
    document.getElementById("workHours").value = settings.workHours;
    document.getElementById("workMinutes").value = settings.workMinutes;
    document.getElementById("isBreakTimeIncludedInWorkingHours").checked =
      settings.isBreakTimeIncludedInWorkingHours !== false;
    document.getElementById("isNotificationEnabled").checked =
      settings.isNotificationEnabled !== false;
  });
}

function handleWelcomeScreen() {
  const welcomeScreen = document.getElementById("welcomeScreen");
  const settingsPanel = document.getElementById("settingsPanel");
  const continueBtn = document.getElementById("continueBtn");

  chrome.storage.sync.get(["welcomeSeen"], ({ welcomeSeen }) => {
    if (welcomeSeen) {
      welcomeScreen.style.display = "none";
      settingsPanel.style.display = "block";
    } else {
      welcomeScreen.style.display = "block";
      settingsPanel.style.display = "none";
    }
  });

  continueBtn?.addEventListener("click", () => {
    chrome.storage.sync.set({ welcomeSeen: true }, () => {
      welcomeScreen.style.display = "none";
      settingsPanel.style.display = "block";
    });
  });
}


// Toggle edit mode for duration inputs
function toggleEditMode() {
  isEditingDuration = !isEditingDuration;

  const hoursInput = document.getElementById("workHours");
  const minutesInput = document.getElementById("workMinutes");
  const editIcon = document.getElementById("editDurationIcon");

  if (isEditingDuration) {
    // Enable editing - show checkmark
    hoursInput.disabled = false;
    minutesInput.disabled = false;
    editIcon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
    hoursInput.focus();
  } else {
    // Disable editing - show pencil
    hoursInput.disabled = true;
    minutesInput.disabled = true;
    editIcon.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64c3d1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
      </svg>
    `;
  }
}

// Save settings to storage
function saveSettings() {
  // Get input values
  const workHoursInput = document.getElementById("workHours").value;
  const workMinutesInput = document.getElementById("workMinutes").value;
  const isBreakTimeIncludedInWorkingHours = document.getElementById("isBreakTimeIncludedInWorkingHours").checked;
  const isNotificationEnabled = document.getElementById("isNotificationEnabled").checked;

  // Parse input values
  const workHours =
    workHoursInput === "" || isNaN(parseInt(workHoursInput))
      ? defaultSettings.workHours
      : parseInt(workHoursInput);

  const workMinutes =
    workMinutesInput === "" || isNaN(parseInt(workMinutesInput))
      ? defaultSettings.workMinutes
      : parseInt(workMinutesInput);

  const settings = {
    useCustomSettings: true,
    workHours,
    workMinutes,
    isBreakTimeIncludedInWorkingHours,
    isNotificationEnabled
  };

  // Validate work hours and minutes
  if (settings.workHours < 0 || settings.workHours > 12) {
    settings.workHours = defaultSettings.workHours;
  }

  if (settings.workMinutes < 0 || settings.workMinutes > 59) {
    settings.workMinutes = defaultSettings.workMinutes;
  }

  // Show saving animation on the button
  const saveButton = document.getElementById("saveSettings");
  const originalText = saveButton.textContent;
  saveButton.textContent = "Saving...";
  saveButton.disabled = true;
  saveButton.style.backgroundColor = "#aaa";

  // Save to Chrome storage
  chrome.storage.sync.set(settings, function () {
    // Update input fields with the actual saved values
    document.getElementById("workHours").value = settings.workHours;
    document.getElementById("workMinutes").value = settings.workMinutes;

    // Exit edit mode after saving
    if (isEditingDuration) {
      toggleEditMode();
    }

    // Show brief success message
    const status = document.getElementById("status");
    status.textContent = "Settings saved!";
    status.style.backgroundColor = "#e3f6f7";

    // Send message to content script to immediately update the display
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs[0] && tabs[0].url.includes("keka.com")) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          {
            action: "settingsUpdated",
            settings: settings,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.log(
                "Failed to send settings update:",
                chrome.runtime.lastError.message
              );
            } else {
              console.log("Settings updated successfully:", response);
            }
          }
        );
      }
    });

    // Reset button after short delay
    setTimeout(function () {
      saveButton.textContent = originalText;
      saveButton.disabled = false;
      saveButton.style.backgroundColor = "#64c3d1";

      // Reset status message
      setTimeout(function () {
        status.textContent = "Connected to Keka";
      }, 1000);
    }, 500);
  });
}

// Set up event listeners for settings UI
function setupSettingsUI() {
  // Save button
  document
    .getElementById("saveSettings")
    .addEventListener("click", saveSettings);

  // Edit duration icon click
  document
    .getElementById("editDurationIcon")
    .addEventListener("click", toggleEditMode);

  // Add input validation for hours and minutes
  document.getElementById("workHours").addEventListener("input", function () {
    if (this.value > 12) this.value = 12;
    if (this.value < 0) this.value = 0;
  });

  document.getElementById("workMinutes").addEventListener("input", function () {
    if (this.value > 59) this.value = 59;
    if (this.value < 0) this.value = 0;
  });

  // Allow Enter key to toggle edit mode or save
  document.getElementById("workHours").addEventListener("keypress", function (e) {
    if (e.key === "Enter") {
      saveSettings();
    }
  });

  document.getElementById("workMinutes").addEventListener("keypress", function (e) {
    if (e.key === "Enter") {
      saveSettings();
    }
  });
}