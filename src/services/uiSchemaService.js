import { createServiceLogger } from "./loggerService.js";
import { aiDecisionService } from "./aiDecisionService.js";

const log = createServiceLogger("ui-schema-service");

class UiSchemaService {
  /**
   * Extract a structured UI schema from a page analysis.
   * @param {object} pageInfo - Output from browserService.analyzePageState
   * @returns {Promise<object>}
   */
  async extractSchema(pageInfo) {
    log.info("Extracting UI schema from page state");

    const prompt = `Analyze this page structure and convert it into a high-level UI component schema.
    Identify the overall layout (e.g. "hero + features + footer") and map interactive elements into logical components (e.g. "Navbar", "Sidebar", "ProductCard").
    
    URL: ${pageInfo.url}
    Title: ${pageInfo.title}
    
    Layout Containers:
    ${JSON.stringify(pageInfo.layout || [], null, 2)}
    
    Interactive Elements Sample:
    ${JSON.stringify((pageInfo.elements || []).slice(0, 50), null, 2)}
    
    Respond in JSON only with this structure:
    {
      "layout": "string description",
      "designTokens": {
        "primaryColor": "hex",
        "fontFamily": "string"
      },
      "components": [
        {
          "type": "string (navbar|hero|card|form|footer|grid)",
          "id": "string",
          "label": "string",
          "children": []
        }
      ]
    }`;

    const response = await aiDecisionService._prompt(prompt);
    try {
      const schema = JSON.parse(response.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim());
      log.info("UI schema extracted successfully");
      return schema;
    } catch (err) {
      log.error("Failed to parse UI schema AI response", { error: err.message, response });
      return { layout: "unknown", components: [] };
    }
  }

  /**
   * Map UI components to design atoms for Figma.
   */
  mapToFigmaNodes(schema) {
    // Logic to convert the schema into a format FigmaService understands
    return schema.components.map(comp => ({
      id: comp.id,
      name: comp.label || comp.type,
      type: this._mapToFigmaType(comp.type),
      // Add more design details here
    }));
  }

  _mapToFigmaType(type) {
    switch (type) {
      case "card":
      case "navbar":
      case "hero":
      case "form":
        return "FRAME";
      case "button":
        return "INSTANCE";
      default:
        return "GROUP";
    }
  }
}

export const uiSchemaService = new UiSchemaService();
