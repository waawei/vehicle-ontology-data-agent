import { CircleAlert } from "lucide-react";
import { Link, useRouteError } from "react-router-dom";

export function RouteErrorPage() {
  const error = useRouteError();
  const requestRef = error instanceof Error ? error.name : "ROUTE_ERROR";
  return (
    <main className="standalone-route-state" aria-labelledby="route-error-title">
      <CircleAlert aria-hidden="true" />
      <h1 id="route-error-title">页面加载失败</h1>
      <p>请求引用：<code>{requestRef}</code></p>
      <Link className="command-button" to="/">返回分析</Link>
    </main>
  );
}
