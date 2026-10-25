const { app, BrowserWindow, ipcMain, screen, desktopCapturer, Menu, shell, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '')); // tolerate a BOM from Windows editors
const MOODS = ['idle', 'happy', 'curious', 'excited', 'sleepy', 'judging', 'sad', 'love', 'talk'];
const WORK_DIR = path.join(os.tmpdir(), 'little-dude');
const SHOT = path.join(WORK_DIR, 'screen.jpg');
fs.mkdirSync(WORK_DIR, { recursive: true });

let win;
const W = 340, H = 520; // main window size (mostly click-through transparent space)
let busy = false;
let watching = true;
let asleep = false;
let history = []; // [{who: 'me'|'you', text}]
let lastCursor = { x: 0, y: 0 };
let lastMoveAt = Date.now();

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: W, height: H,
    x: workArea.x + workArea.width - W - 20,
    y: workArea.y + workArea.height - H,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');
  win.webContents.on('console-message', (_e, level, message, line) => console.log('[page]', level, message, line));
}

// ---------- seeing ----------
async function takeScreenshot() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = Math.min(1, 1280 / display.size.width);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
  });
  const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
  fs.writeFileSync(SHOT, src.thumbnail.toJPEG(70));
}

// ---------- thinking (runs the AI CLI from config.brainCommand in headless mode) ----------
function brainBin() {
  const name = config.brainCommand + (process.platform === 'win32' ? '.exe' : '');
  const local = path.join(os.homedir(), '.local', 'bin', name);
  return fs.existsSync(local) ? local : config.brainCommand;
}

function askBrain(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--model', config.model,
      '--tools', 'Read', '--allowedTools', 'Read',
      '--strict-mcp-config', '--setting-sources', 'project', '--disable-slash-commands',
      '--system-prompt', `You are ${config.name}, ${config.personality} You can see the user's screen via screenshots. Always reply with ONLY a JSON object, no other text.`,
    ];
    const p = spawn(brainBin(), args, { cwd: WORK_DIR, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err || out || `${config.brainCommand} exited ${code}`))));
  });
}

function parseReply(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m[0]);
    return { mood: MOODS.includes(j.mood) ? j.mood : 'talk', say: String(j.say || '').trim(), spotify: j.spotify };
  } catch {
    return { mood: 'talk', say: raw.trim() };
  }
}

function recentHistory() {
  return history.slice(-8).map(h => `${h.who === 'me' ? 'User' : 'You'}: ${h.text}`).join('\n') || '(nothing yet)';
}

async function think(kind, question) {
  if (busy && kind === 'comment') return;
  if (kind === 'chat') win.webContents.send('thinking');
  while (busy) await new Promise(r => setTimeout(r, 300)); // chats wait for the current thought to finish
  busy = true;
  try {
    await takeScreenshot();
    const fmt = `Reply ONLY as JSON: {"mood": one of ${JSON.stringify(MOODS)}, "say": "..."}`;
    const music = nowPlaying ? `\nNow playing on my Spotify: ${nowPlaying.title} by ${nowPlaying.artist}${nowPlaying.playing ? '' : ' (paused)'}.` : '';
    const musicCtl = spotify.connected()
      ? ` If I ask you to control music, also include "spotify": {"action": "play"|"pause"|"resume"|"next"|"previous", "query": "what to search for (only for play)"}.`
      : '';
    const prompt = kind === 'chat'
      ? `Read the image screen.jpg: a screenshot of my screen right now (use it if relevant).${music}\nRecent conversation:\n${recentHistory()}\n\nMy message: ${question}\n\nAnswer helpfully but briefly (max 60 words). ${fmt}${musicCtl}`
      : `Read the image screen.jpg: a screenshot of my screen right now.${music}\nThings said recently:\n${recentHistory()}\n\nReact to what I'm doing with ONE short playful line (max 18 words), like a pet peeking over my shoulder. Don't repeat yourself; if it's the same thing as before, say something new about it. ${fmt}`;
    const reply = parseReply(await askBrain(prompt));
    if (kind === 'chat' && reply.spotify) spotifyAction(reply.spotify.action, reply.spotify.query);
    if (kind === 'chat') history.push({ who: 'me', text: question });
    if (reply.say) history.push({ who: 'you', text: reply.say });
    history = history.slice(-20);
    console.log(`[${kind}]`, JSON.stringify(reply));
    win.webContents.send('reply', reply);
  } catch (e) {
    console.error(e);
    win.webContents.send('reply', { mood: 'sad', say: kind === 'chat' ? "my brain glitched... is my brain logged in?" : '' });
  } finally {
    busy = false;
  }
}

// ---------- notes + recordings (saved as plain files) ----------
const NOTES_DIR = config.notesFolder || path.join(app.getPath('documents'), 'Little Dude Notes');
const REC_DIR = path.join(NOTES_DIR, 'Recordings');
const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clock = (d = new Date(), sep = ':') => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(sep);

ipcMain.handle('save-note', (_, text) => {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const file = path.join(NOTES_DIR, `${stamp()}.md`);
  const head = fs.existsSync(file) ? '' : `# Notes – ${stamp()}\n\n`;
  fs.appendFileSync(file, `${head}## ${clock().slice(0, 5)}\n\n${text.trim()}\n\n`);
  return file;
});
ipcMain.on('open-folder', (_, which) => {
  const dir = which === 'recordings' ? REC_DIR : NOTES_DIR;
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

// recording: the page mixes mic + PC sound and streams chunks here, we append them to a .webm file
let recFile = null;
ipcMain.handle('rec-start', () => {
  fs.mkdirSync(REC_DIR, { recursive: true });
  recFile = path.join(REC_DIR, `${stamp()} ${clock(new Date(), '-')}.webm`);
  fs.writeFileSync(recFile, Buffer.alloc(0));
  return recFile;
});
ipcMain.on('rec-chunk', (_, bytes) => { if (recFile) fs.appendFileSync(recFile, Buffer.from(bytes)); });
ipcMain.handle('rec-stop', () => { const f = recFile; recFile = null; return f; });

// ---------- spotify ----------
const spotify = require('./spotify')({ getClientId: () => config.spotifyClientId, tokenFile: path.join(app.getPath('userData'), 'spotify.json') });
let nowPlaying = null;

function spotifyState(extra = {}) {
  return { hasClientId: !!config.spotifyClientId, connected: spotify.connected(), now: nowPlaying, ...extra };
}

async function pollSpotify() {
  if (!spotify.connected()) return;
  try {
    const np = await spotify.nowPlaying();
    const changed = np?.id !== nowPlaying?.id || np?.playing !== nowPlaying?.playing;
    const newSong = np && np.playing && np.id !== nowPlaying?.id;
    nowPlaying = np;
    if (changed) win.webContents.send('spotify', spotifyState({ newSong }));
  } catch (e) { console.log('[spotify]', e.message); }
}

async function spotifyAction(action, query) {
  try {
    let msg = null;
    if (action === 'play' && query) msg = await spotify.search(query);
    else if (action === 'play' || action === 'resume') await spotify.play();
    else if (action === 'pause') await spotify.pause();
    else if (action === 'next') await spotify.next();
    else if (action === 'previous') await spotify.previous();
    setTimeout(pollSpotify, 700);
    return { ok: true, msg };
  } catch (e) {
    const msg = /premium/i.test(e.message) ? 'controlling playback needs spotify premium 😔' : e.message;
    win.webContents.send('spotify', spotifyState({ error: msg }));
    return { ok: false, msg };
  }
}

ipcMain.handle('spotify-state', () => spotifyState());
ipcMain.handle('spotify-action', (_, action, query) => spotifyAction(action, query));
ipcMain.handle('spotify-login', async (_, clientId) => {
  if (clientId) {
    config.spotifyClientId = clientId.trim();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  }
  try { await spotify.login(); await pollSpotify(); return spotifyState(); } catch (e) { return spotifyState({ error: e.message }); }
});
ipcMain.on('open-spotify-dashboard', () => shell.openExternal('https://developer.spotify.com/dashboard'));
ipcMain.handle('spotify-logout', () => { spotify.logout(); nowPlaying = null; return spotifyState(); });

// ---------- the bird ----------
const BIRD_PAD = 10; // bird.html draws the bird inset by this much so flapping isn't clipped
let birdWin, perch = null, flying = false;

function createBird() {
  birdWin = new BrowserWindow({
    width: 80, height: 60, show: false,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  birdWin.setAlwaysOnTop(true, 'screen-saver');
  birdWin.setIgnoreMouseEvents(true);
  birdWin.loadFile('bird.html');
}

// top-left of the bird window when the bird is sitting on its perch (follows the dude if he's dragged)
function perchPos() {
  const b = win.getBounds();
  return { x: b.x + perch.x - BIRD_PAD, y: b.y + perch.y - BIRD_PAD };
}

function flyBird() {
  if (flying || !perch || asleep) return;
  flying = true;
  const w = Math.round(perch.w + BIRD_PAD * 2), h = Math.round(perch.h + BIRD_PAD * 2);
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const start = perchPos();
  const stops = [start];
  for (let i = 0, n = 3 + Math.floor(Math.random() * 3); i < n; i++) {
    stops.push({ x: wa.x + Math.random() * (wa.width - w), y: wa.y + Math.random() * (wa.height * 0.75 - h) });
  }
  stops.push(null); // home: resolved live, in case the dude moved

  birdWin.setBounds({ x: Math.round(start.x), y: Math.round(start.y), width: w, height: h });
  birdWin.showInactive();
  win.webContents.send('bird', 'away');

  let leg = 0, t0 = Date.now(), dir = 0;
  const timer = setInterval(() => {
    const a = stops[leg], b = stops[leg + 1] || perchPos();
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const dur = Math.max(900, dist / 0.22); // ~220 px/s
    const t = Math.min(1, (Date.now() - t0) / dur);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in-out
    const wobble = Math.sin(t * Math.PI) * Math.sin(Date.now() / 120) * 8;
    // setBounds (not setPosition): with display scaling, repeated setPosition makes the window creep bigger
    birdWin.setBounds({ x: Math.round(a.x + (b.x - a.x) * e), y: Math.round(a.y + (b.y - a.y) * e + wobble), width: w, height: h });
    const d = Math.sign(b.x - a.x);
    if (d && d !== dir) { dir = d; birdWin.webContents.send('dir', d); }
    if (t < 1) return;
    leg++; t0 = Date.now();
    if (leg >= stops.length - 1) {
      clearInterval(timer);
      birdWin.hide();
      win.webContents.send('bird', 'home');
      flying = false;
    } else if (!stops[leg]) stops[leg] = b;
  }, 16);
}

function scheduleBird(first) {
  const ms = first ? 15000 : (config.birdFlyEveryMinutes || 3) * 60000 * (0.5 + Math.random());
  setTimeout(() => { try { flyBird(); } catch (e) { console.log('[bird] error', e); flying = false; } scheduleBird(); }, ms);
}

// ---------- vibing ----------
function tick() {
  const c = screen.getCursorScreenPoint();
  if (c.x !== lastCursor.x || c.y !== lastCursor.y) {
    lastCursor = c;
    lastMoveAt = Date.now();
    if (asleep) { asleep = false; win.webContents.send('wake'); }
  } else if (!asleep && Date.now() - lastMoveAt > config.sleepAfterIdleMinutes * 60000) {
    asleep = true;
    win.webContents.send('sleep');
  }
  const b = win.getBounds();
  const rel = { x: c.x - b.x, y: c.y - b.y };
  win.webContents.send('cursor', rel);

  // click-through everywhere except the dude / bubble / chat box
  const over = dragFrom || hitRects.some(r => rel.x >= r.x && rel.x <= r.x + r.w && rel.y >= r.y && rel.y <= r.y + r.h);
  if (over !== mouseOver) {
    mouseOver = over;
    win.setIgnoreMouseEvents(!over, { forward: true });
    win.webContents.send('hover', over);
  }
}
let hitRects = [];
let mouseOver = false;

app.whenReady().then(() => {
  // PC sound for recordings: answer getDisplayMedia with Windows' audio loopback (we throw the video away)
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(s => cb({ video: s[0], audio: 'loopback' }));
  });
  createWindow();
  createBird();
  setInterval(pollSpotify, 5000);
  scheduleBird(true);
  setInterval(tick, 100);
  setInterval(() => { if (watching && !asleep) think('comment'); }, config.commentEveryMinutes * 60000);
  setTimeout(() => { if (watching) think('comment'); }, 5000);
});

ipcMain.handle('assets', () => {
  const dir = path.join(__dirname, 'assets');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(png|gif|webp|apng)$/i.test(f)) : [];
});
ipcMain.handle('config', () => config);
ipcMain.on('hit-rects', (_, d) => { hitRects = d.rects; perch = d.perch; });
ipcMain.handle('sprite', () => {
  const f = path.join(__dirname, 'assets', 'sprite.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
});
ipcMain.on('focus', () => win.focus());
ipcMain.on('chat', (_, text) => think('chat', text));

let dragFrom = null;
ipcMain.on('drag-start', () => { dragFrom = { cursor: screen.getCursorScreenPoint(), pos: win.getPosition() }; });
ipcMain.on('drag-move', () => {
  if (!dragFrom) return;
  const c = screen.getCursorScreenPoint();
  win.setBounds({ x: dragFrom.pos[0] + c.x - dragFrom.cursor.x, y: dragFrom.pos[1] + c.y - dragFrom.cursor.y, width: W, height: H });
});
ipcMain.on('drag-end', () => { dragFrom = null; });

ipcMain.on('menu', () => {
  Menu.buildFromTemplate([
    { label: 'Say something now', click: () => think('comment') },
    { label: 'Let the bird fly', enabled: !!perch && !flying, click: flyBird },
    { label: 'Show all expressions', click: () => win.webContents.send('showcase') },
    { label: watching ? 'Stop watching my screen' : 'Start watching my screen', click: () => { watching = !watching; win.webContents.send('watching', watching); } },
    { label: 'Forget conversation', click: () => { history = []; } },
    { type: 'separator' },
    { label: 'Open notes folder', click: () => shell.openPath((fs.mkdirSync(NOTES_DIR, { recursive: true }), NOTES_DIR)) },
    { type: 'separator' },
    { label: 'Bye (quit)', click: () => app.quit() },
  ]).popup({ window: win });
});
