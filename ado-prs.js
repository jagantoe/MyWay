/* Azure DevOps - Pull requests of favorite repositories (Services and Server).
 *
 * What it does
 *   On a repository's pull request page (.../_git/<repo>/pullrequests, tabs "Mine" and "Active") the native list,
 *   which only shows the current repository, is hidden and replaced by the active PRs of all repositories you marked
 *   as favorite in the project (falls back to the current repository when there are none).
 *   - "Mine":   split into "Created by me", "Assigned to me" and "Assigned to my teams".
 *   - "Active": one list with all active PRs of the favorite repositories.
 *   Each row shows author, title, draft/labels, target branch, repository, reviewer votes, comment threads
 *   (active/resolved) and the time of the last activity. Rows use ADO's own CSS classes so they look native.
 *
 * How it works
 *   Read-only GET requests on the same origin with the session cookie (connectionData, repositories, favorites,
 *   my teams, active PRs of the project, and the threads of each shown PR - max 6 in parallel). Results are cached
 *   for 30 seconds. A MutationObserver follows the SPA navigation: the list is shown on Mine/Active and the native
 *   list is restored on other pages.
 *
 * Usage
 *   Run it as a bookmarklet (see README.md) or paste it in the DevTools console on a pull request page.
 *   Running it again turns it off and restores the native list.
 *   Console helpers: window.__favPrs.refresh() (reload, bypass the cache), window.__favPrs.disable().
 */
(() => {
  'use strict';
  // Clicking the bookmarklet again turns it off.
  if (window.__favPrs) { window.__favPrs.disable(); return; }

  const LIST_SELECTOR = null;
  const ROOT_ID = 'fav-pr-root', STYLE_ID = 'fav-pr-style', HOST_CLASS = 'fav-pr-host';
  const CACHE_MS = 30000;
  const MAX_PARALLEL = 6;
  const COLUMNS = ['8px', '3rem', '100%', '12rem', '10rem', '5rem', '10rem', '2.625rem', '8px'];
  const VOTES = {
    '10': ['CompletedSolid', 'approved', '#107c10', 'Approved'],
    '5': ['CompletedSolid', 'approved', '#107c10', 'Approved with suggestions'],
    '-5': ['Clock', 'waiting', '#d67f3c', 'Waiting for author'],
    '-10': ['StatusErrorFull', 'rejected', '#cd4a45', 'Rejected'],
  };

  let cache = null;
  let renderedFor = null;
  let timer = 0;
  const activityCache = new Map();
  const queue = [];
  let running = 0;
  const root = document.createElement('div');
  root.id = ROOT_ID;

  const R = `#${ROOT_ID}`;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${HOST_CLASS} { display: none !important; }
    ${R} { overflow: auto; }
    ${R} .fav-pr-info { padding: 4px 0 12px; }
    ${R} .repos-pr-section-card { margin-bottom: 16px; }
    ${R} .fav-pr-card-header { display: flex; align-items: center; gap: 8px; padding: 12px 20px 4px; }
    ${R} .fav-pr-count { padding: 0 8px; border-radius: 10px; background: rgba(127,127,127,.15); font-size: 12px; line-height: 20px; }
    ${R} .fav-pr-table-wrap { width: 100%; }
    ${R} .fav-pr-empty { padding: 20px; }
    ${R} .fav-pr-pill { margin-left: 8px; }
    ${R} .fav-pr-comments .fabric-icon { margin-right: 4px; }
  `;
  document.head.append(style);

  function getContext() {
    const segs = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const i = segs.indexOf('_git');
    if (i < 0 || (segs[i + 2] || '').toLowerCase() !== 'pullrequests') return null;
    const orgDepth = location.hostname === 'dev.azure.com' ? 1 : 0;
    const repo = segs[i + 1];
    return {
      orgBase: location.origin + (orgDepth ? '/' + encodeURIComponent(segs[0]) : ''),
      project: i > orgDepth ? segs[i - 1] : repo,
      repo,
      tab: (new URLSearchParams(location.search).get('_a') || 'mine').toLowerCase(),
    };
  }

  async function api(url) {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json();
  }

  function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      running++;
      fn().then(resolve, reject).finally(() => { running--; pump(); });
    }
  }

  async function loadActivePrs(orgBase, projectId) {
    const all = [];
    const top = 500;
    for (let skip = 0; ; skip += top) {
      const r = await api(`${orgBase}/${projectId}/_apis/git/pullrequests?searchCriteria.status=active&$top=${top}&$skip=${skip}&api-version=7.1`);
      all.push(...r.value);
      if (r.value.length < top) return all;
    }
  }

  async function loadData(ctx) {
    const [conn, repos] = await Promise.all([
      api(`${ctx.orgBase}/_apis/connectionData`),
      api(`${ctx.orgBase}/${encodeURIComponent(ctx.project)}/_apis/git/repositories?api-version=7.1`).then(r => r.value),
    ]);
    const current = repos.find(r => r.name.toLowerCase() === ctx.repo.toLowerCase());
    const projectId = (current || repos[0]).project.id;
    const [favs, teams, prs] = await Promise.all([
      api(`${ctx.orgBase}/_apis/Favorite/Favorites?artifactType=Microsoft.TeamFoundation.Git.Repository&api-version=7.1-preview.1`)
        .then(r => r.value || [])
        .catch(err => { console.warn('[favPrs] favorites unavailable', err); return []; }),
      api(`${ctx.orgBase}/_apis/projects/${projectId}/teams?$mine=true&api-version=7.1`)
        .then(r => r.value || [])
        .catch(() => []),
      loadActivePrs(ctx.orgBase, projectId),
    ]);
    const favIds = new Set(favs.map(f => String(f.artifactId).toLowerCase()));
    let favRepos = repos.filter(r => favIds.has(r.id.toLowerCase()));
    if (!favRepos.length && current) favRepos = [current];
    const repoIds = new Set(favRepos.map(r => r.id.toLowerCase()));
    return {
      me: conn.authenticatedUser.id,
      teamIds: new Set(teams.map(t => t.id)),
      favRepos,
      prs: prs
        .filter(p => repoIds.has(p.repository.id.toLowerCase()))
        .sort((a, b) => new Date(b.creationDate) - new Date(a.creationDate)),
    };
  }

  function getData(ctx) {
    const key = `${ctx.orgBase}|${ctx.project}`.toLowerCase();
    if (!cache || cache.key !== key || Date.now() - cache.time > CACHE_MS) {
      activityCache.clear();
      cache = { key, time: Date.now(), promise: loadData(ctx) };
    }
    return cache.promise;
  }

  function prActivity(pr, orgBase) {
    const key = `${pr.repository.id}/${pr.pullRequestId}`;
    if (!activityCache.has(key)) {
      const url = `${orgBase}/${pr.repository.project.id}/_apis/git/repositories/${pr.repository.id}/pullRequests/${pr.pullRequestId}/threads?api-version=7.1`;
      activityCache.set(key, limit(() => api(url)).then(r => {
        // System threads (votes, pushes, ...) only contain non-text comments.
        const threads = r.value.filter(t => !t.isDeleted && t.comments?.some(c => c.commentType === 'text' && !c.isDeleted));
        const active = threads.filter(t => t.status === 'active' || t.status === 'pending').length;
        const updated = r.value.reduce((max, t) => {
          const d = new Date(t.lastUpdatedDate || t.publishedDate);
          return d > max ? d : max;
        }, new Date(pr.creationDate));
        return { total: threads.length, active, updated };
      }));
    }
    return activityCache.get(key);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function icon(name, extraCls = '') {
    const wrap = el('span', 'fluent-icons-enabled');
    const i = el('span', `flex-noshrink fabric-icon ms-Icon--${name} ${extraCls}`);
    i.setAttribute('aria-hidden', 'true');
    wrap.append(i);
    return wrap;
  }

  function shortTime(date) {
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (now - date < 7 * 86400000) return date.toLocaleDateString(undefined, { weekday: 'long' });
    return date.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
    });
  }

  const branch = ref => (ref || '').replace(/^refs\/heads\//, '');

  function coin(identity, size) {
    const c = el('div', `bolt-coin flex-noshrink size${size}`);
    c.title = identity.displayName || '';
    const img = el('img', `bolt-coin-content using-image size${size}`);
    img.src = identity.imageUrl || '';
    img.alt = '';
    c.append(img);
    return c;
  }

  function cell(extraCls, contentCls, ...children) {
    const td = el('td', `bolt-table-cell bolt-list-cell ${extraCls}`);
    td.setAttribute('role', 'gridcell');
    const content = el('div', `bolt-table-cell-content ${contentCls}`);
    content.append(...children);
    td.append(content);
    return td;
  }

  function spacerCell() {
    const td = el('td', 'bolt-table-cell-compact bolt-table-cell bolt-list-cell bolt-table-spacer-cell');
    td.setAttribute('role', 'presentation');
    return td;
  }

  function reviewer(r) {
    const wrap = el('div', 'pr-reviewer relative');
    const vote = VOTES[String(r.vote)];
    wrap.title = `${r.displayName}${vote ? ': ' + vote[3] : ''}${r.isRequired ? ' (required)' : ''}`;
    wrap.append(coin(r, 24));
    if (vote) {
      const v = icon(vote[0], `repos-pr-reviewer-vote absolute ${vote[1]}`);
      v.firstChild.style.color = vote[2];
      wrap.append(v);
    }
    return wrap;
  }

  function row(pr, orgBase, first) {
    const a = el('a', `bolt-table-row bolt-list-row single-click-activation v-align-middle selectable-text${first ? ' first-row' : ''}`);
    a.href = `${orgBase}/${encodeURIComponent(pr.repository.project.name)}/_git/${encodeURIComponent(pr.repository.name)}/pullrequest/${pr.pullRequestId}`;
    a.setAttribute('role', 'row');

    const titleLine = el('div', 'bolt-table-two-line-cell-item flex-row scroll-hidden');
    const title = el('div', 'body-l flex-self-center text-ellipsis', pr.title);
    title.title = pr.title;
    titleLine.append(title);
    const pills = [...(pr.isDraft ? ['Draft'] : []), ...(pr.labels || []).filter(l => l.active !== false).map(l => l.name)];
    pills.forEach(text => {
      const p = el('div', 'bolt-pill flex-row flex-center standard compact flex-noshrink fav-pr-pill');
      p.append(el('div', 'bolt-pill-content text-ellipsis', text));
      titleLine.append(p);
    });

    const subLine = el('div', 'bolt-table-two-line-cell-item flex-row scroll-hidden');
    const sub = el('div', 'secondary-text body-s text-ellipsis');
    const subSpan = el('span', null, `${pr.createdBy.displayName} request !${pr.pullRequestId} into `);
    subSpan.append(icon('OpenSource'), el('span', 'monospaced-xs padding-horizontal-4', branch(pr.targetRefName)));
    sub.append(subSpan);
    subLine.append(sub);

    const repoName = el('div', 'text-ellipsis', pr.repository.name);
    repoName.title = `${pr.repository.name}\n${branch(pr.sourceRefName)} → ${branch(pr.targetRefName)}`;

    const reviewers = el('div', 'flex-row flex-center rhythm-horizontal-8');
    [...(pr.reviewers || [])]
      .sort((x, y) => Math.abs(y.vote) - Math.abs(x.vote))
      .forEach(rv => reviewers.append(reviewer(rv)));

    const commentCount = el('span', 'repos-pr-list-comment-count', '');
    const comments = el('div', 'flex-row flex-center secondary-text fav-pr-comments');
    comments.append(icon('ActivityFeed'), commentCount);

    const updated = el('div');
    prActivity(pr, orgBase).then(({ total, active, updated: date }) => {
      commentCount.textContent = String(total);
      comments.title = total ? `${active} active, ${total - active} resolved` : 'No comment threads';
      const time = el('time', 'bolt-time-item white-space-nowrap', shortTime(date));
      time.dateTime = date.toISOString();
      time.title = date.toLocaleString();
      updated.replaceChildren('Updated ', time);
    }).catch(err => console.warn('[favPrs] activity unavailable', err));

    a.append(
      spacerCell(),
      cell('', 'flex-row flex-center', coin(pr.createdBy, 32)),
      cell('bolt-table-two-line-cell', 'flex-column', titleLine, subLine),
      cell('', 'flex-row flex-center', repoName),
      cell('', 'flex-row flex-center', reviewers),
      cell('', 'flex-row flex-center', comments),
      cell('', 'flex-row flex-center', updated),
      cell('bolt-table-cell-side-action', ''),
      spacerCell(),
    );
    return a;
  }

  function card(title, prs, orgBase) {
    const c = el('div', 'flex-noshrink repos-pr-section-card bolt-card flex-column depth-8 bolt-card-white');
    const header = el('div', 'fav-pr-card-header');
    header.append(el('div', 'title-m', title), el('span', 'fav-pr-count', String(prs.length)));
    c.append(header);

    const content = el('div', 'bolt-card-content flex-row flex-grow');
    if (!prs.length) {
      content.append(el('div', 'fav-pr-empty secondary-text', 'No pull requests'));
      c.append(content);
      return c;
    }
    const wrap = el('div', 'flex-column scroll-hidden fav-pr-table-wrap');
    const container = el('div', 'bolt-table-container flex-grow h-scroll-hidden');
    const table = el('table', 'repos-pr-list bolt-table bolt-table-show-lines bolt-list body-m relative scroll-hidden');
    table.setAttribute('role', 'grid');
    table.style.width = '100%';
    const colgroup = el('colgroup');
    COLUMNS.forEach(w => {
      const col = el('col');
      col.style.width = w;
      colgroup.append(col);
    });
    const tbody = el('tbody', 'relative');
    prs.forEach((pr, i) => tbody.append(row(pr, orgBase, i === 0)));
    table.append(colgroup, tbody);
    container.append(table);
    wrap.append(container);
    content.append(wrap);
    c.append(content);
    return c;
  }

  function buildView({ me, teamIds, favRepos, prs }, ctx) {
    const info = el('div', 'fav-pr-info secondary-text',
      `Favorite repositories (${favRepos.length}): ${favRepos.map(r => r.name).sort().join(', ')}`);
    if (ctx.tab === 'active') return [info, card('Active', prs, ctx.orgBase)];

    const created = prs.filter(p => p.createdBy.id === me);
    const assigned = prs.filter(p => p.createdBy.id !== me && p.reviewers?.some(r => r.id === me));
    const teams = prs.filter(p => p.createdBy.id !== me && !assigned.includes(p) && p.reviewers?.some(r => teamIds.has(r.id)));
    const sections = [['Created by me', created], ['Assigned to me', assigned], ['Assigned to my teams', teams]]
      .filter(([, list]) => list.length);
    return [info, ...(sections.length
      ? sections.map(([title, list]) => card(title, list, ctx.orgBase))
      : [card('Mine', [], ctx.orgBase)])];
  }

  const viewKey = ctx => `${ctx.orgBase}|${ctx.project}|${ctx.tab}`.toLowerCase();

  async function render(ctx) {
    const key = viewKey(ctx);
    renderedFor = key;
    root.replaceChildren(el('div', 'fav-pr-info secondary-text', 'Loading pull requests of favorite repositories…'));
    try {
      const data = await getData(ctx);
      if (renderedFor === key) root.replaceChildren(...buildView(data, ctx));
    } catch (err) {
      console.error('[favPrs]', err);
      if (renderedFor === key) {
        root.replaceChildren(el('div', 'fav-pr-info',
          `Could not load pull requests: ${err.message}. Click the bookmarklet again to restore the default list.`));
      }
    }
  }

  function findHosts() {
    if (LIST_SELECTOR) return [...document.querySelectorAll(LIST_SELECTOR)];
    const hosts = [];
    const tabbars = [...document.querySelectorAll('.bolt-tabbar')];
    const tabbar = tabbars.find(t => t.querySelector('[href*="_a=active"], [id*="active" i]')) || tabbars[0];
    for (let n = tabbar; n && n !== document.body && !hosts.length; n = n.parentElement) {
      for (let s = n.nextElementSibling; s; s = s.nextElementSibling) {
        if (s !== root && !['STYLE', 'SCRIPT'].includes(s.tagName) && !/filter/i.test(String(s.className))) hosts.push(s);
      }
    }
    // Native PR lists rendered elsewhere than after the tab bar.
    document.querySelectorAll('a[href*="/pullrequest/"]').forEach(a => {
      if (root.contains(a)) return;
      const box = a.closest('.bolt-card, .bolt-table-container, .bolt-table');
      if (box && !hosts.some(h => h.contains(box))) hosts.push(box);
    });
    return hosts;
  }

  function tick() {
    const ctx = getContext();
    const hosts = ctx && (ctx.tab === 'mine' || ctx.tab === 'active') ? findHosts() : [];
    document.querySelectorAll('.' + HOST_CLASS).forEach(h => { if (!hosts.includes(h)) h.classList.remove(HOST_CLASS); });
    if (!hosts.length) {
      root.remove();
      renderedFor = null;
      return;
    }
    hosts.forEach(h => h.classList.add(HOST_CLASS));
    if (hosts[0].nextElementSibling !== root) hosts[0].after(root);
    const cls = [...hosts[0].classList].filter(c => c !== HOST_CLASS).join(' ');
    if (root.className !== cls) root.className = cls;
    if (renderedFor !== viewKey(ctx)) render(ctx);
  }

  const observer = new MutationObserver(muts => {
    if (muts.every(m => root.contains(m.target))) return;
    clearTimeout(timer);
    timer = setTimeout(tick, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function disable() {
    observer.disconnect();
    clearTimeout(timer);
    root.remove();
    style.remove();
    document.querySelectorAll('.' + HOST_CLASS).forEach(h => h.classList.remove(HOST_CLASS));
    delete window.__favPrs;
  }

  window.__favPrs = {
    disable,
    refresh: () => { cache = null; renderedFor = null; tick(); },
  };
  tick();
})();
