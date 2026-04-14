import http from 'http';

const postRequest = (path, data) => {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 1000,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
};

const getRequest = (path) => {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:1000${path}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function testInvoiceWebsite() {
  try {
    console.log('1. Opening the invoice website...');
    const openResult = await postRequest('/api/browser/open', {
      url: 'https://nextgen-invoice.onrender.com/',
      headless: false
    });
    console.log('Open result:', JSON.stringify(openResult, null, 2));
    
    if (!openResult.data?.sessionId) {
      console.error('Failed to get session ID');
      return;
    }
    
    const sessionId = openResult.data.sessionId;
    console.log('Session ID:', sessionId);
    
    console.log('\n2. Waiting for page to fully load...');
    await sleep(8000);
    
    const analyzeResult = await getRequest(`/api/browser/analyze?sessionId=${sessionId}`);
    console.log('Page loaded:', analyzeResult.data.title);
    
    console.log('\n3. Taking initial screenshot...');
    const screenshotResult = await getRequest(`/api/browser/screenshot?sessionId=${sessionId}&embedImage=false&saveLocal=true`);
    console.log('Screenshot saved to:', screenshotResult.data.path);
    
    console.log('\n4. Filling form using specific selectors...');
    
    await postRequest('/api/browser/type', { sessionId, selector: '#patient_name', text: 'John Doe' });
    console.log('Patient name typed');
    
    await postRequest('/api/browser/type', { sessionId, selector: '#ip_no', text: '12345' });
    console.log('IP No typed');
    
    await postRequest('/api/browser/select', { sessionId, selector: '#hospital_select', label: 'AMAR MEDICAL AND RESEARCH CENTRE' });
    console.log('Hospital selected');
    
    await postRequest('/api/browser/type', { sessionId, selector: "[name='data[0][item_name]']", text: 'Paracetamol 500mg' });
    await postRequest('/api/browser/type', { sessionId, selector: "[name='data[0][batch_no]']", text: 'BATCH001' });
    await postRequest('/api/browser/type', { sessionId, selector: "[name='data[0][exp]']", text: '2026-12' });
    await postRequest('/api/browser/type', { sessionId, selector: "[name='data[0][rate]']", text: '50' });
    await postRequest('/api/browser/type', { sessionId, selector: "[name='data[0][quantity]']", text: '10' });
    console.log('Medicine details filled');
    
    console.log('\n5. Taking screenshot after filling form...');
    const screenshotAfterFill = await getRequest(`/api/browser/screenshot?sessionId=${sessionId}&embedImage=false&saveLocal=true`);
    console.log('Screenshot saved to:', screenshotAfterFill.data.path);
    
    console.log('\n6. Clicking GENERATE button...');
    const clickResult = await postRequest('/api/browser/click', {
      sessionId,
      selector: 'button.btn[type="submit"]'
    });
    console.log('Click result:', JSON.stringify(clickResult, null, 2));
    
    console.log('\n7. Taking screenshot after generating...');
    await sleep(3000);
    const finalScreenshot = await getRequest(`/api/browser/screenshot?sessionId=${sessionId}&embedImage=false&saveLocal=true`);
    console.log('Screenshot saved to:', finalScreenshot.data.path);
    
    console.log('\n8. Generating PDF...');
    const pdfResult = await postRequest('/api/browser/generate_pdf', {
      sessionId,
      fileName: 'invoice-complete.pdf'
    });
    console.log('PDF saved to:', pdfResult.data.path);
    
    console.log('\n✓ Test completed successfully!');
    console.log('\nFiles generated:');
    console.log('- Screenshot:', screenshotAfterFill.data.path);
    console.log('- PDF:', pdfResult.data.path);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testInvoiceWebsite();