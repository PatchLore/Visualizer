// Auto-director for KINETIX. It listens to the whole track once (beats, bars, sections), then plans shader changes,
// crossfades and effects that follow the song. The plan is plain data ({scenes, events}), shown on the page's
// timeline for editing and sent as-is to the export, so the preview and the MP4 play exactly the same plan.
//
//   const analysis = await KinetixDirector.analyse(audioBuffer, progress => ...);
//   const { scenes, events } = KinetixDirector.plan(analysis, { seed, colors });
(function () {
    const N = 1024, HOP = 512;

    function makeFft(n) {
        const levels = Math.log2(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n);
        for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
        for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
        return (re, im) => {
            for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
            for (let size = 2; size <= n; size *= 2) {
                const half = size / 2, step = n / size;
                for (let i = 0; i < n; i += size) for (let j = 0; j < half; j++) {
                    const k = j * step, a = i + j, b = a + half;
                    const tr = re[b] * cos[k] + im[b] * sin[k], ti = im[b] * cos[k] - re[b] * sin[k];
                    re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
                }
            }
        };
    }

    // ---- Listening: per 11.6 ms frame, the onset strength (spectral flux) and the loudness and bass level ----
    async function features(audio, onProgress) {
        const sr = audio.sampleRate, len = audio.length;
        const mono = new Float32Array(len);
        for (let c = 0; c < audio.numberOfChannels; c++) { const ch = audio.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += ch[i] / audio.numberOfChannels; }
        const frames = Math.max(1, Math.floor((len - N) / HOP) + 1);
        const win = new Float32Array(N);
        for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
        const fft = makeFft(N), re = new Float64Array(N), im = new Float64Array(N);
        const binHz = sr / N, maxBin = Math.min(N / 2, Math.ceil(12000 / binHz)), bassBins = [Math.max(1, Math.round(30 / binHz)), Math.round(150 / binHz)];
        const flux = new Float32Array(frames), lowFlux = new Float32Array(frames), loud = new Float32Array(frames), bass = new Float32Array(frames);
        const prev = new Float32Array(maxBin + 1);
        for (let f = 0; f < frames; f++) {
            const start = f * HOP;
            for (let i = 0; i < N; i++) { re[i] = (mono[start + i] || 0) * win[i]; im[i] = 0; }
            fft(re, im);
            let fl = 0, lfl = 0, total = 0, low = 0;
            for (let k = 1; k <= maxBin; k++) {
                const p = re[k] * re[k] + im[k] * im[k], m = Math.log1p(1000 * Math.sqrt(p) / N);
                const d = m - prev[k];
                if (d > 0) { fl += d; if (k <= bassBins[1]) lfl += d; }
                prev[k] = m;
                total += p;
                if (k >= bassBins[0] && k <= bassBins[1]) low += p;
            }
            flux[f] = fl; lowFlux[f] = lfl;
            loud[f] = 10 * Math.log10(total / (N * N) + 1e-12);
            bass[f] = 10 * Math.log10(low / (N * N) + 1e-12);
            if (f % 1500 === 0) { if (onProgress) onProgress(f / frames); await new Promise(r => setTimeout(r)); }
        }
        return { fps: sr / HOP, offset: N / 2 / sr, duration: audio.duration, flux, lowFlux, loud, bass };
    }

    // Onset envelope: flux above its local average (±0.25 s), scaled to unit spread.
    function onsetEnvelope(flux, fps) {
        const n = flux.length, w = Math.max(1, Math.round(0.25 * fps)), sum = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + flux[i];
        const o = new Float32Array(n);
        let sq = 0;
        for (let i = 0; i < n; i++) {
            const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
            o[i] = Math.max(0, flux[i] - (sum[b] - sum[a]) / (b - a));
            sq += o[i] * o[i];
        }
        const sd = Math.sqrt(sq / n) || 1;
        for (let i = 0; i < n; i++) o[i] /= sd;
        return o;
    }

    // Tempo: the autocorrelation of the onsets (with its double, so the real beat beats its half), weighted toward
    // dance tempos around 125 BPM, between 72 and 190 BPM. Returns the beat period in frames.
    function beatPeriod(o, fps) {
        const n = o.length, minLag = Math.floor(60 * fps / 190), maxLag = Math.ceil(60 * fps / 72);
        const ac = new Float64Array(2 * maxLag + 2);
        for (let lag = minLag; lag < ac.length && lag < n; lag++) {
            let s = 0;
            for (let i = 0; i + lag < n; i++) s += o[i] * o[i + lag];
            ac[lag] = s / (n - lag);
        }
        const score = lag => {
            const bpm = 60 * fps / lag, w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.7, 2));
            return w * (ac[lag] + 0.5 * (ac[2 * lag] || 0));
        };
        let best = minLag;
        for (let lag = minLag; lag <= maxLag; lag++) if (score(lag) > score(best)) best = lag;
        const a = score(best - 1), b = score(best), c = score(best + 1), den = a - 2 * b + c;
        return best + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0);
    }

    // Beats by dynamic programming (after Ellis 2007): each beat is an onset whose distance from the previous beat
    // stays close to the period, so the grid follows the music even if the tempo drifts a little.
    function trackBeats(o, period) {
        const n = o.length, cs = new Float64Array(n), back = new Int32Array(n).fill(-1), tight = 120;
        const lo = Math.max(1, Math.round(period / 2)), hi = Math.round(period * 2);
        for (let t = 0; t < n; t++) {
            let best = -Infinity, at = -1;
            for (let p = t - hi; p <= t - lo; p++) {
                if (p < 0) continue;
                const s = cs[p] - tight * Math.pow(Math.log((t - p) / period), 2);
                if (s > best) { best = s; at = p; }
            }
            if (at >= 0 && best > 0) { cs[t] = o[t] + best; back[t] = at; } else cs[t] = o[t];
        }
        let end = Math.max(0, n - Math.round(2 * period));
        for (let t = end; t < n; t++) if (cs[t] > cs[end]) end = t;
        const beats = [];
        for (let t = end; t >= 0; t = back[t]) beats.push(t);
        return beats.reverse();
    }

    // A beat for the whole track: tracked beats, gaps filled, and the grid extended to the start and the end.
    function fillBeats(frameBeats, fps, offset, duration, periodSec) {
        const times = frameBeats.map(f => f / fps + offset), out = [];
        for (let i = 0; i < times.length; i++) {
            if (i > 0) {
                const gap = times[i] - times[i - 1], steps = Math.round(gap / periodSec);
                for (let s = 1; s < steps; s++) out.push(times[i - 1] + gap * s / steps);
            }
            out.push(times[i]);
        }
        if (!out.length) out.push(0);
        while (out[0] - periodSec > -periodSec * 0.5) out.unshift(out[0] - periodSec);
        while (out[out.length - 1] + periodSec < duration) out.push(out[out.length - 1] + periodSec);
        return out.filter(t => t >= 0);
    }

    function percentile(arr, p) {
        const s = Array.from(arr).sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
    }

    async function analyse(audio, onProgress) {
        const feat = await features(audio, onProgress);
        feat.onsets = onsetEnvelope(feat.flux, feat.fps);
        return fromPeriod(feat, beatPeriod(feat.onsets, feat.fps));
    }

    // Beats tracked around a beat period (in frames), then the sections. The beat length is the average of the
    // tracked intervals near their median: beats fall on whole frames, so at 175 BPM they alternate 29 and 30 frames
    // apart, and the median alone would say 172.3.
    function fromPeriod(feat, period) {
        const { fps, offset, duration } = feat;
        const tracked = trackBeats(feat.onsets, period);
        const intervals = tracked.slice(1).map((b, i) => b - tracked[i]).sort((a, b) => a - b);
        let beat = period;
        if (intervals.length > 8) {
            const median = intervals[intervals.length >> 1], near = intervals.filter(d => Math.abs(d - median) <= 1.5);
            beat = near.reduce((s, d) => s + d, 0) / near.length;
        }
        const periodSec = beat / fps;
        return structure(feat, fillBeats(tracked, fps, offset, duration, periodSec), periodSec);
    }

    // The track re-tracked at a tempo the user knows (60-200 BPM). Detection can lock onto a related tempo: drum and
    // bass at 175 often reads as 117 (its breaks repeat every beat and a half), which half or double can't fix.
    function withTempo(analysis, bpm) {
        if (!(bpm >= 60 && bpm <= 200)) return analysis;
        return fromPeriod(analysis.feat, 60 * analysis.feat.fps / bpm);
    }

    // The same track at half or double the detected tempo (factor 0.5 or 2), for when the guess is an octave off.
    function retempo(analysis, factor) {
        const { feat } = analysis;
        let beats = analysis.beats, periodSec = analysis.periodSec;
        if (factor === 2 && 60 / periodSec * 2 <= 220) {
            beats = beats.flatMap((t, i) => i + 1 < beats.length ? [t, (t + beats[i + 1]) / 2] : [t]);
            periodSec /= 2;
        } else if (factor === 0.5 && 60 / periodSec / 2 >= 50) {
            // Keep the half of the beats with the stronger kicks.
            const kickAt = t => { const f = Math.max(0, Math.round((t - feat.offset) * feat.fps)); let m = 0; for (let k = Math.max(0, f - 2); k <= Math.min(feat.lowFlux.length - 1, f + 2); k++) m = Math.max(m, feat.lowFlux[k]); return m; };
            const sums = [0, 1].map(par => beats.reduce((s, t, i) => s + (i % 2 === par ? kickAt(t) : 0), 0));
            const par = sums[1] > sums[0] ? 1 : 0;
            beats = beats.filter((_, i) => i % 2 === par);
            periodSec *= 2;
        }
        return structure(feat, beats, periodSec);
    }

    function structure(feat, beats, periodSec) {
        const { fps, offset, duration } = feat;
        const bpm = Math.round(60 / periodSec * 10) / 10;

        // Per beat: loudness and bass, each scaled 0-1 between this track's quiet (10th percentile) and loud (95th).
        const nb = beats.length, E = new Float32Array(nb), B = new Float32Array(nb), L = new Float32Array(nb);
        for (let i = 0; i < nb; i++) {
            const a = Math.max(0, Math.round((beats[i] - offset) * fps)), b = Math.min(feat.loud.length, Math.max(a + 1, Math.round(((beats[i + 1] ?? beats[i] + periodSec) - offset) * fps)));
            let e = 0, ba = 0, lf = 0, c = 0;
            for (let f = a; f < b; f++) { e += feat.loud[f]; ba += feat.bass[f]; c++; }
            const near = Math.min(feat.lowFlux.length - 1, a);
            for (let f = Math.max(0, near - 2); f <= Math.min(feat.lowFlux.length - 1, near + 2); f++) lf = Math.max(lf, feat.lowFlux[f]);
            E[i] = c ? e / c : -120; B[i] = c ? ba / c : -120; L[i] = lf;
        }
        const scale = arr => { const lo = percentile(arr, 0.1), hi = percentile(arr, 0.95); for (let i = 0; i < arr.length; i++) arr[i] = Math.max(0, Math.min(1, (arr[i] - lo) / Math.max(1, hi - lo))); };
        scale(E); scale(B);

        // Section changes: where the 4 bars after a beat differ most from the 4 bars before it.
        const W = 16, novelty = new Float32Array(nb);
        const avg = (arr, a, b) => { let s = 0; for (let i = a; i < b; i++) s += arr[i]; return s / Math.max(1, b - a); };
        for (let i = W; i <= nb - W; i++) novelty[i] = Math.abs(avg(E, i, i + W) - avg(E, i - W, i)) + 0.6 * Math.abs(avg(B, i, i + W) - avg(B, i - W, i));
        const peaks = [];
        for (let i = W; i <= nb - W; i++) {
            if (novelty[i] < 0.12) continue;
            let top = true;
            for (let j = Math.max(0, i - 8); j <= Math.min(nb - 1, i + 8); j++) if (novelty[j] > novelty[i]) { top = false; break; }
            if (top) peaks.push({ beat: i, strength: novelty[i] });
        }

        // Downbeat: sections almost always change on the first beat of a bar, so the changes vote for which beat
        // of four is "one"; kick drums add a smaller vote.
        const votes = [0, 0, 0, 0], kick = [0, 0, 0, 0], kickCount = [0, 0, 0, 0];
        for (const p of peaks) votes[p.beat % 4] += p.strength;
        for (let i = 0; i < nb; i++) { kick[i % 4] += L[i]; kickCount[i % 4]++; }
        const kickMax = Math.max(...kick.map((k, i) => k / Math.max(1, kickCount[i]))) || 1;
        for (let k = 0; k < 4; k++) votes[k] += 0.3 * (kick[k] / Math.max(1, kickCount[k])) / kickMax;
        const downbeat = votes.indexOf(Math.max(...votes));
        const totalBars = Math.max(1, Math.floor((nb - downbeat) / 4));

        // Boundaries in bars, strongest first, lined up on 4-bar phrases with the strongest one, at least 8 bars apart.
        peaks.sort((a, b) => b.strength - a.strength);
        const accepted = [];
        let anchor = null;
        for (const p of peaks) {
            let bar = Math.round((p.beat - downbeat) / 4);
            if (anchor === null) anchor = bar;
            const phrase = anchor + 4 * Math.round((bar - anchor) / 4);
            if (Math.abs(phrase - bar) <= 1) bar = phrase;
            if (bar < 4 || bar > totalBars - 4 || accepted.some(a => Math.abs(a - bar) < 8)) continue;
            accepted.push(bar);
        }
        accepted.sort((a, b) => a - b);

        const barTime = bar => timeAtBeat(beats, downbeat + 4 * bar, periodSec);
        const edges = [0, ...accepted, totalBars];
        const sections = [];
        for (let s = 0; s < edges.length - 1; s++) {
            const a = downbeat + 4 * edges[s], b = Math.min(nb, downbeat + 4 * edges[s + 1]);
            sections.push({ startBar: edges[s], endBar: edges[s + 1], start: s === 0 ? 0 : barTime(edges[s]), end: s === edges.length - 2 ? duration : barTime(edges[s + 1]),
                            energy: avg(E, s === 0 ? 0 : a, b), bass: avg(B, s === 0 ? 0 : a, b) });
        }
        classify(sections);
        return { bpm, beats, downbeat, periodSec, totalBars, sections, duration, feat };
    }

    function timeAtBeat(beats, i, periodSec) {
        if (i < 0) return Math.max(0, beats[0] + i * periodSec);
        if (i < beats.length) return beats[i];
        return beats[beats.length - 1] + (i - beats.length + 1) * periodSec;
    }

    // Drop: loud with full bass. Calm: quiet. Groove: in between. A track with no clear drop gets its loudest
    // section(s) as drops.
    function classify(sections) {
        for (const s of sections) s.kind = s.energy >= 0.62 && s.bass >= 0.5 ? 'drop' : s.energy < 0.38 ? 'calm' : 'groove';
        if (!sections.some(s => s.kind === 'drop')) {
            const top = Math.max(...sections.map(s => s.energy));
            for (const s of sections) if (s.energy >= top - 0.08 && s.energy > 0.45) s.kind = 'drop';
        }
        sections.forEach((s, i) => {
            const first = i === 0, last = i === sections.length - 1 && sections.length > 1;
            s.label = s.kind === 'drop' ? 'Drop' : first ? 'Intro' : last ? 'Outro' : s.kind === 'calm' ? 'Breakdown' : 'Groove';
        });
    }

    // ---- Planning ----
    function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
    function shuffle(arr, rand) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

    // Shaders by energy: 0 Tunnel, 1 Mandala, 2 Plasma, 3 Vortex, 4 Hex Grid, 5 Synthwave.
    const POOLS = { drop: [0, 3, 4], groove: [5, 4, 1, 0], calm: [2, 1, 5] };

    // seed: a different seed gives a different but equally musical plan. colors: [accent, second, third]; drops use
    // the accent, grooves the second and calm sections the third.
    function plan(analysis, { seed = 1, colors = [] } = {}) {
        const rand = mulberry32(seed * 7919 + 17);
        const { beats, downbeat, periodSec, sections, duration, totalBars } = analysis;
        const beat = periodSec, bar = 4 * periodSec;
        const barTime = b => timeAtBeat(beats, downbeat + 4 * b, periodSec);
        const color = kind => (kind === 'drop' ? colors[0] : kind === 'groove' ? colors[1] || colors[0] : colors[2] || colors[1] || colors[0]) || '#00f0ff';
        const pools = { drop: shuffle(POOLS.drop, rand), groove: shuffle(POOLS.groove, rand), calm: shuffle(POOLS.calm, rand) };
        const turn = { groove: 0, calm: 0 };
        const scenes = [], events = [];
        let prevMode = -1, dropCount = 0;
        const pick = kind => {
            const pool = pools[kind];
            for (let k = 0; k < pool.length; k++) { const m = pool[turn[kind]++ % pool.length]; if (m !== prevMode) return m; }
            return pool[0];
        };
        const fx = (fxName, at, dur, from, to = from) => { if (dur > 0.02 && at < duration) events.push({ at: round(Math.max(0, at)), dur: round(Math.min(dur, duration - at)), fx: fxName, from, to }); };

        sections.forEach((s, si) => {
            const len = s.endBar - s.startBar;
            // Long sections change look every 16 bars, so nothing stays on screen for minutes.
            const splits = [s.startBar];
            if (len >= 24) for (let b = s.startBar + 16; s.endBar - b >= 8; b += 16) splits.push(b);
            const home = pools.drop[0], alt = pools.drop[1];
            splits.forEach((b, k) => {
                let mode;
                if (s.kind === 'drop') mode = (dropCount + k) % 2 === 0 ? home : alt;
                else mode = pick(s.kind);
                if (mode === prevMode && s.kind === 'drop') mode = mode === home ? alt : home;
                const at = k === 0 ? s.start : barTime(b);
                const fade = scenes.length === 0 || s.kind === 'drop' ? 0 : k === 0 ? (s.kind === 'calm' ? 2 * bar : bar) : bar;
                scenes.push({ at: round(at), mode, color: color(s.kind), fade: round(Math.min(fade, 8)), label: k === 0 ? s.label : `${s.label} ${k + 1}` });
                prevMode = mode;
            });

            if (s.kind === 'drop') {
                if (si > 0 && sections[si - 1].kind !== 'drop') {
                    // Arrival: one white flash, one beat inverted, two bars of hyperdrive (the cut adds a glitch).
                    fx('flash', s.start, 0.6, 1);
                    fx('invert', s.start, beat, 1);
                    fx('hyper', s.start, 2 * bar, 1);
                    // The build into it: pixels grow coarser over up to 4 bars, a glitch on the last beat, then
                    // everything snaps sharp on the drop.
                    const prev = sections[si - 1];
                    const bars = Math.min(4, Math.max(1, Math.floor((prev.endBar - prev.startBar) / 2)));
                    const from = barTime(s.startBar - bars);
                    fx('pixel', from, s.start - from, 0, 0.85);
                    fx('glitch', s.start - beat, beat, 0.4, 1);
                }
                // Fills on the last beat of each 8-bar phrase: a glitch or an 8-bit stab.
                for (let b = s.startBar + 8; b < s.endBar; b += 8) {
                    if (splits.includes(b)) continue;
                    const at = barTime(b) - beat;
                    if (rand() < 0.6) fx('glitch', at, beat, 1, 0.2); else fx('pixel', at, beat, 0.6);
                }
                dropCount++;
            } else if (s.kind === 'groove') {
                for (let b = s.startBar + 16; b < s.endBar; b += 16) if (!splits.includes(b)) fx('glitch', barTime(b) - beat, beat, 0.6, 0.1);
            }
        });

        // Outro: the picture dissolves into 8-bit over the last two bars.
        if (totalBars > 8) { const at = Math.min(barTime(totalBars - 2), duration - 1); fx('pixel', at, duration - at, 0, 1); }

        events.sort((a, b) => a.at - b.at);
        return { scenes, events };
    }

    const round = x => Math.round(x * 1000) / 1000;

    window.KinetixDirector = { analyse, retempo, withTempo, plan, makeFft };
})();
