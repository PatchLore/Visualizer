# Music Visualiser

Describe the music you imagine, get a Suno-ready package, then turn the finished track into a visualiser video.

- **Song Studio** (`index.html`): a plain-words description becomes a Suno style prompt (checked against the
  1,000-character limit, artist names translated into sound), an Exclude list, Weirdness / Style influence /
  Variety settings, lyrics with structure tags, three titles, a scene-by-scene video plan (palette, art style,
  image prompts tied to the lyrics), a YouTube kit and notes explaining the choices. Any result can be rewritten
  with a chip or a sentence. Written by Claude; the engine is `api/_lib/compose.js`.
- **Three visualisers** that run entirely in the browser and export full-length MP4s. Audio and images stay on the
  user's computer. "Make the video" in the Studio opens the right one with the title, artist and colour set.
  - **AetherFlux** (`aetherflux.html`): a 3D particle galaxy (three.js) that morphs between seven shapes, a
    beat-reactive centre with a logo, a classic spectrum, and a scene timeline.
  - **Monstercat** (`monstercat.html`): Monstercat-style spectrum bars, bass-driven particles, logo and
    artist/title (under the bars or top left), and background scenes that crossfade during the song.
  - **KINETIX** (`kinetix.html`): six WebGL shaders (tunnel, mandala, plasma, vortex, hex grid, synthwave) driven
    by the track's bass, mids and highs, with artist/title text. Loading a track runs the **auto-director**
    (`js/director.js`): it finds the tempo, beats, bars and sections (intro, groove, build, drop, breakdown,
    outro) and plans the video: shader changes on phrase lines (cuts with a glitch into drops, crossfades into calm
    parts, a new look every 16 bars in long sections), 8-bit builds that snap sharp on the drop, a flash, one-beat
    invert and hyperdrive on arrival, and glitch or 8-bit fills at phrase ends. The plan shows on a timeline where
    scenes and effects can be dragged (snapping to beats), retimed, added or removed; Regenerate gives another plan
    and ½/2× fixes a tempo detected an octave off. The plan is plain data, so the preview and the MP4 match. It
    also works as a live VJ tool: mic input, tap tempo and a built-in kick, hold-to-play FX pads and keys,
    fullscreen, and short WebM loop recordings.
- **LOOP//FORGE** (`loopforge.html`): seamless looping GIFs from six VFX shaders (no track needed), for Discord,
  socials and stream overlays. Every motion completes whole turns, palette cycles or grid cells over the loop, so
  the last frame flows into the first. Encoded in the browser with [gifenc](https://github.com/mattdesl/gifenc)
  (loaded from jsDelivr, pinned to 1.0.3) using one palette for the whole loop, so colours don't flicker, with an
  optional fixed ordered dither to smooth the glows. Works on phones too, since it doesn't need WebCodecs.
  **Describe a loop** writes a new one from a prompt: `api/_lib/shader.js` has Claude write a GLSL `scene()`
  function to the same seamless rules, and the page compiles it and checks it (it compiles, isn't black, moves,
  matches itself after one loop, and draws a 480x480 frame in under 250 ms). Anything that fails goes back with the
  problem for a fix, twice at most. Working loops become presets saved in the browser, and can be changed with a
  sentence ("make it blue"). Abstract and graphic ideas work best; real-world subjects come out as neon line art.

## Run it locally

```bash
npm install
```

Put your Anthropic API key in `.env` (`ANTHROPIC_API_KEY=...`; the file is git-ignored), then:

```bash
npm run dev
```

and open http://127.0.0.1:4330. The dev server serves the site and runs `functions/api/*.js` the way Cloudflare
Pages does. Optional settings in `.env`: `AI_MODEL` (default `claude-opus-5-5`) and `AI_EFFORT` (`low` by default,
about 30 seconds per song; `medium` is about a minute). WebCodecs needs `localhost` or HTTPS, so opening the HTML
files directly won't export.

## Deploy

### Vercel (current)

The repo deploys to Vercel as a static site plus two functions: `api/compose.js` (the Song Studio) and
`api/shader.js` (LOOP//FORGE's loop writer), which wrap the engines in `api/_lib/` (`vercel.json` gives each up to
60 seconds). Vercel never serves `api/` as static files, so the prompts stay private. No build step.

In the Vercel project, under Settings → Environment Variables, add:

- `ANTHROPIC_API_KEY` (required)
- `STUDIO_ACCESS_CODE` (recommended until payments exist): the Studio asks for this code once per browser, so
  strangers who find the URL can't spend your key
- `AI_MODEL` / `AI_EFFORT` if you change them
- `SHADER_EFFORT` for the loop writer: `low` by default (about 15 seconds per loop), `medium` takes about 55 seconds,
  too close to Vercel's 60-second limit

Redeploy after changing variables.

### Cloudflare Pages (alternative)

Create a Pages project from the repo (no build command, output directory `/`); Cloudflare runs
`functions/api/compose.js` and `functions/api/shader.js`, which re-export the same engines. Add the same variables under Settings → Variables and Secrets. Binding a KV
namespace as `QUOTA` turns on a free daily limit per visitor (`FREE_DAILY_LIMIT`, default 5 songs;
`SHADER_DAILY_LIMIT`, default 20 loop requests, fixes included).

`test-assets/`, `Music/`, `.env` and `node_modules/` are git-ignored and never deployed.

## How export works

`js/export.js` loads the visualiser again in a hidden iframe sized exactly 1920x1080 (or 1080x1920 for Shorts), so
the page draws as it would full screen at that size. The page analyses the track offline (`__setupExport`) and
draws each frame on request (`__renderExportFrame`), so the video is frame-accurate however slow the computer is.
Frames are encoded with WebCodecs (H.264, falling back to VP9) and the audio with AAC (falling back to Opus), then
muxed into an MP4 with [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (loaded from jsDelivr, pinned to 5.2.2).

In Chrome and Edge the MP4 streams straight to a file the user picks, so long tracks don't fill memory. Other
browsers build the file in memory, with the bitrate scaled down for long tracks, and offer it as a download.

When the render finishes it stays on screen: a completion panel says the video is ready and has a **Download MP4**
button (or, when streaming to disk, shows where the file was saved). Nothing is auto-downloaded, because browsers
block a download started that long after the click and the file then looks lost. Rendering is refused on phones and
tablets, where the tab runs out of memory and reloads part-way through.

Expect roughly 2x the track length for Monstercat and KINETIX and 3x for AetherFlux on a typical laptop.

## Browser support

| Browser | Export |
|---|---|
| Chrome, Edge (desktop) | H.264, with AAC audio where the system provides an AAC encoder (Windows, macOS), otherwise Opus; streamed to disk |
| Firefox | Expected to work in memory with Opus audio; not tested |
| Safari 16.4+ | Not tested |
| Phones | Live view only; exporting is not supported |

Tested so far in a Chromium-based browser on Windows (H.264 + Opus, in-memory path).

## Origin

Split out of the RemotionVideo studio, where the same pages export through a server (headless Chrome + ffmpeg).
The two copies are now separate; changes to one aren't copied to the other.

Third-party code: three.js r128 and the Tailwind Play CDN build are in `vendor/`. The Monstercat style follows the
approach in caseif/vis.js (reimplemented). Not affiliated with Monstercat.
