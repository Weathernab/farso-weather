import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 5173);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const forecastCache = new Map();
const CACHE_MS = 10 * 60 * 1000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const FETCH_TIMEOUT_MS = 8000;
const OBSERVATION_TIMEOUT_MS = 5000;
const APP_TIMEZONE = "Europe/Ljubljana";
const ARSO_AMS_OBSERVATIONS =
  "https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observationAms_si_latest.xml";
const ARSO_BEZIGRAD_OBSERVATION =
  "https://meteo.arso.gov.si/uploads/probase/www/observ/surface/text/sl/observationAms_LJUBL-ANA_BEZIGRAD_latest.xml";
const scoreFile = join(root, ".farso-cache", "model-scores.json");
const SCORE_DECAY = 0.18;
const MAX_STORED_PREDICTION_HOURS = 96;

const SOURCES = [
  {
    id: "openmeteo_best",
    name: "Open-Meteo",
    note: "samodejno najboljsi lokalni model",
    openMeteoModel: "best_match",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "best_match" }),
  },
  {
    id: "met_yr",
    name: "MET Norway / Yr",
    note: "norveski meteoroloski API",
    fetcher: fetchMetNo,
  },
  {
    id: "wttr",
    name: "wttr.in",
    note: "javna vremenska napoved",
    fetcher: fetchWttr,
  },
  {
    id: "seven_timer",
    name: "7Timer Civil",
    note: "neodvisna javna tockovna napoved",
    fetcher: (place, days) => fetchSevenTimer(place, days, "civil"),
  },
  {
    id: "seven_timer_meteo",
    name: "7Timer Meteo",
    note: "7Timer meteoroloski produkt za kontrolno primerjavo",
    fetcher: (place, days) => fetchSevenTimer(place, days, "meteo"),
  },
  {
    id: "dwd_icon",
    name: "DWD ICON",
    note: "nemski ICON model prek Open-Meteo",
    openMeteoModel: "icon_seamless",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/dwd-icon"),
  },
  {
    id: "icon_eu",
    name: "DWD ICON-EU",
    note: "visjelocljiv evropski ICON model",
    openMeteoModel: "icon_eu",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "icon_eu" }),
  },
  {
    id: "meteoswiss_icon",
    name: "MeteoSwiss ICON",
    note: "svicarski visokoresolucijski ICON model",
    openMeteoModel: "meteoswiss_icon_seamless",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "meteoswiss_icon_seamless" }),
  },
  {
    id: "geosphere",
    name: "GeoSphere Austria",
    note: "avstrijski regionalni model, prostorsko blizu Sloveniji",
    openMeteoModel: "geosphere_seamless",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "geosphere_seamless" }),
  },
  {
    id: "italia_meteo",
    name: "ItaliaMeteo ICON-2I",
    note: "italijanski regionalni model ICON-2I",
    openMeteoModel: "italia_meteo_arpae_icon_2i",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "italia_meteo_arpae_icon_2i" }),
  },
  {
    id: "meteofrance",
    name: "Meteo-France ARPEGE",
    note: "francoski ARPEGE model prek Open-Meteo",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/meteofrance"),
  },
  {
    id: "ecmwf",
    name: "ECMWF IFS",
    note: "evropski globalni model prek Open-Meteo",
    openMeteoModel: "ecmwf_ifs025",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/ecmwf"),
  },
  {
    id: "ecmwf_aifs",
    name: "ECMWF AIFS",
    note: "AI napovedni model ECMWF za dodatno primerjavo",
    openMeteoModel: "ecmwf_aifs025_single",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "ecmwf_aifs025_single" }),
  },
  {
    id: "ukmo",
    name: "UKMO",
    note: "britanski globalni model Met Office",
    openMeteoModel: "ukmo_seamless",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "ukmo_seamless" }),
  },
  {
    id: "knmi",
    name: "KNMI Harmonie",
    note: "nizozemski regionalni model kot neodvisna kontrola",
    openMeteoModel: "knmi_seamless",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "knmi_seamless" }),
  },
  {
    id: "dmi",
    name: "DMI Harmonie",
    note: "danski regionalni model kot neodvisna kontrola",
    openMeteoModel: "dmi_seamless",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "dmi_seamless" }),
  },
  {
    id: "gfs",
    name: "NOAA GFS",
    note: "ameriski globalni model prek Open-Meteo",
    openMeteoModel: "gfs_seamless",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/gfs"),
  },
  {
    id: "gem",
    name: "GEM Canada",
    note: "kanadski globalni model za neodvisno primerjavo",
    openMeteoModel: "gem_seamless",
    fetcher: (place, days) => fetchOpenMeteo(place, days, "/v1/forecast", { models: "gem_seamless" }),
  },
  {
    id: "arso",
    name: "ARSO",
    note: "uradna ARSO 3-urna napoved za Ljubljano",
    fetcher: fetchArso,
  },
];

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://localhost:${port}`);

    if (url.pathname === "/api/forecast") {
      await handleForecast(url, response);
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = normalize(join(root, requested));

    if (!filePath.startsWith(normalize(root))) {
      send(response, 403, "text/plain; charset=utf-8", "Forbidden");
      return;
    }

    const body = await readFile(filePath);
    send(response, 200, types[extname(filePath)] || "application/octet-stream", body);
  } catch (error) {
    send(response, 500, "application/json; charset=utf-8", {
      error: error.message || "Napaka streznika.",
    });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Weather app: http://127.0.0.1:${port}`);
});

async function handleForecast(url, response) {
  const query = url.searchParams.get("location")?.trim() || "Ljubljana";
  const days = clamp(Number(url.searchParams.get("days") || 5), 1, 7);
  const cacheKey = `${query.toLowerCase()}::${days}`;
  const cached = forecastCache.get(cacheKey);

  if (cached && Date.now() - cached.savedAt < CACHE_MS) {
    const scoreStore = await loadScoreStore();
    const observation = cached.payload.observation || null;
    const learningUpdate = updateScoresFromObservation(scoreStore, observation);
    await saveScoreStore(scoreStore);

    send(response, 200, "application/json; charset=utf-8", {
      ...cached.payload,
      observation: observation || cached.payload.observation,
      learning: learningSummary(scoreStore, learningUpdate),
      cached: true,
      cacheAgeSeconds: Math.round((Date.now() - cached.savedAt) / 1000),
    });
    return;
  }

  const place = await geocode(query);
  const openMeteoSources = SOURCES.filter((source) => source.openMeteoModel);
  const openMeteoBatchPromise = openMeteoSources.length
    ? fetchOpenMeteoBatch(place, days, openMeteoSources)
    : Promise.resolve(null);

  const results = await mapLimit(SOURCES, 6, async (source) => {
    try {
      const forecast = source.openMeteoModel
        ? fromOpenMeteoBatch(await openMeteoBatchPromise, source.openMeteoModel)
        : await source.fetcher(place, days);
      return {
        ...sourceMeta(source),
        ok: true,
        rawHours: forecast.hourly?.length || 0,
        forecast: normalizeForecast(forecast, days),
      };
    } catch (error) {
      return { ...sourceMeta(source), ok: false, error: error.message || "ni podatkov" };
    }
  });

  const usable = results.filter((source) => source.ok && source.forecast?.hourly?.length);
  const observation = await fetchObservation(place).catch(() => null);
  const scoreStore = await loadScoreStore();
  const learningUpdate = updateScoresFromObservation(scoreStore, observation);
  const calibrated = calibrateSources(usable, observation, scoreStore);

  if (calibrated.length < 2) {
    if (cached) {
      send(response, 200, "application/json; charset=utf-8", {
        ...cached.payload,
        cached: true,
        stale: true,
        cacheAgeSeconds: Math.round((Date.now() - cached.savedAt) / 1000),
        warning: "Svezi viri niso bili dovolj odzivni, zato je prikazana zadnja znana napoved.",
      });
      return;
    }

    send(response, 502, "application/json; charset=utf-8", {
      error: "Premalo virov je vrnilo uporabne podatke za izracun povprecja.",
      place,
      sources: results.map(stripForecast),
    });
    return;
  }

  const averaged = averageSources(calibrated, days);
  rememberPredictions(scoreStore, usable, observation);
  await saveScoreStore(scoreStore);

  const payload = {
    place,
    generatedAt: new Date().toISOString(),
    observation,
    learning: learningSummary(scoreStore, learningUpdate),
    averaged,
    sources: results.map((source) => summarizeSource(calibrated.find((item) => item.id === source.id) || source, averaged.hourly)),
  };

  forecastCache.set(cacheKey, { savedAt: Date.now(), payload });
  send(response, 200, "application/json; charset=utf-8", payload);
}

async function geocode(query) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "sl");
  url.searchParams.set("format", "json");

  const data = await fetchJson(url);
  if (!data.results?.length) {
    throw new Error("Lokacije nisem nasel.");
  }

  const result = data.results[0];
  return {
    name: result.name,
    admin1: result.admin1,
    country: result.country,
    latitude: result.latitude,
    longitude: result.longitude,
    elevation: result.elevation,
    timezone: result.timezone || "auto",
  };
}

async function fetchOpenMeteo(place, days, endpoint, extra = {}) {
  const url = openMeteoUrl(place, days, endpoint, extra);

  try {
    const data = await fetchJson(url);
    return fromOpenMeteo(data);
  } catch (error) {
    if (endpoint === "/v1/forecast" && extra.models) {
      const fallbackUrl = openMeteoUrl(place, days, "/v1/forecast");
      const data = await fetchJson(fallbackUrl);
      return fromOpenMeteo(data);
    }

    throw error;
  }
}

function openMeteoUrl(place, days, endpoint, extra = {}) {
  const url = new URL(`https://api.open-meteo.com${endpoint}`);
  url.searchParams.set("latitude", place.latitude);
  url.searchParams.set("longitude", place.longitude);
  url.searchParams.set("forecast_days", String(days));
  url.searchParams.set("timezone", place.timezone || APP_TIMEZONE);
  Object.entries(extra).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set(
    "hourly",
    "temperature_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m"
  );
  return url;
}

async function fetchOpenMeteoBatch(place, days, sources) {
  const models = [...new Set(sources.map((source) => source.openMeteoModel).filter(Boolean))];
  const url = openMeteoUrl(place, days, "/v1/forecast", { models: models.join(",") });
  return fetchJson(url);
}

async function fetchMetNo(place) {
  const url = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
  url.searchParams.set("lat", roundCoord(place.latitude));
  url.searchParams.set("lon", roundCoord(place.longitude));
  if (Number.isFinite(place.elevation)) {
    url.searchParams.set("altitude", String(Math.round(place.elevation)));
  }

  const data = await fetchJson(url, {
    headers: {
      "user-agent": "PovprecnaVremenskaNapoved/1.0 github.local contact:local",
    },
  });

  return {
    hourly: data.properties.timeseries.map((item) => {
      const instant = item.data.instant.details;
      const next = item.data.next_1_hours?.details || item.data.next_6_hours?.details || {};
      const symbol = item.data.next_1_hours?.summary?.symbol_code || "";

      return {
        time: normalizeTime(item.time),
        temp: instant.air_temperature,
        rainChance: Number.NaN,
        rain: next.precipitation_amount,
        wind: msToKmh(instant.wind_speed),
        cloud: instant.cloud_area_fraction,
        code: symbolToWeatherCode(symbol),
      };
    }),
  };
}

async function fetchWttr(place) {
  const url = new URL(`https://wttr.in/${encodeURIComponent(`${place.latitude},${place.longitude}`)}`);
  url.searchParams.set("format", "j1");

  const data = await fetchJson(url, {
    headers: { "user-agent": "PovprecnaVremenskaNapoved/1.0" },
  });

  const hourly = [];
  data.weather?.forEach((day) => {
    day.hourly?.forEach((hour) => {
      const hourText = String(hour.time || "0").padStart(4, "0").slice(0, 2);
      hourly.push({
        time: `${day.date}T${hourText}:00`,
        temp: Number(hour.tempC),
        rainChance: Number(hour.chanceofrain),
        rain: Number(hour.precipMM),
        wind: Number(hour.windspeedKmph),
        cloud: Number(hour.cloudcover),
        code: wttrCode(hour.weatherCode),
      });
    });
  });

  return { hourly };
}

async function fetchSevenTimer(place, days, product) {
  const url = new URL("https://www.7timer.info/bin/api.pl");
  url.searchParams.set("lon", place.longitude);
  url.searchParams.set("lat", place.latitude);
  url.searchParams.set("product", product);
  url.searchParams.set("unit", "metric");
  url.searchParams.set("output", "json");

  const data = await fetchJson(url, {
    headers: { "user-agent": "PovprecnaVremenskaNapoved/1.0" },
  });

  const init = parseSevenTimerInit(data.init);
  const maxHours = days * 24;
  const hourly = [];

  data.dataseries?.forEach((item) => {
    if (!Number.isFinite(item.timepoint) || item.timepoint > maxHours) return;
    const time = new Date(init.getTime() + item.timepoint * 60 * 60 * 1000);
    const condition = sevenTimerCondition(item);

    hourly.push({
      time: localIsoHour(time),
      temp: Number(item.temp2m),
      rainChance: Number.NaN,
      rain: sevenTimerPrecipitation(item),
      wind: sevenTimerWindKmh(item.wind10m?.speed),
      cloud: sevenTimerCloudPercent(item.cloudcover),
      code: codeForCondition(condition),
    });
  });

  return { hourly };
}

async function fetchArso(place, days) {
  if ((place.country || "").toLowerCase() !== "slovenija") {
    throw new Error("ARSO numericni vir je omejen na Slovenijo.");
  }

  const region = arsoRegion(place);
  const apiUrl = new URL("https://vreme.arso.gov.si/api/1.0/location/");
  apiUrl.searchParams.set("location", arsoLocationName(place));

  try {
    const data = await fetchJson(apiUrl, {
      headers: { "user-agent": "PovprecnaVremenskaNapoved/1.0" },
    });
    const hourly = parseArsoApi(data).slice(0, days * 24);
    if (hourly.length) return { hourly };
  } catch {
    // Fall back to the older public XML product if the newer location API is unavailable.
  }

  const xmlUrl = `https://meteo.arso.gov.si/uploads/probase/www/fproduct/text/sl/forecast_SI_${region}_latest.xml`;
  const xml = await fetchText(xmlUrl, {
    headers: { "user-agent": "PovprecnaVremenskaNapoved/1.0" },
  });

  const hourly = parseArsoXml(xml).slice(0, days * 24);
  if (!hourly.length) throw new Error("ARSO vir ne vsebuje pricakovanih numericnih podatkov.");

  return { hourly };
}

function fromOpenMeteo(data) {
  const hourly = data.hourly.time.map((time, index) => ({
    time,
    temp: numberAt(data.hourly.temperature_2m, index),
    rainChance: numberAt(data.hourly.precipitation_probability, index),
    rain: numberAt(data.hourly.precipitation, index),
    wind: numberAt(data.hourly.wind_speed_10m, index),
    cloud: numberAt(data.hourly.cloud_cover, index),
    code: numberAt(data.hourly.weather_code, index),
  }));

  return { hourly };
}

function fromOpenMeteoBatch(data, model) {
  if (!data?.hourly?.time?.length) throw new Error("Open-Meteo batch ne vsebuje urnih podatkov.");

  const hourly = data.hourly.time.map((time, index) => ({
    time,
    temp: numberAt(data.hourly[`temperature_2m_${model}`], index),
    rainChance: numberAt(data.hourly[`precipitation_probability_${model}`], index),
    rain: numberAt(data.hourly[`precipitation_${model}`], index),
    wind: numberAt(data.hourly[`wind_speed_10m_${model}`], index),
    cloud: numberAt(data.hourly[`cloud_cover_${model}`], index),
    code: numberAt(data.hourly[`weather_code_${model}`], index),
  }));

  return { hourly };
}

async function fetchObservation(place) {
  if ((place.country || "").toLowerCase() !== "slovenija") return null;

  try {
    const xml = await fetchText(ARSO_AMS_OBSERVATIONS, {
      headers: { "user-agent": "PovprecnaVremenskaNapoved/1.0" },
      attempts: 1,
      timeoutMs: OBSERVATION_TIMEOUT_MS,
    });
    const stations = parseArsoObservations(xml);
    const nearest = nearestObservationStation(place, stations);
    if (nearest) return nearest;
  } catch {
    // Fall back to the dedicated Ljubljana station below.
  }

  if (!String(place.name || "").toLowerCase().includes("ljubljana")) return null;

  const xml = await fetchText(ARSO_BEZIGRAD_OBSERVATION, {
    headers: { "user-agent": "PovprecnaVremenskaNapoved/1.0" },
    attempts: 1,
    timeoutMs: OBSERVATION_TIMEOUT_MS,
  });
  const observation = parseArsoObservationBlock(xml, place);
  return Number.isFinite(observation?.temp) ? observation : null;
}

function parseArsoObservations(xml) {
  return [...String(xml).matchAll(/<metData>([\s\S]*?)<\/metData>/g)]
    .map((match) => parseArsoObservationBlock(match[1]))
    .filter((station) => Number.isFinite(station.temp) && Number.isFinite(station.latitude) && Number.isFinite(station.longitude));
}

function parseArsoObservationBlock(xml, place = null) {
  const station = textBetween(xml, "domain_shortTitle") || textBetween(xml, "domain_longTitle") || "ARSO postaja";
  const latitude = Number(textBetween(xml, "domain_lat"));
  const longitude = Number(textBetween(xml, "domain_lon"));
  const distanceKm = place && Number.isFinite(latitude) && Number.isFinite(longitude)
    ? distanceKmBetween(place.latitude, place.longitude, latitude, longitude)
    : Number.NaN;

  return {
    station,
    stationId: textBetween(xml, "domain_meteosiId") || station.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    latitude,
    longitude,
    distanceKm,
    valid: textBetween(xml, "valid"),
    time: hourKey(textBetween(xml, "valid")),
    temp: Number(textBetween(xml, "t")),
    wind: msToKmh(Number(textBetween(xml, "ff_val"))),
    rain: Number(textBetween(xml, "rr_val")),
    cloudText: textBetween(xml, "nn_icon-wwsyn_icon"),
  };
}

function nearestObservationStation(place, stations) {
  const nearest = stations
    .map((station) => ({
      ...station,
      distanceKm: distanceKmBetween(place.latitude, place.longitude, station.latitude, station.longitude),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];

  return nearest && nearest.distanceKm <= 80 ? nearest : null;
}

function calibrateSources(sources, observation, scoreStore) {
  return sources.map((source) => {
    const learned = learnedSourceStats(scoreStore, source.id, observation?.stationId);

    if (!observation || !Number.isFinite(observation.temp)) {
      return { ...source, calibration: learned ? { ...learned, weight: learned.weight } : null };
    }

    const reference = source.forecast.hourly.find((hour) => hour.time === observation.time)
      || source.forecast.hourly.find((hour) => hour.time >= observation.time)
      || source.forecast.hourly[0];
    const bias = Number.isFinite(reference?.temp) ? reference.temp - observation.temp : Number.NaN;
    const instantWeight = calibrationWeight(bias);
    const learnedWeight = learned?.weight ?? 1;
    const weight = clamp(instantWeight * learnedWeight, 0.35, 1.8);

    return {
      ...source,
      calibration: {
        station: observation.station,
        observedTemp: observation.temp,
        observedTime: observation.time,
        modelTemp: reference?.temp,
        bias,
        instantWeight,
        learnedWeight,
        learnedSamples: learned?.samples || 0,
        learnedMae: learned?.tempMae ?? Number.NaN,
        weight,
      },
      forecast: {
        hourly: source.forecast.hourly.map((hour) => calibrateHour(hour, observation.time, bias, weight)),
      },
    };
  });
}

function averageSources(sources, days) {
  const buckets = new Map();

  sources.forEach((source) => {
    source.forecast.hourly.forEach((hour) => {
      if (!hour.time || !Number.isFinite(hour.temp)) return;
      const key = hourKey(hour.time);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ ...hour, source: source.name });
    });
  });

  const hourly = [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([time]) => time >= currentHourKey())
    .slice(0, days * 24)
    .map(([time, rows]) => {
      const conditionVotes = countConditions(rows);
      const condition = winningCondition(conditionVotes);

      return {
        time,
        temp: weightedMean(rows.map((row) => row.temp), rows.map((row) => row.weight)),
        rainChance: weightedMean(rows.map((row) => row.rainChance), rows.map((row) => row.weight)),
        rain: weightedMean(rows.map((row) => row.rain), rows.map((row) => row.weight)),
        wind: weightedMean(rows.map((row) => row.wind), rows.map((row) => row.weight)),
        cloud: weightedMean(rows.map((row) => row.cloud), rows.map((row) => row.weight)),
        code: codeForCondition(condition),
        spread: spread(rows.map((row) => row.temp)),
        sampleSize: rows.length,
        effectiveSampleSize: sum(rows.map((row) => row.weight)),
        condition,
        conditionVotes,
        sources: rows.map((row) => row.source),
        sourceValues: rows.map((row) => ({
          source: row.source,
          temp: row.temp,
          rawTemp: row.rawTemp,
          weight: row.weight,
          bias: row.bias,
          condition: conditionForRow(row),
          rainChance: row.rainChance,
        })),
      };
    });

  return {
    hourly,
    daily: groupDaily(hourly).slice(0, days),
  };
}

function summarizeSource(source, averagedHours) {
  if (!source.ok) return stripForecast(source);

  const wantedKeys = new Set(averagedHours.slice(0, 24).map((hour) => hour.time));
  const alignedHours = source.forecast.hourly.filter((hour) => wantedKeys.has(hourKey(hour.time)));
  const firstHours = alignedHours.slice(0, 24);

  return {
    id: source.id,
    name: source.name,
    note: source.note,
    ok: true,
    hours: source.forecast.hourly.length,
    rawHours: source.rawHours ?? source.forecast.hourly.length,
    matchedHours: firstHours.length,
    comparable: firstHours.length >= 6,
    calibration: source.calibration,
    temp24: firstHours.length >= 6 ? mean(firstHours.map((hour) => hour.temp)) : Number.NaN,
    rainChance24: firstHours.length >= 6 ? mean(firstHours.map((hour) => hour.rainChance)) : Number.NaN,
    rain24: firstHours.length >= 6 ? sum(firstHours.map((hour) => hour.rain)) : Number.NaN,
    wind24: firstHours.length >= 6 ? mean(firstHours.map((hour) => hour.wind)) : Number.NaN,
  };
}

function normalizeForecast(forecast, days) {
  const rows = (forecast.hourly || [])
    .filter((hour) => hour.time && Number.isFinite(hour.temp))
    .map((hour) => ({ ...hour, time: hourKey(hour.time) }))
    .sort((a, b) => a.time.localeCompare(b.time));

  if (!rows.length) return { hourly: [] };

  const unique = [];
  rows.forEach((row) => {
    const previous = unique.at(-1);
    if (previous?.time === row.time) {
      unique[unique.length - 1] = mergeForecastRows(previous, row);
    } else {
      unique.push(row);
    }
  });

  const hourly = [];
  for (let index = 0; index < unique.length; index += 1) {
    const current = unique[index];
    const next = unique[index + 1];
    hourly.push(current);

    if (!next) continue;

    const gap = hoursBetween(current.time, next.time);
    if (gap <= 1 || gap > 6) continue;

    for (let offset = 1; offset < gap; offset += 1) {
      hourly.push(interpolateForecastHour(current, next, offset / gap));
    }
  }

  return { hourly: hourly.slice(0, days * 24) };
}

function calibrateHour(hour, observationTime, bias, weight) {
  if (!Number.isFinite(bias)) return { ...hour, weight: 1, rawTemp: hour.temp, bias: Number.NaN };

  const lead = Math.max(0, hoursBetween(observationTime, hour.time));
  const decay = calibrationDecay(lead);

  return {
    ...hour,
    rawTemp: hour.temp,
    temp: Number.isFinite(hour.temp) ? hour.temp - bias * decay : hour.temp,
    bias,
    weight,
  };
}

function calibrationWeight(bias) {
  const error = Math.abs(bias);
  if (!Number.isFinite(error)) return 1;
  if (error <= 0.75) return 1.35;
  if (error <= 1.5) return 1.15;
  if (error <= 2.5) return 0.9;
  if (error <= 4) return 0.65;
  return 0.4;
}

function calibrationDecay(leadHours) {
  if (leadHours <= 3) return 1;
  if (leadHours <= 12) return 0.75;
  if (leadHours <= 24) return 0.45;
  if (leadHours <= 48) return 0.2;
  return 0;
}

function stripForecast(source) {
  return {
    id: source.id,
    name: source.name,
    note: source.note,
    ok: false,
    error: source.error || "ni podatkov",
  };
}

async function loadScoreStore() {
  try {
    const data = JSON.parse(await readFile(scoreFile, "utf8"));
    return {
      version: 1,
      scores: data.scores || {},
      predictions: data.predictions || {},
      observed: data.observed || {},
    };
  } catch {
    return { version: 1, scores: {}, predictions: {}, observed: {} };
  }
}

async function saveScoreStore(store) {
  await mkdir(join(root, ".farso-cache"), { recursive: true });
  await writeFile(scoreFile, JSON.stringify(pruneScoreStore(store), null, 2), "utf8");
}

function updateScoresFromObservation(store, observation) {
  if (!observation?.time || !Number.isFinite(observation.temp)) return { updated: 0, time: null };
  const observedKey = observationKey(observation);
  if (store.observed[observedKey]) return { updated: 0, time: observation.time, station: observation.station };

  const predictions = store.predictions[observedKey] || {};
  let updated = 0;

  Object.entries(predictions).forEach(([sourceId, prediction]) => {
    if (!Number.isFinite(prediction.temp)) return;
    const error = Math.abs(prediction.temp - observation.temp);
    const scoreKey = sourceScoreKey(sourceId, observation.stationId);
    const score = store.scores[scoreKey] || { samples: 0, tempMae: error, station: observation.station, stationId: observation.stationId, sourceId, lastUpdated: null };

    score.tempMae = score.samples ? score.tempMae * (1 - SCORE_DECAY) + error * SCORE_DECAY : error;
    score.samples += 1;
    score.lastError = error;
    score.lastPrediction = prediction.temp;
    score.lastObserved = observation.temp;
    score.lastObservedTime = observation.time;
    score.lastUpdated = new Date().toISOString();

    store.scores[scoreKey] = score;
    updated += 1;
  });

  store.observed[observedKey] = { temp: observation.temp, station: observation.station, updated, savedAt: new Date().toISOString() };
  delete store.predictions[observedKey];
  return { updated, time: observation.time, station: observation.station };
}

function rememberPredictions(store, sources, observation) {
  if (!observation?.stationId) return;
  const start = currentHourKey();
  const end = addHoursToKey(start, MAX_STORED_PREDICTION_HOURS);

  sources.forEach((source) => {
    source.forecast.hourly.forEach((hour) => {
      const time = hourKey(hour.time);
      if (time < start || time > end || !Number.isFinite(hour.temp)) return;

      const key = predictionKey(observation.stationId, time);
      if (!store.predictions[key]) store.predictions[key] = {};
      store.predictions[key][source.id] = {
        temp: hour.temp,
        wind: hour.wind,
        rain: hour.rain,
        condition: conditionForRow(hour),
        station: observation.station,
        stationId: observation.stationId,
        savedAt: new Date().toISOString(),
      };
    });
  });
}

function learnedSourceStats(store, sourceId, stationId) {
  const score = store?.scores?.[sourceScoreKey(sourceId, stationId)];
  if (!score?.samples || !Number.isFinite(score.tempMae)) return null;

  return {
    samples: score.samples,
    tempMae: score.tempMae,
    lastError: score.lastError,
    weight: learnedWeight(score.tempMae, score.samples),
  };
}

function learnedWeight(tempMae, samples) {
  const maturity = clamp(samples / 12, 0.25, 1);
  const base = tempMae <= 0.8
    ? 1.25
    : tempMae <= 1.3
      ? 1.12
      : tempMae <= 2
        ? 0.95
        : tempMae <= 3
          ? 0.78
          : 0.6;
  return 1 + (base - 1) * maturity;
}

function learningSummary(store, update) {
  return {
    updatedFromObservation: update,
    sourcesWithScores: Object.keys(store.scores).length,
    pendingPredictionHours: Object.keys(store.predictions).length,
  };
}

function pruneScoreStore(store) {
  const cutoff = addHoursToKey(currentHourKey(), -12);
  const maxFuture = addHoursToKey(currentHourKey(), MAX_STORED_PREDICTION_HOURS);

  Object.keys(store.predictions).forEach((key) => {
    const time = key.includes("::") ? key.split("::").at(-1) : key;
    if (time < cutoff || time > maxFuture) delete store.predictions[key];
  });

  const observedKeys = Object.keys(store.observed).sort();
  observedKeys.slice(0, Math.max(0, observedKeys.length - 200)).forEach((time) => delete store.observed[time]);

  return store;
}

function predictionKey(stationId, time) {
  return `${stationId || "unknown"}::${time}`;
}

function observationKey(observation) {
  return predictionKey(observation.stationId, observation.time);
}

function sourceScoreKey(sourceId, stationId) {
  return `${stationId || "global"}::${sourceId}`;
}

function distanceKmBetween(lat1, lon1, lat2, lon2) {
  const earthKm = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseArsoApi(data) {
  const days = data?.forecast3h?.features?.[0]?.properties?.days || [];
  const hourly = [];

  days.forEach((day) => {
    (day.timeline || []).forEach((entry) => {
      const temp = Number(entry.t);
      if (!entry.valid || !Number.isFinite(temp)) return;

      const rain = Number(entry.tp_acc);
      const snow = Number(entry.sn_acc);

      hourly.push({
        time: entry.valid,
        temp,
        rainChance: Number.NaN,
        rain: Number.isFinite(rain) ? rain : 0,
        wind: Number(entry.ff_val),
        cloud: arsoCloudPercent(entry),
        code: arsoApiWeatherCode(entry, rain, snow),
      });
    });
  });

  return hourly;
}

function parseArsoXml(xml) {
  const times = [...xml.matchAll(/<valid>(.*?)<\/valid>/g)].map((match) => match[1]);
  const temps = [...xml.matchAll(/<t>(-?\d+(?:\.\d+)?)<\/t>/g)].map((match) => Number(match[1]));
  const rain = [...xml.matchAll(/<rr>(-?\d+(?:\.\d+)?)<\/rr>/g)].map((match) => Number(match[1]));
  const wind = [...xml.matchAll(/<ff_val>(-?\d+(?:\.\d+)?)<\/ff_val>/g)].map((match) => Number(match[1]));
  const clouds = [...xml.matchAll(/<nn_icon>(\d+)<\/nn_icon>/g)].map((match) => Number(match[1]));
  const length = Math.min(times.length, temps.length);

  return Array.from({ length }, (_, index) => ({
    time: normalizeTime(times[index]),
    temp: temps[index],
    rainChance: Number.NaN,
    rain: rain[index],
    wind: wind[index],
    cloud: clouds[index],
    code: arsoCloudToWeatherCode(clouds[index], rain[index]),
  }));
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithRetry(url, options);
  if (!response.ok) throw new Error(await httpErrorMessage(response));
  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetchWithRetry(url, options);
  if (!response.ok) throw new Error(await httpErrorMessage(response));
  return response.text();
}

async function fetchWithRetry(url, options = {}) {
  let lastError;

  const attempts = options.attempts ?? 2;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, withTimeout(options));
      if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts - 1) return response;
      await new Promise((resolve) => setTimeout(resolve, 450 + attempt * 650));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 450 + attempt * 650));
    }
  }

  throw lastError;
}

async function httpErrorMessage(response) {
  let detail = "";
  try {
    detail = (await response.text()).replace(/\s+/g, " ").slice(0, 140);
  } catch {
    detail = "";
  }

  const host = new URL(response.url).hostname;
  return `${host} HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
}

function withTimeout(options) {
  return {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
  };
}

function send(response, status, contentType, body) {
  response.writeHead(status, { "content-type": contentType });
  response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sourceMeta(source) {
  return { id: source.id, name: source.name, note: source.note };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function groupDaily(hourly) {
  const groups = new Map();
  hourly.forEach((hour) => {
    const date = hour.time.slice(0, 10);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(hour);
  });

  return [...groups.entries()].map(([date, rows]) => ({
    date,
    minTemp: Math.min(...rows.map((row) => row.temp)),
    maxTemp: Math.max(...rows.map((row) => row.temp)),
    rain: sum(rows.map((row) => row.rain)),
    rainChance: mean(rows.map((row) => row.rainChance)),
    wind: mean(rows.map((row) => row.wind)),
    cloud: mean(rows.map((row) => row.cloud)),
    code: codeForCondition(winningCondition(mergeConditionVotes(rows.map((row) => row.conditionVotes)))),
    sampleSize: Math.round(mean(rows.map((row) => row.sampleSize))),
    condition: winningCondition(mergeConditionVotes(rows.map((row) => row.conditionVotes))),
    conditionVotes: mergeConditionVotes(rows.map((row) => row.conditionVotes)),
  }));
}

function arsoRegion(place) {
  const text = `${place.name} ${place.admin1}`.toLowerCase();
  if (text.includes("koper") || text.includes("obal") || text.includes("primors")) return "OBALA";
  if (text.includes("maribor") || text.includes("ptuj") || text.includes("murska")) return "PODRAVJE";
  if (text.includes("celje") || text.includes("savinj")) return "SAVINJSKA";
  if (text.includes("novo mesto") || text.includes("dolenj")) return "DOLENJSKA";
  if (text.includes("kranj") || text.includes("gorenj") || text.includes("bled")) return "GORENJSKA";
  if (text.includes("nova gorica") || text.includes("goriska")) return "GORISKA";
  return "OSREDNJESLOVENSKA";
}

function mergeForecastRows(a, b) {
  return {
    ...a,
    temp: mean([a.temp, b.temp]),
    rainChance: mean([a.rainChance, b.rainChance]),
    rain: mean([a.rain, b.rain]),
    wind: mean([a.wind, b.wind]),
    cloud: mean([a.cloud, b.cloud]),
    code: Number.isFinite(b.code) ? b.code : a.code,
  };
}

function interpolateForecastHour(a, b, fraction) {
  return {
    time: addHoursToKey(a.time, Math.round(hoursBetween(a.time, b.time) * fraction)),
    temp: interpolateNumber(a.temp, b.temp, fraction),
    rainChance: interpolateNumber(a.rainChance, b.rainChance, fraction),
    rain: distributeAccumulation(a.rain, b.rain, hoursBetween(a.time, b.time)),
    wind: interpolateNumber(a.wind, b.wind, fraction),
    cloud: interpolateNumber(a.cloud, b.cloud, fraction),
    code: a.code,
  };
}

function interpolateNumber(a, b, fraction) {
  if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * fraction;
  if (Number.isFinite(a)) return a;
  if (Number.isFinite(b)) return b;
  return Number.NaN;
}

function distributeAccumulation(a, b, hours) {
  const value = Number.isFinite(b) ? b : a;
  return Number.isFinite(value) && hours > 1 ? value / hours : value;
}

function hoursBetween(a, b) {
  return Math.round((dateFromHourKey(b).getTime() - dateFromHourKey(a).getTime()) / 3600000);
}

function addHoursToKey(key, hours) {
  const date = dateFromHourKey(key);
  date.setUTCHours(date.getUTCHours() + hours);
  return isoHourFromUtcParts(date);
}

function dateFromHourKey(key) {
  const [datePart, timePart] = key.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour] = timePart.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour));
}

function symbolToWeatherCode(symbol) {
  if (symbol.includes("thunder")) return 95;
  if (symbol.includes("snow")) return 71;
  if (symbol.includes("rain") || symbol.includes("sleet")) return 61;
  if (symbol.includes("fog")) return 45;
  if (symbol.includes("cloudy")) return 3;
  if (symbol.includes("partly")) return 2;
  if (symbol.includes("clearsky") || symbol.includes("fair")) return 0;
  return Number.NaN;
}

function wttrCode(code) {
  const value = Number(code);
  if ([386, 389, 392, 395].includes(value)) return 95;
  if ([179, 227, 230, 323, 326, 329, 332, 335, 338, 368, 371].includes(value)) return 71;
  if ([176, 263, 266, 293, 296, 299, 302, 305, 308, 353, 356, 359].includes(value)) return 61;
  if ([113].includes(value)) return 0;
  if ([116].includes(value)) return 2;
  if ([119, 122].includes(value)) return 3;
  if ([143, 248, 260].includes(value)) return 45;
  return Number.NaN;
}

function sevenTimerCondition(item = {}) {
  const text = String(item.weather || "").toLowerCase();
  const precType = String(item.prec_type || "").toLowerCase();

  if (text.includes("ts")) return "storm";
  if (text.includes("snow") || precType === "snow") return "snow";
  if (text.includes("rain") || text.includes("shower") || precType === "rain") return "rain";
  if (text.includes("fog") || text.includes("humid")) return "fog";
  if (text.includes("cloudy")) return "cloudy";
  if (text.includes("mcloudy") || text.includes("pcloudy")) return "partly";
  if (text.includes("clear")) return "clear";
  if (Number.isFinite(Number(item.cloudcover))) {
    const cloud = sevenTimerCloudPercent(item.cloudcover);
    if (cloud >= 75) return "cloudy";
    if (cloud >= 35) return "partly";
    return "clear";
  }

  return "unknown";
}

function sevenTimerPrecipitation(item) {
  const weather = String(item.weather || "").toLowerCase();
  const precType = String(item.prec_type || "").toLowerCase();
  if (weather.includes("rain") || weather.includes("shower") || precType === "rain") return 0.4;
  if (weather.includes("snow") || precType === "snow") return 0.2;
  return 0;
}

function sevenTimerCloudPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, (numeric - 1) * 12.5)) : Number.NaN;
}

function sevenTimerWindKmh(speed) {
  const levels = [0, 3, 8, 14, 21, 30, 40, 52, 65, 80, 96, 112, 130];
  const numeric = Number(speed);
  return Number.isFinite(numeric) ? levels[Math.max(0, Math.min(levels.length - 1, numeric))] : Number.NaN;
}

function parseSevenTimerInit(value) {
  const text = String(value || "");
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})/);
  if (!match) return new Date();
  const [, year, month, day, hour] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour)));
}

function localIsoHour(date) {
  return zonedIsoHour(date, APP_TIMEZONE);
}

function arsoCloudToWeatherCode(cloud, rain) {
  if (Number.isFinite(rain) && rain > 0.5) return 61;
  if (!Number.isFinite(cloud)) return Number.NaN;
  if (cloud <= 2) return 0;
  if (cloud <= 5) return 2;
  return 3;
}

function arsoApiWeatherCode(entry, rain, snow) {
  const text = [
    entry.clouds_icon_wwsyn_icon,
    entry.wwsyn_shortText,
    entry.clouds_shortText,
    entry.weatherShortText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (text.includes("ts") || text.includes("neviht")) return 95;
  if (text.includes("snow") || text.includes("sneg") || (Number.isFinite(snow) && snow > 0.05)) return 71;
  if (text.includes("rain") || text.includes("ra") || text.includes("dez") || text.includes("dež") || text.includes("ploh") || (Number.isFinite(rain) && rain > 0.05)) return 61;
  if (text.includes("fog") || text.includes("fg") || text.includes("megl")) return 45;
  if (text.includes("overcast") || text.includes("oblačno") || text.includes("oblacno")) return 3;
  if (text.includes("part") || text.includes("delno") || text.includes("pretežno") || text.includes("pretezno")) return 2;
  if (text.includes("clear") || text.includes("jasno")) return 0;
  return Number.NaN;
}

function arsoCloudPercent(entry) {
  const numeric = Number(entry.nn);
  if (Number.isFinite(numeric)) return clamp(numeric * 12.5, 0, 100);

  const text = String(entry.clouds_shortText || entry.clouds_icon_wwsyn_icon || "").toLowerCase();
  if (text.includes("overcast") || text.includes("oblačno") || text.includes("oblacno")) return 90;
  if (text.includes("pretežno") || text.includes("pretezno")) return 70;
  if (text.includes("part") || text.includes("delno")) return 45;
  if (text.includes("clear") || text.includes("jasno")) return 10;
  return Number.NaN;
}

function arsoLocationName(place) {
  const name = String(place.name || "").trim();
  if (name.toLowerCase().includes("ljubljana")) return "Ljubljana";
  return name || "Ljubljana";
}

function normalizeTime(value) {
  const text = String(value).trim();
  const sl = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2})(?::(\d{2}))?/);
  if (sl) {
    const [, day, month, year, hour, minute = "00"] = sl;
    return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}`;
  }

  return text.replace("Z", "").slice(0, 16);
}

function hourKey(value) {
  const text = String(value).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) {
      date.setUTCMinutes(0, 0, 0);
      return zonedIsoHour(date, APP_TIMEZONE);
    }
  }

  const normalized = normalizeTime(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized.slice(0, 13)}:00`;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return `${normalized.slice(0, 13)}:00`;
  date.setUTCMinutes(0, 0, 0);
  return zonedIsoHour(date, APP_TIMEZONE);
}

function currentHourKey() {
  return zonedIsoHour(new Date(), APP_TIMEZONE);
}

function zonedIsoHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:00`;
}

function isoHourFromUtcParts(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:00`;
}

function roundCoord(value) {
  return Number(value).toFixed(4);
}

function msToKmh(value) {
  return Number.isFinite(value) ? value * 3.6 : Number.NaN;
}

function numberAt(values, index) {
  const value = values?.[index];
  return typeof value === "number" ? value : Number.NaN;
}

function validNumbers(values) {
  return values.filter(Number.isFinite);
}

function mean(values) {
  const numbers = validNumbers(values);
  return numbers.length ? sum(numbers) / numbers.length : Number.NaN;
}

function weightedMean(values, weights) {
  let total = 0;
  let weightTotal = 0;

  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const weight = Number.isFinite(weights[index]) ? weights[index] : 1;
    total += value * weight;
    weightTotal += weight;
  });

  return weightTotal ? total / weightTotal : Number.NaN;
}

function sum(values) {
  return validNumbers(values).reduce((total, value) => total + value, 0);
}

function spread(values) {
  const numbers = validNumbers(values);
  return numbers.length ? Math.max(...numbers) - Math.min(...numbers) : Number.NaN;
}

function mode(values) {
  const counts = new Map();
  validNumbers(values).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? Number.NaN;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function countConditions(rows) {
  return mergeConditionVotes(rows.map((row) => ({ [conditionForRow(row)]: row.weight || 1 })));
}

function mergeConditionVotes(voteMaps) {
  return voteMaps.reduce((merged, votes = {}) => {
    Object.entries(votes).forEach(([condition, count]) => {
      merged[condition] = (merged[condition] || 0) + count;
    });
    return merged;
  }, {});
}

function winningCondition(votes = {}) {
  const priority = ["storm", "snow", "rain", "fog", "cloudy", "partly", "clear", "unknown"];
  return (
    Object.entries(votes).sort((a, b) => {
      if (a[0] === "unknown" && b[0] !== "unknown") return 1;
      if (b[0] === "unknown" && a[0] !== "unknown") return -1;
      if (b[1] !== a[1]) return b[1] - a[1];
      return priority.indexOf(a[0]) - priority.indexOf(b[0]);
    })[0]?.[0] || "unknown"
  );
}

function conditionForRow(row) {
  if (isStormCode(row.code)) return "storm";
  if (isSnowCode(row.code)) return "snow";
  if (isRainCode(row.code) || (Number.isFinite(row.rain) && row.rain > 0.05) || (Number.isFinite(row.rainChance) && row.rainChance >= 50)) return "rain";
  if (isFogCode(row.code)) return "fog";
  if (row.code === 3 || (Number.isFinite(row.cloud) && row.cloud >= 75)) return "cloudy";
  if (row.code === 2 || (Number.isFinite(row.cloud) && row.cloud >= 35)) return "partly";
  if ([0, 1].includes(row.code) || (Number.isFinite(row.cloud) && row.cloud < 35)) return "clear";
  return "unknown";
}

function codeForCondition(condition) {
  return {
    clear: 0,
    partly: 2,
    cloudy: 3,
    fog: 45,
    rain: 61,
    snow: 71,
    storm: 95,
  }[condition] ?? Number.NaN;
}

function isRainCode(code) {
  return [51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code);
}

function isSnowCode(code) {
  return [71, 73, 75].includes(code);
}

function isFogCode(code) {
  return [45, 48].includes(code);
}

function isStormCode(code) {
  return code === 95;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function textBetween(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1]?.trim() || "";
}
