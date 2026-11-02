// Home page: the example clips load and play only while on screen (and not at all for people who prefer reduced
// motion, who see the poster frames); the Free and Pro section reads its price and payment link from js/config.js.
(function () {
    const videos = document.querySelectorAll('.showcase video[data-src]');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!still && 'IntersectionObserver' in window) {
        const seen = new IntersectionObserver(entries => {
            for (const e of entries) {
                const v = e.target;
                if (e.isIntersecting) {
                    if (!v.src) v.src = v.dataset.src;
                    v.play().catch(() => {});
                } else v.pause();
            }
        }, { threshold: 0.25 });
        videos.forEach(v => seen.observe(v));
    }

    // The demo video: counted once per visit when it starts playing.
    const demo = document.getElementById('demo-video');
    if (demo) demo.addEventListener('play', () => window.track && window.track('Demo played'), { once: true });

    // "Already have a code?": checked with an empty Studio request, which the server turns away (401) for a wrong code
    // before reading it, and refuses (400) for the missing description before counting it or calling the AI.
    const unlockBtn = document.getElementById('pro-unlock'), unlocked = document.getElementById('pro-unlocked');
    if (unlockBtn && window.AccessCode) unlockBtn.onclick = async () => {
        try {
            const ok = await AccessCode.unlock(code => fetch('api/compose', {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-code': code }, body: '{}',
            }));
            if (ok) unlocked.textContent = 'Unlocked: the Song Studio, AI loops and lyric sync will work in this browser.';
        } catch { unlocked.textContent = 'Could not reach the server. Check your connection and try again.'; }
    };

    const site = window.SITE || {};
    const buy = document.getElementById('pro-buy');
    document.getElementById('pro-price').textContent = site.proPrice || '';
    if (site.proLink) {
        buy.href = site.proLink;
        buy.target = '_blank';
        buy.addEventListener('click', () => window.track && window.track('Get Pro'));
    } else {
        buy.textContent = 'Coming soon';
        buy.classList.add('off');
        buy.removeAttribute('href');
        document.getElementById('pro-note').textContent = 'Pro is opening soon.';
    }
})();
