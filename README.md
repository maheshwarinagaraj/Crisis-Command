# CrisisMesh backend
```
npm install
cp .env.example .env   # optional keys
export $(cat .env | xargs) && npm start
```
Socket.IO events: `state` (full crisis state), `agent_log`.

REST
- POST /api/location {lat,lng}        live geolocation → sets HQ, reseeds units
- POST /api/incidents {text,lat?,lng?} e.g. {"text":"Industrial fire, 60 people trapped"}
- POST /api/resources/:id/fail
- POST /api/resources/:id/position {lat,lng}  live unit GPS
- POST /api/blocks {incidentId}
- POST /api/approval {decision:"approve"|"reject"}
- GET  /api/state

Frontend snippet (live geo):
```js
navigator.geolocation.watchPosition(p=>fetch(API+'/api/location',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lat:p.coords.latitude,lng:p.coords.longitude})}));
io(API).on('state',s=>render(s));
```
Put a built frontend in ./public to serve it from the same server.
