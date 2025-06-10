// Default settings
const defaultSettings = {
  useCustomSettings: false,
  workHours: 8,
  workMinutes: 30,
  showSeconds: true,  // Keep for backward compatibility
  showProgressBar: true  // Keep for backward compatibility
};

// Extension initialization

// Current settings (will be loaded from storage)
let currentSettings = { ...defaultSettings };

// Flag to track if 24-hour format is enabled in Keka
let is24HourFormatEnabled = false;

// Theme colors for light and dark modes
const themeColors = {
  dark: {
    background: 'rgb(10, 29, 44)',
    border: '1px solid rgb(20, 55, 82)',
    text: 'white',
    divider: 'rgb(20, 55, 82)',
    progressBg: 'rgba(100, 195, 209, 0.2)',
    progressFill: '#64c3d1',
    warningText: '#F5B153'
  },
  light: {
    background: '#f5f7f9',
    border: '1px solid #e0e4e8',
    text: '#333',
    divider: '#e0e4e8',
    progressBg: 'rgba(100, 195, 209, 0.15)',
    progressFill: '#64c3d1',
    warningText: '#e67e22'
  }
};

// Keka's font family
const kekaFontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

// Function to get Keka's font family from the page
function getKekaFontFamily() {
  try {
    // Try to get font-family from a Keka element
    const kekaElement = document.querySelector('.card-body') || document.querySelector('body');
    if (kekaElement) {
      const computedStyle = window.getComputedStyle(kekaElement);
      const fontFamily = computedStyle.getPropertyValue('font-family');
      if (fontFamily && fontFamily.length > 0) {
        return fontFamily;
      }
    }
  } catch (error) {
    // Fallback to default Keka font family if there's an error
  }
  
  // Return the default Keka font family if we couldn't get it from the page
  return kekaFontFamily;
}

// Function to get current theme
function getCurrentTheme() {
  try {
    // Check localStorage for ThemeMode
    const themeMode = localStorage.getItem('ThemeMode');
    if (themeMode === 'light') {
      return 'light';
    }
    
    // If we can't determine the theme or it's set to dark, default to dark
    return 'dark';
  } catch (error) {
    // If we can't access localStorage, default to dark theme
    return 'dark';
  }
}

// Function to apply theme to time display
function applyThemeToDisplay() {
  if (!timeDisplayElement) return;
  
  const theme = getCurrentTheme();
  const colors = themeColors[theme];
  const fontFamily = getKekaFontFamily();
  
  // Apply theme to container if in fallback position
  const isInFallbackPosition = timeDisplayElement.style.position === 'absolute';
  if (isInFallbackPosition) {
    timeDisplayElement.style.backgroundColor = colors.background;
    timeDisplayElement.style.border = colors.border;
    timeDisplayElement.style.color = colors.text;
  } else {
    // If integrated into Keka's UI, just set the text color
    timeDisplayElement.style.color = colors.text;
  }
  
  // Apply font family
  timeDisplayElement.style.fontFamily = fontFamily;
  
  // Update divider color
  const divider = timeDisplayElement.querySelector('div[style*="border-top"]');
  if (divider) {
    divider.style.borderTop = `1px solid ${colors.divider}`;
  }
  
  // Update warning text color
  const warningText = timeDisplayElement.querySelector('div[style*="color:"]');
  if (warningText && warningText.textContent.includes('Not punched in yet')) {
    warningText.style.color = colors.warningText;
  }
  
  // Update progress bar colors if present
  const progressBar = timeDisplayElement.querySelector('div[style*="background-color:"][style*="height: 4px"]');
  if (progressBar) {
    progressBar.style.backgroundColor = colors.progressBg;
    const progressFill = progressBar.querySelector('div');
    if (progressFill) {
      progressFill.style.backgroundColor = colors.progressFill;
    }
  }
  
  // Apply font styling to the content labels
  const contentContainer = timeDisplayElement.querySelector('.time-content');
  if (contentContainer) {
    const labels = contentContainer.querySelectorAll('span');
    labels.forEach(label => {
      label.style.paddingRight = '5px'; // Add a little spacing
    });
  }
}

// Watch for theme changes
function setupThemeChangeListener() {
  // Create a MutationObserver to watch for class changes on body or theme-related elements
  const themeObserver = new MutationObserver(() => {
    applyThemeToDisplay();
  });
  
  // Watch for theme toggle switches
  const themeSwitch = document.getElementById('themeSwitch');
  if (themeSwitch) {
    themeSwitch.addEventListener('change', () => {
      // Wait a moment for the theme change to apply
      setTimeout(applyThemeToDisplay, 100);
    });
  }
  
  // Watch for storage changes
  window.addEventListener('storage', (event) => {
    if (event.key === 'ThemeMode') {
      applyThemeToDisplay();
    }
  });
  
  // Observe theme-related containers
  const themeContainer = document.querySelector('.toggle-theme-container');
  if (themeContainer) {
    themeObserver.observe(themeContainer, { 
      attributes: true, 
      childList: true, 
      subtree: true 
    });
  }
  
  // Also observe body in case theme changes are reflected there
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });
}

// Load settings from storage
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(defaultSettings, function(settings) {
      // Update our current settings
      currentSettings = settings;
      
      // Return whether custom settings are enabled
      resolve({
        settings,
        usingCustomSettings: settings.useCustomSettings
      });
    });
  });
}

// Calculate total work minutes from settings
function getTotalWorkMinutes() {
  return (currentSettings.workHours * 60) + currentSettings.workMinutes;
}

// Format time based on settings
function formatTime(hours, minutes, seconds) {
  if (currentSettings.showSeconds) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  } else {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }
}

// Format time with AM/PM based on 24-hour format setting
function formatTimeWithAmPm(hours, minutes, seconds) {
  // Check for 24-hour format preference
  if (is24HourFormatEnabled) {
    // Use 24-hour format
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  } else {
    // Use 12-hour format with AM/PM
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const formattedHours = hours % 12 || 12;
    return `${formattedHours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} ${ampm}`;
  }
}

// Function to extract shift timing information without opening the dropdown
function extractShiftTimings() {
  try {
    // Get all attendance log rows
    const attendanceRows = document.querySelectorAll('.dropdown.attendance-logs-row');
    if (!attendanceRows || attendanceRows.length === 0) {
      return null;
    }
    
    // Always prioritize finding today's row first
    let todayRow = null;
    
    // Check each row to find today's row
    for (let i = 0; i < attendanceRows.length; i++) {
      const row = attendanceRows[i];
      if (checkIfTodayRow(row)) {
        todayRow = row;
        break;
      }
    }
    
    // If we couldn't find today's row explicitly, just use the first row
    // as it's likely the most recent (today's) row
    if (!todayRow && attendanceRows.length > 0) {
      todayRow = attendanceRows[0];
      
      // Extra check: if it's clearly not today (e.g., labeled as "Yesterday"), 
      // don't use it and just show "Not punched in"
      const rowText = todayRow.textContent || '';
      if (rowText.includes('Yesterday') || rowText.includes('yesterday')) {
        return {
          isToday: true,
          notPunchedIn: true
        };
      }
    }
    
    // If we found today's row, use it
    if (todayRow) {
      // Look for the dropdown content within this row, even if it's not currently visible
      // The important part is that it was loaded into the DOM at least once
      const dropdownContent = todayRow.querySelector('.dropdown-menu-logs');
      
      // Check if dropdown content exists in the DOM (even if hidden)
      if (dropdownContent) {
        // Extract timings from the dropdown in the DOM
        const dropdownData = extractTimingsFromDropdown(dropdownContent);
        if (dropdownData && (dropdownData.punches.length > 0 || dropdownData.lastPunchInTime)) {
          dropdownData.isToday = true;
          return dropdownData;
        }
      }
      
      // If we couldn't get data from the dropdown (it might not be loaded yet),
      // try to get data directly from the row
      const punchInInfo = getPunchInfoFromRow(todayRow);
      if (punchInInfo && punchInInfo.checkInTime) {
        // Add the today flag to the data
        punchInInfo.isToday = true;
        return punchInInfo;
      }
      
      // If we still couldn't get data, check for MISSING punch-out specifically
      // in the row's content even if dropdown is closed
      const hasMissingPunchOut = todayRow.textContent.includes('MISSING');
      
      // If we found MISSING text, try to extract the punch-in time
      if (hasMissingPunchOut) {
        // Try to find the punch-in time directly in the row
        // This is a special case for when the dropdown is not loaded but we can see there's a MISSING punch-out
        const punchInTime = extractPunchInTimeFromRow(todayRow);
        
        if (punchInTime) {
          return {
            isToday: true,
            hasMissingPunchOut: true,
            lastPunchInTime: punchInTime,
            punches: [{ type: 'in', time: punchInTime }],
            checkInTime: punchInTime
          };
        }
      }
      
      // If we couldn't get any data but it's today's row, return data showing not punched in
      return {
        isToday: true,
        notPunchedIn: true
      };
    }
    
    // If we couldn't find today's row, but want to show something for the current day anyway
    return {
      isToday: true,
      notPunchedIn: true
    };
  } catch (error) {
    return null;
  }
}

// Try to extract punch-in time directly from a row (without open dropdown)
function extractPunchInTimeFromRow(row) {
  try {
    // Look for the expanded dropdown within the row
    const openDropdown = row.querySelector('.dropdown-menu-logs');
    if (openDropdown) {
      // If dropdown is present, try to extract from there first
      const punchElements = openDropdown.querySelectorAll('.d-flex.mt-10');
      for (const element of punchElements) {
        if (element.textContent.includes('MISSING')) {
          // This is the element with MISSING punch-out, look for the punch-in time
          const timeMatches = element.textContent.match(/(\d+:\d+:\d+\s*[AP]M)/i);
          if (timeMatches) {
            return timeMatches[1];
          }
        }
      }
    }
    
    // If we couldn't find from dropdown or it's not open,
    // try looking for time patterns in the entire row text
    const rowText = row.textContent || '';
    
    // Look for patterns that indicate punch-in time with MISSING punch-out
    // First check specific patterns like "10:49:52 AM" ... "MISSING"
    const timeWithMissingMatch = rowText.match(/(\d+:\d+:\d+\s*[AP]M).*?MISSING/i);
    if (timeWithMissingMatch) {
      return timeWithMissingMatch[1];
    }
    
    // If specific pattern not found, just look for any time in the row
    const anyTimeMatch = rowText.match(/(\d+:\d+:\d+\s*[AP]M)/i);
    if (anyTimeMatch) {
      return anyTimeMatch[1];
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// Function to extract timings from the dropdown
function extractTimingsFromDropdown(dropdownElement) {
  try {
    // If no dropdown element provided, look for it in the DOM (even if hidden)
    const openDropdown = dropdownElement || document.querySelector('.dropdown-menu-logs');
    if (!openDropdown) {
      return null;
    }
    
    // Look for specific pattern that has both punch-in and punch-out times
    // Based on the DOM structure provided
    const punchPairs = openDropdown.querySelectorAll('.d-flex.mt-10');
    if (!punchPairs || punchPairs.length === 0) {
      return null;
    } else {
    }
    
    let punches = [];
    let hasMissingPunchOut = false;
    let lastPunchInTime = null;
    
    // Extract all punch times from the dropdown
    punchPairs.forEach((element, index) => {
      // Check if this row contains a MISSING punch-out
      const elementText = element.textContent || '';
      const hasMissing = elementText.includes('MISSING');
      if (hasMissing) {
        hasMissingPunchOut = true;
      }
      
      // In the DOM structure provided, we have a specific pattern:
      // - First span with ki-arrow-forward ki-green is the punch-in indicator
      // - First span with ki-arrow-forward ki-red is the punch-out indicator
      // - The spans immediately following these contain the actual times
      
      // Look for punch-in time (first span after green arrow)
      const punchInElement = element.querySelector('.ki-arrow-forward.ki-green + span, span.text-green');
      if (punchInElement) {
        const timeText = punchInElement.textContent.trim();
        
        if (timeText && !timeText.includes('MISSING')) {
          punches.push({
            type: 'in',
            time: timeText
          });
          
          // If we have a MISSING punch-out, store this as the last punch-in time
          if (hasMissing) {
            lastPunchInTime = timeText;
          }
        }
      }
      
      // Look for punch-out time (first span after red arrow)
      const punchOutElement = element.querySelector('.ki-arrow-forward.ki-red + span, span.text-red');
      if (punchOutElement) {
        const timeText = punchOutElement.textContent.trim();
        
        if (timeText && !timeText.includes('MISSING')) {
          punches.push({
            type: 'out',
            time: timeText
          });
        }
      }
    });
    
    // If we couldn't find any punches with the precise selectors,
    // fall back to a more generic approach looking for time patterns in text
    if (punches.length === 0) {
      // Scan the entire dropdown content for time patterns
      const dropdownText = openDropdown.textContent || '';
      
      // Check for MISSING pattern
      if (dropdownText.includes('MISSING')) {
        hasMissingPunchOut = true;
        
        // Try to extract punch-in time associated with MISSING
        const missingContext = dropdownText.match(/(\d+:\d+:\d+\s*[AP]M).*?MISSING/i);
        if (missingContext) {
          lastPunchInTime = missingContext[1];
          
          punches.push({
            type: 'in',
            time: lastPunchInTime
          });
        }
      }
      
      // Extract all time values from the text
      const timeMatches = dropdownText.match(/(\d+:\d+:\d+\s*[AP]M)/gi);
      if (timeMatches) {
        // If we have exactly one time and MISSING, it's likely just a punch-in
        if (timeMatches.length === 1 && hasMissingPunchOut) {
          // Already added as punch-in above
        } 
        // Otherwise, try to determine in/out based on context
        else {
          for (let i = 0; i < timeMatches.length; i++) {
            const time = timeMatches[i];
            // Check if this time is already in our punches array
            const alreadyAdded = punches.some(p => p.time === time);
            
            if (!alreadyAdded) {
              // Try to determine if it's punch-in or punch-out based on context
              const beforeContext = dropdownText.substring(0, dropdownText.indexOf(time));
              const isIn = beforeContext.includes('IN') || 
                        beforeContext.lastIndexOf('green') > beforeContext.lastIndexOf('red');
                        
              punches.push({
                type: isIn ? 'in' : 'out',
                time: time
              });
            }
          }
        }
      }
    }
    
    // Sort punches by time to ensure they're in chronological order
    punches.sort((a, b) => {
      const timeA = parseTimeString(a.time);
      const timeB = parseTimeString(b.time);
      if (timeA && timeB) {
        return timeA - timeB;
      }
      return 0;
    });
    
    // Get the first punch-in time for calculating end time
    const firstPunchIn = punches.find(p => p.type === 'in');
    
    // If we have a MISSING punch-out but couldn't find the time in the punches array,
    // add the lastPunchInTime we found directly
    if (hasMissingPunchOut && lastPunchInTime && !punches.some(p => p.type === 'in')) {
      punches.push({
        type: 'in',
        time: lastPunchInTime
      });
    }
    
    return {
      punches: punches,
      checkInTime: firstPunchIn ? firstPunchIn.time : lastPunchInTime,
      hasMissingPunchOut: hasMissingPunchOut,
      lastPunchInTime: lastPunchInTime
    };
  } catch (error) {
    return null;
  }
}

// Check if a row represents today
function checkIfTodayRow(row) {
  // Get all text in the row
  const rowText = row.textContent || '';
  
  // Check for common indicators of today's row
  if (rowText.includes('Today') || rowText.includes('today')) {
    return true;
  }
  
  // Get today's date in various formats
  const today = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = months[today.getMonth()];
  const date = today.getDate();
  
  // Check for date formats like "Jun 09" or "9 Jun"
  if (rowText.includes(`${monthName} ${date.toString().padStart(2, '0')}`) || 
      rowText.includes(`${date} ${monthName}`)) {
    return true;
  }
  
  // Check date in numeric format (MM/DD or DD/MM)
  const monthNum = (today.getMonth() + 1).toString().padStart(2, '0');
  const dateNum = today.getDate().toString().padStart(2, '0');
  if (rowText.includes(`${monthNum}/${dateNum}`) || rowText.includes(`${dateNum}/${monthNum}`)) {
    return true;
  }
  
  // Check date in format like "09 Jun 2023" or "Jun 09, 2023"
  const year = today.getFullYear();
  if (rowText.includes(`${date.toString().padStart(2, '0')} ${monthName} ${year}`) || 
      rowText.includes(`${monthName} ${date.toString().padStart(2, '0')}, ${year}`)) {
    return true;
  }
  
  // Check for other variations like "09-Jun-2023" or "09/Jun/2023"
  if (rowText.includes(`${date.toString().padStart(2, '0')}-${monthName}`) || 
      rowText.includes(`${date.toString().padStart(2, '0')}/${monthName}`)) {
    return true;
  }
  
  // Look for specific date indicators in the row
  const dateIndicator = row.querySelector('.date-indicator, .today-indicator, [data-today="true"]');
  if (dateIndicator) {
    return true;
  }
  
  return false;
}

// Try to get punch info directly from the row without opening dropdown
function getPunchInfoFromRow(row) {
  try {
    // Check if there's any time information directly in the row
    // Some Keka UIs may show the punch time directly in the row
    const timeInfo = row.querySelector('.d-flex.align-items-center .w-50 span');
    if (timeInfo) {
      const timeText = timeInfo.textContent.trim();
      // If we have time info like "9h 30m" we can use it
      if (timeText && timeText.includes('h') && timeText.includes('m')) {
        // Extract hours and minutes
        const hoursMatch = timeText.match(/(\d+)h/);
        const minutesMatch = timeText.match(/(\d+)m/);
        
        const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
        const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
        
        // Calculate total time in HH:MM:SS format
        const hoursFulfilledText = formatTime(hours, minutes, 0);
        
        // Calculate completion percentage
        const totalHours = hours + (minutes / 60);
        const totalWorkMinutes = getTotalWorkMinutes();
        const completionPercentage = Math.min(Math.round((totalHours * 60 / totalWorkMinutes) * 100), 100);
        
        // For time remaining, we need to estimate based on total work time - current time
        const remainingMinutes = totalWorkMinutes - ((hours * 60) + minutes);
        const hoursRemaining = Math.max(0, Math.floor(remainingMinutes / 60));
        const minutesRemaining = Math.max(0, Math.floor(remainingMinutes % 60));
        const timeRemaining = formatTime(hoursRemaining, minutesRemaining, 0);
        
        return {
          directRowData: true,
          hoursFulfilled: hoursFulfilledText,
          timeRemaining: timeRemaining,
          completionPercentage: completionPercentage,
          checkInTime: "Found" // Just a placeholder to indicate we have data
        };
      }
    }
    
    // If we couldn't find direct time info, return null
    return null;
  } catch (error) {
    return null;
  }
}

// Parse time string to Date object
function parseTimeString(timeString) {
  try {
    if (!timeString) return null;
    
    // Clean up the time string
    let cleanTime = timeString.trim();
    
    // Match against various time formats (12-hour or 24-hour)
    let timeRegex = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|AM|PM)?/i;
    let match = cleanTime.match(timeRegex);
    
    if (!match) return null;
    
    let hours = parseInt(match[1], 10);
    let minutes = parseInt(match[2], 10);
    let seconds = match[3] ? parseInt(match[3], 10) : 0;
    let ampm = match[4] ? match[4].toLowerCase() : null;
    
    // Convert to 24-hour format if needed
    if (ampm) {
      if (ampm === 'pm' && hours < 12) {
        hours += 12;
      } else if (ampm === 'am' && hours === 12) {
        hours = 0;
      }
    }
    
    // Create a Date object for today with the specified time
    let now = new Date();
    let timeDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds);
    
    return timeDate;
  } catch (error) {
    return null;
  }
}

// Function to calculate time details
function calculateTimeDetails(timingsData) {
  try {
    // Get the latest work minutes from settings - we'll use this throughout the function
    const totalWorkMinutes = getTotalWorkMinutes();
    
    // If it's today but not punched in yet
    if (timingsData.isToday && timingsData.notPunchedIn) {
      const hours = Math.floor(totalWorkMinutes / 60);
      const minutes = totalWorkMinutes % 60;
      
      return {
        notPunchedIn: true,
        timeRemaining: formatTime(hours, minutes, 0),
        hoursFulfilled: formatTime(0, 0, 0),
        completionPercentage: 0,
        expectedLeaveTime: "Not punched in"
      };
    }
    
    // If direct row data is available, return it
    if (timingsData.directRowData) {
      // Calculate expected leave time
      const now = new Date();
      const fulfilledMinutes = timingsData.fulfilledMinutes || 0;
      const remainingMinutes = Math.max(0, totalWorkMinutes - fulfilledMinutes);
      
      let expectedLeaveTime = "Completed";
      if (remainingMinutes > 0) {
        const leaveTime = new Date(now.getTime() + (remainingMinutes * 60 * 1000));
        const hours = leaveTime.getHours();
        const minutes = leaveTime.getMinutes();
        const seconds = leaveTime.getSeconds();
        expectedLeaveTime = formatTimeWithAmPm(hours, minutes, seconds);
      }
      
      return {
        timeRemaining: timingsData.timeRemaining,
        hoursFulfilled: timingsData.hoursFulfilled,
        completionPercentage: timingsData.completionPercentage,
        expectedLeaveTime: expectedLeaveTime
      };
    }
    
    // If no timings data found, return null
    if (!timingsData) {
      return null;
    }
    
    // Handle case where we have MISSING punch-out but no punches array
    if (timingsData.hasMissingPunchOut && timingsData.lastPunchInTime && (!timingsData.punches || timingsData.punches.length === 0)) {
      const now = new Date();
      const punchInTime = parseTimeString(timingsData.lastPunchInTime);
      
      if (punchInTime && punchInTime < now) {
        // Calculate the time fulfilled as time from punch-in until now
        const totalFulfilledMs = now - punchInTime;
        
        // Calculate hours fulfilled
        const hoursFulfilled = totalFulfilledMs / (1000 * 60 * 60);
        
        // Format as HH:MM:SS
        const hoursElapsed = Math.floor(totalFulfilledMs / (1000 * 60 * 60));
        const minutesElapsed = Math.floor((totalFulfilledMs % (1000 * 60 * 60)) / (1000 * 60));
        const secondsElapsed = Math.floor((totalFulfilledMs % (1000 * 60)) / 1000);
        const hoursFulfilledText = formatTime(hoursElapsed, minutesElapsed, secondsElapsed);
        
        // Calculate completion percentage
        const completionPercentage = Math.min(Math.round((hoursFulfilled * 60 / totalWorkMinutes) * 100), 100);
        
        // Calculate remaining time
        const fulfilledMinutes = (hoursElapsed * 60) + minutesElapsed;
        const remainingMinutes = Math.max(0, totalWorkMinutes - fulfilledMinutes);
        const remainingMs = (remainingMinutes * 60 * 1000) - (secondsElapsed * 1000);
        
        // Convert to hours, minutes, seconds for display
        const hoursRemaining = Math.floor(remainingMs / (1000 * 60 * 60));
        const minutesRemaining = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
        const secondsRemaining = Math.floor((remainingMs % (1000 * 60)) / 1000);
        
        // Calculate expected leave time - use punch-in time + total work time for consistency
        let expectedLeaveTime = "Completed";
        if (remainingMinutes > 0 || secondsRemaining > 0) {
          // Calculate expected leave time based on punch-in time + work duration
          // This will stay consistent rather than constantly changing
          const totalWorkMs = totalWorkMinutes * 60 * 1000;
          const leaveTime = new Date(punchInTime.getTime() + totalWorkMs);
          const hours = leaveTime.getHours();
          const minutes = leaveTime.getMinutes();
          const seconds = leaveTime.getSeconds();
          expectedLeaveTime = formatTimeWithAmPm(hours, minutes, seconds);
        }
        
        // Format the time
        const timeRemaining = formatTime(hoursRemaining, minutesRemaining, secondsRemaining);
        
        return {
          timeRemaining,
          hoursFulfilled: hoursFulfilledText,
          completionPercentage,
          expectedLeaveTime
        };
      }
    }
    
    // If we have punches array but it's empty
    if (!timingsData.punches || timingsData.punches.length === 0) {
      return null;
    }
    
    const now = new Date();
    const punches = timingsData.punches;
    
    // Calculate total time fulfilled
    let totalFulfilledMs = 0;
    let inTime = null;
    let lastPunchInTime = null;
    let firstPunchInTime = null;
    let breakTimeMs = 0;
    
    // Process each punch in chronological order
    // We need pairs of punch-in followed by punch-out
    for (let i = 0; i < punches.length; i++) {
      const currentPunch = punches[i];
      
      if (currentPunch.type === 'in') {
        // If we find a punch-in, save it and look for the next punch-out
        inTime = parseTimeString(currentPunch.time);
        
        // Save the first punch-in time for expected checkout calculation
        if (!firstPunchInTime) {
          firstPunchInTime = inTime;
        }
        
        // Save the most recent punch-in time
        lastPunchInTime = inTime;
        
        // Calculate break time if this isn't the first punch-in
        if (i > 0 && punches[i-1].type === 'out') {
          const previousOutTime = parseTimeString(punches[i-1].time);
          if (previousOutTime && inTime) {
            breakTimeMs += (inTime - previousOutTime);
          }
        }
      } else if (currentPunch.type === 'out' && inTime) {
        // If we find a punch-out and we have a saved punch-in, calculate duration
        const outTime = parseTimeString(currentPunch.time);
        if (outTime && outTime > inTime) {
          const duration = outTime - inTime;
          totalFulfilledMs += duration;
        }
        // Reset inTime to null so we can find the next pair
        inTime = null;
      }
    }
    
    // If last punch was a punch-in, add time from then until now
    if (inTime && inTime < now) {
      totalFulfilledMs += (now - inTime);
    }
    
    // Calculate hours fulfilled
    const hoursFulfilled = totalFulfilledMs / (1000 * 60 * 60);
    
    // Format as HH:MM:SS
    const hoursElapsed = Math.floor(totalFulfilledMs / (1000 * 60 * 60));
    const minutesElapsed = Math.floor((totalFulfilledMs % (1000 * 60 * 60)) / (1000 * 60));
    const secondsElapsed = Math.floor((totalFulfilledMs % (1000 * 60)) / 1000);
    const hoursFulfilledText = formatTime(hoursElapsed, minutesElapsed, secondsElapsed);
    
    // Calculate completion percentage
    const completionPercentage = Math.min(Math.round((hoursFulfilled * 60 / totalWorkMinutes) * 100), 100);
    
    // Calculate remaining time based on settings
    let timeRemaining = formatTime(0, 0, 0);
    
    // Calculate expected leave time - this should be consistent based on punch-in time
    let expectedLeaveTime = "Completed";
    
    // If using custom settings, calculate directly from total work time
    if (currentSettings.useCustomSettings) {
      // Calculate how many minutes are left in the workday
      const fulfilledMinutes = (hoursElapsed * 60) + minutesElapsed;
      const remainingMinutes = Math.max(0, totalWorkMinutes - fulfilledMinutes);
      const remainingMs = (remainingMinutes * 60 * 1000) - (secondsElapsed * 1000);
      
      // Convert to hours, minutes, seconds for display
      const hoursRemaining = Math.floor(remainingMs / (1000 * 60 * 60));
      const minutesRemaining = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
      const secondsRemaining = Math.floor((remainingMs % (1000 * 60)) / 1000);
      
      // Format the time with seconds
      timeRemaining = formatTime(hoursRemaining, minutesRemaining, secondsRemaining);
      
      // Calculate expected leave time if still working - based on first punch-in time + breaks
      if (inTime && inTime < now && lastPunchInTime && (remainingMinutes > 0 || secondsRemaining > 0)) {
        // Calculate expected leave time based on first punch-in time + work duration + breaks
        const totalWorkMs = totalWorkMinutes * 60 * 1000;
        
        // Add break time to the expected leave time
        const leaveTime = new Date(firstPunchInTime.getTime() + totalWorkMs + breakTimeMs);
        const hours = leaveTime.getHours();
        const minutes = leaveTime.getMinutes();
        const seconds = leaveTime.getSeconds();
        expectedLeaveTime = formatTimeWithAmPm(hours, minutes, seconds);
      } else if (!inTime || inTime >= now) {
        expectedLeaveTime = "Not currently working";
      }
    } else {
      // For multiple punches, we need to calculate remaining time based on total hours worked
      const fulfilledMinutes = (hoursElapsed * 60) + minutesElapsed;
      const remainingMinutes = Math.max(0, totalWorkMinutes - fulfilledMinutes);
      const remainingMs = (remainingMinutes * 60 * 1000) - (secondsElapsed * 1000);
      
      // Convert to hours, minutes, seconds for display
      const hoursRemaining = Math.floor(remainingMs / (1000 * 60 * 60));
      const minutesRemaining = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
      const secondsRemaining = Math.floor((remainingMs % (1000 * 60)) / 1000);
      
      // Format the time with seconds
      timeRemaining = formatTime(hoursRemaining, minutesRemaining, secondsRemaining);
      
      // Calculate expected leave time if still working - based on first punch-in time + breaks
      if (inTime && inTime < now && firstPunchInTime && (remainingMinutes > 0 || secondsRemaining > 0)) {
        // Calculate expected leave time based on first punch-in time + work duration + breaks
        const totalWorkMs = totalWorkMinutes * 60 * 1000;
        
        // Add break time to the expected leave time
        const leaveTime = new Date(firstPunchInTime.getTime() + totalWorkMs + breakTimeMs);
        const hours = leaveTime.getHours();
        const minutes = leaveTime.getMinutes();
        const seconds = leaveTime.getSeconds();
        expectedLeaveTime = formatTimeWithAmPm(hours, minutes, seconds);
      } else if (!inTime || inTime >= now) {
        expectedLeaveTime = "Not currently working";
      }
    }
    
    return {
      timeRemaining,
      hoursFulfilled: hoursFulfilledText,
      completionPercentage,
      expectedLeaveTime
    };
  } catch (error) {
    return null;
  }
}

// Global variable to track the display element
let timeDisplayElement = null;

// Check if we're on the correct page and should show the display
function isAttendanceLogsPage() {
  // Check for the attendance logs table or row
  return !!document.querySelector('.attendance-logs-row');
}

// Update the time display and manage visibility
function updateTimeDisplay() {
  // Only proceed if we're on the attendance logs page
  if (!isAttendanceLogsPage()) {
    // If we have a display element but we're not on the logs page, remove it
    if (timeDisplayElement && timeDisplayElement.parentNode) {
      timeDisplayElement.parentNode.removeChild(timeDisplayElement);
      timeDisplayElement = null;
    }
    return;
  }
  
  // Extract the timings data
  const timingsData = extractShiftTimings();
  
  // If it's a promise, handle it accordingly
  if (timingsData && typeof timingsData.then === 'function') {
    timingsData.then(handleTimingsData);
  } else {
    // If it's not a promise, process it directly
    handleTimingsData(timingsData);
  }
  
  // Check and reposition the time display if needed
  checkAndRepositionTimeDisplay();
}

// Handle the timings data once we have it
function handleTimingsData(timings) {
  // Try to find the best container for our time display
  const actionsContainer = document.querySelector('employee-attendance-request-actions .card-body');
  const actionsCard = document.querySelector('employee-attendance-request-actions .card');
  
  // Get current theme
  const theme = getCurrentTheme();
  const colors = themeColors[theme];
  
  // Get Keka's font family
  const fontFamily = getKekaFontFamily();
  
  // If the timeDisplayElement already exists but is not in the correct container, remove it
  if (timeDisplayElement && actionsContainer && !actionsContainer.contains(timeDisplayElement) && document.body.contains(timeDisplayElement)) {
    document.body.removeChild(timeDisplayElement);
    timeDisplayElement = null;
  }
  
  if (!timeDisplayElement) {
    // Create a new element to display the time information
    timeDisplayElement = document.createElement('div');
    timeDisplayElement.classList.add('time-display-info');
    
    // Create a simple divider without the header
    timeDisplayElement.innerHTML = `
      <div style="border-top: 1px solid ${colors.divider}; margin: 10px 0px 12px;"></div>
      <div class="time-content"></div>
    `;
    
    // Style it to match Keka's design and current theme
    timeDisplayElement.style.color = colors.text;
    timeDisplayElement.style.fontFamily = fontFamily;
    timeDisplayElement.style.fontWeight = '400';
    timeDisplayElement.style.fontSize = '14px';
    timeDisplayElement.style.lineHeight = '1.4';
    timeDisplayElement.style.width = '100%';
    
    // Add it to the best available container
    if (actionsContainer) {
      // Check if we should insert as the last child or in a specific position
      actionsContainer.appendChild(timeDisplayElement);
    } else if (actionsCard) {
      // If we found the card but not the body, create a new card-body and add our element
      const newCardBody = document.createElement('div');
      newCardBody.className = 'card-body';
      newCardBody.style.paddingTop = '0';
      newCardBody.appendChild(timeDisplayElement);
      actionsCard.appendChild(newCardBody);
    } else {
      // Fall back to old method if the proper container isn't found
      timeDisplayElement.style.position = 'absolute';
      timeDisplayElement.style.top = '235px';
      timeDisplayElement.style.right = '235px';
      timeDisplayElement.style.zIndex = '2';
      timeDisplayElement.style.width = 'auto';
      timeDisplayElement.style.backgroundColor = colors.background;
      timeDisplayElement.style.border = colors.border;
      timeDisplayElement.style.padding = '10px';
      timeDisplayElement.style.borderRadius = '3px';
      document.body.appendChild(timeDisplayElement);
    }
    
    // Apply theme styling
    applyThemeToDisplay();
  }
  
  // Get the content container
  const contentContainer = timeDisplayElement.querySelector('.time-content');
  if (!contentContainer) return;
  
  if (timings && timings.needsUserClick) {
    contentContainer.textContent = 'Click row to view time details';
  } else if (timings && timings.notPunchedIn && timings.isToday) {
    // Get the total work time in minutes
    const totalWorkMinutes = getTotalWorkMinutes();
    const hours = Math.floor(totalWorkMinutes / 60);
    const minutes = totalWorkMinutes % 60;
    
    contentContainer.innerHTML = `
      <div style="color: ${colors.warningText};">Not punched in yet</div>
      <div style="display: flex; justify-content: space-between;">
        <div><span>Time Completed:</span> ${formatTime(0, 0, 0)}</div>
        <div><span>Time Remaining:</span> ${formatTime(hours, minutes, 0)}</div>
      </div>
      <div><span>Expected Checkout:</span> Not punched in</div>
      <div><span>Completion:</span> 0%</div>
    `;
  } else if (timings && (timings.checkInTime || timings.directRowData)) {
    const timeDetails = calculateTimeDetails(timings);
    
    if (timeDetails) {
      let content = `
        <div style="display: flex; justify-content: space-between;">
          <div><span>Time Completed:</span> ${timeDetails.hoursFulfilled}</div>
          <div><span>Time Remaining:</span> ${timeDetails.timeRemaining}</div>
        </div>
        <div><span>Expected Checkout:</span> ${timeDetails.expectedLeaveTime || 'N/A'}</div>
        <div><span>Completion:</span> ${timeDetails.completionPercentage}%</div>
      `;
      
      // Add progress bar if enabled
      if (currentSettings.showProgressBar) {
        content += `
          <div style="margin-top: 5px; background-color: ${colors.progressBg}; height: 4px; border-radius: 2px;">
            <div style="width: ${timeDetails.completionPercentage}%; height: 100%; background-color: ${colors.progressFill}; border-radius: 2px;"></div>
          </div>
        `;
      }
      
      contentContainer.innerHTML = content;
    } else {
      contentContainer.textContent = 'Unable to calculate time';
    }
  } else {
    contentContainer.textContent = 'No time data available';
  }
  
  // Apply font styling to the content labels
  const labels = contentContainer.querySelectorAll('span');
  labels.forEach(label => {
    label.style.paddingRight = '5px'; // Add a little spacing
  });
  
  // Apply theme styling to newly added content
  applyThemeToDisplay();
}

// Function to check and reposition the time display if needed
function checkAndRepositionTimeDisplay() {
  if (!timeDisplayElement) return;
  
  // Try to find the best container for our time display
  const actionsContainer = document.querySelector('employee-attendance-request-actions .card-body');
  const actionsCard = document.querySelector('employee-attendance-request-actions .card');
  
  // Get current theme
  const theme = getCurrentTheme();
  const colors = themeColors[theme];
  
  // Get Keka's font family
  const fontFamily = getKekaFontFamily();
  
  // If the timeDisplayElement is not in the correct container, reposition it
  if (actionsContainer && !actionsContainer.contains(timeDisplayElement)) {
    // If it's in the document body, remove it
    if (document.body.contains(timeDisplayElement)) {
      document.body.removeChild(timeDisplayElement);
    }
    
    // Preserve the content
    const content = timeDisplayElement.innerHTML;
    
    // Reset styles to fit inside the card
    timeDisplayElement.style.position = '';
    timeDisplayElement.style.top = '';
    timeDisplayElement.style.right = '';
    timeDisplayElement.style.zIndex = '';
    timeDisplayElement.style.backgroundColor = '';
    timeDisplayElement.style.border = '';
    timeDisplayElement.style.padding = '';
    timeDisplayElement.style.borderRadius = '';
    timeDisplayElement.style.width = '100%';
    timeDisplayElement.style.color = colors.text;
    timeDisplayElement.style.fontFamily = fontFamily;
    
    // Restore the content
    timeDisplayElement.innerHTML = content;
    
    // Add it to the actions container
    actionsContainer.appendChild(timeDisplayElement);
    
    // Ensure we have the divider and time-content div
    if (!timeDisplayElement.querySelector('.time-content')) {
      // Create a simple divider without the header
      timeDisplayElement.innerHTML = `
        <div style="border-top: 1px solid ${colors.divider}; margin: 15px 0 10px 0;"></div>
        <div class="time-content"></div>
      `;
      
      // Force an update to populate the content
      setTimeout(updateTimeDisplay, 100);
    }
    
    // Apply theme
    applyThemeToDisplay();
  } else if (actionsCard && !document.body.contains(timeDisplayElement) && !actionsContainer) {
    // If we found the card but not the body, create a new card-body and add our element
    const newCardBody = document.createElement('div');
    newCardBody.className = 'card-body';
    newCardBody.style.paddingTop = '0';
    
    // Preserve the content
    const content = timeDisplayElement.innerHTML;
    
    // Reset styles
    timeDisplayElement.style.position = '';
    timeDisplayElement.style.top = '';
    timeDisplayElement.style.right = '';
    timeDisplayElement.style.zIndex = '';
    timeDisplayElement.style.backgroundColor = '';
    timeDisplayElement.style.border = '';
    timeDisplayElement.style.padding = '';
    timeDisplayElement.style.borderRadius = '';
    timeDisplayElement.style.width = '100%';
    timeDisplayElement.style.color = colors.text;
    timeDisplayElement.style.fontFamily = fontFamily;
    
    // Restore the content
    timeDisplayElement.innerHTML = content;
    
    // Ensure we have the divider and time-content div
    if (!timeDisplayElement.querySelector('.time-content')) {
      // Create a simple divider without the header
      timeDisplayElement.innerHTML = `
        <div style="border-top: 1px solid ${colors.divider}; margin: 15px 0 10px 0;"></div>
        <div class="time-content"></div>
      `;
    }
    
    newCardBody.appendChild(timeDisplayElement);
    actionsCard.appendChild(newCardBody);
    
    // Force an update to populate the content
    setTimeout(updateTimeDisplay, 100);
    
    // Apply theme
    applyThemeToDisplay();
  } else {
    // Element is already in the correct place, just ensure theme is applied
    applyThemeToDisplay();
  }
}

// Function to ensure the timer is running
function ensureTimerIsRunning() {
  if (!window.timeUpdateInterval) {
    window.timeUpdateInterval = setInterval(updateTimeDisplay, 1000);
  }
}

// Listen for settings changes in storage
chrome.storage.onChanged.addListener(function(changes, namespace) {
  if (namespace === 'sync') {
    // Update our current settings
    for (let key in changes) {
      currentSettings[key] = changes[key].newValue;
    }
    
    // Force a refresh of the data
    const isDataRefreshed = triggerDropdownLoading();
    
    // Update the display with new settings
    setTimeout(() => {
      updateTimeDisplay();
    }, isDataRefreshed ? 800 : 100);
  }
});

// Function to set up URL change monitor
function setUpUrlChangeMonitor() {
  // Only set up once
  if (window.urlChangeMonitorActive) return;
  window.urlChangeMonitorActive = true;
  
  // Watch for page URL changes (for single-page applications)
  let lastUrl = location.href;
  
  // Create observer if it doesn't exist
  if (!window.urlObserver) {
    window.urlObserver = new MutationObserver(() => {
      if (lastUrl !== location.href) {
        lastUrl = location.href;
        
        // URL changed, check if we need to show/hide the display
        setTimeout(() => {
          if (isAttendanceLogsPage()) {
            // We're on the attendance page, ensure the timer is running
            ensureTimerIsRunning();
            updateTimeDisplay();
          }
        }, 1000);
      }
    });
    
    // Start observing
    window.urlObserver.observe(document, {subtree: true, childList: true});
  }
}

// Initialize the time display when the content script loads
function initializeTimeDisplay() {
  // If we already have a timer running, no need to initialize again
  if (window.timeUpdateInterval) {
    return;
  }
  
  // Load settings first
  loadSettings().then((result) => {
    // Set up theme change listener
    setupThemeChangeListener();
    
    // Check for 24-hour format toggle
    check24HourFormatToggle();
    
    // Set up a mutation observer to detect changes to the 24-hour format toggle
    setupFormatToggleObserver();
    
    // Initial time display update with fully loaded settings
    updateTimeDisplay();
    
    // Set up URL change monitor
    setUpUrlChangeMonitor();
    
    // Set up periodic updates and ensure it's running in a global context
    ensureTimerIsRunning();
    
    // Also periodically check the 24-hour format toggle
    setInterval(check24HourFormatToggle, 5000);
  });
}

// Set up observer for 24-hour format toggle changes
function setupFormatToggleObserver() {
  // Create a mutation observer to watch for changes to the toggle
  const observer = new MutationObserver((mutations) => {
    // Check for mutations that might affect the toggle
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes' || mutation.type === 'childList') {
        // Re-check the toggle state
        check24HourFormatToggle();
        // Update the display
        updateTimeDisplay();
      }
    });
  });
  
  // Function to set up the observer
  function setupObserver() {
    // Try to find the 24-hour format toggle
    const formatToggle = document.querySelector('#isFeatureEnabled[name="isFeatureEnabled"]');
    if (formatToggle) {
      // Observe the toggle element for changes
      observer.observe(formatToggle, { 
        attributes: true,
        attributeFilter: ['checked']
      });
      
      // Also observe its parent for changes that might affect the toggle
      if (formatToggle.parentElement) {
        observer.observe(formatToggle.parentElement, {
          childList: true,
          subtree: true
        });
      }
    }
  }
  
  // Initial setup
  setupObserver();
  
  // Periodically try to set up the observer in case the toggle wasn't loaded yet
  const setupInterval = setInterval(() => {
    const formatToggle = document.querySelector('#isFeatureEnabled[name="isFeatureEnabled"]');
    if (formatToggle) {
      setupObserver();
      clearInterval(setupInterval);
    }
  }, 2000);
}

// Function to check if 24-hour format is enabled in Keka
function check24HourFormatToggle() {
  try {
    // Find the 24-hour format toggle in Keka's UI
    const formatToggle = document.querySelector('#isFeatureEnabled[name="isFeatureEnabled"]');
    if (formatToggle) {
      // Update the global flag
      is24HourFormatEnabled = formatToggle.checked;
      return formatToggle.checked;
    }
    return false;
  } catch (error) {
    return false;
  }
}

// Add a click event listener to close the dropdown when clicking outside
document.addEventListener('click', function(event) {
  // Check if we have a dropdown open and the click is outside of it
  const openDropdown = document.querySelector('.dropdown.attendance-logs-row.open');
  if (openDropdown) {
    // Check if the click is outside the dropdown
    if (!openDropdown.contains(event.target)) {
      // Find the dropdown toggle and click it to close
      const dropdownToggle = openDropdown.querySelector('[dropdowntoggle]');
      if (dropdownToggle) {
        dropdownToggle.click();
      }
    }
  }
});

// Original message listener has been replaced by the comprehensive one above

// Function to trigger dropdown loading
function triggerDropdownLoading() {
  try {
    // Find today's row
    const rows = document.querySelectorAll('.dropdown.attendance-logs-row');
    let todayRow = null;
    
    // First pass: Look for today's row specifically
    for (const row of rows) {
      if (checkIfTodayRow(row)) {
        todayRow = row;
        break;
      }
    }
    
    // If no specific today row found, try using the first row
    if (!todayRow && rows.length > 0) {
      todayRow = rows[0];
    }
    
    // If we found a row, try to open its dropdown
    if (todayRow) {
      // Check if we already have data from this row without needing to click
      const alreadyHasData = todayRow.querySelector('.dropdown-menu-logs .d-flex.mt-10');
      if (alreadyHasData) {
        updateTimeDisplay();
        return true;
      }
      
      // Find the toggle element that opens the dropdown
      const toggleElement = todayRow.querySelector('[dropdowntoggle]');
      
      if (toggleElement) {
        // Check if dropdown is already open
        const isAlreadyOpen = todayRow.classList.contains('open') || 
                              todayRow.querySelector('.dropdown-menu-logs.show');
        
        // If it's already open, close it first then reopen
        if (isAlreadyOpen) {
          toggleElement.click();
          
          // Wait a moment before reopening
          setTimeout(() => {
            toggleElement.click();
            
            // Close it after content is loaded
            setTimeout(() => {
              toggleElement.click();
              
              // Force an update after dropdown is loaded and closed
              setTimeout(updateTimeDisplay, 300);
            }, 700); // Wait a bit longer to ensure content loads
          }, 300);
        } else {
          // Schedule click to open dropdown
          toggleElement.click();
          
          // Schedule click to close dropdown after content is loaded
          setTimeout(() => {
            toggleElement.click();
            
            // Force an update after dropdown is loaded and closed
            setTimeout(updateTimeDisplay, 300);
          }, 700); // Wait a bit longer to ensure content loads
        }
        
        return true; // Successfully triggered dropdown loading
      } else {
        return false; // Failed to trigger dropdown loading
      }
    } else {
      return false; // Failed to trigger dropdown loading
    }
  } catch (error) {
    return false;
  }
}

// Initialize the extension when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', function() {
  initializeTimeDisplay();
});

// Also initialize on window load as a fallback
window.addEventListener('load', function() {
  initializeTimeDisplay();
});

// Function to ensure the extension is fully initialized
function ensureExtensionInitialized() {
  // Check if we already have a timer running
  if (window.timeUpdateInterval) {
    return;
  }
  
  // Call initialize function
  initializeTimeDisplay();
}

// Add message listener for communication with popup and background
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  // Make sure the extension is initialized on any message
  if (!window.timeUpdateInterval) {
    ensureExtensionInitialized();
  }
  
  // Ensure timer is running whenever we receive any message
  ensureTimerIsRunning();
  
  if (request.action === "getTimeRemaining") {
    // Try to refresh the data by triggering the dropdown if needed
    const isDataRefreshed = triggerDropdownLoading();
    
    // Get the latest time details
    setTimeout(() => {
      // Extract the timings data
      const timingsData = extractShiftTimings();
      let timeDetails = null;
      
      // Process timings data to get time details
      if (timingsData && (timingsData.checkInTime || timingsData.directRowData)) {
        timeDetails = calculateTimeDetails(timingsData);
      } else if (timingsData && timingsData.notPunchedIn && timingsData.isToday) {
        // Not punched in yet, return zeros and total work time
        const totalWorkMinutes = getTotalWorkMinutes();
        const hours = Math.floor(totalWorkMinutes / 60);
        const minutes = totalWorkMinutes % 60;
        
        timeDetails = {
          hoursFulfilled: formatTime(0, 0, 0),
          timeRemaining: formatTime(hours, minutes, 0),
          completionPercentage: 0
        };
      }
      
      // Send response back to popup
      sendResponse(timeDetails);
    }, isDataRefreshed ? 800 : 100); // Wait longer if we just triggered a dropdown refresh
    
    // Return true to indicate we'll send a response asynchronously
    return true;
  } else if (request.action === "autoFetchData") {
    // Check if we're on the attendance logs page
    if (isAttendanceLogsPage()) {
      // Try to refresh the data by triggering the dropdown
      const isDataRefreshed = triggerDropdownLoading();
      
      // Update the time display after the data is fetched
      setTimeout(() => {
        updateTimeDisplay();
        
        // Send response back with success status
        sendResponse({ success: true, dataRefreshed: isDataRefreshed });
        
        // Set up one more attempt in case the first one failed
        if (!isDataRefreshed) {
          setTimeout(() => {
            triggerDropdownLoading();
            setTimeout(updateTimeDisplay, 800);
          }, 2000);
        }
      }, isDataRefreshed ? 800 : 100);
    } else {
      sendResponse({ success: false, reason: "Not on attendance logs page" });
    }
    
    // Return true to indicate we'll send a response asynchronously
    return true;
  } else if (request.action === "ensureTimerRunning") {
    // Ensure the timer is running
    ensureTimerIsRunning();
    
    // Update the display
    updateTimeDisplay();
    
    // Send response
    sendResponse({ success: true });
    return true;
  } else if (request.action === "settingsUpdated") {
    // Update our current settings with the new values
    if (request.settings) {
      currentSettings = { ...currentSettings, ...request.settings };
      
      // Force a refresh of the data display
      const isDataRefreshed = triggerDropdownLoading();
      
      // Update the display
      setTimeout(() => {
        updateTimeDisplay();
        sendResponse({ success: true });
      }, isDataRefreshed ? 800 : 100);
    } else {
      sendResponse({ success: false, error: "No settings provided" });
    }
    return true;
  }
});