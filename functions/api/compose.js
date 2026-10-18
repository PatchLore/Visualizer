// Cloudflare Pages entry point for POST /api/compose. The engine lives in api/_lib/compose.js, where Vercel never
// serves it as a static file (the prompt is the product, so it shouldn't be readable).
export { onRequestPost } from '../../api/_lib/compose.js';
