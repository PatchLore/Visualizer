// Tailwind for chromaflow.html, built to css/chromaflow.css by `npm run css` (rebuild after changing classes).
module.exports = {
    content: ['chromaflow.html'],
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: { sans: ['Inter', 'sans-serif'], mono: ['JetBrains Mono', 'monospace'] },
            colors: { zinc: { 850: '#1f1f23', 925: '#121215', 950: '#09090b' } },
        },
    },
};
