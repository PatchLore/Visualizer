// POST /api/shader: writes a seamless looping GLSL scene for LOOP//FORGE from a plain-words prompt. Also changes an
// existing scene ("make it red") and repairs one the browser rejected (a compile error, a seam, a black or frozen
// picture, or one too slow to draw). The browser compiles and checks every result, so the code never runs anywhere
// but the visitor's GPU.
//
// Served on Vercel through api/shader.js, on Cloudflare Pages through functions/api/shader.js, and locally through
// dev-server.mjs. Uses the same environment as api/_lib/compose.js, plus:
//   SHADER_EFFORT        low (default, about 15 s) | medium (about 55 s, close to Vercel's 60 s limit) | high
//   SHADER_DAILY_LIMIT   loop requests per visitor per day, fixes included (default 20; see api/_lib/limits.js)
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { useQuota, limitMessage } from './limits.js';

const DEFAULT_MODEL = 'claude-opus-5-5';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function onRequestPost({ request, env }) {
    if (env.STUDIO_ACCESS_CODE && request.headers.get('x-studio-code') !== env.STUDIO_ACCESS_CODE) {
        return json({ error: 'Enter the access code to generate loops.', needCode: true }, 401);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400); }
    const input = {
        prompt: text(body.prompt, 600),
        previous: text(body.previous, 12000),   // the current scene's code, when changing or repairing it
        change: text(body.change, 400),         // what to change about it
        problem: text(body.problem, 2000),      // what the browser found wrong with it
    };
    if (!input.prompt && !input.previous) return json({ error: 'Describe the loop first.' }, 400);
    if ((input.change || input.problem) && !input.previous) return json({ error: 'Nothing to change yet.' }, 400);

    const quota = await useQuota(request, env, { prefix: 'shader', limit: Number(env.SHADER_DAILY_LIMIT || 20) });
    if (quota.left < 0) return json({ error: limitMessage(quota, 'loops'), limited: true, quota }, 429);

    try {
        const scene = await callClaude(env, userPrompt(input));
        const code = scene.code.replace(/^```\w*\s*|```\s*$/g, '').trim();
        if (!/vec3\s+scene\s*\(\s*vec2\s+\w+\s*,\s*float\s+\w+\s*\)/.test(code)) {
            return json({ error: 'The loop came back without its scene function. Try again.' }, 502);
        }
        return json({ name: text(scene.name, 40) || 'Custom loop', code, summary: text(scene.summary, 300), quota });
    } catch (err) {
        if (err.expose) return json({ error: err.message }, err.status || 502);
        if (err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIError && err.status === 529)) {
            return json({ error: 'The loop writer is busy right now. Try again in a minute.' }, 429);
        }
        if (err instanceof Anthropic.AuthenticationError) {
            console.error('Anthropic rejected the API key.');
            return json({ error: 'The generator is not set up yet (API key missing or invalid).' }, 500);
        }
        console.error(err);
        return json({ error: 'Something went wrong writing that loop. Try again.' }, 502);
    }
}

// ---- Prompts ----
// Fixed text, so it's cached across requests. The page compiles the code between a fixed prelude (uniforms and
// helpers) and a fixed main() that adds chromatic aberration, tone mapping and a vignette.
const SYSTEM = `You write looping visuals for LOOP//FORGE, a GIF maker. Each visual is a GLSL ES 1.0 (WebGL 1) fragment-shader scene that the page renders as a perfectly seamless loop. You turn a person's description into one striking, original scene.

WHAT YOU WRITE
Optional helper functions, then exactly this function:
  vec3 scene(vec2 uv, float T)
- uv: the pixel position. The picture's centre is (0, 0); y runs from -0.5 (bottom) to 0.5 (top); x runs the same per unit but wider or narrower with the aspect ratio (square, 3:2 or 9:16). Zoom is already applied.
- T: the loop angle, 0 to TAU over the loop (T = u_phase * TAU).
- Return the colour. Values can go above 1.0 for glow: the page tone-maps (c / (1 + 0.35c)), adds chromatic aberration and a vignette afterwards. Dark backgrounds with bright, glowing forms look best.

ALREADY DEFINED (use them; never declare or redefine them, and don't name anything the same)
- precision highp float; and #define PI 3.14159265359, #define TAU 6.28318530718
- uniform float u_phase;   // 0 to 1 over the loop
- uniform float u_comp;    // the Complexity slider, 1.0 to 8.0 (default 4.0): use it to scale detail, counts or iterations
- uniform float u_hue;     // the Color Palette slider, 0.0 to 1.0, already inside palette()
- uniform vec2 u_res;      // canvas size in pixels
- mat2 rot(float a);       // rotation matrix: p *= rot(a)
- vec3 palette(float t);   // a smooth rainbow palette, period 1.0 in t, shifted by u_hue
- vec2 fold(vec2 p, float n);  // kaleidoscope fold into floor(n) mirrored sectors
Do not write main(), uniforms, varyings, precision lines, #version or #extension.

THE LOOP MUST BE SEAMLESS (the page checks that the frame at T = TAU equals the frame at T = 0)
- Every time-dependent value must have period TAU in T (or 1 in u_phase): sin(k*T + c), cos(k*T + c), rot(k*T + c), palette(x + k*u_phase), fract(x + k*u_phase), mod(x + k*u_phase, 1.0), with k a whole number (negative is fine, 0 is static).
- Never T * 0.5, T / 3.0, u_phase * 1.5, or T or u_phase used linearly outside sin, cos, rot, fract, mod or palette.
- Rotating a fold(p, n) by T / n is allowed: one sector per loop looks identical.
- Scrolling: move by whole cells per loop inside fract or mod, like fract(p.y * 4.0 + 2.0 * u_phase).
- Noise and hashes are NOT periodic, so a coordinate that scrolls with u_phase or T must never go into noise() or a hash, even inside a loop: the frames at the start and end of the loop would show different noise. Noise may use space only, or travel around a circle in time: noise(p + 0.6 * vec2(cos(T), sin(T))). To scroll noise (fire, smoke, a tunnel), use two such circle samples, or fract() the scroll and crossfade two noise samples offset by one period: mix(noise(p + vec2(0.0, f)), noise(p + vec2(0.0, f - 1.0)), f) with f = fract(k * u_phase).
- The loop must visibly move: something should change between T = 0 and T = TAU / 4.

GLSL ES 1.0 RULES (WebGL 1 rejects anything else)
- Float literals need a decimal point: 1.0, not 1. No implicit int to float conversion; write float(i).
- Loops need constant bounds: for (float i = 0.0; i < 8.0; i++) { if (i >= u_comp) break; ... }. No while loops.
- No % operator (use mod), no bitwise operators, no arrays indexed by variables, no textures, no recursion, no switch, no derivatives (dFdx), no round(), no inverse(), no float literals with an f suffix.
- Declare every function before use. Use atan(y, x) for angles. Guard divisions (max(d, 0.001)).

PERFORMANCE (scene() runs three times per pixel on canvases up to 640 pixels across, in a browser, possibly on a phone)
- About 150 loop iterations in total at most; nested loops at most 8 by 8; ray marching at most 48 steps; fractal or iterated function loops at most 12.
- No huge constants that blow up precision (sin of very large numbers flickers): keep arguments to sin and fract hashes modest.

STYLE
- Interpret the description as a 2D procedural motion graphic: glowing lines, signed-distance shapes, fields, particles, grids, kaleidoscopes, tunnels, fluids. For figurative subjects (an animal, a person, an object), draw a stylised neon line-art, silhouette or symbolic version from simple shapes; it should be recognisable at a glance if the prompt names a thing. Never draw text or letters.
- No hard edges: never switch a whole region on or off with an if or a bounding box (it leaves straight lines and dark rectangles in the picture). Blend every part into the background with smoothstep or soft falloffs, so the background stays continuous.
- No strobing (it can trigger seizures): the overall brightness must never flash or swap between light and dark more than three times a second. Pulse and glow smoothly instead.
- Make it feel finished: depth, layered motion, a clear focal point, rich colour. Use palette() for colour unless the description names specific colours, then mix those with palette() so the Color Palette slider still does something.

ALSO RETURN
- name: 2 or 3 words for the preset button.
- summary: one short sentence describing what you drew.`;

function userPrompt(input) {
    if (input.problem) {
        return `The person asked for: ${input.prompt || '(see the code)'}\n\nCurrent code:\n${input.previous}\n\nThe page rejected it: ${input.problem}\n\nFix that problem. Keep the look and idea the same unless the fix requires changing them. Return the full code.`;
    }
    if (input.change) {
        return `The person originally asked for: ${input.prompt || '(see the code)'}\n\nCurrent code:\n${input.previous}\n\nChange requested: ${input.change}\n\nApply the change and keep everything else. Return the full code.`;
    }
    return `Description: ${input.prompt}`;
}

// ---- Model call ----
const Scene = z.object({ name: z.string(), summary: z.string(), code: z.string() });

async function callClaude(env, user) {
    if (!env.ANTHROPIC_API_KEY) throw exposed('The generator is not set up yet (add ANTHROPIC_API_KEY).', 500);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
    const response = await client.beta.messages.parse({
        model: env.AI_MODEL || DEFAULT_MODEL,
        max_tokens: 16000,
        // If the model declines on policy grounds, the API retries on its default fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: env.SHADER_EFFORT || 'low', format: betaZodOutputFormat(Scene) },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') throw exposed('That request was declined. Try describing the loop differently.', 422);
    if (response.stop_reason === 'max_tokens' || !response.parsed_output) throw exposed('The loop came out too long. Try a simpler description.', 502);
    return response.parsed_output;
}

function exposed(message, status = 502) { const e = new Error(message); e.expose = true; e.status = status; return e; }
