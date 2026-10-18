// POST /api/compose: turns a plain-words description of a song into a Suno-ready package (style prompt, exclude
// list, settings, lyrics with structure tags, title ideas), a video plan for the visualisers (palette, art style,
// scene image prompts tied to the song's sections) and a YouTube kit. Also refines a previous result.
//
// Served on Vercel through api/compose.js, on Cloudflare Pages through functions/api/compose.js, and locally
// through dev-server.mjs.
// Environment:
//   ANTHROPIC_API_KEY   required
//   AI_MODEL            Claude model id (default claude-opus-5-5)
//   AI_EFFORT           low (default, about 30 s) | medium (about 60 s) | high
//   STUDIO_ACCESS_CODE  optional; when set, requests must send it (x-studio-code header) - keeps a public
//                       deployment from spending the key until payments exist
//   QUOTA               optional Cloudflare KV binding; with it, FREE_DAILY_LIMIT generations per visitor per day
//   FREE_DAILY_LIMIT    default 5
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';

const DEFAULT_MODEL = 'claude-opus-5-5';
const LIMITS = {
    'suno-v6': { style: 1000, lyrics: 5000, label: 'Suno v6' },
    'suno-v5': { style: 1000, lyrics: 5000, label: 'Suno v5' },
    'other': { style: 400, lyrics: 3000, label: 'Udio or another AI music tool' },
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export async function onRequestPost({ request, env }) {
    if (env.STUDIO_ACCESS_CODE && request.headers.get('x-studio-code') !== env.STUDIO_ACCESS_CODE) {
        return json({ error: 'Enter the access code to use the Studio.', needCode: true }, 401);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400); }
    const input = readInput(body);
    if (input.error) return json({ error: input.error }, 400);

    const quota = await useQuota(request, env);
    if (quota && quota.left < 0) return json({ error: 'You have used today\'s free generations. Come back tomorrow, or upgrade for unlimited.', quota }, 429);

    try {
        const parsed = await callClaude(env, buildSystemPrompt(input), buildUserPrompt(input));
        const { result, warnings } = tidy(parsed, input);
        return json({ result, warnings, quota });
    } catch (err) {
        if (err.expose) return json({ error: err.message }, err.status || 502);
        if (err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIError && err.status === 529)) {
            return json({ error: 'The writer is busy right now. Try again in a minute.' }, 429);
        }
        if (err instanceof Anthropic.AuthenticationError) {
            console.error('Anthropic rejected the API key.');
            return json({ error: 'The generator is not set up yet (API key missing or invalid).' }, 500);
        }
        console.error(err);
        return json({ error: 'Something went wrong writing that. Try again.' }, 502);
    }
}

// ---- Input ----
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function readInput(b) {
    const refine = b.refine && typeof b.refine === 'object' ? {
        instruction: text(b.refine.instruction, 500),
        previous: b.refine.previous && typeof b.refine.previous === 'object' ? b.refine.previous : null,
    } : null;
    const input = {
        description: text(b.description, 2000),
        target: pick(b.target, Object.keys(LIMITS), 'suno-v6'),
        vocal: pick(b.vocal, ['auto', 'female', 'male', 'duet', 'instrumental'], 'auto'),
        lyricsMode: pick(b.lyricsMode, ['write', 'mine'], 'write'),
        myLyrics: text(b.myLyrics, 5000),
        genres: Array.isArray(b.genres) ? b.genres.map(g => text(g, 40)).filter(Boolean).slice(0, 3) : [],
        mood: text(b.mood, 60),
        energy: pick(b.energy, ['auto', 'low', 'medium', 'high'], 'auto'),
        era: text(b.era, 60),
        language: text(b.language, 40) || 'English',
        length: pick(b.length, ['full', 'short'], 'full'),
        artist: text(b.artist, 80),
        refine,
    };
    if (refine) {
        if (!refine.instruction) return { error: 'Say what to change.' };
        if (!refine.previous || JSON.stringify(refine.previous).length > 40000) return { error: 'Nothing to refine yet.' };
    } else if (input.description.length < 3 && !(input.lyricsMode === 'mine' && input.myLyrics)) {
        return { error: 'Describe the song first.' };
    }
    return input;
}

// ---- Free daily limit (only when a KV namespace is bound as QUOTA) ----
async function useQuota(request, env) {
    if (!env.QUOTA) return null;
    const limit = Number(env.FREE_DAILY_LIMIT || 5);
    const who = request.headers.get('cf-connecting-ip') || 'unknown';
    const key = `q:${new Date().toISOString().slice(0, 10)}:${who}`;
    const used = Number(await env.QUOTA.get(key)) || 0;
    if (used >= limit) return { limit, left: -1 };
    await env.QUOTA.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
    return { limit, left: limit - used - 1 };
}

// ---- Prompts ----
function buildSystemPrompt(input) {
    const lim = LIMITS[input.target];
    const suno = input.target !== 'other';
    return `You are a senior music producer, top-line writer and music-video director. You turn a person's description of the song they imagine into a package they can paste straight into ${lim.label}, plus a plan for a visualiser video.

Fill in every field of the response:
{
  "titles": [3 short original song titles, best first],
  "style": "the Style of Music field",
  "exclude": "the Exclude Styles field",
  "settings": { "weirdness": 0-100, "styleInfluence": 0-100, "variety": 0-100 or null, "vocalGender": "female" | "male" | "none" | "auto", "why": "one sentence" },
  "lyrics": "the Lyrics field",
  "visual": {
    "visualizer": "monstercat" | "aetherflux",
    "accent": "#rrggbb",
    "palette": ["#rrggbb", "#rrggbb", "#rrggbb"],
    "artStyle": "one style line appended to every scene image prompt",
    "character": "a fixed description of the main character, or empty string",
    "scenes": [ { "section": "Intro | Verse 1 | Chorus | ...", "moment": "the lyric line or moment it illustrates", "prompt": "the image prompt" } ]
  },
  "youtube": { "title": "...", "description": "...", "tags": [...], "hashtags": [...] },
  "notes": [2 to 4 short sentences explaining the key choices]
}

STYLE FIELD (${lim.style} characters maximum; aim for ${suno ? '300 to 700' : '150 to 350'}):
- Comma-separated descriptive phrases. Lead with genre and sub-genre, then era or scene, tempo feel with an approximate BPM, 3 to 6 specific instruments or sounds, vocal character (gender, register, timbre, delivery), production and mix texture, and the emotional arc.
- Be concrete: "dusty Rhodes chords" not "keys"; "breathy alto close to the mic" not "nice vocals".
- Never name real artists, bands, producers or songs: Suno blocks them. Translate any reference into the sound itself (era, instruments, vocal timbre, production) and say so in notes.
- Never put negatives in the style field ("no drums" reads as "drums"). Negatives go in exclude.
- No contradictions (for example "lo-fi" with "pristine hi-fi mix").

EXCLUDE FIELD: comma-separated sounds or styles to keep out, chosen to protect the intended sound (for example a stray genre the description could drift into). Under 200 characters. Never repeat anything that is in the style field.

SETTINGS: ${suno ? `weirdness 10 to 30 for faithful genre songs, higher only for experimental requests. styleInfluence 55 to 85 (higher keeps Suno closer to the style field). variety: ${input.target === 'suno-v6' ? 'Suno v6 rewrites style prompts when variety is high; use 0 to 20 so the prompt is respected, higher only if the person wants surprises' : 'null (v5 has no variety setting)'}.` : 'weirdness and styleInfluence are guidance only; variety null.'}

LYRICS FIELD (${lim.lyrics} characters maximum):
- Structure tags in square brackets on their own lines: [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Final Chorus], [Outro]. You may add short performance cues in square brackets, such as [Soft piano intro] or [Whispered]. Do not use parentheses for directions; Suno sings parenthesised words as backing vocals.
- ${input.length === 'short' ? 'A short song for TikTok or Reels: about 30 to 60 seconds, for example [Intro] [Verse] [Chorus] [Outro], 400 to 800 characters.' : 'A full song of about 3 minutes: two verses of 4 to 8 lines, pre-choruses if they help, a chorus of 4 to 6 lines written out in full every time it repeats (Suno needs the words each time), a bridge and an outro. Usually 1,400 to 2,400 characters.'}
- Write like a professional: one point of view, a clear story arc (the second verse moves the story on, the bridge changes perspective), singable lines with consistent syllable counts, and rhyme: verses rhyme in couplets or alternate lines (ABAB or AABB), the chorus rhymes too.
- The chorus is 4 to 6 DIFFERENT lines built around one hook line. The hook may open and close the chorus, but never write the same line more than twice in a row.
- Every line needs a specific image, object or action ("the paper bag, the borrowed time"), not an abstraction. Before you finish, rewrite any line that a thousand other songs already contain: fire/desire, heart/apart, endless night, paint the sky, echo of your name, tide I cannot tame, shadows calling, we will rise.
- Lyrics in ${input.language}${input.language !== 'English' ? ' (titles and YouTube text may stay in English unless the person writes in that language)' : ''}. No real people's names, brands or slurs.
${input.vocal === 'instrumental' ? '- INSTRUMENTAL: no sung words. Use only section tags with instrument and arrangement cues, for example [Intro: lone cello] [Build] [Drop] [Breakdown] [Outro].' : ''}
${input.lyricsMode === 'mine' ? '- The person supplied their own lyrics. Keep their words. Only add or fix structure tags and performance cues. Do not rewrite lines unless the refine instruction asks you to.' : ''}

VIDEO PLAN:
- visualizer: "monstercat" (spectrum bars and particles with crossfading background scenes; right for most vocal songs, pop, hip-hop, R&B, rock, EDM) or "aetherflux" (a 3D particle galaxy; right for ambient, cinematic, trance, space or meditative music).
- accent: the colour of the spectrum bars. It must stand out on a dark background, so use a bright, saturated version of the song's key colour (never near-black or dark navy).
- palette: three colours that describe the song, first one the accent family.
- artStyle: one consistent illustration or photo style chosen for THIS song, ending with "no text, no watermark, 16:9". Range widely: cinematic 35mm film stills, anime film frames, contemporary ink wash, risograph print, oil painting, Super 8 home movie, neon noir photography, watercolour, claymation, 3D render. Pick the one that best carries the song's mood; never default to the same style.
- character: if the song has a narrator or main character, describe them once in a fixed way (age range, hair, clothing) that matches the vocal${input.vocal === 'female' ? ' (a woman)' : input.vocal === 'male' ? ' (a man)' : ''}, so every scene shows the same person. Never guess a gender the person did not give; if unknown, keep the character's face hidden or use objects and places.
- scenes: ${input.length === 'short' ? '3 to 5' : '8 to 12'} scenes in song order, one per section or key line, so the video follows the lyrics. Each prompt describes one clear, striking composition; mention the character by the word "the character" when they appear; no text or lettering in images.

YOUTUBE: title under 70 characters, using the first of your titles plus a short genre or feeling descriptor${input.artist ? ` and the artist "${input.artist}"` : ''}; description of two short paragraphs about the song's story and sound${input.artist ? '' : ' (no artist name)'}; 12 to 15 tags; 3 hashtags. If a tag or title mentions a year, it is ${new Date().getFullYear()}.

Everything must be original.`;
}

function buildUserPrompt(input) {
    if (input.refine) {
        return `Here is the current package:\n${JSON.stringify(input.refine.previous)}\n\nChange requested: ${input.refine.instruction}\n\nApply the change. Keep everything else the same unless the change requires it (for example a new mood also changes the style field, palette and scenes). Return the full JSON.`;
    }
    const lines = [`Song description: ${input.description || '(see the lyrics)'}`];
    if (input.genres.length) lines.push(`Genres: ${input.genres.join(', ')}`);
    if (input.mood) lines.push(`Mood: ${input.mood}`);
    if (input.energy !== 'auto') lines.push(`Energy: ${input.energy}`);
    if (input.era) lines.push(`Era or influence: ${input.era}`);
    lines.push(`Vocals: ${input.vocal === 'auto' ? 'choose what suits the song' : input.vocal}`);
    lines.push(`Language: ${input.language}`);
    if (input.lyricsMode === 'mine' && input.myLyrics) lines.push(`Their lyrics:\n${input.myLyrics}`);
    return lines.join('\n');
}

// ---- Model call ----
// The reply is constrained to this schema (structured outputs), so it always parses. Value ranges and list lengths
// are enforced afterwards in tidy(), not here: constraints the API can't apply would be checked client-side and
// fail the whole reply over one extra tag.
const Song = z.object({
    titles: z.array(z.string()),
    style: z.string(),
    exclude: z.string(),
    settings: z.object({
        weirdness: z.number(),
        styleInfluence: z.number(),
        variety: z.number().nullable(),
        vocalGender: z.enum(['female', 'male', 'none', 'auto']),
        why: z.string(),
    }),
    lyrics: z.string(),
    visual: z.object({
        visualizer: z.enum(['monstercat', 'aetherflux']),
        accent: z.string(),
        palette: z.array(z.string()),
        artStyle: z.string(),
        character: z.string(),
        scenes: z.array(z.object({ section: z.string(), moment: z.string(), prompt: z.string() })),
    }),
    youtube: z.object({
        title: z.string(),
        description: z.string(),
        tags: z.array(z.string()),
        hashtags: z.array(z.string()),
    }),
    notes: z.array(z.string()),
});

async function callClaude(env, system, user) {
    if (!env.ANTHROPIC_API_KEY) throw exposed('The generator is not set up yet (add ANTHROPIC_API_KEY).', 500);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
    const response = await client.beta.messages.parse({
        model: env.AI_MODEL || DEFAULT_MODEL,
        max_tokens: 16000,
        // If the model declines on policy grounds, the API retries on its default fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: env.AI_EFFORT || 'low', format: betaZodOutputFormat(Song) },
        system,
        messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') throw exposed('That request was declined. Try describing the song differently.', 422);
    if (response.stop_reason === 'max_tokens' || !response.parsed_output) throw exposed('The song came out too long. Try a shorter description or a short song.', 502);
    return response.parsed_output;
}

function exposed(message, status = 502) { const e = new Error(message); e.expose = true; e.status = status; return e; }

// ---- Clean-up and checks ----
const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Math.round(Number(n)))) : d);
// Plain hyphens and spaces: models like to emit non-breaking hyphens and spaces, which look odd once pasted.
const str = (v, max = 5000) => (typeof v === 'string' ? v.replace(/[‐‑‒]/g, '-').replace(/[  ]/g, ' ').trim().slice(0, max) : '');

// Cuts at the last comma before the limit, so a long style prompt loses whole phrases, not half a word.
function fitPhrases(s, max) {
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const at = cut.lastIndexOf(',');
    return (at > max * 0.6 ? cut.slice(0, at) : cut).trim();
}

function tidy(r, input) {
    const lim = LIMITS[input.target];
    const warnings = [];
    let style = str(r.style, 4000).replace(/\s+/g, ' ');
    if (style.length > lim.style) { style = fitPhrases(style, lim.style); warnings.push(`The style prompt was trimmed to fit ${lim.label}'s ${lim.style}-character limit.`); }
    let lyrics = str(r.lyrics, 20000);
    if (lyrics.length > lim.lyrics) { lyrics = lyrics.slice(0, lim.lyrics); warnings.push(`The lyrics were cut to ${lim.label}'s ${lim.lyrics}-character limit.`); }

    // Contradiction check: phrases in exclude that also appear in style.
    const styleLower = style.toLowerCase();
    const exclude = str(r.exclude, 400).split(',').map(s => s.trim()).filter(Boolean)
        .filter(p => { const clash = styleLower.includes(p.toLowerCase()); if (clash) warnings.push(`Removed "${p}" from exclude because the style asks for it.`); return !clash; })
        .join(', ');

    const s = r.settings || {};
    const v = r.visual || {};
    const palette = (Array.isArray(v.palette) ? v.palette : []).filter(c => HEX.test(c)).slice(0, 3);
    let accent = HEX.test(v.accent) ? v.accent : palette[0] || '#ff2d55';
    if (luminance(accent) < 0.18) accent = brighten(accent);
    const scenes = (Array.isArray(v.scenes) ? v.scenes : []).slice(0, 16).map(sc => ({
        section: str(sc.section, 40), moment: str(sc.moment, 200), prompt: str(sc.prompt, 1200),
    })).filter(sc => sc.prompt);
    const y = r.youtube || {};
    return {
        warnings,
        result: {
            target: input.target,
            titles: (Array.isArray(r.titles) ? r.titles : []).map(t => str(t, 80)).filter(Boolean).slice(0, 3),
            style, exclude, lyrics,
            settings: {
                weirdness: clamp(s.weirdness, 0, 100, 25),
                styleInfluence: clamp(s.styleInfluence, 0, 100, 70),
                variety: input.target === 'suno-v6' ? clamp(s.variety, 0, 100, 10) : null,
                vocalGender: pick(s.vocalGender, ['female', 'male', 'none', 'auto'], 'auto'),
                why: str(s.why, 300),
            },
            visual: {
                visualizer: pick(v.visualizer, ['monstercat', 'aetherflux'], 'monstercat'),
                accent, palette: palette.length ? palette : [accent],
                artStyle: str(v.artStyle, 400), character: str(v.character, 400), scenes,
            },
            youtube: {
                title: str(y.title, 100), description: str(y.description, 2000),
                tags: (Array.isArray(y.tags) ? y.tags : []).map(t => str(t, 60)).filter(Boolean).slice(0, 20),
                hashtags: (Array.isArray(y.hashtags) ? y.hashtags : []).map(t => str(t, 40)).filter(Boolean).slice(0, 5),
            },
            notes: (Array.isArray(r.notes) ? r.notes : []).map(n => str(n, 300)).filter(Boolean).slice(0, 5),
        },
    };
}

// Relative luminance of a hex colour (0 black to 1 white), and a lift for colours too dark to read as bars.
function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
}
function brighten(hex) {
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    const m = Math.max(r, g, b, 1), k = 230 / m;
    r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
