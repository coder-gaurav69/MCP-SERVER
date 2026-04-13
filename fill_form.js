const BASE_URL = 'http://127.0.0.1:4000';
const SESSION_ID = '54aefac4-97e7-4426-924e-ad75d792b1e7';

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
        console.log(`${method} ${endpoint}:`, result.status);
        return result;
    } catch (error) {
        console.error(`Error ${method} ${endpoint}:`, error.message);
        throw error;
    }
}

async function typeText(selector, text) {
    return makeRequest('POST', '/type', {
        sessionId: SESSION_ID,
        selector,
        text
    });
}

async function selectOption(selector, value) {
    return makeRequest('POST', '/select', {
        sessionId: SESSION_ID,
        selector,
        value
    });
}

async function clickButton(selector) {
    return makeRequest('POST', '/click', {
        sessionId: SESSION_ID,
        selector
    });
}

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fillForm() {
    try {
        console.log('Starting form fill...');

        // 1. Fill invoice date (today's date in YYYY-MM-DD format)
        const today = new Date().toISOString().split('T')[0];
        await typeText('#date', today);
        await wait(500);

        // 2. Fill patient name
        await typeText('#patient_name', 'John Doe');
        await wait(500);

        // 3. Fill IP number
        await typeText('#ip_no', '102345');
        await wait(500);

        // 4. Select hospital from dropdown
        // First, let's see what options are available by trying to select a value
        // We'll try to select the first option after "Select hospital..."
        await selectOption('#hospital_select', '1'); // Try value "1"
        await wait(1000);

        // 5. Fill custom hospital name (optional)
        await typeText('#custom_hospital_name', 'City General Hospital');
        await wait(500);

        // 6. Fill unit (should auto-fill but we'll type just in case)
        await typeText('#unit', 'Main Unit');
        await wait(500);

        // 7. Fill GST number
        await typeText('#gst_no', '27ABCDE1234F1Z5');
        await wait(500);

        // 8. Fill location
        await typeText('#location', 'Mumbai, Maharashtra');
        await wait(500);

        // 9. Fill address
        await typeText('#address', '123 Main Street, Mumbai, Maharashtra 400001');
        await wait(500);

        // 10. Fill medicine item details
        await typeText('[name="data[0][item_name]"]', 'Paracetamol 500mg');
        await wait(500);

        await typeText('[name="data[0][batch_no]"]', 'B123456');
        await wait(500);

        // Expiry date in YYYY-MM format
        await typeText('[name="data[0][exp]"]', '2025-12');
        await wait(500);

        await typeText('[name="data[0][rate]"]', '25.50');
        await wait(500);

        await typeText('[name="data[0][quantity]"]', '10');
        await wait(500);

        // Amount should auto-calculate, but we can fill if needed
        // await typeText('[name="data[0][amount]"]', '255.00');

        console.log('Form filled successfully!');

        // Take a screenshot to verify
        const screenshot = await makeRequest('GET', `/screenshot?sessionId=${SESSION_ID}&fileName=form_filled`);
        console.log('Screenshot saved:', screenshot.data?.filePath);

        return true;
    } catch (error) {
        console.error('Error filling form:', error);
        return false;
    }
}

async function generateInvoice() {
    try {
        console.log('Generating invoice...');

        // Click the generate button
        const result = await clickButton('button.btn:has-text("GENERATE PROFESSIONAL INVOICE")');

        if (result.status === 'success') {
            console.log('Invoice generation initiated');

            // Wait for processing
            await wait(3000);

            // Take screenshot of result
            const screenshot = await makeRequest('GET', `/screenshot?sessionId=${SESSION_ID}&fileName=invoice_generated`);
            console.log('Result screenshot saved:', screenshot.data?.filePath);

            return true;
        } else {
            console.error('Failed to click generate button:', result);
            return false;
        }
    } catch (error) {
        console.error('Error generating invoice:', error);
        return false;
    }
}

async function main() {
    console.log('Session ID:', SESSION_ID);

    // Fill the form
    const filled = await fillForm();
    if (!filled) {
        console.error('Failed to fill form');
        return;
    }

    // Wait a moment
    await wait(2000);

    // Generate invoice
    const generated = await generateInvoice();
    if (generated) {
        console.log('Invoice generation completed successfully!');
    } else {
        console.error('Invoice generation failed');
    }
}

main();