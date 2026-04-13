const BASE_URL = 'http://127.0.0.1:4000';

async function makeRequest(method, endpoint, data = null) {
    const url = `${BASE_URL}${endpoint}`;
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (data) {
        options.body = JSON.stringify(data);
    }

    try {
        const response = await fetch(url, options);
        const result = await response.json();
        console.log(`${method} ${endpoint}:`, result);
        return result;
    } catch (error) {
        console.error(`Error ${method} ${endpoint}:`, error.message);
        throw error;
    }
}

async function openWebsite() {
    console.log('Opening website: https://nextgen-invoice.onrender.com/');
    const result = await makeRequest('POST', '/open', {
        url: 'https://nextgen-invoice.onrender.com/',
        headless: false, // Show browser window
        persist: false
    });
    return result.data?.sessionId;
}

async function analyzePage(sessionId) {
    console.log('Analyzing page...');
    const result = await makeRequest('GET', `/analyze?sessionId=${sessionId}`);
    return result.data;
}

async function takeScreenshot(sessionId) {
    console.log('Taking screenshot...');
    const result = await makeRequest('GET', `/screenshot?sessionId=${sessionId}&embedImage=true`);
    return result.data;
}

async function main() {
    try {
        // Step 1: Open the website
        const sessionId = await openWebsite();
        if (!sessionId) {
            console.error('Failed to get sessionId');
            return;
        }
        console.log('Session ID:', sessionId);

        // Wait a bit for page to load
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Step 2: Analyze the page to see form fields
        const analysis = await analyzePage(sessionId);
        console.log('Page analysis:', JSON.stringify(analysis, null, 2));

        // Step 3: Take screenshot for verification
        const screenshot = await takeScreenshot(sessionId);
        console.log('Screenshot saved:', screenshot?.filePath);

    } catch (error) {
        console.error('Main error:', error);
    }
}

main();