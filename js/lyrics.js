// Lyric sync for the visualisers: times every lyric word to the sung vocal (or takes the timings from an LRC file),
// lets the user check and nudge the lines, and draws them word by word.
//
//   const panel = LyricSync.mount(container, { getFile, getTime, seek, onChange, initialText });
//   panel.trackChanged();                       // after a new track loads (restores a sync saved for it)
//   LyricSync.draw(ctx, W, H, t, lines, opts);  // in the frame loop and the export
//
// Timing: the page makes a small mono copy of the track (AAC or Opus in MP4 through WebCodecs, about 0.25 MB a minute)
// and /api/lyrics asks Whisper large-v3 for word timestamps, with the lyrics as a hint. Here, Whisper's words are
// matched to the real lyrics (longest common subsequence), missed words are spread between their matched
// neighbours, and each word's start moves to where the voice comes in, found in the vocal band (250-3500 Hz) of the
// audio. The same approach as RemotionVideo's tools/sync-lyrics.mjs. Lines: [{text, start, end, words: [{word,
// start, end, matched}]}], the format Spectrum's export already draws.
(function () {
    const norm = w => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const lyricLines = text => text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^\[.*\]$/.test(l));

    // ---- Audio ----
    async function decode(file, rate) {
        const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(await file.arrayBuffer());
        const mono = new Float32Array(buf.length);
        for (let c = 0; c < buf.numberOfChannels; c++) { const ch = buf.getChannelData(c); for (let i = 0; i < buf.length; i++) mono[i] += ch[i] / buf.numberOfChannels; }
        return { buf, mono };
    }

    // A compact upload: mono, 48 kHz, 32 kbps, in an MP4 container (Whisper resamples to 16 kHz anyway).
    async function compact(mono, rate) {
        if (!('AudioEncoder' in window) || !window.Mp4Muxer) throw new Error('Lyric sync needs Chrome or Edge.');
        let chosen = null;
        for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
            const config = { codec, sampleRate: rate, numberOfChannels: 1, bitrate: 32000 };
            try { if ((await AudioEncoder.isConfigSupported(config)).supported) { chosen = { config, mux }; break; } } catch {}
        }
        if (!chosen) throw new Error('This browser cannot compress audio for lyric sync. Use Chrome or Edge.');
        const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), audio: { codec: chosen.mux, numberOfChannels: 1, sampleRate: rate }, fastStart: 'in-memory' });
        let fail = null;
        const enc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { fail = e; } });
        enc.configure(chosen.config);
        const block = rate;   // one second at a time
        for (let at = 0; at < mono.length; at += block) {
            const n = Math.min(block, mono.length - at);
            const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfChannels: 1, numberOfFrames: n, timestamp: Math.round(at / rate * 1e6), data: mono.subarray(at, at + n) });
            enc.encode(data);
            data.close();
            if (fail) throw fail;
        }
        await enc.flush();
        enc.close();
        muxer.finalize();
        return new Blob([muxer.target.buffer], { type: 'audio/mp4' });
    }

    // The vocal band at 16 kHz, for finding where each word really starts.
    async function vocalBand(buf) {
        const rate = 16000, len = Math.ceil(buf.duration * rate);
        const ctx = new OfflineAudioContext(1, len, rate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3500;
        src.connect(hp); hp.connect(lp); lp.connect(ctx.destination);
        src.start();
        return (await ctx.startRendering()).getChannelData(0);
    }

    // ---- Matching Whisper's words to the lyrics ----
    function align(text, heardWords, vocal) {
        const lines = lyricLines(text);
        const lyricWords = lines.flatMap((t, line) => t.split(/\s+/).map(word => ({ word, line })));
        const heard = heardWords.map(w => ({ ...w, n: norm(w.word) })).filter(w => w.n);
        const A = lyricWords.map(w => norm(w.word)), B = heard.map(w => w.n);
        const dp = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
        for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
            dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        const match = new Array(A.length).fill(-1);
        for (let i = 0, j = 0; i < A.length && j < B.length;) {
            if (A[i] === B[j]) { match[i] = j; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
        }
        const timed = lyricWords.map((w, i) => ({ ...w, start: match[i] >= 0 ? heard[match[i]].start : null, end: match[i] >= 0 ? heard[match[i]].end : null, matched: match[i] >= 0 }));
        if (!timed.some(w => w.matched)) throw new Error('None of the sung words matched the lyrics. Check the lyrics are for this track.');
        // Unmatched words: spread evenly between the matched words either side. A long gap is usually an
        // instrumental break, so they're sung just before the next heard word.
        for (let i = 0; i < timed.length;) {
            if (timed[i].matched) { i++; continue; }
            let j = i; while (j < timed.length && !timed[j].matched) j++;
            let from = i > 0 ? timed[i - 1].end : Math.max(0, (timed[j]?.start ?? 0) - 0.4 * (j - i));
            const to = j < timed.length ? timed[j].start : from + 0.4 * (j - i);
            if ((to - from) / (j - i) > 0.6) from = Math.max(from, to - 0.45 * (j - i));
            const step = (to - from) / (j - i);
            for (let k = i; k < j; k++) { timed[k].start = from + step * (k - i); timed[k].end = from + step * (k - i + 1); }
            i = j;
        }
        // Onsets: Whisper's starts run early on sung vowels. In 10 ms steps of vocal-band energy, move each word's
        // start to the sharpest rise within reach (the first clear rise after a pause), or 80 ms later without one.
        const STEP = 0.01, per = 160, energy = [];
        for (let i = 0; i + per <= vocal.length; i += per) {
            let s = 0;
            for (let j = 0; j < per; j++) { const v = vocal[i + j] * 32768; s += v * v; }
            energy.push(Math.log10(1e-3 + Math.sqrt(s / per)));
        }
        const smooth = energy.map((_, i) => (energy[i - 1] ?? energy[i]) * 0.25 + energy[i] * 0.5 + (energy[i + 1] ?? energy[i]) * 0.25);
        const rise = smooth.map((v, i) => Math.max(0, v - (smooth[i - 3] ?? v)));
        let lastStart = 0;
        timed.forEach((w, idx) => {
            const prev = timed[idx - 1];
            const afterPause = !prev || prev.line !== w.line || w.start - prev.end > 0.25;
            const smeared = afterPause && w.end - w.start > 1.2;
            const from = smeared ? Math.max(w.start, w.end - 1.8) : w.start - 0.05;
            const reach = smeared ? w.end - 0.1 : afterPause ? Math.min(w.start + 1.5, Math.max(w.end - 0.05, w.start + 0.35)) : Math.min(w.start + 0.35, w.end - 0.05);
            const lo = Math.max(0, Math.round(from / STEP)), hi = Math.min(rise.length - 1, Math.round(reach / STEP));
            let best = -1, bestRise = 0.12;
            if (afterPause) for (let i = lo; i <= hi; i++) if (rise[i] > 0.18) { best = i; break; }
            if (best < 0) for (let i = lo; i <= hi; i++) if (rise[i] > bestRise) { bestRise = rise[i]; best = i; }
            const refined = best >= 0 ? best * STEP : smeared ? w.end - 0.9 : w.start + 0.08;
            const start = Math.max(refined, lastStart + 0.05);
            w.start = start;
            if (w.end < start + 0.1) w.end = start + 0.1;
            lastStart = start;
        });
        return lines.map((t, line) => {
            const words = timed.filter(w => w.line === line).map(({ word, start, end, matched }) => ({ word, start: +start.toFixed(3), end: +end.toFixed(3), matched }));
            return { text: t, start: words[0].start, end: words[words.length - 1].end, words };
        });
    }

    // ---- LRC files ----
    // Timed lyrics as distributors and lyric services supply them: "[mm:ss.xx]line", several stamps on a line for a
    // repeated chorus, optional "<mm:ss.xx>word" stamps for each word, and an "[offset:+/-ms]" tag. Lines without word
    // stamps spread their words evenly up to the next line (or a natural length for the last one). Returns null for
    // text with fewer than two timed lines, so plain lyrics still go to the vocal sync.
    function parseLrc(text) {
        const stamp = s => { const m = /^(\d+):(\d+(?:[.:]\d+)?)$/.exec(s.trim()); return m ? +m[1] * 60 + parseFloat(m[2].replace(':', '.')) : null; };
        const offsetTag = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(text);
        const offset = offsetTag ? -(+offsetTag[1]) / 1000 : 0;   // a positive offset means the lyrics come earlier
        const raw = [];
        for (const line of text.split(/\r?\n/)) {
            const tags = [];
            let rest = line.trim(), m;
            while ((m = /^\[([^\]]+)\]/.exec(rest))) { const t = stamp(m[1]); if (t !== null) tags.push(t); rest = rest.slice(m[0].length); }
            if (!tags.length) continue;
            const words = [];
            const parts = rest.split(/(<\d+:\d+(?:[.:]\d+)?>)/).filter(Boolean);
            let at = null;
            for (const p of parts) {
                const w = /^<(.+)>$/.exec(p);
                if (w) { at = stamp(w[1]); continue; }
                for (const word of p.trim().split(/\s+/).filter(Boolean)) { words.push({ word, start: at }); at = null; }
            }
            if (!words.length) continue;
            for (const t of tags) raw.push({ start: Math.max(0, t + offset), words: words.map(w => ({ word: w.word, start: w.start === null ? null : Math.max(0, w.start + offset + (t - tags[0])) })) });
        }
        if (raw.length < 2) return null;
        raw.sort((a, b) => a.start - b.start);
        return raw.map((ln, i) => {
            const next = raw[i + 1];
            const natural = ln.start + 0.6 + 0.42 * ln.words.length;
            const end = next ? Math.max(ln.start + 0.3, Math.min(next.start - 0.1, natural + 2)) : natural;
            const n = ln.words.length, step = (end - ln.start) / n;
            const words = ln.words.map((w, k) => ({ word: w.word, start: w.start ?? ln.start + step * k, matched: true }));
            words.forEach((w, k) => { w.end = k + 1 < n ? Math.max(w.start + 0.05, words[k + 1].start) : end; });
            words.forEach(w => { w.start = +w.start.toFixed(3); w.end = +w.end.toFixed(3); });
            return { text: ln.words.map(w => w.word).join(' '), start: words[0].start, end: +end.toFixed(3), words };
        });
    }

    // ---- The request ----
    const store = {
        get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
        set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
    };
    async function requestTimings(blob, text) {
        // Lyric sync is part of Pro: the access code is asked for once (js/access.js) and remembered in this browser.
        const { res, data } = await AccessCode.request(code => {
            const form = new FormData();
            form.append('audio', blob, blob.type === 'audio/mp4' ? 'track.m4a' : 'track.wav');
            form.append('prompt', [...new Set(lyricLines(text))].join(' ').slice(0, 880));
            return fetch('api/lyrics', { method: 'POST', headers: { 'x-studio-code': code }, body: form });
        }, 'Lyric sync');
        if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status}).`);
        return data.words;
    }

    async function sync(file, text, status) {
        status('Preparing the audio…');
        const { buf, mono } = await decode(file, 48000);
        const blob = await compact(mono, 48000);
        if (blob.size > 4 * 1024 * 1024) throw new Error('This track is too long to sync in one go (over 4 MB once compressed).');
        status('Timing the words to the vocal… (usually 5-30 s)');
        const [words, vocal] = await Promise.all([requestTimings(blob, text), vocalBand(buf)]);
        status('Matching the words to your lyrics…');
        let lines = align(text, words, vocal);
        // Whisper occasionally has an off run on the same audio (a quarter of the words instead of nearly all), so a
        // weak match is retried once and the better of the two kept.
        const rate = ls => ls.reduce((n, l) => n + l.words.filter(w => w.matched).length, 0) / Math.max(1, ls.reduce((n, l) => n + l.words.length, 0));
        if (rate(lines) < 0.85) {
            status('Checking the timing again…');
            try { const again = align(text, await requestTimings(blob, text), vocal); if (rate(again) > rate(lines)) lines = again; } catch {}
        }
        return lines;
    }

    // ---- Drawing ----
    // The current line: appears just before it's sung, stays until shortly after (or until the next line), fading in
    // and out; words already sung are white, the rest dimmer. opts: {font, y (fraction of the height), size}.
    function draw(ctx, W, H, t, lines, opts = {}) {
        if (!lines || !lines.length) return;
        let line = null, next = null;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].start - 0.25 <= t) { line = lines[i]; next = lines[i + 1] || null; } else break;
        }
        if (!line) return;
        const until = Math.min(line.end + 1.2, next ? next.start - 0.25 : Infinity);
        if (t > until) return;
        const alpha = Math.min(1, (t - (line.start - 0.25)) / 0.25, (until - t) / 0.25);
        const portrait = H > W;
        let size = Math.round(Math.min(W, H) * (opts.size || (portrait ? 0.052 : 0.046)));
        ctx.save();
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const font = s => `600 ${s}px ${opts.font || "Montserrat, 'Segoe UI', sans-serif"}`;
        ctx.font = font(size);
        const words = line.text.split(/\s+/);
        let space = ctx.measureText(' ').width, widths = words.map(w => ctx.measureText(w).width);
        let total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
        if (total > W * 0.9) {   // long lines shrink to fit
            size = Math.floor(size * W * 0.9 / total);
            ctx.font = font(size);
            space = ctx.measureText(' ').width; widths = words.map(w => ctx.measureText(w).width);
            total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
        }
        ctx.shadowColor = 'rgba(0,0,0,0.75)';
        ctx.shadowBlur = size * 0.4;
        let x = (W - total) / 2;
        const y = H * (opts.y || (portrait ? 0.72 : 0.82));
        words.forEach((w, i) => {
            const sung = line.words && line.words[i] ? t >= line.words[i].start : true;
            ctx.fillStyle = sung ? '#ffffff' : 'rgba(255,255,255,0.45)';
            ctx.fillText(w, x, y);
            x += widths[i] + space;
        });
        ctx.restore();
    }

    // ---- The panel ----
    const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
    let styled = false;
    function addStyles() {
        if (styled) return;
        styled = true;
        const css = document.createElement('style');
        css.textContent = `
            .lyr { display: flex; flex-direction: column; gap: 6px; font-size: 11px; }
            .lyr textarea { width: 100%; min-height: 90px; resize: vertical; background: rgba(0,0,0,0.35); color: #fff; border: 1px solid rgba(255,255,255,0.14);
                border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 11px; line-height: 1.45; box-sizing: border-box; user-select: text; }
            .lyr-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
            .lyr button { cursor: pointer; }
            .lyr-status { color: #cfd5e4; min-height: 14px; }
            .lyr-status.err { color: #ff8fab; }
            .lyr-status a { color: inherit; }
            .lyr-list { display: flex; flex-direction: column; gap: 3px; max-height: 160px; overflow-y: auto; }
            .lyr-line { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 4px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.07); }
            .lyr-line.now { border-color: rgba(255,255,255,0.45); }
            .lyr-line .t { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: #9fe8ff; cursor: pointer; background: none; border: 0; padding: 0; font: inherit; font-size: 10.5px; }
            .lyr-line .x { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e6e9f2; }
            .lyr-line .n { flex: 0 0 auto; padding: 0 5px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color: #cfd5e4; border-radius: 3px; font-size: 10px; line-height: 16px; }
            .lyr-line.miss .x { color: #ffcf8a; }
            .lyr-hint { color: #8b93a7; font-size: 10px; line-height: 1.45; }`;
        document.head.appendChild(css);
    }

    function mount(container, { getFile, getTime, seek, onChange, initialText = '' }) {
        addStyles();
        container.innerHTML = `
            <div class="lyr">
                <textarea placeholder="Paste the lyrics. [Section] headers are fine."></textarea>
                <div class="lyr-row"><button type="button" class="lyr-sync">Sync to the vocal</button><button type="button" class="lyr-lrc" title="Use timed lyrics from an .lrc file">Import .lrc</button><input type="file" class="lyr-lrc-file" accept=".lrc,text/plain" hidden><label class="lyr-row"><input type="checkbox" class="lyr-show" checked> Show in the video</label></div>
                <div class="lyr-status"></div>
                <div class="lyr-list"></div>
                <div class="lyr-hint">Already have timed lyrics? Import or paste an .lrc file: it's used as it is, with no sync needed. Click a time to play from that line; − and + move a line 0.1 s. Lines in amber had words the timing missed.</div>
            </div>`;
        const $ = s => container.querySelector(s);
        const ta = $('textarea'), list = $('.lyr-list'), status = $('.lyr-status'), show = $('.lyr-show'), btn = $('.lyr-sync');
        ta.value = initialText;
        let lines = null, key = null;
        const setStatus = (msg, err = false) => { status.textContent = msg; status.classList.toggle('err', err); };
        const emit = () => onChange(show.checked && lines ? lines : null);
        const save = () => { if (key) store.set(key, { text: ta.value, lines }); };
        const fileKey = f => f ? `lyrics:${f.name}:${f.size}` : null;

        function render() {
            list.textContent = '';
            (lines || []).forEach((ln, i) => {
                const row = document.createElement('div');
                row.className = 'lyr-line' + (ln.words.some(w => w.matched === false) ? ' miss' : '');
                row.dataset.i = i;
                const t = document.createElement('button'); t.className = 't'; t.textContent = fmt(ln.start); t.title = 'Play from here';
                t.onclick = () => seek(Math.max(0, ln.start - 1));
                const x = document.createElement('span'); x.className = 'x'; x.textContent = ln.text; x.title = ln.text;
                const nudge = d => () => { ln.start += d; ln.end += d; ln.words.forEach(w => { w.start += d; w.end += d; }); t.textContent = fmt(ln.start); save(); emit(); };
                const minus = document.createElement('button'); minus.className = 'n'; minus.textContent = '−'; minus.title = '0.1 s earlier'; minus.onclick = nudge(-0.1);
                const plus = document.createElement('button'); plus.className = 'n'; plus.textContent = '+'; plus.title = '0.1 s later'; plus.onclick = nudge(0.1);
                row.append(t, x, minus, plus);
                list.appendChild(row);
            });
        }

        // Timings from an LRC file: no request needed.
        function useLrc(parsed) {
            lines = parsed;
            key = fileKey(getFile());
            save(); render(); emit();
            setStatus(`✓ Used the timings from the LRC: ${lines.length} lines${getFile() ? '' : '. Load the track to see them play'}.`);
            window.track && window.track('Lyrics from LRC', { lines: lines.length });
        }
        $('.lyr-lrc').onclick = () => $('.lyr-lrc-file').click();
        $('.lyr-lrc-file').onchange = async e => {
            const f = e.target.files[0]; if (!f) return;
            const text = await f.text();
            const parsed = parseLrc(text);
            if (!parsed) { setStatus('That file has no timed lines. An .lrc file has lines like [01:23.45] Lyric text.', true); return; }
            ta.value = text;
            useLrc(parsed);
            e.target.value = '';
        };

        btn.onclick = async () => {
            const lrc = parseLrc(ta.value);
            if (lrc) { useLrc(lrc); return; }
            const file = getFile();
            if (!file) { setStatus('Load the track first.', true); return; }
            if (lyricLines(ta.value).join(' ').split(/\s+/).length < 4) { setStatus('Paste the lyrics first.', true); return; }
            btn.disabled = true;
            const t0 = Date.now();
            try {
                lines = await sync(file, ta.value, setStatus);
                key = fileKey(file);
                save(); render(); emit();
                const missed = lines.reduce((n, l) => n + l.words.filter(w => !w.matched).length, 0), all = lines.reduce((n, l) => n + l.words.length, 0);
                setStatus(`✓ ${lines.length} lines timed in ${Math.round((Date.now() - t0) / 1000)} s${missed ? `; ${missed} of ${all} words estimated (amber)` : ''}.`);
                window.track && window.track('Lyrics synced', { lines: lines.length });
            } catch (err) {
                setStatus(err.message === 'Failed to fetch' ? 'Could not reach the server.' : err.message, true);
                if (err.pro) { const a = document.createElement('a'); a.href = 'index.html#pro'; a.textContent = 'See Pro →'; status.appendChild(a); }
            } finally { btn.disabled = false; }
        };
        show.onchange = emit;
        ta.addEventListener('input', () => { if (key) save(); });

        // Highlight the line being sung.
        setInterval(() => {
            if (!lines || !list.children.length) return;
            const t = getTime();
            let cur = -1;
            lines.forEach((l, i) => { if (l.start - 0.25 <= t) cur = i; });
            [...list.children].forEach(r => r.classList.toggle('now', +r.dataset.i === cur));
        }, 250);

        return {
            // A new track: bring back a sync saved for it in this browser, or clear the lines.
            trackChanged() {
                const before = key;
                key = fileKey(getFile());
                const saved = key && store.get(key, null);
                if (saved && saved.lines) { lines = saved.lines; if (saved.text) ta.value = saved.text; setStatus(`Restored the sync saved for this track (${lines.length} lines).`); }
                else if (lines && !before) { save(); setStatus(`Using the ${lines.length} timed lines for this track.`); }   // timed (an LRC) before any track was loaded
                else { lines = null; setStatus(''); }
                render(); emit();
            },
            lines: () => (show.checked ? lines : null),
        };
    }

    window.LyricSync = { mount, draw, align, sync, parseLrc };
})();
