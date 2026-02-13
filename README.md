# Wellness Reminder

A calming macOS menu bar app that helps you maintain healthy habits while working at your computer. Combines research-backed wellness practices into synchronized, non-intrusive break reminders.

## Features

- **20-20-20 Eye Rule** - Every 20 minutes, look 20 feet away for 20 seconds
- **Micro-stretches** - Quick stretches rotating through neck, shoulders, wrists, and ankles
- **Posture Switching** - Alternates between sitting and standing every 40 minutes
- **Full Body Stretches** - Deeper 2-minute stretches for back, hips, chest, and legs
- **Walk Breaks** - 5-minute walking breaks every 2 hours
- **Mindful Breathing** - Guided 4-4-4 breathing exercises with visual cues
- **Extended Mindfulness** - 4-minute dedicated sessions every 4 hours

## Smart Features

- **Auto-pause during calls** - Detects Zoom, Slack huddles, Google Meet, FaceTime
- **Auto-pause during video** - Pauses for Netflix, YouTube, VLC in fullscreen
- **Snooze** - Up to 3 snoozes per break (5 min each)
- **Pomodoro Mode** - Optional 25-minute focus timer integration
- **Daily Summary** - Track completed, skipped, and snoozed breaks
- **Launch on Startup** - Starts automatically when you log in

## Installation

### From Source

```bash
git clone https://github.com/YOURUSERNAME/wellness-reminder.git
cd wellness-reminder
npm install
npm start
```

### Build the App

```bash
npm run build:mac
```

The `.dmg` file will be in the `dist/` folder.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` or `Space` | Start timer / Next activity |
| `Escape` | Skip current break |
| `Cmd+Shift+P` | Pause/Resume (global) |

## Break Schedule

| Interval | Activities |
|----------|------------|
| Every 20 min | Eye break + Micro-stretch |
| Every 40 min | + Posture switch + Breathing |
| Every 100 min | + Full body stretch |
| Every 2 hours | + 5-min walk + Extended breathing |
| Every 4 hours | + 4-min mindfulness session |

## Menu Bar

Click the icon to access:
- Take a break now
- Pause / Resume
- Pause for 30min, 1hr, or 2hr
- Toggle Pomodoro mode
- View daily summary
- Settings
- Test break

## Tech Stack

- Electron
- electron-store
- electron-builder

## License

MIT
