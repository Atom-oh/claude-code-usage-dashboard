import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConfigProvider, useConfig } from "./ConfigContext.jsx";

afterEach(cleanup);

function PricingConsumer() {
  const { pricing } = useConfig();
  return <output>{pricing ? `${pricing.cacheWriteTtl}:${pricing.overriddenModels.join(",")}` : "미확인"}</output>;
}

test("runtime pricing assumptions reach consumers without inventing a TTL on old servers", () => {
  const { rerender } = render(
    <ConfigProvider config={{ pricing: { cacheWriteTtl: "5m", overriddenModels: ["custom"] } }}>
      <PricingConsumer />
    </ConfigProvider>
  );
  expect(screen.getByText("5m:custom")).toBeTruthy();
  rerender(<ConfigProvider config={{}}><PricingConsumer /></ConfigProvider>);
  expect(screen.getByText("미확인")).toBeTruthy();
});
