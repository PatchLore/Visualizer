// Daily limits for the AI endpoints (the Song Studio, the loop writer and lyric sync), per visitor and optionally for
// the whole site, so a public deployment can't run up the Anthropic and Groq bills.
//
// Counters live in the first of these that is available:
//   - a Cloudflare KV namespace bound as QUOTA (Cloudflare Pages);
//   - Upstash Redis over its REST API: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or KV_REST_API_URL +
//     KV_REST_API_TOKEN as Vercel's Upstash integration names them;
//   - this server instance's memory. Only a fallback: Vercel runs several short-lived instances, each counting on
//     its own, so set up Redis for a limit that really holds.
//
// Environment (the per-endpoint limits are read by the endpoints and passed in):
//   FREE_DAILY_LIMIT (5), SHADER_DAILY_LIMIT (20), LYRICS_DAILY_LIMIT (10)   per visitor per day
//   PRO_LIMIT_FACTOR   visitors who send the access code get this many times the limit (default 10)
//   AI_DAILY_LIMIT     optional: all AI requests per day across every visitor, a hard ceiling on the day's cost
const TTL = 60 * 60 * 26;   // a day's counter outlives its day, whatever the time zone
const memory = new Map();   // key -> {count, expires}

// The visitor's IP, from the header the platform itself sets, never one a visitor could send: Vercel overwrites
// x-real-ip and x-forwarded-for but passes cf-connecting-ip through untouched, so trusting that header there would let
// anyone send a new made-up value with each request and get a fresh daily quota every time. Cloudflare sets
// cf-connecting-ip itself.
function visitor(request, env) {
    const h = request.headers;
    const forwarded = (h.get('x-forwarded-for') || '').split(',')[0].trim();
    const ip = env.VERCEL
        ? h.get('x-real-ip') || forwarded
        : h.get('cf-connecting-ip') || h.get('x-real-ip') || forwarded;
    return ip || 'unknown';
}

// Adds one to a counter and returns the new count.
async function increment(env, key) {
    if (env.QUOTA) {
        const used = (Number(await env.QUOTA.get(key)) || 0) + 1;
        await env.QUOTA.put(key, String(used), { expirationTtl: TTL });
        return used;
    }
    const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL, token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
    if (url && token) {
        try {
            const res = await fetch(`${url.replace(/\/$/, '')}/pipeline`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify([['INCR', key], ['EXPIRE', key, String(TTL)]]),
            });
            if (res.ok) {
                const n = Number((await res.json())[0]?.result);
                if (Number.isFinite(n)) return n;
            }
            console.error('Redis counter failed', res.status);
        } catch (err) {
            console.error('Redis counter unreachable', err.message);
        }
        // Redis unavailable: count in memory rather than refuse everyone.
    }
    const now = Date.now();
    for (const [k, v] of memory) if (v.expires < now) memory.delete(k);
    const entry = memory.get(key) || { count: 0, expires: now + TTL * 1000 };
    entry.count++;
    memory.set(key, entry);
    return entry.count;
}

// Counts one request against the visitor's daily limit for this endpoint (prefix) and the site's daily ceiling.
// Returns {limit, left}; left < 0 means refused, with site: true when the site-wide ceiling was the reason.
export async function useQuota(request, env, { prefix = 'q', limit = Number(env.FREE_DAILY_LIMIT || 5) } = {}) {
    const pro = env.STUDIO_ACCESS_CODE && request.headers.get('x-studio-code') === env.STUDIO_ACCESS_CODE;
    const cap = pro ? limit * Number(env.PRO_LIMIT_FACTOR || 10) : limit;
    const day = new Date().toISOString().slice(0, 10);
    const used = await increment(env, `${prefix}:${day}:${visitor(request, env)}`);
    if (used > cap) return { limit: cap, left: -1 };
    if (env.AI_DAILY_LIMIT) {
        const all = await increment(env, `all:${day}`);
        if (all > Number(env.AI_DAILY_LIMIT)) return { limit: cap, left: -1, site: true };
    }
    return { limit: cap, left: cap - used };
}

// The refusal for a 429: the visitor's own limit, or the site's ceiling.
export function limitMessage(quota, whatRanOut) {
    return quota.site
        ? 'The generator has reached its limit for today. Try again tomorrow.'
        : `You have reached today's limit for ${whatRanOut}. Come back tomorrow.`;
}
