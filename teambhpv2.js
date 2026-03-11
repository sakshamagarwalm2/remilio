const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ──────────────────────────────────────────────
// CAR LIST — add/remove entries as needed
// ──────────────────────────────────────────────
const CAR_LIST = [
    { make: 'BMW',      model: 'X3',     variant: '30i' },
    { make: 'Honda',    model: 'City',   variant: 'ZX CVT' },
    { make: 'Hyundai',  model: 'Creta',  variant: 'SX Turbo' },
    { make: 'Tata',     model: 'Nexon',  variant: 'EV Max' },
    { make: 'Maruti',   model: 'Swift',  variant: 'ZXi Plus' },
    { make: 'Toyota',   model: 'Innova', variant: 'Crysta GX' },
];

// ──────────────────────────────────────────────
// TIMING CONFIG
// ──────────────────────────────────────────────
const DELAY_AFTER_SEARCH_LOAD     = 3000;
const DELAY_AFTER_REVIEWS_CLICK   = 6000;
const DELAY_AFTER_PAGE_CLICK      = 5000;
const DELAY_BETWEEN_THREADS       = 3000;
const DELAY_BETWEEN_THREAD_PAGES  = 2000;
const DELAY_BETWEEN_CARS          = 5000;

// ──────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────
const OUTPUT_DIR = path.join(__dirname, 'scraped_data');

// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// CATEGORIZATION — Rule-Based Classifier (no AI needed)
//
// Strategy: weighted keyword scoring per category.
// Each rule set fires on the lowercased post text.
// The category with the highest total score wins.
// Tie-breaks fall through in priority order:
//   Issue/Problem > Query > OwnershipReview >
//   Comparison > Feedback > GeneralDiscussion
// ──────────────────────────────────────────────

const CATEGORIES = [
    'OwnershipReview',   // Long-term personal ownership experience
    'Feedback',          // Opinion on specific features / driving feel
    'Query',             // Questions asked by users
    'Comparison',        // Comparing two or more cars
    'Issue/Problem',     // Faults, defects, reliability complaints
    'GeneralDiscussion', // Anything that doesn't fit above
];

// ── Classifier rules ──────────────────────────────────────────────────────────
// Each entry: { pattern: RegExp, score: number, category: string }
// Patterns are tested against the full lowercased post.
// Higher score = stronger signal.
// ─────────────────────────────────────────────────────────────────────────────
const CLASSIFIER_RULES = [

    // ── Issue / Problem ───────────────────────────────────────────────────────
    // Hard defects, service visits, breakdowns — highest priority
    { pattern: /\b(broke down|breakdown|stall(?:ed|ing|s)?|won't start|doesn'?t start|dead battery|engine fail)\b/, score: 9, category: 'Issue/Problem' },
    { pattern: /\b(vibrat(?:ion|ing|es?)|rattl(?:e|ing|ed)|clunk|squeak(?:ing|ed)?|noise from|knocking|grinding)\b/, score: 7, category: 'Issue/Problem' },
    { pattern: /\b(problem|issue|fault|defect|complaint|warranty claim|service center complaint)\b/, score: 6, category: 'Issue/Problem' },
    { pattern: /\b(recall|tsb|technical service bulletin)\b/, score: 8, category: 'Issue/Problem' },
    { pattern: /\b(oil leak|coolant leak|transmission problem|gear(?:box)? issue|brake fail|abs fault|airbag warning)\b/, score: 8, category: 'Issue/Problem' },
    { pattern: /\b(check engine|warning light|malfunction indicator|mil light)\b/, score: 9, category: 'Issue/Problem' },
    { pattern: /\b(rust|corrosion|paint peel|body panel gap)\b/, score: 5, category: 'Issue/Problem' },
    { pattern: /\b(went to (the )?service|service visit|took it to (the )?service|service center|service station)\b.*\b(complain|issue|problem|fix|repair)\b/, score: 7, category: 'Issue/Problem' },
    { pattern: /\b(repair(?:ed|ing)?|replaced the|had to replace|mechanic|workshop)\b/, score: 4, category: 'Issue/Problem' },
    { pattern: /\b(don'?t buy|avoid this car|worst car|terrible quality|pathetic (service|quality|build))\b/, score: 6, category: 'Issue/Problem' },
    { pattern: /\b(nightmare|lemon|shocking quality|appalled|disgusted)\b/, score: 5, category: 'Issue/Problem' },

    // ── Query ─────────────────────────────────────────────────────────────────
    // Questions — strong signal from sentence-ending ? or explicit question words
    { pattern: /\?{1,}/, score: 5, category: 'Query' },                          // any question mark
    { pattern: /\?{2,}/, score: 3, category: 'Query' },                          // multiple ??
    { pattern: /\b(anyone know|does anyone|can anyone|has anyone|has somebody)\b/, score: 7, category: 'Query' },
    { pattern: /\b(please (advise|help|suggest|guide|clarify|confirm))\b/, score: 7, category: 'Query' },
    { pattern: /\b(what is|what are|what's|what was|what would)\b/, score: 4, category: 'Query' },
    { pattern: /\b(how (do|does|can|should|much|many|long|often))\b/, score: 5, category: 'Query' },
    { pattern: /\b(which (is|are|one|model|variant|car|option))\b/, score: 5, category: 'Query' },
    { pattern: /\b(is it|is there|are there|should i|would you|could you)\b/, score: 3, category: 'Query' },
    { pattern: /\b(looking (for|to buy)|planning to buy|want to buy|thinking of buying)\b/, score: 4, category: 'Query' },
    { pattern: /\b(need (advice|help|suggestions?|guidance|recommendations?))\b/, score: 6, category: 'Query' },
    { pattern: /\b(kindly (advise|help|confirm|share|let me know))\b/, score: 6, category: 'Query' },
    { pattern: /\b(let me know|please let|please share|please confirm)\b/, score: 4, category: 'Query' },

    // ── Ownership Review ──────────────────────────────────────────────────────
    // Long-term personal narratives with km/time milestones
    { pattern: /\b\d{3,6}\s*(km|kms|kilometers?|kilometres?)\b/, score: 7, category: 'OwnershipReview' },  // "12000 km"
    { pattern: /\b(my ownership (review|experience|report|story|update)|ownership review|long[- ]term ownership)\b/, score: 10, category: 'OwnershipReview' },
    { pattern: /\b(i (have|had|own|owned|bought|purchased|got|drove|drive|been driving))\b.*\b(months?|years?|km|kms)\b/, score: 7, category: 'OwnershipReview' },
    { pattern: /\b(my (car|vehicle|ride))\b.*\b(\d+\s*(km|months?|years?))\b/, score: 6, category: 'OwnershipReview' },
    { pattern: /\b(long[- ]term)\b.*\b(review|experience|report|ownership)\b/, score: 9, category: 'OwnershipReview' },
    { pattern: /\b(first (service|free service|paid service|scheduled service))\b/, score: 5, category: 'OwnershipReview' },
    { pattern: /\b(fuel (efficiency|economy|consumption|mileage))\b.*\b(\d+(\.\d+)?\s*(kmpl|km\/l|l\/100|mpg))\b/, score: 6, category: 'OwnershipReview' },
    { pattern: /\b(after\s+\d+\s*(km|months?|years?))\b/, score: 6, category: 'OwnershipReview' },
    { pattern: /\b(clocked|covered|done\s+\d+)\b/, score: 5, category: 'OwnershipReview' },
    { pattern: /\b(took delivery|delivery done|delivery report|delivery review)\b/, score: 5, category: 'OwnershipReview' },
    { pattern: /\b(overall (rating|score|verdict|impression))\b.*\b(\d+\s*(\/|out of)\s*10)\b/, score: 6, category: 'OwnershipReview' },
    { pattern: /\b(pros?\s+(and|&|vs\.?)\s*cons?)\b/i, score: 6, category: 'OwnershipReview' },
    { pattern: /\b(buying (experience|process|story))\b/, score: 5, category: 'OwnershipReview' },

    // ── Comparison ────────────────────────────────────────────────────────────
    // Two or more named cars / brands being contrasted
    { pattern: /\b(vs\.?|versus|compared? (to|with)|comparison)\b/, score: 7, category: 'Comparison' },
    { pattern: /\bshortlisted?\b.*\b(between|and|or)\b/, score: 8, category: 'Comparison' },
    { pattern: /\bbetween\b.*\band\b.*\b(car|suv|sedan|hatchback|mpv|ev|option)\b/, score: 6, category: 'Comparison' },
    { pattern: /\b(better than|worse than|prefer(red|ring)? .{0,20} over|chose .{0,20} over)\b/, score: 6, category: 'Comparison' },
    { pattern: /\b(both (cars?|vehicles?|options?)|either (car|option)|the other (car|option|model))\b/, score: 5, category: 'Comparison' },
    // Named rival brands appearing together → strong comparison signal
    { pattern: /\b(hyundai|kia|maruti|suzuki|honda|toyota|tata|mahindra|volkswagen|skoda|mg|jeep|ford|renault|nissan|bmw|mercedes|audi|volvo)\b.*\b(hyundai|kia|maruti|suzuki|honda|toyota|tata|mahindra|volkswagen|skoda|mg|jeep|ford|renault|nissan|bmw|mercedes|audi|volvo)\b/, score: 6, category: 'Comparison' },

    // ── Feedback ──────────────────────────────────────────────────────────────
    // Specific feature opinions without km milestones
    { pattern: /\b(build quality|fit (and|&) finish|panel gap|NVH|cabin noise|road noise|wind noise)\b/, score: 6, category: 'Feedback' },
    { pattern: /\b(suspension|ride quality|handling|steering feel|feedback|cornering|body roll)\b/, score: 5, category: 'Feedback' },
    { pattern: /\b(infotainment|touchscreen|adas|lane keep|blind spot|cruise control|sunroof|panoramic)\b/, score: 5, category: 'Feedback' },
    { pattern: /\b(seat comfort|legroom|headroom|boot space|cargo|practicality|ergonomic)\b/, score: 5, category: 'Feedback' },
    { pattern: /\b(turbo|torque|power|acceleration|0 to 100|top speed|engine performance)\b/, score: 4, category: 'Feedback' },
    { pattern: /\b(looks|design|styling|exterior|interior|colour|color|aesthetics)\b.*\b(love|like|hate|dislike|impressed|disappoint)\b/, score: 5, category: 'Feedback' },
    { pattern: /\b(i (love|like|hate|dislike|prefer|enjoy|found|feel|think|noticed|observed))\b.*\b(feature|option|variant|part|system|mode)\b/, score: 4, category: 'Feedback' },
    { pattern: /\b(good|great|excellent|superb|amazing|bad|poor|average|decent|mediocre)\b.*\b(ride|mileage|space|quality|engine|performance|comfort|build)\b/, score: 4, category: 'Feedback' },

];

// ── Structural signals (applied after keyword scoring) ───────────────────────
// Long posts (>500 chars) with first-person "I have/had" boost OwnershipReview.
// Short posts (<120 chars) with a "?" boost Query strongly.

/**
 * Pure rule-based post classifier. Zero network calls, runs synchronously.
 * Returns one of the CATEGORIES strings.
 */
function categorizePost(postContent) {
    const text = postContent.toLowerCase().replace(/\s+/g, ' ').trim();

    // Accumulate scores per category
    const scores = {
        'OwnershipReview':   0,
        'Feedback':          0,
        'Query':             0,
        'Comparison':        0,
        'Issue/Problem':     0,
        'GeneralDiscussion': 0,
    };

    for (const rule of CLASSIFIER_RULES) {
        if (rule.pattern.test(text)) {
            scores[rule.category] += rule.score;
        }
    }

    // ── Structural boosts ─────────────────────────────────────────────────────
    const charCount    = text.length;
    const questionCount = (text.match(/\?/g) || []).length;
    const hasFirstPerson = /\b(i have|i had|i own|i owned|i bought|i drove|my car|my vehicle)\b/.test(text);
    const hasKmMention   = /\b\d{3,6}\s*(km|kms|kilometers?)\b/.test(text);

    // Very short post with question mark → likely a query
    if (charCount < 150 && questionCount >= 1) scores['Query'] += 5;

    // Long first-person post mentioning km → strong ownership signal
    if (charCount > 400 && hasFirstPerson && hasKmMention) scores['OwnershipReview'] += 6;

    // Long post (review-length) with first-person but no question → ownership or feedback
    if (charCount > 600 && hasFirstPerson && questionCount === 0) scores['OwnershipReview'] += 3;

    // Purely short with no other signals → general discussion
    if (charCount < 80 && questionCount === 0) scores['GeneralDiscussion'] += 3;

    // ── Pick winner with tie-break priority ───────────────────────────────────
    // Priority (highest → lowest) if scores tie:
    const PRIORITY = ['Issue/Problem', 'Query', 'OwnershipReview', 'Comparison', 'Feedback', 'GeneralDiscussion'];

    let bestCat   = 'GeneralDiscussion';
    let bestScore = 0;

    for (const cat of PRIORITY) {
        if (scores[cat] > bestScore) {
            bestScore = scores[cat];
            bestCat   = cat;
        }
        // Strict ">" means first in priority order wins ties automatically
    }

    return bestCat;
}

/**
 * Classify an array of posts synchronously.
 * Returns an array of category strings in the same order as input.
 * No async needed — rule engine is pure CPU.
 */
function categorizePosts(posts) {
    return posts.map(p => categorizePost(p.content));
}

// ──────────────────────────────────────────────
// RESUME / PROGRESS TRACKING
// progress.json tracks which car index we are on
// so if the script crashes, re-running resumes from there
// ──────────────────────────────────────────────
const PROGRESS_FILE = path.join(OUTPUT_DIR, 'progress.json');

function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    return { lastCompletedCarIndex: -1 };  // -1 means nothing done yet
}

function saveProgress(carIndex) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastCompletedCarIndex: carIndex }, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
const DELAY = ms => new Promise(r => setTimeout(r, ms));
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

/**
 * Normalize a thread URL so all paginated variants map to the same root key.
 *
 * Team-BHP paginated threads look like:
 *   …/some-thread.html        ← page 1  (no suffix)
 *   …/some-thread-2.html      ← page 2
 *   …/some-thread-3.html      ← page 3
 *
 * We strip the trailing -N so every page of the same thread deduplicates to
 * base-slug.html. The scraper follows "next page" links itself inside
 * scrapeThread(), so we only ever queue the root (page-1) URL.
 */
function normalizeThreadUrl(href) {
    // Drop fragment anchor first
    const noFragment = href.split('#')[0];
    // Strip -<digits>.html → .html  (only when digits immediately precede .html)
    return noFragment.replace(/-\d+\.html$/, '.html');
}

/** Generate a deterministic Mongo-style ObjectId-like hex string from a string */
function makeObjectId(seed) {
    const hash = crypto.createHash('md5').update(seed).digest('hex');
    return hash.substring(0, 24); // 24 hex chars like ObjectId
}

/** Convert a post into the target MongoDB document shape */
function toMongoDoc({ post, threadUrl, brandSlug, modelSlug, category }) {
    const brandOid  = makeObjectId(`brand_${brandSlug}`);
    const modelOid  = makeObjectId(`model_${modelSlug}`);
    const reviewOid = makeObjectId(`${threadUrl}_${post.postNumber}_${post.author.name}`);
    const cwReviewId = Math.abs(parseInt(crypto.createHash('md5').update(reviewOid).digest('hex').substring(0, 8), 16));

    // Try to parse overall rating from content (heuristic — 0 if not found)
    const ratingMatch = post.content.match(/(\d)\s*\/\s*10|\brat(?:ing|ed)[^\d]*(\d)/i);
    const overallRating = ratingMatch ? parseInt(ratingMatch[1] || ratingMatch[2]) : 0;

    return {
        _id:          { $oid: reviewOid },
        cwReviewId,
        __v:          0,
        brandId:      { $oid: brandOid },
        createdAt:    { $date: new Date().toISOString() },
        customerInfo: {
            userName:     post.author.name     || '',
            userEmail:    '',                          // not available on forum
            userlocation: post.author.location || '',
        },
        description:    post.content,
        downvotes:      0,
        entryDate:      post.postDate || '',
        modelId:        { $oid: modelOid },
        overallRating,
        ratingParams: {
            designAndStyling:            0,
            comfortAndSpace:             0,
            performance:                 0,
            valueForMoney:               0,
            featuresAndTechnology:       0,
            afterSalesCostAndExperience: 0,
        },
        title:              threadUrl.split('/').pop().replace('.html', '').replace(/-/g, ' '),
        updatedAt:          { $date: new Date().toISOString() },
        upvotes:            0,
        userUploadedImages: [],
        status:             'pending',
        category:           category || 'GeneralDiscussion',   // ← AI-assigned category
        // Extra metadata (not in schema but useful for traceability)
        _meta: {
            threadUrl,
            postNumber:   post.postNumber,
            authorRank:   post.author.rank,
            authorPosts:  post.author.postsCount,
            authorJoined: post.author.joinDate,
            source:       'team-bhp',
        },
    };
}

// ──────────────────────────────────────────────
// GSC WAIT HELPERS
// ──────────────────────────────────────────────
async function waitForGSCResults(page, timeoutMs = 10000) {
    try {
        await page.waitForFunction(
            () => document.querySelectorAll('.gsc-result, .gs-result').length > 0,
            { timeout: timeoutMs }
        );
        return true;
    } catch (_) { return false; }
}

async function waitForGSCPage(page, pageNum, timeoutMs = 10000) {
    try {
        await page.waitForFunction(
            (num) => {
                const active = document.querySelector('.gsc-cursor-current-page');
                return active && active.textContent.trim() === String(num);
            },
            { timeout: timeoutMs },
            pageNum
        );
        await new Promise(r => setTimeout(r, 1500));
        return true;
    } catch (_) { return false; }
}

// ──────────────────────────────────────────────
// Grab links — only official-new-car-reviews URLs
// ──────────────────────────────────────────────
async function grabCurrentPageLinks(page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('a.gs-title, .gsc-webResult a[href], .gs-result a[href]'))
            .map(a => a.href || '')
            .filter(h =>
                h.includes('team-bhp.com/forum') &&
                h.includes('.html') &&
                !h.includes('/member') &&
                !h.includes('/search.php') &&
                !h.includes('/galleryV2')
            )
    );
}

// ──────────────────────────────────────────────
// STEP 1 — Collect thread URLs
// ──────────────────────────────────────────────
async function collectReviewLinks(page, query) {
    log(`\n🔍 Searching for: "${query}"`);

    const searchUrl =
        'https://www.team-bhp.com/search.php' +
        '?cx=partner-pub-8422315737402856%3Azcmboq-gw8i' +
        '&cof=FORID%3A9&ie=ISO-8859-1&sa=&q=' + encodeURIComponent(query);

    log(`URL: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log(`Waiting ${DELAY_AFTER_SEARCH_LOAD / 1000}s for page to settle...`);
    await DELAY(DELAY_AFTER_SEARCH_LOAD);

    log('Clicking "Reviews" tab...');
    const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('a, div, span, li, td'))
            .find(e => e.innerText && e.innerText.trim() === 'Reviews');
        if (el) { el.click(); return true; }
        return false;
    });

    if (clicked) {
        log(`✔ Reviews tab clicked! Waiting ${DELAY_AFTER_REVIEWS_CLICK / 1000}s...`);
        await DELAY(DELAY_AFTER_REVIEWS_CLICK);
        const loaded = await waitForGSCResults(page, 8000);
        log(loaded ? '✔ GSC results visible' : '⚠️  GSC results may not be fully loaded');
    } else {
        log('⚠️  Reviews tab not found — using current results');
        await DELAY(3000);
    }

    const totalPages = await page.evaluate(() =>
        document.querySelectorAll('.gsc-cursor-page').length
    );
    log(`Found ${totalPages} search result pages`);

    const seenRoots = new Set();

    log(`\nScraping page 1 / ${totalPages}...`);
    (await grabCurrentPageLinks(page)).forEach(h => seenRoots.add(normalizeThreadUrl(h)));
    log(`  ${seenRoots.size} unique official-review links so far`);

    for (let p = 2; p <= totalPages; p++) {
        log(`\nClicking page ${p} / ${totalPages}...`);
        const didClick = await page.evaluate((num) => {
            const btn = Array.from(document.querySelectorAll('.gsc-cursor-page'))
                .find(el => el.textContent.trim() === String(num));
            if (btn) { btn.click(); return true; }
            return false;
        }, p);

        if (!didClick) { log(`  ⚠️  Page ${p} button not found — stopping`); break; }

        const loaded = await waitForGSCPage(page, p, 10000);
        if (!loaded) { log(`  ⚠️  Page ${p} did not confirm load`); await DELAY(DELAY_AFTER_PAGE_CLICK); }

        let newCount = 0;
        (await grabCurrentPageLinks(page)).forEach(h => {
            const root = normalizeThreadUrl(h);
            if (!seenRoots.has(root)) { seenRoots.add(root); newCount++; }
        });
        log(`  ✔ Page ${p} | +${newCount} new | ${seenRoots.size} total`);
    }

    const unique = [...seenRoots];
    log(`\n📋 ${unique.length} unique official-review threads found`);
    unique.forEach((u, i) => log(`   ${i + 1}. ${u}`));
    return unique;
}

// ──────────────────────────────────────────────
// STEP 2 — Scrape posts from a thread
// ──────────────────────────────────────────────
async function scrapeThreadPage(page) {
    return page.evaluate(() => {
        const posts = document.querySelectorAll('table[id^="post"]');
        const results = [];
        posts.forEach(post => {
            const userMenu  = post.querySelector('div[id^="postmenu_"]');
            const userName  = userMenu ? userMenu.innerText.trim() : 'Unknown';

            const cell = post.querySelector('td.alt2');
            let userRank = '', joinDate = '', location = '', postsCount = '';
            if (cell) {
                const divs = cell.querySelectorAll('div.smallfont');
                if (divs.length > 0) userRank = divs[0].innerText.trim();
                const text = cell.innerText;
                const m1 = text.match(/Join Date:\s*(.*)/);
                const m2 = text.match(/Location:\s*(.*)/);
                const m3 = text.match(/Posts:\s*(.*)/);
                if (m1) joinDate  = m1[1].trim();
                if (m2) location  = m2[1].trim();
                if (m3) postsCount = m3[1].trim();
            }

            const dateEl = post.querySelector('td.thead');
            let postDate = '', postNumber = '';
            if (dateEl) {
                const parts = dateEl.innerText.trim().split('#');
                postDate   = parts[0].trim();
                postNumber = parts[1] ? '#' + parts[1].trim() : '';
            }

            const msgEl  = post.querySelector('div[id^="post_message_"]');
            const content = msgEl ? msgEl.innerText.trim() : '';

            results.push({
                postNumber, postDate,
                author: { name: userName, rank: userRank, joinDate, location, postsCount },
                content
            });
        });
        return results;
    });
}

async function scrapeThread(page, threadUrl) {
    log(`  Opening: ${threadUrl}`);
    let currentUrl = threadUrl;
    let allPosts   = [];
    let pageNum    = 1;
    const pageUrls = [];

    while (currentUrl) {
        log(`    → Page ${pageNum}: ${currentUrl}`);
        pageUrls.push(currentUrl);
        try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForSelector('table[id^="post"]', { timeout: 15000 });
        } catch (e) {
            log(`    ⚠️  Could not load — skipping. (${e.message})`);
            break;
        }
        const posts = await scrapeThreadPage(page);
        log(`    ✔ ${posts.length} posts`);
        allPosts = allPosts.concat(posts);

        currentUrl = await page.evaluate(() => {
            const next = Array.from(document.querySelectorAll('a'))
                .find(a => a.innerText.trim() === '>');
            return next ? next.href : null;
        });
        if (currentUrl) { pageNum++; await DELAY(DELAY_BETWEEN_THREAD_PAGES); }
    }

    log(`  ✅ Done — ${pageNum} pages, ${allPosts.length} posts`);
    return { posts: allPosts, pagesVisited: pageNum, pageUrls };
}

// ──────────────────────────────────────────────
// PROCESS ONE CAR
// ──────────────────────────────────────────────
async function processCar(page, carEntry, carIndex) {
    const { make, model, variant } = carEntry;
    const query    = `${make} ${model} ${variant}`;
    const slug     = query.replace(/\s+/g, '_').toLowerCase();
    const brandSlug = make.toLowerCase();
    const modelSlug = `${make}_${model}`.toLowerCase().replace(/\s+/g, '_');

    log(`\n${'═'.repeat(60)}`);
    log(`🚗  CAR ${carIndex + 1} / ${CAR_LIST.length}:  ${query}`);
    log(`${'═'.repeat(60)}`);

    const reviewsFile = path.join(OUTPUT_DIR, `${slug}_reviews.json`);
    const queueFile   = path.join(OUTPUT_DIR, `${slug}_queue.json`);
    const mongoFile   = path.join(OUTPUT_DIR, `${slug}_mongo.json`);

    // ── Step 1: collect URLs ──────────────────────────────────
    const reviewLinks = await collectReviewLinks(page, query);
    if (!reviewLinks.length) {
        log('❌ No official-review links found for this car — skipping.');
        return;
    }

    // Build / load queue (supports resume within a car too)
    let queueData;
    if (fs.existsSync(queueFile)) {
        queueData = JSON.parse(fs.readFileSync(queueFile, 'utf-8'));
        log(`📋 Existing queue loaded (${queueData.threads.length} threads)`);
    } else {
        queueData = {
            query, scrapedAt: new Date().toISOString(),
            totalThreads: reviewLinks.length,
            threads: reviewLinks.map((url, i) => ({
                index: i + 1, threadUrl: url,
                status: 'pending', pagesVisited: 0, pageUrls: [], postsScraped: 0
            }))
        };
        fs.writeFileSync(queueFile, JSON.stringify(queueData, null, 2), 'utf-8');
        log(`📁 Queue saved → ${queueFile}`);
    }

    // Load previously scraped data (if resuming)
    let allThreadData = fs.existsSync(reviewsFile)
        ? JSON.parse(fs.readFileSync(reviewsFile, 'utf-8'))
        : [];
    let allMongoDocs = fs.existsSync(mongoFile)
        ? JSON.parse(fs.readFileSync(mongoFile, 'utf-8'))
        : [];

    // ── Step 2: scrape each pending thread ───────────────────
    for (let i = 0; i < queueData.threads.length; i++) {
        const entry = queueData.threads[i];
        if (entry.status === 'done') {
            log(`\n⏩ Thread ${i + 1} already done — skipping`);
            continue;
        }

        log(`\n${'─'.repeat(60)}`);
        log(`Thread ${i + 1} / ${queueData.threads.length} — ${entry.threadUrl}`);

        try {
            const { posts, pagesVisited, pageUrls } = await scrapeThread(page, entry.threadUrl);
            entry.status       = 'done';
            entry.pagesVisited = pagesVisited;
            entry.pageUrls     = pageUrls;
            entry.postsScraped = posts.length;

            if (posts.length > 0) {
                allThreadData.push({ threadUrl: entry.threadUrl, pagesVisited, posts });

                // ── Categorize all posts via rule-based classifier ──────
                log(`  🏷️  Categorizing ${posts.length} posts (rule-based)...`);
                const categories = categorizePosts(posts);
                const catSummary = {};
                categories.forEach(c => { catSummary[c] = (catSummary[c] || 0) + 1; });
                log(`  📊 Categories: ${JSON.stringify(catSummary)}`);

                // Convert to Mongo docs (with category attached)
                posts.forEach((post, idx) => {
                    const doc = toMongoDoc({
                        post,
                        threadUrl: entry.threadUrl,
                        brandSlug,
                        modelSlug,
                        category: categories[idx],
                    });
                    allMongoDocs.push(doc);
                });
            }
        } catch (err) {
            log(`⚠️  Error: ${err.message}`);
            entry.status = 'error';
            entry.error  = err.message;
        }

        // Persist after every thread
        fs.writeFileSync(reviewsFile, JSON.stringify(allThreadData, null, 2), 'utf-8');
        fs.writeFileSync(queueFile,   JSON.stringify(queueData, null, 2), 'utf-8');
        fs.writeFileSync(mongoFile,   JSON.stringify(allMongoDocs, null, 2), 'utf-8');

        const total = allThreadData.reduce((s, t) => s + t.posts.length, 0);
        log(`💾 Saved — ${allThreadData.length} threads, ${total} posts, ${allMongoDocs.length} mongo docs`);

        if (i < queueData.threads.length - 1) {
            log(`Pausing ${DELAY_BETWEEN_THREADS / 1000}s...`);
            await DELAY(DELAY_BETWEEN_THREADS);
        }
    }

    // Summary
    const totalPosts = allThreadData.reduce((s, t) => s + t.posts.length, 0);
    log(`\n🎉  Car done!  Threads: ${allThreadData.length}  |  Posts: ${totalPosts}  |  Mongo docs: ${allMongoDocs.length}`);
    log(`    📄 Raw reviews  → ${reviewsFile}`);
    log(`    🗄️  Mongo output → ${mongoFile}`);
    log(`    📋 Queue        → ${queueFile}`);
}

// ──────────────────────────────────────────────
// MAIN — loop over all cars with resume support
// ──────────────────────────────────────────────
(async () => {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const progress = loadProgress();
    const startFrom = progress.lastCompletedCarIndex + 1;

    log(`🚗  Team-BHP bulk scraper`);
    log(`📋  Cars to process: ${CAR_LIST.length}`);
    if (startFrom > 0) {
        log(`⏩  Resuming from car index ${startFrom} (${CAR_LIST[startFrom]?.make} ${CAR_LIST[startFrom]?.model})`);
    }
    log(`👁️   Browser is VISIBLE\n`);

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
    });

    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    try {
        for (let i = startFrom; i < CAR_LIST.length; i++) {
            await processCar(page, CAR_LIST[i], i);

            // Save progress AFTER each car completes successfully
            saveProgress(i);
            log(`\n✅ Progress saved: car ${i + 1} / ${CAR_LIST.length} done`);

            if (i < CAR_LIST.length - 1) {
                log(`\nPausing ${DELAY_BETWEEN_CARS / 1000}s before next car...`);
                await DELAY(DELAY_BETWEEN_CARS);
            }
        }

        log(`\n${'═'.repeat(60)}`);
        log(`🏁  ALL CARS DONE!`);
        log(`    Output directory: ${OUTPUT_DIR}`);

    } catch (err) {
        log(`❌ Fatal error: ${err.message}`);
        console.error(err);
        log(`\n⚠️  Script crashed. Re-run to resume from last completed car.`);
    } finally {
        log('\nDone. Browser left open.');
    }
})();