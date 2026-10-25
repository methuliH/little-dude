# little dude

A little guy who lives in the corner of your Windows desktop. He peeks at your screen, makes comments, chats with you, takes notes, controls your Spotify, and records audio. His bird flies around every now and then.

His brain is an AI command-line tool running in headless mode under your own login (set by `brainCommand` in `config.json`), so there's no API key to set up. Everything he says counts toward that plan's usage.

## Run him

Requires Node.js and the CLI named in `brainCommand`, installed and logged in.

```bash
npm install
npm start
```

Or double-click `start.bat`.

## Using him

- **Drag** him anywhere.
- **Right-click** for options: say something now, let the bird fly, show all expressions, stop watching my screen, open notes folder, quit.
- **Click** him to open his toolbar:
  - 💬 **Chat**: ask anything. He sees your screen when he answers. With Spotify connected you can say things like "play some lofi" or "skip this".
  - 📝 **Notes**: type and press `Ctrl+Enter`. Notes are added to one Markdown file per day in `Documents\Little Dude Notes`.
  - 🎵 **Spotify**: shows what's playing, has play/pause/skip buttons, and plays anything you type into the search box.
  - ⏺ **Record**: records your mic and your PC's sound mixed together, saved as `.webm` files in `Documents\Little Dude Notes\Recordings`. VLC, Chrome, and Windows Media Player can all play them.

He falls asleep after 5 idle minutes and stops commenting until you're back.

## Spotify setup (one time, ~5 minutes)

Spotify doesn't let apps connect without a "Client ID", so you make your own (free):

1. Go to <https://developer.spotify.com/dashboard> and log in. Click **Create app**.
2. Give it any name and description.
3. Under **Redirect URIs**, add exactly `http://127.0.0.1:8888/callback`.
4. Tick **Web API**, agree to the terms, and save.
5. Open the app's **Settings** and copy the **Client ID**.
6. Click little dude, open 🎵, paste the Client ID, and press **connect**. Then log in to Spotify in the browser tab that opens.

Showing what's playing works on any account. Playing, pausing, and skipping need **Spotify Premium** (a Spotify rule). If nothing happens, open Spotify on some device first so there's somewhere for the music to play.

## Settings (`config.json`)

| key | what it does |
|---|---|
| `name`, `personality` | who he is |
| `brainCommand` | the AI CLI he runs to think |
| `model` | model for his brain (`haiku` = fast and cheap, `sonnet` = smarter) |
| `commentEveryMinutes` | how often he comments on your screen |
| `sleepAfterIdleMinutes` | idle time before he falls asleep |
| `birdFlyEveryMinutes` | roughly how often the bird goes for a flight |
| `notesFolder` | where notes and recordings go (blank = `Documents\Little Dude Notes`) |
| `spotifyClientId` | filled in for you when you connect Spotify |
| `announceSongs` | he says the song name when a new track starts |

## Art

The character is in `assets/`: the body (`idle.png`), the bird (`bird.png`), and both eyes, which are cut out so they can blink and move. `sprite.json` says where each piece sits. `cutout.py` regenerates all of it from the original drawing:

```bash
python assets/cutout.py path/to/drawing.png assets
```

## Privacy

Each comment or chat sends a screenshot of your screen to the AI. Use **Stop watching my screen** in the right-click menu before opening anything private. Notes and recordings stay on your PC.
