/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FIGMA DESIGN GENERATOR — Rule-based design generation (ZERO COST, no AI)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Generates design layout JSON based on page type detection (login, signup,
 * dashboard, landing, etc.). Uses hardcoded design rules and templates.
 *
 * Output format: Figma-compatible node structure that can be:
 *   1. Used as a design spec for implementation
 *   2. Pushed to Figma via the Figma Plugin API (if user has a plugin)
 *   3. Converted to HTML/CSS directly
 */

import { createServiceLogger } from "./loggerService.js";

const log = createServiceLogger("figma-generator");

// ─── Design Tokens ──────────────────────────────────────────────────────────

const DESIGN_TOKENS = {
  colors: {
    primary: { hex: "#6366F1", name: "Indigo 500" },
    primaryDark: { hex: "#4F46E5", name: "Indigo 600" },
    primaryLight: { hex: "#A5B4FC", name: "Indigo 300" },
    secondary: { hex: "#8B5CF6", name: "Violet 500" },
    accent: { hex: "#F59E0B", name: "Amber 500" },
    success: { hex: "#10B981", name: "Emerald 500" },
    error: { hex: "#EF4444", name: "Red 500" },
    warning: { hex: "#F59E0B", name: "Amber 500" },
    background: { hex: "#0F172A", name: "Slate 900" },
    surface: { hex: "#1E293B", name: "Slate 800" },
    surfaceLight: { hex: "#334155", name: "Slate 700" },
    textPrimary: { hex: "#F8FAFC", name: "Slate 50" },
    textSecondary: { hex: "#94A3B8", name: "Slate 400" },
    textMuted: { hex: "#64748B", name: "Slate 500" },
    border: { hex: "#334155", name: "Slate 700" },
    white: { hex: "#FFFFFF", name: "White" }
  },
  typography: {
    heading1: { family: "Inter", size: 36, weight: 700, lineHeight: 1.2 },
    heading2: { family: "Inter", size: 28, weight: 600, lineHeight: 1.3 },
    heading3: { family: "Inter", size: 22, weight: 600, lineHeight: 1.4 },
    body: { family: "Inter", size: 16, weight: 400, lineHeight: 1.5 },
    bodySmall: { family: "Inter", size: 14, weight: 400, lineHeight: 1.5 },
    caption: { family: "Inter", size: 12, weight: 400, lineHeight: 1.4 },
    button: { family: "Inter", size: 16, weight: 600, lineHeight: 1.0 },
    label: { family: "Inter", size: 14, weight: 500, lineHeight: 1.0 }
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
    section: 64
  },
  radius: {
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
    full: 9999
  },
  shadows: {
    sm: { x: 0, y: 1, blur: 2, spread: 0, color: "rgba(0,0,0,0.05)" },
    md: { x: 0, y: 4, blur: 6, spread: -1, color: "rgba(0,0,0,0.1)" },
    lg: { x: 0, y: 10, blur: 15, spread: -3, color: "rgba(0,0,0,0.1)" },
    xl: { x: 0, y: 20, blur: 25, spread: -5, color: "rgba(0,0,0,0.1)" },
    glow: { x: 0, y: 0, blur: 20, spread: 4, color: "rgba(99,102,241,0.15)" }
  }
};

// ─── Node Helpers ───────────────────────────────────────────────────────────

let _nodeIdCounter = 0;
function nextNodeId() {
  return `${++_nodeIdCounter}:${Math.random().toString(36).slice(2, 6)}`;
}

function createFrame(name, props = {}) {
  return {
    id: nextNodeId(),
    name,
    type: "FRAME",
    layoutMode: props.layoutMode || "VERTICAL",
    primaryAxisSizingMode: props.primaryAxisSizingMode || "AUTO",
    counterAxisSizingMode: props.counterAxisSizingMode || "FIXED",
    itemSpacing: props.itemSpacing ?? DESIGN_TOKENS.spacing.md,
    paddingLeft: props.paddingLeft ?? props.padding ?? 0,
    paddingRight: props.paddingRight ?? props.padding ?? 0,
    paddingTop: props.paddingTop ?? props.padding ?? 0,
    paddingBottom: props.paddingBottom ?? props.padding ?? 0,
    absoluteBoundingBox: props.bounds || { x: 0, y: 0, width: props.width || 400, height: props.height || 600 },
    fills: props.fills || [],
    strokes: props.strokes || [],
    effects: props.effects || [],
    cornerRadius: props.cornerRadius ?? 0,
    children: []
  };
}

function createText(name, text, style = "body", overrides = {}) {
  const typo = DESIGN_TOKENS.typography[style] || DESIGN_TOKENS.typography.body;
  const color = overrides.color || DESIGN_TOKENS.colors.textPrimary;
  return {
    id: nextNodeId(),
    name,
    type: "TEXT",
    characters: text,
    style: {
      fontFamily: typo.family,
      fontSize: typo.size,
      fontWeight: typo.weight,
      lineHeightPx: typo.size * typo.lineHeight,
      textAlignHorizontal: overrides.align || "LEFT"
    },
    fills: [{ type: "SOLID", color: hexToRgb(color.hex) }]
  };
}

function createInput(name, placeholder = "", props = {}) {
  return createFrame(name, {
    layoutMode: "HORIZONTAL",
    width: props.width || 360,
    height: 48,
    padding: 12,
    cornerRadius: DESIGN_TOKENS.radius.md,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.surface.hex), opacity: 0.6 }],
    strokes: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.border.hex) }],
    ...props,
    children: [
      createText(`${name}_placeholder`, placeholder, "body", { color: DESIGN_TOKENS.colors.textMuted })
    ]
  });
}

function createButton(name, label, variant = "primary", props = {}) {
  const isPrimary = variant === "primary";
  const bgColor = isPrimary ? DESIGN_TOKENS.colors.primary : DESIGN_TOKENS.colors.surface;
  const textColor = isPrimary ? DESIGN_TOKENS.colors.white : DESIGN_TOKENS.colors.textPrimary;

  const btn = createFrame(name, {
    layoutMode: "HORIZONTAL",
    width: props.width || 360,
    height: 48,
    padding: 12,
    cornerRadius: DESIGN_TOKENS.radius.md,
    fills: [{ type: "SOLID", color: hexToRgb(bgColor.hex) }],
    effects: isPrimary ? [
      { type: "DROP_SHADOW", ...DESIGN_TOKENS.shadows.md },
      { type: "DROP_SHADOW", ...DESIGN_TOKENS.shadows.glow }
    ] : [],
    ...props
  });

  btn.children = [
    createText(`${name}_label`, label, "button", { color: textColor, align: "CENTER" })
  ];

  return btn;
}

function createDivider(name = "Divider") {
  return createFrame(name, {
    layoutMode: "HORIZONTAL",
    width: 360,
    height: 1,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.border.hex), opacity: 0.5 }]
  });
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16) / 255,
    g: parseInt(h.substring(2, 4), 16) / 255,
    b: parseInt(h.substring(4, 6), 16) / 255
  };
}

// ─── Page Type Detection ────────────────────────────────────────────────────

const PAGE_TYPE_PATTERNS = {
  login: [/log\s*in/i, /sign\s*in/i, /auth/i, /session/i],
  signup: [/sign\s*up/i, /register/i, /create\s*account/i, /join/i],
  dashboard: [/dashboard/i, /admin/i, /panel/i, /overview/i, /analytics/i],
  landing: [/landing/i, /home/i, /welcome/i, /hero/i],
  settings: [/settings/i, /preferences/i, /profile/i, /account/i],
  pricing: [/pricing/i, /plans/i, /subscription/i, /billing/i],
  contact: [/contact/i, /support/i, /help/i, /feedback/i]
};

function detectPageType(description) {
  const text = String(description || "").toLowerCase();

  for (const [type, patterns] of Object.entries(PAGE_TYPE_PATTERNS)) {
    if (patterns.some(p => p.test(text))) {
      return type;
    }
  }

  return "generic";
}

// ─── Layout Generators ──────────────────────────────────────────────────────

function generateLoginLayout(options = {}) {
  const { title = "Welcome Back", subtitle = "Sign in to your account" } = options;

  _nodeIdCounter = 0;

  const page = createFrame("Login Page", {
    width: 1440, height: 900,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.background.hex) }]
  });

  // Card Container (centered)
  const card = createFrame("Login Card", {
    width: 440, height: 520,
    padding: 40,
    itemSpacing: 24,
    cornerRadius: DESIGN_TOKENS.radius.xl,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.surface.hex) }],
    strokes: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.border.hex), opacity: 0.3 }],
    effects: [
      { type: "DROP_SHADOW", ...DESIGN_TOKENS.shadows.xl },
      { type: "DROP_SHADOW", ...DESIGN_TOKENS.shadows.glow }
    ]
  });

  // Logo placeholder
  const logo = createFrame("Logo", {
    layoutMode: "HORIZONTAL",
    width: 48, height: 48,
    cornerRadius: DESIGN_TOKENS.radius.lg,
    fills: [{
      type: "GRADIENT_LINEAR",
      gradientStops: [
        { position: 0, color: hexToRgb(DESIGN_TOKENS.colors.primary.hex) },
        { position: 1, color: hexToRgb(DESIGN_TOKENS.colors.secondary.hex) }
      ]
    }]
  });

  card.children.push(logo);
  card.children.push(createText("Title", title, "heading2", { align: "CENTER" }));
  card.children.push(createText("Subtitle", subtitle, "bodySmall", { color: DESIGN_TOKENS.colors.textSecondary, align: "CENTER" }));

  // Form fields
  const form = createFrame("Form", {
    width: 360,
    itemSpacing: 16
  });

  form.children.push(createText("Email Label", "Email Address", "label"));
  form.children.push(createInput("Email Input", "you@example.com"));
  form.children.push(createText("Password Label", "Password", "label"));
  form.children.push(createInput("Password Input", "••••••••"));
  form.children.push(createButton("Login Button", "Sign In", "primary"));
  form.children.push(createDivider("Or Divider"));
  form.children.push(createButton("Google Button", "Continue with Google", "secondary"));

  card.children.push(form);

  // Footer
  card.children.push(createText("Footer", "Don't have an account? Sign up", "caption", {
    color: DESIGN_TOKENS.colors.textMuted,
    align: "CENTER"
  }));

  page.children.push(card);
  return page;
}

function generateSignupLayout(options = {}) {
  const { title = "Create Account", subtitle = "Start your journey today" } = options;

  _nodeIdCounter = 0;

  const page = createFrame("Signup Page", {
    width: 1440, height: 1024,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.background.hex) }]
  });

  const card = createFrame("Signup Card", {
    width: 480, height: 680,
    padding: 40,
    itemSpacing: 20,
    cornerRadius: DESIGN_TOKENS.radius.xl,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.surface.hex) }],
    effects: [{ type: "DROP_SHADOW", ...DESIGN_TOKENS.shadows.xl }]
  });

  card.children.push(createText("Title", title, "heading2", { align: "CENTER" }));
  card.children.push(createText("Subtitle", subtitle, "bodySmall", { color: DESIGN_TOKENS.colors.textSecondary, align: "CENTER" }));

  const form = createFrame("Form", { width: 400, itemSpacing: 14 });

  // Name row (side by side)
  const nameRow = createFrame("Name Row", {
    layoutMode: "HORIZONTAL",
    width: 400,
    itemSpacing: 12
  });
  nameRow.children.push(createInput("First Name", "First Name", { width: 194 }));
  nameRow.children.push(createInput("Last Name", "Last Name", { width: 194 }));
  form.children.push(nameRow);

  form.children.push(createText("Email Label", "Email", "label"));
  form.children.push(createInput("Email Input", "you@example.com"));
  form.children.push(createText("Password Label", "Password", "label"));
  form.children.push(createInput("Password Input", "Create a strong password"));
  form.children.push(createText("Confirm Label", "Confirm Password", "label"));
  form.children.push(createInput("Confirm Input", "Repeat your password"));
  form.children.push(createButton("Signup Button", "Create Account", "primary"));

  card.children.push(form);
  card.children.push(createText("Footer", "Already have an account? Sign in", "caption", {
    color: DESIGN_TOKENS.colors.textMuted, align: "CENTER"
  }));

  page.children.push(card);
  return page;
}

function generateDashboardLayout(options = {}) {
  const { title = "Dashboard" } = options;

  _nodeIdCounter = 0;

  const page = createFrame("Dashboard Page", {
    width: 1440, height: 900,
    layoutMode: "HORIZONTAL",
    itemSpacing: 0,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.background.hex) }]
  });

  // Sidebar
  const sidebar = createFrame("Sidebar", {
    width: 260, height: 900,
    padding: 20,
    itemSpacing: 8,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.surface.hex) }],
    strokes: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.border.hex), opacity: 0.2 }]
  });

  sidebar.children.push(createText("Brand", "⚡ AppName", "heading3"));
  sidebar.children.push(createDivider());

  const navItems = ["Dashboard", "Analytics", "Projects", "Team", "Settings"];
  for (const item of navItems) {
    const navItem = createFrame(`Nav_${item}`, {
      layoutMode: "HORIZONTAL",
      width: 220, height: 44,
      padding: 12,
      cornerRadius: DESIGN_TOKENS.radius.md,
      fills: item === "Dashboard" ? [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.primary.hex), opacity: 0.1 }] : []
    });
    navItem.children.push(createText(`Nav_${item}_Text`, item, "body", {
      color: item === "Dashboard" ? DESIGN_TOKENS.colors.primary : DESIGN_TOKENS.colors.textSecondary
    }));
    sidebar.children.push(navItem);
  }

  page.children.push(sidebar);

  // Main Content
  const main = createFrame("Main Content", {
    width: 1180, height: 900,
    padding: 32,
    itemSpacing: 24
  });

  // Header
  const header = createFrame("Header", {
    layoutMode: "HORIZONTAL",
    width: 1116, height: 60,
    itemSpacing: 16
  });
  header.children.push(createText("Page Title", title, "heading2"));
  main.children.push(header);

  // Stats Row
  const statsRow = createFrame("Stats Row", {
    layoutMode: "HORIZONTAL",
    width: 1116,
    itemSpacing: 16
  });

  const statLabels = [
    { label: "Total Users", value: "12,493", change: "+12.5%" },
    { label: "Revenue", value: "$48,290", change: "+8.2%" },
    { label: "Active Now", value: "573", change: "+3.1%" },
    { label: "Conversion", value: "4.3%", change: "-0.4%" }
  ];

  for (const stat of statLabels) {
    const card = createFrame(`Stat_${stat.label}`, {
      width: 265, height: 120,
      padding: 20,
      itemSpacing: 8,
      cornerRadius: DESIGN_TOKENS.radius.lg,
      fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.surface.hex) }],
      strokes: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.border.hex), opacity: 0.3 }]
    });
    card.children.push(createText(`${stat.label}_label`, stat.label, "bodySmall", { color: DESIGN_TOKENS.colors.textSecondary }));
    card.children.push(createText(`${stat.label}_value`, stat.value, "heading2"));
    card.children.push(createText(`${stat.label}_change`, stat.change, "caption", {
      color: stat.change.startsWith("+") ? DESIGN_TOKENS.colors.success : DESIGN_TOKENS.colors.error
    }));
    statsRow.children.push(card);
  }

  main.children.push(statsRow);

  // Chart placeholder
  const chartArea = createFrame("Chart Area", {
    width: 1116, height: 360,
    padding: 24,
    cornerRadius: DESIGN_TOKENS.radius.lg,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.surface.hex) }]
  });
  chartArea.children.push(createText("Chart Title", "Revenue Overview", "heading3"));
  chartArea.children.push(createText("Chart Placeholder", "[Chart will render here — use a charting library like Recharts or Chart.js]", "bodySmall", { color: DESIGN_TOKENS.colors.textMuted }));
  main.children.push(chartArea);

  page.children.push(main);
  return page;
}

function generateGenericLayout(description, options = {}) {
  _nodeIdCounter = 0;

  const page = createFrame("Generic Page", {
    width: 1440, height: 900,
    padding: 64,
    itemSpacing: 32,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.background.hex) }]
  });

  page.children.push(createText("Title", description || "Page Title", "heading1"));
  page.children.push(createText("Description", "Auto-generated layout. Customize based on your needs.", "body", { color: DESIGN_TOKENS.colors.textSecondary }));

  const card = createFrame("Content Card", {
    width: 800, height: 400,
    padding: 32,
    itemSpacing: 16,
    cornerRadius: DESIGN_TOKENS.radius.xl,
    fills: [{ type: "SOLID", color: hexToRgb(DESIGN_TOKENS.colors.surface.hex) }]
  });
  card.children.push(createText("Card Title", "Content Area", "heading3"));
  card.children.push(createText("Card Body", "Add your content here.", "body", { color: DESIGN_TOKENS.colors.textSecondary }));
  card.children.push(createButton("Action Button", "Get Started", "primary", { width: 200 }));

  page.children.push(card);
  return page;
}

// ─── Service Class ──────────────────────────────────────────────────────────

class FigmaGeneratorService {
  /**
   * Generate a design layout JSON from a page type or description.
   *
   * @param {string} description - e.g. "login page", "dashboard", "signup form"
   * @param {object} [options] - Override options (title, subtitle, etc.)
   * @returns {{ pageType: string, designTokens: object, layout: object, cssHints: object }}
   */
  generateDesign(description, options = {}) {
    const pageType = detectPageType(description);
    log.info("Generating design", { description, detectedType: pageType });

    let layout;
    switch (pageType) {
      case "login":
        layout = generateLoginLayout(options);
        break;
      case "signup":
        layout = generateSignupLayout(options);
        break;
      case "dashboard":
        layout = generateDashboardLayout(options);
        break;
      default:
        layout = generateGenericLayout(description, options);
        break;
    }

    // Generate CSS implementation hints
    const cssHints = this._generateCSSHints(pageType);

    return {
      pageType,
      designTokens: DESIGN_TOKENS,
      layout,
      cssHints,
      nodeCount: this._countNodes(layout),
      tip: `Use these design tokens and layout structure to implement a pixel-perfect ${pageType} page. The layout JSON follows Figma's node structure.`
    };
  }

  /**
   * Convert layout JSON to a flat list of implementation tasks.
   */
  toImplementationPlan(layout) {
    const tasks = [];

    const walk = (node, depth = 0) => {
      if (!node) return;

      if (node.type === "FRAME" && node.children?.length > 0) {
        tasks.push({
          type: "create_container",
          name: node.name,
          depth,
          layout: node.layoutMode,
          width: node.absoluteBoundingBox?.width,
          height: node.absoluteBoundingBox?.height,
          childCount: node.children.length
        });
      } else if (node.type === "TEXT") {
        tasks.push({
          type: "add_text",
          name: node.name,
          depth,
          text: node.characters,
          fontSize: node.style?.fontSize,
          fontWeight: node.style?.fontWeight
        });
      }

      if (node.children) {
        for (const child of node.children) walk(child, depth + 1);
      }
    };

    walk(layout);
    return tasks;
  }

  _countNodes(node) {
    if (!node) return 0;
    let count = 1;
    if (node.children) {
      for (const child of node.children) count += this._countNodes(child);
    }
    return count;
  }

  _generateCSSHints(pageType) {
    const base = {
      fontImport: "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');",
      cssVariables: {
        "--color-primary": DESIGN_TOKENS.colors.primary.hex,
        "--color-primary-dark": DESIGN_TOKENS.colors.primaryDark.hex,
        "--color-secondary": DESIGN_TOKENS.colors.secondary.hex,
        "--color-bg": DESIGN_TOKENS.colors.background.hex,
        "--color-surface": DESIGN_TOKENS.colors.surface.hex,
        "--color-text": DESIGN_TOKENS.colors.textPrimary.hex,
        "--color-text-secondary": DESIGN_TOKENS.colors.textSecondary.hex,
        "--color-border": DESIGN_TOKENS.colors.border.hex,
        "--radius-md": `${DESIGN_TOKENS.radius.md}px`,
        "--radius-lg": `${DESIGN_TOKENS.radius.lg}px`,
        "--radius-xl": `${DESIGN_TOKENS.radius.xl}px`,
        "--shadow-md": "0 4px 6px -1px rgba(0,0,0,0.1)",
        "--shadow-glow": "0 0 20px 4px rgba(99,102,241,0.15)"
      }
    };

    if (pageType === "login" || pageType === "signup") {
      base.layoutHint = "Center the card vertically and horizontally using flexbox: display:flex; justify-content:center; align-items:center; min-height:100vh;";
    } else if (pageType === "dashboard") {
      base.layoutHint = "Use CSS Grid or flexbox with sidebar: grid-template-columns: 260px 1fr; or display:flex;";
    }

    return base;
  }
}

export const figmaGeneratorService = new FigmaGeneratorService();
