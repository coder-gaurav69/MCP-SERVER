import { createServiceLogger } from "./loggerService.js";
import { aiDecisionService } from "./aiDecisionService.js";
import { visionService } from "./visionService.js";
import { browserService } from "./browserService.js";

const log = createServiceLogger("code-generator-service");

class CodeGeneratorService {
  /**
   * Convert a UI schema into clean React components using Tailwind CSS.
   * @param {object} schema - Output from uiSchemaService.extractSchema
   * @returns {Promise<object>}
   */
  async generateReactCode(schema) {
    log.info("Generating React code from UI schema");

    const prompt = `Convert this UI schema into a set of high-quality, reusable React components using Tailwind CSS.
    Generate a main Page component that assembles the other components (Navbar, Hero, Cards, etc.).
    The code should be clean, modular, and use modern React patterns (Functional Components, Hooks).
    
    UI SCHEMA:
    ${JSON.stringify(schema, null, 2)}
    
    Respond with a JSON object where keys are filenames (e.g., "Page.jsx", "Navbar.jsx") and values are the code contents.
    JSON only.`;

    const response = await aiDecisionService._prompt(prompt);
    try {
      const files = JSON.parse(response.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim());
      log.info("React code generated successfully", { files: Object.keys(files) });
      return files;
    } catch (err) {
      log.error("Failed to parse code generation AI response", { error: err.message, response });
      return { "Error.jsx": `// Failed to generate code: ${err.message}` };
    }
  }

  async verifyVisualFidelity(sessionId, schema) {
    log.info("Verifying visual fidelity of generated schema");
    const session = browserService.getSession(sessionId);
    if (!session) return { confidence: 0, mismatch: "Session not found" };

    const buffer = await session.page.screenshot({ fullPage: false });
    
    const prompt = `Compare this screenshot with the provided UI schema.
    Detect any mismatches in layout, component types, or design tokens.
    
    UI SCHEMA:
    ${JSON.stringify(schema, null, 2)}
    
    Respond in JSON only:
    {
      "confidence": 0-1 score,
      "mismatches": ["list of discrepancies"],
      "suggestedFixes": ["list of improvements"]
    }`;

    const response = await visionService.analyzeScreenshot(buffer, prompt);
    return response;
  }
}

export const codeGeneratorService = new CodeGeneratorService();
