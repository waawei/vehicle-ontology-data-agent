import { FileQuestion } from "lucide-react";
import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <section className="route-state" aria-labelledby="not-found-title">
      <div className="state-icon danger"><FileQuestion aria-hidden="true" /></div>
      <p className="eyebrow">404</p>
      <h2 id="not-found-title">页面未找到</h2>
      <p>此地址不属于当前 Workbench 路由。</p>
      <Link className="command-button secondary" to="/">返回分析</Link>
    </section>
  );
}
