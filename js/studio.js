// Song Studio: description -> /api/compose -> Suno-ready package, video plan and YouTube kit. The latest result
// and a short history live in localStorage; "Make the video" hands the plan to a visualiser page.
(function () {
    const $ = id => document.getElementById(id);
    const store = {
        get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
        set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
    };
    const EXAMPLES = [
        'A late-night R&B song about leaving someone you still love. Rainy city, slow and sensual.',
        'Euphoric progressive trance anthem about a summer that changed everything, big drop, female vocal.',
        'Dusty acoustic folk ballad sung by an old man about the farm he had to sell.',
        'Dark cinematic synthwave about driving out of a neon city at 3am, instrumental.',
        'Upbeat pop-punk song about quitting a job you hate, shouty gang vocals in the chorus.',
    ];
    const REFINES = ['Darker', 'More upbeat', 'Catchier chorus', 'More stripped back', 'More vintage', 'More modern', 'Shorter lines', 'Different title ideas'];

    let current = store.get('studio.current', null);   // { input, result, warnings, title }
    let busy = false;

    // ---- Form state ----
    function segValue(name) { return document.querySelector(`.seg[data-name="${name}"] .on`)?.dataset.value; }
    function setSeg(name, value) {
        document.querySelectorAll(`.seg[data-name="${name}"] button`).forEach(b => b.classList.toggle('on', b.dataset.value === value));
        if (name === 'lyricsMode') $('mine-wrap').hidden = value !== 'mine';
    }
    function readForm() {
        return {
            description: $('description').value.trim(),
            vocal: segValue('vocal'), lyricsMode: segValue('lyricsMode'), target: segValue('target'),
            myLyrics: $('my-lyrics').value.trim(),
            genres: $('genres').value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 3),
            mood: $('mood').value.trim(), era: $('era').value.trim(), language: $('language').value,
            energy: segValue('energy'), length: segValue('length'), artist: $('artist').value.trim(),
        };
    }
    function fillForm(input) {
        if (!input) return;
        $('description').value = input.description || '';
        for (const k of ['vocal', 'lyricsMode', 'target', 'energy', 'length']) if (input[k]) setSeg(k, input[k]);
        $('my-lyrics').value = input.myLyrics || '';
        $('genres').value = (input.genres || []).join(', ');
        $('mood').value = input.mood || ''; $('era').value = input.era || '';
        $('language').value = input.language || 'English'; $('artist').value = input.artist || '';
    }

    // ---- API ----
    async function compose(payload, label) {
        if (busy) return null;
        busy = true;
        const btns = [$('generate'), document.querySelector('#refine-form button')];
        const labels = btns.map(b => b.innerHTML);
        btns.forEach(b => { b.disabled = true; });
        $('generate').innerHTML = `${label}<span class="thinking"><i></i><i></i><i></i></span>`;
        $('error').hidden = true;
        // A full song takes about half a minute, so say what's happening while it writes.
        const steps = payload.refine
            ? ['Reading your change…', 'Rewriting…', 'Keeping what works…', 'Checking Suno\'s limits…']
            : ['Reading your idea…', 'Finding the sound…', 'Writing the verses…', 'Building the chorus…', 'Planning the video scenes…', 'Writing the YouTube kit…', 'Checking Suno\'s limits…'];
        const started = Date.now();
        const tick = () => {
            const secs = (Date.now() - started) / 1000;
            $('progress').textContent = `${steps[Math.min(Math.floor(secs / 4.5), steps.length - 1)]} ${Math.round(secs)}s · usually about 30s`;
        };
        tick();
        const timer = setInterval(tick, 1000);
        try {
            const send = () => fetch('api/compose', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-studio-code': store.get('studio.code', '') },
                body: JSON.stringify(payload),
            });
            let res = await send();
            let data = await res.json().catch(() => ({ error: 'The server sent an unexpected reply.' }));
            // The Studio is part of Pro: deployments with an access code ask for it once; it's remembered in this
            // browser. Cancelling shows what Pro includes.
            if (res.status === 401 && data.needCode) {
                const code = window.prompt('The Song Studio is part of Pro. Enter your access code (or Cancel to see Pro):');
                if (!code) {
                    document.getElementById('pro')?.scrollIntoView({ behavior: 'smooth' });
                    throw new Error('The Song Studio is part of Pro. See Free and Pro below.');
                }
                store.set('studio.code', code.trim());
                res = await send();
                data = await res.json().catch(() => ({ error: 'The server sent an unexpected reply.' }));
                if (res.status === 401) store.set('studio.code', '');
            }
            if (data.quota) $('quota').textContent = `${data.quota.left} free ${data.quota.left === 1 ? 'song' : 'songs'} left today`;
            if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status}).`);
            return data;
        } catch (err) {
            $('error').textContent = err.message === 'Failed to fetch' ? 'Could not reach the server. Check your connection and try again.' : err.message;
            $('error').hidden = false;
            return null;
        } finally {
            clearInterval(timer);
            $('progress').textContent = '';
            busy = false;
            btns.forEach((b, i) => { b.disabled = false; b.innerHTML = labels[i]; });
        }
    }

    async function generate(e) {
        e.preventDefault();
        const input = readForm();
        if (input.description.length < 3 && !(input.lyricsMode === 'mine' && input.myLyrics)) {
            $('error').textContent = 'Describe the song you imagine first.'; $('error').hidden = false; $('description').focus(); return;
        }
        const data = await compose(input, 'Writing your song');
        if (!data) return;
        window.track && window.track('Studio song', { target: input.target });
        current = { input, result: data.result, warnings: data.warnings || [], title: 0 };
        save(true);
        render();
        $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function refine(instruction) {
        if (!current || !instruction) return;
        const previous = { ...current.result };
        delete previous.target;
        const data = await compose({ ...current.input, refine: { instruction, previous } }, 'Rewriting');
        if (!data) return;
        current = { ...current, result: data.result, warnings: data.warnings || [], title: 0 };
        save(true);
        render();
        $('refine-text').value = '';
    }

    // ---- Persistence ----
    function save(addToHistory) {
        store.set('studio.current', current);
        if (!addToHistory) return;
        const history = store.get('studio.history', []);
        history.unshift({ at: Date.now(), ...current });
        store.set('studio.history', history.slice(0, 12));
        renderHistory();
    }

    // ---- Rendering ----
    function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    const chosenTitle = () => current.result.titles[current.title] || current.result.titles[0] || 'Untitled';

    function render() {
        if (!current) return;
        const r = current.result;
        $('results').hidden = false;

        const titles = $('titles');
        titles.textContent = '';
        r.titles.forEach((t, i) => {
            const b = el('button', i === current.title ? 'on' : '', t);
            b.type = 'button';
            b.onclick = () => { current.title = i; save(false); render(); };
            titles.appendChild(b);
        });

        const limit = r.target === 'other' ? 400 : 1000;
        $('style').textContent = r.style;
        $('style-count').textContent = `${r.style.length} / ${limit}`;
        $('style-count').classList.toggle('warn', r.style.length > limit * 0.95);
        $('exclude').textContent = r.exclude || 'Nothing to exclude.';

        const settings = $('settings');
        settings.textContent = '';
        const rows = [['Weirdness', r.settings.weirdness], ['Style influence', r.settings.styleInfluence]];
        if (r.settings.variety != null) rows.push(['Variety', r.settings.variety]);
        for (const [name, value] of rows) {
            const box = el('div', 'setting');
            box.append(el('b', '', `${value}%`), el('span', '', name));
            const meter = el('div', 'meter'); const fill = el('i'); fill.style.width = `${value}%`; meter.appendChild(fill);
            box.appendChild(meter);
            settings.appendChild(box);
        }
        const voice = { female: 'Female', male: 'Male', none: 'None', auto: 'Auto' }[r.settings.vocalGender];
        const vbox = el('div', 'setting'); vbox.append(el('b', '', voice), el('span', '', 'Vocal gender')); settings.appendChild(vbox);
        $('settings-why').textContent = r.settings.why;

        const lyricLimit = r.target === 'other' ? 3000 : 5000;
        const lyrics = $('lyrics');
        lyrics.textContent = '';
        for (const line of r.lyrics.split('\n')) {
            if (/^\s*\[.*\]\s*$/.test(line)) lyrics.appendChild(el('span', 'tag', line));
            else lyrics.appendChild(document.createTextNode(line));
            lyrics.appendChild(document.createTextNode('\n'));
        }
        $('lyrics-count').textContent = `${r.lyrics.length} / ${lyricLimit}`;

        const warnings = current.warnings || [];
        $('warnings').hidden = !warnings.length;
        $('warnings').textContent = warnings.join(' ');
        $('notes-card').hidden = !r.notes.length;
        $('notes').textContent = '';
        r.notes.forEach(n => $('notes').appendChild(el('li', '', n)));

        // Video plan
        const v = r.visual;
        const swatches = $('swatches');
        swatches.textContent = '';
        [v.accent, ...v.palette.filter(c => c.toLowerCase() !== v.accent.toLowerCase())].slice(0, 4).forEach(c => { const i = el('i'); i.style.background = c; i.title = c; swatches.appendChild(i); });
        const visName = { aetherflux: 'AetherFlux', kinetix: 'KINETIX' }[v.visualizer] || 'Spectrum';
        $('plan-summary').textContent = `${visName} visualiser · ${v.artStyle.replace(/,?\s*no text.*$/i, '')}`;
        const scenes = $('scenes');
        scenes.textContent = '';
        v.scenes.forEach((sc, i) => {
            const li = el('li');
            li.append(el('span', 'sec', sc.section), el('span', 'moment', sc.moment ? `“${sc.moment}”` : ''), el('span', 'prompt', sc.prompt));
            const copy = el('button', 'copy', 'Copy prompt');
            copy.type = 'button';
            copy.onclick = () => copyText(fullScenePrompt(sc), copy);
            li.appendChild(copy);
            scenes.appendChild(li);
        });
        $('make-video').href = `${['aetherflux', 'kinetix'].includes(v.visualizer) ? v.visualizer : 'spectrum'}.html?from=studio`;   // older results say 'monstercat'

        // YouTube kit
        $('yt-title').textContent = r.youtube.title;
        $('yt-description').textContent = ytDescription();
        $('yt-tags').textContent = r.youtube.tags.join(', ');
    }

    function fullScenePrompt(sc) {
        const v = current.result.visual;
        const who = v.character && /\bthe character\b/i.test(sc.prompt) ? ` The character: ${v.character}.` : '';
        return `${sc.prompt}${who} ${v.artStyle}`.replace(/\s+/g, ' ').trim();
    }
    function ytDescription() {
        const y = current.result.youtube;
        return `${y.description}${y.hashtags.length ? `\n\n${y.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')}` : ''}`;
    }

    function renderHistory() {
        const history = store.get('studio.history', []);
        $('history-wrap').hidden = !history.length;
        const list = $('history');
        list.textContent = '';
        history.forEach(h => {
            const b = el('button');
            b.type = 'button';
            b.append(el('b', '', h.result.titles[h.title] || h.result.titles[0] || 'Untitled'), el('span', '', h.input.description || 'From your lyrics'));
            b.onclick = () => { current = { input: h.input, result: h.result, warnings: h.warnings, title: h.title || 0 }; save(false); fillForm(h.input); render(); $('results').scrollIntoView({ behavior: 'smooth' }); };
            list.appendChild(b);
        });
    }

    // ---- Copy ----
    async function copyText(text, button) {
        try { await navigator.clipboard.writeText(text); }
        catch {
            const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
            try { document.execCommand('copy'); } catch {} t.remove();
        }
        if (button) { const was = button.textContent; button.textContent = 'Copied'; button.classList.add('done'); setTimeout(() => { button.textContent = was; button.classList.remove('done'); }, 1400); }
    }
    const COPY = {
        style: () => current.result.style,
        exclude: () => current.result.exclude,
        lyrics: () => current.result.lyrics,
        scenes: () => current.result.visual.scenes.map((sc, i) => `${i + 1}. ${sc.section}: ${fullScenePrompt(sc)}`).join('\n\n'),
        ytTitle: () => current.result.youtube.title,
        ytDescription,
        ytTags: () => current.result.youtube.tags.join(', '),
    };

    // ---- Hand-off to the visualisers ----
    function handOff() {
        window.track && window.track('Make the video', { visualizer: current.result.visual.visualizer });
        const r = current.result;
        store.set('studio.handoff', {
            title: chosenTitle(), artist: current.input.artist || '', accent: r.visual.accent, palette: r.visual.palette,
            visualizer: r.visual.visualizer, at: Date.now(),
        });
    }

    // ---- Wire up ----
    EXAMPLES.forEach(text => {
        const b = el('button', '', text.length > 52 ? `${text.slice(0, 50)}…` : text);
        b.type = 'button';
        b.title = text;
        b.onclick = () => { $('description').value = text; $('description').focus(); };
        $('examples').appendChild(b);
    });
    REFINES.forEach(text => {
        const b = el('button', '', text);
        b.type = 'button';
        b.onclick = () => refine(text === 'Different title ideas' ? 'Give three new, more striking title ideas; keep everything else.' : `Make it ${text.toLowerCase()}.`);
        $('refine-chips').appendChild(b);
    });
    document.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        setSeg(seg.dataset.name, b.dataset.value);
    }));
    document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => current && copyText(COPY[b.dataset.copy](), b)));
    $('compose').addEventListener('submit', generate);
    $('refine-form').addEventListener('submit', e => { e.preventDefault(); refine($('refine-text').value.trim()); });
    $('description').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('compose').requestSubmit(); });
    $('make-video').addEventListener('click', handOff);
    $('make-reveal').addEventListener('click', handOff);

    // Spectrum card: a row of bars with staggered timing.
    const bars = $('bars');
    for (let i = 0; i < 34; i++) {
        const b = el('div', 'bar');
        b.style.height = `${18 + 70 * Math.pow(1 - i / 34, 1.6)}px`;
        b.style.animationDelay = `${-(i * 0.13) % 1.1}s`;
        b.style.animationDuration = `${0.8 + (i % 5) * 0.12}s`;
        bars.appendChild(b);
    }

    if (current) { fillForm(current.input); render(); }
    renderHistory();
})();
