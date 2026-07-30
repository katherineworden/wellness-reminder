const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

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
  { name: 'Neck Rolls', duration: 30, instructions: 'Slowly roll your head in a circle. 5 times each direction.', animation: 'neck-roll' },
  { name: 'Shoulder Shrugs', duration: 30, instructions: 'Raise shoulders to ears, hold 3 seconds, release. Repeat 5 times.', animation: 'shoulder-shrug' },
  { name: 'Wrist Circles', duration: 30, instructions: 'Extend arms, make fist, rotate wrists. 10 circles each direction.', animation: 'wrist-circle' },
  { name: 'Ankle Circles', duration: 30, instructions: 'Lift one foot, rotate ankle slowly. 10 circles each foot.', animation: 'ankle-circle' },
  { name: 'Ankle Stretch', duration: 30, instructions: 'Point toes down, then flex up. Rise on toes, then heels. Repeat.', animation: 'ankle-stretch' },
  { name: 'Seated Spinal Twist', duration: 30, instructions: 'Sit tall, twist torso to one side, hold 10 sec. Switch sides.', animation: 'spinal-twist' }
];

const fullStretches = [
  { name: 'Standing Back Extension', duration: 120, instructions: 'Stand tall, hands on lower back, gently arch backward. Hold 20 sec, repeat 3 times.', animation: 'back-extension' },
  { name: 'Hamstring Stretch', duration: 120, instructions: 'Stand, place heel on raised surface, lean forward with straight back. 30 sec each leg.', animation: 'hamstring' },
  { name: 'Hip Flexor Lunge', duration: 120, instructions: 'Kneel on one knee, front foot flat. Push hips forward gently. 30 sec each side.', animation: 'hip-flexor' },
  { name: 'Chest & Doorway Stretch', duration: 120, instructions: 'Stand in doorway, forearms on frame, lean forward. Hold 30 sec, repeat.', animation: 'chest-stretch' },
  { name: 'Figure-4 Hip Stretch', duration: 120, instructions: 'Sit, cross ankle over opposite knee, lean forward. 30 sec each side.', animation: 'figure-4' },
  { name: 'Deep Calf & Ankle Stretch', duration: 120, instructions: 'Step back, press heel down, lean into wall. 30 sec each leg, both straight and bent knee.', animation: 'calf-stretch' }
];

let microStretchIndex = 0;
let fullStretchIndex = 0;

// User preferences with safe defaults (old installs may lack these keys)
function getPrefs() {
  const s = store.get('settings') || {};
  return {
    baseInterval: s.baseInterval || s.eyeBreakInterval || 20,
    enabled: Object.assign(
      { combo: true, posture: true, fullStretch: true, walk: true, mindfulness: true },
      s.enabled || {}
    )
  };
}

// --- Call / fullscreen detection (single osascript, no callback nesting) ---

async function runOsa(script) {
  try {
    const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, `'\\''`)}' 2>/dev/null`, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

// Check a browser's tab URLs for a call service
async function checkBrowserTabs(appName) {
  try {
    const script = `
      tell application "${appName}"
        set urls to ""
        try
          repeat with w in windows
            repeat with t in tabs of w
              set urls to urls & " " & (URL of t)
            end repeat
          end repeat
        end try
        return urls
      end tell
    `;
    const { stdout } = await execAsync(
      `osascript -e '${script.replace(/'/g, `'\\''`)}' 2>/dev/null`,
      { timeout: 3000 }
    );
    const urls = stdout.toLowerCase();
    if (urls.includes('meet.google.com/') ||
        urls.includes('zoom.us/wc/') ||
        urls.includes('zoom.us/j/') ||
        urls.includes('teams.microsoft.com/l/meetup') ||
        urls.includes('teams.live.com/meet') ||
        urls.includes('teams.microsoft.com/_#/pre-join-calling') ||
        urls.includes('whereby.com/') ||
        urls.includes('app.gather.town') ||
        urls.includes('around.co/room')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Check if mic is in use (reliable "in a call" signal)
async function isMicInUse() {
  try {
    const { stdout } = await execAsync(
      `lsof 2>/dev/null | grep -E "coreaudiod.*CoreAudio" | wc -l`,
      { timeout: 3000 }
    );
    // Always has some baseline; only check for elevated count is unreliable.
    // Use a more specific check: look for apps with audio input claims
    const { stdout: audioCheck } = await execAsync(
      `ioreg -c AppleUSBAudioEngine -r 2>/dev/null | grep -c "IOAudioEngineState = 1" || echo 0`,
      { timeout: 3000 }
    );
    return audioCheck.trim() !== '0';
  } catch {
    return false;
  }
}

// Permission-free detection via power assertions and processes.
// Any WebRTC call (Meet, Teams, Slack huddles, Discord, Zoom-in-browser) makes
// Chromium/Electron hold a "WebRTC has active PeerConnections" power assertion,
// and Zoom/FaceTime/recorders hold their own — no Accessibility access needed.
async function isInCallOrRecording() {
  try {
    const { stdout } = await execAsync('pmset -g assertions', { timeout: 4000 });
    if (/PeerConnections/i.test(stdout)) return 'call';
    if (/pid \d+\((zoom\.us|CptHost|FaceTime)\)/i.test(stdout)) return 'call';
    if (/screencaptureui/i.test(stdout)) return 'recording';
  } catch {}
  try {
    const { stdout } = await execAsync(
      'pgrep -x screencapture; pgrep -x CptHost; pgrep -x OBS; pgrep -f "OBS Studio"; true',
      { timeout: 3000 }
    );
    if (stdout.trim()) return 'recording';
  } catch {}
  return null;
}

async function checkForCallsOrFullscreen() {
  // Reliable, permission-free checks first
  const busy = await isInCallOrRecording();
  if (busy) {
    console.log(`[Wellness] Detected ${busy} via assertions/processes, skipping break`);
    return true;
  }

  try {
    // Single comprehensive AppleScript check for native apps + fullscreen
    const result = await execAsync(`osascript -e '
      tell application "System Events"
        set appList to name of every process whose visible is true
        set appStr to appList as text

        if appStr contains "zoom" then
          try
            tell process "zoom.us"
              if exists (window "Zoom Meeting") then return "call"
            end tell
          end try
        end if

        if appStr contains "Slack" then
          try
            tell process "Slack"
              repeat with w in (every window)
                set wName to name of w
                if wName contains "Huddle" or wName contains "Call" then return "call"
              end repeat
            end tell
          end try
        end if

        if appStr contains "FaceTime" then
          try
            tell process "FaceTime"
              if (count of windows) > 0 then return "call"
            end tell
          end try
        end if

        -- Also check browser window titles as a fast path
        repeat with browserName in {"Google Chrome", "Arc", "Safari", "Microsoft Edge", "Brave Browser"}
          if appStr contains browserName then
            try
              tell process (browserName as text)
                repeat with w in (every window)
                  set wName to name of w
                  if wName contains "Meet -" or wName contains "Google Meet" or wName contains "Microsoft Teams" or wName contains "Zoom Meeting" then return "call"
                end repeat
              end tell
            end try
          end if
        end repeat

        repeat with proc in (every process whose visible is true)
          try
            repeat with win in (every window of proc)
              if (value of attribute "AXFullScreen" of win) is true then return "fullscreen"
            end repeat
          end try
        end repeat

        return "ok"
      end tell
    ' 2>/dev/null`, { timeout: 8000 });

    const status = result.stdout.trim();
    if (status === 'call' || status === 'fullscreen') {
      console.log(`[Wellness] Detected ${status} via AppleScript, skipping break`);
      return true;
    }

    // Deeper check: tab URLs across browsers (catches Meet/Zoom/Teams in background tabs)
    const browsers = ['Google Chrome', 'Arc', 'Safari', 'Microsoft Edge', 'Brave Browser'];
    const running = await execAsync(`osascript -e 'tell application "System Events" to get name of every process whose visible is true'`, { timeout: 3000 }).catch(() => ({ stdout: '' }));
    const runningLower = running.stdout.toLowerCase();

    for (const browser of browsers) {
      if (runningLower.includes(browser.toLowerCase())) {
        const inCall = await checkBrowserTabs(browser);
        if (inCall) {
          console.log(`[Wellness] Call detected in ${browser} tab URL, skipping break`);
          return true;
        }
      }
    }

    return false;
  } catch (e) {
    console.error('[Wellness] Detection error:', e.message);
    return false;
  }
}

// --- Stats ---

function recordBreakStats(status, breakData) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const dailyStats = store.get('dailyStats') || {};

    if (!dailyStats[today]) {
      dailyStats[today] = { completed: 0, skipped: 0, snoozed: 0, breaks: [] };
    }

    dailyStats[today][status]++;
    dailyStats[today].breaks.push({
      time: new Date().toISOString(),
      status,
      activities: breakData?.activities?.map(a => a.type) || []
    });

    // Prune old entries
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    for (const date of Object.keys(dailyStats)) {
      if (new Date(date) < cutoff) delete dailyStats[date];
    }

    store.set('dailyStats', dailyStats);
  } catch (e) {
    console.error('[Wellness] Error recording stats:', e);
  }
}

// --- Break scheduler ---

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
    if (store.get('pomodoroEnabled')) this.startPomodoroTimer();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pomodoroWorkTimer) { clearTimeout(this.pomodoroWorkTimer); this.pomodoroWorkTimer = null; }
  }

  scheduleNextBreak() {
    if (this.timer) clearTimeout(this.timer);
    const intervalMs = getPrefs().baseInterval * 60 * 1000;
    this.timer = setTimeout(() => this.triggerBreak(), intervalMs);
    updateTrayMenu();
  }

  async triggerBreak() {
    // Check pause state
    const isPaused = store.get('isPaused');
    if (isPaused) {
      const pauseUntil = store.get('pauseUntil');
      if (pauseUntil && Date.now() >= pauseUntil) {
        // Timed pause expired
        store.set('isPaused', false);
        store.set('pauseUntil', null);
        updateTrayMenu();
      } else {
        // Still paused (either indefinitely or timed)
        this.scheduleNextBreak();
        return;
      }
    }

    // Check for calls / fullscreen
    const busy = await checkForCallsOrFullscreen();
    if (busy) {
      this.timer = setTimeout(() => this.triggerBreak(), 60 * 1000);
      return;
    }

    this.cycleCount++;
    const breakData = this.determineBreakType();

    // Every break type due this cycle is switched off — quietly wait for the next one
    if (breakData.activities.length === 0) {
      this.scheduleNextBreak();
      return;
    }

    this.snoozeCount = 0;
    showBreakOverlay(breakData);
  }

  determineBreakType() {
    const cycle = this.cycleCount;
    const { enabled } = getPrefs();
    const activities = [];

    // Eyes + micro-stretch stacked: rest your eyes while you stretch (every break)
    if (enabled.combo) {
      const ms = microStretches[microStretchIndex];
      activities.push({
        type: 'combo',
        name: ms.name,
        duration: Math.max(20, ms.duration),
        instructions: `Fix your gaze on something at least 20 feet away — out a window or across the room — and keep it there while you stretch. ${ms.instructions}`,
        animation: ms.animation
      });
      microStretchIndex = (microStretchIndex + 1) % microStretches.length;
    }

    // Posture switch folded into breathing every 2nd cycle
    if (enabled.posture && cycle % 2 === 0) {
      const cur = store.get('currentPosture');
      const next = cur === 'sit' ? 'stand' : 'sit';
      store.set('currentPosture', next);

      activities.push({
        type: 'breathing',
        name: next === 'stand' ? 'Stand & Breathe' : 'Sit & Breathe',
        duration: 45,
        instructions: next === 'stand'
          ? 'Raise your desk and stand tall, shoulders back. Then settle in with the circle — in for 4, hold 4, out 4.'
          : 'Lower your desk and sit back down with intention. Then settle in with the circle — in for 4, hold 4, out 4.',
        newPosture: next
      });
    }

    // Full stretch every 5th cycle (~100 min)
    if (enabled.fullStretch && cycle % 5 === 0) {
      const fs = fullStretches[fullStretchIndex];
      activities.push({ type: 'full-stretch', ...fs });
      fullStretchIndex = (fullStretchIndex + 1) % fullStretches.length;
    }

    // Walk break every 6th cycle (2 hours) + settling breath
    if (enabled.walk && cycle % 6 === 0) {
      activities.push({
        type: 'walk', name: 'Walk Break', duration: 300,
        instructions: 'Take a 5-minute walk. Get some water, step outside if you can, give your body a real break.'
      });
      activities.push({
        type: 'breathing', name: 'Settling Breath', duration: 180,
        instructions: 'After your walk, settle back in. Follow the circle through slow, deep breaths. Let your body and mind reset.'
      });
    }

    // Dedicated mindfulness every 12th cycle (4 hours)
    if (enabled.mindfulness && cycle % 12 === 0) {
      activities.push({
        type: 'breathing', name: 'Mindfulness Break', duration: 240,
        instructions: 'A longer pause. Close your eyes if comfortable. Follow your breath, letting thoughts pass without holding onto them.'
      });
    }

    console.log(`[Wellness] Cycle ${cycle}:`, activities.map(a => a.name).join(', '));
    return { activities, cycleNumber: cycle };
  }

  triggerOnDemandBreak() {
    const ms = microStretches[Math.floor(Math.random() * microStretches.length)];
    this.snoozeCount = 0;
    showBreakOverlay({
      activities: [
        {
          type: 'combo', name: ms.name, duration: Math.max(20, ms.duration),
          instructions: `Fix your gaze on something at least 20 feet away — out a window or across the room — and keep it there while you stretch. ${ms.instructions}`,
          animation: ms.animation
        },
        { type: 'breathing', name: 'Mindful Breathing', duration: 36, instructions: 'Follow the circle. Breathe in for 4 seconds, hold for 4, breathe out for 4.' }
      ],
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
    }
    return { snoozed: false, remaining: 0 };
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
      if (mainWindow) mainWindow.webContents.send('pomodoro-complete', this.pomodoroCount);
      if (store.get('pomodoroEnabled')) this.startPomodoroTimer();
    }, 25 * 60 * 1000);
  }

  togglePomodoro(enabled) {
    store.set('pomodoroEnabled', enabled);
    if (enabled) {
      this.pomodoroCount = 0;
      this.startPomodoroTimer();
    } else if (this.pomodoroWorkTimer) {
      clearTimeout(this.pomodoroWorkTimer);
      this.pomodoroWorkTimer = null;
    }
  }
}

// --- Windows ---

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420, height: 650, show: false,
    frame: true, resizable: false, titleBarStyle: 'hiddenInset',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile(path.join(__dirname, 'settings.html'));
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().bounds;
  overlayWindow = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false, transparent: false, alwaysOnTop: true,
    skipTaskbar: true, focusable: true, show: false, hasShadow: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
}

function showBreakOverlay(breakData) {
  currentBreakData = breakData;
  isOverlayVisible = true;

  if (!overlayWindow) return;

  const { width, height } = screen.getPrimaryDisplay().bounds;
  overlayWindow.setBounds({ x: 0, y: 0, width, height });
  overlayWindow.webContents.send('show-break', breakData);
  overlayWindow.show();
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  // Steal focus so keyboard works immediately
  app.focus({ steal: true });
  overlayWindow.focus();

  // Retry focus a couple times for macOS
  setTimeout(() => {
    if (overlayWindow && isOverlayVisible) {
      app.focus({ steal: true });
      overlayWindow.focus();
    }
  }, 200);
  setTimeout(() => {
    if (overlayWindow && isOverlayVisible) {
      overlayWindow.focus();
    }
  }, 600);
}

function hideBreakOverlay() {
  isOverlayVisible = false;
  if (overlayWindow) overlayWindow.hide();
}

// --- Tray ---

function createTray() {
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

  const template = [
    { label: currentPosture === 'sit' ? 'Currently sitting' : 'Currently standing', enabled: false },
    { type: 'separator' },
    { label: 'Take a break now', click: () => scheduler?.triggerOnDemandBreak() },
    { type: 'separator' },
    { label: isPaused ? 'Resume breaks' : 'Pause breaks', click: () => togglePause() },
    { label: 'Pause for...', submenu: [
      { label: '30 minutes', click: () => pauseFor(30) },
      { label: '1 hour', click: () => pauseFor(60) },
      { label: '2 hours', click: () => pauseFor(120) }
    ]},
    { type: 'separator' },
    { label: pomodoroEnabled ? 'Pomodoro (on)' : 'Pomodoro (off)', click: () => { scheduler?.togglePomodoro(!pomodoroEnabled); updateTrayMenu(); } },
    { type: 'separator' },
    { label: 'Daily Summary', click: () => showDailySummary() },
    { label: 'Settings', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Test break', click: () => {
      showBreakOverlay({
        activities: [
          { type: 'combo', name: 'Neck Rolls', duration: 5, instructions: 'Fix your gaze on something at least 20 feet away and keep it there while you stretch. Slowly roll your head in a circle.', animation: 'neck-roll' },
          { type: 'breathing', name: 'Mindful Breathing', duration: 12, instructions: 'Follow the circle. Breathe in for 4 seconds, hold for 4, breathe out for 4.' }
        ],
        cycleNumber: 0
      });
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function togglePause() {
  const isPaused = store.get('isPaused');
  if (isPaused) {
    // Resume
    store.set('isPaused', false);
    store.set('pauseUntil', null);
    if (scheduler) scheduler.scheduleNextBreak();
  } else {
    // Pause indefinitely
    store.set('isPaused', true);
    store.set('pauseUntil', null);
  }
  updateTrayMenu();
}

function pauseFor(minutes) {
  store.set('isPaused', true);
  store.set('pauseUntil', Date.now() + minutes * 60 * 1000);
  updateTrayMenu();
}

function showDailySummary() {
  const today = new Date().toISOString().split('T')[0];
  const dailyStats = store.get('dailyStats') || {};
  if (mainWindow) {
    mainWindow.webContents.send('show-summary', dailyStats[today] || { completed: 0, skipped: 0, snoozed: 0 });
    mainWindow.show();
    mainWindow.focus();
  }
}

// --- IPC ---

ipcMain.on('break-complete', () => scheduler?.complete());
ipcMain.on('break-snooze', (event) => {
  if (scheduler) event.reply('snooze-result', scheduler.snooze());
});
ipcMain.on('break-skip', () => scheduler?.skip());
ipcMain.on('toggle-pomodoro', (_, enabled) => { scheduler?.togglePomodoro(enabled); updateTrayMenu(); });

ipcMain.on('get-stats', (event) => {
  const today = new Date().toISOString().split('T')[0];
  const dailyStats = store.get('dailyStats') || {};
  event.reply('stats-data', dailyStats[today] || { completed: 0, skipped: 0, snoozed: 0, breaks: [] });
});

ipcMain.on('get-settings', (event) => {
  event.reply('settings-data', {
    pomodoroEnabled: store.get('pomodoroEnabled'),
    launchOnStartup: store.get('launchOnStartup'),
    settings: store.get('settings'),
    prefs: getPrefs()
  });
});

ipcMain.on('save-settings', (_, newSettings) => store.set('settings', newSettings));

ipcMain.on('save-preferences', (_, prefs) => {
  const s = store.get('settings') || {};
  if (prefs.baseInterval) s.baseInterval = prefs.baseInterval;
  if (prefs.enabled) s.enabled = prefs.enabled;
  store.set('settings', s);
  // Apply the new rhythm right away
  if (scheduler) scheduler.scheduleNextBreak();
});

ipcMain.on('set-launch-on-startup', (_, enabled) => {
  store.set('launchOnStartup', enabled);
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
});

// --- App lifecycle ---

app.whenReady().then(() => {
  createMainWindow();
  createOverlayWindow();
  createTray();
  mainWindow.show();

  scheduler = new BreakScheduler();
  scheduler.start();

  globalShortcut.register('CommandOrControl+Shift+P', togglePause);

  app.setLoginItemSettings({
    openAtLogin: store.get('launchOnStartup'),
    openAsHidden: true
  });
});

app.on('window-all-closed', () => { /* keep running */ });
app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  scheduler?.stop();
});
app.on('activate', () => mainWindow?.show());
