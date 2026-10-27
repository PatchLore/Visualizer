// Cloudflare Pages entry point for POST /api/shader. The engine lives in api/_lib/shader.js, where Vercel never
// serves it as a static file.
export { onRequestPost } from '../../api/_lib/shader.js';
