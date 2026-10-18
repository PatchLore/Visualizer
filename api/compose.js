// Vercel entry point for POST /api/compose. The engine itself lives in functions/api/compose.js (the Cloudflare
// Pages Function); this passes the request through with Vercel's environment variables.
import { onRequestPost } from '../functions/api/compose.js';

export async function POST(request) {
    return onRequestPost({ request, env: process.env });
}
