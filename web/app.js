const byId = (id) => document.getElementById(id);
const time = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  timeZone: "Europe/London", timeZoneName: "short",
});
const hour = 60 * 60 * 1000;
const rangeButtons = [...document.querySelectorAll("[data-hours]")];
const status = byId("feed-status");

function showStatus(message, attention = false) {
  status.textContent = message;
  status.toggleAttribute("data-attention", attention);
}

function drawChart(readings, hours) {
  const end = Date.parse(readings.at(-1)[0]);
  const start = end - hours * hour;
  const points = readings
    .filter(([at]) => Date.parse(at) >= start)
    .map(([at, metres]) => [Date.parse(at), metres]);
  const heights = points.map(([, metres]) => metres);
  const low = Math.min(...heights) - .005;
  const high = Math.max(...heights) + .005;
  byId("levels").replaceChildren(...[high, (high + low) / 2, low].map((level) => {
    const label = document.createElement("span");
    label.textContent = level.toFixed(3);
    return label;
  }));
  const path = points.map(([at, metres], index) => {
    const x = 4 + (at - start) * 712 / (end - start);
    const y = 168 - (metres - low) * 156 / (high - low);
    const connect = index > 0 && at - points[index - 1][0] <= 45 * 60 * 1000;
    return (connect ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + (connect ? "" : "h.1");
  }).join(" ");
  byId("water-line").setAttribute("d", path);
  byId("chart").setAttribute("aria-label", "Gauge height, " + heights.at(-1).toFixed(3) +
    " metres at the latest reading. See recent measurements for values.");
  byId("range-start").textContent = time.format(start);
  byId("range-end").textContent = time.format(end);
  byId("range-note").textContent = points.length + " readings in this range. Gaps show missing readings.";
  rangeButtons.forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.hours) === hours)));
}

function showImports(runs) {
  const latest = runs[0];
  if (!latest) return;
  byId("last-import").textContent = time.format(new Date(latest.at)) + " · " + latest.received + " rows received";
  for (const field of ["added", "revised", "unchanged", "rejected"]) byId(field).textContent = latest[field];
  for (const [reason, count] of Object.entries(latest.reasons)) {
    const item = document.createElement("li");
    item.textContent = reason + " · " + count;
    byId("reject-reasons").append(item);
  }
  byId("reject-reasons").hidden = latest.rejected === 0;
  for (const run of runs) {
    const item = document.createElement("li");
    const title = document.createElement("div");
    title.className = "run-top";
    const at = document.createElement("time");
    at.dateTime = run.at;
    at.textContent = time.format(new Date(run.at));
    const state = document.createElement("span");
    state.className = "run-state";
    state.toggleAttribute("data-failed", Boolean(run.error));
    state.textContent = run.error ? "Refresh failed" : "Imported";
    title.append(at, state);
    const detail = document.createElement("p");
    detail.className = "run-note";
    detail.textContent = run.error || run.added + " new · " + run.revised + " revised · " +
      run.unchanged + " unchanged · " + run.rejected + " rejected";
    item.append(title, detail);
    byId("import-rows").append(item);
  }
}

try {
  const response = await fetch("/snapshot.json", { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("Snapshot unavailable");
  const snapshot = await response.json();
  const { readings, runs } = snapshot;
  const latest = readings.at(-1);
  if (latest) {
    byId("height").textContent = latest[1].toFixed(3) + " m";
    byId("measured-at").textContent = time.format(new Date(latest[0]));
    drawChart(readings, 24);
    rangeButtons.forEach((button) => button.addEventListener("click", () => drawChart(readings, Number(button.dataset.hours))));
    for (const [at, metres] of readings.slice(-12).reverse()) {
      const row = byId("reading-rows").insertRow();
      row.insertCell().textContent = time.format(new Date(at));
      row.insertCell().textContent = metres.toFixed(3);
    }
  } else {
    document.querySelector(".readings").hidden = true;
  }
  showImports(runs);
  byId("report").hidden = false;

  const lastImport = snapshot.last_import ? " Last good import " + time.format(new Date(snapshot.last_import)) + "." : "";
  if (response.headers.get("X-River-Snapshot") === "backup") {
    showStatus("Showing the backup snapshot because the latest report could not be loaded." + lastImport, true);
  } else if (runs[0]?.error || !latest) {
    showStatus((runs[0]?.error || "No readings have been imported yet.") + lastImport, true);
  } else if (Date.now() - Date.parse(runs[0].at) > 4 * hour) {
    showStatus("No import check reported in the last four hours." + lastImport, true);
  } else if (Date.now() - Date.parse(latest[0]) > 24 * hour) {
    showStatus("The latest gauge reading is over 24 hours old." + lastImport, true);
  } else {
    showStatus("Latest successful import " + time.format(new Date(snapshot.last_import)) + ".");
  }
} catch {
  showStatus("The readings could not be loaded. Refresh this page to try again.", true);
}
