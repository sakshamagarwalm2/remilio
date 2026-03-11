/**
 * ai_worker.js
 * 
 * Runs in parallel to the scraper. Continuously reads the global mongo JSON file,
 * looks for posts with category: "pending_ai", scores them via Google Gemini API, and
 * safely writes them back.
 * 
 * Run with: node ai_worker.js
 */

const fs = require('fs');
const path = require('path');

const {
    ai,
    ACTIVE_MODEL,
    SYSTEM_PROMPT,
    AI_CONFIG,
    parseSingleResponse,
} = require('./ai_config');

// Require trim mapping optionally if trims_data exists to enrich logging
const TRIMS_DATA_FILE = path.join(__dirname, 'trims_data.json');
let trimList = [];
if (fs.existsSync(TRIMS_DATA_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(TRIMS_DATA_FILE, 'utf-8'));
        trimList = data.carList || [];
    } catch (e) {
        // quiet
    }
}

const OUTPUT_DIR = path.join(__dirname, 'scraped_data');
const GLOBAL_MONGO_FILE = path.join(OUTPUT_DIR, 'all_mongo.json');

const DELAY = ms => new Promise(r => setTimeout(r, ms));
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

function buildSinglePrompt(description) {
    const snippet = (description || '').substring(0, 800).replace(/\s+/g, ' ').trim();
    return `Post:\n\"\"\"\n${snippet}\n\"\"\"\n\nRespond with ONLY the JSON object as described in your instructions.`;
}

async function classifyOneWithAI(description) {
    const userPrompt = buildSinglePrompt(description);

    for (let attempt = 1; attempt <= AI_CONFIG.maxRetries; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: ACTIVE_MODEL,
                contents: userPrompt,
                config: {
                    systemInstruction: SYSTEM_PROMPT,
                    temperature: AI_CONFIG.temperature,
                    responseMimeType: "application/json",
                }
            });

            const result = parseSingleResponse(response.text);

            if (result.ok) {
                return result.category;
            }

            log(`    ⚠️  Zod FAILED: ${result.error} | raw: "${response.text.substring(0, 80)}"`);

        } catch (err) {
            const status = err.status || (err.response && err.response.status);
            const msg = err.message;

            if (status === 429) {
                log(`    ⏳ Rate limited (429) — waiting ${AI_CONFIG.rateLimitDelayMs / 1000}s then retrying`);
                await DELAY(AI_CONFIG.rateLimitDelayMs);
                continue;
            }

            log(`    ⚠️  Attempt ${attempt}: ${msg}`);
            if (attempt < AI_CONFIG.maxRetries) {
                await DELAY(1000 * attempt);
            }
        }
    }
    
    log(`    ❌ All attempts errored.`);
    return null;
}

// Safely update the category of a specific post without overwriting new appends from teambhpv2.js
function safeWriteCategory(reviewId, newCategory) {
    if (!fs.existsSync(GLOBAL_MONGO_FILE)) return false;
    
    try {
        // Re-read file to get the absolute latest state
        const rawData = fs.readFileSync(GLOBAL_MONGO_FILE, 'utf-8');
        const docs = JSON.parse(rawData);
        
        let found = false;
        for (let i = 0; i < docs.length; i++) {
            if (docs[i]._id?.$oid === reviewId) {
                docs[i].category = newCategory;
                // also update status to something other than pending if desired, e.g. status = 'categorized'
                found = true;
                break;
            }
        }
        
        if (found) {
            fs.writeFileSync(GLOBAL_MONGO_FILE, JSON.stringify(docs, null, 2), 'utf-8');
            return true;
        }
    } catch (e) {
        log(`    ❌ Failed to safely write to ${GLOBAL_MONGO_FILE}: ${e.message}`);
    }
    return false;
}

// Helper to look up human readable trim name from a mongo document
// The scraper generates the schema IDs like: crypto hash of `model_${make}_${model}`
function identifyTrim(doc) {
    // Try to guess from the thread title or meta if exact IDs are hard to match
    const title = doc.title || '';
    const brandFallback = (doc._meta?.threadUrl || '').split('/').pop();
    
    // Fall back to title lookup against our trims list
    for (const car of trimList) {
        const slug = `${car.make} ${car.model} ${car.variant}`.toLowerCase();
        if (title.toLowerCase().includes(car.model.toLowerCase()) || brandFallback.toLowerCase().includes(car.model.toLowerCase())) {
            return slug;
        }
    }
    
    return title.length > 30 ? title.substring(0, 30) + '...' : title;
}

// The main loop that monitors the file and categorizes items
async function main() {
    log('🤖 Gemini AI Worker loop started. Looking for "pending_ai" posts in all_mongo.json...');
    
    if (!process.env.GEMINI_API_KEY && ai.apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
        log('❌ GEMINI_API_KEY environment variable not set. Please set it before running this worker.');
        process.exit(1);
    }

    while (true) {
        if (!fs.existsSync(GLOBAL_MONGO_FILE)) {
            await DELAY(5000);
            continue;
        }

        let docs;
        try {
            const rawData = fs.readFileSync(GLOBAL_MONGO_FILE, 'utf-8');
            docs = JSON.parse(rawData);
        } catch (e) {
            log(`⚠️ Could not parse JSON, will try again. (${e.message})`);
            await DELAY(5000);
            continue;
        }

        // Find the first post that needs categorization
        const pendingDoc = docs.find(d => d.category === 'pending_ai');

        if (!pendingDoc) {
            // Queue is empty, wait a bit before checking again
            await DELAY(3000);
            continue;
        }

        const reviewId = pendingDoc._id?.$oid;
        const carName = identifyTrim(pendingDoc);

        log(`\n🚗  Trim context: ${carName}`);
        log(`🏷️  Scoring post ID: ${reviewId} ...`);
        
        const category = await classifyOneWithAI(pendingDoc.description);
        
        const finalCategory = category || 'GeneralDiscussion';
        
        if (category) {
            log(`    ✅ Result: ${finalCategory}`);
        } else {
            log(`    ❌ [AI FAILED] Defaulting to: ${finalCategory}`);
        }

        // Safely update the file
        const saved = safeWriteCategory(reviewId, finalCategory);
        if (!saved) {
            log(`    ⚠️ Could not update JSON for post ${reviewId}. Maybe it was deleted?`);
        }

        // Delay between API calls to avoid rate limits
        await DELAY(AI_CONFIG.delayBetweenPostsMs || 1500);
    }
}

main().catch(err => {
    console.error('Fatal AI worker error:', err);
});
