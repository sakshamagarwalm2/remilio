const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({
        headless: false, defaultViewport: null,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Intercept ALL XHR/fetch responses and log anything from Google
    page.on('response', async response => {
        const url = response.url();
        if (url.includes('googleapis') || url.includes('cse.google') || url.includes('google.com/cse')) {
            console.log(`\n[XHR INTERCEPTED] ${url.substring(0, 120)}`);
            try {
                const text = await response.text();
                console.log(`  Response (first 500 chars): ${text.substring(0, 500)}`);
            } catch (e) { console.log('  (could not read response body)'); }
        }
    });

    await page.goto(
        'https://www.team-bhp.com/search.php?cx=partner-pub-8422315737402856%3Azcmboq-gw8i&cof=FORID%3A9&ie=ISO-8859-1&sa=&q=BMW%20X3%2030i',
        { waitUntil: 'networkidle2', timeout: 60000 }
    );
    await new Promise(r => setTimeout(r, 3000));

    // Click Reviews
    await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('a,div,span,li,td'))
            .find(e => e.innerText && e.innerText.trim() === 'Reviews');
        if (el) el.click();
    });
    console.log('\n[Clicked Reviews tab, waiting 6s...]');
    await new Promise(r => setTimeout(r, 6000));

    // Dump every possible cursor/pagination element in the DOM
    const cursorInfo = await page.evaluate(() => {
        const selectors = [
            '.gsc-cursor-page', '.gs-cursor-page', '.gsc-cursor td',
            '.gsc-cursor-box', '[class*="cursor"]', '[class*="page-number"]',
            'td[onclick]', 'div[onclick]', 'span[onclick]'
        ];
        const found = {};
        selectors.forEach(sel => {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
                found[sel] = Array.from(els).map(el => ({
                    text: el.textContent.trim().substring(0, 20),
                    classes: el.className,
                    onclick: el.getAttribute('onclick') || '',
                    html: el.outerHTML.substring(0, 150)
                }));
            }
        });
        return found;
    });

    console.log('\n=== GSC CURSOR ELEMENTS FOUND ===');
    if (Object.keys(cursorInfo).length === 0) {
        console.log('  NONE found in main DOM — widget is in iframe or shadow DOM');
    } else {
        Object.entries(cursorInfo).forEach(([sel, els]) => {
            console.log(`\n  Selector: "${sel}" (${els.length} elements)`);
            els.forEach(e => console.log(`    text="${e.text}" class="${e.classes}" html="${e.html}"`));
        });
    }

    // Check all iframes
    console.log('\n=== CHECKING IFRAMES ===');
    const iframes = await page.frames();
    console.log(`  Total frames: ${iframes.length}`);
    for (const frame of iframes) {
        try {
            const frameUrl = frame.url();
            if (frameUrl && frameUrl !== 'about:blank') {
                console.log(`  Frame URL: ${frameUrl.substring(0, 100)}`);
                const frameCursors = await frame.evaluate(() => {
                    const els = document.querySelectorAll('.gsc-cursor-page, [class*="cursor"], td, a');
                    return Array.from(els).slice(0, 5).map(e => ({
                        tag: e.tagName, text: e.textContent.trim().substring(0, 20),
                        classes: e.className.substring(0, 50)
                    }));
                });
                if (frameCursors.length) {
                    console.log(`    Elements: ${JSON.stringify(frameCursors)}`);
                }
            }
        } catch (e) { console.log(`  Frame error: ${e.message.substring(0, 60)}`); }
    }

    console.log('\nDebug complete. Browser stays open — inspect manually.');
})();