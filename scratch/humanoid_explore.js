import { browserService } from '../src/services/browserService.js';

async function main() {
  const result = await browserService.openUrl({ url: 'https://nexora-j4ds.onrender.com/' });
  const sessionId = result.sessionId;
  const session = browserService.sessions.get(sessionId);
  
  if (!session) {
    console.error("Session not found in browserService.sessions");
    return;
  }

  const links = await session.page.evaluate(() => {
    const selectors = ['nav a', 'header a', '.nav-link', 'a'];
    const seen = new Set();
    const result = [];
    
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = el.innerText.trim();
        const href = el.getAttribute('href');
        if (text && href && !href.startsWith('#') && !seen.has(text)) {
          seen.add(text);
          result.push({ text, href, selector: `${sel}:has-text("${text}")` });
        }
      }
    }
    // Filter for common navigation text
    const navWords = ['Home', 'About', 'Services', 'Contact', 'Projects', 'Blog', 'Pricing', 'Features'];
    return result.filter(l => navWords.some(word => l.text.toLowerCase().includes(word.toLowerCase())));
  });
  
  console.log('---LINKS FOUND---');
  links.forEach(l => console.log(` - ${l.text} (${l.href})`));
  console.log('------------------');
  
  for (const link of links) {
    console.log(`\n🤖 Humanoid Interaction: Moving to and clicking "${link.text}"`);
    
    try {
      // browserService.click will use moveMouseHumanoid internally
      await browserService.click({ sessionId, query: link.text });
      
      // Wait for page load/settle
      await new Promise(r => setTimeout(r, 3000));
      
      const pageTitle = await session.page.title();
      const currentUrl = session.page.url();
      console.log(`📍 Now on page: "${pageTitle}" (${currentUrl})`);
      
      const fileName = `humanoid-${link.text.replace(/\s+/g, '_').toLowerCase()}.png`;
      console.log(`📸 Taking screenshot: ${fileName}`);
      
      const screenshot = await browserService.screenshot({ 
        sessionId, 
        saveLocal: true, 
        fileName 
      });
      console.log(`✅ Saved to: ${screenshot.path}`);
    } catch (err) {
      console.error(`❌ Failed to interact with "${link.text}": ${err.message}`);
    }
  }
  
  console.log('\n✨ Exploration complete.');
  await session.page.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
