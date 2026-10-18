// In-browser MP4 export, shared by both visualisers.
//
// The page is loaded again in a hidden iframe at exactly the export size (1920x1080 or 1080x1920), so its drawing
// code sees the same window size it would full screen. The iframe page analyses the track offline and draws each
// frame on request (__setupExport / __renderExportFrame); every frame is encoded with WebCodecs (H.264, falling
// back to VP9) and the original audio is re-encoded (AAC, falling back to Opus), then both are muxed into an MP4
// with mp4-muxer. Nothing leaves the computer.
//
// Usage from a page:
//   const save = await BrowserExport.pickSaveFile(name);         // call first, inside the click handler
//   await BrowserExport.exportVideo({page, settings, audioFile, aspect, fileName, save});
(function () {
    const SIZES = { landscape: [1920, 1080], portrait: [1080, 1920] };
    const FPS = 30;
    const SAMPLE_RATE = 48000;

    // Yields to the event loop without timers, which hidden tabs throttle hard.
    const yieldNow = () => new Promise(resolve => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => resolve();
        ch.port2.postMessage(0);
    });

    function supported() {
        return 'VideoEncoder' in window && 'AudioEncoder' in window && 'VideoFrame' in window;
    }

    async function pickVideoConfig(width, height) {
        const options = [
            ['avc1.64002a', 'avc'],   // H.264 High 4.2
            ['avc1.4d002a', 'avc'],   // Main
            ['avc1.42002a', 'avc'],   // Baseline
            ['vp09.00.41.08', 'vp9'],
        ];
        for (const [codec, muxCodec] of options) {
            const config = { codec, width, height, bitrate: 12_000_000, framerate: FPS };
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
        const bar = document.createElement('div');
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
        card.append(frame, bar, text, hint, cancel);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        return {
            iframe, cancel,
            set(progress, message) { fill.style.width = `${Math.round(progress * 100)}%`; text.textContent = message; },
            remove() { overlay.remove(); },
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
    // audioFile: the track as a File/Blob. save: a handle from pickSaveFile, or null for an in-memory file.
    // Returns {blob, url} for in-memory exports (also offered as a download), or {savedTo} for streamed ones.
    async function exportVideo({ page, settings, audioFile, aspect = 'landscape', fileName = 'visualiser.mp4', save = null }) {
        if (!supported()) throw new Error('Exporting needs WebCodecs. Use Chrome or Edge on a computer.');
        if (!audioFile) throw new Error('Load a track first.');
        const [width, height] = SIZES[aspect] || SIZES.landscape;
        const ui = makeOverlay(width, height);
        let cancelled = false;
        ui.cancel.onclick = () => { cancelled = true; ui.set(0, 'Cancelling…'); };
        const audioUrl = URL.createObjectURL(audioFile);
        let videoEncoder = null, audioEncoder = null, fileStream = null;
        const fail = { error: null };
        const check = () => { if (fail.error) throw fail.error; if (cancelled) throw new Error('Export cancelled.'); };

        try {
            ui.set(0, 'Checking what this browser can encode…');
            const video = await pickVideoConfig(width, height);
            const audio = await pickAudioConfig();

            ui.set(0, 'Decoding the track…');
            const decoded = await new OfflineAudioContext(2, 1, SAMPLE_RATE).decodeAudioData(await audioFile.arrayBuffer());

            ui.set(0, 'Opening the renderer…');
            ui.iframe.src = `${page}${page.includes('?') ? '&' : '?'}export=local`;
            await waitFor(() => ui.iframe.contentWindow && ui.iframe.contentWindow.__visReady, 30000, 'Opening the renderer');
            const win = ui.iframe.contentWindow;
            win.__localExport = { settings: { ...settings, fps: FPS }, audioUrl };

            ui.set(0, 'Analysing the track…');
            const { frames } = await win.__setupExport();
            check();

            const { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } = window.Mp4Muxer;
            let target;
            if (save) {
                fileStream = await save.createWritable();
                target = new FileSystemWritableFileStreamTarget(fileStream);
            } else {
                target = new ArrayBufferTarget();
            }
            const muxer = new Muxer({
                target,
                video: { codec: video.muxCodec, width, height, frameRate: FPS },
                audio: { codec: audio.muxCodec, numberOfChannels: 2, sampleRate: SAMPLE_RATE },
                fastStart: save ? false : 'in-memory',
                firstTimestampBehavior: 'offset',
            });

            videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { fail.error = e; } });
            videoEncoder.configure(video.config);
            audioEncoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { fail.error = e; } });
            audioEncoder.configure(audio.config);

            // Audio first (seconds of work): the track, cut to the video's length, in 0.1 s blocks.
            const total = Math.min(decoded.length, Math.round(frames / FPS * SAMPLE_RATE));
            const block = SAMPLE_RATE / 10;
            for (let at = 0; at < total; at += block) {
                const count = Math.min(block, total - at);
                const data = new AudioData({
                    format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfChannels: 2, numberOfFrames: count,
                    timestamp: Math.round(at / SAMPLE_RATE * 1e6), data: planarAudio(decoded, at, count),
                });
                audioEncoder.encode(data);
                data.close();
            }
            await audioEncoder.flush();
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
                while (videoEncoder.encodeQueueSize > 4) await new Promise(r => videoEncoder.addEventListener('dequeue', r, { once: true }));
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
                return { savedTo: save.name };
            }
            const blob = new Blob([target.buffer], { type: 'video/mp4' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            return { blob, url };
        } catch (err) {
            if (fileStream) { try { await fileStream.abort(); } catch {} }
            throw err;
        } finally {
            for (const enc of [videoEncoder, audioEncoder]) { if (enc && enc.state !== 'closed') { try { enc.close(); } catch {} } }
            URL.revokeObjectURL(audioUrl);
            ui.remove();
        }
    }

    // A file name from the artist and title: "Artist - Title.mp4".
    function fileNameFor(artist, title, aspect) {
        const clean = s => (s || '').replace(/[\\/:*?"<>|]+/g, '').trim();
        const base = [clean(artist), clean(title)].filter(Boolean).join(' - ') || 'visualiser';
        return `${base}${aspect === 'portrait' ? ' (9x16)' : ''}.mp4`;
    }

    window.BrowserExport = { supported, pickSaveFile, exportVideo, fileNameFor };
})();
