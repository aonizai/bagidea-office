// Shared auto-translate for BagIdea Office pop-out windows (Tools Hub, Plugins
// Hub, Workflow Builder). Thai is the source language; for any OTHER office
// language we pull cached translations from the daemon (/i18n) and ask it to
// fill in anything missing (Gemini, cached to disk → later harvested into the
// shipped seed). English keeps its hand-written copy in each window.
//
//   const WL = await WinLang.build(reg.lang);   // {lang, map, tr(s), ensure()}
//   el.textContent = WL.tr(thaiString);          // map[thai] || thai
//   WL.ensure(allThaiStrings, () => rerender()); // fill gaps, re-render live
window.WinLang = (function () {
  async function build(lang) {
    const self = { lang: lang || "th", map: {} };
    self.tr = (s) => (self.map[s] != null ? self.map[s] : s);
    if (self.lang === "th") { self.ensure = async () => {}; return self; }
    try {
      const r = await fetch("/i18n/all?lang=" + self.lang);
      self.map = (await r.json()).map || {};
    } catch {}
    // Ask the daemon to translate strings we don't have yet, then poll a few
    // times so background Gemini results get picked up and re-rendered live.
    self.ensure = async function (strings, onUpdate) {
      const want = [...new Set((strings || []).filter(Boolean).map(String))];
      const missing = () => want.filter((s) => !(s in self.map));
      if (!missing().length) return;
      try {
        await fetch("/i18n", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ lang: self.lang, strings: missing() }),
        });
      } catch {}
      for (let i = 0; i < 8 && missing().length; i++) {
        await new Promise((r) => setTimeout(r, 1300));
        try {
          const r = await fetch("/i18n/all?lang=" + self.lang);
          const m = (await r.json()).map || {};
          let upd = false;
          for (const s of want) if (m[s] != null && self.map[s] == null) { self.map[s] = m[s]; upd = true; }
          if (upd && onUpdate) onUpdate();
        } catch {}
      }
    };
    return self;
  }
  return { build: build };
})();
