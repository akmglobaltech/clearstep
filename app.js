const sourceInput = document.querySelector("#source-input");
const answerContent = document.querySelector("#answer-content");
const emptyAnswer = document.querySelector("#empty-answer");
const inputError = document.querySelector("#input-error");
const savedCount = document.querySelector("#saved-count");
const recentList = document.querySelector("#recent-list");
const toast = document.querySelector("#toast");

const depthDescriptions = [
  "Simple words, no assumed knowledge",
  "Useful context without the jargon overload",
  "More context, terminology, and edge cases",
];
const sampleText = "Error: connect ECONNREFUSED 127.0.0.1:5432\n\nThe app could not connect to the database. Check that the database server is running and accepting TCP/IP connections.";
let selectedMode = "explain";
let selectedDepth = 0;
let sourceType = "text";
let currentAnswer = null;
let toastTimer;

function loadSaved() {
  try {
    const items = JSON.parse(localStorage.getItem("clearstep-saved") || "[]");
    return Array.isArray(items) ? items : [];
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

  items.slice(0, 8).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-item";
    button.textContent = item.title;
    button.title = item.title;
    button.addEventListener("click", () => showAnswer(item));
    recentList.append(button);
  });
}

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function makeTitle(text) {
  const firstLine = text.split(/\n/).map(cleanText).find(Boolean) || "Saved explanation";
  return firstLine.length > 43 ? `${firstLine.slice(0, 40).trimEnd()}…` : firstLine;
}

function identifyLines(text) {
  const matches = text.split(/\n+/).map(cleanText).filter((line) =>
    /\b(https?:\/\/|error|failed|warning|must|should|do not|don't|step\s*\d|\d+[.)])|[.!?]$|:\s/.test(line),
  );
  const unique = [...new Set(matches)];
  return unique.slice(0, 4);
}

function makeAnswer(text) {
  const mode = selectedMode;
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
  } else if (isTechnical) {
    explanation = "This message signals that an operation did not complete as expected. The key is to identify what was being attempted, then check the setting, input, or service named in the message.";
    steps = [
      "Look at the line immediately before this message to see what action triggered it.",
      "Check the specific file, value, or service named in the message, including spelling and configuration.",
      "Try the same action again. If it fails, capture the full message and the step that triggered it.",
    ];
    if (depth === 2) extra = "Error messages are clues rather than complete diagnoses. The surrounding log lines and the change immediately before the failure often narrow down the cause.";
  } else {
    explanation = `This text is asking you to pay attention to ${sourceLines[0] ? `“${sourceLines[0].slice(0, 100)}${sourceLines[0].length > 100 ? "…" : ""}”` : "the information it contains"}. The useful part is separating what it says from what it expects you to do.`;
    steps = [
      "Identify the specific action or decision this information is asking for.",
      "Check any dates, requirements, or terms that could change what you need to do.",
      "If something is still unclear, ask the sender to clarify that point before acting.",
    ];
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
    createdAt: new Date().toISOString(),
  };
}

function showAnswer(answer) {
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
  const stepsHeading = document.createElement("h3");
  stepsHeading.innerHTML = "<span aria-hidden=\"true\">↗</span> Try this next";
  const stepsList = document.createElement("ol");
  answer.steps.forEach((step, index) => {
    const item = document.createElement("li");
    const marker = document.createElement("span");
    marker.className = "list-marker";
    marker.textContent = String(index + 1);
    const text = document.createElement("span");
    text.textContent = step;
    item.append(marker, text);
    stepsList.append(item);
  });
  stepsSection.append(stepsHeading, stepsList);
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
  save.textContent = "Save explanation";
  save.addEventListener("click", saveCurrentAnswer);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-button";
  copy.textContent = "Copy steps";
  copy.addEventListener("click", async () => {
    const text = `${answer.heading}\n\n${answer.explanation}\n\n${answer.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
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
  disclaimer.textContent = "Local first-pass preview based only on the text you provided. Check important details with the original source.";
  answerContent.append(disclaimer);
}

function saveCurrentAnswer() {
  if (!currentAnswer) return;
  const items = loadSaved();
  if (items.some((item) => item.source === currentAnswer.source && item.mode === currentAnswer.mode)) {
    showToast("This explanation is already saved");
    return;
  }
  items.unshift(currentAnswer);
  try {
    localStorage.setItem("clearstep-saved", JSON.stringify(items.slice(0, 30)));
    updateSavedList();
    showToast("Saved on this device");
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
  const count = sourceInput.value.length;
  document.querySelector("#char-count").textContent = `${count.toLocaleString()} ${count === 1 ? "character" : "characters"}`;
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
    sourceType = button.dataset.source;
    document.querySelectorAll(".source-tab").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-selected", active);
      item.setAttribute("aria-pressed", String(active));
    });
    const isLink = sourceType === "link";
    sourceInput.placeholder = isLink ? "Paste a link, then add the relevant text below…" : "Paste an error, confusing message, or instructions…";
    document.querySelector("#source-hint").textContent = isLink ? "Links are kept as a reference; paste text to analyze" : "Paste or type anything that feels unclear";
    sourceInput.setAttribute("aria-label", isLink ? "Link and text to understand" : "Text to understand");
    sourceInput.focus();
  });
});

sourceInput.addEventListener("input", () => {
  updateCharacterCount();
  inputError.textContent = "";
});

document.querySelector("#clear-input").addEventListener("click", () => {
  sourceInput.value = "";
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
  if (/^https?:\/\/\S+$/i.test(text)) {
    inputError.textContent = "Paste the relevant page text too; this preview cannot read links yet.";
    sourceInput.focus();
    return;
  }
  inputError.textContent = "";
  showAnswer(makeAnswer(sourceInput.value));
});

document.querySelector("#try-sample").addEventListener("click", () => {
  sourceInput.value = sampleText;
  sourceType = "text";
  document.querySelectorAll(".source-tab").forEach((item) => {
    const active = item.dataset.source === "text";
    item.classList.toggle("is-selected", active);
    item.setAttribute("aria-pressed", String(active));
  });
  sourceInput.placeholder = "Paste an error, confusing message, or instructions…";
  document.querySelector("#source-hint").textContent = "Paste or type anything that feels unclear";
  sourceInput.setAttribute("aria-label", "Text to understand");
  updateCharacterCount();
  showAnswer(makeAnswer(sampleText));
});

document.querySelector("#saved-nav").addEventListener("click", () => {
  const first = loadSaved()[0];
  if (first) showAnswer(first);
  else showToast("Your saved explanations will appear here");
});
document.querySelector("#workspace-nav").addEventListener("click", () => sourceInput.focus());

updateSavedList();