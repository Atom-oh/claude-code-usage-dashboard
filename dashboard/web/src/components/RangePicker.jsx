import { useRange } from "../RangeContext.jsx";
import { SegmentedControl } from "./SegmentedControl.jsx";

export function RangePicker() {
  const { days, setDays } = useRange();
  return <SegmentedControl options={[{ value: "7", label: "7일" }, { value: "14", label: "14일" }, { value: "30", label: "30일" }]} value={String(days)} onChange={(v) => setDays(Number(v))} />;
}
