import { Route, Routes } from "react-router-dom";
import { RefreshProvider } from "./RefreshContext.jsx";
import { RangeProvider } from "./RangeContext.jsx";
import { FilterProvider } from "./FilterContext.jsx";
import { FreshnessProvider } from "./FreshnessContext.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { MobileNav } from "./components/MobileNav.jsx";
import { FilterBar } from "./components/FilterBar.jsx";
import { FloatingChat } from "./components/FloatingChat.jsx";
import FreshnessBanner from "./components/FreshnessBanner.jsx";
import Overview from "./pages/Overview.jsx";
import Executive from "./pages/Executive.jsx";
import Trends from "./pages/Trends.jsx";
import Productivity from "./pages/Productivity.jsx";
import Usage from "./pages/Usage.jsx";
import Users from "./pages/Users.jsx";
import Cost from "./pages/Cost.jsx";
import Analytics from "./pages/Analytics.jsx";
import Reliability from "./pages/Reliability.jsx";
import Clients from "./pages/Clients.jsx";
import { ClientProvider, useClient } from "./ClientContext.jsx";
import { CLIENT_PAGES } from "./clientNavigation.js";

export default function App() {
  return <ClientProvider><Dashboard /></ClientProvider>;
}

function Dashboard() {
  const { common } = useClient();
  return (
    <RefreshProvider>
      <RangeProvider>
        <FilterProvider>
          <FreshnessProvider>
            <div className="flex h-screen flex-col lg:flex-row">
              <MobileNav />
              <Sidebar />
              <main className="min-w-0 flex-1 overflow-y-auto animate-fade-in">
                <FreshnessBanner className="mx-8 mt-3" />
                <div className="px-8 py-2.5 bg-chrome border-b border-chrome-border">
                  <FilterBar />
                </div>
                {common ? <Routes>
                  {CLIENT_PAGES.map((page) => <Route key={page.key} path={page.to} element={<Clients page={page.key} />} />)}
                  <Route path="*" element={<Clients page="overview" />} />
                </Routes> : <Routes>
                  <Route path="/" element={<Overview />} />
                  <Route path="/exec" element={<Executive />} />
                  <Route path="/trends" element={<Trends />} />
                  <Route path="/productivity" element={<Productivity />} />
                  <Route path="/usage" element={<Usage />} />
                  <Route path="/users" element={<Users />} />
                  <Route path="/cost" element={<Cost />} />
                  <Route path="/reliability" element={<Reliability />} />
                  <Route path="/analytics" element={<Analytics />} />
                </Routes>}
              </main>
            </div>
            {!common && <FloatingChat />}
          </FreshnessProvider>
        </FilterProvider>
      </RangeProvider>
    </RefreshProvider>
  );
}
