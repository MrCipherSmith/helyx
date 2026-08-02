import { useState, useEffect } from "react";
import { api, type Session, type GitHubPR, type GitHubReview, type GitHubComment, type GitHubCheckRun } from "../api";
import { errorMessage } from "../utils/errors";

interface Props { session: Session }

type Filter = "all" | "ready" | "draft";
type AuthorFilter = "me" | "all";

const CONCLUSION_COLOR: Record<string, string> = {
  success: "text-green-500",
  failure: "text-red-500",
  timed_out: "text-red-500",
  action_required: "text-orange-500",
  cancelled: "text-gray-400",
  skipped: "text-gray-400",
  neutral: "text-gray-400",
};

const CONCLUSION_ICON: Record<string, string> = {
  success: "✓",
  failure: "✗",
  timed_out: "⏱",
  action_required: "!",
  cancelled: "○",
  skipped: "–",
  neutral: "○",
};

const REVIEW_STATE_COLOR: Record<string, string> = {
  APPROVED: "text-green-500",
  CHANGES_REQUESTED: "text-red-500",
  COMMENTED: "opacity-60",
  DISMISSED: "opacity-40",
};

const REVIEW_STATE_ICON: Record<string, string> = {
  APPROVED: "✓",
  CHANGES_REQUESTED: "✗",
  COMMENTED: "💬",
  DISMISSED: "○",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// --- PR Detail panel ---
function PRDetail({
  sessionId,
  pr,
  onBack,
}: {
  sessionId: number;
  pr: GitHubPR;
  onBack: () => void;
}) {
  const [data, setData] = useState<{ reviews: GitHubReview[]; comments: GitHubComment[]; checks: GitHubCheckRun[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "checks" | "comments">("overview");

  // Same render-time reset as the list: `loading` must flip before the fetch,
  // not one frame into it, or the previous PR's detail shows through.
  const [renderedPr, setRenderedPr] = useState(pr.number);
  if (renderedPr !== pr.number) {
    setRenderedPr(pr.number);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    api.git.prDetail(sessionId, pr.number)
      .then((d) => { if (!cancelled) setData({ reviews: d.reviews, comments: d.comments, checks: d.checks }) })
      .catch(() => { if (!cancelled) setData(null) })
      .finally(() => { if (!cancelled) setLoading(false) });
    return () => { cancelled = true };
  }, [sessionId, pr.number]);

  const significantReviews = data?.reviews.filter((r) => r.state !== "COMMENTED" || r.body.trim()) ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-black/10 shrink-0"
        style={{ background: "var(--tg-secondary-bg)" }}>
        <button onClick={onBack} className="text-sm opacity-60 hover:opacity-100 shrink-0">←</button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {pr.draft
              ? <span className="text-xs px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-400 shrink-0">Draft</span>
              : <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-500 shrink-0">Open</span>}
            <span className="text-xs font-mono opacity-50 shrink-0">#{pr.number}</span>
          </div>
          <div className="text-sm font-medium leading-tight truncate">{pr.title}</div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex border-b border-black/10 shrink-0" style={{ background: "var(--tg-secondary-bg)" }}>
        {(["overview", "checks", "comments"] as const).map((t) => {
          const label = t === "overview" ? "Overview" : t === "checks" ? `Checks ${data ? `(${data.checks.length})` : ""}` : `Comments ${data ? `(${data.comments.length + significantReviews.length})` : ""}`;
          return (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`flex-1 py-2 text-xs font-medium ${activeTab === t ? "text-[var(--tg-button)] border-b-2 border-[var(--tg-button)]" : "opacity-50"}`}>
              {label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {loading && <div className="text-xs opacity-50 text-center py-8">Loading…</div>}

        {/* Overview tab */}
        {!loading && activeTab === "overview" && (
          <>
            {/* Meta */}
            <div className="flex flex-wrap gap-3 text-xs opacity-60">
              <span>👤 {pr.author}</span>
              <span>🌿 {pr.head} → {pr.base}</span>
              <span>🕐 {timeAgo(pr.created_at)}</span>
              {(pr.additions !== undefined) && (
                <span>
                  <span className="text-green-500">+{pr.additions}</span>{" "}
                  <span className="text-red-400">−{pr.deletions}</span>{" "}
                  in {pr.changed_files} files
                </span>
              )}
            </div>

            {/* Checks summary in overview */}
            {data && data.checks.length > 0 && (
              <div className="rounded-lg p-2 space-y-1.5" style={{ background: "var(--tg-secondary-bg)" }}>
                <div className="text-xs font-medium opacity-70 mb-1">CI Status</div>
                {data.checks.slice(0, 5).map((cr) => (
                  <div key={cr.id} className="flex items-center gap-2 text-xs">
                    <span className={`shrink-0 font-mono ${cr.status !== "completed" ? "text-yellow-500" : CONCLUSION_COLOR[cr.conclusion ?? ""] ?? "opacity-50"}`}>
                      {cr.status !== "completed" ? "⏳" : CONCLUSION_ICON[cr.conclusion ?? ""] ?? "○"}
                    </span>
                    <span className="truncate opacity-80">{cr.name}</span>
                  </div>
                ))}
                {data.checks.length > 5 && <div className="text-xs opacity-40">+{data.checks.length - 5} more</div>}
              </div>
            )}

            {/* Reviews summary */}
            {data && significantReviews.length > 0 && (
              <div className="rounded-lg p-2 space-y-2" style={{ background: "var(--tg-secondary-bg)" }}>
                <div className="text-xs font-medium opacity-70 mb-1">Reviews</div>
                {significantReviews.map((r) => (
                  <div key={r.id} className="flex items-start gap-2 text-xs">
                    <span className={`shrink-0 font-bold ${REVIEW_STATE_COLOR[r.state] ?? ""}`}>
                      {REVIEW_STATE_ICON[r.state] ?? "?"}
                    </span>
                    <div className="min-w-0">
                      <span className="font-medium">{r.author}</span>
                      {r.body && <p className="opacity-70 mt-0.5 line-clamp-2 whitespace-pre-wrap">{r.body}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* PR body */}
            {pr.body && (
              <div className="text-xs opacity-70 whitespace-pre-wrap leading-relaxed">
                {pr.body.slice(0, 1500)}{pr.body.length > 1500 ? "…" : ""}
              </div>
            )}
          </>
        )}

        {/* Checks tab */}
        {!loading && activeTab === "checks" && data && (
          data.checks.length === 0
            ? <div className="text-xs opacity-50 text-center py-8">No checks</div>
            : data.checks.map((cr) => (
              <div key={cr.id} className="flex items-center gap-2 text-xs p-2 rounded-lg"
                style={{ background: "var(--tg-secondary-bg)" }}>
                <span className={`shrink-0 font-mono text-sm ${cr.status !== "completed" ? "text-yellow-500" : CONCLUSION_COLOR[cr.conclusion ?? ""] ?? "opacity-50"}`}>
                  {cr.status !== "completed" ? "⏳" : CONCLUSION_ICON[cr.conclusion ?? ""] ?? "○"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{cr.name}</div>
                  {cr.completed_at && <div className="opacity-50">{timeAgo(cr.completed_at)}</div>}
                </div>
                {cr.html_url && (
                  <a href={cr.html_url} target="_blank" rel="noreferrer"
                    className="shrink-0 opacity-40 hover:opacity-80 text-lg">↗</a>
                )}
              </div>
            ))
        )}

        {/* Comments tab */}
        {!loading && activeTab === "comments" && data && (
          <>
            {significantReviews.map((r) => (
              <div key={r.id} className="rounded-lg p-2.5 text-xs space-y-1"
                style={{ background: "var(--tg-secondary-bg)" }}>
                <div className="flex items-center gap-2">
                  <span className={`font-bold ${REVIEW_STATE_COLOR[r.state] ?? ""}`}>{REVIEW_STATE_ICON[r.state]}</span>
                  <span className="font-medium">{r.author}</span>
                  <span className="opacity-40">{timeAgo(r.submitted_at)}</span>
                </div>
                {r.body && <p className="opacity-80 whitespace-pre-wrap leading-relaxed">{r.body}</p>}
              </div>
            ))}
            {data.comments.map((c) => (
              <div key={c.id} className="rounded-lg p-2.5 text-xs space-y-1.5"
                style={{ background: "var(--tg-secondary-bg)" }}>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.author}</span>
                  <span className="opacity-40">{timeAgo(c.created_at)}</span>
                  <span className="font-mono opacity-40 truncate text-xs">{c.path}:{c.line}</span>
                </div>
                {c.diff_hunk && (
                  <pre className="text-xs font-mono bg-black/20 rounded p-1.5 overflow-x-auto whitespace-pre text-[10px] leading-4 opacity-70">
                    {c.diff_hunk.split("\n").slice(-4).join("\n")}
                  </pre>
                )}
                <p className="opacity-80 whitespace-pre-wrap leading-relaxed">{c.body}</p>
              </div>
            ))}
            {significantReviews.length === 0 && data.comments.length === 0 && (
              <div className="text-xs opacity-50 text-center py-8">No comments</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- PR list item ---
function PRCard({ pr, onClick }: { pr: GitHubPR; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full text-left p-3 rounded-lg space-y-1.5 active:opacity-70"
      style={{ background: "var(--tg-secondary-bg)" }}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
            {pr.draft
              ? <span className="text-xs px-1 py-0.5 rounded bg-gray-500/20 text-gray-400">Draft</span>
              : <span className="text-xs px-1 py-0.5 rounded bg-green-500/20 text-green-500">Open</span>}
            <span className="text-xs font-mono opacity-40">#{pr.number}</span>
          </div>
          <div className="text-sm font-medium leading-snug">{pr.title}</div>
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs opacity-50 flex-wrap">
        <span>🌿 {pr.head}</span>
        <span>👤 {pr.author}</span>
        <span>{timeAgo(pr.updated_at)}</span>
        {(pr.additions !== undefined) && (
          <span><span className="text-green-500">+{pr.additions}</span> <span className="text-red-400">−{pr.deletions}</span></span>
        )}
      </div>
    </button>
  );
}

// --- Main PRList component ---
export function PRList({ session }: Props) {
  const [prs, setPrs] = useState<GitHubPR[] | null>(null);
  const [repo, setRepo] = useState<{ owner: string; repo: string } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [authorFilter, setAuthorFilter] = useState<AuthorFilter>("me");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPR, setSelectedPR] = useState<GitHubPR | null>(null);

  const [reloadKey, setReloadKey] = useState(0);

  // Reset while rendering when the query changes, not in an effect: an effect
  // would paint the previous session's PRs for one frame first. Selection is
  // tied to the session alone — switching author must not close an open PR.
  const query = `${session.id}:${authorFilter}`;
  const [renderedQuery, setRenderedQuery] = useState(query);
  if (renderedQuery !== query) {
    if (renderedQuery.split(':')[0] !== String(session.id)) setSelectedPR(null);
    setRenderedQuery(query);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    // `cancelled` guards against a slow response for the previous session or
    // author landing after a newer one and overwriting it.
    let cancelled = false;
    api.git.prs(session.id, { author: authorFilter })
      .then((d) => { if (!cancelled) { setPrs(d.prs); setRepo(d.repo); setError(null); } })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session.id, authorFilter, reloadKey]);

  const load = () => {
    setLoading(true);
    setError(null);
    setReloadKey((k) => k + 1);
  };

  if (selectedPR) {
    return <PRDetail sessionId={session.id} pr={selectedPR} onBack={() => setSelectedPR(null)} />;
  }

  const filtered = (prs ?? []).filter((pr) => {
    if (filter === "draft") return pr.draft;
    if (filter === "ready") return !pr.draft;
    return true;
  });

  const filterTabs: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "ready", label: "Ready" },
    { id: "draft", label: "Draft" },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Repo header + author toggle + refresh */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-black/10 shrink-0"
        style={{ background: "var(--tg-secondary-bg)" }}>
        <span className="text-xs font-mono opacity-50 truncate flex-1">
          {repo ? `${repo.owner}/${repo.repo}` : "…"}
        </span>
        <div className="flex rounded overflow-hidden border border-black/10 shrink-0">
          {(["me", "all"] as AuthorFilter[]).map((a) => (
            <button key={a} onClick={() => setAuthorFilter(a)}
              className={`px-2 py-0.5 text-xs ${authorFilter === a ? "bg-[var(--tg-button)] text-white" : "opacity-50"}`}>
              {a === "me" ? "Mine" : "All"}
            </button>
          ))}
        </div>
        <button onClick={load} className="text-xs opacity-50 hover:opacity-100 shrink-0">↻</button>
      </div>

      {/* Filter tabs */}
      <div className="flex border-b border-black/10 shrink-0" style={{ background: "var(--tg-secondary-bg)" }}>
        {filterTabs.map((t) => {
          const count = t.id === "all" ? (prs?.length ?? 0) : t.id === "draft" ? (prs?.filter((p) => p.draft).length ?? 0) : (prs?.filter((p) => !p.draft).length ?? 0);
          return (
            <button key={t.id} onClick={() => setFilter(t.id)}
              className={`flex-1 py-2 text-xs font-medium ${filter === t.id ? "text-[var(--tg-button)] border-b-2 border-[var(--tg-button)]" : "opacity-50"}`}>
              {t.label} {prs !== null && <span className="opacity-60">({count})</span>}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {loading && <div className="text-xs opacity-50 text-center py-8">Loading PRs…</div>}
        {error && (
          <div className="text-xs text-red-400 text-center py-8 space-y-2">
            <div>{error}</div>
            <button onClick={load} className="underline opacity-70">Retry</button>
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="text-xs opacity-50 text-center py-8">No {filter !== "all" ? filter : "open"} PRs</div>
        )}
        {filtered.map((pr) => (
          <PRCard key={pr.number} pr={pr} onClick={() => setSelectedPR(pr)} />
        ))}
      </div>
    </div>
  );
}
