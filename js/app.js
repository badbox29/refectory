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
  set:    (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  remove: k => { try { localStorage.removeItem(k); } catch {} },
};

function saveLocal() {
  ls.set(STORAGE_KEY, App.data);
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
  scheduleSave();
}

function deleteRecipe(id) {
  delete App.data.recipes[id];
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
      <div class="recipe-card-img" style="${r.image ? `background-image:url('${esc(r.image)}')` : ''}">
        ${!r.image ? `<div class="recipe-card-placeholder">🍽️</div>` : ''}
      </div>
      <div class="recipe-card-body">
        <div class="recipe-card-title">${esc(r.title)}</div>
        ${r.description ? `<div class="recipe-card-desc">${esc(r.description)}</div>` : ''}
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
  const tags = getAllTags();
  if (!tags.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = tags.map(t =>
    `<button class="tag-filter-btn ${View.recipeTags.includes(t) ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`
  ).join('');
  bar.querySelectorAll('.tag-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tag;
      if (View.recipeTags.includes(t)) View.recipeTags = View.recipeTags.filter(x => x !== t);
      else View.recipeTags.push(t);
      renderRecipes();
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
  if (r.image) { imgEl.src = r.image; imgEl.style.display = ''; }
  else imgEl.style.display = 'none';

  // Ingredients
  document.getElementById('detail-ingredients').innerHTML =
    (r.ingredients || []).map(i =>
      `<li>${esc(i.amount ? `${i.amount} ${i.unit || ''} ${i.name}`.trim() : i.name)}</li>`
    ).join('');

  // Steps
  document.getElementById('detail-steps').innerHTML =
    (r.steps || []).map((s, idx) =>
      `<li><span class="step-num">${idx + 1}</span>${esc(typeof s === 'string' ? s : s.text || '')}</li>`
    ).join('');

  // Scaling
  const scaleInput = document.getElementById('detail-scale');
  scaleInput.value = r.servings || 1;
  scaleInput.dataset.base = r.servings || 1;
  document.getElementById('detail-scale-label').textContent = `Servings (base: ${r.servings || 1})`;

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
  const list = document.getElementById('editor-ingredients-list');
  list.innerHTML = ingredients.map((ing, i) => `
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
    image:       form.querySelector('#editor-image-url').value.trim(),
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
        <div class="pick-img" style="${r.image ? `background-image:url('${esc(r.image)}')` : ''}">
          ${!r.image ? '🍽️' : ''}
        </div>
        <div class="pick-title">${esc(r.title)}</div>
      </div>
    `).join('');
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
    for (const ing of (r.ingredients || [])) {
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

function openMealieImport() {
  document.getElementById('mealie-json-input').value = '';
  document.getElementById('mealie-url-input').value  = '';
  document.getElementById('mealie-api-key').value    = '';
  document.getElementById('mealie-import-status').textContent = '';
  document.getElementById('mealie-zip-input').value  = '';
  // Remove any lingering import button from previous session
  document.getElementById('mealie-import-zip-btn')?.remove();
  setMealieDropZoneIdle();
  // Default to backup tab — most common full-import path
  switchMealieTab('backup');
  openModal('modal-mealie-import');
}

function switchMealieTab(tab) {
  const panels = { backup: 'mealie-backup-panel', json: 'mealie-json-panel', api: 'mealie-api-panel' };
  const btns   = { backup: 'mealie-tab-backup',   json: 'mealie-tab-json',   api: 'mealie-tab-api'   };
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

  return {
    id:          genId(),
    title,
    description: raw.description || raw.summary || '',
    servings:    parseInt(raw.recipeYield || raw.servings) || null,
    tags,
    source:      raw.orgURL ? 'Web' : (raw.source || ''),
    sourceUrl:   raw.orgURL || raw.sourceUrl || '',
    image:       raw.image || '',
    ingredients,
    steps,
    importedFrom: 'mealie',
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
  };
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
    renderAll();
    closeModal('modal-mealie-import');
    showToast(`✅ Imported ${result.count} recipes from Mealie backup`);
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
    if (i.quantity && i.quantity !== 1) parts.push(String(i.quantity));
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

    // Image — read the tiny-original webp from zip and encode as base64
    let image = '';
    if (embedImages) {
      try {
        const uuid     = toUUID(rid);
        // Prefer tiny for storage efficiency; fall back to original
        const imgPaths = [
          `data/recipes/${uuid}/images/tiny-original.webp`,
          `data/recipes/${uuid}/images/original.webp`,
        ];
        for (const p of imgPaths) {
          const imgFile = zip.file(p);
          if (imgFile) {
            const b64 = await imgFile.async('base64');
            image = `data:image/webp;base64,${b64}`;
            break;
          }
        }
      } catch { /* skip image */ }
    }

    const newId = genId();
    const existing = Object.values(App.data.recipes)
      .find(ex => ex.importedFrom === 'mealie-backup' && ex.title === r.name);

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
        image:       image || existing.image,
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
        tags, ingredients, steps, image,
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
  App.data = mergeData(data);
  saveLocal();
  renderAll();
  if (isNew) showToast(`Welcome to Refectory 🌿`);
  else showToast(`Welcome back! Syncing your recipes…`);
  syncToWorker();
}

function onGuestReady(data) {
  App.data = mergeData(data);
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

  // Existing session — try to pull from worker, then boot check
  const tokenBeforePull = App.data.userToken;
  const remote          = await pullFromWorker();
  if (remote) {
    App.data = mergeData(remote);
    saveLocal();
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
  document.getElementById('settings-save-btn')?.addEventListener('click', saveSettings);
  document.getElementById('settings-account-btn')?.addEventListener('click', () => {
    closeModal('modal-settings');
    if (Auth.isGuest()) Auth.showSetupFresh();
    else if (Auth.isTokenAccount()) Auth.showGoogleUpgradeFlow();
    else Auth.showGuestSwitchConfirm();
  });

  // Mealie import tabs
  // Mealie import tabs
  document.getElementById('mealie-tab-backup')?.addEventListener('click', () => switchMealieTab('backup'));
  document.getElementById('mealie-tab-json')?.addEventListener('click',   () => switchMealieTab('json'));
  document.getElementById('mealie-tab-api')?.addEventListener('click',    () => switchMealieTab('api'));

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

  boot();
});
