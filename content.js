(() => {
if (globalThis.__linkedinJobExcludesLoaded) return;
globalThis.__linkedinJobExcludesLoaded = true;

const HIDDEN_ATTRIBUTE = "data-job-excludes-hidden";
const CARD_SELECTOR = [
  "[data-occludable-job-id]",
  "li.jobs-search-results__list-item",
  "li[class*='job-card']",
  "[class*='job-card-container']",
  "[data-job-id]"
].join(",");

let excludedCompanies = [];
let scheduledFrame = null;
const observedRoots = new WeakSet();

function normalized(value) {
  return (value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim().replace(/\s+/g, " ");
}

function companyMatch(text) {
  const lines = (text || "").split(/[\n\r]+/).map(normalized).filter(Boolean);
  return excludedCompanies.find((company) => {
    const name = normalized(company);
    return name && lines.some((line) => line === name || line.includes(name));
  });
}

function collectRoots(root, roots = []) {
  roots.push(root);
  root.querySelectorAll?.("*").forEach((element) => {
    if (element.shadowRoot) collectRoots(element.shadowRoot, roots);
  });
  return roots;
}

function observeRoots() {
  for (const root of collectRoots(document)) {
    if (observedRoots.has(root)) continue;
    observedRoots.add(root);
    new MutationObserver(scheduleFilter).observe(root, { childList: true, characterData: true, subtree: true });
  }
}

function hideCard(card) {
  if (!card || card.getAttribute(HIDDEN_ATTRIBUTE) === "true") return false;
  card.setAttribute(HIDDEN_ATTRIBUTE, "true");
  card.setAttribute("data-job-excludes-old-display", card.style.getPropertyValue("display"));
  card.setAttribute("data-job-excludes-old-priority", card.style.getPropertyPriority("display"));
  card.style.setProperty("display", "none", "important");
  return true;
}

function isSingleJobCard(card) {
  if (!card) return false;
  const text = card.innerText || card.textContent || "";
  const lineCount = text.split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean).length;
  const jobLinks = card.querySelectorAll("a[href*='/jobs/view/']").length;
  const rect = card.getBoundingClientRect();
  // Avoid applying the filter to a whole results column or a large page panel.
  return text.length <= 1400 && lineCount <= 22 && jobLinks <= 2 && rect.height > 0 && rect.height <= 520;
}

function restoreCards(roots) {
  for (const root of roots) {
    root.querySelectorAll?.(`[${HIDDEN_ATTRIBUTE}='true']`).forEach((card) => {
      const display = card.getAttribute("data-job-excludes-old-display") || "";
      const priority = card.getAttribute("data-job-excludes-old-priority") || "";
      if (display) card.style.setProperty("display", display, priority);
      else card.style.removeProperty("display");
      card.removeAttribute(HIDDEN_ATTRIBUTE);
      card.removeAttribute("data-job-excludes-old-display");
      card.removeAttribute("data-job-excludes-old-priority");
    });
  }
}

function cardFromCompanyLabel(label) {
  // Current LinkedIn search-results cards expose a stable component key.
  // The row wrapper above data-display-contents also contains the logo,
  // dismiss button and application status, so hiding it removes the full row.
  const component = label.closest?.("[componentkey^='job-card-component-ref-']");
  const clickableCard = component?.closest("[role='button'][componentkey^='job-card-component-ref-']");
  const contentsWrapper = clickableCard?.parentElement;
  if (contentsWrapper?.getAttribute("data-display-contents") === "true") {
    const fullRow = contentsWrapper.parentElement;
    if (fullRow && fullRow.contains(label)) return fullRow;
  }

  let node = label;
  for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
    if (node.matches?.("li,[data-occludable-job-id],[data-job-id],[role='listitem']") && isSingleJobCard(node)) return node;
    const className = typeof node.className === "string" ? node.className.toLowerCase() : "";
    const id = (node.id || "").toLowerCase();
    if (/job-card|jobcard|job-result/.test(`${className} ${id}`) && isSingleJobCard(node)) return node;
    if (depth >= 2 && isSingleJobCard(node)) {
      const lines = (node.innerText || "").split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean);
      const hasLogo = Boolean(node.querySelector("img,svg,[role='img'],[class*='logo']"));
      const hasCardControl = Boolean(node.querySelector("button,[role='button']"));
      if (lines.length >= 3 && node.getBoundingClientRect().height >= 50 && (hasLogo || hasCardControl)) return node;
    }
  }
  return null;
}

function findCompanyLabels(root, company) {
  const name = normalized(company);
  const labels = [];
  root.querySelectorAll?.("span,div,p,a").forEach((element) => {
    if (normalized(element.innerText || element.textContent) === name) labels.push(element);
  });
  return labels;
}

function applyFilter() {
  if (scheduledFrame !== null) {
    cancelAnimationFrame(scheduledFrame);
    scheduledFrame = null;
  }
  observeRoots();
  const roots = collectRoots(document);
  restoreCards(roots);

  let inspected = 0;
  let labelsFound = 0;
  let hidden = 0;
  const cards = new Set();

  if (excludedCompanies.length) {
    for (const root of roots) {
      root.querySelectorAll?.(CARD_SELECTOR).forEach((card) => {
        if (isSingleJobCard(card)) cards.add(card);
      });
      root.querySelectorAll?.("a[href*='/jobs/view/']").forEach((link) => {
        const item = link.closest("li") || link.closest("[role='listitem']");
        if (isSingleJobCard(item)) cards.add(item);
      });
      for (const company of excludedCompanies) {
        for (const label of findCompanyLabels(root, company)) {
          labelsFound += 1;
          const card = cardFromCompanyLabel(label);
          if (card) cards.add(card);
        }
      }
    }

    const matchingCards = [...cards].filter((card) => companyMatch(card.innerText || card.textContent));
    inspected = cards.size;
    // If both an inner text panel and its complete result row were detected,
    // keep only the outer row so its logo and controls disappear with it.
    const completeRows = matchingCards.filter((card) => !matchingCards.some((other) => other !== card && other.contains(card)));
    for (const card of completeRows) {
      if (hideCard(card)) hidden += 1;
    }
  }

  const stats = { inspected, labelsFound, hidden, updatedAt: Date.now(), page: location.href };
  chrome.storage.local.set({ jobFilterStats: stats });
  return stats;
}

function scheduleFilter() {
  if (scheduledFrame !== null) return;
  scheduledFrame = requestAnimationFrame(() => {
    scheduledFrame = null;
    applyFilter();
  });
}

chrome.storage.sync.get({ excludedCompanies: [] }).then(({ excludedCompanies: companies }) => {
  excludedCompanies = companies;
  scheduleFilter();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.excludedCompanies) {
    const nextCompanies = changes.excludedCompanies.newValue || [];
    if (JSON.stringify(nextCompanies) !== JSON.stringify(excludedCompanies)) {
      excludedCompanies = nextCompanies;
      scheduleFilter();
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "JOB_EXCLUDES_LIST_UPDATED") return;
  excludedCompanies = Array.isArray(message.excludedCompanies) ? message.excludedCompanies : [];
  const stats = applyFilter();
  sendResponse({ ok: true, ...stats });
});

observeRoots();
})();
