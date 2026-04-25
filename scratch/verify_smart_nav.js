import { browserService } from '../src/services/browserService.js';

async function main() {
  console.log("🚀 Starting Smart Exploration...");
  const result = await browserService.openUrl({ url: 'https://nexora-j4ds.onrender.com/' });
  const sessionId = result.sessionId;
  
  console.log("🔍 Running browser_explore_site...");
  // Simulate the browser_explore_site tool logic (which I added to mcpServer.js)
  // Since I want to verify the logic directly from the service:
  const links = await browserService.discoverNavLinks(browserService.sessions.get(sessionId));
  console.log(`✅ Found ${links.length} real navigation links.`);
  
  const visited = [];
  for (const link of links.filter(l => l.isInternal)) {
    console.log(`\n🤖 Clicking: "${link.text}" -> ${link.href}`);
    const navResult = await browserService.openUrl({ sessionId, url: link.fullUrl });
    
    if (navResult.method === "humanoid_click") {
      console.log(`✨ Success: Humanoid click registered for "${link.text}"`);
    } else if (navResult.status === "link_not_found") {
      console.log(`❌ Rejected: Link not found on page (fabrication blocked)`);
    }
    
    visited.push({ text: link.text, method: navResult.method || navResult.status });
  }
  
  // Test Fabrication Blocking
  console.log("\n🧪 Testing Fabrication Blocking (direct navigation to /fake-page)...");
  const fakeNav = await browserService.openUrl({ sessionId, url: 'https://nexora-j4ds.onrender.com/fake-page' });
  console.log(`🚫 Result: ${fakeNav.status} (Error: ${fakeNav.error})`);
  
  console.log("\n✨ Final visited map:", visited);
  process.exit(0);
}

main().catch(err => {
  console.error("FAILED:", err);
  process.exit(1);
});
