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
    recipes:     {},  // each recipe may have a `rating` field (0–5), a `favorite`
                      // boolean and a `notes` field
    // Meal plan: { [weekKey]: { [dayIndex]: { [slot]: recipeId } } }
    // weekKey = ISO week "2025-W03", dayIndex 0-6, slot = "breakfast"|"lunch"|"dinner"|"snack"
    // A slot value is an entry string, or an array of them when more than one
    // thing is cooked in that slot. Read with slotEntries(), write with packSlot().
    mealplan:    {},
    // Cookbooks: { [id]: { id, name, description, recipeIds: [] } }
    cookbooks:   {},
    // Recipe groups: { [id]: { id, name, members: [{ id, label }], createdAt, updatedAt } }
    // A group is a set of variants of the same dish — three takes on Swedish
    // egg coffee, say — that collapse to a single tabbed card in the grid.
    // Distinct from a cookbook, which is a collection that leaves its members
    // visible. Membership is exclusive: a recipe in two groups would render
    // twice and undo the collapsing the feature exists for.
    groups:      {},
    // Meal plan templates: { [id]: { id, name, weeks, slots: [], createdAt, updatedAt } }
    // A slot is { w, d, slot, v } — week index within the template (0-based),
    // day of week (0=Mon), meal slot name, and the packed slot value.
    // Deliberately anchored on week+weekday rather than day-of-month: meal
    // planning is weekly-rhythmic (pizza Friday, Sunday roast), so a template
    // loaded into a month starting on a Wednesday must keep Friday on Friday.
    // Day-of-month offsets would slide the whole rhythm and also have no
    // sensible answer for a 31-day template landing in February.
    templates:   {},
    // Shopping stores (custom lists): { [id]: { id, name, createdAt } }
    shoppingStores: {},
    // Item → store assignment: { [itemKey]: storeId }
    // itemKey is the merge key for recipe-derived items, or the manual item's id
    itemStoreAssignments: {},
    lastModified: Date.now(),
  };
}

function mergeData(raw) {
  const d = defaultData();
  if (!raw || typeof raw !== 'object') return d;
  return {
    ...d,
    ...raw,
    recipes:   (raw.recipes   && typeof raw.recipes   === 'object') ? raw.recipes   : d.recipes,
    mealplan:  (raw.mealplan  && typeof raw.mealplan  === 'object') ? raw.mealplan  : d.mealplan,
    cookbooks: (raw.cookbooks && typeof raw.cookbooks === 'object') ? raw.cookbooks : d.cookbooks,
    templates: (raw.templates && typeof raw.templates === 'object') ? raw.templates : d.templates,
    groups:    (raw.groups && typeof raw.groups === 'object') ? raw.groups : d.groups,
    shoppingStores: (raw.shoppingStores && typeof raw.shoppingStores === 'object') ? raw.shoppingStores : d.shoppingStores,
    itemStoreAssignments: (raw.itemStoreAssignments && typeof raw.itemStoreAssignments === 'object') ? raw.itemStoreAssignments : d.itemStoreAssignments,
  };
}

// ─── LocalStorage helpers ─────────────────────────────────────────

const ls = {
  get:    k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set:    (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.error('[Refectory] localStorage.set failed:', e); } },
  remove: k => { try { localStorage.removeItem(k); } catch {} },
};

// Persist to localStorage, and be loud when it doesn't work.
//
// This used to swallow a QuotaExceededError into a three-second toast. On a
// shared origin — several apps under one github.io account, say — the quota is
// per origin, not per app, so a neighbour can fill it. When that happens every
// write silently lands in memory only and disappears on the next reload, which
// is indistinguishable from the app working until you notice hours of edits
// are gone. A banner that stays put is the whole point: silent data loss is
// far worse than a loud failure.
function saveLocal() {
  try {
    const json = JSON.stringify(App.data);
    localStorage.setItem(STORAGE_KEY, json);
    // Verify the write actually landed. Some browsers accept setItem and
    // discard the value under storage pressure rather than throwing.
    const back = localStorage.getItem(STORAGE_KEY);
    if (!back || back.length !== json.length) throw new Error('write did not persist');
    if (App.storageBlocked) { App.storageBlocked = false; renderStorageBanner(); }
    return true;
  } catch (e) {
    console.error('[Refectory] saveLocal failed — data NOT persisted:', e);
    App.storageBlocked = true;
    App.storageError    = e?.name === 'QuotaExceededError' ? 'quota' : (e?.message || 'unknown');
    renderStorageBanner();
    return false;
  }
}

// Persistent, dismissible-only-by-fixing banner. Also reports how much of the
// origin's storage other keys are using, since on a shared origin the cause is
// usually not this app.
function renderStorageBanner() {
  const el = document.getElementById('storage-banner');
  if (!el) return;
  if (!App.storageBlocked) { el.style.display = 'none'; el.innerHTML = ''; return; }

  let mine = 0, total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const bytes = (k.length + (localStorage.getItem(k) || '').length) * 2;
      total += bytes;
      if (k.startsWith('ref_')) mine += bytes;
    }
  } catch {}
  const mb = b => (b / 1048576).toFixed(2);

  el.style.display = '';
  el.innerHTML = `
    <strong>⚠️ Changes are not being saved.</strong>
    ${App.storageError === 'quota'
      ? `This site's storage is <em>full</em> — edits only last until you reload.
         Browsers cap it at a few megabytes per web address, and
         <strong>${mb(total)} MB is already used</strong> here.
         Refectory accounts for ${mb(mine)} MB of that; the rest belongs to other
         pages on the same address, which share the same limit.`
      : `Storage is unavailable (${esc(App.storageError || 'unknown')}), so edits only last
         until you reload.`}
    <span class="storage-banner-actions">
      <button class="btn btn-sm btn-outline" id="storage-banner-export">Export a backup now</button>
      <button class="btn btn-sm btn-outline" id="storage-banner-retry">Check again</button>
    </span>`;
  el.querySelector('#storage-banner-export')?.addEventListener('click', () => openExportModal());
  // Without this the banner can't clear itself: the flag only resets on a
  // successful write, so after freeing space it would linger until something
  // else happened to save.
  el.querySelector('#storage-banner-retry')?.addEventListener('click', () => {
    if (saveLocal()) showToast('Storage is working again — changes are being saved ✓');
    else showToast('Still out of space. Free some up, then check again.');
  });
}

// ─── Worker sync ──────────────────────────────────────────────────

function getWorkerUrl() {
  return App.data?.workerUrl || '';
}

async function pushToWorker() {
  const base  = getWorkerUrl().replace(/\/+$/, '');
  if (!base) return false;
  const token = App.data?.userToken;
  if (!token) return false;

  // Strip image fields — images live in IndexedDB, never sent to worker
  const payload = {
    ...App.data,
    recipes: Object.fromEntries(
      Object.entries(App.data.recipes || {}).map(([id, r]) => {
        const { image: _img, ...rest } = r;
        return [id, rest];
      })
    ),
  };

  const body    = JSON.stringify(payload);
  const headers = await Auth._authHeaders('PUT', token, body);
  try {
    const res = await fetch(`${base}/storage/${encodeURIComponent(token)}/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status));
      console.error(`[Refectory] pushToWorker failed (${res.status}):`, errText);
    }
    return res.ok;
  } catch(e) {
    console.error('[Refectory] pushToWorker network error:', e);
    return false;
  }
}

async function pullFromWorker() {
  const base  = getWorkerUrl().replace(/\/+$/, '');
  if (!base) return null;
  const token   = App.data?.userToken;
  if (!token) return null;
  const headers = await Auth._authHeaders('GET', token, '');
  try {
    const res = await fetch(`${base}/storage/${encodeURIComponent(token)}/profile`, { headers });
    if (res.status === 410) {
      // This token was migrated to a Google account on another device.
      // Update local state so bootCheck triggers Google reauth.
      App.data.authMethod = 'google';
      saveLocal();
      return null;
    }

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
  if (!App.pendingSync) return;
  App.pendingSync = false;
  const ok = await pushToWorker();
  if (!ok) App.pendingSync = true; // retry next tick
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
  el.textContent = msg;   // also clears any markup a previous undo toast left
  el.classList.remove('has-action');
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), duration);
}

// A toast with one action on it. Used for moves in the planner, where the
// mistake is cheap to make and annoying to reverse by hand.
function showUndoToast(msg, onUndo, duration = 6000) {
  const el = document.getElementById('toast');
  if (!el) { showToast(msg); return; }
  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-action';
  btn.textContent = 'Undo';
  btn.addEventListener('click', () => {
    clearTimeout(el._timer);
    el.classList.remove('show', 'has-action');
    el.textContent = '';
    onUndo();
    showToast('Move undone');
  });
  el.append(text, btn);
  el.classList.add('has-action', 'show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.classList.remove('show', 'has-action'); el.textContent = ''; }, duration);
}

// ─── Modal helpers ────────────────────────────────────────────────

function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add('open'); document.body.classList.add('modal-open'); }
}

function closeModal(id) {
  // Leaving the editor by any route abandons an in-progress import review.
  // Hooking this here rather than on the ✕ covers the cancel button and the
  // duplicate-warning jump too, so no route can strand a half-reviewed queue.
  if (id === 'modal-recipe-editor' && typeof editorQueueActive === 'function' && editorQueueActive()) {
    clearEditorQueue();
  }
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('open');
    // Only remove body lock if no other modals open
    if (!document.querySelector('.modal-overlay.open')) document.body.classList.remove('modal-open');
  }
}

// ─── Render helpers ───────────────────────────────────────────────

// Strip markdown and collapse whitespace for plain-text card previews
// ─── Star rating helpers ─────────────────────────────────────────

// Render a read-only star string for display (e.g. "★★★☆☆")
function starsDisplay(rating) {
  const n = Math.round(rating || 0);
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

// Wire up a .star-input widget for interactive rating
function initStarInput(container, initialRating) {
  if (!container) return;
  const stars = container.querySelectorAll('.star-btn');
  function setRating(val) {
    container.dataset.rating = val;
    stars.forEach(s => {
      const v = parseInt(s.dataset.val);
      s.classList.toggle('filled', v <= val);
    });
  }
  setRating(initialRating || 0);
  stars.forEach(star => {
    star.addEventListener('click', () => {
      const val = parseInt(star.dataset.val);
      // Clicking current rating again clears it
      const current = parseInt(container.dataset.rating);
      setRating(val === current ? 0 : val);
    });
    star.addEventListener('mouseenter', () => {
      stars.forEach(s => s.classList.toggle('filled', parseInt(s.dataset.val) <= parseInt(star.dataset.val)));
    });
    star.addEventListener('mouseleave', () => {
      setRating(parseInt(container.dataset.rating));
    });
  });
}

function plainText(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
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

// Storage-space day names. mealplan[weekKey][dayIdx] is Monday-anchored and
// stays that way — see the display helpers below for what the planner shows.
const DAY_NAMES  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FULL_DAYS  = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

// ─── Display-space week (Sunday-anchored) ────────────────────────
// The planner reads as a wall calendar: Sunday first. Storage does not change
// — mealplan is still keyed by ISO week with Monday = index 0, which is what
// every date-driven consumer (shopping list, share links, Mealie import,
// Today's Meals) already computes for itself. Only the planner grid is
// re-windowed, so the leftmost column is the Sunday *before* that ISO week's
// Monday and therefore lives in the previous week key.
//
// Nothing outside these helpers should have to know that. Anything that walks
// a planner week goes through plannerColumns() and uses the storage
// coordinates it hands back.

const COL_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COL_FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The week key whose Sun–Sat window contains `date`. Differs from
// getISOWeekKey only on Sundays: ISO puts a Sunday at the end of the week it
// closes, but on screen that Sunday opens the week ahead. Without this, "This
// Week" on a Sunday would show the week that just ended.
function displayWeekKeyFor(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const mon = new Date(d);
  mon.setDate(d.getDate() - d.getDay() + 1);   // the Monday inside this window
  return getISOWeekKey(mon);
}

// The Sunday that opens the displayed window for a week key.
function displayWeekStart(weekKey, offset = 0) {
  const mon = weekStartDate(weekKey, offset);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() - 1);
  return sun;
}

// The seven planner columns, left to right, Sun → Sat. Each carries the
// storage coordinates it reads and writes, so a caller never computes a day
// index itself.
function plannerColumns(weekKey) {
  const sun  = displayWeekStart(weekKey);
  const prev = addWeeks(weekKey, -1);
  const cols = [];
  for (let col = 0; col < 7; col++) {
    const date = new Date(sun);
    date.setDate(sun.getDate() + col);
    cols.push({
      col,
      date,
      name:     COL_DAY_NAMES[col],
      fullName: COL_FULL_DAYS[col],
      // Sunday is index 6 of the preceding ISO week; Mon–Sat are 0–5 of this one.
      weekKey:  col === 0 ? prev : weekKey,
      dayIdx:   col === 0 ? 6    : col - 1,
    });
  }
  return cols;
}

function plannerColumn(weekKey, col) {
  return plannerColumns(weekKey)[Math.max(0, Math.min(6, col | 0))];
}

// Calendar date a display column refers to.
function displaySlotDate(weekKey, col) {
  const d = displayWeekStart(weekKey);
  d.setDate(d.getDate() + col);
  d.setHours(0, 0, 0, 0);
  return d;
}
// Slots with no real position in the day — available as a same-day leftovers
// source regardless of where they sit in MEAL_SLOTS.
const ANYTIME_SLOTS = ['snack'];

// ─── Leftovers ────────────────────────────────────────────────────
// A meal slot holds a recipe id string. A leftovers entry is that same
// string with a prefix, so the mealplan shape never changes and sync,
// merge and export keep working untouched. Leftovers point at the recipe
// they came from, but don't re-stamp lastCooked and contribute no
// ingredients to the shopping list.
// Full-bleed placeholder for recipes with no image. Fills its container and
// picks up --green-soft, so it tracks the light/dark theme.
const PLACEHOLDER_ART =
  '<svg class="rf-ph" aria-hidden="true" focusable="false"><rect width="100%" height="100%" fill="url(#rf-utensils)"/></svg>';

const LEFTOVERS_PREFIX = 'leftovers:';
// A "fend for yourselves" night points at no recipe at all — it's the absence
// of a plan, not a reference to one. Stored as a bare sentinel in the slot.
const FEND_ENTRY = 'fend';
function isFendEntry(entry) { return entry === FEND_ENTRY; }

// Badge wording — one place each to change it
const LEFTOVERS_LABEL = 'Leftovers';
const FEND_LABEL      = 'Fend For Yourselves';
function isLeftoverEntry(entry) {
  return typeof entry === 'string' && entry.startsWith(LEFTOVERS_PREFIX);
}
function slotRecipeId(entry) {
  if (isFendEntry(entry)) return null;
  return isLeftoverEntry(entry) ? entry.slice(LEFTOVERS_PREFIX.length) : entry;
}
function makeLeftoverEntry(recipeId) { return LEFTOVERS_PREFIX + recipeId; }

// ─── Multi-entry slots ───────────────────────────────────────────
// A slot holds either a bare entry string (the common case — unchanged from
// before) or an array of them, for days where more than one thing is cooked.
// Cooking two dinners on a low-energy day so one can be frozen or eaten as
// leftovers later is a deliberate plan, not a mistake, so the model has to
// represent it. Reads always go through slotEntries(); writes always go
// through packSlot(), which collapses a single entry back to a bare string
// and returns null for empty so callers delete the key rather than storing
// an empty array — [] is truthy, and several render paths test slots for
// truthiness to decide whether a day has anything planned.
function slotEntries(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter(Boolean);
}
function packSlot(entries) {
  const list = (entries || []).filter(Boolean);
  if (!list.length) return null;
  return list.length === 1 ? list[0] : list;
}
// Recipe ids for every entry in a slot, skipping fend nights and dead refs.
function slotRecipeIds(v) {
  return slotEntries(v).map(slotRecipeId).filter(Boolean);
}

// ─── Current view state ───────────────────────────────────────────

const View = {
  currentWeek:   displayWeekKeyFor(),
  activeSection: 'recipes',  // 'recipes' | 'planner' | 'shopping' | 'cookbooks'
  plannerDay:    new Date().getDay(),  // display column 0=Sun…6=Sat, default today
  recipeSearch:  '',
  recipeTags:    [],          // selected tag filters
  editingId:     null,        // recipe id being edited
  checkedItems:  new Set(),   // shopping list checked item keys (session only)
  recipeSort:    'updated',   // 'updated' | 'created' | 'alpha' | 'rating' | 'favorite' | 'lastCooked'
  manualItems:   [],          // [{id, name, checked}] — manually added shopping items
  selectMode:        false,         // recipe bulk-select mode
  selectedRecipeIds: new Set(),     // recipe ids selected in bulk-select mode
  activeShoppingTab: 'default',     // 'default' | a shoppingStores id
};

// ─── Navigation ───────────────────────────────────────────────────

function showSection(name) {
  View.activeSection = name;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === name));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
  if (name === 'recipes')   renderRecipes();
  if (name === 'planner')   renderPlanner();
  if (name === 'shopping')  renderShoppingList();
  if (name === 'cookbooks') renderCookbooks();
}

// ─── Recipe CRUD ──────────────────────────────────────────────────

function getRecipes() {
  const recipes = Object.values(App.data.recipes || {});
  if (View.recipeSort === 'alpha')      return recipes.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  if (View.recipeSort === 'rating')     return recipes.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  // Favorites first, then most recently updated within each group
  if (View.recipeSort === 'favorite')   return recipes.sort((a, b) =>
    (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
  // Newest first by creation, not modification. Distinct from 'updated'
  // because planning meals rewrites lastCooked on existing recipes, which
  // bumps their updatedAt and buries anything genuinely new.
  // Bulk imports share a createdAt to the millisecond, so ties fall back to
  // title rather than shuffling on every render.
  if (View.recipeSort === 'created')    return recipes.sort((a, b) =>
    (b.createdAt || 0) - (a.createdAt || 0) || (a.title || '').localeCompare(b.title || ''));
  if (View.recipeSort === 'lastCooked') return recipes.filter(r => r.lastCooked).sort((a, b) => (b.lastCooked || 0) - (a.lastCooked || 0));
  return recipes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getRecipe(id) { return App.data.recipes?.[id] || null; }

// Resolve a recipe's image for display. Locally cached bytes win (Mealie
// imports, pasted data URLs); otherwise fall back to the remote link stored
// on the recipe record, which syncs across devices.
async function resolveImage(id) {
  const local = await ImageStore.get(id);
  if (local) return local;
  return getRecipe(id)?.imageUrl || null;
}

function saveRecipe(recipe) {
  recipe.updatedAt = Date.now();
  if (!recipe.createdAt) recipe.createdAt = recipe.updatedAt;
  App.data.recipes[recipe.id] = recipe;
  scheduleSave();
}

function deleteRecipe(id) {
  // A deleted recipe must not linger as a group tab pointing at nothing.
  removeFromGroup(id);
  delete App.data.recipes[id];
  ImageStore.delete(id);
  // Remove from meal plan too
  for (const wk of Object.keys(App.data.mealplan)) {
    for (const day of Object.keys(App.data.mealplan[wk])) {
      for (const slot of MEAL_SLOTS) {
        const entries = slotEntries(App.data.mealplan[wk][day][slot]);
        if (!entries.length) continue;
        // Drop only the entries pointing at this recipe — a second dinner
        // planned the same day has nothing to do with the one being deleted.
        const kept   = entries.filter(e => slotRecipeId(e) !== id);
        if (kept.length === entries.length) continue;
        const packed = packSlot(kept);
        if (packed === null) delete App.data.mealplan[wk][day][slot];
        else App.data.mealplan[wk][day][slot] = packed;
      }
    }
  }
  scheduleSave();
}

// ─── Recipe rendering ─────────────────────────────────────────────

// ─── Bulk recipe selection / tag editing ──────────────────────────

function toggleSelectMode() {
  View.selectMode = !View.selectMode;
  if (!View.selectMode) View.selectedRecipeIds.clear();
  const btn = document.getElementById('btn-select-mode');
  if (btn) btn.classList.toggle('active', View.selectMode);
  renderRecipes();
}

function toggleRecipeSelection(id) {
  if (View.selectedRecipeIds.has(id)) View.selectedRecipeIds.delete(id);
  else View.selectedRecipeIds.add(id);
  renderRecipes();
}

function renderBulkActionBar(visibleRecipes) {
  const bar = document.getElementById('bulk-action-bar');
  if (!bar) return;

  if (!View.selectMode) { bar.style.display = 'none'; return; }
  bar.style.display = '';

  const count = View.selectedRecipeIds.size;
  document.getElementById('bulk-selected-count').textContent =
    count ? `${count} selected` : 'Select recipes below';

  const addBtn      = document.getElementById('bulk-add-tag-btn');
  const removeBtn   = document.getElementById('bulk-remove-tag-btn');
  const cookbookBtn = document.getElementById('bulk-add-cookbook-btn');
  const exportBtn   = document.getElementById('bulk-export-btn');
  const deleteBtn   = document.getElementById('bulk-delete-btn');
  [addBtn, removeBtn, cookbookBtn, exportBtn, deleteBtn].forEach(b => { if (b) b.disabled = count === 0; });

  document.getElementById('bulk-select-all-btn').onclick = () => {
    visibleRecipes.forEach(r => View.selectedRecipeIds.add(r.id));
    renderRecipes();
  };
  document.getElementById('bulk-clear-btn').onclick = () => {
    View.selectedRecipeIds.clear();
    renderRecipes();
  };
  addBtn.onclick      = () => openBulkTagModal('add');
  removeBtn.onclick   = () => openBulkTagModal('remove');
  cookbookBtn.onclick = () => openBulkCookbookModal();
  exportBtn.onclick   = () => openExportModal([...View.selectedRecipeIds]);
  deleteBtn.onclick   = () => confirmBulkDelete();
}

async function confirmBulkDelete() {
  const ids = [...View.selectedRecipeIds];
  if (!ids.length) return;
  const titles = ids.map(id => getRecipe(id)?.title).filter(Boolean);
  const preview = titles.slice(0, 5).join(', ') + (titles.length > 5 ? `, +${titles.length - 5} more` : '');
  const okBulk = await appConfirm({
    title: `Delete ${ids.length} recipe${ids.length !== 1 ? 's' : ''}?`,
    message: `${preview}\n\nThis cannot be undone.`,
    confirmLabel: 'Delete', danger: true,
  });
  if (!okBulk) return;

  ids.forEach(id => deleteRecipe(id));
  View.selectedRecipeIds.clear();
  renderRecipes();
  renderTagFilter();
  showToast(`✓ Deleted ${ids.length} recipe${ids.length !== 1 ? 's' : ''}`);
}

function openBulkCookbookModal() {
  const count = View.selectedRecipeIds.size;
  if (!count) return;

  document.getElementById('bulk-cookbook-desc').textContent =
    `Choose a cookbook to add ${count} selected recipe${count !== 1 ? 's' : ''} to.`;

  const books = getCookbooks();
  const listEl  = document.getElementById('bulk-cookbook-list');
  const emptyEl = document.getElementById('bulk-cookbook-empty');

  if (!books.length) {
    listEl.innerHTML = '';
    emptyEl.style.display = '';
  } else {
    emptyEl.style.display = 'none';
    listEl.innerHTML = books.map(cb => {
      const alreadyIn = (cb.recipeIds || []).filter(id => View.selectedRecipeIds.has(id)).length;
      return `
        <button class="bulk-cookbook-row" data-id="${esc(cb.id)}">
          <span class="bulk-cookbook-name">${esc(cb.name)}</span>
          <span class="muted" style="font-size:.78rem;">
            ${(cb.recipeIds || []).length} recipe${(cb.recipeIds || []).length !== 1 ? 's' : ''}
            ${alreadyIn ? ` · ${alreadyIn} already in` : ''}
          </span>
        </button>`;
    }).join('');

    listEl.querySelectorAll('.bulk-cookbook-row').forEach(btn => {
      btn.addEventListener('click', () => addSelectedRecipesToCookbook(btn.dataset.id));
    });
  }

  openModal('modal-bulk-cookbook');
}

function addSelectedRecipesToCookbook(cookbookId) {
  const cb = getCookbook(cookbookId);
  if (!cb) return;
  const ids = [...View.selectedRecipeIds];
  let added = 0;
  cb.recipeIds = cb.recipeIds || [];
  for (const id of ids) {
    if (!cb.recipeIds.includes(id)) { cb.recipeIds.push(id); added++; }
  }
  scheduleSave();
  closeModal('modal-bulk-cookbook');
  showToast(`✓ Added ${added} recipe${added !== 1 ? 's' : ''} to "${cb.name}"`);
}

function openBulkTagModal(mode) {
  if (!View.selectedRecipeIds.size) return;
  const count = View.selectedRecipeIds.size;

  document.getElementById('bulk-tag-modal-title').textContent = mode === 'add' ? 'Add Tag' : 'Remove Tag';
  document.getElementById('bulk-tag-modal-desc').textContent =
    mode === 'add'
      ? `Add a tag to ${count} selected recipe${count !== 1 ? 's' : ''}.`
      : `Remove a tag from ${count} selected recipe${count !== 1 ? 's' : ''}.`;

  document.getElementById('bulk-tag-add-group').style.display    = mode === 'add' ? '' : 'none';
  document.getElementById('bulk-tag-remove-group').style.display = mode === 'remove' ? '' : 'none';

  if (mode === 'add') {
    document.getElementById('bulk-tag-input').value = '';
  } else {
    // Populate dropdown with tags present across the selected recipes, with counts
    const tagCounts = {};
    for (const id of View.selectedRecipeIds) {
      const r = getRecipe(id);
      (r?.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
    }
    const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const selectEl = document.getElementById('bulk-tag-remove-select');
    selectEl.innerHTML = sortedTags.length
      ? sortedTags.map(([tag, n]) => `<option value="${esc(tag)}">${esc(tag)} (${n} of ${count})</option>`).join('')
      : `<option value="">No tags on selected recipes</option>`;
  }

  document.getElementById('bulk-tag-confirm-btn').onclick = () => applyBulkTag(mode);
  openModal('modal-bulk-tag');
  if (mode === 'add') setTimeout(() => document.getElementById('bulk-tag-input')?.focus(), 50);
}

function applyBulkTag(mode) {
  const ids = [...View.selectedRecipeIds];
  if (!ids.length) return;

  if (mode === 'add') {
    const tag = document.getElementById('bulk-tag-input')?.value.trim();
    if (!tag) { showToast('Enter a tag name first.'); return; }
    let count = 0;
    for (const id of ids) {
      const r = getRecipe(id);
      if (!r) continue;
      r.tags = r.tags || [];
      if (!r.tags.includes(tag)) { r.tags.push(tag); count++; }
    }
    scheduleSave();
    closeModal('modal-bulk-tag');
    renderRecipes();
    renderTagFilter();
    showToast(`✓ Added "${tag}" to ${count} recipe${count !== 1 ? 's' : ''}`);
  } else {
    const tag = document.getElementById('bulk-tag-remove-select')?.value;
    if (!tag) { showToast('No tag selected.'); return; }
    let count = 0;
    for (const id of ids) {
      const r = getRecipe(id);
      if (!r?.tags?.includes(tag)) continue;
      r.tags = r.tags.filter(t => t !== tag);
      count++;
    }
    scheduleSave();
    closeModal('modal-bulk-tag');
    renderRecipes();
    renderTagFilter();
    showToast(`✓ Removed "${tag}" from ${count} recipe${count !== 1 ? 's' : ''}`);
  }
}


// Renders a small badge on a recipe card indicating why it matched the search.
// Title matches are visually obvious (the title is right there), so we only
// surface the less-obvious reasons: ingredients, description, or tags.
function renderMatchPill(sources) {
  const priority = [
    ['ingredients', '🥕 Ingredient match'],
    ['description', '📝 Description match'],
    ['tags',        '🏷 Tag match'],
  ];
  for (const [key, label] of priority) {
    if (sources.has(key)) return `<span class="match-pill">${label}</span>`;
  }
  return ''; // title-only match — no pill needed
}

function renderRecipes() {
  const grid   = document.getElementById('recipe-grid');
  const noRes  = document.getElementById('recipe-empty');
  if (!grid) return;

  let recipes = getRecipes();
  const q     = View.recipeSearch.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const matchSources = {}; // recipeId -> Set of 'title'|'description'|'tags'|'ingredients'

  if (terms.length) {
    recipes = recipes.filter(r => {
      const titleText = (r.title || '').toLowerCase();
      const descText  = (r.description || '').toLowerCase();
      const tagTexts  = (r.tags || []).map(t => t.toLowerCase());
      const ingTexts  = (r.ingredients || []).map(i => ingredientText(i).toLowerCase());

      const sources = new Set();
      // Every search term must be found *somewhere* on the recipe (any field).
      // Track which field(s) satisfied each term so the match pill stays accurate.
      const allTermsMatch = terms.every(term => {
        const inTitle = titleText.includes(term);
        const inDesc  = descText.includes(term);
        const inTags  = tagTexts.some(t => t.includes(term));
        const inIng   = ingTexts.some(i => i.includes(term));
        if (inTitle) sources.add('title');
        if (inDesc)  sources.add('description');
        if (inTags)  sources.add('tags');
        if (inIng)   sources.add('ingredients');
        return inTitle || inDesc || inTags || inIng;
      });

      if (allTermsMatch) { matchSources[r.id] = sources; return true; }
      return false;
    });
  }
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

  // Collapse groups: every matching member folds into one tabbed card. In
  // select mode groups stay expanded, since selection operates on individual
  // recipes and you can't tick a tab.
  const gIdx  = View.selectMode ? {} : groupIndex();
  const cards = [];
  const seenGroups = new Set();
  for (const r of recipes) {
    const g = gIdx[r.id];
    if (!g) { cards.push({ type: 'recipe', r, sortKey: r.title || '' }); continue; }
    if (seenGroups.has(g.id)) continue;
    seenGroups.add(g.id);
    // Only members that survived the filter are shown, so a search inside a
    // group narrows its tabs rather than resurrecting the whole set.
    const members = g.members
      .map(m => ({ ...m, recipe: recipes.find(x => x.id === m.id) }))
      .filter(m => m.recipe);
    if (!members.length) continue;
    cards.push({ type: 'group', g, members, sortKey: g.name || '' });
  }

  // Groups sort on their own name, so their position never depends on which
  // member happens to be active.
  if (View.recipeSort === 'alpha') cards.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  grid.innerHTML = cards.map(c => c.type === 'group'
    ? renderGroupCard(c.g, c.members, q, matchSources)
    : renderRecipeCard(c.r, q, matchSources)).join('');

  wireRecipeGrid(grid);
  renderBulkActionBar(recipes);
  hydrateGridImages(grid);
}

function renderRecipeCard(r, q, matchSources) {
  return `
    <div class="recipe-card${View.selectMode ? ' select-mode' : ''}${View.selectedRecipeIds.has(r.id) ? ' is-selected' : ''}" data-id="${esc(r.id)}">
      ${View.selectMode ? `<div class="recipe-card-select-overlay"><input type="checkbox" class="recipe-select-cb" data-id="${esc(r.id)}" ${View.selectedRecipeIds.has(r.id) ? 'checked' : ''}/></div>` : ''}
      <div class="recipe-card-img" data-img-id="${esc(r.id)}">
        <div class="recipe-card-placeholder">${PLACEHOLDER_ART}</div>
        ${q && matchSources[r.id] ? renderMatchPill(matchSources[r.id]) : ''}
      </div>
      <div class="recipe-card-body">
        <div class="recipe-card-title">${esc(r.title)}</div>
        ${r.description ? `<div class="recipe-card-desc">${esc(plainText(r.description))}</div>` : ''}
        <div class="recipe-card-meta">
          ${r.favorite ? `<span class="card-fav" title="Family Favorite">♥</span>` : ''}
          ${r.rating ? `<span class="card-stars" title="${r.rating} out of 5">${starsDisplay(r.rating)}</span>` : ''}
          ${r.servings ? `<span>Serves ${esc(String(r.servings))}</span>` : ''}
          ${r.totalTime ? `<span class="card-time">⏱ ${esc(r.totalTime)}</span>` : r.cookTime ? `<span class="card-time">⏱ ${esc(r.cookTime)}</span>` : ''}
          ${r.tags?.length ? `<span>${r.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// One card, tabs along the top edge. The active tab is whichever member the
// search matched, so a hit inside a group surfaces the right variant rather
// than whatever happens to be first.
function renderGroupCard(g, members, q, matchSources) {
  const activeIdx = Math.max(0, members.findIndex(m => matchSources[m.id]));
  const active    = members[activeIdx] || members[0];
  const r         = active.recipe;
  return `
    <div class="recipe-card recipe-card-group" data-group-id="${esc(g.id)}" data-id="${esc(r.id)}">
      <div class="group-tabs" role="tablist" title="${esc(g.name)}">
        ${members.map((m, i) => `
          <button class="group-tab${i === activeIdx ? ' is-active' : ''}"
                  data-group-id="${esc(g.id)}" data-member="${esc(m.id)}"
                  title="${esc(m.recipe.title)}">${esc(m.label || m.recipe.title)}</button>`).join('')}
        <button class="group-edit" data-group-id="${esc(g.id)}" title="Edit group">⚙</button>
      </div>
      <div class="recipe-card-img" data-img-id="${esc(r.id)}">
        <div class="recipe-card-placeholder">${PLACEHOLDER_ART}</div>
        ${q && matchSources[r.id] ? renderMatchPill(matchSources[r.id]) : ''}
      </div>
      <div class="recipe-card-body">
        <div class="group-name">${esc(g.name)}</div>
        <div class="recipe-card-title">${esc(r.title)}</div>
        ${r.description ? `<div class="recipe-card-desc">${esc(plainText(r.description))}</div>` : ''}
        <div class="recipe-card-meta">
          ${r.favorite ? `<span class="card-fav" title="Family Favorite">♥</span>` : ''}
          ${r.rating ? `<span class="card-stars" title="${r.rating} out of 5">${starsDisplay(r.rating)}</span>` : ''}
          ${r.servings ? `<span>Serves ${esc(String(r.servings))}</span>` : ''}
          ${r.totalTime ? `<span class="card-time">⏱ ${esc(r.totalTime)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

function wireRecipeGrid(grid) {
  grid.querySelectorAll('.recipe-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('.group-tab') || e.target.closest('.group-edit')) return;
      if (View.selectMode) {
        e.preventDefault();
        toggleRecipeSelection(card.dataset.id);
        return;
      }
      openRecipeDetail(card.dataset.id);
    });
  });

  // Switching a tab swaps the card in place rather than re-rendering the grid,
  // so the rest of the page doesn't jump and images aren't re-fetched.
  grid.querySelectorAll('.group-tab').forEach(tab => {
    tab.addEventListener('click', e => {
      e.stopPropagation();
      const card = tab.closest('.recipe-card-group');
      const g    = getGroup(tab.dataset.groupId);
      const r    = getRecipe(tab.dataset.member);
      if (!card || !g || !r) return;
      card.dataset.id = r.id;
      card.querySelectorAll('.group-tab').forEach(x => x.classList.toggle('is-active', x === tab));
      card.querySelector('.recipe-card-title').textContent = r.title;
      const desc = card.querySelector('.recipe-card-desc');
      if (desc) desc.textContent = r.description ? plainText(r.description) : '';
      const img = card.querySelector('.recipe-card-img');
      img.dataset.imgId = r.id;
      img.style.backgroundImage = '';
      hydrateGridImages(card);
    });
  });

  grid.querySelectorAll('.group-edit').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openGroupEditor(btn.dataset.groupId); });
  });

  grid.querySelectorAll('.recipe-select-cb').forEach(cb => {
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => toggleRecipeSelection(cb.dataset.id));
  });
}

function hydrateGridImages(root) {
  root.querySelectorAll('[data-img-id]').forEach(async imgEl => {
    const dataUrl = await resolveImage(imgEl.dataset.imgId);
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

function getAllTagsWithCounts() {
  const counts = {};
  for (const r of Object.values(App.data.recipes || {})) {
    (r.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  }
  return Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ─── Tag manager (merge / rename) ──────────────────────────────────

let _tagManagerSelected = new Set();

function openTagManager() {
  _tagManagerSelected = new Set();
  renderTagManager();
  openModal('modal-tag-manager');
}

function renderTagManager() {
  const body = document.getElementById('tag-manager-body');
  if (!body) return;

  // Preserve scroll position of the tag list across re-renders
  const prevList = document.querySelector('.tag-manager-list');
  const prevScroll = prevList ? prevList.scrollTop : 0;

  const search = document.getElementById('tag-manager-search')?.value.trim().toLowerCase() || '';
  const all    = getAllTagsWithCounts();
  const visible = search ? all.filter(t => t.tag.toLowerCase().includes(search)) : all;

  const selectedCount = _tagManagerSelected.size;
  const visibleSelectedCount = visible.filter(t => _tagManagerSelected.has(t.tag)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelectedCount === visible.length;

  const totalRecipesAffected = selectedCount
    ? new Set(
        Object.values(App.data.recipes || {})
          .filter(r => (r.tags || []).some(t => _tagManagerSelected.has(t)))
          .map(r => r.id)
      ).size
    : 0;

  body.innerHTML = `
    <input class="input" id="tag-manager-search" placeholder="Search tags…"
           value="${esc(search)}" autocomplete="off" style="margin-bottom:.65rem;"/>

    ${visible.length ? `
      <label class="tag-manager-select-all">
        <input type="checkbox" id="tag-manager-select-all-cb" ${allVisibleSelected ? 'checked' : ''}/>
        <span>Select all ${search ? 'matching' : ''} (${visible.length})</span>
        ${selectedCount ? `<span class="muted" style="margin-left:auto;">${selectedCount} selected</span>` : ''}
      </label>
    ` : ''}

    <div class="tag-manager-list">
      ${visible.map(({ tag, count }) => `
        <label class="tag-manager-row">
          <input type="checkbox" class="tag-manager-cb" data-tag="${esc(tag)}"
                 ${_tagManagerSelected.has(tag) ? 'checked' : ''}/>
          <span class="tag-manager-name">${esc(tag)}</span>
          <span class="tag-manager-count muted">${count} recipe${count !== 1 ? 's' : ''}</span>
        </label>`).join('') || `<p class="muted" style="padding:.5rem 0;">No tags match your search.</p>`}
    </div>

    ${selectedCount >= 2 ? `
      <div class="tag-manager-merge-bar">
        <div class="muted" style="font-size:.8rem;margin-bottom:.5rem;">
          Merging <strong>${selectedCount}</strong> tags will affect <strong>${totalRecipesAffected}</strong> recipe${totalRecipesAffected !== 1 ? 's' : ''}.
        </div>
        <div style="display:flex;gap:.5rem;">
          <input class="input" id="tag-manager-merge-name" placeholder="New tag name…"
                 value="${esc([..._tagManagerSelected].sort((a,b) => b.length - a.length)[0] || '')}" style="flex:1;"/>
          <button class="btn btn-primary btn-sm" id="tag-manager-merge-btn">Merge into this</button>
        </div>
      </div>
    ` : selectedCount === 1 ? `
      <div class="tag-manager-merge-bar">
        <div class="muted" style="font-size:.8rem;margin-bottom:.5rem;">Rename this tag everywhere:</div>
        <div style="display:flex;gap:.5rem;">
          <input class="input" id="tag-manager-merge-name" placeholder="New name…"
                 value="${esc([..._tagManagerSelected][0] || '')}" style="flex:1;"/>
          <button class="btn btn-primary btn-sm" id="tag-manager-merge-btn">Rename</button>
        </div>
      </div>
    ` : ''}
  `;

  // Restore scroll position
  const newList = document.querySelector('.tag-manager-list');
  if (newList) newList.scrollTop = prevScroll;

  // Re-wire search (preserve focus/cursor position)
  const searchEl = document.getElementById('tag-manager-search');
  searchEl?.addEventListener('input', () => {
    const pos = searchEl.selectionStart;
    renderTagManager();
    const newEl = document.getElementById('tag-manager-search');
    if (newEl) { newEl.focus(); newEl.setSelectionRange(pos, pos); }
  });

  // Select-all toggle — applies to currently visible (filtered) tags only
  document.getElementById('tag-manager-select-all-cb')?.addEventListener('change', e => {
    if (e.target.checked) visible.forEach(t => _tagManagerSelected.add(t.tag));
    else visible.forEach(t => _tagManagerSelected.delete(t.tag));
    renderTagManager();
  });

  // Checkbox selection
  body.querySelectorAll('.tag-manager-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) _tagManagerSelected.add(cb.dataset.tag);
      else _tagManagerSelected.delete(cb.dataset.tag);
      renderTagManager();
    });
  });

  // Merge/rename action
  document.getElementById('tag-manager-merge-btn')?.addEventListener('click', () => {
    const newName = document.getElementById('tag-manager-merge-name')?.value.trim();
    if (!newName) { showToast('Enter a tag name first.'); return; }
    mergeTags([..._tagManagerSelected], newName);
  });
}

function mergeTags(oldTags, newName) {
  let affected = 0;
  for (const r of Object.values(App.data.recipes || {})) {
    const tags = r.tags || [];
    if (!tags.some(t => oldTags.includes(t))) continue;
    const rest = tags.filter(t => !oldTags.includes(t));
    if (!rest.includes(newName)) rest.push(newName);
    r.tags = rest;
    affected++;
  }
  scheduleSave();
  _tagManagerSelected = new Set();
  renderTagManager();
  renderTagFilter();
  renderRecipes();
  showToast(`✓ Merged into "${newName}" — ${affected} recipe${affected !== 1 ? 's' : ''} updated`);
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
      <button class="tag-filter-toggle" id="tag-filter-manage" style="margin-left:auto;">⚙ Manage Tags</button>
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

  // Open tag manager
  bar.querySelector('#tag-filter-manage')?.addEventListener('click', openTagManager);

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

  // If this recipe belongs to a group, put its siblings across the top so you
  // can compare variants without closing and reopening.
  const gTabs = document.getElementById('detail-group-tabs');
  const g     = groupForRecipe(id);
  if (gTabs) {
    if (!g) { gTabs.style.display = 'none'; gTabs.innerHTML = ''; }
    else {
      gTabs.style.display = '';
      gTabs.innerHTML = g.members.filter(m => getRecipe(m.id)).map(m => `
        <button class="detail-group-tab${m.id === id ? ' is-active' : ''}"
                data-member="${esc(m.id)}"
                title="${esc(getRecipe(m.id).title)}">${esc(m.label || getRecipe(m.id).title)}</button>`).join('');
      gTabs.querySelectorAll('.detail-group-tab').forEach(b =>
        b.addEventListener('click', () => openRecipeDetail(b.dataset.member)));
    }
  }

  document.getElementById('detail-title').textContent       = r.title || '';
  document.getElementById('detail-description').textContent = r.description || '';
  document.getElementById('detail-servings').textContent    = r.servings ? `Serves ${r.servings}` : '';
  const mtEl = document.getElementById('detail-meal-type');
  if (mtEl) {
    if (r.mealType) {
      mtEl.innerHTML = `<span class="meal-type-badge meal-type-${esc(r.mealType)}">${esc(r.mealType.charAt(0).toUpperCase() + r.mealType.slice(1))}</span>`;
    } else {
      mtEl.textContent = '';
    }
  }

  const lcEl = document.getElementById('detail-last-cooked');
  if (lcEl) {
    if (r.lastCooked) {
      const d = new Date(r.lastCooked);
      lcEl.textContent = `Last cooked ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } else {
      lcEl.textContent = '';
    }
  }
  const favEl = document.getElementById('detail-favorite');
  if (favEl) {
    favEl.className = 'detail-fav' + (r.favorite ? ' is-fav' : '');
    favEl.title     = r.favorite ? 'Family Favorite — click to unset' : 'Mark as Family Favorite';
    favEl.textContent = r.favorite ? '♥' : '♡';
    favEl.onclick = () => {
      const rec = getRecipe(r.id);
      if (!rec) return;
      rec.favorite = !rec.favorite;
      saveRecipe(rec);
      openRecipeDetail(r.id);
      renderRecipes();
      showToast(rec.favorite ? '♥ Added to Family Favorites' : 'Removed from Family Favorites');
    };
  }

  const ratingEl = document.getElementById('detail-rating');
  if (ratingEl) {
    const rating = r.rating || 0;
    ratingEl.innerHTML = `<span class="detail-stars${rating ? '' : ' detail-stars-empty'}" title="${rating ? rating + ' out of 5' : 'Not yet rated — click Edit to rate'}">${starsDisplay(rating)}</span>`;
  }

  // Time chips — only shown when data present
  const timeChip = (label, val) => {
    const el = document.getElementById(`detail-${label}`);
    if (!el) return;
    if (val) {
      el.innerHTML = `<span class="detail-time-chip"><span class="detail-time-label">${label}</span>${esc(val)}</span>`;
    } else {
      el.textContent = '';
    }
  };
  timeChip('prep',  r.prepTime  || '');
  timeChip('cook',  r.cookTime  || '');
  timeChip('total', r.totalTime || '');
  document.getElementById('detail-tags').innerHTML          = (r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  document.getElementById('detail-source').innerHTML        = r.sourceUrl
    ? (() => {
        const display = r.source && r.source !== r.sourceUrl
          ? r.source
          : (() => { try { const u = new URL(r.sourceUrl); return u.hostname + (u.pathname.length > 1 ? u.pathname : ''); } catch { return r.sourceUrl; } })();
        const truncated = display.length > 60 ? display.slice(0, 57) + '…' : display;
        return `<a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener" title="${esc(r.sourceUrl)}">${esc(truncated)}</a>`;
      })()
    : (r.source ? esc(r.source) : '');

  const imgEl = document.getElementById('detail-image');
  imgEl.style.display = 'none';
  imgEl.src = '';
  resolveImage(id).then(dataUrl => {
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
      `<li><span class="step-num">${idx + 1}</span><span class="step-text">${esc(plainText(stepText(s)))}</span></li>`
    ).join('');

  // Scaling
  const scaleInput = document.getElementById('detail-scale');
  const servingsRaw = String(r.servings || '').trim();
  const servingsNum = parseFloat(servingsRaw) || 1;
  scaleInput.value = servingsNum;
  scaleInput.dataset.base = servingsNum;
  const servingsLabel = servingsRaw || String(servingsNum);
  document.getElementById('detail-scale-label').textContent = `Servings (base: ${servingsLabel})`;

  document.getElementById('detail-print-btn').onclick = () => printRecipe(id);
  document.getElementById('detail-edit-btn').onclick = () => { closeModal('modal-recipe-detail'); openRecipeEditor(id); };
  document.getElementById('detail-delete-btn').onclick = async () => {
    if (await appConfirm({
      title: 'Delete recipe?',
      message: `“${r.title}” will be removed. This cannot be undone.`,
      confirmLabel: 'Delete', danger: true,
    })) {
      deleteRecipe(id);
      closeModal('modal-recipe-detail');
      renderRecipes();
      showToast('Recipe deleted.');
    }
  };
  document.getElementById('detail-plan-btn').onclick = () => openAddToPlanModal(id);

  // ── Tab switching ────────────────────────────────────────────────
  const tabs        = document.querySelectorAll('.detail-tab');
  const panelRecipe = document.getElementById('detail-panel-recipe');
  const panelNotes  = document.getElementById('detail-panel-notes');
  const notesArea   = document.getElementById('detail-notes');

  // Reset to Recipe Details tab each time modal opens
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === 'recipe'));
  if (panelRecipe) panelRecipe.style.display = '';
  if (panelNotes)  panelNotes.style.display  = 'none';

  // Populate notes
  if (notesArea) notesArea.value = r.notes || '';

  // Wire tab buttons
  tabs.forEach(tab => {
    tab.onclick = () => {
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      const isNotes = tab.dataset.tab === 'notes';
      if (panelRecipe) panelRecipe.style.display = isNotes ? 'none' : '';
      if (panelNotes)  panelNotes.style.display  = isNotes ? '' : 'none';
      if (isNotes) {
        notesArea?.focus();
        if (notesArea) {
          notesArea.style.height = 'auto';
          notesArea.style.height = Math.max(420, notesArea.scrollHeight) + 'px';
        }
      }
    };
  });

  // Auto-save notes on input (debounced 600ms) + auto-expand textarea
  let _notesSaveTimer = null;
  if (notesArea) {
    const autoExpand = () => {
      notesArea.style.height = 'auto';
      notesArea.style.height = Math.max(420, notesArea.scrollHeight) + 'px';
    };
    notesArea.oninput = () => {
      autoExpand();
      clearTimeout(_notesSaveTimer);
      _notesSaveTimer = setTimeout(() => {
        const recipe = getRecipe(id);
        if (recipe) {
          recipe.notes = notesArea.value;
          saveRecipe(recipe);
        }
      }, 600);
    };
    // Expand on initial load if notes already exist
    setTimeout(autoExpand, 0);
  }

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

// ─── Duplicate recipe detection ────────────────────────────────────

function normalizeTitleForCompare(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token-overlap (Jaccard) similarity with a containment boost for
// "X" vs "X Recipe" / "X Sandwich" style near-duplicates.
function titleSimilarity(a, b) {
  const na = normalizeTitleForCompare(a), nb = normalizeTitleForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const wordsA = new Set(na.split(' '));
  const wordsB = new Set(nb.split(' '));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = na.includes(nb) || nb.includes(na) ? 0.25 : 0;

  return Math.min(1, jaccard + containment);
}

const DUPLICATE_TITLE_THRESHOLD = 0.75;

// Returns recipes already in the library whose title looks like a likely
// duplicate of `title`. Excludes `excludeId` (used when editing an existing recipe).
function findSimilarRecipes(title, excludeId = null) {
  if (!title?.trim()) return [];
  return Object.values(App.data.recipes || {})
    .filter(r => r.id !== excludeId)
    .map(r => ({ recipe: r, score: titleSimilarity(title, r.title) }))
    .filter(m => m.score >= DUPLICATE_TITLE_THRESHOLD)
    .sort((a, b) => b.score - a.score);
}

function renderDuplicateWarning(title, excludeId = null) {
  const banner = document.getElementById('editor-duplicate-warning');
  if (!banner) return;

  const matches = findSimilarRecipes(title, excludeId);
  if (!matches.length) { banner.style.display = 'none'; banner.innerHTML = ''; return; }

  banner.style.display = '';
  banner.innerHTML = `
    <span class="dup-warning-icon">⚠️</span>
    <span class="dup-warning-text">
      ${matches.length === 1 ? 'A similar recipe already exists' : `${matches.length} similar recipes already exist`}:
      ${matches.slice(0, 3).map(m => `<button type="button" class="dup-warning-link" data-id="${esc(m.recipe.id)}">${esc(m.recipe.title)}</button>`).join(', ')}
    </span>
  `;
  banner.querySelectorAll('.dup-warning-link').forEach(btn => {
    btn.addEventListener('click', () => {
      closeModal('modal-recipe-editor');
      openRecipeDetail(btn.dataset.id);
    });
  });
}


// ─── Editor import queue ─────────────────────────────────────────
// When a page yields several recipes they load into the editor as tabs rather
// than being saved blind — a heuristic parse is a guess, and guesses deserve a
// look before they land in the collection. The editor form is already a clean
// two-way mapping (openRecipeEditor paints a recipe object in, collectEditorData
// reads one back out), so switching tabs is just "read the current one back,
// paint the next one". On-screen edits survive a switch because switching *is*
// a save into memory.
const EditorQueue = { items: [], active: -1 };

function editorQueueActive() { return EditorQueue.items.length > 0; }

// Fold the on-screen form back into the queue entry it came from. Spreading
// over the original preserves fields the form doesn't surface — the heuristic
// flag, importedFrom, createdAt.
function stashActiveTab() {
  const i = EditorQueue.active;
  if (i < 0 || !EditorQueue.items[i]) return;
  EditorQueue.items[i] = { ...EditorQueue.items[i], ...collectEditorData() };
}

function openEditorQueue(list) {
  EditorQueue.items  = list.map(r => ({ ...r, imageUrl: r.imageUrl || r.image || '' }));
  EditorQueue.active = -1;
  switchEditorTab(0);
}

function switchEditorTab(idx) {
  if (idx < 0 || idx >= EditorQueue.items.length || idx === EditorQueue.active) return;
  stashActiveTab();
  EditorQueue.active = idx;
  openRecipeEditor(null, EditorQueue.items[idx]);
}

// Remove a tab. `savedTitle` is set when it left via Save rather than Discard.
// `landOn` is the post-splice index to open next; leave it null to take the
// slot the removed tab vacated, which is what you want when the tab being
// removed is the one on screen. Discarding a *different* tab has to pass the
// adjusted index of the one being edited instead — otherwise removing an
// earlier tab shifts it down and the user gets dropped onto a neighbour with
// their edits silently left behind.
function closeEditorTab(idx, savedTitle, landOn = null) {
  EditorQueue.items.splice(idx, 1);

  if (!EditorQueue.items.length) {
    EditorQueue.active = -1;
    renderEditorQueueTabs();
    closeModal('modal-recipe-editor');
    showToast(savedTitle ? `Saved “${savedTitle}” — all done ✓` : 'Import review finished');
    if (View.activeSection !== 'recipes') showSection('recipes');
    return;
  }

  const next = Math.min(landOn == null ? idx : landOn, EditorQueue.items.length - 1);
  EditorQueue.active = -1;   // nothing on screen maps to a tab now, so don't stash
  switchEditorTab(next);
  const left = EditorQueue.items.length;
  showToast(savedTitle
    ? `Saved “${savedTitle}” · ${left} left to review`
    : `Discarded · ${left} left to review`);
}

function renderEditorQueueTabs() {
  const bar = document.getElementById('editor-queue-tabs');
  if (!bar) return;
  if (!EditorQueue.items.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = EditorQueue.items.map((r, i) => `
    <div class="eq-tab${i === EditorQueue.active ? ' is-active' : ''}" data-idx="${i}"
         title="${esc(r.title || 'Untitled')}">
      <span class="eq-tab-label">${esc(r.title || 'Untitled')}</span>
      <button class="eq-tab-close" data-close="${i}" title="Discard this one">✕</button>
    </div>`).join('');

  bar.querySelectorAll('.eq-tab').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.eq-tab-close')) return;
      switchEditorTab(parseInt(el.dataset.idx));
    });
  });
  bar.querySelectorAll('.eq-tab-close').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const i = parseInt(btn.dataset.close);
      if (i === EditorQueue.active) {
        // Discarding the tab on screen throws its edits away — that's the
        // point of discard, so don't stash it first.
        EditorQueue.active = -1;
        closeEditorTab(i, null);
      } else {
        // Discarding a different tab keeps the current one open, but removing
        // an earlier tab shifts its index down by one.
        stashActiveTab();
        const stay = i < EditorQueue.active ? EditorQueue.active - 1 : EditorQueue.active;
        EditorQueue.active = -1;
        closeEditorTab(i, null, stay);
      }
    });
  });
}

function clearEditorQueue() {
  EditorQueue.items  = [];
  EditorQueue.active = -1;
  renderEditorQueueTabs();
}

function openRecipeEditor(id = null, prefill = null) {
  const recipe = id ? (getRecipe(id) || {}) : (prefill || {});
  View.editingId = id;

  const form = document.getElementById('recipe-editor-form');
  form.querySelector('#editor-title').value       = recipe.title       || '';
  form.querySelector('#editor-description').value = recipe.description || '';
  form.querySelector('#editor-servings').value    = recipe.servings    || '';
  initStarInput(form.querySelector('#editor-rating'), recipe.rating || 0);
  const favEl = form.querySelector('#editor-favorite');
  if (favEl) favEl.checked = !!recipe.favorite;
  const mealTypeEl = form.querySelector('#editor-meal-type');
  if (mealTypeEl) mealTypeEl.value = recipe.mealType || '';
  form.querySelector('#editor-tags').value        = (recipe.tags || []).join(', ');
  form.querySelector('#editor-source').value      = recipe.source      || '';
  form.querySelector('#editor-source-url').value  = recipe.sourceUrl   || '';
  form.querySelector('#editor-image-url').value   = recipe.imageUrl || recipe.image || '';

  // Ingredients
  renderEditorIngredients(recipe.ingredients || [{ name: '', amount: '', unit: '' }]);
  // Steps
  renderEditorSteps(recipe.steps || [{ text: '' }]);

  const modalTitle = document.getElementById('modal-editor-title');
  if (modalTitle) {
    modalTitle.textContent = editorQueueActive()
      ? `Review Imports — ${EditorQueue.active + 1} of ${EditorQueue.items.length}`
      : (id ? 'Edit Recipe' : 'New Recipe');
  }
  renderEditorQueueTabs();

  const warnEl = document.getElementById('editor-heuristic-warning');
  if (warnEl) warnEl.style.display = recipe.heuristic ? '' : 'none';

  // Duplicate detection — check immediately (covers scraped/prefilled titles)
  // and re-check live as the user types a title manually.
  const titleInput = form.querySelector('#editor-title');
  renderDuplicateWarning(titleInput.value, id);
  titleInput.oninput = () => renderDuplicateWarning(titleInput.value, id);

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
    rating:      parseInt(form.querySelector('#editor-rating')?.dataset.rating) || 0,
    favorite:    !!form.querySelector('#editor-favorite')?.checked,
    mealType:    form.querySelector('#editor-meal-type')?.value || '',
    tags,
    source:      form.querySelector('#editor-source').value.trim(),
    sourceUrl:   form.querySelector('#editor-source-url').value.trim(),
    imageUrl:    form.querySelector('#editor-image-url').value.trim(),
    ingredients,
    steps,
  };
}

function saveEditorRecipe() {
  const btn = document.getElementById('btn-save-recipe');
  if (btn?.disabled) return;  // prevent double-fire
  if (btn) btn.disabled = true;

  const data = collectEditorData();
  if (!data.title) {
    showToast('Please enter a recipe title.');
    if (btn) btn.disabled = false;
    return;
  }

  // Lock in the ID — use editingId for existing, generate once for new
  if (!View.editingId) View.editingId = genId();
  const id       = View.editingId;
  const existing = getRecipe(id) || {};

  // Remote image links live on the recipe record so they sync across devices.
  // A pasted data: URL is raw bytes — those stay in IndexedDB, never in
  // localStorage and never pushed to the worker.
  if (data.imageUrl.startsWith('data:')) {
    ImageStore.set(id, data.imageUrl);
    data.imageUrl = '';
  }
  saveRecipe({ ...existing, ...data, id });
  View.editingId = null;
  if (btn) btn.disabled = false;
  renderRecipes();

  // Reviewing an import queue: drop the tab just saved and move to the next
  // rather than dismissing the editor, which would strand the rest.
  if (editorQueueActive() && EditorQueue.active >= 0) {
    closeEditorTab(EditorQueue.active, data.title);
    return;
  }

  closeModal('modal-recipe-editor');
  showToast(existing.id ? 'Recipe updated ✓' : 'Recipe saved ✓');
  if (View.activeSection !== 'recipes') showSection('recipes');
}

// ─── Meal planner ─────────────────────────────────────────────────

function getWeekPlan(weekKey) {
  return App.data.mealplan?.[weekKey] || {};
}

// Recipe ids planned across one or more *display* weeks. Walking the stored
// week object directly would be off by a day at each end now that a display
// window runs Sun–Sat: it would pull in the Monday past the end of the
// horizon and miss the Sunday at the start of it.
//
// Leftovers are already-cooked food and fend nights aren't a meal, so neither
// contributes anything to buy.
function plannedRecipeIds(weekKeys) {
  const ids = new Set();
  for (const wk of weekKeys) {
    for (const c of plannerColumns(wk)) {
      const day = App.data.mealplan?.[c.weekKey]?.[c.dayIdx];
      if (!day) continue;
      for (const v of Object.values(day)) {
        for (const entry of slotEntries(v)) {
          if (isLeftoverEntry(entry) || isFendEntry(entry)) continue;
          const id = slotRecipeId(entry);
          if (id) ids.add(id);
        }
      }
    }
  }
  return ids;
}

// The weeks the shopping list covers: the one on screen plus the next.
function shoppingHorizonWeeks() {
  return [View.currentWeek, addWeeks(View.currentWeek, 1)];
}


// ─── Today's Meals widget ──────────────────────────────────────────

function getTodaysMeals() {
  const now      = new Date();
  const weekKey  = getISOWeekKey(now);
  const dayIdx   = (now.getDay() + 6) % 7; // Mon=0 .. Sun=6, matches DAY_NAMES/MEAL_SLOTS layout
  const plan     = getWeekPlan(weekKey);
  const dayPlan  = plan[dayIdx] || {};

  const meals = [];
  for (const slot of MEAL_SLOTS) {
    for (const entry of slotEntries(dayPlan[slot])) {
      if (isFendEntry(entry)) { meals.push({ slot, recipe: null, fend: true }); continue; }
      const recipe = getRecipe(slotRecipeId(entry));
      if (recipe) meals.push({ slot, recipe, leftover: isLeftoverEntry(entry) });
    }
  }
  return meals;
}

function renderTodaysMealsTrigger() {
  const btn   = document.getElementById('btn-todays-meals');
  if (!btn) return;
  const meals = getTodaysMeals();
  btn.style.display = meals.length ? '' : 'none';
}

function renderTodaysMealsDrawer() {
  const body = document.getElementById('todays-meals-drawer-body');
  if (!body) return;
  const meals = getTodaysMeals();

  if (!meals.length) {
    body.innerHTML = '<div class="todays-meals-empty">Nothing planned for today.</div>';
    return;
  }

  body.innerHTML = `<div class="todays-meals-grid">${meals.map(({ slot, recipe, leftover, fend }) => `
    <div class="todays-meal-card"${fend ? '' : ` data-id="${esc(recipe.id)}"`}>
      <div class="todays-meal-card-img"${fend ? '' : ` data-img-id="${esc(recipe.id)}"`}>${PLACEHOLDER_ART}</div>
      <div class="todays-meal-card-body">
        <span class="meal-type-badge meal-type-${esc(slot)}">${esc(capitalise(slot))}</span>
        ${fend ? `<span class="fend-badge">${FEND_LABEL}</span>` : ''}
        ${leftover ? `<span class="leftovers-badge">${LEFTOVERS_LABEL}</span>` : ''}
        ${fend ? '' : `<div class="todays-meal-card-title">${esc(recipe.title)}</div>`}
      </div>
    </div>
  `).join('')}</div>`;

  body.querySelectorAll('.todays-meal-card').forEach(card => {
    if (!card.dataset.id) return;
    card.addEventListener('click', () => {
      closeModal('todays-meals-overlay');
      openRecipeDetail(card.dataset.id);
    });
  });

  // Async-load card images from IndexedDB (non-blocking)
  body.querySelectorAll('[data-img-id]').forEach(async imgEl => {
    const dataUrl = await resolveImage(imgEl.dataset.imgId);
    if (dataUrl) {
      imgEl.style.backgroundImage = `url('${dataUrl}')`;
      imgEl.textContent = '';
    }
  });
}

function toggleTodaysMealsDrawer() {
  const overlay = document.getElementById('todays-meals-overlay');
  if (!overlay) return;
  if (overlay.classList.contains('open')) {
    closeModal('todays-meals-overlay');
  } else {
    renderTodaysMealsDrawer();
    openModal('todays-meals-overlay');
  }
}


// ─── Random recipe suggestion ─────────────────────────────────────

function pickRandomRecipe(excludeIds = []) {
  const pool = Object.values(App.data.recipes || {})
    .filter(r => !excludeIds.includes(r.id));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function suggestRandomMealSlot(weekKey, dayIdx, slot) {
  // Exclude recipes already planned this week. "This week" means the Sun–Sat
  // window on screen, not the storage week — on a Sunday those differ, and
  // the point of the exclusion is to avoid repeats she can actually see.
  const usedIds = [];
  for (const c of plannerColumns(displayWeekKeyFor(slotDate(weekKey, dayIdx)))) {
    const day = App.data.mealplan?.[c.weekKey]?.[c.dayIdx];
    if (!day) continue;
    for (const v of Object.values(day)) usedIds.push(...slotRecipeIds(v));
  }

  const allRecipes = Object.values(App.data.recipes || {});

  // Prefer recipes whose mealType matches this slot
  const matching = allRecipes.filter(r =>
    !usedIds.includes(r.id) && r.mealType === slot
  );
  // Fall back to untyped recipes if no matches
  const untyped = allRecipes.filter(r =>
    !usedIds.includes(r.id) && !r.mealType
  );
  // Last resort — any recipe not already used
  const fallback = allRecipes.filter(r => !usedIds.includes(r.id));

  const pool = matching.length ? matching : untyped.length ? untyped : fallback;
  if (!pool.length) { showToast('No recipes available to suggest.'); return; }

  const recipe = pool[Math.floor(Math.random() * pool.length)];
  setMealSlot(weekKey, dayIdx, slot, recipe.id, { append: true });
  if (isMobilePlanner()) renderPlannerMobile();
  else renderPlanner();
  const source = matching.length ? '' : untyped.length ? ' (untyped)' : ' (any)';
  showToast(`🎲 Suggested: ${recipe.title}${source}`);
}

// Stamp the cook date for an entry. Eating leftovers isn't cooking, and a
// fend night isn't a recipe, so neither touches lastCooked.
function stampCooked(entry) {
  if (!entry || isLeftoverEntry(entry) || isFendEntry(entry)) return;
  const r = getRecipe(slotRecipeId(entry));
  if (r) { r.lastCooked = Date.now(); saveRecipe(r); }
}

// Write a slot. Passing null for `entry` clears the slot entirely (unchanged).
// Pass { append: true } to add alongside whatever is already there instead of
// replacing it.
function setMealSlot(weekKey, dayIdx, slot, entry, opts = {}) {
  if (!App.data.mealplan) App.data.mealplan = {};
  if (!App.data.mealplan[weekKey]) App.data.mealplan[weekKey] = {};
  if (!App.data.mealplan[weekKey][dayIdx]) App.data.mealplan[weekKey][dayIdx] = {};
  const day = App.data.mealplan[weekKey][dayIdx];

  if (entry) {
    const next = opts.append ? [...slotEntries(day[slot]), entry] : [entry];
    const packed = packSlot(next);
    if (packed === null) delete day[slot]; else day[slot] = packed;
    stampCooked(entry);
  } else {
    delete day[slot];
  }
  scheduleSave();
  renderTodaysMealsTrigger();
}

// Remove one entry from a slot by position, leaving any others in place.
function removeMealSlotEntry(weekKey, dayIdx, slot, idx) {
  const day = App.data.mealplan?.[weekKey]?.[dayIdx];
  if (!day) return;
  const entries = slotEntries(day[slot]);
  if (idx < 0 || idx >= entries.length) return;
  entries.splice(idx, 1);
  const packed = packSlot(entries);
  if (packed === null) delete day[slot]; else day[slot] = packed;
  scheduleSave();
  renderTodaysMealsTrigger();
}


// ─── Moving meals between slots ──────────────────────────────────
// Deliberately not built on setMealSlot: that stamps lastCooked, and dragging
// a meal from Tuesday to Wednesday is re-planning it, not cooking it. Same
// reasoning as leftovers entries and template loads.

function planDayRef(weekKey, dayIdx, create = false) {
  if (create) {
    if (!App.data.mealplan) App.data.mealplan = {};
    if (!App.data.mealplan[weekKey]) App.data.mealplan[weekKey] = {};
    if (!App.data.mealplan[weekKey][dayIdx]) App.data.mealplan[weekKey][dayIdx] = {};
  }
  return App.data.mealplan?.[weekKey]?.[dayIdx] || null;
}

// Write a slot from a list of entries, pruning the day and week when they
// empty out. Several render paths test a day for truthiness to decide whether
// anything is planned, so leaving `{}` behind would light up empty days.
function writePlanSlot(weekKey, dayIdx, slot, entries) {
  const day = planDayRef(weekKey, dayIdx, true);
  const packed = packSlot(entries);
  if (packed === null) delete day[slot]; else day[slot] = packed;
  if (!Object.keys(day).length) delete App.data.mealplan[weekKey][dayIdx];
  if (!Object.keys(App.data.mealplan[weekKey]).length) delete App.data.mealplan[weekKey];
}

// from / to are { weekKey, dayIdx, slot, idx }. `to.idx` is the position to
// insert at; null or undefined appends. Pass { copy: true } to duplicate
// rather than move.
function moveMealEntry(from, to, opts = {}) {
  const src = planDayRef(from.weekKey, from.dayIdx);
  if (!src) return false;
  const srcEntries = slotEntries(src[from.slot]);
  const entry = srcEntries[from.idx];
  if (!entry) return false;

  const sameSlot = from.weekKey === to.weekKey
                && String(from.dayIdx) === String(to.dayIdx)
                && from.slot === to.slot;

  if (sameSlot) {
    const list = srcEntries.slice();
    let at = to.idx == null ? list.length : to.idx;
    if (!opts.copy) {
      list.splice(from.idx, 1);
      // Removing the entry shifts everything after it down one, so an
      // insertion point past the old position has to come back by one too.
      if (at > from.idx) at--;
    }
    at = Math.max(0, Math.min(at, list.length));
    list.splice(at, 0, entry);
    writePlanSlot(from.weekKey, from.dayIdx, from.slot, list);
  } else {
    if (!opts.copy) {
      const list = srcEntries.slice();
      list.splice(from.idx, 1);
      writePlanSlot(from.weekKey, from.dayIdx, from.slot, list);
    }
    // Re-read the target after the source write: if source and target share a
    // day, that write may have pruned the day object out from under us.
    const dstDay = planDayRef(to.weekKey, to.dayIdx, true);
    const dstList = slotEntries(dstDay[to.slot]);
    const at = to.idx == null ? dstList.length : Math.max(0, Math.min(to.idx, dstList.length));
    dstList.splice(at, 0, entry);
    writePlanSlot(to.weekKey, to.dayIdx, to.slot, dstList);
  }

  scheduleSave();
  renderTodaysMealsTrigger();
  return true;
}

// Snapshot just the weeks a move touches, so an undo can put them back
// without holding a copy of the whole plan.
function snapshotWeeks(weekKeys) {
  const snap = {};
  for (const wk of new Set(weekKeys)) {
    const w = App.data.mealplan?.[wk];
    snap[wk] = w ? JSON.parse(JSON.stringify(w)) : null;
  }
  return snap;
}

function restoreWeeks(snap) {
  if (!App.data.mealplan) App.data.mealplan = {};
  for (const [wk, val] of Object.entries(snap)) {
    if (val === null) delete App.data.mealplan[wk];
    else App.data.mealplan[wk] = val;
  }
  scheduleSave();
  renderTodaysMealsTrigger();
}

// ─── Planner drag and drop ───────────────────────────────────────
// Built on Pointer Events rather than HTML5 drag-and-drop. HTML5 DnD never
// fires on touch, so going that route would mean a second, parallel input
// system the day this needs to work on a phone. Pointer Events cover both;
// for now touch is turned away at the door by the pointerType guard in
// onPlanPointerDown, which leaves scrolling on the mobile planner completely
// untouched. Enabling mobile later means relaxing that guard, adding a
// long-press delay so a drag doesn't fight the scroll, and registering the
// day-tab strip as a drop target — additive, with none of this rewritten.

const PLAN_DRAG_THRESHOLD = 4;    // px of movement before it counts as a drag
const PLAN_EDGE_SCROLL    = 48;   // px from the edge that starts autoscroll

const PlanDrag = {
  pending:      null,   // { el, cell, x, y, pointerId }
  active:       false,
  from:         null,
  ghost:        null,
  srcEl:        null,
  dropCell:     null,
  dropIdx:      null,
  copy:         false,
  suppressClick: false,
  scrollTimer:  null,
};

function planCoordsFrom(el) {
  if (!el) return null;
  const { wk, day, slot, idx } = el.dataset;
  if (wk == null || day == null || !slot) return null;
  return { weekKey: wk, dayIdx: Number(day), slot, idx: idx == null ? null : Number(idx) };
}

function attachPlanDrag(root) {
  if (!root || root._planDragBound) return;
  root._planDragBound = true;
  root.addEventListener('pointerdown', onPlanPointerDown);
}

function onPlanPointerDown(e) {
  // Desktop only for now. Touch and pen fall through untouched so the mobile
  // planner keeps scrolling normally.
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  if (e.target.closest('.plan-remove, .plan-add, .plan-dice, .plan-leftover')) return;

  const el = e.target.closest('.plan-recipe');
  if (!el) return;
  const from = planCoordsFrom(el);
  if (!from || from.idx == null) return;

  PlanDrag.pending = { el, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  PlanDrag.from    = from;
  PlanDrag.suppressClick = false;

  window.addEventListener('pointermove', onPlanPointerMove);
  window.addEventListener('pointerup', onPlanPointerUp);
  window.addEventListener('pointercancel', cancelPlanDrag);
  window.addEventListener('keydown', onPlanDragKey);
}

function onPlanPointerMove(e) {
  if (!PlanDrag.pending) return;
  PlanDrag.copy = e.altKey;

  if (!PlanDrag.active) {
    const dx = e.clientX - PlanDrag.pending.x;
    const dy = e.clientY - PlanDrag.pending.y;
    if (Math.hypot(dx, dy) < PLAN_DRAG_THRESHOLD) return;
    startPlanDrag();
  }

  e.preventDefault();
  positionPlanGhost(e.clientX, e.clientY);
  updatePlanDropTarget(e.clientX, e.clientY);
  edgeScrollPlanner(e.clientX);
}

function startPlanDrag() {
  const el = PlanDrag.pending.el;
  PlanDrag.active = true;
  PlanDrag.srcEl  = el;

  const rect  = el.getBoundingClientRect();
  const ghost = el.cloneNode(true);
  ghost.classList.add('plan-drag-ghost');
  ghost.classList.remove('plan-recipe-mobile');
  ghost.querySelector('.plan-remove')?.remove();
  ghost.style.width  = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost._offsetX = PlanDrag.pending.x - rect.left;
  ghost._offsetY = PlanDrag.pending.y - rect.top;
  document.body.appendChild(ghost);
  PlanDrag.ghost = ghost;

  el.classList.add('plan-drag-source');
  document.body.classList.add('plan-dragging');
}

function positionPlanGhost(x, y) {
  const g = PlanDrag.ghost;
  if (!g) return;
  g.style.left = `${x - g._offsetX}px`;
  g.style.top  = `${y - g._offsetY}px`;
  g.classList.toggle('plan-drag-ghost-copy', !!PlanDrag.copy);
}

// Work out which cell is under the cursor and where in its stack the entry
// would land. The ghost is pointer-events:none, so it never hit-tests itself.
function updatePlanDropTarget(x, y) {
  const under = document.elementFromPoint(x, y);
  const cell  = under?.closest?.('.plan-cell');

  if (cell !== PlanDrag.dropCell) {
    PlanDrag.dropCell?.classList.remove('plan-cell-drop');
    cell?.classList.add('plan-cell-drop');
    PlanDrag.dropCell = cell || null;
  }
  clearPlanDropLine();
  if (!cell) { PlanDrag.dropIdx = null; return; }

  const chips = [...cell.querySelectorAll('.plan-recipe')];
  let idx = chips.length;
  for (let i = 0; i < chips.length; i++) {
    const r = chips[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) { idx = i; break; }
  }
  PlanDrag.dropIdx = idx;

  const line = document.createElement('div');
  line.className = 'plan-drop-line';
  const stack = cell.querySelector('.plan-stack');
  if (!stack) { cell.prepend(line); return; }
  if (idx >= chips.length) stack.appendChild(line);
  else stack.insertBefore(line, chips[idx]);
}

function clearPlanDropLine() {
  document.querySelectorAll('.plan-drop-line').forEach(n => n.remove());
}

// Nudge the week grid sideways when dragging near its edge — the table
// scrolls horizontally on narrower desktop windows.
function edgeScrollPlanner(x) {
  const wrap = document.querySelector('.planner-table-wrap');
  clearInterval(PlanDrag.scrollTimer);
  if (!wrap || wrap.scrollWidth <= wrap.clientWidth) return;
  const r = wrap.getBoundingClientRect();
  let dir = 0;
  if (x < r.left + PLAN_EDGE_SCROLL)  dir = -1;
  if (x > r.right - PLAN_EDGE_SCROLL) dir = 1;
  if (!dir) return;
  PlanDrag.scrollTimer = setInterval(() => { wrap.scrollLeft += dir * 14; }, 16);
}

function onPlanDragKey(e) {
  if (e.key === 'Escape') cancelPlanDrag();
  if (PlanDrag.active && (e.key === 'Alt' || e.altKey !== PlanDrag.copy)) {
    PlanDrag.copy = e.altKey;
    PlanDrag.ghost?.classList.toggle('plan-drag-ghost-copy', !!PlanDrag.copy);
  }
}

function onPlanPointerUp() {
  if (!PlanDrag.active) { teardownPlanDrag(); return; }

  const cell = PlanDrag.dropCell;
  const to   = cell ? planCoordsFrom(cell) : null;
  const from = PlanDrag.from;
  const copy = PlanDrag.copy;
  const idx  = PlanDrag.dropIdx;

  // A click handler fires after pointerup on the source chip; without this it
  // would open the recipe every time she finishes a drag.
  PlanDrag.suppressClick = true;
  setTimeout(() => { PlanDrag.suppressClick = false; }, 0);

  teardownPlanDrag();
  if (!to || !from) { renderPlanner(); return; }

  // Dropping an entry back where it started is a no-op, not a move.
  const unchanged = from.weekKey === to.weekKey
                 && from.dayIdx === to.dayIdx
                 && from.slot === to.slot
                 && (idx === from.idx || idx === from.idx + 1);
  if (unchanged && !copy) { renderPlanner(); return; }

  const before = snapshotWeeks([from.weekKey, to.weekKey]);
  if (!moveMealEntry(from, { ...to, idx }, { copy })) { renderPlanner(); return; }
  renderPlanner();

  const label = copy ? 'Copied' : 'Moved';
  showUndoToast(`${label} to ${planDropLabel(to)}`, () => {
    restoreWeeks(before);
    renderPlanner();
  });
}

// "Wed dinner" — enough to confirm where it landed without reading the grid.
function planDropLabel(to) {
  const d = slotDate(to.weekKey, to.dayIdx);
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${to.slot}`;
}

function cancelPlanDrag() {
  const wasActive = PlanDrag.active;
  teardownPlanDrag();
  if (wasActive) renderPlanner();
}

function teardownPlanDrag() {
  clearInterval(PlanDrag.scrollTimer);
  clearPlanDropLine();
  PlanDrag.ghost?.remove();
  PlanDrag.srcEl?.classList.remove('plan-drag-source');
  PlanDrag.dropCell?.classList.remove('plan-cell-drop');
  document.body.classList.remove('plan-dragging');

  PlanDrag.pending = null;
  PlanDrag.active  = false;
  PlanDrag.from    = null;
  PlanDrag.ghost   = null;
  PlanDrag.srcEl   = null;
  PlanDrag.dropCell = null;
  PlanDrag.dropIdx = null;
  PlanDrag.copy    = false;

  window.removeEventListener('pointermove', onPlanPointerMove);
  window.removeEventListener('pointerup', onPlanPointerUp);
  window.removeEventListener('pointercancel', cancelPlanDrag);
  window.removeEventListener('keydown', onPlanDragKey);
}

// ─── Planner chip rendering ──────────────────────────────────────
// One chip per entry. `idx` is the entry's position in the slot so the remove
// button can take out just that one and leave the rest of the day intact.
// `ctx` is a plannerColumns() entry — it carries both the display column and
// the storage coordinates, so chips and buttons can be addressed without the
// handler having to re-derive which week a Sunday belongs to.
function planCoordAttrs(ctx, slot) {
  return `data-wk="${esc(ctx.weekKey)}" data-day="${ctx.dayIdx}" data-col="${ctx.col}" data-slot="${slot}"`;
}

function renderPlanChip(entry, idx, ctx, slot, mobile) {
  const cls  = mobile ? ' plan-recipe-mobile' : '';
  const coords = planCoordAttrs(ctx, slot);
  const rm   = `<button class="plan-remove" ${coords} data-idx="${idx}" title="Remove">✕</button>`;
  if (isFendEntry(entry)) {
    return `<div class="plan-recipe${cls} plan-recipe-fend" ${coords} data-idx="${idx}">
              <div class="plan-recipe-img plan-recipe-img-fend">${PLACEHOLDER_ART}</div>
              <span class="fend-badge">${FEND_LABEL}</span>
              ${rm}
            </div>`;
  }
  const rid = slotRecipeId(entry);
  const r   = rid ? getRecipe(rid) : null;
  if (!r) return '';
  const isLeft = isLeftoverEntry(entry);
  return `<div class="plan-recipe${cls}${isLeft ? ' plan-recipe-leftover' : ''}" data-id="${esc(rid)}" ${coords} data-idx="${idx}">
            <div class="plan-recipe-img" data-plan-img="${esc(rid)}"></div>
            <div class="plan-recipe-img-placeholder">${PLACEHOLDER_ART}</div>
            ${isLeft ? `<span class="leftovers-badge">${LEFTOVERS_LABEL}</span>` : ''}
            <div class="plan-recipe-title">${esc(r.title)}</div>
            ${rm}
          </div>`;
}

// The add / dice / leftovers controls. Shown full-size on an empty slot, and
// as a slim strip under existing chips so a second meal can be added to a day
// that already has one planned.
function renderPlanAddWrap(ctx, slot, mobile, compact) {
  const m = mobile ? '-mobile' : '';
  const c = compact ? ' plan-add-wrap-compact' : '';
  const d = planCoordAttrs(ctx, slot);
  if (compact) {
    return `<div class="plan-add-wrap${m ? ' plan-add-wrap-mobile' : ''}${c}">
              <button class="plan-add plan-add${m}" ${d} title="Add another">+</button>
              <button class="plan-dice plan-dice${m}" ${d} title="Random recipe">🎲</button>
              <button class="plan-leftover plan-leftover${m}" ${d} title="Leftovers">♻</button>
            </div>`;
  }
  return mobile
    ? `<div class="plan-add-wrap plan-add-wrap-mobile">
         <button class="plan-add plan-add-mobile" ${d}>+ Add Recipe</button>
         <button class="plan-dice plan-dice-mobile" ${d} title="Random recipe">🎲 Suggest</button>
         <button class="plan-leftover plan-leftover-mobile" ${d} title="Leftovers">♻ Leftovers</button>
       </div>`
    : `<div class="plan-add-wrap">
         <button class="plan-add" ${d} title="Add recipe">+</button>
         <button class="plan-dice" ${d} title="Random recipe">🎲</button>
         <button class="plan-leftover" ${d} title="Leftovers">♻</button>
       </div>`;
}

function renderPlanSlot(entries, ctx, slot, mobile) {
  if (!entries.length) return renderPlanAddWrap(ctx, slot, mobile, false);
  return `<div class="plan-stack${entries.length > 1 ? ' plan-stack-multi' : ''}">
            ${entries.map((e, i) => renderPlanChip(e, i, ctx, slot, mobile)).join('')}
          </div>
          ${renderPlanAddWrap(ctx, slot, mobile, true)}`;
}

// ─── Mobile planner (single-day view) ────────────────────────────

function isMobilePlanner() {
  return window.innerWidth <= 640;
}

function renderPlannerMobile() {
  const wk   = View.currentWeek;
  const cols = plannerColumns(wk);
  const di   = Math.max(0, Math.min(6, View.plannerDay | 0));

  // Day tabs
  const todayCol = todayColumnIn(wk);
  const tabsEl = document.getElementById('planner-day-tabs');
  if (tabsEl) {
    tabsEl.innerHTML = cols.map(c => {
      const day = App.data.mealplan?.[c.weekKey]?.[c.dayIdx];
      const hasRecipe = MEAL_SLOTS.some(slot => day?.[slot]);
      const isToday   = c.col === todayCol;
      return `<button class="planner-day-tab${c.col === di ? ' active' : ''}${isToday ? ' is-today' : ''}" data-di="${c.col}"${isToday ? ' title="Today"' : ''}>
        <span class="planner-day-tab-name">${c.name.slice(0,1)}</span>
        <span class="planner-day-tab-date">${c.date.getDate()}</span>
        ${hasRecipe ? '<span class="planner-day-tab-dot"></span>' : ''}
      </button>`;
    }).join('');
    tabsEl.querySelectorAll('.planner-day-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        View.plannerDay = parseInt(btn.dataset.di);
        renderPlannerMobile();
      });
    });
  }

  // Single day content
  const dayEl = document.getElementById('planner-mobile-day');
  if (!dayEl) return;

  const ctx  = cols[di];
  const plan = App.data.mealplan?.[ctx.weekKey]?.[ctx.dayIdx] || {};
  const dateLabel = ctx.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  dayEl.innerHTML = `
    <div class="planner-mobile-date-label">${dateLabel}${di === todayCol ? ' <span class="today-pill">Today</span>' : ''}</div>
    ${MEAL_SLOTS.map(slot => `
        <div class="planner-mobile-slot">
          <div class="planner-mobile-slot-label">${capitalise(slot)}</div>
          <div class="planner-mobile-slot-content">
            ${renderPlanSlot(slotEntries(plan[slot]), ctx, slot, true)}
          </div>
        </div>`).join('')}
  `;

  // Wire add buttons
  dayEl.querySelectorAll('.plan-add').forEach(btn => {
    btn.addEventListener('click', () => {
      openPickRecipeModal(btn.dataset.wk, parseInt(btn.dataset.day), btn.dataset.slot);
    });
  });

  // Wire remove buttons
  dayEl.querySelectorAll('.plan-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeMealSlotEntry(btn.dataset.wk, parseInt(btn.dataset.day), btn.dataset.slot, parseInt(btn.dataset.idx));
      renderPlannerMobile();
    });
  });

  // Wire leftovers buttons (mobile)
  dayEl.querySelectorAll('.plan-leftover').forEach(btn => {
    btn.addEventListener('click', () => {
      openPickRecipeModal(btn.dataset.wk, parseInt(btn.dataset.day), btn.dataset.slot, 'leftovers');
    });
  });

  // Wire dice buttons (mobile)
  dayEl.querySelectorAll('.plan-dice').forEach(btn => {
    btn.addEventListener('click', () => {
      suggestRandomMealSlot(btn.dataset.wk, parseInt(btn.dataset.day), btn.dataset.slot);
    });
  });

  // Wire recipe card clicks
  dayEl.querySelectorAll('.plan-recipe').forEach(el => {
    if (!el.dataset.id) return;
    el.addEventListener('click', () => openRecipeDetail(el.dataset.id));
  });

  // Async-load images
  dayEl.querySelectorAll('[data-plan-img]').forEach(async imgEl => {
    const dataUrl = await resolveImage(imgEl.dataset.planImg);
    if (dataUrl) {
      imgEl.style.backgroundImage = `url('${dataUrl}')`;
      imgEl.closest('.plan-recipe')?.querySelector('.plan-recipe-img-placeholder')?.remove();
    }
  });
}

function renderPlanner() {
  const wk   = View.currentWeek;
  const cols = plannerColumns(wk);

  document.getElementById('planner-week-label').textContent = formatWeekLabel(wk);

  // Mobile: single-day view
  const mobileDay  = document.getElementById('planner-mobile-day');
  const tableWrap  = document.querySelector('.planner-table-wrap');
  const dayTabs    = document.getElementById('planner-day-tabs');
  const isMobile   = isMobilePlanner();
  if (mobileDay)  mobileDay.style.display  = isMobile ? '' : 'none';
  if (tableWrap)  tableWrap.style.display  = isMobile ? 'none' : '';
  if (dayTabs)    dayTabs.style.display    = isMobile ? '' : 'none';
  if (isMobile) { renderPlannerMobile(); return; }

  const todayCol = todayColumnIn(wk);

  const table = document.getElementById('planner-table');
  table.innerHTML = `
    <thead>
      <tr>
        <th class="slot-col"></th>
        ${cols.map(c => `<th class="day-col${c.col === todayCol ? ' is-today' : ''}">
            <div class="day-name">${c.name}</div>
            <div class="day-date">${c.date.getMonth() + 1}/${c.date.getDate()}</div>
          </th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${MEAL_SLOTS.map(slot => `
        <tr>
          <td class="slot-label">${capitalise(slot)}</td>
          ${cols.map(c => {
            const day = App.data.mealplan?.[c.weekKey]?.[c.dayIdx];
            return `<td class="plan-cell${c.col === todayCol ? ' is-today' : ''}" ${planCoordAttrs(c, slot)}>
                ${renderPlanSlot(slotEntries(day?.[slot]), c, slot, false)}
              </td>`;
          }).join('')}
        </tr>
      `).join('')}
    </tbody>
  `;

  // Plan add buttons
  table.querySelectorAll('.plan-add').forEach(btn => {
    btn.addEventListener('click', () => {
      openPickRecipeModal(btn.dataset.wk, parseInt(btn.dataset.day), btn.dataset.slot);
    });
  });

  // Plan remove buttons
  table.querySelectorAll('.plan-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeMealSlotEntry(btn.dataset.wk, parseInt(btn.dataset.day), btn.dataset.slot, parseInt(btn.dataset.idx));
      renderPlanner();
    });
  });

  // Random suggestion buttons (desktop)
  table.querySelectorAll('.plan-dice').forEach(btn => {
    btn.addEventListener('click', () => {
      suggestRandomMealSlot(btn.dataset.wk, parseInt(btn.dataset.day), btn.dataset.slot);
    });
  });

  // Leftovers buttons (desktop)
  table.querySelectorAll('.plan-leftover').forEach(btn => {
    btn.addEventListener('click', () => {
      openPickRecipeModal(btn.dataset.wk, parseInt(btn.dataset.day), btn.dataset.slot, 'leftovers');
    });
  });

  // Click card to view recipe. A click that ends a drag isn't a click.
  table.querySelectorAll('.plan-recipe').forEach(el => {
    if (!el.dataset.id) return;
    el.addEventListener('click', () => {
      if (PlanDrag.suppressClick) return;
      openRecipeDetail(el.dataset.id);
    });
  });

  attachPlanDrag(table);

  // Async-load plan card images from IndexedDB
  table.querySelectorAll('[data-plan-img]').forEach(async imgEl => {
    const dataUrl = await resolveImage(imgEl.dataset.planImg);
    if (dataUrl) {
      imgEl.style.backgroundImage = `url('${dataUrl}')`;
      imgEl.closest('.plan-recipe')?.querySelector('.plan-recipe-img-placeholder')?.remove();
    }
  });
}

function formatWeekLabel(weekKey) {
  const start = displayWeekStart(weekKey);
  const end   = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}, ${start.getFullYear()}`;
}

// Label for a span of consecutive weeks. formatWeekLabel only ever describes
// a single week, so a 4-week template save would show the first week's dates
// and quietly misstate what it was about to capture.
function formatWeekRangeLabel(startWeek, weeks) {
  const start = displayWeekStart(startWeek);
  const end   = displayWeekStart(addWeeks(startWeek, Math.max(1, weeks) - 1));
  end.setDate(end.getDate() + 6);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // Only repeat the year when the span crosses one
  return start.getFullYear() === end.getFullYear()
    ? `${fmt(start)} – ${fmt(end)}, ${start.getFullYear()}`
    : `${fmt(start)}, ${start.getFullYear()} – ${fmt(end)}, ${end.getFullYear()}`;
}

function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Pick recipe modal (for planner) ─────────────────────────────

let _pickTarget = null;

// Recipes planned in the last `days` days, most recent first. Used to fill
// the leftovers picker — what you actually cooked recently is almost always
// what's in the fridge.
// What could plausibly be in the fridge when a given slot comes around.
//
// The anchor is the slot being filled, not today. Planning a month ahead and
// marking a Thursday-in-September dinner as leftovers should offer what was
// cooked the week before *that* Thursday — anchoring on the current date made
// the list useless for anything but this week.
//
// `beforeSlot` handles the same-day case: a turkey cooked for Monday lunch is
// fair game for Monday dinner, but not the other way round. MEAL_SLOTS is in
// chronological order, so position in that array is the ordering.
//
// Snacks are the exception. They sort last in MEAL_SLOTS but aren't actually
// an end-of-day meal — a batch of something made as a snack can be eaten at
// any point that day, so it stays available for every other slot on the same
// date. Only the slot being filled is ever excluded from itself.
function getRecentlyPlanned(days = 7, anchor = null) {
  const seen = new Map();
  const from = anchor?.date instanceof Date ? new Date(anchor.date) : new Date();
  const beforeSlot = anchor?.slot ? MEAL_SLOTS.indexOf(anchor.slot) : -1;

  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setDate(from.getDate() - i);
    const dayPlan = getWeekPlan(getISOWeekKey(d))[(d.getDay() + 6) % 7] || {};

    for (let si = 0; si < MEAL_SLOTS.length; si++) {
      const slot = MEAL_SLOTS[si];
      if (i === 0 && beforeSlot >= 0) {
        // Never offer the slot being filled as a source for itself.
        if (si === beforeSlot) continue;
        // Otherwise on the anchor day only earlier slots count — except the
        // anytime ones, which are available whenever they were planned.
        if (si > beforeSlot && !ANYTIME_SLOTS.includes(slot)) continue;
      }
      for (const entry of slotEntries(dayPlan[slot])) {
        // A leftovers entry is food already being re-eaten, not a fresh cook,
        // so it isn't itself a source of further leftovers.
        if (isLeftoverEntry(entry) || isFendEntry(entry)) continue;
        const id = slotRecipeId(entry);
        const rec = id ? getRecipe(id) : null;
        if (!rec || isLeftoversPlaceholder(rec)) continue;
        // Rank by day, then by slot within the day, so the most recent cook
        // sorts first even when several land on the same date.
        const ts = d.getTime() + si;
        if (!seen.has(id) || seen.get(id) < ts) seen.set(id, ts);
      }
    }
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => getRecipe(id));
}

// Which planner column is today, or -1 when today isn't in this window.
// Display space: 0 = Sunday. Compared on local calendar date rather than
// timestamps so a meal planned at 11pm and one at 1am don't land on
// different days.
function todayColumnIn(weekKey) {
  const now = new Date();
  if (displayWeekKeyFor(now) !== weekKey) return -1;
  return now.getDay();
}

// A placeholder recipe standing in for "we ate leftovers" rather than a dish
// in its own right — Mealie users often create one because Mealie has no
// first-class leftovers concept. Refectory does, via leftovers: entries, so
// offering this record in the leftovers picker would mark leftovers as
// leftovers of leftovers. Matched on title alone, deliberately narrowly: a
// real recipe called "Leftover Turkey Soup" must not be caught by this.
function isLeftoversPlaceholder(recipe) {
  return /^\s*left\s?-?overs?\s*$/i.test(recipe?.title || '');
}

// The calendar date a planner slot refers to.
function slotDate(weekKey, dayIdx) {
  const d = weekStartDate(weekKey);
  d.setDate(d.getDate() + Number(dayIdx));
  return d;
}

// Every recipe that could sensibly be marked as leftovers. Only the picker in
// leftovers mode uses this — the placeholder is still a valid ordinary meal,
// so it stays selectable everywhere else.
function leftoverCandidates() {
  return getRecipes().filter(r => !isLeftoversPlaceholder(r));
}

function openPickRecipeModal(weekKey, dayIdx, slot, mode) {
  _pickTarget = { weekKey, dayIdx, slot, mode: mode || 'recipe' };
  const isLeftovers = _pickTarget.mode === 'leftovers';

  document.getElementById('pick-recipe-title').textContent =
    isLeftovers ? 'Add Leftovers' : 'Choose a Recipe';

  const hint = document.getElementById('pick-recipe-hint');
  hint.style.display = isLeftovers ? '' : 'none';

  // The inline toggle is the shortcut from the normal picker; redundant when
  // you already came in through the leftovers button.
  const toggle = document.getElementById('pick-leftovers-toggle');
  const asLeft = document.getElementById('pick-as-leftovers');
  if (asLeft) asLeft.checked = false;
  if (toggle) toggle.style.display = isLeftovers ? 'none' : 'flex';

  const showAll = document.getElementById('pick-show-all');
  showAll.style.display = 'none';

  // "No planned meal" skips recipe selection entirely
  const fendBtn = document.getElementById('pick-fend');
  fendBtn.style.display = isLeftovers ? '' : 'none';
  fendBtn.onclick = () => {
    if (_pickTarget) {
      setMealSlot(_pickTarget.weekKey, _pickTarget.dayIdx, _pickTarget.slot, FEND_ENTRY);
      if (isMobilePlanner()) renderPlannerMobile(); else renderPlanner();
    }
    closeModal('modal-pick-recipe');
  };

  if (isLeftovers) {
    const target = slotDate(weekKey, dayIdx);
    const recent = getRecentlyPlanned(7, { date: target, slot });
    const dayLabel = target.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    if (recent.length) {
      hint.textContent = `Cooked in the week before ${dayLabel}:`;
      renderPickGrid(recent);
      showAll.style.display = '';
      showAll.textContent = 'Other — show all recipes';
      showAll.onclick = () => {
        hint.textContent = 'All recipes:';
        showAll.style.display = 'none';
        renderPickGrid(leftoverCandidates());
        filterPickRecipes(document.getElementById('pick-recipe-search').value);
      };
    } else {
      hint.textContent = `Nothing cooked in the week before ${dayLabel} — pick any recipe:`;
      renderPickGrid(leftoverCandidates());
    }
    document.getElementById('pick-recipe-search').value = '';
    filterPickRecipes('');
    openModal('modal-pick-recipe');
    return;
  }

  const recipes   = getRecipes();
  const grid      = document.getElementById('pick-recipe-grid');
  const emptyMsg  = document.getElementById('pick-recipe-empty');

  if (!recipes.length) {
    grid.innerHTML = '';
    emptyMsg.style.display = '';
  } else {
    emptyMsg.style.display = 'none';
    renderPickGrid(recipes);
  }

  document.getElementById('pick-recipe-search').value = '';
  filterPickRecipes('');
  openModal('modal-pick-recipe');
}

function renderPickGrid(recipes) {
  const grid = document.getElementById('pick-recipe-grid');
  grid.innerHTML = recipes.map(r => `
    <div class="pick-recipe-item" data-id="${esc(r.id)}">
      <div class="pick-img" data-pick-img="${esc(r.id)}">${PLACEHOLDER_ART}</div>
      <div class="pick-title">${esc(r.title)}</div>
    </div>
  `).join('');

  grid.querySelectorAll('[data-pick-img]').forEach(async imgEl => {
    const dataUrl = await resolveImage(imgEl.dataset.pickImg);
    if (dataUrl) {
      imgEl.style.backgroundImage = `url('${dataUrl}')`;
      imgEl.textContent = '';
    }
  });

  grid.querySelectorAll('.pick-recipe-item').forEach(item => {
    item.addEventListener('click', () => {
      if (_pickTarget) {
        const asLeftovers = _pickTarget.mode === 'leftovers'
          || document.getElementById('pick-as-leftovers')?.checked;
        const entry = asLeftovers ? makeLeftoverEntry(item.dataset.id) : item.dataset.id;
        setMealSlot(_pickTarget.weekKey, _pickTarget.dayIdx, _pickTarget.slot, entry, { append: true });
        if (isMobilePlanner()) renderPlannerMobile(); else renderPlanner();
      }
      closeModal('modal-pick-recipe');
    });
  });
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

// ─── Shopping stores (custom lists) ────────────────────────────────

function getShoppingStores() {
  return Object.values(App.data.shoppingStores || {})
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function getShoppingStore(id) {
  return App.data.shoppingStores?.[id] || null;
}

function createShoppingStore(name) {
  const id = genId();
  App.data.shoppingStores = App.data.shoppingStores || {};
  App.data.shoppingStores[id] = { id, name, createdAt: Date.now() };
  scheduleSave();
  return id;
}

function deleteShoppingStore(id) {
  if (!App.data.shoppingStores?.[id]) return;
  delete App.data.shoppingStores[id];
  // Any items assigned to this store fall back to Unassigned (default list)
  for (const key of Object.keys(App.data.itemStoreAssignments || {})) {
    if (App.data.itemStoreAssignments[key] === id) delete App.data.itemStoreAssignments[key];
  }
  if (View.activeShoppingTab === id) View.activeShoppingTab = 'default';
  scheduleSave();
}

function getItemStore(itemKey) {
  return App.data.itemStoreAssignments?.[itemKey] || '';
}

function setItemStore(itemKey, storeId) {
  App.data.itemStoreAssignments = App.data.itemStoreAssignments || {};
  if (storeId) App.data.itemStoreAssignments[itemKey] = storeId;
  else delete App.data.itemStoreAssignments[itemKey];
  scheduleSave();
}

// Renders the tab bar above the shopping list. Hidden entirely when no
// custom stores exist yet — Default-only mode looks exactly like before.
function renderShoppingTabs() {
  const wrap = document.getElementById('shopping-tabs');
  if (!wrap) return;

  const stores = getShoppingStores();

  if (!stores.length) {
    // No custom lists yet — show a small standalone entry point instead of a full tab row
    wrap.style.display = '';
    wrap.innerHTML = `<button class="shopping-new-list-link" id="shopping-new-list-btn">+ New List</button>`;
    document.getElementById('shopping-new-list-btn')?.addEventListener('click', openNewShoppingListPrompt);
    return;
  }

  wrap.style.display = '';
  wrap.innerHTML = `
    <div class="detail-tabs shopping-tabs-row">
      <button class="detail-tab${View.activeShoppingTab === 'default' ? ' active' : ''}" data-tab="default">Default</button>
      ${stores.map(s => `<button class="detail-tab${View.activeShoppingTab === s.id ? ' active' : ''}" data-tab="${esc(s.id)}">${esc(s.name)}</button>`).join('')}
      <button class="detail-tab shopping-new-list-tab" id="shopping-new-list-btn" title="Create a new list">+ New List</button>
    </div>
  `;

  wrap.querySelectorAll('.detail-tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      View.activeShoppingTab = btn.dataset.tab;
      renderShoppingList();
    });
  });

  document.getElementById('shopping-new-list-btn')?.addEventListener('click', openNewShoppingListPrompt);
}

function openNewShoppingListPrompt() {
  const name = prompt('Name this list (e.g. Kroger, Costco, Publix):');
  const trimmed = name?.trim();
  if (!trimmed) return;
  const id = createShoppingStore(trimmed);
  View.activeShoppingTab = id;
  renderShoppingList();
}

function wireShoppingAddInput() {
  const addInput = document.getElementById('shopping-add-input');
  const addBtn   = document.getElementById('shopping-add-btn');
  function addManualItem() {
    const name = addInput?.value.trim();
    if (!name) return;
    View.manualItems.push({ id: genId(), name, checked: false });
    if (addInput) addInput.value = '';
    renderShoppingList();
    document.getElementById('shopping-add-input')?.focus();
  }
  addBtn?.addEventListener('click', addManualItem);
  addInput?.addEventListener('keydown', e => { if (e.key === 'Enter') addManualItem(); });
}


// ─── Smart ingredient merging for shopping list ────────────────────

const UNICODE_FRACTIONS = {
  '¼': 0.25, '½': 0.5, '¾': 0.75,
  '⅓': 1/3, '⅔': 2/3,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1/6, '⅚': 5/6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

const UNIT_ALIASES = {
  cup:   ['cup', 'cups', 'c'],
  tbsp:  ['tbsp', 'tbsps', 'tablespoon', 'tablespoons', 'tb', 'tbs'],
  tsp:   ['tsp', 'tsps', 'teaspoon', 'teaspoons'],
  oz:    ['oz', 'ozs', 'ounce', 'ounces'],
  lb:    ['lb', 'lbs', 'pound', 'pounds', 'lb.'],
  g:     ['g', 'gram', 'grams'],
  kg:    ['kg', 'kilogram', 'kilograms'],
  ml:    ['ml', 'milliliter', 'milliliters'],
  l:     ['l', 'liter', 'liters'],
  pinch: ['pinch', 'pinches'],
  clove: ['clove', 'cloves'],
  can:   ['can', 'cans'],
  slice: ['slice', 'slices'],
};

const UNIT_LOOKUP = (() => {
  const lookup = {};
  for (const [canon, variants] of Object.entries(UNIT_ALIASES)) {
    for (const v of variants) lookup[v.toLowerCase()] = canon;
  }
  return lookup;
})();

function parseQuantityFromString(str) {
  str = str.trim();
  // Convert "1½" style mixed unicode fractions, then standalone unicode fractions
  for (const [frac, val] of Object.entries(UNICODE_FRACTIONS)) {
    str = str.replace(new RegExp(`(\\d+)\\s*${frac}`, 'g'), (m, whole) => String(parseInt(whole) + val));
    str = str.replace(new RegExp(frac, 'g'), String(val));
  }
  const m = str.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+\.\d+|\d+)/);
  if (!m) return null;
  const numStr = m[1];
  let value;
  if (numStr.includes('/')) {
    const parts = numStr.split(/\s+/);
    if (parts.length === 2) {
      const [num, den] = parts[1].split('/').map(Number);
      value = parseInt(parts[0]) + num / den;
    } else {
      const [num, den] = numStr.split('/').map(Number);
      value = num / den;
    }
  } else {
    value = parseFloat(numStr);
  }
  return { value, rest: str.slice(m[0].length).trim() };
}

// Parse a free-text ingredient line into { quantity, unit, name }
function parseIngredientForMerge(line) {
  if (typeof line !== 'string') return { quantity: null, unit: null, name: String(line || '') };
  const qty = parseQuantityFromString(line);
  if (!qty) return { quantity: null, unit: null, name: line.trim() };

  const restWords = qty.rest.split(/\s+/);
  const firstWord = (restWords[0] || '').toLowerCase().replace(/[.,]/g, '');
  const unit = UNIT_LOOKUP[firstWord] || null;

  if (unit) {
    return { quantity: qty.value, unit, name: restWords.slice(1).join(' ').trim() };
  }
  return { quantity: qty.value, unit: null, name: qty.rest };
}

// Strip prep descriptors so "garlic, minced" groups with "garlic"
function normalizeIngredientName(name) {
  return name
    .toLowerCase()
    .replace(/,.*$/, '')
    .replace(/\b(finely|roughly|coarsely|thinly|freshly)\b/g, '')
    .replace(/\b(diced|minced|chopped|sliced|crushed|grated|peeled|halved|quartered|melted|softened|divided)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decimalToFraction(val) {
  const whole = Math.floor(val);
  const frac  = val - whole;
  const map = [
    [0.125, '⅛'], [0.25, '¼'], [1/3, '⅓'], [0.375, '⅜'],
    [0.5, '½'], [0.625, '⅝'], [2/3, '⅔'], [0.75, '¾'], [0.875, '⅞'],
  ];
  if (frac < 0.02) return String(whole || 0);
  let closest = map[0], minDiff = Math.abs(frac - closest[0]);
  for (const f of map) {
    const diff = Math.abs(frac - f[0]);
    if (diff < minDiff) { minDiff = diff; closest = f; }
  }
  if (minDiff > 0.015) return val.toFixed(2).replace(/\.?0+$/, '').replace(/^0\./, '.');
  return whole ? `${whole}${closest[1]}` : closest[1];
}

// Merge a flat list of { text, from } ingredient entries into consolidated lines.
// Returns [{ key, displayName, summary, sources: [recipeTitle, ...] }]
function mergeShoppingIngredients(entries) {
  const groups = {}; // "unit::normalizedName" → group

  for (const { text, from } of entries) {
    const parsed = parseIngredientForMerge(text);
    const groupName = normalizeIngredientName(parsed.name) || parsed.name.toLowerCase().trim();
    if (!groupName) continue;
    const key = `${parsed.unit || 'none'}::${groupName}`;

    if (!groups[key]) {
      groups[key] = {
        key, unit: parsed.unit, displayName: parsed.name,
        totalQty: 0, hasQty: false, sources: new Set(),
      };
    }
    if (parsed.quantity != null) { groups[key].totalQty += parsed.quantity; groups[key].hasQty = true; }
    if (from) groups[key].sources.add(from);
  }

  return Object.values(groups).map(g => {
    const sources = [...g.sources];
    let summary;
    if (g.hasQty) {
      const qtyStr = Number.isInteger(g.totalQty) ? String(g.totalQty) : decimalToFraction(g.totalQty);
      summary = g.unit ? `${qtyStr} ${g.unit}` : qtyStr;
    } else {
      summary = '';
    }
    return {
      key: g.key,
      name: g.displayName,
      summary,
      sources,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Builds and triggers the print-friendly shopping list view.
// Only unchecked items are printed — checked items are already handled,
// no need to clutter a paper list with things you already have.
// ─── Shopping list printing ─────────────────────────────────────────

function openShoppingPrintModal() {
  openModal('modal-shopping-print');
}

function openShoppingPrintPicker() {
  closeModal('modal-shopping-print');
  const stores = getShoppingStores();
  const listEl = document.getElementById('shopping-print-pick-list');

  listEl.innerHTML = `
    <label class="bulk-cookbook-row" style="cursor:pointer;">
      <input type="checkbox" class="print-pick-cb" value="default" checked style="margin-right:.5rem;"/>
      <span class="bulk-cookbook-name">Default list</span>
    </label>
    ${stores.map(s => `
      <label class="bulk-cookbook-row" style="cursor:pointer;">
        <input type="checkbox" class="print-pick-cb" value="${esc(s.id)}" style="margin-right:.5rem;"/>
        <span class="bulk-cookbook-name">${esc(s.name)}</span>
      </label>`).join('')}
  `;

  openModal('modal-shopping-print-pick');
}

// Gathers the full set of recipe-derived + manual items for the shopping
// horizon (current + next week), independent of whatever tab is on screen.
// This lets print modes pull "all lists" data even if you're viewing one
// specific store tab when you open the print modal.
function gatherAllShoppingItems() {
  const recipeIds = plannedRecipeIds(shoppingHorizonWeeks());

  const rawEntries = [];
  for (const rid of recipeIds) {
    const r = getRecipe(rid);
    if (!r) continue;
    for (const rawIng of (r.ingredients || [])) {
      const text = typeof rawIng === 'string' ? rawIng : ingredientText(rawIng);
      if (text?.trim()) rawEntries.push({ text: text.trim(), from: r.title });
    }
  }

  const merged = mergeShoppingIngredients(rawEntries);
  const recipeItems = merged.map(m => ({
    key: m.key,
    name: m.name,
    detail: m.summary,
    checked: View.checkedItems.has(m.key),
  }));

  const manualItemsNorm = View.manualItems.map(i => ({
    key: i.id,
    name: i.name,
    detail: '',
    checked: i.checked,
  }));

  return { recipeItems, manualItems: manualItemsNorm, weekLabel: formatWeekLabel(weeks[0]) };
}

// Builds one print page (a .print-shopping-card) for a given list of items.
// `pillLabelFn`, if provided, renders a small static pill per item (used
// only on the Default page to show each item's assigned store / Unassigned).
function buildShoppingPrintPage(title, subtitle, items, pillLabelFn = null) {
  const unchecked = items.filter(i => !i.checked).sort((a, b) => a.name.localeCompare(b.name));

  const renderItem = (item) => `
    <li class="print-shopping-item">
      <span class="print-shopping-box"></span>
      <span class="print-shopping-name">${esc(item.name)}</span>
      ${item.detail ? `<span class="print-shopping-detail">${esc(item.detail)}</span>` : ''}
      ${pillLabelFn ? `<span class="print-shopping-pill">${esc(pillLabelFn(item))}</span>` : ''}
    </li>`;

  let columnsHtml;
  if (!unchecked.length) {
    columnsHtml = `<ul class="print-shopping-list"><li class="print-shopping-empty">Nothing here — list is empty or all checked off!</li></ul>`;
  } else if (unchecked.length <= 4) {
    // Too few items to meaningfully split — one column reads cleaner
    columnsHtml = `<ul class="print-shopping-list">${unchecked.map(renderItem).join('')}</ul>`;
  } else {
    // Split into two explicit columns (left fills first) so the dividing
    // border between them always has real content on both sides to span.
    const mid   = Math.ceil(unchecked.length / 2);
    const left  = unchecked.slice(0, mid);
    const right = unchecked.slice(mid);
    columnsHtml = `
      <div class="print-shopping-columns">
        <ul class="print-shopping-list">${left.map(renderItem).join('')}</ul>
        ${right.length ? `<ul class="print-shopping-list print-shopping-col-right">${right.map(renderItem).join('')}</ul>` : ''}
      </div>`;
  }

  return `
    <div class="print-shopping-card">
      <div class="print-shopping-header">
        <h1 class="print-shopping-title">${esc(title)}</h1>
        <div class="print-shopping-subtitle">${esc(subtitle)}</div>
      </div>
      ${columnsHtml}
      <div class="print-footer"><span class="print-logo">🌿 Refectory</span></div>
    </div>`;
}

// Renders the requested set of pages into #shopping-print-area and triggers
// the browser print dialog. `listIds` is an array where 'default' means the
// Default list and anything else is a shoppingStores id.
function printShoppingLists(listIds) {
  const area = document.getElementById('shopping-print-area');
  if (!area) return;

  const { recipeItems, manualItems, weekLabel } = gatherAllShoppingItems();
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const stores = getShoppingStores();

  const pages = [];

  for (const listId of listIds) {
    if (listId === 'default') {
      const allItems = [...recipeItems, ...manualItems];
      const pillFor = (item) => {
        const storeId = getItemStore(item.key);
        const store = storeId ? getShoppingStore(storeId) : null;
        return store ? store.name : 'Unassigned';
      };
      pages.push(buildShoppingPrintPage('Shopping List', `${date} · Based on meals for ${weekLabel}`, allItems, pillFor));
    } else {
      const store = getShoppingStore(listId);
      if (!store) continue;
      const storeItems = [...recipeItems, ...manualItems].filter(item => getItemStore(item.key) === store.id);
      pages.push(buildShoppingPrintPage(store.name, date, storeItems, null));
    }
  }

  if (!pages.length) { showToast('Nothing to print.'); return; }

  area.innerHTML = pages.join('');
  document.body.classList.add('printing-shopping');
  window.print();
  document.body.classList.remove('printing-shopping');
}



function renderShoppingList() {
  const container = document.getElementById('shopping-list-content');
  if (!container) return;

  renderShoppingTabs();

  // Collect all recipes in current + next week plan
  const recipeIds = plannedRecipeIds(shoppingHorizonWeeks());

  const isDefaultTab = View.activeShoppingTab === 'default';
  const activeStore  = isDefaultTab ? null : getShoppingStore(View.activeShoppingTab);

  // If the active custom-list tab was deleted out from under us, fall back
  if (!isDefaultTab && !activeStore) {
    View.activeShoppingTab = 'default';
    return renderShoppingList();
  }

  if (!recipeIds.size && !View.manualItems.length) {
    // Show add row + placeholder — no plan recipes and no manual items yet
    container.innerHTML = `
      <div class="shopping-add-row">
        <input class="input" id="shopping-add-input" placeholder="Add an item…" autocomplete="off"/>
        <button class="btn btn-outline btn-sm" id="shopping-add-btn">Add</button>
      </div>
      <p class="muted" style="margin-top:.75rem;">Add recipes to your meal plan to generate a shopping list automatically. You can also add items manually above.</p>
    `;
    wireShoppingAddInput();
    return;
  }

  // Collect raw ingredient lines with their source recipe
  const rawEntries = [];
  for (const rid of recipeIds) {
    const r = getRecipe(rid);
    if (!r) continue;
    for (const rawIng of (r.ingredients || [])) {
      const text = typeof rawIng === 'string' ? rawIng : ingredientText(rawIng);
      if (text?.trim()) rawEntries.push({ text: text.trim(), from: r.title });
    }
  }

  // Smart-merge: combines matching quantities/units, groups by ingredient name
  const merged = mergeShoppingIngredients(rawEntries);
  const agg = {};
  merged.forEach(m => {
    agg[m.key] = {
      name: m.name,
      key: m.key,
      entries: [{ amount: m.summary, unit: '', from: m.sources.join(', ') }],
    };
  });

  // All recipe-derived items, regardless of store assignment
  const allRecipeItems = Object.values(agg);

  // Filter by active tab: Default shows everything; a store tab shows only
  // items assigned to that store.
  const visibleRecipeItems = isDefaultTab
    ? allRecipeItems
    : allRecipeItems.filter(item => getItemStore(item.key) === activeStore.id);

  const visibleManualItems = isDefaultTab
    ? View.manualItems
    : View.manualItems.filter(item => getItemStore(item.id) === activeStore.id);

  // Unchecked items first (alphabetical), checked items at bottom (alphabetical)
  const unchecked = visibleRecipeItems.filter(i => !View.checkedItems.has(i.key)).sort((a, b) => a.name.localeCompare(b.name));
  const checked   = visibleRecipeItems.filter(i =>  View.checkedItems.has(i.key)).sort((a, b) => a.name.localeCompare(b.name));
  const checkedCount = checked.length;

  // Manual items — split into checked/unchecked
  const manualUnchecked = visibleManualItems.filter(i => !i.checked);
  const manualChecked   = visibleManualItems.filter(i =>  i.checked);
  const totalChecked    = checkedCount + manualChecked.length;

  const stores = getShoppingStores();

  // Builds the pill-styled <select> for assigning an item to a store.
  // Shown on every tab so an item can be reassigned from anywhere.
  function storeSelectHtml(itemKey) {
    const current = getItemStore(itemKey);
    const isAssigned = !!current;
    const options = [
      `<option value="">Unassigned</option>`,
      ...stores.map(s => `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>${esc(s.name)}</option>`),
    ].join('');
    return `<select class="store-pill-select${isAssigned ? ' is-assigned' : ''}" data-item-key="${esc(itemKey)}">${options}</select>`;
  }

  container.innerHTML = `
    <div class="shopping-header">
      <p class="muted shopping-note">
        ${isDefaultTab
          ? `Based on meals planned for ${formatWeekLabel(weeks[0])} and the following week.`
          : `Items assigned to <strong>${esc(activeStore.name)}</strong>.`}
      </p>
      <div style="display:flex;gap:.5rem;align-items:center;">
        ${totalChecked ? `<button class="btn btn-ghost btn-sm" id="shopping-clear-checked">Clear checked (${totalChecked})</button>` : ''}
        ${!isDefaultTab ? `<button class="btn btn-ghost btn-sm" id="shopping-delete-list-btn" style="color:var(--red);">Delete List</button>` : ''}
        <button class="btn btn-ghost btn-sm" id="shopping-print-btn">Print / Save PDF</button>
      </div>
    </div>

    ${stores.length ? `<p class="shopping-hint">Tap the list pill to assign an item to a store.</p>` : ''}

    <!-- Add item input -->
    <div class="shopping-add-row">
      <input class="input" id="shopping-add-input" placeholder="Add an item…" autocomplete="off"/>
      <button class="btn btn-outline btn-sm" id="shopping-add-btn">Add</button>
    </div>

    <ul class="shopping-list">
      <!-- Manual unchecked items first -->
      ${manualUnchecked.map(item => `
        <li class="shopping-item shopping-item-manual" data-manual-id="${esc(item.id)}">
          <label class="shopping-check">
            <input type="checkbox" class="shopping-cb-manual"/>
            <span class="shopping-ing">
              <span class="shopping-name">${esc(item.name)}</span>
              <span class="shopping-detail muted">Added manually</span>
            </span>
          </label>
          ${storeSelectHtml(item.id)}
          <button class="shopping-remove-manual" data-manual-id="${esc(item.id)}" title="Remove">✕</button>
        </li>`).join('')}

      <!-- Recipe items: unchecked -->
      ${unchecked.map(item => {
        const e = item.entries[0] || {};
        const sourceList = e.from || '';
        const sourceLabel = sourceList.split(', ').length > 2
          ? `${sourceList.split(', ').slice(0, 2).join(', ')} +${sourceList.split(', ').length - 2} more`
          : sourceList;
        const summary = [e.amount, sourceLabel ? `(${sourceLabel})` : ''].filter(Boolean).join(' ');
        return `
          <li class="shopping-item" data-key="${esc(item.key)}">
            <label class="shopping-check">
              <input type="checkbox" class="shopping-cb"/>
              <span class="shopping-ing">
                <span class="shopping-name">${esc(item.name)}</span>
                <span class="shopping-detail muted">${esc(summary)}</span>
              </span>
            </label>
            ${storeSelectHtml(item.key)}
          </li>`;
      }).join('')}

      <!-- Divider if anything is checked -->
      ${totalChecked ? '<li class="shopping-divider"></li>' : ''}

      <!-- Recipe items: checked -->
      ${checked.map(item => {
        const e = item.entries[0] || {};
        const sourceList = e.from || '';
        const sourceLabel = sourceList.split(', ').length > 2
          ? `${sourceList.split(', ').slice(0, 2).join(', ')} +${sourceList.split(', ').length - 2} more`
          : sourceList;
        const summary = [e.amount, sourceLabel ? `(${sourceLabel})` : ''].filter(Boolean).join(' ');
        return `
          <li class="shopping-item is-checked" data-key="${esc(item.key)}">
            <label class="shopping-check">
              <input type="checkbox" class="shopping-cb" checked/>
              <span class="shopping-ing">
                <span class="shopping-name">${esc(item.name)}</span>
                <span class="shopping-detail muted">${esc(summary)}</span>
              </span>
            </label>
            ${storeSelectHtml(item.key)}
          </li>`;
      }).join('')}

      <!-- Manual checked items last -->
      ${manualChecked.map(item => `
        <li class="shopping-item shopping-item-manual is-checked" data-manual-id="${esc(item.id)}">
          <label class="shopping-check">
            <input type="checkbox" class="shopping-cb-manual" checked/>
            <span class="shopping-ing">
              <span class="shopping-name">${esc(item.name)}</span>
              <span class="shopping-detail muted">Added manually</span>
            </span>
          </label>
          ${storeSelectHtml(item.id)}
          <button class="shopping-remove-manual" data-manual-id="${esc(item.id)}" title="Remove">✕</button>
        </li>`).join('')}
    </ul>
  `;

  // Add item
  wireShoppingAddInput();

  // Recipe item checkboxes
  container.querySelectorAll('.shopping-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.closest('.shopping-item').dataset.key;
      if (cb.checked) View.checkedItems.add(key);
      else            View.checkedItems.delete(key);
      renderShoppingList();
    });
  });

  // Manual item checkboxes
  container.querySelectorAll('.shopping-cb-manual').forEach(cb => {
    cb.addEventListener('change', () => {
      const id   = cb.closest('.shopping-item-manual').dataset.manualId;
      const item = View.manualItems.find(i => i.id === id);
      if (item) { item.checked = cb.checked; renderShoppingList(); }
    });
  });

  // Manual item remove buttons
  container.querySelectorAll('.shopping-remove-manual').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.manualId;
      View.manualItems = View.manualItems.filter(i => i.id !== id);
      setItemStore(id, ''); // clean up any assignment for the removed item
      renderShoppingList();
    });
  });

  // Store pill-selects — assign/reassign an item to a list
  container.querySelectorAll('.store-pill-select').forEach(sel => {
    sel.addEventListener('change', () => {
      setItemStore(sel.dataset.itemKey, sel.value);
      renderShoppingList();
    });
  });

  // Clear all checked (scoped to what's visible on the current tab)
  document.getElementById('shopping-clear-checked')?.addEventListener('click', () => {
    checked.forEach(i => View.checkedItems.delete(i.key));
    View.manualItems = View.manualItems.filter(i => !(visibleManualItems.includes(i) && i.checked));
    renderShoppingList();
  });

  // Delete this custom list
  document.getElementById('shopping-delete-list-btn')?.addEventListener('click', async () => {
    if (!activeStore) return;
    if (!await appConfirm({
      title: `Delete "${activeStore.name}"?`,
      message: 'Items on it become unassigned on the Default list. This cannot be undone.',
      confirmLabel: 'Delete', danger: true,
    })) return;
    deleteShoppingStore(activeStore.id);
    renderShoppingList();
  });

  document.getElementById('shopping-print-btn')?.addEventListener('click', () => openShoppingPrintModal());
}




// ─── URL Recipe Scraper ───────────────────────────────────────────

function openNewRecipeChoice() {
  openModal('modal-new-recipe-choice');
}

function openUrlImport() {
  closeModal('modal-new-recipe-choice');
  document.getElementById('url-import-input').value = '';
  document.getElementById('url-import-status').textContent = '';
  document.getElementById('url-import-status').style.color = '';
  openModal('modal-url-import');
  setTimeout(() => document.getElementById('url-import-input')?.focus(), 100);
}

async function fetchAndScrapeUrl() {
  const input    = document.getElementById('url-import-input');
  const statusEl = document.getElementById('url-import-status');
  const btn      = document.getElementById('url-import-fetch-btn');
  const url      = input?.value.trim();

  if (!url) { input?.focus(); return; }

  // Basic URL check
  try { new URL(url); } catch {
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = 'Please enter a valid URL.';
    return;
  }

  const base = getWorkerUrl().replace(/\/+$/, '');
  if (!base) {
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = 'No worker URL configured — go to Settings first.';
    return;
  }

  btn.disabled = true;
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'Fetching recipe…';

  try {
    const res  = await fetch(`${base}/scrape?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (isBotBlocked(res, data)) throw new Error(BLOCKED_HINT);
    if (!res.ok || !data.html) throw new Error(data.error || 'Could not fetch that page.');

    statusEl.textContent = 'Parsing recipe data…';
    const found = parseRecipesFromHtml(data.html, data.finalUrl || url);

    if (!found.length) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'No recipe found on that page. Try a different URL or create manually.';
      btn.disabled = false;
      return;
    }

    closeModal('modal-url-import');
    if (found.length > 1) openRecipeVariantPicker(found);
    else                  openScrapedRecipe(found[0]);

  } catch(e) {
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = e.message || 'Something went wrong fetching that page.';
  } finally {
    btn.disabled = false;
  }
}

function openPasteRecipeModal() {
  const ta = document.getElementById('paste-recipe-text');
  if (ta) ta.value = '';
  updatePasteHint();
  openModal('modal-paste-recipe');
  setTimeout(() => ta?.focus(), 50);
}

// Live read-out of what the parser found, so a paste that didn't split
// properly is obvious before it reaches the editor.
function updatePasteHint() {
  const hint = document.getElementById('paste-recipe-hint');
  const text = document.getElementById('paste-recipe-text')?.value || '';
  if (!hint) return;
  if (!text.trim()) { hint.textContent = ''; return; }

  const r = parseRecipeText(text);
  const bits = [];
  if (r.title) bits.push(`“${r.title}”`);
  bits.push(`${r.ingredients.length} ingredient${r.ingredients.length === 1 ? '' : 's'}`);
  bits.push(`${r.steps.length} step${r.steps.length === 1 ? '' : 's'}`);

  const bad = !r.ingredients.length || !r.steps.length;
  hint.textContent = bad
    ? `Found ${bits.join(' · ')} — check there are “Ingredients” and “Directions” headings.`
    : `Found ${bits.join(' · ')}.`;
  hint.style.color = bad ? 'var(--saffron)' : 'var(--muted)';
}

function submitPastedRecipe() {
  const text = document.getElementById('paste-recipe-text')?.value || '';
  if (!text.trim()) { showToast('Paste some recipe text first.'); return; }
  const r = parseRecipeText(text);
  if (!r.title && !r.ingredients.length) {
    showToast('Couldn’t find a recipe in that text.');
    return;
  }
  closeModal('modal-paste-recipe');
  openScrapedRecipe(r);
}

// ── Plain-text recipe parser ─────────────────────────────────────
// For recipes that arrive as text — a screenshot transcription, a message
// from a friend, something copied out of a PDF. Looks for section headings
// and splits on them; everything else is a best guess, so results always land
// in the editor for review rather than being saved directly.

const TXT_ING_RE  = /^\s*ingredients?\s*:?\s*$/i;
const TXT_STEP_RE = /^\s*(directions?|instructions?|method|steps?|preparation)\s*:?\s*$/i;
const TXT_NOTE_RE = /^\s*(notes?|tips?)\s*:?\s*$/i;

// Strip list decoration: bullets, dashes, checkboxes, "1." / "1)" numbering.
function stripListMarker(line) {
  return line
    .replace(/^\s*[-–—•*·▢□☐]\s+/, '')
    .replace(/^\s*\d{1,3}\s*[.)]\s+/, '')
    .replace(/^\s*\[[ x]\]\s*/i, '')
    .trim();
}

function parseRecipeText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const title = [];
  const ing = [], steps = [], notes = [];
  let section = 'head';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (TXT_ING_RE.test(line))  { section = 'ing';  continue; }
    if (TXT_STEP_RE.test(line)) { section = 'step'; continue; }
    if (TXT_NOTE_RE.test(line)) { section = 'note'; continue; }

    const clean = stripListMarker(line);
    if (!clean) continue;

    if (section === 'head')      title.push(clean);
    else if (section === 'ing')  ing.push(clean);
    else if (section === 'step') steps.push(clean);
    else                         notes.push(clean);
  }

  // Trailing lines after the steps that read like metadata rather than an
  // instruction — "Total cook time: 5–6 hours" — belong in the time fields,
  // not as a final step nobody performs.
  const meta = {};
  const metaFrom = arr => {
    while (arr.length) {
      const last = arr[arr.length - 1];
      const t = last.match(/^total\s*(cook|prep)?\s*time\s*:?\s*(.+)$/i);
      const c = last.match(/^cook(ing)?\s*time\s*:?\s*(.+)$/i);
      const pp = last.match(/^prep(aration)?\s*time\s*:?\s*(.+)$/i);
      const sv = last.match(/^(?:serv(?:es|ings?)|yield|makes)\s*:?\s*(\d+)/i);
      if (t)       { meta.totalTime = t[2].trim(); arr.pop(); continue; }
      if (c)       { meta.cookTime  = c[2].trim(); arr.pop(); continue; }
      if (pp)      { meta.prepTime  = pp[2].trim(); arr.pop(); continue; }
      if (sv)      { meta.servings  = parseInt(sv[1]); arr.pop(); continue; }
      break;
    }
  };
  metaFrom(steps);
  metaFrom(ing);

  // Same scan over the header block, where "Serves 6" often sits under the title
  for (let i = title.length - 1; i >= 1; i--) {
    const sv = title[i].match(/^(?:serv(?:es|ings?)|yield|makes)\s*:?\s*(\d+)/i);
    const tt = title[i].match(/^total\s*(cook)?\s*time\s*:?\s*(.+)$/i);
    if (sv) { meta.servings = meta.servings || parseInt(sv[1]); title.splice(i, 1); }
    else if (tt) { meta.totalTime = meta.totalTime || tt[2].trim(); title.splice(i, 1); }
  }

  return {
    title: title.shift() || '',
    // Anything else above the ingredients is prose about the dish
    description: [...title, ...notes].join('\n\n'),
    servings:  meta.servings || '',
    prepTime:  meta.prepTime || '',
    cookTime:  meta.cookTime || '',
    totalTime: meta.totalTime || '',
    ingredients: ing,
    steps,
    tags: [],
    source: '', sourceUrl: '', image: '',
    importedFrom: 'text',
    heuristic: true,
  };
}

// ── HTML parser — JSON-LD first, Open Graph fallback ─────────────

// Hand a scraped recipe to the editor. A heuristic parse is a guess, so the
// user gets told rather than being left to discover mangled ingredients later.
function openScrapedRecipe(recipe) {
  if (recipe.image) {
    ImageStore.set('_scrape_preview', recipe.image);
    recipe._scrapeImageUrl = recipe.image;
  }
  openRecipeEditor(null, recipe);
  if (recipe.heuristic) {
    showToast('⚠ This page had no recipe data — ingredients and steps were guessed from the page. Please check them.');
  }
}

function openRecipeVariantPicker(list) {
  const wrap = document.getElementById('variant-list');
  const hint = document.getElementById('variant-hint');
  if (!wrap) { openScrapedRecipe(list[0]); return; }

  if (hint) {
    hint.textContent = list.some(r => r.heuristic)
      ? `This page has no recipe data, so ${list.length} possible recipes were read from the page itself. Pick one — check it carefully after importing.`
      : `This page contains ${list.length} recipes. Pick the one you want.`;
  }

  wrap.innerHTML = list.map((r, i) => `
    <button class="variant-option" data-idx="${i}">
      <div class="variant-title">${esc(r.title)}</div>
      <div class="variant-meta">
        ${r.ingredients.length} ingredient${r.ingredients.length === 1 ? '' : 's'}
        · ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}
        ${r.servings ? ` · serves ${esc(String(r.servings))}` : ''}
      </div>
      ${r.ingredients.length ? `<div class="variant-preview">${esc(r.ingredients.slice(0, 3).join(', '))}${r.ingredients.length > 3 ? '…' : ''}</div>` : ''}
    </button>`).join('');

  wrap.querySelectorAll('.variant-option').forEach(btn => {
    btn.addEventListener('click', () => {
      closeModal('modal-recipe-variant');
      openScrapedRecipe(list[parseInt(btn.dataset.idx)]);
    });
  });

  // Review-all: load every version into the editor as tabs. Nothing is written
  // until each tab is saved, so this is a shortcut through the picker, not a
  // bypass of review — which matters most for heuristic parses, where the
  // ingredients are a guess about which list on the page was the right one.
  const allBtn = document.getElementById('variant-import-all');
  if (allBtn) {
    allBtn.textContent = `Review all ${list.length} in the editor`;
    allBtn.onclick = () => {
      closeModal('modal-recipe-variant');
      // Titles fall back to the page title when a version has no heading of
      // its own, so several can arrive identical — number those, or they're
      // indistinguishable both in the tab strip and afterwards in the grid.
      const counts = {};
      list.forEach(r => { const k = (r.title || '').toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
      const seen = {};
      const prepared = list.map(r => {
        const k = (r.title || '').toLowerCase();
        if (counts[k] > 1) {
          seen[k] = (seen[k] || 0) + 1;
          return { ...r, title: `${r.title} (${seen[k]})` };
        }
        return r;
      });
      openEditorQueue(prepared);
    };
  }

  openModal('modal-recipe-variant');
}

// Returns every recipe found on the page, best source first. A page can
// legitimately carry several — a blog post comparing three variations of the
// same drink, say — so the caller decides which one the user wanted rather
// than this silently picking the first.
function parseRecipesFromHtml(html, sourceUrl) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(html, 'text/html');
  const found  = [];

  // 1. JSON-LD structured data — authoritative when present
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const raw = JSON.parse(script.textContent);
      const candidates = [];
      if (Array.isArray(raw)) candidates.push(...raw);
      else if (raw['@graph']) candidates.push(...raw['@graph']);
      else candidates.push(raw);

      for (const obj of candidates) {
        const type  = obj['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.some(t => String(t).toLowerCase().includes('recipe'))) {
          const recipe = extractFromJsonLd(obj, sourceUrl);
          if (recipe?.title) found.push(recipe);
        }
      }
    } catch { /* malformed JSON-LD — skip */ }
  }
  if (found.length) return dedupeRecipes(found);

  // 2. Heuristic scrape of the page body. Only reached when the page carries
  // no Recipe schema at all — a blog post with the ingredients in a plain
  // <ul>. This is guesswork by nature, so results are flagged `heuristic`
  // and the editor warns the user to check them.
  const guessed = extractFromHtmlHeuristic(doc, sourceUrl);
  if (guessed.length) return dedupeRecipes(guessed);

  // 3. Open Graph / meta — title, description and image only
  const meta = extractFromMeta(doc, sourceUrl);
  return meta ? [meta] : [];
}

// Kept for callers that only ever want one (image re-pull, for instance)
function parseRecipeFromHtml(html, sourceUrl) {
  return parseRecipesFromHtml(html, sourceUrl)[0] || null;
}

function dedupeRecipes(list) {
  const seen = new Set();
  return list.filter(r => {
    const key = (r.title || '').toLowerCase().trim() + '|' + (r.ingredients || []).length;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Heuristic body scrape ────────────────────────────────────────
const ING_RE   = /^\s*ingredients?\b/i;
const STEP_RE  = /^\s*(instructions?|directions?|method|steps?|how to make|preparation)\b/i;
const HEAD_SEL = 'h1,h2,h3,h4,h5,h6,strong,b,p,div,span,dt';

function extractFromHtmlHeuristic(doc, sourceUrl) {
  const body = doc.body;
  if (!body) return [];

  // Everything in document order, so "the next list after this label" is a
  // real question we can answer without guessing at DOM nesting.
  const all = Array.from(body.querySelectorAll(HEAD_SEL + ',ul,ol'));

  // A label is a short element whose own text (not its children's) matches.
  const labelText = (el) => {
    const t = (el.textContent || '').trim();
    return t.length && t.length <= 60 ? t : '';
  };

  const marks = [];
  all.forEach((el, i) => {
    const t = labelText(el);
    if (!t) return;
    const kind = ING_RE.test(t) ? 'ing' : STEP_RE.test(t) ? 'step' : null;
    if (!kind) return;
    // A label like <p><strong>Ingredients:</strong></p> matches twice, once
    // for the paragraph and once for its child. Left as two marks, the second
    // looks like the start of another recipe and collapses the window used to
    // find this one's steps — so collapse a wrapper and its child into a
    // single mark, keeping the innermost since it sits closest to the list.
    const prev = marks[marks.length - 1];
    if (prev && prev.kind === kind && prev.el.contains(el)) { marks[marks.length - 1] = { i, kind, el }; return; }
    marks.push({ i, kind, el });
  });
  if (!marks.length) return [];

  // First usable list after position `from`, never scanning past `stopAt`.
  // The hard bound is what keeps one recipe's steps from being satisfied by
  // the next recipe's ingredient list: a recipe with a single instruction
  // would otherwise fail the minimum-items check and the scan would run on
  // into the following section and silently steal its list.
  const listAfter = (from, stopAt, minItems) => {
    const limit = Math.min(stopAt == null ? all.length : stopAt, all.length);
    for (let j = from + 1; j < limit; j++) {
      const el = all[j];
      if (el.tagName !== 'UL' && el.tagName !== 'OL') continue;
      const items = Array.from(el.querySelectorAll(':scope > li'));
      if (items.length < minItems) continue;
      // A list that's mostly bare links is navigation, not a recipe
      const linky = items.filter(li => li.querySelector('a') &&
        (li.textContent || '').trim() === (li.querySelector('a')?.textContent || '').trim());
      if (linky.length > items.length / 2) continue;
      return { el, items: items.map(li => (li.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean) };
    }
    return null;
  };

  // Nearest heading above position i gives the recipe its name
  const titleBefore = (i) => {
    for (let j = i - 1; j >= 0 && j > i - 30; j--) {
      const el = all[j];
      if (!/^H[1-4]$/.test(el.tagName)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 120 && !ING_RE.test(t) && !STEP_RE.test(t)) return t;
    }
    return '';
  };

  const pageTitle = (doc.querySelector('meta[property="og:title"]')?.content
                  || doc.title || '').trim();
  const metaImg = pickSecureImage(
    doc.querySelector('meta[property="og:image:secure_url"]')?.content,
    doc.querySelector('meta[property="og:image"]')?.content);

  const out = [];
  for (let m = 0; m < marks.length; m++) {
    if (marks[m].kind !== 'ing') continue;

    // Ingredients must appear before the next label of any kind — usually
    // this recipe's own "Instructions" heading. Two items minimum, since a
    // one-line list is far more often page furniture than a recipe.
    const nextMark = marks[m + 1];
    const ing = listAfter(marks[m].i, nextMark ? nextMark.i : null, 2);
    if (!ing) continue;

    // Steps come from the first instruction label after this ingredient
    // block, and only if it appears before the next recipe's ingredients —
    // otherwise we'd staple recipe 1's steps onto recipe 2.
    const nextIng  = marks.slice(m + 1).find(x => x.kind === 'ing');
    const stepMark = marks.slice(m + 1).find(x =>
      x.kind === 'step' && (!nextIng || x.i < nextIng.i));
    // One step is a legitimate recipe; the bound above stops a short list
    // from reaching into the next section.
    const steps = stepMark
      ? listAfter(stepMark.i, nextIng ? nextIng.i : null, 1)
      : null;

    const title = titleBefore(marks[m].i) || pageTitle;
    if (!title) continue;

    // Servings, if the page states it near the heading
    let servings = '';
    for (let j = Math.max(0, marks[m].i - 6); j < marks[m].i; j++) {
      const t = (all[j].textContent || '').trim();
      const hit = t.length < 40 && t.match(/servings?\s*[:\-]?\s*(\d+)/i);
      if (hit) { servings = hit[1]; break; }
    }

    out.push({
      title,
      description: '',
      servings,
      prepTime: '', cookTime: '', totalTime: '',
      ingredients: ing.items,
      steps: steps ? steps.items : [],
      tags: [],
      source: new URL(sourceUrl).hostname,
      sourceUrl,
      image: metaImg,
      importedFrom: 'url',
      heuristic: true,
    });
  }
  return out;
}

function extractFromJsonLd(obj, sourceUrl) {
  // Ingredients
  const rawIngredients = obj.recipeIngredient || obj.ingredients || [];
  const ingredients = rawIngredients.map(i => typeof i === 'string' ? i : String(i)).filter(Boolean);

  // Instructions — can be string, array of strings, or array of HowToStep
  const rawInstructions = obj.recipeInstructions || obj.instructions || [];
  const steps = [];
  const processInstructions = (items) => {
    if (typeof items === 'string') {
      // Sometimes a big block of text — split on newlines
      items.split(/\n+/).map(s => s.trim()).filter(Boolean).forEach(s => steps.push(s));
      return;
    }
    for (const item of (Array.isArray(items) ? items : [items])) {
      if (typeof item === 'string') { if (item.trim()) steps.push(item.trim()); }
      else if (item['@type'] === 'HowToSection') {
        processInstructions(item.itemListElement || item.steps || []);
      } else {
        const text = item.text || item.name || '';
        if (text.trim()) steps.push(text.trim());
      }
    }
  };
  processInstructions(rawInstructions);

  // Tags — from keywords and recipeCategory
  const tags = [];
  const addTags = (val) => {
    if (!val) return;
    const str = Array.isArray(val) ? val.join(',') : String(val);
    str.split(/[,;]+/).map(t => t.trim()).filter(Boolean).forEach(t => tags.push(t));
  };
  addTags(obj.keywords);
  addTags(obj.recipeCategory);
  addTags(obj.recipeCuisine);

  // Times — ISO 8601 duration → human readable
  const parseDuration = (iso) => {
    if (!iso) return '';
    const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
    if (!m) return iso;
    const h = parseInt(m[1] || 0), min = parseInt(m[2] || 0);
    if (h && min) return `${h} hr ${min} min`;
    if (h) return `${h} hour${h !== 1 ? 's' : ''}`;
    if (min) return `${min} minute${min !== 1 ? 's' : ''}`;
    return '';
  };

  // Image — may be string, array, or ImageObject
  let image = obj.image;
  if (Array.isArray(image)) image = image[0];
  if (image && typeof image === 'object') image = image.url || image.contentUrl || '';

  return {
    title:       obj.name || '',
    description: obj.description || '',
    servings:    obj.recipeYield ? String(Array.isArray(obj.recipeYield) ? obj.recipeYield[0] : obj.recipeYield) : '',
    prepTime:    parseDuration(obj.prepTime),
    cookTime:    parseDuration(obj.cookTime || obj.performTime),
    totalTime:   parseDuration(obj.totalTime),
    ingredients,
    steps,
    tags:        [...new Set(tags)],
    source:      new URL(sourceUrl).hostname,
    sourceUrl,
    image:       pickSecureImage(typeof image === 'string' ? image : ''),
    importedFrom: 'url',
  };
}

// Pages often advertise the same image twice: og:image over plain http and
// og:image:secure_url over https. Taking og:image first stores a URL the
// browser then has to upgrade itself, which logs a mixed-content warning and
// fails outright on hosts that don't redirect. Prefer the secure form, and
// upgrade a bare http:// link on the way in — the browser is going to request
// https regardless, so storing http only hides what's actually happening.
function pickSecureImage(...candidates) {
  const url = candidates.find(Boolean) || '';
  return url.startsWith('http://') ? 'https://' + url.slice(7) : url;
}

function extractFromMeta(doc, sourceUrl) {
  const meta = (name) =>
    doc.querySelector(`meta[property="${name}"]`)?.content ||
    doc.querySelector(`meta[name="${name}"]`)?.content || '';

  const title = meta('og:title') || doc.title || '';
  if (!title) return null;

  return {
    title:       title.trim(),
    description: meta('og:description') || meta('description') || '',
    servings:    '',
    prepTime:    '',
    cookTime:    '',
    totalTime:   '',
    ingredients: [],
    steps:       [],
    tags:        [],
    source:      new URL(sourceUrl).hostname,
    sourceUrl,
    image:       pickSecureImage(meta('og:image:secure_url'), meta('og:image')),
    importedFrom: 'url',
  };
}

// Refuse to import while the store may still be loading. Signed in, an
// existing session, and no completed pull means the recipes this import would
// match against might simply not be here yet — and importing anyway produces a
// second full copy of the library that only surfaces later as duplicates.
function importGuardBlocked() {
  if (App.bootPullDone) return null;
  if (Auth.isGuest())   return null;
  return 'Still loading your recipes from sync — wait a moment and try again, ' +
         'or the import may create a second copy of everything.';
}

// ─── Recipe groups ───────────────────────────────────────────────

function getGroups() {
  return Object.values(App.data.groups || {})
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
function getGroup(id) { return App.data.groups?.[id] || null; }

// recipeId -> group. Derived rather than stored on the recipe, so membership
// has exactly one source of truth and can't drift out of sync.
function groupIndex() {
  const idx = {};
  for (const g of Object.values(App.data.groups || {})) {
    for (const m of (g.members || [])) idx[m.id] = g;
  }
  return idx;
}
function groupForRecipe(id) { return groupIndex()[id] || null; }

// Longest run of words shared by every title, used as the group name.
// "Traditional Swedish Egg Coffee Recipe" / "Must-Have Swedish Egg Coffee" /
// "Indonesian Version of Swedish Egg Coffee" -> "Swedish Egg Coffee".
function commonTitlePhrase(titles) {
  if (titles.length < 2) return '';
  const words = t => String(t || '').split(/\s+/).filter(Boolean);
  const first = words(titles[0]);
  let best = '';
  for (let i = 0; i < first.length; i++) {
    for (let j = first.length; j > i; j--) {
      const phrase = first.slice(i, j).join(' ');
      if (phrase.length <= best.length) continue;
      const re = new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i');
      if (titles.every(t => re.test(t))) best = phrase;
    }
  }
  // A single shared word is only a subject if it's a real noun. Length is the
  // wrong test — it rejects "Chili" while accepting "Recipe" — so filter on
  // the filler words that titles happen to share instead.
  const FILLER = new Set(['recipe','recipes','the','a','an','and','or','with','of','for',
                          'best','easy','quick','simple','homemade','classic','perfect',
                          'my','our','style','version','made','make','how','to','in','on']);
  const parts = best.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return best;
  return parts.length === 1 && !FILLER.has(parts[0].toLowerCase()) && parts[0].length >= 4
    ? best : '';
}

// What's left of a title once the shared phrase is removed — the bit that
// actually distinguishes this variant, which is what a tab should say.
function deriveVariantLabel(title, phrase) {
  let t = String(title || '');
  if (phrase) {
    const re = new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i');
    t = t.replace(re, ' ');
  }
  t = t.replace(/\brecipes?\b/gi, ' ')
       .replace(/\bversion\s+of\b/gi, ' ')
       .replace(/[\s\-–—:,]+$/, '')
       .replace(/^[\s\-–—:,]+/, '')
       .replace(/\s{2,}/g, ' ')
       .trim();
  return t || String(title || '').slice(0, 24);
}

function suggestGroupFromRecipes(recipes) {
  const titles = recipes.map(r => r.title || '');
  const phrase = commonTitlePhrase(titles);
  return {
    name: phrase || titles[0] || 'Group',
    members: recipes.map(r => ({ id: r.id, label: deriveVariantLabel(r.title, phrase) })),
  };
}

function saveGroup({ id, name, members }) {
  if (!App.data.groups) App.data.groups = {};
  const now = Date.now();
  const gid = id || genId();
  const existing = App.data.groups[gid];
  App.data.groups[gid] = {
    id: gid,
    name: (name || '').trim() || 'Group',
    members: members.filter(m => m.id && getRecipe(m.id)),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  // A group of one isn't a group
  if (App.data.groups[gid].members.length < 2) delete App.data.groups[gid];
  scheduleSave();
  return App.data.groups[gid] || null;
}

function deleteGroup(id) {
  if (!App.data.groups?.[id]) return;
  // Ungroup only — the recipes themselves are untouched.
  delete App.data.groups[id];
  scheduleSave();
}

// Drop a recipe from whatever group holds it, cleaning up if too few remain.
function removeFromGroup(recipeId) {
  const g = groupForRecipe(recipeId);
  if (!g) return;
  g.members = g.members.filter(m => m.id !== recipeId);
  g.updatedAt = Date.now();
  if (g.members.length < 2) delete App.data.groups[g.id];
  scheduleSave();
}

// ─── Group editor ────────────────────────────────────────────────
let _groupDraft = null;

function openGroupEditor(groupId, recipeIds) {
  const existing = groupId ? getGroup(groupId) : null;
  if (existing) {
    _groupDraft = { id: existing.id, name: existing.name,
                    members: existing.members.filter(m => getRecipe(m.id)).map(m => ({ ...m })) };
  } else {
    const recipes = (recipeIds || []).map(getRecipe).filter(Boolean);
    if (recipes.length < 2) { showToast('Pick at least two recipes to group.'); return; }
    _groupDraft = { id: null, ...suggestGroupFromRecipes(recipes) };
  }

  document.getElementById('group-editor-title').textContent = existing ? 'Edit Group' : 'Group Recipes';
  document.getElementById('group-name').value = _groupDraft.name;
  document.getElementById('group-delete').style.display = existing ? '' : 'none';
  renderGroupMembers();
  openModal('modal-group-editor');
}

function renderGroupMembers() {
  const wrap = document.getElementById('group-members');
  if (!wrap || !_groupDraft) return;
  wrap.innerHTML = _groupDraft.members.map((m, i) => {
    const r = getRecipe(m.id);
    return `
      <div class="group-member-row">
        <input class="input group-member-label" data-idx="${i}" value="${esc(m.label)}"
               placeholder="Tab label"/>
        <span class="group-member-title" title="${esc(r?.title || '')}">${esc(r?.title || '(missing)')}</span>
        <button class="btn btn-icon group-member-remove" data-idx="${i}" title="Remove from group">✕</button>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.group-member-label').forEach(inp =>
    inp.addEventListener('input', () => { _groupDraft.members[+inp.dataset.idx].label = inp.value; }));
  wrap.querySelectorAll('.group-member-remove').forEach(btn =>
    btn.addEventListener('click', () => {
      _groupDraft.members.splice(+btn.dataset.idx, 1);
      renderGroupMembers();
    }));
}

function saveGroupFromEditor() {
  if (!_groupDraft) return;
  _groupDraft.name = document.getElementById('group-name')?.value || _groupDraft.name;
  if (_groupDraft.members.length < 2) {
    showToast('A group needs at least two recipes — remove it instead to ungroup.');
    return;
  }
  const g = saveGroup(_groupDraft);
  _groupDraft = null;
  closeModal('modal-group-editor');
  View.selectMode = false;
  View.selectedRecipeIds.clear();
  renderRecipes();
  showToast(g ? `Grouped as “${g.name}” ✓` : 'Group removed');
}

// ─── In-app confirmation dialog ──────────────────────────────────
// Replaces window.confirm, which renders in the browser's own chrome — wrong
// typeface, wrong colours, and prefixed with the bare origin, which looks like
// a phishing prompt rather than part of the app. It also can't show anything
// selectable, so a dialog that needs to hand back an account token has nowhere
// to put it.
let _confirmResolve = null;

function appConfirm({ title = 'Are you sure?', message = '', confirmLabel = 'Continue',
                      cancelLabel = 'Cancel', danger = false, copyValue = '' } = {}) {
  const t   = document.getElementById('confirm-title');
  const m   = document.getElementById('confirm-message');
  const ok  = document.getElementById('confirm-ok');
  const no  = document.getElementById('confirm-cancel');
  const cw  = document.getElementById('confirm-copy-wrap');
  const cv  = document.getElementById('confirm-copy-value');
  if (!t || !m || !ok) return Promise.resolve(window.confirm(message));  // fallback

  t.textContent = title;
  // Paragraph per blank-line-separated block, so multi-part messages read as
  // prose rather than one run-on wall.
  m.innerHTML = String(message).split(/\n\s*\n/)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`).join('');

  ok.textContent = confirmLabel;
  no.textContent = cancelLabel;
  ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');

  if (cw) {
    cw.style.display = copyValue ? '' : 'none';
    if (copyValue && cv) cv.value = copyValue;
  }

  openModal('modal-confirm');
  setTimeout(() => ok.focus(), 50);

  return new Promise(resolve => { _confirmResolve = resolve; });
}

function _settleConfirm(result) {
  closeModal('modal-confirm');
  const r = _confirmResolve;
  _confirmResolve = null;
  if (r) r(result);
}

// ─── Duplicate recipe cleanup ────────────────────────────────────
// Importing the same source library twice creates two records per recipe:
// identity is a random genId(), so nothing links a Mealie recipe imported on
// one device to the same recipe imported on another. Matching on title is the
// only signal available after the fact.
//
// Merging is not just deletion — meal plans, cookbooks and templates all hold
// recipe ids, so every reference to a dropped copy has to be repointed at the
// survivor first or the planner fills with blanks.

// Score a record by how much would be lost if it were the one discarded.
function recipeCompleteness(r) {
  return (r.imageUrl ? 8 : 0)
       + (r.lastCooked ? 4 : 0)
       + (r.favorite ? 2 : 0)
       + (r.rating ? 2 : 0)
       + (r.nutrition ? 1 : 0)
       + Math.min(4, (r.ingredients || []).length ? 2 : 0)
       + Math.min(4, (r.steps || []).length ? 2 : 0)
       + ((r.description || '').length ? 1 : 0);
}

// Group by normalised title and pick a survivor per group.
function findDuplicateRecipes() {
  const groups = {};
  for (const r of Object.values(App.data.recipes || {})) {
    const key = (r.title || '').trim().toLowerCase();
    if (!key) continue;
    (groups[key] = groups[key] || []).push(r);
  }

  const dupes = [];
  for (const [key, list] of Object.entries(groups)) {
    if (list.length < 2) continue;
    const ranked = [...list].sort((a, b) =>
      recipeCompleteness(b) - recipeCompleteness(a) ||
      // Tie-break on the older creation date: after the importer began using
      // Mealie's own created_at, the older record is the one carrying the real
      // history rather than the timestamp of a re-import.
      (a.createdAt || 0) - (b.createdAt || 0));
    dupes.push({ key, keep: ranked[0], drop: ranked.slice(1) });
  }
  return dupes;
}

// Repoint every reference from `fromId` to `toId` across the whole store.
function remapRecipeReferences(map) {
  let planRefs = 0, bookRefs = 0, tplRefs = 0;
  const swap = entry => {
    if (typeof entry !== 'string') return entry;
    if (entry === FEND_ENTRY) return entry;
    const leftover = entry.startsWith(LEFTOVERS_PREFIX);
    const id  = leftover ? entry.slice(LEFTOVERS_PREFIX.length) : entry;
    const to  = map[id];
    if (!to) return entry;
    planRefs++;
    return leftover ? LEFTOVERS_PREFIX + to : to;
  };

  for (const wk of Object.keys(App.data.mealplan || {})) {
    for (const d of Object.keys(App.data.mealplan[wk] || {})) {
      const day = App.data.mealplan[wk][d];
      for (const slot of Object.keys(day)) {
        // De-duplicate after remapping: a day that held both copies of the
        // same recipe would otherwise end up listing one dish twice.
        const mapped = slotEntries(day[slot]).map(swap);
        const seen = new Set();
        const next = packSlot(mapped.filter(e => {
          if (e === FEND_ENTRY) return true;
          if (seen.has(e)) return false;
          seen.add(e);
          return true;
        }));
        if (next === null) delete day[slot]; else day[slot] = next;
      }
    }
  }

  for (const cb of Object.values(App.data.cookbooks || {})) {
    if (!Array.isArray(cb.recipeIds)) continue;
    const before = cb.recipeIds.length;
    cb.recipeIds = [...new Set(cb.recipeIds.map(id => map[id] || id))];
    bookRefs += before - cb.recipeIds.length + cb.recipeIds.filter(id => Object.values(map).includes(id)).length;
  }

  for (const tpl of Object.values(App.data.templates || {})) {
    for (const s of (tpl.slots || [])) {
      const seen = new Set();
      const next = packSlot(slotEntries(s.v).map(e => {
        const after = swap(e);
        if (after !== e) tplRefs++;
        return after;
      }).filter(e => {
        if (e === FEND_ENTRY) return true;
        if (seen.has(e)) return false;
        seen.add(e);
        return true;
      }));
      if (next !== null) s.v = next;
    }
  }
  return { planRefs, bookRefs, tplRefs };
}

function mergeDuplicateRecipes(dupes) {
  const map = {};
  for (const g of dupes) for (const d of g.drop) map[d.id] = g.keep.id;

  // References first — deleting a recipe that a plan still points at would
  // leave the planner rendering blanks.
  const refs = remapRecipeReferences(map);

  let removed = 0;
  for (const g of dupes) {
    for (const d of g.drop) {
      // Don't discard anything the survivor is missing
      const keep = App.data.recipes[g.keep.id];
      if (keep) {
        if (!keep.imageUrl && d.imageUrl)     keep.imageUrl = d.imageUrl;
        if (!keep.nutrition && d.nutrition)   keep.nutrition = d.nutrition;
        if (!keep.rating && d.rating)         keep.rating = d.rating;
        if (!keep.favorite && d.favorite)     keep.favorite = true;
        if (d.lastCooked && (!keep.lastCooked || d.lastCooked > keep.lastCooked))
          keep.lastCooked = d.lastCooked;
        if (!(keep.tags || []).length && (d.tags || []).length) keep.tags = d.tags;
        keep.updatedAt = Date.now();
      }
      delete App.data.recipes[d.id];
      ImageStore.delete(d.id);
      removed++;
    }
  }
  scheduleSave();
  return { removed, ...refs };
}

let _dupes = null;

function openDedupeModal() {
  _dupes = findDuplicateRecipes();
  const sum  = document.getElementById('dedupe-summary');
  const prev = document.getElementById('dedupe-preview');
  const go   = document.getElementById('dedupe-go');

  const extra = _dupes.reduce((n, g) => n + g.drop.length, 0);
  if (!_dupes.length) {
    sum.textContent = 'No duplicate recipe names found.';
    sum.style.color = 'var(--green-mid)';
    prev.innerHTML = '';
    if (go) go.disabled = true;
    openModal('modal-dedupe');
    return;
  }

  sum.innerHTML = `<strong>${_dupes.length}</strong> name${_dupes.length === 1 ? '' : 's'} ` +
    `appear${_dupes.length === 1 ? 's' : ''} more than once — <strong>${extra}</strong> ` +
    `record${extra === 1 ? '' : 's'} would be removed, leaving ` +
    `<strong>${Object.keys(App.data.recipes).length - extra}</strong> recipes.`;
  sum.style.color = '';

  prev.innerHTML = _dupes.slice(0, 40).map(g => `
    <div class="dupe-row">
      <div class="dupe-title">${esc(g.keep.title)}</div>
      <div class="dupe-meta">
        keeping the copy with ${dupeDescribe(g.keep)} ·
        removing ${g.drop.length} other${g.drop.length === 1 ? '' : 's'}
      </div>
    </div>`).join('') +
    (_dupes.length > 40 ? `<div class="f13 muted" style="padding:.5rem 0;">…and ${_dupes.length - 40} more.</div>` : '');

  if (go) go.disabled = false;
  openModal('modal-dedupe');
}

function dupeDescribe(r) {
  const bits = [];
  if (r.imageUrl)   bits.push('an image');
  if (r.lastCooked) bits.push('cook history');
  if (r.rating)     bits.push('a rating');
  if (r.nutrition)  bits.push('nutrition');
  return bits.length ? bits.join(', ') : 'the earliest date';
}

async function runDedupe() {
  if (!_dupes?.length) return;
  const extra = _dupes.reduce((n, g) => n + g.drop.length, 0);
  if (!await appConfirm({
    title: `Remove ${extra} duplicate record${extra === 1 ? '' : 's'}?`,
    message: `Meal plans, cookbooks and templates will be repointed at the copy that's kept.\n\nThis can't be undone — export a backup first if you haven't.`,
    confirmLabel: 'Merge duplicates', danger: true,
  })) return;

  const res = mergeDuplicateRecipes(_dupes);
  _dupes = null;
  closeModal('modal-dedupe');
  renderAll();
  showToast(`Merged ${res.removed} duplicates · ${res.planRefs} meal plan entries repointed`);
}

// ─── Share meal plan ─────────────────────────────────────────────
// Publishes a read-only window onto a date range. The worker renders the page
// and reads live data, so the link stays current; it expires on its own at
// midnight after the final day.

function shareDateInputs() {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const sel = document.getElementById('share-range')?.value || 'week';

  if (sel === 'custom') {
    const from = parseLocalDate(document.getElementById('share-from')?.value || '');
    const to   = parseLocalDate(document.getElementById('share-to')?.value || '');
    if (!from || !to) return { error: 'Pick a start and end date.' };
    if (to < from)    return { error: 'The end date is before the start date.' };
    const days = Math.round((to - from) / 86400000) + 1;
    if (days > 62)    return { error: 'Ranges longer than 62 days can’t be shared.' };
    return { from, to, fromStr: iso(from), toStr: iso(to) };
  }

  const weeks = sel === 'week' ? 1 : parseInt(sel) || 1;
  const from  = displayWeekStart(View.currentWeek);
  const to    = displayWeekStart(addWeeks(View.currentWeek, weeks - 1));
  to.setDate(to.getDate() + 6);
  return { from, to, fromStr: iso(from), toStr: iso(to) };
}

// Midnight after the final day, in *her* timezone. The worker runs in UTC and
// has no idea where she is, so this has to be computed client-side and sent.
function shareExpiryFor(toDate) {
  const end = new Date(toDate);
  end.setHours(23, 59, 59, 999);
  return end.getTime() + 1;
}

function shareRangeLabel(from, to) {
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return from.getFullYear() === to.getFullYear()
    ? `${fmt(from)} – ${fmt(to)}, ${from.getFullYear()}`
    : `${fmt(from)}, ${from.getFullYear()} – ${fmt(to)}, ${to.getFullYear()}`;
}

// Count what the recipients would actually see, so a plan with no images or
// no meals is obvious before the link goes out rather than after.
function shareRangeStats(from, to) {
  let meals = 0, withImg = 0, days = 0;
  for (let ts = new Date(from).setHours(0,0,0,0);
       ts <= new Date(to).setHours(0,0,0,0); ts += 86400000) {
    const d  = new Date(ts);
    const wk = getISOWeekKey(d);
    const dayPlan = App.data.mealplan?.[wk]?.[(d.getDay() + 6) % 7] || {};
    let any = false;
    for (const slot of MEAL_SLOTS) {
      for (const entry of slotEntries(dayPlan[slot])) {
        if (isFendEntry(entry)) { meals++; any = true; continue; }
        const r = getRecipe(slotRecipeId(entry));
        if (!r) continue;
        meals++; any = true;
        if (/^https?:\/\//i.test(r.imageUrl || '')) withImg++;
      }
    }
    if (any) days++;
  }
  return { meals, withImg, days };
}

function updateShareHint() {
  const hint   = document.getElementById('share-hint');
  const custom = document.getElementById('share-custom');
  const isCustom = document.getElementById('share-range')?.value === 'custom';
  if (custom) custom.style.display = isCustom ? '' : 'none';
  if (!hint) return;

  const r = shareDateInputs();
  if (r.error) { hint.textContent = r.error; hint.style.color = 'var(--saffron)'; return; }

  const st = shareRangeStats(r.from, r.to);
  if (!st.meals) {
    hint.textContent = `Nothing planned for ${shareRangeLabel(r.from, r.to)}.`;
    hint.style.color = 'var(--saffron)';
    return;
  }
  const noImg = st.meals - st.withImg;
  hint.textContent =
    `${shareRangeLabel(r.from, r.to)} · ${st.meals} meal${st.meals === 1 ? '' : 's'} across ` +
    `${st.days} day${st.days === 1 ? '' : 's'}` +
    (noImg ? ` · ${noImg} without a photo` : '');
  hint.style.color = 'var(--muted)';
}

function openSharePlanModal() {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const start = displayWeekStart(View.currentWeek);
  const end   = new Date(start); end.setDate(start.getDate() + 6);
  const f = document.getElementById('share-from'), t = document.getElementById('share-to');
  if (f && !f.value) f.value = iso(start);
  if (t && !t.value) t.value = iso(end);

  document.getElementById('share-result').style.display = 'none';
  document.getElementById('share-title').value = '';
  updateShareHint();
  openModal('modal-share-plan');
}

async function createSharePlanLink() {
  const btn = document.getElementById('share-create');
  const r   = shareDateInputs();
  if (r.error) { showToast(r.error); return; }

  const base = getWorkerUrl().replace(/\/+$/, '');
  if (!base)  { showToast('No worker URL configured — go to Settings first.'); return; }
  if (Auth.isGuest()) { showToast('Sign in to share a meal plan.'); return; }

  const token = App.data?.userToken;
  if (!token) { showToast('No account token — try signing in again.'); return; }

  const label = shareRangeLabel(r.from, r.to);
  const body  = JSON.stringify({
    token,
    from: r.fromStr,
    to:   r.toStr,
    title:    (document.getElementById('share-title')?.value || '').trim() || 'Meal Plan',
    subtitle: label,
    expiresAt: shareExpiryFor(r.to),
  });

  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    const headers = await Auth._authHeaders('POST', token, body);
    const res  = await fetch(`${base}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) throw new Error(data.error || `HTTP ${res.status}`);

    const url = `${base}/share/${data.id}`;
    document.getElementById('share-url').value = url;
    document.getElementById('share-expiry').textContent =
      `Stops working ${new Date(data.expiresAt).toLocaleString('en-US',
        { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
    document.getElementById('share-result').style.display = '';
    showToast('Link created ✓');
  } catch (e) {
    showToast(`Could not create link: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create Link'; }
  }
}

// ─── Meal plan templates ─────────────────────────────────────────
// Capture a stretch of the planner under a name and drop it onto any other
// week later. Templates store week index + day of week, never dates, so
// loading one preserves the weekday rhythm wherever it lands.

// Templates saved before the planner became Sunday-first store `d` as a
// Monday-anchored day index (Mon=0), relative to a Mon–Sun week. Everything
// now reasons in display columns (Sun=0) over a Sun–Sat week, so those old
// records have to be re-pinned or a loaded template would land a day off.
//
// This is a pure relative remap — templates hold no dates, only offsets. The
// Sunday that opens week w's display window is the day *before* that week's
// Monday, so every old offset shifts forward by one and a template can gain a
// trailing week. Marked with `anchor` so it only ever runs once per record.
function migrateTemplateAnchors() {
  const tpls = App.data.templates;
  if (!tpls) return 0;
  let changed = 0;

  for (const tpl of Object.values(tpls)) {
    if (!tpl || tpl.anchor === 'sun') continue;
    const slots = (tpl.slots || []).map(s => {
      const offset = (Number(s.w) || 0) * 7 + (Number(s.d) || 0) + 1;
      return { ...s, w: Math.floor(offset / 7), d: offset % 7 };
    });
    tpl.slots  = slots;
    tpl.weeks  = slots.length ? Math.max(...slots.map(s => s.w)) + 1 : (tpl.weeks || 1);
    tpl.anchor = 'sun';
    changed++;
  }

  if (changed) scheduleSave();
  return changed;
}

function getTemplates() {
  return Object.values(App.data.templates || {})
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getTemplate(id) { return App.data.templates?.[id] || null; }

// Read `weeks` consecutive weeks out of the planner starting at startWeek.
// `range` optionally clips to exact dates, for a custom span that begins or
// ends mid-week. Partial weeks need no special handling: every slot already
// records its own weekday, so a range starting on a Wednesday simply leaves
// Mon and Tue of week 0 empty, and loading puts each day back on the same
// weekday of the target week.
function captureTemplateSlots(startWeek, weeks, range = null) {
  const slots = [];
  const from  = range?.from ? new Date(range.from).setHours(0, 0, 0, 0) : null;
  const to    = range?.to   ? new Date(range.to).setHours(23, 59, 59, 999) : null;

  for (let w = 0; w < weeks; w++) {
    const wk = addWeeks(startWeek, w);
    // Walk display columns, so `d` is Sun=0 — the same week the user sees on
    // screen. Saving "this week" has to capture the Sunday she's looking at,
    // not the one that closes the underlying ISO week.
    for (const c of plannerColumns(wk)) {
      const d   = c.col;
      const day = App.data.mealplan?.[c.weekKey]?.[c.dayIdx];
      if (!day) continue;
      if (from !== null || to !== null) {
        const ts = c.date.getTime();
        if (from !== null && ts < from) continue;
        if (to   !== null && ts > to)   continue;
      }
      for (const slot of MEAL_SLOTS) {
        const entries = slotEntries(day[slot]);
        if (!entries.length) continue;
        slots.push({ w, d, slot, v: packSlot(entries) });
      }
    }
  }
  return slots;
}

// Turn a pair of dates into the week-anchored span the template model wants:
// the display week the range starts in, and how many weeks it touches.
function rangeToWeekSpan(fromDate, toDate) {
  const startWeek = displayWeekKeyFor(fromDate);
  const endWeek   = displayWeekKeyFor(toDate);
  let weeks = 1;
  while (weeks < 60 && addWeeks(startWeek, weeks - 1) !== endWeek) weeks++;
  return { startWeek, weeks };
}

function saveTemplate(name, startWeek, weeks, range = null) {
  const slots = captureTemplateSlots(startWeek, weeks, range);
  if (!slots.length) return { ok: false, error: 'Nothing planned in that range to save.' };
  if (!App.data.templates) App.data.templates = {};
  const id  = genId();
  const now = Date.now();
  App.data.templates[id] = {
    id,
    name: name.trim() || `Template ${new Date(now).toLocaleDateString()}`,
    weeks,
    slots,
    // Marks `d` as a display column (Sun=0). Templates saved before the
    // Sunday-first change carry no anchor and are migrated on load.
    anchor: 'sun',
    createdAt: now,
    updatedAt: now,
  };
  scheduleSave();
  return { ok: true, id, count: slots.reduce((n, s) => n + slotEntries(s.v).length, 0) };
}

function deleteTemplate(id) {
  if (!App.data.templates?.[id]) return;
  delete App.data.templates[id];
  scheduleSave();
}

// How many meals a template holds, and how many of those still resolve to a
// recipe that exists. A template built months ago can reference recipes since
// deleted, so the gap is worth showing before the user loads it.
function templateStats(tpl) {
  let total = 0, missing = 0;
  for (const s of (tpl.slots || [])) {
    for (const entry of slotEntries(s.v)) {
      total++;
      if (isFendEntry(entry)) continue;         // points at no recipe by design
      if (!getRecipe(slotRecipeId(entry))) missing++;
    }
  }
  return { total, missing, days: new Set((tpl.slots || []).map(s => `${s.w}:${s.d}`)).size };
}

// Apply a template onto the planner starting at `startWeek`.
// mode 'replace' overwrites any slot the template has an entry for;
// mode 'fill' leaves occupied slots alone and only fills empty ones.
function applyTemplate(id, startWeek, mode = 'replace') {
  const tpl = getTemplate(id);
  if (!tpl) return { ok: false, error: 'Template not found.' };

  if (!App.data.mealplan) App.data.mealplan = {};
  let applied = 0, skippedMissing = 0, skippedOccupied = 0;

  for (const s of (tpl.slots || [])) {
    // Entries whose recipe has since been deleted are dropped rather than
    // written as dead references — the planner would render them as blanks
    // and the shopping list would silently ignore them.
    const kept = slotEntries(s.v).filter(e => {
      if (isFendEntry(e)) return true;
      if (getRecipe(slotRecipeId(e))) return true;
      skippedMissing++;
      return false;
    });
    if (!kept.length) continue;

    // s.d is a display column; plannerColumns turns it back into the week and
    // day index the plan is actually stored under.
    const c   = plannerColumn(addWeeks(startWeek, s.w), s.d);
    const day = planDayRef(c.weekKey, c.dayIdx, true);

    if (mode === 'fill' && slotEntries(day[s.slot]).length) {
      skippedOccupied += kept.length;
      continue;
    }

    const packed = packSlot(kept);
    if (packed === null) continue;
    day[s.slot] = packed;
    applied += kept.length;
  }

  // Loading a plan is not cooking it — lastCooked stays untouched, exactly as
  // in the Mealie history import.
  scheduleSave();
  return { ok: true, applied, skippedMissing, skippedOccupied };
}

// ─── Template UI ─────────────────────────────────────────────────

function openTemplatesModal() {
  document.getElementById('tpl-name').value = '';

  // Seed the custom inputs with the week on screen, so switching to Custom
  // starts somewhere sensible rather than blank.
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const start = displayWeekStart(View.currentWeek);
  const end   = new Date(start); end.setDate(start.getDate() + 6);
  const fromEl = document.getElementById('tpl-from');
  const toEl   = document.getElementById('tpl-to');
  if (fromEl && !fromEl.value) fromEl.value = iso(start);
  if (toEl   && !toEl.value)   toEl.value   = iso(end);

  updateTemplateSaveHint();   // sets the range label to match the current span
  renderTemplateList();
  openModal('modal-templates');
}

// Tell the user what a save would actually capture before they commit — a
// range with nothing planned in it is the most likely mistake here.
// Resolve the save controls into the span to capture. Returns null when a
// custom range is selected but not yet valid, so callers can report why
// rather than silently saving the wrong thing.
function currentTemplateSpan() {
  const sel = document.getElementById('tpl-weeks')?.value || '1';

  if (sel !== 'custom') {
    const weeks = parseInt(sel) || 1;
    return { startWeek: View.currentWeek, weeks, range: null,
             label: formatWeekRangeLabel(View.currentWeek, weeks) };
  }

  const from = parseLocalDate(document.getElementById('tpl-from')?.value || '');
  const to   = parseLocalDate(document.getElementById('tpl-to')?.value || '');
  if (!from || !to) return { error: 'Pick a start and end date.' };
  if (to < from)    return { error: 'The end date is before the start date.' };

  const span = rangeToWeekSpan(from, to);
  if (span.weeks > 26) return { error: 'That range is longer than 6 months — try a shorter one.' };

  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const label = from.getFullYear() === to.getFullYear()
    ? `${fmt(from)} – ${fmt(to)}, ${from.getFullYear()}`
    : `${fmt(from)}, ${from.getFullYear()} – ${fmt(to)}, ${to.getFullYear()}`;
  return { startWeek: span.startWeek, weeks: span.weeks, range: { from, to }, label };
}

function updateTemplateSaveHint() {
  const hint   = document.getElementById('tpl-save-hint');
  const label  = document.getElementById('tpl-save-from');
  const custom = document.getElementById('tpl-custom-range');
  const isCustom = document.getElementById('tpl-weeks')?.value === 'custom';
  if (custom) custom.style.display = isCustom ? '' : 'none';
  if (!hint) return;

  const span = currentTemplateSpan();
  if (span.error) {
    if (label) label.textContent = 'a custom range';
    hint.textContent = span.error;
    hint.style.color = 'var(--saffron)';
    return;
  }

  if (label) label.textContent = span.label;
  const slots = captureTemplateSlots(span.startWeek, span.weeks, span.range);
  const meals = slots.reduce((n, s) => n + slotEntries(s.v).length, 0);
  const days  = new Set(slots.map(s => `${s.w}:${s.d}`)).size;
  hint.textContent = meals
    ? `Captures ${meals} meal${meals === 1 ? '' : 's'} across ${days} day${days === 1 ? '' : 's'}.`
    : 'Nothing planned in that range yet.';
  hint.style.color = meals ? 'var(--muted)' : 'var(--saffron)';
}

function renderTemplateList() {
  const wrap = document.getElementById('tpl-list');
  if (!wrap) return;
  const list = getTemplates();
  if (!list.length) {
    wrap.innerHTML = `<div class="f13 muted" style="padding:.75rem 0;">
      No templates yet. Plan a week you like, then save it here and load it onto any future week.</div>`;
    return;
  }

  wrap.innerHTML = list.map(t => {
    const st = templateStats(t);
    return `
    <div class="tpl-row" data-id="${esc(t.id)}">
      <div class="tpl-row-main">
        <div class="tpl-row-name">${esc(t.name)}</div>
        <div class="tpl-row-meta">
          ${t.weeks} week${t.weeks === 1 ? '' : 's'} · ${st.total} meal${st.total === 1 ? '' : 's'} · ${st.days} day${st.days === 1 ? '' : 's'}
          ${st.missing ? `<span class="tpl-missing">· ${st.missing} recipe${st.missing === 1 ? '' : 's'} no longer exist${st.missing === 1 ? 's' : ''}</span>` : ''}
        </div>
      </div>
      <div class="tpl-row-actions">
        <button class="btn btn-primary btn-sm tpl-load" data-id="${esc(t.id)}">Load</button>
        <button class="btn btn-icon tpl-delete" data-id="${esc(t.id)}" title="Delete template">🗑</button>
      </div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.tpl-load').forEach(btn => {
    btn.addEventListener('click', () => loadTemplateIntoPlanner(btn.dataset.id));
  });
  wrap.querySelectorAll('.tpl-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = getTemplate(btn.dataset.id);
      if (!t) return;
      appConfirm({
        title: 'Delete template?',
        message: `“${t.name}” will be removed. This won't change any meal plans.`,
        confirmLabel: 'Delete', danger: true,
      }).then(go => {
        if (!go) return;
        deleteTemplate(btn.dataset.id);
        renderTemplateList();
        showToast('Template deleted');
      });
    });
  });
}

async function loadTemplateIntoPlanner(id) {
  const tpl = getTemplate(id);
  if (!tpl) return;
  const mode = document.getElementById('tpl-fill-only')?.checked ? 'fill' : 'replace';
  const target = View.currentWeek;

  // Replacing can overwrite meals already planned, so say so before doing it.
  if (mode === 'replace') {
    const clashes = tpl.slots.filter(s => {
      const c = plannerColumn(addWeeks(target, s.w), s.d);
      return slotEntries(App.data.mealplan?.[c.weekKey]?.[c.dayIdx]?.[s.slot]).length;
    }).length;
    if (clashes && !await appConfirm({
      title: 'Overwrite planned meals?',
      message: `“${tpl.name}” will replace ${clashes} slot${clashes === 1 ? '' : 's'} that already ` +
        `${clashes === 1 ? 'has' : 'have'} meals planned, starting ${formatWeekLabel(target)}.\n\n` +
        `Tick “Only fill empty slots” first if you'd rather keep them.`,
      confirmLabel: 'Overwrite', danger: true,
    })) return;
  }

  const res = applyTemplate(id, target, mode);
  if (!res.ok) { showToast(res.error); return; }

  closeModal('modal-templates');
  renderAll();

  const bits = [`Loaded ${res.applied} meal${res.applied === 1 ? '' : 's'}`];
  if (res.skippedOccupied) bits.push(`${res.skippedOccupied} skipped (slot in use)`);
  if (res.skippedMissing)  bits.push(`${res.skippedMissing} skipped (recipe deleted)`);
  showToast(bits.join(' · '));
}

// ─── Cookbooks ────────────────────────────────────────────────────

function getCookbooks() {
  return Object.values(App.data.cookbooks || {})
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function getCookbook(id) {
  return App.data.cookbooks?.[id] || null;
}

function renderCookbooks() {
  const grid    = document.getElementById('cookbooks-grid');
  const empty   = document.getElementById('cookbooks-empty');
  if (!grid) return;

  const books = getCookbooks();
  if (!books.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  grid.innerHTML = books.map(cb => {
    const count    = (cb.recipeIds || []).length;
    const previews = (cb.recipeIds || []).slice(0, 4);
    return `
      <div class="cookbook-card" data-id="${esc(cb.id)}">
        <div class="cookbook-card-mosaic">
          ${previews.map(rid => `<div class="cookbook-mosaic-cell" data-mosaic-img="${esc(rid)}">${PLACEHOLDER_ART}</div>`).join('')}
          ${previews.length === 0 ? '<div class="cookbook-mosaic-empty">📚</div>' : ''}
        </div>
        <div class="cookbook-card-body">
          <div class="cookbook-card-name">${esc(cb.name)}</div>
          <div class="cookbook-card-count muted">${count} recipe${count !== 1 ? 's' : ''}</div>
          ${cb.description ? `<div class="cookbook-card-desc muted">${esc(cb.description)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  // Async-load mosaic images
  grid.querySelectorAll('[data-mosaic-img]').forEach(async cell => {
    const dataUrl = await resolveImage(cell.dataset.mosaicImg);
    if (dataUrl) {
      cell.style.backgroundImage = `url('${dataUrl}')`;
      cell.textContent = '';
    }
  });

  grid.querySelectorAll('.cookbook-card').forEach(card => {
    card.addEventListener('click', () => openCookbookDetail(card.dataset.id));
  });
}

// ── Cookbook editor ───────────────────────────────────────────────

let _editingCookbookId = null;

function openCookbookEditor(id) {
  _editingCookbookId = id;
  const cb = id ? getCookbook(id) : null;
  document.getElementById('cookbook-editor-title').textContent = id ? 'Edit Cookbook' : 'New Cookbook';
  document.getElementById('cookbook-name').value = cb?.name || '';
  document.getElementById('cookbook-desc').value = cb?.description || '';
  openModal('modal-cookbook-editor');
  document.getElementById('cookbook-name').focus();
}

function saveCookbook() {
  const name = document.getElementById('cookbook-name').value.trim();
  if (!name) { document.getElementById('cookbook-name').focus(); return; }
  const desc = document.getElementById('cookbook-desc').value.trim();

  if (_editingCookbookId) {
    const cb = getCookbook(_editingCookbookId);
    if (cb) { cb.name = name; cb.description = desc; }
  } else {
    const id = genId();
    App.data.cookbooks[id] = { id, name, description: desc, recipeIds: [], createdAt: Date.now() };
  }
  scheduleSave();
  closeModal('modal-cookbook-editor');
  renderCookbooks();
  if (_editingCookbookId) renderCookbookDetail(_editingCookbookId);
}

async function deleteCookbook(id) {
  if (!await appConfirm({
    title: 'Delete cookbook?',
    message: 'The recipes themselves will not be affected.',
    confirmLabel: 'Delete', danger: true,
  })) return;
  delete App.data.cookbooks[id];
  scheduleSave();
  closeModal('modal-cookbook-detail');
  renderCookbooks();
}

// ── Cookbook detail ───────────────────────────────────────────────

let _openCookbookId = null;

function openCookbookDetail(id) {
  _openCookbookId = id;
  renderCookbookDetail(id);
  openModal('modal-cookbook-detail');
}

function renderCookbookDetail(id) {
  const cb = getCookbook(id);
  if (!cb) return;

  document.getElementById('cookbook-detail-title').textContent = cb.name;
  const descEl = document.getElementById('cookbook-detail-desc');
  descEl.textContent = cb.description || '';
  descEl.style.display = cb.description ? '' : 'none';

  const recipeIds = cb.recipeIds || [];
  const grid      = document.getElementById('cookbook-recipes-grid');
  const empty     = document.getElementById('cookbook-recipes-empty');

  if (!recipeIds.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = '';
  } else {
    if (empty) empty.style.display = 'none';
    grid.innerHTML = recipeIds.map(rid => {
      const r = getRecipe(rid);
      if (!r) return '';
      return `
        <div class="recipe-card" data-id="${esc(rid)}">
          <div class="recipe-card-img" data-img-id="${esc(rid)}">
            <div class="recipe-card-placeholder">${PLACEHOLDER_ART}</div>
          </div>
          <div class="recipe-card-body">
            <div class="recipe-card-title">${esc(r.title)}</div>
            <div class="recipe-card-meta">
              ${r.rating ? `<span class="card-stars">${starsDisplay(r.rating)}</span>` : ''}
              ${r.servings ? `<span>Serves ${esc(String(r.servings))}</span>` : ''}
            </div>
            <button class="cookbook-remove-recipe btn btn-ghost btn-sm"
                    data-rid="${esc(rid)}" style="margin-top:.35rem;font-size:.72rem;color:var(--muted);">
              Remove from cookbook
            </button>
          </div>
        </div>`;
    }).filter(Boolean).join('');

    // Async-load images
    grid.querySelectorAll('[data-img-id]').forEach(async imgEl => {
      const dataUrl = await resolveImage(imgEl.dataset.imgId);
      if (dataUrl) {
        imgEl.style.backgroundImage = `url('${dataUrl}')`;
        imgEl.querySelector('.recipe-card-placeholder')?.remove();
      }
    });

    // Open recipe detail — close cookbook detail first, reopen after
    grid.querySelectorAll('.recipe-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.cookbook-remove-recipe')) return;
        closeModal('modal-cookbook-detail');
        openRecipeDetail(card.dataset.id);
        // Reopen cookbook detail when recipe detail closes
        const recipeOverlay = document.getElementById('modal-recipe-detail');
        const observer = new MutationObserver(() => {
          if (!recipeOverlay.classList.contains('open')) {
            observer.disconnect();
            openModal('modal-cookbook-detail');
          }
        });
        observer.observe(recipeOverlay, { attributes: true, attributeFilter: ['class'] });
      });
    });

    // Remove recipe from cookbook
    grid.querySelectorAll('.cookbook-remove-recipe').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const cb = getCookbook(id);
        if (cb) {
          cb.recipeIds = cb.recipeIds.filter(r => r !== btn.dataset.rid);
          scheduleSave();
          renderCookbookDetail(id);
          renderCookbooks();
        }
      });
    });
  }

  // Wire footer buttons
  document.getElementById('cookbook-detail-edit').onclick   = () => openCookbookEditor(id);
  document.getElementById('cookbook-detail-delete').onclick = () => deleteCookbook(id);
}

// ── Add recipe to cookbook picker ────────────────────────────────

function openCookbookPick(cookbookId) {
  const grid   = document.getElementById('cookbook-pick-grid');
  const search = document.getElementById('cookbook-pick-search');
  if (!grid) return;

  // Clear state from any previous open
  grid.innerHTML = '';
  if (search) search.value = '';

  function renderPick(q) {
    const cb       = getCookbook(cookbookId);
    const existing = new Set(cb?.recipeIds || []);
    const g        = document.getElementById('cookbook-pick-grid');
    if (!g) return;

    const recipes = getRecipes().filter(r =>
      !existing.has(r.id) &&
      (!q || r.title.toLowerCase().includes(q.toLowerCase()))
    );

    g.innerHTML = recipes.map(r => `
      <div class="pick-recipe-item" data-id="${esc(r.id)}">
        <div class="pick-img" data-pick-img="${esc(r.id)}">${PLACEHOLDER_ART}</div>
        <div class="pick-title">${esc(r.title)}</div>
      </div>`).join('');

    g.querySelectorAll('[data-pick-img]').forEach(async imgEl => {
      const dataUrl = await resolveImage(imgEl.dataset.pickImg);
      if (dataUrl) { imgEl.style.backgroundImage = `url('${dataUrl}')`; imgEl.textContent = ''; }
    });

    g.querySelectorAll('.pick-recipe-item').forEach(item => {
      item.addEventListener('click', () => {
        const cb = getCookbook(cookbookId);
        if (cb && !cb.recipeIds.includes(item.dataset.id)) {
          cb.recipeIds.push(item.dataset.id);
          scheduleSave();
          renderCookbookDetail(cookbookId);
          renderCookbooks();
          const s = document.getElementById('cookbook-pick-search');
          renderPick(s?.value || '');
        }
      });
    });
  }

  // Wire search — remove old listener by replacing with a fresh handler via oninput
  if (search) {
    search.oninput = e => renderPick(e.target.value);
    setTimeout(() => search.focus(), 50);
  }

  renderPick('');
  openModal('modal-cookbook-pick');
}

// ─── Mealie import ────────────────────────────────────────────────


// ─── Export ───────────────────────────────────────────────────────

let _exportMode = null; // 'full' | 'images'
let _bulkExportIds = null; // set when exporting a specific selection of recipes

function openExportModal(idsOverride = null) {
  _exportMode = null;
  _bulkExportIds = idsOverride;
  const titleEl = document.querySelector('#modal-export .modal-title');
  if (titleEl) titleEl.textContent = idsOverride ? `Export ${idsOverride.length} Selected Recipes` : 'Export Recipes';
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

async function runExport(idsOverride = null) {
  if (!_exportMode) return;
  const statusEl = document.getElementById('export-status');
  const btn      = document.getElementById('btn-export-go');
  btn.disabled   = true;
  btn.textContent = 'Building…';

  try {
    const zip  = new JSZip();
    const date = new Date().toISOString().slice(0, 10);
    const ids  = idsOverride || Object.keys(App.data.recipes || {});

    if (_exportMode === 'full') {
      // recipes.json — selected recipe data, no images
      const recipes = Object.fromEntries(
        ids.filter(id => App.data.recipes[id]).map(id => {
          const { image: _img, ...rest } = App.data.recipes[id];
          return [id, rest];
        })
      );
      zip.file('recipes.json', JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), recipes }, null, 2));
      statusEl.textContent = 'Adding recipe data…';
    }

    // Images — always included in full, only thing in images-only
    statusEl.textContent = 'Collecting images…';
    const imgFolder = zip.folder('images');
    let imgCount = 0;
    for (const id of ids) {
      const dataUrl = await ImageStore.get(id);
      if (!dataUrl) continue;
      // Only cached bytes go in the zip; remote links ride along in recipes.json
      if (!dataUrl.startsWith('data:')) continue;
      // dataUrl is "data:image/webp;base64,{b64}" — extract the raw base64
      const b64 = dataUrl.split(',')[1];
      if (b64) { imgFolder.file(`${id}.webp`, b64, { base64: true }); imgCount++; }
    }

    statusEl.textContent = 'Compressing…';
    const blob   = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const suffix = idsOverride ? `selected-${date}` : date;
    const filename = _exportMode === 'full'
      ? `refectory-backup-${suffix}.zip`
      : `refectory-images-${suffix}.zip`;

    // Trigger download
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    const recipeCount = ids.filter(id => App.data.recipes[id]).length;
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
  const blocked = importGuardBlocked();
  if (blocked) return { ok: false, error: blocked };

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
  // Default to refectory tab — most common import path for returning users
  switchMealieTab('refectory');
  openModal('modal-mealie-import');
}

function switchMealieTab(tab) {
  const panels = { backup: 'mealie-backup-panel', json: 'mealie-json-panel', api: 'mealie-api-panel', refectory: 'mealie-refectory-panel', repull: 'mealie-repull-panel' };
  const btns   = { backup: 'mealie-tab-backup',   json: 'mealie-tab-json',   api: 'mealie-tab-api',   refectory: 'mealie-tab-refectory',    repull: 'mealie-tab-repull'   };
  Object.entries(panels).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = key === tab ? '' : 'none';
  });
  Object.entries(btns).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', key === tab);
  });
  if (tab === 'repull' && !_repull.running) refreshRepullCounts();
}

// ─── Re-pull images from source URLs ──────────────────────────────
// Refetches each recipe's source page through the worker's scrape proxy and
// pulls a fresh image link out of it. The link is written to the recipe
// record (not IndexedDB), so a repair run on any one device propagates to
// every device through the normal sync. Locally cached image bytes always
// win at display time, so this never overwrites a real image file.

const REPULL_CONCURRENCY  = 4;    // parallel fetches; pacing below is the real throttle
const REPULL_MAX_RETRIES  = 6;    // per recipe, rate-limit rejections only
const REPULL_BACKOFF_MS   = 3000; // fallback wait when the server sends no Retry-After
const REPULL_BACKOFF_CAP  = 60000;
// The worker allows 60 scrapes/min per IP. Starting a request every 1050ms
// holds ~57/min: fast enough to be worth parallelising, slack enough that
// clock skew and retries don't trip the limiter. Concurrency still helps —
// it keeps the pipeline full while individual pages are slow to respond.
const REPULL_MIN_INTERVAL_MS = 1050;

let _repull = { running: false, cancel: false, scan: null };

// A rate limiter rejects the whole burst, not one request, so a hit has to
// pause every in-flight fetch — not just the one that bounced.
let _repullGate = null;

// Shared scheduler: workers reserve the next start slot rather than sleeping a
// fixed amount each, so the request rate stays even no matter how many workers
// there are or how long any single page takes.
let _repullNextSlot = 0;

async function repullTakeSlot() {
  const now  = Date.now();
  const slot = Math.max(now, _repullNextSlot);
  _repullNextSlot = slot + REPULL_MIN_INTERVAL_MS;
  if (slot > now) await new Promise(r => setTimeout(r, slot - now));
}

function isRateLimited(res, data) {
  if (res.status === 429) return true;
  return /rate.?limit|too many/i.test(data?.error || '');
}

// A site refusing automated access is a different failure from a broken page
// or a flaky network: retrying won't help, and the honest advice is to add the
// recipe by hand. 429 is deliberately excluded — that one does clear on retry
// and is handled by the backoff path.
function isBotBlocked(res, data) {
  if ([401, 403, 451].includes(res.status)) return true;
  return /\b(403|forbidden|blocked|bot detect|captcha|access denied|just a moment)\b/i
    .test(data?.error || '');
}

const BLOCKED_HINT = 'This site blocks automated access, so the page can\u2019t be fetched. ' +
                     'You can still add the recipe by hand.';

// Prefer the server's own figure when it sends one — the worker knows exactly
// when a slot frees up, so guessing with exponential backoff is a fallback.
function repullRetryAfterMs(res, data) {
  const header = parseInt(res.headers.get('Retry-After') || '', 10);
  if (Number.isFinite(header) && header > 0) return (header + 1) * 1000;
  if (Number.isFinite(data?.retryAfter) && data.retryAfter > 0) return (data.retryAfter + 1) * 1000;
  return null;
}

async function repullWaitForGate() {
  while (_repullGate) await _repullGate;
}

// Pause all workers for `ms`. Concurrent callers share one wait rather than
// stacking their own on top of it.
function repullPause(ms, onTick) {
  if (_repullGate) return _repullGate;
  // Push every worker's next slot past the pause so nobody fires the instant
  // the gate opens and immediately re-trips the limiter.
  _repullNextSlot = Math.max(_repullNextSlot, Date.now() + ms);
  _repullGate = (async () => {
    const until = Date.now() + ms;
    while (Date.now() < until && !_repull.cancel) {
      onTick?.(Math.ceil((until - Date.now()) / 1000));
      await new Promise(r => setTimeout(r, 250));
    }
    _repullGate = null;
  })();
  return _repullGate;
}

// Pull an image URL out of a fetched page: JSON-LD first, then OG/Twitter meta.
function extractImageFromHtml(html, pageUrl) {
  let img = '';
  try { img = parseRecipeFromHtml(html, pageUrl)?.image || ''; } catch {}
  if (!img) {
    try {
      const doc  = new DOMParser().parseFromString(html, 'text/html');
      const meta = (n) => doc.querySelector(`meta[property="${n}"]`)?.content
                       || doc.querySelector(`meta[name="${n}"]`)?.content || '';
      img = pickSecureImage(meta('og:image:secure_url'), meta('og:image'), meta('twitter:image'));
    } catch {}
  }
  if (!img) return '';
  // Resolve protocol-relative and root-relative paths against the page
  try { return new URL(img, pageUrl).href; } catch { return ''; }
}

// A recipe has an image if this device has bytes for it OR the record has a link.
async function recipeHasImage(r) {
  try { if (await ImageStore.get(r.id)) return true; } catch {}
  return !!r.imageUrl;
}

async function scanRepullTargets() {
  const recipes    = Object.values(App.data.recipes || {});
  const gaps       = [];   // missing an image AND recoverable
  const gapsNoSrc  = [];   // missing an image with nothing to fetch from
  for (const r of recipes) {
    if (await recipeHasImage(r)) continue;
    (r.sourceUrl ? gaps : gapsNoSrc).push(r.id);
  }
  return {
    total:      recipes.length,
    withSource: recipes.filter(r => r.sourceUrl).length,
    gaps,
    gapsNoSrc,
  };
}

async function refreshRepullCounts() {
  const el = document.getElementById('repull-counts');
  if (!el) return;
  el.textContent = 'Scanning…';
  const s = _repull.scan = await scanRepullTargets();
  const missing = s.gaps.length + s.gapsNoSrc.length;

  const lines = [`<strong>${s.total}</strong> recipes · <strong>${missing}</strong> missing an image`];
  if (s.gaps.length) {
    lines.push(`<strong style="color:var(--green-mid);">${s.gaps.length}</strong> can be recovered from a source URL`);
  }
  if (s.gapsNoSrc.length) {
    lines.push(`${s.gapsNoSrc.length} have no source URL — these need an image added by hand`);
  }
  if (!missing) lines.push('Nothing missing on this device.');
  el.innerHTML = lines.join('<br/>');

  // Button reflects exactly how many pages a run would fetch
  const allBox   = document.getElementById('repull-all');
  const startBtn = document.getElementById('btn-repull-start');
  const count    = allBox?.checked ? s.withSource : s.gaps.length;
  if (startBtn) {
    startBtn.disabled    = !count;
    startBtn.textContent = count ? `Start (${count})` : 'Nothing to re-pull';
  }
}

function repullLog(msg, color) {
  const log = document.getElementById('repull-log');
  if (!log) return;
  log.style.display = '';
  const line = document.createElement('div');
  if (color) line.style.color = color;
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

async function runImageRepull() {
  if (_repull.running) return;

  const base = getWorkerUrl().replace(/\/+$/, '');
  const statusEl = document.getElementById('mealie-import-status');
  if (!base) {
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = 'No worker URL configured — go to Settings first.';
    return;
  }

  const all  = document.getElementById('repull-all')?.checked;
  const scan = _repull.scan || (await scanRepullTargets());
  const ids  = all
    ? Object.values(App.data.recipes || {}).filter(r => r.sourceUrl).map(r => r.id)
    : scan.gaps;

  if (!ids.length) {
    statusEl.style.color = 'var(--muted)';
    statusEl.textContent = 'Nothing to re-pull.';
    return;
  }

  _repull.running = true;
  _repull.cancel  = false;
  _repullGate     = null;
  _repullNextSlot = 0;

  const startBtn  = document.getElementById('btn-repull-start');
  const cancelBtn = document.getElementById('btn-repull-cancel');
  const wrap      = document.getElementById('repull-progress-wrap');
  const bar       = document.getElementById('repull-progress-bar');
  const text      = document.getElementById('repull-progress-text');
  const log       = document.getElementById('repull-log');

  if (startBtn)  startBtn.disabled   = true;
  if (cancelBtn) cancelBtn.style.display = '';
  if (wrap)      wrap.style.display  = '';
  if (log)     { log.innerHTML = ''; log.style.display = 'none'; }
  statusEl.textContent = '';

  let idx = 0, done = 0, ok = 0, noImg = 0, failed = 0, blocked = 0;

  const started = Date.now();
  const tick = () => {
    const pct = Math.round((done / ids.length) * 100);
    if (bar) bar.style.width = pct + '%';
    if (!text) return;
    let eta = '';
    if (done >= 3 && done < ids.length) {
      const secs = Math.round(((Date.now() - started) / done) * (ids.length - done) / 1000);
      eta = secs > 90 ? ` · ~${Math.ceil(secs / 60)} min left` : ` · ~${secs}s left`;
    }
    text.textContent =
      `${done} of ${ids.length} · ${ok} recovered · ${noImg} no image · ${failed} failed` +
      (blocked ? ` · ${blocked} blocked` : '') + eta;
  };
  tick();

  let backoff = REPULL_BACKOFF_MS;

  const worker = async () => {
    while (idx < ids.length && !_repull.cancel) {
      await repullWaitForGate();
      if (_repull.cancel) return;

      const r = getRecipe(ids[idx++]);
      if (!r || !r.sourceUrl) { done++; tick(); continue; }
      const label = (r.title || 'Untitled').slice(0, 55);

      let attempt = 0;
      for (;;) {
        if (_repull.cancel) return;
        try {
          await repullTakeSlot();
          if (_repull.cancel) return;
          const res  = await fetch(`${base}/scrape?url=${encodeURIComponent(r.sourceUrl)}`);
          const data = await res.json().catch(() => ({}));

          if (isRateLimited(res, data)) {
            if (++attempt > REPULL_MAX_RETRIES) {
              failed++;
              repullLog(`✕ ${label} — still rate limited after ${REPULL_MAX_RETRIES} retries`, 'var(--red)');
              break;
            }
            const advised = repullRetryAfterMs(res, data);
            const wait = advised ?? Math.min(backoff, REPULL_BACKOFF_CAP);
            // Only escalate the guess when we're actually guessing
            if (advised === null) backoff = Math.min(backoff * 2, REPULL_BACKOFF_CAP);
            await repullPause(wait, (secs) => {
              if (text) text.textContent =
                `Rate limited — waiting ${secs}s · ${done} of ${ids.length} · ${ok} recovered`;
            });
            tick();
            continue;   // same recipe, fresh attempt
          }

          if (isBotBlocked(res, data)) {
            // No amount of retrying gets past a bot wall — record it and move
            // on rather than burning the retry budget and the rate limiter.
            blocked++;
            repullLog(`⛔ ${label} — site blocks automated access`, 'var(--saffron)');
            break;
          }
          if (!res.ok || !data.html) throw new Error(data.error || `HTTP ${res.status}`);

          const img = extractImageFromHtml(data.html, data.finalUrl || r.sourceUrl);
          if (img) {
            r.imageUrl = img;
            // Without this the recovered link is invisible to the sync merge,
            // which compares updatedAt — so any other device's later edit
            // would silently win and drop it.
            r.updatedAt = Date.now();
            ok++;
            repullLog(`✓ ${label}`, 'var(--green-mid)');
          } else {
            noImg++;
            repullLog(`— ${label} — page loaded, no image found`);
          }
          // A clean response means the limiter has forgiven us; ease back off
          backoff = REPULL_BACKOFF_MS;
          break;
        } catch (e) {
          failed++;
          repullLog(`✕ ${label} — ${e.message || 'fetch failed'}`, 'var(--red)');
          break;
        }
      }

      done++;
      tick();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(REPULL_CONCURRENCY, ids.length) }, worker)
  );

  if (ok) { scheduleSave(); renderAll(); }

  _repull.running = false;
  if (cancelBtn) cancelBtn.style.display = 'none';
  if (startBtn)  startBtn.disabled = false;

  statusEl.style.color = ok ? 'var(--green-mid)' : 'var(--muted)';
  statusEl.textContent = _repull.cancel
    ? `Stopped — ${ok} recovered before cancelling.`
    : `Done — ${ok} recovered, ${noImg} with no image, ${failed} failed` +
      (blocked ? `, ${blocked} blocked by the site.` : '.');
  if (ok) showToast(`Recovered ${ok} image${ok === 1 ? '' : 's'} ✓`);

  await refreshRepullCounts();
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
  const blocked = importGuardBlocked();
  if (blocked) { showToast(blocked); return; }

  const btn          = document.getElementById('mealie-import-zip-btn');
  const embedImages  = document.getElementById('mealie-import-images')?.checked ?? true;
  const importExtras = document.getElementById('mealie-import-plans')?.checked ?? true;
  const status       = document.getElementById('mealie-import-status');

  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

  const result = await importFromMealieBackup(file, embedImages, importExtras);

  if (btn) { btn.disabled = false; btn.textContent = 'Import from Backup'; }

  if (result.ok) {
    saveLocal();
    renderAll();
    closeModal('modal-mealie-import');
    const bits = [`${result.count} recipes`];
    if (result.plans?.placed) bits.push(`${result.plans.placed} planned meals`);
    if (result.favCount)      bits.push(`${result.favCount} favorites`);
    if (result.rateCount)     bits.push(`${result.rateCount} ratings`);
    showToast(`✅ Imported ${bits.join(', ')} from Mealie backup`);
    if (result.plans?.unmatched) {
      console.warn(`[Refectory] ${result.plans.unmatched} meal plan entries referenced recipes not in the backup`);
    }
    // Push to worker immediately — don't wait for the next sync interval
    if (!Auth.isGuest()) {
      App.pendingSync = true;
      syncToWorker().then(ok => {
        if (ok) showToast('Recipes synced to worker ✓');
        else    console.warn('[Refectory] Post-import worker push failed — will retry on next sync');
      });
    }
  } else {
    if (status) { status.textContent = result.error; status.style.color = 'var(--red)'; }
  }
}

// ─── Mealie backup zip parser ─────────────────────────────────────

// ─── Mealie meal plan import ──────────────────────────────────────
// Mealie stores one row per planned dish keyed by calendar date, and allows
// several rows on the same date and meal type — cooking two dinners so one can
// be frozen is a normal plan, not a mistake. Refectory slots hold multiple
// entries, so nothing has to be dropped.
const MEALIE_SLOT_MAP = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', side: 'snack' };

// "2024-05-13" -> a local-midnight Date. Deliberately not new Date(str): that
// parses a bare ISO date as UTC, which in any negative-offset zone lands on the
// previous day locally and would shift every entry a day earlier.
function parseLocalDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

// Mealie timestamps are ISO strings ("2023-07-10T19:35:12.592956") or bare
// dates. Returns null rather than NaN so callers can fall through cleanly.
function mealieDate(v) {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function importMealieMealPlans(data, idMap) {
  const rows = (data.group_meal_plans || []).filter(r => r.recipe_id && r.date);
  if (!rows.length) return { placed: 0, skipped: 0, slots: 0, unmatched: 0 };

  // created_at order decides position within a slot, so the dish planned first
  // stays first — that's the one the day reads as its main meal.
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const staged  = {};
  const cooked  = {};
  const todayMs = new Date().setHours(23, 59, 59, 999);
  let placed = 0, unmatched = 0, skipped = 0;

  for (const row of rows) {
    const newId = idMap[row.recipe_id];
    if (!newId) { unmatched++; continue; }
    const date = parseLocalDate(row.date);
    if (!date) { skipped++; continue; }

    const wk   = getISOWeekKey(date);
    const day  = (date.getDay() + 6) % 7;            // Mon=0, matches the planner
    const slot = MEALIE_SLOT_MAP[row.entry_type] || 'dinner';

    staged[wk]            = staged[wk]            || {};
    staged[wk][day]       = staged[wk][day]       || {};
    staged[wk][day][slot] = staged[wk][day][slot] || [];
    staged[wk][day][slot].push(newId);
    placed++;

    // A meal planned for next week hasn't been cooked yet, so future dates must
    // not stamp lastCooked.
    const ts = date.getTime();
    if (ts <= todayMs && (!cooked[newId] || cooked[newId] < ts)) cooked[newId] = ts;
  }

  // Write staged slots wholesale rather than appending, so running the import
  // twice doesn't double every entry.
  if (!App.data.mealplan) App.data.mealplan = {};
  let slots = 0;
  for (const [wk, days] of Object.entries(staged)) {
    App.data.mealplan[wk] = App.data.mealplan[wk] || {};
    for (const [day, slotsObj] of Object.entries(days)) {
      App.data.mealplan[wk][day] = App.data.mealplan[wk][day] || {};
      for (const [slot, entries] of Object.entries(slotsObj)) {
        const packed = packSlot(entries);
        if (packed === null) continue;
        App.data.mealplan[wk][day][slot] = packed;
        slots++;
      }
    }
  }

  // lastCooked comes from the plan history, never Date.now() — importing three
  // years of meals must not mark every recipe as cooked today.
  for (const [id, ts] of Object.entries(cooked)) {
    const r = App.data.recipes?.[id];
    if (r && (!r.lastCooked || r.lastCooked < ts)) r.lastCooked = ts;
  }

  return { placed, skipped, slots, unmatched };
}

async function importFromMealieBackup(file, embedImages, importExtras = true) {
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

  // Nutrition is one row per recipe. Mealie stores every figure as a string and
  // blanks as empty string, so coerce and drop anything non-numeric.
  const nutriByRecipe = {};
  (data.recipe_nutrition || []).forEach(n => {
    const num = v => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };
    const vals = {
      calories: num(n.calories),
      fat:      num(n.fat_content),
      protein:  num(n.protein_content),
      carbs:    num(n.carbohydrate_content),
      fiber:    num(n.fiber_content),
      sodium:   num(n.sodium_content),
      sugar:    num(n.sugar_content),
    };
    if (Object.values(vals).every(v => v === null)) return;
    nutriByRecipe[n.recipe_id] = Object.fromEntries(
      Object.entries(vals).filter(([, v]) => v !== null));
  });

  // Favorites are per-user in Mealie, but a Refectory install is one shared
  // household record — so take the union across everyone in the group.
  const favIds = new Set((data.users_to_favorites || []).map(f => f.recipe_id));

  // Mealie id -> Refectory id, built as recipes are written. Meal plan rows
  // reference Mealie ids, so this is what lets the plan import resolve them
  // without persisting a source id on every recipe.
  const idMap = {};

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

    // Auto-detect mealType from tags/categories
    const mealKeywords = { breakfast: ['breakfast','brunch','morning'], lunch: ['lunch','midday'], dinner: ['dinner','supper','main course','entree','entrée'], snack: ['snack','appetizer','side','dessert','treat'] };
    let mealType = '';
    outer: for (const [type, keywords] of Object.entries(mealKeywords)) {
      for (const tag of recipeTags) {
        if (keywords.some(kw => tag.toLowerCase().includes(kw))) { mealType = type; break outer; }
      }
    }

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
    // Match on Mealie's own id first. Title matching was the only signal
    // available before sourceId was stored, and it fails the moment an import
    // runs against a store that hasn't loaded yet — which produces a second
    // full copy of the library under fresh random ids. Storing the source id
    // costs ~20 bytes per recipe and makes re-imports idempotent by identity
    // rather than by name.
    const all = Object.values(App.data.recipes);
    const existing =
      all.find(ex => ex.sourceId === rid && ex.importedFrom === 'mealie-backup') ||
      all.find(ex => ex.importedFrom === 'mealie-backup' && !ex.sourceId && ex.title === r.name);
    const newId    = existing ? existing.id : genId();
    idMap[rid]     = newId;

    // Rating carries over as-is (Mealie uses the same 0–5 scale). Favorite is
    // Mealie's own per-user flag, unioned across the household.
    const rating    = Number.isFinite(r.rating) ? r.rating : 0;
    const favorite  = favIds.has(rid);
    const nutrition = nutriByRecipe[rid] || null;

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
        mealType: mealType || existing.mealType || '',
        importedFrom: 'mealie-backup',
        updatedAt:   Date.now(),
      });
      // Backfill identity onto records imported before sourceId existed, so
      // the next import matches by id and can't duplicate them again.
      existing.sourceId = rid;
      if (importExtras) {
        // Only overwrite a local rating when Mealie actually has one, so a
        // rating added in Refectory isn't wiped by a re-import.
        if (rating)    existing.rating   = rating;
        if (favorite)  existing.favorite = true;
        if (nutrition) existing.nutrition = nutrition;
      }
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
        tags, ingredients, steps, mealType,
        importedFrom: 'mealie-backup',
        sourceId:    rid,
        // Mealie's own creation date, so "Recently added" reflects when the
        // recipe actually entered the collection rather than when it was
        // migrated — otherwise every imported recipe shares one timestamp.
        createdAt:   mealieDate(r.created_at) || mealieDate(r.date_added) || Date.now(),
        updatedAt:   Date.now(),
        ...(importExtras && rating    ? { rating }           : {}),
        ...(importExtras && favorite  ? { favorite: true }   : {}),
        ...(importExtras && nutrition ? { nutrition }        : {}),
      };
      count++;
    }
  }

  if (!count) return { ok: false, error: 'No recipes were found in the backup.' };

  // Meal plans go last — they resolve against idMap, so every recipe has to
  // exist first.
  let plans = null, favCount = 0, rateCount = 0, nutriCount = 0;
  if (importExtras) {
    status('Importing meal plans…');
    plans = importMealieMealPlans(data, idMap);
    for (const mealieId of Object.keys(idMap)) {
      const rec = App.data.recipes[idMap[mealieId]];
      if (!rec) continue;
      if (rec.favorite)  favCount++;
      if (rec.rating)    rateCount++;
      if (rec.nutrition) nutriCount++;
    }
  }

  scheduleSave();
  return { ok: true, count, skipped, plans, favCount, rateCount, nutriCount };
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

// ─── Print ───────────────────────────────────────────────────────

async function printRecipe(id) {
  const r = getRecipe(id);
  if (!r) return;

  // Title
  document.getElementById('print-title').textContent = r.title || '';

  // Tags
  const tagsEl = document.getElementById('print-tags');
  tagsEl.textContent = (r.tags || []).join(' · ');

  // Source
  const srcEl = document.getElementById('print-source');
  if (r.sourceUrl) {
    try {
      const u = new URL(r.sourceUrl);
      srcEl.textContent = u.hostname + u.pathname;
    } catch { srcEl.textContent = r.sourceUrl; }
  } else {
    srcEl.textContent = r.source || '';
  }

  // Image
  const imgEl = document.getElementById('print-image');
  const dataUrl = await resolveImage(id);
  if (dataUrl) {
    imgEl.src = dataUrl;
    imgEl.style.display = '';
  } else {
    imgEl.style.display = 'none';
  }

  // Meta chips — servings, prep, cook, total
  const metaEl = document.getElementById('print-meta');
  const chips = [];
  const chip = (label, val) => val
    ? `<div class="print-meta-chip"><span class="print-meta-chip-label">${label}</span><span>${esc(val)}</span></div>`
    : '';
  const servingsRaw = String(r.servings || '').trim();
  if (servingsRaw) chips.push(chip('Serves', servingsRaw));
  if (r.prepTime)  chips.push(chip('Prep',   r.prepTime));
  if (r.cookTime)  chips.push(chip('Cook',   r.cookTime));
  if (r.totalTime) chips.push(chip('Total',  r.totalTime));
  metaEl.innerHTML = chips.join('');

  // Description (strip markdown)
  const descEl = document.getElementById('print-desc');
  const desc = plainText(r.description || '');
  descEl.textContent = desc;
  descEl.style.display = desc ? '' : 'none';

  // Ingredients
  document.getElementById('print-ingredients').innerHTML =
    (r.ingredients || []).map(i =>
      `<li>${esc(ingredientText(i))}</li>`
    ).join('');

  // Steps
  document.getElementById('print-steps').innerHTML =
    (r.steps || []).map(s =>
      `<li>${esc(plainText(stepText(s)))}</li>`
    ).join('');

  // Notes — show only if present
  let printNotesEl = document.getElementById('print-notes');
  if (!printNotesEl) {
    printNotesEl = document.createElement('div');
    printNotesEl.id = 'print-notes';
    document.querySelector('.print-footer')?.before(printNotesEl);
  }
  if (r.notes?.trim()) {
    printNotesEl.innerHTML = `
      <div class="print-notes-title">My Notes</div>
      <div class="print-notes-text">${esc(r.notes)}</div>`;
    printNotesEl.style.display = '';
  } else {
    printNotesEl.style.display = 'none';
  }

  document.body.classList.add('printing-recipe');
  window.print();
  document.body.classList.remove('printing-recipe');
}

function openSettings() {
  Auth.renderSettingsSection();
  const d = App.data;
  document.getElementById('settings-firstname-input').value = d.firstName  || '';
  document.getElementById('settings-lastname-input').value  = d.lastName   || '';
  document.getElementById('settings-username-input').value  = d.username   || '';
  const workerEl = document.getElementById('settings-worker-url');
  if (workerEl) workerEl.value = d.workerUrl || '';
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
  const workerEl = document.getElementById('settings-worker-url');
  if (workerEl) App.data.workerUrl = workerEl.value.trim().replace(/\/+$/, '');
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

// ─── One-time migration: promote remote image links out of IndexedDB ──
// Historically every image — remote link or raw bytes — was written to
// IndexedDB, which is per-device and never syncs. A link is ~100 bytes and
// belongs on the recipe record so it travels with the rest of the data.
// Bytes stay where they are.
async function migrateImageUrls() {
  if ((App.data.imageUrlMigration || 0) >= 1) return;
  let moved = 0;
  for (const id of Object.keys(App.data.recipes || {})) {
    const r = App.data.recipes[id];
    if (!r || r.imageUrl) continue;
    let val;
    try { val = await ImageStore.get(id); } catch { continue; }
    if (!val || val.startsWith('data:')) continue;
    r.imageUrl = val;
    moved++;
  }
  App.data.imageUrlMigration = 1;
  scheduleSave();
  if (moved) {
    renderAll();
    showToast(`Recovered ${moved} image link${moved === 1 ? '' : 's'} ✓`);
  }
}

function renderAll() {
  renderStorageBanner();
  renderRecipes();
  if (View.activeSection === 'planner')   renderPlanner();
  if (View.activeSection === 'shopping')  renderShoppingList();
  if (View.activeSection === 'cookbooks') renderCookbooks();
  renderTodaysMealsTrigger();
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

  // Re-pin any Monday-anchored templates in the local store. Runs again after
  // the worker pull, since that can bring in un-migrated records too.
  migrateTemplateAnchors();

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
    App.bootPullDone   = true;   // nothing to load — an empty store is correct here
    App.bootPullLoaded = true;
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
        // Local wins, but don't discard an image link the remote copy has
        // and this device hasn't migrated yet.
        merged[id] = (!localR.imageUrl && remoteR?.imageUrl)
          ? { ...localR, imageUrl: remoteR.imageUrl }
          : localR;
      } else {
        // Remote wins on recency — but taking it wholesale threw away image
        // links recovered locally. An imageUrl the remote lacks is strictly
        // new information, never a stale value worth discarding, so graft it
        // on rather than losing a re-pull's results to any later edit.
        merged[id] = (localR.imageUrl && !remoteR.imageUrl)
          ? { ...remoteR, imageUrl: localR.imageUrl }
          : remoteR;
      }
    }
    App.data = mergeData({ ...remote, recipes: merged });
    saveLocal();
    // Push merged result back to worker so it stays in sync
    if (Object.keys(localRecipes).length > Object.keys(remoteRecipes).length) {
      pushToWorker();
    }
  }

  // The boot pull has settled — either remote data merged in, or we know it
  // didn't arrive. Imports are gated on this: running one against a store that
  // hasn't loaded yet is how an entire library gets imported a second time
  // under fresh ids, because there's nothing in memory to match against.
  App.bootPullDone   = true;
  App.bootPullLoaded = !!remote;

  const ok = await Auth.bootCheck(tokenBeforePull);
  if (!ok) return;

  // Run before the first render: a template pulled from the worker may still
  // be Monday-anchored even if this device migrated its local copy already.
  migrateTemplateAnchors();

  renderAll();
  migrateImageUrls();
  if (!Auth.isGuest()) startSyncPing();
}

// ─── Event wiring ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });

  // Recipe search
  document.getElementById('planner-templates')?.addEventListener('click', openTemplatesModal);
  document.getElementById('planner-share')?.addEventListener('click', openSharePlanModal);
  document.getElementById('btn-find-dupes')?.addEventListener('click', () => {
    closeModal('modal-mealie-import');
    openDedupeModal();
  });
  document.getElementById('bulk-group-btn')?.addEventListener('click', () => {
    const ids = [...View.selectedRecipeIds];
    // Exclusive membership: regrouping has to be an explicit ungroup first, so
    // a recipe can never appear under two collapsed cards.
    const already = ids.filter(id => groupForRecipe(id));
    if (already.length) {
      showToast(`${already.length} of those ${already.length === 1 ? 'is' : 'are'} already in a group — ungroup ${already.length === 1 ? 'it' : 'them'} first.`);
      return;
    }
    openGroupEditor(null, ids);
  });
  document.getElementById('group-save')?.addEventListener('click', saveGroupFromEditor);
  document.getElementById('group-cancel')?.addEventListener('click', () => {
    _groupDraft = null; closeModal('modal-group-editor');
  });
  document.getElementById('group-delete')?.addEventListener('click', async () => {
    if (!_groupDraft?.id) return;
    const g = getGroup(_groupDraft.id);
    if (!await appConfirm({
      title: 'Ungroup these recipes?',
      message: `“${g?.name || 'This group'}” will be removed. The recipes themselves are kept and go back to showing individually.`,
      confirmLabel: 'Ungroup', danger: true,
    })) return;
    deleteGroup(_groupDraft.id);
    _groupDraft = null;
    closeModal('modal-group-editor');
    renderRecipes();
    showToast('Ungrouped ✓');
  });

  document.getElementById('confirm-ok')?.addEventListener('click', () => _settleConfirm(true));
  document.getElementById('confirm-cancel')?.addEventListener('click', () => _settleConfirm(false));
  document.getElementById('confirm-copy-btn')?.addEventListener('click', async () => {
    const el = document.getElementById('confirm-copy-value');
    if (!el?.value) return;
    try { await navigator.clipboard.writeText(el.value); showToast('Copied ✓'); }
    catch { el.select(); document.execCommand('copy'); showToast('Copied ✓'); }
  });
  // Escape must resolve the promise, not just hide the modal, or the caller
  // waits forever and the app appears to hang.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _confirmResolve) _settleConfirm(false);
  });

  document.getElementById('dedupe-go')?.addEventListener('click', runDedupe);
  document.getElementById('dedupe-cancel')?.addEventListener('click', () => closeModal('modal-dedupe'));
  document.getElementById('choice-paste-text')?.addEventListener('click', () => {
    closeModal('modal-new-recipe-choice');
    openPasteRecipeModal();
  });
  document.getElementById('paste-recipe-text')?.addEventListener('input', updatePasteHint);
  document.getElementById('paste-recipe-go')?.addEventListener('click', submitPastedRecipe);
  document.getElementById('paste-recipe-cancel')?.addEventListener('click', () => closeModal('modal-paste-recipe'));
  document.getElementById('share-range')?.addEventListener('change', updateShareHint);
  document.getElementById('share-from')?.addEventListener('change', updateShareHint);
  document.getElementById('share-to')?.addEventListener('change', updateShareHint);
  document.getElementById('share-create')?.addEventListener('click', createSharePlanLink);
  document.getElementById('share-cancel')?.addEventListener('click', () => closeModal('modal-share-plan'));
  document.getElementById('share-copy')?.addEventListener('click', async () => {
    const el = document.getElementById('share-url');
    if (!el?.value) return;
    try { await navigator.clipboard.writeText(el.value); showToast('Link copied ✓'); }
    catch { el.select(); document.execCommand('copy'); showToast('Link copied ✓'); }
  });
  document.getElementById('tpl-weeks')?.addEventListener('change', updateTemplateSaveHint);
  document.getElementById('tpl-from')?.addEventListener('change', updateTemplateSaveHint);
  document.getElementById('tpl-to')?.addEventListener('change', updateTemplateSaveHint);
  document.getElementById('tpl-save-btn')?.addEventListener('click', () => {
    const name = document.getElementById('tpl-name')?.value || '';
    const span = currentTemplateSpan();
    if (span.error) { showToast(span.error); return; }
    const res  = saveTemplate(name, span.startWeek, span.weeks, span.range);
    if (!res.ok) { showToast(res.error); return; }
    document.getElementById('tpl-name').value = '';
    renderTemplateList();
    showToast(`Saved template with ${res.count} meal${res.count === 1 ? '' : 's'} ✓`);
  });

  document.getElementById('recipe-sort')?.addEventListener('change', e => {
    View.recipeSort = e.target.value;
    renderRecipes();
  });

  document.getElementById('recipe-search')?.addEventListener('input', e => {
    View.recipeSearch = e.target.value;
    renderRecipes();
  });

  // New recipe button
  document.getElementById('btn-new-recipe')?.addEventListener('click', openNewRecipeChoice);
  document.getElementById('btn-select-mode')?.addEventListener('click', toggleSelectMode);
  document.getElementById('modal-bulk-tag')?.querySelector('.modal-close')
    ?.addEventListener('click', () => closeModal('modal-bulk-tag'));
  document.getElementById('modal-bulk-cookbook')?.querySelector('.modal-close')
    ?.addEventListener('click', () => closeModal('modal-bulk-cookbook'));

  // Shopping list print modals
  document.getElementById('modal-shopping-print')?.querySelector('.modal-close')
    ?.addEventListener('click', () => closeModal('modal-shopping-print'));
  document.getElementById('modal-shopping-print-pick')?.querySelector('.modal-close')
    ?.addEventListener('click', () => closeModal('modal-shopping-print-pick'));
  document.getElementById('print-mode-default')?.addEventListener('click', () => {
    closeModal('modal-shopping-print');
    printShoppingLists(['default']);
  });
  document.getElementById('print-mode-all')?.addEventListener('click', () => {
    closeModal('modal-shopping-print');
    const allIds = ['default', ...getShoppingStores().map(s => s.id)];
    printShoppingLists(allIds);
  });
  document.getElementById('print-mode-specific')?.addEventListener('click', openShoppingPrintPicker);
  document.getElementById('shopping-print-pick-confirm')?.addEventListener('click', () => {
    const ids = [...document.querySelectorAll('.print-pick-cb:checked')].map(cb => cb.value);
    closeModal('modal-shopping-print-pick');
    if (!ids.length) { showToast('Select at least one list to print.'); return; }
    printShoppingLists(ids);
  });
  document.getElementById('bulk-tag-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') applyBulkTag('add');
  });

  // New recipe choice modal
  document.getElementById('choice-import-url')?.addEventListener('click', openUrlImport);
  document.getElementById('choice-create-manual')?.addEventListener('click', () => {
    closeModal('modal-new-recipe-choice');
    openRecipeEditor(null);
  });
  document.getElementById('modal-new-recipe-choice')?.querySelector('.modal-close')
    ?.addEventListener('click', () => closeModal('modal-new-recipe-choice'));

  // URL import modal
  document.getElementById('url-import-fetch-btn')?.addEventListener('click', fetchAndScrapeUrl);
  document.getElementById('url-import-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchAndScrapeUrl();
  });
  document.getElementById('modal-url-import')?.querySelector('.modal-close')
    ?.addEventListener('click', () => closeModal('modal-url-import'));

  // Import button
  document.getElementById('btn-import-mealie')?.addEventListener('click', openMealieImport);
  document.getElementById('btn-export')?.addEventListener('click', () => openExportModal());

  // Export modal — option selection and go button
  document.getElementById('export-opt-full')?.addEventListener('click',   () => selectExportMode('full'));
  document.getElementById('export-opt-images')?.addEventListener('click', () => selectExportMode('images'));
  document.getElementById('btn-export-go')?.addEventListener('click', () => runExport(_bulkExportIds));
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

  document.getElementById('btn-save-recipe').onclick = saveEditorRecipe;

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
    View.currentWeek = displayWeekKeyFor();
    View.plannerDay  = new Date().getDay();
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

  document.getElementById('modal-tag-manager')?.querySelector('.modal-close')
    ?.addEventListener('click', () => closeModal('modal-tag-manager'));

  // Cookbooks
  document.getElementById('btn-new-cookbook')?.addEventListener('click', () => openCookbookEditor(null));
  document.getElementById('cookbook-editor-save')?.addEventListener('click', saveCookbook);
  document.getElementById('cookbook-editor-cancel')?.addEventListener('click', () => closeModal('modal-cookbook-editor'));
  document.getElementById('modal-cookbook-editor')?.querySelector('.modal-close')?.addEventListener('click', () => closeModal('modal-cookbook-editor'));
  document.getElementById('modal-cookbook-detail')?.querySelector('.modal-close')?.addEventListener('click', () => closeModal('modal-cookbook-detail'));
  document.getElementById('modal-cookbook-pick')?.querySelector('.modal-close')?.addEventListener('click', () => closeModal('modal-cookbook-pick'));
  document.getElementById('cookbook-add-recipe-btn')?.addEventListener('click', () => {
    if (_openCookbookId) openCookbookPick(_openCookbookId);
  });
  document.getElementById('cookbook-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveCookbook(); });

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
  document.getElementById('modal-settings')?.addEventListener('click', async e => {
    if (e.target.id === 'btn-clear-imported') {
      if (await appConfirm({
        title: 'Remove imported recipes?',
        message: 'Every recipe brought in from Mealie will be deleted. Hand-entered recipes are kept.',
        confirmLabel: 'Remove imported', danger: true,
      })) {
        clearImportedRecipes();
      }
    }
    if (e.target.id === 'btn-wipe-recipes') {
      if (await appConfirm({
        title: 'Delete everything?',
        message: 'All recipes and meal plans will be permanently deleted. This cannot be undone.',
        confirmLabel: 'Delete everything', danger: true,
      })) {
        wipeAllRecipes();
      }
    }
  });
  document.getElementById('settings-save-btn')?.addEventListener('click', saveSettings);
  document.getElementById('settings-account-btn')?.addEventListener('click', () => {
    closeModal('modal-settings');

    // Guests have no account yet, so "switch" means "create one".
    if (Auth.isGuest()) { Auth.showSetupFresh(); return; }

    // Everyone else goes to the account setup screen, which is the only place
    // offering "load my existing account" — sign in with Google, or join with
    // a token. Token accounts used to be sent to the Google *upgrade* flow
    // instead, which is what the separate "Upgrade to Google sign-in" button
    // already does, and which refuses outright when a Google account for that
    // address already exists. That left a device with a token account no route
    // to any other account at all.
    const token = App.data?.userToken;
    const isToken = Auth.isTokenAccount() && token;
    appConfirm({
      title: 'Switch or Create Account',
      message: isToken
        ? `Switching replaces the recipes on this device.\n\n` +
          `Save this account's token first — it is the only way back to its data.`
        : `Switching replaces the recipes on this device.\n\n` +
          `They stay safe in sync and come back when you sign in again.`,
      copyValue: isToken ? token : '',
      confirmLabel: 'Switch account',
      danger: true,
    }).then(go => {
      if (go) Auth.showAccountSetup();
      else openModal('modal-settings');
    });
  });

  // Mealie import tabs
  // Mealie import tabs
  document.getElementById('mealie-tab-backup')?.addEventListener('click',     () => switchMealieTab('backup'));
  document.getElementById('mealie-tab-json')?.addEventListener('click',       () => switchMealieTab('json'));
  document.getElementById('mealie-tab-api')?.addEventListener('click',        () => switchMealieTab('api'));
  document.getElementById('mealie-tab-refectory')?.addEventListener('click',  () => switchMealieTab('refectory'));
  document.getElementById('mealie-tab-repull')?.addEventListener('click',     () => switchMealieTab('repull'));
  document.getElementById('btn-repull-start')?.addEventListener('click',      runImageRepull);
  document.getElementById('btn-repull-cancel')?.addEventListener('click',     () => { _repull.cancel = true; });
  document.getElementById('repull-all')?.addEventListener('change',           () => { if (!_repull.running) refreshRepullCounts(); });

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

  // Today's Meals — toggle drawer; clicking the label again while open closes it
  document.getElementById('btn-todays-meals')?.addEventListener('click', toggleTodaysMealsDrawer);

  // Safety save when tab is hidden or page is closing
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && App.data) saveLocal();
  });
  window.addEventListener('pagehide', () => {
    if (App.data) saveLocal();
  });

  // Re-render planner on resize (fold open/close)
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (View.activeSection === 'planner') renderPlanner();
    }, 150);
  });

  boot();
});
