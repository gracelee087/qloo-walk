# TasteWalk (working title)

A GPS walking audio guide that learns your taste as you walk. Built for the
[Qloo Agentic Hackathon](https://qloo.devpost.com/). Walking area: SoHo & the
Lower East Side, New York (configured in `js/city.js`).

Work in progress — this README will be rewritten before submission.

## Run locally

```sh
cp .env.example .env      # fill in keys
npm install
npm run dev               # netlify dev → http://localhost:8888
```

Rebuild the map data (streets, placeholder places, subway stations) from
OpenStreetMap: `npm run refresh-data`.

## Origin

Started from the code of my earlier project myeongdong-3d (a Seoul walking
guide). The 3D city was replaced with a 2D Leaflet map and all Seoul-specific
data and content were removed.

## Data & attribution

Map data © OpenStreetMap contributors (ODbL). Places in `data/area-pois.json`
are placeholders from OpenStreetMap until Qloo results replace them.
