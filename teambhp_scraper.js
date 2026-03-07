const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/**
 * Scrapes car reviews from a Team-BHP thread URL.
 * @param {string} url - The URL of the Team-BHP car review thread.
 * @returns {Promise<Array>} - A list of review objects.
 */
async function scrapeTeamBHPReviews(url) {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    try {
        console.log(`Navigating to: ${url}`);
        // Set a realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait for the posts to be visible
        await page.waitForSelector('table[id^="post"]', { timeout: 10000 });

        const reviews = await page.evaluate(() => {
            const postElements = document.querySelectorAll('table[id^="post"]');
            const results = [];

            postElements.forEach(post => {
                // Extract User Info
                const userMenu = post.querySelector('div[id^="postmenu_"]');
                const userName = userMenu ? userMenu.innerText.trim() : 'Unknown';

                // Extract User Details (Rank, Join Date, Location, Posts, etc.)
                // In Team-BHP, user details are often in a div with class 'smallfont' inside the user info cell
                const userDetailsCell = post.querySelector('td.alt2');
                let userRank = '';
                let joinDate = '';
                let location = '';
                let postsCount = '';

                if (userDetailsCell) {
                    const smallFontDivs = userDetailsCell.querySelectorAll('div.smallfont');
                    if (smallFontDivs.length > 0) {
                        userRank = smallFontDivs[0].innerText.trim();

                        const fullText = userDetailsCell.innerText;
                        const joinMatch = fullText.match(/Join Date:\s*(.*)/);
                        const locMatch = fullText.match(/Location:\s*(.*)/);
                        const postsMatch = fullText.match(/Posts:\s*(.*)/);

                        if (joinMatch) joinDate = joinMatch[1].trim();
                        if (locMatch) location = locMatch[1].trim();
                        if (postsMatch) postsCount = postsMatch[1].trim();
                    }
                }

                // Extract Post Date and ID
                const postDateElement = post.querySelector('td.thead');
                let postDate = '';
                let postNumber = '';
                if (postDateElement) {
                    const dateText = postDateElement.innerText.trim();
                    const parts = dateText.split('#');
                    postDate = parts[0].trim();
                    postNumber = parts[1] ? '#' + parts[1].trim() : '';
                }

                // Extract Review Content
                const messageElement = post.querySelector('div[id^="post_message_"]');
                let reviewText = '';
                if (messageElement) {
                    // We want to keep the text but maybe clean up some whitespace
                    reviewText = messageElement.innerText.trim();
                }

                results.push({
                    postNumber,
                    postDate,
                    author: {
                        name: userName,
                        rank: userRank,
                        joinDate,
                        location,
                        postsCount
                    },
                    content: reviewText
                });
            });

            return results;
        });

        return reviews;
    } catch (error) {
        console.error('Error during scraping:', error.message);
        return [];
    } finally {
        await browser.close();
    }
}

// Example usage
const targetUrl = process.argv[2] || 'https://www.team-bhp.com/forum/official-new-car-reviews/305642-bmw-x3-30-xdrive-m-sport-pro-review.html';

scrapeTeamBHPReviews(targetUrl).then(reviews => {
    if (reviews.length > 0) {
        // Create output directory if it doesn't exist
        const outputDir = path.join(__dirname, 'scraped_data');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Derive filename from the URL slug
        const urlSlug = targetUrl
            .split('/')
            .filter(Boolean)
            .pop()
            .replace('.html', '');
        const outputFile = path.join(outputDir, `${urlSlug}.json`);

        // Write data to file
        fs.writeFileSync(outputFile, JSON.stringify(reviews, null, 2), 'utf-8');
        console.log(`✅ Scraped ${reviews.length} posts`);
        console.log(`📄 Data saved to: ${outputFile}`);
    } else {
        console.log("No reviews found or an error occurred.");
    }
}).catch(err => {
    console.error("Fatal error:", err);
});
