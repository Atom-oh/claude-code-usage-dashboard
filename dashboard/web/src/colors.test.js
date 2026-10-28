import { expect, test } from "vitest";
import { byModelLegendOrder, groupModelColorFor, modelColorFor, modelFamily, modelLegendRank } from "./colors.js";
import { modelColorKey, trendColor } from "./modelCostTrend.js";

const families = [
  ["opus", ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-5"], [8, 32]],
  ["sonnet", ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"], [215, 235]],
  ["haiku", ["claude-haiku-4-5", "claude-haiku-3-5"], [150, 175]],
  ["fable", ["claude-fable-5-1", "claude-fable-5"], [325, 345]],
  ["sol", ["openai.gpt-6.1-sol", "openai.gpt-6-sol", "openai.gpt-5.6-sol"], [30, 45]],
  ["terra", ["openai.gpt-6-terra", "openai.gpt-5.6-terra"], [18, 35]],
  ["luna", ["openai.gpt-6-luna", "openai.gpt-5.6-luna"], [185, 205]],
  ["astra", ["openai.gpt-6-astra", "openai.gpt-6.1-astra"], [255, 280]],
];

function rgb(hex) {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function hue(hex) {
  const [r, g, b] = rgb(hex), hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  const delta = hi - lo;
  const sector = hi === r ? (g - b) / delta : hi === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return ((sector * 60) % 360 + 360) % 360;
}

function contrast(a, b) {
  const luminance = (hex) => rgb(hex).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
}

test.each(families)("recognizes %s models and normalizes regional and version aliases", (family, models) => {
  for (const model of models) {
    expect(modelFamily(model)).toBe(family);
    const regional = model.startsWith("claude") ? `us.anthropic.${model}-v1:0` : `global.${model}[1m]`;
    expect(modelFamily(regional)).toBe(family);
    expect(groupModelColorFor("bedrock", regional)).toBe(groupModelColorFor("bedrock", model));
  }
});

test.each(families)("keeps %s versions separate within one hue across channels and themes", (_family, models, bounds) => {
  for (const [theme, surface] of [["light", "#ffffff"], ["dark", "#171c27"]]) {
    const colors = models.map((model) => groupModelColorFor("bedrock", model, theme));
    expect(new Set(colors).size).toBe(models.length);
    for (const [index, model] of models.entries()) {
      const color = colors[index];
      expect(hue(color)).toBeGreaterThanOrEqual(bounds[0]);
      expect(hue(color)).toBeLessThanOrEqual(bounds[1]);
      expect(contrast(color, surface), `${model} ${theme}`).toBeGreaterThanOrEqual(3);
      expect(groupModelColorFor("enterprise", model, theme)).toBe(color);
      expect(trendColor(modelColorKey(model).key, theme)).toBe(color);
    }
  }
});

test("future versions stay in their family instead of becoming pale backend fallbacks", () => {
  for (const family of ["opus", "sonnet", "haiku", "fable", "sol", "terra", "luna", "astra"]) {
    const model = ["sol", "terra", "luna", "astra"].includes(family)
      ? `openai.gpt-9-${family}` : `claude-${family}-9`;
    const color = groupModelColorFor("bedrock", model);
    expect(modelColorFor(model)).toBe(color);
    expect(contrast(color, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(groupModelColorFor("enterprise", model)).toBe(color);
  }
});

test("other and absent model identities get a visible neutral without guessing their client", () => {
  for (const model of ["", null, "zai.glm-5", "xai.grok-4.6", "custom-sol-model"]) {
    expect(modelFamily(model)).toBeNull();
    const color = groupModelColorFor("bedrock", model);
    const components = rgb(color);
    expect(Math.max(...components) - Math.min(...components)).toBeLessThan(0.2);
    expect(contrast(color, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(groupModelColorFor("enterprise", model)).toBe(color);
  }
});

test("registered version order follows the family registry and normalizes regional aliases", () => {
  for (const versions of [
    ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"],
    ["claude-fable-5-1", "claude-fable-5"],
    ["openai.gpt-6.1-sol", "openai.gpt-6-sol", "openai.gpt-5.6-sol"],
  ]) {
    expect([...versions].reverse().sort(byModelLegendOrder)).toEqual(versions);
  }
  expect(modelLegendRank("us.anthropic.claude-opus-5-5-v1:0")).toBe(modelLegendRank("claude-opus-5-5"));
});
