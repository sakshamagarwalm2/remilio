/**
 * fetch_trims.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches 5 trims from the Rimello API, enriches each with model name + brand
 * name (via separate API calls), and writes the result to trims_data.json.
 *
 * Run: node fetch_trims.js
 *
 * Output file: trims_data.json  (ready to feed into scraper.js as CAR_LIST)
 *
 * pnpm packages required:
 *   pnpm add axios   (same as scraper.js — likely already installed)
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const BASE_URL     = 'https://api.dev.rimello.ai';
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20iLCJzdWIiOiI2OTRjZTExZDcwYjRmMTc5Y2E2NTJjN2IiLCJpYXQiOjE3NzMyMjE1NjEsImV4cCI6MTc3MzgyNjM2MX0.qhT30c9yXtfTXi58FFRrHOw5EwbmQGiLwA1ZVH67FPA';
const TRIMS_LIMIT  = 5;   // ← change this to fetch more trims later
const OUTPUT_FILE  = path.join(__dirname, 'trims_data.json');

// ── HELPERS ───────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

const authHeaders = {
    'accept':        'application/json',
    'Authorization': `Bearer ${ACCESS_TOKEN}`,
};

// Simple GET wrapper with clear error logging
async function apiGet(url, label) {
    try {
        const res = await axios.get(url, { headers: authHeaders, timeout: 15000 });
        return res.data;
    } catch (err) {
        const status = err.response?.status;
        const msg    = err.response?.data?.message || err.message;
        log(`  ❌ ${label} failed — HTTP ${status ?? 'N/A'}: ${msg}`);
        return null;
    }
}

// ── IN-MEMORY CACHE  (avoids duplicate model/brand calls) ─────────────────────
const modelCache = {};
const brandCache = {};

async function getModelName(modelId) {
    if (modelCache[modelId] !== undefined) return modelCache[modelId];
    const data = await apiGet(`${BASE_URL}/models/${modelId}`, `Model ${modelId}`);
    // Response shape: { name: "Punch", ... }
    const name = data?.name ?? null;
    modelCache[modelId] = name;
    return name;
}

async function getBrandName(brandId) {
    if (brandCache[brandId] !== undefined) return brandCache[brandId];
    const data = await apiGet(`${BASE_URL}/brands/${brandId}`, `Brand ${brandId}`);
    // Response shape: { name: "Tata", ... }  — may return 404 for some IDs
    const name = data?.name ?? null;
    brandCache[brandId] = name;
    return name;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
    log('═'.repeat(60));
    log(`🚗  Rimello trim fetcher  —  fetching ${TRIMS_LIMIT} trims`);
    log('═'.repeat(60));

    // ── Step 1: Fetch trims list ──────────────────────────────────────────────
    log('\n📡 Step 1: GET /trims');
    const trimsUrl = `${BASE_URL}/trims?page=1&limit=${TRIMS_LIMIT}&sortBy=_id&sortDir=asc`;
    const trimsRes = await apiGet(trimsUrl, 'Trims list');

    if (!trimsRes) {
        log('❌ Could not fetch trims. Check your token or network.');
        process.exit(1);
    }

    // Handle both { results: [...] } and flat array responses
    const trimsList = Array.isArray(trimsRes) ? trimsRes : (trimsRes.results ?? []);
    log(`✅ Received ${trimsList.length} trims  (total in DB: ${trimsRes.total ?? '?'})`);

    if (!trimsList.length) {
        log('⚠️  No trims returned — nothing to process.');
        process.exit(0);
    }

    // ── Step 2: Enrich each trim with model + brand names ─────────────────────
    log('\n📡 Step 2: Enriching trims with model + brand info...\n');

    const enriched = [];

    for (let i = 0; i < trimsList.length; i++) {
        const trim = trimsList[i];
        const trimName = trim.name ?? 'Unknown';
        const modelId  = trim.modelId ?? null;
        const brandId  = trim.brandId ?? null;

        log(`  [${i + 1}/${trimsList.length}] Trim: "${trimName}"  (modelId: ${modelId}, brandId: ${brandId})`);

        // ── Model name ────────────────────────────────────────────────────────
        let modelName = null;
        if (modelId) {
            modelName = await getModelName(modelId);
            log(`    ✅ Model: ${modelName ?? '⚠️  not found'}`);
        } else {
            log(`    ⚠️  No modelId on this trim`);
        }

        // ── Brand name ────────────────────────────────────────────────────────
        let brandName = null;
        if (brandId) {
            brandName = await getBrandName(brandId);
            log(`    ${brandName ? '✅' : '⚠️ '} Brand: ${brandName ?? 'not found (404 is common — brandId may belong to a nested resource)'}`);
        } else {
            log(`    ⚠️  No brandId on this trim`);
        }

        // ── Assemble output record ─────────────────────────────────────────────
        enriched.push({
            // ── IDs ──────────────────────────────────────────────────────────
            trimId:   trim._id,
            modelId:  modelId,
            brandId:  brandId,
            cwId:     trim.cwId ?? null,

            // ── Names ─────────────────────────────────────────────────────────
            trimName:  trimName,
            modelName: modelName,
            brandName: brandName,

            // ── Pricing & availability ────────────────────────────────────────
            exShowroom:   trim.price?.exShowroom ?? null,
            availability: trim.availability ?? null,
            status:       trim.status ?? null,

            // ── Colors ───────────────────────────────────────────────────────
            colors: (trim.colors ?? []).map(c => ({
                colorName: c.colorName,
                colorCode: c.colorCode,
                looksLike: c.looksLike ?? [],
            })),

            // ── Raw trim (full original) ───────────────────────────────────────
            _raw: trim,
        });
    }

    // ── Step 3: Write output JSON ─────────────────────────────────────────────
    log('\n📝 Step 3: Writing output...');

    const output = {
        fetchedAt:  new Date().toISOString(),
        totalFetched: enriched.length,
        note: 'Generated by fetch_trims.js — feed enriched[] into scraper CAR_LIST',

        // ── Car list format ready for scraper.js ──────────────────────────────
        // Each entry maps to { make, model, variant } expected by scraper.js
        carList: enriched.map(e => ({
            make:    e.brandName  ?? e.brandId  ?? 'Unknown',
            model:   e.modelName  ?? e.modelId  ?? 'Unknown',
            variant: e.trimName,
            // Extra IDs kept for reference
            _trimId:  e.trimId,
            _modelId: e.modelId,
            _brandId: e.brandId,
            _cwId:    e.cwId,
        })),

        // ── Full enriched records ─────────────────────────────────────────────
        enriched,
    };

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
    log(`✅ Saved → ${OUTPUT_FILE}`);

    // ── Step 4: Print summary table ───────────────────────────────────────────
    log('\n' + '═'.repeat(60));
    log('📊 SUMMARY');
    log('═'.repeat(60));
    log(`${'#'.padEnd(3)} ${'Brand'.padEnd(12)} ${'Model'.padEnd(12)} ${'Trim'.padEnd(30)} ${'Price (ex)'.padStart(12)}`);
    log('─'.repeat(72));
    enriched.forEach((e, i) => {
        const brand = (e.brandName ?? '—').padEnd(12);
        const model = (e.modelName ?? '—').padEnd(12);
        const trim  = (e.trimName  ?? '—').padEnd(30);
        const price = e.exShowroom ? `₹${(e.exShowroom / 100000).toFixed(2)}L` : '—';
        log(`${String(i + 1).padEnd(3)} ${brand} ${model} ${trim} ${price.padStart(12)}`);
    });
    log('═'.repeat(60));
    log(`\n🏁 Done! Output: ${OUTPUT_FILE}`);
    log(`   To use in scraper, replace CAR_LIST with output.carList from trims_data.json\n`);
})();