// The interactive terminal: commands, a pretend filesystem, breakout, snake and the DO_NOT_RUN.sh reality wipe.
// It drives the DOM that Terminal.tsx renders, so it is plain imperative code rather than React state.

type Mode = "intro" | "idle" | "game" | "void";
type GameKind = "breakout" | "snake";

interface LinkInfo { href: string; host: string; desc: string }
interface Cmd { names: string[]; usage: string; desc: string; run: (args: string[], line: string) => void; hidden: boolean }
interface Word { el: HTMLElement; l: number; r: number; t: number; b: number; dead: boolean }
interface Game {
  kind: GameKind;
  W: number; H: number; L: number; R: number;
  words: Word[];
  alive: number;
  over: boolean;
  wordEl: HTMLElement;
  headEl: HTMLElement;
  raf: number;
  timer: number;
  timers: number[];
  unbind: (() => void)[];
  back: () => void;
  cleanup: () => void;
}

const LINKS: Record<string, LinkInfo> = {
  portfolio: { href: "https://resume.nicholascerisano.com", host: "resume.nicholascerisano.com", desc: "resume and projects" },
  github: { href: "https://github.com/EpicNicks", host: "github.com/EpicNicks", desc: "code and side projects" },
  linkedin: { href: "https://www.linkedin.com/in/nicholas-cerisano/", host: "linkedin.com/in/nicholas-cerisano", desc: "say hello" },
};

const FORTUNES = [
  "There are only two hard things in Computer Science: cache invalidation and naming things. (Phil Karlton)",
  "Premature optimization is the root of all evil. (Donald Knuth)",
  "Debugging is twice as hard as writing the code in the first place. (Brian Kernighan)",
  "It always takes longer than you expect, even when you take into account Hofstadter's Law. (Douglas Hofstadter)",
  "Programs must be written for people to read, and only incidentally for machines to execute. (Harold Abelson)",
  "Talk is cheap. Show me the code. (Linus Torvalds)",
  "The best way to predict the future is to invent it. (Alan Kay)",
  "Simplicity is a prerequisite for reliability. (Edsger Dijkstra)",
  "Make it work, make it right, make it fast. (Kent Beck)",
  "It works on my machine.",
  "A good programmer looks both ways before crossing a one-way street.",
  "Weeks of coding can save you hours of planning.",
];

const THEMES = ["dark", "light", "amber"];

// a tiny pretend filesystem; home is /home, and where all my stuff lives
const HOME = "/home";
const FS: Record<string, string[]> = { "/": ["home", "tmp"], "/home": ["role.txt", "portfolio", "github", "linkedin"], "/tmp": ["DO_NOT_RUN.sh"] };
const FILES: Record<string, string> = {
  "/home/role.txt": "Software developer. Five years of professional experience.",
  "/home/portfolio": LINKS.portfolio.href,
  "/home/github": LINKS.github.href,
  "/home/linkedin": LINKS.linkedin.href,
  "/tmp/DO_NOT_RUN.sh": '#!/bin/sh\n# DO NOT RUN THIS\necho "rm -rf /"',
};
const SCRIPT_PATH = "/tmp/DO_NOT_RUN.sh";

const NEOFETCH_ART = [" _   _", "| \\ | |", "|  \\| |", "| |\\  |", "|_| \\_|"].join("\n");
const COW = [
  "",
  "        \\   ^__^",
  "         \\  (oo)\\_______",
  "            (__)\\       )\\/\\",
  "                ||----w |",
  "                ||     ||",
].join("\n");

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const cmdLink = (cmd: string, label = cmd): string => `<button type="button" class="cmdlink" data-cmd="${esc(cmd)}">${esc(label)}</button>`;
const kindOf = (p: string): "dir" | "file" | null => (FS[p] ? "dir" : FILES[p] !== undefined ? "file" : null);
const fsOf = (el: Element): number => parseFloat(getComputedStyle(el).fontSize);

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`terminal: #${id} is missing`);
  return el;
}

// Wires the terminal up to the elements Terminal.tsx rendered. Returns a function that undoes everything.
export function startTerminal(): () => void {
  const out = byId("out");
  const live = byId("live");
  const typedEl = byId("typed");
  const cwdEl = byId("cwd");
  const sink = byId("sink") as HTMLInputElement;
  const hint = byId("hint");
  const walls = byId("walls");
  const termEl = byId("term");
  const root = document.documentElement;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // everything below can be torn down: listeners hang off one signal, timers and frames are tracked
  const ac = new AbortController();
  const signal = ac.signal;
  let disposed = false;
  let wipeRaf = 0;
  const timeouts = new Set<number>();
  const later = (fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => { timeouts.delete(id); fn(); }, ms);
    timeouts.add(id);
    return id;
  };
  const wait = (ms: number) => new Promise<void>((r) => later(r, ms));

  // ---------- state ----------
  let mode: Mode = "intro";
  let post = false;        // true after a win: "again" and "quit" are live
  let saved = "";          // terminal html from just before the game started
  let lastGame: GameKind = "breakout";
  let cur: HTMLElement = document.createElement("div");   // block that receives command output
  let lastX = innerWidth / 2;
  let introSkip = reduce;
  let G: Game | null = null;
  let cwd = HOME;
  const history: string[] = [];
  let hIdx = 0;
  let draft = "";

  const promptDir = () => (cwd === HOME ? "" : cwd);
  const syncPrompt = () => { cwdEl.textContent = promptDir(); };
  function resolvePath(arg: string): string {
    let p = arg === "~" || arg.startsWith("~/") ? HOME + arg.slice(1) : arg;
    if (!p.startsWith("/")) p = cwd + "/" + p;
    const parts: string[] = [];
    for (const s of p.split("/")) { if (!s || s === ".") continue; if (s === "..") parts.pop(); else parts.push(s); }
    return "/" + parts.join("/");
  }

  // ---------- output helpers ----------
  function newBlock(cmdText?: string): HTMLElement {
    const blk = document.createElement("div");
    blk.className = "blk";
    if (cmdText !== undefined) {
      const line = document.createElement("div");
      line.className = "line";
      line.innerHTML = (promptDir() ? `<span class="cwd">${esc(promptDir())}</span>` : "") + '<span class="ps">$</span><span class="cmd"></span>';
      line.querySelector(".cmd")!.textContent = cmdText;
      blk.appendChild(line);
    }
    out.appendChild(blk);
    cur = blk;
    return blk;
  }
  function print(html: string, cls = ""): void {
    const d = document.createElement("div");
    d.className = ("out " + cls).trim();
    d.innerHTML = html;
    cur.appendChild(d);
  }
  const printText = (s: string) => print(esc(s));
  const scrollEnd = () => scrollTo(0, document.documentElement.scrollHeight);

  // ---------- fortune: a shuffled bag, so nothing repeats until every quote has been shown ----------
  let fortuneBag: number[] = [];
  try {
    const b: unknown = JSON.parse(store.get("fortuneBag") ?? "[]");
    if (Array.isArray(b) && b.every((i) => Number.isInteger(i) && i >= 0 && i < FORTUNES.length)) fortuneBag = b as number[];
  } catch { /* start fresh */ }
  let fortuneLast = Number(store.get("fortuneLast"));
  function nextFortune(): string {
    if (!fortuneBag.length) {
      fortuneBag = FORTUNES.map((_, i) => i);
      for (let i = fortuneBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fortuneBag[i], fortuneBag[j]] = [fortuneBag[j], fortuneBag[i]]; }
      if (fortuneBag[0] === fortuneLast) fortuneBag.push(fortuneBag.shift() as number);   // no repeat across the reshuffle
    }
    fortuneLast = fortuneBag.shift() as number;
    store.set("fortuneBag", JSON.stringify(fortuneBag));
    store.set("fortuneLast", String(fortuneLast));
    return FORTUNES[fortuneLast];
  }

  // ---------- command registry ----------
  const defs: Cmd[] = [];
  const REG: Record<string, Cmd> = {};
  function def(names: string[], usage: string, desc: string, run: Cmd["run"], hidden = false): void {
    const d: Cmd = { names, usage, desc, run, hidden };
    defs.push(d);
    names.forEach((n) => { REG[n] = d; });
  }

  def(["help"], "help", "list commands and what they do", () => {
    printText("Available commands:");
    print(defs.filter((d) => !d.hidden).map((d) =>
      `<span class="row"><span class="c">${cmdLink(d.names[0], d.usage)}</span><span class="d">${esc(d.desc)}</span></span>`
    ).join(""));
  });
  def(["whoami"], "whoami", "show who I am", () => print("Nicholas Cerisano", "name"));
  def(["ls"], "ls [dir]", "list files and folders", (args) => {
    const a = args.filter((x) => !x.startsWith("-"));
    const path = resolvePath(a[0] || ".");
    const k = kindOf(path);
    if (!k) return printText(`ls: cannot access '${a[0]}': No such file or directory`);
    if (k === "file") return printText(a[0]);
    if (path === HOME) {
      return print('<span class="f"><span class="k">role.txt</span><span class="d">what I do</span></span>'
        + Object.entries(LINKS).map(([n, l]) => `<a href="${l.href}" target="_blank" rel="noopener"><span class="k">${n}</span><span class="d">${l.desc}</span></a>`).join(""), "links");
    }
    print(FS[path].map((n) => {
      const full = (path === "/" ? "" : path) + "/" + n;
      return kindOf(full) === "dir" ? cmdLink("cd " + full, n + "/") : esc(n);
    }).join("  "));
  });
  def(["cat"], "cat <file>", "print a file, try role.txt", (args) => {
    const f = args[0];
    if (!f) return printText("cat: missing file operand. Try 'cat role.txt'");
    const p = resolvePath(f), k = kindOf(p);
    if (!k) printText(`cat: ${f}: No such file or directory`);
    else if (k === "dir") printText(`cat: ${f}: Is a directory`);
    else printText(FILES[p]);
  });
  def(["cd"], "cd [dir]", "change directory, try cd .. or cd /", (args) => {
    const a = args[0];
    const path = a ? resolvePath(a) : HOME;
    const k = kindOf(path);
    if (!k) return printText(`cd: no such file or directory: ${a}`);
    if (k === "file") return printText(`cd: not a directory: ${a}`);
    cwd = path;
    syncPrompt();
  });
  def(["pwd"], "pwd", "print the current directory", () => printText(cwd));
  const go = (name: string) => {
    const l = LINKS[name];
    printText(`opening ${l.host}`);
    const w = window.open(l.href, "_blank");
    if (w) w.opener = null;
    else print(`Your browser blocked the new tab. <a class="inline" href="${l.href}" target="_blank" rel="noopener">${l.host}</a>`);
  };
  def(["portfolio"], "portfolio", "open my resume and projects", () => go("portfolio"));
  def(["github"], "github", "open my GitHub", () => go("github"));
  def(["linkedin"], "linkedin", "open my LinkedIn", () => go("linkedin"));
  def(["open"], "open <name>", "open a link by name", (args) => {
    const n = (args[0] || "").toLowerCase();
    if (LINKS[n]) go(n); else printText("usage: open portfolio | github | linkedin");
  });
  def(["neofetch"], "neofetch", "a summary of my experience and interests", () => {
    const rows = [
      ["Role", "Software developer"],
      ["Experience", "5 years professional"],
      ["Languages", "C++, C#, TypeScript, Dart"],
      ["Hobby", "building game engines"],
      ["Also", "Unity, Flutter, React"],
      ["Motto", "Programming is an art that requires style, precision, and finesse."],
      ["Portfolio", LINKS.portfolio.host],
      ["GitHub", LINKS.github.host],
    ];
    print(`<div class="nf"><pre>${esc(NEOFETCH_ART)}</pre><div><div class="who">nicholas@landing</div><div>----------------</div>`
      + rows.map(([k, v]) => `<div class="kv"><span class="kk">${esc(k)}</span><span>${esc(v)}</span></div>`).join("") + "</div></div>");
  });
  def(["echo"], "echo <text>", "print text back", (args) => printText(args.join(" ")));
  def(["date"], "date", "show the current date and time", () => printText(new Date().toString()));
  def(["history"], "history", "show commands you have typed", () => printText(history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join("\n")));
  def(["theme"], "theme [name]", "switch colours: dark, light or amber", (args) => {
    const now = root.dataset.theme ?? "dark";
    const next = args[0] ? args[0].toLowerCase() : THEMES[(THEMES.indexOf(now) + 1) % THEMES.length];
    if (!THEMES.includes(next)) return printText(`theme: unknown theme '${args[0]}'. Choose dark, light or amber.`);
    root.dataset.theme = next;
    store.set("theme", next);
    printText(`theme set to ${next}`);
  });
  def(["fortune"], "fortune", "a programming quote, never repeated until you have seen them all", () => printText(nextFortune()));
  def(["cowsay"], "cowsay [text]", "have a cow say something", (args) => {
    const words = (args.join(" ") || "Moo.").split(/\s+/);
    const lines: string[] = [];
    let l = "";
    for (const w of words) { if ((l + " " + w).trim().length > 30 && l) { lines.push(l); l = w; } else l = (l + " " + w).trim(); }
    lines.push(l);
    const width = Math.max(...lines.map((x) => x.length));
    const body = lines.map((x, i) => {
      const [a, b] = lines.length === 1 ? ["<", ">"] : i === 0 ? ["/", "\\"] : i === lines.length - 1 ? ["\\", "/"] : ["|", "|"];
      return `${a} ${x.padEnd(width)} ${b}`;
    });
    printText(` ${"_".repeat(width + 2)}\n${body.join("\n")}\n ${"-".repeat(width + 2)}${COW}`);
  });
  def(["breakout"], "breakout", "play breakout, bouncing off the words on screen", () => { scrollEnd(); startBreakout(cur); });
  def(["snake"], "snake", "play snake, eating the words on screen", () => { scrollEnd(); startSnake(cur); });
  def(["clear"], "clear", "clear the screen", () => { out.innerHTML = ""; scrollTo(0, 0); });
  def(["reset"], "reset", "reload the page and start over", () => location.reload());

  // easter eggs, left out of help
  def(["sudo"], "sudo", "", () => printText("visitor is not in the sudoers file. This incident will be reported."), true);
  def(["rm"], "rm", "", (args) => printText(args.join(" ").includes("/")
    ? "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe"
    : "rm: cannot remove: Read-only file system"), true);
  def(["vim", "vi", "nano", "emacs"], "vim", "", () => printText("No editor installed. Nobody has to ask how to exit it."), true);
  def(["exit", "quit", "logout"], "exit", "", () => printText("logout\nThere is no escape from the browser. Try 'clear'."), true);
  def(["sh", "bash"], "sh", "", (args, line) => {
    const shell = line.split(/\s+/)[0];
    if (args[0]) execFile(args[0], shell); else printText(`${shell}: no script given`);
  }, true);

  // running a file: only one script in this filesystem is executable
  function execFile(arg: string, shell = "bash"): void {
    const p = resolvePath(arg), k = kindOf(p);
    if (!k) return printText(`${shell}: ${arg}: No such file or directory`);
    if (k === "dir") return printText(`${shell}: ${arg}: Is a directory`);
    if (p !== SCRIPT_PATH) return printText(`${shell}: ${arg}: Permission denied`);
    doom();
  }

  function run(line: string): void {
    const [name, ...args] = line.split(/\s+/);
    if (name.includes("/")) return execFile(name);
    const d = REG[name.toLowerCase()];
    if (!d) {
      printText(`command not found: ${name}`);
      print(`Type ${cmdLink("help")} to see available commands.`);
      return;
    }
    d.run(args, line);
  }

  function submit(raw: string): void {
    const t = raw.trim();
    if (post && (t === "again" || t === "quit")) { if (t === "again") replay(); else leavePost(); return; }
    newBlock(raw);
    if (t) { history.push(t); run(t); }
    hIdx = history.length;
    draft = "";
    if (mode !== "game") scrollEnd();
  }

  // ---------- input ----------
  function render(): void {
    const v = sink.value;
    const s = sink.selectionStart ?? v.length;
    typedEl.innerHTML = `<span style="white-space:pre">${esc(v.slice(0, s))}</span><span class="caret"></span><span style="white-space:pre">${esc(v.slice(s))}</span>`;
  }
  function setValue(v: string): void { sink.value = v; sink.setSelectionRange(v.length, v.length); render(); }

  // Tab completion for commands, files and folders. Like bash, one match completes in full, several
  // complete as far as they agree, and if there is nothing more to add the candidates are listed.
  function complete(): void {
    const v = sink.value;
    const caret = sink.selectionStart ?? v.length;
    const before = v.slice(0, caret), after = v.slice(caret);
    const start = before.search(/\S*$/);                 // where the word under the caret begins
    const word = before.slice(start);
    const head = before.slice(0, start);
    const words = head.trim() ? head.trim().split(/\s+/) : [];
    const cmd = (words[0] || "").toLowerCase();
    if (!word && !words.length) return;

    let options: string[] = [];      // full replacements for `word`
    let prefixLen = 0;               // part of `word` that stays as typed (the directory part of a path)
    const asPath = (dirsOnly: boolean) => {
      const slash = word.lastIndexOf("/");
      const dirPart = word.slice(0, slash + 1), namePart = word.slice(slash + 1);
      const dir = resolvePath(dirPart || ".");
      if (kindOf(dir) !== "dir") return;
      prefixLen = dirPart.length;
      for (const n of FS[dir]) {
        if (!n.startsWith(namePart)) continue;
        const isDir = kindOf((dir === "/" ? "" : dir) + "/" + n) === "dir";
        if (dirsOnly && !isDir) continue;
        options.push(dirPart + n + (isDir ? "/" : ""));
      }
    };

    if (!words.length && !word.includes("/")) {
      options = defs.filter((d) => !d.hidden).flatMap((d) => d.names).filter((n) => n.startsWith(word.toLowerCase()));
    } else if (cmd === "open" && words.length === 1) {
      options = Object.keys(LINKS).filter((n) => n.startsWith(word.toLowerCase()));
    } else if (cmd === "theme" && words.length === 1) {
      options = THEMES.filter((n) => n.startsWith(word.toLowerCase()));
    } else if (cmd === "help" || cmd === "history" || cmd === "date" || cmd === "whoami") {
      return;
    } else {
      asPath(cmd === "cd");
    }
    options = [...new Set(options)];
    if (!options.length) return;

    let common = options[0];
    for (const o of options) while (!o.startsWith(common)) common = common.slice(0, -1);
    if (options.length === 1) {
      const done = head + common + (common.endsWith("/") ? "" : " ");
      setValue(done + after.replace(/^\s+/, ""));
      sink.setSelectionRange(done.length, done.length);   // keep the caret right after the completion
      render();
    } else if (common.length > word.length) {
      setValue(head + common + after);
      sink.setSelectionRange((head + common).length, (head + common).length);
      render();
    } else {
      // nothing more to fill in: show what could come next
      newBlock(v);
      print(options.map((o) => esc(o.slice(prefixLen))).join("  "));
      scrollEnd();
    }
  }

  sink.addEventListener("keydown", (e) => {
    if (mode !== "idle") return;
    if (e.key === "Enter") {
      e.preventDefault();
      const v = sink.value;
      setValue("");
      submit(v);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (e.key === "ArrowUp" && hIdx === history.length) draft = sink.value;
      hIdx = clamp(hIdx + (e.key === "ArrowUp" ? -1 : 1), 0, history.length);
      setValue(hIdx === history.length ? draft : history[hIdx]);
    } else if (e.key === "Tab") {
      e.preventDefault();
      complete();
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      newBlock(sink.value + "^C");
      setValue("");
      scrollEnd();
    }
    requestAnimationFrame(render);
  }, { signal });
  (["input", "keyup", "click", "select"] as const).forEach((ev) => sink.addEventListener(ev, render, { signal }));
  sink.addEventListener("focus", () => live.classList.remove("blurred"), { signal });
  sink.addEventListener("blur", () => live.classList.add("blurred"), { signal });

  // typing anywhere focuses the terminal; any key or tap skips the intro
  document.addEventListener("keydown", (e) => {
    if (mode === "intro") { introSkip = true; e.preventDefault(); return; }
    if (mode === "idle" && document.activeElement !== sink && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) sink.focus({ preventScroll: true });
  }, { signal });
  addEventListener("pointerdown", () => { if (mode === "intro") introSkip = true; }, { signal });
  termEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>(".cmdlink");
    if (btn && mode === "idle") { e.preventDefault(); submit(btn.dataset.cmd ?? ""); sink.focus({ preventScroll: true }); return; }
    if (mode === "idle" && !target.closest("a") && !getSelection()?.toString()) sink.focus({ preventScroll: true });
  }, { signal });
  addEventListener("pointermove", (e) => { lastX = e.clientX; }, { signal });

  // ---------- shared game plumbing ----------
  function wrapWords(el: HTMLElement): void {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (tw.nextNode()) nodes.push(tw.currentNode as Text);
    for (const n of nodes) {
      if (n.parentElement?.closest("[data-role]")) continue;
      const frag = document.createDocumentFragment();
      for (const part of (n.nodeValue ?? "").split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) frag.append(part);
        else { const s = document.createElement("span"); s.className = "w"; s.textContent = part; frag.append(s); }
      }
      n.replaceWith(frag);
    }
  }
  function bindWin<K extends keyof WindowEventMap>(g: Game, type: K, fn: (e: WindowEventMap[K]) => void): void {
    window.addEventListener(type, fn);
    g.unbind.push(() => window.removeEventListener(type, fn));
  }

  function exitUI(): void {
    root.classList.remove("playing", "breakout", "snake");
    hint.hidden = true;
    walls.hidden = true;
    live.style.visibility = "";
    mode = "idle";
    G = null;
    sink.focus({ preventScroll: true });
  }

  // Splits the command line into a ball/head (the "$") and a word (what you typed), freezes the
  // terminal, and turns every other visible word into something the game can use.
  function prepare(kind: GameKind, blk: HTMLElement, hintText: string): Game | null {
    const cmdEl = blk.querySelector<HTMLElement>(".cmd");
    const headEl = blk.querySelector<HTMLElement>(".ps");
    const m = cmdEl?.textContent?.match(/^(\s*)(\S+)([\s\S]*)$/);
    if (!cmdEl || !headEl || !m) return null;

    saved = out.innerHTML;                       // restored on quit, or when the player loses
    lastGame = kind;
    const wordEl = document.createElement("span");
    wordEl.dataset.role = "word";
    if (kind === "snake") wordEl.innerHTML = [...m[2]].map((c) => `<span class="lt">${esc(c)}</span>`).join("");
    else wordEl.textContent = m[2];
    cmdEl.textContent = "";
    cmdEl.append(m[1], wordEl, m[3]);
    headEl.dataset.role = "head";

    mode = "game";
    root.classList.add("playing", kind);
    sink.blur();
    live.style.visibility = "hidden";
    hint.textContent = hintText;
    hint.hidden = false;
    wrapWords(out);
    void out.offsetHeight;

    const W = innerWidth, H = innerHeight;
    const tr = termEl.getBoundingClientRect();
    const L = Math.max(0, tr.left), R = Math.min(W, tr.right);
    walls.style.left = L + "px";
    walls.style.width = R - L + "px";
    walls.hidden = false;

    const words: Word[] = [...out.querySelectorAll<HTMLElement>(".w")].map((el) => {
      const r = el.getBoundingClientRect();
      const h = fsOf(el) * 1.25, cy = (r.top + r.bottom) / 2;
      return { el, l: r.left, r: r.right, t: cy - h / 2, b: cy + h / 2, dead: false };
    }).filter((k) => k.r - k.l > 0 && k.b > 0 && k.t < H && k.r > 0 && k.l < W);

    if (!words.length) {
      out.innerHTML = saved;
      exitUI();
      newBlock();
      printText("Nothing on screen to play with.");
      return null;
    }
    const g: Game = { kind, W, H, L, R, words, alive: words.length, over: false, wordEl, headEl, raf: 0, timer: 0, timers: [], unbind: [], back() {}, cleanup() {} };
    bindWin(g, "resize", () => abort("instant"));
    G = g;
    return g;
  }

  function kill(g: Game, k: Word): void {
    k.dead = true;
    g.alive--;
    k.el.style.transition = "transform .35s ease-in, opacity .35s ease-in";
    k.el.style.transform = `translate(${(Math.random() - 0.5) * 40}px, ${16 + Math.random() * 30}px) rotate(${(Math.random() - 0.5) * 50}deg)`;
    k.el.style.opacity = "0";
  }

  function teardown(g: Game): void {
    g.over = true;
    cancelAnimationFrame(g.raf);
    clearTimeout(g.timer);
    g.timers.forEach(clearTimeout);
    g.unbind.forEach((u) => u());
  }

  // lose or quit: everything flies back to where it was, then the terminal returns
  function abort(how: "animate" | "instant"): void {
    const g = G;
    if (!g || g.over) return;
    teardown(g);
    const finish = () => { g.cleanup(); if (saved) out.innerHTML = saved; exitUI(); scrollEnd(); };
    if (how === "instant" || reduce) return finish();
    g.words.filter((k) => k.dead).forEach((k, i) => {
      const d = Math.min(i * 12, 450);
      k.el.style.transition = `transform .8s cubic-bezier(.2,.9,.2,1) ${d}ms, opacity .5s ease-out ${d}ms`;
      k.el.style.transform = "";
      k.el.style.opacity = "";
    });
    g.back();
    later(finish, 1400);
  }

  // win: clear the terminal and offer a replay
  function win(): void {
    const g = G;
    if (!g || g.over) return;
    teardown(g);
    later(() => {
      g.cleanup();
      exitUI();
      out.innerHTML = "";
      newBlock();
      printText("You win!");
      print(`Type ${cmdLink("again")} to replay or ${cmdLink("quit")} to exit the game`);
      post = true;
      scrollEnd();
    }, 450);
  }
  function replay(): void {
    post = false;
    out.innerHTML = saved;
    const blk = newBlock("again");
    scrollEnd();
    (lastGame === "snake" ? startSnake : startBreakout)(blk);
  }
  function leavePost(): void {
    post = false;
    out.innerHTML = saved;
    scrollEnd();
  }

  // ---------- breakout: the word you typed is the paddle, the $ is the ball, other words are bricks ----------
  const PADDLE_SCALE = 1.5;            // paddle scale, for playability
  function startBreakout(blk: HTMLElement): void {
    const g = prepare("breakout", blk, "move with mouse, touch or arrow keys. esc to quit");
    if (!g) return;
    const { H, L, R, headEl: ballEl, wordEl: paddleEl } = g;
    const pr = paddleEl.getBoundingClientRect(), br = ballEl.getBoundingClientRect();
    const pcx = (pr.left + pr.right) / 2, pcy = (pr.top + pr.bottom) / 2, bcx = (br.left + br.right) / 2, bcy = (br.top + br.bottom) / 2;
    const p = { x: 0, y: H - 64, w: pr.width * PADDLE_SCALE, h: fsOf(paddleEl) * 1.25 * PADDLE_SCALE };
    const b = { x: 0, y: 0, vx: 0, vy: 0, r: fsOf(ballEl) * 0.55, go: false };
    let speed = clamp(H * 0.65, 360, 640);
    const maxSpeed = speed * 1.5;
    let tx = clamp(lastX, L, R);
    const keys = { l: false, r: false };
    p.x = clamp(tx, L + p.w / 2, R - p.w / 2);
    b.x = p.x; b.y = p.y - p.h / 2 - b.r - 2;

    const place = () => {
      paddleEl.style.transform = `translate(${p.x - pcx}px, ${p.y - pcy}px) scale(${PADDLE_SCALE})`;
      ballEl.style.transform = `translate(${b.x - bcx}px, ${b.y - bcy}px)`;
    };
    g.back = () => {
      for (const el of [paddleEl, ballEl]) { el.style.transition = "transform .8s cubic-bezier(.2,.9,.2,1)"; el.style.transform = ""; }
    };

    const launch = () => {
      if (g.over || b.go || !g.raf) return;
      const a = Math.random() * 0.8 - 0.4;
      b.vx = Math.sin(a) * speed; b.vy = -Math.cos(a) * speed;
      b.go = true;
    };
    bindWin(g, "pointermove", (e) => { tx = e.clientX; });
    bindWin(g, "pointerdown", launch);
    bindWin(g, "keydown", (e) => {
      if (e.key === "Escape") return abort("animate");
      if (e.key === "ArrowLeft") keys.l = true;
      else if (e.key === "ArrowRight") keys.r = true;
      else if (e.key === " " || e.key === "ArrowUp") launch();
      else return;
      e.preventDefault();
    });
    bindWin(g, "keyup", (e) => { if (e.key === "ArrowLeft") keys.l = false; if (e.key === "ArrowRight") keys.r = false; });

    const normalise = () => {
      const s = Math.hypot(b.vx, b.vy) || 1;
      b.vx = (b.vx / s) * speed; b.vy = (b.vy / s) * speed;
      const minVy = speed * 0.28;
      if (Math.abs(b.vy) < minVy) {
        b.vy = (b.vy <= 0 ? -1 : 1) * minVy;
        b.vx = (b.vx < 0 ? -1 : 1) * Math.sqrt(speed * speed - minVy * minVy);
      }
    };

    let last = 0;
    const frame = (now: number): void => {
      if (g.over) return;
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      if (keys.l) tx -= 900 * dt;
      if (keys.r) tx += 900 * dt;
      tx = clamp(tx, L, R);
      p.x = clamp(tx, L + p.w / 2, R - p.w / 2);

      if (!b.go) {
        b.x = p.x; b.y = p.y - p.h / 2 - b.r - 2;
      } else {
        b.x += b.vx * dt; b.y += b.vy * dt;
        if (b.x < L + b.r) { b.x = L + b.r; b.vx = Math.abs(b.vx); }
        else if (b.x > R - b.r) { b.x = R - b.r; b.vx = -Math.abs(b.vx); }
        if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); }

        if (b.vy > 0 && b.y + b.r >= p.y - p.h / 2 && b.y - b.r <= p.y + p.h / 2 && Math.abs(b.x - p.x) <= p.w / 2 + b.r) {
          const k = clamp((b.x - p.x) / (p.w / 2 + b.r), -1, 1) * 1.05;   // up to about 60 degrees off vertical
          b.vx = Math.sin(k) * speed; b.vy = -Math.cos(k) * speed;
          b.y = p.y - p.h / 2 - b.r;
        }

        let hit: { k: Word; dx: number; dy: number } | null = null;
        let best = Infinity;
        for (const k of g.words) {
          if (k.dead) continue;
          const dx = b.x - clamp(b.x, k.l, k.r), dy = b.y - clamp(b.y, k.t, k.b);
          const d2 = dx * dx + dy * dy;
          if (d2 < b.r * b.r && d2 < best) { best = d2; hit = { k, dx, dy }; }
        }
        if (hit) {
          const { k, dx, dy } = hit;
          kill(g, k);
          if (dx === 0 && dy === 0) {
            if (Math.min(b.x - k.l, k.r - b.x) < Math.min(b.y - k.t, k.b - b.y)) b.vx = -b.vx; else b.vy = -b.vy;
          } else if (Math.abs(dx) > Math.abs(dy)) b.vx = dx > 0 ? Math.abs(b.vx) : -Math.abs(b.vx);
          else b.vy = dy > 0 ? Math.abs(b.vy) : -Math.abs(b.vy);
          speed = Math.min(maxSpeed, speed * 1.02);
          normalise();
          if (g.alive === 0) return win();
        }
        if (b.y - b.r > H) return abort("animate");
      }
      place();
      g.raf = requestAnimationFrame(frame);
    };

    // glide the paddle and ball down from their command line, then play
    const glide = reduce ? "none" : "transform .6s cubic-bezier(.2,.8,.2,1)";
    paddleEl.style.transition = ballEl.style.transition = glide;
    place();
    g.timers.push(window.setTimeout(() => {
      paddleEl.style.transition = ballEl.style.transition = "none";
      last = performance.now();
      g.raf = requestAnimationFrame(frame);
      g.timers.push(window.setTimeout(launch, 700));
    }, reduce ? 0 : 650));
  }

  // ---------- snake: the $ is the head, the letters you typed are the body, words on screen are food ----------
  interface Seg { c: number; r: number; el: HTMLElement }
  function startSnake(blk: HTMLElement): void {
    const g = prepare("snake", blk, "press an arrow key or swipe to start. esc to quit");
    if (!g) return;
    const letters = [...g.wordEl.querySelectorAll<HTMLElement>(".lt")];
    const chars = letters.map((e) => e.textContent ?? "");
    const hr = g.headEl.getBoundingClientRect();
    const lrs = letters.map((e) => e.getBoundingClientRect());
    const fs = fsOf(g.headEl);
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(20);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    termEl.appendChild(probe);
    const cw = probe.getBoundingClientRect().width / 20;
    probe.remove();
    const ch = parseFloat(getComputedStyle(termEl).lineHeight);
    const X0 = hr.left, Y0 = hr.top;
    const minC = Math.ceil((g.L - X0) / cw), maxC = Math.floor((g.R - X0) / cw) - 1;
    const minR = Math.ceil(-Y0 / ch), maxR = Math.floor((g.H - Y0) / ch) - 1;

    const layer = document.createElement("div");
    layer.className = "snake-layer";
    document.body.appendChild(layer);
    g.cleanup = () => layer.remove();
    const mk = (txt: string, cls: string): HTMLElement => {
      const el = document.createElement("span");
      el.className = "seg " + cls;
      el.textContent = txt;
      el.style.cssText = `width:${cw}px;height:${ch}px;line-height:${ch}px;font-size:${fs}px`;
      layer.appendChild(el);
      return el;
    };
    const at = (el: HTMLElement, x: number, y: number) => { el.style.transform = `translate(${x}px, ${y}px)`; };
    const cell = (s: Seg) => at(s.el, X0 + s.c * cw, Y0 + s.r * ch);

    // start from where the command was typed, then tuck the body in behind the head
    const segs: Seg[] = [{ c: 0, r: 0, el: mk("$", "head") }];
    at(segs[0].el, hr.left, hr.top);
    letters.forEach((_, i) => { const el = mk(chars[i], "body"); at(el, lrs[i].left, lrs[i].top); segs.push({ c: i + 1, r: 0, el }); });
    void layer.offsetHeight;
    const slide = reduce ? "none" : "transform .5s cubic-bezier(.2,.8,.2,1)";
    segs.forEach((s) => { s.el.style.transition = slide; cell(s); });

    g.back = () => {
      segs.forEach((s, i) => {
        s.el.style.transition = "transform .8s cubic-bezier(.2,.9,.2,1), opacity .6s";
        const home = i === 0 ? hr : lrs[Math.min(i, lrs.length) - 1];
        at(s.el, home.left, home.top);
        if (i > lrs.length) s.el.style.opacity = "0";
      });
    };

    let dir = { x: -1, y: 0 };      // facing left, body trailing to the right
    const queue: { x: number; y: number }[] = [];
    let started = false, grow = 0, eaten = 0;
    const tickMs = () => Math.max(70, 130 - 3 * eaten);

    const tick = (): void => {
      if (g.over) return;
      const next = queue.shift();
      if (next) dir = next;
      const head = segs[0];
      const nc = head.c + dir.x, nr = head.r + dir.y;
      if (nc < minC || nc > maxC || nr < minR || nr > maxR) return abort("animate");
      const growing = grow > 0;
      for (let i = 0; i < (growing ? segs.length : segs.length - 1); i++) if (segs[i].c === nc && segs[i].r === nr) return abort("animate");

      const prev = segs.map((s) => ({ c: s.c, r: s.r }));
      head.c = nc; head.r = nr;
      for (let i = 1; i < segs.length; i++) { segs[i].c = prev[i - 1].c; segs[i].r = prev[i - 1].r; }
      if (growing) {
        grow--;
        const t = prev[prev.length - 1];
        const s: Seg = { c: t.c, r: t.r, el: mk(chars[(segs.length - 1) % chars.length], "body") };
        cell(s);
        s.el.style.transition = `transform ${tickMs()}ms linear`;
        segs.push(s);
      }
      segs.forEach((s) => { s.el.style.transition = reduce ? "none" : `transform ${tickMs()}ms linear`; cell(s); });

      // eat any word the head touches
      const cx = X0 + nc * cw + cw * 0.1, cy = Y0 + nr * ch + ch * 0.15, cw2 = cw * 0.8, ch2 = ch * 0.7;
      for (const k of g.words) {
        if (!k.dead && cx + cw2 > k.l - 2 && cx < k.r + 2 && cy + ch2 > k.t && cy < k.b) { kill(g, k); grow++; eaten++; }
      }
      if (g.alive === 0) return win();
      g.timer = window.setTimeout(tick, tickMs());
    };

    const steer = (x: number, y: number) => {
      const last = queue.length ? queue[queue.length - 1] : dir;
      if ((x === -last.x && y === -last.y) || (x === last.x && y === last.y)) return;
      if (queue.length < 2) queue.push({ x, y });
      if (!started) { started = true; hint.hidden = true; g.timer = window.setTimeout(tick, reduce ? 0 : 450); }
    };
    const KEYS: Record<string, [number, number]> = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
    bindWin(g, "keydown", (e) => {
      if (e.key === "Escape") return abort("animate");
      const d = KEYS[e.key] ?? KEYS[e.key.toLowerCase()];
      if (!d) return;
      e.preventDefault();
      steer(d[0], d[1]);
    });
    let sx = 0, sy = 0;
    bindWin(g, "pointerdown", (e) => { sx = e.clientX; sy = e.clientY; });
    bindWin(g, "pointerup", (e) => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      if (Math.abs(dx) > Math.abs(dy)) steer(dx > 0 ? 1 : -1, 0); else steer(0, dy > 0 ? 1 : -1);
    });
  }

  // ---------- DO_NOT_RUN.sh: the reality wipe ----------
  function doom(): void {
    printText("rm -rf /");
    mode = "void";                 // from here on, nothing on the page takes input
    sink.blur();
    later(startWipe, reduce ? 300 : 700);
  }

  interface Unit { el: HTMLElement; x0: number; y0: number; r0: number; a0: number; delay: number; dur: number; swirl: number; tumble: number; done: boolean }
  interface Spark { r0: number; a0: number; life: number; born: number; swirl: number; w: number; c: string; lx: number; ly: number }

  // Everything is pulled into a black hole at the centre of the screen. The hole grows as the terminal
  // background collapses inward (ragged, burning edge, white left behind). As the background nears
  // its end the hole implodes, its horizon flares, and one arced line of light sweeps out as it settles
  // to a dot. Every run rolls its own spin direction, edge shape, tempo and per-word timing.
  // Only a page refresh undoes it.
  function startWipe(): void {
    if (disposed) return;
    const W = innerWidth, H = innerHeight, cx = W / 2, cy = H / 2, TAU = Math.PI * 2;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
    const smooth = (x: number) => x * x * (3 - 2 * x);
    const cs = getComputedStyle(root);
    const css = (v: string) => cs.getPropertyValue(v).trim();
    const bg = css("--bg") || "#0e1116";
    const palette = ["--text", "--prompt", "--link", "--white"].map(css);

    const dir = Math.random() < 0.5 ? -1 : 1;                   // which way everything spirals
    const k = rnd(0.9, 1.15);                                   // overall tempo
    const T = { hole: 0.5 * k, suck0: 1.7 * k, suck1: 6.6 * k, shrink0: 0, climax: 0, end: 0 };
    T.shrink0 = T.suck0 + 0.78 * (T.suck1 - T.suck0);           // the hole stops growing as the background nears its end
    T.climax = T.suck1 + 0.9 * k;                               // horizon flares and the arc goes out
    T.end = T.climax + 1.6 * k;
    const hPeak = Math.min(W, H) * rnd(0.15, 0.19), hMin = 4;
    const rMax = Math.hypot(W, H) / 2;
    const rim = "#000";                                         // the burning edge, the horizon and the arc are all black
    const harm = Array.from({ length: 4 }, (_, i) => ({
      f: 3 + Math.floor(Math.random() * (5 + i * 4)), a: rnd(0.02, 0.07) / (1 + i * 0.6),
      ph: rnd(0, TAU), dr: rnd(0.4, 1.4) * (Math.random() < 0.5 ? -1 : 1),
    }));
    const wobble = (a: number, t: number, speed: number) => harm.reduce((n, h) => n + h.a * Math.sin(h.f * a + h.ph + h.dr * t * speed), 0);

    const mk = (z: number) => {
      const c = document.createElement("canvas");
      c.className = "void-canvas";
      c.width = W * dpr; c.height = H * dpr;
      c.style.zIndex = String(z);
      document.body.appendChild(c);
      const x = c.getContext("2d") as CanvasRenderingContext2D;
      x.scale(dpr, dpr);
      return { c, x };
    };
    const bgc = mk(1), fxc = mk(3);
    const bgx = bgc.x, fx = fxc.x;

    // every word and the prompt become things that can fall
    wrapWords(out);
    void out.offsetHeight;
    const units: Unit[] = [...out.querySelectorAll<HTMLElement>(".w"), ...live.querySelectorAll<HTMLElement>(".ps, .cwd, .caret")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.bottom > 0 && r.top < H && r.right > 0 && r.left < W)
      .map(({ el, r }) => {
        const x0 = (r.left + r.right) / 2, y0 = (r.top + r.bottom) / 2;
        const r0 = Math.hypot(x0 - cx, y0 - cy), n = r0 / rMax;
        return {
          el, x0, y0, r0, a0: Math.atan2(y0 - cy, x0 - cx),
          delay: T.suck0 + (n * 1.5 + rnd(0, 0.8)) * k,        // near the centre goes first
          dur: (0.9 + 1.3 * n) * rnd(0.85, 1.25) * k,
          swirl: rnd(0.5, 1.4), tumble: dir * rnd(0.5, 3) * Math.PI, done: false,
        };
      });
    units.forEach((u) => { u.el.style.willChange = "transform"; });

    root.classList.add("void");        // white page, transparent body, terminal lifted above the backdrop canvas
    const parts: Spark[] = [];
    const bow = (Math.random() < 0.5 ? -1 : 1) * rnd(0.05, 0.1) * H;   // which way the horizon line curves
    let bgGone = false, shaken = false, acc = 0, hintOn = false;

    function drawBg(p: number, t: number): void {
      bgx.clearRect(0, 0, W, H);
      const e = Math.pow(p, 1.8);
      const R = rMax * 1.18 + (hPeak * 0.9 - rMax * 1.18) * e;
      bgx.beginPath();
      for (let i = 0; i <= 160; i++) {
        const a = (i / 160) * TAU;
        const rr = R * (1 + wobble(a, t, dir * (1 + e * 3)) * (0.4 + e * 1.2));
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        if (i) bgx.lineTo(px, py); else bgx.moveTo(px, py);
      }
      bgx.closePath();
      bgx.fillStyle = bg;
      bgx.fill();
      if (R < rMax * 1.1) {
        bgx.lineWidth = 2 + e * 3;
        bgx.strokeStyle = rim; bgx.shadowColor = rim; bgx.shadowBlur = 16;
        bgx.stroke();
        bgx.shadowBlur = 0;
      }
    }
    drawBg(0, 0);                      // paint the dark backdrop in the same frame the page goes white

    const frameAt = (t: number, dt: number): void => {
      // a rumble builds before anything moves
      if (t < T.suck0) {
        const m = Math.pow(t / T.suck0, 2) * 4;
        termEl.style.transform = `translate(${rnd(-m, m)}px, ${rnd(-m, m)}px)`;
      } else if (!shaken) { termEl.style.transform = ""; shaken = true; }

      // words fall along a spiral, stretching along the way in
      let gone = 0;
      for (const u of units) {
        if (u.done) { gone++; continue; }
        const q = (t - u.delay) / u.dur;
        if (q <= 0) continue;
        if (q >= 1) { u.done = true; u.el.style.visibility = "hidden"; gone++; continue; }
        const e = Math.pow(q, 2.1);
        const r = u.r0 * (1 - e), th = u.a0 + dir * e * Math.PI * 1.5 * u.swirl;
        const sx = 1 + 3 * e * e, sy = Math.max(0.03, 1 - 0.97 * e);
        u.el.style.transform = `translate(${cx + Math.cos(th) * r - u.x0}px, ${cy + Math.sin(th) * r - u.y0}px) rotate(${th}rad) scale(${sx}, ${sy}) rotate(${-th}rad) rotate(${u.tumble * e}rad)`;
        u.el.style.opacity = e > 0.85 ? String(1 - (e - 0.85) / 0.15) : "";
      }
      if (gone === units.length) termEl.style.visibility = "hidden";

      // the hole grows through the collapse, then implodes once the background is nearly gone
      let h: number;
      if (t < T.shrink0) h = hPeak * Math.pow(smooth(clamp((t - T.hole) / (T.shrink0 - T.hole), 0, 1)), 0.9);
      else h = hMin + (hPeak - hMin) * (1 - Math.pow(clamp((t - T.shrink0) / (T.climax - T.shrink0), 0, 1), 2.4));
      // how violently the horizon is flaring: it builds during the implosion, then bleeds away
      const f = t < T.climax ? smooth(clamp((t - T.shrink0) / (T.climax - T.shrink0), 0, 1)) : Math.pow(Math.max(0, 1 - (t - T.climax) / (1.3 * k)), 2);

      const p = clamp((t - T.suck0) / (T.suck1 - T.suck0), 0, 1);
      if (!bgGone) {
        if (p >= 1) { bgGone = true; bgc.c.remove(); } else drawBg(p, t);
      }

      // sparks torn off the collapsing edge
      const R = rMax * 1.18 * (1 - Math.pow(p, 1.8)) + hPeak * 0.9 * Math.pow(p, 1.8);
      if (t > T.suck0 - 0.2 * k && t < T.suck1 && R < rMax * 1.1) {
        acc += 170 * dt * (0.5 + 0.5 * (1 - p));
        while (acc >= 1 && parts.length < 340) {
          acc--;
          parts.push({ r0: R * rnd(0.85, 1.02), a0: rnd(0, TAU), life: rnd(0.8, 1.8) * k, born: t, swirl: dir * rnd(2, 5), w: rnd(0.8, 2.2), c: pick(palette), lx: NaN, ly: NaN });
        }
      }

      fx.clearRect(0, 0, W, H);
      if (h > 0.5) {
        const halo = fx.createRadialGradient(cx, cy, h, cx, cy, h * 2.8);
        halo.addColorStop(0, `rgba(0,0,0,${0.2 * Math.min(1, h / hPeak)})`); halo.addColorStop(1, "rgba(0,0,0,0)");
        fx.fillStyle = halo;
        fx.beginPath(); fx.arc(cx, cy, h * 2.8, 0, TAU); fx.fill();
      }
      fx.lineCap = "round";
      for (let i = parts.length - 1; i >= 0; i--) {
        const q = parts[i], pr = (t - q.born) / q.life;
        if (pr >= 1) { parts.splice(i, 1); continue; }
        const r = q.r0 * (1 - Math.pow(pr, 1.6)), th = q.a0 + q.swirl * Math.pow(pr, 1.4);
        const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
        if (!Number.isNaN(q.lx)) {
          fx.strokeStyle = q.c; fx.globalAlpha = 0.85 * (1 - pr * 0.4); fx.lineWidth = q.w;
          fx.beginPath(); fx.moveTo(q.lx, q.ly); fx.lineTo(x, y); fx.stroke();
        }
        q.lx = x; q.ly = y;
      }
      fx.globalAlpha = 1;

      if (h > 0.5) {
        // soft shadow hugging the horizon, strongest at the climax
        if (f > 0.01) {
          const gr = h + hPeak * (0.5 + 1.2 * f);
          const glow = fx.createRadialGradient(cx, cy, h * 0.9, cx, cy, gr);
          glow.addColorStop(0, `rgba(0,0,0,${0.35 * f})`); glow.addColorStop(1, "rgba(0,0,0,0)");
          fx.fillStyle = glow;
          fx.beginPath(); fx.arc(cx, cy, gr, 0, TAU); fx.fill();
        }
        // the hole itself: a smooth ball while it grows, an unstable burning horizon while it collapses
        fx.beginPath();
        for (let i = 0; i <= 120; i++) {
          const a = (i / 120) * TAU;
          const rr = h * (1 + wobble(a, t, 3) * (0.1 + 1.6 * f));
          const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
          if (i) fx.lineTo(px, py); else fx.moveTo(px, py);
        }
        fx.closePath();
        fx.fillStyle = "#000";
        fx.fill();
        if (f > 0.01) {
          fx.lineWidth = 1 + 5 * f;
          fx.strokeStyle = `rgba(0,0,0,${f})`;
          fx.shadowColor = rim; fx.shadowBlur = 10 + 40 * f;
          fx.stroke();
          fx.shadowBlur = 0;
        }
      }

      // the moment the horizon lets go: one arced horizontal line sweeps out from the hole and fades
      const fl = (t - T.climax) / (0.9 * k);
      if (fl > 0 && fl < 1) {
        const reach = W * 0.6 * (1 - Math.pow(1 - fl, 3));
        const thick = 12 * (1 - fl), alpha = Math.pow(1 - fl, 1.4);
        const top: [number, number][] = [], bottom: [number, number][] = [];
        for (let i = 0; i <= 60; i++) {
          const u = -1 + (2 * i) / 60;
          const x = cx + u * reach, y = cy + bow * (1 - u * u) * (1 - fl * 0.5);
          const half = (thick * Math.pow(1 - Math.abs(u), 1.4)) / 2;   // pointed at both ends
          top.push([x, y - half]); bottom.push([x, y + half]);
        }
        fx.fillStyle = `rgba(0,0,0,${alpha})`;
        fx.shadowColor = rim; fx.shadowBlur = 30;
        fx.beginPath();
        top.forEach(([x, y], i) => (i ? fx.lineTo(x, y) : fx.moveTo(x, y)));
        bottom.reverse().forEach(([x, y]) => fx.lineTo(x, y));
        fx.closePath();
        fx.fill();
        fx.shadowBlur = 0;
      }

      if (!hintOn && t > T.end + 1) {
        hintOn = true;
        hint.textContent = "Refresh the page to bring it all back.";
        hint.className = "void-hint";
        hint.setAttribute("role", "status");
        hint.hidden = false;
      }
    };

    if (reduce) { frameAt(T.end + 10, 0); return; }
    const t0 = performance.now();
    let last = t0;
    const loop = (now: number) => {
      frameAt((now - t0) / 1000, Math.min(0.05, (now - last) / 1000));
      last = now;
      wipeRaf = requestAnimationFrame(loop);
    };
    wipeRaf = requestAnimationFrame(loop);
  }

  // ---------- boot ----------
  out.innerHTML = "";
  const savedTheme = store.get("theme");
  if (savedTheme && THEMES.includes(savedTheme)) root.dataset.theme = savedTheme;

  void (async function intro() {
    render();
    live.classList.add("blurred");
    for (const c of ["whoami", "cat role.txt", "ls"]) {
      for (let i = 1; i <= c.length && !introSkip; i++) { setValue(c.slice(0, i)); await wait(32); }
      if (!introSkip) await wait(120);
      if (disposed) return;
      setValue("");
      submit(c);
      if (!introSkip) await wait(220);
      if (disposed) return;
    }
    mode = "idle";
    newBlock();
    print(`click a name above, or type ${cmdLink("help")} for everything else.`, "muted");
    sink.focus({ preventScroll: true });
    render();
  })();

  return () => {
    disposed = true;
    ac.abort();
    timeouts.forEach(clearTimeout);
    cancelAnimationFrame(wipeRaf);
    if (G) { teardown(G); G.cleanup(); G = null; }
    document.querySelectorAll(".void-canvas, .snake-layer").forEach((el) => el.remove());
    root.classList.remove("playing", "breakout", "snake", "void");
    termEl.style.transform = "";
    termEl.style.visibility = "";
    live.style.visibility = "";
    walls.hidden = true;
    hint.hidden = true;
    hint.className = "";
    hint.textContent = "";
    out.innerHTML = "";
    sink.value = "";
  };
}
