// Twitter/X auto-capture: liked tweets automatically sent to Second Brain

(function () {
  if (window.__sbTwitterAutocapture) return;
  window.__sbTwitterAutocapture = true;

  const CAPTURED_KEY = "sb-captured-tweets";
  // Detect bookmark clicks (capture phase to catch before React handles it)
  document.addEventListener(
    "click",
    (e) => {

      const bookmarkButton = e.target.closest('[data-testid="bookmark"]');
      if (!bookmarkButton) return;

      console.log("[SB] bookmark button clicked!", e.target, bookmarkButton);

      // Try to find the tweet article (works in timeline view)
      const article = bookmarkButton.closest('article[data-testid="tweet"]');

      // Determine tweet URL: from article's time link, or fall back to page URL
      let tweetUrl;
      if (article) {
        const timeLink = article.querySelector("a[href*='/status/'] time")
          ?.closest("a[href*='/status/']");
        if (timeLink) {
          tweetUrl = new URL(timeLink.href, window.location.origin).href;
        }
      }
      if (!tweetUrl && /\/status\/\d+/.test(window.location.pathname)) {
        tweetUrl = window.location.href.split("?")[0];
      }
      if (!tweetUrl) {
        console.log("[SB] could not determine tweet URL");
        return;
      }

      // Dedup check + settings (auto-capture can be disabled from the welcome page)
      chrome.storage.local.get([CAPTURED_KEY, "twitterAutocaptureEnabled", "sbTwitterNoticeShown"], (result) => {
        if (result.twitterAutocaptureEnabled === false) return;

        const captured = result[CAPTURED_KEY] || [];
        if (captured.includes(tweetUrl)) return;

        // Mark as captured (keep last 500 to avoid unbounded growth)
        const updated = [...captured, tweetUrl].slice(-500);
        chrome.storage.local.set({ [CAPTURED_KEY]: updated });

        // Use full page HTML + document.title, same as manual capture
        const html = document.documentElement.outerHTML;
        const title = document.title;

        chrome.runtime.sendMessage(
          { action: "capture", html, title, url: tweetUrl },
          (response) => {
            if (response?.success) {
              if (!result.sbTwitterNoticeShown) {
                // First time: explain what just happened and where to turn it off
                chrome.storage.local.set({ sbTwitterNoticeShown: true });
                showToast("Saved to Second Brain — bookmarked tweets are auto-captured. Turn this off on the extension's welcome page.", false, 7000);
              } else {
                showToast("Bookmarked tweet captured");
              }
            } else {
              showToast("Capture failed", true);
            }
          }
        );
      });
    },
    true // capture phase
  );

  let xRadarEnabled = true;
  const radarSeen = new Set();
  const radarQueue = [];
  let radarTimer = null;

  chrome.storage.local.get("xRadarEnabled", (result) => {
    xRadarEnabled = result.xRadarEnabled !== false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.xRadarEnabled) {
      xRadarEnabled = changes.xRadarEnabled.newValue !== false;
    }
  });

  function uniqueLinks(links) {
    return [...new Set(links)].slice(0, 5);
  }

  function extractTweet(article) {
    if (article.parentElement?.closest('article[data-testid="tweet"]')) return null;
    const time = article.querySelector("time");
    const statusLink = time?.closest("a[href*='/status/']");
    const href = statusLink?.getAttribute("href");
    if (!href) return null;
    const url = new URL(href, location.origin).href.split("?")[0];
    const userText = article.querySelector('[data-testid="User-Name"]')?.innerText || "";
    const handle = (userText.match(/@([A-Za-z0-9_]{1,15})/) || [])[1];
    if (!handle) return null;
    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')]
      .filter((node) => !node.closest('article[data-testid="tweet"]') || node.closest('article[data-testid="tweet"]') === article)
      .map((node) => node.innerText.trim())
      .filter(Boolean);
    const ownText = texts[0] || "";
    const quoteText = texts.slice(1).join("\n");
    const outboundUrls = uniqueLinks(
      [...article.querySelectorAll("a[href]")].flatMap((anchor) => {
        try {
          const parsed = new URL(anchor.href, location.origin);
          const host = parsed.hostname.replace(/^www\./, "");
          if (host === "x.com" || host === "twitter.com") return [];
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
          return [parsed.href.split("#")[0]];
        } catch {
          return [];
        }
      }),
    );
    if (ownText.length < 40 && outboundUrls.length === 0 && !quoteText) return null;
    const snippet = [ownText, quoteText].filter(Boolean).join("\n").slice(0, 1500);
    return {
      channel: "x",
      sourceId: `x:@${handle.toLowerCase()}`,
      sourceName: `@${handle}`,
      authorHandle: `@${handle}`,
      title: ownText.slice(0, 80) || `@${handle}`,
      url,
      publishedAt: time.getAttribute("datetime") || new Date().toISOString(),
      snippet,
      outboundUrls,
    };
  }

  function mergeThread(batch) {
    if (!/\/status\/\d+/.test(location.pathname)) return batch;
    const groups = [];
    for (const item of batch) {
      const last = groups[groups.length - 1];
      if (last && last.authorHandle === item.authorHandle) {
        last.snippet = `${last.snippet}\n${item.snippet}`.slice(0, 1500);
        last._count += 1;
        last.rawLengthHint = `Thread (${last._count})`;
        last.outboundUrls = uniqueLinks([...(last.outboundUrls || []), ...(item.outboundUrls || [])]);
      } else {
        groups.push({ ...item, _count: 1 });
      }
    }
    return groups.map((item) => {
      const copy = { ...item };
      delete copy._count;
      return copy;
    });
  }

  function flushRadar() {
    if (radarTimer) {
      clearTimeout(radarTimer);
      radarTimer = null;
    }
    if (!xRadarEnabled || radarQueue.length === 0) {
      radarQueue.length = 0;
      return;
    }
    const batch = radarQueue.splice(0, radarQueue.length);
    chrome.runtime.sendMessage({ action: "radarIngest", items: mergeThread(batch) });
  }

  function queueTweet(article) {
    if (!xRadarEnabled) return;
    const item = extractTweet(article);
    if (!item || radarSeen.has(item.url)) return;
    radarSeen.add(item.url);
    radarQueue.push(item);
    if (radarQueue.length >= 10) flushRadar();
    else if (!radarTimer) radarTimer = setTimeout(flushRadar, 10000);
  }

  const radarObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) queueTweet(entry.target);
    }
  }, { threshold: 0.5 });

  function watchTweets() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
      if (article.dataset.sbRadar) return;
      article.dataset.sbRadar = "1";
      radarObserver.observe(article);
    });
  }

  const tweetChanges = new MutationObserver(watchTweets);
  if (document.body) tweetChanges.observe(document.body, { childList: true, subtree: true });
  watchTweets();

  function showToast(message, isError = false, durationMs = 2000) {
    const existing = document.getElementById("sb-autocapture-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "sb-autocapture-toast";
    if (isError) toast.classList.add("sb-toast-error");
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }
})();
