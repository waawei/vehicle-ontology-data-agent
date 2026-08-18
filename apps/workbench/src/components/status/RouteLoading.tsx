export function RouteLoading() {
  return (
    <section className="route-state loading-state" aria-label="页面加载中" aria-busy="true">
      <span className="skeleton heading" />
      <span className="skeleton line" />
      <span className="skeleton surface" />
    </section>
  );
}
