import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { createServiceLogger } from "./loggerService.js";
import { opencvService } from "./opencvService.js";

const log = createServiceLogger("ai-service");

const normalize = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[_\-.:*()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const FIELD_SYNONYMS = new Map([
  ["email", ["mail", "e mail", "username", "user id", "login id"]],
  ["username", ["user", "user name", "login", "login id", "email"]],
  ["password", ["pass", "pwd", "secret"]],
  ["phone", ["mobile", "cell", "telephone", "contact number"]],
  ["name", ["full name", "first name", "last name", "display name"]],
  ["address", ["street", "location", "where"]],
  ["city", ["town"]],
  ["zip", ["postal", "postcode", "pin", "pincode"]],
  ["search", ["find", "query"]],
  ["submit", ["send", "save", "continue", "next", "login", "sign in"]]
]);

const methodRank = { DOM: 0, OCR: 1, VISION: 2, AI: 3 };

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function tokens(value) {
  const base = normalize(value);
  if (!base) return [];
  const parts = base.split(" ").filter(Boolean);
  const expanded = new Set(parts);
  for (const part of parts) {
    const synonyms = FIELD_SYNONYMS.get(part) || [];
    for (const synonym of synonyms) {
      for (const token of normalize(synonym).split(" ").filter(Boolean)) expanded.add(token);
    }
  }
  return [...expanded];
}

function levenshtein(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const previous = Array(right.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    let prevDiag = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const temp = previous[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, prevDiag + cost);
      prevDiag = temp;
    }
  }
  const distance = previous[right.length];
  return 1 - distance / Math.max(left.length, right.length);
}

function tokenSimilarity(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  const overlap = left.filter((token) => rightSet.has(token)).length;
  const union = new Set([...left, ...right]).size || 1;
  return overlap / union;
}

function textSimilarity(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.88;
  return Math.max(tokenSimilarity(left, right), levenshtein(left, right) * 0.7);
}

function candidateText(candidate) {
  return [
    candidate.label,
    candidate.placeholder,
    candidate.name,
    candidate.id,
    candidate.aria,
    candidate.text,
    candidate.semanticLabel,
    candidate.purpose,
    candidate.type
  ].filter(Boolean).join(" ");
}

function parseJsonLoose(text) {
  const cleaned = String(text || "").replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Response was not valid JSON");
  }
}

class AiService {
  constructor() {
    this.cache = new Map();
  }

  cacheKey(scope, value) {
    return `${scope}:${value}`;
  }

  imageCacheKey(scope, imageBuffer, pageKey = "") {
    return this.cacheKey(scope, pageKey || hashBuffer(imageBuffer));
  }

  getCached(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > config.aiCacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    log.info("cache hit", { key });
    return cached.value;
  }

  setCached(key, value) {
    this.cache.set(key, { value, timestamp: Date.now() });
    return value;
  }

  scoreCandidate(intent, candidate, contextText = "") {
    const primary = Math.max(
      textSimilarity(intent, candidate.label),
      textSimilarity(intent, candidate.placeholder),
      textSimilarity(intent, candidate.name),
      textSimilarity(intent, candidate.id),
      textSimilarity(intent, candidate.aria),
      textSimilarity(intent, candidate.semanticLabel)
    );
    const broad = textSimilarity(intent, candidateText(candidate));
    const contextBoost = contextText ? textSimilarity(intent, contextText) * 0.12 : 0;
    const exactSelectorBoost = normalize(candidate.selector).includes(normalize(intent)) ? 0.05 : 0;
    return clamp01(Math.max(primary, broad * 0.86) + contextBoost + exactSelectorBoost);
  }

  smartMatch(intent, elements = [], { method = "DOM", ocrText = "", visionData = null } = {}) {
    const candidates = elements
      .filter((el) => el && el.selector)
      .map((el) => {
        const contextText = [ocrText, visionData?.analysis, visionData?.description, visionData?.rawText]
          .filter(Boolean)
          .join(" ");
        return { ...el, score: this.scoreCandidate(intent, el, contextText) };
      })
      .sort((a, b) => b.score - a.score);

    const best = candidates[0] || null;
    return {
      success: !!best,
      methodUsed: method,
      confidence: best ? Number(best.score.toFixed(3)) : 0,
      selectedElement: best?.selector || null,
      element: best,
      logs: best
        ? [`${method}: matched "${intent}" to ${best.selector} (${best.score.toFixed(2)})`]
        : [`${method}: no candidate elements available`]
    };
  }

  async withTempImage(imageBuffer, fn) {
    await fs.mkdir(config.aiTempDir, { recursive: true });
    const filePath = path.resolve(config.aiTempDir, `ai-${Date.now()}-${hashBuffer(imageBuffer).slice(0, 10)}.png`);
    try {
      await fs.writeFile(filePath, imageBuffer);
      return await fn(filePath);
    } finally {
      await fs.unlink(filePath).catch(() => {});
    }
  }

  async extractTextFromImage(imageBuffer, options = {}) {
    const cacheKey = this.imageCacheKey("ocr", imageBuffer, options.cacheKey);
    const cached = this.getCached(cacheKey);
    if (cached) return { ...cached, cacheHit: true };

    if (!config.aiServiceEnabled) {
      return { success: false, text: "", lines: [], words: [], logs: ["OCR skipped: AI_SERVICE_ENABLED=false"] };
    }

    log.info("OCR.space API call", { cacheKey });

    // MANDATORY OPENCV PIPELINE
    const { croppedBuffer, mainArea } = await opencvService.processScreenshot(imageBuffer);

    return this.withTempImage(croppedBuffer, async (filePath) => {
      const form = new FormData();
      const file = await fs.readFile(filePath);
      form.append("apikey", config.ocrSpaceApiKey);
      form.append("language", options.language || "eng");
      form.append("isOverlayRequired", "true");
      form.append("OCREngine", "2");
      form.append("file", new Blob([file], { type: "image/png" }), path.basename(filePath));

      const response = await fetch(config.ocrSpaceApiUrl, { method: "POST", body: form });
      const raw = await response.text();
      if (!response.ok) throw new Error(`OCR.space API error (${response.status}): ${raw.slice(0, 500)}`);

      const data = JSON.parse(raw);
      const parsed = data?.ParsedResults || [];
      const text = parsed.map((item) => item.ParsedText || "").join("\n").trim();
      const lines = parsed.flatMap((item) => item.TextOverlay?.Lines || []);
      const words = lines.flatMap((line) => line.Words || []);
      const result = {
        success: !data.IsErroredOnProcessing,
        text,
        lines,
        words,
        raw: data,
        logs: [`OCR: extracted ${text.length} characters`]
      };
      return this.setCached(cacheKey, result);
    });
  }

  async analyzeScreenshot(imageBuffer, options = {}) {
    const cacheKey = this.imageCacheKey("vision", imageBuffer, options.cacheKey);
    const cached = this.getCached(cacheKey);
    if (cached) return { ...cached, cacheHit: true };

    if (!config.aiServiceEnabled) {
      return { success: false, analysis: "", logs: ["Vision skipped: AI_SERVICE_ENABLED=false"] };
    }
    if (!config.huggingFaceApiKey) {
      return { success: false, analysis: "", logs: ["Vision skipped: missing HUGGINGFACE_API_KEY"] };
    }

    const endpoint = `https://api-inference.huggingface.co/models/${config.huggingFaceVisionModel}`;
    log.info("Hugging Face vision API call", { model: config.huggingFaceVisionModel, cacheKey });

    // MANDATORY OPENCV PIPELINE
    const { croppedBuffer, mainArea, regions } = await opencvService.processScreenshot(imageBuffer);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.huggingFaceApiKey}`,
        "Content-Type": "image/png",
        "X-Region-Info": JSON.stringify(mainArea)
      },
      body: croppedBuffer
    });
    const rawText = await response.text();
    if (!response.ok) throw new Error(`Hugging Face API error (${response.status}): ${rawText.slice(0, 500)}`);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = rawText;
    }
    const analysis = Array.isArray(data)
      ? data.map((item) => item.generated_text || item.label || JSON.stringify(item)).join("\n")
      : data?.generated_text || data?.summary_text || rawText;
    const result = {
      success: true,
      analysis: String(analysis || "").trim(),
      raw: data,
      logs: [`VISION: ${config.huggingFaceVisionModel} returned ${String(analysis || "").length} characters`]
    };
    return this.setCached(cacheKey, result);
  }

  async groqDecision(intent, elements, ocrText, visionData) {
    if (!config.aiServiceEnabled) return null;
    if (!config.groqApiKey) return null;

    const compactElements = elements.slice(0, 80).map((el, index) => ({
      index,
      selector: el.selector,
      tag: el.tag,
      label: el.label,
      placeholder: el.placeholder,
      name: el.name,
      type: el.type,
      aria: el.aria,
      text: el.text
    }));

    const prompt = `Choose the best DOM element selector for this automation intent.

Intent: ${JSON.stringify(intent)}

DOM candidates:
${JSON.stringify(compactElements)}

Visual Region context:
${JSON.stringify(visionData?.regions || [])}
Main area: ${JSON.stringify(visionData?.mainArea || {})}

OCR visible text:
${JSON.stringify(String(ocrText || "").slice(0, 2500))}

Vision description:
${JSON.stringify(String(visionData?.analysis || "").slice(0, 2500))}

Return JSON only:
{"selector":"...","confidence":0.0,"reasoning":"short reason"}

Use only selectors that appear in DOM candidates.`;

    log.info("Groq decision API call", { model: config.groqModel, intent });

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.groqApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.groqModel,
        messages: [
          { role: "system", content: "You are a precise browser automation selector matcher. Return valid JSON only." },
          { role: "user", content: prompt }
        ],
        temperature: 0.05,
        max_tokens: 300
      })
    });

    const raw = await response.text();
    if (!response.ok) throw new Error(`Groq API error (${response.status}): ${raw.slice(0, 500)}`);
    const data = JSON.parse(raw);
    const content = data?.choices?.[0]?.message?.content || "";
    return parseJsonLoose(content);
  }

  async decideBestFieldMatch(domData, ocrText = "", visionData = null) {
    const intent = domData?.intent || domData?.query || domData?.fieldName || "";
    const elements = domData?.elements || domData?.domFields || [];
    const logs = [];

    const dom = this.smartMatch(intent, elements, { method: "DOM" });
    logs.push(...dom.logs);
    if (dom.confidence >= config.aiDomConfidenceThreshold) {
      return { ...dom, logs };
    }

    if (ocrText) {
      const ocr = this.smartMatch(intent, elements, { method: "OCR", ocrText });
      logs.push(...ocr.logs);
      if (ocr.confidence >= config.aiOcrConfidenceThreshold) {
        return { ...ocr, logs };
      }
    }

    if (visionData?.analysis) {
      const vision = this.smartMatch(intent, elements, { method: "VISION", ocrText, visionData });
      logs.push(...vision.logs);
      if (vision.confidence >= config.aiVisionConfidenceThreshold) {
        return { ...vision, logs };
      }
    }

    try {
      const ai = await this.groqDecision(intent, elements, ocrText, visionData);
      if (ai?.selector && elements.some((el) => el.selector === ai.selector)) {
        const result = {
          success: true,
          methodUsed: "AI",
          confidence: clamp01(ai.confidence ?? 0.7),
          selectedElement: ai.selector,
          element: elements.find((el) => el.selector === ai.selector),
          logs: [...logs, `AI: Groq selected ${ai.selector} (${ai.confidence ?? "unknown"})`, ai.reasoning || ""].filter(Boolean)
        };
        return result;
      }
    } catch (error) {
      logs.push(`AI: Groq decision failed: ${error.message}`);
      log.warn("Groq decision failed", { error: error.message });
    }

    const fallback = [dom, ocrText ? this.smartMatch(intent, elements, { method: "OCR", ocrText }) : null]
      .filter(Boolean)
      .sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return methodRank[a.methodUsed] - methodRank[b.methodUsed];
      })[0] || dom;

    return {
      ...fallback,
      success: !!fallback.selectedElement,
      logs: [...logs, `WARN: falling back to closest match ${fallback.selectedElement || "none"}`]
    };
  }
}

export const aiService = new AiService();
