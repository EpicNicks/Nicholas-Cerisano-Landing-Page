import { useEffect } from "react";
import { startTerminal } from "./terminal.ts";
import "./terminal.css";

// The markup the terminal script drives. React only renders this shell; the output, prompt and games are
// built imperatively by terminal.ts, which also cleans up after itself when this unmounts.
export default function Terminal() {
  useEffect(() => startTerminal(), []);

  return (
    <>
      <main className="term" id="term">
        <div id="out" role="log" aria-live="polite" />
        <div id="live">
          <span className="cwd" id="cwd" />
          <span className="ps">$</span>
          <span id="typed" />
        </div>
      </main>
      <div id="walls" hidden />
      <input
        id="sink"
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Terminal input. Type help for commands."
      />
      <div id="hint" hidden />
    </>
  );
}
