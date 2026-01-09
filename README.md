# Keka Time Tracker Extension

A Chrome extension that enhances the Keka attendance experience by providing real-time work tracking, instant attendance insights, and customizable work time settings — without waiting for page refreshes.

FEATURES

- Real-time tracking of effective, gross, and break time
- Hoverable attendance logs with grouped punch-in/out entries
- Work completion progress bar with percentage (up to 2 decimals)
- Progress label automatically changes to 'Completed' at 100%
- Browser notification when work duration is completed
- Manual refresh for attendance logs without reloading Keka
- Customizable working hours and break handling
- Punch In / Punch Out status indicator on profile icon
- Works outside Attendance page
- Adapts to Keka light/dark theme and 12/24-hour format

WORK TIME SETTINGS

- Default work duration: 8 hours 30 minutes
- Customize work hours and minutes
- Option to include or exclude break time
- Enable or disable completion notifications

INSTALLATION

1. Download or clone the repository
2. Open chrome://extensions
3. Enable Developer Mode
4. Click Load unpacked
5. Select the project folder
6. Open Keka Attendance page

HOW IT WORKS

- Reads attendance logs using Keka internal APIs (read-only)
- Calculates time with second-level accuracy
- Updates UI in real time
- Displays data via navbar chip and hover dropdown
- Sends notification once per work session

PRIVACY

- No data is sent to external servers
- All calculations happen locally
- Uses your existing Keka session only

CREDITS
Created as a productivity enhancement for Keka users.
