import { browserService } from '../src/services/browserService.js';

async function main() {
  console.log("🚀 Starting Autonomous Autopilot Test...");
  const result = await browserService.openUrl({ url: 'https://nextgen-invoice.onrender.com/' });
  const sessionId = result.sessionId;

  console.log("🧠 Autopilot taking over...");
  const fillResult = await browserService.autofill({ 
    sessionId, 
    goal: "Fill the form completely as a patient named Gaurav. Include medicine data for Paracetamol." 
  });
  
  console.log("📊 Results:");
  console.log(`- Success: ${fillResult.success}`);
  console.log(`- Total Fields Filled: ${fillResult.filledFields.length}`);
  
  console.log("📸 Screenshot saved at:", fillResult.screenshot);
  process.exit(fillResult.success ? 0 : 1);
}

main().catch(err => {
  console.error("FAILED:", err);
  process.exit(1);
});
