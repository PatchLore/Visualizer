// The Pro access code: asked for in a small dialog (not window.prompt) when an AI endpoint answers 401 needCode, and
// remembered in this browser.
//
//   const { res, data } = await AccessCode.request(code => fetch(url, { headers: { 'x-studio-code': code }, ... }), 'The Song Studio');
//
// request() sends with the remembered code; on a needCode refusal it asks, resends, and asks again (saying so) while
// the code is wrong. Cancelling throws an Error with .pro = true, so the page can point at the Pro section.
(function () {
    const KEY = 'studio.code';
    const get = () => { try { return JSON.parse(localStorage.getItem(KEY) || '""'); } catch { return ''; } };
    const set = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };
    const parse = res => res.json().catch(() => ({ error: 'The server sent an unexpected reply.' }));

    let dialog = null;
    function build() {
        const css = document.createElement('style');
        css.textContent = `
            .acc { box-sizing: border-box; overflow: visible; border: 1px solid rgba(255,255,255,0.16); border-radius: 16px; padding: 22px; width: min(400px, calc(100vw - 32px)); background: #0d1018;
                color: #eef0f6; font: 14px/1.5 Montserrat, Inter, 'Segoe UI', sans-serif; box-shadow: 0 30px 80px rgba(0,0,0,0.6); }
            .acc::backdrop { background: rgba(3,5,10,0.7); backdrop-filter: blur(4px); }
            .acc h2 { margin: 0 0 6px; font-size: 17px; }
            .acc p { margin: 0 0 14px; color: #aeb6c8; font-size: 13px; }
            .acc input { width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18);
                background: #070910; color: #fff; font: inherit; letter-spacing: 0.5px; }
            .acc input:focus { outline: 2px solid #a78bfa; outline-offset: 1px; }
            .acc .err { color: #ff9db3; font-size: 12.5px; min-height: 18px; margin: 6px 0 4px; }
            .acc .row { display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; margin-top: 6px; }
            .acc .row a { margin-right: auto; color: #c4b5fd; font-size: 13px; }
            .acc button { min-height: 40px; padding: 0 16px; border-radius: 10px; font: inherit; font-size: 13px; cursor: pointer; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: #fff; }
            .acc button.go { border: 0; font-weight: 700; background: linear-gradient(135deg, #ff2d55, #c026d3 60%, #a78bfa); }
            .acc button:focus-visible, .acc a:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; }`;
        document.head.appendChild(css);
        dialog = document.createElement('dialog');
        dialog.className = 'acc';
        dialog.innerHTML = `
            <form method="dialog">
                <h2>Pro access code</h2>
                <p class="why"></p>
                <label class="sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)" for="acc-code">Access code</label>
                <input id="acc-code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Your access code" required>
                <div class="err" role="alert" aria-live="assertive"></div>
                <div class="row">
                    <a href="index.html#pro">What's Pro?</a>
                    <button type="button" value="cancel" class="cancel">Cancel</button>
                    <button type="submit" value="ok" class="go">Unlock</button>
                </div>
            </form>`;
        document.body.appendChild(dialog);
        // Answered straight from Unlock, Cancel and Escape (the dialog's own close event can be held back while the
        // page isn't being drawn).
        const input = dialog.querySelector('input');
        dialog.querySelector('form').addEventListener('submit', e => { e.preventDefault(); finish(input.value.trim() || null); });
        dialog.querySelector('.cancel').onclick = () => finish(null);
        dialog.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
    }

    let answer = null;
    function finish(code) {
        dialog.close();
        if (answer) { const done = answer; answer = null; done(code); }
    }

    // Shows the dialog and resolves with the code, or null if cancelled.
    function ask(feature, error = '') {
        if (!dialog) build();
        dialog.querySelector('.why').textContent = `${feature} is part of Pro. Enter your access code to use it; this browser will remember it.`;
        dialog.querySelector('.err').textContent = error;
        const input = dialog.querySelector('input');
        input.value = '';
        return new Promise(resolve => {
            answer = resolve;
            dialog.showModal();
            input.focus();
        });
    }

    async function request(send, feature) {
        let res = await send(get());
        let data = await parse(res);
        let error = '';
        while (res.status === 401 && data.needCode) {
            const code = await ask(feature, error);
            if (code === null) { const e = new Error(`${feature} is part of Pro. `); e.pro = true; throw e; }
            set(code);
            res = await send(code);
            data = await parse(res);
            if (res.status === 401) { set(''); error = "That code isn't right. Check it and try again."; }
        }
        return { res, data };
    }

    window.AccessCode = { request, ask, get };
})();
