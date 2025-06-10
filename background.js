

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if the page is fully loaded and is a Keka page
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('keka.com')) {
    // Wait a moment for the page to be fully initialized
    setTimeout(() => {
      // Send message to content script to trigger data fetch
      chrome.tabs.sendMessage(tabId, { action: "autoFetchData" }, response => {
        // No need to do anything with the response
      });
    }, 2000); // Wait 2 seconds for the page to fully initialize
  }
});

// Listen for popup disconnect events
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    // When the popup connects, we note the connection
    port.onDisconnect.addListener(() => {
      // When the popup disconnects, send a message to ensure the timer keeps running
      chrome.tabs.query({url: '*://*.keka.com/*'}, (tabs) => {
        if (tabs.length > 0) {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { action: "ensureTimerRunning" });
          });
        }
      });
    });
  }
}); 