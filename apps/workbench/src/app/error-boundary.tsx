import { Component, type ReactNode } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch() {
    // Production telemetry may record an opaque request ref in W8; payloads stay out of the console.
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-boundary" aria-labelledby="fatal-title">
        <CircleAlert aria-hidden="true" />
        <h1 id="fatal-title">工作台无法显示</h1>
        <p>当前页面发生异常。刷新后将从服务器资源恢复。</p>
        <button type="button" className="command-button" onClick={() => window.location.reload()}>
          <RotateCcw aria-hidden="true" />
          刷新页面
        </button>
      </main>
    );
  }
}
