import { useLocation, useNavigate } from "react-router-dom";
import { TaskTraceOverlay } from "../components/TaskTraceOverlay.jsx";
import { parseTaskPath } from "../clientNavigation.js";

// A shared task link (/tasks/<id>/<from>/<to>): the task detail without a user in the
// URL. The server resolves the task's owner; closing returns to the Users page.
export default function SharedTask() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const task = parseTaskPath(pathname);
  const close = () => navigate({ pathname: "/users", search: "" });
  if (!task) return <div className="p-8">
    <h1 className="text-xl font-semibold text-ink-800">작업 상세</h1>
    <p role="alert" className="mt-3 text-sm text-ink-600">작업 링크가 올바르지 않습니다. 링크 전체가 복사됐는지 확인하세요.</p>
  </div>;
  return <div className="p-8">
    <h1 className="text-xl font-semibold text-ink-800">작업 상세</h1>
    <p className="mt-2 text-sm text-ink-600">공유된 작업 링크입니다. 닫으면 Users 페이지로 이동합니다.</p>
    <TaskTraceOverlay key={task.id} taskId={task.id} from={task.from} to={task.to} onClose={close} />
  </div>;
}
