const WMO = {
  0: "jasno",
  1: "pretezno jasno",
  2: "delno oblacno",
  3: "oblacno",
  45: "megla",
  48: "ivnata megla",
  51: "rahlo rosenje",
  53: "rosenje",
  55: "mocno rosenje",
  61: "rahel dez",
  63: "dez",
  65: "mocan dez",
  71: "rahel sneg",
  73: "sneg",
  75: "mocan sneg",
  80: "rahel naliv",
  81: "naliv",
  82: "mocan naliv",
  95: "nevihta",
};

const DEG = "\u00B0";
const form = document.querySelector("#search-form");
const locationInput = document.querySelector("#location-input");
const daysSelect = document.querySelector("#days-select");
const includeRain = document.querySelector("#include-rain");
const statusEl = document.querySelector("#status");
const button = form.querySelector("button");
const hourButtons = [...document.querySelectorAll(".hour-button")];
const hourScrollButtons = [...document.querySelectorAll("[data-hour-scroll]")];

let latestData = null;
let selectedHours = 24;
let selectedDate = null;
let selectedStep = 1;

const ui = {
  avgTemp: document.querySelector("#avg-temp"),
  avgTempDetail: document.querySelector("#avg-temp-detail"),
  avgRain: document.querySelector("#avg-rain"),
  avgRainDetail: document.querySelector("#avg-rain-detail"),
  avgWind: document.querySelector("#avg-wind"),
  avgWindDetail: document.querySelector("#avg-wind-detail"),
  confidence: document.querySelector("#confidence"),
  confidenceDetail: document.querySelector("#confidence-detail"),
  chartRange: document.querySelector("#chart-range"),
  currentPlace: document.querySelector("#current-place"),
  currentHour: document.querySelector("#current-hour"),
  currentSymbol: document.querySelector("#current-symbol"),
  currentDesc: document.querySelector("#current-desc"),
  chipTemp: document.querySelector("#chip-temp"),
  chipPlace: document.querySelector("#chip-place"),
  dailyCards: document.querySelector("#daily-cards"),
  hourScrollArea: document.querySelector("#hour-scroll-area"),
  hourlyGrid: document.querySelector("#hourly-grid"),
  modelsList: document.querySelector("#models-list"),
  modelCount: document.querySelector("#model-count"),
};

includeRain.closest("label").style.display = "none";

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadForecast();
});

hourButtons.forEach((hourButton) => {
  hourButton.addEventListener("click", () => {
    selectedHours = Number(hourButton.dataset.hours);
    selectedStep = selectedHours === 48 ? 3 : 1;
    if (selectedHours === 72) selectedDate = null;
    hourButtons.forEach((item) => item.classList.toggle("active", item === hourButton));
    if (latestData) renderHourly(latestData.averaged.hourly);
  });
});

hourScrollButtons.forEach((scrollButton) => {
  scrollButton.addEventListener("click", () => {
    const direction = Number(scrollButton.dataset.hourScroll);
    ui.hourScrollArea.scrollBy({
      left: direction * Math.max(280, ui.hourScrollArea.clientWidth * 0.75),
      behavior: "smooth",
    });
  });
});

ui.hourScrollArea.addEventListener("scroll", updateHourScrollButtons, { passive: true });
window.addEventListener("resize", updateHourScrollButtons);

loadForecast();

async function loadForecast() {
  const location = locationInput.value.trim();
  const days = Number(daysSelect.value);

  if (!location) {
    setStatus("Vnesi lokacijo.", true);
    return;
  }

  setLoading(true);
  setStatus("FARSO nalaga vremenske napovedi in racuna povprecje ...");

  try {
    const url = new URL("/api/forecast", window.location.origin);
    url.searchParams.set("location", location);
    url.searchParams.set("days", String(days));

    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Napovedi ni bilo mogoce naloziti.");

    latestData = data;
    render(data);
    const active = data.sources.filter((source) => source.ok).length;
    setStatus(`FARSO izracun: povprecje iz ${active} virov.`);
  } catch (error) {
    setStatus(error.message || "Napovedi ni bilo mogoce naloziti.", true);
  } finally {
    setLoading(false);
  }
}

function render(data) {
  const { averaged, sources, place, observation } = data;
  const current = averaged.hourly[0];
  const next24 = averaged.hourly.slice(0, 24);
  const daily = averaged.daily;
  const activeSources = sources.filter((source) => source.ok);
  const avgTemp = mean(next24.map((hour) => hour.temp));
  const meanSpread = mean(next24.map((hour) => hour.spread));
  const rainSum = sum(daily.map((day) => day.rain));

  ui.currentPlace.textContent = shortPlace(place);
  ui.chipPlace.textContent = shortPlace(place);
  ui.currentHour.textContent = formatHour(current?.time);
  ui.currentDesc.textContent = capitalize(weatherText(current?.code));
  ui.currentSymbol.className = "current-icon";
  ui.currentSymbol.innerHTML = weatherIconMarkup(current, "big");
  ui.avgTemp.textContent = format(avgTemp, 0);
  ui.chipTemp.textContent = `${format(avgTemp, 0)} ${DEG}C`;
  ui.avgTempDetail.textContent = observation?.temp
    ? `${placeLabel(place)}, ${observationLabel(observation)} ${format(observation.temp, 1)}${DEG}C`
    : `${placeLabel(place)}, ${activeSources.length} virov`;
  ui.avgRain.textContent = `${format(rainSum, 1)} mm`;
  ui.avgRainDetail.textContent = `${format(mean(next24.map((hour) => hour.rainChance)), 0)}% verjetnost`;
  ui.avgWind.textContent = `${format(mean(next24.map((hour) => hour.wind)), 0)} km/h`;
  ui.avgWindDetail.textContent = "povprecje 24 h";
  ui.confidence.textContent = confidenceLabel(meanSpread);
  ui.confidenceDetail.textContent = `razpon ${format(meanSpread, 1)}${DEG}C`;
  ui.chartRange.textContent = `${formatDate(averaged.hourly[0]?.time)} - ${formatDate(averaged.hourly.at(-1)?.time)}`;

  renderDailyCards(daily);
  renderHourly(averaged.hourly);
  renderSources(sources, activeSources);
}

function renderDailyCards(days) {
  const cards = days.slice(0, 5).map((day, index) => `
    <button class="day-card ${day.date === selectedDate || (!selectedDate && index === 0) ? "active" : ""}" type="button" data-date="${day.date}">
      <span class="day-icon">${weatherIconMarkup(day, "small", "daily")}</span>
      <div>
        <strong>${index === 0 ? "Danes" : formatDayName(day.date)}</strong>
        <small>${formatShortDate(day.date)}</small>
      </div>
      <div class="day-temps">
        <span>${format(day.maxTemp, 0)} ${DEG}C</span>
        <span>${format(day.minTemp, 0)} ${DEG}C</span>
      </div>
    </button>
  `);

  cards.push(`<article class="next-days">Naslednjih<br>5 dni <span>›</span></article>`);
  ui.dailyCards.innerHTML = cards.join("");

  ui.dailyCards.querySelectorAll(".day-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedDate = card.dataset.date;
      selectedStep = 3;
      selectedHours = 48;
      hourButtons.forEach((item) => item.classList.toggle("active", item.dataset.hours === "48"));
      renderDailyCards(latestData.averaged.daily);
      renderHourly(latestData.averaged.hourly);
    });
  });
}

function renderHourly(hourly) {
  const matchingDate = selectedDate
    ? hourly.filter((hour) => hour.time.slice(0, 10) === selectedDate)
    : hourly;
  const rows = matchingDate
    .filter((_, index) => selectedStep === 1 || index % selectedStep === 0)
    .slice(0, selectedDate ? 24 : selectedHours);
  const temps = rows.map((hour) => hour.temp).filter(Number.isFinite);
  const min = Math.min(...temps);
  const max = Math.max(...temps);

  ui.hourScrollArea.scrollLeft = 0;
  ui.hourlyGrid.style.gridTemplateColumns = `repeat(${rows.length}, minmax(116px, 116px))`;
  ui.hourlyGrid.innerHTML = rows.map((hour) => {
    const pct = Number.isFinite(hour.temp)
      ? 35 + ((hour.temp - min) / Math.max(1, max - min)) * 32
      : 45;

    return `
      <article class="hour-col" style="--bar:${pct}%">
        <div class="hour-time">${formatHourOnly(hour.time)}</div>
        <div class="hour-icon">${weatherIconMarkup(hour, "hour")}</div>
        <div class="hour-temp">${format(hour.temp, 0)} ${DEG}C</div>
        <div class="hour-wind" title="${conditionTitle(hour)}">
          <span>${conditionVoteLabel(hour)}</span>
          <span class="wind-speed">veter ${format(hour.wind, 0)}</span>
        </div>
      </article>
    `;
  }).join("");
  updateHourScrollButtons();
}

function renderSources(sources, activeSources) {
  ui.modelCount.textContent = `${activeSources.length} aktivni viri`;

  const comparableSources = activeSources.filter((source) => source.comparable);
  const maxTemp = Math.max(1, ...comparableSources.map((source) => source.temp24));

  ui.modelsList.innerHTML = sources.map((source) => {
    if (!source.ok) {
      return `
        <article class="model-item inactive">
          <header><strong>${source.name}</strong><span>ni na voljo</span></header>
          <p>${source.error || "Vir ni vrnil uporabnih podatkov."}</p>
        </article>
      `;
    }

    const tempWidth = source.comparable ? Math.max(4, Math.min(100, (source.temp24 / maxTemp) * 100)) : 0;
    const rainWidth = source.comparable ? Math.max(4, Math.min(100, source.rainChance24 || source.rain24 * 8)) : 0;
    const valueText = source.comparable ? `${format(source.temp24, 1)}${DEG}C` : "premalo ur";

    return `
      <article class="model-item">
        <header><strong>${source.name}</strong><span>${valueText}</span></header>
        <p>${source.note} · ${source.matchedHours || 0}/24 poravnanih ur</p>
        ${calibrationMarkup(source.calibration)}
        <div class="model-bars" aria-hidden="true">
          <div class="bar"><span style="width:${tempWidth}%"></span></div>
          <div class="bar rain"><span style="width:${rainWidth}%"></span></div>
        </div>
      </article>
    `;
  }).join("");
}

function calibrationMarkup(calibration) {
  if (!calibration || !Number.isFinite(calibration.bias)) return "";
  const signedBias = calibration.bias > 0 ? `+${format(calibration.bias, 1)}` : format(calibration.bias, 1);
  const learned = calibration.learnedSamples
    ? ` · MAE ${format(calibration.learnedMae, 1)}${DEG}C/${calibration.learnedSamples}x`
    : "";
  return `<p class="calibration-line">${calibration.station || "ARSO"} odklon ${signedBias}${DEG}C · utež ${format(calibration.weight, 2)}${learned}</p>`;
}

function observationLabel(observation) {
  const distance = Number.isFinite(observation?.distanceKm) ? ` ${format(observation.distanceKm, 0)} km` : "";
  return `${observation?.station || "ARSO"}${distance}`;
}

function updateHourScrollButtons() {
  if (!ui.hourScrollArea) return;
  const maxScroll = ui.hourScrollArea.scrollWidth - ui.hourScrollArea.clientWidth;
  const canScroll = maxScroll > 4;

  hourScrollButtons.forEach((buttonEl) => {
    const direction = Number(buttonEl.dataset.hourScroll);
    buttonEl.hidden = !canScroll;
    buttonEl.disabled = direction < 0
      ? ui.hourScrollArea.scrollLeft <= 2
      : ui.hourScrollArea.scrollLeft >= maxScroll - 2;
  });
}

function confidenceLabel(spreadValue) {
  if (spreadValue <= 1.5) return "visoka";
  if (spreadValue <= 3.5) return "srednja";
  return "nizja";
}

function weatherText(code) {
  return WMO[code] || "spremenljivo";
}

function weatherIconMarkup(weather, size = "hour", period = "hourly") {
  const code = typeof weather === "number" ? weather : weather?.code;
  const type = weatherClass(code) || "clear";
  const partly = code === 2;
  const parts = [`<span class="meteo-icon ${size} ${type}${partly ? " partly" : ""}" aria-hidden="true">`];

  if (["clear", "cloud", "rain", "snow", "storm"].includes(type)) {
    parts.push(`<span class="mi-sun"></span>`);
  }

  if (["cloud", "rain", "snow", "storm"].includes(type)) {
    parts.push(`<span class="mi-cloud"></span>`);
  }

  if (type === "rain" || type === "storm") {
    rainDropClasses(weather, period).forEach((dropClass) => {
      parts.push(`<span class="mi-drop ${dropClass}"></span>`);
    });
  }

  if (type === "snow") {
    parts.push(`<span class="mi-snow s1">*</span><span class="mi-snow s2">*</span><span class="mi-snow s3">*</span>`);
  }

  if (type === "mist") {
    parts.push(`<span class="mi-fog f1"></span><span class="mi-fog f2"></span><span class="mi-fog f3"></span>`);
  }

  if (type === "storm") {
    parts.push(`<span class="mi-bolt"></span>`);
  }

  parts.push(`</span>`);
  return parts.join("");
}

function rainDropClasses(weather, period) {
  const count = precipitationIntensity(weather, period);
  if (count <= 1) return ["d2"];
  if (count === 2) return ["d1", "d3"];
  return ["d1", "d2", "d3"];
}

function precipitationIntensity(weather, period = "hourly") {
  const code = typeof weather === "number" ? weather : weather?.code;
  if ([55, 65, 82, 95].includes(code)) return 3;
  if ([53, 63, 81].includes(code)) return 2;

  const rain = Number(weather?.rain);
  if (Number.isFinite(rain)) {
    const strong = period === "daily" ? 8 : 1;
    const moderate = period === "daily" ? 2 : 0.25;
    if (rain >= strong) return 3;
    if (rain >= moderate) return 2;
    if (rain > 0.05) return 1;
  }

  const rainChance = Number(weather?.rainChance);
  if (Number.isFinite(rainChance)) {
    if (rainChance >= 85) return 3;
    if (rainChance >= 55) return 2;
  }

  if ([51, 61, 80].includes(code)) return 1;
  return 1;
}

function weatherClass(code) {
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "rain";
  if ([45, 48].includes(code)) return "mist";
  if ([71, 73, 75].includes(code)) return "snow";
  if (code === 95) return "storm";
  if ([2, 3].includes(code)) return "cloud";
  return "";
}

function conditionVoteLabel(hour) {
  const condition = hour.condition || conditionFromCode(hour.code);
  const votes = hour.conditionVotes || {};
  const total = Object.values(votes).reduce((sum, count) => sum + count, 0);
  const winner = Math.round(votes[condition] || 0);
  const denominator = Math.round(total || hour.sampleSize || 0);
  return `${conditionShort(condition)} ${winner}/${denominator}`;
}

function conditionTitle(hour) {
  const votes = hour.conditionVotes || {};
  const parts = Object.entries(votes)
    .sort((a, b) => b[1] - a[1])
    .map(([condition, count]) => `${conditionName(condition)}: ${format(count, 1)} utezi`);
  return parts.length ? parts.join(", ") : "ni glasov virov";
}

function conditionFromCode(code) {
  if (code === 95) return "storm";
  if ([71, 73, 75].includes(code)) return "snow";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "rain";
  if ([45, 48].includes(code)) return "fog";
  if (code === 3) return "cloudy";
  if (code === 2) return "partly";
  if ([0, 1].includes(code)) return "clear";
  return "unknown";
}

function conditionShort(condition) {
  return {
    clear: "jasno",
    partly: "delno",
    cloudy: "obl.",
    fog: "megla",
    rain: "dez",
    snow: "sneg",
    storm: "nevihta",
    unknown: "?",
  }[condition] || "?";
}

function conditionName(condition) {
  return {
    clear: "jasno",
    partly: "delno oblacno",
    cloudy: "oblacno",
    fog: "megla",
    rain: "dez",
    snow: "sneg",
    storm: "nevihta",
    unknown: "neznano",
  }[condition] || condition;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setLoading(isLoading) {
  button.disabled = isLoading;
  button.textContent = isLoading ? "…" : "⌕";
}

function validNumbers(values) {
  return values.filter(Number.isFinite);
}

function mean(values) {
  const numbers = validNumbers(values);
  return numbers.length ? sum(numbers) / numbers.length : Number.NaN;
}

function sum(values) {
  return validNumbers(values).reduce((total, value) => total + value, 0);
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "--";
}

function shortPlace(place) {
  return place?.name || "--";
}

function placeLabel(place) {
  return [place.name, place.admin1, place.country].filter(Boolean).join(", ");
}

function format(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits).replace(".", ",") : "--";
}

function formatDate(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("sl-SI", {
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function formatShortDate(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("sl-SI", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

function formatDayName(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("sl-SI", {
    weekday: "long",
  }).format(new Date(value));
}

function formatHour(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("sl-SI", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatHourOnly(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("sl-SI", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
