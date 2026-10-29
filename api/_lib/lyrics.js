// POST /api/lyrics: word timings for a song, for lyric videos. The page sends a small mono copy of the track
// (multipart field "audio", a few hundred KB) and a hint built from the lyrics (field "prompt"); this asks Groq's
// Whisper large-v3 for word timestamps and returns them. Matching them to the real lyrics and tightening each word's
// start against the vocal happen in the page (js/lyrics.js), which already has the audio decoded.
//
// Served on Vercel through api/lyrics.js, on Cloudflare Pages through functions/api/lyrics.js, and locally through
// dev-server.mjs. Uses the Studio's access code and quota settings (see api/_lib/compose.js), plus:
//   GROQ_API_KEY          required (Claude can't time audio; this is a speech-recognition model)
//   LYRICS_DAILY_LIMIT    syncs per visitor per day when QUOTA is bound (default 10)
import { useQuota } from './compose.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const MAX_BYTES = 4 * 1024 * 1024;   // under Vercel's 4.5 MB request limit

export async function onRequestPost({ request, env }) {
    if (env.STUDIO_ACCESS_CODE && request.headers.get('x-studio-code') !== env.STUDIO_ACCESS_CODE) {
        return json({ error: 'Enter the access code to sync lyrics.', needCode: true }, 401);
    }
    if (!env.GROQ_API_KEY) return json({ error: 'Lyric sync is not set up yet (add GROQ_API_KEY).' }, 500);
    let form;
    try { form = await request.formData(); } catch { return json({ error: 'Send the audio as multipart form data.' }, 400); }
    const audio = form.get('audio');
    if (!audio || typeof audio === 'string' || !audio.size) return json({ error: 'No audio was sent.' }, 400);
    if (audio.size > MAX_BYTES) return json({ error: 'The audio is too large to sync. Try a shorter track.' }, 413);
    const prompt = String(form.get('prompt') || '').slice(0, 880);
    const language = /^[a-z]{2}$/.test(String(form.get('language') || '')) ? String(form.get('language')) : '';

    const quota = await useQuota(request, env, { prefix: 'lyrics', limit: Number(env.LYRICS_DAILY_LIMIT || 10) });
    if (quota && quota.left < 0) return json({ error: 'You have used today\'s free lyric syncs. Come back tomorrow.', quota }, 429);

    const body = new FormData();
    body.append('file', audio, audio.name || 'track.m4a');
    body.append('model', 'whisper-large-v3');
    body.append('response_format', 'verbose_json');
    body.append('timestamp_granularities[]', 'word');
    if (language) body.append('language', language);
    if (prompt) body.append('prompt', prompt);
    for (let attempt = 1; ; attempt++) {
        let res;
        try {
            res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST', headers: { authorization: `Bearer ${env.GROQ_API_KEY}` }, body,
            });
        } catch (err) {
            if (attempt < 3) { await new Promise(r => setTimeout(r, 1500 * attempt)); continue; }
            console.error(err);
            return json({ error: 'Could not reach the lyric timing service. Try again.' }, 502);
        }
        if (res.ok) {
            const data = await res.json();
            const words = (data.words || []).map(w => ({ word: String(w.word || '').trim(), start: +w.start, end: +w.end })).filter(w => w.word && Number.isFinite(w.start));
            return json({ words, text: data.text || '', quota });
        }
        if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
        if (res.status === 401) { console.error('Groq rejected the API key.'); return json({ error: 'Lyric sync is not set up yet (the Groq key is invalid).' }, 500); }
        console.error('Groq error', res.status, (await res.text()).slice(0, 300));
        return json({ error: res.status === 429 ? 'The lyric timing service is busy. Try again in a minute.' : 'The lyric timing service could not read that audio.' }, 502);
    }
}
