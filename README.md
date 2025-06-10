# Keka Time Tracker Extension

A Chrome extension that enhances the Keka attendance system by showing remaining work time based on your punches and allowing you to customize your shift duration.

## Features

- Shows time fulfilled, time remaining, and completion percentage directly in the Keka interface
- Calculates time fulfilled by summing up precise punch-in/out logs with second-level accuracy
- Displays time information directly in the Keka Actions card
- Styled to match Keka's interface in both light and dark themes
- Shows "Not punched in yet" status for new days when user hasn't clocked in
- Updates in real-time with second-by-second calculations
- Automatically adjusts expected checkout time based on breaks
- Respects Keka's 24-hour format toggle setting

## Shift Settings

The extension provides a simple popup where you can customize your work shift duration:

- By default, the extension uses Keka's standard work duration (8.5 hours)
- You can enable custom work duration and set your own hours and minutes

## Installation

1. Load the extension in Chrome's developer mode
2. Navigate to your Keka attendance page
3. You'll see the time tracker display automatically integrated into the Keka interface

## Accessing Shift Settings

Click the extension icon in Chrome to access the shift duration settings.

## How it Works

The extension:
1. Detects when you're on the Keka attendance page
2. Reads your punch data without interfering with the UI
3. Calculates your worked time with second precision
4. Shows time remaining based on your shift settings
5. Updates in real-time
6. Adjusts expected checkout time based on breaks between punches

## Credits

Created as a productivity tool for Keka users. 