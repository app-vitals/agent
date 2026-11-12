/**
 * admin/src/admin-ui-installation-repos-pages.ts
 * Pure renderers for the agent detail page's GitHub Sync card (IRM-3.2): one
 * Sync button, the read-only list of repos on the agent App's installation per
 * org (with the user-can-push hint), and the single confirm step that lists
 * installation adds, installation removes, agent-repo removes and the open work
 * that would be blocked. It also renders the open-work lists shown for the
 * agent-repo removal (IRM-1.7) and the coverage warning on the agent's repos
 * list. Platform-admin only; the caller decides visibility, and only renders
 * the card when the installer and lookup Apps are both configured. Every
 * dynamic value is escaped. Inputs carry repo names and ids only.
 */

import { escapeHtml } from "./admin-ui-styles.ts";
import {
  MAX_UNCONFIRMED_REMOVALS,
  MISSING_APP_ID_REASON,
} from "./installation-ports.ts";

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

/** JSON body of GET /agents/:id/repos/:owner/:name/removal-preview. */
export interface RepoRemovalPreviewView {
  repo: string;
  openWork: OpenWorkView[];
  warnings: string[];
}

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

export const NO_USERNAME_REASON =
  "No GitHub username is bound to this agent, so there is nothing to sync against. Bind one under Owner and identities.";

export const APP_ID_MISMATCH_MESSAGE =
  "No installation matches the GH_APP_ID of this agent, although the Installations card matches an installation by App slug. GH_APP_ID is probably set to the wrong numeric App id; correct it in the agent env.";

/** JSON body of GET /agents/:id/github-sync/preview. */
export interface GithubSyncPreviewView {
  status: "previewed" | "skipped";
  reason?: string;
  appAdds?: string[];
  appRemoves?: string[];
  agentRemoves?: string[];
  skippedOrgs?: { org: string; reason: string }[];
  openWork?: OpenWorkView[];
  warnings?: string[];
}

/** JSON body of POST /agents/:id/github-sync/apply. */
export interface GithubSyncApplyView {
  status: "applied" | "noop" | "skipped";
  reason?: string;
  appAdds?: string[];
  appRemoves?: string[];
  agentRemoves?: string[];
  notApplied?: { repo: string; reason: string }[];
  skippedOrgs?: { org: string; reason: string }[];
  warnings?: string[];
}

export interface GithubSyncCardState {
  /** The agent has a GH_APP_ID in its env. */
  hasAppId: boolean;
  githubUsername?: string | null;
}

/**
 * The Sync card shell; it loads its repos body from the UI route on page load.
 * Without a GH_APP_ID or a bound username the button is replaced by the
 * reason (missing App id first).
 */
export function renderGithubSyncCard(
  agentId: string,
  state: GithubSyncCardState,
): string {
  const id = escapeHtml(agentId);
  const base = `/admin/agents/${id}/github-installation`;
  let action: string;
  if (!state.hasAppId) {
    action = `<div class="alert alert-warning" data-reason="missing-app-id">${escapeHtml(MISSING_APP_ID_REASON)}</div>`;
  } else if (!state.githubUsername?.trim()) {
    action = `<div class="alert alert-warning" data-reason="no-username">${escapeHtml(NO_USERNAME_REASON)}</div>`;
  } else {
    action = `<button type="button" class="btn btn-primary" id="github-sync-btn" data-url="/admin/agents/${id}/github-sync/confirm">Sync</button><div id="github-sync-confirm" style="margin-top:12px"></div>`;
  }
  const loader = state.hasAppId
    ? `<div id="github-installation-body">Loading...</div>`
    : "";
  return `<div class="card" id="github-installation-card" data-base-url="${base}">
      <div class="card-title">GitHub sync</div>
      <p style="color:#6b7280;font-size:12px;margin:0 0 12px">Brings this agent's App installation and its repos in line with what the bound GitHub user can push to.</p>
      ${action}
      ${loader}
      <script>
        (function() {
          var card = document.getElementById('github-installation-card');
          var body = document.getElementById('github-installation-body');
          var out = document.getElementById('github-sync-confirm');
          if (!card) return;
          function show(r) { return r.text().then(function(t) { out.innerHTML = t; }); }
          function fail() { out.textContent = 'The request failed.'; }
          if (body) {
            fetch(card.getAttribute('data-base-url'), { credentials: 'same-origin' })
              .then(function(r) { return r.text(); })
              .then(function(t) { body.innerHTML = t; })
              .catch(function() { body.textContent = 'The request failed.'; });
          }
          if (!out) return;
          card.addEventListener('click', function(e) {
            var t = e.target;
            if (!t || !t.id) return;
            if (t.id === 'github-sync-btn') {
              out.textContent = 'Loading...';
              fetch(t.getAttribute('data-url'), { credentials: 'same-origin' }).then(show).catch(fail);
            } else if (t.id === 'github-sync-confirm-btn') {
              var payload = JSON.parse(t.getAttribute('data-body') || '{}');
              var cb = document.getElementById('github-sync-confirm-removals');
              if (cb) payload.confirmRemovals = cb.checked;
              t.disabled = true;
              fetch(t.getAttribute('data-url'), {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
              }).then(show).catch(fail);
            }
          });
          card.addEventListener('change', function(e) {
            var t = e.target;
            if (t && t.id === 'github-sync-confirm-removals') {
              var btn = document.getElementById('github-sync-confirm-btn');
              if (btn) btn.disabled = !t.checked;
            }
          });
        })();
      </script>
    </div>`;
}

/** The card body: read-only repos per org with the user-can-push hint (only when known). */
export function renderInstallationReposBody(
  view: InstallationReposView,
  opts: { appIdMismatch?: boolean } = {},
): string {
  if (view.orgs.length === 0) {
    if (opts.appIdMismatch) {
      return `<div class="alert alert-warning" data-reason="app-id-mismatch">${escapeHtml(APP_ID_MISMATCH_MESSAGE)}</div>`;
    }
    return `<p class="empty-state">The agent App is not installed on any organization the installer can reach.</p>`;
  }
  return view.orgs
    .map((o) => {
      const rows =
        o.repos.length === 0
          ? `<tr><td colspan="2" class="empty-state">No repos.</td></tr>`
          : o.repos
              .map((r) => {
                const hint =
                  r.userCanPush === undefined
                    ? ""
                    : r.userCanPush
                      ? '<span class="badge badge-green" title="The bound user can push">user can push</span>'
                      : '<span class="badge badge-warning" title="The bound user cannot push">user cannot push</span>';
                return `<tr><td class="mono">${escapeHtml(r.fullName)}</td><td>${hint}</td></tr>`;
              })
              .join("");
      return `<div class="github-installation-org" data-org="${escapeHtml(o.org)}" style="margin-bottom:16px"><div style="font-weight:600;margin-bottom:6px">${escapeHtml(o.org)}</div><table class="detail-table"><thead><tr><th>Repo</th><th>Bound user</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .join("");
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

const repoList = (kind: string, title: string, repos: readonly string[]) =>
  repos.length === 0
    ? ""
    : `<div data-list="${kind}" style="margin-top:8px"><div style="font-weight:600">${escapeHtml(title)} (${repos.length})</div><ul style="margin:4px 0 0 18px">${repos.map((r) => `<li class="mono">${escapeHtml(r)}</li>`).join("")}</ul></div>`;

const skippedOrgsHtml = (
  skipped: readonly { org: string; reason: string }[],
) =>
  skipped.length === 0
    ? ""
    : `<div class="alert alert-warning" data-skipped-orgs="1"><div style="font-weight:600">Skipped orgs (nothing added or removed there)</div>${skipped.map((s) => `<div><span class="mono">${escapeHtml(s.org)}</span>: ${escapeHtml(s.reason)}</div>`).join("")}</div>`;

/**
 * The single confirm step of Sync: the installation adds, installation
 * removes, agent-repo removes and the open work the removals would block. One
 * confirmation applies them all; more than the removal cap needs the extra
 * checkbox (confirmRemovals).
 */
export function renderSyncConfirm(
  agentId: string,
  preview: GithubSyncPreviewView,
): string {
  if (preview.status === "skipped") {
    return `<div class="alert alert-warning" data-sync="skipped">Sync was skipped: ${escapeHtml(preview.reason ?? "unknown reason")}</div>`;
  }
  const appAdds = preview.appAdds ?? [];
  const appRemoves = preview.appRemoves ?? [];
  const agentRemoves = preview.agentRemoves ?? [];
  const skipped = skippedOrgsHtml(preview.skippedOrgs ?? []);
  const warnings = warningsHtml(preview.warnings);
  if (appAdds.length + appRemoves.length + agentRemoves.length === 0) {
    return `<div class="alert alert-success" data-sync="in-sync">Already in sync: nothing to add or remove.</div>${skipped}${warnings}`;
  }
  const removals = new Set([...appRemoves, ...agentRemoves].map(lc)).size;
  const overCap = removals > MAX_UNCONFIRMED_REMOVALS;
  const body = escapeHtml(
    JSON.stringify({ appAdds, appRemoves, agentRemoves }),
  );
  const url = `/admin/agents/${escapeHtml(agentId)}/github-sync/apply-confirmed`;
  const capBox = overCap
    ? `<label style="display:block;margin:12px 0"><input type="checkbox" id="github-sync-confirm-removals" /> I confirm removing ${removals} repos (more than ${MAX_UNCONFIRMED_REMOVALS}).</label>`
    : "";
  return `<div class="alert alert-warning" data-sync="confirm">Apply these changes?</div>${repoList("app-adds", "Add to the agent App installation", appAdds)}${repoList("app-removes", "Remove from the agent App installation", appRemoves)}${repoList("agent-removes", "Remove from the agent's repos", agentRemoves)}${renderOpenWorkByRepo(
    preview.openWork ?? [],
    "Open tasks and PRs that will be blocked",
    "No open tasks or PRs would be blocked.",
  )}${skipped}${warnings}${capBox}<button type="button" class="btn btn-danger" id="github-sync-confirm-btn" data-url="${url}" data-body="${body}"${overCap ? " disabled" : ""}>Confirm sync</button>`;
}

/** Result of applying a sync, with the open work that was blocked. */
export function renderSyncResult(
  result: GithubSyncApplyView,
  blocked: readonly OpenWorkView[],
): string {
  if (result.status === "skipped") {
    return `<div class="alert alert-warning" data-sync="skipped">Sync was skipped: ${escapeHtml(result.reason ?? "unknown reason")}</div>`;
  }
  if (result.status === "noop") {
    return `<div class="alert alert-success" data-sync="noop">Nothing was changed.</div>${warningsHtml(result.warnings)}`;
  }
  const notApplied = result.notApplied ?? [];
  return `<div class="alert alert-success" data-sync="applied">Sync applied. Reload the page to refresh the lists.</div>${repoList("app-adds", "Added to the agent App installation", result.appAdds ?? [])}${repoList("app-removes", "Removed from the agent App installation", result.appRemoves ?? [])}${repoList("agent-removes", "Removed from the agent's repos", result.agentRemoves ?? [])}${
    notApplied.length === 0
      ? ""
      : `<div class="alert alert-warning" data-not-applied="1"><div style="font-weight:600">Left alone</div>${notApplied.map((n) => `<div><span class="mono">${escapeHtml(n.repo)}</span>: ${escapeHtml(n.reason)}</div>`).join("")}</div>`
  }${skippedOrgsHtml(result.skippedOrgs ?? [])}${renderOpenWorkByRepo(
    blocked,
    "Open tasks and PRs that were blocked",
    "No open tasks or PRs were blocked.",
  )}${warningsHtml(result.warnings)}`;
}
