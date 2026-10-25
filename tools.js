// toolbar + panels that pop up when you click him: chat, notes, spotify, recording.
// Uses $, say, setMood, hop, talk, dude, input, bubble, config from index.html.
const PANELS = ['chat', 'notes', 'spot', 'rec'];
let openPanel = 'chat';

function showPanel(name) {
  openPanel = name;
  for (const p of PANELS) $(p).classList.toggle('show', p === name);
  document.querySelectorAll('#toolbar button').forEach(b => b.classList.toggle('on', b.dataset.panel === name));
  if (name === 'spot') refreshSpotify();
  window.pet.focus();
  const focusEl = { chat: input, notes: $('noteText'), spot: spot.connected ? $('spotQuery') : $('spotClientId') }[name];
  if (focusEl) setTimeout(() => focusEl.focus(), 50);
}

function togglePanels(force) {
  const show = force ?? !$('toolbar').classList.contains('show');
  $('toolbar').classList.toggle('show', show);
  if (show) { hop(); showPanel(openPanel); } else for (const p of PANELS) $(p).classList.remove('show');
}

$('toolbar').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showPanel(b.dataset.panel); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') togglePanels(false); });
document.querySelectorAll('[data-open]').forEach(b => { b.onclick = () => window.pet.openFolder(b.dataset.open); });

function react(mood, line, ms = 3000) { setMood(mood); say(line); talk(500 + line.length * 40); hop(); setTimeout(() => setMood('idle'), ms); }

// ---------- notes ----------
const noteText = $('noteText');
try { noteText.value = localStorage.getItem('noteDraft') || ''; } catch {}
noteText.addEventListener('input', () => { try { localStorage.setItem('noteDraft', noteText.value); } catch {} });

async function saveNote() {
  if (!noteText.value.trim()) return;
  const file = await window.pet.saveNote(noteText.value);
  noteText.value = '';
  try { localStorage.removeItem('noteDraft'); } catch {}
  $('noteMsg').textContent = `saved → ${file.split(/[\\/]/).slice(-2).join('/')}`;
  react('happy', 'noted ✍️');
}
$('noteSave').onclick = saveNote;
noteText.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) saveNote(); });

// ---------- spotify ----------
let spot = { hasClientId: false, connected: false, now: null };

function renderSpotify(s) {
  spot = s;
  $('spotSetup').style.display = s.connected ? 'none' : '';
  $('spotPlayer').style.display = s.connected ? '' : 'none';
  if (s.hasClientId) $('spotClientId').placeholder = 'client id saved — just hit connect';
  const n = s.now;
  $('spotTitle').textContent = n ? n.title : 'nothing playing';
  $('spotArtist').textContent = n ? n.artist : 'play something on any device';
  if (n?.art) $('spotArt').src = n.art; else $('spotArt').removeAttribute('src');
  $('spotToggle').textContent = n?.playing ? '⏸' : '▶';
  $('spotMsg').textContent = s.error || '';
}
async function refreshSpotify() { renderSpotify(await window.pet.spotifyState()); }

window.pet.on('spotify', s => {
  renderSpotify(s);
  if (s.error) react('sad', s.error);
  else if (s.newSong && config.announceSongs && !bubble.classList.contains('show')) react('happy', `♪ ${s.now.title} – ${s.now.artist}`, 4000);
});
$('spotDash').onclick = () => window.pet.openSpotifyDashboard();
$('spotConnect').onclick = async () => {
  const id = $('spotClientId').value.trim();
  if (!id && !spot.hasClientId) { $('spotMsg').textContent = 'paste a client id first'; return; }
  $('spotMsg').textContent = 'finish logging in in your browser…';
  const s = await window.pet.spotifyLogin(id);
  renderSpotify(s);
  if (s.connected) react('excited', 'ooh we have music now 🎶');
};
$('spotLogout').onclick = async () => renderSpotify(await window.pet.spotifyLogout());
document.querySelectorAll('[data-sp]').forEach(b => { b.onclick = () => window.pet.spotifyAction(b.dataset.sp); });
$('spotToggle').onclick = () => window.pet.spotifyAction(spot.now?.playing ? 'pause' : 'play');
$('spotQuery').addEventListener('keydown', async e => {
  const q = e.target.value.trim();
  if (e.key !== 'Enter' || !q) return;
  e.target.value = '';
  $('spotMsg').textContent = 'searching…';
  const r = await window.pet.spotifyAction('play', q);
  $('spotMsg').textContent = r.msg || '';
});
refreshSpotify();

// ---------- recording: mic + PC sound mixed into one file ----------
let rec = null;

async function startRecording() {
  $('recMsg').textContent = 'starting…';
  try {
    const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); // main answers with audio loopback
    sys.getVideoTracks().forEach(t => t.stop());
    let mic = null;
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {} // no mic → PC sound only

    const ctx = new AudioContext();
    const mix = ctx.createMediaStreamDestination();
    const sysTracks = sys.getAudioTracks();
    if (sysTracks.length) ctx.createMediaStreamSource(new MediaStream(sysTracks)).connect(mix);
    if (mic) ctx.createMediaStreamSource(mic).connect(mix);
    if (!sysTracks.length && !mic) throw new Error('no audio sources found');

    const file = await window.pet.recStart();
    const mr = new MediaRecorder(mix.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
    let chain = Promise.resolve(); // keep chunks in order
    mr.ondataavailable = e => {
      if (e.data.size) chain = chain.then(async () => window.pet.recChunk(new Uint8Array(await e.data.arrayBuffer())));
    };
    mr.start(1000);
    rec = { mr, ctx, streams: [sys, mic].filter(Boolean), file, started: Date.now(), done: () => chain };
    rec.timer = setInterval(() => {
      const s = Math.floor((Date.now() - rec.started) / 1000);
      $('recTime').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    dude.classList.add('recording');
    $('recBtn').textContent = '⏹ stop';
    $('recMsg').textContent = `recording ${[mic && 'mic', sysTracks.length && 'PC sound'].filter(Boolean).join(' + ')}…`;
    react('excited', "ooh we're recording 🎙️");
  } catch (e) {
    $('recMsg').textContent = `couldn't start: ${e.message}`;
    react('sad', "couldn't start recording 😔");
  }
}

async function stopRecording() {
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  await new Promise(res => { r.mr.onstop = res; r.mr.stop(); });
  await r.done();
  r.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
  r.ctx.close();
  await window.pet.recStop();
  dude.classList.remove('recording');
  $('recBtn').textContent = '⏺ record';
  $('recMsg').textContent = `saved → ${r.file.split(/[\\/]/).slice(-2).join('/')}`;
  react('happy', 'saved the recording 💾');
}

$('recBtn').onclick = () => (rec ? stopRecording() : startRecording());
