/* BagIdea Office — site i18n. English is the canonical source (I18N.en).
   Other languages override per key; any missing key falls back to English.
   The 14 languages mirror the ones the app itself supports. */
const LANGS = [
  ["en","🇬🇧 English"],["zh","🇨🇳 中文"],["es","🇪🇸 Español"],["hi","🇮🇳 हिन्दी"],
  ["ar","🇸🇦 العربية"],["pt","🇧🇷 Português"],["ru","🇷🇺 Русский"],["ja","🇯🇵 日本語"],
  ["de","🇩🇪 Deutsch"],["fr","🇫🇷 Français"],["ko","🇰🇷 한국어"],["id","🇮🇩 Indonesia"],
  ["vi","🇻🇳 Tiếng Việt"],["th","🇹🇭 ไทย"],
];
const RTL = new Set(["ar"]);

const I18N = {
  en: {
    nav_features:"Features", nav_docs:"Docs", nav_install:"Install", nav_sponsors:"Sponsors",
    cta_get:"Get started", cta_docs:"Read the docs", cta_github:"GitHub",
    hero_title:'Your wallpaper <span class="grad">goes to work</span>.',
    hero_sub:"BagIdea Office turns your Windows desktop into a living HD-2D office where every AI agent is a real Claude that walks to its desk, asks permission, holds meetings, and gets work done — behind your icons.",
    badge_win:"Windows 11", badge_open:"Open source", badge_free:"Free to run",
    badge_langs:"14 languages",
    shot_cap:"A real desktop, captured live — agents at their desks, the brand billboard, the day/night cycle following your local time.",

    what_eyebrow:"What is it", what_title:"Not a dashboard. A world.",
    what_lead:"Most AI tools give you a chat box. BagIdea Office gives your agents a place to live — and shows you the true state of every Claude Code session as a pixel-art employee at work.",
    what_p1_h:"Real agents, real work", what_p1_p:"Every character is a real Claude Code session running inside real project folders. When you delegate, you watch the work actually happen — desks, hand-offs, meetings, approvals.",
    what_p2_h:"Truth, not theatre", what_p2_p:"Nothing on screen is faked. A walk to Security is a real permission request; a glowing screen is a live tool call; a finished task really finished. The wallpaper renders the truth.",
    what_p3_h:"It lives on your desktop", what_p3_p:"It renders behind your desktop icons like a real wallpaper — calm when idle, alive when working. A chat head and tray icon keep it one click away.",

    feat_eyebrow:"Features", feat_title:"Everything your office can do",
    feat_lead:"A full agent-operations product — rendered as a place.",
    f_world_t:"Living wallpaper world", f_world_d:"HD-2D office behind your icons: agents walk an A* graph, glowing monitors, auras, a roofline clock, countryside with grass, clouds and fireflies, and a real day/night cycle tied to your clock.",
    f_ceo_t:"CEO chain of command", f_ceo_d:"You are the CEO. Give an order and the Director walks over, takes it, plans, and delegates real work to the team — every hand-off acted out on the wallpaper, then the summary walked back to you.",
    f_ghost_t:"Self-splitting ghosts", f_ghost_d:"When work parallelizes, an agent splits into translucent ghost clones that hurry up the glass staircase to the floating Ghost Deck, work in parallel, then merge back with a synthesis.",
    f_grid_t:"Swappable 3×3 office", f_grid_d:"Rearrange the whole floor in the 3D Editor — click two rooms to swap. Furniture, agent seats, navigation and even the cat and dogs follow their room.",
    f_voice_t:"Voice, channels & memory", f_voice_d:"Talk by voice (F6 push-to-talk), call the office (realtime Gemini Live), give agents one of 16 ♀/♂ voices, and run it from Telegram, Discord or LINE. Hermes-style memory grows token-lean.",
    f_plugin_t:"Plugins, skills & tools", f_plugin_d:"Extend the office with plugins (install from any GitHub repo), assign agents from a library of builtin skills, and add new capability via MCP servers — humans and agents can build plugins.",
    f_security_t:"Spatialized security", f_security_d:"When an agent needs a tool you haven't granted, it physically walks to the Security Center and waits. You Allow / ✓✓ Forever / Deny. Granted tools run silently and never leave the desk.",
    f_projects_t:"Real projects", f_projects_d:"Register real folders as projects; the Director creates and routes work into them. Each assignee's Claude session lives inside the directory and is resumable by you — one window per project.",
    f_i18n_t:"14 languages", f_i18n_d:"The whole UI speaks 14 languages — English, ไทย, 中文, Español, हिन्दी, العربية, Português, Русский, 日本語, Deutsch, Français, 한국어, Indonesia, Tiếng Việt — auto-translated and switchable office-wide.",

    tour_eyebrow:"A look around", tour_title:"See it in action",
    tour1_h:"A live desktop wallpaper", tour1_p:"It runs behind your real desktop icons with an optional activity feed down the side — clean for streaming, alive while agents work.",
    tour2_h:"Talk to your office", tour2_p:"Open on the CEO seat and give orders; the Director takes them and dispatches the team. Every conversation is a resumable thread with full history.",
    tour3_h:"Rearrange it in 3D", tour3_p:"The 3D Office Editor lets you swap rooms on a 3×3 grid, move the Ghost Deck, place furniture, and import your own models and images.",
    tour4_h:"Drive it from the terminal", tour4_p:"The bagidea CLI controls everything — start/stop, ask, status, projects, plugins, proposals, voice and more.",

    inst_eyebrow:"Installation", inst_title:"Up and running in minutes",
    inst_lead:"One command installs every dependency, builds the app, and wires it onto your PATH.",
    inst_plat:"Currently supported: Windows 11. Linux & macOS wallpaper backends are planned and will land in a later update.",
    inst_s1_h:"Run the one-shot installer", inst_s1_p:"Open PowerShell and paste this. It installs Git, Node LTS, Rust, Godot 4.6.3 and the Claude Code CLI, clones the app, builds the shell, brands the icon, and adds the bagidea command to your PATH.",
    inst_s2_h:"Log in to Claude (first time only)", inst_s2_p:"Open a new terminal and run claude once to sign in with your existing Claude account or subscription — that's the brain of every agent.",
    inst_s3_h:"Start the office", inst_s3_p:"Run bagidea start (or use the Start Menu shortcut). Your wallpaper becomes the office, with the chat head and tray icon ready.",
    inst_req_h:"Requirements", inst_req:"Windows 11 · a Vulkan-capable GPU (verified on a GTX 1060) · a Claude account (Claude Code CLI). Node, Rust and Godot are installed for you by the installer.",
    inst_manual:"Prefer manual? Clone the repo, build the Rust shell with cargo build --release, and run it. Full steps are in the docs.",

    cli_eyebrow:"Command line", cli_title:"The bagidea CLI",
    cli_lead:"Run the whole office from your terminal — and script it into anything.",
    cli_more:"See the full CLI reference in the docs →",

    sp_eyebrow:"Sponsors", sp_title:"Back an open AI-agent workspace",
    sp_lead:"BagIdea Office is built in the open. Sponsorship funds development, art licenses, cross-platform backends, and keeps it free to run. Your brand is shown here and in the app's credits.",
    sp_gold_t:"Gold Partner", sp_gold_1:"Logo on the site & in-app credits", sp_gold_2:"Top placement, largest size", sp_gold_3:"Roadmap input & early builds", sp_gold_4:"Shout-out in release notes",
    sp_silver_t:"Silver Partner", sp_silver_1:"Logo on the website", sp_silver_2:"Mention in release notes", sp_silver_3:"Early access to builds",
    sp_bronze_t:"Bronze / Backer", sp_bronze_1:"Name on the supporters list", sp_bronze_2:"Our heartfelt thanks", sp_bronze_3:"A good-karma boost",
    sp_cta:"Become a sponsor", sp_contact:"Reach out and let's talk →",

    foot_tag:"Your wallpaper goes to work.", foot_made:"Built with Claude Code.",
    foot_product:"Product", foot_resources:"Resources", foot_company:"Company",
    foot_features:"Features", foot_install:"Install", foot_docs:"Documentation", foot_cli:"CLI reference",
    foot_github:"GitHub repo", foot_template:"Plugin template", foot_issues:"Report an issue",
    foot_sponsors:"Sponsors", foot_contact:"Contact",
    founder_name:"Mr. Thanawat Suriya", founder_role:"CEO & Founder · BagIdea Innovation Co., Ltd.",
    copyright:"© 2026 BagIdea Innovation Co., Ltd. · MIT-licensed open source.",

    /* ---------- docs page ---------- */
    d_title:"Documentation", d_sub:"Everything about BagIdea Office — what it is, every feature, how to install, and the full CLI.",
    d_back:"← Home",
    dn_intro:"Introduction", dn_what:"What it is", dn_concepts:"Core concepts",
    dn_install:"Installation", dn_install_win:"Windows (one-shot)", dn_install_manual:"Manual build", dn_install_first:"First run", dn_install_fix:"If it fails",
    dn_using:"Using it", dn_chat:"Chat & the CEO", dn_projects:"Projects", dn_security:"Permissions", dn_editor:"3D Editor", dn_voice:"Voice & channels",
    dn_features:"Features", dn_plugins:"Plugins & skills", dn_lang:"Languages",
    dn_cli:"CLI reference", dn_faq:"FAQ",

    d_intro_h:"Introduction", d_intro_p1:"BagIdea Office is a living AI-agent office that runs as your Windows desktop wallpaper. Every AI agent on your machine becomes a pixel-art employee in an HD-2D office: they walk to their desks when real work starts, gather at Security to ask permission, hold meetings, learn skills, and the lights follow your real local time.",
    d_intro_p2:"It is not a dashboard and not a chat window — it is a world that renders the true state of your Claude Code sessions, headless agent runs and custom scripts as living characters, behind your desktop icons.",
    d_intro_p3:"Three independent layers keep it robust: a zero-dependency Node daemon (the source of truth), a Godot 4 renderer (the wallpaper), and a lightweight overlay UI (chat, settings, approvals). The daemon keeps agents running even if rendering restarts.",

    d_what_h:"What it is", d_what_p:"At its heart, BagIdea Office is an operations layer for AI agents — given a place. Instead of a flat list of tasks, you get a spatial, honest view of what your agents are actually doing:",
    d_what_l1:"Real Claude Code sessions, spawned with each agent's persona, skills and allowed tools.",
    d_what_l2:"A CEO → Director → team chain of command you drive by giving orders.",
    d_what_l3:"Spatialized permission approvals — agents walk to Security for tools you haven't granted.",
    d_what_l4:"Real project folders, resumable sessions, and self-splitting sub-agents for parallel work.",

    d_concepts_h:"Core concepts",
    d_c_ceo_h:"You are the CEO", d_c_ceo_p:"The gold seat is you. Type an order and the Director (the main Claude agent) walks over, takes it, plans, and delegates to the team.",
    d_c_director_h:"The Director", d_c_director_p:"main is your second-in-command — Shino by default: a playful-but-focused manager who answers you, creates projects, and routes work to the team with DELEGATE lines. Tuned for delegation over hands-on work; you can re-tune or rename him in the editor.",
    d_c_ghost_h:"Ghosts (sub-agents)", d_c_ghost_p:"When a job parallelizes, an agent splits into translucent clones that work on the Ghost Deck and merge back with a synthesis.",
    d_c_grid_h:"The room grid", d_c_grid_p:"The floor is a 3×3 jigsaw of identical rooms; any room fits any slot, so you can rearrange the whole office in the editor.",

    d_install_h:"Installation",
    d_install_win_h:"Windows — one-shot installer (recommended)",
    d_install_win_p:"Open PowerShell and run the command below. On a bare machine it installs everything needed — Git, Node LTS, Rust, the Visual Studio C++ Build Tools (the Rust linker, and the most common reason a build fails), Godot 4.6.3 and the Claude Code CLI — then clones the app to %LOCALAPPDATA%\\BagIdeaOffice, builds the desktop shell, brands the window icon, adds bagidea to your PATH and creates a Start Menu shortcut. Freshly installed tools are pulled onto the current PATH so it finishes in one pass, and it is safe to re-run (a re-run does a git pull; your data is kept). The first run downloads the C++ Build Tools (~2–4 GB, one time) if they are missing.",
    d_install_fix_h:"If the install fails",
    d_install_fix_p:"The installer is built to finish on a bare machine, but here are the common snags and their fixes. Almost all are solved by opening a NEW terminal and re-running the installer — re-runs are safe and keep your data.",
    d_install_fix_l1:"<b>execution policy error</b> — run: <code>powershell -ExecutionPolicy Bypass -Command \"irm https://raw.githubusercontent.com/bagidea/bagidea-office/main/installer/install.ps1 | iex\"</code>",
    d_install_fix_l2:"<b>winget not found</b> — install \"App Installer\" from the Microsoft Store, reopen the terminal, re-run.",
    d_install_fix_l3:"<b>BUILD FAILED / linker 'link.exe' not found</b> — the C++ Build Tools are missing. Run <code>winget install Microsoft.VisualStudio.2022.BuildTools --override \"--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended\"</code> (or add \"Desktop development with C++\" in the Visual Studio Installer), open a new terminal, re-run.",
    d_install_fix_l4:"<b>git / node / cargo not found right after install</b> — winget updates PATH in the registry, not the open shell. Open a new terminal and re-run; it finishes from where it stopped.",
    d_install_fix_l5:"<b>SmartScreen / Defender blocks the script</b> — it's open source (read it in the repo). Choose \"More info → Run anyway\", or download install.ps1 and run it yourself.",
    d_install_fix_l6:"<b>bagidea command not found after a successful build</b> — it was just added to PATH; open a new terminal, or launch from Start Menu → \"BagIdea Office\".",
    d_install_manual_h:"Manual build",
    d_install_manual_p:"Clone the repository, point the Claude hook paths at your clone, then build the Rust shell:",
    d_install_first_h:"First run",
    d_install_first_p:"Log in to Claude once, then start the office. Your wallpaper becomes the live office; a chat head and tray icon appear.",
    d_install_plat:"Platform support: Windows 11 today (wallpaper embedding uses the WorkerW technique). Linux and macOS backends are planned for a later update.",

    d_using_h:"Using it",
    d_chat_h:"Chat & the CEO", d_chat_p:"The chat panel opens on your CEO seat. Type an order in the CEO seat and the Director walks over to take it, plans, and delegates — you watch the hand-offs on the wallpaper, and the summary is walked back to you. To talk to any agent directly, click their face in the rail or on the live map. Every conversation is a resumable thread with full history.",
    d_projects_h:"Projects", d_projects_p:"Register real folders as projects (with PLACE shorthands like \"classroom → D:\\Learning\"). The Director can create new projects himself and route work into them; the assignee's Claude session runs inside that directory and is resumable. One window per project — ▶ opens it, or shows a live view while an agent works.",
    d_security_h:"Permissions", d_security_p:"Tools you grant in an agent's profile run silently — and the agent never even leaves its desk. For anything else, the agent walks to the Security Center and waits while a card pops up with the exact command. Choose Allow, ✓✓ Forever (remembers the grant), or Deny. No answer in 50 seconds auto-denies and the agent re-plans.",
    d_editor_h:"The 3D Editor", d_editor_p:"Open the editor (the 🎨 button or bagidea editor) to rearrange the office in true 3D: click two rooms to swap them on the 3×3 grid, move the Ghost Deck, place furniture and decor, and import your own .glb/.gltf/.fbx models and images. Save and the wallpaper updates instantly — furniture, agent seats, navigation and pets all follow.",
    d_voice_h:"Voice & channels", d_voice_p:"Hold F6 anywhere to speak a command to the office. Give agents one of 16 TTS voices (split clearly ♀/♂). Call the main agent for a realtime voice conversation (Gemini Live) in its assigned voice. Connect Telegram, Discord or LINE and command your office from your phone — replies come back on the same channel.",

    d_plugins_h:"Plugins, skills & tools",
    d_plugins_p:"Plugins extend the office for real — a folder with a manifest can add UI panels, HTTP routes, and commands agents can drive, with ctx access to the registry, feed, broadcasting and even running Claude turns. Two core plugins ship in the box (🎵 Music Player, 🧮 Calculator); install more from any GitHub repo. Start from the official template, or read the worked example repos.",
    d_skills_p:"Every office ships with a library of builtin skills (office operations, deep research, office control, plugin building, code review, docs, debugging, data wrangling, project kickoff, diagrams) you can assign to any agent, plus Hermes-style skills the office learns automatically after real work. Add new raw capability via MCP servers.",
    d_lang_h:"Languages", d_lang_p:"The whole interface supports 14 languages. English is the default; pick another in settings and the office translates office-wide (and remembers your choice per machine). This website speaks the same 14 languages — use the picker in the top bar.",

    d_cli_h:"CLI reference", d_cli_p:"The installer puts bagidea on your PATH. It talks to the running office and can start it. A few highlights:",
    d_faq_h:"FAQ",
    d_faq_q1:"Does it cost money to run?", d_faq_a1:"The app is free and open source (MIT). Agents run through your own Claude Code login, so usage follows your existing Claude account or subscription — there is no separate BagIdea fee.",
    d_faq_q2:"Is my code/data sent anywhere?", d_faq_a2:"The daemon runs locally on 127.0.0.1. Agents are Claude Code sessions, so they use Claude like any Claude Code project. Optional features (voice, image, realtime) use your own OpenAI/Gemini keys only when you enable them.",
    d_faq_q3:"Which platforms are supported?", d_faq_a3:"Windows 11 today. Linux and macOS wallpaper backends are on the roadmap.",
    d_faq_q4:"Can I build my own plugin?", d_faq_a4:"Yes — fork the official template repo. A person or an agent can build a working plugin from it in minutes; the full spec is in the plugin guide.",
  },

  de: {
    nav_features:"Funktionen", nav_docs:"Dokumentation", nav_install:"Installieren", nav_sponsors:"Sponsoren",
    cta_get:"Loslegen", cta_docs:"Dokumentation lesen", cta_github:"GitHub",
    hero_title:'Ihr Hintergrundbild <span class="grad">geht arbeiten</span>.',
    hero_sub:"BagIdea Office verwandelt Ihren Windows-Desktop in ein lebendiges HD-2D-Büro, in dem jeder KI-Agent ein echter Claude ist, der zu seinem Schreibtisch geht, um Erlaubnis bittet, Meetings abhält und Arbeit erledigt — hinter Ihren Icons.",
    badge_win:"Windows 11", badge_open:"Open Source", badge_free:"Kostenlos nutzbar",
    badge_langs:"14 Sprachen",
    shot_cap:"Ein echter Desktop, live aufgenommen — Agents an ihren Schreibtischen, das Marken-Billboard, der Tag-Nacht-Zyklus nach Ihrer lokalen Zeit.",

    what_eyebrow:"Was ist das", what_title:"Kein Dashboard. Eine Welt.",
    what_lead:"Die meisten KI-Werkzeuge bieten Ihnen eine Chatbox. BagIdea Office gibt Ihren Agents einen Platz zum Leben — und zeigt Ihnen den wahren Zustand jeder Claude Code-Sitzung als Pixel-Art-Mitarbeiter bei der Arbeit.",
    what_p1_h:"Echte Agents, echte Arbeit", what_p1_p:"Jede Figur ist eine echte Claude Code-Sitzung, die in echten Projektordnern läuft. Wenn Sie delegieren, sehen Sie die Arbeit tatsächlich geschehen — Schreibtische, Übergaben, Meetings, Genehmigungen.",
    what_p2_h:"Wahrheit, kein Theater", what_p2_p:"Nichts auf dem Bildschirm ist gefälscht. Ein Gang zur Sicherheitszentrale ist eine echte Berechtigungsanfrage; ein leuchtender Bildschirm ist ein live Werkzeugaufruf; eine abgeschlossene Aufgabe ist wirklich abgeschlossen. Das Hintergrundbild rendert die Wahrheit.",
    what_p3_h:"Es lebt auf Ihrem Desktop", what_p3_p:"Es rendert hinter Ihren Desktop-Icons wie ein echtes Hintergrundbild — ruhig im Leerlauf, lebendig bei der Arbeit. Ein Chat-Kopf und ein Tray-Icon halten es einen Klick entfernt.",

    feat_eyebrow:"Funktionen", feat_title:"Alles, was Ihr Büro kann",
    feat_lead:"Ein vollständiges Agent-Betriebsprodukt — dargestellt als Ort.",
    f_world_t:"Lebendige Hintergrundbild-Welt", f_world_d:"HD-2D-Büro hinter Ihren Icons: Agents gehen auf einem A*-Graphen, leuchtende Monitore, Auren, eine Dachuhr, Landschaft mit Gras, Wolken und Glühwürmchen sowie ein echter Tag-Nacht-Zyklus, der mit Ihrer Uhr verbunden ist.",
    f_ceo_t:"CEO-Befehlskette", f_ceo_d:"Sie sind der CEO. Geben Sie einen Befehl, und der Director kommt, nimmt ihn entgegen, plant und delegiert echte Arbeit an das Team — jede Übergabe wird auf dem Hintergrundbild ausgespielt, dann wird die Zusammenfassung zu Ihnen zurückgebracht.",
    f_ghost_t:"Sich selbst teilende Geister", f_ghost_d:"Wenn Arbeit parallelisiert wird, teilt sich ein Agent in durchscheinende Geistklone auf, die die Glastreppe zum schwebenden Ghost Deck hinaufeilen, parallel arbeiten und dann mit einer Synthese wieder zusammengeführt werden.",
    f_grid_t:"Austauschbares 3×3-Büro", f_grid_d:"Ordnen Sie den gesamten Grundriss im 3D-Editor um — klicken Sie zwei Räume an, um sie zu tauschen. Möbel, Agent-Plätze, Navigation und sogar die Katze und die Hunde folgen ihrem Raum.",
    f_voice_t:"Sprache, Kanäle und Gedächtnis", f_voice_d:"Sprechen Sie per Sprache (F6 Push-to-Talk), rufen Sie das Büro an (Echtzeit-Gemini Live), geben Sie Agents eine von 16 · Stimmen, und betreiben Sie es über Telegram, Discord oder LINE. Das Hermes-artige Gedächtnis wächst token-sparsam.",
    f_plugin_t:"Plugins, Fähigkeiten und Werkzeuge", f_plugin_d:"Erweitern Sie das Büro mit Plugins (aus jedem GitHub-Repo installierbar), weisen Sie Agents Fähigkeiten aus einer Bibliothek integrierter Skills zu, und fügen Sie neue Möglichkeiten über MCP-Server hinzu — Menschen und Agents können Plugins bauen.",
    f_security_t:"Räumliche Sicherheit", f_security_d:"Wenn ein Agent ein Werkzeug benötigt, das Sie nicht freigegeben haben, geht er physisch zur Sicherheitszentrale und wartet. Sie wählen Erlauben / ✓✓ Immer / Ablehnen. Freigegebene Werkzeuge laufen lautlos und verlassen nie den Schreibtisch.",
    f_projects_t:"Echte Projekte", f_projects_d:"Registrieren Sie echte Ordner als Projekte; der Director erstellt und leitet Arbeit in diese weiter. Die Claude-Sitzung jedes Aufgabennehmers läuft innerhalb des Verzeichnisses und kann von Ihnen fortgesetzt werden — ein Fenster pro Projekt.",
    f_i18n_t:"14 Sprachen", f_i18n_d:"Die gesamte Benutzeroberfläche spricht 14 Sprachen — Englisch, ไทย, 中文, Español, हिन्दी, العربية, Português, Русский, 日本語, Deutsch, Français, 한국어, Indonesia, Tiếng Việt — automatisch übersetzt und büroweit umschaltbar.",

    tour_eyebrow:"Ein Rundgang", tour_title:"Sehen Sie es in Aktion",
    tour1_h:"Ein live Desktop-Hintergrundbild", tour1_p:"Es läuft hinter Ihren echten Desktop-Icons mit einem optionalen Aktivitäts-Feed an der Seite — sauber beim Streamen, lebendig wenn Agents arbeiten.",
    tour2_h:"Sprechen Sie mit Ihrem Büro", tour2_p:"Öffnen Sie den CEO-Sitz und geben Sie Befehle; der Director nimmt sie entgegen und schickt das Team los. Jedes Gespräch ist ein fortsetzbarer Thread mit vollständigem Verlauf.",
    tour3_h:"Ordnen Sie es in 3D um", tour3_p:"Der 3D-Büro-Editor lässt Sie Räume auf einem 3×3-Raster tauschen, das Ghost Deck verschieben, Möbel platzieren und eigene Modelle und Bilder importieren.",
    tour4_h:"Steuern Sie es vom Terminal", tour4_p:"Die bagidea-CLI steuert alles — start/stop, fragen, Status, Projekte, Plugins, Vorschläge, Sprache und mehr.",

    inst_eyebrow:"Installation", inst_title:"In Minuten einsatzbereit",
    inst_lead:"Ein Befehl installiert alle Abhängigkeiten, baut die App und fügt sie zu Ihrem PATH hinzu.",
    inst_plat:"Derzeit unterstützt: Windows 11. Linux- und macOS-Wallpaper-Backends sind geplant und werden in einem späteren Update veröffentlicht.",
    inst_s1_h:"Den Einzel-Installer ausführen", inst_s1_p:"Öffnen Sie PowerShell und fügen Sie dies ein. Es installiert Git, Node LTS, Rust, Godot 4.6.3 und die Claude Code-CLI, klont die App, baut die Shell, versieht das Icon mit dem Markenzeichen und fügt den bagidea-Befehl zu Ihrem PATH hinzu.",
    inst_s2_h:"Bei Claude anmelden (nur beim ersten Mal)", inst_s2_p:"Öffnen Sie ein neues Terminal und führen Sie claude einmal aus, um sich mit Ihrem bestehenden Claude-Konto oder -Abonnement anzumelden — das ist das Gehirn jedes Agents.",
    inst_s3_h:"Das Büro starten", inst_s3_p:"Führen Sie bagidea start aus (oder verwenden Sie die Startmenü-Verknüpfung). Ihr Hintergrundbild wird zum Büro, mit Chat-Kopf und Tray-Icon bereit.",
    inst_req_h:"Systemanforderungen", inst_req:"Windows 11 · eine Vulkan-fähige GPU (getestet auf einer GTX 1060) · ein Claude-Konto (Claude Code CLI). Node, Rust und Godot werden vom Installer für Sie installiert.",
    inst_manual:"Lieber manuell? Klonen Sie das Repo, bauen Sie die Rust-Shell mit cargo build --release und führen Sie sie aus. Vollständige Schritte sind in der Dokumentation.",

    cli_eyebrow:"Befehlszeile", cli_title:"Die bagidea-CLI",
    cli_lead:"Steuern Sie das gesamte Büro von Ihrem Terminal aus — und binden Sie es in alles ein.",
    cli_more:"Die vollständige CLI-Referenz in der Dokumentation →",

    sp_eyebrow:"Sponsoren", sp_title:"Einen offenen KI-Agent-Arbeitsbereich unterstützen",
    sp_lead:"BagIdea Office wird offen entwickelt. Sponsoring finanziert Entwicklung, Kunstlizenzen, plattformübergreifende Backends und hält es kostenlos nutzbar. Ihre Marke wird hier und in den App-Credits angezeigt.",
    sp_gold_t:"Gold Partner", sp_gold_1:"Logo auf der Website und in den App-Credits", sp_gold_2:"Top-Platzierung, größte Größe", sp_gold_3:"Roadmap-Einfluss und frühe Builds", sp_gold_4:"Erwähnung in den Release Notes",
    sp_silver_t:"Silver Partner", sp_silver_1:"Logo auf der Website", sp_silver_2:"Erwähnung in den Release Notes", sp_silver_3:"Frühzeitiger Zugang zu Builds",
    sp_bronze_t:"Bronze / Unterstützer", sp_bronze_1:"Name auf der Unterstützerliste", sp_bronze_2:"Unser herzlicher Dank", sp_bronze_3:"Ein Karma-Boost",
    sp_cta:"Sponsor werden", sp_contact:"Melden Sie sich und lassen Sie uns sprechen →",

    foot_tag:"Ihr Hintergrundbild geht arbeiten.", foot_made:"Gebaut mit Claude Code.",
    foot_product:"Produkt", foot_resources:"Ressourcen", foot_company:"Unternehmen",
    foot_features:"Funktionen", foot_install:"Installieren", foot_docs:"Dokumentation", foot_cli:"CLI-Referenz",
    foot_github:"GitHub-Repo", foot_template:"Plugin-Vorlage", foot_issues:"Problem melden",
    foot_sponsors:"Sponsoren", foot_contact:"Kontakt",
    founder_name:"Mr. Thanawat Suriya", founder_role:"CEO & Gründer · BagIdea Innovation Co., Ltd.",
    copyright:"© 2026 BagIdea Innovation Co., Ltd. · MIT-lizenzierter Open Source.",

    d_title:"Dokumentation", d_sub:"Alles über BagIdea Office — was es ist, jede Funktion, wie man es installiert und die vollständige CLI.",
    d_back:"← Startseite",
    dn_intro:"Einführung", dn_what:"Was es ist", dn_concepts:"Grundkonzepte",
    dn_install:"Installation", dn_install_win:"Windows (Einzel-Befehl)", dn_install_manual:"Manueller Build", dn_install_first:"Erste Ausführung",
    dn_using:"Nutzung", dn_chat:"Chat & CEO", dn_projects:"Projekte", dn_security:"Berechtigungen", dn_editor:"3D-Editor", dn_voice:"Sprache & Kanäle",
    dn_features:"Funktionen", dn_plugins:"Plugins & Fähigkeiten", dn_lang:"Sprachen",
    dn_cli:"CLI-Referenz", dn_faq:"FAQ",

    d_intro_h:"Einführung", d_intro_p1:"BagIdea Office ist ein lebendiges KI-Agent-Büro, das als Ihr Windows-Desktop-Hintergrundbild läuft. Jeder KI-Agent auf Ihrem Rechner wird zu einem Pixel-Art-Mitarbeiter in einem HD-2D-Büro: Er geht zu seinem Schreibtisch, wenn echte Arbeit beginnt, versammelt sich bei der Sicherheitszentrale, um Erlaubnis zu bitten, hält Meetings ab, lernt Fähigkeiten, und die Lichter folgen Ihrer echten lokalen Zeit.",
    d_intro_p2:"Es ist kein Dashboard und kein Chatfenster — es ist eine Welt, die den wahren Zustand Ihrer Claude Code-Sitzungen, kopflosen Agent-Läufe und benutzerdefinierten Skripte als lebendige Figuren hinter Ihren Desktop-Icons rendert.",
    d_intro_p3:"Drei unabhängige Schichten sorgen für Robustheit: ein abhängigkeitsfreier Node-Daemon (die einzige Wahrheitsquelle), ein Godot 4-Renderer (das Hintergrundbild) und eine leichtgewichtige Overlay-UI (Chat, Einstellungen, Genehmigungen). Der Daemon hält Agents am Laufen, auch wenn der Renderer neu startet.",

    d_what_h:"Was es ist", d_what_p:"Im Kern ist BagIdea Office eine Betriebsschicht für KI-Agents — mit einem Ort versehen. Anstatt einer flachen Aufgabenliste erhalten Sie eine räumliche, ehrliche Ansicht dessen, was Ihre Agents tatsächlich tun:",
    d_what_l1:"Echte Claude Code-Sitzungen, erzeugt mit der Persona, den Fähigkeiten und erlaubten Werkzeugen jedes Agents.",
    d_what_l2:"Eine CEO → Director → Team-Befehlskette, die Sie durch das Geben von Befehlen steuern.",
    d_what_l3:"Räumliche Berechtigungsgenehmigungen — Agents gehen zur Sicherheitszentrale für Werkzeuge, die Sie nicht freigegeben haben.",
    d_what_l4:"Echte Projektordner, fortsetzbare Sitzungen und sich selbst teilende Sub-Agents für parallele Arbeit.",

    d_concepts_h:"Grundkonzepte",
    d_c_ceo_h:"Sie sind der CEO", d_c_ceo_p:"Der goldene Sitz sind Sie. Tippen Sie einen Befehl ein und der Director (der Haupt-Claude-Agent) kommt herüber, nimmt ihn entgegen, plant und delegiert an das Team.",
    d_c_director_h:"Der Director", d_c_director_p:"main ist Claude selbst — der Büromanager, der Ihnen antwortet, Projekte erstellt und Arbeit mit DELEGATE-Zeilen weiterleitet.",
    d_c_ghost_h:"Geister (Sub-Agents)", d_c_ghost_p:"Wenn eine Aufgabe parallelisiert wird, teilt sich ein Agent in durchscheinende Klone auf, die auf dem Ghost Deck arbeiten und mit einer Synthese wieder zusammengeführt werden.",
    d_c_grid_h:"Das Raumraster", d_c_grid_p:"Der Boden ist ein 3×3-Puzzle aus identischen Räumen; jeder Raum passt in jeden Slot, sodass Sie das gesamte Büro im Editor umordnen können.",

    d_install_h:"Installation",
    d_install_win_h:"Windows — Einzel-Installer (empfohlen)",
    d_install_win_p:"Öffnen Sie PowerShell und führen Sie den folgenden Befehl aus. Er installiert alle Abhängigkeiten (Git, Node LTS, Rust, Godot 4.6.3, Claude Code CLI), klont die App nach %LOCALAPPDATA%\\BagIdeaOffice, baut die Desktop-Shell, versieht das Fenster-Icon mit dem Markenzeichen, fügt bagidea zu Ihrem PATH hinzu und erstellt eine Startmenü-Verknüpfung. Es ist sicher, es erneut auszuführen — jeder Schritt überspringt, was bereits erledigt ist.",
    d_install_manual_h:"Manueller Build",
    d_install_manual_p:"Klonen Sie das Repository, zeigen Sie die Claude-Hook-Pfade auf Ihren Klon und bauen Sie dann die Rust-Shell:",
    d_install_first_h:"Erste Ausführung",
    d_install_first_p:"Melden Sie sich einmal bei Claude an, dann starten Sie das Büro. Ihr Hintergrundbild wird zum live Büro; ein Chat-Kopf und ein Tray-Icon erscheinen.",
    d_install_plat:"Plattformunterstützung: Windows 11 heute (Wallpaper-Einbettung verwendet die WorkerW-Technik). Linux- und macOS-Backends sind für ein späteres Update geplant.",

    d_using_h:"Nutzung",
    d_chat_h:"Chat & CEO", d_chat_p:"Das Chat-Panel öffnet sich auf Ihrem CEO-Sitz. Geben Sie einen Befehl auf dem CEO-Sitz ein und der Director kommt herüber, um ihn entgegenzunehmen, plant und delegiert — Sie sehen die Übergaben auf dem Hintergrundbild, und die Zusammenfassung wird zu Ihnen zurückgebracht. Um direkt mit einem Agent zu sprechen, klicken Sie auf sein Gesicht in der Leiste oder auf der Live-Karte. Jedes Gespräch ist ein fortsetzbarer Thread mit vollständigem Verlauf.",
    d_projects_h:"Projekte", d_projects_p:"Registrieren Sie echte Ordner als Projekte (mit PLACE-Kürzeln wie \"Klassenzimmer → D:\\Learning\"). Der Director kann selbst neue Projekte erstellen und Arbeit dorthin weiterleiten; die Claude-Sitzung des Aufgabennehmers läuft in diesem Verzeichnis und ist fortsetzbar. Ein Fenster pro Projekt — ▶ öffnet es oder zeigt eine Live-Ansicht, während ein Agent arbeitet.",
    d_security_h:"Berechtigungen", d_security_p:"Werkzeuge, die Sie im Profil eines Agents freigeben, laufen lautlos — und der Agent verlässt sogar seinen Schreibtisch nie. Für alles andere geht der Agent zur Sicherheitszentrale und wartet, während eine Karte mit dem genauen Befehl erscheint. Wählen Sie Erlauben, ✓✓ Immer (merkt sich die Genehmigung) oder Ablehnen. Keine Antwort in 50 Sekunden lehnt automatisch ab und der Agent plant neu.",
    d_editor_h:"Der 3D-Editor", d_editor_p:"Öffnen Sie den Editor (die 🎨-Schaltfläche oder bagidea editor), um das Büro in echtem 3D umzuordnen: Klicken Sie zwei Räume an, um sie auf dem 3×3-Raster zu tauschen, verschieben Sie das Ghost Deck, platzieren Sie Möbel und Dekoration und importieren Sie eigene .glb/.gltf/.fbx-Modelle und Bilder. Speichern Sie und das Hintergrundbild wird sofort aktualisiert — Möbel, Agent-Plätze, Navigation und Haustiere folgen alle.",
    d_voice_h:"Sprache & Kanäle", d_voice_p:"Halten Sie F6 irgendwo gedrückt, um einen Befehl ans Büro zu sprechen. Geben Sie Agents eine von 16 TTS-Stimmen (klar in · aufgeteilt). Rufen Sie den Haupt-Agent für ein Echtzeit-Sprachgespräch (Gemini Live) in seiner zugewiesenen Stimme an. Verbinden Sie Telegram, Discord oder LINE und steuern Sie Ihr Büro von Ihrem Telefon aus — Antworten kommen auf demselben Kanal zurück.",

    d_plugins_h:"Plugins, Fähigkeiten und Werkzeuge",
    d_plugins_p:"Plugins erweitern das Büro wirklich — ein Ordner mit einem Manifest kann UI-Panels, HTTP-Routen und Befehle hinzufügen, die Agents steuern können, mit ctx-Zugriff auf die Registry, den Feed, Broadcasting und sogar das Ausführen von Claude-Aufgaben. Zwei Kern-Plugins werden mitgeliefert (🎵 Music Player, 🧮 Calculator); installieren Sie weitere aus jedem GitHub-Repo. Starten Sie mit der offiziellen Vorlage oder lesen Sie die Beispiel-Repos.",
    d_skills_p:"Jedes Büro wird mit einer Bibliothek integrierter Fähigkeiten geliefert (Tiefenrecherche, Bürosteuerung, Plugin-Erstellung, Code-Review, Dokumentation, Debugging, Datenverwaltung, Projekt-Kickoff, Diagramme), die Sie jedem Agent zuweisen können, plus Hermes-artige Fähigkeiten, die das Büro nach echter Arbeit automatisch erlernt. Fügen Sie neue rohe Fähigkeiten über MCP-Server hinzu.",
    d_lang_h:"Sprachen", d_lang_p:"Die gesamte Oberfläche unterstützt 14 Sprachen. Englisch ist die Standardsprache; wählen Sie eine andere in den Einstellungen und das Büro übersetzt büroweit (und merkt sich Ihre Wahl pro Rechner). Diese Website spricht dieselben 14 Sprachen — verwenden Sie die Auswahl in der oberen Leiste.",

    d_cli_h:"CLI-Referenz", d_cli_p:"Der Installer legt bagidea in Ihrem PATH ab. Es spricht mit dem laufenden Büro und kann es starten. Ein paar Highlights:",
    d_faq_h:"FAQ",
    d_faq_q1:"Kostet es Geld, es zu betreiben?", d_faq_a1:"Die App ist kostenlos und Open Source (MIT). Agents laufen über Ihr eigenes Claude Code-Login, sodass die Nutzung Ihrem bestehenden Claude-Konto oder -Abonnement folgt — es gibt keine separate BagIdea-Gebühr.",
    d_faq_q2:"Werden mein Code/meine Daten irgendwohin gesendet?", d_faq_a2:"Der Daemon läuft lokal auf 127.0.0.1. Agents sind Claude Code-Sitzungen, daher verwenden sie Claude wie jedes Claude Code-Projekt. Optionale Funktionen (Sprache, Bild, Echtzeit) verwenden nur Ihre eigenen OpenAI/Gemini-Schlüssel, wenn Sie sie aktivieren.",
    d_faq_q3:"Welche Plattformen werden unterstützt?", d_faq_a3:"Windows 11 heute. Linux- und macOS-Wallpaper-Backends sind auf der Roadmap.",
    d_faq_q4:"Kann ich mein eigenes Plugin bauen?", d_faq_a4:"Ja — forken Sie das offizielle Vorlagen-Repo. Eine Person oder ein Agent kann in Minuten ein funktionierendes Plugin daraus erstellen; die vollständige Spezifikation befindet sich im Plugin-Leitfaden.",
  },

  th: {
    nav_features:"ฟีเจอร์", nav_docs:"คู่มือ", nav_install:"ติดตั้ง", nav_sponsors:"สปอนเซอร์",
    cta_get:"เริ่มใช้งาน", cta_docs:"อ่านคู่มือ", cta_github:"GitHub",
    hero_title:'วอลเปเปอร์ของคุณ <span class="grad">ทำงานได้จริง</span>',
    hero_sub:"BagIdea Office เปลี่ยนเดสก์ท็อป Windows ของคุณให้เป็นออฟฟิศ HD-2D ที่มีชีวิต — ทุก AI agent คือ Claude ตัวจริงที่เดินไปนั่งโต๊ะ ขออนุญาตใช้เครื่องมือ ประชุม และทำงานจริง อยู่หลังไอคอนเดสก์ท็อปของคุณ",
    badge_win:"Windows 11", badge_open:"โอเพนซอร์ส", badge_free:"ใช้ฟรี",
    badge_langs:"14 ภาษา",
    shot_cap:"เดสก์ท็อปจริง ถ่ายสด — agents นั่งทำงานที่โต๊ะ, ป้ายแบรนด์, วงจรกลางวัน-กลางคืนตามเวลาเครื่องคุณ",

    what_eyebrow:"มันคืออะไร", what_title:"ไม่ใช่แดชบอร์ด แต่เป็นโลกทั้งใบ",
    what_lead:"เครื่องมือ AI ส่วนใหญ่ให้คุณแค่ช่องแชท แต่ BagIdea Office ให้ที่อยู่กับ agents ของคุณ — และแสดงสถานะจริงของทุก Claude Code session เป็นพนักงานพิกเซลอาร์ตที่กำลังทำงาน",
    what_p1_h:"agent จริง งานจริง", what_p1_p:"ทุกตัวละครคือ Claude Code session จริงที่รันอยู่ในโฟลเดอร์โปรเจคจริง เวลาคุณมอบหมายงาน คุณจะเห็นงานเกิดขึ้นจริง ทั้งโต๊ะ การส่งงาน การประชุม การขออนุญาต",
    what_p2_h:"ความจริง ไม่ใช่ละคร", what_p2_p:"ไม่มีอะไรบนจอเป็นของปลอม การเดินไปห้องขอสิทธิ์คือคำขอใช้เครื่องมือจริง จอเรืองแสงคือการเรียกใช้ tool จริง งานที่เสร็จก็เสร็จจริง วอลเปเปอร์เรนเดอร์ความจริง",
    what_p3_h:"อยู่บนเดสก์ท็อปของคุณ", what_p3_p:"มันเรนเดอร์อยู่หลังไอคอนเดสก์ท็อปเหมือนวอลเปเปอร์จริง — สงบตอนว่าง มีชีวิตตอนทำงาน มีหัวแชทและไอคอนถาดระบบให้เรียกใช้ได้ในคลิกเดียว",

    feat_eyebrow:"ฟีเจอร์", feat_title:"ทุกสิ่งที่ออฟฟิศของคุณทำได้",
    feat_lead:"โปรดักต์จัดการ agent แบบเต็มรูปแบบ — ในรูปของสถานที่จริง",
    f_world_t:"โลกวอลเปเปอร์มีชีวิต", f_world_d:"ออฟฟิศ HD-2D หลังไอคอน: agents เดินตามกราฟ A*, จอเรืองแสง, ออร่า, นาฬิกาบนหลังคา, ชนบทรอบออฟฟิศพร้อมหญ้า เมฆ หิ่งห้อย และวงจรกลางวัน-กลางคืนตามนาฬิกาเครื่องคุณ",
    f_ceo_t:"สายบังคับบัญชาผ่าน CEO", f_ceo_d:"คุณคือ CEO สั่งงานแล้ว Director จะเดินมารับคำสั่ง วางแผน และมอบหมายงานจริงให้ทีม — เห็นการส่งงานบนวอลเปเปอร์ แล้วเดินกลับมารายงานสรุปให้คุณ",
    f_ghost_t:"แตกร่างเป็นผีช่วยงาน", f_ghost_d:"เมื่องานแยกขนานได้ agent จะแตกเป็นร่างโคลนโปร่งแสง รีบขึ้นบันไดแก้วไปยัง Ghost Deck ลอยฟ้า ทำงานขนานกัน แล้วรวมร่างพร้อมสรุปผล",
    f_grid_t:"ออฟฟิศสลับได้ 3×3", f_grid_d:"จัดผังทั้งชั้นใน 3D Editor — คลิกสองห้องเพื่อสลับ เฟอร์นิเจอร์ จุดนั่งของ agents เส้นทางเดิน และแม้แต่แมวกับหมาก็ตามห้องไปด้วย",
    f_voice_t:"เสียง ช่องทาง และความจำ", f_voice_d:"คุยด้วยเสียง (F6 กดพูด), โทรหาออฟฟิศ (Gemini Live เรียลไทม์), ตั้งเสียงให้ agent ได้ 16 แบบ ♀/♂ และสั่งงานผ่าน Telegram, Discord, LINE ความจำสไตล์ Hermes โตแบบประหยัด token",
    f_plugin_t:"Plugin สกิล และเครื่องมือ", f_plugin_d:"ต่อยอดออฟฟิศด้วย plugin (ติดตั้งจาก GitHub repo ใดก็ได้), assign สกิลพื้นฐานให้ agent, และเพิ่มความสามารถใหม่ผ่าน MCP servers — ทั้งคนและ agent เขียน plugin ได้",
    f_security_t:"ระบบความปลอดภัยเชิงพื้นที่", f_security_d:"เมื่อ agent ต้องใช้เครื่องมือที่คุณยังไม่อนุญาต มันจะเดินไปห้องขอสิทธิ์และรอ คุณกด อนุญาต / ✓✓ ตลอดไป / ปฏิเสธ เครื่องมือที่อนุญาตแล้วทำงานเงียบ ๆ ไม่ต้องลุกจากโต๊ะ",
    f_projects_t:"โปรเจคจริง", f_projects_d:"ลงทะเบียนโฟลเดอร์จริงเป็นโปรเจค Director สร้างและจัดงานเข้าไปได้ session ของผู้รับงานทำงานอยู่ในโฟลเดอร์นั้นและกลับมาทำต่อได้ — หนึ่งหน้าต่างต่อหนึ่งโปรเจค",
    f_i18n_t:"14 ภาษา", f_i18n_d:"ทั้ง UI พูดได้ 14 ภาษา — อังกฤษ, ไทย, จีน, สเปน, ฮินดี, อาหรับ, โปรตุเกส, รัสเซีย, ญี่ปุ่น, เยอรมัน, ฝรั่งเศส, เกาหลี, อินโดนีเซีย, เวียดนาม — แปลอัตโนมัติและสลับได้ทั้งออฟฟิศ",

    tour_eyebrow:"ชมรอบ ๆ", tour_title:"ดูตอนใช้งานจริง",
    tour1_h:"วอลเปเปอร์เดสก์ท็อปสด", tour1_p:"รันอยู่หลังไอคอนจริงของคุณ พร้อมแถบ feed กิจกรรมด้านข้าง (ถ้าต้องการ) — สะอาดสำหรับสตรีม มีชีวิตตอน agents ทำงาน",
    tour2_h:"คุยกับออฟฟิศของคุณ", tour2_p:"เปิดมาที่ที่นั่ง CEO แล้วสั่งงาน Director รับคำสั่งและกระจายงานให้ทีม ทุกบทสนทนาเป็น thread ที่กลับมาต่อได้พร้อมประวัติเต็ม",
    tour3_h:"จัดผังใหม่แบบ 3 มิติ", tour3_p:"3D Office Editor ให้คุณสลับห้องในกริด 3×3, ย้าย Ghost Deck, วางเฟอร์นิเจอร์ และ import โมเดล/รูปของคุณเอง",
    tour4_h:"สั่งจากเทอร์มินัล", tour4_p:"คำสั่ง bagidea คุมได้ทุกอย่าง — เปิด/ปิด, ถาม, สถานะ, โปรเจค, plugin, ข้อเสนอ, เสียง และอีกมาก",

    inst_eyebrow:"การติดตั้ง", inst_title:"พร้อมใช้ในไม่กี่นาที",
    inst_lead:"คำสั่งเดียวติดตั้ง dependency ทั้งหมด, build แอป, และผูกคำสั่งเข้า PATH ให้",
    inst_plat:"ตอนนี้รองรับ Windows 11 ส่วน Linux และ macOS อยู่ในแผนและจะอัปเดตตามมาภายหลัง",
    inst_s1_h:"รันตัวติดตั้งคำสั่งเดียว", inst_s1_p:"เปิด PowerShell แล้ววางคำสั่งนี้ มันจะติดตั้ง Git, Node LTS, Rust, Godot 4.6.3 และ Claude Code CLI, clone แอป, build shell, ทำไอคอนแบรนด์ และเพิ่มคำสั่ง bagidea เข้า PATH",
    inst_s2_h:"ล็อกอิน Claude (ครั้งแรกครั้งเดียว)", inst_s2_p:"เปิดเทอร์มินัลใหม่ รัน claude หนึ่งครั้งเพื่อเข้าสู่ระบบด้วยบัญชี/แพ็กเกจ Claude ที่คุณมีอยู่ — นั่นคือสมองของทุก agent",
    inst_s3_h:"เปิดออฟฟิศ", inst_s3_p:"รัน bagidea start (หรือใช้ทางลัด Start Menu) วอลเปเปอร์จะกลายเป็นออฟฟิศ พร้อมหัวแชทและไอคอนถาดระบบ",
    inst_req_h:"ความต้องการของระบบ", inst_req:"Windows 11 · การ์ดจอที่รองรับ Vulkan (ทดสอบบน GTX 1060) · บัญชี Claude (Claude Code CLI) ส่วน Node, Rust, Godot ตัวติดตั้งจัดการให้",
    inst_manual:"อยากติดตั้งเอง? clone repo, build Rust shell ด้วย cargo build --release แล้วรัน ขั้นตอนเต็มอยู่ในคู่มือ",

    cli_eyebrow:"คอมมานด์ไลน์", cli_title:"คำสั่ง bagidea",
    cli_lead:"คุมทั้งออฟฟิศจากเทอร์มินัล — และเขียนสคริปต์ต่อยอดได้",
    cli_more:"ดูคำสั่งทั้งหมดในคู่มือ →",

    sp_eyebrow:"สปอนเซอร์", sp_title:"สนับสนุนพื้นที่ทำงาน AI agent แบบเปิด",
    sp_lead:"BagIdea Office พัฒนาแบบเปิด การสนับสนุนช่วยเรื่องการพัฒนา ลิขสิทธิ์อาร์ต รองรับหลายแพลตฟอร์ม และทำให้ใช้งานได้ฟรีต่อไป แบรนด์ของคุณจะแสดงที่นี่และในเครดิตของแอป",
    sp_gold_t:"Gold Partner", sp_gold_1:"โลโก้บนเว็บและเครดิตในแอป", sp_gold_2:"ตำแหน่งบนสุด ขนาดใหญ่สุด", sp_gold_3:"ร่วมกำหนด roadmap + ได้ build ก่อนใคร", sp_gold_4:"ขอบคุณใน release notes",
    sp_silver_t:"Silver Partner", sp_silver_1:"โลโก้บนเว็บไซต์", sp_silver_2:"กล่าวถึงใน release notes", sp_silver_3:"เข้าถึง build ก่อนใคร",
    sp_bronze_t:"Bronze / ผู้สนับสนุน", sp_bronze_1:"ชื่อในรายชื่อผู้สนับสนุน", sp_bronze_2:"คำขอบคุณจากใจ", sp_bronze_3:"เพิ่มบุญกุศลให้คุณ",
    sp_cta:"เป็นสปอนเซอร์", sp_contact:"ติดต่อเราเพื่อพูดคุย →",

    foot_tag:"วอลเปเปอร์ของคุณทำงานได้จริง", foot_made:"สร้างด้วย Claude Code",
    foot_product:"โปรดักต์", foot_resources:"แหล่งข้อมูล", foot_company:"บริษัท",
    foot_features:"ฟีเจอร์", foot_install:"ติดตั้ง", foot_docs:"คู่มือ", foot_cli:"คำสั่ง CLI",
    foot_github:"GitHub repo", foot_template:"เทมเพลต plugin", foot_issues:"แจ้งปัญหา",
    foot_sponsors:"สปอนเซอร์", foot_contact:"ติดต่อ",
    founder_name:"นายธนวัฒน์ สุริยะ", founder_role:"CEO & FOUNDER · บริษัท แบ็กไอเดีย อินโนเวชั่น จำกัด",
    copyright:"© 2026 บริษัท แบ็กไอเดีย อินโนเวชั่น จำกัด · โอเพนซอร์สสัญญาอนุญาต MIT",

    d_title:"คู่มือการใช้งาน", d_sub:"ทุกอย่างเกี่ยวกับ BagIdea Office — มันคืออะไร ฟีเจอร์ทั้งหมด วิธีติดตั้ง และคำสั่ง CLI ครบ",
    d_back:"← หน้าแรก",
    dn_intro:"แนะนำ", dn_what:"มันคืออะไร", dn_concepts:"แนวคิดหลัก",
    dn_install:"การติดตั้ง", dn_install_win:"Windows (คำสั่งเดียว)", dn_install_manual:"ติดตั้งเอง", dn_install_first:"เปิดครั้งแรก", dn_install_fix:"ถ้าติดตั้งไม่ผ่าน",
    dn_using:"การใช้งาน", dn_chat:"แชท & CEO", dn_projects:"โปรเจค", dn_security:"สิทธิ์การใช้เครื่องมือ", dn_editor:"3D Editor", dn_voice:"เสียง & ช่องทาง",
    dn_features:"ฟีเจอร์", dn_plugins:"Plugin & สกิล", dn_lang:"ภาษา",
    dn_cli:"คำสั่ง CLI", dn_faq:"คำถามที่พบบ่อย",

    d_intro_h:"แนะนำ", d_intro_p1:"BagIdea Office คือออฟฟิศ AI agent ที่มีชีวิต ทำงานเป็นวอลเปเปอร์เดสก์ท็อป Windows ของคุณ ทุก AI agent ในเครื่องจะกลายเป็นพนักงานพิกเซลอาร์ตในออฟฟิศ HD-2D เดินไปนั่งโต๊ะเมื่อมีงานจริง ไปขออนุญาตที่ห้องสิทธิ์ ประชุม เรียนรู้สกิล และแสงไฟตามเวลาจริงของเครื่องคุณ",
    d_intro_p2:"มันไม่ใช่แดชบอร์ดและไม่ใช่หน้าต่างแชท — แต่เป็นโลกที่เรนเดอร์สถานะจริงของ Claude Code session, การรัน agent แบบ headless และสคริปต์ของคุณ เป็นตัวละครมีชีวิต อยู่หลังไอคอนเดสก์ท็อป",
    d_intro_p3:"สามชั้นอิสระทำให้ระบบทนทาน: Node daemon แบบไม่มี dependency (แหล่งความจริง), ตัวเรนเดอร์ Godot 4 (วอลเปเปอร์), และ UI overlay เบา ๆ (แชท ตั้งค่า อนุมัติ) daemon ทำให้ agents ทำงานต่อแม้ตัวเรนเดอร์รีสตาร์ต",

    d_what_h:"มันคืออะไร", d_what_p:"แก่นของ BagIdea Office คือชั้นจัดการปฏิบัติการสำหรับ AI agent — ที่มีสถานที่ให้ แทนที่จะเป็นรายการงานแบน ๆ คุณจะได้มุมมองเชิงพื้นที่ที่ซื่อสัตย์ว่า agents ทำอะไรอยู่จริง:",
    d_what_l1:"Claude Code session จริง สร้างพร้อม persona สกิล และเครื่องมือที่อนุญาตของแต่ละ agent",
    d_what_l2:"สายบังคับบัญชา CEO → Director → ทีม ที่คุณคุมด้วยการสั่งงาน",
    d_what_l3:"การอนุมัติสิทธิ์เชิงพื้นที่ — agent เดินไปห้องสิทธิ์เมื่อต้องใช้เครื่องมือที่ยังไม่อนุญาต",
    d_what_l4:"โฟลเดอร์โปรเจคจริง, session ที่กลับมาต่อได้, และ sub-agent ที่แตกร่างทำงานขนาน",

    d_concepts_h:"แนวคิดหลัก",
    d_c_ceo_h:"คุณคือ CEO", d_c_ceo_p:"ที่นั่งสีทองคือคุณ พิมพ์สั่งงานแล้ว Director (Claude หลัก) จะเดินมารับ วางแผน และมอบหมายให้ทีม",
    d_c_director_h:"Director", d_c_director_p:"main คือมือขวาของคุณ — ค่าเริ่มต้นชื่อ Shino: ผู้จัดการบุคลิกหนุ่มขี้เล่นแต่จริงจังกับงาน ตอบคุณ สร้างโปรเจค และจัดงานให้ทีมด้วยบรรทัด DELEGATE เน้นสั่งงานมากกว่าลงมือเอง ปรับแต่งหรือเปลี่ยนชื่อได้ใน editor",
    d_c_ghost_h:"ผี (sub-agent)", d_c_ghost_p:"เมื่องานแยกขนานได้ agent จะแตกเป็นร่างโคลนโปร่งแสง ทำงานบน Ghost Deck แล้วรวมร่างพร้อมสรุป",
    d_c_grid_h:"กริดห้อง", d_c_grid_p:"พื้นเป็น jigsaw 3×3 ของห้องขนาดเท่ากัน ห้องไหนก็ไปสล็อตไหนได้ จัดผังทั้งออฟฟิศใหม่ใน editor ได้",

    d_install_h:"การติดตั้ง",
    d_install_win_h:"Windows — ตัวติดตั้งคำสั่งเดียว (แนะนำ)",
    d_install_win_p:"เปิด PowerShell แล้วรันคำสั่งด้านล่าง — บนเครื่องเปล่ามันจะลงทุกอย่างที่ต้องใช้: Git, Node LTS, Rust, Visual Studio C++ Build Tools (ตัว linker ของ Rust และเป็นสาเหตุ build ไม่ผ่านที่พบบ่อยที่สุด), Godot 4.6.3 และ Claude Code CLI → clone แอปไปที่ %LOCALAPPDATA%\\BagIdeaOffice → build shell → ตีตราไอคอน → เพิ่ม bagidea เข้า PATH และสร้างทางลัด Start Menu ของที่เพิ่งลงจะถูกดึงเข้า PATH ปัจจุบันให้จึงจบรวดเดียว และรันซ้ำได้ปลอดภัย (รันซ้ำ = git pull ข้อมูลไม่หาย) รอบแรกถ้ายังไม่มี C++ Build Tools จะดาวน์โหลดให้ (~2–4 GB ครั้งเดียว)",
    d_install_fix_h:"ถ้าติดตั้งไม่ผ่าน",
    d_install_fix_p:"ตัวติดตั้งออกแบบให้จบบนเครื่องเปล่า แต่ด้านล่างคืออาการที่พบบ่อยพร้อมวิธีแก้ เกือบทุกอย่างแก้ได้ด้วยการเปิดเทอร์มินัลใหม่แล้วรันตัวติดตั้งซ้ำ — รันซ้ำปลอดภัย ข้อมูลไม่หาย",
    d_install_fix_l1:"<b>error เรื่อง execution policy</b> — รัน: <code>powershell -ExecutionPolicy Bypass -Command \"irm https://raw.githubusercontent.com/bagidea/bagidea-office/main/installer/install.ps1 | iex\"</code>",
    d_install_fix_l2:"<b>winget not found</b> — ติดตั้ง \"App Installer\" จาก Microsoft Store, เปิดเทอร์มินัลใหม่, รันซ้ำ",
    d_install_fix_l3:"<b>BUILD FAILED / linker 'link.exe' not found</b> — ขาด C++ Build Tools รัน <code>winget install Microsoft.VisualStudio.2022.BuildTools --override \"--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended\"</code> (หรือเปิด Visual Studio Installer แล้วติ๊ก \"Desktop development with C++\"), เปิดเทอร์มินัลใหม่, รันซ้ำ",
    d_install_fix_l4:"<b>git / node / cargo หาไม่เจอ ทั้งที่เพิ่งลง</b> — winget อัปเดต PATH ใน registry ไม่ใช่เทอร์มินัลที่เปิดอยู่ เปิดเทอร์มินัลใหม่แล้วรันซ้ำ มันจะทำต่อจากที่ค้าง",
    d_install_fix_l5:"<b>SmartScreen / Defender บล็อกสคริปต์</b> — เป็น open source (อ่านได้ใน repo) กด \"More info → Run anyway\" หรือดาวน์โหลด install.ps1 มารันเอง",
    d_install_fix_l6:"<b>build เสร็จแต่พิมพ์ bagidea ไม่เจอ</b> — คำสั่งเพิ่งถูกเติมเข้า PATH เปิดเทอร์มินัลใหม่ หรือเปิดจาก Start Menu → \"BagIdea Office\"",
    d_install_manual_h:"ติดตั้งเอง",
    d_install_manual_p:"clone repo, ชี้ path ของ Claude hook มาที่ clone ของคุณ แล้ว build Rust shell:",
    d_install_first_h:"เปิดครั้งแรก",
    d_install_first_p:"ล็อกอิน Claude หนึ่งครั้ง แล้วเปิดออฟฟิศ วอลเปเปอร์จะกลายเป็นออฟฟิศสด พร้อมหัวแชทและไอคอนถาดระบบ",
    d_install_plat:"การรองรับแพลตฟอร์ม: ตอนนี้ Windows 11 (ฝังวอลเปเปอร์ด้วยเทคนิค WorkerW) ส่วน Linux และ macOS อยู่ในแผนอัปเดตภายหลัง",

    d_using_h:"การใช้งาน",
    d_chat_h:"แชท & CEO", d_chat_p:"หน้าต่างแชทเปิดที่ที่นั่ง CEO ของคุณ พิมพ์สั่งงานในนาม CEO แล้ว Director จะเดินมารับ วางแผน และมอบหมาย — คุณเห็นการส่งงานบนวอลเปเปอร์ แล้วเขาเดินกลับมารายงานสรุป จะคุยกับ agent ตัวไหนตรง ๆ ก็คลิกหน้าในแถบหรือบนแผนที่สด ทุกบทสนทนาเป็น thread ที่กลับมาต่อได้พร้อมประวัติ",
    d_projects_h:"โปรเจค", d_projects_p:"ลงทะเบียนโฟลเดอร์จริงเป็นโปรเจค (ตั้งชื่อย่อ PLACE ได้ เช่น \"ห้องเรียน → D:\\Learning\") Director สร้างโปรเจคใหม่และจัดงานเข้าไปเองได้ session ของผู้รับงานรันอยู่ในโฟลเดอร์นั้นและกลับมาต่อได้ หนึ่งหน้าต่างต่อโปรเจค — ▶ เปิด หรือดูงานสดขณะ agent ทำงาน",
    d_security_h:"สิทธิ์การใช้เครื่องมือ", d_security_p:"เครื่องมือที่คุณอนุญาตในโปรไฟล์ agent ทำงานเงียบ ๆ — และ agent ไม่ต้องลุกจากโต๊ะด้วย ส่วนอย่างอื่น agent จะเดินไปห้องขอสิทธิ์และรอ พร้อมการ์ดที่โชว์คำสั่งเป๊ะ ๆ เลือก อนุญาต, ✓✓ ตลอดไป (จดจำ), หรือ ปฏิเสธ ไม่ตอบใน 50 วินาทีจะปฏิเสธอัตโนมัติและ agent วางแผนใหม่",
    d_editor_h:"3D Editor", d_editor_p:"เปิด editor (ปุ่ม 🎨 หรือ bagidea editor) เพื่อจัดผังออฟฟิศแบบ 3 มิติจริง: คลิกสองห้องเพื่อสลับในกริด 3×3, ย้าย Ghost Deck, วางเฟอร์นิเจอร์/ของตกแต่ง และ import โมเดล .glb/.gltf/.fbx กับรูปของคุณเอง กดบันทึกแล้ววอลเปเปอร์อัปเดตทันที — เฟอร์นิเจอร์ จุดนั่ง เส้นทางเดิน และสัตว์เลี้ยงตามไปหมด",
    d_voice_h:"เสียง & ช่องทาง", d_voice_p:"กด F6 ค้างจากที่ไหนก็ได้เพื่อพูดสั่งงาน ตั้งเสียงให้ agent ได้ 16 แบบ (แยก ♀/♂ ชัดเจน) โทรหา main agent เพื่อคุยด้วยเสียงเรียลไทม์ (Gemini Live) ด้วยเสียงที่ตั้งไว้ เชื่อม Telegram, Discord, LINE แล้วสั่งงานจากมือถือ — คำตอบกลับมาช่องเดิม",

    d_plugins_h:"Plugin สกิล และเครื่องมือ",
    d_plugins_p:"Plugin ต่อยอดออฟฟิศได้จริง — โฟลเดอร์ที่มี manifest เพิ่มแผง UI, HTTP route, และคำสั่งที่ agent ใช้ได้ พร้อม ctx เข้าถึง registry, feed, broadcast และแม้แต่รัน Claude ได้ มี plugin หลัก 2 ตัวมาในกล่อง (🎵 Music Player, 🧮 Calculator) ติดตั้งเพิ่มจาก GitHub repo ใดก็ได้ เริ่มจากเทมเพลตทางการ หรืออ่าน repo ตัวอย่าง",
    d_skills_p:"ทุกออฟฟิศมาพร้อมห้องสมุดสกิลพื้นฐาน (บริหารออฟฟิศ, ค้นคว้าเชิงลึก, ควบคุมออฟฟิศ, สร้าง plugin, รีวิวโค้ด, เขียนเอกสาร, ดีบัก, จัดการข้อมูล, เริ่มโปรเจค, ทำไดอะแกรม) assign ให้ agent คนไหนก็ได้ บวกสกิลสไตล์ Hermes ที่ออฟฟิศเรียนรู้เองหลังทำงานจริง เพิ่มความสามารถใหม่ผ่าน MCP servers",
    d_lang_h:"ภาษา", d_lang_p:"ทั้งอินเทอร์เฟซรองรับ 14 ภาษา ค่าเริ่มต้นเป็นอังกฤษ เลือกภาษาอื่นในตั้งค่าแล้วออฟฟิศแปลทั้งระบบ (และจำค่าต่อเครื่อง) เว็บนี้ก็พูดได้ 14 ภาษาเดียวกัน — ใช้ตัวเลือกที่แถบบน",

    d_cli_h:"คำสั่ง CLI", d_cli_p:"ตัวติดตั้งใส่ bagidea ไว้ใน PATH ให้ มันคุยกับออฟฟิศที่รันอยู่และเปิดเองได้ ตัวอย่างเด่น ๆ:",
    d_faq_h:"คำถามที่พบบ่อย",
    d_faq_q1:"รันแล้วเสียเงินไหม?", d_faq_a1:"ตัวแอปฟรีและโอเพนซอร์ส (MIT) agents รันผ่าน Claude Code login ของคุณเอง การใช้งานจึงเป็นไปตามบัญชี/แพ็กเกจ Claude ที่คุณมี — ไม่มีค่าธรรมเนียม BagIdea แยกต่างหาก",
    d_faq_q2:"โค้ด/ข้อมูลของฉันถูกส่งไปไหนไหม?", d_faq_a2:"daemon รันในเครื่องที่ 127.0.0.1 agents คือ Claude Code session จึงใช้ Claude เหมือนโปรเจค Claude Code ทั่วไป ฟีเจอร์เสริม (เสียง รูป เรียลไทม์) ใช้ key OpenAI/Gemini ของคุณเองเฉพาะเมื่อเปิดใช้",
    d_faq_q3:"รองรับแพลตฟอร์มไหน?", d_faq_a3:"ตอนนี้ Windows 11 ส่วน Linux และ macOS อยู่ใน roadmap",
    d_faq_q4:"เขียน plugin เองได้ไหม?", d_faq_a4:"ได้ — fork เทมเพลตทางการ ทั้งคนและ agent สร้าง plugin ที่ใช้งานได้จากมันในไม่กี่นาที spec เต็มอยู่ในคู่มือ plugin",
  },
};

/* ---------- engine ---------- */
(function () {
  const KEY = "bagidea_site_lang";
  function pick() {
    const saved = localStorage.getItem(KEY);
    if (saved && I18N[saved]) return saved;
    const b = (navigator.language || "en").slice(0, 2).toLowerCase();
    return I18N[b] ? b : "en";
  }
  function t(lang, key) {
    return (I18N[lang] && I18N[lang][key] != null) ? I18N[lang][key]
         : (I18N.en[key] != null ? I18N.en[key] : null);
  }
  // Languages other than the inline ones (en/th/de) live in assets/i18n/<lang>.json
  // and are fetched on demand, then cached. Falls back to English on any miss.
  async function ensureLang(lang) {
    if (I18N[lang]) return;
    try {
      const r = await fetch("assets/i18n/" + lang + ".json", { cache: "force-cache" });
      I18N[lang] = r.ok ? await r.json() : {};
    } catch { I18N[lang] = {}; }
  }
  async function apply(lang) {
    await ensureLang(lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = RTL.has(lang) ? "rtl" : "ltr";
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const v = t(lang, el.getAttribute("data-i18n"));
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const v = t(lang, el.getAttribute("data-i18n-html"));
      if (v != null) el.innerHTML = v;
    });
    document.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      el.getAttribute("data-i18n-attr").split(",").forEach((pair) => {
        const [attr, key] = pair.split(":");
        const v = t(lang, key); if (v != null) el.setAttribute(attr, v);
      });
    });
    localStorage.setItem(KEY, lang);
    document.querySelectorAll(".langpick .menu button").forEach((b) =>
      b.classList.toggle("on", b.dataset.lang === lang));
    const cur = LANGS.find((l) => l[0] === lang);
    const lbl = document.querySelector(".langpick .cur");
    if (lbl && cur) lbl.textContent = cur[1].split(" ")[0] + " " + lang.toUpperCase();
  }
  function buildPicker() {
    const host = document.querySelector(".langpick");
    if (!host) return;
    const menu = document.createElement("div");
    menu.className = "menu";
    for (const [code, label] of LANGS) {
      const b = document.createElement("button");
      b.dataset.lang = code; b.textContent = label;
      b.onclick = () => { apply(code); host.classList.remove("open"); };
      menu.appendChild(b);
    }
    host.appendChild(menu);
    host.querySelector("button.toggle").onclick = (e) => {
      e.stopPropagation(); host.classList.toggle("open");
    };
    document.addEventListener("click", () => host.classList.remove("open"));
  }
  window.addEventListener("DOMContentLoaded", () => {
    buildPicker();
    apply(pick());
  });
})();
