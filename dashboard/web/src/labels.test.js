import { expect, test } from "vitest";
import { effortLabel, unclassifiedLabel, decisionLabel } from "./labels.js";

test("effortLabel maps unknown/empty/nullish to 미지정, passes through everything else", () => {
  expect(effortLabel("unknown")).toBe("미지정");
  expect(effortLabel("")).toBe("미지정");
  expect(effortLabel(null)).toBe("미지정");
  expect(effortLabel(undefined)).toBe("미지정");
  expect(effortLabel("high")).toBe("high");
  expect(effortLabel("xhigh")).toBe("xhigh");
});

test("unclassifiedLabel maps unknown/empty/nullish to 미분류, passes through everything else", () => {
  expect(unclassifiedLabel("unknown")).toBe("미분류");
  expect(unclassifiedLabel("")).toBe("미분류");
  expect(unclassifiedLabel(null)).toBe("미분류");
  expect(unclassifiedLabel(undefined)).toBe("미분류");
  expect(unclassifiedLabel("bedrock")).toBe("bedrock");
  expect(unclassifiedLabel("enterprise")).toBe("enterprise");
});

// decisionLabel deliberately does NOT fold ""/null/undefined to a label, unlike the other two
// helpers above — a tool-decision row always carries a real decision value, and folding an
// empty one would invent a verdict that was never made.
test("decisionLabel maps accept/reject to 수락/거부, passes through everything else including empty/nullish", () => {
  expect(decisionLabel("accept")).toBe("수락");
  expect(decisionLabel("reject")).toBe("거부");
  expect(decisionLabel("unknown")).toBe("unknown");
  expect(decisionLabel("")).toBe("");
  expect(decisionLabel(null)).toBe(null);
  expect(decisionLabel(undefined)).toBe(undefined);
});
