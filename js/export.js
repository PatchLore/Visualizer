// In-browser MP4 export, shared by both visualisers.
//
// The page is loaded again in a hidden iframe at exactly the export size (1920x1080 or 1080x1920), so its drawing
// code sees the same window size it would full screen. The iframe page analyses the track offline and draws each
// frame on request (__setupExport / __renderExportFrame); every frame is encoded with WebCodecs (H.264, falling
// back to VP9) and the original audio is re-encoded (AAC, falling back to Opus), then both are muxed into an MP4
// with mp4-muxer (loaded from jsDelivr on the first export, so pages that never export don't download it). Nothing
// leaves the computer.
//
// Usage from a page:
//   const save = await BrowserExport.pickSaveFile(name);         // call first, inside the click handler
//   await BrowserExport.exportVideo({page, settings, audioFile, aspect, fileName, save});
(function () {
    const SIZES = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] };
    const FPS = 30;
    const SAMPLE_RATE = 48000;
    // The in-memory path can't stream to disk, so cap the quality to keep a long track's file (and the memory it
    // needs) within reach of a laptop.
    const MAX_MEMORY_BYTES = 600 * 1024 * 1024;
    let lastUrl = null;

    // Yields to the event loop without timers, which hidden tabs throttle hard.
    const yieldNow = () => new Promise(resolve => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve();
        ch.port2.postMessage(0);
    });

    // mp4-muxer, fetched once, the first time something needs it (an export here, or lyric sync's upload in
    // js/lyrics.js).
    const MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.js';
    let muxerLoading = null;
    function loadMuxer() {
        if (window.Mp4Muxer) return Promise.resolve(window.Mp4Muxer);
        if (!muxerLoading) {
            muxerLoading = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = MUXER_URL;
                script.onload = () => (window.Mp4Muxer ? resolve(window.Mp4Muxer) : reject(new Error('The MP4 writer did not load.')));
                script.onerror = () => { muxerLoading = null; script.remove(); reject(new Error('Could not load the MP4 writer. Check your connection and try again.')); };
                document.head.appendChild(script);
            });
        }
        return muxerLoading;
    }

    function supported() {
        return 'VideoEncoder' in window && 'AudioEncoder' in window && 'VideoFrame' in window;
    }

    // Rendering a whole track holds the decoded audio and the growing file in memory; phones and tablets get
    // killed and quietly reload to a blank page halfway through, so they're refused up front.
    function onMobile() {
        if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile;
        return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    async function pickVideoConfig(width, height, bitrate) {
        const options = [
            ['avc1.64002a', 'avc'],   // H.264 High 4.2
            ['avc1.4d002a', 'avc'],   // Main
            ['avc1.42002a', 'avc'],   // Baseline
            ['vp09.00.41.08', 'vp9'],
        ];
        for (const [codec, muxCodec] of options) {
            const config = { codec, width, height, bitrate, framerate: FPS };
            if (muxCodec === 'avc') config.avc = { format: 'avc' };
            try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, muxCodec }; } catch {}
        }
        throw new Error('This browser cannot encode video. Use Chrome or Edge on a computer.');
    }

    async function pickAudioConfig() {
        const options = [['mp4a.40.2', 'aac', 256_000], ['opus', 'opus', 192_000]];
        for (const [codec, muxCodec, bitrate] of options) {
            const config = { codec, sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate };
            try { if ((await AudioEncoder.isConfigSupported(config)).supported) return { config, muxCodec }; } catch {}
        }
        throw new Error('This browser cannot encode audio. Use Chrome or Edge on a computer.');
    }

    // Chrome and Edge can stream the MP4 straight to disk, so long tracks never sit in memory. Must be called
    // from the click handler itself (the browser only shows the save dialog for a user gesture).
    async function pickSaveFile(fileName) {
        if (!window.showSaveFilePicker) return null;
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
            });
            return handle;
        } catch (err) {
            if (err.name === 'AbortError') throw new Error('Export cancelled.');
            return null;   // dialog unavailable: fall back to an in-memory file and a download
        }
    }

    // Progress overlay with a live preview of the frames being drawn.
    function makeOverlay(width, height) {
        const overlay = document.createElement('div');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Exporting video');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;'
            + 'padding:16px;background:rgba(3,5,10,0.86);backdrop-filter:blur(6px);font-family:Montserrat,Inter,"Segoe UI",sans-serif;color:#eef0f6';
        const card = document.createElement('div');
        card.style.cssText = 'display:flex;flex-direction:column;gap:12px;max-width:100%;padding:18px;border-radius:16px;'
            + 'background:#0b0e17;border:1px solid rgba(255,255,255,0.12);box-shadow:0 20px 60px rgba(0,0,0,0.5)';
        const scale = Math.min(520 / width, 360 / height, (window.innerWidth - 70) / width);
        const frame = document.createElement('div');
        frame.style.cssText = `position:relative;overflow:hidden;border-radius:10px;background:#000;width:${Math.round(width * scale)}px;height:${Math.round(height * scale)}px`;
        const iframe = document.createElement('iframe');
        iframe.style.cssText = `position:absolute;left:0;top:0;border:0;width:${width}px;height:${height}px;transform:scale(${scale});transform-origin:0 0;pointer-events:none`;
        frame.appendChild(iframe);
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
        const bar = document.createElement('div');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', 'Export progress');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.style.cssText = 'height:6px;border-radius:3px;background:rgba(255,255,255,0.1);overflow:hidden';
        const fill = document.createElement('div');
        fill.style.cssText = 'height:100%;width:0;background:linear-gradient(90deg,#22d3ee,#a78bfa);transition:width .2s';
        bar.appendChild(fill);
        const text = document.createElement('div');
        text.style.cssText = 'font-size:13px;color:#cfd5e4';
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11px;color:#6b7388';
        hint.textContent = 'Rendering on your computer. Keep this tab open; nothing is uploaded.';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.style.cssText = 'align-self:flex-end;padding:7px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.06);color:#fff;font:inherit;font-size:12px;cursor:pointer';
        // What a screen reader hears: each stage, then every 10% while rendering, then the result.
        const live = document.createElement('div');
        live.setAttribute('role', 'status');
        live.setAttribute('aria-live', 'polite');
        live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';
        let spokenStage = '', spokenTenth = -1;
        card.append(frame, bar, text, hint, cancel, live);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        const returnFocus = document.activeElement;
        cancel.focus();
        const close = () => { overlay.remove(); if (returnFocus && returnFocus.focus) returnFocus.focus(); };

        function button(label, primary) {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = primary
                ? 'padding:10px 18px;border-radius:10px;border:0;background:linear-gradient(90deg,#22d3ee,#a78bfa);color:#04101c;font:inherit;font-size:13px;font-weight:700;cursor:pointer'
                : 'padding:10px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.06);color:#fff;font:inherit;font-size:13px;cursor:pointer';
            return b;
        }
        // Replaces the progress view with a final panel, so finishing is obvious and the file can always be saved.
        function panel(mark, title, detail, actions) {
            frame.remove();
            bar.remove();
            text.remove();
            hint.remove();
            cancel.remove();
            const head = document.createElement('div');
            head.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700';
            const badge = document.createElement('span');
            badge.textContent = mark;
            badge.style.cssText = 'display:grid;place-items:center;width:26px;height:26px;border-radius:50%;font-size:14px;'
                + (mark === '✓' ? 'background:#10b981;color:#04101c' : 'background:#f59e0b;color:#1a1205');
            const heading = document.createElement('span');
            heading.textContent = title;
            head.append(badge, heading);
            const line = document.createElement('div');
            line.textContent = detail || '';
            line.style.cssText = 'font-size:12px;color:#aeb6c8;line-height:1.5;max-width:420px;word-break:break-word';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center';
            actions.forEach(a => row.appendChild(a));
            card.append(head, line, row);
            live.textContent = `${title}. ${detail || ''}`;
            overlay.setAttribute('aria-label', title);
            actions[0].focus();
        }

        return {
            iframe, cancel,
            set(progress, message) {
                fill.style.width = `${Math.round(progress * 100)}%`;
                bar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
                text.textContent = message;
                const stage = message.replace(/\d.*$/, ''), tenth = Math.floor(progress * 10);
                if (stage !== spokenStage || tenth !== spokenTenth) {
                    spokenStage = stage; spokenTenth = tenth;
                    live.textContent = progress > 0 && progress < 1 ? `${message}, ${Math.round(progress * 100)}%` : message;
                }
            },
            done({ title, detail, url, fileName }) {
                const actions = [];
                if (url) {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = fileName || 'visualiser.mp4';
                    a.textContent = 'Download MP4';
                    a.style.cssText = 'padding:10px 18px;border-radius:10px;background:linear-gradient(90deg,#22d3ee,#a78bfa);color:#04101c;font-size:13px;font-weight:700;text-decoration:none';
                    actions.push(a);
                }
                const done = button(url ? 'Done' : 'Close', false);
                done.onclick = close;
                actions.push(done);
                panel('✓', title || 'Video ready', detail, actions);
            },
            error(message) {
                const shut = button('Close', false);
                shut.onclick = close;
                panel('!', 'Export failed', message, [shut]);
            },
            remove: close,
        };
    }

    function waitFor(check, timeoutMs, what) {
        const start = performance.now();
        return new Promise((resolve, reject) => {
            const tick = () => {
                if (check()) return resolve();
                if (performance.now() - start > timeoutMs) return reject(new Error(`${what} timed out.`));
                setTimeout(tick, 50);
            };
            tick();
        });
    }

    function planarAudio(buffer, from, count) {
        const data = new Float32Array(count * 2);
        const left = buffer.getChannelData(0), right = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
        data.set(left.subarray(from, from + count), 0);
        data.set(right.subarray(from, from + count), count);
        return data;
    }

    // page: the visualiser's own URL (loaded with ?export=local). settings: what the page's __setupExport reads.
    // audioFile: the track as a File/Blob. silent: true for a video with no audio track at all (loops such as Spotify
    // Canvas, which plays without sound); then audioFile is not needed. save: a handle from pickSaveFile, or null for
    // an in-memory file. Returns {blob, url} for in-memory exports (with a Download button left on screen), or
    // {savedTo} for streamed ones.
    async function exportVideo({ page, settings, audioFile, aspect = 'landscape', fileName = 'visualiser.mp4', save = null, silent = false }) {
        if (!supported()) throw new Error('Exporting needs WebCodecs. Use Chrome or Edge on a computer.');
        if (!audioFile && !silent) throw new Error('Load a track first.');
        if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
        const [width, height] = SIZES[aspect] || SIZES.landscape;
        const ui = makeOverlay(width, height);
        const muxerReady = loadMuxer();   // fetched while the track decodes
        muxerReady.catch(() => {});
        let cancelled = false, keepOpen = false;
        ui.cancel.onclick = () => { cancelled = true; ui.set(0, 'Cancelling…'); };
        const audioUrl = audioFile ? URL.createObjectURL(audioFile) : null;
        let videoEncoder = null, audioEncoder = null, fileStream = null;
        const fail = { error: null };
        const check = () => { if (fail.error) throw fail.error; if (cancelled) throw new Error('Export cancelled.'); };

        try {
            ui.set(0, 'Checking what this browser can encode…');
            const page0 = page.replace(/\.html.*$/, '');
            if (window.track) window.track('Export started', { page: page0, aspect });
            if (onMobile()) {
                throw new Error('Rendering a full video needs Chrome or Edge on a computer. Phones and tablets run out of memory part-way through, which reloads the page and loses the render.');
            }
            const audio = silent ? null : await pickAudioConfig();

            ui.set(0, silent ? 'Preparing…' : 'Decoding the track…');
            let decoded = silent ? null : await new OfflineAudioContext(2, 1, SAMPLE_RATE).decodeAudioData(await audioFile.arrayBuffer());
            // Without a save handle the whole MP4 is held in memory, so spend fewer bits per second on long tracks.
            // Silent loops (Spotify Canvas and similar) are short and get uploaded, so they use a lighter 8 Mbps.
            const bitrate = silent ? 8_000_000 : save ? 12_000_000
                : Math.max(2_500_000, Math.min(12_000_000, Math.round(MAX_MEMORY_BYTES * 8 / Math.max(decoded.duration, 1))));
            const video = await pickVideoConfig(width, height, bitrate);

            ui.set(0, 'Opening the renderer…');
            ui.iframe.src = `${page}${page.includes('?') ? '&' : '?'}export=local`;
            await waitFor(() => ui.iframe.contentWindow && ui.iframe.contentWindow.__visReady, 30000, 'Opening the renderer');
            const win = ui.iframe.contentWindow;
            win.__localExport = { settings: { ...settings, fps: FPS }, audioUrl };

            ui.set(0, 'Analysing the track…');
            // start: where in the track the video begins (pages that export a clip); 0 otherwise. fade: the clip's audio
            // fades in briefly and out over the last second, so it doesn't start or stop mid-note.
            const { frames, duration, start = 0, fade = false } = await win.__setupExport();
            check();

            const { Muxer, StreamTarget, FileSystemWritableFileStreamTarget } = await muxerReady;
            let target, parts = null;
            if (save) {
                fileStream = await save.createWritable();
                target = new FileSystemWritableFileStreamTarget(fileStream);
            } else {
                // Keep the output as separate byte ranges and hand them to a Blob at the end. A Blob lives outside
                // the JS heap (the browser can page it to disk), so a long render doesn't need one giant buffer.
                parts = new ChunkCollector();
                target = new StreamTarget({ onData: (data, position) => parts.add(data, position) });
            }
            const muxer = new Muxer({
                target,
                video: { codec: video.muxCodec, width, height, frameRate: FPS },
                ...(silent ? {} : { audio: { codec: audio.muxCodec, numberOfChannels: 2, sampleRate: SAMPLE_RATE } }),
                fastStart: false,   // metadata at the end: media is written once, straight through, as it's encoded
                firstTimestampBehavior: 'offset',
            });

            videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { fail.error = e; } });
            videoEncoder.configure(video.config);
            if (!silent) {
                audioEncoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { fail.error = e; } });
                audioEncoder.configure(audio.config);
            }

            // Audio first (seconds of work): the track from the clip's start, cut to the video's length, in 0.1 s blocks.
            const offset = silent ? 0 : Math.min(decoded.length, Math.max(0, Math.round(start * SAMPLE_RATE)));
            const total = silent ? 0 : Math.min(decoded.length - offset, Math.round(frames / FPS * SAMPLE_RATE));
            const block = SAMPLE_RATE / 10;
            for (let at = 0; at < total; at += block) {
                const count = Math.min(block, total - at);
                const samples = planarAudio(decoded, offset + at, count);
                if (fade) {
                    const fadeIn = 0.08 * SAMPLE_RATE, fadeOut = 1.0 * SAMPLE_RATE;
                    for (let k = 0; k < count; k++) {
                        const n = at + k, g = Math.min(1, n / fadeIn, (total - n) / fadeOut);
                        if (g < 1) { samples[k] *= g; samples[count + k] *= g; }
                    }
                }
                const data = new AudioData({
                    format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfChannels: 2, numberOfFrames: count,
                    timestamp: Math.round(at / SAMPLE_RATE * 1e6), data: samples,
                });
                audioEncoder.encode(data);
                data.close();
                if ((at / block) % 100 === 0) await yieldNow();   // long tracks keep the progress bar moving
            }
            if (audioEncoder) await audioEncoder.flush();
            decoded = null;   // the encoded audio is in the muxer now; free the decoded track before the video loop
            check();

            // Video, frame by frame.
            const frameUs = 1e6 / FPS, started = performance.now();
            for (let i = 0; i < frames; i++) {
                check();
                const canvas = win.__renderExportFrame(i);
                let frame;
                try {
                    frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs), alpha: 'discard' });
                } catch {
                    const bitmap = await createImageBitmap(canvas);   // fallback for canvases from another document
                    frame = new VideoFrame(bitmap, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs), alpha: 'discard' });
                    bitmap.close();
                }
                videoEncoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
                frame.close();
                // Wait for the encoder to catch up, but never sit here forever if it silently stalls.
                while (videoEncoder.encodeQueueSize > 4) {
                    await Promise.race([
                        new Promise(r => videoEncoder.addEventListener('dequeue', r, { once: true })),
                        new Promise(r => setTimeout(r, 200)),
                    ]);
                    check();
                }
                if (i % 10 === 0) {
                    const elapsed = (performance.now() - started) / 1000, left = i > 30 ? elapsed / i * (frames - i) : null;
                    ui.set(i / frames, `Rendering frame ${i + 1} of ${frames}` + (left != null ? ` · about ${Math.ceil(left / 60)} min left` : ''));
                    await yieldNow();
                }
            }
            ui.set(1, 'Finishing the MP4…');
            await videoEncoder.flush();
            check();
            muxer.finalize();

            if (save) {
                await fileStream.close();
                fileStream = null;
                keepOpen = true;
                if (window.track) window.track('Export finished', { page: page0, aspect, minutes: Math.round(frames / FPS / 60) });
                ui.done({ title: 'Video saved', detail: `${save.name} — the full MP4 is on your computer.` });
                return { savedTo: save.name };
            }
            const blob = parts.blob();
            const url = URL.createObjectURL(blob);
            lastUrl = url;
            keepOpen = true;
            // No auto-download: browsers block one started this long after the click, and then the file looks lost.
            // The panel keeps a real button, clicked by the user, so saving always works.
            if (window.track) window.track('Export finished', { page: page0, aspect, minutes: Math.round(frames / FPS / 60) });
            ui.done({
                title: 'Video complete',
                detail: `${formatBytes(blob.size)} · ${formatDuration(duration || frames / FPS)} · ready to download.`,
                url, fileName,
            });
            return { blob, url };
        } catch (err) {
            if (fileStream) { try { await fileStream.abort(); } catch {} }
            if (!(err && err.message === 'Export cancelled.')) {
                keepOpen = true;
                ui.error(err && err.message ? err.message : 'The renderer stopped unexpectedly.');
            }
            throw err;
        } finally {
            for (const enc of [videoEncoder, audioEncoder]) { if (enc && enc.state !== 'closed') { try { enc.close(); } catch {} } }
            if (audioUrl) URL.revokeObjectURL(audioUrl);
            if (!keepOpen) ui.remove();
        }
    }

    // Holds the MP4 as byte ranges until the end. mp4-muxer writes media in order, then goes back once to patch
    // the size in the mdat header, so a plain push would corrupt the file; overlapping ranges are trimmed here.
    class ChunkCollector {
        constructor() { this.pieces = []; this.next = 0; }
        add(data, position) {
            const end = position + data.byteLength;
            if (position !== this.next) {
                for (let i = this.pieces.length - 1; i >= 0; i--) {
                    const p = this.pieces[i], start = p.position, stop = start + p.data.byteLength;
                    if (stop <= position || start >= end) continue;
                    const before = start < position ? p.data.subarray(0, position - start) : null;
                    const after = stop > end ? p.data.subarray(end - start) : null;
                    this.pieces.splice(i, 1);
                    if (before) this.pieces.push({ position: start, data: before });
                    if (after) this.pieces.push({ position: end, data: after });
                }
            }
            this.pieces.push({ position, data });
            this.next = Math.max(this.next, end);
        }
        blob() {
            const sorted = this.pieces.slice().sort((a, b) => a.position - b.position);
            this.pieces = [];
            return new Blob(sorted.map(p => p.data), { type: 'video/mp4' });
        }
    }

    function formatBytes(bytes) {
        if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
        if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
        return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
    }
    function formatDuration(seconds) {
        const total = Math.max(0, Math.round(seconds || 0));
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    // A file name from the artist and title: "Artist - Title.mp4".
    function fileNameFor(artist, title, aspect) {
        const clean = s => (s || '').replace(/[\\/:*?"<>|]+/g, '').trim();
        const base = [clean(artist), clean(title)].filter(Boolean).join(' - ') || 'visualiser';
        return `${base}${aspect === 'portrait' ? ' (9x16)' : aspect === 'square' ? ' (1x1)' : ''}.mp4`;
    }

    window.BrowserExport = { supported, pickSaveFile, exportVideo, fileNameFor, loadMuxer };
})();
