# Music Visualiser

Describe the music you imagine, get a Suno-ready package, then turn the finished track into a visualiser video.

- **Song Studio** (`index.html`): a plain-words description becomes a Suno style prompt (checked against the
  1,000-character limit, artist names translated into sound), an Exclude list, Weirdness / Style influence /
  Variety settings, lyrics with structure tags, three titles, a scene-by-scene video plan (palette, art style,
  image prompts tied to the lyrics), a YouTube kit and notes explaining the choices. Any result can be rewritten
  with a chip or a sentence. Written by Claude; the engine is `api/_lib/compose.js`.
- **Visualisers** that run entirely in the browser and export MP4s. Audio and images stay on the
  user's computer. "Make the video" in the Studio opens the right one with the title, artist and colour set.
  - **AetherFlux** (`aetherflux.html`): a 3D particle galaxy (three.js) that morphs between seven shapes, a
    beat-reactive centre with a logo, a classic spectrum, and a scene timeline.
  - **Spectrum** (`spectrum.html`, formerly Monstercat; `monstercat.html` redirects): classic label-style spectrum bars, bass-driven particles, logo and
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
  **Video loops (MP4)**: Spotify Canvas (9:16, 8 s), Reels/TikTok (9:16, 15 s), square (10 s) or YouTube (16:9, 15 s),
  1080p at 30 fps with no audio track (`silent` in `js/export.js`, 8 Mbps). The loop repeats a whole number of times,
  so the video loops seamlessly too.
  **Describe a loop** writes a new one from a prompt: `api/_lib/shader.js` has Claude write a GLSL `scene()`
  function to the same seamless rules, and the page compiles it and checks it (it compiles, isn't black, moves,
  matches itself after one loop, and draws a 480x480 frame in under 250 ms). Anything that fails goes back with the
  problem for a fix, twice at most. Working loops become presets saved in the browser, and can be changed with a
  sentence ("make it blue"). Abstract and graphic ideas work best; real-world subjects come out as neon line art.
- **ChromaFlow** (`chromaflow.html`): a cover-art reveal. An uploaded image (or one of four presets) is painted as a
  time-lapse in six brush styles, coarse to fine, and completes on the reveal: by default the track's first drop,
  found by the auto-director, with the clip set around it. Kicks paint bigger bursts, snares throw splatters and
  hi-hats speed up the swirl. On the reveal it flashes and snaps to the crisp original (or keeps the painting), then
  holds it with RGB split and zoom on kicks, drifting dust and the title. Strokes are scheduled per frame from the
  track's analysis and drawn with a seeded random generator, so the preview and the MP4 are identical. Exports 9:16,
  1:1 or 16:9 clips of 15-60 s (or the whole track) with the clip's audio; without a track, a silent time-lapse.

## Short clips (Drop Hunter)

Spectrum and KINETIX have a clip picker by the Export button: choose 15, 30 or 60 seconds and **Find the best
moments** lists the three strongest clips (with a preview button each); AetherFlux has a "Best 15/30/60 s" choice
that takes the strongest automatically. `js/clips.js` scores clips from the auto-director's sections and bars: a clip
opens on a bar about a third before a lift in the music (usually a drop), and scores on its average energy plus the
size of the lift. The export renders only that stretch: the page warms its motion up to the clip's first frame, and
`js/export.js` cuts the audio from the clip's start (`start` from `__setupExport`) and fades it in and out (`fade`).

## Lyric sync

Spectrum and KINETIX have a Lyrics panel: paste the lyrics (the Studio's lyrics come across with "Make the video"),
press **Sync to the vocal**, check the lines and nudge any that are off. An `.lrc` file (timed lyrics from a
distributor or lyric service, imported or pasted) is used as it is, with no sync request; word stamps, repeated
line stamps and the offset tag are read. Synced lyrics are drawn word by word in the
preview and the MP4, and saved in the browser per track, so a reload doesn't cost another sync.

`js/lyrics.js` makes a small mono copy of the track in the browser (AAC or Opus in MP4, about 1.2 MB for a 4.7-minute
song, under Vercel's 4.5 MB request limit) and `/api/lyrics` (`api/_lib/lyrics.js`) asks Groq's Whisper large-v3 for
word timestamps with the lyrics as a hint. The page then matches Whisper's words to the real lyrics, spreads missed
words between their neighbours, and moves each word's start to where the voice comes in (vocal-band energy). The
same method as the RemotionVideo project's `tools/sync-lyrics.mjs`.

Needs `GROQ_API_KEY` (in `.env` locally, in Vercel for the live site); it uses the Studio's access code and the
daily limits below (`LYRICS_DAILY_LIMIT`, default 10 syncs per visitor).

## Home page, Pro and analytics

- **Demo video**: `examples/demo.mp4` (720p, 36 s, with sound) plays from the top of the home page. It was rendered
  from the app itself (title and end cards, the Studio with a real result, Spectrum, AetherFlux and KINETIX on one
  stretch of a track, and LOOP//FORGE), with the track's audio added in ffmpeg. The 1080p master for sharing is kept
  locally in `promo/`, which is neither committed nor deployed.
- **Showcase**: the home page opens with real exports in `examples/` (muted MP4s with poster frames, played only
  while on screen, never for people who prefer reduced motion). They were rendered from this app's own export hooks.
- **Free and Pro**: the visualisers and GIF presets are free; Pro is the Song Studio and AI loops, which already need
  the access code (`STUDIO_ACCESS_CODE`) when one is set. Put a Stripe Payment Link and the price in `js/config.js`;
  until then the button says "Coming soon". Stripe collects the buyer's email: reply with the access code.
  Cancelling the access-code prompt in the Studio or LOOP//FORGE points to Pro.
- **Analytics**: `js/analytics.js` loads Vercel Web Analytics on every page (switch on Analytics in the Vercel
  project; nothing loads locally) and records key events with `track()`: Studio song, Make the video, Export
  started and Export finished (per visualiser), AI loop, GIF rendered and Get Pro. Custom events need a Vercel plan
  that includes them; page views work on every plan.

## Run it locally

```bash
npm install
```

Copy `.env.example` to `.env` and put in your Anthropic API key (`ANTHROPIC_API_KEY=...`; `.env` is git-ignored), then:

```bash
npm run dev
```

and open http://127.0.0.1:4330. The dev server serves the site and runs `functions/api/*.js` the way Cloudflare
Pages does. Optional settings in `.env`: `AI_MODEL` (default `claude-opus-5-5`) and `AI_EFFORT` (`low` by default,
about 30 seconds per song; `medium` is about a minute). WebCodecs needs `localhost` or HTTPS, so opening the HTML
files directly won't export.

## Deploy

### Vercel (current)

The repo deploys to Vercel as a static site plus three functions: `api/compose.js` (the Song Studio),
`api/shader.js` (LOOP//FORGE's loop writer) and `api/lyrics.js` (lyric sync), which wrap the engines in `api/_lib/` (`vercel.json` gives each up to
60 seconds). Vercel never serves `api/` as static files, so the prompts stay private. No build step.

In the Vercel project, under Settings → Environment Variables, add:

- `ANTHROPIC_API_KEY` (required)
- `GROQ_API_KEY` (for lyric sync)
- `STUDIO_ACCESS_CODE` (recommended until payments exist): the Studio asks for this code once per browser, so
  strangers who find the URL can't spend your key
- `AI_MODEL` / `AI_EFFORT` if you change them
- `SHADER_EFFORT` for the loop writer: `low` by default (about 15 seconds per loop), `medium` takes about 55 seconds,
  too close to Vercel's 60-second limit
- Daily limits (see below): connect Upstash Redis for limits that hold across Vercel's instances

Redeploy after changing variables.

### Sharing previews and search

Every page has a description, a canonical link, OpenGraph and Twitter card tags with its own 1200x630 image in `og/`,
and the icons (`favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`); `robots.txt` and `sitemap.xml` sit at the root.
They use the live address, https://visualizer-eight-nu.vercel.app: with a custom domain, replace it in the `.html`
pages, `robots.txt` and `sitemap.xml`. `vercel.json` redirects the old `monstercat.html` to `spectrum.html` (301).

### Daily limits

The three AI endpoints (the Studio, the loop writer and lyric sync) count requests per visitor per day in
`api/_lib/limits.js` and answer 429 when a limit is reached; the pages show the message. Defaults:
`FREE_DAILY_LIMIT` 5 songs, `SHADER_DAILY_LIMIT` 20 loop requests (fixes included), `LYRICS_DAILY_LIMIT` 10 syncs.
Visitors who send the access code get `PRO_LIMIT_FACTOR` times as many (default 10). `AI_DAILY_LIMIT` optionally caps
all AI requests per day across every visitor, a ceiling on the day's cost.

Counters are kept in a Cloudflare KV namespace bound as `QUOTA`, else in Upstash Redis
(`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` + `KV_REST_API_TOKEN` as Vercel's Upstash
integration names them: Vercel → Storage → Upstash, free tier), else in the server's memory. Memory is only a
fallback: Vercel runs several short-lived instances, each counting on its own. Also set a monthly spending limit on
the Anthropic and Groq keys.

### Cloudflare Pages (alternative)

Create a Pages project from the repo (no build command, output directory `/`); Cloudflare runs
`functions/api/compose.js`, `functions/api/shader.js` and `functions/api/lyrics.js`, which re-export the same engines.
Add the same variables under Settings → Variables and Secrets, and bind a KV namespace as `QUOTA` for the daily
limits.

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

Expect roughly 2x the track length for Spectrum and KINETIX and 3x for AetherFlux on a typical laptop.

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

Third-party code: three.js r128 and the Tailwind Play CDN build are in `vendor/`. The Spectrum bar analysis follows the
approach in caseif/vis.js (reimplemented).
