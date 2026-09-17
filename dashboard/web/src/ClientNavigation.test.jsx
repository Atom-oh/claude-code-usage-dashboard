import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ClientProvider, useClient } from "./ClientContext.jsx";
import { ConfigProvider } from "./ConfigContext.jsx";
import { useNavigation } from "./components/Sidebar.jsx";

const paths = ["/", "/exec", "/trends", "/productivity", "/usage", "/users", "/cost", "/reliability", "/analytics"];
let current;
function Probe() {
  const client = useClient(), location = useLocation(), navigation = useNavigation();
  current = { ...client, location, navigation };
  return <div>
    <output>{JSON.stringify({ client: client.client, common: client.common, detail: client.detail, path: location.pathname })}</output>
    {["all", "claude", "codex"].map((name) => <button key={name} onClick={() => client.setClient(name)}>{name}</button>)}
    <button onClick={() => client.setDetail(true)}>detail</button>
    <button onClick={() => client.setDetail(false)}>shared</button>
  </div>;
}
function mount(entry, enabledClients = ["claude", "codex"], piiMask = false) {
  return render(<MemoryRouter initialEntries={[entry]}>
    <ConfigProvider config={{ enabledClients, piiMask }}>
      <ClientProvider><Probe /></ClientProvider>
    </ConfigProvider>
  </MemoryRouter>);
}
afterEach(cleanup);

test.each(["all", "claude", "codex"])("all primary pages and navigation are shared for %s", async (client) => {
  for (const path of paths) {
    const view = mount(`${path}?client=${client}&days=7`);
    await waitFor(() => expect(current.location.pathname).toBe(path));
    expect(current.common).toBe(true);
    expect(current.detail).toBe(false);
    expect(current.navigation.items.map((item) => item.to)).toEqual(paths);
    expect(current.navigation.brand).toBe("Claude + Codex");
    view.unmount();
  }
});
test("switching clients retains the route, dates and shared backend/model selectors", async () => {
  mount("/cost?client=codex&days=7&model=gpt&backend=bedrock-mantle&user=person");
  fireEvent.click(screen.getByText("claude", { selector: "button" }));
  await waitFor(() => expect(current.client).toBe("claude"));
  expect(current.location.pathname).toBe("/cost");
  const query = new URLSearchParams(current.location.search);
  expect(query.get("days")).toBe("7");
  expect(query.get("backend")).toBe("bedrock-mantle");
  expect(query.get("model")).toBe("gpt");
  expect(query.get("user")).toBe("person");
});
test("Claude detail is explicit and switching away restores shared mode on the same page", async () => {
  mount("/usage?client=claude&days=7&backend=anthropic");
  expect(typeof current.setDetail).toBe("function");
  fireEvent.click(screen.getByText("detail", { selector: "button" }));
  await waitFor(() => expect(current.detail).toBe(true));
  expect(new URLSearchParams(current.location.search).get("view")).toBe("detail");
  expect(new URLSearchParams(current.location.search).has("backend")).toBe(false);
  fireEvent.click(screen.getByText("codex", { selector: "button" }));
  await waitFor(() => expect(current.client).toBe("codex"));
  expect(current.common).toBe(true);
  expect(current.location.pathname).toBe("/usage");
  expect(new URLSearchParams(current.location.search).has("view")).toBe(false);
});
test("legacy Claude channel links retain their meaning and become explicit detail URLs", async () => {
  mount("/cost?group=enterprise&days=2");
  await waitFor(() => expect(current.client).toBe("claude"));
  expect(current.detail).toBe(true);
  const query = new URLSearchParams(current.location.search);
  expect(query.get("view")).toBe("detail");
  expect(query.get("group")).toBe("enterprise");
  fireEvent.click(screen.getByText("shared", { selector: "button" }));
  await waitFor(() => expect(current.common).toBe(true));
  expect(new URLSearchParams(current.location.search).has("group")).toBe(false);
});
test("disabled clients cannot open detail routes; masking applies during normalization", async () => {
  mount("/cost?client=claude&view=detail&group=enterprise&user=private", ["codex"], true);
  await waitFor(() => expect(current.client).toBe("codex"));
  expect(current.common).toBe(true);
  expect(current.location.pathname).toBe("/cost");
  const query = new URLSearchParams(current.location.search);
  expect(query.has("view")).toBe(false);
  expect(query.has("group")).toBe(false);
  expect(query.has("user")).toBe(false);
});
test("unknown paths normalize equally for both clients", async () => {
  for (const client of ["claude", "codex"]) {
    const view = mount(`/missing?client=${client}`);
    await waitFor(() => expect(current.location.pathname).toBe("/"));
    view.unmount();
  }
});
