const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { exec } = require('child_process');

// Initialize persistent storage
const store = new Store({
  defaults: {
    pomodoroEnabled: false,
    launchOnStartup: true,
    isPaused: false,
    pauseUntil: null,
    currentPosture: 'sit',
    dailyStats: {},
    settings: {
      eyeBreakInterval: 20,
      postureInterval: 40,
      fullStretchInterval: 100,
      walkInterval: 120,
      snoozeLimit: 3,
      snoozeDuration: 5
    }
  }
});

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let scheduler = null;
let isOverlayVisible = false;
let currentBreakData = null;

// Stretch content definitions
const microStretches = [
  {
    name: 'Neck Rolls',
    duration: 30,
    instructions: 'Slowly roll your head in a circle. 5 times each direction.',
    animation: 'neck-roll'
  },
  {
    name: 'Shoulder Shrugs',
    duration: 30,
    instructions: 'Raise shoulders to ears, hold 3 seconds, release. Repeat 5 times.',
    animation: 'shoulder-shrug'
  },
  {
    name: 'Wrist Circles',
    duration: 30,
    instructions: 'Extend arms, make fist, rotate wrists. 10 circles each direction.',
    animation: 'wrist-circle'
  },
  {
    name: 'Ankle Circles',
    duration: 30,
    instructions: 'Lift one foot, rotate ankle slowly. 10 circles each foot.',
    animation: 'ankle-circle'
  },
  {
    name: 'Ankle Stretch',
    duration: 30,
    instructions: 'Point toes down, then flex up. Rise on toes, then heels. Repeat.',
    animation: 'ankle-stretch'
  },
  {
    name: 'Seated Spinal Twist',
    duration: 30,
    instructions: 'Sit tall, twist torso to one side, hold 10 sec. Switch sides.',
    animation: 'spinal-twist'
  }
];

const fullStretches = [
  {
    name: 'Standing Back Extension',
    duration: 120,
    instructions: 'Stand tall, hands on lower back, gently arch backward. Hold 20 sec, repeat 3 times.',
    animation: 'back-extension'
  },
  {
    name: 'Hamstring Stretch',
    duration: 120,
    instructions: 'Stand, place heel on raised surface, lean forward with straight back. 30 sec each leg.',
    animation: 'hamstring'
  },
  {
    name: 'Hip Flexor Lunge',
    duration: 120,
    instructions: 'Kneel on one knee, front foot flat. Push hips forward gently. 30 sec each side.',
    animation: 'hip-flexor'
  },
  {
    name: 'Chest & Doorway Stretch',
    duration: 120,
    instructions: 'Stand in doorway, forearms on frame, lean forward. Hold 30 sec, repeat.',
    animation: 'chest-stretch'
  },
  {
    name: 'Figure-4 Hip Stretch',
    duration: 120,
    instructions: 'Sit, cross ankle over opposite knee, lean forward. 30 sec each side.',
    animation: 'figure-4'
  },
  {
    name: 'Deep Calf & Ankle Stretch',
    duration: 120,
    instructions: 'Step back, press heel down, lean into wall. 30 sec each leg, both straight and bent knee.',
    animation: 'calf-stretch'
  }
];

// Track current indices for rotation
let microStretchIndex = 0;
let fullStretchIndex = 0;

// Break scheduling system
class BreakScheduler {
  constructor() {
    this.timer = null;
    this.cycleCount = 0;
    this.pomodoroCount = 0;
    this.pomodoroWorkTimer = null;
    this.snoozeCount = 0;
  }

  start() {
    this.scheduleNextBreak();
    if (store.get('pomodoroEnabled')) {
      this.startPomodoroTimer();
    }
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pomodoroWorkTimer) {
      clearTimeout(this.pomodoroWorkTimer);
      this.pomodoroWorkTimer = null;
    }
  }

  scheduleNextBreak() {
    const settings = store.get('settings');
    const intervalMs = settings.eyeBreakInterval * 60 * 1000;

    this.timer = setTimeout(async () => {
      await this.triggerBreak();
    }, intervalMs);

    updateTrayMenu();
  }

  async triggerBreak() {
    // Check if paused
    if (store.get('isPaused')) {
      const pauseUntil = store.get('pauseUntil');
      if (pauseUntil && Date.now() < pauseUntil) {
        this.scheduleNextBreak();
        return;
      } else {
        store.set('isPaused', false);
        store.set('pauseUntil', null);
      }
    }

    // Check for calls/fullscreen
    const shouldPause = await checkForCallsOrFullscreen();
    if (shouldPause) {
      this.timer = setTimeout(() => this.triggerBreak(), 60 * 1000);
      return;
    }

    this.cycleCount++;
    const breakData = this.determineBreakType();

    this.snoozeCount = 0;
    showBreakOverlay(breakData);
  }

  determineBreakType() {
    const cycle = this.cycleCount;
    const activities = [];
    let totalDuration = 20;

    console.log(`[Wellness] Cycle ${cycle} - determining break type...`);

    // Eye break every 20 min
    activities.push({
      type: 'eye',
      name: 'Look Away',
      duration: 20,
      instructions: 'Look at something 20 feet away for 20 seconds. Let your eyes relax and refocus.'
    });

    // Micro-stretch every 20 min
    const microStretch = microStretches[microStretchIndex];
    activities.push({
      type: 'micro-stretch',
      ...microStretch
    });
    totalDuration += microStretch.duration;
    microStretchIndex = (microStretchIndex + 1) % microStretches.length;

    // Posture switch + breathing every 40 min (every 2nd cycle)
    if (cycle % 2 === 0) {
      const currentPosture = store.get('currentPosture');
      const newPosture = currentPosture === 'sit' ? 'stand' : 'sit';
      store.set('currentPosture', newPosture);

      activities.push({
        type: 'posture',
        name: newPosture === 'stand' ? 'Time to Stand' : 'Time to Sit',
        duration: 10,
        instructions: newPosture === 'stand'
          ? 'Raise your desk and stand tall. Roll your shoulders back, feet hip-width apart.'
          : 'Lower your desk and sit with intention. Feet flat, back supported, shoulders relaxed.',
        newPosture
      });
      totalDuration += 10;

      // Add breathing/mindfulness at posture switch
      activities.push({
        type: 'breathing',
        name: 'Mindful Breathing',
        duration: 36, // 3 cycles of 4-4-4 breathing
        instructions: 'Follow the circle. Breathe in for 4 seconds, hold for 4, breathe out for 4.'
      });
      totalDuration += 36;
    }

    // Full stretch every 100 min (every 5th cycle)
    if (cycle % 5 === 0) {
      const fullStretch = fullStretches[fullStretchIndex];
      activities.push({
        type: 'full-stretch',
        ...fullStretch
      });
      totalDuration += fullStretch.duration;
      fullStretchIndex = (fullStretchIndex + 1) % fullStretches.length;
    }

    // Walk break every 120 min (every 6th cycle) + extended breathing after
    if (cycle % 6 === 0) {
      activities.push({
        type: 'walk',
        name: 'Walk Break',
        duration: 300,
        instructions: 'Take a 5-minute walk. Get some water, step outside if you can, give your body a real break.'
      });

      // Extended breathing after walk (3 min = 180 sec, about 15 breath cycles)
      activities.push({
        type: 'breathing',
        name: 'Settling Breath',
        duration: 180,
        instructions: 'After your walk, settle back in. Follow the circle through slow, deep breaths. Let your body and mind reset.'
      });
      totalDuration = 480; // 5 min walk + 3 min breathing
    }

    // Dedicated mindfulness break every 4 hours (every 12th cycle)
    if (cycle % 12 === 0) {
      activities.push({
        type: 'breathing',
        name: 'Mindfulness Break',
        duration: 240, // 4 minutes
        instructions: 'A longer pause. Close your eyes if comfortable. Follow your breath, letting thoughts pass without holding onto them.'
      });
      totalDuration += 240;
    }

    console.log(`[Wellness] Cycle ${cycle} activities:`, activities.map(a => a.type).join(', '));

    return {
      activities,
      totalDuration,
      cycleNumber: cycle
    };
  }

  // Trigger an on-demand break
  triggerOnDemandBreak() {
    const activities = [];

    // Eye break
    activities.push({
      type: 'eye',
      name: 'Look Away',
      duration: 20,
      instructions: 'Look at something 20 feet away for 20 seconds. Let your eyes relax and refocus.'
    });

    // Random micro-stretch
    const microStretch = microStretches[Math.floor(Math.random() * microStretches.length)];
    activities.push({
      type: 'micro-stretch',
      ...microStretch
    });

    // Breathing
    activities.push({
      type: 'breathing',
      name: 'Mindful Breathing',
      duration: 36,
      instructions: 'Follow the circle. Breathe in for 4 seconds, hold for 4, breathe out for 4.'
    });

    this.snoozeCount = 0;
    showBreakOverlay({
      activities,
      totalDuration: 86,
      cycleNumber: 0
    });
  }

  snooze() {
    const settings = store.get('settings');
    if (this.snoozeCount < settings.snoozeLimit) {
      this.snoozeCount++;
      hideBreakOverlay();
      this.timer = setTimeout(() => this.triggerBreak(), settings.snoozeDuration * 60 * 1000);
      return { snoozed: true, remaining: settings.snoozeLimit - this.snoozeCount };
    } else {
      return { snoozed: false, remaining: 0 };
    }
  }

  skip() {
    recordBreakStats('skipped', currentBreakData);
    hideBreakOverlay();
    this.scheduleNextBreak();
  }

  complete() {
    recordBreakStats('completed', currentBreakData);
    hideBreakOverlay();
    this.scheduleNextBreak();
  }

  startPomodoroTimer() {
    this.pomodoroWorkTimer = setTimeout(() => {
      this.pomodoroCount++;
      if (mainWindow) {
        mainWindow.webContents.send('pomodoro-complete', this.pomodoroCount);
      }
      if (store.get('pomodoroEnabled')) {
        this.startPomodoroTimer();
      }
    }, 25 * 60 * 1000);
  }

  togglePomodoro(enabled) {
    store.set('pomodoroEnabled', enabled);
    if (enabled) {
      this.pomodoroCount = 0;
      this.startPomodoroTimer();
    } else {
      if (this.pomodoroWorkTimer) {
        clearTimeout(this.pomodoroWorkTimer);
        this.pomodoroWorkTimer = null;
      }
    }
  }
}

// Check for video calls, fullscreen apps, or video playback
async function checkForCallsOrFullscreen() {
  return new Promise((resolve) => {
    // Video/streaming apps to check for
    const videoApps = ['netflix', 'youtube', 'vlc', 'iina', 'quicktime', 'tv', 'prime video', 'disney', 'hbo', 'plex', 'infuse', 'mpv'];

    exec(`osascript -e 'tell application "System Events" to get name of every process whose visible is true'`, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }

      const runningApps = stdout.toLowerCase();

      // Check for Slack huddle (Slack call window contains "Huddle")
      exec(`osascript -e '
        tell application "System Events"
          if exists (process "Slack") then
            try
              tell process "Slack"
                set windowNames to name of every window
                repeat with winName in windowNames
                  if winName contains "Huddle" or winName contains "Call" then
                    return "in_call"
                  end if
                end repeat
              end tell
            end try
          end if
          return ""
        end tell
      ' 2>/dev/null`, (slackErr, slackResult) => {
        if (!slackErr && slackResult && slackResult.trim() === 'in_call') {
          console.log('[Wellness] Slack huddle detected, pausing break');
          resolve(true);
          return;
        }

        // Check for Zoom meeting
        exec(`osascript -e 'tell application "System Events" to get every window of (every process whose name contains "zoom")' 2>/dev/null`, (err, zoomWindows) => {
          if (!err && zoomWindows && zoomWindows.includes('Zoom Meeting')) {
            resolve(true);
            return;
          }

        // Check for fullscreen apps (including video players)
        exec(`osascript -e '
          tell application "System Events"
            set fullscreenApps to {}
            repeat with proc in (every process whose visible is true)
              try
                repeat with win in (every window of proc)
                  if (value of attribute "AXFullScreen" of win) is true then
                    set end of fullscreenApps to name of proc
                  end if
                end repeat
              end try
            end repeat
            return fullscreenApps
          end tell
        '`, (err2, fullscreenResult) => {
          if (!err2 && fullscreenResult && fullscreenResult.trim().length > 0) {
            // Check if any fullscreen app is a video app
            const fullscreenAppsLower = fullscreenResult.toLowerCase();
            const isVideoFullscreen = videoApps.some(app => fullscreenAppsLower.includes(app));
            if (isVideoFullscreen) {
              console.log('[Wellness] Video app in fullscreen, pausing break');
              resolve(true);
              return;
            }
            // Other fullscreen apps also pause
            resolve(true);
            return;
          }

          // Check for screen sharing
          exec(`osascript -e 'do shell script "defaults read com.apple.controlcenter \\"NSStatusItem Visible ScreenMirroring\\" 2>/dev/null || echo 0"'`, (err3, screenShare) => {
            if (screenShare && screenShare.trim() === '1') {
              resolve(true);
              return;
            }

            // Check if Now Playing shows something is playing (video/music)
            exec(`osascript -e '
              tell application "System Events"
                set nowPlaying to ""
                try
                  tell process "Control Center"
                    if exists menu bar item "Now Playing" of menu bar 1 then
                      set nowPlaying to "playing"
                    end if
                  end tell
                end try
                return nowPlaying
              end tell
            ' 2>/dev/null`, (err4, nowPlaying) => {
              // If something is actively playing in fullscreen, we already caught it above
              // This is a fallback but may have false positives (music), so we don't block on it alone
              resolve(false);
            });
          });
        });
        });
      });
    });
  });
}

// Record break statistics
function recordBreakStats(status, breakData) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const dailyStats = store.get('dailyStats') || {};

    if (!dailyStats[today]) {
      dailyStats[today] = {
        completed: 0,
        skipped: 0,
        snoozed: 0,
        breaks: []
      };
    }

    dailyStats[today][status]++;
    dailyStats[today].breaks.push({
      time: new Date().toISOString(),
      status,
      activities: breakData?.activities?.map(a => a.type) || []
    });

    // Clean up old stats (older than 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    Object.keys(dailyStats).forEach(date => {
      if (new Date(date) < thirtyDaysAgo) {
        delete dailyStats[date];
      }
    });

    store.set('dailyStats', dailyStats);
  } catch (e) {
    console.error('[Wellness] Error recording stats:', e);
  }
}

// Window management
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 650,
    show: false,
    frame: true,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'settings.html'));

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;

  overlayWindow = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
}

function showBreakOverlay(breakData) {
  currentBreakData = breakData;
  isOverlayVisible = true;

  if (overlayWindow) {
    // Ensure fullscreen coverage
    const { width, height } = screen.getPrimaryDisplay().bounds;
    overlayWindow.setBounds({ x: 0, y: 0, width, height });

    overlayWindow.webContents.send('show-break', breakData);
    overlayWindow.show();
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setIgnoreMouseEvents(false);

    // Aggressive focus - use app.focus() first to bring app to front
    app.focus({ steal: true });
    overlayWindow.focus();
    overlayWindow.webContents.focus();

    // Keep trying to grab focus
    const focusAttempts = [50, 100, 200, 400, 800];
    focusAttempts.forEach(delay => {
      setTimeout(() => {
        if (overlayWindow && isOverlayVisible) {
          app.focus({ steal: true });
          overlayWindow.focus();
          overlayWindow.webContents.focus();
          overlayWindow.webContents.executeJavaScript(`
            window.focus();
            document.body.focus();
            document.getElementById("btnStart")?.focus();
          `).catch(() => {});
        }
      }, delay);
    });
  }
}

function hideBreakOverlay() {
  isOverlayVisible = false;
  if (overlayWindow) {
    overlayWindow.hide();
  }
}

// Tray management
function createTray() {
  // Load template icon from file (macOS will handle dark/light mode)
  const iconPath = path.join(__dirname, '..', 'assets', 'iconTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Wellness Reminder');
  updateTrayMenu();
}

function updateTrayMenu() {
  const isPaused = store.get('isPaused');
  const pomodoroEnabled = store.get('pomodoroEnabled');
  const currentPosture = store.get('currentPosture');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: currentPosture === 'sit' ? 'Currently sitting' : 'Currently standing',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Take a break now',
      click: () => {
        if (scheduler) {
          scheduler.triggerOnDemandBreak();
        }
      }
    },
    { type: 'separator' },
    {
      label: isPaused ? 'Resume' : 'Pause',
      click: () => togglePause()
    },
    {
      label: 'Pause for...',
      submenu: [
        { label: '30 minutes', click: () => pauseFor(30) },
        { label: '1 hour', click: () => pauseFor(60) },
        { label: '2 hours', click: () => pauseFor(120) }
      ]
    },
    { type: 'separator' },
    {
      label: pomodoroEnabled ? 'Pomodoro (on)' : 'Pomodoro (off)',
      click: () => {
        scheduler.togglePomodoro(!pomodoroEnabled);
        updateTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: 'Daily Summary',
      click: () => showDailySummary()
    },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Test break',
      click: () => {
        const testBreak = {
          activities: [
            {
              type: 'eye',
              name: 'Look Away',
              duration: 5,
              instructions: 'Look at something 20 feet away. Let your eyes relax.'
            },
            {
              type: 'micro-stretch',
              name: 'Neck Rolls',
              duration: 5,
              instructions: 'Slowly roll your head in a circle. 5 times each direction.',
              animation: 'neck-roll'
            },
            {
              type: 'breathing',
              name: 'Mindful Breathing',
              duration: 12,
              instructions: 'Follow the circle. Breathe in for 4 seconds, hold for 4, breathe out for 4.'
            }
          ],
          totalDuration: 22,
          cycleNumber: 0
        };
        showBreakOverlay(testBreak);
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function togglePause() {
  const isPaused = store.get('isPaused');
  store.set('isPaused', !isPaused);
  if (!isPaused) {
    store.set('pauseUntil', null);
  }
  updateTrayMenu();
}

function pauseFor(minutes) {
  store.set('isPaused', true);
  store.set('pauseUntil', Date.now() + minutes * 60 * 1000);
  updateTrayMenu();

  setTimeout(() => {
    store.set('isPaused', false);
    store.set('pauseUntil', null);
    updateTrayMenu();
  }, minutes * 60 * 1000);
}

function showDailySummary() {
  const today = new Date().toISOString().split('T')[0];
  const dailyStats = store.get('dailyStats') || {};
  const todayStats = dailyStats[today] || { completed: 0, skipped: 0, snoozed: 0 };

  if (mainWindow) {
    mainWindow.webContents.send('show-summary', todayStats);
    mainWindow.show();
    mainWindow.focus();
  }
}

// IPC handlers
ipcMain.on('break-complete', () => {
  if (scheduler) scheduler.complete();
});

ipcMain.on('break-snooze', (event) => {
  if (scheduler) {
    const result = scheduler.snooze();
    event.reply('snooze-result', result);
  }
});

ipcMain.on('break-skip', () => {
  if (scheduler) scheduler.skip();
});

ipcMain.on('toggle-pomodoro', (event, enabled) => {
  if (scheduler) {
    scheduler.togglePomodoro(enabled);
    updateTrayMenu();
  }
});

ipcMain.on('get-stats', (event) => {
  const today = new Date().toISOString().split('T')[0];
  const dailyStats = store.get('dailyStats') || {};
  event.reply('stats-data', dailyStats[today] || { completed: 0, skipped: 0, snoozed: 0, breaks: [] });
});

ipcMain.on('get-settings', (event) => {
  event.reply('settings-data', {
    pomodoroEnabled: store.get('pomodoroEnabled'),
    launchOnStartup: store.get('launchOnStartup'),
    settings: store.get('settings')
  });
});

ipcMain.on('save-settings', (event, newSettings) => {
  store.set('settings', newSettings);
});

ipcMain.on('set-launch-on-startup', (event, enabled) => {
  store.set('launchOnStartup', enabled);
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true
  });
});

// App lifecycle
app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  createTray();

  // Show the main window on first launch so user knows it's running
  mainWindow.show();

  scheduler = new BreakScheduler();
  scheduler.start();

  // Global shortcuts
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    togglePause();
  });

  // Escape is handled in overlay.html directly to avoid conflicts

  // Launch on startup
  app.setLoginItemSettings({
    openAtLogin: store.get('launchOnStartup'),
    openAsHidden: true
  });
});

app.on('window-all-closed', () => {
  // Keep running on macOS
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  if (scheduler) {
    scheduler.stop();
  }
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});
