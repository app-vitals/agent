/**
 * admin/src/admin-ui-github-reconcile-pages.ts
 * Pure renderers for the agent detail page's GitHub Reconcile card (GHE-3.5).
 * Platform-admin only; the caller renders the card only when a GitHub username
 * is bound and the enterprise apps are configured. The card posts to the
 * admin UI's plan/apply proxy routes; these renderers produce the fragments
 * those routes return. Every dynamic value is escaped. Inputs carry repo names
 * and ids only (no token or key ever reaches this module).
 */

import { escapeHtml } from "./admin-ui-styles.ts";

/** Mirrors MAX_UNCONFIRMED_REMOVALS in reconcile-apply-service.ts. */
export const RECONCILE_REMOVAL_CAP = 10;

export interface GithubReconcileDiffView {
  installationAdds: string[];
  installationRemoves: string[];
  configAdds: string[];
  configRemoves: string[];
}

/** JSON body of POST /agents/:id/github-reconcile/plan. */
export interface GithubReconcilePlanView {
  status: "planned" | "skipped";
  reason?: string;
  planHash?: string;
  empty?: boolean;
  diff?: GithubReconcileDiffView;
  skippedOrgs?: { org: string; reason: string }[];
  rejectedAdds?: { repo: string; reason: string }[];
  warnings?: string[];
  affectedOpenWork?: { id: string; repo: string; title?: string }[];
}

/** JSON body of POST /agents/:id/github-reconcile/apply. */
export interface GithubReconcileApplyView {
  status: "applied" | "failed" | "noop" | "skipped";
  reason?: string;
  auditId?: string;
  error?: string;
  warnings?: string[];
}

/** The Reconcile card; the buttons talk to the UI plan/apply routes. */
export function renderGithubReconcileCard(agentId: string): string {
  const base = `/admin/agents/${escapeHtml(agentId)}/github-reconcile`;
  return `<div class="card" id="github-reconcile-card">
      <div class="card-title">Reconcile</div>
      <p style="color:#6b7280;font-size:12px;margin:0 0 12px">Plans the repo changes needed to match this agent's GitHub user access. Nothing changes until you review the plan and confirm.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input name="addRepos" id="github-reconcile-add" type="text" class="form-input mono" placeholder="Repos to add (owner/repo, comma separated; optional)" style="min-width:320px" />
        <button type="button" class="btn btn-primary" id="github-reconcile-plan-btn" data-plan-url="${base}/plan" data-apply-url="${base}/apply">Plan</button>
      </div>
      <div id="github-reconcile-result" style="margin-top:12px"></div>
      <script>
        (function() {
          var btn = document.getElementById('github-reconcile-plan-btn');
          var out = document.getElementById('github-reconcile-result');
          var input = document.getElementById('github-reconcile-add');
          if (!btn || !out || !input) return;
          function show(r) { return r.text().then(function(t) { out.innerHTML = t; }); }
          function fail() { out.textContent = 'The request failed.'; }
          function adds() {
            return input.value.split(/[\\s,]+/).filter(function(s) { return s; });
          }
          btn.addEventListener('click', function() {
            btn.disabled = true;
            out.textContent = 'Loading...';
            fetch(btn.getAttribute('data-plan-url'), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ addRepos: adds() })
            }).then(show).catch(fail).then(function() { btn.disabled = false; });
          });
          function sync() {
            var plan = out.querySelector('#github-reconcile-plan');
            var apply = out.querySelector('#github-reconcile-apply-btn');
            var ok = out.querySelector('#github-reconcile-confirm');
            var cap = out.querySelector('#github-reconcile-confirm-removals');
            if (!plan || !apply || !ok) return;
            apply.disabled = !(ok.checked && (!cap || cap.checked));
          }
          out.addEventListener('change', sync);
          out.addEventListener('click', function(e) {
            var t = e.target;
            if (!t || t.id !== 'github-reconcile-apply-btn') return;
            var plan = out.querySelector('#github-reconcile-plan');
            var cap = out.querySelector('#github-reconcile-confirm-removals');
            var add = plan.getAttribute('data-add-repos');
            t.disabled = true;
            fetch(btn.getAttribute('data-apply-url'), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                planHash: plan.getAttribute('data-plan-hash'),
                addRepos: add ? add.split(',') : [],
                confirmRemovals: !!(cap && cap.checked)
              })
            }).then(show).catch(fail);
          });
        })();
      </script>
    </div>`;
}

function repoList(repos: string[]): string {
  return repos.length === 0
    ? `<span style="color:#9ca3af">none</span>`
    : repos.map((r) => `<div class="mono">${escapeHtml(r)}</div>`).join("");
}

function diffTable(diff: GithubReconcileDiffView): string {
  const row = (label: string, adds: string[], removes: string[]) =>
    `<tr><td style="width:200px">${label}</td><td>${repoList(adds)}</td><td>${repoList(removes)}</td></tr>`;
  return `<table class="detail-table"><thead><tr><th>Change</th><th>Add</th><th>Remove</th></tr></thead><tbody>${row("Installation", diff.installationAdds, diff.installationRemoves)}${row("Agent config", diff.configAdds, diff.configRemoves)}</tbody></table>`;
}

function section(title: string, body: string): string {
  return `<div style="margin-top:12px"><div style="font-weight:600;margin-bottom:6px">${title}</div>${body}</div>`;
}

/**
 * Fragment for the plan result. `addRepos` is the named-add list the plan was
 * made with; apply must resend it, so it rides along on the plan element.
 */
export function renderGithubReconcilePlanResult(
  plan: GithubReconcilePlanView,
  addRepos: string[],
): string {
  if (plan.status === "skipped" || !plan.diff || !plan.planHash) {
    return `<div class="alert alert-warning">Reconcile skipped: ${escapeHtml(plan.reason ?? "no plan was produced")}.</div>`;
  }
  const parts: string[] = [];
  if (plan.skippedOrgs?.length) {
    parts.push(
      `<div class="alert alert-warning">Skipped organizations:<ul style="margin:6px 0 0 18px">${plan.skippedOrgs.map((o) => `<li><span class="mono">${escapeHtml(o.org)}</span>: ${escapeHtml(o.reason)}</li>`).join("")}</ul></div>`,
    );
  }
  if (plan.rejectedAdds?.length) {
    parts.push(
      `<div class="alert alert-warning">Rejected additions:<ul style="margin:6px 0 0 18px">${plan.rejectedAdds.map((r) => `<li><span class="mono">${escapeHtml(r.repo)}</span>: ${escapeHtml(r.reason)}</li>`).join("")}</ul></div>`,
    );
  }
  if (plan.warnings?.length) {
    parts.push(
      `<div class="alert alert-warning">${plan.warnings.map((w) => `<div>${escapeHtml(w)}</div>`).join("")}</div>`,
    );
  }
  if (plan.empty) {
    parts.push(
      `<p class="empty-state">Nothing to change: the agent already matches its GitHub access.</p>`,
    );
    return parts.join("");
  }
  parts.push(diffTable(plan.diff));
  if (plan.affectedOpenWork?.length) {
    const rows = plan.affectedOpenWork
      .map(
        (w) =>
          `<tr><td class="mono">${escapeHtml(w.id)}</td><td class="mono">${escapeHtml(w.repo)}</td><td>${escapeHtml(w.title ?? "")}</td></tr>`,
      )
      .join("");
    parts.push(
      section(
        "Open tasks and PRs affected by the removals",
        `<table class="detail-table"><thead><tr><th>Id</th><th>Repo</th><th>Title</th></tr></thead><tbody>${rows}</tbody></table>`,
      ),
    );
  }
  const removals = plan.diff.configRemoves.length;
  const overCap = removals > RECONCILE_REMOVAL_CAP;
  const capConfirm = overCap
    ? `<label style="display:block;margin-bottom:8px"><input type="checkbox" id="github-reconcile-confirm-removals" /> This plan removes ${removals} repos (more than ${RECONCILE_REMOVAL_CAP}). I confirm the removals.</label>`
    : "";
  parts.push(
    `<div id="github-reconcile-plan" style="margin-top:12px" data-plan-hash="${escapeHtml(plan.planHash)}" data-add-repos="${escapeHtml(addRepos.join(","))}" data-over-cap="${overCap}">
        <label style="display:block;margin-bottom:8px"><input type="checkbox" id="github-reconcile-confirm" /> I have reviewed this plan and want to apply it.</label>
        ${capConfirm}
        <button type="button" class="btn btn-danger" id="github-reconcile-apply-btn" disabled>Apply</button>
      </div>`,
  );
  return parts.join("");
}

/** Fragment for the apply result. */
export function renderGithubReconcileApplyResult(
  res: GithubReconcileApplyView,
): string {
  const audit = res.auditId
    ? ` Audit id: <span class="mono">${escapeHtml(res.auditId)}</span>.`
    : "";
  const warnings = (res.warnings ?? [])
    .map((w) => `<div>${escapeHtml(w)}</div>`)
    .join("");
  switch (res.status) {
    case "applied":
      return `<div class="alert alert-success">Reconcile applied.${audit}${warnings}</div>`;
    case "noop":
      return `<div class="alert alert-warning">Nothing to change.${warnings}</div>`;
    case "failed":
      return `<div class="alert alert-error">Reconcile failed${res.error ? `: ${escapeHtml(res.error)}` : ""}.${audit}${warnings}</div>`;
    default:
      return `<div class="alert alert-warning">Reconcile skipped${res.reason ? `: ${escapeHtml(res.reason)}` : ""}.</div>`;
  }
}
