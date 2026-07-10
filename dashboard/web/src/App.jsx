import { Route, Routes } from "react-router-dom";
import { RangeProvider } from "./RangeContext.jsx";
import { FilterProvider } from "./FilterContext.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { FilterBar } from "./components/FilterBar.jsx";
import { FloatingChat } from "./components/FloatingChat.jsx";
import Overview from "./pages/Overview.jsx";
import Executive from "./pages/Executive.jsx";
import Trends from "./pages/Trends.jsx";
import Productivity from "./pages/Productivity.jsx";
import Usage from "./pages/Usage.jsx";
import Users from "./pages/Users.jsx";
import Cost from "./pages/Cost.jsx";
import Analytics from "./pages/Analytics.jsx";

export default function App() {
  return (
    <RangeProvider>
      <FilterProvider>
        <div className="flex h-screen">
          <Sidebar />
          <main className="flex-1 overflow-y-auto animate-fade-in">
            <div className="px-8 py-2.5 bg-chrome border-b border-chrome-border">
              <FilterBar />
            </div>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/exec" element={<Executive />} />
              <Route path="/trends" element={<Trends />} />
              <Route path="/productivity" element={<Productivity />} />
              <Route path="/usage" element={<Usage />} />
              <Route path="/users" element={<Users />} />
              <Route path="/cost" element={<Cost />} />
              <Route path="/analytics" element={<Analytics />} />
            </Routes>
          </main>
        </div>
        <FloatingChat />
      </FilterProvider>
    </RangeProvider>
  );
}
