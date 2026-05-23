const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

const virtualConsole = new jsdom.VirtualConsole();
virtualConsole.on("error", () => { console.log("ERROR:", ...arguments); });
virtualConsole.on("warn", () => { console.log("WARN:", ...arguments); });
virtualConsole.on("info", () => { console.log("INFO:", ...arguments); });
virtualConsole.on("log", () => { console.log("LOG:", ...arguments); });
virtualConsole.on("jsdomError", (e) => { console.log("JSDOM_ERROR:", e.message, e.detail); });

const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole });
setTimeout(() => {
  console.log("Done");
}, 2000);
