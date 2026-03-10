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
const OFFICIAL_REVIEW_BASE = 'https://www.team-bhp.com/forum/official-new-car-reviews';
const OUTPUT_DIR = path.join(__dirname, 'scraped_data');

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

function normalizeThreadUrl(href) {
    return href.split('#')[0].replace(/-(\d+)\.html$/, '.html');
}

/** Only keep URLs that start with the official reviews base */
function isOfficialReviewUrl(href) {
    return href.startsWith(OFFICIAL_REVIEW_BASE);
}

/** Generate a deterministic Mongo-style ObjectId-like hex string from a string */
function makeObjectId(seed) {
    const hash = crypto.createHash('md5').update(seed).digest('hex');
    return hash.substring(0, 24); // 24 hex chars like ObjectId
}

/** Convert a post into the target MongoDB document shape */
function toMongoDoc({ post, threadUrl, brandSlug, modelSlug }) {
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
    const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a.gs-title, .gsc-webResult a[href], .gs-result a[href]'))
            .map(a => a.href || '')
    );
    return links.filter(h => h.startsWith('https://www.team-bhp.com/forum/official-new-car-reviews') && h.includes('.html'));
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

                // Convert to Mongo docs
                posts.forEach(post => {
                    const doc = toMongoDoc({ post, threadUrl: entry.threadUrl, brandSlug, modelSlug });
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