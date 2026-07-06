import { Route, Routes } from "react-router-dom";
import { RangeProvider } from "./RangeContext.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import Overview from "./pages/Overview.jsx";
import Productivity from "./pages/Productivity.jsx";
import Usage from "./pages/Usage.jsx";
import Users from "./pages/Users.jsx";
import Cost from "./pages/Cost.jsx";

export default function App() {
  return (
    <RangeProvider>
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 overflow-y-auto animate-fade-in">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/productivity" element={<Productivity />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="/users" element={<Users />} />
            <Route path="/cost" element={<Cost />} />
          </Routes>
        </main>
      </div>
    </RangeProvider>
  );
}
