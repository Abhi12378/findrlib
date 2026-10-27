const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const STORAGE_BOOKMARKS = "resourcefinder.bookmarks.v1";
const STORAGE_COLLECTIONS = "resourcefinder.collections.v1";
const SEARCH_SOURCES = ["github","videos","web","books","papers","documents","tools"];
const SOURCE_HEALTH_KEY = "resourcefinder.source-health.v1";
const state = {
  view: "home", profile: {id:"guest", name:"Guest"}, history: [], supportEmail:"", sourceHealth:{}, catalogRefresh: null, nightlyInstalled: false, googleReady: false, hosted: location.hostname.endsWith(".netlify.app"), backgroundCrawler: true, videoMetadata: true, availableSources: null, tab: "all", query: "", catalog: [], catalogTotal: 0,
  catalogOffset: 0, catalogLoading: false, catalogError: false, featured: [], live: {}, crawled: [], loading: new Set(), showLimit: 30,
  crawl: null, checkedUrls: new Set(), loadingMore: false, pendingCrawl: false,
  bookmarks: [],
  collections: [],
  collectionId: null, currentItem: null, searchVersion: 0
};
const resourceMap = new Map();
let toastTimer;
let dialogReturnFocus = null;

function loadStored(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}
function workspaceKey() {
  return "resourcefinder.workspace.v2." + state.profile.id;
}
function isAuthenticated() { return state.profile.id !== "guest"; }
function loadWorkspace(profile) {
  state.profile = profile;
  let data = null;
  if (profile.id !== "guest") {
    try { data = JSON.parse(localStorage.getItem(workspaceKey()) || "null"); } catch { data = null; }
  }
  state.bookmarks = Array.isArray(data?.bookmarks) ? data.bookmarks : [];
  state.collections = Array.isArray(data?.collections) ? data.collections : [];
  state.history = Array.isArray(data?.history) ? data.history : [];
  state.collectionId = null;
  updateSavedCount();
  renderHome();
  if (state.view === "saved" || state.view === "collections") render();
}
function saveStored() {
  if (isAuthenticated()) {
    try {
      localStorage.setItem(workspaceKey(), JSON.stringify({
        bookmarks:state.bookmarks, collections:state.collections, history:state.history
      }));
    } catch { showToast("Browser storage is full. Export your bookmarks for backup."); }
  }
  updateSavedCount();
  renderHome();
}
function renderHome() {
  const signedIn = isAuthenticated();
  $("#privateHome").hidden = !signedIn;
  $("#accountAccess").hidden = signedIn;
  $("#profileWrap").hidden = !signedIn;
  $("#topSaved").hidden = !signedIn;
  $$(".public-auth-action").forEach((node) => { node.hidden = signedIn; });
  $$(".private-nav, .sidebar-bottom-card").forEach((node) => { node.hidden = !signedIn; });
  $("#profileName").textContent = signedIn ? state.profile.name : "Guest";
  $("#topProfile").textContent = signedIn ? state.profile.name + " ▾" : "Profile";
  $("#homeSavedCount").textContent = state.bookmarks.length;
  $("#homeCollectionCount").textContent = state.collections.length;
  $("#accountHeading").textContent = signedIn ? "Welcome back, " + state.profile.name : "Your research, organized.";
  $("#accountDescription").textContent = signedIn ?
    "Your signed-in workspace is saved in this browser and opens again after a verified Google sign-in." : "";
  $("#homeWorkspaceSummary").textContent = signedIn ?
    "Saved locally for " + state.profile.name + " on this browser." : "";
  renderSupport();
  $("#recentSearches").innerHTML = state.history.length ?
    state.history.slice(0, 8).map((entry) => '<button class="recent-query" data-recent="' +
      escapeHtml(entry.q) + '"><span>' + assetIcon("search", "recent-icon") + '</span>' + escapeHtml(entry.q) + '</button>').join("") :
    '<p class="empty-recent">Your recent searches will appear here.</p>';
}
function renderFeatured() {
  const items = state.featured.slice(0, 3);
  register(items);
  $("#featuredGrid").innerHTML = items.length ? items.map(cardHtml).join("") :
    '<div class="empty-state"><h3>Indexed examples unavailable</h3><p>Explore live sources or refresh the API catalog.</p></div>';
}
function renderRefresh(info) {
  state.catalogRefresh = info;
  if (!info) return;
  $("#homeCatalogCount").textContent = info.catalog_count.toLocaleString() + " APIs indexed";
  $("#catalogStat").textContent = info.catalog_count.toLocaleString() + " APIs indexed";
  $("#refreshNow").disabled = !!info.running;
  if (state.hosted) {
    $("#refreshNow").hidden = true;
    $("#refreshStatus").textContent = "Catalog bundled on " + new Date(info.last_success).toLocaleDateString() + ". A new deploy updates the index.";
    return;
  }
  const when = info.last_success ? new Date(info.last_success).toLocaleString() : "not yet";
  const schedule = state.nightlyInstalled ? " A Windows task also checks at local midnight while the app is closed." :
    " Checks at local midnight while the app runs; install the included Windows task for closed-app refresh.";
  $("#refreshStatus").textContent = info.running ? "Checking Public APIs for new listings…" :
    info.last_error ? "The latest catalog check could not finish. The saved catalog is still available. Last refreshed " + when + "." + schedule :
    "Last refreshed " + when + ". " + (info.new_entries || 0) + " newly listed APIs on the last update." + schedule;
}
function renderHealth(snapshot) {
  const node = $("#providerHealth");
  if (!node) return;
  const providers = snapshot?.providers || state.sourceHealth;
  const observed = SEARCH_SOURCES.filter((source) => providers[source] && providers[source].status !== "unobserved");
  if (!observed.length) {
    $("#healthBadgeText").textContent = "Awaiting search";
    $("#agentStatus").textContent = "Sources checked on search";
    node.innerHTML = '<div class="health-empty">Run a search to check all seven sources. Recent results will appear here.</div>';
    return;
  }
  const labels = {github:"GitHub", videos:"YouTube", web:"Web", books:"Open Library", papers:"Research paper", documents:"Documents", tools:"Tools & apps"};
  const failing = observed.filter((source) => ["degraded","down"].includes(providers[source].status)).length;
  $("#healthBadgeText").textContent = observed.length + " of " + SEARCH_SOURCES.length + " checked";
  $("#agentStatus").textContent = failing ? failing + " source" + (failing === 1 ? "" : "s") + " need attention" : "Recent source checks available";
  node.innerHTML = SEARCH_SOURCES.map((key) => {
    const info = providers[key] || {status:"unobserved"};
    const latency = info.response_ms == null && info.median_ms == null ? "" :
      " · " + (info.response_ms == null ? "median " : "response ") + (info.response_ms ?? info.median_ms) + " ms";
    const checked = info.checked_at ? " · " + new Date(info.checked_at).toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}) : "";
    const detail = info.reason || (info.status === "unobserved" ? "Not checked yet" :
      info.status === "down" ? "Request failed" :
      info.status === "degraded" ? "Provider returned limited results" : "Responding");
    return '<div class="health-row"><strong>' + escapeHtml(labels[key]) + '</strong><span class="health-state ' +
      escapeHtml(info.status) + '">' + escapeHtml(info.status === "unobserved" ? "pending" : info.status) +
      '</span><small>' + escapeHtml(detail + latency + checked) + '</small></div>';
  }).join("");
}
function restoreSourceHealth() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SOURCE_HEALTH_KEY) || "null");
    if (saved && typeof saved === "object") for (const source of SEARCH_SOURCES) {
      const item = saved[source];
      if (item && ["healthy","degraded","down"].includes(item.status) &&
          Number.isFinite(Date.parse(item.checked_at)) && Date.now() - Date.parse(item.checked_at) < 30 * 60 * 1000)
        state.sourceHealth[source] = item;
    }
  } catch { /* Private browsing may restrict session storage. */ }
}
function recordSourceHealth(source, data, elapsed) {
  const issue = Boolean(data?.error || data?.provider_issue);
  state.sourceHealth[source] = {
    status: issue ? (data?.items?.length ? "degraded" : "down") : "healthy",
    response_ms: Math.round(elapsed), checked_at: new Date().toISOString(),
    reason: issue ? (data?.items?.length ? "Partial provider response" : "Provider unavailable") : "Responding"
  };
  try { sessionStorage.setItem(SOURCE_HEALTH_KEY, JSON.stringify(state.sourceHealth)); } catch {}
  if (state.hosted) renderHealth({providers:state.sourceHealth});
}
function renderSupport() {
  const node = $("#supportStatus");
  if (!node) return;
  node.textContent = isAuthenticated() ?
    "Signed in as " + (state.profile.email || state.profile.name) + ". Send your message to saaiabhishikth@gmail.com." :
    "Sign in with Google to send a message to saaiabhishikth@gmail.com.";
}

async function pollRefresh() {
  try {
    const status = await getJson("/api/status");
    renderRefresh(status.catalog_refresh);
    if (status.catalog_refresh?.running) setTimeout(pollRefresh, 2500);
  } catch { $("#refreshStatus").textContent = "Catalog status unavailable."; }
}
async function setupGoogle(clientId) {
  if (!clientId) { $("#googleHint").textContent = "Google sign-in is not configured."; return; }
  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.onload = () => {
    if (!window.google?.accounts?.id) { $("#googleHint").textContent = "Google sign-in could not load."; return; }
    google.accounts.id.initialize({client_id:clientId, callback:async ({credential}) => {
      try {
        const response = await fetch("/api/auth/google", {method:"POST",
          headers:{"Content-Type":"application/json"}, body:JSON.stringify({credential})});
        if (!response.ok) throw new Error("Verification failed");
        const person = await response.json();
        loadWorkspace({id:"google." + person.sub, name:person.name || "Google user", email:person.email});
        closeProfileMenu();
        setView("home");
        showToast("Google workspace opened");
      } catch { showToast("Google sign-in could not be verified"); }
    }});
    google.accounts.id.renderButton($("#googleButton"), {theme:"outline", size:"large", text:"signin_with", width:240});
    state.googleReady = true;
  };
  script.onerror = () => { $("#googleHint").textContent = "Google sign-in is unavailable. Check your connection and authorized origin."; };
  document.head.appendChild(script);
}
function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "#";
  } catch { return "#"; }
}
function typeLabel(type) {
  return ({api:"API", library:"GitHub library", video:"Video", book:"Book", paper:"Open-access paper", website:"Website", documentation:"Documentation", platform:"Platform"})[type] || "Resource";
}
// Bundled SVGs retain their upstream attribution in assets/icons/ATTRIBUTION.md.
const ICON_DATA = Object.freeze({"book-marked":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWJvb2stbWFya2VkIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMTAgMnY3Ljc1MWEuMjUuMjUgMCAwMC40MDcuMTk1bDIuMjgtMS44MzRhLjUuNSAwIDAxLjYyNyAwbDIuMjggMS44MzRBLjI1LjI1IDAgMDAxNiA5Ljc1MVYyIiAvPg0KICA8cGF0aCBkPSJNNCAxOS41di0xNUEyLjUgMi41IDAgMDE2LjUgMkgxOWExIDEgMCAwMTEgMXYxOGExIDEgMCAwMS0xIDFINi41YTEgMSAwIDAxMC01SDIwIiAvPg0KPC9zdmc+DQo=","book-open":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWJvb2stb3BlbiINCiAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIg0KICB3aWR0aD0iMjQiDQogIGhlaWdodD0iMjQiDQogIHZpZXdCb3g9IjAgMCAyNCAyNCINCiAgZmlsbD0ibm9uZSINCiAgc3Ryb2tlPSIjMGI5ZDhiIg0KICBzdHJva2Utd2lkdGg9IjIiDQogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCINCiAgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCINCj4NCiAgPHBhdGggZD0iTTEyIDV2MTYiIC8+DQogIDxwYXRoIGQ9Ik0yMC4wMDEgMTlBMiAyIDAgMDAyMiAxN1Y1YTIgMiAwIDAwLTEuOTk5LTJMMTYgMy4wMDJBNSA1IDAgMDAxMiA1YTUgNSAwIDAwLTQtMkg0YTIgMiAwIDAwLTIgMnYxMmEyIDIgMCAwMDEuOTk5IDJIOGE1IDUgMCAwMTQgMiA1IDUgMCAwMTQtMnoiIC8+DQo8L3N2Zz4NCg==","bookmark-check":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWJvb2ttYXJrLWNoZWNrIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMTcgM2EyIDIgMCAwIDEgMiAydjE1YTEgMSAwIDAgMS0xLjQ5Ni44NjhsLTQuNTEyLTIuNTc4YTIgMiAwIDAgMC0xLjk4NCAwbC00LjUxMiAyLjU3OEExIDEgMCAwIDEgNSAyMFY1YTIgMiAwIDAgMSAyLTJ6IiAvPg0KICA8cGF0aCBkPSJtOSAxMCAyIDIgNC00IiAvPg0KPC9zdmc+DQo=","bookmark":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWJvb2ttYXJrIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMTcgM2EyIDIgMCAwIDEgMiAydjE1YTEgMSAwIDAgMS0xLjQ5Ni44NjhsLTQuNTEyLTIuNTc4YTIgMiAwIDAgMC0xLjk4NCAwbC00LjUxMiAyLjU3OEExIDEgMCAwIDEgNSAyMFY1YTIgMiAwIDAgMSAyLTJ6IiAvPg0KPC9zdmc+DQo=","boxes":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWJveGVzIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMi45NyAxMi45MkEyIDIgMCAwIDAgMiAxNC42M3YzLjI0YTIgMiAwIDAgMCAuOTcgMS43MWwzIDEuOGEyIDIgMCAwIDAgMi4wNiAwTDEyIDE5di01LjVsLTUtMy00LjAzIDIuNDJaIiAvPg0KICA8cGF0aCBkPSJtNyAxNi41LTQuNzQtMi44NSIgLz4NCiAgPHBhdGggZD0ibTcgMTYuNSA1LTMiIC8+DQogIDxwYXRoIGQ9Ik03IDE2LjV2NS4xNyIgLz4NCiAgPHBhdGggZD0iTTEyIDEzLjVWMTlsMy45NyAyLjM4YTIgMiAwIDAgMCAyLjA2IDBsMy0xLjhhMiAyIDAgMCAwIC45Ny0xLjcxdi0zLjI0YTIgMiAwIDAgMC0uOTctMS43MUwxNyAxMC41bC01IDNaIiAvPg0KICA8cGF0aCBkPSJtMTcgMTYuNS01LTMiIC8+DQogIDxwYXRoIGQ9Im0xNyAxNi41IDQuNzQtMi44NSIgLz4NCiAgPHBhdGggZD0iTTE3IDE2LjV2NS4xNyIgLz4NCiAgPHBhdGggZD0iTTcuOTcgNC40MkEyIDIgMCAwIDAgNyA2LjEzdjQuMzdsNSAzIDUtM1Y2LjEzYTIgMiAwIDAgMC0uOTctMS43MWwtMy0xLjhhMiAyIDAgMCAwLTIuMDYgMGwtMyAxLjhaIiAvPg0KICA8cGF0aCBkPSJNMTIgOCA3LjI2IDUuMTUiIC8+DQogIDxwYXRoIGQ9Im0xMiA4IDQuNzQtMi44NSIgLz4NCiAgPHBhdGggZD0iTTEyIDEzLjVWOCIgLz4NCjwvc3ZnPg0K","braces":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWJyYWNlcyINCiAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIg0KICB3aWR0aD0iMjQiDQogIGhlaWdodD0iMjQiDQogIHZpZXdCb3g9IjAgMCAyNCAyNCINCiAgZmlsbD0ibm9uZSINCiAgc3Ryb2tlPSIjMGI5ZDhiIg0KICBzdHJva2Utd2lkdGg9IjIiDQogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCINCiAgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCINCj4NCiAgPHBhdGggZD0iTTggM0g3YTIgMiAwIDAgMC0yIDJ2NWEyIDIgMCAwIDEtMiAyIDIgMiAwIDAgMSAyIDJ2NWMwIDEuMS45IDIgMiAyaDEiIC8+DQogIDxwYXRoIGQ9Ik0xNiAyMWgxYTIgMiAwIDAgMCAyLTJ2LTVjMC0xLjEuOS0yIDItMmEyIDIgMCAwIDEtMi0yVjVhMiAyIDAgMCAwLTItMmgtMSIgLz4NCjwvc3ZnPg0K","circle-check":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWNpcmNsZS1jaGVjayINCiAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIg0KICB3aWR0aD0iMjQiDQogIGhlaWdodD0iMjQiDQogIHZpZXdCb3g9IjAgMCAyNCAyNCINCiAgZmlsbD0ibm9uZSINCiAgc3Ryb2tlPSIjMGI5ZDhiIg0KICBzdHJva2Utd2lkdGg9IjIiDQogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCINCiAgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCINCj4NCiAgPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIC8+DQogIDxwYXRoIGQ9Im0xNiA5LTUuNSA1LjVMOCAxMiIgLz4NCjwvc3ZnPg0K","circle-help":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWNpcmNsZS1oZWxwIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgLz4NCiAgPHBhdGggZD0iTTkuMDkgOWEzIDMgMCAwIDEgNS44MyAxYzAgMi0zIDMtMyAzIiAvPg0KICA8cGF0aCBkPSJNMTIgMTdoLjAxIiAvPg0KPC9zdmc+DQo=","circle-play":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWNpcmNsZS1wbGF5Ig0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNOSA5LjAwM2ExIDEgMCAwIDEgMS41MTctLjg1OWw0Ljk5NyAyLjk5N2ExIDEgMCAwIDEgMCAxLjcxOGwtNC45OTcgMi45OTdBMSAxIDAgMCAxIDkgMTQuOTk2eiIgLz4NCiAgPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIC8+DQo8L3N2Zz4NCg==","code-xml":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWNvZGUteG1sIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJtMTggMTYgNC00LTQtNCIgLz4NCiAgPHBhdGggZD0ibTYgOC00IDQgNCA0IiAvPg0KICA8cGF0aCBkPSJtMTQuNSA0LTUgMTYiIC8+DQo8L3N2Zz4NCg==","compass-white":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWNvbXBhc3MiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iI2U1ZmZmOSINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIiAvPg0KICA8cGF0aCBkPSJtMTYuMjQgNy43Ni0xLjgwNCA1LjQxMWEyIDIgMCAwIDEtMS4yNjUgMS4yNjVMNy43NiAxNi4yNGwxLjgwNC01LjQxMWEyIDIgMCAwIDEgMS4yNjUtMS4yNjV6IiAvPg0KPC9zdmc+DQo=","compass":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWNvbXBhc3MiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIiAvPg0KICA8cGF0aCBkPSJtMTYuMjQgNy43Ni0xLjgwNCA1LjQxMWEyIDIgMCAwIDEtMS4yNjUgMS4yNjVMNy43NiAxNi4yNGwxLjgwNC01LjQxMWEyIDIgMCAwIDEgMS4yNjUtMS4yNjV6IiAvPg0KPC9zdmc+DQo=","download":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWRvd25sb2FkIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMTIgMTVWMyIgLz4NCiAgPHBhdGggZD0iTTIxIDE1djRhMiAyIDAgMCAxLTIgMkg1YTIgMiAwIDAgMS0yLTJ2LTQiIC8+DQogIDxwYXRoIGQ9Im03IDEwIDUgNSA1LTUiIC8+DQo8L3N2Zz4NCg==","external-link":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWV4dGVybmFsLWxpbmsiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Ik0xNSAzaDZ2NiIgLz4NCiAgPHBhdGggZD0iTTEwIDE0IDIxIDMiIC8+DQogIDxwYXRoIGQ9Ik0xOCAxM3Y2YTIgMiAwIDAgMS0yIDJINWEyIDIgMCAwIDEtMi0yVjhhMiAyIDAgMCAxIDItMmg2IiAvPg0KPC9zdmc+DQo=","file-search":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWZpbGUtc2VhcmNoIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNNiAyMmEyIDIgMCAwIDEtMi0yVjRhMiAyIDAgMCAxIDItMmg4YTIuNCAyLjQgMCAwIDEgMS43MDQuNzA2bDMuNTg4IDMuNTg4QTIuNCAyLjQgMCAwIDEgMjAgOHYxMmEyIDIgMCAwIDEtMiAyeiIgLz4NCiAgPHBhdGggZD0iTTE0IDJ2NWExIDEgMCAwIDAgMSAxaDUiIC8+DQogIDxjaXJjbGUgY3g9IjExLjUiIGN5PSIxNC41IiByPSIyLjUiIC8+DQogIDxwYXRoIGQ9Ik0xMy4zIDE2LjMgMTUgMTgiIC8+DQo8L3N2Zz4NCg==","file-text":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWZpbGUtdGV4dCINCiAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIg0KICB3aWR0aD0iMjQiDQogIGhlaWdodD0iMjQiDQogIHZpZXdCb3g9IjAgMCAyNCAyNCINCiAgZmlsbD0ibm9uZSINCiAgc3Ryb2tlPSIjMGI5ZDhiIg0KICBzdHJva2Utd2lkdGg9IjIiDQogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCINCiAgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCINCj4NCiAgPHBhdGggZD0iTTYgMjJhMiAyIDAgMCAxLTItMlY0YTIgMiAwIDAgMSAyLTJoOGEyLjQgMi40IDAgMCAxIDEuNzA0LjcwNmwzLjU4OCAzLjU4OEEyLjQgMi40IDAgMCAxIDIwIDh2MTJhMiAyIDAgMCAxLTIgMnoiIC8+DQogIDxwYXRoIGQ9Ik0xNCAydjVhMSAxIDAgMCAwIDEgMWg1IiAvPg0KICA8cGF0aCBkPSJNMTAgOUg4IiAvPg0KICA8cGF0aCBkPSJNMTYgMTNIOCIgLz4NCiAgPHBhdGggZD0iTTE2IDE3SDgiIC8+DQo8L3N2Zz4NCg==","files":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWZpbGVzIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMTUgMmgtNGEyIDIgMCAwIDAtMiAydjExYTIgMiAwIDAgMCAyIDJoOGEyIDIgMCAwIDAgMi0yVjgiIC8+DQogIDxwYXRoIGQ9Ik0xNi43MDYgMi43MDZBMi40IDIuNCAwIDAgMCAxNSAydjVhMSAxIDAgMCAwIDEgMWg1YTIuNCAyLjQgMCAwIDAtLjcwNi0xLjcwNnoiIC8+DQogIDxwYXRoIGQ9Ik01IDdhMiAyIDAgMCAwLTIgMnYxMWEyIDIgMCAwIDAgMiAyaDhhMiAyIDAgMCAwIDEuNzMyLTEiIC8+DQo8L3N2Zz4NCg==","flask-conical":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWZsYXNrLWNvbmljYWwiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Ik0xNCAydjZhMiAyIDAgMCAwIC4yNDUuOTZsNS41MSAxMC4wOEEyIDIgMCAwIDEgMTggMjJINmEyIDIgMCAwIDEtMS43NTUtMi45Nmw1LjUxLTEwLjA4QTIgMiAwIDAgMCAxMCA4VjIiIC8+DQogIDxwYXRoIGQ9Ik02LjQ1MyAxNWgxMS4wOTQiIC8+DQogIDxwYXRoIGQ9Ik04LjUgMmg3IiAvPg0KPC9zdmc+DQo=","folders":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWZvbGRlcnMiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Ik0yMCA1YTIgMiAwIDAgMSAyIDJ2N2EyIDIgMCAwIDEtMiAySDlhMiAyIDAgMCAxLTItMlY1YTIgMiAwIDAgMSAyLTJoMi41YTEuNSAxLjUgMCAwIDEgMS4yLjZsLjYuOGExLjUgMS41IDAgMCAwIDEuMi42eiIgLz4NCiAgPHBhdGggZD0iTTMgOC4yNjhhMiAyIDAgMCAwLTEgMS43MzhWMTlhMiAyIDAgMCAwIDIgMmgxMWEyIDIgMCAwIDAgMS43MzItMSIgLz4NCjwvc3ZnPg0K","github":"data:image/svg+xml;base64,PHN2ZyBmaWxsPSIjMjQyOTJmIiByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+R2l0SHViPC90aXRsZT48cGF0aCBkPSJNMTIgLjI5N2MtNi42MyAwLTEyIDUuMzczLTEyIDEyIDAgNS4zMDMgMy40MzggOS44IDguMjA1IDExLjM4NS42LjExMy44Mi0uMjU4LjgyLS41NzcgMC0uMjg1LS4wMS0xLjA0LS4wMTUtMi4wNC0zLjMzOC43MjQtNC4wNDItMS42MS00LjA0Mi0xLjYxQzQuNDIyIDE4LjA3IDMuNjMzIDE3LjcgMy42MzMgMTcuN2MtMS4wODctLjc0NC4wODQtLjcyOS4wODQtLjcyOSAxLjIwNS4wODQgMS44MzggMS4yMzYgMS44MzggMS4yMzYgMS4wNyAxLjgzNSAyLjgwOSAxLjMwNSAzLjQ5NS45OTguMTA4LS43NzYuNDE3LTEuMzA1Ljc2LTEuNjA1LTIuNjY1LS4zLTUuNDY2LTEuMzMyLTUuNDY2LTUuOTMgMC0xLjMxLjQ2NS0yLjM4IDEuMjM1LTMuMjItLjEzNS0uMzAzLS41NC0xLjUyMy4xMDUtMy4xNzYgMCAwIDEuMDA1LS4zMjIgMy4zIDEuMjMuOTYtLjI2NyAxLjk4LS4zOTkgMy0uNDA1IDEuMDIuMDA2IDIuMDQuMTM4IDMgLjQwNSAyLjI4LTEuNTUyIDMuMjg1LTEuMjMgMy4yODUtMS4yMy42NDUgMS42NTMuMjQgMi44NzMuMTIgMy4xNzYuNzY1Ljg0IDEuMjMgMS45MSAxLjIzIDMuMjIgMCA0LjYxLTIuODA1IDUuNjI1LTUuNDc1IDUuOTIuNDIuMzYuODEgMS4wOTYuODEgMi4yMiAwIDEuNjA2LS4wMTUgMi44OTYtLjAxNSAzLjI4NiAwIC4zMTUuMjEuNjkuODI1LjU3QzIwLjU2NSAyMi4wOTIgMjQgMTcuNTkyIDI0IDEyLjI5N2MwLTYuNjI3LTUuMzczLTEyLTEyLTEyIi8+PC9zdmc+","globe":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWdsb2JlIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgLz4NCiAgPHBhdGggZD0iTTEyIDJhMTQuNSAxNC41IDAgMCAwIDAgMjAgMTQuNSAxNC41IDAgMCAwIDAtMjAiIC8+DQogIDxwYXRoIGQ9Ik0yIDEyaDIwIiAvPg0KPC9zdmc+DQo=","house":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWhvdXNlIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMTUgMjF2LThhMSAxIDAgMCAwLTEtMWgtNGExIDEgMCAwIDAtMSAxdjgiIC8+DQogIDxwYXRoIGQ9Ik0zIDEwYTIgMiAwIDAgMSAuNzA5LTEuNTI4bDctNmEyIDIgMCAwIDEgMi41ODIgMGw3IDZBMiAyIDAgMCAxIDIxIDEwdjlhMiAyIDAgMCAxLTIgMkg1YTIgMiAwIDAgMS0yLTJ6IiAvPg0KPC9zdmc+DQo=","info":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWluZm8iDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIiAvPg0KICA8cGF0aCBkPSJNMTIgMTZ2LTQiIC8+DQogIDxwYXRoIGQ9Ik0xMiA4aC4wMSIgLz4NCjwvc3ZnPg0K","lightbulb":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLWxpZ2h0YnVsYiINCiAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIg0KICB3aWR0aD0iMjQiDQogIGhlaWdodD0iMjQiDQogIHZpZXdCb3g9IjAgMCAyNCAyNCINCiAgZmlsbD0ibm9uZSINCiAgc3Ryb2tlPSIjMGI5ZDhiIg0KICBzdHJva2Utd2lkdGg9IjIiDQogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCINCiAgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCINCj4NCiAgPHBhdGggZD0iTTE1IDE0Yy4yLTEgLjctMS43IDEuNS0yLjUgMS0uOSAxLjUtMi4yIDEuNS0zLjVBNiA2IDAgMCAwIDYgOGMwIDEgLjIgMi4yIDEuNSAzLjUuNy43IDEuMyAxLjUgMS41IDIuNSIgLz4NCiAgPHBhdGggZD0iTTkgMThoNiIgLz4NCiAgPHBhdGggZD0iTTEwIDIyaDQiIC8+DQo8L3N2Zz4NCg==","mail":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLW1haWwiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Im0yMiA3LTguOTkxIDUuNzI3YTIgMiAwIDAgMS0yLjAwOSAwTDIgNyIgLz4NCiAgPHJlY3QgeD0iMiIgeT0iNCIgd2lkdGg9IjIwIiBoZWlnaHQ9IjE2IiByeD0iMiIgLz4NCjwvc3ZnPg0K","menu":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLW1lbnUiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Ik00IDVoMTYiIC8+DQogIDxwYXRoIGQ9Ik00IDEyaDE2IiAvPg0KICA8cGF0aCBkPSJNNCAxOWgxNiIgLz4NCjwvc3ZnPg0K","package":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXBhY2thZ2UiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Ik0xMSAyMS43M2EyIDIgMCAwIDAgMiAwbDctNEEyIDIgMCAwIDAgMjEgMTZWOGEyIDIgMCAwIDAtMS0xLjczbC03LTRhMiAyIDAgMCAwLTIgMGwtNyA0QTIgMiAwIDAgMCAzIDh2OGEyIDIgMCAwIDAgMSAxLjczeiIgLz4NCiAgPHBhdGggZD0iTTEyIDIyVjEyIiAvPg0KICA8cG9seWxpbmUgcG9pbnRzPSIzLjI5IDcgMTIgMTIgMjAuNzEgNyIgLz4NCiAgPHBhdGggZD0ibTcuNSA0LjI3IDkgNS4xNSIgLz4NCjwvc3ZnPg0K","panel-top":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXBhbmVsLXRvcCINCiAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIg0KICB3aWR0aD0iMjQiDQogIGhlaWdodD0iMjQiDQogIHZpZXdCb3g9IjAgMCAyNCAyNCINCiAgZmlsbD0ibm9uZSINCiAgc3Ryb2tlPSIjMGI5ZDhiIg0KICBzdHJva2Utd2lkdGg9IjIiDQogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCINCiAgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCINCj4NCiAgPHJlY3Qgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiB4PSIzIiB5PSIzIiByeD0iMiIgLz4NCiAgPHBhdGggZD0iTTMgOWgxOCIgLz4NCjwvc3ZnPg0K","panels-top-left":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXBhbmVscy10b3AtbGVmdCINCiAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIg0KICB3aWR0aD0iMjQiDQogIGhlaWdodD0iMjQiDQogIHZpZXdCb3g9IjAgMCAyNCAyNCINCiAgZmlsbD0ibm9uZSINCiAgc3Ryb2tlPSIjMGI5ZDhiIg0KICBzdHJva2Utd2lkdGg9IjIiDQogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCINCiAgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCINCj4NCiAgPHJlY3Qgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiB4PSIzIiB5PSIzIiByeD0iMiIgLz4NCiAgPHBhdGggZD0iTTMgOWgxOCIgLz4NCiAgPHBhdGggZD0iTTkgMjFWOSIgLz4NCjwvc3ZnPg0K","pdf":"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDMyIDMyIj48cGF0aCBmaWxsPSIjOTA5MDkwIiBkPSJtMjQuMSAyLjA3Mmw1LjU2NCA1Ljh2MjIuMDU2SDguODc5VjMwaDIwLjg1NlY3Ljk0NXoiLz48cGF0aCBmaWxsPSIjZjRmNGY0IiBkPSJNMjQuMDMxIDJIOC44MDh2MjcuOTI4aDIwLjg1NlY3Ljg3M3oiLz48cGF0aCBmaWxsPSIjN2E3YjdjIiBkPSJNOC42NTUgMy41aC02LjM5djYuODI3aDIwLjFWMy41eiIvPjxwYXRoIGZpbGw9IiNkZDIwMjUiIGQ9Ik0yMi40NzIgMTAuMjExSDIuMzk1VjMuMzc5aDIwLjA3N3oiLz48cGF0aCBmaWxsPSIjNDY0NjQ4IiBkPSJNOS4wNTIgNC41MzRINy43NDV2NC44aDEuMDI4VjcuNzE1TDkgNy43MjhhMiAyIDAgMCAwIC42NDctLjExN2ExLjQgMS40IDAgMCAwIC40OTMtLjI5MWExLjIgMS4yIDAgMCAwIC4zMzUtLjQ1NGEyLjEgMi4xIDAgMCAwIC4xMDUtLjkwOGEyLjIgMi4yIDAgMCAwLS4xMTQtLjY0NGExLjE3IDEuMTcgMCAwIDAtLjY4Ny0uNjVhMiAyIDAgMCAwLS40MDktLjEwNGEyIDIgMCAwIDAtLjMxOS0uMDI2bS0uMTg5IDIuMjk0aC0uMDg5di0xLjQ4aC4xOTNhLjU3LjU3IDAgMCAxIC40NTkuMTgxYS45Mi45MiAwIDAgMSAuMTgzLjU1OGMwIC4yNDYgMCAuNDY5LS4yMjIuNjI2YS45NC45NCAwIDAgMS0uNTI0LjExNG0zLjY3MS0yLjMwNmMtLjExMSAwLS4yMTkuMDA4LS4yOTUuMDExTDEyIDQuNTM4aC0uNzh2NC44aC45MThhMi43IDIuNyAwIDAgMCAxLjAyOC0uMTc1YTEuNyAxLjcgMCAwIDAgLjY4LS40OTFhMS45IDEuOSAwIDAgMCAuMzczLS43NDlhMy43IDMuNyAwIDAgMCAuMTE0LS45NDlhNC40IDQuNCAwIDAgMC0uMDg3LTEuMTI3YTEuOCAxLjggMCAwIDAtLjQtLjczM2ExLjYgMS42IDAgMCAwLS41MzUtLjRhMi40IDIuNCAwIDAgMC0uNTQ5LS4xNzhhMS4zIDEuMyAwIDAgMC0uMjI4LS4wMTdtLS4xODIgMy45MzdoLS4xVjUuMzkyaC4wMTNhMS4wNiAxLjA2IDAgMCAxIC42LjEwN2ExLjIgMS4yIDAgMCAxIC4zMjQuNGExLjMgMS4zIDAgMCAxIC4xNDIuNTI2Yy4wMDkuMjIgMCAuNCAwIC41NDlhMyAzIDAgMCAxLS4wMzMuNTEzYTEuOCAxLjggMCAwIDEtLjE2OS41YTEuMSAxLjEgMCAwIDEtLjM2My4zNmEuNjcuNjcgMCAwIDEtLjQxNi4xMDZtNS4wOC0zLjkxNUgxNXY0LjhoMS4wMjhWNy40MzRoMS4zdi0uODkyaC0xLjNWNS40M2gxLjR2LS44OTIiLz48cGF0aCBmaWxsPSIjZGQyMDI1IiBkPSJNMjEuNzgxIDIwLjI1NXMzLjE4OC0uNTc4IDMuMTg4LjUxMXMtMS45NzUuNjQ2LTMuMTg4LS41MTFtLTIuMzU3LjA4M2E3LjUgNy41IDAgMCAwLTEuNDczLjQ4OWwuNC0uOWMuNC0uOS44MTUtMi4xMjcuODE1LTIuMTI3YTE0IDE0IDAgMCAwIDEuNjU4IDIuMjUyYTEzIDEzIDAgMCAwLTEuNC4yODhabS0xLjI2Mi02LjVjMC0uOTQ5LjMwNy0xLjIwOC41NDYtMS4yMDhzLjUwOC4xMTUuNTE3LjkzOWExMC44IDEwLjggMCAwIDEtLjUxNyAyLjQzNGE0LjQgNC40IDAgMCAxLS41NDctMi4xNjJabS00LjY0OSAxMC41MTZjLS45NzgtLjU4NSAyLjA1MS0yLjM4NiAyLjYtMi40NDRjLS4wMDMuMDAxLTEuNTc2IDMuMDU2LTIuNiAyLjQ0NE0yNS45IDIwLjg5NWMtLjAxLS4xLS4xLTEuMjA3LTIuMDctMS4xNmExNCAxNCAwIDAgMC0yLjQ1My4xNzNhMTIuNSAxMi41IDAgMCAxLTIuMDEyLTIuNjU1YTExLjggMTEuOCAwIDAgMCAuNjIzLTMuMWMtLjAyOS0xLjItLjMxNi0xLjg4OC0xLjIzNi0xLjg3OHMtMS4wNTQuODE1LS45MzMgMi4wMTNhOS4zIDkuMyAwIDAgMCAuNjY1IDIuMzM4cy0uNDI1IDEuMzIzLS45ODcgMi42MzlzLS45NDYgMi4wMDYtLjk0NiAyLjAwNmE5LjYgOS42IDAgMCAwLTIuNzI1IDEuNGMtLjgyNC43NjctMS4xNTkgMS4zNTYtLjcyNSAxLjk0NWMuMzc0LjUwOCAxLjY4My42MjMgMi44NTMtLjkxYTIzIDIzIDAgMCAwIDEuNy0yLjQ5MnMxLjc4NC0uNDg5IDIuMzM5LS42MjNzMS4yMjYtLjI0IDEuMjI2LS4yNHMxLjYyOSAxLjYzOSAzLjIgMS41ODFzMS40OTUtLjkzOSAxLjQ4NS0xLjAzNSIvPjxwYXRoIGZpbGw9IiM5MDkwOTAiIGQ9Ik0yMy45NTQgMi4wNzdWNy45NWg1LjYzM3oiLz48cGF0aCBmaWxsPSIjZjRmNGY0IiBkPSJNMjQuMDMxIDJ2NS44NzNoNS42MzN6Ii8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTguOTc1IDQuNDU3SDcuNjY4djQuOEg4LjdWNy42MzlsLjIyOC4wMTNhMiAyIDAgMCAwIC42NDctLjExN2ExLjQgMS40IDAgMCAwIC40OTMtLjI5MWExLjIgMS4yIDAgMCAwIC4zMzItLjQ1NGEyLjEgMi4xIDAgMCAwIC4xMDUtLjkwOGEyLjIgMi4yIDAgMCAwLS4xMTQtLjY0NGExLjE3IDEuMTcgMCAwIDAtLjY4Ny0uNjVhMiAyIDAgMCAwLS40MTEtLjEwNWEyIDIgMCAwIDAtLjMxOS0uMDI2bS0uMTg5IDIuMjk0aC0uMDg5di0xLjQ4aC4xOTRhLjU3LjU3IDAgMCAxIC40NTkuMTgxYS45Mi45MiAwIDAgMSAuMTgzLjU1OGMwIC4yNDYgMCAuNDY5LS4yMjIuNjI2YS45NC45NCAwIDAgMS0uNTI0LjExNG0zLjY3LTIuMzA2Yy0uMTExIDAtLjIxOS4wMDgtLjI5NS4wMTFsLS4yMzUuMDA2aC0uNzh2NC44aC45MThhMi43IDIuNyAwIDAgMCAxLjAyOC0uMTc1YTEuNyAxLjcgMCAwIDAgLjY4LS40OTFhMS45IDEuOSAwIDAgMCAuMzczLS43NDlhMy43IDMuNyAwIDAgMCAuMTE0LS45NDlhNC40IDQuNCAwIDAgMC0uMDg3LTEuMTI3YTEuOCAxLjggMCAwIDAtLjQtLjczM2ExLjYgMS42IDAgMCAwLS41MzUtLjRhMi40IDIuNCAwIDAgMC0uNTQ5LS4xNzhhMS4zIDEuMyAwIDAgMC0uMjI4LS4wMTdtLS4xODIgMy45MzdoLS4xVjUuMzE1aC4wMTNhMS4wNiAxLjA2IDAgMCAxIC42LjEwN2ExLjIgMS4yIDAgMCAxIC4zMjQuNGExLjMgMS4zIDAgMCAxIC4xNDIuNTI2Yy4wMDkuMjIgMCAuNCAwIC41NDlhMyAzIDAgMCAxLS4wMzMuNTEzYTEuOCAxLjggMCAwIDEtLjE2OS41YTEuMSAxLjEgMCAwIDEtLjM2My4zNmEuNjcuNjcgMCAwIDEtLjQxNi4xMDZtNS4wNzctMy45MTVoLTIuNDN2NC44aDEuMDI4VjcuMzU3aDEuM3YtLjg5MmgtMS4zVjUuMzUzaDEuNHYtLjg5MiIvPjwvc3ZnPg==","play-white":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXBsYXkiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iI2U1ZmZmOSINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Ik01IDVhMiAyIDAgMCAxIDMuMDA4LTEuNzI4bDExLjk5NyA2Ljk5OGEyIDIgMCAwIDEgLjAwMyAzLjQ1OGwtMTIgN0EyIDIgMCAwIDEgNSAxOXoiIC8+DQo8L3N2Zz4NCg==","play":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXBsYXkiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Ik01IDVhMiAyIDAgMCAxIDMuMDA4LTEuNzI4bDExLjk5NyA2Ljk5OGEyIDIgMCAwIDEgLjAwMyAzLjQ1OGwtMTIgN0EyIDIgMCAwIDEgNSAxOXoiIC8+DQo8L3N2Zz4NCg==","powerpoint":"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDMyIDMyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9IlNWR05UUWZ4ZVF3IiB4MT0iNC40OTQiIHgyPSIxMy44MzIiIHkxPSItMTc0OC4wODYiIHkyPSItMTczMS45MTQiIGdyYWRpZW50VHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCAxNzU2KSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2NhNGMyOCIvPjxzdG9wIG9mZnNldD0iLjUiIHN0b3AtY29sb3I9IiNjNTQwMWUiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNiNjJmMTQiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cGF0aCBmaWxsPSIjZWQ2YzQ3IiBkPSJNMTguOTMgMTcuM0wxNi45NzcgM2gtLjE0NkExMi45IDEyLjkgMCAwIDAgMy45NTMgMTUuODU0VjE2WiIvPjxwYXRoIGZpbGw9IiNmZjhmNmIiIGQ9Ik0xNy4xMjMgM2gtLjE0NnYxM2w2LjUxMSAyLjZMMzAgMTZ2LS4xNDZBMTIuOSAxMi45IDAgMCAwIDE3LjEyMyAzIi8+PHBhdGggZmlsbD0iI2QzNTIzMCIgZD0iTTMwIDE2di4xNDNBMTIuOTA1IDEyLjkwNSAwIDAgMSAxNy4xMiAyOWgtLjI4N2ExMi45MDcgMTIuOTA3IDAgMCAxLTEyLjg4LTEyLjg1N1YxNloiLz48cGF0aCBkPSJNMTcuNjI4IDkuMzg5VjIzLjI2YTEuMiAxLjIgMCAwIDEtLjc0MiAxLjFhMS4yIDEuMiAwIDAgMS0uNDUuMDkxSDcuMDI3YTEwIDEwIDAgMCAxLS41MjEtLjY1YTEyLjc0IDEyLjc0IDAgMCAxLTIuNTUzLTcuNjU3di0uMjg2QTEyLjcgMTIuNyAwIDAgMSA2LjA1IDguODVhOSA5IDAgMCAxIC40NTYtLjY1aDkuOTNhMS4yIDEuMiAwIDAgMSAxLjE5MiAxLjE4OSIgb3BhY2l0eT0iLjEiLz48cGF0aCBkPSJNMTYuOTc3IDEwLjA0djEzLjg3MWExLjIgMS4yIDAgMCAxLS4wOTEuNDQ4YTEuMiAxLjIgMCAwIDEtMS4xLjc0MUg3LjYycS0uMzA5LS4zMTQtLjU5My0uNjVhMTAgMTAgMCAwIDEtLjUyMS0uNjVhMTIuNzQgMTIuNzQgMCAwIDEtMi41NTMtNy42NTd2LS4yODZBMTIuNyAxMi43IDAgMCAxIDYuMDUgOC44NWg5LjczNWExLjIgMS4yIDAgMCAxIDEuMTkyIDEuMTkiIG9wYWNpdHk9Ii4yIi8+PHBhdGggZD0iTTE2Ljk3NyAxMC4wNHYxMi41NzFhMS4yIDEuMiAwIDAgMS0xLjE5MiAxLjE4OUg2LjUwNmExMi43NCAxMi43NCAwIDAgMS0yLjU1My03LjY1N3YtLjI4NkExMi43IDEyLjcgMCAwIDEgNi4wNSA4Ljg1aDkuNzM1YTEuMiAxLjIgMCAwIDEgMS4xOTIgMS4xOSIgb3BhY2l0eT0iLjIiLz48cGF0aCBkPSJNMTYuMzI2IDEwLjA0djEyLjU3MWExLjIgMS4yIDAgMCAxLTEuMTkyIDEuMTg5SDYuNTA2YTEyLjc0IDEyLjc0IDAgMCAxLTIuNTUzLTcuNjU3di0uMjg2QTEyLjcgMTIuNyAwIDAgMSA2LjA1IDguODVoOS4wODRhMS4yIDEuMiAwIDAgMSAxLjE5MiAxLjE5IiBvcGFjaXR5PSIuMiIvPjxwYXRoIGZpbGw9InVybCgjU1ZHTlRRZnhlUXcpIiBkPSJNMy4xOTQgOC44NWgxMS45MzhhMS4xOTMgMS4xOTMgMCAwIDEgMS4xOTQgMS4xOTF2MTEuOTE4YTEuMTkzIDEuMTkzIDAgMCAxLTEuMTk0IDEuMTkxSDMuMTk0QTEuMTkgMS4xOSAwIDAgMSAyIDIxLjk1OVYxMC4wNDFBMS4xOSAxLjE5IDAgMCAxIDMuMTk0IDguODUiLz48cGF0aCBmaWxsPSIjZmZmIiBkPSJNOS4yOTMgMTIuMDI4YTMuMyAzLjMgMCAwIDEgMi4xNzQuNjM2YTIuMjcgMi4yNyAwIDAgMSAuNzU2IDEuODQxYTIuNTYgMi41NiAwIDAgMS0uMzczIDEuMzc2YTIuNSAyLjUgMCAwIDEtMS4wNTkuOTM1YTMuNiAzLjYgMCAwIDEtMS41OTEuMzM0SDcuNjg3djIuOEg2LjE0MXYtNy45MjJaTTcuNjg2IDE1Ljk0aDEuMzMxYTEuNzQgMS43NCAwIDAgMCAxLjE3Ny0uMzUxYTEuMyAxLjMgMCAwIDAgLjQtMS4wMjVxMC0xLjMwOS0xLjUyNS0xLjMxSDcuNjg2eiIvPjwvc3ZnPg==","refresh-cw":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXJlZnJlc2gtY3ciDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iIzBiOWQ4YiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Ik0zIDEyYTkgOSAwIDAgMSA5LTkgOS43NSA5Ljc1IDAgMCAxIDYuNzQgMi43NEwyMSA4IiAvPg0KICA8cGF0aCBkPSJNMjEgM3Y1aC01IiAvPg0KICA8cGF0aCBkPSJNMjEgMTJhOSA5IDAgMCAxLTkgOSA5Ljc1IDkuNzUgMCAwIDEtNi43NC0yLjc0TDMgMTYiIC8+DQogIDxwYXRoIGQ9Ik04IDE2SDN2NSIgLz4NCjwvc3ZnPg0K","scroll-text":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXNjcm9sbC10ZXh0Ig0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMTUgMTJoLTUiIC8+DQogIDxwYXRoIGQ9Ik0xNSA4aC01IiAvPg0KICA8cGF0aCBkPSJNMTkgMTdWNWEyIDIgMCAwIDAtMi0ySDQiIC8+DQogIDxwYXRoIGQ9Ik04IDIxaDEyYTIgMiAwIDAgMCAyLTJ2LTFhMSAxIDAgMCAwLTEtMUgxMWExIDEgMCAwIDAtMSAxdjFhMiAyIDAgMSAxLTQgMFY1YTIgMiAwIDEgMC00IDB2MmExIDEgMCAwIDAgMSAxaDMiIC8+DQo8L3N2Zz4NCg==","search":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXNlYXJjaCINCiAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIg0KICB3aWR0aD0iMjQiDQogIGhlaWdodD0iMjQiDQogIHZpZXdCb3g9IjAgMCAyNCAyNCINCiAgZmlsbD0ibm9uZSINCiAgc3Ryb2tlPSIjMGI5ZDhiIg0KICBzdHJva2Utd2lkdGg9IjIiDQogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCINCiAgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCINCj4NCiAgPHBhdGggZD0ibTIxIDIxLTQuMzQtNC4zNCIgLz4NCiAgPGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iOCIgLz4NCjwvc3ZnPg0K","shield-check":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXNoaWVsZC1jaGVjayINCiAgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIg0KICB3aWR0aD0iMjQiDQogIGhlaWdodD0iMjQiDQogIHZpZXdCb3g9IjAgMCAyNCAyNCINCiAgZmlsbD0ibm9uZSINCiAgc3Ryb2tlPSIjMGI5ZDhiIg0KICBzdHJva2Utd2lkdGg9IjIiDQogIHN0cm9rZS1saW5lY2FwPSJyb3VuZCINCiAgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCINCj4NCiAgPHBhdGggZD0iTTIwIDEzYzAgNS0zLjUgNy41LTcuNjYgOC45NWExIDEgMCAwIDEtLjY3LS4wMUM3LjUgMjAuNSA0IDE4IDQgMTNWNmExIDEgMCAwIDEgMS0xYzIgMCA0LjUtMS4yIDYuMjQtMi43MmExLjE3IDEuMTcgMCAwIDEgMS41MiAwQzE0LjUxIDMuODEgMTcgNSAxOSA1YTEgMSAwIDAgMSAxIDF6IiAvPg0KICA8cGF0aCBkPSJtOSAxMiAyIDIgNC00IiAvPg0KPC9zdmc+DQo=","sparkles-white":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXNwYXJrbGVzIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiNlNWZmZjkiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMTEuMDE3IDIuODE0YTEgMSAwIDAgMSAxLjk2NiAwbDEuMDUxIDUuNTU4YTIgMiAwIDAgMCAxLjU5NCAxLjU5NGw1LjU1OCAxLjA1MWExIDEgMCAwIDEgMCAxLjk2NmwtNS41NTggMS4wNTFhMiAyIDAgMCAwLTEuNTk0IDEuNTk0bC0xLjA1MSA1LjU1OGExIDEgMCAwIDEtMS45NjYgMGwtMS4wNTEtNS41NThhMiAyIDAgMCAwLTEuNTk0LTEuNTk0bC01LjU1OC0xLjA1MWExIDEgMCAwIDEgMC0xLjk2Nmw1LjU1OC0xLjA1MWEyIDIgMCAwIDAgMS41OTQtMS41OTR6IiAvPg0KICA8cGF0aCBkPSJNMjAgMnY0IiAvPg0KICA8cGF0aCBkPSJNMjIgNGgtNCIgLz4NCiAgPGNpcmNsZSBjeD0iNCIgY3k9IjIwIiByPSIyIiAvPg0KPC9zdmc+DQo=","sparkles":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXNwYXJrbGVzIg0KICB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciDQogIHdpZHRoPSIyNCINCiAgaGVpZ2h0PSIyNCINCiAgdmlld0JveD0iMCAwIDI0IDI0Ig0KICBmaWxsPSJub25lIg0KICBzdHJva2U9IiMwYjlkOGIiDQogIHN0cm9rZS13aWR0aD0iMiINCiAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIg0KICBzdHJva2UtbGluZWpvaW49InJvdW5kIg0KPg0KICA8cGF0aCBkPSJNMTEuMDE3IDIuODE0YTEgMSAwIDAgMSAxLjk2NiAwbDEuMDUxIDUuNTU4YTIgMiAwIDAgMCAxLjU5NCAxLjU5NGw1LjU1OCAxLjA1MWExIDEgMCAwIDEgMCAxLjk2NmwtNS41NTggMS4wNTFhMiAyIDAgMCAwLTEuNTk0IDEuNTk0bC0xLjA1MSA1LjU1OGExIDEgMCAwIDEtMS45NjYgMGwtMS4wNTEtNS41NThhMiAyIDAgMCAwLTEuNTk0LTEuNTk0bC01LjU1OC0xLjA1MWExIDEgMCAwIDEgMC0xLjk2Nmw1LjU1OC0xLjA1MWEyIDIgMCAwIDAgMS41OTQtMS41OTR6IiAvPg0KICA8cGF0aCBkPSJNMjAgMnY0IiAvPg0KICA8cGF0aCBkPSJNMjIgNGgtNCIgLz4NCiAgPGNpcmNsZSBjeD0iNCIgY3k9IjIwIiByPSIyIiAvPg0KPC9zdmc+DQo=","word":"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgdmlld0JveD0iMCAwIDMyIDMyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9IlNWRzJtM0FWYjZwIiB4MT0iNC40OTQiIHgyPSIxMy44MzIiIHkxPSItMTcxMi4wODYiIHkyPSItMTY5NS45MTQiIGdyYWRpZW50VHJhbnNmb3JtPSJ0cmFuc2xhdGUoMCAxNzIwKSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzIzNjhjNCIvPjxzdG9wIG9mZnNldD0iLjUiIHN0b3AtY29sb3I9IiMxYTVkYmUiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMxMTQ2YWMiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cGF0aCBmaWxsPSIjNDFhNWVlIiBkPSJNMjguODA2IDNIOS43MDVhMS4xOSAxLjE5IDAgMCAwLTEuMTkzIDEuMTkxVjkuNWwxMS4wNjkgMy4yNUwzMCA5LjVWNC4xOTFBMS4xOSAxLjE5IDAgMCAwIDI4LjgwNiAzIi8+PHBhdGggZmlsbD0iIzJiN2NkMyIgZD0iTTMwIDkuNUg4LjUxMlYxNmwxMS4wNjkgMS45NUwzMCAxNloiLz48cGF0aCBmaWxsPSIjMTg1YWJkIiBkPSJNOC41MTIgMTZ2Ni41bDEwLjQxOCAxLjNMMzAgMjIuNVYxNloiLz48cGF0aCBmaWxsPSIjMTAzZjkxIiBkPSJNOS43MDUgMjloMTkuMUExLjE5IDEuMTkgMCAwIDAgMzAgMjcuODA5VjIyLjVIOC41MTJ2NS4zMDlBMS4xOSAxLjE5IDAgMCAwIDkuNzA1IDI5Ii8+PHBhdGggZD0iTTE2LjQzNCA4LjJIOC41MTJ2MTYuMjVoNy45MjJhMS4yIDEuMiAwIDAgMCAxLjE5NC0xLjE5MVY5LjM5MUExLjIgMS4yIDAgMCAwIDE2LjQzNCA4LjIiIG9wYWNpdHk9Ii4xIi8+PHBhdGggZD0iTTE1Ljc4MyA4Ljg1SDguNTEyVjI1LjFoNy4yNzFhMS4yIDEuMiAwIDAgMCAxLjE5NC0xLjE5MVYxMC4wNDFhMS4yIDEuMiAwIDAgMC0xLjE5NC0xLjE5MSIgb3BhY2l0eT0iLjIiLz48cGF0aCBkPSJNMTUuNzgzIDguODVIOC41MTJWMjMuOGg3LjI3MWExLjIgMS4yIDAgMCAwIDEuMTk0LTEuMTkxVjEwLjA0MWExLjIgMS4yIDAgMCAwLTEuMTk0LTEuMTkxIiBvcGFjaXR5PSIuMiIvPjxwYXRoIGQ9Ik0xNS4xMzIgOC44NWgtNi42MlYyMy44aDYuNjJhMS4yIDEuMiAwIDAgMCAxLjE5NC0xLjE5MVYxMC4wNDFhMS4yIDEuMiAwIDAgMC0xLjE5NC0xLjE5MSIgb3BhY2l0eT0iLjIiLz48cGF0aCBmaWxsPSJ1cmwoI1NWRzJtM0FWYjZwKSIgZD0iTTMuMTk0IDguODVoMTEuOTM4YTEuMTkzIDEuMTkzIDAgMCAxIDEuMTk0IDEuMTkxdjExLjkxOGExLjE5MyAxLjE5MyAwIDAgMS0xLjE5NCAxLjE5MUgzLjE5NEExLjE5IDEuMTkgMCAwIDEgMiAyMS45NTlWMTAuMDQxQTEuMTkgMS4xOSAwIDAgMSAzLjE5NCA4Ljg1Ii8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTYuOSAxNy45ODhxLjAzNS4yNzYuMDQ2LjQ4MWguMDI4cS4wMTUtLjE5NS4wNjUtLjQ3Yy4wNS0uMjc1LjA2Mi0uMzM4LjA4OS0uNDY1bDEuMjU1LTUuNDA3aDEuNjI0bDEuMyA1LjMyNmE4IDggMCAwIDEgLjE2MiAxaC4wMjJhOCA4IDAgMCAxIC4xMzUtLjk3NWwxLjAzOS01LjM1OGgxLjQ3N2wtMS44MjQgNy43NDhoLTEuNzI3bC0xLjIzNy01LjEyNnEtLjA1NC0uMjIyLS4xMjItLjU3OHQtLjA4NC0uNTJoLS4wMjFxLS4wMjEuMTg5LS4wODQuNTYxdC0uMS41NTJMNy43OCAxOS44NzFINi4wMjRMNC4xOSAxMi4xMjdoMS41bDEuMTMxIDUuNDE4YTUgNSAwIDAgMSAuMDc5LjQ0MyIvPjwvc3ZnPg==","x":"data:image/svg+xml;base64,PCEtLSBAbGljZW5zZSBsdWNpZGUtc3RhdGljIHYxLjYxLjAgLSBJU0MgLS0+DQo8c3ZnDQogIGNsYXNzPSJsdWNpZGUgbHVjaWRlLXgiDQogIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyINCiAgd2lkdGg9IjI0Ig0KICBoZWlnaHQ9IjI0Ig0KICB2aWV3Qm94PSIwIDAgMjQgMjQiDQogIGZpbGw9Im5vbmUiDQogIHN0cm9rZT0iI2I4Y2RkMiINCiAgc3Ryb2tlLXdpZHRoPSIyIg0KICBzdHJva2UtbGluZWNhcD0icm91bmQiDQogIHN0cm9rZS1saW5lam9pbj0icm91bmQiDQo+DQogIDxwYXRoIGQ9Ik0xOCA2IDYgMTgiIC8+DQogIDxwYXRoIGQ9Im02IDYgMTIgMTIiIC8+DQo8L3N2Zz4NCg==","youtube":"data:image/svg+xml;base64,PHN2ZyBmaWxsPSIjZmYwMDMzIiByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+WW91VHViZTwvdGl0bGU+PHBhdGggZD0iTTIzLjQ5OCA2LjE4NmEzLjAxNiAzLjAxNiAwIDAgMC0yLjEyMi0yLjEzNkMxOS41MDUgMy41NDUgMTIgMy41NDUgMTIgMy41NDVzLTcuNTA1IDAtOS4zNzcuNTA1QTMuMDE3IDMuMDE3IDAgMCAwIC41MDIgNi4xODZDMCA4LjA3IDAgMTIgMCAxMnMwIDMuOTMuNTAyIDUuODE0YTMuMDE2IDMuMDE2IDAgMCAwIDIuMTIyIDIuMTM2YzEuODcxLjUwNSA5LjM3Ni41MDUgOS4zNzYuNTA1czcuNTA1IDAgOS4zNzctLjUwNWEzLjAxNSAzLjAxNSAwIDAgMCAyLjEyMi0yLjEzNkMyNCAxNS45MyAyNCAxMiAyNCAxMnMwLTMuOTMtLjUwMi01LjgxNHpNOS41NDUgMTUuNTY4VjguNDMyTDE1LjgxOCAxMmwtNi4yNzMgMy41Njh6Ii8+PC9zdmc+"});
function assetIcon(name, className = "asset-icon") {
  const src = ICON_DATA[name];
  return src ? '<img class="' + className + '" src="' + src + '" alt="" aria-hidden="true" loading="lazy">' : "";
}
function hydrateLocalIcons() {
  document.querySelectorAll("img[data-icon]").forEach((img) => {
    const src = ICON_DATA[img.dataset.icon];
    if (src) img.src = src;
  });
}
function resourceAsset(item) {
  if (item.type === "documentation")
    return ({PDF:"pdf", Word:"word", PowerPoint:"powerpoint"})[item.file_format] || "files";
  return ({api:"braces", library:"github", video:"youtube", book:"book-open",
    paper:"flask-conical", website:"globe", platform:"panels-top-left"})[item.type] || "compass";
}
function compactNumber(number) {
  if (!number && number !== 0) return "";
  return number >= 1000 ? (number / 1000).toFixed(number >= 10000 ? 0 : 1) + "k" : String(number);
}
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}
function updateSavedCount() {
  $("#savedCount").textContent = state.bookmarks.length;
  $("#topSavedCount").textContent = state.bookmarks.length;
}
function isSaved(item) {
  return state.bookmarks.some((saved) => saved.url === item.url);
}
function register(items) {
  items.forEach((item) => resourceMap.set(item.id, item));
}
function tagsFor(item) {
  const tags = [];
  if (item.access_status)
    tags.push([item.access_status === "free" ? "Free access" :
      item.access_status === "paid" ? "Paid" : "Access unverified",
      item.access_status === "free" ? "success" : item.access_status === "paid" ? "paid" : ""]);
  else if (item.free === true) tags.push(["Verified free","success"]);
  if (item.file_format) tags.push([item.file_format,"purple"]);
  if (item.crawl_status === "checked") tags.push(["Page reachable","success"]);
  if (item.open_source === true) tags.push(["Open source","purple"]);
  if (item.type === "api" && item.key_required === true) tags.push(["API key",""]);
  if (item.type === "api" && item.key_required === false) tags.push([item.auth && item.auth !== "No" ? item.auth : "No key",""]);
  if (item.language) tags.push([item.language,""]);
  if (item.type === "book" && item.availability) tags.push([item.availability,""]);
  if (item.category && tags.length < 3) tags.push([item.category,""]);
  return tags.slice(0, 3);
}
function videoThumbnail(item) {
  if (item.type !== "video") return "";
  try {
    const url = new URL(item.url);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    let id = "";
    if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
      if (url.pathname === "/watch") id = url.searchParams.get("v") || "";
      else if (["shorts", "live", "embed"].includes(parts[0])) id = parts[1] || "";
    } else if (["youtu.be", "www.youtu.be"].includes(host)) id = parts[0] || "";
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" : "";
  } catch { return ""; }
}
function resourceFavicon(item) {
  if (!["api", "platform", "website"].includes(item.type)) return "";
  try {
    const source = new URL(safeUrl(item.icon_url || item.url));
    if (!["https:", "http:"].includes(source.protocol)) return "";
    return item.icon_url ? source.href : source.origin + "/favicon.ico";
  } catch { return ""; }
}
function resourceIconHtml(item) {
  const icon = resourceFavicon(item);
  const format = item.type === "documentation" ? item.file_format : "";
  return '<div class="resource-icon icon-' + escapeHtml(item.type) +
    (format ? ' file-' + escapeHtml(format.toLowerCase()) : '') + '" aria-hidden="true">' +
    '<span class="icon-fallback">' + assetIcon(resourceAsset(item)) + '</span>' +
    (icon ? '<img class="brand-icon" src="' + escapeHtml(icon) +
      '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "") + '</div>';
}
function videoStats(item) {
  if (item.type !== "video") return "";
  const views = item.video_views ? escapeHtml(item.video_views) + " views" :
    item.video_metadata_loading ? "Checking views…" : "Views not supplied";
  let date = item.video_published_relative ?
    "Posted about " + item.video_published_relative :
    item.video_metadata_loading ? "Checking upload date…" : "Upload date not supplied";
  if (item.video_published_at) {
    const parsed = new Date(item.video_published_at + "T00:00:00Z");
    if (!Number.isNaN(parsed.getTime())) date = "Posted " +
      new Intl.DateTimeFormat(undefined,{year:"numeric",month:"short",day:"numeric",timeZone:"UTC"}).format(parsed);
  }
  return '<div class="video-stats"><span>' + views + '</span><span>' + escapeHtml(date) + '</span></div>';
}
function cardDescription(item) {
  const text = String(item.description || "").replace(/\s+/g, " ").trim();
  if (!text || /^open the source to learn more\.?$/i.test(text))
    return typeLabel(item.type) + " from " + (item.source || "the publisher") + ". View the original page for details and current access terms.";
  if (text.length <= 190) return text;
  const clipped = text.slice(0, 187).replace(/\s+\S*$/, "").trim();
  return (clipped || text.slice(0, 187)) + "…";
}
function cardHtml(item) {
  const url = safeUrl(item.url);
  const saved = isSaved(item);
  let meta = item.source || typeLabel(item.type);
  if (item.stars) meta = "★ " + compactNumber(item.stars) + " stars";
  else if (item.year) meta = item.year + " · " + meta;
  else if (item.auth && item.auth !== "No") meta = item.auth + " · " + meta;
  const thumbnail = videoThumbnail(item);
  const cover = thumbnail ? '<a class="video-cover" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" aria-label="Watch ' + escapeHtml(item.title) + ' on YouTube"><img src="' + escapeHtml(thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="video-play" aria-hidden="true">' + assetIcon("play-white", "play-image") + '</span></a>' : '';
  return '<article class="resource-card' + (thumbnail ? ' video-card' : '') + '">' + cover +
    '<div class="card-top">' + resourceIconHtml(item) +
    '<div class="card-source">' + escapeHtml(typeLabel(item.type)) + '<strong>' + escapeHtml(item.source || "Resource") + '</strong></div>' +
    '<button class="bookmark-btn' + (saved ? " saved" : "") + '" data-save="' + escapeHtml(item.id) + '" aria-label="' + escapeHtml((saved ? "Remove bookmark for " : "Bookmark ") + item.title) + '" title="' + (saved ? "Remove bookmark" : isAuthenticated() ? "Bookmark resource" : "Sign in to save") + '">' + assetIcon(saved ? "bookmark-check" : "bookmark", "bookmark-image") + '</button></div>' +
    '<h3>' + escapeHtml(item.title) + '</h3>' + videoStats(item) +
    '<p>' + escapeHtml(cardDescription(item)) + '</p>' +
    '<div class="tag-row">' + tagsFor(item).map((tag) => '<span class="tag ' + tag[1] + '">' + escapeHtml(tag[0]) + '</span>').join("") + '</div>' +
    '<div class="card-bottom"><span class="card-meta">' + escapeHtml(meta) + '</span><div class="card-actions"><button data-detail="' + escapeHtml(item.id) + '" aria-label="Details for ' + escapeHtml(item.title) + '">Details</button><a href="' + escapeHtml(url) + '" aria-label="Open ' + escapeHtml(item.title) + ' in a new tab" target="_blank" rel="noopener noreferrer">View resource ↗</a></div></div></article>';
}
function filterItems(items) {
  if (state.tab === "documentation") {
    const openPapers = (state.live.papers?.items || []).filter((item) => item.pdf_url).map((item) => ({
      ...item, id:"document-" + item.id, type:"documentation", url:item.pdf_url,
      category:"PDF paper", file_format:"PDF", access_status:"free",
      access_note:"Research paper is marked open access and has a public full-text link.",
      source:"Research paper · full text", free:true
    }));
    items = items.concat(openPapers);
  }
  const free = $("#freeFilter").checked;
  const oss = $("#ossFilter").checked;
  const key = $("#keyFilter").value;
  const language = $("#languageFilter").value;
  const format = $("#formatFilter").value;
  return items.filter((item) => {
    if (state.tab !== "all" && item.type !== state.tab) return false;
    if (state.tab === "documentation" && format !== "any" && item.file_format !== format) return false;
    if (free && item.free !== true) return false;
    if (oss && item.open_source !== true) return false;
    if (key !== "any" && (item.type !== "api" || item.key_required !== (key === "yes"))) return false;
    if (language !== "any" && (item.language || "").toLowerCase() !== language.toLowerCase()) return false;
    return true;
  });
}
function resultScore(item) {
  if (Number.isFinite(Number(item.relevance_score))) return Number(item.relevance_score);
  const terms = state.query.toLowerCase().match(/[\w+#.-]+/g) || [];
  const stop = new Set(["a","an","and","best","find","for","free","in","of","the","to","api","apis","library","resources"]);
  const title = (item.title || "").toLowerCase();
  const category = (item.category || "").toLowerCase();
  const description = (item.description || "").toLowerCase();
  let score = 0;
  terms.filter((term) => term.length > 1 && !stop.has(term)).forEach((term) => {
    score += title.includes(term) ? 8 : category.includes(term) ? 5 : description.includes(term) ? 2 : -8;
  });
  if (item.source === "Crawled page") score += 1;
  if (item.source === "External search") score -= 18;
  return score;
}
function canonicalUrl(value) {
  try {
    const url = new URL(value);
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","ref"].forEach((key) => url.searchParams.delete(key));
    url.hash = "";
    return (url.origin + url.pathname.replace(/\/$/, "") + url.search).toLowerCase();
  } catch { return String(value || "").toLowerCase(); }
}
function allResults() {
  const items = state.catalog.concat(
    ...["github", "videos", "books", "papers", "web", "documents", "tools"].map((source) => (state.live[source] || {}).items || []),
    state.crawled
  );
  // Prefer a product card when its URL is also listed as a website in Tools & apps.
  const candidates = state.tab === "platform" ?
    items.filter((item) => item.type === "platform").concat(items.filter((item) => item.type !== "platform")) : items;
  const seen = new Set();
  const ranked = candidates.filter((item) => {
    if (item.crawl_status === "stale") return false;
    const key = canonicalUrl(item.url || item.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item, index) => ({item, index, score:resultScore(item)}))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const result = [];
  const deferred = [];
  const counts = {};
  ranked.forEach((entry) => {
    const source = entry.item.source || "Other";
    if (result.length < 12 && (counts[source] || 0) >= 3) deferred.push(entry.item);
    else { result.push(entry.item); counts[source] = (counts[source] || 0) + 1; }
  });
  return result.concat(deferred);
}
function renderProgress() {
  const node = $("#sourceProgress");
  const messages = [];
  if (state.loading.size) messages.push("Searching " + state.loading.size + " live " + (state.loading.size === 1 ? "source" : "sources") + "…");
  if (state.crawl?.state === "running") messages.push("Checking pages in the background: " + state.crawl.checked + "/" + state.crawl.queued + ".");
  node.hidden = messages.length === 0;
  node.textContent = messages.join(" ") + (messages.length ? " Results appear as they arrive." : "");
}
function renderDiscover() {
  const items = filterItems(allResults());
  register(items);
  const visible = items.slice(0, state.showLimit);
  const sourceByTab = {api:[], library:["github"], video:["videos"], book:["books"],
    paper:["papers"], website:["web"], documentation:["documents","papers"], platform:["tools"]};
  const relevant = sourceByTab[state.tab] || SEARCH_SOURCES;
  const pending = state.catalogLoading || relevant.some((source) => state.loading.has(source));
  const failed = state.catalogError || relevant.some((source) => {
    const data = state.live[source];
    return data && (data.error || (data.provider_issue && !(data.items || []).length));
  });
  const mode = items.length ? "success" : pending ? "loading" : failed ? "error" : "empty";
  $("#resultsGrid").innerHTML = visible.length ? visible.map(cardHtml).join("") :
    mode === "loading" ? '<div class="skeleton-grid" aria-label="Loading results"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div>' : "";
  const canFetchMore = (state.tab === "all" && state.catalogOffset < state.catalogTotal) ||
    relevant.some((key) => state.live[key]?.has_more);
  $("#resultsCount").textContent = items.length ? items.length + (canFetchMore ? "+" : "") + " results" :
    mode === "loading" ? "Searching…" : state.query ? "No results" : "Ready to search";
  $("#emptyState").hidden = mode !== "empty";
  $("#errorState").hidden = mode !== "error";
  $("#emptyState h3").textContent = state.query ? "No resources found. Try a broader search." : "Search to find resources";
  $("#emptyState p").textContent = state.query ?
    "Clear a filter or choose another category to widen your search." :
    "Describe what you need above, then choose a source type.";
  $("#resultsTitle").textContent = state.query ? "Results for “" + state.query + "”" : "Featured resources";
  $("#resultsSubtitle").textContent = state.query ?
    (state.hosted ? "Browse results from the catalog and available live sources." : "Browse indexed results while background page checks discover related links.") :
    "Start with a topic or explore handpicked guides.";
  $("#loadMore").hidden = !items.length || (items.length <= state.showLimit && !canFetchMore);
  $("#loadMore").disabled = state.loadingMore;
  $("#loadMore").innerHTML = state.loadingMore ? "Searching more sources…" : "Show more resources <span>↓</span>";
  $("#sourceNotices").innerHTML = mode === "success" && failed ?
    '<div class="source-warning">Some sources are temporarily unavailable. <button type="button" data-retry-search>Retry sources</button></div>' : "";
  renderProgress();
}
function renderSaved() {
  register(state.bookmarks);
  $("#savedGrid").innerHTML = state.bookmarks.map(cardHtml).join("");
  $("#savedEmpty").hidden = state.bookmarks.length > 0;
}
function renderCollections() {
  if (state.collectionId) {
    const collection = state.collections.find((entry) => entry.id === state.collectionId);
    if (!collection) state.collectionId = null;
    else {
      $("#collectionGrid").hidden = true;
      $("#collectionDetail").hidden = false;
      $("#collectionTitle").textContent = collection.name;
      const items = collection.items.map((id) => state.bookmarks.find((item) => item.id === id)).filter(Boolean);
      register(items);
      $("#collectionSubtitle").textContent = items.length + " saved " + (items.length === 1 ? "resource" : "resources");
      $("#collectionResults").innerHTML = items.map(cardHtml).join("") || '<div class="empty-state"><div class="empty-icon">' + assetIcon("folders", "empty-image") + '</div><h3>This collection is empty</h3><p>Open a saved resource and add it from the details panel.</p></div>';
      return;
    }
  }
  $("#collectionGrid").hidden = false;
  $("#collectionDetail").hidden = true;
  const cards = state.collections.map((collection) =>
    '<button class="collection-card" data-collection="' + escapeHtml(collection.id) + '"><span class="collection-icon">' + assetIcon("folders", "collection-image") + '</span><strong>' + escapeHtml(collection.name) + '</strong><small>' + collection.items.length + ' resources →</small></button>'
  ).join("");
  $("#collectionGrid").innerHTML = cards || '<div class="empty-state"><div class="empty-icon">' + assetIcon("folders", "empty-image") + '</div><h3>No collections yet</h3><p>Create one to group resources for a project or learning path.</p></div>';
}
function render() {
  if (state.view === "home") renderHome();
  else if (state.view === "discover") renderDiscover();
  else if (state.view === "saved") renderSaved();
  else renderCollections();
}
function closeProfileMenu() {
  $("#profileMenu").hidden = true;
  $("#topProfile").setAttribute("aria-expanded", "false");
}
function closeNavMenu(restoreFocus = true) {
  const wasOpen = $("#sidebar").classList.contains("open");
  $("#sidebar").classList.remove("open");
  $("#sidebar").setAttribute("aria-hidden", "true");
  $("#navBackdrop").hidden = true;
  $("#mainContent").inert = false;
  document.body.classList.remove("menu-open");
  $("#mobileMenu").setAttribute("aria-expanded", "false");
  $("#mobileMenu").setAttribute("aria-label", "Open menu");
  if (wasOpen && restoreFocus) $("#mobileMenu").focus();
}
function openNavMenu() {
  closeProfileMenu();
  $("#sidebar").classList.add("open");
  $("#sidebar").setAttribute("aria-hidden", "false");
  $("#navBackdrop").hidden = false;
  $("#mainContent").inert = true;
  document.body.classList.add("menu-open");
  $("#mobileMenu").setAttribute("aria-expanded", "true");
  $("#mobileMenu").setAttribute("aria-label", "Close menu");
  $("#sidebar .nav-item").focus();
}
function showLoginPrompt() {
  closeNavMenu(false);
  setView("home");
  $("#accountAccess").scrollIntoView({behavior:"smooth",block:"center"});
  showToast("Sign in with Google to open your workspace");
}
function setView(view) {
  if (["saved", "collections"].includes(view) && !isAuthenticated()) { showLoginPrompt(); return; }
  state.view = view;
  $$(".content").forEach((node) => { if (node.id.endsWith("View")) node.hidden = node.id !== view + "View"; });
  $$(".nav-item[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$(".type-item").forEach((button) => {
    const active = view === "discover" && button.dataset.tab === state.tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  closeNavMenu(false);
  closeProfileMenu();
  render();
  window.scrollTo({top:0, behavior:"smooth"});
}
function goSection(section) {
  setView("home");
  const node = document.getElementById(section);
  if (node) node.scrollIntoView({behavior:"smooth",block:"start"});
}
function signOut() {
  if (window.google?.accounts?.id) { google.accounts.id.disableAutoSelect(); google.accounts.id.cancel?.(); }
  closeProfileMenu();
  closeDetailIfOpen();
  closeModalIfOpen();
  state.query = "";
  state.searchVersion += 1;
  state.catalog = []; state.catalogOffset = 0; state.catalogTotal = 0; state.catalogLoading = false; state.catalogError = false;
  state.live = {}; state.crawled = []; state.crawl = null; state.loading.clear();
  state.checkedUrls.clear(); state.currentItem = null; resourceMap.clear();
  loadWorkspace({id:"guest", name:"Guest"});
  $("#searchInput").value = "";
  $("#homeSearchInput").value = "";
  history.replaceState(null, "", location.pathname);
  setView("home");
  fetchCatalog(true, state.searchVersion);
  showToast("Logged out. Guest browsing does not save activity.");
}
function closeDetailIfOpen() { if (!$("#detailDrawer").hidden) closeDetail(); }
function closeModalIfOpen() { if (!$("#collectionModal").hidden) closeModal(); }
function setTab(tab) {
  state.tab = tab;
  closeNavMenu(false);
  if (state.view !== "discover") setView("discover");
  $$(".tab, .type-item").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    if (button.classList.contains("type-item")) button.setAttribute("aria-pressed", String(active));
    if (button.classList.contains("tab")) { button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1; }
  });
  state.showLimit = 30;
  $("#formatFilterWrap").hidden = tab !== "documentation";
  $("#keyFilterWrap").hidden = tab !== "all" && tab !== "api";
  if (tab !== "all" && tab !== "api") $("#keyFilter").value = "any";
  renderDiscover();
  const source = tab === "documentation" ? "documents" : tab === "platform" ? "tools" : null;
  if (source && state.query && (!state.availableSources || state.availableSources.includes(source)) && !state.live[source] && !state.loading.has(source))
    fetchLive(source, state.searchVersion);
}
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {signal:controller.signal});
    if (!response.ok) throw new Error("Source temporarily unavailable");
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function fetchFeatured() {
  try {
    const data = await getJson("/api/catalog?limit=8");
    state.featured = (data.items || []).filter((item) => item.type === "api" && item.url).slice(0, 3);
  } catch { state.featured = []; }
  renderFeatured();
}
async function fetchCatalog(reset, version) {
  const offset = reset ? 0 : state.catalogOffset;
  if (reset && version === state.searchVersion) {
    state.catalogLoading = true;
    state.catalogError = false;
    renderDiscover();
  }
  try {
    const data = await getJson("/api/catalog?" + new URLSearchParams({q:state.query, offset:String(offset), limit:"80"}));
    if (version !== state.searchVersion) return;
    const incoming = data.items || [];
    state.catalog = reset ? incoming : state.catalog.concat(incoming);
    state.catalogOffset = offset + incoming.length;
    state.catalogTotal = data.total || 0;
    register(incoming);
    renderFeatured();
  } catch {
    if (version === state.searchVersion) state.catalogError = true;
  } finally {
    if (version === state.searchVersion) {
      if (reset) state.catalogLoading = false;
      renderDiscover();
    }
  }
}
async function hydrateVideoMetadata(items, version) {
  if (!state.videoMetadata) return;
  const targets = items.filter((item) => item.type === "video").slice(0, 30);
  if (!targets.length) return;
  targets.forEach((item) => { item.video_metadata_loading = true; });
  renderDiscover();
  let changedSaved = false;
  for (let offset = 0; offset < targets.length; offset += 12) {
    if (version !== state.searchVersion) return;
    const chunk = targets.slice(offset, offset + 12);
    const ids = chunk.map((item) => {
      try { return new URL(item.url).searchParams.get("v") || ""; } catch { return ""; }
    });
    if (ids.some((id) => !/^[A-Za-z0-9_-]{11}$/.test(id))) {
      chunk.forEach((item) => { item.video_metadata_loading = false; });
      continue;
    }
    try {
      const data = await getJson("/api/video/meta?" + new URLSearchParams({ids:ids.join(",")}));
      if (version !== state.searchVersion) return;
      chunk.forEach((item, index) => {
        const metadata = data.items?.[ids[index]] || {};
        if (metadata.video_views) item.video_views = metadata.video_views;
        if (metadata.video_published_at) item.video_published_at = metadata.video_published_at;
        item.video_metadata_loading = false;
        if (isSaved(item)) changedSaved = true;
      });
    } catch {
      chunk.forEach((item) => { item.video_metadata_loading = false; });
    }
    renderDiscover();
  }
  if (changedSaved) saveStored();
}
async function fetchLive(source, version, page = 1) {
  state.loading.add(source);
  renderProgress();
  const healthStart = performance.now();
  try {
    const data = await getJson("/api/live?" + new URLSearchParams({source, q:state.query, page:String(page)}));
    if (version !== state.searchVersion) return;
    if (page === 1) recordSourceHealth(source, data, performance.now() - healthStart);
    const oldItems = page > 1 ? (state.live[source]?.items || []) : [];
    state.live[source] = {...data, items: oldItems.concat(data.items || []), error:Boolean(data.error || (data.provider_issue && !(data.items || []).length))};
    register(data.items || []);
    if (source === "videos") hydrateVideoMetadata(data.items || [], version);
  } catch {
    if (version === state.searchVersion) {
      if (page === 1) recordSourceHealth(source, {error:true,items:[]}, performance.now() - healthStart);
      const previous = state.live[source] || {items:[]};
      state.live[source] = {...previous, notice:"Unavailable", error:true, has_more:false};
    }
  } finally {
    if (version === state.searchVersion) {
      state.loading.delete(source);
      renderDiscover();
    }
  }
}
function updateCrawled(job) {
  const known = new Set(state.crawled.map((item) => item.url));
  for (const item of job.discovered || []) {
    if (!known.has(item.url)) { state.crawled.push(item); known.add(item.url); }
  }
  const lookup = new Map(allResults().map((item) => [item.url, item]));
  for (const [url, update] of Object.entries(job.updates || {})) {
    state.checkedUrls.add(url);
    const item = lookup.get(url);
    if (!item) continue;
    item.crawl_status = update.status;
    item.crawl_reason = update.reason;
    item.checked_at = update.checked_at;
    item.page_title = update.title;
    if (item.source === "Crawled page" && update.status === "checked") {
      if (update.title) item.title = update.title;
      if (update.description) item.description = update.description;
    }
  }
  register(state.crawled);
}
async function pollCrawl(jobId, version) {
  if (version !== state.searchVersion) return;
  try {
    const job = await getJson("/api/crawl/status?" + new URLSearchParams({id:jobId}));
    if (version !== state.searchVersion) return;
    state.crawl = job;
    updateCrawled(job);
    renderDiscover();
    if (job.state === "running") setTimeout(() => pollCrawl(jobId, version), 1300);
    else if (state.pendingCrawl) { state.pendingCrawl = false; startCrawl(version); }
  } catch {
    if (version === state.searchVersion) { state.crawl = {state:"error", checked:0, queued:0}; renderDiscover(); }
  }
}
async function startCrawl(version) {
  if (!state.backgroundCrawler) return;
  if (version !== state.searchVersion || !state.query || state.crawl?.state === "running") return;
  const items = allResults().filter((item) =>
    ["website","documentation","platform","api","library"].includes(item.type) &&
    item.source !== "External search" && item.source !== "Crawled page" && !state.checkedUrls.has(item.url)
  ).slice(0, 24);
  if (!items.length) return;
  items.forEach((item) => state.checkedUrls.add(item.url));
  try {
    const response = await fetch("/api/crawl/start", {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({q:state.query, items:items.map((item) => ({url:item.url, title:item.title, type:item.type}))})});
    if (!response.ok) throw new Error("Crawler unavailable");
    const data = await response.json();
    if (version === state.searchVersion) {
      state.crawl = {state:"running", checked:0, queued:items.length};
      renderProgress();
      pollCrawl(data.job_id, version);
    }
  } catch { if (version === state.searchVersion) showToast("Background page checks are unavailable"); }
}
const AUTOCOMPLETE_TOPICS = [
  "AI tools","APIs","Arduino","Books","C++ libraries","Cybersecurity",
  "Developer documentation","Ethical hacking","Free API for weather",
  "GitHub libraries","HTML tutorials","IoT projects","JavaScript",
  "Kubernetes","LIC AO papers","Linux","Machine learning","Networking",
  "Open source tools","PDF tools","Python PDF library","Quantum computing",
  "RAG","React","Research paper","STM32","TypeScript","UI design","Vue",
  "Weather APIs","XML parser","YouTube tutorials","Zero trust security"
];
const autocompleteClosers = [];

function closeAllAutocomplete() {
  autocompleteClosers.forEach((close) => close());
}
function setupAutocomplete(inputId, listId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let options = [];
  let active = -1;
  let requestVersion = 0;
  let timer;

  function close() {
    requestVersion += 1;
    clearTimeout(timer);
    list.hidden = true;
    list.innerHTML = "";
    options = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  function matches(value, query) {
    const lower = value.toLowerCase();
    return lower.startsWith(query) || lower.split(/[^a-z0-9+#]+/).some((word) => word.startsWith(query));
  }
  function render(catalogItems = []) {
    const query = input.value.trim().replace(/\s+/g, " ").toLowerCase();
    if (!query) { close(); return; }
    const found = [];
    const seen = new Set();
    function add(value, kind) {
      if (typeof value !== "string") return;
      const name = value.trim();
      if (!name || !matches(name, query) || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      found.push({value:name, kind});
    }
    if (isAuthenticated()) state.history.forEach((entry) => add(entry.q, "Recent search"));
    AUTOCOMPLETE_TOPICS.forEach((name) => add(name, "Topic"));
    state.featured.forEach((item) => add(item.title, "API"));
    state.catalog.forEach((item) => add(item.title, "API"));
    catalogItems.forEach((item) => add(item.title, "API"));
    found.sort((a, b) => {
      const aStart = a.value.toLowerCase().startsWith(query) ? 0 : 1;
      const bStart = b.value.toLowerCase().startsWith(query) ? 0 : 1;
      return aStart - bStart || a.value.length - b.value.length || a.value.localeCompare(b.value);
    });
    options = found.slice(0, 6);
    options.push({value:input.value.trim(), kind:"Search all resources", direct:true});
    active = -1;
    list.innerHTML = options.map((option, index) =>
      '<button type="button" role="option" aria-selected="false" tabindex="-1" class="autocomplete-option" id="' +
      listId + '-option-' + index + '" data-index="' + index + '"><span>' +
      escapeHtml(option.direct ? 'Search for “' + option.value + '”' : option.value) +
      '</span><small>' + escapeHtml(option.kind) + '</small></button>'
    ).join("");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
  }
  function activate(index) {
    active = index;
    list.querySelectorAll(".autocomplete-option").forEach((button, i) => {
      button.classList.toggle("is-active", i === active);
      button.setAttribute("aria-selected", String(i === active));
    });
    if (active >= 0) {
      const selected = list.querySelectorAll(".autocomplete-option")[active];
      input.setAttribute("aria-activedescendant", selected.id);
      selected.scrollIntoView({block:"nearest"});
    }
  }

  input.addEventListener("input", () => {
    requestVersion += 1;
    clearTimeout(timer);
    render();
    const query = input.value.trim();
    if (query.length < 2) return;
    const version = requestVersion;
    timer = setTimeout(async () => {
      try {
        const data = await getJson("/api/catalog?" + new URLSearchParams({q:query, limit:"40"}));
        if (version === requestVersion && document.activeElement === input) render(data.items || []);
      } catch { /* Topic suggestions stay available if the catalog is offline. */ }
    }, 180);
  });
  input.addEventListener("focus", () => render());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { if (!list.hidden) { event.preventDefault(); close(); } return; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !list.hidden) {
      event.preventDefault();
      activate(active < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1) : (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (event.key === "Enter" && active >= 0 && !list.hidden) {
      event.preventDefault();
      search(options[active].value);
    }
  });
  list.addEventListener("pointerdown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-index]");
    if (!button) return;
    const selected = options[Number(button.dataset.index)];
    if (selected) search(selected.value);
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.target !== input && !list.contains(event.target)) close();
  });
  autocompleteClosers.push(close);
}
function search(query) {
  closeAllAutocomplete();
  state.query = query.trim().replace(/\s+/g, " ").slice(0, 400);
  if (state.query && isAuthenticated()) {
    state.history = [{q:state.query, at:new Date().toISOString()}, ...state.history.filter((entry) => entry.q.toLowerCase() !== state.query.toLowerCase())].slice(0, 40);
    saveStored();
  }
  $("#searchInput").value = state.query;
  $("#homeSearchInput").value = state.query;
  state.searchVersion += 1;
  const version = state.searchVersion;
  state.catalog = [];
  state.catalogOffset = 0;
  state.catalogTotal = 0;
  state.catalogLoading = true;
  state.catalogError = false;
  state.live = {};
  state.crawled = [];
  state.crawl = null;
  state.checkedUrls = new Set();
  state.pendingCrawl = false;
  const sources = SEARCH_SOURCES.filter((source) => !state.availableSources || state.availableSources.includes(source));
  state.loading = new Set(state.query ? sources : []);
  state.showLimit = 30;
  setView("discover");
  history.replaceState(null, "", state.query ? "?q=" + encodeURIComponent(state.query) : location.pathname);
  renderDiscover();
  const requests = [fetchCatalog(true, version)];
  if (state.query) sources.forEach((source) => requests.push(fetchLive(source, version)));
  if (state.query && state.tab === "documentation") requests.push(fetchLive("documents", version));
  if (state.query && state.tab === "platform") requests.push(fetchLive("tools", version));
  Promise.allSettled(requests).then(() => {
    startCrawl(version);
    if (!state.hosted) getJson("/api/health").then((data) => renderHealth(data.provider_health)).catch(() => {});
  });
}
function toggleBookmark(item) {
  if (!isAuthenticated()) { showLoginPrompt(); return; }
  const index = state.bookmarks.findIndex((saved) => saved.url === item.url);
  if (index >= 0) {
    const removed = state.bookmarks.splice(index, 1)[0];
    state.collections.forEach((collection) => { collection.items = collection.items.filter((id) => id !== removed.id); });
    showToast("Removed from saved resources");
  } else {
    state.bookmarks.unshift(item);
    showToast("Saved to your resources");
  }
  saveStored();
  render();
  if (!$("#detailDrawer").hidden) openDetail(item);
}
function genericSteps(item) {
  if (item.type === "api") return [
    "Open the provider documentation and confirm its current pricing and terms.",
    item.key_required ? "Create an account and obtain an API key from the provider." : "Check the documentation for an endpoint; no API key is listed in the source catalog.",
    "Copy a request example from the provider docs and test it with your own parameters."
  ];
  if (item.type === "library") return [
    "Open the GitHub repository and read its README and license.",
    "Follow the project installation instructions for your language and environment.",
    "Run an example from the repository and check the latest issues for compatibility."
  ];
  if (item.type === "video") return ["Open the video on YouTube.", "Check its description and chapters for code or related links.", "Verify any commands against current documentation before using them."];
  if (item.type === "book") return ["Open the Open Library record.", "Check the page for read, borrow, or preview availability.", "Use the listed edition that suits your needs."];
  if (item.type === "paper") return ["Open the paper record or its open-access full text.", "Review the abstract and publication date.", "Follow citations and methods in the original paper."];
  return ["Open the original source.", "Check publication date, licensing and current instructions.", "Use the publisher's examples or documentation for your project."];
}
function fact(label, value) {
  return '<div class="fact"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value || "Not specified") + '</strong></div>';
}
function openDetail(item) {
  if ($("#detailDrawer").hidden) dialogReturnFocus = document.activeElement;
  state.currentItem = item;
  const details = $("#detailDrawer");
  const saved = isSaved(item);
  const steps = item.steps || genericSteps(item);
  const link = safeUrl(item.url);
  const facts = [
    fact("SOURCE", item.source), fact("RESOURCE TYPE", typeLabel(item.type)),
    fact("ACCESS", item.access_status === "free" ? "Free to open when indexed" :
      item.access_status === "paid" ? "Paid" :
      item.access_status === "unverified" ? "Unverified" :
      item.free === true ? "Verified for this guide" : "Check source"),
    fact("OPEN SOURCE", item.open_source === true ? "Yes" : item.open_source === false ? "No" : "Check source")
  ];
  if (item.file_format) facts.push(fact("FILE FORMAT", item.file_format));
  if (item.video_views) facts.push(fact("VIDEO VIEWS", item.video_views));
  if (item.video_published_at) facts.push(fact("POSTED", item.video_published_at));
  if (item.access_note) facts.push(fact("ACCESS BASIS", item.access_note));
  if (item.language) facts.push(fact("LANGUAGE", item.language));
  if (item.auth) facts.push(fact("AUTH", item.auth));
  if (item.license) facts.push(fact("LICENSE", item.license));
  if (item.availability) facts.push(fact("AVAILABILITY", item.availability));
  if (item.crawl_status) facts.push(fact("PAGE CHECK", item.crawl_status === "checked" ? "Reachable HTML page" : (item.crawl_reason || item.crawl_status)));
  if (item.checked_at) facts.push(fact("LAST CHECKED", new Date(item.checked_at * 1000).toLocaleString()));
  const codeSection = item.code ?
    '<section class="drawer-section"><h3>Working example</h3><div class="code-header"><span>' + escapeHtml(item.code_language || "Code") + '</span><button id="copyCode">Copy code</button></div><pre class="code-block"><code>' + escapeHtml(item.code) + '</code></pre></section>' :
    '<section class="drawer-section"><h3>Example status</h3><div class="drawer-note">A verified code sample is not available for this resource yet. Use the provider documentation for current endpoints and usage examples.</div></section>';
  const collectionOptions = state.collections.map((collection) =>
    '<option value="' + escapeHtml(collection.id) + '">' + escapeHtml(collection.name) + '</option>'
  ).join("");
  $("#drawerContent").innerHTML =
    '<div class="drawer-head"><span class="drawer-back">RESOURCE DETAILS</span><button class="drawer-close" id="closeDrawer" aria-label="Close details">×</button></div>' +
    '<div class="drawer-body"><div class="drawer-heading">' + resourceIconHtml(item) + '<div><h2 id="drawerTitle">' + escapeHtml(item.title) + '</h2><small>' + escapeHtml(item.source || typeLabel(item.type)) + (item.author ? " · " + escapeHtml(item.author) : "") + '</small></div></div>' +
    '<p class="drawer-description">' + escapeHtml(item.description || "Open the original source for more detail.") + '</p>' +
    '<div class="drawer-actions"><a class="search-button" href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">Open resource <span>↗</span></a>' + (isAuthenticated() ? '<button class="outline-button" id="drawerSave">' + assetIcon(saved ? "bookmark-check" : "bookmark", "bookmark-image") + (saved ? " Saved" : " Save resource") + '</button>' : '') +
    (item.pdf_url ? '<a class="outline-button" href="' + escapeHtml(safeUrl(item.pdf_url)) + '" target="_blank" rel="noopener noreferrer">Open full text ↗</a>' : "") + '</div>' +
    '<section class="drawer-section"><h3>At a glance</h3><div class="fact-grid">' + facts.join("") + '</div></section>' +
    '<section class="drawer-section"><h3>Get started</h3><ol class="setup-list">' + steps.map((step) => '<li>' + escapeHtml(step) + '</li>').join("") + '</ol></section>' +
    codeSection +
    (isAuthenticated() ? '<section class="drawer-section"><h3>Add to collection</h3>' +
    (state.collections.length ? '<select class="collection-select" id="drawerCollection"><option value="">Choose a collection…</option>' + collectionOptions + '</select>' : '<p class="drawer-note">Create a collection to organize this resource.</p><button class="outline-button" id="drawerCreateCollection">+ New collection</button>') +
    '</section>' : '') + '</div>';
  $("#overlay").hidden = false;
  details.hidden = false;
  $("#appShell").inert = true;
  details.setAttribute("aria-labelledby", "drawerTitle");
  document.body.style.overflow = "hidden";
  $("#closeDrawer").focus();
}
function closeDetail() {
  $("#detailDrawer").hidden = true;
  $("#overlay").hidden = true;
  document.body.style.overflow = "";
  $("#appShell").inert = false;
  state.currentItem = null;
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  dialogReturnFocus = null;
}
function openModal() {
  if (!isAuthenticated()) { showLoginPrompt(); return; }
  dialogReturnFocus = document.activeElement;
  $("#collectionModal").hidden = false;
  $("#appShell").inert = true;
  $("#collectionName").value = "";
  $("#collectionName").focus();
}
function closeModal() {
  $("#collectionModal").hidden = true;
  $("#appShell").inert = false;
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  dialogReturnFocus = null;
}
function createCollection(name) {
  const collection = {id:"collection-" + Date.now(), name:name.trim(), items:[]};
  state.collections.push(collection);
  saveStored();
  closeModal();
  setView("collections");
  showToast("Collection created");
}
function clearFilters() {
  $("#freeFilter").checked = false;
  $("#ossFilter").checked = false;
  $("#keyFilter").value = "any";
  $("#languageFilter").value = "any";
  $("#formatFilter").value = "any";
  render();
}
function exportBookmarks() {
  if (!isAuthenticated()) { showLoginPrompt(); return; }
  const data = {app:"FindrLib", version:2, exported_at:new Date().toISOString(), bookmarks:state.bookmarks, collections:state.collections, history:state.history};
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "findrlib-workspace.json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importBookmarks(file) {
  if (!isAuthenticated()) { showLoginPrompt(); return; }
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.bookmarks) || !Array.isArray(data.collections)) throw new Error("Invalid file");
    const incoming = data.bookmarks.filter((item) => item && typeof item.id === "string" && typeof item.title === "string" && safeUrl(item.url) !== "#");
    incoming.forEach((item) => { if (!state.bookmarks.some((saved) => saved.url === item.url)) state.bookmarks.push(item); });
    data.collections.filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.items)).forEach((item) => {
      if (!state.collections.some((collection) => collection.id === item.id)) state.collections.push(item);
    });
    if (Array.isArray(data.history)) {
      const valid = data.history.filter((entry) => entry && typeof entry.q === "string" && entry.q.length <= 400 && typeof entry.at === "string");
      state.history = [...valid, ...state.history].filter((entry, index, all) =>
        all.findIndex((other) => other.q.toLowerCase() === entry.q.toLowerCase()) === index).slice(0, 40);
    }
    saveStored(); render(); showToast("Workspace imported");
  } catch { showToast("This file is not a valid bookmark export"); }
}
async function init() {
  restoreSourceHealth();
  loadWorkspace({id:"guest", name:"Guest"});
  setView("home");
  fetchFeatured();
  setInterval(() => {
    if (!state.hosted && document.visibilityState === "visible")
      getJson("/api/health").then((data) => renderHealth(data.provider_health)).catch(() => {});
  }, 10000);
  try {
    const status = await getJson("/api/status");
    state.availableSources = Array.isArray(status.sources) ? status.sources : null;
    state.hosted = status.deployment === "netlify";
    state.backgroundCrawler = status.background_crawler !== false;
    state.videoMetadata = status.video_metadata !== false;
    if (state.hosted) {
      $("#agentStatus").textContent = "Sources checked on search";
      renderHealth({providers:state.sourceHealth});
    }
    state.nightlyInstalled = !!status.scheduled_refresh?.installed;
    renderRefresh(status.catalog_refresh);
    renderHealth(status.provider_health);
    state.supportEmail = status.support_email || "";
    $("#supportSubmit").textContent = "Send to support →";
    renderSupport();
    if (status.google_signin_available) setupGoogle(status.google_client_id);
    else $("#googleHint").textContent = status.google_client_id ?
      "Install the Google verification dependencies from requirements-auth.txt, then restart." :
      "Add a Google OAuth Web client ID to config.local.json to enable sign-in.";
    if (status.catalog_refresh?.running) setTimeout(pollRefresh, 2500);
  } catch { $("#catalogStat").textContent = "Catalog"; $("#agentStatus").textContent = "Offline"; }
  const initialQuery = new URLSearchParams(location.search).get("q");
  if (initialQuery) search(initialQuery);
  else fetchCatalog(true, state.searchVersion);
}
$("#searchForm").addEventListener("submit", (event) => { event.preventDefault(); search($("#searchInput").value); });
$$(".suggestion").forEach((button) => button.addEventListener("click", () => search(button.dataset.query)));
$$(".tab, .type-item").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
$$(".nav-item[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$("#sidebarBrand").addEventListener("click", () => setView("home"));
$("#sidebarClose").addEventListener("click", () => closeNavMenu());
$("#discoverShortcut").textContent = /Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform || navigator.platform || "") ? "⌘ K" : "Ctrl K";
$("#topSaved").addEventListener("click", () => setView("saved"));
$("#topProfile").addEventListener("click", () => {
  const opening = $("#profileMenu").hidden;
  $("#profileMenu").hidden = !opening;
  $("#topProfile").setAttribute("aria-expanded", String(opening));
  if (opening) $("#profileSaved").focus();
});
$("#profileSaved").addEventListener("click", () => setView("saved"));
$("#profileExport").addEventListener("click", () => { closeProfileMenu(); exportBookmarks(); });
$("#profileLogout").addEventListener("click", signOut);
$("#homeStart")?.addEventListener("click", () => { setView("discover"); $("#searchInput").focus(); });
$("#signOut").addEventListener("click", signOut);
$("#loginNav").addEventListener("click", () => goSection("accountAccess"));
$("#createNav").addEventListener("click", () => goSection("accountAccess"));
$("#homeSearchForm").addEventListener("submit", (event) => { event.preventDefault(); search($("#homeSearchInput").value); });
setupAutocomplete("searchInput", "searchAutocomplete");
setupAutocomplete("homeSearchInput", "homeAutocomplete");
$$(".home-suggestion").forEach((button) => button.addEventListener("click", () => search(button.dataset.query)));
$$("[data-category]").forEach((button) => button.addEventListener("click", () => {
  setTab(button.dataset.category);
  $("#searchInput").focus();
}));
$$("[data-section]").forEach((button) => button.addEventListener("click", () => goSection(button.dataset.section)));
$$(".top-brand, .top-links [data-view], .landing-section [data-view]").forEach((button) =>
  button.addEventListener("click", () => setView(button.dataset.view)));
$("#supportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  if (!isAuthenticated() || !state.profile.email) {
    $("#supportStatus").textContent = "Sign in with Google first so your email is included with the message.";
    goSection("accountAccess");
    return;
  }
  if (!state.hosted) {
    $("#supportStatus").textContent = "Direct delivery is available on resourcefinders.netlify.app.";
    return;
  }
  const subject = $("#feedbackSubject").value.trim();
  const message = $("#feedbackMessage").value.trim();
  if (subject.length < 3 || message.length < 10) {
    $("#supportStatus").textContent = "Please add a subject and at least 10 characters of detail.";
    return;
  }
  $("#supportEmailField").value = state.profile.email;
  $("#supportNameField").value = state.profile.name;
  const button = $("#supportSubmit");
  button.disabled = true;
  button.textContent = "Sending…";
  $("#supportStatus").textContent = "Sending your message…";
  try {
    const response = await fetch("/", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams(new FormData(form)).toString()});
    if (!response.ok) throw new Error("Submission failed");
    $("#feedbackSubject").value = "";
    $("#feedbackMessage").value = "";
    $("#supportStatus").textContent = "Message submitted. Thank you for helping improve FindrLib.";
  } catch {
    $("#supportStatus").textContent = "Could not send your message. Please try again.";
  } finally {
    button.disabled = false;
    button.textContent = "Send to support →";
  }
});

$("#refreshNow").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/catalog/refresh", {method:"POST"});
    if (!response.ok) throw new Error("Refresh failed");
    const data = await response.json();
    renderRefresh(data.catalog_refresh);
    if (data.started) { showToast("Checking for new APIs"); setTimeout(pollRefresh, 1500); }
    else showToast("Catalog refresh is already running");
  } catch { showToast("Catalog refresh could not start"); }
});
$("#sidebarCollection").addEventListener("click", openModal);
$("#createCollection").addEventListener("click", openModal);
$("#clearFilters").addEventListener("click", clearFilters);
$("#emptyClear").addEventListener("click", clearFilters);
$("#retrySearch").addEventListener("click", () => search(state.query));
$$(".filters input, .filters select").forEach((input) => input.addEventListener("change", () => { state.showLimit = 30; render(); }));
$("#loadMore").addEventListener("click", async () => {
  if (state.loadingMore) return;
  const count = filterItems(allResults()).length;
  if (count > state.showLimit) { state.showLimit += 30; renderDiscover(); return; }
  state.loadingMore = true;
  state.showLimit += 80;
  renderDiscover();
  const version = state.searchVersion;
  const requests = [];
  if (state.tab === "all" && state.catalogOffset < state.catalogTotal) requests.push(fetchCatalog(false, version));
  const moreSources = state.tab === "documentation" ? ["documents"] :
    state.tab === "platform" ? ["tools"] : Object.keys(state.live);
  for (const source of moreSources) {
    const data = state.live[source];
    if (data?.has_more) requests.push(fetchLive(source, version, (data.page || 1) + 1));
  }
  await Promise.allSettled(requests);
  if (version === state.searchVersion) {
    state.loadingMore = false;
    renderDiscover();
    if (state.crawl?.state === "running") state.pendingCrawl = true;
    else startCrawl(version);
  }
});
$("#exportSaved").addEventListener("click", exportBookmarks);
$("#importSaved").addEventListener("change", (event) => { if (event.target.files[0]) importBookmarks(event.target.files[0]); event.target.value = ""; });
$("#backCollections").addEventListener("click", () => { state.collectionId = null; renderCollections(); });
$("#deleteCollection").addEventListener("click", () => {
  if (!window.confirm("Delete this collection? Saved resources will stay in your workspace.")) return;
  state.collections = state.collections.filter((item) => item.id !== state.collectionId);
  state.collectionId = null; saveStored(); renderCollections(); showToast("Collection deleted");
});
$("#collectionForm").addEventListener("submit", (event) => { event.preventDefault(); if ($("#collectionName").value.trim()) createCollection($("#collectionName").value); });
$("#overlay").addEventListener("click", closeDetail);
$$("[data-close-modal]").forEach((node) => node.addEventListener("click", closeModal));
$("#mobileMenu").addEventListener("click", () => {
  if ($("#sidebar").classList.contains("open")) closeNavMenu(); else openNavMenu();
});
$("#navBackdrop").addEventListener("click", () => closeNavMenu());

document.addEventListener("error", (event) => {
  if (event.target.matches?.(".brand-icon")) event.target.hidden = true;
}, true);
document.addEventListener("click", (event) => {
  if (!event.target.closest("#profileWrap")) closeProfileMenu();
  if (event.target.closest("[data-retry-search]")) { search(state.query); return; }
  const recent = event.target.closest("[data-recent]");
  if (recent) { search(recent.dataset.recent); return; }
  const homeView = event.target.closest(".home-view [data-view]");
  if (homeView) { setView(homeView.dataset.view); return; }
  const detail = event.target.closest("[data-detail]");
  if (detail) { const item = resourceMap.get(detail.dataset.detail); if (item) openDetail(item); return; }
  const save = event.target.closest("[data-save]");
  if (save) { const item = resourceMap.get(save.dataset.save); if (item) toggleBookmark(item); return; }
  const collection = event.target.closest("[data-collection]");
  if (collection) { state.collectionId = collection.dataset.collection; renderCollections(); return; }
  if (event.target.closest(".goDiscover")) { setView("discover"); return; }
  if (event.target.id === "closeDrawer") { closeDetail(); return; }
  if (event.target.id === "drawerSave" && state.currentItem) { toggleBookmark(state.currentItem); return; }
  if (event.target.id === "copyCode" && state.currentItem && state.currentItem.code) {
    navigator.clipboard.writeText(state.currentItem.code).then(() => showToast("Code copied"));
    return;
  }
  if (event.target.id === "drawerCreateCollection") { closeDetail(); openModal(); }
});
document.addEventListener("change", (event) => {
  if (event.target.id !== "drawerCollection" || !event.target.value || !state.currentItem) return;
  const collection = state.collections.find((item) => item.id === event.target.value);
  if (!collection) return;
  let savedItem = state.bookmarks.find((item) => item.url === state.currentItem.url);
  if (!savedItem) {
    savedItem = state.currentItem;
    state.bookmarks.unshift(savedItem);
  }
  if (!collection.items.includes(savedItem.id)) collection.items.push(savedItem.id);
  saveStored(); openDetail(state.currentItem); showToast("Added to " + collection.name);
});
document.addEventListener("keydown", (event) => {
  const dialog = !$("#collectionModal").hidden ? $("#collectionModal .modal") :
    !$("#detailDrawer").hidden ? $("#detailDrawer") :
    $("#sidebar").classList.contains("open") ? $("#sidebar") : null;
  if (event.key === "Tab" && dialog) {
    const controls = Array.from(dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled])'))
      .filter((control) => !control.hidden && control.getClientRects().length > 0);
    if (controls.length) {
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  if (event.key === "Escape") { if (!$("#collectionModal").hidden) closeModal(); else if (!$("#detailDrawer").hidden) closeDetail(); else if (!$("#profileMenu").hidden) closeProfileMenu(); else closeNavMenu(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setView("discover"); $("#searchInput").focus(); }
  if (event.key === "/" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)) { event.preventDefault(); setView("discover"); $("#searchInput").focus(); }
});
hydrateLocalIcons();
init();


// A missing remote thumbnail leaves the card's play surface visible.
document.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement && event.target.closest(".video-cover")) event.target.remove();
}, true);
