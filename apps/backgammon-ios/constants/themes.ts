export type Theme = {
  // Background tiers
  bg: string;
  bgDeepest: string;
  surface: string;
  surfaceLight: string;
  bgSubtle: string;

  // Text hierarchy
  text: string;
  textSecondary: string;
  textMuted: string;
  textFaint: string;

  // Accent
  accent: string;
  accentLight: string;
  accentDark: string;
  accentFg: string;

  // Burgundy
  burgundy: string;
  burgundyLight: string;

  // Semantic
  green: string;
  red: string;
  gold: string;
  warning: string;

  // Board
  white: string;
  black: string;
  whiteBorder: string;
  blackBorder: string;
  feltDark: string;
  feltLight: string;
  boardBar: string;
  pointLight: string;
  pointDark: string;
  boardHighlight: string;

  // Dice
  dieWhiteFace: string;
  dieWhiteStroke: string;
  dieWhiteDot: string;
  dieBlackFace: string;
  dieBlackStroke: string;
  dieBlackDot: string;

  // Borders
  border: string;
  borderStrong: string;

  // Misc
  overlay: string;
};

export type ThemeName = "dark" | "light" | "lux";

export const darkTheme: Theme = {
  // Background tiers
  bg: "#0A0E08",
  bgDeepest: "#040604",
  surface: "#141A12",
  surfaceLight: "#1E241C",
  bgSubtle: "#2A3026",

  // Text hierarchy
  text: "#ECE8E0",
  textSecondary: "#B0AAA0",
  textMuted: "#787268",
  textFaint: "#5A5850",

  // Accent (burgundy)
  accent: "#581428",
  accentLight: "#6B2D3E",
  accentDark: "#3A0C1A",
  accentFg: "#ECE8E0",

  // Burgundy
  burgundy: "#882040",
  burgundyLight: "#A83858",

  // Semantic
  green: "#60A860",
  red: "#CC4444",
  gold: "#D4A843",
  warning: "#FBBF24",

  // Board
  white: "#DCD8D0",
  black: "#8A2040",
  whiteBorder: "#A8A098",
  blackBorder: "#A04060",
  feltDark: "#2D5A28",
  feltLight: "#3A6B35",
  boardBar: "#2A2118",
  pointLight: "#E8C78A",
  pointDark: "#A0522D",
  boardHighlight: "rgba(88, 20, 40, 0.25)",

  // Dice
  dieWhiteFace: "#DCD8D0",
  dieWhiteStroke: "#B8B4AC",
  dieWhiteDot: "#2A2018",
  dieBlackFace: "#8A2040",
  dieBlackStroke: "#8A2840",
  dieBlackDot: "#DCD8D0",

  // Borders
  border: "#2A3026",
  borderStrong: "#3A4036",

  // Misc
  overlay: "rgba(0, 0, 0, 0.6)",
};

export const lightTheme: Theme = {
  // Background tiers
  bg: "#F5F1EB",
  bgDeepest: "#E8E2D8",
  surface: "#FFFFFF",
  surfaceLight: "#FFFFFF",
  bgSubtle: "#E0DAD0",

  // Text hierarchy
  text: "#1A1814",
  textSecondary: "#4A4640",
  textMuted: "#6B6560",
  textFaint: "#7D776C",

  // Accent
  accent: "#7A1830",
  accentLight: "#8E2C44",
  accentDark: "#5C1024",
  accentFg: "#FFFFFF",

  // Burgundy
  burgundy: "#882040",
  burgundyLight: "#A83858",

  // Semantic
  green: "#60A860",
  red: "#CC4444",
  gold: "#806410",
  warning: "#FBBF24",

  // Board
  white: "#F0EDE5",
  black: "#8B2252",
  whiteBorder: "#C8C0B4",
  blackBorder: "#6B1A3A",
  feltDark: "#2D5A28",
  feltLight: "#3A6B35",
  boardBar: "#6B5B45",
  pointLight: "#E8C78A",
  pointDark: "#A0522D",
  boardHighlight: "rgba(122, 24, 48, 0.15)",

  // Dice
  dieWhiteFace: "#F0EDE5",
  dieWhiteStroke: "#C8C0B4",
  dieWhiteDot: "#2A2018",
  dieBlackFace: "#8B2252",
  dieBlackStroke: "#A03060",
  dieBlackDot: "#F0EDE5",

  // Borders
  border: "#C4BCB0",
  borderStrong: "#766E62",

  // Misc
  overlay: "rgba(0, 0, 0, 0.4)",
};

export const luxTheme: Theme = {
  // Background tiers
  bg: "#3A0C1A",
  bgDeepest: "#2A0A16",
  surface: "#481220",
  surfaceLight: "#581428",
  bgSubtle: "#6B2D3E",

  // Text hierarchy
  text: "#E8B84A",
  textSecondary: "#D4A843",
  textMuted: "#B8922E",
  textFaint: "#A08850",

  // Accent (gold)
  accent: "#C5973E",
  accentLight: "#D4A843",
  accentDark: "#A07828",
  accentFg: "#2A0A16",

  // Burgundy
  burgundy: "#882040",
  burgundyLight: "#A83858",

  // Semantic
  green: "#60A860",
  red: "#CC4444",
  gold: "#D0A848",
  warning: "#FBBF24",

  // Board
  white: "#F5F0E0",
  black: "#9A1830",
  whiteBorder: "#D4C8B0",
  blackBorder: "#B83050",
  feltDark: "#2D5A28",
  feltLight: "#3A6B35",
  boardBar: "#2A2118",
  pointLight: "#C9A84C",
  pointDark: "#8B6914",
  boardHighlight: "rgba(197, 151, 62, 0.2)",

  // Dice
  dieWhiteFace: "#F5F0E0",
  dieWhiteStroke: "#D4C8B0",
  dieWhiteDot: "#2A0A16",
  dieBlackFace: "#9A1830",
  dieBlackStroke: "#B83050",
  dieBlackDot: "#F5F0E0",

  // Borders
  border: "#6B2D3E",
  borderStrong: "#882040",

  // Misc
  overlay: "rgba(0, 0, 0, 0.6)",
};
