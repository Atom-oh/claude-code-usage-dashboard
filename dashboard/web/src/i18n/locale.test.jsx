import React, { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LanguagePicker } from "../components/LanguagePicker.jsx";
import { GuideLink } from "../components/ReleaseLink.jsx";
import { CLIENT_PAGES, USER_GUIDE_URL } from "../clientNavigation.js";
import {
  LOCALES, formatUnit, getLocale, guidePath, localize, localizedMessage, localeStore,
  messageText, richMessage, translate, translateSource, useLocale,
} from "./index.js";
import ko from "./locales/ko.json";

const keyFor = (source) => Object.keys(ko).find((key) => ko[key] === source);

afterEach(async () => {
  cleanup();
  await localeStore.select("ko");
  localStorage.removeItem("ccdash.locale");
});

function StatefulPanel() {
  useLocale();
  const [selected, setSelected] = useState(false);
  const [note, setNote] = useState("");
  const [error] = useState(() => localizedMessage(keyFor("언어")));
  return <>
    <LanguagePicker />
    <button onClick={() => setSelected(true)} data-testid="task">trace-001</button>
    {selected && <section data-testid="open-trace">
      <input aria-label="Raw task note" value={note} onChange={(e) => setNote(e.target.value)} />
      <span data-testid="authored-label">{translateSource("미수집")}</span>
      <span data-testid="stored-message">{messageText(error)}</span>
    </section>}
    <GuideLink />
  </>;
}

it("switches all five languages without remounting an open task or changing entered text", async () => {
  render(<MemoryRouter initialEntries={["/users?days=2&client=claude"]}><StatefulPanel /></MemoryRouter>);
  fireEvent.click(screen.getByTestId("task"));
  const input = screen.getByRole("textbox", { name: "Raw task note" });
  fireEvent.change(input, { target: { value: "사용자 원문 <script> & model-id" } });
  const panel = screen.getByTestId("open-trace");
  for (const locale of ["en", "zh-CN", "ja", "es", "ko"]) {
    fireEvent.change(screen.getByRole("combobox"), { target: { value: locale } });
    await waitFor(() => expect(getLocale()).toBe(locale));
    expect(document.documentElement.lang).toBe(locale);
    expect(screen.getByTestId("open-trace")).toBe(panel);
    expect(input.value).toBe("사용자 원문 <script> & model-id");
    expect(screen.getByTestId("authored-label").textContent).toBe(translateSource("미수집"));
    expect(screen.getByTestId("stored-message").textContent).toBe(translateSource("언어"));
    expect(screen.getByRole("link").getAttribute("href")).toBe(`${USER_GUIDE_URL}${guidePath()}user-guide.html`);
    expect(localStorage.getItem("ccdash.locale")).toBe(locale);
  }
});

it("keeps static record identity and machine fields while resolving current labels", async () => {
  const column = localize({ key: "tokens", label: "토큰" });
  const columns = localize([column]);
  expect(columns[0]).toBe(column);
  expect(localize(columns)).toBe(columns);
  const before = CLIENT_PAGES[0];
  await localeStore.select("es");
  expect(CLIENT_PAGES[0]).toBe(before);
  expect(before.key).toBe("overview");
  expect(before.to).toBe("/");
  expect(column.label).toBe(translateSource("토큰"));
  expect(column.key).toBe("tokens");
  expect(LOCALES.map((item) => item.name)).toEqual(["English", "简体中文", "日本語", "Español", "한국어"]);
});

it("renders rich interpolation as React content without interpreting markup", () => {
  const key = Object.keys(ko).find((item) => ko[item].includes("{0}"));
  render(<div>{richMessage(key, ["<img src=x onerror=alert(1)>"])}</div>);
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
});

it("preserves unknown telemetry values and positional punctuation", async () => {
  await localeStore.select("en");
  expect(translateSource("custom-agent-α")).toBe("custom-agent-α");
  const key = Object.keys(ko).find((item) => ko[item].includes("{0}"));
  expect(translate(key, ["{1} $&"])).toContain("{1} $&");
  expect(formatUnit(1, "day")).toBe("1 day");
  expect(formatUnit(2, "day")).toBe("2 days");
  await localeStore.select("es");
  expect(formatUnit(1, "day")).toBe("1 día");
  expect(formatUnit(2, "day")).toBe("2 días");
});
