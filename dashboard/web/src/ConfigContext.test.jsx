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

function ClientConsumer() {
  const { enabledClients, codexEndpoint } = useConfig();
  return <output>{JSON.stringify({ enabledClients, codexEndpoint })}</output>;
}

test.each([
  [{}, ["claude"], "mantle"],
  [{ enabledClients: ["claude"] }, ["claude"], "mantle"],
  [{ enabledClients: ["codex"], codexEndpoint: "runtime" }, ["codex"], "runtime"],
  [{ enabledClients: ["claude", "codex"] }, ["claude", "codex"], "mantle"],
])("exposes client activation with backward-compatible defaults: %j", (config, enabledClients, codexEndpoint) => {
  render(<ConfigProvider config={config}><ClientConsumer /></ConfigProvider>);
  expect(JSON.parse(screen.getByRole("status").textContent)).toEqual({ enabledClients, codexEndpoint });
});
