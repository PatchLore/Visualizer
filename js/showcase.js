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
