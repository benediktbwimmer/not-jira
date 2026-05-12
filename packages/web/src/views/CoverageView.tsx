import type { SourceCoverage } from "../types";

export function CoverageView({ coverage }: { coverage: SourceCoverage[] }) {
  return (
    <section className="wide-view">
      <div className="view-heading"><h1>Source Coverage</h1></div>
      <div className="coverage-table">
        <div className="coverage-row header"><span>Source</span><span>Total</span><span>Ready</span><span>Blocked</span><span>Started</span><span>Finished</span></div>
        {coverage.map((row, index) => (
          <div className="coverage-row" key={`${row.sourceDoc ?? "none"}-${row.sourceSection ?? "none"}-${index}`}>
            <span>{row.sourceDoc ?? "No source"} / {row.sourceSection ?? "No section"}</span>
            <span>{row.total}</span>
            <span>{row.ready}</span>
            <span>{row.blocked}</span>
            <span>{row.started}</span>
            <span>{row.finished}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
