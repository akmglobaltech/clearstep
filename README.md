# Clearstep

Clearstep helps visitors find locally mapped shops for phones, laptops, and accessories.

## Try it

Open `index.html` in a modern browser. Search a city and country, choose a category and radius, or opt in to use the browser's current location. Results include map position, mapped contact details, directions, source records, and each shop record's last edit date. Shops can be saved in local browser storage.

## Data and limits

Place boundaries come from OpenStreetMap's Nominatim service. Shop records and map tiles come from OpenStreetMap/Overpass. The app queries only phone, computer, and electronics shop tags inside the selected city's mapped boundary, then applies the chosen distance from that city centre. Coverage depends on community mapping and can be incomplete or out of date. Map edit dates describe record edits, not a shop's current operating status.

OpenStreetMap does not provide live inventory or prices. A result is a mapped place, not confirmation that it sells a particular model or has stock today; visitors should call ahead. Search endpoints and map tiles have their own usage policies and rate limits. The app caches results in the browser for ten minutes to reduce repeat requests.

OpenStreetMap data is available under the ODbL. Attribution appears alongside the map; see <https://www.openstreetmap.org/copyright>. Location is requested only after the visitor chooses **Use my location**. Saved shops remain in that browser.

The static MVP queries public Nominatim and Overpass endpoints directly and caches map results for ten minutes per browser session. These shared endpoints may throttle or reject high-volume use; they are not an unlimited production API. A larger launch should add a compliant shared cache/backend or a data provider with service guarantees.