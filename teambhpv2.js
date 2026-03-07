const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────
const MAKE = process.argv[2] || 'BMW';
const MODEL = process.argv[3] || 'X3';
const VARIANT = process.argv[4] || '30i';

const DELAY_AFTER_SEARCH_LOAD = 3000;
const DELAY_AFTER_REVIEWS_CLICK = 6000;  // wait for GSC AJAX to fully render
const DELAY_AFTER_PAGE_CLICK = 5000;  // wait after clicking a page number
const DELAY_BETWEEN_THREADS = 3000;
const DELAY_BETWEEN_THREAD_PAGES = 2000;

const DELAY = ms => new Promise(r => setTimeout(r, ms));
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

function normalizeThreadUrl(href) {
    return href.split('#')[0].replace(/-(\d+)\.html$/, '.html');
}

// ─────────────────────────────────────────────────────────────
// Wait until GSC results are rendered in DOM
// We know results are loaded when .gsc-result elements appear
// ─────────────────────────────────────────────────────────────
async function waitForGSCResults(page, timeoutMs = 10000) {
    try {
        await page.waitForFunction(
            () => document.querySelectorAll('.gsc-result, .gs-result').length > 0,
            { timeout: timeoutMs }
        );
        return true;
    } catch (_) {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────
// Wait until GSC shows results for a specific page number
// (active page indicator changes class to gsc-cursor-current-page)
// ─────────────────────────────────────────────────────────────
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
        await new Promise(r => setTimeout(r, 1500)); // small extra settle time
        return true;
    } catch (_) {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────
// Grab all forum thread links currently visible in GSC results
// ─────────────────────────────────────────────────────────────
async function grabCurrentPageLinks(page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('a.gs-title, .gsc-webResult a[href], .gs-result a[href]'))
            .map(a => a.href || '')
            .filter(h =>
                h.includes('team-bhp.com/forum') &&
                h.includes('.html') &&
                !h.includes('/member') &&
                !h.includes('/search.php') &&
                !h.includes('/galleryV2') &&
                !h.includes('official-new-car-reviews/?')
            )
    );
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — Collect all unique thread URLs from search
// ─────────────────────────────────────────────────────────────
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

    // ── Click "Reviews" tab ───────────────────────────────────
    log('Clicking "Reviews" tab...');
    const clicked = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('a, div, span, li, td'))
            .find(e => e.innerText && e.innerText.trim() === 'Reviews');
        if (el) { el.click(); return true; }
        return false;
    });

    if (clicked) {
        log(`✔ Reviews tab clicked! Waiting ${DELAY_AFTER_REVIEWS_CLICK / 1000}s for GSC to load results...`);
        await DELAY(DELAY_AFTER_REVIEWS_CLICK);
        // Extra: wait until actual result cards appear
        const loaded = await waitForGSCResults(page, 8000);
        log(loaded ? '✔ GSC results are visible in DOM' : '⚠️  GSC results may not be fully loaded yet');
    } else {
        log('⚠️  Reviews tab not found — using current results');
        await DELAY(3000);
    }

    // ── How many pages are there? ─────────────────────────────
    const totalPages = await page.evaluate(() => {
        const pages = document.querySelectorAll('.gsc-cursor-page');
        return pages.length; // e.g. 10
    });
    log(`Found ${totalPages} search result pages`);

    const seenRoots = new Set();

    // ── Scrape page 1 ─────────────────────────────────────────
    log(`\nScraping search results page 1 / ${totalPages}...`);
    const page1Links = await grabCurrentPageLinks(page);
    page1Links.forEach(h => seenRoots.add(normalizeThreadUrl(h)));
    log(`  +${page1Links.length} links | ${seenRoots.size} unique so far`);

    // ── Click through pages 2..N ──────────────────────────────
    for (let p = 2; p <= totalPages; p++) {
        log(`\nClicking page ${p} of ${totalPages}...`);

        const didClick = await page.evaluate((pageNum) => {
            const btn = Array.from(document.querySelectorAll('.gsc-cursor-page'))
                .find(el => el.textContent.trim() === String(pageNum));
            if (btn) { btn.click(); return true; }
            return false;
        }, p);

        if (!didClick) {
            log(`  ⚠️  Could not find page ${p} button — stopping early`);
            break;
        }

        // Wait until the active page indicator updates to confirm load
        log(`  Waiting for page ${p} results to load...`);
        const loaded = await waitForGSCPage(page, p, 10000);
        if (!loaded) {
            log(`  ⚠️  Page ${p} did not confirm load — trying anyway`);
            await DELAY(DELAY_AFTER_PAGE_CLICK);
        }

        const links = await grabCurrentPageLinks(page);
        let newCount = 0;
        links.forEach(h => {
            const root = normalizeThreadUrl(h);
            if (!seenRoots.has(root)) { seenRoots.add(root); newCount++; }
        });
        log(`  ✔ Page ${p} loaded | +${newCount} new | ${seenRoots.size} unique total`);
    }

    const unique = [...seenRoots];
    log(`\n📋 Final queue — ${unique.length} unique threads:`);
    unique.forEach((u, i) => log(`   ${i + 1}. ${u}`));
    return unique;
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — Scrape posts from each thread (all pages)
// ─────────────────────────────────────────────────────────────
async function scrapeThreadPage(page) {
    return page.evaluate(() => {
        const posts = document.querySelectorAll('table[id^="post"]');
        const results = [];
        posts.forEach(post => {
            const userMenu = post.querySelector('div[id^="postmenu_"]');
            const userName = userMenu ? userMenu.innerText.trim() : 'Unknown';

            const cell = post.querySelector('td.alt2');
            let userRank = '', joinDate = '', location = '', postsCount = '';
            if (cell) {
                const divs = cell.querySelectorAll('div.smallfont');
                if (divs.length > 0) userRank = divs[0].innerText.trim();
                const text = cell.innerText;
                const m1 = text.match(/Join Date:\s*(.*)/);
                const m2 = text.match(/Location:\s*(.*)/);
                const m3 = text.match(/Posts:\s*(.*)/);
                if (m1) joinDate = m1[1].trim();
                if (m2) location = m2[1].trim();
                if (m3) postsCount = m3[1].trim();
            }

            const dateEl = post.querySelector('td.thead');
            let postDate = '', postNumber = '';
            if (dateEl) {
                const parts = dateEl.innerText.trim().split('#');
                postDate = parts[0].trim();
                postNumber = parts[1] ? '#' + parts[1].trim() : '';
            }

            const msgEl = post.querySelector('div[id^="post_message_"]');
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
    let allPosts = [];
    let pageNum = 1;
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

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
(async () => {
    const query = `${MAKE} ${MODEL} ${VARIANT}`;
    const slug = query.replace(/\s+/g, '_').toLowerCase();

    log(`🚗  Team-BHP scraper  |  "${query}"`);
    log(`👁️   Browser is VISIBLE\n`);

    const outputDir = path.join(__dirname, 'scraped_data');
    fs.mkdirSync(outputDir, { recursive: true });
    const reviewsFile = path.join(outputDir, `${slug}_reviews.json`);
    const queueFile = path.join(outputDir, `${slug}_queue.json`);

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    try {
        // ── Step 1: collect all URLs ──────────────────────────────
        const reviewLinks = await collectReviewLinks(page, query);

        if (!reviewLinks.length) {
            log('❌ No links found.'); await browser.close(); return;
        }

        // Save queue
        const queueData = {
            query, scrapedAt: new Date().toISOString(),
            totalThreads: reviewLinks.length,
            threads: reviewLinks.map((url, i) => ({
                index: i + 1, threadUrl: url,
                status: 'pending', pagesVisited: 0, pageUrls: [], postsScraped: 0
            }))
        };
        fs.writeFileSync(queueFile, JSON.stringify(queueData, null, 2), 'utf-8');
        log(`\n📁 Queue saved → ${queueFile}`);

        // ── Step 2: scrape each thread ────────────────────────────
        const allThreadData = [];
        for (let i = 0; i < reviewLinks.length; i++) {
            const url = reviewLinks[i];
            const entry = queueData.threads[i];

            log(`\n${'━'.repeat(60)}`);
            log(`Thread ${i + 1} / ${reviewLinks.length} — ${url}`);

            try {
                const { posts, pagesVisited, pageUrls } = await scrapeThread(page, url);
                entry.status = 'done'; entry.pagesVisited = pagesVisited;
                entry.pageUrls = pageUrls; entry.postsScraped = posts.length;
                if (posts.length > 0) allThreadData.push({ threadUrl: url, pagesVisited, posts });
            } catch (err) {
                log(`⚠️  Error: ${err.message}`);
                entry.status = 'error'; entry.error = err.message;
            }

            fs.writeFileSync(reviewsFile, JSON.stringify(allThreadData, null, 2), 'utf-8');
            fs.writeFileSync(queueFile, JSON.stringify(queueData, null, 2), 'utf-8');
            const total = allThreadData.reduce((s, t) => s + t.posts.length, 0);
            log(`💾 Saved — ${allThreadData.length} threads, ${total} posts`);

            if (i < reviewLinks.length - 1) {
                log(`Pausing ${DELAY_BETWEEN_THREADS / 1000}s...`);
                await DELAY(DELAY_BETWEEN_THREADS);
            }
        }

        // ── Summary ───────────────────────────────────────────────
        const totalPosts = allThreadData.reduce((s, t) => s + t.posts.length, 0);
        log(`\n${'═'.repeat(60)}`);
        log(`🎉  All done!  Threads: ${allThreadData.length}  |  Posts: ${totalPosts}`);
        log(`    📄 Reviews → ${reviewsFile}`);
        log(`    📋 Queue   → ${queueFile}`);
        log(`\n📊 Per-thread summary:`);
        log(`    # | Pages | Posts | Thread`);
        log(`    --+-------+-------+${'─'.repeat(50)}`);
        queueData.threads.forEach(t => {
            const title = t.threadUrl.split('/').pop().replace('.html', '').slice(0, 48);
            log(`  ${String(t.index).padStart(3)} | ${String(t.pagesVisited).padStart(5)} | ${String(t.postsScraped).padStart(5)} | ${title}`);
        });

    } catch (err) {
        log(`❌ Fatal: ${err.message}`); console.error(err);
    } finally {
        log('\nDone. Browser left open.');
    }
})();