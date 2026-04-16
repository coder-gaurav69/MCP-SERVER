import { config } from "../config.js";

/**
 * Vision Analysis Service — Uses Google Gemini Flash (free tier) to give the AI agent "eyes".
 * Allows visual analysis of screenshots, hover effect detection, and clone comparison.
 */
class VisionService {
  constructor() {
    this._apiUrl = null;
  }

  get apiUrl() {
    if (!this._apiUrl) {
      const model = config.visionModel || "gemini-2.0-flash";
      this._apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    }
    return this._apiUrl;
  }

  isAvailable() {
    return config.visionEnabled && !!config.geminiApiKey;
  }

  _ensureAvailable() {
    if (!config.visionEnabled) {
      throw new Error("Vision AI is disabled. Set VISION_ENABLED=true in your .env file.");
    }
    if (!config.geminiApiKey) {
      throw new Error(
        "Missing GEMINI_API_KEY. Get a free API key at https://aistudio.google.com and add it to your .env file."
      );
    }
  }

  /**
   * Send an image buffer + text prompt to Gemini Vision and get a structured response.
   * @param {Buffer} imageBuffer - PNG/JPEG buffer
   * @param {string} prompt - What to analyze
   * @returns {Promise<{analysis: string, raw: object}>}
   */
  async analyzeScreenshot(imageBuffer, prompt) {
    this._ensureAvailable();

    const base64 = imageBuffer.toString("base64");

    const body = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: base64
              }
            },
            {
              text: prompt || "Analyze this screenshot in detail. Describe the layout, colors, fonts, spacing, and any visual effects you see."
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: config.visionMaxTokens,
        temperature: 0.2
      }
    };

    const url = `${this.apiUrl}?key=${config.geminiApiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const textParts = result?.candidates?.[0]?.content?.parts || [];
    const analysis = textParts.map(p => p.text || "").join("\n").trim();

    return { analysis, raw: result };
  }

  /**
   * Compare two screenshots and return a similarity analysis with differences.
   * @param {Buffer} bufferA - Original/reference screenshot
   * @param {Buffer} bufferB - Clone/comparison screenshot
   * @returns {Promise<{score: number, differences: string[], analysis: string}>}
   */
  async compareScreenshots(bufferA, bufferB) {
    this._ensureAvailable();

    const base64A = bufferA.toString("base64");
    const base64B = bufferB.toString("base64");

    const prompt = `You are a pixel-perfect UI comparison expert. Compare these two screenshots:
- Image 1 is the ORIGINAL/reference design
- Image 2 is the CLONE/recreation

Respond in this exact JSON format (no markdown, pure JSON):
{
  "similarityScore": <number 0-100>,
  "overallMatch": "<excellent|good|fair|poor>",
  "differences": [
    {"element": "<what>", "issue": "<what's different>", "severity": "<critical|major|minor>", "fix": "<how to fix>"}
  ],
  "summary": "<1-2 sentence overall summary>"
}

Be extremely precise. Check: colors, fonts, spacing, layout, alignment, sizes, borders, shadows, backgrounds, hover states, animations, icons, images.`;

    const body = {
      contents: [
        {
          parts: [
            { inlineData: { mimeType: "image/png", data: base64A } },
            { inlineData: { mimeType: "image/png", data: base64B } },
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: config.visionMaxTokens,
        temperature: 0.1
      }
    };

    const url = `${this.apiUrl}?key=${config.geminiApiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const rawText = (result?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();

    // Try to parse JSON from response
    let parsed = null;
    try {
      // Strip markdown code fences if present
      const cleaned = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // If JSON parse fails, return raw analysis
      return {
        score: -1,
        differences: [],
        analysis: rawText,
        parseError: true
      };
    }

    return {
      score: parsed.similarityScore ?? -1,
      overallMatch: parsed.overallMatch || "unknown",
      differences: parsed.differences || [],
      summary: parsed.summary || "",
      analysis: rawText
    };
  }

  /**
   * Analyze the visual effect of hovering over an element.
   * Takes before/after screenshots and asks AI to describe the visual change.
   * @param {Buffer} beforeBuffer - Screenshot before hover
   * @param {Buffer} afterBuffer - Screenshot after hover
   * @param {string} elementDescription - What element was hovered
   * @returns {Promise<{effects: string, analysis: string}>}
   */
  async analyzeHoverEffect(beforeBuffer, afterBuffer, elementDescription = "") {
    this._ensureAvailable();

    const base64Before = beforeBuffer.toString("base64");
    const base64After = afterBuffer.toString("base64");

    const prompt = `You are a CSS expert. Analyze the visual difference between these two screenshots.
- Image 1: BEFORE hover${elementDescription ? ` on "${elementDescription}"` : ""}
- Image 2: AFTER hover${elementDescription ? ` on "${elementDescription}"` : ""}

Describe every visual change you see. Respond in JSON format:
{
  "hasEffect": true/false,
  "effects": [
    {"type": "<color|scale|shadow|border|opacity|transform|background|text|other>", "description": "<what changed>", "cssEstimate": "<approximate CSS property and value>"}
  ],
  "suggestedCSS": "<complete :hover CSS block to recreate this effect>",
  "summary": "<1-sentence description>"
}`;

    const body = {
      contents: [
        {
          parts: [
            { inlineData: { mimeType: "image/png", data: base64Before } },
            { inlineData: { mimeType: "image/png", data: base64After } },
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: config.visionMaxTokens,
        temperature: 0.1
      }
    };

    const url = `${this.apiUrl}?key=${config.geminiApiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const rawText = (result?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();

    let parsed = null;
    try {
      const cleaned = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return { effects: rawText, analysis: rawText, parseError: true };
    }

    return {
      hasEffect: parsed.hasEffect ?? false,
      effects: parsed.effects || [],
      suggestedCSS: parsed.suggestedCSS || "",
      summary: parsed.summary || "",
      analysis: rawText
    };
  }

  /**
   * Extract visual design system from a screenshot using AI.
   * @param {Buffer} imageBuffer
   * @returns {Promise<object>}
   */
  async extractVisualDesignSystem(imageBuffer) {
    this._ensureAvailable();

    const prompt = `You are a UI/UX design expert. Analyze this webpage screenshot and extract the complete visual design system.

Respond in JSON format:
{
  "colors": {
    "primary": "<hex>",
    "secondary": "<hex>",
    "accent": "<hex>",
    "background": "<hex>",
    "surface": "<hex>",
    "text": "<hex>",
    "textSecondary": "<hex>",
    "border": "<hex>",
    "allColors": ["<hex>", ...]
  },
  "typography": {
    "headingFont": "<font family>",
    "bodyFont": "<font family>",
    "sizes": {"h1": "<px>", "h2": "<px>", "h3": "<px>", "body": "<px>", "small": "<px>"},
    "weights": ["<thin|light|normal|medium|semibold|bold|extrabold>"]
  },
  "spacing": {
    "unit": "<px>",
    "scale": ["<px>", ...]
  },
  "borderRadius": "<px>",
  "shadows": ["<css box-shadow>"],
  "layout": "<flex|grid|float|other>",
  "style": "<modern|minimal|corporate|playful|luxury|brutalist|other>",
  "darkMode": true/false
}`;

    return this.analyzeScreenshot(imageBuffer, prompt);
  }
}

export const visionService = new VisionService();
