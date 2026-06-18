// Normalise an ingredient — accepts either a plain string or {name,amount,unit}
function ingredientText(i) {
  if (!i) return '';
  if (typeof i === 'string') return i;
  const parts = [i.amount, i.unit, i.name].filter(Boolean);
  return parts.join(' ').trim();
}

// Normalise a step — accepts either a plain string or {text} object
function stepText(s) {
  if (!s) return '';
  if (typeof s === 'string') return s;
  return (s.text || s.title || '').trim();
}

/* ─────────────────────────────────────────────────────────────────
   Refectory — app.js
   LocalStorage + Cloudflare KV sync, three auth tiers.
   ───────────────────────────────────────────────────────────────── */
'use strict';

// ─── Constants ────────────────────────────────────────────────────

const STORAGE_KEY        = 'ref_appdata';
const STORAGE_AUTH_KEY   = 'ref_google_id_token';
const STORAGE_DISMISS_KEY= 'ref_token_upgrade_dismissed';
const SYNC_INTERVAL_MS   = 60_000; // 1 minute

// ─── Theme ────────────────────────────────────────────────────

const THEME_KEY = 'ref_theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const lightBtn = document.getElementById('theme-light');
  const darkBtn  = document.getElementById('theme-dark');
  if (lightBtn) lightBtn.classList.toggle('active', theme === 'light');
  if (darkBtn)  darkBtn.classList.toggle('active',  theme === 'dark');
  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(saved || preferred);
}

// ─── State ────────────────────────────────────────────────────────

const App = {
  data: null,       // full data blob — profile + recipes + mealplan
  syncTimer: null,
  pendingSync: false,
};

// Default data shape
function defaultData() {
  return {
    authMethod:  'guest',
    userToken:   Auth.generateToken(),
    workerUrl:   '',
    linkedGoogle: null,
    firstName:   '',
    lastName:    '',
    username:    '',
    // Recipes: { [id]: { id, title, description, servings, ingredients, steps, tags, source, sourceUrl, importedFrom, createdAt, updatedAt, image } }
    recipes:     {},
    // Meal plan: { [weekKey]: { [dayIndex]: { [slot]: recipeId } } }
    // weekKey = ISO week "2025-W03", dayIndex 0-6, slot = "breakfast"|"lunch"|"dinner"|"snack"
    mealplan:    {},
    lastModified: Date.now(),
  };
}

function mergeData(raw) {
  const d = defaultData();
  if (!raw || typeof raw !== 'object') return d;
  return {
    ...d,
    ...raw,
    recipes:  (raw.recipes  && typeof raw.recipes  === 'object') ? raw.recipes  : d.recipes,
    mealplan: (raw.mealplan && typeof raw.mealplan === 'object') ? raw.mealplan : d.mealplan,
  };
}

// ─── LocalStorage helpers ─────────────────────────────────────────

const ls = {
  get:    k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set:    (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.error('[Refectory] localStorage.set failed:', e); } },
  remove: k => { try { localStorage.removeItem(k); } catch {} },
};

function saveLocal() {
  try {
    const json = JSON.stringify(App.data);
    localStorage.setItem(STORAGE_KEY, json);
  } catch(e) {
    console.error('[Refectory] saveLocal failed — data NOT persisted:', e);
    showToast('⚠️ Could not save — storage may be full or unavailable', 'error');
  }
}

// ─── Worker sync ──────────────────────────────────────────────────

function getWorkerUrl() {
  return App.data?.workerUrl || '';
}

async function pushToWorker() {
  const base  = getWorkerUrl().replace(/\/+$/, '');
  if (!base) return false;
  const token   = App.data?.userToken;
  if (!token) return false;
  const body    = JSON.stringify(App.data);
  const headers = await Auth._authHeaders('PUT', token, body);
  try {
    const res = await fetch(`${base}/storage/${encodeURIComponent(token)}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    return res.ok;
  } catch { return false; }
}

async function pullFromWorker() {
  const base  = getWorkerUrl().replace(/\/+$/, '');
  if (!base) return null;
  const token   = App.data?.userToken;
  if (!token) return null;
  const headers = await Auth._authHeaders('GET', token, '');
  try {
    const res = await fetch(`${base}/storage/${encodeURIComponent(token)}/profile`, { headers });
    if (res.status === 410) { showToast('Account migrated to Google — please sign in again.'); return null; }

    const migratedTo = res.headers.get('X-Token-Migrated');
    if (migratedTo) {
      const j = await res.json();
      App.data = Auth.handlePullMigration(migratedTo, mergeData(j.value ?? j));
      saveLocal();
      return App.data;
    }

    if (!res.ok) return null;
    const j = await res.json();
    return j.value ?? j;
  } catch { return null; }
}

async function syncToWorker() {
  if (Auth.isGuest()) return;
  App.pendingSync = false;
  await pushToWorker();
}

function scheduleSave() {
  App.pendingSync = true;
  saveLocal();
}

function startSyncPing() {
  if (App.syncTimer) clearInterval(App.syncTimer);
  App.syncTimer = setInterval(syncToWorker, SYNC_INTERVAL_MS);
}

// ─── Toast ────────────────────────────────────────────────────────

function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), duration);
}

// ─── Modal helpers ────────────────────────────────────────────────

function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add('open'); document.body.classList.add('modal-open'); }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('open');
    // Only remove body lock if no other modals open
    if (!document.querySelector('.modal-overlay.open')) document.body.classList.remove('modal-open');
  }
}

// ─── Render helpers ───────────────────────────────────────────────

// Strip markdown and collapse whitespace for plain-text card previews
function plainText(str) {
  if (!str) return '';
  return str
    .replace(/[*][*](.+?)[*][*]/g, '$1')
    .replace(/[*](.+?)[*]/g, '$1')
    .replace(/#+\s*/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Week key helpers ─────────────────────────────────────────────

function getISOWeekKey(date = new Date()) {
  const d   = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const wn    = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  return `${d.getFullYear()}-W${String(wn).padStart(2, '0')}`;
}

// Returns the Monday of the week containing the given weekKey offset by `offset` weeks
function weekStartDate(weekKey, offset = 0) {
  const [year, wn] = weekKey.split('-W').map(Number);
  const jan4  = new Date(year, 0, 4);
  const mon   = new Date(jan4);
  mon.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (wn - 1) * 7 + offset * 7);
  return mon;
}

function addWeeks(weekKey, n) {
  return getISOWeekKey(weekStartDate(weekKey, n));
}

const DAY_NAMES  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL_DAYS  = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

// ─── Current view state ───────────────────────────────────────────

const View = {
  currentWeek:   getISOWeekKey(),
  activeSection: 'recipes',  // 'recipes' | 'planner' | 'shopping'
  recipeSearch:  '',
  recipeTags:    [],          // selected tag filters
  editingId:     null,        // recipe id being edited
};

// ─── Navigation ───────────────────────────────────────────────────

function showSection(name) {
  View.activeSection = name;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === name));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
  if (name === 'recipes')  renderRecipes();
  if (name === 'planner')  renderPlanner();
  if (name === 'shopping') renderShoppingList();
}

// ─── Recipe CRUD ──────────────────────────────────────────────────

function getRecipes() {
  return Object.values(App.data.recipes || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getRecipe(id) { return App.data.recipes?.[id] || null; }

function saveRecipe(recipe) {
  recipe.updatedAt = Date.now();
  if (!recipe.createdAt) recipe.createdAt = recipe.updatedAt;
  App.data.recipes[recipe.id] = recipe;
  const editorImg = form.querySelector('#editor-image-url')?.value.trim();
  if (editorImg) ImageStore.set(recipe.id, editorImg);
  scheduleSave();
}

function deleteRecipe(id) {
  delete App.data.recipes[id];
  ImageStore.delete(id);
  // Remove from meal plan too
  for (const wk of Object.keys(App.data.mealplan)) {
    for (const day of Object.keys(App.data.mealplan[wk])) {
      for (const slot of MEAL_SLOTS) {
        if (App.data.mealplan[wk][day][slot] === id) {
          delete App.data.mealplan[wk][day][slot];
        }
      }
    }
  }
  scheduleSave();
}

// ─── Recipe rendering ─────────────────────────────────────────────

function renderRecipes() {
  const grid   = document.getElementById('recipe-grid');
  const noRes  = document.getElementById('recipe-empty');
  if (!grid) return;

  let recipes = getRecipes();
  const q     = View.recipeSearch.toLowerCase();
  if (q) recipes = recipes.filter(r =>
    r.title?.toLowerCase().includes(q) ||
    r.description?.toLowerCase().includes(q) ||
    r.tags?.some(t => t.toLowerCase().includes(q))
  );
  if (View.recipeTags.length) {
    recipes = recipes.filter(r => View.recipeTags.every(t => r.tags?.includes(t)));
  }

  renderTagFilter();

  if (!recipes.length) {
    grid.innerHTML = '';
    noRes.style.display = '';
    return;
  }
  noRes.style.display = 'none';

  grid.innerHTML = recipes.map(r => `
    <div class="recipe-card" data-id="${esc(r.id)}">
      <div class="recipe-card-img" data-img-id="${esc(r.id)}">
        <div class="recipe-card-placeholder">🍽️</div>
      </div>
      <div class="recipe-card-body">
        <div class="recipe-card-title">${esc(r.title)}</div>
        ${r.description ? `<div class="recipe-card-desc">${esc(plainText(r.description))}</div>` : ''}
        <div class="recipe-card-meta">
          ${r.servings ? `<span>Serves ${esc(String(r.servings))}</span>` : ''}
          ${r.tags?.length ? `<span>${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.recipe-card').forEach(card => {
    card.addEventListener('click', () => openRecipeDetail(card.dataset.id));
  });

  // Async-load card images from IndexedDB (non-blocking)
  grid.querySelectorAll('[data-img-id]').forEach(async imgEl => {
    const dataUrl = await ImageStore.get(imgEl.dataset.imgId);
    if (dataUrl) {
      imgEl.style.backgroundImage = `url('${dataUrl}')`;
      imgEl.querySelector('.recipe-card-placeholder')?.remove();
    }
  });
}

function getAllTags() {
  const tags = new Set();
  for (const r of Object.values(App.data.recipes || {})) {
    (r.tags || []).forEach(t => tags.add(t));
  }
  return [...tags].sort();
}

function renderTagFilter() {
  const bar = document.getElementById('tag-filter-bar');
  if (!bar) return;
  const allTags = getAllTags();
  if (!allTags.length) { bar.innerHTML = ''; return; }

  const active  = View.recipeTags;
  const isOpen  = bar.dataset.open === '1';
  const search  = bar.dataset.search || '';

  // ── Summary row (always visible) ────────────────────────────────
  const activePills = active.map(t => `
    <span class="tag-active-pill" data-tag="${esc(t)}">
      ${esc(t)}<button title="Remove" data-remove="${esc(t)}">✕</button>
    </span>`).join('');

  const toggleLabel = isOpen
    ? '▴ Hide tags'
    : `${allTags.length} tags ▾${active.length ? ` (${active.length} active)` : ''}`;

  // ── Expanded panel ───────────────────────────────────────────────
  const visibleTags = search
    ? allTags.filter(t => t.toLowerCase().includes(search.toLowerCase()))
    : allTags;

  const pills = visibleTags.map(t =>
    `<button class="tag-filter-btn${active.includes(t) ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`
  ).join('');

  bar.innerHTML = `
    <div class="tag-filter-summary">
      ${activePills}
      <button class="tag-filter-toggle" id="tag-filter-toggle-btn">${toggleLabel}</button>
      ${active.length ? `<button class="tag-filter-toggle" id="tag-filter-clear" style="color:var(--red);border-color:var(--red);">Clear all</button>` : ''}
    </div>
    <div class="tag-filter-panel${isOpen ? ' open' : ''}">
      <input class="tag-filter-search" id="tag-filter-search" placeholder="Search tags…" value="${esc(search)}" autocomplete="off"/>
      <div class="tag-filter-pills">${pills}</div>
    </div>
  `;

  // Toggle open/close
  bar.querySelector('#tag-filter-toggle-btn')?.addEventListener('click', () => {
    bar.dataset.open = bar.dataset.open === '1' ? '0' : '1';
    renderTagFilter();
  });

  // Clear all active tags
  bar.querySelector('#tag-filter-clear')?.addEventListener('click', () => {
    View.recipeTags = [];
    renderRecipes();
    renderTagFilter();
  });

  // Remove individual active tag from summary pills
  bar.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const t = btn.dataset.remove;
      View.recipeTags = View.recipeTags.filter(x => x !== t);
      renderRecipes();
      renderTagFilter();
    });
  });

  // Tag search filter
  bar.querySelector('#tag-filter-search')?.addEventListener('input', e => {
    bar.dataset.search = e.target.value;
    renderTagFilter();
    // Keep focus inside the search box after re-render
    bar.querySelector('#tag-filter-search')?.focus();
  });

  // Tag pill clicks
  bar.querySelectorAll('.tag-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tag;
      if (View.recipeTags.includes(t)) View.recipeTags = View.recipeTags.filter(x => x !== t);
      else View.recipeTags.push(t);
      renderRecipes();
      renderTagFilter();
    });
  });
}

// ─── Recipe detail modal ──────────────────────────────────────────

function openRecipeDetail(id) {
  const r = getRecipe(id);
  if (!r) return;

  document.getElementById('detail-title').textContent       = r.title || '';
  document.getElementById('detail-description').textContent = r.description || '';
  document.getElementById('detail-servings').textContent    = r.servings ? `Serves ${r.servings}` : '';
  document.getElementById('detail-tags').innerHTML          = (r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  document.getElementById('detail-source').innerHTML        = r.sourceUrl
    ? `<a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener">${esc(r.source || r.sourceUrl)}</a>`
    : (r.source ? esc(r.source) : '');

  const imgEl = document.getElementById('detail-image');
  imgEl.style.display = 'none';
  imgEl.src = '';
  ImageStore.get(id).then(dataUrl => {
    if (dataUrl) { imgEl.src = dataUrl; imgEl.style.display = ''; }
  });

  // Ingredients
  document.getElementById('detail-ingredients').innerHTML =
    (r.ingredients || []).map(i =>
      `<li>${esc(ingredientText(i))}</li>`
    ).join('');

  // Steps
  document.getElementById('detail-steps').innerHTML =
    (r.steps || []).map((s, idx) =>
      `<li><span class="step-num">${idx + 1}</span>${esc(stepText(s))}</li>`
    ).join('');

  // Scaling
  const scaleInput = document.getElementById('detail-scale');
  const servingsRaw = String(r.servings || '').trim();
  const servingsNum = parseFloat(servingsRaw) || 1;
  scaleInput.value = servingsNum;
  scaleInput.dataset.base = servingsNum;
  const servingsLabel = servingsRaw || String(servingsNum);
  document.getElementById('detail-scale-label').textContent = `Servings (base: ${servingsLabel})`;

  document.getElementById('detail-edit-btn').onclick = () => { closeModal('modal-recipe-detail'); openRecipeEditor(id); };
  document.getElementById('detail-delete-btn').onclick = () => {
    if (confirm(`Delete "${r.title}"? This cannot be undone.`)) {
      deleteRecipe(id);
      closeModal('modal-recipe-detail');
      renderRecipes();
      showToast('Recipe deleted.');
    }
  };
  document.getElementById('detail-plan-btn').onclick = () => openAddToPlanModal(id);

  openModal('modal-recipe-detail');
  updateScaledIngredients();
}

function updateScaledIngredients() {
  const scaleInput = document.getElementById('detail-scale');
  const base       = parseFloat(scaleInput?.dataset.base) || 1;
  const target     = parseFloat(scaleInput?.value) || base;
  const ratio      = target / base;
  const detailId   = document.querySelector('#modal-recipe-detail')?.dataset.recipeId;
  // re-render with scaling if recipe id available — look up from title
  // For now, update display via simple ratio recalculation
  const items = document.querySelectorAll('#detail-ingredients li');
  const recipe = Object.values(App.data.recipes || {}).find(r =>
    r.title === document.getElementById('detail-title')?.textContent
  );
  if (!recipe) return;
  document.getElementById('detail-ingredients').innerHTML =
    (recipe.ingredients || []).map(i => {
      if (typeof i === 'string') {
        const m = i.match(/^([0-9.\/\s]+)(.*)/);
        if (m && !isNaN(parseFloat(m[1]))) {
          const scaled = parseFloat(m[1]) * ratio;
          const num = Number.isInteger(scaled) ? scaled : scaled.toFixed(2).replace(/\.?0+$/, '');
          return `<li>${esc((num + m[2]).trim())}</li>`;
        }
        return `<li>${esc(i)}</li>`;
      }
      let amount = i.amount;
      if (amount && !isNaN(parseFloat(amount))) {
        const scaled = parseFloat(amount) * ratio;
        amount = Number.isInteger(scaled) ? scaled : scaled.toFixed(2).replace(/\.?0+$/, '');
      }
      return `<li>${esc(amount ? `${amount} ${i.unit || ''} ${i.name}`.trim() : i.name)}</li>`;
    }).join('');
}

// ─── Recipe editor modal ──────────────────────────────────────────

function openRecipeEditor(id = null) {
  const recipe = id ? (getRecipe(id) || {}) : {};
  View.editingId = id;

  const form = document.getElementById('recipe-editor-form');
  form.querySelector('#editor-title').value       = recipe.title       || '';
  form.querySelector('#editor-description').value = recipe.description || '';
  form.querySelector('#editor-servings').value    = recipe.servings    || '';
  form.querySelector('#editor-tags').value        = (recipe.tags || []).join(', ');
  form.querySelector('#editor-source').value      = recipe.source      || '';
  form.querySelector('#editor-source-url').value  = recipe.sourceUrl   || '';
  form.querySelector('#editor-image-url').value   = recipe.image || '';

  // Ingredients
  renderEditorIngredients(recipe.ingredients || [{ name: '', amount: '', unit: '' }]);
  // Steps
  renderEditorSteps(recipe.steps || [{ text: '' }]);

  document.getElementById('modal-editor-title').textContent = id ? 'Edit Recipe' : 'New Recipe';
  openModal('modal-recipe-editor');
}

function renderEditorIngredients(ingredients) {
  // Normalise string ingredients (from Mealie import) to objects for the editor
  const normalised = (ingredients || []).map(i =>
    typeof i === 'string' ? { name: i, amount: '', unit: '' } : i
  );
  const list = document.getElementById('editor-ingredients-list');
  list.innerHTML = normalised.map((ing, i) => `
    <div class="ingredient-row" data-idx="${i}">
      <input class="input ing-amount" placeholder="Amount" value="${esc(String(ing.amount || ''))}"/>
      <input class="input ing-unit"   placeholder="Unit"   value="${esc(ing.unit || '')}"/>
      <input class="input ing-name"   placeholder="Ingredient name" value="${esc(ing.name || '')}"/>
      <button class="btn btn-icon remove-ing" title="Remove">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('.remove-ing').forEach(btn => {
    btn.addEventListener('click', () => { btn.closest('.ingredient-row').remove(); });
  });
}

function renderEditorSteps(steps) {
  const list = document.getElementById('editor-steps-list');
  list.innerHTML = steps.map((s, i) => `
    <div class="step-row" data-idx="${i}">
      <span class="step-num">${i + 1}</span>
      <textarea class="input step-text" rows="2" placeholder="Describe this step…">${esc(typeof s === 'string' ? s : s.text || '')}</textarea>
      <button class="btn btn-icon remove-step" title="Remove">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('.remove-step').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.step-row').remove();
      // Re-number
      document.querySelectorAll('#editor-steps-list .step-num').forEach((el, i) => { el.textContent = i + 1; });
    });
  });
}

function collectEditorData() {
  const form = document.getElementById('recipe-editor-form');
  const ingredients = [...document.querySelectorAll('#editor-ingredients-list .ingredient-row')]
    .map(row => ({
      amount: row.querySelector('.ing-amount').value.trim(),
      unit:   row.querySelector('.ing-unit').value.trim(),
      name:   row.querySelector('.ing-name').value.trim(),
    })).filter(i => i.name);

  const steps = [...document.querySelectorAll('#editor-steps-list .step-row')]
    .map(row => ({ text: row.querySelector('.step-text').value.trim() }))
    .filter(s => s.text);

  const tagsRaw = form.querySelector('#editor-tags').value.trim();
  const tags    = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

  return {
    title:       form.querySelector('#editor-title').value.trim(),
    description: form.querySelector('#editor-description').value.trim(),
    servings:    parseInt(form.querySelector('#editor-servings').value) || null,
    tags,
    source:      form.querySelector('#editor-source').value.trim(),
    sourceUrl:   form.querySelector('#editor-source-url').value.trim(),
    ingredients,
    steps,
  };
}

function saveEditorRecipe() {
  const data = collectEditorData();
  if (!data.title) { showToast('Please enter a recipe title.'); return; }

  const id = View.editingId || genId();
  const existing = getRecipe(id) || {};
  saveRecipe({ ...existing, ...data, id });
  closeModal('modal-recipe-editor');
  View.editingId = null;
  renderRecipes();
  showToast(existing.id ? 'Recipe updated ✓' : 'Recipe saved ✓');
  if (View.activeSection !== 'recipes') showSection('recipes');
}

// ─── Meal planner ─────────────────────────────────────────────────

function getWeekPlan(weekKey) {
  return App.data.mealplan?.[weekKey] || {};
}

function setMealSlot(weekKey, dayIdx, slot, recipeId) {
  if (!App.data.mealplan) App.data.mealplan = {};
  if (!App.data.mealplan[weekKey]) App.data.mealplan[weekKey] = {};
  if (!App.data.mealplan[weekKey][dayIdx]) App.data.mealplan[weekKey][dayIdx] = {};
  if (recipeId) App.data.mealplan[weekKey][dayIdx][slot] = recipeId;
  else delete App.data.mealplan[weekKey][dayIdx][slot];
  scheduleSave();
}

function renderPlanner() {
  const wk      = View.currentWeek;
  const start   = weekStartDate(wk);
  const plan    = getWeekPlan(wk);

  document.getElementById('planner-week-label').textContent = formatWeekLabel(wk);

  const table = document.getElementById('planner-table');
  table.innerHTML = `
    <thead>
      <tr>
        <th class="slot-col"></th>
        ${DAY_NAMES.map((d, i) => {
          const date = new Date(start);
          date.setDate(start.getDate() + i);
          return `<th class="day-col">
            <div class="day-name">${d}</div>
            <div class="day-date">${date.getMonth() + 1}/${date.getDate()}</div>
          </th>`;
        }).join('')}
      </tr>
    </thead>
    <tbody>
      ${MEAL_SLOTS.map(slot => `
        <tr>
          <td class="slot-label">${capitalise(slot)}</td>
          ${[0,1,2,3,4,5,6].map(di => {
            const rid = plan[di]?.[slot];
            const r   = rid ? getRecipe(rid) : null;
            return `
              <td class="plan-cell" data-day="${di}" data-slot="${slot}">
                ${r
                  ? `<div class="plan-recipe" data-id="${esc(rid)}">
                       <span class="plan-recipe-title">${esc(r.title)}</span>
                       <button class="plan-remove" data-day="${di}" data-slot="${slot}" title="Remove">✕</button>
                     </div>`
                  : `<button class="plan-add" data-day="${di}" data-slot="${slot}" title="Add recipe">+</button>`
                }
              </td>`;
          }).join('')}
        </tr>
      `).join('')}
    </tbody>
  `;

  // Plan add buttons
  table.querySelectorAll('.plan-add').forEach(btn => {
    btn.addEventListener('click', () => {
      openPickRecipeModal(wk, parseInt(btn.dataset.day), btn.dataset.slot);
    });
  });

  // Plan remove buttons
  table.querySelectorAll('.plan-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      setMealSlot(wk, parseInt(btn.dataset.day), btn.dataset.slot, null);
      renderPlanner();
    });
  });

  // Click recipe name to view
  table.querySelectorAll('.plan-recipe').forEach(el => {
    el.querySelector('.plan-recipe-title').addEventListener('click', () => openRecipeDetail(el.dataset.id));
  });
}

function formatWeekLabel(weekKey) {
  const start = weekStartDate(weekKey);
  const end   = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}, ${start.getFullYear()}`;
}

function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Pick recipe modal (for planner) ─────────────────────────────

let _pickTarget = null;

function openPickRecipeModal(weekKey, dayIdx, slot) {
  _pickTarget = { weekKey, dayIdx, slot };
  const recipes   = getRecipes();
  const grid      = document.getElementById('pick-recipe-grid');
  const emptyMsg  = document.getElementById('pick-recipe-empty');

  if (!recipes.length) {
    grid.innerHTML = '';
    emptyMsg.style.display = '';
  } else {
    emptyMsg.style.display = 'none';
    grid.innerHTML = recipes.map(r => `
      <div class="pick-recipe-item" data-id="${esc(r.id)}">
        <div class="pick-img" data-pick-img="${esc(r.id)}">🍽️</div>
        <div class="pick-title">${esc(r.title)}</div>
      </div>
    `).join('');

    // Async-load pick grid images from IndexedDB
    grid.querySelectorAll('[data-pick-img]').forEach(async imgEl => {
      const dataUrl = await ImageStore.get(imgEl.dataset.pickImg);
      if (dataUrl) {
        imgEl.style.backgroundImage = `url('${dataUrl}')`;
        imgEl.textContent = '';
      }
    });
    grid.querySelectorAll('.pick-recipe-item').forEach(item => {
      item.addEventListener('click', () => {
        if (_pickTarget) {
          setMealSlot(_pickTarget.weekKey, _pickTarget.dayIdx, _pickTarget.slot, item.dataset.id);
          renderPlanner();
        }
        closeModal('modal-pick-recipe');
      });
    });
  }

  document.getElementById('pick-recipe-search').value = '';
  filterPickRecipes('');
  openModal('modal-pick-recipe');
}

function openAddToPlanModal(recipeId) {
  // Same as openPickRecipeModal but pre-selects recipe — simpler: open planner with a toast
  showToast('Open the Meal Planner and click + to add this recipe.');
  closeModal('modal-recipe-detail');
  showSection('planner');
}

function filterPickRecipes(q) {
  const lq = q.toLowerCase();
  document.querySelectorAll('.pick-recipe-item').forEach(item => {
    const title = item.querySelector('.pick-title')?.textContent.toLowerCase() || '';
    item.style.display = (!q || title.includes(lq)) ? '' : 'none';
  });
}

// ─── Shopping list ────────────────────────────────────────────────

function renderShoppingList() {
  const container = document.getElementById('shopping-list-content');
  if (!container) return;

  // Collect all recipes in current + next week plan
  const weeks   = [View.currentWeek, addWeeks(View.currentWeek, 1)];
  const recipeIds = new Set();
  for (const wk of weeks) {
    const plan = getWeekPlan(wk);
    for (const day of Object.values(plan)) {
      for (const rid of Object.values(day)) {
        if (rid) recipeIds.add(rid);
      }
    }
  }

  if (!recipeIds.size) {
    container.innerHTML = `<p class="muted">Add recipes to your meal plan to generate a shopping list.</p>`;
    return;
  }

  // Aggregate ingredients
  const agg = {}; // "name" → { amounts: [...], unit }
  for (const rid of recipeIds) {
    const r = getRecipe(rid);
    if (!r) continue;
    for (const rawIng of (r.ingredients || [])) {
      const ing = typeof rawIng === 'string'
        ? { name: rawIng, amount: '', unit: '' }
        : rawIng;
      if (!ing.name) continue;
      const key = ing.name.toLowerCase().trim();
      if (!agg[key]) agg[key] = { name: ing.name, entries: [] };
      agg[key].entries.push({ amount: ing.amount, unit: ing.unit, from: r.title });
    }
  }

  const sorted = Object.values(agg).sort((a, b) => a.name.localeCompare(b.name));
  container.innerHTML = `
    <div class="shopping-header">
      <p class="muted shopping-note">Based on meals planned for ${formatWeekLabel(weeks[0])} and the following week.</p>
      <button class="btn btn-ghost btn-sm" id="shopping-print-btn">Print / Save PDF</button>
    </div>
    <ul class="shopping-list">
      ${sorted.map(item => {
        const summary = item.entries.map(e =>
          [e.amount, e.unit, e.name].filter(Boolean).join(' ')
        ).join(' + ');
        return `
          <li class="shopping-item">
            <label class="shopping-check">
              <input type="checkbox" class="shopping-cb"/>
              <span class="shopping-ing">
                <span class="shopping-name">${esc(item.name)}</span>
                <span class="shopping-detail muted">${esc(summary)}</span>
              </span>
            </label>
          </li>`;
      }).join('')}
    </ul>
  `;

  document.getElementById('shopping-print-btn')?.addEventListener('click', () => window.print());
}

// ─── Mealie import ────────────────────────────────────────────────


// ─── Export ───────────────────────────────────────────────────────

let _exportMode = null; // 'full' | 'images'

function openExportModal() {
  _exportMode = null;
  document.getElementById('export-status').textContent = '';
  document.getElementById('btn-export-go').disabled = true;
  // Reset selection styles
  ['export-opt-full', 'export-opt-images'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.borderColor = 'var(--border)';
      el.style.background  = '';
    }
  });
  openModal('modal-export');
}

function selectExportMode(mode) {
  _exportMode = mode;
  ['full', 'images'].forEach(m => {
    const el = document.getElementById(`export-opt-${m}`);
    if (!el) return;
    const active = m === mode;
    el.style.borderColor = active ? 'var(--green-mid)' : 'var(--border)';
    el.style.background  = active ? 'rgba(107,140,90,.08)' : '';
  });
  document.getElementById('btn-export-go').disabled = false;
  document.getElementById('export-status').textContent = '';
}

async function runExport() {
  if (!_exportMode) return;
  const statusEl = document.getElementById('export-status');
  const btn      = document.getElementById('btn-export-go');
  btn.disabled   = true;
  btn.textContent = 'Building…';

  try {
    const zip  = new JSZip();
    const date = new Date().toISOString().slice(0, 10);

    if (_exportMode === 'full') {
      // recipes.json — all recipe data, no images
      const recipes = Object.fromEntries(
        Object.entries(App.data.recipes || {}).map(([id, r]) => {
          const { image: _img, ...rest } = r;
          return [id, rest];
        })
      );
      zip.file('recipes.json', JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), recipes }, null, 2));
      statusEl.textContent = 'Adding recipe data…';
    }

    // Images — always included in full, only thing in images-only
    statusEl.textContent = 'Collecting images…';
    const imgFolder = zip.folder('images');
    const ids = Object.keys(App.data.recipes || {});
    let imgCount = 0;
    for (const id of ids) {
      const dataUrl = await ImageStore.get(id);
      if (!dataUrl) continue;
      // dataUrl is "data:image/webp;base64,{b64}" — extract the raw base64
      const b64 = dataUrl.split(',')[1];
      if (b64) { imgFolder.file(`${id}.webp`, b64, { base64: true }); imgCount++; }
    }

    statusEl.textContent = 'Compressing…';
    const blob     = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const filename = _exportMode === 'full'
      ? `refectory-backup-${date}.zip`
      : `refectory-images-${date}.zip`;

    // Trigger download
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    const recipeCount = Object.keys(App.data.recipes || {}).length;
    statusEl.style.color = 'var(--green-mid)';
    statusEl.textContent = _exportMode === 'full'
      ? `✓ Exported ${recipeCount} recipes and ${imgCount} images`
      : `✓ Exported ${imgCount} images`;

  } catch (e) {
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = `Export failed: ${e.message}`;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Download';
  }
}

// ─── Refectory backup import ──────────────────────────────────────

async function importFromRefectoryBackup(file) {
  const statusEl = document.getElementById('mealie-import-status');
  const status   = (msg, err) => {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = err ? 'var(--red)' : ''; }
  };

  status('Reading zip…');
  let zip;
  try { zip = await JSZip.loadAsync(file); }
  catch (e) { return { ok: false, error: `Could not read zip: ${e.message}` }; }

  const hasRecipes = !!zip.file('recipes.json');
  const imgFiles   = Object.keys(zip.files).filter(n => n.startsWith('images/') && n.endsWith('.webp'));

  if (!hasRecipes && !imgFiles.length) {
    return { ok: false, error: 'Not a valid Refectory backup — no recipes.json or images found.' };
  }

  let recipeCount = 0, imgCount = 0;

  // ── Restore recipe data ──────────────────────────────────────────
  if (hasRecipes) {
    status('Restoring recipes…');
    try {
      const text = await zip.file('recipes.json').async('string');
      const { recipes } = JSON.parse(text);
      if (recipes && typeof recipes === 'object') {
        // Merge — don't wipe recipes already on device
        App.data.recipes = { ...App.data.recipes, ...recipes };
        recipeCount = Object.keys(recipes).length;
      }
    } catch (e) { return { ok: false, error: `recipes.json parse error: ${e.message}` }; }
  }

  // ── Restore images ───────────────────────────────────────────────
  if (imgFiles.length) {
    status(`Restoring ${imgFiles.length} images…`);
    for (const path of imgFiles) {
      try {
        const id  = path.replace('images/', '').replace('.webp', '');
        const b64 = await zip.file(path).async('base64');
        await ImageStore.set(id, `data:image/webp;base64,${b64}`);
        imgCount++;
      } catch { /* skip bad image */ }
    }
  }

  if (recipeCount) { scheduleSave(); }
  return { ok: true, recipeCount, imgCount, hasRecipes };
}

function openMealieImport() {
  document.getElementById('mealie-json-input').value = '';
  document.getElementById('mealie-url-input').value  = '';
  document.getElementById('mealie-api-key').value    = '';
  document.getElementById('mealie-import-status').textContent = '';
  document.getElementById('mealie-zip-input').value   = '';
  document.getElementById('refectory-zip-input').value = '';
  // Remove any lingering import buttons from previous session
  document.getElementById('mealie-import-zip-btn')?.remove();
  document.getElementById('refectory-import-btn')?.remove();
  setMealieDropZoneIdle();
  // Default to backup tab — most common full-import path
  switchMealieTab('backup');
  openModal('modal-mealie-import');
}

function switchMealieTab(tab) {
  const panels = { backup: 'mealie-backup-panel', json: 'mealie-json-panel', api: 'mealie-api-panel', refectory: 'mealie-refectory-panel' };
  const btns   = { backup: 'mealie-tab-backup',   json: 'mealie-tab-json',   api: 'mealie-tab-api',   refectory: 'mealie-tab-refectory'   };
  Object.entries(panels).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = key === tab ? '' : 'none';
  });
  Object.entries(btns).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', key === tab);
  });
}

function setMealieDropZoneIdle() {
  const dz = document.getElementById('mealie-drop-zone');
  if (!dz) return;
  dz.style.borderColor = '';
  dz.style.background  = '';
  dz.innerHTML = `
    <div style="font-size:2rem;margin-bottom:.5rem;">📦</div>
    <div style="font-size:.9rem;">Drop your <strong>mealie_*.zip</strong> here</div>
    <div style="font-size:.8rem;margin-top:.35rem;">or <span style="color:var(--green-mid);text-decoration:underline;cursor:pointer;" id="mealie-browse-link">browse to select</span></div>
  `;
  document.getElementById('mealie-browse-link')?.addEventListener('click', () =>
    document.getElementById('mealie-zip-input')?.click()
  );
}

function parseMealieRecipe(raw) {
  // Handles Mealie v1 export format
  if (!raw || typeof raw !== 'object') return null;
  const title = raw.name || raw.title || '';
  if (!title) return null;

  const ingredients = (raw.recipeIngredient || raw.ingredients || []).map(i => {
    if (typeof i === 'string') return { name: i, amount: '', unit: '' };
    return {
      name:   i.food?.name || i.name || i.note || '',
      amount: i.quantity != null ? String(i.quantity) : (i.amount || ''),
      unit:   i.unit?.name || i.unit || '',
    };
  }).filter(i => i.name);

  const steps = (raw.recipeInstructions || raw.instructions || []).map(s => ({
    text: typeof s === 'string' ? s : (s.text || s.title || ''),
  })).filter(s => s.text);

  const tags = [
    ...(raw.tags  || []).map(t => typeof t === 'string' ? t : t.name || ''),
    ...(raw.categories || []).map(c => typeof c === 'string' ? c : c.name || ''),
  ].filter(Boolean);

  const recipeId = genId();
  const imageUrl = raw.image || '';

  // Store image in IndexedDB if present — keeps it out of localStorage
  if (imageUrl) ImageStore.set(recipeId, imageUrl);

  return {
    id:          recipeId,
    title,
    description: raw.description || raw.summary || '',
    servings:    parseInt(raw.recipeYield || raw.servings) || null,
    tags,
    source:      raw.orgURL ? 'Web' : (raw.source || ''),
    sourceUrl:   raw.orgURL || raw.sourceUrl || '',
    ingredients,
    steps,
    importedFrom: 'mealie',
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
  };
}


// Called when user drops or selects a Refectory backup zip
async function handleRefectoryZipFile(file) {
  const dz     = document.getElementById('refectory-drop-zone');
  const status = document.getElementById('mealie-import-status');

  if (!file.name.endsWith('.zip')) {
    if (status) { status.textContent = 'Please select a .zip file.'; status.style.color = 'var(--red)'; }
    return;
  }

  if (dz) {
    dz.style.borderColor = 'var(--green-mid)';
    dz.innerHTML = `<div style="font-size:1.5rem;margin-bottom:.5rem;">✅</div>
      <div style="font-size:.9rem;font-weight:600;">${file.name}</div>
      <div style="font-size:.8rem;margin-top:.35rem;color:var(--muted);">${(file.size/1024/1024).toFixed(1)} MB — click Import to continue</div>`;
  }
  if (status) { status.textContent = ''; status.style.color = ''; }

  const existing = document.getElementById('refectory-import-btn');
  if (!existing && dz) {
    const btn = document.createElement('button');
    btn.id = 'refectory-import-btn';
    btn.className = 'btn btn-primary w100';
    btn.textContent = 'Import Refectory Backup';
    btn.style.marginTop = '.75rem';
    dz.parentElement.insertBefore(btn, dz.nextSibling);
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Importing…';
      const result = await importFromRefectoryBackup(file);
      btn.disabled = false; btn.textContent = 'Import Refectory Backup';
      if (result.ok) {
        renderAll();
        closeModal('modal-mealie-import');
        const parts = [];
        if (result.recipeCount) parts.push(`${result.recipeCount} recipes`);
        if (result.imgCount)    parts.push(`${result.imgCount} images`);
        showToast(`✅ Imported ${parts.join(' and ')}`);
      } else {
        const s = document.getElementById('mealie-import-status');
        if (s) { s.textContent = result.error; s.style.color = 'var(--red)'; }
      }
    });
  } else if (existing) {
    existing.onclick = async () => {
      existing.disabled = true; existing.textContent = 'Importing…';
      const result = await importFromRefectoryBackup(file);
      existing.disabled = false; existing.textContent = 'Import Refectory Backup';
      if (result.ok) {
        renderAll();
        closeModal('modal-mealie-import');
        const parts = [];
        if (result.recipeCount) parts.push(`${result.recipeCount} recipes`);
        if (result.imgCount)    parts.push(`${result.imgCount} images`);
        showToast(`✅ Imported ${parts.join(' and ')}`);
      }
    };
  }
}

// Called when user drops or selects a zip file
async function handleMealieZipFile(file) {
  const dz     = document.getElementById('mealie-drop-zone');
  const status = document.getElementById('mealie-import-status');

  if (!file.name.endsWith('.zip')) {
    if (status) { status.textContent = 'Please select a .zip file.'; status.style.color = 'var(--red)'; }
    return;
  }

  // Show selected filename in drop zone
  if (dz) {
    dz.style.borderColor = 'var(--green-mid)';
    dz.innerHTML = `<div style="font-size:1.5rem;margin-bottom:.5rem;">✅</div>
      <div style="font-size:.9rem;font-weight:600;">${file.name}</div>
      <div style="font-size:.8rem;margin-top:.35rem;color:var(--muted);">${(file.size/1024/1024).toFixed(1)} MB — click Import to continue</div>`;
  }
  if (status) { status.textContent = ''; status.style.color = ''; }

  // Auto-trigger import button if not yet present; otherwise show it
  const existingBtn = document.getElementById('mealie-import-zip-btn');
  if (!existingBtn && dz) {
    const btn = document.createElement('button');
    btn.id        = 'mealie-import-zip-btn';
    btn.className = 'btn btn-primary w100';
    btn.textContent = 'Import from Backup';
    btn.style.marginTop = '.75rem';
    dz.parentElement.insertBefore(btn, dz.nextSibling);
    btn.addEventListener('click', () => triggerMealieZipImport(file));
  } else if (existingBtn) {
    existingBtn.onclick = () => triggerMealieZipImport(file);
  }
}

async function triggerMealieZipImport(file) {
  const btn         = document.getElementById('mealie-import-zip-btn');
  const embedImages = document.getElementById('mealie-import-images')?.checked ?? true;
  const status      = document.getElementById('mealie-import-status');

  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

  const result = await importFromMealieBackup(file, embedImages);

  if (btn) { btn.disabled = false; btn.textContent = 'Import from Backup'; }

  if (result.ok) {
    // Explicitly save after import — belt and suspenders
    saveLocal();
    renderAll();
    closeModal('modal-mealie-import');
    showToast(`✅ Imported ${result.count} recipes from Mealie backup`);
    // Confirm to console that data was persisted
    const saved = localStorage.getItem(STORAGE_KEY);
    const recipeCount = saved ? Object.keys(JSON.parse(saved).recipes || {}).length : 0;
    console.log(`[Refectory] Saved. localStorage has ${recipeCount} recipes.`);
  } else {
    if (status) { status.textContent = result.error; status.style.color = 'var(--red)'; }
  }
}

// ─── Mealie backup zip parser ─────────────────────────────────────

async function importFromMealieBackup(file, embedImages) {
  const status = (msg, err) => {
    const el = document.getElementById('mealie-import-status');
    if (el) { el.textContent = msg; el.style.color = err ? 'var(--red)' : ''; }
  };

  status('Reading zip file…');
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (e) {
    return { ok: false, error: `Could not read zip: ${e.message}` };
  }

  const dbFile = zip.file('database.json');
  if (!dbFile) return { ok: false, error: 'No database.json found — is this a Mealie backup zip?' };

  status('Parsing database…');
  let data;
  try {
    const text = await dbFile.async('string');
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `database.json is not valid JSON: ${e.message}` };
  }

  // Build lookup tables
  const units = {};
  (data.ingredient_units || []).forEach(u => { units[u.id] = u; });
  const foods = {};
  (data.ingredient_foods || []).forEach(f => { foods[f.id] = f; });
  const tagMap = {};
  (data.tags || []).forEach(t => { tagMap[t.id] = t.name; });
  const catMap = {};
  (data.categories || []).forEach(c => { catMap[c.id] = c.name; });

  // Group relational tables by recipe_id
  const ingrByRecipe = {}, instrByRecipe = {}, notesByRecipe = {};
  const r2t = {}, r2c = {};

  (data.recipes_ingredients || []).forEach(i => {
    (ingrByRecipe[i.recipe_id] = ingrByRecipe[i.recipe_id] || []).push(i);
  });
  Object.values(ingrByRecipe).forEach(arr => arr.sort((a, b) => a.position - b.position));

  (data.recipe_instructions || []).forEach(i => {
    (instrByRecipe[i.recipe_id] = instrByRecipe[i.recipe_id] || []).push(i);
  });
  Object.values(instrByRecipe).forEach(arr => arr.sort((a, b) => a.position - b.position));

  (data.notes || []).forEach(n => {
    (notesByRecipe[n.recipe_id] = notesByRecipe[n.recipe_id] || []).push(n);
  });
  (data.recipes_to_tags || []).forEach(x => {
    (r2t[x.recipe_id] = r2t[x.recipe_id] || []).push(x.tag_id);
  });
  (data.recipes_to_categories || []).forEach(x => {
    (r2c[x.recipe_id] = r2c[x.recipe_id] || []).push(x.category_id);
  });

  function buildIngredientStr(i) {
    if (i.original_text) return i.original_text;
    if (i.note)          return i.note;
    const parts = [];
    if (i.quantity != null && i.quantity !== 0) parts.push(String(i.quantity));
    if (i.unit_id && units[i.unit_id]) {
      const u = units[i.unit_id];
      parts.push(u.use_abbreviation && u.abbreviation ? u.abbreviation : u.name);
    }
    if (i.food_id && foods[i.food_id]) parts.push(foods[i.food_id].name);
    return parts.join(' ') || null;
  }

  function toUUID(id) {
    return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
  }

  const recipes = data.recipes || [];
  let count = 0, skipped = 0;
  const total = recipes.length;

  for (let idx = 0; idx < recipes.length; idx++) {
    const r   = recipes[idx];
    const rid = r.id;
    status(`Importing recipe ${idx + 1} of ${total}: ${r.name || '?'}…`);

    // Ingredients
    const ingredients = (ingrByRecipe[rid] || [])
      .map(buildIngredientStr).filter(Boolean);

    // Steps
    const steps = (instrByRecipe[rid] || [])
      .map(i => {
        const text  = (i.text  || '').trim();
        const title = (i.title || '').trim();
        return text ? (title ? `${title}: ${text}` : text) : null;
      }).filter(Boolean);

    // Tags from both tags and categories tables
    const recipeTags = [];
    (r2t[rid] || []).forEach(tid => { if (tagMap[tid]) recipeTags.push(tagMap[tid]); });
    (r2c[rid] || []).forEach(cid => { if (catMap[cid]) recipeTags.push(catMap[cid]); });
    const tags = [...new Set(recipeTags)];

    // Description + notes
    let description = (r.description || '').trim();
    (notesByRecipe[rid] || []).forEach(n => {
      const t = (n.text  || '').trim();
      const h = (n.title || '').trim();
      if (t) description += h ? `

**${h}**
${t}` : `

${t}`;
    });

    // Determine the Refectory ID for this recipe before touching images
    const existing = Object.values(App.data.recipes)
      .find(ex => ex.importedFrom === 'mealie-backup' && ex.title === r.name);
    const newId    = existing ? existing.id : genId();

    // Image — read from zip and store in IndexedDB (not in App.data / localStorage)
    if (embedImages) {
      try {
        const uuid     = toUUID(rid);
        const imgPaths = [
          `data/recipes/${uuid}/images/tiny-original.webp`,
          `data/recipes/${uuid}/images/original.webp`,
        ];
        for (const p of imgPaths) {
          const imgFile = zip.file(p);
          if (imgFile) {
            const b64     = await imgFile.async('base64');
            const dataUrl = `data:image/webp;base64,${b64}`;
            await ImageStore.set(newId, dataUrl);
            break;
          }
        }
      } catch { /* skip image on failure */ }
    }

    if (existing) {
      // Update in place, preserve our own id
      Object.assign(existing, {
        title: r.name || existing.title,
        description: description.trim(),
        servings:    r.recipe_yield || existing.servings,
        prepTime:    r.prep_time    || '',
        cookTime:    r.cook_time    || r.perform_time || '',
        totalTime:   r.total_time   || '',
        source:      r.org_url      || '',
        sourceUrl:   r.org_url      || '',
        tags, ingredients, steps,
        importedFrom: 'mealie-backup',
        updatedAt:   Date.now(),
      });
      count++;
    } else {
      App.data.recipes[newId] = {
        id:          newId,
        title:       r.name || '',
        description: description.trim(),
        servings:    r.recipe_yield || '',
        prepTime:    r.prep_time    || '',
        cookTime:    r.cook_time    || r.perform_time || '',
        totalTime:   r.total_time   || '',
        source:      r.org_url      || '',
        sourceUrl:   r.org_url      || '',
        tags, ingredients, steps,
        importedFrom: 'mealie-backup',
        createdAt:   Date.now(),
        updatedAt:   Date.now(),
      };
      count++;
    }
  }

  if (!count) return { ok: false, error: 'No recipes were found in the backup.' };
  scheduleSave();
  return { ok: true, count, skipped };
}

async function importFromMealieJson(jsonText) {
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return { ok: false, error: 'Invalid JSON.' }; }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  let count = 0;
  for (const item of items) {
    const r = parseMealieRecipe(item);
    if (r) { App.data.recipes[r.id] = r; count++; }
  }
  if (!count) return { ok: false, error: 'No valid recipes found in the JSON.' };
  scheduleSave();
  return { ok: true, count };
}

async function importFromMealieApi(baseUrl, apiKey) {
  const base = baseUrl.replace(/\/+$/, '');
  const hdrs = { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' };
  try {
    // Fetch recipe slugs
    const listRes = await fetch(`${base}/api/recipes?perPage=9999`, { headers: hdrs });
    if (!listRes.ok) return { ok: false, error: `API error ${listRes.status} — check your URL and key.` };
    const list = await listRes.json();
    const slugs = (list.items || list).map(r => r.slug).filter(Boolean);
    if (!slugs.length) return { ok: false, error: 'No recipes found.' };

    let count = 0;
    for (const slug of slugs) {
      try {
        const r = await fetch(`${base}/api/recipes/${slug}`, { headers: hdrs });
        if (!r.ok) continue;
        const recipe = parseMealieRecipe(await r.json());
        if (recipe) { App.data.recipes[recipe.id] = recipe; count++; }
      } catch { /* skip */ }
    }
    if (!count) return { ok: false, error: 'Could not import any recipes.' };
    scheduleSave();
    return { ok: true, count };
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` };
  }
}

// ─── Settings modal ───────────────────────────────────────────────

function openSettings() {
  Auth.renderSettingsSection();
  const d = App.data;
  document.getElementById('settings-firstname-input').value = d.firstName || '';
  document.getElementById('settings-lastname-input').value  = d.lastName  || '';
  document.getElementById('settings-username-input').value   = d.username  || '';
  openModal('modal-settings');
}

function clearImportedRecipes() {
  const recipes = App.data.recipes || {};
  const toRemove = Object.entries(recipes)
    .filter(([, r]) => r.importedFrom === 'mealie-backup' || r.importedFrom === 'mealie')
    .map(([id]) => id);
  toRemove.forEach(id => delete App.data.recipes[id]);
  ImageStore.deleteMany(toRemove);
  saveLocal();
  renderAll();
  closeModal('modal-settings');
  showToast(`Cleared ${toRemove.length} imported recipe${toRemove.length !== 1 ? 's' : ''} ✓`);
}

function wipeAllRecipes() {
  App.data.recipes  = {};
  App.data.mealplan = {};
  ImageStore.clear();
  saveLocal();
  renderAll();
  closeModal('modal-settings');
  showToast('All recipes wiped ✓');
}

function saveSettings() {
  App.data.firstName = document.getElementById('settings-firstname-input').value.trim();
  App.data.lastName  = document.getElementById('settings-lastname-input').value.trim();
  App.data.username  = document.getElementById('settings-username-input').value.trim();
  scheduleSave();
  closeModal('modal-settings');
  showToast('Settings saved ✓');
}

// ─── Auth callbacks ───────────────────────────────────────────────

function onSignedIn(data, isNew) {
  // Preserve any locally-accumulated recipes when upgrading from guest
  const existing = App.data || {};
  const merged = mergeData(data);
  App.data = {
    ...merged,
    recipes:  { ...(existing.recipes || {}), ...(merged.recipes || {}) },
    mealplan: Object.keys(existing.mealplan || {}).length ? existing.mealplan : (merged.mealplan || {}),
  };
  saveLocal();
  renderAll();
  if (isNew) showToast(`Welcome to Refectory 🌿`);
  else showToast(`Welcome back! Syncing your recipes…`);
  syncToWorker();
}

function onGuestReady(data) {
  // Merge incoming auth data (authMethod, name fields) with whatever is
  // already in App.data — preserving any recipes imported before this fires.
  const existing = App.data || {};
  App.data = {
    ...mergeData(data),
    recipes:  Object.keys(existing.recipes  || {}).length ? existing.recipes  : (data.recipes  || {}),
    mealplan: Object.keys(existing.mealplan || {}).length ? existing.mealplan : (data.mealplan || {}),
  };
  saveLocal();
  renderAll();
}

function renderAll() {
  renderRecipes();
  if (View.activeSection === 'planner')  renderPlanner();
  if (View.activeSection === 'shopping') renderShoppingList();
}

// ─── Boot ─────────────────────────────────────────────────────────

// Fetch Google Client ID from the worker (never stored in frontend source)
async function fetchGoogleClientId() {
  const base = getWorkerUrl().replace(/\/+$/, '');
  if (!base) return '';
  try {
    const res = await fetch(`${base}/auth/config`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.googleClientId || '';
  } catch { return ''; }
}

async function boot() {
  // Apply saved/preferred theme immediately (before any render)
  initTheme();

  // Load from localStorage first (instant)
  const stored = ls.get(STORAGE_KEY);
  App.data     = stored ? mergeData(stored) : defaultData();

  // Fetch Google Client ID from worker if we have a worker URL configured.
  // Falls back to empty string (disables Google sign-in) until URL is set.
  const googleClientId = await fetchGoogleClientId();

  // Init auth module
  Auth.init({
    googleClientId,
    storageKey:       STORAGE_KEY,
    storageAuthKey:   STORAGE_AUTH_KEY,
    storageDismissKey: STORAGE_DISMISS_KEY,
    workerBase:       getWorkerUrl,
    getData:          () => App.data,
    setData:          (d) => { App.data = d; saveLocal(); },
    mergeData,
    onSignedIn,
    onGuestReady,
    onSessionExpired: () => {},
    pushToWorker,
    startSyncPing,
    openModal,
    closeModal,
    toast:            showToast,
    appName:          'Refectory',
    appEmoji:         '🌿',
  });

  // New user — show account setup wizard
  if (!stored) {
    renderAll();
    Auth.showAccountSetup();
    return;
  }

  // Existing session — pull from worker and merge with local data
  // Local recipes win if they are newer (updatedAt), so a large import
  // right before a reload doesn't get clobbered by a stale worker copy.
  const tokenBeforePull = App.data.userToken;
  const localRecipes    = { ...(App.data.recipes || {}) };
  const remote          = await pullFromWorker();
  if (remote) {
    const remoteRecipes = remote.recipes || {};
    // Merge: for each recipe take whichever copy has the later updatedAt
    const merged = { ...remoteRecipes };
    for (const [id, localR] of Object.entries(localRecipes)) {
      const remoteR = remoteRecipes[id];
      if (!remoteR || (localR.updatedAt || 0) >= (remoteR.updatedAt || 0)) {
        merged[id] = localR;
      }
    }
    App.data = mergeData({ ...remote, recipes: merged });
    saveLocal();
    // Push merged result back to worker so it stays in sync
    if (Object.keys(localRecipes).length > Object.keys(remoteRecipes).length) {
      pushToWorker();
    }
  }

  const ok = await Auth.bootCheck(tokenBeforePull);
  if (!ok) return;

  renderAll();
  if (!Auth.isGuest()) startSyncPing();
}

// ─── Event wiring ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });

  // Recipe search
  document.getElementById('recipe-search')?.addEventListener('input', e => {
    View.recipeSearch = e.target.value;
    renderRecipes();
  });

  // New recipe button
  document.getElementById('btn-new-recipe')?.addEventListener('click', () => openRecipeEditor(null));

  // Import button
  document.getElementById('btn-import-mealie')?.addEventListener('click', openMealieImport);
  document.getElementById('btn-export')?.addEventListener('click', openExportModal);

  // Export modal — option selection and go button
  document.getElementById('export-opt-full')?.addEventListener('click',   () => selectExportMode('full'));
  document.getElementById('export-opt-images')?.addEventListener('click', () => selectExportMode('images'));
  document.getElementById('btn-export-go')?.addEventListener('click', runExport);
  document.getElementById('modal-export')?.querySelector('.modal-close')
    ?.addEventListener('click', () => closeModal('modal-export'));

  // Editor form
  document.getElementById('btn-add-ingredient')?.addEventListener('click', () => {
    const list = document.getElementById('editor-ingredients-list');
    const div  = document.createElement('div');
    div.className = 'ingredient-row';
    div.innerHTML = `
      <input class="input ing-amount" placeholder="Amount"/>
      <input class="input ing-unit"   placeholder="Unit"/>
      <input class="input ing-name"   placeholder="Ingredient name"/>
      <button class="btn btn-icon remove-ing" title="Remove">✕</button>
    `;
    div.querySelector('.remove-ing').addEventListener('click', () => div.remove());
    list.appendChild(div);
  });

  document.getElementById('btn-add-step')?.addEventListener('click', () => {
    const list = document.getElementById('editor-steps-list');
    const div  = document.createElement('div');
    div.className = 'step-row';
    const num = list.children.length + 1;
    div.innerHTML = `
      <span class="step-num">${num}</span>
      <textarea class="input step-text" rows="2" placeholder="Describe this step…"></textarea>
      <button class="btn btn-icon remove-step" title="Remove">✕</button>
    `;
    div.querySelector('.remove-step').addEventListener('click', () => {
      div.remove();
      document.querySelectorAll('#editor-steps-list .step-num').forEach((el, i) => { el.textContent = i + 1; });
    });
    list.appendChild(div);
  });

  document.getElementById('btn-save-recipe')?.addEventListener('click', saveEditorRecipe);

  // Planner nav
  document.getElementById('planner-prev')?.addEventListener('click', () => {
    View.currentWeek = addWeeks(View.currentWeek, -1);
    renderPlanner();
  });
  document.getElementById('planner-next')?.addEventListener('click', () => {
    View.currentWeek = addWeeks(View.currentWeek, 1);
    renderPlanner();
  });
  document.getElementById('planner-today')?.addEventListener('click', () => {
    View.currentWeek = getISOWeekKey();
    renderPlanner();
  });

  // Pick recipe search
  document.getElementById('pick-recipe-search')?.addEventListener('input', e => filterPickRecipes(e.target.value));

  // Recipe detail scale
  document.getElementById('detail-scale')?.addEventListener('input', updateScaledIngredients);

  // Theme toggle
  document.getElementById('theme-light')?.addEventListener('click', () => applyTheme('light'));
  document.getElementById('theme-dark')?.addEventListener('click',  () => applyTheme('dark'));

  // Settings
  document.getElementById('btn-settings')?.addEventListener('click', openSettings);

  // Token copy button
  document.getElementById('settings-token-copy')?.addEventListener('click', () => {
    const token = App.data?.userToken || '';
    if (!token) return;
    navigator.clipboard.writeText(token).then(() => showToast('Token copied to clipboard ✓'));
  });

  // Enter-token button — opens the auth wizard at the token-entry screen
  document.getElementById('settings-token-change')?.addEventListener('click', () => {
    closeModal('modal-settings');
    Auth.showSetupLoadToken();
  });

  // Danger zone buttons (wired fresh each time settings opens via delegation)
  document.getElementById('modal-settings')?.addEventListener('click', e => {
    if (e.target.id === 'btn-clear-imported') {
      if (confirm('Remove all Mealie-imported recipes? Hand-entered recipes will be kept.')) {
        clearImportedRecipes();
      }
    }
    if (e.target.id === 'btn-wipe-recipes') {
      if (confirm('Permanently delete ALL recipes and meal plans? This cannot be undone.')) {
        wipeAllRecipes();
      }
    }
  });
  document.getElementById('settings-save-btn')?.addEventListener('click', saveSettings);
  document.getElementById('settings-account-btn')?.addEventListener('click', () => {
    closeModal('modal-settings');
    if (Auth.isGuest()) Auth.showSetupFresh();
    else if (Auth.isTokenAccount()) Auth.showGoogleUpgradeFlow();
    else Auth.showGuestSwitchConfirm();
  });

  // Mealie import tabs
  // Mealie import tabs
  document.getElementById('mealie-tab-backup')?.addEventListener('click',     () => switchMealieTab('backup'));
  document.getElementById('mealie-tab-json')?.addEventListener('click',       () => switchMealieTab('json'));
  document.getElementById('mealie-tab-api')?.addEventListener('click',        () => switchMealieTab('api'));
  document.getElementById('mealie-tab-refectory')?.addEventListener('click',  () => switchMealieTab('refectory'));

  // Drop zone
  const dropZone = document.getElementById('mealie-drop-zone');
  const zipInput = document.getElementById('mealie-zip-input');
  if (dropZone && zipInput) {
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--green-mid)';
      dropZone.style.background  = 'rgba(var(--green-mid-rgb, 107,140,90),.07)';
    });
    dropZone.addEventListener('dragleave', () => setMealieDropZoneIdle());
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleMealieZipFile(file);
    });
    dropZone.addEventListener('click', () => zipInput.click());
    zipInput.addEventListener('change', () => {
      if (zipInput.files[0]) handleMealieZipFile(zipInput.files[0]);
    });
  }

  // Refectory backup drop zone
  const refDz    = document.getElementById('refectory-drop-zone');
  const refInput = document.getElementById('refectory-zip-input');
  if (refDz && refInput) {
    const highlight = () => { refDz.style.borderColor = 'var(--green-mid)'; refDz.style.background = 'rgba(107,140,90,.07)'; };
    const unhighlight = () => { refDz.style.borderColor = ''; refDz.style.background = ''; };
    refDz.addEventListener('dragover', e => { e.preventDefault(); highlight(); });
    refDz.addEventListener('dragleave', unhighlight);
    refDz.addEventListener('drop', e => {
      e.preventDefault(); unhighlight();
      const file = e.dataTransfer.files[0];
      if (file) handleRefectoryZipFile(file);
    });
    refDz.addEventListener('click', () => refInput.click());
    document.getElementById('refectory-browse-link')?.addEventListener('click', e => {
      e.stopPropagation(); refInput.click();
    });
    refInput.addEventListener('change', () => {
      if (refInput.files[0]) handleRefectoryZipFile(refInput.files[0]);
    });
  }

  document.getElementById('mealie-import-json-btn')?.addEventListener('click', async () => {
    const txt    = document.getElementById('mealie-json-input').value.trim();
    const status = document.getElementById('mealie-import-status');
    if (!txt) { status.textContent = 'Paste your Mealie JSON export first.'; return; }
    const result = await importFromMealieJson(txt);
    if (result.ok) {
      status.style.color = 'var(--green)';
      status.textContent = `Imported ${result.count} recipe${result.count !== 1 ? 's' : ''} ✓`;
      setTimeout(() => { closeModal('modal-mealie-import'); renderRecipes(); }, 1200);
    } else {
      status.style.color = 'var(--red)';
      status.textContent = result.error;
    }
  });

  document.getElementById('mealie-import-api-btn')?.addEventListener('click', async () => {
    const url    = document.getElementById('mealie-url-input').value.trim();
    const key    = document.getElementById('mealie-api-key').value.trim();
    const status = document.getElementById('mealie-import-status');
    const btn    = document.getElementById('mealie-import-api-btn');
    if (!url || !key) { status.textContent = 'Enter both URL and API key.'; return; }
    btn.disabled = true; btn.textContent = 'Importing…';
    status.textContent = '';
    const result = await importFromMealieApi(url, key);
    btn.disabled = false; btn.textContent = 'Import from Mealie';
    if (result.ok) {
      status.style.color = 'var(--green)';
      status.textContent = `Imported ${result.count} recipe${result.count !== 1 ? 's' : ''} ✓`;
      setTimeout(() => { closeModal('modal-mealie-import'); renderRecipes(); }, 1200);
    } else {
      status.style.color = 'var(--red)';
      status.textContent = result.error;
    }
  });

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Close modals on ✕ button
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.closest('.modal-overlay').id));
  });

  // Safety save when tab is hidden or page is closing
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && App.data) saveLocal();
  });
  window.addEventListener('pagehide', () => {
    if (App.data) saveLocal();
  });

  boot();
});
