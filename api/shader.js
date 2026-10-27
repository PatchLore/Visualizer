// Vercel entry point for POST /api/shader. The engine is api/_lib/shader.js (underscore folders are neither routes
// nor static files on Vercel); this passes the request through with Vercel's environment variables.
import { onRequestPost } from './_lib/shader.js';

export async function POST(request) {
    return onRequestPost({ request, env: process.env });
}
