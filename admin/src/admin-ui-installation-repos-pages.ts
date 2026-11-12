/**
 * admin/src/admin-ui-installation-repos-pages.ts
 * Pure renderers for the agent detail page's "Installation repos" card
 * (IRM-1.4), which replaces the plan-first Reconcile card: the repos on the
 * agent App's installation per org with add/remove, the user-can-push hint,
 * and a button that removes repos the bound user can no longer push to (IRM-1.3)
 * after an explicit confirmation. It also renders the open-work lists shown
 * before and after a removal (IRM-1.7) and the coverage warning on the agent's
 * repos list. Platform-admin only; the caller decides visibility. Every dynamic
 * value is escaped. Inputs carry repo names and ids only.
 */

import { escapeHtml } from "./admin-ui-styles.ts";
import { MAX_UNCONFIRMED_REMOVALS } from "./reconcile-apply-service.ts";

export interface OpenWorkView {
  id: string;
  repo: string;
  title?: string;
}

/** JSON body of GET /agents/:id/github-installation/repos. */
export interface InstallationReposView {
  appId?: number;
  orgs: {
    org: string;
    repos: { fullName: string; userCanPush?: boolean }[];
  }[];
}

/** JSON body of GET /agents/:id/github-lost-access/preview. */
export interface LostAccessPreviewView {
  status: "previewed" | "skipped";
  reason?: string;
  repos?: string[];
  installationRemoves?: string[];
  configRemoves?: string[];
  skippedOrgs?: { org: string; reason: string }[];
  openWork?: OpenWorkView[];
  warnings?: string[];
}

/** JSON body of POST /agents/:id/github-lost-access/remove. */
export interface LostAccessRemoveView {
  status: "applied" | "noop" | "skipped";
  reason?: string;
  auditId?: string;
  repos?: string[];
  installationRemoves?: string[];
  configRemoves?: string[];
  notRemoved?: { repo: string; reason: string }[];
  skippedOrgs?: { org: string; reason: string }[];
  warnings?: string[];
}

/** JSON body of GET /agents/:id/repos/:owner/:name/removal-preview. */
export interface RepoRemovalPreviewView {
  repo: string;
  openWork: OpenWorkView[];
  warnings: string[];
}

export const NO_USERNAME_REASON =
  "No GitHub username is bound to this agent, so repos the user can no longer push to cannot be found. Bind a username above to enable this.";
export const INSTALLER_UNCONFIGURED_REASON =
  "The installer GitHub App is not configured, so the agent App's installation repos cannot be listed or changed.";

const lc = (s: string): string => s.toLowerCase();

/** Link for an open-work item: a `owner/repo#N` id is a PR on GitHub. */
function workLabel(item: OpenWorkView): string {
  const pr = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(item.id);
  const id = escapeHtml(item.id);
  if (!pr) return `<span class="mono">${id}</span>`;
  const url = `https://github.com/${pr[1]}/pull/${pr[2]}`;
  return `<a class="mono" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${id}</a>`;
}

/** Open work grouped per repo, linked. Empty input renders a plain note. */
export function renderOpenWorkByRepo(
  work: readonly OpenWorkView[],
  heading: string,
  emptyNote: string,
): string {
  if (work.length === 0) {
    return `<p class="empty-state" data-open-work="none">${escapeHtml(emptyNote)}</p>`;
  }
  const byRepo = new Map<string, OpenWorkView[]>();
  for (const w of work) byRepo.set(w.repo, [...(byRepo.get(w.repo) ?? []), w]);
  const groups = [...byRepo]
    .map(
      ([repo, items]) =>
        `<div style="margin-top:6px"><span class="mono" style="font-weight:600">${escapeHtml(repo)}</span><ul style="margin:4px 0 0 18px">${items
          .map(
            (w) =>
              `<li>${workLabel(w)}${w.title ? ` ${escapeHtml(w.title)}` : ""}</li>`,
          )
          .join("")}</ul></div>`,
    )
    .join("");
  return `<div class="alert alert-warning" data-open-work="list"><div style="font-weight:600">${escapeHtml(heading)}</div>${groups}</div>`;
}

function warningsHtml(warnings: readonly string[] | undefined): string {
  return (warnings ?? []).length === 0
    ? ""
    : `<div class="alert alert-warning" data-warnings="1">${(warnings ?? []).map((w) => `<div>${escapeHtml(w)}</div>`).join("")}</div>`;
}

function skippedOrgsHtml(
  skipped: readonly { org: string; reason: string }[] | undefined,
): string {
  return (skipped ?? []).length === 0
    ? ""
    : `<div class="alert alert-warning" data-skipped-orgs="1">Skipped organizations (nothing was removed there):<ul style="margin:6px 0 0 18px">${(skipped ?? []).map((o) => `<li><span class="mono">${escapeHtml(o.org)}</span>: ${escapeHtml(o.reason)}</li>`).join("")}</ul></div>`;
}

/** The card shell; it loads its body fragment from the UI route on page load. */
export function renderInstallationReposCard(agentId: string): string {
  const base = `/admin/agents/${escapeHtml(agentId)}/github-installation`;
  return `<div class="card" id="github-installation-card" data-base-url="${base}">
      <div class="card-title">Installation repos</div>
      <p style="color:#6b7280;font-size:12px;margin:0 0 12px">The repos on this agent's own GitHub App installation, per organization. Changes apply immediately and are audited; the agent's configured repos are not changed here.</p>
      <div id="github-installation-body">Loading...</div>
      <div id="github-installation-result" style="margin-top:12px"></div>
      <script>
        (function() {
          var card = document.getElementById('github-installation-card');
          var body = document.getElementById('github-installation-body');
          var out = document.getElementById('github-installation-result');
          if (!card || !body || !out) return;
          var base = card.getAttribute('data-base-url');
          function text(r) { return r.text(); }
          function fail() { out.textContent = 'The request failed.'; }
          function load() {
            return fetch(base, { credentials: 'same-origin' }).then(text)
              .then(function(t) { body.innerHTML = t; })
              .catch(function() { body.textContent = 'The request failed.'; });
          }
          function post(url, payload) {
            return fetch(url, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload)
            }).then(text);
          }
          card.addEventListener('click', function(e) {
            var t = e.target;
            if (!t || !t.getAttribute) return;
            var act = t.getAttribute('data-action');
            if (!act) return;
            if (act === 'add') {
              var input = document.getElementById('github-installation-add');
              var repos = input.value.split(/[\\s,]+/).filter(function(s) { return s; });
              if (!repos.length) return;
              t.disabled = true;
              post(base + '/repos/add', { repos: repos })
                .then(function(h) { out.innerHTML = h; return load(); })
                .catch(fail).then(function() { t.disabled = false; });
            } else if (act === 'remove') {
              var repo = t.getAttribute('data-repo');
              if (!window.confirm('Remove ' + repo + ' from the installation?')) return;
              t.disabled = true;
              post(base + '/repos/remove', { repos: [repo] })
                .then(function(h) { out.innerHTML = h; return load(); })
                .catch(fail).then(function() { t.disabled = false; });
            } else if (act === 'lost-access-preview') {
              t.disabled = true;
              out.textContent = 'Loading...';
              fetch('/admin/agents/${escapeHtml(agentId)}/github-lost-access/preview', { credentials: 'same-origin' })
                .then(text).then(function(h) { out.innerHTML = h; })
                .catch(fail).then(function() { t.disabled = false; });
            } else if (act === 'lost-access-apply') {
              var box = document.getElementById('github-lost-access-confirm');
              var cap = document.getElementById('github-lost-access-confirm-cap');
              var holder = document.getElementById('github-lost-access-plan');
              if (!box || !box.checked || (cap && !cap.checked) || !holder) return;
              t.disabled = true;
              post('/admin/agents/${escapeHtml(agentId)}/github-lost-access/remove', {
                repos: JSON.parse(holder.getAttribute('data-repos') || '[]'),
                confirmRemovals: !!(cap && cap.checked)
              }).then(function(h) { out.innerHTML = h; return load(); })
                .catch(fail);
            }
          });
          out.addEventListener('change', function() {
            var box = document.getElementById('github-lost-access-confirm');
            var cap = document.getElementById('github-lost-access-confirm-cap');
            var apply = document.getElementById('github-lost-access-apply-btn');
            if (box && apply) apply.disabled = !(box.checked && (!cap || cap.checked));
          });
          load();
        })();
      </script>
    </div>`;
}

/**
 * The card body: repos per org with the user-can-push hint (only when known),
 * add and remove, and the lost-access button (or why it is unavailable).
 */
export function renderInstallationReposBody(
  view: InstallationReposView,
  githubUsername: string | null | undefined,
): string {
  const orgs =
    view.orgs.length === 0
      ? `<p class="empty-state">The agent App is not installed on any organization the installer can reach.</p>`
      : view.orgs
          .map((o) => {
            const rows =
              o.repos.length === 0
                ? `<tr><td colspan="3" class="empty-state">No repos.</td></tr>`
                : o.repos
                    .map((r) => {
                      const hint =
                        r.userCanPush === undefined
                          ? ""
                          : r.userCanPush
                            ? '<span class="badge badge-green" title="The bound user can push">user can push</span>'
                            : '<span class="badge badge-warning" title="The bound user cannot push">user cannot push</span>';
                      return `<tr><td class="mono">${escapeHtml(r.fullName)}</td><td>${hint}</td><td><button type="button" class="btn btn-danger" style="font-size:11px;padding:3px 8px" data-action="remove" data-repo="${escapeHtml(r.fullName)}">Remove</button></td></tr>`;
                    })
                    .join("");
            return `<div class="github-installation-org" data-org="${escapeHtml(o.org)}" style="margin-bottom:16px"><div style="font-weight:600;margin-bottom:6px">${escapeHtml(o.org)}</div><table class="detail-table"><thead><tr><th>Repo</th><th>Bound user</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
          })
          .join("");
  const add = `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
      <input id="github-installation-add" type="text" class="form-input mono" placeholder="Repos to add (owner/repo, comma separated)" style="min-width:320px" />
      <button type="button" class="btn btn-primary" data-action="add">Add</button>
    </div>`;
  const lost = githubUsername
    ? `<button type="button" class="btn btn-danger" id="github-lost-access-btn" data-action="lost-access-preview">Remove repos the user can no longer push to</button>`
    : `<div class="alert alert-warning" data-reason="no-username">${escapeHtml(NO_USERNAME_REASON)}</div>`;
  return `${add}${orgs}<div style="margin-top:12px">${lost}</div>`;
}

/** Why the card body could not be shown, distinct per cause. */
export function renderInstallationReposError(
  status: number,
  message: string,
): string {
  if (status === 503) {
    return `<div class="alert alert-warning" data-reason="installer-unconfigured">${escapeHtml(INSTALLER_UNCONFIGURED_REASON)}</div>`;
  }
  return `<div class="alert alert-error" data-reason="error">${escapeHtml(message)}</div>`;
}

/** Fragment for add/remove on the installation. */
export function renderInstallationChangeResult(
  kind: "add" | "remove",
  res: { auditId?: string; repos?: string[] },
): string {
  const repos = (res.repos ?? [])
    .map((r) => `<span class="mono">${escapeHtml(r)}</span>`)
    .join(", ");
  const audit = res.auditId
    ? ` Audit id: <span class="mono">${escapeHtml(res.auditId)}</span>.`
    : "";
  return `<div class="alert alert-success">${kind === "add" ? "Added to" : "Removed from"} the installation: ${repos}.${audit}</div>`;
}

/**
 * Confirm step for lost-access removal: lists exactly what will be removed,
 * the skipped orgs, the open work that would be blocked (per repo, linked),
 * and the extra confirmation over the cap.
 */
export function renderLostAccessPreview(view: LostAccessPreviewView): string {
  if (view.status === "skipped") {
    return `<div class="alert alert-warning" data-reason="skipped">Nothing to remove: ${escapeHtml(view.reason ?? "the preview was skipped")}.</div>`;
  }
  const repos = view.repos ?? [];
  const parts = [
    skippedOrgsHtml(view.skippedOrgs),
    warningsHtml(view.warnings),
  ];
  if (repos.length === 0) {
    parts.push(
      `<p class="empty-state">No repos to remove: the bound user can still push to everything that could be checked.</p>`,
    );
    return parts.join("");
  }
  const inInstall = new Set((view.installationRemoves ?? []).map(lc));
  const inConfig = new Set((view.configRemoves ?? []).map(lc));
  const rows = repos
    .map(
      (r) =>
        `<tr><td class="mono">${escapeHtml(r)}</td><td>${inInstall.has(lc(r)) ? "installation" : ""}</td><td>${inConfig.has(lc(r)) ? "agent repos" : ""}</td></tr>`,
    )
    .join("");
  parts.push(
    `<div style="font-weight:600;margin:8px 0 6px">These ${repos.length} repos will be removed</div><table class="detail-table"><thead><tr><th>Repo</th><th>Removed from</th><th></th></tr></thead><tbody>${rows}</tbody></table>`,
  );
  parts.push(
    renderOpenWorkByRepo(
      view.openWork ?? [],
      "Open tasks and PRs that will be blocked",
      "No open tasks or PRs would be blocked.",
    ),
  );
  const overCap = repos.length > MAX_UNCONFIRMED_REMOVALS;
  const capConfirm = overCap
    ? `<label style="display:block;margin-bottom:8px"><input type="checkbox" id="github-lost-access-confirm-cap" /> This removes ${repos.length} repos (more than ${MAX_UNCONFIRMED_REMOVALS}). I confirm the removals.</label>`
    : "";
  parts.push(
    `<div id="github-lost-access-plan" style="margin-top:12px" data-repos="${escapeHtml(JSON.stringify(repos))}" data-over-cap="${overCap}">
        <label style="display:block;margin-bottom:8px"><input type="checkbox" id="github-lost-access-confirm" /> I have reviewed this list and want to remove these repos.</label>
        ${capConfirm}
        <button type="button" class="btn btn-danger" id="github-lost-access-apply-btn" data-action="lost-access-apply" disabled>Remove</button>
      </div>`,
  );
  return parts.join("");
}

/**
 * The work that was actually blocked: the open work seen at confirmation on
 * the repos that were removed, minus repos whose blocking the API warned about.
 */
export function actuallyBlockedWork(
  seen: readonly OpenWorkView[],
  removedRepos: readonly string[],
  warnings: readonly string[],
): OpenWorkView[] {
  const removed = new Set(removedRepos.map(lc));
  return seen.filter(
    (w) =>
      removed.has(lc(w.repo)) &&
      !warnings.some((x) =>
        x.includes(`open work for ${w.repo} was not blocked`),
      ),
  );
}

/** Result of the lost-access removal: audit, outcome per repo, blocked work. */
export function renderLostAccessResult(
  res: LostAccessRemoveView,
  blocked: readonly OpenWorkView[],
): string {
  if (res.status === "skipped") {
    return `<div class="alert alert-warning" data-reason="skipped">Nothing was removed: ${escapeHtml(res.reason ?? "skipped")}.</div>`;
  }
  const notRemoved = (res.notRemoved ?? []).length
    ? `<div class="alert alert-warning">Left alone:<ul style="margin:6px 0 0 18px">${(res.notRemoved ?? []).map((n) => `<li><span class="mono">${escapeHtml(n.repo)}</span>: ${escapeHtml(n.reason)}</li>`).join("")}</ul></div>`
    : "";
  const tail = `${notRemoved}${skippedOrgsHtml(res.skippedOrgs)}${warningsHtml(res.warnings)}`;
  if (res.status === "noop") {
    return `<div class="alert alert-warning">Nothing to remove: none of the named repos still lacks push access.</div>${tail}`;
  }
  const repos = (res.repos ?? [])
    .map((r) => `<span class="mono">${escapeHtml(r)}</span>`)
    .join(", ");
  const audit = res.auditId
    ? ` Audit id: <span class="mono">${escapeHtml(res.auditId)}</span>.`
    : "";
  return `<div class="alert alert-success">Removed ${(res.repos ?? []).length} repos: ${repos}.${audit}</div>${renderOpenWorkByRepo(
    blocked,
    "Open tasks and PRs that were blocked",
    "No open tasks or PRs were blocked.",
  )}${tail}`;
}

/**
 * Confirm step for removing one repo from the agent's own repos: the open work
 * it would block, per repo, linked. Confirming posts to the removal route.
 */
export function renderRepoRemovalConfirm(
  agentId: string,
  preview: RepoRemovalPreviewView,
): string {
  const url = `/admin/agents/${escapeHtml(agentId)}/repos/remove-confirmed`;
  return `<div class="alert alert-warning" id="repo-removal-confirm-panel" data-repo="${escapeHtml(preview.repo)}">Remove <span class="mono">${escapeHtml(preview.repo)}</span> from this agent's repos?</div>${renderOpenWorkByRepo(
    preview.openWork,
    "Open tasks and PRs that will be blocked",
    "No open tasks or PRs would be blocked.",
  )}${warningsHtml(preview.warnings)}<button type="button" class="btn btn-danger" id="repo-removal-confirm-btn" data-url="${url}" data-repo="${escapeHtml(preview.repo)}">Confirm removal</button>`;
}

/** Result of removing a repo from the agent's repos, with what was blocked. */
export function renderRepoRemovalResult(
  repo: string,
  blocked: readonly OpenWorkView[],
  warnings: readonly string[],
): string {
  return `<div class="alert alert-success">Removed <span class="mono">${escapeHtml(repo)}</span> from the agent's repos. Reload the page to refresh the list.</div>${renderOpenWorkByRepo(
    blocked,
    "Open tasks and PRs that were blocked",
    "No open tasks or PRs were blocked.",
  )}${warningsHtml(warnings)}`;
}

/** Agent repos the installation does not cover (warning only; case-insensitive). */
export function uncoveredRepos(
  agentRepos: readonly string[],
  installationRepos: readonly string[],
): string[] {
  const covered = new Set(installationRepos.map(lc));
  return agentRepos.filter((r) => !covered.has(lc(r)));
}

/** The badge shown on an uncovered repo row of the agent's repos list. */
export function renderUncoveredBadge(): string {
  return ` <span class="badge badge-warning" data-uncovered="1" title="The agent App's installation does not cover this repo. Nothing is changed automatically.">not on installation</span>`;
}
