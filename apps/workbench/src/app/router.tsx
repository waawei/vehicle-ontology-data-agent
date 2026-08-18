import { lazy, Suspense, type ReactElement } from "react";
import { createBrowserRouter } from "react-router-dom";
import { WorkbenchShell } from "../components/layout/WorkbenchShell";
import { RouteErrorPage } from "../components/status/RouteErrorPage";
import { RouteLoading } from "../components/status/RouteLoading";

const NotFoundPage = lazy(() => import("../pages/NotFoundPage"));
const AgentWorkbench = lazy(() => import("../features/agent/AgentWorkbench"));

function suspended(element: ReactElement) {
  return <Suspense fallback={<RouteLoading />}>{element}</Suspense>;
}

export const workbenchRouter = createBrowserRouter([
  {
    path: "/",
    element: <WorkbenchShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: suspended(<AgentWorkbench />) },
      { path: "agent", element: suspended(<AgentWorkbench />) },
      { path: "agent/skills", element: suspended(<AgentWorkbench />) },
      { path: "agent/archived", element: suspended(<AgentWorkbench />) },
      { path: "agent/workspace", element: suspended(<AgentWorkbench />) },
      { path: "agent/ontology", element: suspended(<AgentWorkbench />) },
      { path: "agent/:threadId", element: suspended(<AgentWorkbench />) },
      { path: "*", element: suspended(<NotFoundPage />) },
    ],
  },
]);
