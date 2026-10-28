const form = document.querySelector("#company-form");
const input = document.querySelector("#company-input");
const list = document.querySelector("#company-list");
const status = document.querySelector("#status");
const notice = document.querySelector("#notice");
const filterStatus = document.querySelector("#filter-status");
const languageSwitch = document.querySelector("#language-switch");
const version = chrome.runtime.getManifest().version;

const messages = {
  "pt-BR": {
    heading: "Empresas bloqueadas",
    description: "As vagas dessas empresas serão removidas dos resultados do LinkedIn.",
    filterWaiting: "Abra uma busca de vagas no LinkedIn para ver o status do filtro.",
    filterStats: (stats) => `Nesta página: ${stats.inspected} cards analisados; ${stats.hidden} vagas removidas.`,
    version: `Versão ${version}`,
    languageGroup: "Idioma da extensão",
    portuguese: "Usar português do Brasil",
    english: "Usar inglês",
    companyLabel: "Adicionar empresa",
    companyPlaceholder: "Nome da empresa",
    add: "Adicionar",
    remove: "Remover",
    removeCompany: (company) => `Remover ${company}`,
    empty: "Nenhuma empresa bloqueada ainda.",
    saved: "Lista salva. O filtro foi atualizado.",
    savedReload: "Lista salva. Atualize uma busca do LinkedIn para aplicar o filtro.",
    required: "Digite o nome da empresa antes de adicionar.",
    duplicate: "Essa empresa já está na lista."
  },
  en: {
    heading: "Blocked companies",
    description: "Jobs from these companies will be removed from LinkedIn search results.",
    filterWaiting: "Open a LinkedIn jobs search to see the filter status.",
    filterStats: (stats) => `This page: ${stats.inspected} cards checked; ${stats.hidden} jobs removed.`,
    version: `Version ${version}`,
    languageGroup: "Extension language",
    portuguese: "Use Brazilian Portuguese",
    english: "Use English",
    companyLabel: "Add a company",
    companyPlaceholder: "Company name",
    add: "Add",
    remove: "Remove",
    removeCompany: (company) => `Remove ${company}`,
    empty: "No companies blocked yet.",
    saved: "List saved. The filter has been updated.",
    savedReload: "List saved. Reload a LinkedIn jobs search to apply the filter.",
    required: "Enter a company name before adding it.",
    duplicate: "This company is already on the list."
  }
};

let language = "pt-BR";
let companies = [];
let latestStats = null;
let statusMessage = "";

function currentMessages() {
  return messages[language];
}

function renderCompanies() {
  const words = currentMessages();
  list.replaceChildren();
  list.setAttribute("aria-label", language === "en" ? "Blocked companies" : "Empresas bloqueadas");

  if (companies.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = words.empty;
    list.append(empty);
    return;
  }

  companies.forEach((company, index) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = company;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = words.remove;
    remove.setAttribute("aria-label", words.removeCompany(company));
    remove.addEventListener("click", async () => {
      await updateCompanies(companies.filter((entry) => entry !== company));
      const remainingButtons = list.querySelectorAll("button");
      if (remainingButtons.length) remainingButtons[Math.min(index, remainingButtons.length - 1)].focus();
      else input.focus();
    });
    item.append(name, remove);
    list.append(item);
  });
}

function render() {
  const words = currentMessages();
  document.documentElement.lang = language;
  document.title = words.heading;
  document.querySelector("#heading").textContent = words.heading;
  document.querySelector("#description").textContent = words.description;
  document.querySelector("#version").textContent = words.version;
  document.querySelector("#company-label").textContent = words.companyLabel;
  input.placeholder = words.companyPlaceholder;
  document.querySelector("#add-button").textContent = words.add;
  languageSwitch.setAttribute("aria-label", words.languageGroup);
  document.querySelector("#language-pt").setAttribute("aria-label", words.portuguese);
  document.querySelector("#language-en").setAttribute("aria-label", words.english);
  document.querySelector("#language-pt").setAttribute("aria-pressed", String(language === "pt-BR"));
  document.querySelector("#language-en").setAttribute("aria-pressed", String(language === "en"));
  filterStatus.textContent = latestStats?.updatedAt ? words.filterStats(latestStats) : words.filterWaiting;
  notice.hidden = !statusMessage;
  if (statusMessage) {
    status.textContent = words[statusMessage];
    const error = ["required", "duplicate"].includes(statusMessage);
    notice.dataset.state = error ? "error" : "success";
    notice.setAttribute("aria-live", error ? "assertive" : "polite");
    input.setAttribute("aria-invalid", String(statusMessage === "required" || statusMessage === "duplicate"));
  } else {
    status.textContent = "";
    input.setAttribute("aria-invalid", "false");
  }
  renderCompanies();
}

function normalize(value) {
  return value.trim().replace(/\s+/g, " ");
}

async function updateCompanies(updatedCompanies) {
  companies = updatedCompanies;
  await chrome.storage.sync.set({ excludedCompanies: companies });
  const applied = await applyToActiveTab();
  statusMessage = applied ? "saved" : "savedReload";
  render();
}

async function applyToActiveTab() {
  try {
    const tab = await new Promise((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        resolve(chrome.runtime.lastError ? null : tabs?.[0] || null);
      });
    });
    if (!tab?.id || !/linkedin\.com\/jobs\//i.test(tab.url || "")) return false;
    const message = {
      type: "JOB_EXCLUDES_LIST_UPDATED",
      excludedCompanies: companies
    };
    const sendMessage = () => new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    });

    let response = await sendMessage();
    if (response?.ok) return true;

    // A newly reloaded extension may not yet have a content script in this tab.
    await new Promise((resolve, reject) => {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
    response = await sendMessage();
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function setLanguage(nextLanguage) {
  language = nextLanguage;
  await chrome.storage.sync.set({ uiLanguage: language });
  render();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const company = normalize(input.value);
  if (!company) {
    statusMessage = "required";
    render();
    input.focus();
    return;
  }

  const duplicate = companies.some((entry) => entry.toLocaleLowerCase() === company.toLocaleLowerCase());
  if (duplicate) {
    statusMessage = "duplicate";
    render();
    return;
  }

  await updateCompanies([...companies, company]);
  input.value = "";
  input.setAttribute("aria-invalid", "false");
  input.focus();
});

input.addEventListener("input", () => {
  if (input.value.trim() && ["required", "duplicate"].includes(statusMessage)) {
    statusMessage = "";
    render();
  }
});

document.querySelector("#language-pt").addEventListener("click", () => setLanguage("pt-BR"));
document.querySelector("#language-en").addEventListener("click", () => setLanguage("en"));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    if (changes.excludedCompanies) companies = changes.excludedCompanies.newValue || [];
    if (changes.uiLanguage && ["pt-BR", "en"].includes(changes.uiLanguage.newValue)) language = changes.uiLanguage.newValue;
    render();
  }
  if (area === "local" && changes.jobFilterStats) {
    latestStats = changes.jobFilterStats.newValue || null;
    render();
  }
});

Promise.all([
  chrome.storage.sync.get({ excludedCompanies: [], uiLanguage: "pt-BR" }),
  chrome.storage.local.get({ jobFilterStats: null })
]).then(([syncData, localData]) => {
  companies = syncData.excludedCompanies || [];
  language = syncData.uiLanguage === "en" ? "en" : "pt-BR";
  latestStats = localData.jobFilterStats;
  render();
});
