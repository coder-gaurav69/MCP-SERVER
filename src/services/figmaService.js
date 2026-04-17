import { config } from "../config.js";

class FigmaService {
  isConfigured() {
    return Boolean(config.figmaApiToken);
  }

  ensureConfigured() {
    if (!this.isConfigured()) {
      throw new Error("Figma not configured. Set FIGMA_API_TOKEN in .env.");
    }
  }

  parseFileKey(input) {
    const value = String(input || "").trim();
    if (!value) {
      throw new Error("Missing Figma file key or URL.");
    }

    // Raw file key.
    if (/^[a-zA-Z0-9]{22,}$/.test(value)) {
      return value;
    }

    // Common URL patterns:
    // https://www.figma.com/file/<key>/...
    // https://www.figma.com/design/<key>/...
    const match = value.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/i);
    if (match?.[1]) {
      return match[1];
    }

    throw new Error("Invalid Figma file key/URL format.");
  }

  toNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  async figmaGet(pathname, searchParams = {}) {
    this.ensureConfigured();

    const url = new URL(`${config.figmaApiBaseUrl}${pathname}`);
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Figma-Token": config.figmaApiToken
      }
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.err || payload?.message || response.statusText;
      throw new Error(`Figma API error (${response.status}): ${detail}`);
    }
    return payload;
  }

  async getFile({ fileKeyOrUrl, depth = 3, ids, version }) {
    const fileKey = this.parseFileKey(fileKeyOrUrl);
    const safeDepth = this.toNumber(depth, 3);
    const data = await this.figmaGet(`/files/${fileKey}`, {
      depth: safeDepth,
      ids,
      version
    });

    return {
      fileKey,
      name: data?.name || "",
      lastModified: data?.lastModified || "",
      thumbnailUrl: data?.thumbnailUrl || "",
      version: data?.version || "",
      role: data?.role || "",
      editorType: data?.editorType || "",
      schemaVersion: data?.schemaVersion || 0,
      branches: Array.isArray(data?.branches) ? data.branches : [],
      document: data?.document || null
    };
  }

  async getNodes({ fileKeyOrUrl, nodeIds }) {
    const fileKey = this.parseFileKey(fileKeyOrUrl);
    const ids = Array.isArray(nodeIds) ? nodeIds.join(",") : String(nodeIds || "");
    if (!ids.trim()) {
      throw new Error("nodeIds is required (comma-separated string or array).");
    }

    const data = await this.figmaGet(`/files/${fileKey}/nodes`, { ids });
    return {
      fileKey,
      nodes: data?.nodes || {}
    };
  }

  async getDesignContext({ fileKeyOrUrl, nodeIds, depth = 4 }) {
    const file = await this.getFile({ fileKeyOrUrl, depth });
    const nodeResult = nodeIds ? await this.getNodes({ fileKeyOrUrl, nodeIds }) : null;

    const pick = (node) => {
      if (!node || typeof node !== "object") return null;
      return {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: node.visible,
        opacity: node.opacity,
        absoluteBoundingBox: node.absoluteBoundingBox,
        fills: node.fills,
        strokes: node.strokes,
        cornerRadius: node.cornerRadius,
        rectangleCornerRadii: node.rectangleCornerRadii,
        effects: node.effects,
        constraints: node.constraints,
        layoutMode: node.layoutMode,
        primaryAxisSizingMode: node.primaryAxisSizingMode,
        counterAxisSizingMode: node.counterAxisSizingMode,
        itemSpacing: node.itemSpacing,
        paddingLeft: node.paddingLeft,
        paddingRight: node.paddingRight,
        paddingTop: node.paddingTop,
        paddingBottom: node.paddingBottom,
        characters: node.characters,
        style: node.style,
        childrenCount: Array.isArray(node.children) ? node.children.length : 0
      };
    };

    const rootChildren = Array.isArray(file?.document?.children) ? file.document.children : [];
    const topFrames = rootChildren.slice(0, 20).map(pick).filter(Boolean);

    const requestedNodes = nodeResult
      ? Object.fromEntries(
          Object.entries(nodeResult.nodes).map(([id, wrapper]) => [id, pick(wrapper?.document)])
        )
      : {};

    return {
      file: {
        key: file.fileKey,
        name: file.name,
        lastModified: file.lastModified,
        version: file.version
      },
      topFrames,
      requestedNodes
    };
  }

  getNodeListFromFile(fileDocument) {
    const out = [];
    const walk = (node, level = 0) => {
      if (!node || typeof node !== "object") return;
      out.push({
        id: node.id,
        name: node.name,
        type: node.type,
        level,
        layoutMode: node.layoutMode,
        itemSpacing: node.itemSpacing,
        fills: Array.isArray(node.fills) ? node.fills.length : 0,
        strokes: Array.isArray(node.strokes) ? node.strokes.length : 0,
        effects: Array.isArray(node.effects) ? node.effects.length : 0,
        hasText: typeof node.characters === "string" && node.characters.trim().length > 0
      });
      if (Array.isArray(node.children)) {
        for (const child of node.children) walk(child, level + 1);
      }
    };
    walk(fileDocument, 0);
    return out;
  }

  inferTechTasks(nodes, framework = "react-tailwind") {
    const componentCandidates = nodes.filter((n) =>
      ["COMPONENT", "INSTANCE", "COMPONENT_SET", "FRAME"].includes(n.type)
    );
    const textNodes = nodes.filter((n) => n.hasText);
    const autoLayoutNodes = nodes.filter((n) => n.layoutMode && n.layoutMode !== "NONE");
    const effectNodes = nodes.filter((n) => (n.effects || 0) > 0);

    return [
      {
        id: "structure",
        title: "Build page layout structure",
        detail: `Create top-level frames/sections as ${framework} containers using Figma frame hierarchy.`,
        basedOn: `frames=${componentCandidates.length}`
      },
      {
        id: "components",
        title: "Create reusable components",
        detail: "Convert Figma components/instances to reusable UI components with props for variants/states.",
        basedOn: `components=${componentCandidates.length}`
      },
      {
        id: "typography",
        title: "Implement typography system",
        detail: "Map text styles to semantic tokens/classes and ensure consistent heading/body scales.",
        basedOn: `textNodes=${textNodes.length}`
      },
      {
        id: "layout",
        title: "Map Auto Layout to CSS/Flex",
        detail: "Translate Figma Auto Layout direction/spacing/padding into flex layouts and spacing utilities.",
        basedOn: `autoLayoutNodes=${autoLayoutNodes.length}`
      },
      {
        id: "visual-effects",
        title: "Add shadows/borders/radius fidelity",
        detail: "Apply effects, border radii, and strokes to match visual depth and shape fidelity.",
        basedOn: `effectNodes=${effectNodes.length}`
      }
    ];
  }

  async buildClonePlan({ fileKeyOrUrl, nodeIds, depth = 4, framework = "react-tailwind" }) {
    const context = await this.getDesignContext({ fileKeyOrUrl, nodeIds, depth });
    const file = await this.getFile({ fileKeyOrUrl, depth });
    const nodes = this.getNodeListFromFile(file.document);
    const tasks = this.inferTechTasks(nodes, framework);

    const selectedNodeIds = nodeIds
      ? (Array.isArray(nodeIds) ? nodeIds : String(nodeIds).split(",")).map((x) => String(x).trim()).filter(Boolean)
      : [];

    const verificationChecklist = [
      "Visual parity check against Figma frames (spacing, alignment, sizing).",
      "Typography parity check (font size, weight, line height, letter spacing).",
      "Color and effect parity check (fills, strokes, shadows, opacity).",
      "Responsive behavior parity check for key breakpoints.",
      "Interaction/state parity check (hover, active, disabled, focus)."
    ];

    const executionOrder = [
      "Extract design context and node-specific details.",
      "Generate design tokens (colors, typography, spacing, radii, shadows).",
      "Implement base layout and frame structure.",
      "Implement reusable components and variants.",
      "Wire interactions and final visual polish.",
      "Run verification checklist and iterate."
    ];

    return {
      file: context.file,
      selectedNodeIds,
      framework,
      summary: {
        totalNodes: nodes.length,
        topFrames: context.topFrames.length,
        requestedNodes: Object.keys(context.requestedNodes || {}).length
      },
      topFrames: context.topFrames,
      requestedNodes: context.requestedNodes,
      implementationPlan: {
        executionOrder,
        tasks
      },
      verificationChecklist
    };
  }
}

export const figmaService = new FigmaService();
