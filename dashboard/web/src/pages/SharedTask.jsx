import { translate, useLocale } from "../i18n/index.js";
import { useLocation, useNavigate } from "react-router-dom";
import { TaskTraceOverlay } from "../components/TaskTraceOverlay.jsx";
import { parseTaskPath } from "../clientNavigation.js";

// A shared task link (/tasks/<id>/<from>/<to>): the task detail without a user in the
// URL. The server resolves the task's owner; closing returns to the Users page.
export default function SharedTask() {
  const _locale = useLocale();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const task = parseTaskPath(pathname);
  const close = () => navigate({ pathname: "/users", search: "" });
  if (!task) return <div className="p-8">
    <h1 className="text-xl font-semibold text-ink-800">{translate("m0c844f6030e9")}</h1>
    <p role="alert" className="mt-3 text-sm text-ink-600">{translate("m5af7533f0efe")}</p>
  </div>;
  return <div className="p-8">
    <h1 className="text-xl font-semibold text-ink-800">{translate("m0c844f6030e9")}</h1>
    <p className="mt-2 text-sm text-ink-600">{translate("m06228e38e028")}</p>
    <TaskTraceOverlay key={task.id} taskId={task.id} from={task.from} to={task.to} onClose={close} />
  </div>;
}
