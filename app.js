const sourceInput = document.querySelector("#source-input");
const answerContent = document.querySelector("#answer-content");
const emptyAnswer = document.querySelector("#empty-answer");
const inputError = document.querySelector("#input-error");
const savedCount = document.querySelector("#saved-count");
const recentList = document.querySelector("#recent-list");
const toast = document.querySelector("#toast");
const sourceLink = document.querySelector("#source-link");
const sourceBox = document.querySelector("#source-box");
const savedDialog = document.querySelector("#saved-dialog");
const savedResults = document.querySelector("#saved-results");

const depthDescriptions = [
  "Simple words, no assumed knowledge",
  "Useful context without the jargon overload",
  "More context, terminology, and edge cases",
];
const samples = {
  error: {
    mode: "fix",
    text: "Error: connect ECONNREFUSED 127.0.0.1:5432\n\nThe app could not connect to the database. Check that the database server is running and accepting TCP/IP connections.",
  },
  notice: {
    mode: "next",
    text: "We couldn't complete your appointment request. Please call the service desk by Friday, 26 September, and have your reference number ready. Requests not confirmed by then may need to be resubmitted.",
  },
  steps: {
    mode: "explain",
    text: "Before you begin:\n1. Download the latest report.\n2. Check the totals against your statement.\n3. Send the signed copy to the accounts team by 30 September.",
  },
};
const sampleText = samples.error.text;
let selectedMode = "explain";
let selectedDepth = 0;
let sourceType = "text";
let currentAnswer = null;
let toastTimer;

function loadSaved() {
  try {
    const items = JSON.parse(localStorage.getItem("clearstep-saved") || "[]");
    return Array.isArray(items)
      ? items.filter((item) => item && typeof item === "object").map((item, index) => ({
        ...item,
        id: item.id || `saved-${index}-${String(item.createdAt || "legacy").replace(/[^a-z\d]/gi, "")}`,
        title: item.title || makeTitle(item.source || "Saved explanation"),
        source: item.source || "",
        sourceLines: Array.isArray(item.sourceLines) ? item.sourceLines : [],
        steps: Array.isArray(item.steps) ? item.steps : [],
        completed: Array.isArray(item.completed) ? item.completed : [],
        reference: typeof item.reference === "string" ? item.reference : "",
      }))
      : [];
  } catch {
    return [];
  }
}

function updateSavedList() {
  const items = loadSaved();
  savedCount.textContent = String(items.length);
  recentList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-recent";
    empty.innerHTML = "Your saved explanations<br />will show up here.";
    recentList.append(empty);
    return;
  }

  items.slice(0, 6).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-item";
    const title = document.createElement("span");
    title.textContent = item.title;
    const mode = document.createElement("small");
    mode.textContent = { explain: "Explain it", fix: "Help me fix it", next: "Next steps" }[item.mode] || "Saved";
    button.append(title, mode);
    button.title = item.title;
    button.addEventListener("click", () => showAnswer(item));
    recentList.append(button);
  });
}

function renderSavedLibrary(query = "") {
  const items = loadSaved();
  const normalizedQuery = cleanText(query).toLowerCase();
  const matches = items.filter((item) => `${item.title} ${item.source} ${item.explanation}`.toLowerCase().includes(normalizedQuery));
  savedResults.replaceChildren();
  document.querySelector("#saved-total").textContent = `${items.length} ${items.length === 1 ? "saved item" : "saved items"}`;

  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "library-empty";
    empty.textContent = items.length ? "No saved explanations match that search." : "Nothing saved yet. Save an explanation to find it here.";
    savedResults.append(empty);
    return;
  }

  matches.forEach((item) => {
    const row = document.createElement("article");
    row.className = "saved-entry";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "saved-entry-open";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const summary = document.createElement("span");
    summary.textContent = item.explanation;
    const metadata = document.createElement("small");
    const date = item.createdAt ? new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Saved";
    metadata.textContent = `${date} · ${{ explain: "Explain it", fix: "Help me fix it", next: "Next steps" }[item.mode] || "Saved"}`;
    open.append(title, summary, metadata);
    open.addEventListener("click", () => {
      showAnswer(item);
      closeSavedLibrary();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "saved-entry-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${item.title} from saved explanations`);
    remove.addEventListener("click", () => removeSaved(item.id));
    row.append(open, remove);
    savedResults.append(row);
  });
}

function openSavedLibrary() {
  renderSavedLibrary(document.querySelector("#saved-search").value);
  if (!savedDialog.open) savedDialog.showModal();
  document.querySelector("#saved-search").focus();
}

function closeSavedLibrary() {
  if (savedDialog.open) savedDialog.close();
}

function removeSaved(id) {
  const items = loadSaved().filter((item) => item.id !== id);
  try {
    localStorage.setItem("clearstep-saved", JSON.stringify(items));
  } catch {
    showToast("Could not update saved explanations in this browser");
    return;
  }
  updateSavedList();
  renderSavedLibrary(document.querySelector("#saved-search").value);
  if (currentAnswer?.id === id) updateSaveButton(false);
  showToast("Removed from your saved explanations");
}

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function makeTitle(text) {
  const firstLine = text.split(/\n/).map(cleanText).find(Boolean) || "Saved explanation";
  return firstLine.length > 43 ? `${firstLine.slice(0, 40).trimEnd()}…` : firstLine;
}

function identifyLines(text) {
  const lines = text.split(/\n+/).map(cleanText).filter(Boolean);
  const matches = lines.filter((line) =>
    /\b(error|failed|warning|must|should|required|deadline|due|by\s+(?:mon|tue|wed|thu|fri|sat|sun|\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|please|step\s*\d|\d+[.)])|[.!?]$|:\s/i.test(line),
  );
  return [...new Set(matches.length ? matches : lines)].slice(0, 4);
}

function makeAnswer(text, reference = "") {
  const mode = selectedMode;
  const lowerText = text.toLowerCase();
  const isTechnical = /error|exception|failed|refused|denied|undefined|not found|timeout|\b\d{3}\b/i.test(text);
  const depth = selectedDepth;
  const title = mode === "fix" ? "A sensible place to start" : mode === "next" ? "Your next steps" : "The short version";
  const sourceLines = identifyLines(text);
  let explanation;
  let steps;
  let extra = "";

  if (isTechnical && /econnrefused|connection refused/i.test(text)) {
    explanation = "The app tried to reach a service, but nothing accepted the connection at that address. This usually means the service is stopped, or the address or port does not match where it is listening.";
    steps = [
      "Start the database or service the app is trying to reach.",
      "Check the host and port in the app's connection settings. The message points to port 5432 on this machine.",
      "Retry the action. If it still fails, check the service logs and connection settings together.",
    ];
    if (depth === 2) extra = "ECONNREFUSED is a TCP connection error: the request reached the target machine, but there was no listener accepting connections on that port. It is different from a timeout, which usually means no response arrived.";
  } else if (isTechnical && /permission denied|access denied|forbidden/.test(lowerText)) {
    explanation = "The operation reached something it tried to use, but the current account or process was not allowed to access it. This points to an access rule, ownership, or sign-in state rather than a missing item.";
    steps = ["Check which account or process is performing the action.", "Confirm that it has permission for the named file, service, or resource.", "Retry after access is confirmed; avoid changing permissions broadly just to silence the message."];
    if (depth === 2) extra = "On a computer, access can depend on both the signed-in user and the process's permissions. A broad permission change may expose more than intended.";
  } else if (isTechnical && /timeout|timed out/.test(lowerText)) {
    explanation = "The requested operation took longer than the allowed wait, so it stopped before getting a response. The cause could be a slow service, network delay, or a wait limit that is too short.";
    steps = ["Retry once and check whether the service is responding.", "Check network or service status around the time this happened.", "If it repeats, note how long it waits and share the full error with the service owner."];
  } else if (isTechnical) {
    explanation = "This message signals that an operation did not complete as expected. The key is to identify what was being attempted, then check the setting, input, or service named in the message.";
    steps = [
      "Look at the line immediately before this message to see what action triggered it.",
      "Check the specific file, value, or service named in the message, including spelling and configuration.",
      "Try the same action again. If it fails, capture the full message and the step that triggered it.",
    ];
    if (depth === 2) extra = "Error messages are clues rather than complete diagnoses. The surrounding log lines and the change immediately before the failure often narrow down the cause.";
  } else {
    const actionLines = text.split(/\n+/).map(cleanText).filter((line) => /\b(please|must|need to|required|by\s+(?:mon|tue|wed|thu|fri|sat|sun|\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|deadline|due|bring|submit|sign|call|send|complete|respond|before)\b/i.test(line));
    explanation = actionLines.length
      ? "This looks like it contains a request or requirement. I’ve pulled out the lines that may affect what you need to do; confirm the exact details against the original message."
      : `The key idea appears to be “${sourceLines[0].slice(0, 100)}${sourceLines[0].length > 100 ? "…" : ""}”. Separate what the text says from what it asks you to do, and check any dates or requirements before acting.`;
    steps = actionLines.length
      ? ["Confirm any date, amount, or requirement in the original message.", "Gather the information or documents it asks for.", "Complete the requested action and keep a copy or confirmation."]
      : ["Identify the specific action or decision this information is asking for.", "Check any dates, requirements, or terms that could change what you need to do.", "Ask the sender to clarify anything that remains uncertain before acting."];
    if (depth === 2) extra = "For formal, financial, legal, or medical instructions, verify important details with the organization or a qualified professional before relying on a summary.";
  }

  if (mode === "fix") {
    explanation = isTechnical
      ? "Start with the simplest likely cause, then check one thing at a time. This message is a useful clue, but it may not identify the root cause by itself."
      : "Work through the instructions one requirement at a time. If a detail is missing or the request seems inconsistent, confirm it with the source before you proceed.";
  } else if (mode === "next") {
    explanation = isTechnical
      ? "Here is a low-risk sequence: check whether the service is available, verify its settings, then retry and capture any new error."
      : "Here is a practical order: identify the requested action, verify the details that affect it, then follow up on anything that remains unclear.";
  }

  if (depth === 0) steps = steps.slice(0, 2);
  if (mode === "explain") steps = steps.slice(0, depth === 0 ? 2 : 3);
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    title: makeTitle(text),
    source: text,
    mode,
    depth,
    heading: title,
    explanation,
    steps,
    sourceLines,
    extra,
    reference,
    completed: [],
    createdAt: new Date().toISOString(),
  };
}

function showAnswer(answer) {
  answer.completed = Array.isArray(answer.completed) ? answer.completed : [];
  answer.sourceLines = Array.isArray(answer.sourceLines) ? answer.sourceLines : [];
  answer.steps = Array.isArray(answer.steps) ? answer.steps : [];
  answer.reference = typeof answer.reference === "string" ? answer.reference : "";
  currentAnswer = answer;
  emptyAnswer.hidden = true;
  answerContent.hidden = false;
  answerContent.replaceChildren();

  const modeNames = { explain: "EXPLAIN IT", fix: "HELP ME FIX IT", next: "WHAT TO DO NEXT" };
  const mode = document.createElement("div");
  mode.className = "answer-mode";
  mode.textContent = modeNames[answer.mode] || modeNames.explain;
  const heading = document.createElement("h2");
  heading.textContent = answer.heading;
  const explanation = document.createElement("p");
  explanation.textContent = answer.explanation;
  answerContent.append(mode, heading, explanation);

  if (answer.reference) {
    const reference = document.createElement("a");
    reference.className = "answer-reference";
    reference.href = answer.reference;
    reference.target = "_blank";
    reference.rel = "noopener noreferrer";
    reference.textContent = `Source link · ${new URL(answer.reference).hostname}`;
    answerContent.append(reference);
  }

  if (answer.sourceLines.length) {
    const sourceSection = document.createElement("section");
    sourceSection.className = "answer-section";
    const sourceHeading = document.createElement("h3");
    sourceHeading.innerHTML = "<span aria-hidden=\"true\">↳</span> What stands out";
    const sourceList = document.createElement("ul");
    answer.sourceLines.slice(0, answer.depth === 0 ? 1 : 3).forEach((line) => {
      const item = document.createElement("li");
      const marker = document.createElement("span");
      marker.className = "list-marker";
      marker.textContent = "•";
      const text = document.createElement("span");
      text.textContent = line;
      item.append(marker, text);
      sourceList.append(item);
    });
    sourceSection.append(sourceHeading, sourceList);
    answerContent.append(sourceSection);
  }

  const stepsSection = document.createElement("section");
  stepsSection.className = "answer-section";
  const progressCount = document.createElement("span");
  progressCount.className = "progress-count";
  const progressHeading = document.createElement("div");
  progressHeading.className = "steps-heading";
  const stepsTitle = document.createElement("h3");
  stepsTitle.innerHTML = "<span aria-hidden=\"true\">↗</span> Your next moves";
  progressHeading.append(stepsTitle, progressCount);
  const progressTrack = document.createElement("div");
  progressTrack.className = "progress-track";
  progressTrack.setAttribute("role", "progressbar");
  progressTrack.setAttribute("aria-label", "Completed next steps");
  progressTrack.setAttribute("aria-valuemin", "0");
  progressTrack.setAttribute("aria-valuemax", String(answer.steps.length));
  const progressFill = document.createElement("span");
  progressFill.className = "progress-fill";
  progressTrack.append(progressFill);
  const stepsList = document.createElement("ol");
  stepsList.className = "checklist";
  const refreshProgress = () => {
    const complete = answer.completed.filter(Boolean).length;
    progressCount.textContent = `${complete}/${answer.steps.length} done`;
    progressTrack.setAttribute("aria-valuenow", String(complete));
    progressFill.style.width = `${answer.steps.length ? (complete / answer.steps.length) * 100 : 0}%`;
  };
  answer.steps.forEach((step, index) => {
    const item = document.createElement("li");
    item.className = "checklist-item";
    const checkbox = document.createElement("input");
    checkbox.id = `step-${answer.id}-${index}`;
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(answer.completed[index]);
    checkbox.setAttribute("aria-label", `Mark step ${index + 1} complete`);
    const text = document.createElement("label");
    text.htmlFor = checkbox.id;
    text.textContent = step;
    item.classList.toggle("is-complete", checkbox.checked);
    checkbox.addEventListener("change", () => {
      answer.completed[index] = checkbox.checked;
      item.classList.toggle("is-complete", checkbox.checked);
      refreshProgress();
      persistAnswerProgress(answer);
    });
    item.append(checkbox, text);
    stepsList.append(item);
  });
  stepsSection.append(progressHeading, progressTrack, stepsList);
  refreshProgress();
  answerContent.append(stepsSection);

  if (answer.extra) {
    const detail = document.createElement("section");
    detail.className = "answer-section";
    const detailHeading = document.createElement("h3");
    detailHeading.textContent = "A little more context";
    const detailText = document.createElement("p");
    detailText.textContent = answer.extra;
    detail.append(detailHeading, detailText);
    answerContent.append(detail);
  }

  const actions = document.createElement("div");
  actions.className = "answer-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "save-button";
  save.id = "save-answer";
  save.textContent = isAnswerSaved(answer) ? "Saved to library" : "Save to library";
  save.classList.toggle("is-saved", isAnswerSaved(answer));
  save.addEventListener("click", saveCurrentAnswer);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.textContent = "Copy explanation";
  copy.addEventListener("click", async () => {
    const text = `${answer.heading}\n\n${answer.explanation}\n\n${answer.steps.map((step, index) => `${answer.completed[index] ? "[x]" : "[ ]"} ${index + 1}. ${step}`).join("\n")}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast("Steps copied to clipboard");
    } catch {
      showToast("Clipboard access is unavailable in this browser");
    }
  });
  actions.append(save, copy);
  answerContent.append(actions);

  const disclaimer = document.createElement("p");
  disclaimer.className = "answer-disclaimer";
  disclaimer.textContent = "On-device first-pass read, not professional advice. Check important details against the original source.";
  answerContent.append(disclaimer);
}

function isAnswerSaved(answer) {
  return loadSaved().some((item) => item.id === answer.id);
}

function updateSaveButton(saved) {
  const button = document.querySelector("#save-answer");
  if (!button) return;
  button.textContent = saved ? "Saved to library" : "Save to library";
  button.classList.toggle("is-saved", saved);
}

function persistAnswerProgress(answer) {
  const items = loadSaved();
  const index = items.findIndex((item) => item.id === answer.id);
  if (index < 0) return;
  items[index] = answer;
  try {
    localStorage.setItem("clearstep-saved", JSON.stringify(items));
    updateSavedList();
  } catch {
    showToast("Progress could not be saved in this browser");
  }
}

function saveCurrentAnswer() {
  if (!currentAnswer) return;
  const items = loadSaved();
  const existing = items.findIndex((item) => item.id === currentAnswer.id);
  if (existing >= 0) items[existing] = currentAnswer;
  else items.unshift(currentAnswer);
  try {
    localStorage.setItem("clearstep-saved", JSON.stringify(items.slice(0, 30)));
    updateSavedList();
    updateSaveButton(true);
    showToast(existing >= 0 ? "Saved explanation updated" : "Saved on this device");
  } catch {
    showToast("Could not save in this browser");
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2300);
}

function updateCharacterCount() {
  const text = sourceInput.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  document.querySelector("#char-count").textContent = `${words.toLocaleString()} ${words === 1 ? "word" : "words"} · ${sourceInput.value.length.toLocaleString()} characters`;
}

function setSourceType(type) {
  sourceType = type;
  document.querySelectorAll(".source-tab").forEach((item) => {
    const active = item.dataset.source === type;
    item.classList.toggle("is-selected", active);
    item.setAttribute("aria-pressed", String(active));
  });
  const isLink = type === "link";
  document.querySelector("#link-field").hidden = !isLink;
  document.querySelector("#link-note").hidden = !isLink;
  sourceInput.setAttribute("aria-label", isLink ? "Text from the linked page to understand" : "Text to understand");
  document.querySelector("#source-hint").textContent = isLink ? "Add the page text below" : "Paste or type something that feels unclear";
}

async function loadTextFile(file) {
  if (!file) return;
  if (!/\.(txt|md|markdown|log|csv|json)$/i.test(file.name) && !file.type.startsWith("text/")) {
    showToast("Choose a text, Markdown, CSV, JSON, or log file");
    return;
  }
  if (file.size > 1_000_000) {
    showToast("Files must be smaller than 1 MB");
    return;
  }
  try {
    const text = await file.text();
    if (text.length > 40000) {
      showToast("This file is over the 40,000 character limit");
      return;
    }
    sourceInput.value = text;
    updateCharacterCount();
    inputError.textContent = "";
    showToast(`Added ${file.name}`);
    sourceInput.focus();
  } catch {
    showToast("Could not read that file");
  }
}

function useExample(name) {
  const sample = samples[name] || samples.error;
  sourceInput.value = sample.text;
  sourceLink.value = "";
  setSourceType("text");
  selectedMode = sample.mode;
  document.querySelectorAll(".mode-option").forEach((item) => {
    const active = item.dataset.mode === selectedMode;
    item.classList.toggle("is-selected", active);
    item.setAttribute("aria-pressed", String(active));
  });
  updateCharacterCount();
  showAnswer(makeAnswer(sample.text));
}

document.querySelectorAll(".mode-option").forEach((button) => {
  button.addEventListener("click", () => {
    selectedMode = button.dataset.mode;
    document.querySelectorAll(".mode-option").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-selected", active);
      item.setAttribute("aria-pressed", String(active));
    });
  });
});

document.querySelectorAll(".depth-option").forEach((button) => {
  button.addEventListener("click", () => {
    selectedDepth = Number(button.dataset.depth);
    document.querySelectorAll(".depth-option").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-selected", active);
      item.setAttribute("aria-pressed", String(active));
    });
    document.querySelector("#depth-description").textContent = depthDescriptions[selectedDepth];
  });
});

document.querySelectorAll(".source-tab").forEach((button) => {
  button.addEventListener("click", () => {
    setSourceType(button.dataset.source);
    sourceInput.focus();
  });
});

sourceInput.addEventListener("input", () => {
  updateCharacterCount();
  inputError.textContent = "";
});

document.querySelector("#clear-input").addEventListener("click", () => {
  sourceInput.value = "";
  sourceLink.value = "";
  updateCharacterCount();
  inputError.textContent = "";
  sourceInput.focus();
});

document.querySelector("#make-clear").addEventListener("click", () => {
  const text = cleanText(sourceInput.value);
  if (!text) {
    inputError.textContent = "Add some text first.";
    sourceInput.focus();
    return;
  }
  let reference = "";
  if (sourceLink.value.trim()) {
    try {
      const parsed = new URL(sourceLink.value.trim());
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("Unsupported protocol");
      reference = parsed.href;
    } catch {
      inputError.textContent = "Enter a valid http or https link.";
      sourceLink.focus();
      return;
    }
  }
  if (sourceType === "link" && !reference) {
    inputError.textContent = "Add a page link, or switch back to Text.";
    sourceLink.focus();
    return;
  }
  if (sourceType === "link" && !text) {
    inputError.textContent = "Paste the page text too; links are kept as a reference, not fetched.";
    sourceInput.focus();
    return;
  }
  inputError.textContent = "";
  showAnswer(makeAnswer(sourceInput.value, reference));
});

document.querySelector("#try-sample").addEventListener("click", () => {
  useExample("error");
});

document.querySelectorAll(".example-chip").forEach((button) => {
  button.addEventListener("click", () => useExample(button.dataset.example));
});

document.querySelector("#file-input").addEventListener("change", (event) => {
  loadTextFile(event.target.files[0]);
  event.target.value = "";
});

sourceBox.addEventListener("dragover", (event) => {
  event.preventDefault();
  sourceBox.classList.add("is-dragging");
});
sourceBox.addEventListener("dragleave", (event) => {
  if (!sourceBox.contains(event.relatedTarget)) sourceBox.classList.remove("is-dragging");
});
sourceBox.addEventListener("drop", (event) => {
  event.preventDefault();
  sourceBox.classList.remove("is-dragging");
  loadTextFile(event.dataTransfer.files[0]);
});

document.querySelector("#paste-input").addEventListener("click", async () => {
  try {
    sourceInput.value = await navigator.clipboard.readText();
    updateCharacterCount();
    inputError.textContent = "";
    sourceInput.focus();
  } catch {
    showToast("Clipboard access is unavailable; paste with your keyboard instead");
  }
});

document.querySelector("#saved-nav").addEventListener("click", openSavedLibrary);
document.querySelector("#close-saved").addEventListener("click", closeSavedLibrary);
document.querySelector("#saved-search").addEventListener("input", (event) => renderSavedLibrary(event.target.value));
savedDialog.addEventListener("click", (event) => {
  if (event.target === savedDialog) closeSavedLibrary();
});
document.querySelector("#workspace-nav").addEventListener("click", () => {
  document.querySelector("#workspace-nav").classList.add("is-active");
  document.querySelector("#saved-nav").classList.remove("is-active");
  sourceInput.focus();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    document.querySelector("#make-clear").click();
  }
});

updateSavedList();