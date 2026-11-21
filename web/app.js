const byId = (id) => document.getElementById(id);
const timeOptions = {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  timeZone: "Europe/London", timeZoneName: "short",
};
const time = new Intl.DateTimeFormat("en-GB", timeOptions);
const timeWithSeconds = new Intl.DateTimeFormat("en-GB", { ...timeOptions, second: "2-digit" });
const minute = 60_000;
const hour = 60 * minute;
const sampleInterval = 15 * minute;
const rangeButtons = [...document.querySelectorAll("[data-hours]")];
const status = byId("feed-status");
const download = byId("reading-download");

function showStatus(message, attention = false) {
  status.textContent = message;
  status.toggleAttribute("data-attention", attention);
}

function elapsedLabel(elapsed) {
  const hours = Math.floor(elapsed / hour);
  const minutes = Math.floor(elapsed % hour / minute);
  const seconds = elapsed % minute / 1000;
  return [hours && hours + " h", minutes && minutes + " min", seconds && seconds + " s"].filter(Boolean).join(" ");
}

function showGaps(gaps) {
  byId("reading-gaps").hidden = gaps.length === 0;
  byId("gap-rows").replaceChildren(...gaps.map(([before, after]) => {
    const label = document.createElement("span");
    const [start, end] = [before, after].map(at => {
      const observation = document.createElement("time");
      observation.dateTime = new Date(at).toISOString();
      observation.textContent = (at % minute ? timeWithSeconds : time).format(at);
      return observation;
    });
    label.append(start, " to ", end);
    const elapsed = document.createElement("strong");
    elapsed.textContent = elapsedLabel(after - before);
    const row = document.createElement("li");
    row.append(label, elapsed);
    return row;
  }));
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
  const chartX = at => (4 + (at - start) * 712 / (end - start)).toFixed(1);
  byId("levels").replaceChildren(...[high, (high + low) / 2, low].map((level) => {
    const label = document.createElement("span");
    label.textContent = level.toFixed(3);
    return label;
  }));
  const gaps = [];
  const path = points.map(([at, metres], index) => {
    const y = 168 - (metres - low) * 156 / (high - low);
    const connect = index > 0 && at - points[index - 1][0] <= sampleInterval;
    if (index > 0 && !connect) gaps.push([points[index - 1][0], at]);
    return (connect ? "L" : "M") + chartX(at) + " " + y.toFixed(1) + (connect ? "" : "h.1");
  }).join(" ");
  byId("water-line").setAttribute("d", path);
  byId("chart").setAttribute("aria-label", "Gauge height, " + heights.at(-1).toFixed(3) +
    " metres at the latest reading. See recent measurements for values.");
  byId("range-start").textContent = time.format(start);
  byId("range-end").textContent = time.format(end);
  byId("range-note").textContent = points.length + (points.length === 1 ? " reading" : " readings") +
    " · " + gaps.length + (gaps.length === 1 ? " gap" : " gaps") + " over 15 minutes.";
  showGaps(gaps);
  rangeButtons.forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.hours) === hours)));

  const slider = byId("reading-index");
  const guide = byId("reading-guide");
  const previous = byId("reading-prev");
  const next = byId("reading-next");
  slider.max = points.length - 1;
  slider.value = slider.max;
  slider.disabled = points.length === 1;
  function showReading() {
    const index = slider.valueAsNumber;
    const [at, metres] = points[index];
    const label = time.format(at) + " · " + metres.toFixed(3) + " m";
    byId("reading-value").textContent = label;
    slider.setAttribute("aria-valuetext", label);
    guide.setAttribute("x1", chartX(at));
    guide.setAttribute("x2", chartX(at));
    const active = document.activeElement;
    if ((index === 0 && active === previous) || (index === points.length - 1 && active === next)) slider.focus();
    previous.disabled = index === 0;
    next.disabled = index === points.length - 1;
  }
  slider.oninput = showReading;
  previous.onclick = () => { slider.stepDown(); showReading(); };
  next.onclick = () => { slider.stepUp(); showReading(); };
  showReading();

  const rows = points.map(([at, metres]) => new Date(at).toISOString() + "," + metres);
  const csv = new Blob(["observed_at_utc,height_m\r\n", rows.join("\r\n"), "\r\n"], { type: "text/csv;charset=utf-8" });
  if (download.hasAttribute("href")) URL.revokeObjectURL(download.href);
  download.href = URL.createObjectURL(csv);
  download.download = "causey-bridge-" + hours + "h-" + new Date(end).toISOString().slice(0, 10) + ".csv";
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
