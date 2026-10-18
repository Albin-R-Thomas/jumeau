// Minimal reproductions of the four production responses supplied during investigation.
const http = require("node:http");
http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let payload;
  if (url.pathname === "/geo/1.0/direct") {
    const ifo = url.searchParams.get("q").startsWith("Ifo");
    payload = ifo ? [
      { name: "Ifo", lat: -18.9346323, lon: 169.2877569, country: "VU" },
      { name: "Ifo", lat: -66.62977095, lon: 139.73124858976993, country: "" },
      { name: "Ifo", lat: 6.8144895, lon: 3.1957574, country: "NG" }
    ] : [
      { name: "Smolensk", lat: 54.7814057, lon: 32.0461261, country: "RU" },
      { name: "Smolensk", lat: 54.77897005, lon: 32.04718121915615, country: "RU" },
      { name: "Livingston Island", lat: -62.6079191, lon: -60.659619996, country: "" }
    ];
  } else if (url.pathname === "/data/2.5/weather") {
    const cafunfo = Number(url.searchParams.get("lat")) > -10;
    payload = {
      name: cafunfo ? "" : "South America", sys: {},
      main: { temp: cafunfo ? 33.02 : 21.16, humidity: cafunfo ? 39 : 73 },
      weather: [{ description: "few clouds" }], dt: 1792321576
    };
  } else {
    res.writeHead(501); res.end(); return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}).listen(process.env.PORT);
