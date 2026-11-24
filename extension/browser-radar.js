// High-dwell reading tracker. A page is ingested only after a minute of
// active attention and a real scroll, and only when the user has the
// Browser Reading Radar toggle on.
(function () {
  if (window.__sbBrowserRadar) return;
  window.__sbBrowserRadar = true;

  const DEFAULT_EXACT = new Set([
    "localhost",
    "127.0.0.1",
    "google.com",
    "bing.com",
    "duckduckgo.com",
    "search.brave.com",
    "x.com",
    "twitter.com",
  ]);
  const DEFAULT_SUFFIXES = [
    "mail.google.com",
    "docs.google.com",
    "drive.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "mail.yahoo.com",
    "web.whatsapp.com",
    "discord.com",
    "slack.com",
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "paypal.com",
    "capitalone.com",
  ];

  let enabled = true;
  let extraDomains = [];
  let activeSeconds = 0;
  let maxDepth = 0;
  let lastInteraction = Date.now();
  let lastSentSeconds = 0;
  let sent = false;
  let pageUrl = location.href;

  function loadSettings() {
    chrome.storage.local.get(["browserRadarEnabled", "radarExcludedDomains"], (result) => {
      enabled = result.browserRadarEnabled !== false;
      extraDomains = String(result.radarExcludedDomains || "")
        .split(",")
        .map((domain) => domain.trim().toLowerCase().replace(/^www\./, ""))
        .filter(Boolean);
    });
  }
  loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.browserRadarEnabled || changes.radarExcludedDomains)) loadSettings();
  });

  function hostBlocked(hostname) {
    const host = hostname.toLowerCase().replace(/^www\./, "");
    if (DEFAULT_EXACT.has(host)) return true;
    const blocked = DEFAULT_SUFFIXES.concat(extraDomains);
    return blocked.some((domain) => host === domain || host.endsWith(`.${domain}`));
  }

  function currentDepth() {
    const scrolling = document.documentElement;
    const max = scrolling.scrollHeight - window.innerHeight;
    if (max <= 0) return 1;
    return Math.min(1, Math.max(0, window.scrollY / max));
  }

  function reset(url) {
    pageUrl = url;
    activeSeconds = 0;
    maxDepth = 0;
    lastSentSeconds = 0;
    sent = false;
    lastInteraction = Date.now();
  }

  function snippet() {
    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    return (root?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  }

  function send() {
    if (!enabled || hostBlocked(location.hostname)) return;
    const canonical = document.querySelector('link[rel="canonical"]')?.href || location.href.split("#")[0];
    const host = location.hostname.replace(/^www\./, "");
    chrome.runtime.sendMessage({
      action: "radarIngest",
      items: [{
        channel: "browser",
        sourceId: `browser:${host}`,
        sourceName: host,
        title: document.title || host,
        url: canonical,
        publishedAt: new Date().toISOString(),
        snippet: snippet(),
        engagement: { dwellSeconds: activeSeconds, scrollDepth: Math.round(maxDepth * 100) / 100 },
      }],
    });
  }

  function maybeSend(forceUpdate) {
    maxDepth = Math.max(maxDepth, currentDepth());
    if (activeSeconds < 60 || maxDepth < 0.3) return;
    if (!sent || (forceUpdate && activeSeconds >= lastSentSeconds + 30)) {
      sent = true;
      lastSentSeconds = activeSeconds;
      send();
    }
  }

  ["scroll", "mousemove", "keydown"].forEach((eventName) => {
    window.addEventListener(eventName, () => {
      lastInteraction = Date.now();
    }, { passive: true });
  });

  setInterval(() => {
    if (location.href !== pageUrl) {
      reset(location.href);
      return;
    }
    if (!enabled || document.visibilityState !== "visible") return;
    if (Date.now() - lastInteraction > 15000) return;
    activeSeconds += 1;
    maybeSend(false);
  }, 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") maybeSend(true);
  });
  window.addEventListener("pagehide", () => maybeSend(true));
})();
