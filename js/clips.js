// Drop Hunter: finds the strongest short clips in a track for TikTok, Reels and Shorts, and lets the user pick one to
// export instead of the whole song.
//
//   const picker = ClipPicker.mount(container, { getFile, getAnalysis, seek, onChange });
//   picker.trackChanged();      // after a new track loads
//
// It uses the auto-director's analysis (js/director.js: beats, bars, sections with their loudness and bass): each
// section start where the music lifts is a candidate, with the clip opened about a third before it on a bar line, so
// the clip builds into the moment. Candidates score on the clip's average energy plus the size of the lift (a drop
// into full bass counts most). The best three that don't overlap are offered. onChange receives {start, length} or
// null (the whole track); the page passes it to its export, which renders only that stretch (js/export.js takes the
// start, and fades the clip's audio in and out).
(function () {
    const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

    function find(analysis, length, count = 3) {
        const { sections, beats, downbeat, periodSec, duration } = analysis;
        if (!sections || !sections.length || duration < length + 2) return [];
        const bars = [];
        for (let i = downbeat; i < beats.length; i += 4) bars.push(beats[i]);
        const snap = t => { let best = t, d = Infinity; for (const b of bars) { const x = Math.abs(b - t); if (x < d) { d = x; best = b; } } return d < 4 * periodSec ? best : t; };
        // Average energy over a window, weighted by how much of each section it covers.
        const energyIn = (a, b) => {
            let sum = 0, cover = 0;
            for (const s of sections) { const o = Math.max(0, Math.min(b, s.end) - Math.max(a, s.start)); sum += o * s.energy; cover += o; }
            return cover ? sum / cover : 0;
        };
        const candidates = [];
        sections.forEach((s, i) => {
            const prev = sections[i - 1];
            const lift = prev ? s.energy - prev.energy : 0;
            const bassLift = prev ? s.bass - prev.bass : 0;
            if (i > 0 && lift < 0.08 && s.energy < 0.55) return;
            let start = i === 0 ? 0 : snap(s.start - length * 0.35);
            start = Math.max(0, Math.min(duration - length, start));
            const score = energyIn(start, start + length) + 0.6 * Math.max(0, lift) + 0.3 * Math.max(0, bassLift) + (s.kind === 'drop' ? 0.2 : 0);
            candidates.push({ start: Math.round(start * 10) / 10, length, moment: s.start, label: s.kind === 'drop' ? 'Drop' : s.label, score });
        });
        candidates.sort((a, b) => b.score - a.score);
        const picked = [];
        for (const c of candidates) {
            if (picked.some(p => Math.abs(p.start - c.start) < length * 0.6)) continue;
            picked.push(c);
            if (picked.length === count) break;
        }
        return picked;
    }

    let styled = false;
    function addStyles() {
        if (styled) return;
        styled = true;
        const css = document.createElement('style');
        css.textContent = `
            .clp { display: flex; flex-direction: column; gap: 6px; font-size: 11px; }
            .clp-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
            .clp select { flex: 1; min-width: 0; }
            .clp button { cursor: pointer; }
            .clp-status { color: #cfd5e4; min-height: 14px; }
            .clp-status.err { color: #ff8fab; }
            .clp-list { display: flex; flex-direction: column; gap: 4px; }
            .clp-item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 5px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); cursor: pointer; }
            .clp-item.on { border-color: rgba(255,255,255,0.6); background: rgba(255,255,255,0.08); }
            .clp-item .when { font-variant-numeric: tabular-nums; color: #9fe8ff; }
            .clp-item .what { flex: 1; color: #e6e9f2; }
            .clp-item .play { padding: 0 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); color: #fff; border-radius: 3px; font-size: 10px; line-height: 18px; }`;
        document.head.appendChild(css);
    }

    function mount(container, { getFile, getAnalysis, seek, onChange }) {
        addStyles();
        container.innerHTML = `
            <div class="clp">
                <div class="clp-row">
                    <select class="clp-len" title="Length of the video">
                        <option value="full">Whole track</option><option value="15">15 s clip</option><option value="30">30 s clip</option><option value="60">60 s clip</option>
                    </select>
                    <button type="button" class="clp-find">Find the best moments</button>
                </div>
                <div class="clp-status"></div>
                <div class="clp-list"></div>
            </div>`;
        const $ = s => container.querySelector(s);
        const len = $('.clp-len'), findBtn = $('.clp-find'), status = $('.clp-status'), list = $('.clp-list');
        let analysis = null, analysedFile = null, chosen = null;
        const setStatus = (m, err = false) => { status.textContent = m; status.classList.toggle('err', err); };
        const choose = clip => {
            chosen = clip;
            [...list.children].forEach(el => el.classList.toggle('on', clip && +el.dataset.start === clip.start));
            onChange(clip ? { start: clip.start, length: clip.length } : null);
        };

        async function ensureAnalysis() {
            const file = getFile();
            if (!file) throw new Error('Load the track first.');
            const shared = getAnalysis && getAnalysis();
            if (shared) return shared;
            if (analysis && analysedFile === file) return analysis;
            setStatus('Listening for the build-ups and drops…');
            const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
            analysis = await KinetixDirector.analyse(audio);
            analysedFile = file;
            return analysis;
        }

        async function run() {
            const seconds = +len.value;
            list.textContent = '';
            choose(null);
            if (!seconds) { setStatus('The export will be the whole track.'); return; }
            findBtn.disabled = true;
            try {
                const a = await ensureAnalysis();
                const clips = find(a, seconds);
                if (!clips.length) { setStatus('The track is too short for that clip length.', true); return; }
                clips.forEach((c, i) => {
                    const row = document.createElement('div');
                    row.className = 'clp-item';
                    row.dataset.start = c.start;
                    row.innerHTML = `<span class="when">${fmt(c.start)}–${fmt(c.start + c.length)}</span><span class="what">${i === 0 ? '★ ' : ''}${c.label} at ${fmt(c.moment)}</span><button type="button" class="play">▶ Preview</button>`;
                    row.onclick = () => choose(c);
                    row.querySelector('.play').onclick = e => { e.stopPropagation(); choose(c); seek(c.start); };
                    list.appendChild(row);
                });
                choose(clips[0]);
                setStatus(`The export will be the selected ${seconds}-second clip, with the audio faded in and out.`);
                window.track && window.track('Clips found', { seconds });
            } catch (err) {
                setStatus(err.message, true);
            } finally { findBtn.disabled = false; }
        }

        findBtn.onclick = run;
        len.onchange = () => { if (len.value === 'full') { list.textContent = ''; choose(null); setStatus(''); } else run(); };
        return {
            trackChanged() { analysis = null; analysedFile = null; list.textContent = ''; choose(null); setStatus(''); if (len.value !== 'full' && getFile()) run(); },
            clip: () => chosen && { start: chosen.start, length: chosen.length },
        };
    }

    window.ClipPicker = { mount, find };
})();
