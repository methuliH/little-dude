// Spotify Web API with PKCE login (no client secret needed). Tokens live in tokenFile.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const { shell } = require('electron');

const PORT = 8888;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

module.exports = function createSpotify({ getClientId, tokenFile }) {
  let tok = null;
  try { tok = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch {}

  function saveTok(t) {
    tok = { access_token: t.access_token, refresh_token: t.refresh_token || tok?.refresh_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 };
    fs.writeFileSync(tokenFile, JSON.stringify(tok));
  }

  async function tokenRequest(params) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: getClientId(), ...params }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error_description || j.error || `token request failed (${res.status})`);
    saveTok(j);
  }

  // opens the browser, waits for Spotify to redirect back to our little local server
  function login() {
    return new Promise((resolve, reject) => {
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const state = b64url(crypto.randomBytes(12));
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, REDIRECT);
        if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const done = (msg, err) => {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<body style="font:18px sans-serif;text-align:center;padding:60px">${msg}</body>`);
          server.close();
          clearTimeout(timeout);
          err ? reject(err) : resolve();
        };
        if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) return done('login cancelled', new Error(url.searchParams.get('error') || 'cancelled'));
        try {
          await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: verifier });
          done('✅ little dude is connected to your Spotify. you can close this tab.');
        } catch (e) { done('login failed: ' + e.message, e); }
      });
      const timeout = setTimeout(() => { server.close(); reject(new Error('login timed out')); }, 5 * 60000);
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', () => {
        shell.openExternal('https://accounts.spotify.com/authorize?' + new URLSearchParams({
          client_id: getClientId(), response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES,
          code_challenge_method: 'S256', code_challenge: challenge, state,
        }));
      });
    });
  }

  async function api(method, path, body, retried) {
    if (!tok) throw new Error('not connected');
    if (Date.now() > tok.expires_at) await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token });
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) { tok.expires_at = 0; return api(method, path, body, true); }
    if (res.status === 204) return null;
    const text = await res.text();
    const j = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(j?.error?.message || `spotify error ${res.status}`);
      err.reason = j?.error?.reason;
      throw err;
    }
    return j;
  }

  // play/pause/skip need an active device; if none, wake up the first one we can see
  async function withDevice(fn) {
    try { return await fn(''); } catch (e) {
      if (e.reason !== 'NO_ACTIVE_DEVICE') throw e;
      const { devices } = await api('GET', '/me/player/devices');
      if (!devices.length) throw new Error('open spotify on any device first');
      return fn(`?device_id=${devices[0].id}`);
    }
  }

  return {
    connected: () => !!tok,
    login,
    logout() { tok = null; try { fs.unlinkSync(tokenFile); } catch {} },

    async nowPlaying() {
      const r = await api('GET', '/me/player/currently-playing');
      if (!r || !r.item) return null;
      return {
        id: r.item.id, title: r.item.name, artist: r.item.artists.map(a => a.name).join(', '),
        art: r.item.album?.images?.at(-1)?.url, playing: r.is_playing,
      };
    },
    play: () => withDevice(q => api('PUT', `/me/player/play${q}`)),
    pause: () => api('PUT', '/me/player/pause'),
    next: () => withDevice(q => api('POST', `/me/player/next${q}`)),
    previous: () => withDevice(q => api('POST', `/me/player/previous${q}`)),

    // "play <anything>": a playlist if it sounds like a vibe, otherwise the best matching track
    async search(query) {
      const r = await api('GET', `/search?${new URLSearchParams({ q: query, type: 'track,playlist', limit: 5 })}`);
      const track = r.tracks?.items?.find(Boolean);
      const playlist = r.playlists?.items?.find(Boolean);
      const vibe = /\b(music|songs|vibes?|playlist|mix|lofi|lo-fi|chill|study|focus|sleep|workout)\b/i.test(query);
      if (vibe && playlist) {
        await withDevice(q => api('PUT', `/me/player/play${q}`, { context_uri: playlist.uri }));
        return `▶ ${playlist.name}`;
      }
      if (!track) throw new Error(`couldn't find "${query}"`);
      await withDevice(q => api('PUT', `/me/player/play${q}`, { uris: [track.uri] }));
      return `▶ ${track.name} – ${track.artists.map(a => a.name).join(', ')}`;
    },
  };
};
