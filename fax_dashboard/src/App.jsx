import { useState, useRef, useEffect, useMemo } from "react";
import {
  LayoutDashboard, FileText, Plus, Search, UploadCloud, CheckCircle2,
  XCircle, Clock, Loader2, X, Download, Eye, ArrowUpRight, ArrowDownLeft,
  Send, Inbox as InboxIcon, ClipboardList, Settings as SettingsIcon, Info,
} from "lucide-react";

// ---------------------------------------------------------------------------
// API_BASE is computed from wherever this page is actually loaded, never
// hardcoded -- this build works unmodified on any server/domain it's
// deployed to, rather than needing a per-deployment edit (which is exactly
// what broke last time: a build made for mtenant.com got deployed as-is
// to a different RingQ server).
//
// TOKEN comes from a ?token=... query param on the page URL -- whatever
// embeds/links to this page (the RingQ portal) is expected to pass the
// user's existing RingQ session token there. Every API call sends it as
// `Authorization: Bearer <token>`, and RingQ's own api_server.py validates
// it against q_tokens directly -- there's no separate login here.
// ---------------------------------------------------------------------------
const API_BASE = `${window.location.origin}/fax-api`;
const TOKEN = new URLSearchParams(window.location.search).get("token");
const DEMO_MODE = !TOKEN;

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

// For plain <a href> links (file downloads/views) -- these can't carry a
// custom Authorization header on simple navigation, so the token rides
// along as a query param instead. api_server.py's _extract_token() already
// checks this as a fallback.
function apiFileUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  return TOKEN ? `${API_BASE}${path}${sep}token=${encodeURIComponent(TOKEN)}` : `${API_BASE}${path}`;
}

const DEMO_JOBS = [
  { id: "FX-1057", rawId: "FX-1057", direction: "out", from: "(512) 555-0101", to: "(212) 555-4433", pages: 1, status: "sent", updated: "Aug 3, 2026, 2:14 PM" },
  { id: "FX-1056", rawId: "FX-1056", direction: "in", from: "(646) 555-7788", to: "(512) 555-0101", pages: 2, status: "received", updated: "Aug 3, 2026, 2:38 PM" },
  { id: "FX-1055", rawId: "FX-1055", direction: "out", from: "(512) 555-0102", to: "(305) 555-1200", pages: 5, status: "failed", updated: "Aug 3, 2026, 2:28 PM", errorReason: "The remote line didn't answer after 3 attempts." },
  { id: "FX-1054", rawId: "FX-1054", direction: "in", from: "(800) 555-3345", to: "(512) 555-0101", pages: 1, status: "received", updated: "Aug 3, 2026, 2:13 PM" },
  { id: "FX-1053", rawId: "FX-1053", direction: "out", from: "(512) 555-0101", to: "(650) 555-9911", pages: 3, status: "sent", updated: "Aug 3, 2026, 1:58 PM" },
  { id: "FX-1052", rawId: "FX-1052", direction: "in", from: "(212) 555-0087", to: "(512) 555-0102", pages: 4, status: "received", updated: "Aug 3, 2026, 1:02 PM" },
  { id: "FX-1051", rawId: "FX-1051", direction: "out", from: "(512) 555-0101", to: "(415) 555-2290", pages: 2, status: "sent", updated: "Aug 3, 2026, 11:47 AM" },
  { id: "FX-1050", rawId: "FX-1050", direction: "in", from: "(973) 555-6610", to: "(512) 555-0101", pages: 1, status: "received", updated: "Aug 3, 2026, 10:55 AM" },
];

const DEMO_DIDS = [
  { did_number: "(512) 555-0101", name: "Main fax line", sip_trunk_name: "demo-trunk" },
  { did_number: "(512) 555-0102", name: "Billing fax", sip_trunk_name: "demo-trunk" },
];

const STATUS_META = {
  queued: { label: "Queued", tone: "muted" },
  dialing: { label: "Dialing", tone: "amber" },
  sending: { label: "Sending", tone: "amber" },
  receiving: { label: "Receiving", tone: "amber" },
  sent: { label: "Sent", tone: "green" },
  received: { label: "Received", tone: "green" },
  failed: { label: "Failed", tone: "red" },
};

const TABS = [
  { key: "overview", name: "Overview", icon: LayoutDashboard },
  { key: "send", name: "Send fax", icon: Send },
  { key: "inbox", name: "Inbox", icon: InboxIcon },
  { key: "log", name: "Status log", icon: ClipboardList },
  { key: "settings", name: "Settings", icon: SettingsIcon },
];

let demoJobCounter = 1058;

function formatDateTime(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Maps a raw job row from api_server.py's /fax/jobs into the shape this UI renders.
function mapJob(apiJob) {
  return {
    id: `FX-${apiJob.id.slice(0, 8).toUpperCase()}`,
    rawId: apiJob.id,
    direction: apiJob.direction,
    from: apiJob.from_number,
    to: apiJob.to_number,
    pages: apiJob.pages,
    status: apiJob.status,
    updated: formatDateTime(apiJob.updated_at),
    errorReason: apiJob.error_reason || null,
  };
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.queued;
  return (
    <span className={`fx-pill fx-pill--${meta.tone}`}>
      <span className="fx-pill__dot" />
      {meta.label}
    </span>
  );
}

function DirectionTag({ direction }) {
  return direction === "in" ? (
    <span className="fx-dir fx-dir--in"><ArrowDownLeft size={13} strokeWidth={2.4} /> In</span>
  ) : (
    <span className="fx-dir fx-dir--out"><ArrowUpRight size={13} strokeWidth={2.4} /> Out</span>
  );
}

function FailureReasonModal({ job, onClose }) {
  if (!job) return null;
  return (
    <div className="fx-modal-backdrop" onClick={onClose}>
      <div className="fx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fx-modal__head">
          <div>
            <div className="fx-mono fx-small fx-muted">{job.id}</div>
            <h3 className="fx-modal__title">Why this fax failed</h3>
          </div>
          <button className="fx-icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <p className="fx-modal__body">
          {job.errorReason || "No further detail was recorded for this failure."}
        </p>
      </div>
    </div>
  );
}

function JobsTable({ jobs }) {
  const [openReasonJob, setOpenReasonJob] = useState(null);
  return (
    <div className="fx-table-wrap">
      <table className="fx-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Direction</th>
            <th>From</th>
            <th>To</th>
            <th>Pages</th>
            <th>Status</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 && (
            <tr><td colSpan={7} className="fx-table__empty">No jobs match this view yet.</td></tr>
          )}
          {jobs.map((j) => (
            <tr key={j.rawId}>
              <td className="fx-mono fx-table__job">{j.id}</td>
              <td><DirectionTag direction={j.direction} /></td>
              <td className="fx-mono">{j.from}</td>
              <td className="fx-mono">{j.to}</td>
              <td>{j.pages}</td>
              <td>
                <span className="fx-status-cell">
                  <StatusPill status={j.status} />
                  {j.status === "failed" && (
                    <button
                      className="fx-reason-btn"
                      onClick={() => setOpenReasonJob(j)}
                      title="See full failure reason"
                      aria-label="See full failure reason"
                    >
                      <Info size={14} />
                    </button>
                  )}
                </span>
              </td>
              <td className="fx-muted">{j.updated}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <FailureReasonModal job={openReasonJob} onClose={() => setOpenReasonJob(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function OverviewTab({ jobs, goToLog }) {
  const total = jobs.length;
  const finished = jobs.filter((j) => j.status === "sent" || j.status === "received" || j.status === "failed");
  const successCount = jobs.filter((j) => j.status === "sent" || j.status === "received").length;
  const successRate = finished.length ? Math.round((successCount / finished.length) * 100) : 100;
  const inProgress = jobs.filter((j) => ["queued", "dialing", "sending", "receiving"].includes(j.status)).length;
  const failed = jobs.filter((j) => j.status === "failed").length;

  return (
    <div className="fx-stack-lg">
      <div className="fx-kpi-grid">
        <div className="fx-card fx-kpi">
          <div className="fx-kpi__label">Total faxes</div>
          <div className="fx-kpi__value">{total}</div>
          <div className="fx-kpi__helper fx-muted">All time</div>
        </div>
        <div className="fx-card fx-kpi">
          <div className="fx-kpi__label">Success rate</div>
          <div className="fx-kpi__value">{successRate}%</div>
          <div className="fx-kpi__helper fx-text-green">Healthy</div>
        </div>
        <div className="fx-card fx-kpi">
          <div className="fx-kpi__label">In progress</div>
          <div className="fx-kpi__value">{inProgress}</div>
          <div className="fx-kpi__helper fx-muted">Queued, dialing, sending</div>
        </div>
        <div className="fx-card fx-kpi">
          <div className="fx-kpi__label">Failed</div>
          <div className="fx-kpi__value">{failed}</div>
          <button className="fx-kpi__helper fx-link fx-text-red" onClick={goToLog}>
            Check the status log
          </button>
        </div>
      </div>

      <div className="fx-card">
        <div className="fx-card__head">
          <div>
            <h2 className="fx-card__title">Recent activity</h2>
            <p className="fx-muted fx-small">Your last {Math.min(8, jobs.length)} fax jobs.</p>
          </div>
        </div>
        <JobsTable jobs={jobs.slice(0, 8)} />
      </div>
    </div>
  );
}

function SendFaxTab({ dids, onJobFinished }) {
  const [toNumber, setToNumber] = useState("");
  const [fromNumber, setFromNumber] = useState(dids[0]?.did_number || "");
  const [note, setNote] = useState("");
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState("idle"); // idle | queued | dialing | sending | sent | failed
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef(null);
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  useEffect(() => {
    if (!fromNumber && dids.length > 0) {
      setFromNumber(dids[0].did_number);
    }
  }, [dids]); // eslint-disable-line react-hooks/exhaustive-deps

  if (dids.length === 0) {
    return (
      <div className="fx-card">
        <h2 className="fx-card__title">Send a fax</h2>
        <p className="fx-muted fx-small" style={{ marginTop: 8 }}>
          No numbers with a working gateway found for this account yet.
        </p>
      </div>
    );
  }

  const steps = ["queued", "dialing", "sending", "sent"];
  const canSend = toNumber.trim().length >= 7 && file && phase === "idle";

  function pickFile(f) {
    if (f && f.type === "application/pdf") setFile(f);
  }

  function reset() {
    setPhase("idle");
    setFile(null);
    setToNumber("");
    setNote("");
    setErrorMsg("");
  }

  function runDemoSend() {
    setPhase("queued");
    const willFail = Math.random() < 0.15;
    const delays = [500, 900, 1100];
    let t = 0;
    ["dialing", "sending", willFail ? "failed" : "sent"].forEach((step, i) => {
      t += delays[i];
      setTimeout(() => setPhase(step), t);
    });
    setTimeout(() => {
      demoJobCounter += 1;
      onJobFinished({
        id: `FX-${demoJobCounter}`, rawId: `FX-${demoJobCounter}`,
        direction: "out", from: fromNumber, to: toNumber, pages: 1,
        status: willFail ? "failed" : "sent", updated: formatDateTime(Date.now() / 1000),
      });
    }, t);
  }

  async function runRealSend() {
    setPhase("queued");
    setErrorMsg("");
    try {
      const fd = new FormData();
      fd.append("to_number", toNumber);
      fd.append("from_number", fromNumber);
      fd.append("file", file);
      const res = await apiFetch("/fax/send", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Send failed");
      const { job_id } = await res.json();

      pollRef.current = setInterval(async () => {
        try {
          const jr = await apiFetch(`/fax/jobs/${job_id}`);
          if (!jr.ok) return;
          const job = await jr.json();
          setPhase(job.status);
          if (["sent", "failed"].includes(job.status)) {
            clearInterval(pollRef.current);
            if (job.status === "failed") setErrorMsg(job.error_reason || "The remote line didn't answer.");
            onJobFinished(null); // null tells the parent to refetch the live list
          }
        } catch { /* transient network hiccup, next tick retries */ }
      }, 1200);
    } catch (e) {
      setPhase("failed");
      setErrorMsg(e.message || "Couldn't reach the fax API.");
    }
  }

  function handleSend() {
    if (!canSend) return;
    DEMO_MODE ? runDemoSend() : runRealSend();
  }

  const activeStepIndex = steps.indexOf(phase === "failed" ? "sending" : phase);

  return (
    <div className="fx-send-grid">
      <div className="fx-card">
        <div className="fx-card__head">
          <div>
            <h2 className="fx-card__title">Send a fax</h2>
            <p className="fx-muted fx-small">Upload a PDF and we'll dial it out over your fax line.</p>
          </div>
        </div>

        <div className="fx-form">
          <label className="fx-field">
            <span className="fx-field__label">To fax number</span>
            <input
              className="fx-input fx-mono"
              placeholder="(555) 555-0100"
              value={toNumber}
              onChange={(e) => setToNumber(e.target.value)}
              disabled={phase !== "idle"}
            />
          </label>

          <label className="fx-field">
            <span className="fx-field__label">From</span>
            <select
              className="fx-input fx-mono"
              value={fromNumber}
              onChange={(e) => setFromNumber(e.target.value)}
              disabled={phase !== "idle"}
            >
              {dids.map((d) => (
                <option key={d.did_number} value={d.did_number}>{d.did_number} — {d.sip_trunk_name}</option>
              ))}
            </select>
          </label>

          <label className="fx-field">
            <span className="fx-field__label">Cover note <span className="fx-muted">(optional)</span></span>
            <textarea
              className="fx-input fx-textarea"
              rows={3}
              placeholder="Add a short note for the recipient"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={phase !== "idle"}
            />
          </label>

          <div className="fx-field">
            <span className="fx-field__label">Document</span>
            <div
              className={`fx-dropzone ${dragOver ? "fx-dropzone--over" : ""} ${file ? "fx-dropzone--filled" : ""}`}
              onClick={() => phase === "idle" && inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); pickFile(e.dataTransfer.files?.[0]); }}
              role="button"
              tabIndex={0}
            >
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf"
                hidden
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
              {file ? (
                <div className="fx-dropzone__file">
                  <FileText size={18} />
                  <span className="fx-mono fx-small">{file.name}</span>
                </div>
              ) : (
                <div className="fx-dropzone__empty">
                  <UploadCloud size={20} />
                  <span>Drop a PDF here, or click to browse</span>
                </div>
              )}
            </div>
          </div>

          {phase === "idle" && (
            <button className="fx-btn fx-btn--primary" disabled={!canSend} onClick={handleSend}>
              <Send size={15} /> Send fax
            </button>
          )}
          {(phase === "sent" || phase === "failed") && (
            <button className="fx-btn fx-btn--ghost" onClick={reset}>Send another</button>
          )}
        </div>
      </div>

      <div className="fx-card fx-progress-card">
        <h3 className="fx-card__title fx-small-title">Transmission status</h3>
        {phase === "idle" ? (
          <p className="fx-muted fx-small">Fill in the form and send — progress shows up here in real time.</p>
        ) : (
          <>
            <ol className="fx-steps">
              {steps.map((step, i) => {
                const done = i < activeStepIndex || phase === "sent";
                const current = i === activeStepIndex && phase !== "sent" && phase !== "failed";
                const isFailedStep = phase === "failed" && i === activeStepIndex;
                return (
                  <li key={step} className={`fx-step ${done ? "fx-step--done" : ""} ${current ? "fx-step--current" : ""} ${isFailedStep ? "fx-step--failed" : ""}`}>
                    <span className="fx-step__dot">
                      {isFailedStep ? <XCircle size={14} /> : done ? <CheckCircle2 size={14} /> : current ? <Loader2 size={14} className="fx-spin" /> : null}
                    </span>
                    <span className="fx-step__label">{isFailedStep ? "Failed" : step[0].toUpperCase() + step.slice(1)}</span>
                  </li>
                );
              })}
            </ol>
            {(phase === "sending" || phase === "dialing") && <div className="fx-scanline" aria-hidden="true" />}
            {phase === "sent" && <p className="fx-text-green fx-small fx-progress-msg">Delivered successfully.</p>}
            {phase === "failed" && <p className="fx-text-red fx-small fx-progress-msg">{errorMsg || "The remote line didn't answer. Try again or check the number."}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function InboxTab({ jobs, onNote }) {
  const received = jobs.filter((j) => j.direction === "in" && j.status === "received");
  return (
    <div className="fx-card">
      <div className="fx-card__head">
        <div>
          <h2 className="fx-card__title">Inbox</h2>
          <p className="fx-muted fx-small">Faxes received on your numbers, ready to view or download.</p>
        </div>
      </div>
      {received.length === 0 ? (
        <p className="fx-muted fx-small fx-empty-pad">Nothing here yet — received faxes will land in this list.</p>
      ) : (
        <div className="fx-inbox-grid">
          {received.map((j) => (
            <div key={j.rawId} className="fx-inbox-card">
              <div className="fx-inbox-card__icon"><FileText size={18} /></div>
              <div className="fx-inbox-card__meta">
                <div className="fx-mono fx-small fx-inbox-card__from">{j.from}</div>
                <div className="fx-muted fx-small">{j.pages} page{j.pages > 1 ? "s" : ""} · {j.updated}</div>
              </div>
              <div className="fx-inbox-card__actions">
                {!DEMO_MODE ? (
                  <>
                    <a className="fx-icon-btn" href={apiFileUrl(`/fax/inbox/${j.rawId}/file`)} target="_blank" rel="noreferrer" title="View">
                      <Eye size={15} />
                    </a>
                    <a className="fx-icon-btn" href={apiFileUrl(`/fax/inbox/${j.rawId}/file`)} download title="Download">
                      <Download size={15} />
                    </a>
                  </>
                ) : (
                  <>
                    <button className="fx-icon-btn" title="View" onClick={() => onNote("Preview opens once connected to a real session.")}>
                      <Eye size={15} />
                    </button>
                    <button className="fx-icon-btn" title="Download" onClick={() => onNote("Download opens once connected to a real session.")}>
                      <Download size={15} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusLogTab({ jobs }) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    return jobs.filter((j) => {
      const matchesFilter =
        filter === "all" ? true :
        filter === "progress" ? ["queued", "dialing", "sending", "receiving"].includes(j.status) :
        j.status === filter;
      const q = query.trim().toLowerCase();
      const matchesQuery = !q || j.id.toLowerCase().includes(q) || j.from.includes(q) || j.to.includes(q);
      return matchesFilter && matchesQuery;
    });
  }, [jobs, filter, query]);

  const chips = [
    { key: "all", label: "All" },
    { key: "sent", label: "Sent" },
    { key: "received", label: "Received" },
    { key: "progress", label: "In progress" },
    { key: "failed", label: "Failed" },
  ];

  return (
    <div className="fx-card">
      <div className="fx-card__head fx-card__head--log">
        <div>
          <h2 className="fx-card__title">Status log</h2>
          <p className="fx-muted fx-small">Every fax job, in and out.</p>
        </div>
        <div className="fx-search">
          <Search size={14} />
          <input
            className="fx-search__input fx-mono"
            placeholder="Search by number or job ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="fx-chips">
        {chips.map((c) => (
          <button
            key={c.key}
            className={`fx-chip ${filter === c.key ? "fx-chip--active" : ""}`}
            onClick={() => setFilter(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <JobsTable jobs={filtered} />
      <div className="fx-muted fx-small fx-table__footer">{filtered.length} job{filtered.length !== 1 ? "s" : ""}</div>
    </div>
  );
}

function SettingsTab({ onNote }) {
  const [identName, setIdentName] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [companyDefault, setCompanyDefault] = useState("");
  const [loaded, setLoaded] = useState(DEMO_MODE);

  useEffect(() => {
    if (DEMO_MODE) return;
    (async () => {
      try {
        const res = await apiFetch("/fax/settings");
        if (res.ok) {
          const s = await res.json();
          setIdentName(s.fax_ident || "");
          setHeaderText(s.fax_header || "");
          setCompanyDefault(s.company_name || "");
        }
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function save() {
    if (DEMO_MODE) { onNote("Settings saved."); return; }
    const res = await apiFetch("/fax/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fax_ident: identName || null, fax_header: headerText || null }),
    });
    onNote(res.ok ? "Settings saved." : "Couldn't save settings.");
  }

  if (!loaded) return null;

  return (
    <div className="fx-card fx-settings-card">
      <div className="fx-card__head">
        <div>
          <h2 className="fx-card__title">Settings</h2>
          <p className="fx-muted fx-small">
            {companyDefault
              ? `Shown at the top of every fax you send. Defaults to "${companyDefault}" if left blank.`
              : "Shown at the top of every fax you send."}
          </p>
        </div>
      </div>

      <div className="fx-form">
        <label className="fx-field">
          <span className="fx-field__label">Fax ident</span>
          <input className="fx-input" placeholder={companyDefault || "Your company"} value={identName} onChange={(e) => setIdentName(e.target.value)} />
        </label>

        <label className="fx-field">
          <span className="fx-field__label">Fax header</span>
          <input className="fx-input" placeholder={companyDefault || "Your company"} value={headerText} onChange={(e) => setHeaderText(e.target.value)} />
        </label>

        <p className="fx-muted fx-small">Which gateway a number sends through is set on the number itself in RingQ, not here.</p>
        <button className="fx-btn fx-btn--primary" onClick={save}>Save changes</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export default function FaxDashboard() {
  const [tab, setTab] = useState("overview");
  const [jobs, setJobs] = useState(DEMO_MODE ? DEMO_JOBS : []);
  const [dids, setDids] = useState(DEMO_MODE ? DEMO_DIDS : []);
  const [toast, setToast] = useState(null);
  const [authError, setAuthError] = useState(false);
  const [connectionError, setConnectionError] = useState(false);

  async function refreshJobs() {
    if (DEMO_MODE) return;
    try {
      const res = await apiFetch("/fax/jobs?limit=50");
      if (res.status === 401) { setAuthError(true); return; }
      if (!res.ok) throw new Error();
      const data = await res.json();
      setJobs(data.map(mapJob));
      setConnectionError(false);
      setAuthError(false);
    } catch {
      setConnectionError(true);
    }
  }

  async function refreshDids() {
    if (DEMO_MODE) return;
    try {
      const res = await apiFetch("/fax/dids");
      if (res.status === 401) { setAuthError(true); return; }
      if (!res.ok) throw new Error();
      setDids(await res.json());
    } catch {
      // jobs' connectionError banner already covers "API unreachable"
    }
  }

  useEffect(() => {
    if (DEMO_MODE) return;
    refreshJobs();
    refreshDids();
    const iv = setInterval(refreshJobs, 4000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  function handleJobFinished(localJob) {
    if (localJob) {
      setJobs((prev) => [localJob, ...prev]);
    } else {
      refreshJobs();
    }
  }

  return (
    <div className="fx-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

        .fx-root {
          --ink: #18141F;
          --ink-soft: #625C72;
          --canvas: #F6F4FA;
          --surface: #FFFFFF;
          --border: #E8E4F1;
          --accent: #E12F8C;
          --accent-ink: #FFFFFF;
          --accent-soft: #FCE8F2;
          --violet: #6D28D9;
          --violet-soft: #F0EBFC;
          --green: #0F9D58;
          --green-soft: #E6F6EC;
          --red: #DC2626;
          --red-soft: #FCEAEA;
          --amber: #C2760C;
          --amber-soft: #FBF0DD;
          --radius-sm: 8px;
          --radius-md: 12px;
          --radius-lg: 18px;
          --shadow-card: 0 1px 2px rgba(24,20,31,0.04), 0 10px 28px -16px rgba(24,20,31,0.16);

          font-family: 'Inter', system-ui, sans-serif;
          color: var(--ink);
          background: var(--canvas);
          min-height: 100%;
          width: 100%;
          box-sizing: border-box;
        }
        .fx-root *, .fx-root *::before, .fx-root *::after { box-sizing: border-box; }
        .fx-root :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

        .fx-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        .fx-muted { color: var(--ink-soft); }
        .fx-small { font-size: 0.8rem; }
        .fx-text-green { color: var(--green); }
        .fx-text-red { color: var(--red); }
        .fx-link { background: none; border: none; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; font: inherit; }

        .fx-shell { max-width: 1180px; margin: 0 auto; }
        .fx-logo { padding: 4px 0 2px; }
        .fx-logo__mark {
          font-family: 'Space Grotesk', sans-serif;
          font-weight: 700;
          font-size: 1.15rem;
          letter-spacing: -0.01em;
          position: relative;
          display: inline-block;
        }
        .fx-logo__mark svg { position: absolute; left: 0; bottom: -6px; width: 100%; height: 8px; }

        .fx-topbar { display: flex; flex-direction: column; gap: 16px; padding: 24px 32px 0; }
        .fx-header { display: flex; align-items: flex-end; justify-content: space-between; flex: 1; flex-wrap: wrap; gap: 12px; }
        .fx-header h1 { font-family: 'Space Grotesk', sans-serif; font-size: 1.6rem; font-weight: 700; margin: 0; display: inline; }
        .fx-header p { margin: 4px 0 0; color: var(--ink-soft); font-size: 0.9rem; }
        .fx-demo-badge { font-size: 0.68rem; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: var(--amber-soft); color: var(--amber); margin-left: 10px; vertical-align: middle; }

        .fx-conn-banner { margin: 12px 32px 0; padding: 8px 14px; background: var(--red-soft); color: var(--red); border-radius: var(--radius-sm); font-size: 0.8rem; }

        .fx-tabs { display: flex; gap: 4px; padding: 18px 32px 0; flex-wrap: wrap; }
        .fx-tab {
          display: flex; align-items: center; gap: 6px;
          padding: 8px 14px; border-radius: 999px; border: 1px solid transparent;
          background: none; font-size: 0.85rem; font-weight: 500; color: var(--ink-soft); cursor: pointer;
        }
        .fx-tab:hover { background: var(--surface); border-color: var(--border); }
        .fx-tab--active { background: var(--ink); color: #fff; }
        .fx-tab--active:hover { background: var(--ink); }

        .fx-content { padding: 20px 32px 40px; flex: 1; }
        .fx-stack-lg { display: flex; flex-direction: column; gap: 20px; }

        .fx-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-card); padding: 22px; }
        .fx-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
        .fx-card__title { font-family: 'Space Grotesk', sans-serif; font-size: 1.05rem; font-weight: 600; margin: 0; }
        .fx-small-title { font-size: 0.95rem; margin-bottom: 14px; }
        .fx-empty-pad { padding: 24px 4px; }

        .fx-kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
        .fx-kpi { padding: 18px 20px; }
        .fx-kpi__label { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-soft); }
        .fx-kpi__value { font-family: 'Space Grotesk', sans-serif; font-size: 2rem; font-weight: 700; margin: 6px 0 4px; }
        .fx-kpi__helper { font-size: 0.78rem; }

        .fx-table-wrap { overflow-x: auto; }
        .fx-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .fx-table th { text-align: left; font-weight: 600; color: var(--ink-soft); font-size: 0.72rem; letter-spacing: 0.05em; text-transform: uppercase; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
        .fx-table td { padding: 11px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
        .fx-table tbody tr:hover { background: var(--canvas); }
        .fx-table tbody tr:last-child td { border-bottom: none; }
        .fx-table__job { font-weight: 600; }
        .fx-table__empty { text-align: center; color: var(--ink-soft); padding: 28px 0 !important; }
        .fx-table__footer { padding-top: 10px; }

        .fx-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; font-size: 0.78rem; font-weight: 500; }
        .fx-pill__dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
        .fx-pill--green { background: var(--green-soft); color: var(--green); }
        .fx-pill--red { background: var(--red-soft); color: var(--red); }
        .fx-pill--amber { background: var(--amber-soft); color: var(--amber); }
        .fx-pill--muted { background: var(--canvas); color: var(--ink-soft); }

        .fx-status-cell { display: inline-flex; align-items: center; gap: 6px; }
        .fx-reason-btn { background: none; border: none; padding: 2px; margin: 0; cursor: pointer; color: var(--red); display: inline-flex; border-radius: 999px; }
        .fx-reason-btn:hover { background: var(--red-soft); }

        .fx-modal-backdrop { position: fixed; inset: 0; background: rgba(24,20,31,0.45); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 20px; }
        .fx-modal { background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-card); padding: 22px; max-width: 420px; width: 100%; }
        .fx-modal__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
        .fx-modal__title { font-family: 'Space Grotesk', sans-serif; font-size: 1.02rem; font-weight: 600; margin: 2px 0 0; }
        .fx-modal__body { font-size: 0.88rem; line-height: 1.5; color: var(--ink); margin: 0; white-space: pre-wrap; }

        .fx-dir { display: inline-flex; align-items: center; gap: 4px; font-size: 0.8rem; font-weight: 500; }
        .fx-dir--in { color: var(--violet); }
        .fx-dir--out { color: var(--accent); }

        .fx-btn { display: inline-flex; align-items: center; gap: 7px; font-size: 0.85rem; font-weight: 600; padding: 9px 16px; border-radius: var(--radius-sm); border: 1px solid transparent; cursor: pointer; font-family: inherit; }
        .fx-btn--primary { background: var(--accent); color: var(--accent-ink); }
        .fx-btn--primary:hover { background: #C6247B; }
        .fx-btn--primary:disabled { background: #E9C6DA; cursor: not-allowed; }
        .fx-btn--ghost { background: var(--surface); border-color: var(--border); color: var(--ink); }
        .fx-btn--ghost:hover { background: var(--canvas); }
        .fx-btn--sm { padding: 6px 12px; font-size: 0.8rem; }

        .fx-icon-btn { background: var(--canvas); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px; cursor: pointer; color: var(--ink-soft); display: inline-flex; text-decoration: none; }
        .fx-icon-btn:hover { color: var(--ink); background: #EFEBF7; }

        .fx-form { display: flex; flex-direction: column; gap: 16px; }
        .fx-field { display: flex; flex-direction: column; gap: 6px; }
        .fx-field--row { flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; }
        .fx-field__label { font-size: 0.82rem; font-weight: 600; }
        .fx-input { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 9px 12px; font-size: 0.88rem; font-family: inherit; background: var(--surface); color: var(--ink); width: 100%; }
        .fx-input:focus { border-color: var(--accent); }
        .fx-input--sm { padding: 7px 10px; font-size: 0.82rem; }
        .fx-textarea { resize: vertical; }

        .fx-dropzone { border: 1.5px dashed var(--border); border-radius: var(--radius-md); padding: 22px; display: flex; align-items: center; justify-content: center; cursor: pointer; text-align: center; color: var(--ink-soft); background: var(--canvas); }
        .fx-dropzone--over { border-color: var(--accent); background: var(--accent-soft); }
        .fx-dropzone--filled { border-style: solid; background: var(--surface); }
        .fx-dropzone__empty, .fx-dropzone__file { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; }

        .fx-send-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; align-items: start; }
        .fx-progress-card { position: sticky; top: 20px; }
        .fx-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
        .fx-step { display: flex; align-items: center; gap: 10px; color: var(--ink-soft); font-size: 0.85rem; }
        .fx-step__dot { width: 20px; height: 20px; border-radius: 999px; border: 1.5px solid var(--border); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .fx-step--done .fx-step__dot { border-color: var(--green); color: var(--green); }
        .fx-step--done { color: var(--ink); }
        .fx-step--current .fx-step__dot { border-color: var(--amber); color: var(--amber); }
        .fx-step--current { color: var(--ink); font-weight: 600; }
        .fx-step--failed .fx-step__dot { border-color: var(--red); color: var(--red); }
        .fx-step--failed { color: var(--red); font-weight: 600; }
        .fx-progress-msg { margin-top: 14px; }
        .fx-spin { animation: fx-spin 0.9s linear infinite; }
        @keyframes fx-spin { to { transform: rotate(360deg); } }

        .fx-scanline { position: relative; height: 3px; margin-top: 16px; border-radius: 999px; background: var(--violet-soft); overflow: hidden; }
        .fx-scanline::after { content: ''; position: absolute; inset: 0; width: 40%; background: linear-gradient(90deg, transparent, var(--accent), transparent); animation: fx-scan 1.1s ease-in-out infinite; }
        @keyframes fx-scan { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }

        .fx-inbox-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
        .fx-inbox-card { display: flex; align-items: center; gap: 10px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; }
        .fx-inbox-card__icon { width: 34px; height: 34px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .fx-inbox-card__meta { flex: 1; min-width: 0; }
        .fx-inbox-card__from { font-weight: 600; }
        .fx-inbox-card__actions { display: flex; gap: 6px; }

        .fx-card__head--log { align-items: center; }
        .fx-search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 999px; padding: 7px 14px; color: var(--ink-soft); min-width: 240px; }
        .fx-search__input { border: none; outline: none; background: none; font-size: 0.82rem; flex: 1; color: var(--ink); }
        .fx-chips { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
        .fx-chip { padding: 6px 13px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); font-size: 0.8rem; font-weight: 500; color: var(--ink-soft); cursor: pointer; }
        .fx-chip--active { background: var(--ink); border-color: var(--ink); color: #fff; }

        .fx-numbers-list { display: flex; flex-direction: column; gap: 8px; }
        .fx-numbers-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-md); }
        .fx-numbers-row__actions { display: flex; align-items: center; gap: 10px; }
        .fx-numbers-row--new { gap: 8px; }
        .fx-numbers-row--new .fx-input { flex: 1; }

        .fx-switch { width: 38px; height: 22px; border-radius: 999px; background: var(--border); border: none; position: relative; cursor: pointer; flex-shrink: 0; padding: 0; }
        .fx-switch--on { background: var(--accent); }
        .fx-switch__knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 999px; background: #fff; transition: transform 0.15s ease; }
        .fx-switch--on .fx-switch__knob { transform: translateX(16px); }

        .fx-settings-card { max-width: 560px; }

        .fx-toast { position: fixed; bottom: 22px; right: 22px; background: var(--ink); color: #fff; padding: 10px 16px; border-radius: var(--radius-sm); font-size: 0.85rem; box-shadow: var(--shadow-card); display: flex; align-items: center; gap: 10px; z-index: 50; }
        .fx-toast button { background: none; border: none; color: #fff; opacity: 0.6; cursor: pointer; display: flex; }

        @media (max-width: 900px) {
          .fx-send-grid { grid-template-columns: 1fr; }
          .fx-kpi-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 780px) {
          .fx-topbar, .fx-tabs, .fx-content, .fx-conn-banner { padding-left: 18px; padding-right: 18px; margin-left: 0; margin-right: 0; }
        }
        @media (max-width: 520px) {
          .fx-kpi-grid { grid-template-columns: 1fr; }
        }
        @media (prefers-reduced-motion: reduce) {
          .fx-spin, .fx-scanline::after { animation: none; }
        }
      `}</style>

      <div className="fx-shell">
        <div className="fx-topbar">
          <div className="fx-logo">
            <span className="fx-logo__mark">
              RingQ Fax Engine
            </span>
          </div>
          <div className="fx-header">
            <div>
              <h1>eFax{DEMO_MODE && <span className="fx-demo-badge">Demo data — open from RingQ for a real session</span>}</h1>
              <p>Send and receive faxes on your numbers.</p>
            </div>
          </div>
        </div>

        {!DEMO_MODE && authError && (
          <div className="fx-conn-banner">Your session token is missing or expired — reopen this page from RingQ.</div>
        )}
        {!DEMO_MODE && !authError && connectionError && (
          <div className="fx-conn-banner">Can't reach the fax API at {API_BASE} — showing the last data loaded.</div>
        )}

        <nav className="fx-tabs">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.key} className={`fx-tab ${tab === t.key ? "fx-tab--active" : ""}`} onClick={() => setTab(t.key)}>
                <Icon size={14} /> {t.name}
              </button>
            );
          })}
        </nav>

        <div className="fx-content">
          {tab === "overview" && <OverviewTab jobs={jobs} goToLog={() => setTab("log")} />}
          {tab === "send" && <SendFaxTab dids={dids} onJobFinished={handleJobFinished} />}
          {tab === "inbox" && <InboxTab jobs={jobs} onNote={setToast} />}
          {tab === "log" && <StatusLogTab jobs={jobs} />}
          {tab === "settings" && <SettingsTab onNote={setToast} />}
        </div>
      </div>

      {toast && (
        <div className="fx-toast">
          {toast}
          <button onClick={() => setToast(null)} aria-label="Dismiss"><X size={13} /></button>
        </div>
      )}
    </div>
  );
}
