// Page views and a few key events (window.track(name, data)) through Vercel Web Analytics: switch on Analytics in the
// Vercel project and it starts counting. Nothing is loaded locally. Custom events need a Vercel plan that includes
// them; on others only page views are counted, and track() is harmless.
(function () {
    window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    window.track = (name, data) => { try { window.va('event', { name, data }); } catch {} };
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:') return;
    const s = document.createElement('script');
    s.defer = true;
    s.src = '/_vercel/insights/script.js';
    document.head.appendChild(s);
})();
