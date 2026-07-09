import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
         "--enable-unsafe-swiftshader", "--mute-audio"],
});
const p = await b.newPage();
await p.setViewport({ width: 390, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://localhost:5177/", { waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 1000));
await p.evaluate(() => {
  document.querySelectorAll('.tbtn').forEach(btn => {
    if (btn.textContent.includes('▶')) btn.click();
    if (btn.textContent.includes('Mix')) btn.click();
  });
});
await p.evaluate(() => {
  window.testMeters = {};
  setInterval(() => {
    const mx = document.querySelectorAll('.mx-strip');
    mx.forEach(el => {
      const track = el.dataset.track;
      const peakLabel = el.querySelector('.mx-peak-label');
      if (peakLabel && peakLabel.textContent && peakLabel.style.display !== 'none') {
        const val = parseInt(peakLabel.textContent);
        if (!window.testMeters[track] || val > window.testMeters[track]) {
          window.testMeters[track] = val;
        }
      }
    });
  }, 100);
});
await new Promise(r => setTimeout(r, 8000)); // wait for 2 full bars
const meters = await p.evaluate(() => window.testMeters);
console.log("METERS:", meters);
await b.close();
