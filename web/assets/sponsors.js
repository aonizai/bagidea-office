/* BagIdea Office — renders the sponsor wall from sponsors.json.
   Source of truth = /sponsors.json. Sorted by tier (gold > silver > bronze >
   supporter), then by `weight` DESC within a tier. The dollar figure is never
   shown — `weight` only orders the wall. Gold gets the largest logo + a glow
   badge; each step down is smaller; supporters with no logo become name chips.
   Every sponsor links out to their site/social. Falls back silently (leaving
   the hardcoded markup) if the file can't be fetched. */
(function () {
  const ORDER = ["gold", "silver", "bronze", "supporter"];
  const BADGE = { gold: "👑", silver: "🥈", bronze: "🥉", supporter: "💛" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function safeUrl(u) {
    const s = String(u || "");
    return /^https?:\/\//i.test(s) ? s : "";
  }

  // A sponsor with a logo → logo card; without → a name chip (keeps lowest
  // tiers light even with hundreds of names).
  function card(s, tier, label) {
    const url = safeUrl(s.url);
    const open = url
      ? `<a class="sp-logo ${tier}" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(s.name)} — ${esc(label)} 🙏">`
      : `<span class="sp-logo ${tier}" title="${esc(s.name)} — ${esc(label)}">`;
    const close = url ? "</a>" : "</span>";
    const inner = s.logo
      ? `<img src="${esc(s.logo)}" alt="${esc(s.name)} — ${esc(label)}" loading="lazy">
         <span class="sp-badge">${BADGE[tier] || ""} ${esc(label)}</span>`
      : `<span class="sp-name">${esc(s.name)}</span>`;
    return open + inner + close;
  }
  function chip(s) {
    const url = safeUrl(s.url);
    // small round avatar when a logo is given, so every supporter gets a clear
    // display — text-only when none is provided
    const av = s.logo
      ? `<img class="sp-chip-av" src="${esc(s.logo)}" alt="${esc(s.name)}" loading="lazy">`
      : "";
    const cls = s.logo ? "sp-chip has-av" : "sp-chip";
    if (url)
      return `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(s.name)} 🙏">${av}<span>${esc(s.name)}</span></a>`;
    return `<span class="${cls}">${av}<span>${esc(s.name)}</span></span>`;
  }

  function render(data, host) {
    const tiers = (data && data.tiers) || {};
    const list = ((data && data.sponsors) || []).slice();
    if (!list.length) return; // keep fallback markup

    // group by tier, sort each by weight desc (stable for equal weights)
    const groups = {};
    for (const s of list) (groups[s.tier] || (groups[s.tier] = [])).push(s);
    for (const k in groups)
      groups[k].sort((a, b) => (b.weight || 0) - (a.weight || 0));

    const html = [];
    for (const tier of ORDER) {
      const g = groups[tier];
      if (!g || !g.length) continue;
      const label = (tiers[tier] && tiers[tier].label) || tier;
      if (tier === "supporter") {
        // compact name-chip row — scales to many names without a logo each
        html.push(
          `<div class="sp-row sp-row-supporter"><div class="sp-chips">${g
            .map(chip)
            .join("")}</div></div>`
        );
      } else {
        html.push(
          `<div class="sp-row sp-row-${tier}">${g
            .map((s) => card(s, tier, label))
            .join("")}</div>`
        );
      }
    }
    host.innerHTML = html.join("");
  }

  function boot() {
    const host = document.getElementById("sponsorWall");
    if (!host) return;
    fetch("sponsors.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => render(data, host))
      .catch(() => { /* leave the hardcoded fallback in place */ });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
