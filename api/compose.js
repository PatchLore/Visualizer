// Vercel entry point for POST /api/compose. The engine is api/_lib/compose.js (underscore folders are neither
// routes nor static files on Vercel); this passes the request through with Vercel's environment variables.
import { onRequestPost } from './_lib/compose.js';

export async function POST(request) {
    return onRequestPost({ request, env: process.env });
}
