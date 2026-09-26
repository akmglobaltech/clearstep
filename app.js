const searchForm = document.querySelector("#search-form");
const locationInput = document.querySelector("#location-input");
const radiusSelect = document.querySelector("#radius-select");
const searchButton = document.querySelector("#search-button");
const searchError = document.querySelector("#search-error");
const resultsTitle = document.querySelector("#results-title");
const resultsMeta = document.querySelector("#results-meta");
const resultsTools = document.querySelector("#results-tools");
const resultsList = document.querySelector("#results-list");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const mapPlaceLabel = document.querySelector("#map-place-label");
const mapPlaceholder = document.querySelector("#map-placeholder");
const savedCount = document.querySelector("#saved-count");
const toast = document.querySelector("#toast");

const geocoderUrl = "https://nominatim.openstreetmap.org";
const overpassUrl = "https://overpass-api.de/api/interpreter";
const cacheDuration = 10 * 60 * 1000;
const categories = {
  phones: { label: "phone and electronics shops", tags: ["mobile_phone", "electronics"], primary: "mobile_phone" },
  laptops: { label: "laptop and computer shops", tags: ["computer", "electronics"], primary: "computer" },
  accessories: { label: "phone, computer, and electronics shops", tags: ["mobile_phone", "computer", "electronics"], primary: "mobile_phone" },
};

let selectedCategory = "phones";
let currentPlace = null;
let currentResults = [];
let nearbyResults = [];
let nearbyFetchedAt = 0;
let nearbyCached = false;
let currentMarkers = [];
let currentView = "nearby";
let map = null;
let markerLayer = null;
let toastTimer;
let lastGeocoderRequest = 0;
let activeRequest = false;

function readSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem("clearstep-shop-saves") || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function updateSavedCount() {
  savedCount.textContent = String(readSaved().length);
}

function setCategory(category) {
  selectedCategory = category;
  document.querySelectorAll(".category-option").forEach((button) => {
    const active = button.dataset.category === category;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setSearchState(state) {
  const loading = state === "loading";
  emptyState.hidden = loading || state === "results";
  loadingState.hidden = !loading;
  resultsList.hidden = loading || state === "empty";
  resultsTools.hidden = loading || state === "empty";
  resultsMeta.hidden = loading || state === "empty";
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function locationLabel(place) {
  const address = place.address || {};
  return address.city || address.town || address.municipality || address.village || address.county || place.name || place.displayName.split(",")[0];
}

function kmBetween(firstLat, firstLon, secondLat, secondLon) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(secondLat - firstLat);
  const longitudeDelta = radians(secondLon - firstLon);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(firstLat)) * Math.cos(radians(secondLat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function boundaryWidthKm(place) {
  const [south, north, west, east] = place.boundingbox.map(Number);
  return kmBetween(south, west, north, east);
}

function geocoderDelay() {
  const delay = Math.max(0, 1100 - (Date.now() - lastGeocoderRequest));
  return new Promise((resolve) => setTimeout(() => {
    lastGeocoderRequest = Date.now();
    resolve();
  }, delay));
}

async function geocodeCity(query) {
  const queryParts = query.split(",").map((part) => part.trim()).filter(Boolean);
  if (queryParts.length < 2) throw new Error("Enter a city and country, for example Bogura, Bangladesh.");
  const key = `clearstep-place-v1-${query.toLowerCase()}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) || "null");
    if (cached && Date.now() - cached.fetchedAt < 86400000) return cached.place;
  } catch {
    // Continue with a live place lookup when session storage is unavailable.
  }
  await geocoderDelay();
  const url = new URL(`${geocoderUrl}/search`);
  url.search = new URLSearchParams({ format: "jsonv2", q: query, limit: "5", addressdetails: "1", "accept-language": "en" });
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("The place search is busy. Please wait a moment and try again.");
  const results = await response.json();
  const boundaries = results.filter((result) => result.osm_type === "relation" && result.category === "boundary" && result.boundingbox);
  const requestedCountry = queryParts.length > 1 ? queryParts[queryParts.length - 1].toLowerCase() : "";
  const boundary = boundaries.find((result) => {
    if (!requestedCountry) return true;
    const address = result.address || {};
    const aliases = { us: "united states", usa: "united states", uk: "united kingdom", gb: "united kingdom", uae: "united arab emirates" };
    const expected = aliases[requestedCountry] || requestedCountry;
    const actual = String(address.country || "").toLowerCase();
    return (requestedCountry.length === 2 && address.country_code?.toLowerCase() === requestedCountry)
      || actual === expected
      || String(result.display_name || "").toLowerCase().includes(requestedCountry);
  });
  if (!boundary) throw new Error("We couldn't find that city in the selected country. Check the spelling or add a nearby city.");
  const place = {
    osmId: Number(boundary.osm_id),
    name: locationLabel(boundary),
    displayName: boundary.display_name,
    lat: Number(boundary.lat),
    lon: Number(boundary.lon),
    boundingbox: boundary.boundingbox,
    address: boundary.address || {},
  };
  if (boundaryWidthKm(place) > 180) throw new Error("That area is too broad. Search for a city or town inside it instead.");
  try {
    sessionStorage.setItem(key, JSON.stringify({ place, fetchedAt: Date.now() }));
  } catch {
    // Place search remains available when storage is unavailable.
  }
  return place;
}

function queryForPlace(place, category) {
  const areaId = 3600000000 + place.osmId;
  const tagPattern = categories[category].tags.join("|");
  return `[out:json][timeout:25];(nwr["shop"~"^(${tagPattern})$"](area:${areaId}););out center meta;`;
}

function cacheKey(place, category) {
  return `clearstep-osm-v1-${place.osmId}-${category}`;
}

function readCache(place, category) {
  try {
    const item = JSON.parse(sessionStorage.getItem(cacheKey(place, category)) || "null");
    return item && Date.now() - item.fetchedAt < cacheDuration ? item : null;
  } catch {
    return null;
  }
}

function writeCache(place, category, item) {
  try {
    sessionStorage.setItem(cacheKey(place, category), JSON.stringify(item));
  } catch {
    // Search still works when storage is unavailable.
  }
}

async function fetchPlaces(place, category, forceRefresh) {
  if (!forceRefresh) {
    const cached = readCache(place, category);
    if (cached) return { ...cached, cached: true };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    const url = new URL(overpassUrl);
    url.searchParams.set("data", queryForPlace(place, category));
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (response.status === 429) throw new Error("The open map service is busy right now. Wait a minute, then try again.");
    if (response.status === 504) throw new Error("That search area is taking too long. Try a nearby city or search again later.");
    if (!response.ok) throw new Error("The open map service couldn't complete this search. Please try again.");
    const data = await response.json();
    const item = { elements: data.elements || [], fetchedAt: Date.now() };
    writeCache(place, category, item);
    return { ...item, cached: false };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The map search took too long. Try again in a moment.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function elementPoint(element) {
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function safeWebsite(value) {
  if (!value) return "";
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function makePlaces(elements, place, radiusKm, category) {
  const primary = categories[category].primary;
  return elements.map((element) => {
    const point = elementPoint(element);
    if (!point) return null;
    const tags = element.tags || {};
    const shopType = tags.shop || "shop";
    const address = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
    return {
      id: `${element.type}/${element.id}`,
      osmType: element.type,
      osmId: element.id,
      name: String(tags.name || tags.brand || tags.operator || `Unnamed ${shopType.replaceAll("_", " ")} shop`),
      shopType,
      typeLabel: ({ mobile_phone: "Mobile phone shop", computer: "Computer shop", electronics: "Electronics shop" })[shopType] || "Retail shop",
      address: String(tags["addr:full"] || address || tags["addr:suburb"] || tags["addr:neighbourhood"] || tags["addr:city"] || "Address not listed on map"),
      phone: String(tags.phone || tags["contact:phone"] || ""),
      website: safeWebsite(tags.website || tags["contact:website"]),
      openingHours: String(tags.opening_hours || ""),
      lat: point.lat,
      lon: point.lon,
      distance: kmBetween(place.lat, place.lon, point.lat, point.lon),
      mapEditedAt: element.timestamp || "",
      primaryMatch: shopType === primary ? 0 : 1,
      origin: { name: place.name, lat: place.lat, lon: place.lon },
    };
  }).filter((item) => item && item.distance <= radiusKm)
    .sort((first, second) => first.primaryMatch - second.primaryMatch || first.distance - second.distance);
}

function categoryIcon(type) {
  return ({ mobile_phone: "▯", computer: "▱", electronics: "⌁" })[type] || "•";
}

function formatDistance(distance) {
  if (!Number.isFinite(distance)) return "Saved shop";
  return distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`;
}

function formatMapDate(timestamp) {
  if (!timestamp) return "Edit date not listed";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Edit date not listed";
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return "Map entry edited today";
  if (days === 1) return "Map entry edited yesterday";
  if (days < 30) return `Map entry edited ${days} days ago`;
  return `Map edit · ${date.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
}

function osmObjectUrl(placeItem) {
  return `https://www.openstreetmap.org/${encodeURIComponent(placeItem.osmType)}/${placeItem.osmId}`;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function directionsUrl(placeItem) {
  const origin = placeItem.origin || currentPlace;
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${placeItem.lat}%2C${placeItem.lon}%3B${origin.lat}%2C${origin.lon}`;
}

function toggleSaved(placeItem, button) {
  const saved = readSaved();
  const index = saved.findIndex((item) => item.id === placeItem.id);
  if (index >= 0) {
    saved.splice(index, 1);
    showToast("Removed from saved shops");
  } else {
    saved.unshift(placeItem);
    showToast("Shop saved on this device");
  }
  try {
    localStorage.setItem("clearstep-shop-saves", JSON.stringify(saved.slice(0, 100)));
  } catch {
    showToast("Could not save in this browser");
    return;
  }
  updateSavedCount();
  button.classList.toggle("is-saved", index < 0);
  button.textContent = index < 0 ? "★" : "☆";
  button.setAttribute("aria-label", index < 0 ? `Remove ${placeItem.name} from saved shops` : `Save ${placeItem.name}`);
  if (currentView === "saved" && index >= 0) renderSavedPlaces();
}

function makeShopCard(placeItem, index) {
  const card = makeElement("article", "shop-card");
  card.dataset.osmId = placeItem.id;
  const marker = makeElement("span", "shop-number", String(index + 1));
  const body = makeElement("div", "shop-main");
  const top = makeElement("div", "shop-card-top");
  const title = makeElement("h3", "shop-name", placeItem.name);
  const isSaved = readSaved().some((item) => item.id === placeItem.id);
  const saveButton = makeElement("button", `favorite-button${isSaved ? " is-saved" : ""}`, isSaved ? "★" : "☆");
  saveButton.type = "button";
  saveButton.title = isSaved ? "Remove from saved shops" : "Save shop";
  saveButton.setAttribute("aria-label", isSaved ? `Remove ${placeItem.name} from saved shops` : `Save ${placeItem.name}`);
  saveButton.addEventListener("click", () => toggleSaved(placeItem, saveButton));
  top.append(title, saveButton);
  const detail = makeElement("div", "shop-meta");
  detail.append(makeElement("span", "shop-type", `${categoryIcon(placeItem.shopType)} ${placeItem.typeLabel}`));
  detail.append(makeElement("span", "shop-distance", formatDistance(placeItem.distance)));
  body.append(top, detail);
  body.append(makeElement("p", "shop-address", placeItem.address));
  if (placeItem.openingHours) body.append(makeElement("p", "shop-hours", `Mapped hours · ${placeItem.openingHours}`));
  body.append(makeElement("p", "shop-map-date", formatMapDate(placeItem.mapEditedAt)));

  const actions = makeElement("div", "shop-actions");
  if (placeItem.phone) {
    const phone = makeElement("a", "shop-action", "Call shop");
    phone.href = `tel:${placeItem.phone.replace(/[^+\d]/g, "")}`;
    actions.append(phone);
  }
  const directions = makeElement("a", "shop-action secondary-action", "Directions ↗");
  directions.href = directionsUrl(placeItem);
  directions.target = "_blank";
  directions.rel = "noopener noreferrer";
  actions.append(directions);
  if (placeItem.website) {
    const website = makeElement("a", "shop-action secondary-action", "Website ↗");
    website.href = placeItem.website;
    website.target = "_blank";
    website.rel = "noopener noreferrer";
    actions.append(website);
  }
  const source = makeElement("a", "shop-source", "View map record");
  source.href = osmObjectUrl(placeItem);
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  source.title = "Open this shop's OpenStreetMap record to verify or suggest an edit";
  actions.append(source);
  body.append(actions);
  card.append(marker, body);
  card.addEventListener("mouseenter", () => highlightMarker(index));
  card.addEventListener("focusin", () => highlightMarker(index));
  return card;
}

function markerPopup(placeItem) {
  const popup = document.createElement("div");
  popup.className = "map-popup";
  popup.append(makeElement("strong", "", placeItem.name), makeElement("span", "", placeItem.typeLabel));
  const link = makeElement("a", "", "Open map record ↗");
  link.href = osmObjectUrl(placeItem);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  popup.append(link);
  return popup;
}

function ensureMap() {
  if (map) return;
  map = L.map("map-canvas", { scrollWheelZoom: false, zoomControl: true }).setView([20, 0], 2);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
  }).addTo(map);
  markerLayer = L.featureGroup().addTo(map);
}

function showMap(place, places) {
  try {
    ensureMap();
  } catch {
    mapPlaceLabel.textContent = locationLabel(place);
    mapPlaceholder.replaceChildren(makeElement("span", "map-load-error", "Map unavailable. Shop listings are still shown."));
    mapPlaceholder.hidden = false;
    mapPlaceholder.setAttribute("aria-hidden", "false");
    return;
  }
  mapPlaceholder.hidden = true;
  mapPlaceLabel.textContent = locationLabel(place);
  markerLayer.clearLayers();
  currentMarkers = [];
  if (currentView === "nearby") L.circle([place.lat, place.lon], { radius: Number(radiusSelect.value) * 1000, color: "#718c43", weight: 1, fillColor: "#d9edaa", fillOpacity: .16, dashArray: "5 6" }).addTo(markerLayer);
  places.forEach((placeItem, index) => {
    const icon = L.divIcon({ className: "shop-marker-wrap", html: `<span class="shop-marker"><span>${index + 1}</span></span>`, iconSize: [30, 36], iconAnchor: [15, 33] });
    const marker = L.marker([placeItem.lat, placeItem.lon], { icon }).bindPopup(markerPopup(placeItem));
    marker.addTo(markerLayer);
    currentMarkers.push(marker);
  });
  const bounds = markerLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds.pad(.16), { maxZoom: 15 });
  else map.setView([place.lat, place.lon], 13);
  window.setTimeout(() => map.invalidateSize(), 80);
}

function highlightMarker(index) {
  currentMarkers.forEach((marker, markerIndex) => marker.setZIndexOffset(markerIndex === index ? 500 : 0));
}

function addMissingShopLink(place) {
  const link = makeElement("a", "add-shop-link", "Add a missing shop to OpenStreetMap ↗");
  link.href = `https://www.openstreetmap.org/edit#map=17/${place.lat}/${place.lon}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function setViewButtons() {
  const savedButton = document.querySelector("#saved-nav");
  savedButton.classList.toggle("is-active", currentView === "saved");
  savedButton.setAttribute("aria-pressed", String(currentView === "saved"));
}

function renderPlaces(places, place, fetchedAt, cached) {
  currentResults = places;
  resultsList.replaceChildren();
  const count = places.length;
  const radius = Number(radiusSelect.value);
  resultsTitle.textContent = currentView === "saved" ? "Your saved shops." : count ? `${count} ${count === 1 ? "place" : "places"} near ${place.name}.` : "No mapped shops in this radius.";
  resultsMeta.textContent = currentView === "saved"
    ? `${count} saved ${count === 1 ? "shop" : "shops"} · stored on this device`
    : `${categories[selectedCategory].label} · within ${radius} km of ${place.name} · ${cached ? "recent search" : "map checked"} ${new Date(fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  setSearchState("results");

  if (!count) {
    const noResults = makeElement("div", "no-results");
    noResults.append(makeElement("h3", "", currentView === "saved" ? "No saved shops yet." : "No mapped shops found nearby."));
    noResults.append(makeElement("p", "", currentView === "saved" ? "Save a shop with the star to keep it here." : "The map may not have listings for this category yet. Try a wider radius or add a missing shop to OpenStreetMap."));
    if (currentView !== "saved") {
      const expand = makeElement("button", "example-search", "Expand to next radius ↗");
      expand.type = "button";
      expand.addEventListener("click", expandRadius);
      noResults.append(expand, addMissingShopLink(place));
    }
    resultsList.append(noResults);
  } else {
    places.forEach((placeItem, index) => resultsList.append(makeShopCard(placeItem, index)));
  }
  if (place) showMap(place, places);
}

function expandRadius() {
  const next = [...radiusSelect.options].map((option) => Number(option.value)).find((radius) => radius > Number(radiusSelect.value));
  if (!next) return showToast("Already showing the widest radius");
  radiusSelect.value = String(next);
  const cached = currentPlace && readCache(currentPlace, selectedCategory);
  if (cached) {
    nearbyResults = makePlaces(cached.elements, currentPlace, next, selectedCategory);
    nearbyFetchedAt = cached.fetchedAt;
    nearbyCached = true;
    renderPlaces(nearbyResults, currentPlace, nearbyFetchedAt, nearbyCached);
  } else {
    searchForm.requestSubmit();
  }
}

async function runSearch(forceRefresh = false) {
  if (activeRequest) return;
  const query = locationInput.value.trim();
  if (!query) {
    locationInput.focus();
    searchError.textContent = "Enter a city and country to keep results in the right place.";
    searchError.hidden = false;
    return;
  }
  activeRequest = true;
  searchError.hidden = true;
  searchError.textContent = "";
  searchButton.disabled = true;
  searchButton.querySelector("span:first-child").textContent = "Searching…";
  document.querySelector("#loading-place").textContent = query;
  resultsList.replaceChildren();
  setSearchState("loading");
  try {
    const place = await geocodeCity(query);
    currentPlace = place;
    const fetched = await fetchPlaces(place, selectedCategory, forceRefresh);
    const places = makePlaces(fetched.elements, place, Number(radiusSelect.value), selectedCategory);
    nearbyResults = places;
    nearbyFetchedAt = fetched.fetchedAt;
    nearbyCached = fetched.cached;
    currentView = "nearby";
    setViewButtons();
    renderPlaces(places, place, fetched.fetchedAt, fetched.cached);
  } catch (error) {
    resultsList.replaceChildren();
    resultsTitle.textContent = "We couldn't finish that search.";
    resultsMeta.textContent = "Check the place name or try again shortly.";
    resultsMeta.hidden = false;
    resultsTools.hidden = true;
    emptyState.hidden = true;
    loadingState.hidden = true;
    resultsList.hidden = false;
    const failure = makeElement("p", "search-failure", error.message || "Something went wrong. Please try again.");
    resultsList.append(failure);
    if (currentPlace) showMap(currentPlace, []);
  } finally {
    activeRequest = false;
    searchButton.disabled = false;
    searchButton.querySelector("span:first-child").textContent = "Find nearby";
  }
}

function renderSavedPlaces() {
  currentView = "saved";
  setViewButtons();
  const saved = readSaved();
  const place = currentPlace || saved[0]?.origin;
  renderPlaces(saved, place, Date.now(), false);
  if (!place) resultsMeta.textContent = `${saved.length} saved ${saved.length === 1 ? "shop" : "shops"} · stored on this device`;
}

function reverseLookup(lat, lon) {
  return geocoderDelay().then(async () => {
    const url = new URL(`${geocoderUrl}/reverse`);
    url.search = new URLSearchParams({ format: "jsonv2", lat: String(lat), lon: String(lon), zoom: "10", addressdetails: "1", "accept-language": "en" });
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Could not identify your city from that location.");
    return response.json();
  });
}

function useCurrentLocation() {
  if (!navigator.geolocation) return showToast("Location sharing is not available in this browser");
  const button = document.querySelector("#location-button");
  button.disabled = true;
  button.querySelector("span:last-child").textContent = "Finding your area…";
  navigator.geolocation.getCurrentPosition(async ({ coords }) => {
    try {
      const result = await reverseLookup(coords.latitude, coords.longitude);
      const address = result.address || {};
      const locality = address.city || address.town || address.municipality || address.village || address.county;
      if (!locality || !address.country) throw new Error("Could not identify your city. Enter it manually instead.");
      locationInput.value = [locality, address.state, address.country].filter(Boolean).join(", ");
      await runSearch();
    } catch (error) {
      showToast(error.message || "Could not identify your location");
    } finally {
      button.disabled = false;
      button.querySelector("span:last-child").textContent = "Use my location";
    }
  }, (error) => {
    button.disabled = false;
    button.querySelector("span:last-child").textContent = "Use my location";
    showToast(error.code === error.PERMISSION_DENIED ? "Location permission was declined. Enter a city instead." : "Could not get your location. Enter a city instead.");
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
}

document.querySelectorAll(".category-option").forEach((button) => {
  button.addEventListener("click", () => setCategory(button.dataset.category));
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch();
});
document.querySelector("#location-button").addEventListener("click", useCurrentLocation);
document.querySelector("#example-search").addEventListener("click", () => {
  locationInput.value = "Bogura, Bangladesh";
  runSearch();
});
document.querySelector("#refresh-button").addEventListener("click", () => runSearch(true));
document.querySelector("#sort-select").addEventListener("change", (event) => {
  const sorted = [...currentResults];
  if (event.target.value === "recent") sorted.sort((first, second) => new Date(second.mapEditedAt || 0) - new Date(first.mapEditedAt || 0));
  else if (event.target.value === "distance") sorted.sort((first, second) => (first.distance ?? Infinity) - (second.distance ?? Infinity));
  else sorted.sort((first, second) => (first.primaryMatch ?? 0) - (second.primaryMatch ?? 0) || (first.distance ?? Infinity) - (second.distance ?? Infinity));
  if (currentView === "nearby") nearbyResults = sorted;
  renderPlaces(sorted, currentPlace, currentView === "nearby" ? nearbyFetchedAt : Date.now(), currentView === "nearby" ? nearbyCached : true);
});
document.querySelector("#saved-nav").addEventListener("click", () => {
  if (currentView === "saved") {
    currentView = "nearby";
    setViewButtons();
    if (currentPlace) renderPlaces(nearbyResults, currentPlace, nearbyFetchedAt, nearbyCached);
    else {
      resultsTitle.textContent = "A good place to start.";
      setSearchState("empty");
    }
  } else {
    renderSavedPlaces();
  }
});
radiusSelect.addEventListener("change", () => {
  if (currentView !== "nearby" || !currentPlace) return;
  const cached = readCache(currentPlace, selectedCategory);
  if (cached) {
    nearbyResults = makePlaces(cached.elements, currentPlace, Number(radiusSelect.value), selectedCategory);
    nearbyFetchedAt = cached.fetchedAt;
    nearbyCached = true;
    renderPlaces(nearbyResults, currentPlace, nearbyFetchedAt, nearbyCached);
  }
});

updateSavedCount();