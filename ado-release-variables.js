/* Azure DevOps - Release Variables Insight (Services and Server).
 *
 * What it does
 *   Opens a side panel on a classic release definition (_releaseDefinition?definitionId=..) or a release
 *   (_releaseProgress?releaseId=..) that shows how pipeline variables and variable groups resolve per stage:
 *   - Variables:     effective value per stage (with source and overridden values) or grouped by source.
 *   - Group compare: the linked variable groups side by side, differences highlighted.
 *   - References:    every $(var), variables['var'] / variables.var expression and env var read in scripts,
 *                    per stage, job and task, task groups expanded (also nested ones).
 *   - Issues:        undefined or out-of-scope references, secrets read as env vars, conflicting groups, empty
 *                    values, unused or redundant variables and (on a release) group changes since the snapshot.
 *   The effective matrix can be copied as CSV or Markdown.
 *
 * How it works
 *   Read-only GET requests: the release definition / release (Release API), variable groups and task groups
 *   (Distributed Task API). On Azure DevOps Services the Release API lives on the vsrm host, where the session cookie
 *   is not accepted, so the bearer token of the page (VSS/Authentication/Services) is reused. If that fails, the panel
 *   asks for a PAT, which is kept in memory only. Precedence used: stage pipeline variable > release pipeline variable
 *   > group linked to the stage > group linked to the release. A definition is analysed as last saved.
 *
 * Usage
 *   Run it as a bookmarklet (see README.md) or paste it in the DevTools console. A "Variables Insight" button is
 *   added to the tab bar (or bottom right); Esc closes the panel. Running it again replaces the running instance.
 *   Console helpers: window.__adoVarInsight.open() / close() / reload() / destroy(), .model, .analysis.
 */
(() => {
  'use strict';

  if (window.__adoVarInsight) { try { window.__adoVarInsight.destroy(); } catch (e) { /* stale instance */ } }

  const RM_VERSIONS = ['5.0', '4.1'];
  const DT_VERSIONS = ['5.0-preview.1', '4.1-preview.1'];
  const RELEASE = '__release';
  const PREDEFINED = /^(system|build|release|agent|pipeline|environment|task|deployment|common|tf_build|resources|parameters)\./i;
  const SCRIPT_KEY = /script|inline|command|arguments|args/i;
  const MAX_TG_DEPTH = 8;
  const RE_MACRO = /\$\(([^()\s$]+)\)/g;
  const RE_RUNTIME = /variables\[\s*['"]([^'"]+)['"]\s*\]|variables\.([\w.-]+)/gi;
  const RE_ENV = /\$[eE][nN][vV]:([A-Za-z_]\w*)|%([A-Za-z_]\w*)%|\$\{?([A-Z_][A-Z0-9_]*)\b/g;

  const STATUS_TEXT = {
    'ok': 'Defined for this stage',
    'predefined': 'Predefined / system variable',
    'param': 'Task group parameter',
    'undefined': 'Not defined (unless set at runtime via task.setvariable)',
    'out-of-scope': 'Defined, but not available in this stage',
    'secret-env': 'Secret read as environment variable - secrets are not mapped to env vars',
    'unused-context': 'Not evaluated - the variable containing it is not used in any stage',
  };
  const KIND_TEXT = { macro: '$(...)', runtime: 'expression', env: 'env var', param: 'parameter', multiplier: 'multiplier', nested: 'nested' };

  // ---------- utils ----------
  const unique = arr => [...new Set(arr)];
  const byRank = arr => [...(arr || [])].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const groupBy = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); return m; }, new Map());
  const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const envName = n => n.toUpperCase().replace(/[.\s]/g, '_');
  const cmpText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  const valueKey = d => (d.isKeyVault ? `kv:${d.groupId}:${d.lname}` : d.isSecret ? `secret:${d.source}:${d.groupId ?? d.scopeKey}` : `v:${d.value}`);
  const plainValue = d => (d.isKeyVault ? '(Key Vault)' : d.isSecret ? '***' : String(d.value));
  let scopeNames = new Map();
  const scopeName = k => scopeNames.get(k) || k;
  const sourceLabel = d => (d.source === 'pipeline' ? `pipeline · ${d.scopeKey === RELEASE ? 'release' : 'stage'}` : `group · ${d.groupName}`);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') Object.assign(el.style, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }
  const badge = (text, kind, title) => h('span', { class: `avi-badge${kind ? ` avi-b-${kind}` : ''}`, title }, text);

  // ---------- page context ----------
  function detectPage() {
    const url = new URL(location.href);
    if (!/_release|releasemanagement/i.test(url.pathname)) return null;
    const releaseId = url.searchParams.get('releaseId');
    const definitionId = url.searchParams.get('definitionId');
    const mode = releaseId ? 'release' : definitionId ? 'definition' : null;
    const base = mode && projectBaseUrl(url);
    return base ? { mode, id: Number(releaseId || definitionId), base, rmBase: releaseBaseUrl(base) } : null;
  }

  // Azure DevOps Services hosts the Release APIs on a separate vsrm host; Server hosts them on the same one
  function releaseBaseUrl(base) {
    const u = new URL(base);
    if (u.hostname === 'dev.azure.com') u.hostname = 'vsrm.dev.azure.com';
    else if (/^[^.]+\.visualstudio\.com$/i.test(u.hostname)) u.hostname = u.hostname.replace(/\.visualstudio\.com$/i, '.vsrm.visualstudio.com');
    return u.toString().replace(/\/$/, '');
  }

  function projectBaseUrl(url) {
    const segs = url.pathname.split('/').filter(Boolean);
    const idx = segs.findIndex(s => s.startsWith('_'));
    if (idx >= 1) return `${url.origin}/${segs.slice(0, idx).join('/')}`;
    const wc = window.__vssPageContext?.webContext;
    if (wc?.collection?.uri && wc?.project?.name) return `${wc.collection.uri.replace(/\/$/, '')}/${encodeURIComponent(wc.project.name)}`;
    return null;
  }

  const samePage = (a, b) => !!a && !!b && a.mode === b.mode && a.id === b.id && a.base === b.base;

  // ---------- API ----------
  const auth = { pat: null, host: null };
  const authError = message => Object.assign(new Error(message), { needsPat: true });

  function amdRequire(mods, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const req = typeof window.require === 'function' ? window.require : window.requirejs;
      if (typeof req !== 'function') { reject(new Error('page module loader not available')); return; }
      const timer = setTimeout(() => reject(new Error(`timed out loading ${mods.join(', ')}`)), timeoutMs);
      try {
        req(mods, (...m) => { clearTimeout(timer); resolve(m); }, e => { clearTimeout(timer); reject(e); });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // Same session token the ADO web UI attaches when it calls the vsrm host
  async function hostAuthHeader(refresh) {
    const [svc] = await amdRequire(['VSS/Authentication/Services']);
    const mgr = svc.authTokenManager;
    const token = await mgr.getAuthToken(!!refresh);
    return mgr.getAuthorizationHeader(token);
  }

  function authHeaderFor(origin, refresh) {
    if (auth.pat) return Promise.resolve(`Basic ${btoa(`:${auth.pat}`)}`);
    if (origin === location.origin) return Promise.resolve(null);
    if (!auth.host || refresh) {
      auth.host = hostAuthHeader(refresh).catch(e => {
        auth.host = null;
        throw authError(`Could not obtain the page's access token (${e?.message || e}).`);
      });
    }
    return auth.host;
  }

  async function getJson(base, path, versions) {
    const origin = new URL(base).origin;
    let lastError;
    for (const v of versions) {
      const url = `${base}/_apis/${path}${path.includes('?') ? '&' : '?'}api-version=${v}`;
      let res;
      for (let attempt = 0; attempt < 2; attempt++) {
        const header = await authHeaderFor(origin, attempt > 0);
        const init = { headers: { Accept: 'application/json' }, credentials: header ? 'omit' : 'same-origin' };
        if (header) init.headers.Authorization = header;
        try {
          res = await fetch(url, init);
        } catch (e) {
          throw authError(`${path}: request to ${origin} failed (${e.message}).`);
        }
        // an expired host token gets one refresh
        if (res.status !== 401 || !header || auth.pat) break;
      }
      const isJson = (res.headers.get('content-type') || '').includes('json');
      if (res.ok && isJson) return res.json();
      // 203 + HTML is the sign-in page
      if (res.ok || res.status === 401 || res.status === 403) throw authError(`${path}: not authorized on ${origin} (${res.status}).`);
      let msg = `${res.status} ${res.statusText}`;
      if (isJson) { try { msg += ` - ${(await res.json()).message || ''}`; } catch (e) { /* no body */ } }
      lastError = new Error(`${path}: ${msg}`);
      // 400 is what the server returns for an unsupported api-version
      if (res.status !== 400) break;
    }
    throw lastError;
  }
  const rm = (page, path) => getJson(page.rmBase, path, RM_VERSIONS);
  const dt = (page, path) => getJson(page.base, path, DT_VERSIONS);

  const cmpVer = (a = {}, b = {}) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
  function pickVersion(versions, spec) {
    if (!versions.length) throw new Error('not found');
    const major = parseInt(String(spec ?? ''), 10);
    const sorted = [...versions].sort((a, b) => cmpVer(b.version, a.version));
    return sorted.find(v => v.version?.major === major && !v.version?.isTest)
      || sorted.find(v => v.version?.major === major)
      || sorted[0];
  }
  function makeTaskGroupLoader(page) {
    const cache = new Map();
    return (id, versionSpec) => {
      if (!cache.has(id)) cache.set(id, dt(page, `distributedtask/taskgroups/${id}`).then(r => r.value || [r]));
      return cache.get(id).then(versions => pickVersion(versions, versionSpec));
    };
  }

  async function loadGroups(page, ids) {
    if (!ids.length) return [];
    return (await dt(page, `distributedtask/variablegroups?groupIds=${ids.join(',')}`)).value || [];
  }

  // ---------- model ----------
  async function loadModel(page) {
    let raw;
    if (page.mode === 'definition') {
      const def = await rm(page, `release/definitions/${page.id}`);
      const envs = byRank(def.environments);
      const ids = unique([...(def.variableGroups || []), ...envs.flatMap(e => e.variableGroups || [])]);
      raw = {
        kind: 'definition',
        title: def.name,
        subtitle: `Release definition #${def.id} · revision ${def.revision} (saved version - unsaved edits are not included)`,
        variables: def.variables,
        groupRefs: def.variableGroups || [],
        groups: await loadGroups(page, ids),
        envs: envs.map(e => ({ id: e.id, name: e.name, variables: e.variables, groupRefs: e.variableGroups || [], phases: e.deployPhases || [] })),
      };
    } else {
      const rel = await rm(page, `release/releases/${page.id}`);
      const envs = byRank(rel.environments);
      const snapshots = [...(rel.variableGroups || []), ...envs.flatMap(e => e.variableGroups || [])];
      const groups = [...new Map(snapshots.map(g => [g.id, g])).values()];
      let current = null;
      try { current = new Map((await loadGroups(page, groups.map(g => g.id))).map(g => [g.id, g])); } catch (e) { /* drift check is optional */ }
      raw = {
        kind: 'release',
        title: `${rel.releaseDefinition?.name || 'Release'} - ${rel.name}`,
        subtitle: `Release #${rel.id} · snapshot taken ${new Date(rel.createdOn).toLocaleString()}`,
        variables: rel.variables,
        groupRefs: (rel.variableGroups || []).map(g => g.id),
        groups,
        current,
        envs: envs.map(e => ({ id: e.id, name: e.name, variables: e.variables, groupRefs: (e.variableGroups || []).map(g => g.id), phases: e.deployPhasesSnapshot || [] })),
      };
    }
    return buildModel(raw, makeTaskGroupLoader(page));
  }

  async function buildModel(raw, loadTg) {
    const scopes = [{ key: RELEASE, name: 'Release' }, ...raw.envs.map(e => ({ key: String(e.id), name: e.name }))];
    scopeNames = new Map(scopes.map(s => [s.key, s.name]));

    const links = new Map();
    const link = (gid, key) => { if (!links.has(gid)) links.set(gid, new Set()); links.get(gid).add(key); };
    raw.groupRefs.forEach(id => link(id, RELEASE));
    raw.envs.forEach(e => e.groupRefs.forEach(id => link(id, String(e.id))));

    const groupsById = new Map(raw.groups.map(g => [g.id, g]));
    const groups = [...links].map(([gid, keys]) => {
      const g = groupsById.get(gid) || { id: gid, name: `Variable group #${gid} (not accessible)`, variables: {} };
      const variables = g.variables || {};
      const cur = raw.current?.get(gid);
      const lowerNames = new Set(Object.keys(variables).map(n => n.toLowerCase()));
      return {
        id: gid,
        name: g.name,
        description: g.description,
        isKeyVault: /keyvault/i.test(g.type || ''),
        scopeKeys: scopes.map(s => s.key).filter(k => keys.has(k)),
        variables,
        vmap: new Map(Object.entries(variables).map(([n, v]) => [n.toLowerCase(), { name: n, v }])),
        current: cur,
        addedSinceRelease: cur ? Object.keys(cur.variables || {}).filter(n => !lowerNames.has(n.toLowerCase())) : [],
      };
    }).sort((a, b) => cmpText(a.name, b.name));

    const defs = [];
    const pushVars = (vars, scopeKey) => Object.entries(vars || {}).forEach(([name, v]) => defs.push({
      name, lname: name.toLowerCase(), value: v?.value ?? '', isSecret: !!v?.isSecret, allowOverride: !!v?.allowOverride, source: 'pipeline', scopeKey,
    }));
    pushVars(raw.variables, RELEASE);
    raw.envs.forEach(e => pushVars(e.variables, String(e.id)));
    for (const g of groups) {
      for (const [name, v] of Object.entries(g.variables)) {
        let drift = null;
        if (g.current) {
          const c = Object.entries(g.current.variables || {}).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
          if (!c) drift = 'removed from the group since this release';
          else if (!v?.isSecret && !g.isKeyVault && (c.value ?? '') !== (v?.value ?? '')) drift = `current value in group: ${c.value ?? ''}`;
        }
        defs.push({
          name, lname: name.toLowerCase(), value: g.isKeyVault ? '' : v?.value ?? '', isSecret: !!v?.isSecret || g.isKeyVault, isKeyVault: g.isKeyVault,
          source: 'group', groupId: g.id, groupName: g.name, scopeKeys: g.scopeKeys, drift,
        });
      }
    }

    const envMap = new Map();
    defs.forEach(d => { const k = envName(d.name); if (!envMap.has(k)) envMap.set(k, new Set()); envMap.get(k).add(d.name); });

    const c = { envMap, loadTg };
    const stages = [];
    for (const e of raw.envs) {
      const phases = await Promise.all(byRank(e.phases).map(p => buildPhase(p, c)));
      stages.push({ key: String(e.id), name: e.name, phases });
    }
    return { kind: raw.kind, title: raw.title, subtitle: raw.subtitle, scopes, groups, defs, stages };
  }

  // ---------- reference extraction ----------
  function scanText(text, opts, envMap, paramScope) {
    if (text == null || typeof text === 'object') return [];
    const s = String(text);
    if (!s) return [];
    const refs = new Map();
    const add = (name, kind) => {
      const lname = name.toLowerCase();
      if (kind !== 'env' && paramScope?.has(lname)) kind = 'param';
      refs.set(`${kind}|${lname}`, { name, lname, kind });
    };
    for (const m of s.matchAll(RE_MACRO)) add(m[1], 'macro');
    if (opts.condition || s.includes('$[')) for (const m of s.matchAll(RE_RUNTIME)) add(m[1] || m[2], 'runtime');
    if (opts.script && envMap) {
      for (const m of s.matchAll(RE_ENV)) {
        const token = m[1] ? m[1].toUpperCase() : m[2] ? m[2].toUpperCase() : m[3];
        for (const n of envMap.get(token) || []) add(n, 'env');
      }
    }
    return [...refs.values()];
  }

  function addField(node, label, text, opts, c, paramScope) {
    const refs = scanText(text, opts, c.envMap, paramScope);
    if (refs.length) node.fields.push({ label, text: String(text), refs });
  }

  const PHASE_TYPES = { 1: 'Agent job', 2: 'Agentless job', 4: 'Deployment group job', 8: 'Gates' };

  async function buildPhase(p, c) {
    const di = p.deploymentInput || {};
    const node = { name: p.name || 'Job', type: PHASE_TYPES[p.phaseType] || p.phaseType || '', fields: [], tasks: [] };
    addField(node, 'Job name', p.name, {}, c, null);
    addField(node, 'Job condition', di.condition, { condition: true }, c, null);
    (di.demands || []).forEach((d, i) => addField(node, `Demand ${i + 1}`, typeof d === 'string' ? d : `${d.name} ${d.value || ''}`, {}, c, null));
    const mult = di.parallelExecution?.multipliers;
    if (mult) {
      const refs = String(mult).split(',').map(s => s.trim()).filter(Boolean).map(n => ({ name: n, lname: n.toLowerCase(), kind: 'multiplier' }));
      if (refs.length) node.fields.push({ label: 'Multipliers', text: String(mult), refs });
    }
    Object.entries(di.overrideInputs || {}).forEach(([k, v]) => addField(node, `Override: ${k}`, v, {}, c, null));
    node.tasks = await Promise.all((p.workflowTasks || []).map(t => buildTask(t, c, null, 0, new Set())));
    return node;
  }

  function normalizeTask(t) {
    const inner = t.task || {};
    return {
      name: t.name || t.displayName || t.refName || 'Task',
      enabled: t.enabled !== false,
      isGroup: /metatask/i.test(String(t.definitionType || inner.definitionType || '')),
      id: t.taskId || inner.id,
      versionSpec: t.version || inner.versionSpec,
      inputs: t.inputs || {},
      condition: t.condition,
      environment: t.environment || {},
      overrideInputs: t.overrideInputs || {},
    };
  }

  async function buildTask(t, c, paramScope, depth, seen) {
    const n = normalizeTask(t);
    const node = { name: n.name, enabled: n.enabled, isGroup: n.isGroup, tgName: null, note: null, fields: [], children: [] };
    addField(node, 'Display name', n.name, {}, c, paramScope);
    Object.entries(n.inputs).forEach(([k, v]) => addField(node, `Input: ${k}`, v, { script: SCRIPT_KEY.test(k) }, c, paramScope));
    addField(node, 'Condition', n.condition, { condition: true }, c, paramScope);
    Object.entries(n.environment).forEach(([k, v]) => addField(node, `Env: ${k}`, v, {}, c, paramScope));
    Object.entries(n.overrideInputs).forEach(([k, v]) => addField(node, `Override: ${k}`, v, {}, c, paramScope));
    if (!n.isGroup) return node;
    if (depth >= MAX_TG_DEPTH || seen.has(n.id)) { node.note = 'Nested task group not expanded (recursion)'; return node; }
    try {
      const tg = await c.loadTg(n.id, n.versionSpec);
      node.tgName = `${tg.name} v${tg.version?.major ?? '?'}`;
      const params = new Set((tg.inputs || []).map(i => i.name.toLowerCase()));
      for (const inp of tg.inputs || []) {
        if (!String(n.inputs[inp.name] ?? '').trim() && inp.defaultValue) addField(node, `Default for parameter: ${inp.name}`, inp.defaultValue, {}, c, paramScope);
      }
      const next = new Set(seen).add(n.id);
      node.children = await Promise.all((tg.tasks || []).map(ct => buildTask(ct, c, params, depth + 1, next)));
    } catch (e) {
      node.note = `Task group could not be loaded: ${e.message}`;
    }
    return node;
  }

  // ---------- analysis ----------
  function analyze(m) {
    const stageKeys = m.stages.map(s => s.key);
    const byName = groupBy(m.defs, d => d.lname);
    const inScope = (d, key) => (d.source === 'pipeline' ? d.scopeKey === key : d.scopeKeys.includes(key));

    const memo = new Map();
    const resolve = (lname, key) => {
      const mk = `${lname}|${key}`;
      if (memo.has(mk)) return memo.get(mk);
      const ds = byName.get(lname) || [];
      const tiers = key === RELEASE
        ? [['pipeline', RELEASE], ['group', RELEASE]]
        : [['pipeline', key], ['pipeline', RELEASE], ['group', key], ['group', RELEASE]];
      const seen = new Set();
      const ordered = [];
      let winnerTier = null;
      for (const [src, k] of tiers) {
        const tier = ds.filter(d => d.source === src && inScope(d, k) && !seen.has(d));
        tier.forEach(d => seen.add(d));
        if (tier.length && !winnerTier) winnerTier = tier;
        ordered.push(...tier);
      }
      const res = ordered.length ? {
        winner: ordered[0],
        shadowed: ordered.slice(1),
        candidates: winnerTier,
        conflict: winnerTier.length > 1 && new Set(winnerTier.map(valueKey)).size > 1,
      } : null;
      memo.set(mk, res);
      return res;
    };

    const statusAt = (r, key) => {
      if (r.kind === 'param') return 'param';
      const res = resolve(r.lname, key);
      if (res) return r.kind === 'env' && res.winner.isSecret ? 'secret-env' : 'ok';
      if (PREDEFINED.test(r.name)) return 'predefined';
      return byName.has(r.lname) ? 'out-of-scope' : 'undefined';
    };

    const refs = [];
    for (const st of m.stages) {
      for (const ph of st.phases) {
        const phPath = [st.name, `${ph.name}${ph.type ? ` (${ph.type})` : ''}`];
        ph.fields.forEach(f => f.refs.forEach(r => refs.push(Object.assign(r, { stageKey: st.key, path: [...phPath, f.label] }))));
        const walk = (t, path, disabled) => {
          const tp = [...path, t.isGroup ? `${t.name} [task group${t.tgName ? `: ${t.tgName}` : ''}]` : t.name];
          const off = disabled || !t.enabled;
          t.fields.forEach(f => f.refs.forEach(r => refs.push(Object.assign(r, { stageKey: st.key, path: [...tp, f.label], disabled: off }))));
          t.children.forEach(ch => walk(ch, tp, off));
        };
        ph.tasks.forEach(t => walk(t, phPath, false));
      }
    }
    refs.forEach(r => { r.status = statusAt(r, r.stageKey); });

    const direct = refs.filter(r => r.kind !== 'param');
    const refsByName = groupBy(direct, r => r.lname);
    const stageRefCount = new Map();
    direct.forEach(r => {
      if (!stageRefCount.has(r.lname)) stageRefCount.set(r.lname, new Map());
      const sm = stageRefCount.get(r.lname);
      sm.set(r.stageKey, (sm.get(r.stageKey) || 0) + 1);
    });

    // a value is only expanded in stages where its variable is used (directly or via another value)
    const valueRefs = new Map(m.defs.map(d => [d, d.isSecret ? [] : scanText(d.value, { condition: false }, null, null)]));
    const evaluatedIn = new Map();
    const usedSet = new Set();
    for (const k of stageKeys) {
      const used = new Set(direct.filter(r => r.stageKey === k).map(r => r.lname));
      const queue = [...used];
      while (queue.length) {
        const w = resolve(queue.pop(), k)?.winner;
        if (!w) continue;
        if (!evaluatedIn.has(w)) evaluatedIn.set(w, new Set());
        evaluatedIn.get(w).add(k);
        for (const r of valueRefs.get(w)) if (!used.has(r.lname)) { used.add(r.lname); queue.push(r.lname); }
      }
      used.forEach(l => usedSet.add(l));
    }

    const nestedRefs = [];
    const nestedBy = new Map();
    const rank = ['secret-env', 'out-of-scope', 'undefined', 'predefined', 'param', 'ok'];
    for (const d of m.defs) {
      const keys = [...(evaluatedIn.get(d) || [])];
      for (const r of valueRefs.get(d)) {
        let status = 'unused-context';
        let where = ' › not evaluated (variable is not used in any stage)';
        let stageKey = null;
        if (keys.length) {
          const failing = keys.map(k => ({ k, s: statusAt(r, k) })).filter(x => x.s !== 'ok' && x.s !== 'predefined');
          status = failing.length ? failing.map(x => x.s).sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0] : 'ok';
          where = ` › evaluated in ${(failing.length ? failing.map(x => x.k) : keys).map(scopeName).join(', ')}`;
          stageKey = failing[0]?.k ?? keys[0];
        }
        nestedRefs.push(Object.assign(r, { kind: 'nested', status, stageKey, path: [`Value of ${d.name} (${sourceLabel(d)})${where}`], fromDef: d }));
        if (!nestedBy.has(r.lname)) nestedBy.set(r.lname, []);
        nestedBy.get(r.lname).push(d);
      }
    }

    const issues = [];
    const add = (severity, type, varName, title, detail, locations) => issues.push({ severity, type, varName, lname: varName?.toLowerCase(), title, detail, locations });
    const availableIn = l => m.scopes.filter(s => resolve(l, s.key)).map(s => s.name);

    const bad = groupBy([...refs, ...nestedRefs].filter(r => ['undefined', 'out-of-scope', 'secret-env'].includes(r.status)), r => `${r.status}|${r.lname}`);
    for (const rs of bad.values()) {
      const r0 = rs[0];
      const locs = rs.map(r => r.path.join(' › '));
      if (r0.status === 'undefined') add('warning', 'undefined', r0.name, 'Referenced but not defined', 'Not defined in the pipeline or any linked variable group (fine if it is set at runtime via task.setvariable).', locs);
      else if (r0.status === 'out-of-scope') add('error', 'scope', r0.name, 'Used in a stage where it is not available', `Available in: ${availableIn(r0.lname).join(', ') || '-'} · used in: ${unique(rs.map(r => scopeName(r.stageKey))).join(', ')}`, locs);
      else add('error', 'secret-env', r0.name, 'Secret read as environment variable', 'Secret variables are not mapped to environment variables automatically; map it explicitly in the task (Environment variables section).', locs);
    }

    for (const [l, ds] of byName) {
      const name = ds[0].name;
      if (!usedSet.has(l) && !PREDEFINED.test(name)) {
        add('info', 'unused', name, 'Defined but never referenced', `Defined in: ${ds.map(d => `${sourceLabel(d)} (${d.source === 'pipeline' ? scopeName(d.scopeKey) : d.scopeKeys.map(scopeName).join(', ')})`).join('; ')}. It may still be read implicitly, e.g. by a script file via environment variables.`);
      }
      const conflictScopes = m.scopes.filter(s => resolve(l, s.key)?.conflict);
      if (conflictScopes.length) {
        const cands = resolve(l, conflictScopes[0].key).candidates;
        add('warning', 'conflict', name, 'Defined in multiple variable groups with different values', `Scopes: ${conflictScopes.map(s => s.name).join(', ')} · ${cands.map(d => `${d.groupName} = ${plainValue(d)}`).join(' | ')}`);
      }
      const rel = ds.find(d => d.source === 'pipeline' && d.scopeKey === RELEASE && !d.isSecret);
      ds.filter(d => rel && d.source === 'pipeline' && d.scopeKey !== RELEASE && !d.isSecret && d.value === rel.value)
        .forEach(d => add('info', 'redundant', name, 'Stage value identical to release value', `Stage "${scopeName(d.scopeKey)}" repeats the release-scoped value; the stage-scoped variable can be removed.`));
      ds.filter(d => d.drift).forEach(d => add('warning', 'drift', name, 'Variable group changed since this release was created', `${d.groupName}: ${d.drift}`));
      const empty = unique(direct.filter(r => r.lname === l && r.status === 'ok').map(r => r.stageKey))
        .filter(k => { const res = resolve(l, k); return res && !res.winner.isSecret && String(res.winner.value) === ''; });
      if (empty.length) add('warning', 'empty', name, 'Referenced but value is empty', `Empty in: ${empty.map(scopeName).join(', ')}`);
    }
    for (const g of m.groups) {
      if (g.isKeyVault) add('info', 'keyvault', null, `Variable group "${g.name}" is linked to Azure Key Vault`, 'Values are fetched at deployment time and cannot be displayed.');
      if (g.addedSinceRelease.length) add('info', 'drift', null, `Variables added to group "${g.name}" since this release`, g.addedSinceRelease.join(', '));
    }
    const sevOrder = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || cmpText(a.varName || '', b.varName || ''));

    const differs = l => {
      const keys = stageKeys.map(k => resolve(l, k)).filter(Boolean).map(r => valueKey(r.winner));
      return new Set(keys).size > 1;
    };

    return {
      byName, resolve, refs, nestedRefs, nestedBy, refsByName, usedSet, issues, differs,
      issuesByName: groupBy(issues.filter(i => i.lname), i => i.lname),
      displayName: l => byName.get(l)?.[0]?.name ?? l,
      stageRefs: (l, k) => stageRefCount.get(l)?.get(k) || 0,
      refCount: l => (refsByName.get(l)?.length || 0) + (nestedBy.get(l)?.length || 0),
    };
  }

  // ---------- state ----------
  const state = {
    page: detectPage(), href: location.href, model: null, analysis: null, loading: false, error: null, open: false, tab: 'matrix',
    filters: { search: '', effective: true, onlyDiff: false, onlyUnused: false, onlyIssues: false, hidePredefined: true, showAllTasks: false },
    expanded: new Set(), compareGroups: null,
  };

  // ---------- DOM shell ----------
  const CSS = `
#avi-root{--avi-bg:#fff;--avi-bg2:#f6f6f6;--avi-bg3:#ebebeb;--avi-fg:#201f1e;--avi-muted:#6b6b6b;--avi-border:#e0e0e0;--avi-accent:#0078d4;--avi-err:#c50f1f;--avi-warn:#a4640b;--avi-ok:#107c10;--avi-param:#8764b8;font:13px/1.4 "Segoe UI",-apple-system,BlinkMacSystemFont,Roboto,"Helvetica Neue",sans-serif;color:var(--avi-fg)}
#avi-root.avi-dark{--avi-bg:#1f1f1f;--avi-bg2:#292929;--avi-bg3:#333;--avi-fg:#e8e8e8;--avi-muted:#a0a0a0;--avi-border:#3d3d3d;--avi-accent:#4aa0e6;--avi-err:#f1707b;--avi-warn:#f2c661;--avi-ok:#6ccb5f;--avi-param:#b4a0ff}
#avi-root *{box-sizing:border-box}
#avi-root .avi-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;background:#0078d4;color:#fff;border:0;border-radius:18px;padding:8px 16px;font:600 13px "Segoe UI",sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.25);cursor:pointer}
#avi-root .avi-launcher.avi-hidden{display:none}
#avi-root .avi-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483001}
#avi-root .avi-panel{display:none;position:fixed;top:0;right:0;bottom:0;width:min(1500px,96vw);background:var(--avi-bg);z-index:2147483002;box-shadow:-6px 0 24px rgba(0,0,0,.3);flex-direction:column}
#avi-root.avi-open .avi-backdrop{display:block}
#avi-root.avi-open .avi-panel{display:flex}
#avi-root.avi-open .avi-launcher{display:none}
#avi-root .avi-header{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--avi-border)}
#avi-root .avi-titles{flex:1;min-width:0}
#avi-root .avi-title{font-size:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#avi-root .avi-subtitle{color:var(--avi-muted);font-size:12px}
#avi-root .avi-status{color:var(--avi-ok);font-size:12px}
#avi-root .avi-actions{display:flex;gap:6px}
#avi-root .avi-btn{background:var(--avi-bg2);color:var(--avi-fg);border:1px solid var(--avi-border);border-radius:4px;padding:5px 10px;cursor:pointer;font:inherit}
#avi-root .avi-btn:hover{background:var(--avi-bg3)}
#avi-root .avi-btn:disabled{opacity:.5;cursor:default}
#avi-root .avi-btn.avi-on{background:var(--avi-accent);color:#fff;border-color:var(--avi-accent)}
#avi-root .avi-tabs{display:flex;gap:4px;padding:0 20px;border-bottom:1px solid var(--avi-border)}
#avi-root .avi-tab{background:none;border:0;border-bottom:2px solid transparent;padding:10px 12px;color:var(--avi-muted);cursor:pointer;font:inherit;font-weight:600}
#avi-root .avi-tab.avi-on{color:var(--avi-fg);border-bottom-color:var(--avi-accent)}
#avi-root .avi-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:10px 20px;border-bottom:1px solid var(--avi-border);background:var(--avi-bg2)}
#avi-root .avi-search{min-width:260px;padding:5px 8px;border:1px solid var(--avi-border);border-radius:4px;background:var(--avi-bg);color:var(--avi-fg);font:inherit}
#avi-root .avi-check{display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
#avi-root .avi-seg{display:inline-flex}
#avi-root .avi-seg .avi-btn{border-radius:0}
#avi-root .avi-seg .avi-btn:first-child{border-radius:4px 0 0 4px}
#avi-root .avi-seg .avi-btn:last-child{border-radius:0 4px 4px 0}
#avi-root .avi-content{flex:1;overflow:auto}
#avi-root .avi-footer{padding:6px 20px;border-top:1px solid var(--avi-border);color:var(--avi-muted);font-size:11px}
#avi-root .avi-table{border-collapse:separate;border-spacing:0;min-width:100%}
#avi-root .avi-table th{position:sticky;top:0;z-index:2;background:var(--avi-bg3);text-align:left;padding:8px 10px;border-bottom:1px solid var(--avi-border);white-space:nowrap;font-weight:600}
#avi-root .avi-table td{padding:6px 10px;border-bottom:1px solid var(--avi-border);vertical-align:top}
#avi-root .avi-table th.avi-sticky{left:0;z-index:3}
#avi-root .avi-table td.avi-sticky{position:sticky;left:0;z-index:1;background:var(--avi-bg)}
#avi-root .avi-name{cursor:pointer;min-width:220px;max-width:340px}
#avi-root .avi-name:hover .avi-vname{text-decoration:underline}
#avi-root .avi-diff td.avi-name{box-shadow:inset 3px 0 var(--avi-warn)}
#avi-root .avi-vname{font-weight:600;word-break:break-all;margin-right:4px}
#avi-root .avi-caret{display:inline-block;width:14px;color:var(--avi-muted)}
#avi-root .avi-cell{min-width:140px;max-width:320px}
#avi-root .avi-val{font-family:Consolas,"Cascadia Mono",monospace;font-size:12px;word-break:break-all;white-space:pre-wrap}
#avi-root .avi-src{font-size:11px;color:var(--avi-muted);margin-top:2px}
#avi-root .avi-none{color:var(--avi-muted);text-align:center}
#avi-root .avi-bad{background:rgba(197,15,31,.12);color:var(--avi-err);font-weight:600}
#avi-root .avi-overridden .avi-val{text-decoration:line-through;opacity:.6}
#avi-root .avi-t0{background:rgba(16,124,16,.13)}
#avi-root .avi-t1{background:rgba(0,120,212,.13)}
#avi-root .avi-t2{background:rgba(202,80,16,.15)}
#avi-root .avi-t3{background:rgba(135,100,184,.17)}
#avi-root .avi-t4{background:rgba(0,153,188,.15)}
#avi-root .avi-t5{background:rgba(194,57,179,.15)}
#avi-root .avi-badge{display:inline-block;margin:2px 4px 0 0;padding:0 6px;border-radius:9px;font-size:11px;line-height:17px;border:1px solid var(--avi-border);color:var(--avi-muted);white-space:nowrap;font-weight:400}
#avi-root .avi-b-warn{border-color:var(--avi-warn);color:var(--avi-warn)}
#avi-root .avi-b-err{border-color:var(--avi-err);color:var(--avi-err)}
#avi-root .avi-b-ref{border-color:var(--avi-accent);color:var(--avi-accent)}
#avi-root .avi-b-secret{border-color:var(--avi-param);color:var(--avi-param)}
#avi-root .avi-secret{letter-spacing:2px;color:var(--avi-muted)}
#avi-root .avi-empty{font-style:italic;color:var(--avi-muted)}
#avi-root .avi-section td{background:var(--avi-bg2);padding:10px}
#avi-root .avi-sectionsub{color:var(--avi-muted);margin-left:10px;font-size:12px}
#avi-root .avi-details>td{background:var(--avi-bg2);padding:12px 16px 16px 34px}
#avi-root .avi-detailgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px}
#avi-root .avi-details h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--avi-muted)}
#avi-root .avi-mini{border-collapse:collapse;width:100%}
#avi-root .avi-mini td{padding:3px 8px 3px 0;border-bottom:1px solid var(--avi-border);vertical-align:top}
#avi-root .avi-reflist{margin:0;padding-left:18px}
#avi-root .avi-reflist li{margin:2px 0}
#avi-root .avi-stage{margin:16px 20px;border:1px solid var(--avi-border);border-radius:6px;overflow:hidden}
#avi-root .avi-stagehead{background:var(--avi-bg3);padding:8px 12px;font-weight:600;display:flex;justify-content:space-between;gap:12px}
#avi-root .avi-phase{padding:8px 12px;border-top:1px solid var(--avi-border)}
#avi-root .avi-phasehead{font-weight:600;margin-bottom:4px}
#avi-root .avi-task{margin:4px 0 4px 14px;padding-left:10px;border-left:2px solid var(--avi-border)}
#avi-root .avi-taskname{font-weight:600}
#avi-root .avi-task.avi-disabled{opacity:.55}
#avi-root .avi-field{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;margin:2px 0}
#avi-root .avi-flabel{color:var(--avi-muted);font-size:12px;margin-right:4px;cursor:help}
#avi-root .avi-chip{border:1px solid;border-radius:10px;padding:0 8px;font:12px Consolas,"Cascadia Mono",monospace;background:transparent;line-height:18px}
#avi-root button.avi-chip{cursor:pointer}
#avi-root .avi-st-ok{color:var(--avi-ok);border-color:var(--avi-ok)}
#avi-root .avi-st-predefined,#avi-root .avi-st-unused-context{color:var(--avi-muted);border-color:var(--avi-border)}
#avi-root .avi-st-param{color:var(--avi-param);border-color:var(--avi-param)}
#avi-root .avi-st-undefined{color:var(--avi-warn);border-color:var(--avi-warn)}
#avi-root .avi-st-out-of-scope,#avi-root .avi-st-secret-env{color:var(--avi-err);border-color:var(--avi-err);background:rgba(197,15,31,.08)}
#avi-root .avi-dot{display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid;margin-right:6px;vertical-align:middle}
#avi-root .avi-legend{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
#avi-root .avi-issues{padding:8px 20px 20px}
#avi-root .avi-issue{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--avi-border)}
#avi-root .avi-sev{flex:none;width:64px;text-align:center;border-radius:3px;font-size:11px;font-weight:700;padding:2px 0;height:fit-content}
#avi-root .avi-sev-error{background:var(--avi-err);color:#fff}
#avi-root .avi-sev-warning{background:var(--avi-warn);color:#fff}
#avi-root .avi-sev-info{background:var(--avi-bg3);color:var(--avi-fg)}
#avi-root .avi-ititle{font-weight:600}
#avi-root .avi-idetail{color:var(--avi-muted);margin-top:2px}
#avi-root .avi-issue summary{cursor:pointer;color:var(--avi-accent);margin-top:4px}
#avi-root .avi-link{background:none;border:0;padding:0;margin-left:8px;color:var(--avi-accent);cursor:pointer;font:12px Consolas,monospace;text-decoration:underline}
#avi-root .avi-muted{color:var(--avi-muted)}
#avi-root .avi-msg{padding:40px;text-align:center;color:var(--avi-muted)}
#avi-root .avi-err{color:var(--avi-err)}
#avi-root .avi-spinner{width:28px;height:28px;margin:0 auto 12px;border:3px solid var(--avi-border);border-top-color:var(--avi-accent);border-radius:50%;animation:avi-spin 1s linear infinite}
@keyframes avi-spin{to{transform:rotate(360deg)}}
.avi-tabbtn{margin-left:12px;align-self:center;background:transparent;border:1px solid #0078d4;color:#0078d4;border-radius:4px;padding:2px 10px;cursor:pointer;font:600 13px "Segoe UI",sans-serif;white-space:nowrap}
`;

  const styleEl = h('style', { id: 'avi-style' }, CSS);
  const root = h('div', { id: 'avi-root' });
  const launcher = h('button', { class: 'avi-launcher', title: 'Compare release variables across stages', onclick: () => open() }, 'Variables Insight');
  const panel = h('div', { class: 'avi-panel', role: 'dialog' });
  const contentEl = h('div', { class: 'avi-content' });
  const statusEl = h('span', { class: 'avi-status' });
  root.append(launcher, h('div', { class: 'avi-backdrop', onclick: () => close() }), panel);
  document.head.append(styleEl);
  document.body.append(root);
  let tabBtn = null;

  function isDark() {
    for (const el of [document.body, document.documentElement]) {
      const c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (!c || (c.length === 4 && Number(c[3]) === 0)) continue;
      const [r, g, b] = c.map(Number);
      return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }
    return false;
  }

  function open() {
    state.open = true;
    root.classList.toggle('avi-dark', isDark());
    root.classList.add('avi-open');
    if (state.page && !state.model && !state.loading) load();
    else renderPanel();
  }
  function close() {
    state.open = false;
    root.classList.remove('avi-open');
  }

  async function load() {
    const page = state.page;
    state.loading = true;
    state.error = null;
    renderPanel();
    try {
      const model = await loadModel(page);
      if (!samePage(page, state.page)) return;
      state.model = model;
      state.analysis = analyze(model);
      state.compareGroups = new Set(model.groups.map(g => g.id));
    } catch (e) {
      console.error('[Variables Insight]', e);
      if (samePage(page, state.page)) state.error = e;
    } finally {
      if (samePage(page, state.page)) state.loading = false;
      if (state.open) renderPanel();
    }
  }

  // ---------- rendering ----------
  function renderPanel() {
    panel.replaceChildren(renderHeader(), renderTabs(), renderToolbar(), contentEl, renderFooter());
    renderContent();
  }

  function renderHeader() {
    const m = state.model;
    const a = state.analysis;
    return h('div', { class: 'avi-header' },
      h('div', { class: 'avi-titles' },
        h('div', { class: 'avi-title' }, m ? m.title : 'Release Variables Insight'),
        h('div', { class: 'avi-subtitle' }, m
          ? `${m.subtitle} · ${m.stages.length} stages · ${m.groups.length} variable groups · ${a.byName.size} variables`
          : state.page ? 'Loading…' : 'Open a release definition or a release to use this tool.')),
      statusEl,
      h('div', { class: 'avi-actions' },
        h('button', { class: 'avi-btn', onclick: () => copyExport('csv'), disabled: !m, title: 'Copy the effective variable matrix (current filters) as CSV' }, 'Copy CSV'),
        h('button', { class: 'avi-btn', onclick: () => copyExport('md'), disabled: !m, title: 'Copy the effective variable matrix (current filters) as a Markdown table' }, 'Copy Markdown'),
        h('button', { class: 'avi-btn', onclick: () => load(), disabled: !state.page || state.loading }, 'Reload'),
        h('button', { class: 'avi-btn', onclick: () => close(), title: 'Close (Esc)' }, 'Close')));
  }

  function renderTabs() {
    const a = state.analysis;
    const problems = a ? a.issues.filter(i => i.severity !== 'info').length : 0;
    const tabs = [['matrix', 'Variables'], ['compare', 'Group compare'], ['refs', 'References'], ['issues', a ? `Issues (${problems} / ${a.issues.length})` : 'Issues']];
    return h('div', { class: 'avi-tabs' }, tabs.map(([id, label]) => h('button', {
      class: `avi-tab${state.tab === id ? ' avi-on' : ''}`,
      title: id === 'issues' ? 'Errors and warnings / all findings' : null,
      onclick: () => { state.tab = id; renderPanel(); },
    }, label)));
  }

  function check(label, key, title) {
    return h('label', { class: 'avi-check', title },
      h('input', { type: 'checkbox', checked: state.filters[key], onchange: e => { state.filters[key] = e.target.checked; renderContent(); } }), label);
  }

  function renderToolbar() {
    const f = state.filters;
    const search = h('input', {
      class: 'avi-search', type: 'search', placeholder: state.tab === 'matrix' ? 'Filter by name or value…' : 'Filter by variable name…', value: f.search,
      oninput: e => { f.search = e.target.value; renderContent(); },
    });
    const bar = h('div', { class: 'avi-toolbar' }, search);
    if (state.tab === 'matrix') {
      bar.append(
        h('span', { class: 'avi-seg' },
          h('button', { class: `avi-btn${f.effective ? ' avi-on' : ''}`, title: 'One row per variable with the value that actually applies in each stage', onclick: () => { f.effective = true; renderPanel(); } }, 'Effective per stage'),
          h('button', { class: `avi-btn${f.effective ? '' : ' avi-on'}`, title: 'Rows grouped by where the variable is defined', onclick: () => { f.effective = false; renderPanel(); } }, 'By source')),
        check('Only differing between stages', 'onlyDiff'),
        check('Only unused', 'onlyUnused'),
        check('Only with warnings/errors', 'onlyIssues'),
        check('Hide System./Build./Release. style names', 'hidePredefined'));
    } else if (state.tab === 'compare') {
      const groups = state.model?.groups || [];
      bar.append(check('Only differences', 'onlyDiff'),
        h('span', { class: 'avi-legend' }, h('span', { class: 'avi-muted' }, 'Groups:'), groups.map(g => h('button', {
          class: `avi-btn${state.compareGroups?.has(g.id) ? ' avi-on' : ''}`,
          onclick: () => { state.compareGroups.has(g.id) ? state.compareGroups.delete(g.id) : state.compareGroups.add(g.id); renderPanel(); },
        }, g.name))));
    } else if (state.tab === 'refs') {
      bar.append(check('Show tasks without references', 'showAllTasks'),
        h('span', { class: 'avi-legend' }, Object.entries(STATUS_TEXT).map(([s, t]) => h('span', { class: `avi-chip avi-st-${s}`, title: t }, s))));
    }
    return bar;
  }

  function renderFooter() {
    return h('div', { class: 'avi-footer' },
      'Precedence used: stage-scoped pipeline variable > release-scoped pipeline variable > group linked to the stage > group linked to the release. ',
      'Same-level group conflicts are flagged. Secret and Key Vault values cannot be read. Click a variable name for details.');
  }

  function renderContent() {
    const scroll = contentEl.scrollTop;
    contentEl.replaceChildren();
    if (state.loading) {
      contentEl.append(h('div', { class: 'avi-msg' }, h('div', { class: 'avi-spinner' }), 'Loading definition, variable groups and task groups…'));
    } else if (state.error) {
      contentEl.append(h('div', { class: 'avi-msg avi-err' }, `Failed to load: ${state.error.message}`));
      if (state.error.needsPat) contentEl.append(patForm());
    } else if (!state.model) {
      contentEl.append(h('div', { class: 'avi-msg' }, 'Navigate to a release definition (…/_releaseDefinition?definitionId=…) or a release (…/_releaseProgress?releaseId=…).'));
    } else {
      ({ matrix: renderMatrix, compare: renderCompare, refs: renderRefs, issues: renderIssues })[state.tab](contentEl, state.model, state.analysis);
    }
    contentEl.scrollTop = scroll;
  }

  const msg = text => h('div', { class: 'avi-msg' }, text);

  function patForm() {
    const input = h('input', { class: 'avi-search', type: 'password', placeholder: 'Personal access token', autocomplete: 'off' });
    const submit = () => { const v = input.value.trim(); if (v) { auth.pat = v; load(); } };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    return h('div', { class: 'avi-msg' },
      h('div', null, 'Could not reuse the page\'s own sign-in. Provide a PAT with scopes Release (Read), Variable Groups (Read) and Task Groups (Read). It is kept in memory only and discarded when the page reloads.'),
      h('div', { style: { marginTop: '10px' } }, input, ' ', h('button', { class: 'avi-btn', onclick: submit }, 'Use token')));
  }

  function valueNode(d, full) {
    if (d.isKeyVault) return badge('Key Vault', 'secret', 'Value is fetched from Azure Key Vault at deployment time');
    if (d.isSecret) return h('span', { class: 'avi-secret', title: 'Secret value (not readable)' }, '••••••');
    const v = String(d.value);
    if (v === '') return h('span', { class: 'avi-empty' }, '(empty)');
    return h('span', { class: 'avi-val', title: full ? null : v }, full ? v : truncate(v, 160));
  }
  const refBadge = n => badge(`${n} ref${n === 1 ? '' : 's'}`, 'ref', 'Number of references in this stage');
  const sevBadge = s => h('span', { class: `avi-sev avi-sev-${s}` }, s.toUpperCase());

  function visibleNames() {
    const { analysis: a, filters: f } = state;
    const q = f.search.trim().toLowerCase();
    return [...a.byName.keys()].filter(l => {
      const ds = a.byName.get(l);
      if (f.hidePredefined && PREDEFINED.test(ds[0].name)) return false;
      if (f.onlyUnused && a.usedSet.has(l)) return false;
      if (f.onlyIssues && !(a.issuesByName.get(l) || []).some(i => i.severity !== 'info')) return false;
      if (f.onlyDiff && !a.differs(l)) return false;
      if (q && !l.includes(q) && !ds.some(d => !d.isSecret && String(d.value).toLowerCase().includes(q))) return false;
      return true;
    }).sort((x, y) => cmpText(a.displayName(x), a.displayName(y)));
  }

  function focusVar(lname) {
    state.tab = 'matrix';
    state.filters.search = state.analysis.displayName(lname);
    Object.assign(state.filters, { onlyDiff: false, onlyUnused: false, onlyIssues: false, hidePredefined: false });
    state.expanded.add(state.filters.effective ? lname : `p|${lname}`);
    renderPanel();
  }

  // ----- matrix -----
  function renderMatrix(body, m, a) {
    const cols = m.scopes.length + 2;
    const tbody = h('tbody');
    const names = visibleNames();
    if (state.filters.effective) names.forEach(l => appendRow(tbody, l, l, effectiveCells(l, m, a), cols, a));
    else renderRawSections(tbody, names, m, a, cols);
    if (!tbody.children.length) tbody.append(h('tr', null, h('td', { colSpan: cols, class: 'avi-msg' }, 'No variables match the current filters.')));
    body.append(h('table', { class: 'avi-table' },
      h('thead', null, h('tr', null,
        h('th', { class: 'avi-sticky' }, 'Variable'),
        h('th', { title: 'Direct references in tasks/conditions + references from other variable values' }, 'Refs'),
        m.scopes.map(s => h('th', null, s.name)))),
      tbody));
  }

  function appendRow(tbody, l, key, cells, cols, a) {
    const isOpen = state.expanded.has(key);
    const toggle = () => { isOpen ? state.expanded.delete(key) : state.expanded.add(key); renderContent(); };
    const stagesUsed = [...new Set((a.refsByName.get(l) || []).map(r => scopeName(r.stageKey)))];
    tbody.append(h('tr', { class: a.differs(l) ? 'avi-diff' : null },
      h('td', { class: 'avi-name avi-sticky', onclick: toggle },
        h('span', { class: 'avi-caret' }, isOpen ? '▾' : '▸'),
        h('span', { class: 'avi-vname' }, a.displayName(l)),
        nameBadges(l, a)),
      h('td', { title: stagesUsed.length ? `Referenced in: ${stagesUsed.join(', ')}` : 'Not referenced' }, String(a.refCount(l))),
      cells));
    if (isOpen) tbody.append(detailsRow(l, a, cols));
  }

  function nameBadges(l, a) {
    const ds = a.byName.get(l) || [];
    const issues = a.issuesByName.get(l) || [];
    const errors = issues.filter(i => i.severity === 'error').length;
    const warns = issues.filter(i => i.severity === 'warning').length;
    return [
      ds.some(d => d.isSecret && !d.isKeyVault) ? badge('secret', 'secret') : null,
      ds.some(d => d.allowOverride) ? badge('settable', null, 'Settable at release time') : null,
      !a.usedSet.has(l) && !PREDEFINED.test(ds[0]?.name || '') ? badge('unused', null, 'No reference found in any stage') : null,
      a.differs(l) ? badge('differs', 'warn', 'Effective value differs between stages') : null,
      errors ? badge(`${errors} error${errors > 1 ? 's' : ''}`, 'err') : null,
      warns ? badge(`${warns} warning${warns > 1 ? 's' : ''}`, 'warn') : null,
    ];
  }

  function effectiveCells(l, m, a) {
    const res = new Map(m.scopes.map(s => [s.key, a.resolve(l, s.key)]));
    const keys = unique(m.stages.map(s => res.get(s.key)).filter(Boolean).map(r => valueKey(r.winner)));
    const tint = keys.length > 1 ? new Map(keys.map((k, i) => [k, i % 6])) : null;
    return m.scopes.map(s => {
      const r = res.get(s.key);
      const n = s.key === RELEASE ? 0 : a.stageRefs(l, s.key);
      if (!r) {
        return n
          ? h('td', { class: 'avi-cell avi-bad', title: 'Referenced in this stage but not available here' }, 'not available ', refBadge(n))
          : h('td', { class: 'avi-cell avi-none', title: 'Not available in this scope' }, '—');
      }
      const t = tint?.get(valueKey(r.winner));
      return h('td', { class: `avi-cell${t != null ? ` avi-t${t}` : ''}` },
        valueNode(r.winner),
        h('div', { class: 'avi-src' }, sourceLabel(r.winner)),
        r.conflict ? badge('conflict', 'warn', `Several groups at the same level define this variable:\n${r.candidates.map(d => `${d.groupName}: ${plainValue(d)}`).join('\n')}`) : null,
        r.shadowed.length ? badge(`overrides ${r.shadowed.length}`, null, r.shadowed.map(d => `${sourceLabel(d)}: ${plainValue(d)}`).join('\n')) : null,
        r.winner.drift ? badge('changed', 'warn', `Group changed since this release - ${r.winner.drift}`) : null,
        n ? refBadge(n) : null);
    });
  }

  function renderRawSections(tbody, names, m, a, cols) {
    const nameSet = new Set(names);
    const section = (id, title, sub, defs) => {
      const rows = groupBy(defs.filter(d => nameSet.has(d.lname)), d => d.lname);
      if (!rows.size) return;
      tbody.append(h('tr', { class: 'avi-section' }, h('td', { colSpan: cols }, h('strong', null, title), sub ? h('span', { class: 'avi-sectionsub' }, sub) : null)));
      [...rows.keys()].sort((x, y) => cmpText(a.displayName(x), a.displayName(y)))
        .forEach(l => appendRow(tbody, l, `${id}|${l}`, m.scopes.map(s => rawCell(rows.get(l), s.key, a, l)), cols, a));
    };
    section('p', 'Pipeline variables', null, m.defs.filter(d => d.source === 'pipeline'));
    m.groups.forEach(g => section(`g${g.id}`, `Variable group: ${g.name}`,
      [`linked to ${g.scopeKeys.map(scopeName).join(', ')}`, g.isKeyVault ? 'Azure Key Vault' : null, g.description || null].filter(Boolean).join(' · '),
      m.defs.filter(d => d.groupId === g.id)));
  }

  function rawCell(ds, key, a, l) {
    const d = ds.find(x => (x.source === 'pipeline' ? x.scopeKey === key : x.scopeKeys.includes(key)));
    if (!d) return h('td', { class: 'avi-cell avi-none' }, '—');
    const res = a.resolve(l, key);
    const effective = res?.winner === d;
    const n = key === RELEASE ? 0 : a.stageRefs(l, key);
    return h('td', { class: `avi-cell${effective ? '' : ' avi-overridden'}`, title: effective ? null : `Overridden here by ${sourceLabel(res.winner)}` },
      valueNode(d),
      effective ? null : h('div', { class: 'avi-src' }, `overridden by ${sourceLabel(res.winner)}`),
      d.drift ? badge('changed', 'warn', `Group changed since this release - ${d.drift}`) : null,
      n ? refBadge(n) : null);
  }

  function detailsRow(l, a, cols) {
    const defs = a.byName.get(l) || [];
    const refs = a.refsByName.get(l) || [];
    const nested = a.nestedBy.get(l) || [];
    const issues = a.issuesByName.get(l) || [];
    const m = state.model;
    return h('tr', { class: 'avi-details' }, h('td', { colSpan: cols }, h('div', { class: 'avi-detailgrid' },
      h('div', null,
        h('h4', null, 'Defined in'),
        h('table', { class: 'avi-mini' }, h('tbody', null, defs.map(d => h('tr', null,
          h('td', null, d.source === 'pipeline' ? 'Pipeline' : `Group: ${d.groupName}`),
          h('td', null, d.source === 'pipeline' ? scopeName(d.scopeKey) : d.scopeKeys.map(scopeName).join(', ')),
          h('td', null, valueNode(d, true)),
          h('td', null, d.allowOverride ? badge('settable at release time') : null, d.drift ? badge('changed', 'warn', d.drift) : null))))),
        h('h4', { style: { marginTop: '12px' } }, 'Effective value per stage'),
        h('table', { class: 'avi-mini' }, h('tbody', null, m.scopes.map(s => {
          const r = a.resolve(l, s.key);
          return h('tr', null, h('td', null, s.name), h('td', null, r ? valueNode(r.winner, true) : h('span', { class: 'avi-muted' }, 'not available')), h('td', { class: 'avi-muted' }, r ? sourceLabel(r.winner) : ''));
        })))),
      h('div', null,
        h('h4', null, `Referenced (${refs.length + nested.length})`),
        refs.length || nested.length
          ? h('ul', { class: 'avi-reflist' },
            refs.map(r => h('li', { title: STATUS_TEXT[r.status] }, h('span', { class: `avi-dot avi-st-${r.status}` }), r.path.join(' › '), ' ', badge(KIND_TEXT[r.kind]), r.disabled ? badge('disabled task') : null)),
            nested.map(d => h('li', null, h('span', { class: 'avi-dot avi-st-ok' }), `Inside the value of ${d.name} (${sourceLabel(d)})`, ' ', badge('nested'))))
          : h('div', { class: 'avi-muted' }, 'No references found.'),
        issues.length ? [h('h4', { style: { marginTop: '12px' } }, 'Findings'),
          h('ul', { class: 'avi-reflist' }, issues.map(i => h('li', null, sevBadge(i.severity), ' ', i.title, i.detail ? ` - ${i.detail}` : '')))] : null))));
  }

  // ----- group compare -----
  function renderCompare(body, m) {
    if (!m.groups.length) return body.append(msg('No variable groups are linked to this release.'));
    const sel = m.groups.filter(g => state.compareGroups.has(g.id));
    if (!sel.length) return body.append(msg('Select at least one group in the toolbar.'));
    const q = state.filters.search.trim().toLowerCase();
    const names = unique(sel.flatMap(g => [...g.vmap.keys()])).filter(l => !q || l.includes(q));
    const rows = [];
    for (const l of names.sort(cmpText)) {
      const entries = sel.map(g => g.vmap.get(l));
      const keys = entries.map((e, i) => (e ? (sel[i].isKeyVault ? 'kv' : e.v?.isSecret ? `secret:${sel[i].id}` : `v:${e.v?.value ?? ''}`) : 'missing'));
      const distinct = unique(keys);
      const diff = distinct.length > 1;
      if (state.filters.onlyDiff && !diff) continue;
      const tint = diff ? new Map(distinct.filter(k => k !== 'missing').map((k, i) => [k, i % 6])) : null;
      const name = entries.find(Boolean).name;
      rows.push(h('tr', { class: diff ? 'avi-diff' : null },
        h('td', { class: 'avi-name avi-sticky', onclick: () => state.analysis.byName.has(l) && focusVar(l) }, h('span', { class: 'avi-vname' }, name), diff ? badge('differs', 'warn') : null),
        entries.map((e, i) => {
          if (!e) return h('td', { class: 'avi-cell avi-bad' }, 'missing');
          const t = tint?.get(keys[i]);
          return h('td', { class: `avi-cell${t != null ? ` avi-t${t}` : ''}` },
            valueNode({ value: e.v?.value ?? '', isSecret: !!e.v?.isSecret || sel[i].isKeyVault, isKeyVault: sel[i].isKeyVault }));
        })));
    }
    body.append(h('table', { class: 'avi-table' },
      h('thead', null, h('tr', null, h('th', { class: 'avi-sticky' }, 'Variable'),
        sel.map(g => h('th', { title: `Linked to: ${g.scopeKeys.map(scopeName).join(', ')}` }, g.name, h('div', { class: 'avi-src' }, g.scopeKeys.map(scopeName).join(', ')))))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colSpan: sel.length + 1, class: 'avi-msg' }, 'No variables match the current filters.')))));
  }

  // ----- references -----
  function chip(r, a) {
    const text = r.kind === 'env' ? `${r.name} (env)` : r.kind === 'runtime' ? `${r.name} (expr)` : r.name;
    const title = `${STATUS_TEXT[r.status]} · ${KIND_TEXT[r.kind]}`;
    return a.byName.has(r.lname)
      ? h('button', { class: `avi-chip avi-st-${r.status}`, title: `${title} · click for details`, onclick: () => focusVar(r.lname) }, text)
      : h('span', { class: `avi-chip avi-st-${r.status}`, title }, text);
  }

  function renderRefs(body, m, a) {
    const q = state.filters.search.trim().toLowerCase();
    const showAll = state.filters.showAllTasks && !q;
    const match = r => !q || r.lname.includes(q);
    const fieldHas = f => f.refs.some(match);
    const taskHas = t => t.fields.some(fieldHas) || t.children.some(taskHas);
    const renderFields = fields => fields.filter(fieldHas).map(f => h('div', { class: 'avi-field' },
      h('span', { class: 'avi-flabel', title: truncate(f.text, 2000) }, `${f.label}:`), f.refs.filter(match).map(r => chip(r, a))));
    const renderTask = t => h('div', { class: `avi-task${t.enabled ? '' : ' avi-disabled'}` },
      h('div', null, h('span', { class: 'avi-taskname' }, t.name),
        t.isGroup ? badge(`task group${t.tgName ? `: ${t.tgName}` : ''}`, 'secret') : null,
        t.enabled ? null : badge('disabled'),
        t.note ? badge(t.note, 'warn') : null),
      renderFields(t.fields),
      t.children.filter(c => showAll || taskHas(c)).map(renderTask));

    let any = false;
    for (const st of m.stages) {
      const phases = st.phases.filter(p => showAll || p.fields.some(fieldHas) || p.tasks.some(taskHas));
      if (!phases.length && !showAll) continue;
      any = true;
      const vars = unique(a.refs.filter(r => r.stageKey === st.key && r.kind !== 'param').map(r => r.lname));
      body.append(h('div', { class: 'avi-stage' },
        h('div', { class: 'avi-stagehead' }, h('span', null, st.name), h('span', { class: 'avi-muted' }, `${vars.length} distinct variables referenced`)),
        phases.map(p => h('div', { class: 'avi-phase' },
          h('div', { class: 'avi-phasehead' }, p.name, p.type ? h('span', { class: 'avi-sectionsub' }, p.type) : null),
          renderFields(p.fields),
          p.tasks.filter(t => showAll || taskHas(t)).map(renderTask)))));
    }
    const nested = a.nestedRefs.filter(match);
    if (nested.length) {
      any = true;
      body.append(h('div', { class: 'avi-stage' },
        h('div', { class: 'avi-stagehead' }, h('span', null, 'Inside variable values')),
        h('div', { class: 'avi-phase' }, nested.map(r => h('div', { class: 'avi-field' }, h('span', { class: 'avi-flabel' }, `${r.path.join(' › ')}:`), chip(r, a))))));
    }
    if (!any) body.append(msg(q ? 'No references match the filter.' : 'No variable references found.'));
  }

  // ----- issues -----
  function renderIssues(body, m, a) {
    const q = state.filters.search.trim().toLowerCase();
    const list = a.issues.filter(i => !q || (i.varName || '').toLowerCase().includes(q) || i.title.toLowerCase().includes(q));
    if (!list.length) return body.append(msg(q ? 'No findings match the filter.' : 'No findings.'));
    body.append(h('div', { class: 'avi-issues' }, list.map(i => h('div', { class: 'avi-issue' },
      sevBadge(i.severity),
      h('div', null,
        h('div', { class: 'avi-ititle' }, i.title, i.varName ? (a.byName.has(i.lname)
          ? h('button', { class: 'avi-link', onclick: () => focusVar(i.lname) }, i.varName)
          : h('span', { class: 'avi-chip avi-st-undefined', style: { marginLeft: '8px' } }, i.varName)) : null),
        i.detail ? h('div', { class: 'avi-idetail' }, i.detail) : null,
        i.locations?.length ? h('details', null, h('summary', null, `${i.locations.length} location${i.locations.length > 1 ? 's' : ''}`),
          h('ul', { class: 'avi-reflist' }, i.locations.map(p => h('li', null, p)))) : null)))));
  }

  // ---------- export ----------
  function exportRows() {
    const m = state.model;
    const a = state.analysis;
    const header = ['Variable', 'Refs', ...m.scopes.map(s => s.name)];
    const rows = visibleNames().map(l => [a.displayName(l), String(a.refCount(l)), ...m.scopes.map(s => {
      const r = a.resolve(l, s.key);
      return r ? `${plainValue(r.winner)} [${sourceLabel(r.winner)}]` : '';
    })]);
    return [header, ...rows];
  }

  function copyExport(format) {
    const rows = exportRows();
    // leading =,+,-,@ would be evaluated as formulas when the CSV is opened in Excel
    const csvCell = c => { const s = /^[=+\-@\t\r]/.test(c) ? `'${c}` : c; return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const mdCell = c => c.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    const text = format === 'csv'
      ? rows.map(r => r.map(csvCell).join(',')).join('\r\n')
      : [rows[0], rows[0].map(() => '---'), ...rows.slice(1)].map(r => `| ${r.map(mdCell).join(' | ')} |`).join('\n');
    const done = () => { statusEl.textContent = `Copied ${rows.length - 1} rows as ${format.toUpperCase()}`; setTimeout(() => { statusEl.textContent = ''; }, 3000); };
    const fallback = () => {
      const ta = h('textarea', { value: text, style: { position: 'fixed', left: '-9999px' } });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // ---------- integration with the ADO page ----------
  function tryInjectTab() {
    if (!state.page) { tabBtn?.remove(); tabBtn = null; launcher.classList.add('avi-hidden'); return; }
    const bar = [...document.querySelectorAll('.bolt-tabbar-tabs')].find(el => el.offsetParent !== null);
    if (bar && (!tabBtn || !bar.contains(tabBtn))) {
      tabBtn?.remove();
      tabBtn = h('button', { class: 'avi-tabbtn', title: 'Compare release variables across stages', onclick: e => { e.preventDefault(); e.stopPropagation(); open(); } }, 'Variables Insight');
      bar.append(tabBtn);
    }
    const tabVisible = !!tabBtn && document.contains(tabBtn) && tabBtn.offsetParent !== null;
    launcher.classList.toggle('avi-hidden', tabVisible);
  }

  function tick() {
    if (location.href !== state.href) {
      state.href = location.href;
      const page = detectPage();
      if (!samePage(page, state.page)) {
        Object.assign(state, { page, model: null, analysis: null, error: null, loading: false, compareGroups: null });
        state.expanded.clear();
        if (state.open) { if (page) load(); else renderPanel(); }
      }
    }
    tryInjectTab();
  }

  const onKey = e => { if (e.key === 'Escape' && state.open) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  const timer = setInterval(tick, 1000);
  tryInjectTab();

  window.__adoVarInsight = {
    open,
    close,
    reload: load,
    get model() { return state.model; },
    get analysis() { return state.analysis; },
    destroy() {
      clearInterval(timer);
      document.removeEventListener('keydown', onKey, true);
      tabBtn?.remove();
      root.remove();
      styleEl.remove();
      delete window.__adoVarInsight;
    },
  };

  if (state.page) open();
  else console.info('[Variables Insight] Loaded. Navigate to a release definition or release; the "Variables Insight" button will appear.');
})();
