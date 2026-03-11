/**
 * ai_config.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Central config for Google Generative AI (Gemini) + Zod-validated parsing.
 */

const { z } = require('zod');
const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ── Models ────────────────────────────────────────────────────────────────────
// Using Gemini 2.5 Flash as the default fast/cheap categorizer
const ACTIVE_MODEL = 'gemini-2.5-flash';

// ── Valid Categories ──────────────────────────────────────────────────────────
const VALID_CATEGORIES = [
    'OwnershipReview',
    'Feedback',
    'Query',
    'Comparison',
    'Issue/Problem',
    'GeneralDiscussion',
];

// ── Zod Schemas ───────────────────────────────────────────────────────────────
const CategoryEnum = z.enum(VALID_CATEGORIES);

const SinglePostResultSchema = z.object({
    category: CategoryEnum,
});

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert automotive forum post classifier.

For each numbered post provided, assign exactly ONE category from this list:
  OwnershipReview   — owner sharing personal experience, km driven, service history, long-term usage
  Feedback          — opinions/observations on ride quality, features, comfort, design, NVH, performance  
  Query             — asking a question, seeking advice, recommendation, or clarification
  Comparison        — comparing two or more cars, variants, or brands side-by-side
  Issue/Problem     — reporting a defect, breakdown, warning light, noise, vibration, repair, recall
  GeneralDiscussion — none of the above; casual chat, news, announcements

PRIORITY RULES:
  • Issue/Problem beats Feedback when both apply
  • Query beats GeneralDiscussion when the post contains a question

OUTPUT FORMAT — respond with ONLY valid JSON, no markdown, no explanation:
{ "category": "<CategoryLabel>" }

The "category" value MUST be one of the exact strings listed above.
Do NOT include any text outside the JSON object.`;

// ── Batch settings ────────────────────────────────────────────────────────────
const AI_CONFIG = {
    temperature: 0.0, // deterministic
    maxRetries: 3,
    delayBetweenPostsMs: 1500,
    rateLimitDelayMs: 5000,
    validCategories: VALID_CATEGORIES,
};

// ── Zod parse helpers ─────────────────────────────────────────────────────────

function stripCodeFences(text) {
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function parseSingleResponse(raw) {
    try {
        const cleaned = stripCodeFences(raw);
        const json = JSON.parse(cleaned);
        const parsed = SinglePostResultSchema.parse(json);
        return { ok: true, category: parsed.category };
    } catch (err) {
        const msg = err?.errors
            ? err.errors.map(e => `[${e.path.join('.')}] ${e.message}`).join(' | ')
            : err.message;
        return { ok: false, error: msg };
    }
}

module.exports = {
    ai,
    ACTIVE_MODEL,
    SYSTEM_PROMPT,
    AI_CONFIG,
    parseSingleResponse,
};